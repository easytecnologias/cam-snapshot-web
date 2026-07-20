from __future__ import annotations

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from app.models.requests import (
    OltAddOnuRequest,
    OltCollectMacsRequest,
    OltDeleteOnuRequest,
    OltDiscoverOnusRequest,
    OltFindOnuRequest,
    OltOnuSignalRequest,
    OltRegistryRequest,
)
from app.services import olt_registry
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


# --- Cadastro de OLT ---------------------------------------------------------
#
# Nenhuma destas rotas devolve a senha da OLT: o servico entrega `has_password`
# e nada mais. A senha so e aberta em olt_registry.resolve_credentials, chamada
# na hora de falar com o equipamento.


@router.get("/olt/registry")
def api_olt_registry_list() -> Dict[str, Any]:
    itens: List[Dict[str, Any]] = olt_registry.list_olts()
    return {"ok": True, "items": itens, "total": len(itens)}


@router.get("/olt/registry/{olt_id}")
def api_olt_registry_get(olt_id: int) -> Dict[str, Any]:
    item = olt_registry.get_olt(olt_id)
    if not item:
        raise HTTPException(status_code=404, detail="OLT nao encontrada")
    return {"ok": True, "item": item}


@router.post("/olt/registry")
def api_olt_registry_save(req: OltRegistryRequest) -> Dict[str, Any]:
    try:
        item = olt_registry.save_olt(req.model_dump())
    except olt_registry.OltNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "item": item}


@router.delete("/olt/registry/{olt_id}")
def api_olt_registry_delete(olt_id: int) -> Dict[str, Any]:
    if not olt_registry.delete_olt(olt_id):
        raise HTTPException(status_code=404, detail="OLT nao encontrada")
    return {"ok": True}


# --- Operacoes ---------------------------------------------------------------


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
