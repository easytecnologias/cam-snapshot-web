from __future__ import annotations

import json
import logging
import re
from contextlib import redirect_stderr
from datetime import datetime, timezone
from typing import Any, Dict, Tuple
import io
import time

from fastapi import HTTPException

from app.core.paths import SAIDA_DIR
from app.core.perf import perf_step
from app.models.requests import (
    OltAddOnuRequest,
    OltCollectMacsRequest,
    OltDeleteOnuRequest,
    OltDiscoverOnusRequest,
    OltFindOnuRequest,
    OltOnuSignalRequest,
)
from app.cli.tools.olt_8820i_collect_macs import collect_macs_8820i, collect_onu_telemetry_8820i
from app.cli.tools.olt_4840e_collect_macs import collect_macs_4840e
from app.cli.tools.olt_8820i_add_onu import (
    OnuAddError,
    add_onu as _add_onu_8820i,
    delete_onu as _delete_onu_8820i,
    discover_unauthorized_onus,
    find_onu_by_serial,
    onu_signal as _onu_signal_8820i,
    profile_for_model,
)
from app.services.db_store import load_olt_cpe_state, save_olt_cpe_state
from app.services.inventory_json import load_inventory_json, save_inventory_json
from app.services.connector_service import get_connector, list_connectors

logger = logging.getLogger("cam-snapshot")


def _validate_olt_network_context(req: OltCollectMacsRequest) -> dict[str, Any] | None:
    origin = str(getattr(req, "scan_origin", "") or "local").strip().lower()
    if origin not in {"connector", "remote"}:
        return None

    connector_id = str(
        getattr(req, "remote_connector_id", None)
        or getattr(req, "connector_id", None)
        or ""
    ).strip()
    if not connector_id:
        raise HTTPException(400, "Selecione um conector para coletar OLT remota.")

    connector = get_connector(connector_id, include_token=False, enforce_tenant=True)
    if not connector:
        raise HTTPException(404, "Conector nao encontrado.")
    if str(connector.get("status") or "").lower() != "online":
        raise HTTPException(409, "Conector offline. Nao foi possivel coletar a OLT remota.")
    tunnel = connector.get("tunnel") if isinstance(connector.get("tunnel"), dict) else {}
    if not tunnel.get("enabled"):
        raise HTTPException(409, "VPN do conector nao configurada. Prepare a VPN antes de coletar a OLT.")
    return connector


