from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app.models.requests import OltCollectMacsRequest
from app.services.olt_service import collect_macs, clear_macs, list_macs

router = APIRouter(prefix="/api", tags=["olt"])

@router.post("/olt/collect-macs")
def api_olt_collect_macs(req: OltCollectMacsRequest) -> Dict[str, Any]:
    return collect_macs(req)


@router.post("/olt/clear")
def api_olt_clear(site: str = "") -> Dict[str, Any]:
    return clear_macs(site=site)


@router.get("/olt/rows")
def api_olt_rows(site: str = "") -> Dict[str, Any]:
    return list_macs(site=site)
