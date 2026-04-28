from __future__ import annotations

from typing import Any, Dict, List

from app.core.paths import ensure_dirs
from app.models.requests import InventoryDeleteRequest
from app.services.inventory_json import load_inventory_json, save_inventory_json


def inventory_delete(req: InventoryDeleteRequest) -> Dict[str, Any]:
    ensure_dirs()
    ips_set = {ip.strip() for ip in (req.ips or []) if ip and ip.strip()}
    if not ips_set:
        return {"ok": False, "error": "Nenhum IP recebido para apagar."}

    mode = str(getattr(req, "mode", "olt") or "olt").strip().lower()
    rows = load_inventory_json(mode=mode) or []
    if not rows:
        return {"ok": True, "removed": 0, "ips_removed": [], "inventory": []}

    def get_row_ip(row: Dict[str, Any]) -> str:
        if "ip" in row:
            return str(row["ip"]).strip()
        if "IP" in row:
            return str(row["IP"]).strip()
        return ""

    rows_kept: List[Dict[str, Any]] = []
    removed_ips: set[str] = set()

    for row in rows:
        rip = get_row_ip(row)
        if rip and rip in ips_set:
            removed_ips.add(rip)
        else:
            rows_kept.append(row)

    save_inventory_json(rows_kept, mode=mode)
    return {"ok": True, "removed": len(removed_ips), "ips_removed": sorted(list(removed_ips)), "inventory": rows_kept}
