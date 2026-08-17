from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import HTTPException

from app.services.access_control_device import poll_events, provision_person
from app.services.access_control_store import (
    get_device_with_password,
    list_devices,
    list_door_group_members,
    list_group_members,
    list_groups,
    list_pending_provisions,
    list_rules,
    record_event,
    upsert_provision_status,
)

logger = logging.getLogger("cam-snapshot")


def resolve_target_devices_for_person(person_id: str) -> List[Dict[str, Any]]:
    """Pessoa -> grupos que ela participa -> regras ativas -> grupos de porta -> dispositivos (unico por id)."""
    person_groups = {
        group["id"]
        for group in list_groups()
        if person_id in list_group_members(group["id"])
    }
    if not person_groups:
        return []
    door_group_ids = {
        rule["door_group_id"]
        for rule in list_rules()
        if rule.get("active") and rule.get("people_group_id") in person_groups
    }
    if not door_group_ids:
        return []
    device_ids: set[str] = set()
    for door_group_id in door_group_ids:
        device_ids.update(list_door_group_members(door_group_id))
    devices_by_id = {d["id"]: d for d in list_devices() if d.get("active")}
    return [devices_by_id[did] for did in device_ids if did in devices_by_id]


def provision_person_everywhere(person: Dict[str, Any]) -> Dict[str, Any]:
    """Provisiona a pessoa em todos os dispositivos-alvo resolvidos para ela.

    Uma falha em um dispositivo nunca impede tentar os demais nem propaga como
    excecao nao tratada -- e sempre capturada e registrada via
    upsert_provision_status, e refletida em results[i]["status"] == "failed".
    """
    targets = resolve_target_devices_for_person(person["id"])
    results: List[Dict[str, Any]] = []
    overall_ok = True
    for device in targets:
        upsert_provision_status(person["id"], device["id"], "pending")
        full_device = get_device_with_password(device["id"])
        if not full_device:
            overall_ok = False
            error_text = "Dispositivo nao encontrado neste cliente."
            upsert_provision_status(person["id"], device["id"], "failed", error_text)
            results.append({"device_id": device["id"], "status": "failed", "error": error_text})
            continue
        try:
            provision_person(full_device, person)
            upsert_provision_status(person["id"], device["id"], "ok")
            results.append({"device_id": device["id"], "status": "ok", "error": ""})
        except HTTPException as exc:
            overall_ok = False
            error_text = str(exc.detail)
            upsert_provision_status(person["id"], device["id"], "failed", error_text)
            results.append({"device_id": device["id"], "status": "failed", "error": error_text})
            logger.warning(
                "Falha ao provisionar pessoa %s no dispositivo %s: %s", person["id"], device["id"], error_text
            )
        except Exception as exc:  # defesa extra: nunca deixar um dispositivo derrubar os demais
            overall_ok = False
            error_text = str(exc)
            upsert_provision_status(person["id"], device["id"], "failed", error_text)
            results.append({"device_id": device["id"], "status": "failed", "error": error_text})
            logger.exception(
                "Erro inesperado ao provisionar pessoa %s no dispositivo %s", person["id"], device["id"]
            )
    return {"ok": overall_ok, "results": results}


def retry_pending_provisions() -> Dict[str, Any]:
    """Reprocessa provisionamentos com status 'pending' ou 'failed' (chamado em loop pela Task 7).

    Sem backoff/retry-count aqui de proposito -- essa funcao so tenta uma vez
    por chamada; a politica de repeticao (intervalo, limite de tentativas)
    e responsabilidade de quem a chama em loop (Task 7), nao dela.
    """
    from app.services.access_control_store import list_people  # import tardio evita ciclo

    pending = list_pending_provisions()
    if not pending:
        return {"ok": True, "retried": 0}
    people_by_id = {p["id"]: p for p in list_people()}
    retried = 0
    for item in pending:
        person = people_by_id.get(item["person_id"])
        device = get_device_with_password(item["device_id"])
        if not person or not device:
            continue
        try:
            provision_person(device, person)
            upsert_provision_status(item["person_id"], item["device_id"], "ok")
        except HTTPException as exc:
            upsert_provision_status(item["person_id"], item["device_id"], "failed", str(exc.detail))
            logger.warning(
                "Retry de provisionamento falhou para pessoa %s no dispositivo %s: %s",
                item["person_id"], item["device_id"], exc.detail,
            )
        except Exception as exc:
            upsert_provision_status(item["person_id"], item["device_id"], "failed", str(exc))
            logger.exception(
                "Erro inesperado no retry de provisionamento (pessoa %s, dispositivo %s)",
                item["person_id"], item["device_id"],
            )
        retried += 1
    return {"ok": True, "retried": retried}


def poll_device_events(device_id: str) -> int:
    """Busca eventos novos de um dispositivo e grava no historico.

    Nota: poll_events (access_control_device.py) ainda nao filtra por
    since_id no dispositivo -- sempre devolve o indice de eventos inteiro
    que o firmware expoe, e documenta que quem chama precisa deduplicar por
    raw_id. Este Task 5 grava os eventos retornados; a deduplicacao/cursor
    incremental por device (guardar o maior raw_id ja visto) fica para a
    Task 7, que e quem efetivamente chama esta funcao em loop continuo e
    tem o estado de "ultimo evento processado" por dispositivo.
    """
    device = get_device_with_password(device_id)
    if not device:
        return 0
    try:
        events = poll_events(device, since_id=device.get("last_event_id") or "")
    except HTTPException as exc:
        logger.warning("Falha ao consultar eventos do dispositivo %s: %s", device_id, exc.detail)
        return 0
    for event in events:
        record_event({
            "site": device.get("site", ""),
            "device_id": device_id,
            "person_id": "",
            "person_name_raw": event.get("person_name_raw", ""),
            "event_type": event.get("event_type", "entrada"),
            "occurred_at": event.get("occurred_at", ""),
        })
    return len(events)
