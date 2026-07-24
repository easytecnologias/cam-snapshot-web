from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException

from app.core.tenant_context import get_current_tenant_slug
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
from app.services.connector_service import get_connector
from app.services.olt_service import (
    add_onu,
    collect_macs,
    collect_onu_telemetry,
    clear_macs,
    delete_onu,
    discover_onus,
    find_onu,
    list_macs,
    onu_signal,
)
from app.cli.tools.olt_fiberhome import audit_offline_fiberhome

router = APIRouter(prefix="/api", tags=["olt"])
_olt_sync_jobs: dict[str, dict[str, Any]] = {}
_olt_sync_tasks: set[asyncio.Task[Any]] = set()
_olt_offline_audit_jobs: dict[str, dict[str, Any]] = {}
_olt_offline_audit_tasks: set[asyncio.Task[Any]] = set()


def _olt_sync_key(olt_id: int) -> str:
    return f"{get_current_tenant_slug() or 'default'}:{int(olt_id)}"


def _olt_offline_audit_key(olt_id: int) -> str:
    return f"{get_current_tenant_slug() or 'default'}:{int(olt_id)}"


async def _run_olt_registry_sync(job_key: str, job_id: str, olt_id: int, req: OltCollectMacsRequest) -> None:
    try:
        result = await asyncio.to_thread(collect_macs, req)
        _olt_sync_jobs[job_key] = {
            "ok": True,
            "job_id": job_id,
            "olt_id": olt_id,
            "status": "done",
            "count": int(result.get("count") or 0),
            "count_all": int(result.get("count_all") or 0),
            "finished_at": time.time(),
        }
    except Exception as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        _olt_sync_jobs[job_key] = {
            "ok": False,
            "job_id": job_id,
            "olt_id": olt_id,
            "status": "error",
            "error": str(detail),
            "finished_at": time.time(),
        }


async def _run_olt_offline_audit(
    job_key: str,
    job_id: str,
    olt_id: int,
    olt: Dict[str, Any],
    minimum_days: int,
    inventory_rows: List[Dict[str, Any]],
) -> None:
    try:
        result = await asyncio.to_thread(
            audit_offline_fiberhome,
            olt_ip=str(olt.get("host") or ""),
            user=str(olt.get("username") or ""),
            password=str(olt.get("password") or ""),
            olt_name=str(olt.get("name") or "OLT-FiberHome"),
            site=str(olt.get("site") or ""),
            minimum_days=minimum_days,
        )
        olt_ip = str(olt.get("host") or "").strip()
        by_serial: dict[str, list[Dict[str, Any]]] = {}
        for item in inventory_rows:
            if str(item.get("olt_ip") or "").strip() != olt_ip:
                continue
            serial = str(item.get("onu_serial") or item.get("serial") or "").strip().upper()
            if serial:
                by_serial.setdefault(serial, []).append(item)
        for row in result.get("rows", []):
            matches = by_serial.get(str(row.get("onu_serial") or "").strip().upper(), [])
            vlans = sorted({
                str(item.get("vlan") or "").strip()
                for item in matches
                if str(item.get("vlan") or "").strip() not in {"", "65535"}
            }, key=lambda value: (not value.isdigit(), int(value) if value.isdigit() else value))
            macs = sorted({
                str(item.get("cpe_mac") or item.get("mac") or "").strip().lower()
                for item in matches
                if str(item.get("cpe_mac") or item.get("mac") or "").strip()
            })
            row["vlans"] = vlans
            row["vlan_label"] = ", ".join(vlans)
            row["known_macs"] = macs
            row["known_devices"] = len(macs)
            row["vlan_source"] = "inventory_history" if vlans else ""
        result["with_vlan_total"] = sum(1 for row in result.get("rows", []) if row.get("vlans"))
        _olt_offline_audit_jobs[job_key] = {
            "ok": True,
            "job_id": job_id,
            "olt_id": olt_id,
            "status": "done",
            "result": result,
            "finished_at": time.time(),
        }
    except Exception as exc:
        detail = getattr(exc, "detail", None) or str(exc)
        _olt_offline_audit_jobs[job_key] = {
            "ok": False,
            "job_id": job_id,
            "olt_id": olt_id,
            "status": "error",
            "error": str(detail),
            "finished_at": time.time(),
        }
def _ensure_supported_registry_driver(olt_id: int) -> None:
    olt = olt_registry.get_olt(olt_id) or {}
    vendor = str(olt.get("vendor") or "").strip()
    model = str(olt.get("model") or "").strip()
    model_key = model.lower()
    supported = (
        (vendor.lower() == "intelbras" and model_key in {"8820i", "4840e"})
        or (vendor.lower() == "fiberhome" and model_key in {"an5516-04", "an5516-06", "an6000-15", "an6000-17"})
    )
    if not supported:
        label = " / ".join(value for value in (vendor, model) if value) or "nao informado"
        raise HTTPException(
            status_code=422,
            detail=(
                f"A OLT {label} pode ser cadastrada, mas a sincronizacao ainda nao possui driver. "
                "Modelos suportados: Intelbras 8820i/4840E e FiberHome AN5516/AN6000."
            ),
        )


