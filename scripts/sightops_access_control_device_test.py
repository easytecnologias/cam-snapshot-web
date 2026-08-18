from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.access_control_device import get_system_info, open_door, poll_events, provision_person


def test_get_system_info_parses_response() -> None:
    device = {"host": "10.10.13.33", "username": "admin", "password": "xzydsP2011"}
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.text = (
        "appAutoStart=true\r\n"
        "deviceType=SS 3542 MF W\r\n"
        "hardwareVersion=1.00\r\n"
        "processor=FREYJA\r\n"
        "serialNumber=5PGM370013181\r\n"
        "updateSerial=ASI6214S-W\r\n"
    )
    fake_response.raise_for_status = MagicMock()
    with patch("app.services.access_control_device.requests.get", return_value=fake_response) as mock_get:
        info = get_system_info(device)
    assert info["deviceType"] == "SS 3542 MF W"
    assert info["updateSerial"] == "ASI6214S-W"
    called_url = mock_get.call_args.args[0]
    assert "getSystemInfo" in called_url


def test_open_door_checks_ok_response() -> None:
    device = {"host": "10.10.13.33", "username": "admin", "password": "xzydsP2011"}
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.text = "OK"
    fake_response.raise_for_status = MagicMock()
    with patch("app.services.access_control_device.requests.get", return_value=fake_response):
        result = open_door(device, channel=1)
    assert result["ok"] is True


def test_open_door_raises_on_device_error() -> None:
    from fastapi import HTTPException

    device = {"host": "10.10.13.33", "username": "admin", "password": "wrong"}
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.text = "Error: Invalid channel"
    fake_response.raise_for_status = MagicMock()
    with patch("app.services.access_control_device.requests.get", return_value=fake_response):
        try:
            open_door(device, channel=99)
            raise AssertionError("deveria ter levantado HTTPException")
        except HTTPException as exc:
            assert "Invalid channel" in str(exc.detail)


def test_poll_events_empty_response_is_confirmed_real_device_behavior() -> None:
    """Texto real observado ao vivo em 10.10.13.33 (Task 4 Step 6):
    GET /cgi-bin/eventManager.cgi?action=getEventIndexes&code=AccessControlCardRec
    -> HTTP 200, corpo "Error: No Events"
    (accessControl.cgi?action=getRecordList, usado antes, respondia HTTP 501
    "Error\\nNot Implemented!" -- essa acao nao existe neste firmware).
    """
    device = {"host": "10.10.13.33", "username": "admin", "password": "xzydsP2011"}
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.text = "Error: No Events"
    with patch("app.services.access_control_device.requests.get", return_value=fake_response) as mock_get:
        events = poll_events(device)
    assert events == []
    called_url = mock_get.call_args.args[0]
    assert "eventManager.cgi" in called_url
    assert "getEventIndexes" in called_url


def test_poll_events_raises_on_unexpected_error_body() -> None:
    """Review finding: so "Error: No Events" (confirmado ao vivo) pode virar
    lista vazia. Qualquer OUTRO corpo iniciado por "Error" (ex.: falha de
    autenticacao, mau funcionamento) tem que levantar HTTPException com o
    texto real do dispositivo -- nao pode virar lista vazia silenciosa,
    senao quem faz polling em loop nao consegue distinguir "sem novidade"
    de "dispositivo com problema".
    """
    from fastapi import HTTPException

    device = {"host": "10.10.13.33", "username": "admin", "password": "xzydsP2011"}
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.text = "Error: Authentication Failed"
    with patch("app.services.access_control_device.requests.get", return_value=fake_response):
        try:
            poll_events(device)
            raise AssertionError("deveria ter levantado HTTPException")
        except HTTPException as exc:
            assert "Authentication Failed" in str(exc.detail)


def test_provision_person_sends_valid_json_not_python_repr() -> None:
    """Review finding: o multipart 'json' era montado com str(dict) (repr do
    Python -- aspas simples, True/False/None capitalizados), nao JSON de
    verdade. Trocado para json.dumps(). Este teste falha se alguem reverter
    pra str() -- json.loads() rejeitaria o repr do Python.
    """
    device = {"host": "10.10.13.33", "username": "admin", "password": "xzydsP2011"}
    person = {"id": "p1", "full_name": "Fulano de Tal"}
    fake_response = MagicMock()
    fake_response.status_code = 200
    fake_response.text = "OK"
    with patch("app.services.access_control_device.requests.post", return_value=fake_response) as mock_post:
        result = provision_person(device, person)
    assert result["ok"] is True
    sent_files = mock_post.call_args.kwargs["files"]
    sent_json_text = sent_files["json"][1]
    payload = json.loads(sent_json_text)  # levanta ValueError se nao for JSON valido
    assert payload["action"] == "insertMulti"
    assert payload["Info"][0]["UserID"] == "p1"
    assert payload["Info"][0]["UserName"] == "Fulano de Tal"


