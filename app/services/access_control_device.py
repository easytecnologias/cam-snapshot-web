from __future__ import annotations

from typing import Any, Dict, List
from urllib.parse import urlencode

import requests
from fastapi import HTTPException
from requests.auth import HTTPDigestAuth

_TIMEOUT = 10.0


def _base_url(device: Dict[str, Any]) -> str:
    host = str(device.get("host") or "").strip()
    if not host:
        raise HTTPException(status_code=400, detail="Dispositivo sem host configurado.")
    return f"http://{host}"


def _auth(device: Dict[str, Any]) -> HTTPDigestAuth:
    return HTTPDigestAuth(str(device.get("username") or "admin"), str(device.get("password") or ""))


def _get(device: Dict[str, Any], path: str, params: Dict[str, Any] | None = None) -> requests.Response:
    url = f"{_base_url(device)}{path}"
    if params:
        url = f"{url}?{urlencode(params)}"
    try:
        resp = requests.get(url, auth=_auth(device), timeout=_TIMEOUT)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel falar com o dispositivo: {exc}") from exc
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Usuario/senha invalidos no dispositivo.")
    if resp.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"Dispositivo respondeu com erro (HTTP {resp.status_code}): {(resp.text or '').strip()}",
        )
    return resp


def _parse_kv_text(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


def get_system_info(device: Dict[str, Any]) -> Dict[str, str]:
    resp = _get(device, "/cgi-bin/magicBox.cgi", {"action": "getSystemInfo"})
    return _parse_kv_text(resp.text)


def open_door(device: Dict[str, Any], channel: int = 1) -> Dict[str, Any]:
    resp = _get(
        device,
        "/cgi-bin/accessControl.cgi",
        {"action": "openDoor", "channel": int(channel or 1), "UserID": "SightOps", "Type": "Remote"},
    )
    text = (resp.text or "").strip()
    if text.upper().startswith("ERROR") or "Error" in text:
        raise HTTPException(status_code=502, detail=f"Dispositivo recusou abrir a porta: {text}")
    return {"ok": True, "raw": text}


def provision_person(device: Dict[str, Any], person: Dict[str, Any], photo_bytes: bytes | None = None) -> Dict[str, Any]:
    full_name = str(person.get("full_name") or "").strip()
    person_id = str(person.get("id") or "").strip()
    if not full_name or not person_id:
        raise HTTPException(status_code=400, detail="Pessoa sem nome/id para provisionar.")
    info = {
        "UserID": person_id,
        "UserName": full_name,
        "UserType": 0,
        "Doors": [0],
        "ValidFrom": "2020-01-01 00:00:00",
        "ValidTo": "2037-12-31 23:59:59",
    }
    files = {"json": (None, str({"action": "insertMulti", "Info": [info]}))}
    if photo_bytes:
        files["Photo"] = ("face.jpg", photo_bytes, "image/jpeg")
    url = f"{_base_url(device)}/cgi-bin/AccessUser.cgi"
    try:
        resp = requests.post(url, auth=_auth(device), files=files, timeout=_TIMEOUT)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel provisionar no dispositivo: {exc}") from exc
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Usuario/senha invalidos no dispositivo.")
    text = (resp.text or "").strip()
    if resp.status_code >= 400 or "Error" in text or "error" in text:
        raise HTTPException(status_code=502, detail=f"Dispositivo recusou o cadastro: {text}")
    return {"ok": True, "raw": text}


def remove_person(device: Dict[str, Any], person_id: str) -> Dict[str, Any]:
    url = f"{_base_url(device)}/cgi-bin/AccessUser.cgi"
    files = {"json": (None, str({"action": "removeMulti", "UserIDList": [str(person_id)]}))}
    try:
        resp = requests.post(url, auth=_auth(device), files=files, timeout=_TIMEOUT)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel remover no dispositivo: {exc}") from exc
    text = (resp.text or "").strip()
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Usuario/senha invalidos no dispositivo.")
    if resp.status_code >= 400 or "Error" in text or "error" in text:
        raise HTTPException(status_code=502, detail=f"Dispositivo recusou a remocao: {text}")
    return {"ok": True, "raw": text}


def poll_events(device: Dict[str, Any], since_id: str = "") -> List[Dict[str, Any]]:
    """Busca eventos de acesso recentes no dispositivo.

    Ajustado na Task 4 Step 6 (smoke test ao vivo contra 10.10.13.33): a acao
    original do plano (`accessControl.cgi?action=getRecordList`) NAO existe
    neste firmware -- responde HTTP 501 "Error / Not Implemented!". A acao
    real confirmada por sondagem ao vivo e `eventManager.cgi?action=getEventIndexes`
    (HTTP 200; responde "Error: No Events" em texto quando a lista esta vazia,
    e HTTP 400 "Error / Bad Request!" se o parametro `code` faltar).

    O formato de um evento *populado* (pessoa passou/tentou passar) NAO foi
    capturado ao vivo -- gerar um evento real exigiria abrir a porta ou
    apresentar um rosto ao terminal fisico, e a abertura remota da porta foi
    bloqueada pelo classificador de seguranca do ambiente de execucao deste
    agente (acao com efeito fisico real, corretamente recusada). O parsing
    abaixo trata "sem eventos" (respostas iniciadas por "Error") como lista
    vazia -- isso e confirmado -- mas o mapeamento de campos de um evento real
    e melhor esforco e PRECISA ser revalidado assim que houver um evento real
    no log do dispositivo (ex.: proximo acesso legitimo no local).
    """
    resp = _get(device, "/cgi-bin/eventManager.cgi", {"action": "getEventIndexes", "code": "AccessControlCardRec"})
    text = (resp.text or "").strip()
    if not text or text.startswith("Error"):
        return []
    events: List[Dict[str, Any]] = []
    for line in text.splitlines():
        parts = line.split(",")
        if len(parts) < 3:
            continue
        events.append({
            "raw_id": parts[0],
            "occurred_at": parts[1],
            "person_name_raw": parts[2],
            "event_type": "entrada",
        })
    return events