def _registered_request(req: Any) -> Any:
    """Preenche credenciais e escopo no servidor quando a operacao usa olt_id."""
    olt_id = getattr(req, "olt_id", None)
    if not olt_id:
        return req
    try:
        olt = olt_registry.resolve_credentials(int(olt_id))
    except olt_registry.OltNotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if not olt.get("active"):
        raise HTTPException(status_code=409, detail="OLT cadastrada esta inativa")
    if not olt.get("password"):
        raise HTTPException(status_code=409, detail="OLT cadastrada nao possui senha")
    connector_id = str(olt.get("connector_id") or "").strip()
    connector = get_connector(connector_id, include_token=False, enforce_tenant=True) if connector_id else None
    updates = {
        "olt_ip": olt.get("host") or "",
        "user": olt.get("username") or "",
        "password": olt.get("password") or "",
        "site": olt.get("site") or "",
        "olt_name": olt.get("name") or "",
        "olt_model": olt.get("model") or "",
        "olt_vendor": olt.get("vendor") or "",
        "connector_id": connector_id,
        "remote_connector_id": connector_id,
        "connector_name": (connector or {}).get("name") or (connector or {}).get("client") or "",
    }
    allowed = set(req.model_fields) if hasattr(req, "model_fields") else set(req.__fields__)
    updates = {key: value for key, value in updates.items() if key in allowed}
    return req.model_copy(update=updates) if hasattr(req, "model_copy") else req.copy(update=updates)


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


@router.post("/olt/registry/{olt_id}/test")
def api_olt_registry_test(olt_id: int) -> Dict[str, Any]:
    try:
        _ensure_supported_registry_driver(olt_id)
        req = _registered_request(OltDiscoverOnusRequest(olt_id=olt_id, pon="all"))
        result = discover_onus(req)
        pons = result.get("pons") if isinstance(result, dict) else {}
        discovered = sum(len((item or {}).get("discovered") or []) for item in (pons or {}).values())
        test = olt_registry.mark_test_result(olt_id, True, f"{len(pons or {})} PON(s)")
        return {"ok": True, "connected": True, "pons": len(pons or {}), "discovered": discovered, "test": test}
    except Exception as exc:
        try:
            olt_registry.mark_test_result(olt_id, False, str(exc))
        except Exception:
            pass
        raise


@router.post("/olt/registry/{olt_id}/sync")
async def api_olt_registry_sync(olt_id: int) -> Dict[str, Any]:
    _ensure_supported_registry_driver(olt_id)
    req = _registered_request(OltCollectMacsRequest(olt_id=olt_id, pon="all", reuse_json=False))
    req = req.model_copy(update={"scan_origin": "connector" if req.connector_id else "local"})
    olt = olt_registry.get_olt(olt_id) or {}
    if str(olt.get("vendor") or "").strip().lower() == "fiberhome":
        job_key = _olt_sync_key(olt_id)
        current = _olt_sync_jobs.get(job_key) or {}
        if current.get("status") == "running":
            return {**current, "accepted": True}
        job_id = uuid.uuid4().hex
        _olt_sync_jobs[job_key] = {
            "ok": True,
            "accepted": True,
            "job_id": job_id,
            "olt_id": olt_id,
            "status": "running",
            "started_at": time.time(),
        }
        task = asyncio.create_task(
            _run_olt_registry_sync(job_key, job_id, olt_id, req),
            name=f"olt-sync-{olt_id}-{job_id[:8]}",
        )
        _olt_sync_tasks.add(task)
        task.add_done_callback(_olt_sync_tasks.discard)
        return dict(_olt_sync_jobs[job_key])
    result = await asyncio.to_thread(collect_macs, req)
    return {
        "ok": True,
        "olt_id": olt_id,
        "count": int(result.get("count") or 0),
        "count_all": int(result.get("count_all") or 0),
    }


@router.get("/olt/registry/{olt_id}/sync-status")
def api_olt_registry_sync_status(olt_id: int) -> Dict[str, Any]:
    job = _olt_sync_jobs.get(_olt_sync_key(olt_id))
    if not job:
        return {"ok": True, "olt_id": olt_id, "status": "idle"}
    result = dict(job)
    if result.get("status") == "running":
        result["elapsed_s"] = max(0, int(time.time() - float(result.get("started_at") or time.time())))
    return result


