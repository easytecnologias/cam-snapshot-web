from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Any


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DATA_DIR"] = tmp
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-access-control-notifications.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-access-control-notifications-test-key"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_store import (
            ensure_access_control_schema,
            list_access_report_events,
            record_event,
            save_device,
            save_person,
        )
        from app.services.db_store import save_app_settings

        sent: list[dict[str, Any]] = []

        class FakeResponse:
            ok = True
            status_code = 200
            content = b'{"ok": true}'

            def json(self) -> dict[str, Any]:
                return {"ok": True}

        def fake_post(url: str, **kwargs: Any) -> FakeResponse:
            sent.append({"url": url, **kwargs})
            return FakeResponse()

        import requests

        original_post = requests.post
        requests.post = fake_post
        token = set_current_tenant_slug("escola-alertas")
        try:
            ensure_access_control_schema()
            save_app_settings(
                {
                    "telegram_notifications": {
                        "enabled": True,
                        "bot_token": "telegram-token",
                        "chat_id": "-100123",
                    },
                    "access_control_whatsapp_notifications": {
                        "enabled": True,
                        "webhook_url": "https://whatsapp.example.test/send",
                    },
                }
            )
            person = save_person(
                {
                    "full_name": "Aluno Notificado",
                    "person_type": "student",
                    "class_name": "7A",
                    "site": "ESCOLA",
                    "guardian_phone": "(82) 99999-0000",
                    "whatsapp_enabled": True,
                }
            )
            device = save_device(
                {
                    "name": "Portaria Entrada",
                    "site": "ESCOLA",
                    "host": "10.0.0.10",
                    "username": "admin",
                    "password": "12345678",
                    "access_direction": "entrada",
                }
            )

            first_id = record_event(
                {
                    "site": "ESCOLA",
                    "device_id": device["id"],
                    "device_name": device["name"],
                    "device_role": device["access_direction"],
                    "person_id": person["id"],
                    "person_name_raw": person["full_name"],
                    "event_type": "entrada",
                    "raw_event_id": "entrada-1",
                    "occurred_at": "2026-08-20 07:10:00",
                }
            )
            duplicate_id = record_event(
                {
                    "site": "ESCOLA",
                    "device_id": device["id"],
                    "device_name": device["name"],
                    "device_role": device["access_direction"],
                    "person_id": person["id"],
                    "person_name_raw": person["full_name"],
                    "event_type": "entrada",
                    "raw_event_id": "entrada-1",
                    "occurred_at": "2026-08-20 07:10:00",
                }
            )

            assert duplicate_id == first_id
            assert len(sent) == 2, sent
            assert sent[0]["url"] == "https://api.telegram.org/bottelegram-token/sendMessage"
            assert sent[0]["json"]["chat_id"] == "-100123"
            assert "ENTRADA" in sent[0]["json"]["text"], sent[0]
            assert "Aluno Notificado" in sent[0]["json"]["text"], sent[0]
            assert sent[1]["url"] == "https://whatsapp.example.test/send"
            assert sent[1]["json"]["to"] == "+5582999990000", sent[1]
            assert "Aluno Notificado" in sent[1]["json"]["message"], sent[1]

            events = list_access_report_events({"period": "all", "site": "ESCOLA"})
            assert events[0]["id"] == first_id, events
            assert "telegram_sent" in events[0]["notification_status"], events
            assert "whatsapp_sent" in events[0]["notification_status"], events
        finally:
            requests.post = original_post
            reset_current_tenant_slug(token)

    print("access-control notifications regression ok")


