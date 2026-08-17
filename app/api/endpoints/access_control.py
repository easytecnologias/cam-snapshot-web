from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.services.access_control_store import (
    access_control_summary,
    delete_device,
    delete_door_group,
    delete_group,
    delete_person,
    delete_rule,
    list_devices,
    list_door_groups,
    list_events,
    list_group_members,
    list_groups,
    list_people,
    list_people_sites,
    list_provision_status_for_person,
    list_rules,
    save_device,
    save_door_group,
    save_group,
    save_person,
    save_rule,
    set_door_group_members,
    set_group_members,
    upsert_provision_status,
)
from app.services.access_control_device import open_door as device_open_door
from app.services.access_control_sync import provision_person_everywhere, resolve_target_devices_for_person

router = APIRouter(prefix="/api/access-control", tags=["access-control"])


def _enqueue_provisioning(person_ids: Iterable[str], *, force: bool = False) -> int:
    """Marca 'pending' cada par (pessoa, dispositivo) que as regras resolvem.

    Nunca chama o dispositivo: so grava o status. Quem realmente fala com a
    catraca e o loop de fundo (`retry_pending_provisions`). Isso e um Global
    Constraint deste plano -- salvar pessoa/grupo/regra nao pode ficar preso no
    timeout de uma catraca offline.

    `force=False` (grupo/grupo de porta/regra): so enfileira o par que ainda nao
    esta 'ok'. Renomear um grupo de 300 alunos nao precisa reprovisionar todo
    mundo -- o dado da pessoa nao mudou, so o caminho de acesso.
    `force=True` (salvar pessoa): reenfileira mesmo se ja estava 'ok', porque os
    dados que vao pra credencial (nome, ativo) acabaram de mudar.
    """
    queued = 0
    seen: set[str] = set()
    for raw_id in person_ids:
        person_id = str(raw_id or "").strip()
        if not person_id or person_id in seen:
            continue
        seen.add(person_id)
        already_ok: set[str] = set()
        if not force:
            already_ok = {
                str(row.get("device_id") or "")
                for row in list_provision_status_for_person(person_id)
                if str(row.get("status") or "") == "ok"
            }
        for device in resolve_target_devices_for_person(person_id):
            if device["id"] in already_ok:
                continue
            upsert_provision_status(person_id, device["id"], "pending")
            queued += 1
    return queued


def _people_of_door_group(door_group_id: str) -> List[str]:
    """Pessoas que alcancam este grupo de portas por alguma regra ativa."""
    person_ids: List[str] = []
    for rule in list_rules():
        if not rule.get("active"):
            continue
        if str(rule.get("door_group_id") or "") != str(door_group_id):
            continue
        person_ids.extend(list_group_members(str(rule.get("people_group_id") or "")))
    return person_ids


class AccessPersonRequest(BaseModel):
    id: Optional[str] = ""
    full_name: str = Field(min_length=1, max_length=160)
    person_type: str = "student"
    document_id: str = ""
    enrollment_code: str = ""
    class_name: str = ""
    site: str = ""
    guardian_name: str = ""
    guardian_phone: str = ""
    whatsapp_enabled: bool = True
    active: bool = True
    notes: str = ""


class AccessDeviceRequest(BaseModel):
    id: Optional[str] = ""
    name: str = Field(min_length=1, max_length=160)
    site: str = ""
    vendor: str = "dahua"
    model: str = ""
    host: str = Field(min_length=1)
    connector_id: str = ""
    username: str = "admin"
    password: Optional[str] = ""
    active: bool = True


class AccessGroupRequest(BaseModel):
    id: Optional[str] = ""
    name: str = Field(min_length=1, max_length=160)
    site: str = ""
    active: bool = True
    member_ids: List[str] = []


class AccessDoorGroupRequest(BaseModel):
    id: Optional[str] = ""
    name: str = Field(min_length=1, max_length=160)
    site: str = ""
    active: bool = True
    device_ids: List[str] = []


class AccessRuleRequest(BaseModel):
    id: Optional[str] = ""
    people_group_id: str
    door_group_id: str
    weekdays: str = "1234567"
    time_start: str = ""
    time_end: str = ""
    active: bool = True


@router.get("/summary")
def api_access_control_summary() -> Dict[str, Any]:
    return {"ok": True, "summary": access_control_summary()}


@router.get("/people")
def api_access_control_people(
    search: str = Query(""),
    active: str = Query(""),
    person_type: str = Query(""),
    site: str = Query(""),
) -> Dict[str, Any]:
    people = list_people(search=search, active=active, person_type=person_type, site=site)
    return {"ok": True, "count": len(people), "people": people}


@router.get("/people/sites")
def api_access_control_people_sites() -> Dict[str, Any]:
    return {"ok": True, "sites": list_people_sites()}


