from __future__ import annotations

import ipaddress
import json
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
import base64
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import x25519

from app.core.paths import DATA_DIR
from app.core.tenant_context import get_current_tenant_slug

CONNECTORS_PATH = DATA_DIR / "connectors.json"
CONNECTOR_JOBS_PATH = DATA_DIR / "connector-jobs.json"
DEFAULT_WG_ENDPOINT = "201.182.184.80:51820"
DEFAULT_WG_NETWORK_PREFIX = "10.250.0"

_lock = threading.RLock()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: Any) -> str:
    return str(value or "").strip()


def _read_json(path: Path, default: Any) -> Any:
    try:
        if not path.exists():
            return default
        with path.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if data is not None else default
    except Exception:
        return default


def _write_json(path: Path, data: Any) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    tmp.replace(path)


def _load_connectors() -> List[Dict[str, Any]]:
    data = _read_json(CONNECTORS_PATH, [])
    return data if isinstance(data, list) else []


def _save_connectors(rows: List[Dict[str, Any]]) -> None:
    _write_json(CONNECTORS_PATH, rows)


def _wg_keypair() -> Dict[str, str]:
    private = x25519.X25519PrivateKey.generate()
    public = private.public_key()
    private_raw = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    public_raw = public.public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return {
        "private_key": base64.b64encode(private_raw).decode("ascii"),
        "public_key": base64.b64encode(public_raw).decode("ascii"),
    }


def _load_jobs() -> List[Dict[str, Any]]:
    data = _read_json(CONNECTOR_JOBS_PATH, [])
    return data if isinstance(data, list) else []


def _save_jobs(rows: List[Dict[str, Any]]) -> None:
    _write_json(CONNECTOR_JOBS_PATH, rows)


def _mark_stale_running_jobs(jobs: List[Dict[str, Any]], timeout_seconds: int = 180) -> bool:
    changed = False
    now_ts = time.time()
    for job in jobs:
        if job.get("status") != "running":
            continue
        picked = _text(job.get("picked_at"))
        try:
            picked_ts = datetime.fromisoformat(picked.replace("Z", "+00:00")).timestamp()
        except Exception:
            picked_ts = 0
        if picked_ts and (now_ts - picked_ts) > timeout_seconds:
            job["status"] = "failed"
            job["finished_at"] = _now()
            job["error"] = "Tempo esgotado aguardando resultado do conector"
            changed = True
    return changed


def _visible_to_current_tenant(row: Dict[str, Any]) -> bool:
    """Isola conectores por tenant nas rotas usadas por usuario logado.

    O conector so e visivel pra quem criou (mesmo tenant_slug). Linha antiga
    sem tenant_slug (anterior a este isolamento) so aparece pra requisicoes
    sem contexto de tenant (deployment single-tenant), nunca "vaza" pra um
    tenant especifico por engano.

    Nao usar isto nas rotas /agent/* -- o RouterOS/agente nao tem sessao de
    usuario, autentica so por connector_id+token, e isso continua valendo
    como fronteira de acesso pra essas rotas (ver _auth_connector).
    """
    return _text(row.get("tenant_slug")) == get_current_tenant_slug()


def _public_connector(row: Dict[str, Any], include_token: bool = False) -> Dict[str, Any]:
    last_seen = _text(row.get("last_seen"))
    online = False
    if last_seen:
        try:
            last_ts = datetime.fromisoformat(last_seen.replace("Z", "+00:00")).timestamp()
            online = (time.time() - last_ts) <= 90
        except Exception:
            online = False
    out = dict(row)
    out["type"] = _text(out.get("type")) or "windows"
    out["status"] = "online" if online else "offline"
    if not include_token:
        out.pop("token", None)
    return out


def list_connectors(include_token: bool = False) -> Dict[str, Any]:
    with _lock:
        rows = [row for row in _load_connectors() if _visible_to_current_tenant(row)]
        connectors = [_public_connector(row, include_token=include_token) for row in rows]
        jobs = [job for job in _load_jobs() if any(_text(r.get("id")) == _text(job.get("connector_id")) for r in rows)]
    queued = sum(1 for job in jobs if job.get("status") in {"queued", "running"})
    return {"ok": True, "count": len(connectors), "queued_jobs": queued, "connectors": connectors}


def create_connector(payload: Dict[str, Any]) -> Dict[str, Any]:
    name = _text(payload.get("name")) or "Novo conector"
    client = _text(payload.get("client")) or "Cliente"
    site = _text(payload.get("site")) or "Matriz"
    public_base_url = _text(payload.get("public_base_url") or payload.get("public_url")).rstrip("/")
    connector_type = _text(payload.get("type")).lower() or "routeros"
    if connector_type not in {"routeros"}:
        raise ValueError("tipo de conector invalido")
    connector_id = _text(payload.get("id")) or secrets.token_hex(8)
    token = secrets.token_urlsafe(32)
    row = {
        "id": connector_id,
        "token": token,
        "tenant_slug": get_current_tenant_slug(),
        "type": connector_type,
        "name": name,
        "client": client,
        "site": site,
        "created_at": _now(),
        "last_seen": "",
        "status": "offline",
        "version": "",
        "host": {},
        "inventory": {},
        "remote_ip": "",
        "public_base_url": public_base_url,
    }
    with _lock:
        rows = _load_connectors()
        if any(_text(item.get("id")) == connector_id for item in rows):
            raise ValueError("id do conector ja existe")
        rows.append(row)
        _save_connectors(rows)
    return {"ok": True, "connector": _public_connector(row, include_token=True)}


