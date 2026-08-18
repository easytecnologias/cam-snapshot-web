"""Lista de IPs que o usuario autoriza no inventario de cameras, por site.

Inverte a logica da varredura. Sem allowlist, quem manda e a descoberta: tudo
que responde na faixa entra no inventario e o usuario fica apagando na mao --
e voltava na varredura seguinte. Com allowlist, o site passa a ser
declarativo: a varredura pode ate encontrar 200 equipamentos, mas so vira
camera o que estiver nesta lista.

O modo estrito e por site e so vale quando o site tem lista cadastrada. Site
sem lista continua funcionando como antes, entao ligar isso num cliente nao
quebra os outros.
"""

from __future__ import annotations

import ipaddress
import json
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List

from app.core.tenant_context import tenant_scoped_path


def _path():
    return tenant_scoped_path("camera-allowlist.json")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _site_key(site: Any) -> str:
    return str(site or "").strip().lower()


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


def normalize_entry(value: Any) -> str:
    """Aceita IP solto, CIDR e faixa (10.0.0.10-10.0.0.20 ou 10.0.0.10-20)."""
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        if "/" in raw:
            return str(ipaddress.ip_network(raw, strict=False))
        if "-" in raw:
            left, right = [p.strip() for p in raw.split("-", 1)]
            start = ipaddress.ip_address(left)
            if "." not in right:
                right = f"{left.rsplit('.', 1)[0]}.{right}"
            end = ipaddress.ip_address(right)
            if int(end) < int(start):
                start, end = end, start
            return f"{start}-{end}"
        return str(ipaddress.ip_address(raw))
    except Exception:
        return ""


def _entry_matches(entry: str, ip: str) -> bool:
    try:
        addr = ipaddress.ip_address(ip)
    except Exception:
        return False
    try:
        if "/" in entry:
            return addr in ipaddress.ip_network(entry, strict=False)
        if "-" in entry:
            left, right = entry.split("-", 1)
            return int(ipaddress.ip_address(left)) <= int(addr) <= int(ipaddress.ip_address(right))
        return addr == ipaddress.ip_address(entry)
    except Exception:
        return False


def get_site(site: Any) -> Dict[str, Any]:
    data = _load_raw()
    entry = data.get(_site_key(site))
    if not isinstance(entry, dict):
        return {"site": str(site or "").strip(), "enforced": False, "entries": []}
    return {
        "site": entry.get("site") or str(site or "").strip(),
        "enforced": bool(entry.get("enforced", True)),
        "entries": [e for e in (entry.get("entries") or []) if isinstance(e, dict)],
    }


def list_all() -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for key, entry in sorted(_load_raw().items()):
        if not isinstance(entry, dict):
            continue
        out.append({
            "site": entry.get("site") or key,
            "enforced": bool(entry.get("enforced", True)),
            "entries": [e for e in (entry.get("entries") or []) if isinstance(e, dict)],
        })
    return out


def set_site(site: Any, values: Iterable[Any], enforced: bool = True, note: str = "") -> Dict[str, Any]:
    """Substitui a lista do site inteiro."""
    key = _site_key(site)
    if not key:
        return {"ok": False, "error": "Informe o site."}
    data = _load_raw()
    entries: List[Dict[str, Any]] = []
    seen: set[str] = set()
    invalid: List[str] = []
    for value in values or []:
        normalized = normalize_entry(value)
        if not normalized:
            raw = str(value or "").strip()
            if raw:
                invalid.append(raw)
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        entries.append({"value": normalized, "added_at": _now(), "note": str(note or "").strip()})
    data[key] = {"site": str(site or "").strip(), "enforced": bool(enforced), "entries": entries}
    _save_raw(data)
    return {"ok": True, "site": str(site or "").strip(), "enforced": bool(enforced),
            "entries": entries, "invalid": invalid}


def add_entries(site: Any, values: Iterable[Any], note: str = "") -> Dict[str, Any]:
    current = get_site(site)
    existing = [e.get("value") for e in current["entries"]]
    merged = list(existing) + list(values or [])
    result = set_site(site, merged, enforced=current["enforced"] if current["entries"] else True, note=note)
    if result.get("ok"):
        result["added"] = max(0, len(result.get("entries") or []) - len(existing))
    return result


def remove_entries(site: Any, values: Iterable[Any]) -> Dict[str, Any]:
    current = get_site(site)
    drop = {normalize_entry(v) for v in (values or [])}
    drop.discard("")
    kept = [e for e in current["entries"] if e.get("value") not in drop]
    removed = len(current["entries"]) - len(kept)
    result = set_site(site, [e.get("value") for e in kept], enforced=current["enforced"])
    result["removed"] = removed
    return result


def set_enforced(site: Any, enforced: bool) -> Dict[str, Any]:
    current = get_site(site)
    return set_site(site, [e.get("value") for e in current["entries"]], enforced=bool(enforced))


def site_is_enforced(site: Any) -> bool:
    """Estrito so vale se o site tem lista cadastrada e nao foi desligado."""
    current = get_site(site)
    return bool(current["enforced"] and current["entries"])


def is_allowed(site: Any, ip: Any) -> bool:
    current = get_site(site)
    if not (current["enforced"] and current["entries"]):
        return True   # site sem lista: comportamento antigo
    target = str(ip or "").strip()
    if not target:
        return False
    return any(_entry_matches(str(e.get("value") or ""), target) for e in current["entries"])


def _row_ip(row: Dict[str, Any]) -> str:
    return str(row.get("ip") or row.get("IP") or row.get("camera_ip") or "").strip()


def _row_site(row: Dict[str, Any], default_site: str = "") -> str:
    for key in ("site", "site_name", "local", "LOCAL"):
        value = str(row.get(key) or "").strip()
        if value:
            return value
    return str(default_site or "").strip()


def filter_rows(rows: Iterable[Dict[str, Any]], default_site: str = "") -> tuple[List[Dict[str, Any]], int]:
    """Deixa passar so o que o usuario autorizou para aquele site."""
    kept: List[Dict[str, Any]] = []
    blocked = 0
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        site = _row_site(row, default_site)
        if site and not is_allowed(site, _row_ip(row)):
            blocked += 1
            continue
        kept.append(row)
    return kept, blocked


def forget_rows(rows: Iterable[Dict[str, Any]], default_site: str = "") -> Dict[str, Any]:
    """Apagar camera em site declarativo = tirar o IP da lista de permitidos.

    Nesses sites nao existe motivo pra gravar o IP tambem numa lista de
    bloqueados: se so entra o que esta na allowlist, sair da allowlist ja
    basta pra nao voltar. Duas listas dizendo a mesma coisa so criavam duas
    fontes de verdade que podiam se contradizer.

    Devolve tambem `rows_legado`: as linhas de sites que ainda NAO usam
    allowlist, que continuam dependendo da lista de bloqueados pra nao serem
    recriadas pela varredura.
    """
    por_site: Dict[str, List[str]] = {}
    rows_legado: List[Dict[str, Any]] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        site = _row_site(row, default_site)
        ip = _row_ip(row)
        if site and ip and site_is_enforced(site):
            por_site.setdefault(site, []).append(ip)
        else:
            rows_legado.append(row)

    removed = 0
    for site, ips in por_site.items():
        result = remove_entries(site, ips)
        removed += int(result.get("removed") or 0)

    return {
        "removed": removed,
        "sites": sorted(por_site.keys()),
        "rows_legado": rows_legado,
    }
