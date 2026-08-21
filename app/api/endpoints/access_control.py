from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional

from fastapi import APIRouter, File, HTTPException, Query, Request, Response, UploadFile
from pydantic import BaseModel, Field

from app.services.access_control_store import (
    access_control_summary,
    access_report_summary,
    delete_device,
    delete_door_group,
    delete_group,
    delete_person,
    delete_rule,
    list_devices,
    list_door_groups,
    list_events,
    list_access_report_events,
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
    record_manual_exit,
    set_door_group_members,
    set_group_members,
    update_device_health,
    upsert_provision_status,
)
from app.services.access_control_device import get_system_info as device_get_system_info
from app.services.access_control_device import get_controller_person_photo as device_get_controller_person_photo
from app.services.access_control_device import list_controller_people as device_list_controller_people
from app.services.access_control_device import open_door as device_open_door
from app.services.access_control_photos import load_person_face_photo, save_person_face_photo
from app.services.access_control_sync import provision_person_everywhere, resolve_target_devices_for_person
from app.services.access_control_notifications import (
    disconnect_access_whatsapp,
    get_access_whatsapp_connection,
    get_access_whatsapp_config,
    save_access_whatsapp_config,
    test_access_whatsapp,
)

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


def _provision_summary_for_person(person_id: str) -> Dict[str, Any]:
    rows = list_provision_status_for_person(person_id)
    total = len(rows)
    ok_count = sum(1 for row in rows if str(row.get("status") or "") == "ok")
    failed_count = sum(1 for row in rows if str(row.get("status") or "") == "failed")
    pending_count = sum(1 for row in rows if str(row.get("status") or "") == "pending")
    last_error = next((str(row.get("last_error") or "") for row in rows if row.get("last_error")), "")
    if failed_count:
        status = "failed"
    elif pending_count:
        status = "pending"
    elif total and ok_count == total:
        status = "ok"
    else:
        status = "not_configured"
    return {
        "status": status,
        "total": total,
        "ok": ok_count,
        "pending": pending_count,
        "failed": failed_count,
        "last_error": last_error,
    }


