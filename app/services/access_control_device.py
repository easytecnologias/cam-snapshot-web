from __future__ import annotations

import json
import base64
import re
from datetime import datetime, timedelta
from typing import Any, Dict, List
from urllib.parse import urlencode

import requests
from fastapi import HTTPException
from requests.auth import HTTPDigestAuth

_TIMEOUT = 10.0
_ACCESS_REC_LIMIT = 1024
_ACCESS_REC_LOOKBACK_DAYS = 90


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


def _is_intelbras_device(device: Dict[str, Any]) -> bool:
    vendor = str(device.get("vendor") or "").strip().lower()
    model = str(device.get("model") or "").strip().lower()
    return vendor == "intelbras" or model.startswith("asi") or "intelbras" in model


def _check_device_response(resp: requests.Response, action: str) -> str:
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Usuario/senha invalidos no dispositivo.")
    text = (resp.text or "").strip()
    if resp.status_code >= 400 or "Error" in text or "error" in text:
        raise HTTPException(status_code=502, detail=f"Dispositivo recusou {action}: {text}")
    return text


def _post_json(device: Dict[str, Any], path_with_query: str, payload: Dict[str, Any], action_label: str) -> str:
    url = f"{_base_url(device)}{path_with_query}"
    try:
        resp = requests.post(url, auth=_auth(device), json=payload, timeout=_TIMEOUT)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel {action_label} no dispositivo: {exc}") from exc
    return _check_device_response(resp, action_label)


def _parse_kv_text(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


def _parse_record_table(text: str) -> List[Dict[str, str]]:
    records: Dict[int, Dict[str, str]] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        match = re.match(r"^records\[(\d+)\]\.(.+)$", key.strip())
        if not match:
            continue
        index = int(match.group(1))
        field = match.group(2).strip()
        records.setdefault(index, {})[field] = value.strip()
    return [records[index] for index in sorted(records)]


def _timestamp_to_text(value: Any) -> str:
    text = str(value or "").strip()
    if not text:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}", text):
        return text
    if text.isdigit():
        try:
            return datetime.fromtimestamp(int(text)).strftime("%Y-%m-%d %H:%M:%S")
        except (OverflowError, OSError, ValueError):
            return text
    return text


def _timestamp_number(value: Any) -> int:
    text = str(value or "").strip()
    return int(text) if text.isdigit() else 0


def _fetch_access_event_rows(device: Dict[str, Any], since_id: str = "") -> List[Dict[str, str]]:
    """Le historico Intelbras sem ficar preso no primeiro bloco de 1024 eventos.

    Algumas controladoras ASI retornam sempre os primeiros registros quando a
    consulta nao informa StartTime, mesmo com `count` maior que 1024. Por isso,
    quando fazemos polling incremental, buscamos tambem uma janela recente por
    timestamp e filtramos por RecNo depois.
    """
    queries: List[Dict[str, Any]] = [
        {"action": "find", "name": "AccessControlCardRec"},
    ]
    since_number = int(since_id) if str(since_id or "").isdigit() else 0
    start_time = int((datetime.now() - timedelta(days=_ACCESS_REC_LOOKBACK_DAYS)).timestamp())
    recent_query = {
        "action": "find",
        "name": "AccessControlCardRec",
        "StartTime": str(start_time),
        "count": str(_ACCESS_REC_LIMIT),
    }
    # Com cursor salvo, a janela recente e a parte que interessa. Sem cursor,
    # mantemos tambem a leitura antiga para preservar importacao inicial.
    if since_number:
        queries = [recent_query]
    else:
        queries.append(recent_query)

    rows_by_id: Dict[str, Dict[str, str]] = {}
    for params in queries:
        guard = 0
        current_params = dict(params)
        while guard < 8:
            guard += 1
            resp = _get(device, "/cgi-bin/recordFinder.cgi", current_params)
            text = (resp.text or "").strip()
            if not text:
                break
            if text.startswith("Error"):
                raise HTTPException(status_code=502, detail=f"Dispositivo respondeu com erro ao listar eventos: {text}")
            rows = _parse_record_table(text)
            if not rows:
                break
            for row in rows:
                raw_id = _first_text(row, "RecNo", "RecordNo", "ID")
                if raw_id:
                    rows_by_id[raw_id] = row
            if len(rows) < _ACCESS_REC_LIMIT or "StartTime" not in current_params:
                break
            max_ts = max(_timestamp_number(_first_text(row, "CreateTime", "Time", "UTC")) for row in rows)
            if max_ts <= int(current_params.get("StartTime") or 0):
                break
            current_params["StartTime"] = str(max_ts + 1)
    return sorted(rows_by_id.values(), key=lambda row: int(_first_text(row, "RecNo", "RecordNo", "ID") or "0"))