@router.post("/people")
def api_access_control_save_person(req: AccessPersonRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        person = save_person(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Nao chama o dispositivo aqui -- so marca "pending" e devolve na hora.
    # O loop de fundo (Task 7, `retry_pending_provisions`) e quem realmente
    # fala com a catraca, a cada 60-900s. Chamar o dispositivo de forma
    # sincrona aqui prenderia a resposta HTTP de salvar pessoa ate o
    # timeout se a catraca estiver lenta/offline -- proibido pelo Global
    # Constraint deste plano ("Nenhuma chamada ao dispositivo pode
    # bloquear a resposta HTTP de salvar uma pessoa/regra").
    _enqueue_provisioning([person["id"]], force=True)
    return {"ok": True, "person": person}


@router.delete("/people/{person_id}")
def api_access_control_delete_person(person_id: str) -> Dict[str, Any]:
    removed = delete_person(person_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Pessoa nao encontrada neste cliente.")
    return {"ok": True, "removed": True}


@router.post("/people/{person_id}/sync")
def api_access_control_sync_person(person_id: str) -> Dict[str, Any]:
    people = list_people()
    person = next((p for p in people if p["id"] == person_id), None)
    if not person:
        raise HTTPException(status_code=404, detail="Pessoa nao encontrada neste cliente.")
    result = provision_person_everywhere(person)
    return {"ok": True, **result}


@router.get("/devices")
def api_access_control_devices() -> Dict[str, Any]:
    return {"ok": True, "devices": list_devices()}


@router.post("/devices")
def api_access_control_save_device(req: AccessDeviceRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        device = save_device(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "device": device}


@router.delete("/devices/{device_id}")
def api_access_control_delete_device(device_id: str) -> Dict[str, Any]:
    removed = delete_device(device_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Dispositivo nao encontrado neste cliente.")
    return {"ok": True, "removed": True}


@router.post("/devices/{device_id}/open-door")
def api_access_control_open_door(device_id: str, channel: int = 1) -> Dict[str, Any]:
    from app.services.access_control_store import get_device_with_password

    device = get_device_with_password(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo nao encontrado neste cliente.")
    result = device_open_door(device, channel=channel)
    return {"ok": True, **result}


@router.get("/groups")
def api_access_control_groups() -> Dict[str, Any]:
    groups = list_groups()
    for group in groups:
        group["member_ids"] = list_group_members(group["id"])
    return {"ok": True, "groups": groups}


@router.post("/groups")
def api_access_control_save_group(req: AccessGroupRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        member_ids = payload.pop("member_ids", [])
        group = save_group(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    set_group_members(group["id"], member_ids)
    group["member_ids"] = member_ids
    # A spec manda enfileirar provisionamento "ao salvar uma pessoa, ou mudar
    # membership de grupo, ou criar/editar uma regra". Sem este passo, a ordem
    # normal de implantacao (cria pessoas -> cria grupo -> cria grupo de porta
    # -> cria regra) nao gerava nenhuma linha pendente e o loop de fundo nunca
    # provisionava ninguem: retry_pending_provisions() so reprocessa linhas que
    # ja existem, nunca descobre pares (pessoa, dispositivo) novos sozinho.
    _enqueue_provisioning(member_ids)
    return {"ok": True, "group": group}


@router.delete("/groups/{group_id}")
def api_access_control_delete_group(group_id: str) -> Dict[str, Any]:
    removed = delete_group(group_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Grupo nao encontrado neste cliente.")
    return {"ok": True, "removed": True}


@router.get("/door-groups")
def api_access_control_door_groups() -> Dict[str, Any]:
    from app.services.access_control_store import list_door_group_members

    door_groups = list_door_groups()
    for door_group in door_groups:
        door_group["device_ids"] = list_door_group_members(door_group["id"])
    return {"ok": True, "door_groups": door_groups}


@router.post("/door-groups")
def api_access_control_save_door_group(req: AccessDoorGroupRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        device_ids = payload.pop("device_ids", [])
        door_group = save_door_group(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    set_door_group_members(door_group["id"], device_ids)
    door_group["device_ids"] = device_ids
    # Mudou o conjunto de portas: toda pessoa que chega neste grupo de portas
    # por alguma regra ativa pode ter ganhado um dispositivo novo.
    _enqueue_provisioning(_people_of_door_group(door_group["id"]))
    return {"ok": True, "door_group": door_group}


@router.delete("/door-groups/{door_group_id}")
def api_access_control_delete_door_group(door_group_id: str) -> Dict[str, Any]:
    removed = delete_door_group(door_group_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Grupo de portas nao encontrado neste cliente.")
    return {"ok": True, "removed": True}


@router.get("/rules")
def api_access_control_rules() -> Dict[str, Any]:
    return {"ok": True, "rules": list_rules()}


@router.post("/rules")
def api_access_control_save_rule(req: AccessRuleRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        rule = save_rule(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # A regra e o que liga grupo de pessoas a grupo de portas -- criar/reativar
    # uma regra costuma ser o passo que finalmente da acesso a um dispositivo.
    if rule.get("active"):
        _enqueue_provisioning(list_group_members(str(rule.get("people_group_id") or "")))
    return {"ok": True, "rule": rule}


@router.delete("/rules/{rule_id}")
def api_access_control_delete_rule(rule_id: str) -> Dict[str, Any]:
    removed = delete_rule(rule_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Regra nao encontrada neste cliente.")
    return {"ok": True, "removed": True}


@router.get("/events")
def api_access_control_events(
    person_id: str = Query(""),
    site: str = Query(""),
    limit: int = Query(200),
) -> Dict[str, Any]:
    events = list_events(person_id=person_id, site=site, limit=limit)
    return {"ok": True, "count": len(events), "events": events}