def _attach_people_provision_summary(people: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    for person in people:
        person["provision_summary"] = _provision_summary_for_person(str(person.get("id") or ""))
    return people


class AccessPersonRequest(BaseModel):
    id: Optional[str] = ""
    full_name: str = Field(min_length=1, max_length=160)
    person_type: str = "student"
    document_id: str = ""
    enrollment_code: str = ""
    class_name: str = ""
    site: str = ""
    controller_user_id: str = ""
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
    access_direction: str = "entrada"
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
    name: str = ""
    weekdays: str = "1234567"
    time_start: str = ""
    time_end: str = ""
    active: bool = True


class AccessManualExitRequest(BaseModel):
    person_id: str
    site: str = ""
    reason: str = ""


class AccessWhatsappConfigRequest(BaseModel):
    enabled: bool = False
    provider: str = "evolution"
    base_url: str = ""
    api_key: str = ""
    instance: str = "sightops"


class AccessWhatsappTestRequest(BaseModel):
    number: str


@router.get("/summary")
def api_access_control_summary() -> Dict[str, Any]:
    return {"ok": True, "summary": access_control_summary()}


@router.get("/whatsapp")
def api_access_control_whatsapp_get() -> Dict[str, Any]:
    return {"ok": True, **get_access_whatsapp_config()}


@router.put("/whatsapp")
def api_access_control_whatsapp_put(req: AccessWhatsappConfigRequest) -> Dict[str, Any]:
    payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    return {"ok": True, **save_access_whatsapp_config(payload)}


@router.post("/whatsapp/test")
def api_access_control_whatsapp_test(req: AccessWhatsappTestRequest) -> Dict[str, Any]:
    payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
    result = test_access_whatsapp(payload)
    if not result.get("ok"):
        raise HTTPException(status_code=400, detail=result.get("error") or "Nao foi possivel enviar o teste.")
    return result


@router.get("/whatsapp/connection")
def api_access_control_whatsapp_connection() -> Dict[str, Any]:
    result = get_access_whatsapp_connection(refresh_qr=False)
    if not result.get("ok") and result.get("state") == "error":
        raise HTTPException(status_code=502, detail=result.get("error") or "Falha ao consultar WhatsApp.")
    return result


@router.post("/whatsapp/qr")
def api_access_control_whatsapp_qr() -> Dict[str, Any]:
    result = get_access_whatsapp_connection(refresh_qr=True)
    if not result.get("ok"):
        status_code = 400 if result.get("state") == "not_configured" else 502
        raise HTTPException(status_code=status_code, detail=result.get("error") or "Falha ao gerar QR Code.")
    return result


@router.post("/whatsapp/disconnect")
def api_access_control_whatsapp_disconnect() -> Dict[str, Any]:
    result = disconnect_access_whatsapp()
    if not result.get("ok"):
        status_code = 400 if result.get("state") == "not_configured" else 502
        raise HTTPException(status_code=status_code, detail=result.get("error") or "Falha ao desconectar WhatsApp.")
    return result


@router.get("/people")
def api_access_control_people(
    search: str = Query(""),
    active: str = Query(""),
    person_type: str = Query(""),
    site: str = Query(""),
) -> Dict[str, Any]:
    people = list_people(search=search, active=active, person_type=person_type, site=site)
    return {"ok": True, "count": len(people), "people": _attach_people_provision_summary(people)}


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


@router.post("/people/{person_id}/face-photo")
async def api_access_control_person_face_photo(
    person_id: str,
    file: UploadFile = File(...),
) -> Dict[str, Any]:
    content_type = str(file.content_type or "").lower()
    if content_type and content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(status_code=400, detail="Envie uma foto JPG, PNG ou WebP.")
    try:
        result = save_person_face_photo(person_id, await file.read())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    _enqueue_provisioning([result["person"]["id"]], force=True)
    return {"ok": True, **result}


@router.get("/people/{person_id}/face-photo")
def api_access_control_person_face_photo_get(person_id: str) -> Response:
    people = list_people()
    person = next((p for p in people if p["id"] == person_id), None)
    if not person:
        raise HTTPException(status_code=404, detail="Pessoa nao encontrada neste cliente.")
    photo = load_person_face_photo(person)
    if photo is None:
        raise HTTPException(status_code=404, detail="Foto facial nao encontrada.")
    return Response(
        content=photo,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=60"},
    )


@router.post("/people/{person_id}/sync")
def api_access_control_sync_person(person_id: str) -> Dict[str, Any]:
    people = list_people()
    person = next((p for p in people if p["id"] == person_id), None)
    if not person:
        raise HTTPException(status_code=404, detail="Pessoa nao encontrada neste cliente.")
    result = provision_person_everywhere(person)
    return {"ok": True, **result, "provision_summary": _provision_summary_for_person(person_id)}


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


@router.post("/devices/{device_id}/test")
def api_access_control_test_device(device_id: str) -> Dict[str, Any]:
    from app.services.access_control_store import get_device_with_password

    device = get_device_with_password(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo nao encontrado neste cliente.")
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    try:
        info = device_get_system_info(device)
    except HTTPException:
        try:
            update_device_health(device_id, status="offline", last_seen_at=now)
        except ValueError:
            pass
        raise
    model = str(info.get("updateSerial") or info.get("deviceType") or device.get("model") or "").strip()
    updated = update_device_health(device_id, status="online", model=model, last_seen_at=now)
    return {"ok": True, "device": updated, "info": info}


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


@router.post("/devices/{device_id}/import-people")
def api_access_control_import_device_people(device_id: str) -> Dict[str, Any]:
    from app.services.access_control_store import get_device_with_password

    device = get_device_with_password(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo nao encontrado neste cliente.")
    controller_people = device_list_controller_people(device)
    existing_by_controller_id = {
        str(person.get("controller_user_id") or ""): person
        for person in list_people()
        if str(person.get("controller_user_id") or "")
    }
    imported: List[Dict[str, Any]] = []
    skipped: List[Dict[str, str]] = []
    photos_imported = 0
    photos_missing = 0
    photo_errors: List[Dict[str, str]] = []
    site = str(device.get("site") or "").strip()
    device_prefix = "".join(ch for ch in str(device.get("id") or device_id) if ch.isalnum())[:16]
    for controller_person in controller_people:
        controller_user_id = str(controller_person.get("controller_user_id") or "").strip()
        full_name = str(controller_person.get("full_name") or "").strip()
        if not controller_user_id or not full_name:
            skipped.append(controller_person)
            continue
        existing = existing_by_controller_id.get(controller_user_id)
        person = save_person(
            {
                "id": existing["id"] if existing else f"ctl-{device_prefix}-{controller_user_id}",
                "full_name": full_name,
                "person_type": existing.get("person_type", "student") if existing else "student",
                "document_id": controller_person.get("document_id", ""),
                "enrollment_code": existing.get("enrollment_code", "") if existing else controller_user_id,
                "class_name": existing.get("class_name", "") if existing else "",
                "site": existing.get("site", "") or site if existing else site,
                "controller_user_id": controller_user_id,
                "guardian_name": existing.get("guardian_name", "") if existing else "",
                "guardian_phone": existing.get("guardian_phone", "") if existing else "",
                "whatsapp_enabled": existing.get("whatsapp_enabled", True) if existing else True,
                "active": True,
                "notes": existing.get("notes", "") if existing else f"Importado da controladora {device.get('name') or device_id}.",
            }
        )
        if not str(person.get("face_photo_path") or "").strip():
            try:
                photo = device_get_controller_person_photo(device, controller_user_id)
            except HTTPException as exc:
                photo_errors.append({"controller_user_id": controller_user_id, "error": str(exc.detail)})
                photo = None
            if photo:
                try:
                    photo_result = save_person_face_photo(person["id"], photo)
                    person = photo_result["person"]
                    photos_imported += 1
                except ValueError as exc:
                    photo_errors.append({"controller_user_id": controller_user_id, "error": str(exc)})
            else:
                photos_missing += 1
        existing_by_controller_id[controller_user_id] = person
        imported.append(person)
    return {
        "ok": True,
        "device_id": device_id,
        "device_name": device.get("name", ""),
        "read": len(controller_people),
        "imported": len(imported),
        "skipped": len(skipped),
        "photos_imported": photos_imported,
        "photos_missing": photos_missing,
        "photo_errors": photo_errors,
        "people": imported,
    }


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


@router.get("/reports/summary")
def api_access_control_report_summary(
    period: str = Query("today"),
    start: str = Query(""),
    end: str = Query(""),
    type: str = Query(""),
    site: str = Query(""),
    search: str = Query(""),
    device_id: str = Query(""),
) -> Dict[str, Any]:
    filters = {
        "period": period,
        "start": start,
        "end": end,
        "type": type,
        "site": site,
        "search": search,
        "device_id": device_id,
    }
    return {"ok": True, "summary": access_report_summary(filters)}


@router.get("/reports/events")
def api_access_control_report_events(
    period: str = Query("today"),
    start: str = Query(""),
    end: str = Query(""),
    type: str = Query(""),
    site: str = Query(""),
    search: str = Query(""),
    device_id: str = Query(""),
    limit: int = Query(300),
) -> Dict[str, Any]:
    filters = {
        "period": period,
        "start": start,
        "end": end,
        "type": type,
        "site": site,
        "search": search,
        "device_id": device_id,
        "limit": limit,
    }
    events = list_access_report_events(filters)
    return {"ok": True, "count": len(events), "events": events}


@router.post("/reports/manual-exit")
def api_access_control_manual_exit(req: AccessManualExitRequest, request: Request) -> Dict[str, Any]:
    try:
        user = getattr(request.state, "user", {}) or {}
        operator_user = str(user.get("username") or user.get("sub") or "")
        event = record_manual_exit(req.person_id, site=req.site, reason=req.reason, operator_user=operator_user)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "event": event}