def get_connector(connector_id: str, include_token: bool = False, enforce_tenant: bool = False) -> Dict[str, Any] | None:
    """enforce_tenant=True deve ser usado por toda rota chamada por usuario logado
    (nao pelas rotas /agent/*, que autenticam por connector_id+token e nao tem
    sessao/tenant -- ver _visible_to_current_tenant)."""
    cid = _text(connector_id)
    with _lock:
        for row in _load_connectors():
            if _text(row.get("id")) == cid:
                if enforce_tenant and not _visible_to_current_tenant(row):
                    return None
                return _public_connector(row, include_token=include_token)
    return None


def _auth_connector(connector_id: str, token: str) -> Dict[str, Any]:
    cid = _text(connector_id)
    tok = _text(token)
    if not cid or not tok:
        raise PermissionError("credencial do conector ausente")
    rows = _load_connectors()
    for row in rows:
        if _text(row.get("id")) == cid and secrets.compare_digest(_text(row.get("token")), tok):
            return row
    raise PermissionError("token do conector invalido")


def accept_register(connector_id: str, token: str, payload: Dict[str, Any], remote_ip: str = "") -> Dict[str, Any]:
    with _lock:
        row = _auth_connector(connector_id, token)
        rows = _load_connectors()
        now = _now()
        for item in rows:
            if _text(item.get("id")) == _text(row.get("id")):
                item["last_seen"] = now
                item["registered_at"] = item.get("registered_at") or now
                item["version"] = _text(payload.get("version")) or item.get("version") or ""
                item["host"] = payload.get("host") if isinstance(payload.get("host"), dict) else item.get("host", {})
                if isinstance(payload.get("inventory"), dict):
                    item["inventory"] = payload.get("inventory")
                item["remote_ip"] = _text(remote_ip)
                item["status"] = "online"
                row = item
                break
        _save_connectors(rows)
    return {"ok": True, "connector": _public_connector(row)}


def accept_heartbeat(connector_id: str, token: str, payload: Dict[str, Any], remote_ip: str = "") -> Dict[str, Any]:
    return accept_register(connector_id, token, payload, remote_ip=remote_ip)


def create_job(payload: Dict[str, Any]) -> Dict[str, Any]:
    connector_id = _text(payload.get("connector_id"))
    job_type = _text(payload.get("type")) or "ping_many"
    job_payload = payload.get("payload") if isinstance(payload.get("payload"), dict) else {}
    if not connector_id:
        raise ValueError("connector_id obrigatorio")
    if job_type not in {"ping_many", "lan_inventory", "wireguard_install", "wireguard_probe", "wireguard_diagnose"}:
        raise ValueError("tipo de job nao suportado neste MVP")
    with _lock:
        if not get_connector(connector_id, include_token=False, enforce_tenant=True):
            raise ValueError("conector nao encontrado")
        jobs = _load_jobs()
        job = {
            "id": secrets.token_hex(10),
            "connector_id": connector_id,
            "type": job_type,
            "payload": job_payload,
            "status": "queued",
            "created_at": _now(),
            "picked_at": "",
            "finished_at": "",
            "result": None,
            "error": "",
        }
        jobs.append(job)
        _save_jobs(jobs)
    return {"ok": True, "job": job}


def list_jobs(connector_id: str = "", limit: int = 50) -> Dict[str, Any]:
    """Uso por usuario logado (rota /api/connectors/{id}/jobs). Se connector_id
    for de outro tenant, devolve lista vazia -- nao revela nem que o conector
    existe."""
    cid = _text(connector_id)
    if cid and not get_connector(cid, include_token=False, enforce_tenant=True):
        return {"ok": True, "jobs": []}
    with _lock:
        raw_jobs = _load_jobs()
        if _mark_stale_running_jobs(raw_jobs):
            _save_jobs(raw_jobs)
        jobs = list(reversed(raw_jobs))
    if cid:
        jobs = [job for job in jobs if _text(job.get("connector_id")) == cid]
    return {"ok": True, "jobs": jobs[: max(1, min(int(limit or 50), 200))]}


def poll_job(connector_id: str, token: str) -> Dict[str, Any]:
    with _lock:
        _auth_connector(connector_id, token)
        jobs = _load_jobs()
        _mark_stale_running_jobs(jobs)
        selected = None
        now = _now()
        for job in jobs:
            if _text(job.get("connector_id")) == _text(connector_id) and job.get("status") == "queued":
                job["status"] = "running"
                job["picked_at"] = now
                selected = job
                break
        _save_jobs(jobs)
    return {"ok": True, "job": selected}


