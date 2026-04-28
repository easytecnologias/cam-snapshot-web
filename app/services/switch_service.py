from __future__ import annotations

from typing import Any, Dict, List, Tuple

from fastapi import HTTPException

from app.core.paths import DATA_DIR
from app.services.intelbras_switch_service import collect_switch_snapshot
from app.services.db_store import load_switch_mac_state, save_switch_mac_state
from app.models.requests import SwitchCollectMacsRequest


def _safe(v: Any) -> str:
    return str(v or "").strip()


def _norm_mac(v: Any) -> str:
    raw = _safe(v).lower()
    hex_only = "".join(ch for ch in raw if ch in "0123456789abcdef")
    if len(hex_only) < 12:
        return ""
    hex_only = hex_only[-12:]
    return ":".join(hex_only[i:i + 2] for i in range(0, 12, 2))


def _dedup_switch_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[Tuple[str, str, str, str, str]] = set()
    for r in rows or []:
        mac = _norm_mac(r.get("mac"))
        vlan = _safe(r.get("vlan"))
        port = _safe(r.get("port"))
        site = _safe(r.get("site")).lower()
        switch_ip = _safe(r.get("switch_ip")).lower()
        key = (site, switch_ip, port, vlan, mac)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _port_sort_key(value: Any) -> tuple[int, str, int, str]:
    port = _safe(value).lower()
    import re
    m = re.match(r"^([a-z]+)(\d+)$", port)
    if m:
        prefix = m.group(1)
        num = int(m.group(2))
        prio = 0 if prefix == "ge" else 1
        return (prio, prefix, num, port)
    return (9, port, 0, port)


def _sort_switch_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        rows or [],
        key=lambda r: (
            _safe(r.get("site")).lower(),
            _safe(r.get("switch_ip")).lower(),
            _port_sort_key(r.get("port")),
            int(_safe(r.get("vlan")) or "0") if _safe(r.get("vlan")).isdigit() else 0,
            _norm_mac(r.get("mac")),
        ),
    )


