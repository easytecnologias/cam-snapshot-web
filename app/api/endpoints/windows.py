from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response

from app.services.windows_inventory_service import (
    clear_windows_inventory,
    accept_windows_agent_report,
    build_windows_agent_script,
    build_windows_prepare_script,
    load_windows_inventory,
    scan_windows_inventory,
    validate_windows_agent_token,
)
from app.services.windows_pdf_report import build_windows_inventory_pdf

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


@router.get("/report.pdf")
def api_windows_report_pdf(company_name: str = "") -> FileResponse:
    rows = load_windows_inventory()
    pdf_path = build_windows_inventory_pdf(rows, company_name=company_name)
    return FileResponse(path=pdf_path, media_type="application/pdf", filename=pdf_path.name)


@router.get("/prepare-script")
def api_windows_prepare_script(username: str = Query("sightops_inv")) -> Response:
    script = build_windows_prepare_script(username=username)
    return Response(
        content=script,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="sightops-preparar-windows.ps1"'},
    )


@router.get("/agent-script")
def api_windows_agent_script(request: Request) -> Response:
    base_url = str(request.base_url).rstrip("/")
    script = build_windows_agent_script(base_url=base_url)
    return Response(
        content=script,
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="sightops-agente-windows.ps1"'},
    )


@router.post("/agent/report")
async def api_windows_agent_report(request: Request) -> Dict[str, Any]:
    token = str(request.headers.get("x-sightops-agent-token") or "").strip()
    if not validate_windows_agent_token(token):
        raise HTTPException(status_code=401, detail="token do agente invalido")
    try:
        payload = await request.json()
        remote_ip = request.client.host if request.client else ""
        return accept_windows_agent_report(payload if isinstance(payload, dict) else {}, remote_ip=remote_ip)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))