def test_evolution_provider_payload() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DATA_DIR"] = tmp
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-access-control-evolution.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-access-control-evolution-test-key"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_store import ensure_access_control_schema, record_event, save_person
        from app.services.db_store import save_app_settings

        sent: list[dict[str, Any]] = []

        class FakeResponse:
            ok = True
            status_code = 201
            content = b'{"status": "PENDING"}'

            def json(self) -> dict[str, Any]:
                return {"status": "PENDING"}

        def fake_post(url: str, **kwargs: Any) -> FakeResponse:
            sent.append({"url": url, **kwargs})
            return FakeResponse()

        import requests

        original_post = requests.post
        requests.post = fake_post
        token = set_current_tenant_slug("escola-evolution")
        try:
            ensure_access_control_schema()
            save_app_settings(
                {
                    "access_control_whatsapp_notifications": {
                        "enabled": True,
                        "provider": "evolution",
                        "base_url": "http://localhost:8080",
                        "api_key": "evo-key",
                        "instance": "sightops",
                    },
                }
            )
            person = save_person(
                {
                    "full_name": "Aluno Evolution",
                    "site": "ESCOLA",
                    "guardian_phone": "+55 (82) 98136-6839",
                    "whatsapp_enabled": True,
                }
            )

            record_event(
                {
                    "site": "ESCOLA",
                    "person_id": person["id"],
                    "person_name_raw": person["full_name"],
                    "event_type": "saida",
                    "raw_event_id": "saida-evo-1",
                    "occurred_at": "2026-08-20 11:40:00",
                }
            )

            assert len(sent) == 1, sent
            assert sent[0]["url"] == "http://localhost:8080/message/sendText/sightops"
            assert sent[0]["headers"]["apikey"] == "evo-key"
            assert sent[0]["json"]["number"] == "5582981366839"
            assert sent[0]["json"]["text"].startswith("SAIDA - Controle de Acesso"), sent[0]
        finally:
            requests.post = original_post
            reset_current_tenant_slug(token)


def test_evolution_provider_uses_site_specific_instance() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DATA_DIR"] = tmp
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-access-control-evolution-sites.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-access-control-evolution-sites-test-key"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_store import ensure_access_control_schema, record_event, save_person
        from app.services.db_store import save_app_settings

        sent: list[dict[str, Any]] = []

        class FakeResponse:
            ok = True
            status_code = 201
            content = b'{"status": "PENDING"}'

            def json(self) -> dict[str, Any]:
                return {"status": "PENDING"}

        def fake_post(url: str, **kwargs: Any) -> FakeResponse:
            sent.append({"url": url, **kwargs})
            return FakeResponse()

        import requests

        original_post = requests.post
        requests.post = fake_post
        token = set_current_tenant_slug("grupo-escolar")
        try:
            ensure_access_control_schema()
            save_app_settings(
                {
                    "access_control_whatsapp_notifications": {
                        "enabled": True,
                        "provider": "evolution",
                        "base_url": "http://localhost:8080",
                        "api_key": "global-key",
                        "instance": "global",
                    },
                    "access_control_whatsapp_notifications_by_site": {
                        "ESCOLA A": {
                            "enabled": True,
                            "provider": "evolution",
                            "base_url": "http://localhost:8080",
                            "api_key": "key-a",
                            "instance": "escola-a",
                        },
                        "ESCOLA B": {
                            "enabled": True,
                            "provider": "evolution",
                            "base_url": "http://localhost:8080",
                            "api_key": "key-b",
                            "instance": "escola-b",
                        },
                    },
                }
            )
            person_a = save_person(
                {
                    "full_name": "Aluno Escola A",
                    "site": "ESCOLA A",
                    "guardian_phone": "+55 (82) 98136-6801",
                    "whatsapp_enabled": True,
                }
            )
            person_b = save_person(
                {
                    "full_name": "Aluno Escola B",
                    "site": "ESCOLA B",
                    "guardian_phone": "+55 (82) 98136-6802",
                    "whatsapp_enabled": True,
                }
            )

            record_event(
                {
                    "site": "ESCOLA A",
                    "person_id": person_a["id"],
                    "person_name_raw": person_a["full_name"],
                    "event_type": "entrada",
                    "raw_event_id": "site-a-1",
                    "occurred_at": "2026-08-20 07:00:00",
                }
            )
            record_event(
                {
                    "site": "ESCOLA B",
                    "person_id": person_b["id"],
                    "person_name_raw": person_b["full_name"],
                    "event_type": "entrada",
                    "raw_event_id": "site-b-1",
                    "occurred_at": "2026-08-20 07:01:00",
                }
            )

            assert len(sent) == 2, sent
            assert sent[0]["url"] == "http://localhost:8080/message/sendText/escola-a", sent
            assert sent[0]["headers"]["apikey"] == "key-a", sent
            assert sent[0]["json"]["number"] == "5582981366801", sent
            assert sent[1]["url"] == "http://localhost:8080/message/sendText/escola-b", sent
            assert sent[1]["headers"]["apikey"] == "key-b", sent
            assert sent[1]["json"]["number"] == "5582981366802", sent
        finally:
            requests.post = original_post
            reset_current_tenant_slug(token)


if __name__ == "__main__":
    main()
    test_evolution_provider_payload()
    test_evolution_provider_uses_site_specific_instance()
