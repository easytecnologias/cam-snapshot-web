"""Confere que list_access_whatsapp_channels() -- a funcao que alimenta o
card do Dashboard e o Zabbix -- reflete o estado real de canais Evolution
(nao usa mais o campo display_phone_number, que so existe na Cloud API), e
que um canal padrao do cliente configurado em Evolution tambem aparece na
lista (hoje o gate de entrada so reconhece campos da Meta).

Testa ambas direcoes: "connecting" → offline, "open" → conectado.

Roda direto: python scripts/sightops_whatsapp_evolution_channels_test.py
"""
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
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-whatsapp-evolution-channels.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-whatsapp-evolution-channels-test-key"
        os.environ["SIGHTOPS_EVOLUTION_URL"] = "http://evolution.teste:8090"
        os.environ["SIGHTOPS_EVOLUTION_API_KEY"] = "chave-teste"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_notifications import list_access_whatsapp_channels, save_access_whatsapp_config

        class FakeResponse:
            def __init__(self, status_code: int, body: dict[str, Any]):
                self.status_code = status_code
                self._body = body
                self.content = b"1" if body else b""
                self.text = str(body)

            def json(self) -> dict[str, Any]:
                return self._body

        # Estado que sera retornado pelo fake_get para connectionState
        test_state: dict[str, str] = {"state": "connecting"}

        def fake_get(url: str, **kwargs: Any) -> FakeResponse:
            if "connectionState" in url:
                return FakeResponse(200, {"instance": {"state": test_state["state"]}})
            return FakeResponse(200, {"base64": ""})

        import requests

        original_get = requests.get
        requests.get = fake_get
        token = set_current_tenant_slug("escola-canais")
        try:
            # canal padrao do cliente (sem site) configurado em Evolution
            save_access_whatsapp_config({"site": "", "enabled": True, "provider": "evolution"})

            # Cenario 1: sessao presa em "connecting" -- exatamente o estado real
            # da instancia orfa "presidente-dutra" achada em producao
            test_state["state"] = "connecting"
            canais = list_access_whatsapp_channels()
            assert len(canais) == 1, canais
            canal = canais[0]
            assert canal["provider"] == "evolution", canal
            assert canal["configured"] is True, canal
            # sessao presa em "connecting": tem que aparecer como offline no
            # Dashboard, nunca como conectada
            assert canal["connected"] is False, f"connecting should be offline: {canal}"

            # Cenario 2: sessao genuinamente conectada com state "open"
            test_state["state"] = "open"
            canais = list_access_whatsapp_channels()
            assert len(canais) == 1, canais
            canal = canais[0]
            assert canal["provider"] == "evolution", canal
            assert canal["configured"] is True, canal
            # sessao em "open" (genuinamente conectada): tem que aparecer como
            # conectada no Dashboard (este era o bug: Evolution canais mostravam
            # sempre offline mesmo quando conectados)
            assert canal["connected"] is True, f"open should be connected: {canal}"
        finally:
            requests.get = original_get
            reset_current_tenant_slug(token)

    print("whatsapp evolution channels regression ok")


if __name__ == "__main__":
    main()
