from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List

from app.core.tenant_context import tenant_scoped_path


def _path():
    return tenant_scoped_path("olt-ignored-ips.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_raw() -> Dict[str, Dict[str, Any]]:
    path = _path()
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _save_raw(data: Dict[str, Dict[str, Any]]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def load_ignored_ips() -> set[str]:
    return set(_load_raw().keys())


def list_ignored() -> List[Dict[str, Any]]:
    data = _load_raw()
    return [{"ip": ip, **meta} for ip, meta in sorted(data.items())]


def add_ignored_ips(ips: Iterable[str], reason: str = "") -> int:
    data = _load_raw()
    added = 0
    changed = False
    for raw_ip in ips:
        ip = str(raw_ip or "").strip()
        if not ip:
            continue
        if ip not in data:
            added += 1
        entry = {"added_at": _now(), "reason": str(reason or "").strip()}
        if data.get(ip) != entry:
            changed = True
        data[ip] = entry
    if changed:
        _save_raw(data)
    return added


def _row_ip(row: Dict[str, Any]) -> str:
    return str(row.get("ip") or row.get("IP") or row.get("camera_ip") or "").strip()


def _row_text(row: Dict[str, Any], *keys: str) -> str:
    for key in keys:
        value = str(row.get(key) or "").strip()
        if value:
            return value
    return ""


def _row_scope(row: Dict[str, Any]) -> Dict[str, str]:
    return {
        "site": _row_text(row, "site", "site_name", "local", "LOCAL"),
        "connector_id": _row_text(row, "remote_connector_id", "connector_id"),
        "olt_ip": _row_text(row, "olt_ip", "OLT_IP"),
        "pon": _row_text(row, "pon", "PON"),
        "onu_id": _row_text(row, "onu_id", "onu", "ONU", "ONU_ID"),
        "onu_serial": _row_text(row, "onu_serial", "serial", "SERIAL", "ONU_SERIAL"),
    }


def add_ignored_rows(rows: Iterable[Dict[str, Any]], reason: str = "") -> int:
    data = _load_raw()
    added = 0
    changed = False
    for row in rows:
        if not isinstance(row, dict):
            continue
        ip = _row_ip(row)
        if not ip:
            continue
        if ip not in data:
            added += 1
        scope = {key: value for key, value in _row_scope(row).items() if value}
        entry = {
            "added_at": _now(),
            "reason": str(reason or "").strip(),
            **scope,
        }
        if data.get(ip) != entry:
            changed = True
        data[ip] = entry
    if changed:
        _save_raw(data)
    return added


# site/conector dizem DE QUEM e o IP -- sao os campos que impedem bloquear
# 100.65.10.57 de um cliente por causa do mesmo IP privado em outro.
_SCOPE_IDENTIDADE = {"site", "connector_id"}
# olt_ip/pon/onu descrevem por onde a camera estava pendurada. A mesma camera
# aparece com esses campos vazios quando vem de varredura basica ou switch, e
# exigir que batessem fazia o bloqueio nao valer -- a camera apagada voltava.
_SCOPE_TOPOLOGIA = {"olt_ip", "pon", "onu_id", "onu_serial"}


def _matches_scope(meta: Dict[str, Any], row: Dict[str, Any]) -> bool:
    scope = _row_scope(row)
    has_scope = False
    for key, expected in (meta or {}).items():
        if key not in scope:
            continue
        expected_text = str(expected or "").strip()
        if not expected_text:
            continue
        actual = str(scope.get(key) or "").strip()
        if key in _SCOPE_TOPOLOGIA:
            if not actual:
                continue
            has_scope = True
            if actual != expected_text:
                return False
            continue
        has_scope = True
        if key == "site":
            if actual.lower() != expected_text.lower():
                return False
        elif actual != expected_text:
            return False
    return has_scope


def is_ignored_olt_row(row: Dict[str, Any]) -> bool:
    ip = _row_ip(row)
    if not ip:
        return False
    data = _load_raw()
    meta = data.get(ip)
    if not isinstance(meta, dict):
        return False
    if _matches_scope(meta, row):
        return True
    # Compatibilidade com entradas antigas, criadas quando a lista guardava
    # apenas IP. Essas continuam valendo para nao fazer sujeira antiga voltar.
    scoped_keys = {"site", "connector_id", "olt_ip", "pon", "onu_id", "onu_serial"}
    return not any(str(meta.get(key) or "").strip() for key in scoped_keys)


def remove_ignored_ips(ips: Iterable[str]) -> int:
    data = _load_raw()
    removed = 0
    for raw_ip in ips:
        ip = str(raw_ip or "").strip()
        if ip in data:
            del data[ip]
            removed += 1
    if removed:
        _save_raw(data)
    return removed


def remove_ignored_rows(rows: Iterable[Dict[str, Any]]) -> int:
    ips: list[str] = []
    for row in rows:
        if isinstance(row, dict):
            ip = _row_ip(row)
            if ip:
                ips.append(ip)
    return remove_ignored_ips(ips)


# Nome generico: a lista vale para inventario basico, OLT e switch.
is_ignored_row = is_ignored_olt_row


def filter_ignored_rows(rows: Iterable[Dict[str, Any]]) -> tuple[List[Dict[str, Any]], int]:
    """Tira das linhas de uma varredura tudo que o usuario mandou ignorar.

    Antes a varredura fazia o contrario: chamava remove_ignored_rows() e
    apagava o bloqueio de qualquer IP que reencontrasse, entao camera excluida
    voltava sozinha na varredura seguinte.
    """
    kept: List[Dict[str, Any]] = []
    blocked = 0
    for row in rows or []:
        if isinstance(row, dict) and is_ignored_row(row):
            blocked += 1
            continue
        kept.append(row)
    return kept, blocked
