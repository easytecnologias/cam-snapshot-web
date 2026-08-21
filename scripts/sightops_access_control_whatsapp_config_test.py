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
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-access-control-whatsapp-config.db")

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_notifications import (
            disconnect_access_whatsapp,
            get_access_whatsapp_connection,
            get_access_whatsapp_config,
            save_access_whatsapp_config,
            test_access_whatsapp,
        )

        sent: list[dict[str, Any]] = []
        fetched: list[dict[str, Any]] = []
        deleted: list[dict[str, Any]] = []

        class FakeResponse:
            ok = True
            status_code = 201
            content = b'{"status": "PENDING"}'

            def json(self) -> dict[str, Any]:
                return {"status": "PENDING"}

        def fake_post(url: str, **kwargs: Any) -> FakeResponse:
            sent.append({"url": url, **kwargs})
            return FakeResponse()

        def fake_get(url: str, **kwargs: Any) -> FakeResponse:
            fetched.append({"url": url, **kwargs})

            class GetResponse(FakeResponse):
                content = b'{"instance": {"state": "connecting"}, "base64": "data:image/png;base64,abc123"}'

                def json(self) -> dict[str, Any]:
                    if url.endswith("/instance/connectionState/sightops"):
                        return {"instance": {"state": "connecting"}}
                    return {"base64": "data:image/png;base64,abc123"}

            return GetResponse()

        def fake_delete(url: str, **kwargs: Any) -> FakeResponse:
            deleted.append({"url": url, **kwargs})
            return FakeResponse()

        import requests

        original_post = requests.post
        original_get = requests.get
        original_delete = requests.delete
        requests.post = fake_post
        requests.get = fake_get
        requests.delete = fake_delete
        token = set_current_tenant_slug("escola-whatsapp")
        try:
            initial = get_access_whatsapp_config()
            assert initial["enabled"] is False, initial
            assert initial["configured"] is False, initial
            assert "api_key" not in initial, initial

            saved = save_access_whatsapp_config(
                {
                    "enabled": True,
                    "provider": "evolution",
                    "base_url": "http://localhost:8080/",
                    "api_key": "secret-key",
                    "instance": "sightops",
                }
            )
            assert saved["enabled"] is True, saved
            assert saved["configured"] is True, saved
            assert saved["base_url"] == "http://localhost:8080", saved
            assert saved["instance"] == "sightops", saved
            assert "api_key" not in saved, saved

            saved_without_key = save_access_whatsapp_config(
                {
                    "enabled": True,
                    "provider": "evolution",
                    "base_url": "http://localhost:8080",
                    "api_key": "",
                    "instance": "sightops",
                }
            )
            assert saved_without_key["configured"] is True, saved_without_key

            saved_site_a = save_access_whatsapp_config(
                {
                    "site": "ESCOLA A",
                    "enabled": True,
                    "provider": "evolution",
                    "base_url": "http://localhost:8080",
                    "api_key": "",
                    "instance": "escola-a",
                }
            )
            saved_site_b = save_access_whatsapp_config(
                {
                    "site": "ESCOLA B",
                    "enabled": True,
                    "provider": "evolution",
                    "base_url": "http://localhost:8080",
                    "api_key": "site-b-key",
                    "instance": "escola-b",
                }
            )
            loaded_site_a = get_access_whatsapp_config("ESCOLA A")
            loaded_site_b = get_access_whatsapp_config("ESCOLA B")
            assert saved_site_a["site"] == "ESCOLA A", saved_site_a
            assert saved_site_a["site_configured"] is True, saved_site_a
            assert saved_site_a["instance"] == "escola-a", saved_site_a
            assert saved_site_a["configured"] is True, saved_site_a
            assert "api_key" not in saved_site_a, saved_site_a
            assert saved_site_b["instance"] == "escola-b", saved_site_b
            assert loaded_site_a["instance"] == "escola-a", loaded_site_a
            assert loaded_site_b["instance"] == "escola-b", loaded_site_b

            result = test_access_whatsapp({"number": "+55 (82) 98136-6839"})
            assert result["ok"] is True, result
            assert sent[0]["url"] == "http://localhost:8080/message/sendText/sightops"
            assert sent[0]["headers"]["apikey"] == "secret-key"
            assert sent[0]["json"]["number"] == "5582981366839", sent
            assert "Teste SightOps" in sent[0]["json"]["text"], sent

            connection = get_access_whatsapp_connection(refresh_qr=True)
            assert connection["ok"] is True, connection
            assert connection["state"] == "waiting_qr", connection
            assert connection["connected"] is False, connection
            assert connection["qrcode"] == "data:image/png;base64,abc123", connection
            assert fetched[0]["url"] == "http://localhost:8080/instance/connectionState/sightops", fetched
            assert fetched[0]["headers"]["apikey"] == "secret-key", fetched
            assert fetched[1]["url"] == "http://localhost:8080/instance/connect/sightops", fetched
            assert "api_key" not in connection, connection

            disconnected = disconnect_access_whatsapp()
            assert disconnected["ok"] is True, disconnected
            assert disconnected["connected"] is False, disconnected
            assert disconnected["state"] == "disconnected", disconnected
            assert deleted[0]["url"] == "http://localhost:8080/instance/logout/sightops", deleted
            assert deleted[0]["headers"]["apikey"] == "secret-key", deleted
            assert "api_key" not in disconnected, disconnected
        finally:
            requests.post = original_post
            requests.get = original_get
            requests.delete = original_delete
            reset_current_tenant_slug(token)

    print("access-control whatsapp config regression ok")


if __name__ == "__main__":
    main()
