from __future__ import annotations

import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from app.core.tenant_context import tenant_scoped_path
from app.services.connector_service import get_connector, list_connectors
from app.services.inventory_json import inventory_row_key, load_inventory_json, save_inventory_json

router = APIRouter(prefix="/api/deployments", tags=["deployments"])


def _deployments_path() -> Path:
    return tenant_scoped_path("deployments.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _text(value: Any) -> str:
    return str(value or "").strip()


def _norm_mac(value: Any) -> str:
    text = _text(value).lower().replace("-", ":").replace(".", ":")
    text = re.sub(r"[^0-9a-f:]", "", text)
    text = re.sub(r":+", ":", text).strip(":")
    if ":" not in text and len(text) == 12:
        text = ":".join(text[i:i + 2] for i in range(0, 12, 2))
    return text


def _read_rows() -> List[Dict[str, Any]]:
    path = _deployments_path()
    try:
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            return data if isinstance(data, list) else []
    except Exception:
        pass
    return []


def _write_rows(rows: List[Dict[str, Any]]) -> None:
    path = _deployments_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _connector_inventory(connector_id: str) -> Dict[str, Any]:
    row = get_connector(connector_id, include_token=False, enforce_tenant=True)
    if not row:
        raise HTTPException(status_code=404, detail="conector nao encontrado")
    inventory = row.get("inventory") if isinstance(row.get("inventory"), dict) else {}
    return {"connector": row, "inventory": inventory}


def _inventory_sources(inv: Dict[str, Any]) -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    for source, key in (("dhcp", "dhcp_rows"), ("arp", "arp_rows"), ("neighbor", "neighbor_rows")):
        for item in inv.get(key) or []:
            if not isinstance(item, dict):
                continue
            found = dict(item)
            found["source"] = source
            if not found.get("ip") and found.get("address"):
                found["ip"] = found.get("address")
            found["mac_norm"] = _norm_mac(found.get("mac") or found.get("mac_address"))
            rows.append(found)
    for source, key in (("dhcp", "dhcp_sample"), ("arp", "arp_sample"), ("neighbor", "neighbor_sample")):
        sample = _text(inv.get(key))
        if not sample:
            continue
        for chunk in sample.split(";"):
            parts = [part.strip() for part in chunk.split("|")]
            if len(parts) < 2 or not parts[0]:
                continue
            found = {
                "source": source,
                "ip": parts[0],
                "address": parts[0],
                "mac": parts[1],
                "status": parts[2] if len(parts) > 2 else "",
                "mac_norm": _norm_mac(parts[1]),
            }
            rows.append(found)
    return rows


def _lookup_in_connector(connector_id: str, query: str = "") -> Dict[str, Any]:
    data = _connector_inventory(connector_id)
    q = _text(query)
    q_mac = _norm_mac(q)
    q_low = q.lower()
    matches: List[Dict[str, Any]] = []
    for item in _inventory_sources(data["inventory"]):
        values = [
            _text(item.get("ip")),
            _text(item.get("address")),
            _text(item.get("host")),
            _text(item.get("identity")),
            _text(item.get("platform")),
            _text(item.get("mac")),
            _text(item.get("mac_address")),
            _text(item.get("mac_norm")),
        ]
        if not q or any(q_low and q_low in value.lower() for value in values) or (q_mac and q_mac == item.get("mac_norm")):
            matches.append(item)
    return {"ok": True, "connector": data["connector"], "matches": matches[:100], "count": len(matches)}


def _ip_in_use(ip: str, connector_id: str = "", site: str = "") -> Dict[str, Any]:
    wanted = _text(ip)
    matches: List[Dict[str, Any]] = []
    if connector_id:
        data = _connector_inventory(connector_id)
        for item in _inventory_sources(data["inventory"]):
            if _text(item.get("ip") or item.get("address")) == wanted:
                matches.append(item)
    for mode in ("basic", "olt", "switch"):
        for row in load_inventory_json(mode=mode, site=site) or []:
            if _text(row.get("ip") or row.get("IP")) == wanted:
                found = dict(row)
                found["source"] = f"inventory_{mode}"
                matches.append(found)
    return {"ip": wanted, "in_use": bool(matches), "matches": matches[:50]}


@router.get("")
def api_deployments_list() -> Dict[str, Any]:
    rows = list(reversed(_read_rows()))
    return {"ok": True, "deployments": rows[:100], "count": len(rows)}


@router.get("/lookup")
def api_deployments_lookup(connector_id: str, query: str = "") -> Dict[str, Any]:
    return _lookup_in_connector(connector_id, query)


@router.get("/ip-check")
def api_deployments_ip_check(ip: str, connector_id: str = "", site: str = "") -> Dict[str, Any]:
    if not _text(ip):
        raise HTTPException(status_code=400, detail="ip obrigatorio")
    return {"ok": True, **_ip_in_use(ip, connector_id=connector_id, site=site)}


@router.post("")
def api_deployments_save(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="payload invalido")
    row = dict(payload)
    row["id"] = _text(row.get("id")) or secrets.token_hex(8)
    row["created_at"] = row.get("created_at") or _now()
    row["updated_at"] = _now()
    rows = _read_rows()
    rows = [item for item in rows if _text(item.get("id")) != row["id"]]
    rows.append(row)
    _write_rows(rows)
    return {"ok": True, "deployment": row}


@router.post("/commit-camera")
def api_deployments_commit_camera(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="payload invalido")
    # camera_new_ip = IP que a camera vai assumir (o que fica registrado);
    # camera_ip = IP atual, usado so pra conectar/puxar dados na etapa anterior.
    ip = _text(payload.get("camera_new_ip")) or _text(payload.get("camera_ip"))
    title = _text(payload.get("camera_title"))
    if not ip:
        raise HTTPException(status_code=400, detail="ip da camera obrigatorio")
    if not title:
        raise HTTPException(status_code=400, detail="titulo da camera obrigatorio")

    connector_id = _text(payload.get("connector_id"))
    site = _text(payload.get("site") or payload.get("local"))
    mac = _norm_mac(payload.get("camera_mac"))
    row = {
        "ip": ip,
        "mac": mac,
        "fabricante": _text(payload.get("camera_manufacturer")),
        "modelo": _text(payload.get("camera_model")),
        "usuario": _text(payload.get("camera_user")),
        "senha": _text(payload.get("camera_password")),
        "titulo": title,
        "status": "online",
        "local": site,
        "site": site,
        "site_name": site,
        "physical_location": _text(payload.get("location")),
        "remote": bool(connector_id),
        "remote_connector_id": connector_id,
        "onu_serial": _text(payload.get("onu_serial")),
        "vlan": _text(payload.get("vlan")),
        "recorder_host": _text(payload.get("recorder_host")),
        "recorder_type": _text(payload.get("recorder_type")),
        "recorder_channel": _text(payload.get("recorder_channel")),
        "deployment_id": _text(payload.get("id")),
        "installed_at": _now(),
    }
    old_ip = _text(payload.get("camera_ip"))
    rows = load_inventory_json(mode="olt") or []
    key = inventory_row_key(row)
    updated = False
    for idx, existing in enumerate(rows):
        # Casa por IP (novo OU o IP atual usado na etapa de "puxar dados"),
        # por MAC, ou pela chave com connector_id -- o IP muda entre a etapa
        # de puxar dados (rescan-single-ip, sem remote_connector_id) e esta,
        # entao so a chave/IP novo nao bastam pra achar a mesma linha.
        existing_ip = _text(existing.get("ip"))
        existing_mac = _norm_mac(existing.get("mac"))
        same = (
            inventory_row_key(existing) == key
            or existing_ip == ip
            or (old_ip and existing_ip == old_ip)
            or (mac and existing_mac == mac)
        )
        if same:
            rows[idx] = {**existing, **row}
            updated = True
            break
    if not updated:
        rows.append(row)
    save_inventory_json(rows, mode="olt")

    saved = api_deployments_save({**payload, "status": "camera_registered", "camera_inventory_key": key})
    return {"ok": True, "created": not updated, "inventory_key": key, "camera": row, "deployment": saved.get("deployment")}


@router.get("/connectors")
def api_deployments_connectors() -> Dict[str, Any]:
    return list_connectors(include_token=False)