@router.post("/olt/registry/{olt_id}/telemetry")
def api_olt_registry_telemetry(olt_id: int) -> Dict[str, Any]:
    _ensure_supported_registry_driver(olt_id)
    req = _registered_request(OltCollectMacsRequest(olt_id=olt_id, pon="all", reuse_json=False))
    req = req.model_copy(update={"scan_origin": "connector" if req.connector_id else "local"})
    return collect_onu_telemetry(req)


@router.post("/olt/registry/{olt_id}/offline-audit")
async def api_olt_registry_offline_audit(olt_id: int, minimum_days: int = 30) -> Dict[str, Any]:
    """Auditoria somente de leitura; nunca remove uma ONU."""
    olt = olt_registry.resolve_credentials(olt_id)
    if str(olt.get("vendor") or "").strip().lower() != "fiberhome":
        raise HTTPException(
            status_code=422,
            detail="A auditoria de tempo offline esta homologada inicialmente para OLTs FiberHome.",
        )
    if not olt.get("active"):
        raise HTTPException(status_code=409, detail="OLT cadastrada esta inativa")
    if not olt.get("password"):
        raise HTTPException(status_code=409, detail="OLT cadastrada nao possui senha")
    minimum_days = max(0, min(int(minimum_days or 0), 3650))
    job_key = _olt_offline_audit_key(olt_id)
    current = _olt_offline_audit_jobs.get(job_key) or {}
    if current.get("status") == "running":
        return {**current, "accepted": True}
    job_id = uuid.uuid4().hex
    _olt_offline_audit_jobs[job_key] = {
        "ok": True,
        "accepted": True,
        "job_id": job_id,
        "olt_id": olt_id,
        "status": "running",
        "minimum_days": minimum_days,
        "started_at": time.time(),
    }
    task = asyncio.create_task(
        _run_olt_offline_audit(
            job_key,
            job_id,
            olt_id,
            olt,
            minimum_days,
            list_macs(site=str(olt.get("site") or "")).get("rows", []),
        ),
        name=f"olt-offline-audit-{olt_id}-{job_id[:8]}",
    )
    _olt_offline_audit_tasks.add(task)
    task.add_done_callback(_olt_offline_audit_tasks.discard)
    return dict(_olt_offline_audit_jobs[job_key])


@router.get("/olt/registry/{olt_id}/offline-audit-status")
def api_olt_registry_offline_audit_status(olt_id: int) -> Dict[str, Any]:
    job = _olt_offline_audit_jobs.get(_olt_offline_audit_key(olt_id))
    if not job:
        return {"ok": True, "olt_id": olt_id, "status": "idle"}
    result = dict(job)
    if result.get("status") == "running":
        result["elapsed_s"] = max(0, int(time.time() - float(result.get("started_at") or time.time())))
    return result


# --- Operacoes ---------------------------------------------------------------


@router.post("/olt/collect-macs")
def api_olt_collect_macs(req: OltCollectMacsRequest) -> Dict[str, Any]:
    return collect_macs(_registered_request(req))


@router.post("/olt/clear")
def api_olt_clear(site: str = "") -> Dict[str, Any]:
    return clear_macs(site=site)


@router.get("/olt/rows")
def api_olt_rows(site: str = "", compact: bool = False) -> Dict[str, Any]:
    data = list_macs(site=site)
    if not compact:
        return data

    # Tabelas de gravadores precisam somente da identidade da ONU associada ao
    # MAC. Nao envie toda a coleta OLT (que pode ter varios megabytes).
    fields = (
        "cpe_mac", "mac", "MAC", "pon", "PON", "onu_id", "onu", "ONU",
        "onu_name", "onu_serial", "serial", "SERIAL", "site", "local",
        "olt_ip", "olt_name", "remote_connector_id", "connector_id",
        "oper_status", "omci_status", "onu_rx", "olt_rx",
        "telemetry_updated_at",
    )
    rows = [
        {key: row.get(key) for key in fields if row.get(key) not in (None, "")}
        for row in data.get("rows", [])
        if isinstance(row, dict)
    ]
    return {**data, "rows": rows, "count": len(rows), "compact": True}


@router.post("/olt/discover-onus")
def api_olt_discover_onus(req: OltDiscoverOnusRequest) -> Dict[str, Any]:
    return discover_onus(_registered_request(req))


@router.post("/olt/add-onu")
def api_olt_add_onu(req: OltAddOnuRequest) -> Dict[str, Any]:
    return add_onu(_registered_request(req))


@router.post("/olt/find-onu")
def api_olt_find_onu(req: OltFindOnuRequest) -> Dict[str, Any]:
    return find_onu(_registered_request(req))


@router.post("/olt/delete-onu")
def api_olt_delete_onu(req: OltDeleteOnuRequest) -> Dict[str, Any]:
    return delete_onu(_registered_request(req))


@router.post("/olt/onu-signal")
def api_olt_onu_signal(req: OltOnuSignalRequest) -> Dict[str, Any]:
    return onu_signal(_registered_request(req))
