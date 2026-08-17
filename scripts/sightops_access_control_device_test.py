from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.services.access_control_device import get_system_info, open_door


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


def main() -> None:
    test_get_system_info_parses_response()
    test_open_door_checks_ok_response()
    test_open_door_raises_on_device_error()
    print("OK access control device client: getSystemInfo, openDoor")


if __name__ == "__main__":
    main()
