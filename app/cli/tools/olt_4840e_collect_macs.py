#!/usr/bin/env python3
# -*- coding: utf-8 -*-

from __future__ import annotations
from typing import Any, Dict, List, Optional
import os
import select
import shutil
import socket
import subprocess
import re
import telnetlib
import time
import paramiko

_MAC_RE = re.compile(r"\b(?:[0-9a-f]{2}[:\-\.]){5}[0-9a-f]{2}\b", re.I)

# ---- Intelbras 4840E helpers (EPON) ----
_PON_LINE_RE = re.compile(r"^(?P<onu>\d+/\d+/\d+)\s+(?P<onu_mac>(?:[0-9a-f]{2}[:\-\.]){5}[0-9a-f]{2})\s+(?P<llid>\S+)\s+(?P<type>\S+)\s+(?P<cfg>\S+)(?:\s+(?P<desc>.+))?$", re.I)
_MAC_ONU_TABLE_RE = re.compile(
    r"^(?P<mac>(?:[0-9a-f]{2}[:\-\.]){5}[0-9a-f]{2})\s+(?P<vlan>\d+)\s+(?P<onu>\d+/\d+/\d+)\s+(?P<status>\S+)",
    re.I
)

def _split_onu(onu: str) -> Dict[str, str]:
    """'0/1/12' -> {'pon':'0/1', 'onu_id':'12'}"""
    s = (onu or "").strip()
    m = re.fullmatch(r"(\d+)/(\d+)/(\d+)", s)
    if not m:
        return {"pon": "", "onu_id": ""}
    return {"pon": f"{m.group(1)}/{m.group(2)}", "onu_id": m.group(3)}


def _pon_label_to_number(value: Any) -> int:
    s = str(value or "").strip().lower()
    if not s or s == "all":
        return 0
    if re.fullmatch(r"\d+", s):
        return int(s)
    m = re.fullmatch(r"\d+/(\d+)", s)
    if m:
        return int(m.group(1))
    m = re.fullmatch(r"\d+/(\d+)/\d+", s)
    if m:
        return int(m.group(1))
    return 0


def _pon_number_to_label(value: Any) -> str:
    s = str(value or "").strip().lower()
    if not s or s == "all":
        return ""
    if re.fullmatch(r"\d+/\d+", s):
        return s
    if re.fullmatch(r"\d+", s):
        return f"0/{int(s)}"
    return s


def _onu_identity(entry: Dict[str, Any]) -> str:
    return f"{entry.get('pon')}/{entry.get('onu_id')}".strip("/")