def _photo_data_from_access_face_text(text: str) -> bytes | None:
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if not key.strip().lower().endswith(".photodata[0]"):
            continue
        encoded = value.strip()
        if not encoded:
            continue
        try:
            data = base64.b64decode(encoded, validate=True)
        except Exception:
            continue
        if data.startswith(b"\xff\xd8") or data.startswith(b"\x89PNG") or data.startswith(b"RIFF"):
            return data
    return None


def _first_text(row: Dict[str, str], *keys: str) -> str:
    for key in keys:
        value = str(row.get(key) or "").strip()
        if value:
            return value
    return ""


def list_controller_people(device: Dict[str, Any]) -> List[Dict[str, str]]:
    if not _is_intelbras_device(device):
        raise HTTPException(status_code=400, detail="Importacao de pessoas homologada apenas para Intelbras.")
    resp = _get(device, "/cgi-bin/recordFinder.cgi", {"action": "find", "name": "AccessControlCard"})
    people: List[Dict[str, str]] = []
    for row in _parse_record_table(resp.text):
        user_id = _first_text(row, "UserID", "RecNo")
        name = _first_text(row, "CardName", "UserName", "Name")
        if not user_id or not name:
            continue
        people.append(
            {
                "controller_user_id": "".join(ch for ch in user_id if ch.isdigit()),
                "full_name": name,
                "document_id": _first_text(row, "CitizenIDNo"),
                "card_no": _first_text(row, "CardNo"),
                "rec_no": _first_text(row, "RecNo"),
                "valid_from": _first_text(row, "ValidDateStart"),
                "valid_to": _first_text(row, "ValidDateEnd"),
                "raw_active": _first_text(row, "CardStatus", "UserStatus"),
            }
        )
    return people


def get_controller_person_photo(device: Dict[str, Any], controller_user_id: str) -> bytes | None:
    if not _is_intelbras_device(device):
        raise HTTPException(status_code=400, detail="Importacao de fotos homologada apenas para Intelbras.")
    user_id = "".join(ch for ch in str(controller_user_id or "") if ch.isdigit())
    if not user_id:
        return None
    try:
        resp = _get(device, "/cgi-bin/AccessFace.cgi", {"action": "list", "UserIDList[0]": user_id})
    except HTTPException as exc:
        if exc.status_code in {400, 404, 502}:
            return None
        raise
    return _photo_data_from_access_face_text(resp.text)


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