def test_provision_intelbras_uses_legacy_card_and_face_endpoints() -> None:
    device = {"host": "10.10.10.175", "username": "admin", "password": "secret", "vendor": "intelbras"}
    person = {"id": "internal-id", "controller_user_id": "1001", "full_name": "Elishafan Teste"}
    fake_user = MagicMock()
    fake_user.status_code = 200
    fake_user.text = "OK"
    fake_face = MagicMock()
    fake_face.status_code = 200
    fake_face.text = "OK"

    with patch("app.services.access_control_device.requests.post", side_effect=[fake_user, fake_face]) as mock_post:
        result = provision_person(device, person, photo_bytes=b"jpeg-bytes")

    assert result["ok"] is True
    user_url = mock_post.call_args_list[0].args[0]
    assert user_url.endswith("/cgi-bin/AccessUser.cgi?action=insertMulti")
    sent_user_payload = mock_post.call_args_list[0].kwargs["json"]
    assert sent_user_payload["UserList"][0]["UserID"] == "1001"
    assert sent_user_payload["UserList"][0]["UserName"] == "Elishafan Teste"
    assert sent_user_payload["UserList"][0]["Password"] == "123456"
    assert sent_user_payload["UserList"][0]["Doors"] == [0]

    face_url = mock_post.call_args_list[1].args[0]
    assert face_url.endswith("/cgi-bin/AccessFace.cgi?action=insertMulti")
    sent_payload = mock_post.call_args_list[1].kwargs["json"]
    assert sent_payload["FaceList"][0]["UserID"] == "1001"
    assert sent_payload["FaceList"][0]["PhotoData"][0]


def test_provision_intelbras_requires_controller_user_id() -> None:
    from fastapi import HTTPException

    device = {"host": "10.10.10.175", "username": "admin", "password": "secret", "vendor": "intelbras"}
    person = {"id": "internal-id", "full_name": "Sem Id"}
    try:
        provision_person(device, person, photo_bytes=b"jpeg-bytes")
        raise AssertionError("deveria exigir controller_user_id para Intelbras")
    except HTTPException as exc:
        assert "ID na controladora" in str(exc.detail)


def test_provision_intelbras_updates_face_when_insert_reports_batch_error() -> None:
    device = {"host": "10.10.10.175", "username": "admin", "password": "secret", "vendor": "intelbras"}
    person = {"id": "internal-id", "controller_user_id": "1001", "full_name": "Elishafan Teste"}
    fake_user = MagicMock()
    fake_user.status_code = 200
    fake_user.text = "OK"
    fake_face_insert = MagicMock()
    fake_face_insert.status_code = 400
    fake_face_insert.text = "Batch Process Error"
    fake_face_update = MagicMock()
    fake_face_update.status_code = 200
    fake_face_update.text = "OK"

    with patch(
        "app.services.access_control_device.requests.post",
        side_effect=[fake_user, fake_face_insert, fake_face_update],
    ) as mock_post:
        result = provision_person(device, person, photo_bytes=b"jpeg-bytes")

    assert result["ok"] is True
    assert mock_post.call_args_list[1].args[0].endswith("/cgi-bin/AccessFace.cgi?action=insertMulti")
    assert mock_post.call_args_list[2].args[0].endswith("/cgi-bin/AccessFace.cgi?action=updateMulti")


def main() -> None:
    test_get_system_info_parses_response()
    test_open_door_checks_ok_response()
    test_open_door_raises_on_device_error()
    test_poll_events_empty_response_is_confirmed_real_device_behavior()
    test_poll_events_raises_on_unexpected_error_body()
    test_provision_person_sends_valid_json_not_python_repr()
    test_provision_intelbras_uses_legacy_card_and_face_endpoints()
    test_provision_intelbras_requires_controller_user_id()
    test_provision_intelbras_updates_face_when_insert_reports_batch_error()
    print("OK access control device client: getSystemInfo, openDoor, poll_events, provision_person")


if __name__ == "__main__":
    main()