def _dedup_cpes_by_key(cpes: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Remove duplicados por (mac, pon, onu_id) quando possível."""
    out: list[dict[str, Any]] = []
    seen: set[Tuple[str, str, str]] = set()
    for r in cpes:
        mac = (str(r.get("cpe_mac") or r.get("mac") or r.get("MAC") or "")).strip().lower()
        pon = (str(r.get("pon") or r.get("PON") or "")).strip()
        onu = (str(r.get("onu_id") or r.get("onu") or r.get("ONU") or "")).strip()
        site = (str(r.get("site") or r.get("SITE") or "")).strip().lower()
        olt_ip = (str(r.get("olt_ip") or r.get("OLT_IP") or "")).strip().lower()
        connector_id = (str(r.get("remote_connector_id") or r.get("connector_id") or "")).strip().lower()
        key = (mac, f"{connector_id}|{site}|{olt_ip}|{pon}", onu)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _norm_text(value: Any) -> str:
    return str(value or "").strip()


def _norm_mac(value: Any) -> str:
    return re.sub(r"[^0-9a-f]", "", _norm_text(value).lower())


def _norm_onu_serial(value: Any) -> str:
    raw = _norm_text(value).upper()
    # OLTs Intelbras costumam alternar entre VSOL00181583 e 00181583.
    return re.sub(r"^(VSOL|HWTC|ZTEG|ALCL|FHTT)", "", raw)


def _full_onu_serial(serial: Any, vendor: Any = "") -> str:
    serial_text = _norm_text(serial).upper()
    vendor_text = re.sub(r"[^A-Z0-9]", "", _norm_text(vendor).upper())
    if serial_text and len(serial_text) == 8 and len(vendor_text) == 4 and not serial_text.startswith(vendor_text):
        return f"{vendor_text}{serial_text}"
    return serial_text


def _sync_camera_inventory_from_olt_rows(
    olt_rows: list[dict[str, Any]],
    clear_macs: set[str] | None = None,
) -> dict[str, int]:
    """Sincroniza a topologia OLT das cameras pelo MAC sem alterar dados da camera."""
    cameras = load_inventory_json(mode="olt") or []
    by_scope_mac: dict[tuple[str, str], dict[str, Any]] = {}
    by_mac: dict[str, list[dict[str, Any]]] = {}
    for row in olt_rows:
        mac = _norm_mac(row.get("cpe_mac") or row.get("mac") or row.get("MAC"))
        if not mac:
            continue
        connector_id = _norm_text(row.get("connector_id") or row.get("remote_connector_id"))
        by_scope_mac[(connector_id, mac)] = row
        by_mac.setdefault(mac, []).append(row)

    topology_fields = {
        "pon": ("pon", "PON"),
        "onu_id": ("onu_id", "onu", "ONU", "ONU_ID"),
        "onu_name": ("onu_name", "ONU_NAME"),
        "onu_serial": ("onu_serial", "serial", "SERIAL", "ONU_SERIAL"),
        "onu_model": ("onu_model", "model", "ONU_MODEL"),
        "olt_ip": ("olt_ip", "OLT_IP"),
        "olt_name": ("olt_name", "OLT_NAME"),
        "vlan": ("vlan", "VLAN"),
    }
    changed = 0
    cleared = 0
    normalized_clear = {_norm_mac(mac) for mac in (clear_macs or set()) if _norm_mac(mac)}
    for camera in cameras:
        mac = _norm_mac(camera.get("mac") or camera.get("MAC"))
        if not mac:
            continue
        connector_id = _norm_text(camera.get("connector_id") or camera.get("remote_connector_id"))
        match = by_scope_mac.get((connector_id, mac))
        if match is None and len(by_mac.get(mac, [])) == 1:
            match = by_mac[mac][0]
        camera_changed = False
        if match is not None:
            for target, source_keys in topology_fields.items():
                value = next((_norm_text(match.get(key)) for key in source_keys if _norm_text(match.get(key))), "")
                if _norm_text(camera.get(target)) != value:
                    camera[target] = value
                    camera_changed = True
        elif mac in normalized_clear:
            for target in topology_fields:
                if _norm_text(camera.get(target)):
                    camera[target] = ""
                    camera_changed = True
            if camera_changed:
                cleared += 1
        if camera_changed:
            changed += 1
    if changed:
        save_inventory_json(cameras, mode="olt")
    return {"updated_cameras": changed, "cleared_cameras": cleared}


def _req_connector_id(req: Any) -> str:
    return _norm_text(getattr(req, "remote_connector_id", "") or getattr(req, "connector_id", ""))


def _req_connector_name(req: Any) -> str:
    return _norm_text(getattr(req, "connector_name", ""))


def _row_connector_id(row: dict[str, Any]) -> str:
    return _norm_text(row.get("remote_connector_id") or row.get("connector_id"))


def _same_connector_scope(row: dict[str, Any], req: Any) -> bool:
    connector_id = _req_connector_id(req)
    if not connector_id:
        return True
    # Coletas antigas nao registravam o conector. Como o estado ja esta
    # isolado por tenant e o chamador tambem compara OLT/PON/ONU, permita que
    # essas linhas legadas recebam telemetria e sejam migradas para o conector
    # cadastrado. Um conector diferente e conhecido continua bloqueado.
    row_connector_id = _row_connector_id(row)
    return not row_connector_id or row_connector_id == connector_id


def _same_onu_position(row: dict[str, Any], olt_ip: str, pon: int, onu: int) -> bool:
    return (
        _norm_text(row.get("olt_ip") or row.get("OLT_IP")).lower() == _norm_text(olt_ip).lower()
        and _norm_text(row.get("pon") or row.get("PON")) == str(int(pon))
        and _norm_text(row.get("onu_id") or row.get("onu") or row.get("ONU")) == str(int(onu))
    )


def _same_onu_identity(row: dict[str, Any], olt_ip: str, pon: int, onu: int, serial: Any = "") -> bool:
    if _same_onu_position(row, olt_ip, pon, onu):
        return True
    serial_norm = _norm_onu_serial(serial)
    row_serial = _norm_onu_serial(row.get("onu_serial") or row.get("serial") or row.get("SERIAL"))
    return bool(
        serial_norm
        and row_serial
        and serial_norm == row_serial
        and _norm_text(row.get("olt_ip") or row.get("OLT_IP")).lower() == _norm_text(olt_ip).lower()
    )


def _infer_olt_inventory_scope(rows: list[dict[str, Any]], olt_ip: str) -> tuple[str, str]:
    for row in rows:
        if _norm_text(row.get("olt_ip") or row.get("OLT_IP")).lower() != _norm_text(olt_ip).lower():
            continue
        site = _norm_text(row.get("site") or row.get("SITE") or row.get("local"))
        olt_name = _norm_text(row.get("olt_name") or row.get("OLT") or row.get("olt"))
        if site or olt_name:
            return site, olt_name
    return "", ""


def _inventory_vlan_from_request(req: OltAddOnuRequest) -> str:
    vlans: list[str] = []
    for entry in req.services or []:
        vlan = int(getattr(entry, "vlan", 0) or 0)
        if vlan > 0:
            vlans.append(str(vlan))
    if not vlans and int(req.vlan or 0) > 0:
        vlans.append(str(int(req.vlan)))
    return ",".join(dict.fromkeys(vlans))


def _upsert_onu_inventory(req: OltAddOnuRequest, result: dict[str, Any]) -> dict[str, Any]:
    slot = int(result.get("slot") or result.get("onu") or 0)
    pon = int(result.get("pon") or req.pon or 0)
    if not slot or not pon:
        return {"ok": False, "updated": False, "reason": "sem posicao da ONU"}

    obj = load_olt_cpe_state() or {}
    existing_rows = [r for r in list(obj.get("cpes") or obj.get("rows") or []) if isinstance(r, dict)]
    inferred_site, inferred_olt_name = _infer_olt_inventory_scope(existing_rows, req.olt_ip)
    site = _norm_text(req.site) or inferred_site
    olt_name = _norm_text(req.olt_name) or inferred_olt_name
    serial = _full_onu_serial(req.serial, req.vendor)
    model = " ".join(x for x in [_norm_text(req.vendor), _norm_text(req.onu_model)] if x).strip()
    description = _norm_text(req.description)
    connector_id = _req_connector_id(req)
    connector_name = _req_connector_name(req)

    kept = [r for r in existing_rows if not (_same_connector_scope(r, req) and _same_onu_position(r, req.olt_ip, pon, slot))]
    row = {
        "site": site,
        "olt_ip": _norm_text(req.olt_ip),
        "olt_name": olt_name,
        "olt_model": "8820i",
        "pon": pon,
        "onu_id": slot,
        "onu_name": description or f"gpon {pon} onu {slot}",
        "onu_serial": serial,
        "onu_model": model,
        "terminal": _norm_text(req.terminal) or "onu",
        "service": _norm_text(req.service) or "downlink",
        "vlan": _inventory_vlan_from_request(req),
        "tag_mode": _norm_text(req.tag_mode) or "tagged",
        "cpe_mac": "",
        "source": "implantacao-onu",
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if connector_id:
        row["remote_connector_id"] = connector_id
        row["connector_id"] = connector_id
        row["remote_connector_name"] = connector_name
        row["remote"] = True
    out_obj = {
        **{k: v for k, v in obj.items() if k not in ("cpes", "rows")},
        "olt": obj.get("olt") if isinstance(obj.get("olt"), dict) else {},
        "cpes": _dedup_cpes_by_key(kept + [row]),
    }
    save_olt_cpe_state(out_obj)
    return {"ok": True, "updated": True, "row": row, "count": len(out_obj["cpes"])}


def _remove_onu_inventory(req: OltDeleteOnuRequest) -> dict[str, Any]:
    obj = load_olt_cpe_state() or {}
    existing_rows = [r for r in list(obj.get("cpes") or obj.get("rows") or []) if isinstance(r, dict)]
    serial = _norm_text(req.serial).upper()

    def _matches(row: dict[str, Any]) -> bool:
        if not _same_connector_scope(row, req):
            return False
        if _same_onu_position(row, req.olt_ip, req.pon, req.onu):
            return True
        return bool(serial and _norm_text(row.get("onu_serial")).upper() == serial)

    removed_rows = [r for r in existing_rows if _matches(r)]
    kept = [r for r in existing_rows if not _matches(r)]
    removed = len(existing_rows) - len(kept)
    out_obj = {
        **{k: v for k, v in obj.items() if k not in ("cpes", "rows")},
        "olt": obj.get("olt") if isinstance(obj.get("olt"), dict) else {},
        "cpes": kept,
    }
    save_olt_cpe_state(out_obj)
    camera_sync = _sync_camera_inventory_from_olt_rows(
        kept,
        clear_macs={_norm_text(row.get("cpe_mac") or row.get("mac")) for row in removed_rows},
    )
    return {"ok": True, "removed": removed, "remaining": len(kept), **camera_sync}


def _sync_authorized_onu_devices(
    req: OltAddOnuRequest,
    result: dict[str, Any],
    attempts: int = 3,
) -> dict[str, Any]:
    """Consulta a ONU recem-autorizada e grava os MACs aprendidos no inventario."""
    pon = int(result.get("pon") or req.pon or 0)
    onu = int(result.get("slot") or result.get("onu") or 0)
    if not pon or not onu:
        return {"ok": False, "updated": False, "reason": "sem posicao da ONU"}

    signal_req = OltOnuSignalRequest(
        olt_id=req.olt_id,
        olt_ip=req.olt_ip,
        user=req.user,
        password=req.password,
        pon=pon,
        onu=onu,
        serial=req.serial,
        site=req.site,
        olt_name=req.olt_name,
        connector_id=req.connector_id,
        remote_connector_id=req.remote_connector_id,
        connector_name=req.connector_name,
        timeout=max(12.0, float(req.timeout or 0)),
    )
    last_result: dict[str, Any] = {}
    for attempt in range(max(1, attempts)):
        if attempt:
            time.sleep(2.0 * attempt)
        try:
            signal = _onu_signal_8820i(
                olt_ip=signal_req.olt_ip,
                user=signal_req.user,
                password=signal_req.password,
                pon=pon,
                onu=onu,
                serial=signal_req.serial,
                timeout=signal_req.timeout,
            )
            if not signal.get("ok"):
                last_result = {"ok": False, "updated": False, "reason": signal.get("error") or "consulta sem resposta"}
                continue
            _enrich_signal_macs_with_ips(signal)
            last_result = _sync_onu_signal_inventory(signal_req, signal)
            last_result["attempt"] = attempt + 1
            if int(last_result.get("macs") or 0) > 0:
                return last_result
        except Exception as exc:
            last_result = {"ok": False, "updated": False, "reason": str(exc), "attempt": attempt + 1}
            logger.warning("ONU autorizada, mas a tentativa %s de sincronizar MACs falhou: %s", attempt + 1, exc)
    return last_result or {"ok": True, "updated": False, "macs": 0, "reason": "ONU ainda sem MAC aprendido"}


def _vlan_from_interface(value: Any) -> str:
    match = re.search(r"\bvlan\s+(\d+)\b", _norm_text(value), re.IGNORECASE)
    return match.group(1) if match else ""


def _add_mac_ip(index: dict[str, dict[str, str]], mac: Any, ip: Any, source: str) -> None:
    mac_key = _norm_mac(mac)
    ip_text = _norm_text(ip)
    if not mac_key or not ip_text:
        return
    index.setdefault(mac_key, {"ip": ip_text, "source": source})


def _parse_connector_sample(sample: Any) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []
    for chunk in _norm_text(sample).split(";"):
        parts = [part.strip() for part in chunk.split("|")]
        if len(parts) >= 2 and parts[0] and parts[1]:
            rows.append({"ip": parts[0], "mac": parts[1]})
    return rows


def _known_mac_ip_index() -> dict[str, dict[str, str]]:
    index: dict[str, dict[str, str]] = {}

    for mode in ("olt", "basic", "switch"):
        try:
            for row in load_inventory_json(mode=mode) or []:
                _add_mac_ip(index, row.get("mac") or row.get("MAC") or row.get("cpe_mac"), row.get("ip") or row.get("IP"), f"inventario-{mode}")
        except Exception:
            logger.debug("Nao consegui usar inventario %s como indice MAC->IP", mode, exc_info=True)

    try:
        obj = load_olt_cpe_state() or {}
        for row in list(obj.get("cpes") or obj.get("rows") or []):
            if isinstance(row, dict):
                _add_mac_ip(index, row.get("cpe_mac") or row.get("mac"), row.get("ip") or row.get("camera_ip"), "olt-cpe")
    except Exception:
        logger.debug("Nao consegui usar inventario OLT como indice MAC->IP", exc_info=True)

    try:
        connectors = list_connectors(include_token=False).get("connectors") or []
        for connector in connectors:
            inventory = connector.get("inventory") if isinstance(connector.get("inventory"), dict) else {}
            for key in ("dhcp_rows", "arp_rows", "neighbor_rows"):
                for row in inventory.get(key) or []:
                    if isinstance(row, dict):
                        _add_mac_ip(index, row.get("mac") or row.get("mac_address"), row.get("ip") or row.get("address"), f"conector-{key}")
            for key in ("dhcp_sample", "arp_sample", "neighbor_sample"):
                for row in _parse_connector_sample(inventory.get(key)):
                    _add_mac_ip(index, row.get("mac"), row.get("ip"), f"conector-{key}")
    except Exception:
        logger.debug("Nao consegui usar conectores como indice MAC->IP", exc_info=True)

    return index


def _enrich_signal_macs_with_ips(result: dict[str, Any]) -> None:
    macs = [m for m in list(result.get("macs") or []) if isinstance(m, dict)]
    if not macs:
        return
    index = _known_mac_ip_index()
    for mac in macs:
        mac_key = _norm_mac(mac.get("mac") or mac.get("cpe_mac"))
        found = index.get(mac_key) if mac_key else None
        if found and found.get("ip"):
            mac["ip"] = found["ip"]
            mac["ip_source"] = found.get("source", "")
    result["macs"] = macs


def _sync_onu_signal_inventory(req: OltOnuSignalRequest, result: dict[str, Any]) -> dict[str, Any]:
    pon = int(result.get("pon") or req.pon or 0)
    onu = int(result.get("onu") or req.onu or 0)
    if not pon or not onu:
        return {"ok": False, "updated": False, "reason": "sem posicao da ONU"}

    obj = load_olt_cpe_state() or {}
    existing_rows = [r for r in list(obj.get("cpes") or obj.get("rows") or []) if isinstance(r, dict)]
    serial = result.get("serial") or req.serial
    matching_rows = [r for r in existing_rows if _same_onu_identity(r, req.olt_ip, pon, onu, serial)]
    if _req_connector_id(req):
        matching_rows = [r for r in matching_rows if _same_connector_scope(r, req)]
    inferred_site, inferred_olt_name = _infer_olt_inventory_scope(existing_rows, req.olt_ip)
    inferred_site = _norm_text(req.site) or inferred_site
    inferred_olt_name = _norm_text(req.olt_name) or inferred_olt_name
    if matching_rows:
        inferred_site = _norm_text(matching_rows[0].get("site") or matching_rows[0].get("SITE") or matching_rows[0].get("local")) or inferred_site
        inferred_olt_name = _norm_text(matching_rows[0].get("olt_name") or matching_rows[0].get("OLT") or matching_rows[0].get("olt")) or inferred_olt_name

    serial_candidates = [
        _norm_text(result.get("serial")),
        _norm_text(req.serial),
        *[_norm_text(row.get("onu_serial") or row.get("serial")) for row in matching_rows],
    ]
    serial = max((value.upper() for value in serial_candidates if value), key=len, default="")

    base_vlan = ""
    base_onu_name = f"gpon {pon} onu {onu}"
    for row in matching_rows:
        base_vlan = base_vlan or _norm_text(row.get("vlan"))
        base_onu_name = _norm_text(row.get("onu_name")) or base_onu_name

    macs = [m for m in list(result.get("macs") or []) if isinstance(m, dict)]
    if not macs:
        # Sem MAC aprendido nao deve destruir uma linha existente que talvez ja tenha MAC.
        return {"ok": True, "updated": False, "macs": 0, "rows": 0, "reason": "sem mac aprendido", "count": len(existing_rows)}

    now = datetime.now(timezone.utc).isoformat()
    connector_id = _req_connector_id(req)
    connector_name = _req_connector_name(req)
    new_rows: list[dict[str, Any]] = []
    for mac in macs:
        iface = _norm_text(mac.get("interface"))
        row = {
            "site": inferred_site,
            "olt_ip": _norm_text(req.olt_ip),
            "olt_name": inferred_olt_name,
            "olt_model": "8820i",
            "pon": pon,
            "onu_id": onu,
            "onu_name": base_onu_name,
            "onu_serial": serial,
            "onu_model": _norm_text(result.get("model")),
            "profile": _norm_text(result.get("profile")),
            "oper_status": _norm_text(result.get("oper_status")),
            "omci_status": _norm_text(result.get("omci_status")),
            "olt_rx": _norm_text(result.get("olt_rx")),
            "onu_rx": _norm_text(result.get("onu_rx")),
            "distance_km": _norm_text(result.get("distance_km")),
            "vlan": _vlan_from_interface(iface) or base_vlan,
            "cpe_mac": _norm_text(mac.get("mac") or mac.get("cpe_mac")).lower(),
            "ip": _norm_text(mac.get("ip")),
            "interface": iface,
            "source": "implantacao-onu-signal",
            "updated_at": now,
        }
        if connector_id:
            row["remote_connector_id"] = connector_id
            row["connector_id"] = connector_id
            row["remote_connector_name"] = connector_name
            row["remote"] = True
        new_rows.append(row)

    kept = [r for r in existing_rows if not (_same_connector_scope(r, req) and _same_onu_identity(r, req.olt_ip, pon, onu, serial))]
    out_obj = {
        **{k: v for k, v in obj.items() if k not in ("cpes", "rows")},
        "olt": obj.get("olt") if isinstance(obj.get("olt"), dict) else {},
        "cpes": _dedup_cpes_by_key(kept + new_rows),
    }
    save_olt_cpe_state(out_obj)
    camera_sync = _sync_camera_inventory_from_olt_rows(out_obj["cpes"])
    return {"ok": True, "updated": True, "macs": len([r for r in new_rows if r.get("cpe_mac")]), "rows": len(new_rows), "count": len(out_obj["cpes"]), **camera_sync}


def collect_macs(req: OltCollectMacsRequest) -> Dict[str, Any]:
    """Coleta MACs/CPEs na OLT Intelbras (8820i/4840e) e escreve olt-cpe-macs.json (compat legado)."""
    connector = _validate_olt_network_context(req)
    connector_id = str(getattr(req, "remote_connector_id", None) or getattr(req, "connector_id", None) or "").strip()
    connector_name = str((connector or {}).get("name") or (connector or {}).get("client") or "").strip()
    with perf_step("OLT_collect_macs_total"):
        stderr_buf = io.StringIO()

        try:
            with redirect_stderr(stderr_buf):
                with perf_step("OLT_collect_macs_driver"):
                    model = ((req.olt_model or "8820i").strip().lower())
                    if model in ("4840e", "intelbras_4840e", "intelbras_4840e_epon", "4840e_epon", "4840"):
                        rows = collect_macs_4840e(
                            olt_ip=req.olt_ip,
                            user=req.user,
                            password=req.password,
                            pon=req.pon,
                            olt_name=req.olt_name or "OLT-4840E",
                            port=22,
                        )
                    else:
                        rows = collect_macs_8820i(
                            olt_ip=req.olt_ip,
                            user=req.user,
                            password=req.password,
                            pon=req.pon,
                            olt_name=req.olt_name or "OLT-8820I",
                            timeout=12.0,
                        )
        except Exception as e:
            cli_log = stderr_buf.getvalue()
            logger.error(f"Erro ao consultar OLT: {e}")
            if cli_log:
                logger.error(cli_log)
            raise HTTPException(500, f"Erro ao consultar OLT: {e}") from e

        cli_log = stderr_buf.getvalue()
        json_path = None

        try:
            with perf_step("OLT_write_json_olt-cpe-macs.json"):
                SAIDA_DIR.mkdir(parents=True, exist_ok=True)
                json_path = SAIDA_DIR / "olt-cpe-macs.json"

                existing_cpes: list[dict[str, Any]] = []
                existing_meta: dict[str, Any] = {}

                try:
                    obj = load_olt_cpe_state() or {}
                    if not obj and json_path.exists():
                        obj = json.loads(json_path.read_text(encoding="utf-8"))
                    if isinstance(obj, dict):
                        existing_cpes = list(obj.get("cpes") or obj.get("rows") or [])
                        existing_meta = {k: v for k, v in obj.items() if k not in ("cpes", "rows")}
                except Exception:
                    existing_cpes = []
                    existing_meta = {}

                # Normaliza: o legado retorna list[dict]
                site = str(getattr(req, "site", "") or "").strip()
                if connector and not site:
                    site = str(connector.get("site") or connector.get("client") or "").strip()
                new_cpes: list[dict[str, Any]] = []
                old_by_mac = {
                    _norm_mac(item.get("cpe_mac") or item.get("mac")): item
                    for item in existing_cpes
                    if isinstance(item, dict) and _norm_mac(item.get("cpe_mac") or item.get("mac"))
                }
                for r in list(rows or []):
                    if not isinstance(r, dict):
                        continue
                    rr = dict(r)
                    rr["site"] = site
                    rr["olt_ip"] = req.olt_ip
                    rr["olt_model"] = req.olt_model or "8820i"
                    old = old_by_mac.get(_norm_mac(rr.get("cpe_mac") or rr.get("mac"))) or {}
                    old_serial = _norm_text(old.get("onu_serial") or old.get("serial"))
                    new_serial = _norm_text(rr.get("onu_serial") or rr.get("serial"))
                    if len(old_serial) > len(new_serial):
                        rr["onu_serial"] = old_serial
                    if connector_id:
                        rr["remote_connector_id"] = connector_id
                        rr["connector_id"] = connector_id
                        rr["remote_connector_name"] = connector_name
                    new_cpes.append(rr)

                if getattr(req, "reuse_json", False):
                    all_cpes = new_cpes + existing_cpes
                else:
                    # Atualiza apenas o escopo atual (site + olt_ip), mantendo outras OLTs/sites.
                    def _same_scope(x: dict[str, Any]) -> bool:
                        return (
                            str(x.get("olt_ip") or "").strip() == str(req.olt_ip or "").strip()
                            and str(x.get("site") or "").strip().lower() == site.lower()
                            and str(x.get("remote_connector_id") or x.get("connector_id") or "").strip() == connector_id
                        )

                    kept = [x for x in existing_cpes if isinstance(x, dict) and not _same_scope(x)]
                    all_cpes = kept + new_cpes
                all_cpes = _dedup_cpes_by_key(all_cpes)

                out_obj = {
                    **(existing_meta or {}),
                    "olt": {
                        "ip": req.olt_ip,
                        "name": req.olt_name,
                        "model": req.olt_model or "8820i",
                        "pon": req.pon,
                        "site": site,
                    },
                    "cpes": all_cpes,
                }

                save_olt_cpe_state(out_obj)
                camera_sync = _sync_camera_inventory_from_olt_rows(all_cpes)
                if json_path is not None and not json_path.exists():
                    json_path = None
        except Exception as e:
            logger.error(f"Erro ao salvar JSON da OLT: {e}")
            raise HTTPException(500, f"Erro ao salvar JSON da OLT: {e}") from e

        return {
            "ok": True,
            "rows": new_cpes,
            "rows_all": all_cpes,
            "count": len(list(rows or [])),
            "count_all": len(list(all_cpes or [])),
            "json_path": str(json_path) if json_path else None,
            "cli_log": cli_log,
            "camera_sync": camera_sync,
        }


def collect_onu_telemetry(req: OltCollectMacsRequest) -> Dict[str, Any]:
    """Atualiza status/sinal das ONUs preservando MACs e demais dados do inventario."""
    connector = _validate_olt_network_context(req)
    model = _norm_text(req.olt_model or "8820i").lower()
    if model not in {"8820i", "intelbras_8820i"}:
        raise HTTPException(422, "Telemetria leve disponivel para Intelbras 8820i.")
    try:
        telemetry = collect_onu_telemetry_8820i(
            olt_ip=req.olt_ip,
            user=req.user,
            password=req.password,
            pon=req.pon or "all",
            timeout=12.0,
        )
    except Exception as exc:
        logger.exception("Erro ao coletar telemetria da OLT %s", req.olt_ip)
        raise HTTPException(500, f"Erro ao coletar telemetria da OLT: {exc}") from exc

    obj = load_olt_cpe_state() or {}
    existing = [row for row in list(obj.get("cpes") or obj.get("rows") or []) if isinstance(row, dict)]
    connector_id = _req_connector_id(req)
    connector_name = _req_connector_name(req) or _norm_text((connector or {}).get("name"))
    site, inferred_name = _infer_olt_inventory_scope(existing, req.olt_ip)
    site = _norm_text(req.site) or site or _norm_text((connector or {}).get("site"))
    olt_name = _norm_text(req.olt_name) or inferred_name
    now = datetime.now(timezone.utc).isoformat()
    updated_positions: set[tuple[int, int]] = set()
    with_signal = 0

    for item in telemetry:
        pon_id = int(item.get("pon") or 0)
        onu_id = int(item.get("onu_id") or 0)
        if not pon_id or not onu_id:
            continue
        matches = [
            row for row in existing
            if _same_onu_position(row, req.olt_ip, pon_id, onu_id) and _same_connector_scope(row, req)
        ]
        values = {
            "onu_serial": _norm_text(item.get("serial")),
            "oper_status": _norm_text(item.get("oper_status")),
            "omci_status": _norm_text(item.get("omci_status")),
            "olt_rx": _norm_text(item.get("rx_olt")),
            "onu_rx": _norm_text(item.get("rx_onu")),
            "distance_km": _norm_text(item.get("distance_km")),
            # A telemetria periodica nao e uma acao recente do tecnico. Manter
            # esse horario separado evita reordenar o historico de implantacao.
            "telemetry_updated_at": now,
        }
        if values["olt_rx"] or values["onu_rx"]:
            with_signal += 1
        if matches:
            for row in matches:
                row_values = dict(values)
                current_serial = _norm_text(row.get("onu_serial") or row.get("serial"))
                if len(current_serial) > len(row_values["onu_serial"]):
                    row_values["onu_serial"] = current_serial
                row.update(row_values)
                if connector_id and not _row_connector_id(row):
                    row.update({
                        "remote_connector_id": connector_id,
                        "connector_id": connector_id,
                        "remote_connector_name": connector_name,
                        "remote": True,
                    })
        else:
            row = {
                "site": site,
                "olt_ip": _norm_text(req.olt_ip),
                "olt_name": olt_name,
                "olt_model": req.olt_model or "8820i",
                "pon": pon_id,
                "onu_id": onu_id,
                "onu_name": _norm_text(item.get("name")) or f"gpon {pon_id} onu {onu_id}",
                "cpe_mac": "",
                "source": "olt-telemetry",
                **values,
            }
            if connector_id:
                row.update({
                    "remote_connector_id": connector_id,
                    "connector_id": connector_id,
                    "remote_connector_name": connector_name,
                    "remote": True,
                })
            existing.append(row)
        updated_positions.add((pon_id, onu_id))

    out_obj = {
        **{key: value for key, value in obj.items() if key not in ("cpes", "rows")},
        "olt": obj.get("olt") if isinstance(obj.get("olt"), dict) else {},
        "cpes": _dedup_cpes_by_key(existing),
    }
    save_olt_cpe_state(out_obj)
    camera_sync = _sync_camera_inventory_from_olt_rows(out_obj["cpes"])
    return {
        "ok": True,
        "olt_id": getattr(req, "olt_id", None),
        "onus": len(updated_positions),
        "with_signal": with_signal,
        "rows": len(out_obj["cpes"]),
        "camera_sync": camera_sync,
    }


def clear_macs(site: str = "") -> Dict[str, Any]:
    """Apaga dados OLT persistidos (DB-first) e fallback JSON legado."""
    site_norm = str(site or "").strip().lower()
    before = 0
    removed_rows = 0
    kept_rows: list[dict[str, Any]] = []
    existing_obj: dict[str, Any] = {}
    try:
        obj = load_olt_cpe_state() or {}
        if isinstance(obj, dict):
            existing_obj = obj
            rows = list(obj.get("cpes") or obj.get("rows") or [])
            before = len(rows)
            if site_norm:
                def _matches(r: dict[str, Any]) -> bool:
                    vals = [
                        str(r.get("site") or "").strip(),
                        str(r.get("SITE") or "").strip(),
                        str(r.get("local") or "").strip(),
                    ]
                    return any(v.lower() == site_norm for v in vals if v)
                kept_rows = [r for r in rows if not (isinstance(r, dict) and _matches(r))]
                removed_rows = max(0, len(rows) - len(kept_rows))
    except Exception:
        before = 0

    # DB-first
    if site_norm:
        out_obj = {
            **{k: v for k, v in existing_obj.items() if k not in ("cpes", "rows")},
            "olt": existing_obj.get("olt") if isinstance(existing_obj.get("olt"), dict) else {},
            "cpes": kept_rows,
        }
        save_olt_cpe_state(out_obj)
        return {
            "ok": True,
            "cleared": True,
            "scope": "site",
            "site": site.strip(),
            "removed_rows": int(removed_rows),
            "remaining": len(kept_rows),
            "removed_file": False,
        }

    save_olt_cpe_state({"olt": {}, "cpes": []})

    removed_file = False
    try:
        p = SAIDA_DIR / "olt-cpe-macs.json"
        if p.exists():
            p.unlink(missing_ok=True)
            removed_file = True
    except Exception:
        removed_file = False

    return {"ok": True, "cleared": True, "scope": "all", "removed_rows": int(before), "removed_file": removed_file}


def list_macs(site: str = "") -> Dict[str, Any]:
    """Lista dados OLT persistidos (DB-first), com filtro opcional por site."""
    site_norm = str(site or "").strip().lower()
    rows: list[dict[str, Any]] = []

    try:
        obj = load_olt_cpe_state() or {}
        if isinstance(obj, dict):
            base = list(obj.get("cpes") or obj.get("rows") or [])
            rows = [r for r in base if isinstance(r, dict)]
    except Exception:
        rows = []

    if site_norm:
        def _matches(r: dict[str, Any]) -> bool:
            vals = [
                str(r.get("site") or "").strip(),
                str(r.get("SITE") or "").strip(),
                str(r.get("local") or "").strip(),
            ]
            return any(v.lower() == site_norm for v in vals if v)

        rows = [r for r in rows if _matches(r)]

    rows = _dedup_cpes_by_key(rows)
    return {
        "ok": True,
        "rows": rows,
        "count": len(rows),
        "site": site.strip(),
    }


def discover_onus(req: OltDiscoverOnusRequest) -> Dict[str, Any]:
    """Descobre ONUs nao autorizadas + posicoes livres na OLT Intelbras 8820i.

    So a 8820i tem esse fluxo mapeado por enquanto (a 4840e nao tem comando
    de autorizacao confirmado ainda).
    """
    with perf_step("OLT_discover_onus"):
        try:
            return discover_unauthorized_onus(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                pon=req.pon,
                timeout=req.timeout,
            )
        except Exception as e:
            logger.error(f"Erro ao descobrir ONUs na OLT: {e}")
            raise HTTPException(500, f"Erro ao descobrir ONUs na OLT: {e}") from e


def add_onu(req: OltAddOnuRequest) -> Dict[str, Any]:
    """Autoriza uma ONU descoberta (serno_id) na OLT Intelbras 8820i, com
    servico/VLAN opcional. Equipamento vivo -- ver aviso na UI de Implantacao."""
    profile = (req.profile or "").strip() or profile_for_model(req.onu_model, req.terminal)
    services = [{"service": e.service, "vlan": e.vlan} for e in req.services] if req.services else None
    with perf_step("OLT_add_onu"):
        try:
            result = _add_onu_8820i(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                pon=req.pon,
                serno_id=req.serno_id,
                profile=profile,
                description=req.description,
                service=req.service,
                vlan=req.vlan,
                services=services,
                tag_mode=req.tag_mode,
                terminal=req.terminal,
                timeout=req.timeout,
            )
            if result.get("ok"):
                result["inventory"] = _upsert_onu_inventory(req, result)
                result["device_sync"] = _sync_authorized_onu_devices(req, result)
            return result
        except OnuAddError as e:
            return {
                "ok": False,
                "error": str(e),
                "failed_at": e.failed_command,
                "commands_run": e.commands_run,
            }
        except Exception as e:
            logger.error(f"Erro ao autorizar ONU na OLT: {e}")
            raise HTTPException(500, f"Erro ao autorizar ONU na OLT: {e}") from e


def find_onu(req: OltFindOnuRequest) -> Dict[str, Any]:
    """Localiza uma ONU ja autorizada pelo serial, na OLT Intelbras 8820i."""
    with perf_step("OLT_find_onu"):
        try:
            found = find_onu_by_serial(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                serial=req.serial,
                timeout=req.timeout,
            )
        except Exception as e:
            logger.error(f"Erro ao localizar ONU na OLT: {e}")
            raise HTTPException(500, f"Erro ao localizar ONU na OLT: {e}") from e
    if not found:
        return {"ok": False, "error": "ONU nao encontrada para esse serial."}
    return {"ok": True, **found}


def delete_onu(req: OltDeleteOnuRequest) -> Dict[str, Any]:
    """Exclui uma ONU ja autorizada (posicao pon/onu) na OLT Intelbras 8820i.

    Equipamento vivo -- remove o cadastro e desliga o servico da ONU."""
    with perf_step("OLT_delete_onu"):
        try:
            result = _delete_onu_8820i(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                pon=req.pon,
                onu=req.onu,
                timeout=req.timeout,
            )
            if result.get("ok"):
                result["inventory"] = _remove_onu_inventory(req)
            return result
        except Exception as e:
            logger.error(f"Erro ao excluir ONU na OLT: {e}")
            raise HTTPException(500, f"Erro ao excluir ONU na OLT: {e}") from e


def onu_signal(req: OltOnuSignalRequest) -> Dict[str, Any]:
    """Consulta sinal (RX/distancia/status) e MACs aprendidos atras de uma
    ONU ja autorizada na OLT Intelbras 8820i. Aceita serial OU pon+onu."""
    with perf_step("OLT_onu_signal"):
        try:
            result = _onu_signal_8820i(
                olt_ip=req.olt_ip,
                user=req.user,
                password=req.password,
                pon=req.pon or None,
                onu=req.onu or None,
                serial=req.serial,
                timeout=req.timeout,
            )
            if result.get("ok"):
                _enrich_signal_macs_with_ips(result)
                result["inventory"] = _sync_onu_signal_inventory(req, result)
            return result
        except Exception as e:
            logger.error(f"Erro ao consultar sinal da ONU: {e}")
            raise HTTPException(500, f"Erro ao consultar sinal da ONU: {e}") from e