def accept_job_result(connector_id: str, token: str, job_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
    with _lock:
        _auth_connector(connector_id, token)
        jobs = _load_jobs()
        updated = None
        for job in jobs:
            if _text(job.get("id")) == _text(job_id) and _text(job.get("connector_id")) == _text(connector_id):
                ok = bool(payload.get("ok", True))
                job["status"] = "done" if ok else "failed"
                job["finished_at"] = _now()
                job["result"] = payload.get("result")
                job["error"] = _text(payload.get("error"))
                updated = job
                break
        if not updated:
            raise ValueError("job nao encontrado")
        _save_jobs(jobs)
    return {"ok": True, "job": updated}


def _parse_routeros_lan_inventory(result: str) -> Dict[str, Any]:
    leases: List[Dict[str, str]] = []
    arps: List[Dict[str, str]] = []
    neighbors: List[Dict[str, str]] = []
    for raw in re.split(r"[;\r\n]+", result or ""):
        parts = [part.strip() for part in raw.split("|")]
        if not parts or not parts[0]:
            continue
        kind = parts[0].lower()
        if kind == "dhcp" and len(parts) >= 5:
            leases.append({"ip": parts[1], "mac": parts[2], "host": parts[3], "status": parts[4]})
        elif kind == "arp" and len(parts) >= 3:
            arps.append({"ip": parts[1], "mac": parts[2]})
        elif kind == "neighbor" and len(parts) >= 5:
            neighbors.append({"ip": parts[1], "mac": parts[2], "identity": parts[3], "platform": parts[4]})
    return {
        "dhcp_leases": len(leases),
        "arp_entries": len(arps),
        "neighbors": len(neighbors),
        "dhcp_rows": leases,
        "arp_rows": arps,
        "neighbor_rows": neighbors,
        "collected_at": _now(),
    }


def _update_connector_inventory_from_job(connector_id: str, job: Dict[str, Any], result: str) -> None:
    if _text(job.get("type")) != "lan_inventory":
        return
    parsed = _parse_routeros_lan_inventory(result)
    with _lock:
        rows = _load_connectors()
        changed = False
        for row in rows:
            if _text(row.get("id")) != _text(connector_id):
                continue
            inventory = row.get("inventory") if isinstance(row.get("inventory"), dict) else {}
            inventory.update(parsed)
            row["inventory"] = inventory
            changed = True
            break
        if changed:
            _save_connectors(rows)


def accept_routeros_job_result(connector_id: str, token: str, job_id: str, result: str, ok: bool = True, error: str = "") -> Dict[str, Any]:
    job_before = None
    with _lock:
        for item in _load_jobs():
            if _text(item.get("id")) == _text(job_id) and _text(item.get("connector_id")) == _text(connector_id):
                job_before = dict(item)
                break
    payload: Dict[str, Any] = {
        "ok": bool(ok),
        "result": {"routeros_ping": _text(result)},
        "error": _text(error),
    }
    if _text((job_before or {}).get("type")) == "lan_inventory":
        payload["result"] = {"routeros_inventory": _text(result), "inventory": _parse_routeros_lan_inventory(result)}
    response = accept_job_result(connector_id, token, job_id, payload)
    if ok and job_before:
        _update_connector_inventory_from_job(connector_id, job_before, result)
    return response


def _routeros_safe_target(value: Any) -> str:
    text = _text(value)
    if not text or len(text) > 160:
        return ""
    return text if re.fullmatch(r"[A-Za-z0-9_.:-]+", text) else ""


def _wireguard_routeros_address(client_address: str) -> str:
    ip = _text(client_address).split("/", 1)[0]
    return f"{ip}/24" if ip else f"{DEFAULT_WG_NETWORK_PREFIX}.2/24"


def _routeros_job_script_template(base_url: str, connector_id: str, token: str, job: Dict[str, Any] | None) -> str:
    base_url = base_url.rstrip("/")
    if not job:
        return ':put "SightOps: nenhum job pendente";\n'
    job_id = _text(job.get("id"))
    job_type = _text(job.get("type"))
    if job_type == "wireguard_install":
        row = get_connector(connector_id, include_token=True) or {}
        tunnel = row.get("tunnel") if isinstance(row.get("tunnel"), dict) else {}
        if not tunnel.get("client_private_key"):
            ensure_wireguard_tunnel(connector_id, {})
            row = get_connector(connector_id, include_token=True) or {}
            tunnel = row.get("tunnel") if isinstance(row.get("tunnel"), dict) else {}
        endpoint = _text(tunnel.get("endpoint") or DEFAULT_WG_ENDPOINT)
        endpoint_host, _, endpoint_port = endpoint.partition(":")
        endpoint_port = endpoint_port or str(tunnel.get("listen_port") or 51820)
        client_address = _text(tunnel.get("client_address") or f"{DEFAULT_WG_NETWORK_PREFIX}.2/32")
        routeros_address = _wireguard_routeros_address(client_address)
        server_allowed = f"{DEFAULT_WG_NETWORK_PREFIX}.0/24"
        return f""":local result "wireguard_install:started";
:local wgName "sightops-wg";
/interface wireguard remove [find name=$wgName];
/ip address remove [find interface=$wgName];
/ip firewall filter remove [find comment="SightOps WG input"];
/ip firewall filter remove [find comment="SightOps WG output"];
/ip firewall filter remove [find comment="SightOps WG entrada"];
/ip firewall filter remove [find comment="SightOps WG saida"];
/ip route remove [find comment="SightOps WG"];
/interface wireguard add name=$wgName private-key="{_text(tunnel.get("client_private_key"))}" listen-port=13231 mtu=1420;
/ip address add address="{routeros_address}" interface=$wgName comment="SightOps WG";
/interface wireguard peers add interface=$wgName public-key="{_text(tunnel.get("server_public_key"))}" endpoint-address="{endpoint_host}" endpoint-port={endpoint_port} allowed-address="{server_allowed}" persistent-keepalive=25s comment="SightOps WG server";
/ip firewall filter add chain=input in-interface=$wgName action=accept comment="SightOps WG input";
/ip firewall filter add chain=output out-interface=$wgName action=accept comment="SightOps WG output";
/ip firewall filter add chain=forward in-interface=$wgName action=accept comment="SightOps WG entrada";
/ip firewall filter add chain=forward out-interface=$wgName action=accept comment="SightOps WG saida";
:do {{/ip firewall filter move [find comment="SightOps WG input"] destination=0}} on-error={{}};
:do {{/ip firewall filter move [find comment="SightOps WG output"] destination=0}} on-error={{}};
:do {{/ip firewall filter move [find comment="SightOps WG entrada"] destination=0}} on-error={{}};
:do {{/ip firewall filter move [find comment="SightOps WG saida"] destination=0}} on-error={{}};
:set result ("wireguard_install:done,{routeros_address},{endpoint_host}:{endpoint_port}");
/tool fetch url="{base_url}/api/connectors/agent/routeros/jobs/{job_id}/result-text" http-method=post http-header-field="x-sightops-connector-id:{connector_id},x-sightops-connector-token:{token},Content-Type:text/plain" http-data=$result dst-path=sightops-job-result.json;
:put ("SightOps WireGuard instalado: " . $result);
"""
    if job_type == "wireguard_probe":
        return f""":local result "";
:local p1 [/ping address=10.250.0.1 src-address=10.250.0.2 count=3];
:local p2 [/ping address=10.250.0.1 count=3];
:local wgCount [:len [/interface wireguard find name="sightops-wg"]];
:local addrCount [:len [/ip address find interface="sightops-wg"]];
:local peerCount [:len [/interface wireguard peers find interface="sightops-wg"]];
:local inputPackets "missing"; :local outputPackets "missing"; :local forwardInPackets "missing"; :local forwardOutPackets "missing";
:local inputRule [/ip firewall filter find comment="SightOps WG input"]; :if ([:len $inputRule] > 0) do={{:set inputPackets [/ip firewall filter get [:pick $inputRule 0] packets]}};
:local outputRule [/ip firewall filter find comment="SightOps WG output"]; :if ([:len $outputRule] > 0) do={{:set outputPackets [/ip firewall filter get [:pick $outputRule 0] packets]}};
:local forwardInRule [/ip firewall filter find comment="SightOps WG entrada"]; :if ([:len $forwardInRule] > 0) do={{:set forwardInPackets [/ip firewall filter get [:pick $forwardInRule 0] packets]}};
:local forwardOutRule [/ip firewall filter find comment="SightOps WG saida"]; :if ([:len $forwardOutRule] > 0) do={{:set forwardOutPackets [/ip firewall filter get [:pick $forwardOutRule 0] packets]}};
:set result ("wireguard_probe:src=" . $p1 . ",auto=" . $p2 . ",wg=" . $wgCount . ",addr=" . $addrCount . ",peer=" . $peerCount . ",input_pkts=" . $inputPackets . ",output_pkts=" . $outputPackets . ",fwd_in_pkts=" . $forwardInPackets . ",fwd_out_pkts=" . $forwardOutPackets);
/tool fetch url="{base_url}/api/connectors/agent/routeros/jobs/{job_id}/result-text" http-method=post http-header-field="x-sightops-connector-id:{connector_id},x-sightops-connector-token:{token},Content-Type:text/plain" http-data=$result dst-path=sightops-job-result.json;
:put ("SightOps WireGuard probe: " . $result);
"""
    if job_type == "wireguard_diagnose":
        return f""":local result "wireguard_diagnose:";
:local wgCount [:len [/interface wireguard find name="sightops-wg"]];
:local addrCount [:len [/ip address find interface="sightops-wg"]];
:local peerCount [:len [/interface wireguard peers find interface="sightops-wg"]];
:set result ($result . " wg=" . $wgCount . " addr=" . $addrCount . " peer=" . $peerCount . ";");
:foreach i in=[/ip address find interface="sightops-wg"] do={{:set result ($result . " address|" . [/ip address get $i address] . "|" . [/ip address get $i network] . ";")}};
:foreach i in=[/interface wireguard peers find interface="sightops-wg"] do={{:set result ($result . " peer|" . [/interface wireguard peers get $i allowed-address] . "|" . [/interface wireguard peers get $i endpoint-address] . "|" . [/interface wireguard peers get $i endpoint-port] . "|" . [/interface wireguard peers get $i current-endpoint-address] . "|" . [/interface wireguard peers get $i last-handshake] . ";")}};
:foreach i in=[/ip route find where dst-address~"10.250"] do={{:set result ($result . " route|" . [/ip route get $i dst-address] . "|" . [/ip route get $i gateway] . "|" . [/ip route get $i active] . ";")}};
:local ruleN 0;
:foreach i in=[/ip firewall filter find] do={{:if ($ruleN < 60) do={{:local comment [/ip firewall filter get $i comment]; :local chain [/ip firewall filter get $i chain]; :local action [/ip firewall filter get $i action]; :local inIf [/ip firewall filter get $i in-interface]; :local outIf [/ip firewall filter get $i out-interface]; :local packets [/ip firewall filter get $i packets]; :set result ($result . " filter|" . $ruleN . "|" . $chain . "|" . $action . "|" . $inIf . "|" . $outIf . "|" . $packets . "|" . $comment . ";"); :set ruleN ($ruleN + 1)}}}};
:foreach i in=[/ip firewall nat find] do={{:local comment [/ip firewall nat get $i comment]; :if ($comment~"SightOps") do={{:set result ($result . " nat|" . [/ip firewall nat get $i chain] . "|" . [/ip firewall nat get $i action] . "|" . [/ip firewall nat get $i packets] . "|" . $comment . ";")}}}};
/tool fetch url="{base_url}/api/connectors/agent/routeros/jobs/{job_id}/result-text" http-method=post http-header-field="x-sightops-connector-id:{connector_id},x-sightops-connector-token:{token},Content-Type:text/plain" http-data=$result dst-path=sightops-job-result.json;
:put ("SightOps WireGuard diagnose: " . $result);
"""
    if job_type == "lan_inventory":
        return f""":local result "";
:foreach i in=[/ip dhcp-server lease find] do={{:local ip [/ip dhcp-server lease get $i address]; :local mac [/ip dhcp-server lease get $i mac-address]; :local host [/ip dhcp-server lease get $i host-name]; :local status [/ip dhcp-server lease get $i status]; :set result ($result . "dhcp|" . $ip . "|" . $mac . "|" . $host . "|" . $status . ";")}};
:foreach i in=[/ip arp find] do={{:local ip [/ip arp get $i address]; :local mac [/ip arp get $i mac-address]; :set result ($result . "arp|" . $ip . "|" . $mac . ";")}};
:foreach i in=[/ip neighbor find] do={{:local ip [/ip neighbor get $i address]; :local mac [/ip neighbor get $i mac-address]; :local ident [/ip neighbor get $i identity]; :local platform [/ip neighbor get $i platform]; :set result ($result . "neighbor|" . $ip . "|" . $mac . "|" . $ident . "|" . $platform . ";")}};
/tool fetch url="{base_url}/api/connectors/agent/routeros/jobs/{job_id}/result-text" http-method=post http-header-field="x-sightops-connector-id:{connector_id},x-sightops-connector-token:{token},Content-Type:text/plain" http-data=$result dst-path=sightops-job-result.json;
:put ("SightOps inventario LAN {job_id} executado");
"""
    if job_type != "ping_many":
        return f""":local result "unsupported:0,";
/tool fetch url="{base_url}/api/connectors/agent/routeros/jobs/{job_id}/result-text" http-method=post http-header-field="x-sightops-connector-id:{connector_id},x-sightops-connector-token:{token},Content-Type:text/plain" http-data=$result dst-path=sightops-job-result.json;
"""
    raw_targets = (job.get("payload") or {}).get("targets") if isinstance(job.get("payload"), dict) else []
    targets = [_routeros_safe_target(item) for item in (raw_targets if isinstance(raw_targets, list) else [])]
    targets = [item for item in targets if item][:50]
    if not targets:
        targets = ["8.8.8.8"]
    target_list = ";".join(f'"{item}"' for item in targets)
    return f""":local result "";
:foreach target in={{{target_list}}} do={{:local received [/ping address=$target count=1]; :local online "0"; :if ($received > 0) do={{:set online "1"}}; :set result ($result . $target . ":" . $online . ",")}};
/tool fetch url="{base_url}/api/connectors/agent/routeros/jobs/{job_id}/result-text" http-method=post http-header-field="x-sightops-connector-id:{connector_id},x-sightops-connector-token:{token},Content-Type:text/plain" http-data=$result dst-path=sightops-job-result.json;
:put ("SightOps job {job_id} executado: " . $result);
"""


def build_routeros_job_script(base_url: str, connector_id: str, token: str) -> str:
    job = poll_job(connector_id, token).get("job")
    row = get_connector(connector_id, include_token=True) or {}
    saved_base_url = _text(row.get("public_base_url")).rstrip("/")
    if saved_base_url:
        base_url = saved_base_url
    return _routeros_job_script_template(base_url=base_url, connector_id=_text(connector_id), token=_text(token), job=job)


def delete_connector(connector_id: str) -> Dict[str, Any]:
    cid = _text(connector_id)
    with _lock:
        rows = _load_connectors()
        target = next((row for row in rows if _text(row.get("id")) == cid), None)
        if target is None or not _visible_to_current_tenant(target):
            return {"ok": True, "removed": 0}
        kept = [row for row in rows if _text(row.get("id")) != cid]
        jobs = [job for job in _load_jobs() if _text(job.get("connector_id")) != cid]
        _save_connectors(kept)
        _save_jobs(jobs)
    return {"ok": True, "removed": len(rows) - len(kept)}


def ensure_wireguard_tunnel(connector_id: str, payload: Dict[str, Any] | None = None, enforce_tenant: bool = False) -> Dict[str, Any]:
    """enforce_tenant=True na rota de usuario logado. Chamado tambem internamente
    pelo fluxo do proprio agente (wireguard_install job) sem contexto de tenant --
    la deve continuar False."""
    cid = _text(connector_id)
    data = payload if isinstance(payload, dict) else {}
    endpoint = _text(data.get("endpoint") or data.get("server_endpoint") or DEFAULT_WG_ENDPOINT)
    client_lans_raw = data.get("client_lans")
    if isinstance(client_lans_raw, str):
        client_lans = [item.strip() for item in re.split(r"[\s,;]+", client_lans_raw) if item.strip()]
    elif isinstance(client_lans_raw, list):
        client_lans = [_text(item) for item in client_lans_raw if _text(item)]
    else:
        client_lans = []
    if not client_lans:
        client_lans = ["192.168.20.0/24"]
    with _lock:
        rows = _load_connectors()
        idx = next((i for i, row in enumerate(rows) if _text(row.get("id")) == cid), -1)
        if idx < 0 or (enforce_tenant and not _visible_to_current_tenant(rows[idx])):
            raise ValueError("conector nao encontrado")
        row = rows[idx]
        tunnel = row.get("tunnel") if isinstance(row.get("tunnel"), dict) else {}
        if not tunnel.get("server_private_key") or not tunnel.get("server_public_key"):
            server = _wg_keypair()
            tunnel["server_private_key"] = server["private_key"]
            tunnel["server_public_key"] = server["public_key"]
        if not tunnel.get("client_private_key") or not tunnel.get("client_public_key"):
            client = _wg_keypair()
            tunnel["client_private_key"] = client["private_key"]
            tunnel["client_public_key"] = client["public_key"]
        tunnel.update({
            "enabled": True,
            "type": "wireguard",
            "endpoint": endpoint,
            "listen_port": int(_text(data.get("listen_port")) or "51820"),
            "server_address": _text(data.get("server_address")) or f"{DEFAULT_WG_NETWORK_PREFIX}.1/24",
            "client_address": _text(data.get("client_address")) or f"{DEFAULT_WG_NETWORK_PREFIX}.2/32",
            "client_lans": client_lans,
            "updated_at": _now(),
        })
        row["tunnel"] = tunnel
        rows[idx] = row
        _save_connectors(rows)
    public = _public_connector(row, include_token=False)
    if isinstance(public.get("tunnel"), dict):
        public["tunnel"].pop("server_private_key", None)
        public["tunnel"].pop("client_private_key", None)
    return {"ok": True, "connector": public, "tunnel": public.get("tunnel")}


def build_routeros_wireguard_script(connector_id: str) -> str:
    row = get_connector(connector_id, include_token=True, enforce_tenant=True)
    if not row:
        raise ValueError("conector nao encontrado")
    tunnel = row.get("tunnel") if isinstance(row.get("tunnel"), dict) else {}
    if not tunnel.get("client_private_key"):
        tunnel = ensure_wireguard_tunnel(connector_id, {})["connector"].get("tunnel") or {}
        row = get_connector(connector_id, include_token=True) or row
        tunnel = row.get("tunnel") if isinstance(row.get("tunnel"), dict) else tunnel
    endpoint = _text(tunnel.get("endpoint") or DEFAULT_WG_ENDPOINT)
    endpoint_host, _, endpoint_port = endpoint.partition(":")
    endpoint_port = endpoint_port or str(tunnel.get("listen_port") or 51820)
    client_address = _text(tunnel.get("client_address") or f"{DEFAULT_WG_NETWORK_PREFIX}.2/32")
    routeros_address = _wireguard_routeros_address(client_address)
    server_allowed = f"{DEFAULT_WG_NETWORK_PREFIX}.0/24"
    return f"""# SightOps WireGuard - RouterOS
# Cole no terminal do MikroTik do cliente. Requer RouterOS 7.

:local wgName "sightops-wg"
/interface wireguard remove [find name=$wgName]
/ip address remove [find interface=$wgName]
/ip firewall filter remove [find comment~"SightOps WG"]
/ip route remove [find comment~"SightOps WG"]

/interface wireguard add name=$wgName private-key="{_text(tunnel.get("client_private_key"))}" listen-port=13231 mtu=1420
/ip address add address="{routeros_address}" interface=$wgName comment="SightOps WG"
/interface wireguard peers add interface=$wgName public-key="{_text(tunnel.get("server_public_key"))}" endpoint-address="{endpoint_host}" endpoint-port={endpoint_port} allowed-address="{server_allowed}" persistent-keepalive=25s comment="SightOps WG server"
/ip firewall filter add chain=forward in-interface=$wgName action=accept comment="SightOps WG entrada"
/ip firewall filter add chain=forward out-interface=$wgName action=accept comment="SightOps WG saida"

:put "SightOps WireGuard configurado. Agora configure o peer no servidor com a chave publica do cliente."
:put "Cliente public-key: {_text(tunnel.get("client_public_key"))}"
:put "AllowedIPs servidor: {client_address}, {', '.join(_text(item) for item in (tunnel.get("client_lans") or []))}"
"""


def _agent_script_template(base_url: str, connector_id: str, token: str) -> str:
    base_url = base_url.rstrip("/")
    return f"""# SightOps Agent MVP
# Execute em PowerShell como usuario normal para testar.
# Depois este mesmo fluxo vira servico Windows.

$ErrorActionPreference = "SilentlyContinue"
$BaseUrl = "{base_url}"
$ConnectorId = "{connector_id}"
$Token = "{token}"
$Version = "0.1.0"

function Get-SightOpsHost {{
  $ips = @()
  try {{
    $ips = Get-NetIPAddress -AddressFamily IPv4 |
      Where-Object {{ $_.IPAddress -notlike "169.254.*" -and $_.IPAddress -ne "127.0.0.1" }} |
      Select-Object -ExpandProperty IPAddress
  }} catch {{}}
  $macs = @()
  try {{
    $macs = Get-NetAdapter | Where-Object {{ $_.Status -eq "Up" }} | Select-Object -ExpandProperty MacAddress
  }} catch {{}}
  return @{{
    hostname = $env:COMPUTERNAME
    user = [Environment]::UserName
    domain = [Environment]::UserDomainName
    os = (Get-CimInstance Win32_OperatingSystem).Caption
    ips = @($ips)
    macs = @($macs)
  }}
}}

function Invoke-SightOpsJson($Method, $Path, $Body) {{
  $headers = @{{
    "x-sightops-connector-id" = $ConnectorId
    "x-sightops-connector-token" = $Token
  }}
  $json = $null
  if ($null -ne $Body) {{ $json = ($Body | ConvertTo-Json -Depth 8) }}
  return Invoke-RestMethod -Method $Method -Uri "$BaseUrl$Path" -Headers $headers -ContentType "application/json" -Body $json
}}

function Test-SightOpsPing($Target) {{
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $ok = Test-Connection -ComputerName $Target -Count 1 -Quiet -ErrorAction SilentlyContinue
  $sw.Stop()
  return @{{
    target = $Target
    online = [bool]$ok
    rtt_ms = if ($ok) {{ [math]::Round($sw.Elapsed.TotalMilliseconds, 2) }} else {{ $null }}
  }}
}}

function Invoke-SightOpsJob($Job) {{
  if ($null -eq $Job) {{ return }}
  $result = @{{ ok = $true; result = @{{}}; error = "" }}
  try {{
    if ($Job.type -eq "ping_many") {{
      $targets = @($Job.payload.targets)
      $items = @()
      foreach ($target in $targets) {{
        if ([string]::IsNullOrWhiteSpace($target)) {{ continue }}
        $items += Test-SightOpsPing $target
      }}
      $result.result = @{{ targets = $targets; items = $items }}
    }} else {{
      $result.ok = $false
      $result.error = "Tipo de job nao suportado no agente"
    }}
  }} catch {{
    $result.ok = $false
    $result.error = $_.Exception.Message
  }}
  Invoke-SightOpsJson "POST" "/api/connectors/agent/jobs/$($Job.id)/result" $result | Out-Null
}}

Write-Host "SightOps Agent iniciado: $ConnectorId -> $BaseUrl"
Invoke-SightOpsJson "POST" "/api/connectors/agent/register" @{{ version = $Version; host = (Get-SightOpsHost) }} | Out-Null

while ($true) {{
  try {{
    Invoke-SightOpsJson "POST" "/api/connectors/agent/heartbeat" @{{ version = $Version; host = (Get-SightOpsHost) }} | Out-Null
    $poll = Invoke-SightOpsJson "GET" "/api/connectors/agent/jobs/poll" $null
    if ($poll.job) {{ Invoke-SightOpsJob $poll.job }}
  }} catch {{
    Write-Host ("Falha: " + $_.Exception.Message)
  }}
  Start-Sleep -Seconds 10
}}
"""


def _routeros_script_template(base_url: str, connector_id: str, token: str) -> str:
    base_url = base_url.rstrip("/")
    return f"""# SightOps RouterOS Connector MVP
# Cole no terminal do MikroTik. Ele cria um script e um scheduler de heartbeat.

:local baseUrl "{base_url}"
:local connectorId "{connector_id}"
:local token "{token}"

/system script remove [find name="sightops-connector"] 
/system scheduler remove [find name="sightops-connector"] 

/system script add name="sightops-connector" policy=read,write,test,policy source={{\
:local baseUrl "{base_url}";\
:local connectorId "{connector_id}";\
:local token "{token}";\
:local identity [/system identity get name];\
:local version [/system resource get version];\
:local board [/system routerboard get model];\
:local serial [/system routerboard get serial-number];\
:local uptime [/system resource get uptime];\
:local cpu [/system resource get cpu-load];\
:local totalMem [/system resource get total-memory];\
:local freeMem [/system resource get free-memory];\
:local dhcpCount [:len [/ip dhcp-server lease find]];\
:local arpCount [:len [/ip arp find]];\
:local neighborCount [:len [/ip neighbor find]];\
:local dhcpSample "";:local dhcpN 0;:foreach i in=[/ip dhcp-server lease find] do={{:if ($dhcpN < 40) do={{:set dhcpSample ($dhcpSample . [/ip dhcp-server lease get $i address] . "|" . [/ip dhcp-server lease get $i mac-address] . "|" . [/ip dhcp-server lease get $i status] . ";");:set dhcpN ($dhcpN + 1)}}}};\
:local arpSample "";:local arpN 0;:foreach i in=[/ip arp find] do={{:if ($arpN < 40) do={{:set arpSample ($arpSample . [/ip arp get $i address] . "|" . [/ip arp get $i mac-address] . ";");:set arpN ($arpN + 1)}}}};\
:local neighborSample "";:local neighN 0;:foreach i in=[/ip neighbor find] do={{:if ($neighN < 40) do={{:set neighborSample ($neighborSample . [/ip neighbor get $i address] . "|" . [/ip neighbor get $i mac-address] . ";");:set neighN ($neighN + 1)}}}};\
:local payload ("{{\\"version\\":\\"routeros-0.4\\",\\"host\\":{{\\"hostname\\":\\"" . $identity . "\\",\\"os\\":\\"RouterOS\\",\\"model\\":\\"" . $board . "\\",\\"serial\\":\\"" . $serial . "\\",\\"routeros\\":\\"" . $version . "\\",\\"uptime\\":\\"" . $uptime . "\\",\\"cpu_load\\":\\"" . $cpu . "\\",\\"memory_free\\":\\"" . $freeMem . "\\",\\"memory_total\\":\\"" . $totalMem . "\\"}},\\"inventory\\":{{\\"dhcp_leases\\":\\"" . $dhcpCount . "\\",\\"arp_entries\\":\\"" . $arpCount . "\\",\\"neighbors\\":\\"" . $neighborCount . "\\",\\"dhcp_sample\\":\\"" . $dhcpSample . "\\",\\"arp_sample\\":\\"" . $arpSample . "\\",\\"neighbor_sample\\":\\"" . $neighborSample . "\\"}}}}");\
/tool fetch url=($baseUrl . "/api/connectors/agent/heartbeat") http-method=post http-header-field=("x-sightops-connector-id:" . $connectorId . ",x-sightops-connector-token:" . $token . ",Content-Type:application/json") http-data=$payload dst-path=sightops-connector-last.json;\
/tool fetch url=($baseUrl . "/api/connectors/agent/routeros/job.rsc") http-method=get http-header-field=("x-sightops-connector-id:" . $connectorId . ",x-sightops-connector-token:" . $token) dst-path=sightops-routeros-job.rsc;\
/import file-name=sightops-routeros-job.rsc;\
}}

/system scheduler add name="sightops-connector" interval=1m start-time=startup on-event="/system script run sightops-connector"
/system script run sightops-connector

:put "SightOps RouterOS Connector instalado. O sinal deve aparecer online em ate 1 minuto."
"""


def build_agent_script(base_url: str, connector_id: str) -> str:
    row = get_connector(connector_id, include_token=True, enforce_tenant=True)
    if not row:
        raise ValueError("conector nao encontrado")
    return _agent_script_template(base_url=base_url, connector_id=_text(row.get("id")), token=_text(row.get("token")))


def build_routeros_script(base_url: str, connector_id: str) -> str:
    row = get_connector(connector_id, include_token=True, enforce_tenant=True)
    if not row:
        raise ValueError("conector nao encontrado")
    return _routeros_script_template(base_url=base_url, connector_id=_text(row.get("id")), token=_text(row.get("token")))
