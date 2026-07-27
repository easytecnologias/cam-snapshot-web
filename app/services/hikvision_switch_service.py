from __future__ import annotations

import hashlib
import time
import uuid
from typing import Any

import requests
import urllib3

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class HikvisionSwitchError(RuntimeError):
    pass


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _derive_login_password(challenge: str, username: str, salt: str, password: str, iterations: int) -> str:
    seed = _sha256_hex(username + salt + password) + challenge
    derived = hashlib.pbkdf2_hmac("sha256", seed.encode("utf-8"), salt.encode("utf-8"), iterations, dklen=256)
    return derived.hex()[:128]


def _search_id() -> str:
    return uuid.uuid4().hex


class HikvisionSwitchSession:
    def __init__(self, host: str, username: str, password: str, port: int = 80, timeout: float = 10.0):
        self.host = str(host or "").strip()
        self.username = str(username or "").strip()
        self.password = str(password or "")
        self.port = int(port or 80)
        self.timeout = float(timeout or 10.0)
        self.session = requests.Session()
        self.session_tag = ""
        scheme = "https" if self.port == 443 else "http"
        self.base = f"{scheme}://{self.host}:{self.port}/iot/global/0-global/model/service/operate"

    def login(self) -> None:
        random_seed = _sha256_hex(str(int(time.time() * 1000)))[:8]
        random_val = str(int(random_seed, 16))[:8]
        auth_resp = self._post("Session/AuthInfo", {"username": self.username, "random": random_val}, require_auth=False)
        auth_data = auth_resp.get("data") or {}
        challenge = auth_data.get("challenge")
        salt = auth_data.get("salt")
        iterations = int(auth_data.get("iterations") or 100)
        session_id = auth_data.get("sessionID")
        session_id_version = auth_data.get("SessionIDVersion")
        if not challenge or not salt or not session_id:
            raise HikvisionSwitchError("Resposta de autenticacao invalida do switch.")

        derived = _derive_login_password(challenge, self.username, salt, self.password, iterations)
        login_resp = self._post(
            "Session/Login",
            {
                "isSessionIDValidLongTerm": False,
                "password": derived,
                "sessionID": session_id,
                "sessionIDVersion": session_id_version,
                "username": self.username,
                "isNeedSessionTag": True,
            },
            require_auth=False,
        )
        session_tag = (login_resp.get("data") or {}).get("sessionTag")
        if not session_tag:
            raise HikvisionSwitchError("Login recusado pelo switch (usuario/senha invalidos).")
        self.session_tag = session_tag

    def _post(self, module_action: str, data: dict[str, Any] | None, require_auth: bool = True) -> dict[str, Any]:
        headers = {"SessionTag": self.session_tag} if require_auth else {}
        body: dict[str, Any] = {"data": data} if data is not None else {}
        try:
            resp = self.session.post(f"{self.base}/{module_action}", json=body, headers=headers, timeout=self.timeout, verify=False)
        except requests.RequestException as e:
            raise HikvisionSwitchError(f"Falha de conexao com o switch: {e}") from e

        try:
            parsed = resp.json()
        except ValueError as e:
            raise HikvisionSwitchError(f"Resposta invalida do switch ({resp.status_code}).") from e

        if resp.status_code == 401:
            raise HikvisionSwitchError("Sessao expirada/nao autorizada no switch.")
        if resp.status_code != 200 or int(parsed.get("status") or 0) != 200:
            raise HikvisionSwitchError(str(parsed.get("errorMsg") or f"Erro HTTP {resp.status_code} do switch."))
        return parsed

    def call(self, module_action: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
        return self._post(module_action, data, require_auth=True).get("data") or {}

    def search(self, module_action: str, max_results: int = 1000) -> dict[str, Any]:
        return self.call(module_action, {"searchID": _search_id(), "maxResults": max_results, "searchResultPosition": 1})


_RATE_LABELS = {0: "auto", 1: "10M", 2: "100M", 3: "1000M", 4: "10G"}


def _flags_for_port(status_row: dict[str, Any]) -> list[str]:
    return ["RUNNING"] if int(status_row.get("lnkSta") or 0) == 1 else []


def build_snapshot(
    sum_info: dict[str, Any],
    port_status: list[dict[str, Any]],
    poe_info: list[dict[str, Any]],
    mac_entries: list[dict[str, Any]],
    vlan_entries: list[dict[str, Any]],
) -> dict[str, Any]:
    poe_by_port = {int(row.get("portID")): row for row in poe_info if row.get("portID") is not None}

    interfaces: list[dict[str, Any]] = []
    for row in port_status:
        port_id = row.get("ID")
        poe_row = poe_by_port.get(int(port_id)) if port_id is not None else None
        interfaces.append(
            {
                "name": row.get("name") or f"port{port_id}",
                "hardware": "",
                "mac": "",
                "flags": _flags_for_port(row),
                "bandwidth": _RATE_LABELS.get(int(row.get("rate") or 0), ""),
                "ip_cidr": "",
                "input_packets": None,
                "input_bytes": None,
                "input_dropped": None,
                "input_multicast_packets": None,
                "output_packets": None,
                "output_bytes": None,
                "output_multicast_packets": None,
                "output_broadcast_packets": None,
                "rx_pkt_s": row.get("stats", {}).get("rxPktS"),
                "tx_pkt_s": row.get("stats", {}).get("txPktS"),
                "poe_enabled": bool(poe_row.get("enabled")) if poe_row else None,
                "poe_power_watts": poe_row.get("poePower") if poe_row else row.get("poePow"),
            }
        )

    mac_table = [
        {
            "vlan_id": 0,
            "mac": str(row.get("macAddress") or "").lower(),
            "entry_type": str(row.get("addressType") or "dynamic").lower(),
            "port": row.get("portName") or "",
        }
        for row in mac_entries
        if row.get("macAddress")
    ]

    vlans = [
        {
            "vlan_id": row.get("VLANID"),
            "name": "",
            "state": "",
            "instance": "",
            "l3_interface": "",
            "member_ports": [],
        }
        for row in vlan_entries
        if row.get("VLANID") is not None
    ]

    system = {
        "software_version": sum_info.get("softwareVersion") or "",
        "brand": "Hikvision",
        "product_name": sum_info.get("model") or sum_info.get("deviceName") or "",
        "hardware_version": "",
        "compiled": "",
        "cpu_usage": f"{(sum_info.get('CPUList') or [{}])[0].get('CPUUtilization', '')}%" if sum_info.get("CPUList") else "",
        "memory_usage": f"{(sum_info.get('memoryList') or [{}])[0].get('memoryUtilization', '')}%" if sum_info.get("memoryList") else "",
        "memory_total_bytes": None,
        "memory_available_bytes": None,
        "system_time": "",
        "uptime": str(sum_info.get("deviceUpTime") or ""),
        "cpu_temperature": "",
        "serial_number": sum_info.get("serialNumber") or "",
        "ipv4_address": sum_info.get("ipv4Address") or "",
        "mac_address": sum_info.get("macAddress") or "",
        "poe_power_watts": sum_info.get("power"),
        "poe_power_max_watts": sum_info.get("maxPower"),
    }

    data: dict[str, Any] = {
        "system": system,
        "vlans": vlans,
        "interfaces": interfaces,
        "mac_table": mac_table,
        "lldp": {},
        "summary": {
            "interfaces_total": len(interfaces),
            "interfaces_up": sum(1 for row in interfaces if "RUNNING" in (row.get("flags") or [])),
            "vlans_total": len(vlans),
            "mac_entries_total": len(mac_table),
        },
    }
    return data


def collect_switch_snapshot(
    host: str,
    username: str,
    password: str,
    include_config: bool = False,
    port: int = 80,
    timeout: float = 10.0,
) -> dict[str, Any]:
    session = HikvisionSwitchSession(host=host, username=username, password=password, port=port, timeout=timeout)
    session.login()

    sum_info = session.call("PortMgr/GetSwitchSumInfo")
    port_status = session.search("PortMgr/SearchPortStatus").get("matchResults") or []
    poe_info = session.search("POE/SearchPortPoeInfo").get("portPoeInfoList") or []
    mac_entries = session.search("L2TableMgr/SearchPortMacAddress", max_results=1024).get("matchResults") or []
    vlan_entries = session.search("L2Mgr/SearchVLAN", max_results=4094).get("matchResults") or []

    return build_snapshot(sum_info, port_status, poe_info, mac_entries, vlan_entries)
