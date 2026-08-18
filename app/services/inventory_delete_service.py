from __future__ import annotations

from typing import Any, Dict, List

from app.core.paths import ensure_dirs
from app.models.requests import InventoryDeleteRequest
from app.services.inventory_json import inventory_row_key, load_inventory_json, save_inventory_json
from app.services.camera_allowlist import forget_rows as allowlist_forget_rows
from app.services.olt_ignore_list import add_ignored_rows


def inventory_delete(req: InventoryDeleteRequest) -> Dict[str, Any]:
    ensure_dirs()
    ips_set = {ip.strip() for ip in (req.ips or []) if ip and ip.strip()}
    keys_set = {str(key or "").strip() for key in (getattr(req, "keys", []) or []) if str(key or "").strip()}
    connector_id = str(getattr(req, "connector_id", "") or "").strip()
    site = str(getattr(req, "site", "") or "").strip()
    if not ips_set and not keys_set:
        return {"ok": False, "error": "Nenhum IP ou chave recebido para apagar."}

    def get_row_ip(row: Dict[str, Any]) -> str:
        if "ip" in row:
            return str(row["ip"]).strip()
        if "IP" in row:
            return str(row["IP"]).strip()
        return ""

    removed_ips: set[str] = set()
    removed_keys: set[str] = set()
    removed_rows: List[Dict[str, Any]] = []
    inventories: Dict[str, List[Dict[str, Any]]] = {}
    raw_mode = str(getattr(req, "mode", "olt") or "olt").strip().lower()
    if raw_mode in {"all", "todos", "camera", "cameras"}:
        modes = ["basic", "olt", "switch"]
    elif raw_mode in {"basic", "basico", "básico", "base"}:
        modes = ["basic"]
    elif raw_mode in {"switch", "sw", "via_switch", "via-switch"}:
        modes = ["switch"]
    else:
        modes = ["olt"]

    for current_mode in modes:
        rows = load_inventory_json(mode=current_mode) or []
        rows_kept: List[Dict[str, Any]] = []
        for row in rows:
            rip = get_row_ip(row)
            row_key = inventory_row_key(row)
            row_connector = str(row.get("remote_connector_id") or row.get("connector_id") or "").strip()
            row_site = str(row.get("site") or row.get("site_name") or row.get("local") or "").strip()
            scoped_match = True
            if connector_id:
                scoped_match = row_connector == connector_id
            elif site:
                scoped_match = row_site.lower() == site.lower()
            key_match = row_key in keys_set and scoped_match
            ip_match = bool(rip and rip in ips_set and scoped_match)
            should_remove = bool(key_match or ip_match)
            if should_remove:
                removed_ips.add(rip)
                removed_keys.add(row_key)
                removed_rows.append(row)
            else:
                rows_kept.append(row)
        save_inventory_json(rows_kept, mode=current_mode)
        inventories[current_mode] = rows_kept

    # Em site declarativo, apagar e apagar: o IP sai da lista de permitidos e
    # pronto -- nao precisa entrar tambem numa lista de bloqueados. Para voltar,
    # basta o usuario recolocar o IP na lista.
    allowlist_forget = allowlist_forget_rows(removed_rows, default_site=site)
    allowlist_removed = int(allowlist_forget.get("removed") or 0)

    ignored_added = 0
    rows_legado = allowlist_forget.get("rows_legado") or []
    if getattr(req, "permanent", False) and rows_legado:
        # Só os sites que ainda nao usam allowlist dependem da lista de
        # bloqueados pra varredura/sync nao recriarem a linha.
        ignored_added = add_ignored_rows(rows_legado, reason="apagado manualmente no inventario")

    inventory = inventories.get("olt") or inventories.get(modes[0], [])
    return {
        "ok": True,
        "removed": len(removed_ips),
        "ips_removed": sorted(list(removed_ips)),
        "keys_removed": sorted(list(removed_keys)),
        "ignored_added": ignored_added,
        "allowlist_removed": allowlist_removed,
        "allowlist_sites": allowlist_forget.get("sites") or [],
        "inventory": inventory,
        "inventories": inventories,
    }
