from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from app.services.windows_inventory_service import (
    clear_windows_inventory,
    load_windows_inventory,
    scan_windows_inventory,
)

router = APIRouter(prefix="/api/windows", tags=["windows"])


@router.get("/inventory")
def api_windows_inventory() -> Dict[str, Any]:
    rows = load_windows_inventory()
    return {"ok": True, "count": len(rows), "inventory": rows}


@router.post("/scan")
def api_windows_scan(payload: Dict[str, Any]) -> Dict[str, Any]:
    try:
        return scan_windows_inventory(payload if isinstance(payload, dict) else {})
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@router.post("/clear")
def api_windows_clear() -> Dict[str, Any]:
    return clear_windows_inventory()