def _parse_show_pon(output: str) -> List[Dict[str, Any]]:
    """Parse do 'show pon' da Intelbras 4840E."""
    out: List[Dict[str, Any]] = []
    for raw in (output or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if low.startswith(("onu", "total", "olt", "password", "login")):
            continue
        m = _PON_LINE_RE.match(line)
        if not m:
            continue
        onu = m.group("onu")
        sp = _split_onu(onu)
        out.append({
            "onu": onu,
            "pon": sp["pon"],
            "pon_num": _pon_label_to_number(sp["pon"]),
            "onu_id": sp["onu_id"],
            "onu_mac": _norm_mac(m.group("onu_mac")),
            "llid": m.group("llid"),
            "onu_type": m.group("type"),
            "config": m.group("cfg"),
            "description": (m.group("desc") or "").strip(),
        })
    return out


def _selected_pon_labels(pon: str, entries: List[Dict[str, Any]]) -> List[str]:
    p = (pon or "").strip().lower()
    if not p or p == "all":
        return sorted({str(e.get("pon") or "") for e in entries if e.get("pon")})
    return _pon_list_from_input(p)


def discover_onus_4840e_from_show_pon(output: str, pon: str = "all", max_onu: int = 64) -> Dict[str, Any]:
    """Monta resumo de ocupacao da 4840E a partir do comando read-only `show pon`.

    A 4840E deste ambiente nao expôs comando de ONU nao autorizada durante a
    homologacao; por isso esta funcao mostra ONUs autorizadas e posicoes livres.
    """
    entries = _parse_show_pon(output)
    selected = _selected_pon_labels(pon, entries)
    pons: Dict[str, Dict[str, Any]] = {}
    for pon_label in selected:
        pon_num = _pon_label_to_number(pon_label)
        key = str(pon_num or pon_label)
        authorized = [e for e in entries if str(e.get("pon") or "") == pon_label]
        used = sorted(
            int(e.get("onu_id") or 0)
            for e in authorized
            if str(e.get("onu_id") or "").isdigit()
        )
        pons[key] = {
            "pon": pon_num,
            "pon_label": pon_label,
            "used": used,
            "used_slots": used,
            "free": [slot for slot in range(1, max_onu + 1) if slot not in set(used)],
            "free_slots": [slot for slot in range(1, max_onu + 1) if slot not in set(used)],
            "authorized": [
                {
                    "pon": pon_num,
                    "pon_label": e.get("pon"),
                    "onu": int(e.get("onu_id") or 0),
                    "onu_label": _onu_identity(e),
                    "serial": e.get("onu_mac", ""),
                    "mac": e.get("onu_mac", ""),
                    "model": e.get("onu_type", ""),
                    "status": e.get("config", ""),
                    "description": e.get("description", ""),
                }
                for e in authorized
            ],
            "discovered": [],
        }
    return {
        "ok": True,
        "driver": "intelbras_4840e",
        "count": len(entries),
        "discovered": [],
        "pons": pons,
        "note": "Intelbras 4840E: exibindo ONUs autorizadas e posicoes livres; ONU nao autorizada ainda sem comando homologado.",
    }


def find_onu_4840e_from_show_pon(output: str, serial: str) -> Optional[Dict[str, Any]]:
    wanted = _norm_mac(serial)
    if not wanted:
        return None
    for entry in _parse_show_pon(output):
        if _norm_mac(entry.get("onu_mac", "")) != wanted:
            continue
        return {
            "pon": int(entry.get("pon_num") or 0),
            "pon_label": entry.get("pon", ""),
            "onu": int(entry.get("onu_id") or 0),
            "onu_label": _onu_identity(entry),
            "serial": entry.get("onu_mac", ""),
            "model": entry.get("onu_type", ""),
            "description": entry.get("description", ""),
        }
    return None


def _parse_onu_status_4840e(output: str) -> Dict[str, Dict[str, Any]]:
    rows: Dict[str, Dict[str, Any]] = {}
    for raw in (output or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if low.startswith(("onu mac", "total", "olt", "password", "login")):
            continue
        toks = re.split(r"\s+", line)
        if len(toks) < 3 or not re.fullmatch(r"\d+/\d+/\d+", toks[0]) or not _MAC_RE.fullmatch(toks[1]):
            continue
        onu = toks[0]
        sp = _split_onu(onu)
        distance_m = toks[2] if toks[2] != "-" else ""
        register_time = ""
        onu_type = ""
        software = ""
        state = toks[-1] if len(toks) >= 4 else ""
        if len(toks) >= 8:
            register_time = f"{toks[3]} {toks[4]}" if toks[3] != "-" else ""
            onu_type = toks[5]
            software = toks[6]
        rows[onu] = {
            "onu": onu,
            "pon": sp["pon"],
            "pon_num": _pon_label_to_number(sp["pon"]),
            "onu_id": sp["onu_id"],
            "onu_mac": _norm_mac(toks[1]),
            "distance_m": distance_m,
            "register_time": register_time,
            "onu_type": onu_type,
            "software": software,
            "state": state,
        }
    return rows


def _distance_km(distance_m: Any) -> str:
    raw = str(distance_m or "").strip()
    if not raw or raw == "-":
        return ""
    try:
        value = float(raw.replace(",", "."))
    except ValueError:
        return ""
    text = f"{value / 1000:.3f}".rstrip("0").rstrip(".")
    return text


def _parse_onu_opm_4840e(output: str) -> Dict[str, Any]:
    text = output or ""
    result: Dict[str, Any] = {}

    patterns = {
        "temperature_c": r"Work\s+Temperature\s*:\s*([+-]?\d+(?:[.,]\d+)?)\s*Celsius",
        "supply_voltage_v": r"Supply\s+Voltage(?:\(Vcc\))?\s*:\s*([+-]?\d+(?:[.,]\d+)?)\s*V",
        "tx_bias_ma": r"TX\s+Bias\s+Current\s*:\s*([+-]?\d+(?:[.,]\d+)?)\s*mA",
        "onu_tx": r"TX\s+Power\(Output\)\s*:\s*.*?\(([+-]?\d+(?:[.,]\d+)?)\s*dBm\)",
        "onu_rx": r"RX\s+Power\(Input\)\s*:\s*.*?\(([+-]?\d+(?:[.,]\d+)?)\s*dBm\)",
    }
    for key, pattern in patterns.items():
        m = re.search(pattern, text, re.I)
        if not m:
            continue
        value = m.group(1).replace(",", ".")
        result[key] = f"{value} dBm" if key in {"onu_tx", "onu_rx"} else value
    return result


def _parse_onu_sn_4840e(output: str) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    mapping = {
        "vendor_id": r"Vendor\s+ID\s*:\s*(.+)",
        "onu_model": r"Model\s*:\s*(.+)",
        "serial": r"OnuID\(MAC\)\s*:\s*((?:[0-9a-f]{2}[:\-\.]){5}[0-9a-f]{2})",
        "hardware": r"HWVersion\s*:\s*(.+)",
        "software": r"SWVersion\s*:\s*(.+)",
    }
    for key, pattern in mapping.items():
        m = re.search(pattern, output or "", re.I)
        if not m:
            continue
        value = (m.group(1) or "").strip()
        value = re.sub(r"\s*\(HEX:\s*[^)]*\)\s*$", "", value, flags=re.I).strip()
        result[key] = _norm_mac(value) if key == "serial" else value
    return result


def onu_signal_4840e_from_outputs(
    show_pon_output: str,
    mac_output: str,
    pon: int | str = 0,
    onu: int | str = 0,
    serial: str = "",
    status_output: str = "",
    opm_output: str = "",
    sn_output: str = "",
) -> Dict[str, Any]:
    entries = _parse_show_pon(show_pon_output)
    status_rows = _parse_onu_status_4840e(status_output)
    pon_label = _pon_number_to_label(pon)
    onu_id = str(onu or "").strip()
    wanted_serial = _norm_mac(serial)

    found: Optional[Dict[str, Any]] = None
    for entry in entries:
        if wanted_serial and _norm_mac(entry.get("onu_mac", "")) == wanted_serial:
            found = entry
            break
        if pon_label and onu_id and str(entry.get("pon") or "") == pon_label and str(entry.get("onu_id") or "") == onu_id:
            found = entry
            break

    if not found:
        return {"ok": False, "error": "ONU nao encontrada na 4840E para essa posicao/serial."}

    onu_key = _onu_identity(found)
    status = status_rows.get(onu_key) or {}
    opm = _parse_onu_opm_4840e(opm_output)
    sn = _parse_onu_sn_4840e(sn_output)

    macs = []
    for row in _parse_mac_table_onu(mac_output):
        macs.append({
            "mac": row.get("cpe_mac", ""),
            "cpe_mac": row.get("cpe_mac", ""),
            "vlan": row.get("vlan"),
            "interface": row.get("onu") or _onu_identity(found),
            "status": row.get("status", ""),
        })

    return {
        "ok": True,
        "driver": "intelbras_4840e",
        "pon": int(found.get("pon_num") or 0),
        "pon_label": found.get("pon", ""),
        "onu": int(found.get("onu_id") or 0),
        "onu_label": onu_key,
        "serial": sn.get("serial") or found.get("onu_mac", ""),
        "model": sn.get("onu_model") or found.get("onu_type", ""),
        "profile": found.get("description", ""),
        "oper_status": status.get("state") or ("Active" if str(found.get("config") or "").lower() in {"enable", "active"} else found.get("config", "")),
        "omci_status": "OK",
        "onu_rx": opm.get("onu_rx", ""),
        "onu_tx": opm.get("onu_tx", ""),
        "temperature_c": opm.get("temperature_c", ""),
        "supply_voltage_v": opm.get("supply_voltage_v", ""),
        "tx_bias_ma": opm.get("tx_bias_ma", ""),
        "distance_m": status.get("distance_m", ""),
        "distance_km": _distance_km(status.get("distance_m")),
        "register_time": status.get("register_time", ""),
        "vendor_id": sn.get("vendor_id", ""),
        "hardware": sn.get("hardware", ""),
        "software": sn.get("software") or status.get("software", ""),
        "macs": macs,
        "note": "Intelbras 4840E: sinal optico, distancia, status e MACs coletados por comandos homologados de leitura.",
    }


def _with_4840e_session(
    olt_ip: str,
    user: str,
    password: str,
    port: int,
    timeout: float,
    callback,
) -> Any:
    client, chan = _open_shell(olt_ip, user, password, port=port, timeout=timeout)
    try:
        _ensure_logged_in(chan, user=user, password=password, timeout=timeout)
        try:
            _ensure_enable(chan, password=password, timeout=timeout)
        except Exception:
            pass
        return callback(chan)
    finally:
        try: chan.close()
        except Exception: pass
        try: client.close()
        except Exception: pass


def discover_onus_4840e(
    olt_ip: str,
    user: str,
    password: str,
    pon: str = "all",
    port: int = 22,
    timeout: float = 12.0,
) -> Dict[str, Any]:
    def run(chan) -> Dict[str, Any]:
        show_pon = _cli(chan, "show pon", timeout=max(30.0, timeout * 3))
        result = discover_onus_4840e_from_show_pon(show_pon, pon=pon)
        try:
            offline = _cli(chan, "show onu offline", timeout=max(12.0, timeout))
        except Exception:
            offline = ""
        result["offline_raw"] = offline
        return result

    return _with_4840e_session(olt_ip, user, password, port, timeout, run)


def find_onu_4840e(
    olt_ip: str,
    user: str,
    password: str,
    serial: str,
    port: int = 22,
    timeout: float = 12.0,
) -> Optional[Dict[str, Any]]:
    def run(chan) -> Optional[Dict[str, Any]]:
        show_pon = _cli(chan, "show pon", timeout=max(30.0, timeout * 3))
        return find_onu_4840e_from_show_pon(show_pon, serial)

    return _with_4840e_session(olt_ip, user, password, port, timeout, run)


def onu_signal_4840e(
    olt_ip: str,
    user: str,
    password: str,
    pon: int | str = 0,
    onu: int | str = 0,
    serial: str = "",
    port: int = 22,
    timeout: float = 12.0,
) -> Dict[str, Any]:
    def run(chan) -> Dict[str, Any]:
        show_pon = _cli(chan, "show pon", timeout=max(30.0, timeout * 3))
        found = find_onu_4840e_from_show_pon(show_pon, serial) if serial else None
        pon_label = (found or {}).get("pon_label") or _pon_number_to_label(pon)
        onu_id = (found or {}).get("onu") or onu
        if not pon_label or not onu_id:
            return {"ok": False, "error": "Informe PON + ONU ou um serial valido."}
        mac_out = _cli(chan, f"show mac-address-table onu {pon_label}/{onu_id}", timeout=max(30.0, timeout * 3))
        status_out = ""
        opm_out = ""
        sn_out = ""
        try:
            status_out = _cli(chan, "show onu-status", timeout=max(30.0, timeout * 3))
        except Exception:
            status_out = ""
        try:
            _cli(chan, "conf t", timeout=max(12.0, timeout))
            _cli(chan, f"interface pon {pon_label}", timeout=max(12.0, timeout))
            _cli(chan, f"onu {pon_label}/{onu_id}", timeout=max(12.0, timeout))
            opm_out = _cli(chan, "show onu-opm-diagnosis", timeout=max(30.0, timeout * 3))
            sn_out = _cli(chan, "show onu-sn", timeout=max(30.0, timeout * 3))
        except Exception:
            opm_out = opm_out or ""
            sn_out = sn_out or ""
        return onu_signal_4840e_from_outputs(
            show_pon,
            mac_out,
            pon=pon_label,
            onu=onu_id,
            serial=serial,
            status_output=status_out,
            opm_output=opm_out,
            sn_output=sn_out,
        )

    return _with_4840e_session(olt_ip, user, password, port, timeout, run)


def collect_onu_telemetry_4840e_from_outputs(
    show_pon_output: str,
    status_output: str,
    pon: str = "all",
) -> List[Dict[str, Any]]:
    entries = _parse_show_pon(show_pon_output)
    status_by_onu = _parse_onu_status_4840e(status_output)
    selected_pons = set(_selected_pon_labels(pon, entries))
    if not selected_pons and ((pon or "").strip().lower() in {"", "all"}):
        selected_pons = {
            str(row.get("pon") or "")
            for row in status_by_onu.values()
            if row.get("pon")
        }
    by_onu = {str(entry.get("onu") or ""): entry for entry in entries if entry.get("onu")}
    rows: List[Dict[str, Any]] = []
    for onu_key, status in status_by_onu.items():
        pon_label = str(status.get("pon") or "")
        if selected_pons and pon_label not in selected_pons:
            continue
        entry = by_onu.get(onu_key) or {}
        is_up = str(status.get("state") or "").strip().lower() == "up"
        rows.append({
            "pon": int(status.get("pon_num") or 0),
            "pon_label": pon_label,
            "onu_id": int(status.get("onu_id") or 0),
            "serial": status.get("onu_mac") or entry.get("onu_mac") or "",
            "name": entry.get("description") or "",
            "oper_status": "Active" if is_up else "Offline",
            "omci_status": "OK" if is_up else "LOS",
            "rx_olt": "",
            "rx_onu": "",
            "distance_km": _distance_km(status.get("distance_m")),
        })
    rows.sort(key=lambda row: (int(row.get("pon") or 0), int(row.get("onu_id") or 0)))
    return rows


def collect_onu_telemetry_4840e(
    olt_ip: str,
    user: str,
    password: str,
    pon: str = "all",
    port: int = 22,
    timeout: float = 12.0,
) -> List[Dict[str, Any]]:
    def run(chan) -> List[Dict[str, Any]]:
        show_pon = _cli(chan, "show pon", timeout=max(30.0, timeout * 3))
        status_out = _cli(chan, "show onu-status", timeout=max(30.0, timeout * 3))
        return collect_onu_telemetry_4840e_from_outputs(show_pon, status_out, pon=pon)

    return _with_4840e_session(olt_ip, user, password, port, timeout, run)

def _parse_mac_table_onu(output: str) -> List[Dict[str, Any]]:
    """Parse do 'show mac-address-table onu X/Y/Z'."""
    rows: List[Dict[str, Any]] = []
    for raw in (output or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if low.startswith(("mac", "address", "vlan", "total", "----")):
            continue
        m = _MAC_ONU_TABLE_RE.match(line)
        if not m:
            continue
        mac = _norm_mac(m.group("mac"))
        vlan = int(m.group("vlan"))
        onu = m.group("onu")
        status = m.group("status")
        sp = _split_onu(onu)
        rows.append({
            "pon": sp["pon"],
            "onu_id": sp["onu_id"],
            "onu": onu,
            "cpe_mac": mac,
            "vlan": vlan,
            # não existe "porta" nesse comando; mantemos o campo para compat com frontend
            "port": onu,
            "status": status,
        })
    return rows

def _norm_mac(v: str) -> str:
    s = (v or "").strip().lower()
    s = s.replace("-", ":").replace(".", ":")
    s = re.sub(r":+", ":", s)
    return s

def _read(chan, timeout: float = 10.0) -> str:
    """
    Lê do canal até:
      - prompt normal (>, #, (config)# etc)
      - OU prompts de login (Username/Password)
      - OU erro de credencial
    Também tenta avançar paginação se aparecer --More--.
    """
    t0 = time.time()
    buf = ""

    prompt_re = re.compile(r"(?:\r?\n)?[^\n]{0,120}(?:\(config[^\)]*\))?[>#]\s*$")
    user_re   = re.compile(r"(?:^|\n)\s*(?:login\s+as|username)\b.*:\s*$", re.I)
    pass_re   = re.compile(r"(?:^|\n)\s*password\b.*:\s*$", re.I)
    err_re    = re.compile(r"username\s+or\s+password\s+error", re.I)

    more_re   = re.compile(r"(--More--|More:|Press any key|Press any button|next page|continue)", re.I)

    while True:
        if chan.recv_ready():
            chunk = chan.recv(65535).decode("utf-8", errors="ignore")
            buf += chunk

            tail = buf[-300:]
            if more_re.search(tail):
                # avança paginação (se existir)
                try:
                    chan.send(" ")
                    time.sleep(0.05)
                except Exception:
                    pass

            if err_re.search(buf) or user_re.search(buf) or pass_re.search(buf) or prompt_re.search(buf):
                return buf

        if time.time() - t0 > timeout:
            return buf

        time.sleep(0.05)

def _cli(chan, cmd: str, timeout: float = 12.0) -> str:
    # limpa lixo pendente
    try:
        while chan.recv_ready():
            chan.recv(65535)
    except Exception:
        pass

    chan.send(cmd.rstrip() + "\n")
    time.sleep(0.08)
    return _read(chan, timeout=timeout)

def _open_shell(host: str, user: str, password: str, port: int = 22, timeout: float = 12.0):
    if port == 22 and not _paramiko_supports_legacy_4840e():
        try:
            return _sshpass_legacy_shell(host, user, password, port=port, timeout=timeout)
        except RuntimeError:
            return _telnet_shell(host, timeout=timeout)

    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    try:
        client.connect(
            hostname=host,
            port=port,
            username=user,
            password=password,
            look_for_keys=False,
            allow_agent=False,
            timeout=timeout,
            banner_timeout=timeout,
            auth_timeout=timeout,
        )
    except Exception as exc:
        if "no acceptable kex algorithm" not in str(exc).lower():
            raise
        client.close()
        try:
            client = _legacy_kex_client(host, user, password, port=port, timeout=timeout)
        except Exception as legacy_exc:
            if "no acceptable kex algorithm" not in str(legacy_exc).lower():
                raise
            try:
                return _sshpass_legacy_shell(host, user, password, port=port, timeout=timeout)
            except RuntimeError:
                return _telnet_shell(host, timeout=timeout)
    chan = client.invoke_shell(width=220, height=80)
    time.sleep(0.25)
    return client, chan


def _paramiko_supports_legacy_4840e() -> bool:
    transport = paramiko.Transport(socket.socket())
    try:
        opts = transport.get_security_options()
        return (
            "diffie-hellman-group1-sha1" in tuple(opts.kex)
            and "ssh-rsa" in tuple(opts.key_types)
            and "3des-cbc" in tuple(opts.ciphers)
        )
    finally:
        transport.close()


class _ProcessSSHClient:
    def __init__(self, proc: subprocess.Popen[bytes]) -> None:
        self.proc = proc

    def close(self) -> None:
        if self.proc.poll() is not None:
            return
        self.proc.terminate()
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.kill()


class _ProcessChannel:
    def __init__(self, proc: subprocess.Popen[bytes]) -> None:
        if proc.stdout is None or proc.stdin is None:
            raise RuntimeError("Falha ao abrir canal SSH legado.")
        self.proc = proc
        self.stdout = proc.stdout
        self.stdin = proc.stdin
        os.set_blocking(self.stdout.fileno(), False)

    def recv_ready(self) -> bool:
        if self.proc.poll() is not None:
            return True
        ready, _, _ = select.select([self.stdout], [], [], 0)
        return bool(ready)

    def recv(self, size: int) -> bytes:
        try:
            return os.read(self.stdout.fileno(), size)
        except BlockingIOError:
            return b""

    def send(self, data: str) -> int:
        raw = data.encode("utf-8", errors="ignore")
        self.stdin.write(raw)
        self.stdin.flush()
        return len(raw)


def _sshpass_legacy_shell(host: str, user: str, password: str, port: int = 22, timeout: float = 12.0):
    if not shutil.which("sshpass") or not shutil.which("ssh"):
        raise RuntimeError("OLT usa SSH legado, mas sshpass/ssh nao estao disponiveis no container.")
    env = dict(os.environ)
    env["SSHPASS"] = password or ""
    cmd = [
        "sshpass",
        "-e",
        "ssh",
        "-tt",
        "-p",
        str(int(port)),
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "KexAlgorithms=+diffie-hellman-group1-sha1,diffie-hellman-group14-sha1,diffie-hellman-group-exchange-sha1",
        "-o",
        "HostKeyAlgorithms=+ssh-rsa",
        "-o",
        "PubkeyAcceptedAlgorithms=+ssh-rsa",
        "-o",
        "Ciphers=+3des-cbc,aes128-cbc,aes192-cbc,aes256-cbc",
        "-o",
        f"ConnectTimeout={max(3, int(timeout))}",
        f"{user}@{host}",
    ]
    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        env=env,
        bufsize=0,
    )
    time.sleep(0.4)
    return _ProcessSSHClient(proc), _ProcessChannel(proc)


class _TelnetClient:
    def __init__(self, tn: telnetlib.Telnet) -> None:
        self.tn = tn

    def close(self) -> None:
        self.tn.close()


class _TelnetChannel:
    def __init__(self, tn: telnetlib.Telnet) -> None:
        self.tn = tn

    def recv_ready(self) -> bool:
        try:
            return bool(self.tn.sock_avail())
        except EOFError:
            return True

    def recv(self, size: int) -> bytes:
        try:
            return self.tn.read_eager()[:size]
        except EOFError:
            return b""

    def send(self, data: str) -> int:
        raw = data.encode("utf-8", errors="ignore")
        self.tn.write(raw)
        return len(raw)


def _telnet_shell(host: str, timeout: float = 12.0):
    tn = telnetlib.Telnet(host, 23, timeout=timeout)
    time.sleep(0.3)
    return _TelnetClient(tn), _TelnetChannel(tn)


def _prepend_unique(values: tuple[str, ...], current: tuple[str, ...]) -> tuple[str, ...]:
    out: list[str] = []
    for item in (*values, *current):
        if item and item not in out:
            out.append(item)
    return tuple(out)


def _prepend_supported(values: tuple[str, ...], current: tuple[str, ...]) -> tuple[str, ...]:
    supported = set(current)
    return _prepend_unique(tuple(item for item in values if item in supported), current)


def _legacy_kex_client(host: str, user: str, password: str, port: int = 22, timeout: float = 12.0) -> paramiko.SSHClient:
    """Fallback para OLTs Intelbras antigas que so negociam SSH legado."""
    sock = socket.create_connection((host, port), timeout=timeout)
    transport = paramiko.Transport(sock)
    transport.banner_timeout = timeout
    transport.auth_timeout = timeout
    opts = transport.get_security_options()
    opts.kex = _prepend_supported(
        (
            "diffie-hellman-group14-sha1",
            "diffie-hellman-group1-sha1",
            "diffie-hellman-group-exchange-sha1",
        ),
        tuple(opts.kex),
    )
    opts.ciphers = _prepend_supported(
        ("aes128-cbc", "aes192-cbc", "aes256-cbc", "3des-cbc"),
        tuple(opts.ciphers),
    )
    opts.key_types = _prepend_supported(("ssh-rsa", "ssh-dss"), tuple(opts.key_types))
    try:
        transport.connect(username=user, password=password)
    except Exception:
        transport.close()
        sock.close()
        raise
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    client._transport = transport
    return client

def _ensure_logged_in(chan, user: str, password: str, timeout: float = 12.0) -> None:
    out = _read(chan, timeout=timeout)
    low = (out or "").lower()

    if "username or password error" in low:
        raise RuntimeError("OLT respondeu: Username or password error (credenciais inválidas).")

    # Se pediu username/login
    if "login as" in low or "username" in low:
        chan.send((user or "").strip() + "\n")
        time.sleep(0.15)
        out = _read(chan, timeout=timeout)
        low = (out or "").lower()

    # Se pediu password
    if "password" in low:
        chan.send((password or "") + "\n")
        time.sleep(0.2)
        out = _read(chan, timeout=timeout)
        low = (out or "").lower()

    if "username or password error" in low:
        raise RuntimeError("OLT respondeu: Username or password error (credenciais inválidas).")

    # garante que chegamos num prompt normal
    if not re.search(r"(?:\(config[^\)]*\))?[>#]\s*$", out or ""):
        # tenta mais um pouco
        out2 = _read(chan, timeout=timeout)
        if not re.search(r"(?:\(config[^\)]*\))?[>#]\s*$", out2 or ""):
            # não travar “silencioso”
            raise RuntimeError("Não consegui detectar prompt da OLT após login (timeout/prompt inesperado).")

def _ensure_enable(chan, password: str, timeout: float = 12.0) -> None:
    out = _cli(chan, "en", timeout=timeout)
    if "password" in (out or "").lower():
        chan.send((password or "") + "\n")
        time.sleep(0.2)
        _read(chan, timeout=timeout)


def _pon_list_from_input(pon: str) -> List[str]:
    """Aceita '0/1', '1'..'64' ou 'all' (usa 0/1 só pra entrar no contexto)."""
    p = (pon or "").strip().lower()
    if not p or p == "all":
        return ["0/1"]

    p = p.replace("pon", "").strip()

    # formato 0/1
    if re.fullmatch(r"\d+/\d+", p):
        return [p]

    # somente número: 1..64 -> 0/<n>
    if re.fullmatch(r"\d+", p):
        n = int(p)
        if n <= 0:
            raise ValueError("Valor inválido para pon. Use 0/1..0/64, 1..64, ou 'all'.")
        return [f"0/{n}"]

    raise ValueError("Valor inválido para pon. Use 0/1..0/64, 1..64, ou 'all'.")

def _derive_pon_from_port(port: str) -> str:
    m = re.fullmatch(r"p(\d+)/(\d+)", (port or "").strip().lower())
    if m:
        return f"{m.group(1)}/{m.group(2)}"
    return ""

def _parse_mac_table(output: str, fallback_pon: str = "") -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for raw in (output or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        low = line.lower()
        if low.startswith(("mac", "address", "vlan", "total", "----")):
            continue

        macs = _MAC_RE.findall(line)
        if not macs:
            continue

        toks = re.split(r"\s+", line)
        mac = _norm_mac(macs[0])

        vlan = None
        port = ""
        status = ""

        # acha mac
        try:
            mi = next(i for i, t in enumerate(toks) if _norm_mac(t) == mac)
        except StopIteration:
            mi = 0

        for j in range(mi + 1, min(mi + 6, len(toks))):
            if toks[j].isdigit():
                vv = int(toks[j])
                if 1 <= vv <= 4094:
                    vlan = vv
                    if j + 1 < len(toks): port = toks[j + 1]
                    if j + 2 < len(toks): status = toks[j + 2]
                    break

        pon = _derive_pon_from_port(port) or (fallback_pon or "")
        rows.append({
            "pon": pon,
            "onu_id": "",
            "cpe_mac": mac,
            "vlan": vlan,
            "port": port,
            "status": status,
        })
    return rows

def collect_macs_4840e(
    olt_ip: str,
    user: str,
    password: str,
    pon: str = "all",
    olt_name: Optional[str] = None,
    port: int = 22,
    timeout: float = 12.0,
) -> List[Dict[str, Any]]:
    olt_ip = (olt_ip or "").strip()
    user = (user or "").strip()
    if not olt_ip or not user:
        raise ValueError("olt_ip e user são obrigatórios")

    pon_ports = _pon_list_from_input(pon)
    ctx_pon = pon_ports[0]

    client, chan = _open_shell(olt_ip, user, password, port=port, timeout=timeout)
    try:
        _ensure_logged_in(chan, user=user, password=password, timeout=timeout)

        # enable + config
        _ensure_enable(chan, password=password, timeout=timeout)
        _cli(chan, "conf t", timeout=timeout)
        # Entra em um contexto PON válido (mesmo se pon='all'), para ficar igual ao terminal.
        _cli(chan, f"interface pon {ctx_pon}", timeout=timeout)

        # coleta por ONU (resolve vínculo CPE -> ONU)
        # 1) lista ONUs (show pon) -- so mostra ONU que ja registrou (com MAC),
        #    entao ONU totalmente sem sinal nao aparece aqui.
        pon_out = _cli(chan, "show pon", timeout=max(30.0, timeout * 3))
        onu_entries = _parse_show_pon(pon_out)

        # 1b) 'show onu-status' e global (nao precisa de contexto de PON) e traz
        #     TODAS as ONUs provisionadas, inclusive as com sinal caido (Down) --
        #     é o estado real Up/Down da ONU, diferente de "aprendeu MAC de CPE
        #     agora" (uma ONU pode estar Up e sem nenhum cliente ligado nela).
        status_out = _cli(chan, "show onu-status", timeout=max(30.0, timeout * 3))
        status_by_onu = _parse_onu_status_4840e(status_out)

        # define quais PONs entram na consulta
        pon_in = (pon or "").strip().lower()
        want_all = (not pon_in) or (pon_in == "all")
        if want_all:
            selected_pons = sorted(
                {e.get("pon", "") for e in onu_entries if e.get("pon")}
                | {s.get("pon", "") for s in status_by_onu.values() if s.get("pon")}
            )
        else:
            selected_pons = _pon_list_from_input(pon)

        # 2) para cada ONU das PONs selecionadas, consulta MACs por ONU
        out_rows: List[Dict[str, Any]] = []
        onu_by_key = {e.get("onu"): e for e in onu_entries if e.get("onu")}
        if onu_entries:
            for e in onu_entries:
                if e.get("pon") not in selected_pons:
                    continue
                onu = e.get("onu")
                if not onu:
                    continue

                st = status_by_onu.get(onu) or {}
                is_up = str(st.get("state") or "").strip().lower() == "up"

                mac_out = _cli(chan, f"show mac-address-table onu {onu}", timeout=max(60.0, timeout * 6))
                rows = _parse_mac_table_onu(mac_out)
                has_traffic = bool(rows)

                if not rows:
                    # ONU autorizada mas sem CPE aprendido agora -- pode estar Up
                    # (sinal ok, so ninguem conectado na porta) ou Down de vez.
                    # Sem isso a ONU simplesmente sumia do relatorio em vez de
                    # aparecer com o estado real -- usa o MAC da propria ONU
                    # (sempre conhecido via 'show pon'/'show onu-status') como
                    # cpe_mac, pra ter uma chave estavel e a ONU nao ficar
                    # invisivel.
                    sp = _split_onu(onu)
                    rows = [{
                        "pon": sp["pon"],
                        "onu_id": sp["onu_id"],
                        "onu": onu,
                        "cpe_mac": e.get("onu_mac", ""),
                        "vlan": None,
                        "port": onu,
                        "status": "no-traffic",
                    }]

                # enriquece com metadados da ONU (se quiser usar no frontend depois)
                for r in rows:
                    rr = dict(r)
                    rr["olt"] = olt_name or "Intelbras 4840E"
                    rr["onu_mac"] = e.get("onu_mac", "")
                    # Na 4840E (EPON) usamos o MAC da ONU como "serial".
                    rr["onu_serial"] = rr.get("onu_mac") or rr.get("mac") or ""
                    rr["onu_name"] = e.get("description", "")
                    # Estado real da ONU (show onu-status) manda; sem essa
                    # informacao cai no proxy antigo (aprendeu MAC = Active).
                    rr["oper_status"] = "Active" if (is_up or (not st and has_traffic)) else "Offline"
                    rr["omci_status"] = "OK" if (is_up or (not st and has_traffic)) else "LOS"
                    rr["onu_distance_m"] = st.get("distance_m", "")
                    rr["onu_register_time"] = st.get("register_time", "")
                    rr["llid"] = e.get("llid", "")
                    out_rows.append(rr)

        # 2b) ONUs que 'show onu-status' conhece mas que nunca apareceram no
        #     'show pon' (sinal caido desde antes, nunca chegou a registrar
        #     descricao) -- sem isso ficam completamente invisiveis pro
        #     SightOps, mesmo estando provisionadas na OLT.
        for onu, st in status_by_onu.items():
            if onu in onu_by_key:
                continue
            if st.get("pon") not in selected_pons:
                continue
            out_rows.append({
                "pon": st.get("pon", ""),
                "onu_id": st.get("onu_id", ""),
                "onu": onu,
                "cpe_mac": st.get("onu_mac", ""),
                "vlan": None,
                "port": onu,
                "status": "no-traffic",
                "olt": olt_name or "Intelbras 4840E",
                "onu_mac": st.get("onu_mac", ""),
                "onu_serial": st.get("onu_mac", ""),
                "onu_name": "",
                "oper_status": "Active" if str(st.get("state") or "").strip().lower() == "up" else "Offline",
                "omci_status": "OK" if str(st.get("state") or "").strip().lower() == "up" else "LOS",
                "onu_distance_m": st.get("distance_m", ""),
                "onu_register_time": st.get("register_time", ""),
                "llid": "",
            })

        if not onu_entries and not status_by_onu:
            # fallback: tabela global (sem ONU) — mantém compatibilidade
            mac_out = _cli(chan, "show mac-address-table", timeout=max(120.0, timeout * 8))
            rows = _parse_mac_table(mac_out, fallback_pon=ctx_pon)
            for r in rows:
                rr = dict(r)
                rr["olt"] = olt_name or "Intelbras 4840E"
                rr["onu_serial"] = rr.get("onu_mac") or rr.get("mac") or ""
                out_rows.append(rr)

        # aplica filtro "PON" no fallback global (evita e0/x e cpu)
        if (not want_all) and out_rows and ("onu_id" in out_rows[0] and out_rows[0].get("onu_id") == ""):
            allowed = set(selected_pons)
            out_rows = [r for r in out_rows if (r.get("pon") in allowed)]

        rows = out_rows


        out: List[Dict[str, Any]] = []
        for r in rows:
            rr = dict(r)
            rr["olt"] = olt_name or "Intelbras 4840E"
            out.append(rr)
        return out
    finally:
        try: chan.close()
        except Exception: pass
        try: client.close()
        except Exception: pass
