from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

from app.services.windows_inventory_service import (
    clear_windows_inventory,
    build_windows_prepare_script,
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


@router.get("/prepare-script")
def api_windows_prepare_script(username: str = Query("sightops_inv")) -> Response:
    script = build_windows_prepare_script(username=username)
    return Response(
        content=script,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="sightops-preparar-windows.ps1"'},
    )