def _provision_intelbras_person(
    device: Dict[str, Any], person: Dict[str, Any], photo_bytes: bytes | None = None
) -> Dict[str, Any]:
    full_name = str(person.get("full_name") or "").strip()
    controller_user_id = "".join(ch for ch in str(person.get("controller_user_id") or "") if ch.isdigit())
    if not full_name:
        raise HTTPException(status_code=400, detail="Pessoa sem nome para provisionar.")
    if not controller_user_id:
        raise HTTPException(status_code=400, detail="Informe o ID na controladora para provisionar na Intelbras.")

    user_payload = {
        "UserList": [
            {
                "UserID": controller_user_id,
                "UserName": full_name,
                "UserType": 0,
                "UseTime": 200,
                "IsFirstEnter": False,
                "UserStatus": 1 if person.get("active") is False else 0,
                "Authority": 2,
                "CitizenIDNo": "",
                "Password": "123456",
                "Doors": [0],
                "TimeSections": [0],
                "ValidFrom": "2024-08-01 00:00:00",
                "ValidTo": "2034-08-01 23:59:59",
            }
        ]
    }
    card_text = _post_json(
        device,
        "/cgi-bin/AccessUser.cgi?action=insertMulti",
        user_payload,
        "o cadastro do usuario",
    )

    face_text = ""
    if photo_bytes:
        payload = {
            "FaceList": [
                {
                    "UserID": controller_user_id,
                    "PhotoData": [base64.b64encode(photo_bytes).decode("ascii")],
                }
            ]
        }
        try:
            face_text = _post_json(device, "/cgi-bin/AccessFace.cgi?action=insertMulti", payload, "a face")
        except HTTPException as exc:
            if "Batch Process Error" not in str(exc.detail):
                raise
            face_text = _post_json(device, "/cgi-bin/AccessFace.cgi?action=updateMulti", payload, "a face")

    return {"ok": True, "raw": card_text, "face_raw": face_text, "controller_user_id": controller_user_id}


def provision_person(device: Dict[str, Any], person: Dict[str, Any], photo_bytes: bytes | None = None) -> Dict[str, Any]:
    full_name = str(person.get("full_name") or "").strip()
    person_id = str(person.get("id") or "").strip()
    if not full_name or not person_id:
        raise HTTPException(status_code=400, detail="Pessoa sem nome/id para provisionar.")
    if _is_intelbras_device(device):
        return _provision_intelbras_person(device, person, photo_bytes)
    info = {
        "UserID": person_id,
        "UserName": full_name,
        "UserType": 0,
        "Doors": [0],
        "ValidFrom": "2020-01-01 00:00:00",
        "ValidTo": "2037-12-31 23:59:59",
    }
    files = {"json": (None, json.dumps({"action": "insertMulti", "Info": [info]}))}
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
    files = {"json": (None, json.dumps({"action": "removeMulti", "UserIDList": [str(person_id)]}))}
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
    """Busca historico de acesso em controladoras Intelbras.

    Em controladoras ASI/Intelbras primeiro, `eventManager.cgi` pode responder
    "No Events" mesmo com historico gravado. O historico real confirmado ao vivo
    fica em `recordFinder.cgi?action=find&name=AccessControlCardRec`.
    """
    if not _is_intelbras_device(device):
        raise HTTPException(status_code=400, detail="Coleta de eventos homologada apenas para Intelbras.")
    events: List[Dict[str, Any]] = []
    since_number = int(since_id) if str(since_id or "").isdigit() else 0
    for row in _fetch_access_event_rows(device, since_id=since_id):
        raw_id = _first_text(row, "RecNo", "RecordNo", "ID")
        if not raw_id:
            continue
        if since_number and raw_id.isdigit() and int(raw_id) <= since_number:
            continue
        status = _first_text(row, "Status")
        if status and status not in {"1", "true", "True", "OK", "ok"}:
            continue
        raw_type = _first_text(row, "Type").lower()
        event_type = "saida" if raw_type in {"exit", "out", "leave", "saida"} else "entrada"
        events.append(
            {
                "raw_id": raw_id,
                "occurred_at": _timestamp_to_text(_first_text(row, "CreateTime", "Time", "UTC")),
                "person_name_raw": _first_text(row, "CardName", "UserName", "Name"),
                "user_id": _first_text(row, "UserID"),
                "card_no": _first_text(row, "CardNo"),
                "event_type": event_type,
                "status": status,
                "method": _first_text(row, "Method"),
                "door": _first_text(row, "Door"),
                "reader_id": _first_text(row, "ReaderID"),
            }
        )
    return events