def _build_port_stats(rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    stats: dict[tuple[str, str], dict[str, Any]] = {}
    for r in rows or []:
        switch_ip = _safe(r.get("switch_ip")).lower()
        port = _safe(r.get("port") or r.get("switch_port")).lower()
        if not switch_ip or not port:
            continue
        key = (switch_ip, port)
        item = stats.setdefault(key, {"macs": set(), "vlans": set()})
        mac = _norm_mac(r.get("mac"))
        vlan = _safe(r.get("vlan") or r.get("switch_vlan"))
        if mac:
            item["macs"].add(mac)
        if vlan:
            item["vlans"].add(vlan)

    out: dict[tuple[str, str], dict[str, Any]] = {}
    for key, item in stats.items():
        mac_count = len(item["macs"])
        vlan_count = len(item["vlans"])
        is_uplink_candidate = vlan_count > 1 or mac_count >= 32
        out[key] = {
            "port_mac_count": mac_count,
            "port_vlan_count": vlan_count,
            "is_uplink_candidate": is_uplink_candidate,
            "port_role_guess": "uplink" if is_uplink_candidate else "edge",
        }
    return out


def _attach_port_stats(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    stats = _build_port_stats(rows)
    out: list[dict[str, Any]] = []
    for r in rows or []:
        rr = dict(r)
        key = (_safe(rr.get("switch_ip")).lower(), _safe(rr.get("port") or rr.get("switch_port")).lower())
        meta = stats.get(key) or {}
        rr.update(meta)
        out.append(rr)
    return out


def collect_macs(req: SwitchCollectMacsRequest) -> Dict[str, Any]:
    try:
        snapshot = collect_switch_snapshot(
            host=req.switch_ip,
            username=req.user,
            password=req.password,
            include_config=False,
            port=req.port,
            timeout=req.timeout,
        )
    except Exception as e:
        raise HTTPException(500, f"Erro ao consultar switch: {e}") from e

    switch_name = _safe(req.switch_name) or _safe(snapshot.get("system", {}).get("product_name")) or req.switch_ip
    new_rows: list[dict[str, Any]] = []
    for item in snapshot.get("mac_table") or []:
        if not isinstance(item, dict):
            continue
        entry_type = _safe(item.get("entry_type")).lower()
        if entry_type == "local":
            continue
        mac = _norm_mac(item.get("mac"))
        if not mac:
            continue
        new_rows.append(
            {
                "site": _safe(req.site),
                "switch_ip": _safe(req.switch_ip),
                "switch_name": switch_name,
                "switch_model": _safe(snapshot.get("system", {}).get("product_name")),
                "switch_firmware": _safe(snapshot.get("system", {}).get("software_version")),
                "port": _safe(item.get("port")),
                "vlan": _safe(item.get("vlan_id")),
                "mac": mac,
                "entry_type": entry_type or "dynamic",
            }
        )

    try:
        existing_obj = load_switch_mac_state() or {}
        existing_rows = [x for x in (existing_obj.get("rows") or existing_obj.get("items") or []) if isinstance(x, dict)]
    except Exception:
        existing_obj = {}
        existing_rows = []

    site = _safe(req.site).lower()
    switch_ip = _safe(req.switch_ip)
    if req.reuse_json:
        all_rows = existing_rows + new_rows
    else:
        def _same_scope(x: dict[str, Any]) -> bool:
            return _safe(x.get("switch_ip")) == switch_ip and _safe(x.get("site")).lower() == site
        kept = [x for x in existing_rows if not _same_scope(x)]
        all_rows = kept + new_rows

    all_rows = _attach_port_stats(_sort_switch_rows(_dedup_switch_rows(all_rows)))
    payload = {
        **{k: v for k, v in existing_obj.items() if k not in ("rows", "items", "switch")},
        "switch": {
            "ip": switch_ip,
            "name": switch_name,
            "site": _safe(req.site),
            "model": _safe(snapshot.get("system", {}).get("product_name")),
            "firmware": _safe(snapshot.get("system", {}).get("software_version")),
        },
        "rows": all_rows,
    }
    save_switch_mac_state(payload)
    return {
        "ok": True,
        "rows": _attach_port_stats(_sort_switch_rows(_dedup_switch_rows(new_rows))),
        "rows_all": all_rows,
        "count": len(new_rows),
        "count_all": len(all_rows),
        "summary": snapshot.get("summary") or {},
        "system": snapshot.get("system") or {},
    }


def clear_macs(site: str = "") -> Dict[str, Any]:
    site_norm = _safe(site).lower()
    existing_obj = load_switch_mac_state() or {}
    rows = [x for x in (existing_obj.get("rows") or existing_obj.get("items") or []) if isinstance(x, dict)]
    before = len(rows)

    if site_norm:
        kept = [r for r in rows if _safe(r.get("site")).lower() != site_norm]
        save_switch_mac_state(
            {
                **{k: v for k, v in existing_obj.items() if k not in ("rows", "items")},
                "rows": kept,
            }
        )
        return {"ok": True, "scope": "site", "site": site.strip(), "removed_rows": before - len(kept), "remaining": len(kept)}

    save_switch_mac_state({"switch": {}, "rows": []})
    return {"ok": True, "scope": "all", "removed_rows": before, "remaining": 0}


def list_macs(site: str = "") -> Dict[str, Any]:
    obj = load_switch_mac_state() or {}
    rows = [x for x in (obj.get("rows") or obj.get("items") or []) if isinstance(x, dict)]
    site_norm = _safe(site).lower()
    if site_norm:
        rows = [r for r in rows if _safe(r.get("site")).lower() == site_norm]
    rows = _attach_port_stats(_sort_switch_rows(_dedup_switch_rows(rows)))
    return {"ok": True, "rows": rows, "count": len(rows), "site": site.strip()}
