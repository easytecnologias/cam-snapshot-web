from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app.models.requests import (
    OltAddOnuRequest,
    OltCollectMacsRequest,
    OltDeleteOnuRequest,
    OltDiscoverOnusRequest,
    OltFindOnuRequest,
    OltOnuSignalRequest,
)
from app.services.olt_service import (
    add_onu,
    collect_macs,
    clear_macs,
    delete_onu,
    discover_onus,
    find_onu,
    list_macs,
    onu_signal,
)

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


@router.post("/olt/discover-onus")
def api_olt_discover_onus(req: OltDiscoverOnusRequest) -> Dict[str, Any]:
    return discover_onus(req)


@router.post("/olt/add-onu")
def api_olt_add_onu(req: OltAddOnuRequest) -> Dict[str, Any]:
    return add_onu(req)


@router.post("/olt/find-onu")
def api_olt_find_onu(req: OltFindOnuRequest) -> Dict[str, Any]:
    return find_onu(req)


@router.post("/olt/delete-onu")
def api_olt_delete_onu(req: OltDeleteOnuRequest) -> Dict[str, Any]:
    return delete_onu(req)


@router.post("/olt/onu-signal")
def api_olt_onu_signal(req: OltOnuSignalRequest) -> Dict[str, Any]:
    return onu_signal(req)
