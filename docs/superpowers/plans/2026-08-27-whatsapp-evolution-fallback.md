# WhatsApp - Evolution API como canal alternativo por site - Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restaurar o Evolution API como segundo provedor de WhatsApp do Controle de Acesso, escolhido por site, para servir de plano B manual quando a Cloud API oficial da Meta estiver indisponível (ex.: template em análise) — com verificação de saúde ativa (nunca confiar cegamente no que o Evolution reporta) e sem failover automático.

**Architecture:** O provider (`cloud_api` padrão, ou `evolution`) já existe como campo salvo na configuração de WhatsApp por site — só a função que o lê (`_whatsapp_provider`) está hardcoded para ignorá-lo. O trabalho é: (1) reativar essa leitura com um default seguro; (2) restaurar as funções de envio/conexão/desconexão do Evolution, adaptadas para usar credenciais **da plataforma** (variável de ambiente, um container Evolution compartilhado entre clientes) em vez de credenciais por site como na versão antiga; (3) tornar o pipeline de monitoramento (`list_access_whatsapp_channels`, que já alimenta o Dashboard e o Zabbix) consciente do provider, para que uma instância Evolution morta apareça como offline de verdade; (4) expor tudo isso na tela de Conexões do Controle de Acesso (seletor de provider, caixa de QR Code).

**Tech Stack:** FastAPI (backend), `requests` para chamar a REST API do Evolution (`evoapicloud/evolution-api:2.3.7`), SQLite/Postgres via `db_store` para configuração, JS vanilla + HTML no frontend, scripts standalone `scripts/sightops_*_test.py` para testes (sem pytest).

## Global Constraints

- **Default de provider é sempre `cloud_api`.** Nenhuma configuração existente ou nova pode virar `evolution` sem escolha explícita do usuário — é o requisito mais crítico do design (spec, seção "Modelo de configuração").
- **Credenciais do Evolution são da plataforma, não do site.** `base_url`/`api_key` vêm de `SIGHTOPS_EVOLUTION_URL`/`SIGHTOPS_EVOLUTION_API_KEY` (variáveis de ambiente), no mesmo padrão que `_default_zabbix_cfg` já usa para o Zabbix em `app/services/zabbix_monitoring_service.py:33-55`. Só a URL tem um valor padrão embutido no código (`http://10.10.12.7:8090`, endereço já confirmado alcançável a partir do container `sightops-prod-api`); a API key **nunca** tem default no código-fonte — sem ela, o provider fica `not_configured`.
- **Nome de instância único por tenant+site**, nunca uma string fixa — o container Evolution é compartilhado entre todos os clientes da SightOps, então um default tipo `"sightops"` colidiria entre eles. Formato: `{tenant_slug}-{slug(site) ou "padrao"}`.
- **Verificação de saúde é sempre ativa**, nunca otimista: só o estado `open`/`connected`/`online` retornado por `GET /instance/connectionState/{instance}` conta como conectado. Qualquer outro estado (`connecting`, `close`, desconhecido) conta como offline — é a correção direta do bug provado ao vivo na instância órfã "presidente-dutra" (spec, seção "Verificação de saúde").
- **Troca de provider é manual, sem failover automático** — não implementar nenhuma lógica de "tenta um, se falhar tenta o outro".
- **Confirmação de entrega mensagem-a-mensagem fica fora de escopo.** O envio (`POST /message/sendText/{instance}`) aceita HTTP 2xx como sucesso, igual ao código antigo — não construir webhook de ACK.
- **Não mexer na instância órfã "presidente-dutra"** nem tentar reaproveitá-la.
- Este repositório **não usa pytest** — testes são scripts standalone em `scripts/sightops_*_test.py`, rodados com `python scripts/nome_test.py`, seguindo o padrão de `scripts/sightops_access_control_notifications_test.py` (tempdir + sqlite + tenant context + `unittest`-free asserts) e `scripts/sightops_olt_routes_test.py` (FastAPI `TestClient`).
- Produção **não roda a partir do git** — deploy real é manual (extrair arquivo do container rodando, aplicar só o diff, rebuildar, trocar). Este plano cobre só o código do repositório; o deploy fica para quando o usuário pedir (ver "Notas de Deploy" ao final).

---

## Visão geral dos arquivos

| Arquivo | O que muda |
|---|---|
| `app/services/access_control_notifications.py` | Núcleo: provider routing, helpers do Evolution (config, envio, conexão, desconexão), `list_access_whatsapp_channels()` provider-aware |
| `app/api/endpoints/access_control.py` | `refresh_qr` como query param, endpoint novo `POST /whatsapp/disconnect`, default do campo `instance` no modelo Pydantic |
| `frontend/index.html` | Opção "Evolution API" no seletor de provider, caixa nova de QR Code/estado de sessão |
| `frontend/js/accessControl.js` | Alterna a UI conforme o provider, preenche/mostra a caixa do QR Code, botão de desconectar |
| `frontend/styles.css` | Estilos da caixa de QR Code (reaproveitando `.access-whatsapp-cloud` como base) |
| `scripts/sightops_whatsapp_evolution_provider_test.py` (novo) | Testa Task 1 |
| `scripts/sightops_whatsapp_evolution_service_test.py` (novo) | Testa Task 2 |
| `scripts/sightops_whatsapp_evolution_channels_test.py` (novo) | Testa Task 3 |
| `scripts/sightops_whatsapp_evolution_routes_test.py` (novo) | Testa Task 4 |

---

### Task 1: Provider routing volta a ler a configuração, com default seguro

**Files:**
- Modify: `app/services/access_control_notifications.py:1-16` (imports), `:132-135` (`_whatsapp_provider`)
- Test: `scripts/sightops_whatsapp_evolution_provider_test.py` (create)

**Interfaces:**
- Consumes: nada de tasks anteriores (task fundacional).
- Produces:
  - `_whatsapp_provider(cfg: Dict[str, Any]) -> str` — lê `cfg.get("provider")`, normaliza (`strip().lower()`), retorna `"evolution"` só se for exatamente isso, senão `"cloud_api"`.
  - `_slug(text: Any) -> str` — slugifica texto livre (usado nos nomes de instância).
  - `_evolution_platform_cfg() -> Dict[str, str]` — `{"base_url": ..., "api_key": ...}` vindos de env vars.
  - `_evolution_default_instance(site_key: Any = "") -> str` — nome de instância único por tenant+site.
  - Todas usadas pelas Tasks 2-4.

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/sightops_whatsapp_evolution_provider_test.py`:

```python
"""Confere que o provider volta a ser lido da configuracao salva, com
cloud_api como default seguro (nunca evolution sem escolha explicita), e
que o nome de instancia do Evolution e unico por tenant+site (nao uma
string fixa, que colidiria no container compartilhado entre clientes).

Roda direto: python scripts/sightops_whatsapp_evolution_provider_test.py
"""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DATA_DIR"] = tmp
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-whatsapp-provider.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-whatsapp-provider-test-key"
        os.environ["SIGHTOPS_EVOLUTION_URL"] = "http://evolution.teste:8090"
        os.environ["SIGHTOPS_EVOLUTION_API_KEY"] = "chave-teste"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_notifications import (
            _whatsapp_provider,
            _evolution_platform_cfg,
            _evolution_default_instance,
        )

        assert _whatsapp_provider({}) == "cloud_api", "config vazia tem que cair em cloud_api"
        assert _whatsapp_provider({"provider": "cloud_api"}) == "cloud_api"
        assert _whatsapp_provider({"provider": "EVOLUTION"}) == "evolution", "provider deve ser normalizado (case-insensitive)"
        assert _whatsapp_provider({"provider": "algo-invalido"}) == "cloud_api", "provider desconhecido tem que cair em cloud_api, nunca evolution"

        plataforma = _evolution_platform_cfg()
        assert plataforma["base_url"] == "http://evolution.teste:8090", plataforma
        assert plataforma["api_key"] == "chave-teste", plataforma

        token = set_current_tenant_slug("escola-testes")
        try:
            assert _evolution_default_instance("") == "escola-testes-padrao"
            assert _evolution_default_instance("Unidade Centro") == "escola-testes-unidade-centro"
        finally:
            reset_current_tenant_slug(token)

    print("whatsapp evolution provider regression ok")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python scripts/sightops_whatsapp_evolution_provider_test.py`
Expected: `ImportError` — `_evolution_platform_cfg`/`_evolution_default_instance` ainda não existem.

- [ ] **Step 3: Implementar**

Em `app/services/access_control_notifications.py`, adicionar `import os` junto aos imports do topo (linha 7, junto de `import re`):

```python
import hashlib
import hmac
import html
import logging
import os
import re
from typing import Any, Dict, List
```

Substituir o corpo de `_whatsapp_provider` (linhas 132-135):

```python
def _whatsapp_provider(cfg: Dict[str, Any]) -> str:
    """Provider ativo do site: 'evolution' so quando escolhido explicitamente.

    Qualquer outra coisa (vazio, desconhecido, configuracao antiga sem o
    campo) cai em 'cloud_api' -- o canal oficial nunca muda de comportamento
    sem o usuario decidir isso na tela.
    """
    provider = _text(cfg.get("provider"), 40).lower()
    return "evolution" if provider == "evolution" else "cloud_api"


def _slug(text: Any) -> str:
    s = "".join(ch.lower() if ch.isalnum() else "-" for ch in str(text or "").strip())
    while "--" in s:
        s = s.replace("--", "-")
    return s.strip("-")


def _evolution_platform_cfg() -> Dict[str, str]:
    """Endereco e chave do Evolution: infraestrutura da SightOps, um container
    so para todos os clientes -- por isso vem de variavel de ambiente, no
    mesmo padrao ja usado para o Zabbix (_default_zabbix_cfg em
    zabbix_monitoring_service.py), nunca de configuracao por site.

    So a URL tem valor padrao no codigo (endereco ja confirmado alcancavel a
    partir deste container); a chave nunca tem default aqui -- sem ela, o
    provider fica not_configured em vez de tentar falar com um Evolution
    sem autenticacao.
    """
    return {
        "base_url": _text(os.getenv("SIGHTOPS_EVOLUTION_URL") or "http://10.10.12.7:8090", 500).rstrip("/"),
        "api_key": _text(os.getenv("SIGHTOPS_EVOLUTION_API_KEY"), 300),
    }


def _evolution_default_instance(site_key: Any = "") -> str:
    """Nome de instancia unico por tenant+site.

    O container Evolution e compartilhado entre todos os clientes da
    SightOps: um default fixo tipo "sightops" colidiria entre escolas de
    tenants diferentes (ou entre sites do mesmo tenant). O nome derivado do
    tenant+site evita isso sem exigir que o usuario digite nada.
    """
    tenant = _slug(get_current_tenant_slug()) or "sightops"
    parte = _slug(site_key) or "padrao"
    return f"{tenant}-{parte}"[:120]
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python scripts/sightops_whatsapp_evolution_provider_test.py`
Expected: `whatsapp evolution provider regression ok`

- [ ] **Step 5: Rodar o teste existente para confirmar que nao quebrou nada**

Run: `python scripts/sightops_access_control_notifications_test.py`
Expected: `access-control notifications regression ok` (o teste ja salva `"provider": "cloud_api"` explicitamente, então continua batendo com o novo default).

- [ ] **Step 6: Commit**

```bash
git add app/services/access_control_notifications.py scripts/sightops_whatsapp_evolution_provider_test.py
git commit -m "feat(whatsapp): provider volta a ser lido da config, com cloud_api como default seguro"
```

---

### Task 2: Restaurar envio, conexão e desconexão via Evolution

**Files:**
- Modify: `app/services/access_control_notifications.py` — funções `_send_whatsapp`, `get_access_whatsapp_connection`, `get_access_whatsapp_config`, `save_access_whatsapp_config`, `send_access_whatsapp_text`; funções novas `_evolution_instance_cfg`, `_evolution_headers`, `_evolution_state_label`, `_evolution_qrcode_base64`, `_send_whatsapp_evolution`, `_evolution_connection_status`, `_cloud_connection_status`, `disconnect_access_whatsapp`
- Test: `scripts/sightops_whatsapp_evolution_service_test.py` (create)

**Interfaces:**
- Consumes: `_whatsapp_provider`, `_evolution_platform_cfg`, `_evolution_default_instance`, `_slug` (Task 1).
- Produces:
  - `_evolution_instance_cfg(cfg: Dict[str, Any], site_key: Any) -> Dict[str, str]` — `{"base_url", "api_key", "instance"}` prontos para chamar o Evolution.
  - `_send_whatsapp_evolution(cfg, event, message, *, site_key="") -> str` — retorna `"whatsapp_sent"` / `"whatsapp_failed"` / `"whatsapp_skipped"`.
  - `get_access_whatsapp_connection(*, refresh_qr=False, site="", resumo=False) -> Dict[str, Any]` — agora provider-aware; para evolution inclui `"state"`, `"connected"`, `"qrcode"`, `"instance"`.
  - `disconnect_access_whatsapp(site: Any = "") -> Dict[str, Any]` — usado pela Task 4.
  - Usadas pela Task 3: `get_access_whatsapp_connection` (já usada hoje por `list_access_whatsapp_channels`, mas agora devolve dados reais de evolution).

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/sightops_whatsapp_evolution_service_test.py`:

```python
"""Confere o ciclo completo do provider Evolution na camada de servico:
envio de notificacao, checagem de conexao (com a interpretacao estrita que
corrige o bug provado ao vivo -- so "open" conta como conectado) e
desconexao. Usa um FakeResponse para simular o Evolution API sem rede.

Roda direto: python scripts/sightops_whatsapp_evolution_service_test.py
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
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-whatsapp-evolution-service.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-whatsapp-evolution-service-test-key"
        os.environ["SIGHTOPS_EVOLUTION_URL"] = "http://evolution.teste:8090"
        os.environ["SIGHTOPS_EVOLUTION_API_KEY"] = "chave-teste"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services import db_store
        from app.services.access_control_notifications import (
            get_access_whatsapp_config,
            get_access_whatsapp_connection,
            disconnect_access_whatsapp,
            notify_access_event,
            save_access_whatsapp_config,
            send_access_whatsapp_text,
        )

        chamadas: list[dict[str, Any]] = []

        class FakeResponse:
            def __init__(self, status_code: int, body: dict[str, Any]):
                self.status_code = status_code
                self._body = body
                self.content = b"1" if body else b""
                self.text = str(body)

            def json(self) -> dict[str, Any]:
                return self._body

        respostas_get: list[FakeResponse] = []
        respostas_delete: list[FakeResponse] = []

        def fake_get(url: str, **kwargs: Any) -> FakeResponse:
            chamadas.append({"metodo": "GET", "url": url, **kwargs})
            return respostas_get.pop(0)

        def fake_post(url: str, **kwargs: Any) -> FakeResponse:
            chamadas.append({"metodo": "POST", "url": url, **kwargs})
            return FakeResponse(201, {"key": {"id": "3EB0"}})

        def fake_delete(url: str, **kwargs: Any) -> FakeResponse:
            chamadas.append({"metodo": "DELETE", "url": url, **kwargs})
            return respostas_delete.pop(0)

        import requests

        original_get, original_post, original_delete = requests.get, requests.post, requests.delete
        requests.get = fake_get
        requests.post = fake_post
        requests.delete = fake_delete
        token = set_current_tenant_slug("escola-evolution")
        try:
            db_store.ensure_schema() if hasattr(db_store, "ensure_schema") else None
            save_access_whatsapp_config({
                "site": "Unidade Centro",
                "enabled": True,
                "provider": "evolution",
            })

            config = get_access_whatsapp_config("Unidade Centro")
            assert config["provider"] == "evolution", config
            assert config["configured"] is True, config
            assert config["instance"] == "escola-evolution-unidade-centro", config
            assert config["base_url"] == "http://evolution.teste:8090", config

            # --- envio de evento passa a usar o Evolution, nao a Meta ---
            chamadas.clear()
            status = notify_access_event({
                "site": "Unidade Centro",
                "device_id": "",
                "person_id": "",
                "person_name_raw": "Aluno Evolution",
                "guardian_phone": "(82) 98888-1111",
                "event_type": "entrada",
                "occurred_at": "2026-08-27 08:00:00",
            })
            envio = next(c for c in chamadas if c["metodo"] == "POST" and "sendText" in c["url"])
            assert envio["url"].endswith("/message/sendText/escola-evolution-unidade-centro"), envio
            assert envio["headers"]["apikey"] == "chave-teste", envio
            assert envio["json"]["number"] == "5582988881111", envio
            assert "whatsapp_sent" in status["statuses"], status

            # --- resposta direta (send_access_whatsapp_text) tambem usa Evolution ---
            chamadas.clear()
            resposta = send_access_whatsapp_text("5582988881111", "ola", site="Unidade Centro")
            assert resposta["ok"] is True, resposta
            assert any("sendText" in c["url"] for c in chamadas), chamadas

            # --- checagem de conexao: sessao presa em "connecting" NAO pode contar como conectada ---
            respostas_get.clear()
            respostas_get.append(FakeResponse(200, {"instance": {"state": "connecting"}}))
            respostas_get.append(FakeResponse(200, {"base64": "data-fake-qr"}))
            estado = get_access_whatsapp_connection(site="Unidade Centro")
            assert estado["configured"] is True, estado
            assert estado["connected"] is False, estado
            assert estado["state"] == "waiting_qr", estado
            assert estado["qrcode"] == "data-fake-qr", estado

            # --- sessao realmente aberta conta como conectada ---
            respostas_get.clear()
            respostas_get.append(FakeResponse(200, {"instance": {"state": "open"}}))
            estado = get_access_whatsapp_connection(site="Unidade Centro")
            assert estado["connected"] is True, estado
            assert estado["state"] == "connected", estado

            # --- desconectar ---
            respostas_delete.clear()
            respostas_delete.append(FakeResponse(200, {}))
            resultado = disconnect_access_whatsapp("Unidade Centro")
            assert resultado["ok"] is True, resultado
            assert resultado["state"] == "disconnected", resultado

            # --- site sem configuracao de provider continua em cloud_api, sem regressao ---
            padrao = get_access_whatsapp_config("Outro Site")
            assert padrao["provider"] == "cloud_api", padrao
        finally:
            requests.get, requests.post, requests.delete = original_get, original_post, original_delete
            reset_current_tenant_slug(token)

    print("whatsapp evolution service regression ok")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python scripts/sightops_whatsapp_evolution_service_test.py`
Expected: falha — `get_access_whatsapp_config("Unidade Centro")["configured"]` ainda é `False` porque `base_url` está hardcoded em `""` (linha atual 525), e `disconnect_access_whatsapp` nem existe.

- [ ] **Step 3: Implementar**

**3a.** Em `app/services/access_control_notifications.py`, logo depois de `_send_whatsapp_cloud` (depois da linha 305, antes de `def send_access_whatsapp_text`), adicionar o bloco de helpers do Evolution:

```python
def _evolution_instance_cfg(cfg: Dict[str, Any], site_key: Any = "") -> Dict[str, str]:
    """Credenciais + instancia prontas para chamar o Evolution deste site.

    base_url/api_key sao sempre da plataforma (_evolution_platform_cfg),
    nunca do que foi salvo por site -- mesmo que a configuracao antiga do
    site tenha algo gravado ali. So o nome de instancia vem do que foi
    salvo (ou do default unico por tenant+site, se nada foi salvo).
    """
    plataforma = _evolution_platform_cfg()
    instance = _text(cfg.get("instance") or cfg.get("instance_name"), 120) or _evolution_default_instance(site_key)
    return {"base_url": plataforma["base_url"], "api_key": plataforma["api_key"], "instance": instance}


def _evolution_headers(conn: Dict[str, str]) -> Dict[str, str]:
    return {"apikey": conn["api_key"], "Content-Type": "application/json"}


def _evolution_state_label(data: Dict[str, Any]) -> str:
    """Traduz o estado bruto do Evolution para um vocabulario fixo.

    So 'open'/'connected'/'online' vira 'connected'. Qualquer outra coisa
    -- inclusive vazio -- fica como offline/desconhecido: a instancia
    orfa "presidente-dutra" ficou dias em 'connecting' com a sessao morta,
    e uma leitura otimista teria mostrado ela como conectada.
    """
    raw = (
        data.get("state") or data.get("status")
        or (data.get("instance") or {}).get("state")
        or (data.get("instance") or {}).get("status") or ""
    )
    state = _text(raw, 40).lower()
    if state in {"open", "connected", "online"}:
        return "connected"
    if state in {"connecting", "qrcode", "qr", "pairing"}:
        return "waiting_qr"
    if state in {"close", "closed", "disconnected", "offline"}:
        return "disconnected"
    return state or "unknown"


def _evolution_qrcode_base64(data: Dict[str, Any]) -> str:
    raw = data.get("base64") or (data.get("qrcode") or {}).get("base64") or ""
    return _text(raw, 200000)


def _send_whatsapp_evolution(cfg: Dict[str, Any], event: Dict[str, Any], message: str, *, site_key: Any = "") -> str:
    """Envia pelo Evolution (WhatsApp Web nao oficial, biblioteca Baileys).

    Aceita 2xx como sucesso, igual a versao anterior a remocao -- confirmar
    entrega mensagem-a-mensagem fica fora de escopo (spec, secao "Fora de
    escopo"); o que corrige o bug historico e a checagem de saude ativa em
    get_access_whatsapp_connection(), nao o envio em si.
    """
    conn = _evolution_instance_cfg(cfg, site_key)
    if not conn["base_url"] or not conn["api_key"] or not conn["instance"]:
        return "whatsapp_skipped"
    numero = _numero_whatsapp(event.get("guardian_phone"))
    if not numero:
        return "whatsapp_skipped"
    if event.get("whatsapp_enabled") is False:
        return "whatsapp_skipped"
    response = requests.post(
        f"{conn['base_url']}/message/sendText/{conn['instance']}",
        headers=_evolution_headers(conn),
        json={"number": numero, "text": message, "linkPreview": False},
        timeout=20,
    )
    if 200 <= int(response.status_code or 0) < 300:
        return "whatsapp_sent"
    logger.warning(
        "Evolution recusou a mensagem (HTTP %s): %s",
        response.status_code,
        getattr(response, "text", "")[:200],
    )
    return "whatsapp_failed"


def _evolution_connection_status(cfg: Dict[str, Any], site_key: Any, *, refresh_qr: bool = False) -> Dict[str, Any]:
    conn = _evolution_instance_cfg(cfg, site_key)
    if not conn["base_url"] or not conn["api_key"]:
        return {
            "ok": False, "configured": False, "state": "not_configured", "connected": False,
            "qrcode": "", "external_connection": False, "site": _site_key(site_key),
            "error": "Evolution API nao configurado nesta plataforma (SIGHTOPS_EVOLUTION_URL/SIGHTOPS_EVOLUTION_API_KEY).",
        }
    headers = _evolution_headers(conn)
    resultado: Dict[str, Any] = {
        "ok": True, "configured": True, "connected": False, "state": "unknown",
        "qrcode": "", "external_connection": False, "site": _site_key(site_key), "instance": conn["instance"],
    }
    try:
        state_response = requests.get(f"{conn['base_url']}/instance/connectionState/{conn['instance']}", headers=headers, timeout=15)
    except Exception as exc:
        return {**resultado, "ok": False, "state": "error", "error": str(exc)}

    if state_response.status_code == 404:
        try:
            create_response = requests.post(
                f"{conn['base_url']}/instance/create", headers=headers,
                json={"instanceName": conn["instance"], "integration": "WHATSAPP-BAILEYS", "qrcode": True},
                timeout=25,
            )
        except Exception as exc:
            return {**resultado, "ok": False, "state": "error", "error": str(exc)}
        create_data = _resposta_json(create_response)
        estado = _evolution_state_label(create_data)
        resultado.update({"state": estado, "connected": estado == "connected", "qrcode": _evolution_qrcode_base64(create_data)})
        return resultado

    state_data = _resposta_json(state_response)
    estado = _evolution_state_label(state_data)
    # so estado genuinamente "open" conta como conectado -- ver docstring de
    # _evolution_state_label. Isso e a verificacao de saude ativa do design.
    resultado.update({"state": estado, "connected": estado == "connected"})

    if refresh_qr or not resultado["connected"]:
        try:
            qr_response = requests.get(f"{conn['base_url']}/instance/connect/{conn['instance']}", headers=headers, timeout=25)
            qr_data = _resposta_json(qr_response)
            qrcode = _evolution_qrcode_base64(qr_data)
            if qrcode:
                resultado["qrcode"] = qrcode
                if resultado["state"] in {"unknown", "disconnected", "error"}:
                    resultado["state"] = "waiting_qr"
        except Exception as exc:
            resultado["qr_error"] = str(exc)
    return resultado


def disconnect_access_whatsapp(site: Any = "") -> Dict[str, Any]:
    settings = db_store.load_app_settings()
    cfg = _access_whatsapp_cfg(settings, site)
    site_key = _site_key(site)
    if _whatsapp_provider(cfg) != "evolution":
        return {"ok": False, "configured": False, "state": "not_configured", "connected": False, "qrcode": "", "error": "Este site nao usa o Evolution API."}
    conn = _evolution_instance_cfg(cfg, site_key)
    if not conn["base_url"] or not conn["api_key"]:
        return {"ok": False, "configured": False, "state": "not_configured", "connected": False, "qrcode": "", "error": "Evolution API nao configurado nesta plataforma."}
    headers = _evolution_headers(conn)
    try:
        response = requests.delete(f"{conn['base_url']}/instance/logout/{conn['instance']}", headers=headers, timeout=25)
    except Exception as exc:
        return {"ok": False, "configured": True, "state": "error", "connected": False, "qrcode": "", "error": str(exc)}
    if response.status_code == 404:
        return {"ok": True, "configured": True, "state": "disconnected", "connected": False, "qrcode": ""}
    if not (200 <= int(response.status_code or 0) < 300):
        detail = getattr(response, "text", "")[:300] or "Falha ao desconectar WhatsApp."
        return {"ok": False, "configured": True, "state": "error", "connected": False, "qrcode": "", "error": detail}
    return {"ok": True, "configured": True, "state": "disconnected", "connected": False, "qrcode": ""}
```

**3b.** Renomear o corpo atual de `get_access_whatsapp_connection` (linhas 372-461) para uma função privada `_cloud_connection_status`, e criar um `get_access_whatsapp_connection` novo que decide o provider primeiro. Substituir a assinatura da função (linha 372) e tudo até o fim do bloco (linha 461) por:

```python
def _cloud_connection_status(settings: Dict[str, Any], cfg: Dict[str, Any], site_efetivo: str, *, resumo: bool = False) -> Dict[str, Any]:
    """Estado do canal oficial.

    Nao existe QR nem sessao para cair: a autenticacao e um token permanente.
    O que interessa saber e se as credenciais estao no lugar e se o template
    escolhido ja foi aprovado pela Meta.
    """
    dados = _cloud_cfg(cfg)

    # Sem site escolhido, o indicador do topo perguntaria pela configuracao
    # global e diria "nao configurado" mesmo com escolas enviando normalmente.
    # Entao, na falta dela, responde pela primeira escola configurada.
    # So o indicador do topo (resumo) responde por outra escola. No painel de
    # Conexoes, escolher "Padrao do cliente" tem que mostrar o padrao do cliente
    # -- e nao os dados de uma escola que o usuario nao selecionou.
    sites_ok: list[str] = []
    if not site_efetivo and resumo:
        for nome_site in _access_whatsapp_site_configs(settings):
            candidato = _cloud_cfg(_access_whatsapp_cfg(settings, nome_site))
            if candidato["phone_number_id"] and candidato["access_token"]:
                sites_ok.append(nome_site)
        if (not dados["phone_number_id"] or not dados["access_token"]) and sites_ok:
            site_efetivo = sites_ok[0]
            cfg = _access_whatsapp_cfg(settings, site_efetivo)
            dados = _cloud_cfg(cfg)

    if not dados["phone_number_id"] or not dados["access_token"]:
        return {
            "ok": False,
            "configured": False,
            "state": "not_configured",
            "connected": False,
            "qrcode": "",
            "external_connection": True,
            "error": "Informe Phone Number ID e token da API oficial.",
        }
    resultado = {
        "ok": True,
        "configured": True,
        "connected": True,
        "state": "connected",
        "qrcode": "",
        "external_connection": True,
        "phone_number_id": dados["phone_number_id"],
        "template_name": dados["template_name"] or "hello_world",
        "message": "Canal oficial da Meta: sem QR Code nem sessao para cair.",
        "site": site_efetivo,
        # quantas escolas tem canal proprio: com mais de uma, citar so a
        # primeira daria a impressao de que as outras estao fora
        "configured_sites": sites_ok,
    }
    # Dados do proprio numero: o Phone Number ID nao diz nada para quem olha a
    # tela, mas o numero formatado, o nome exibido e a qualidade dizem.
    try:
        resposta = requests.get(
            f"https://graph.facebook.com/{_GRAPH_VERSION}/{dados['phone_number_id']}",
            params={"fields": "display_phone_number,verified_name,quality_rating"},
            headers={"Authorization": f"Bearer {dados['access_token']}"},
            timeout=15,
        )
        numero = _resposta_json(resposta)
        if numero.get("display_phone_number"):
            resultado["display_phone_number"] = numero["display_phone_number"]
        if numero.get("verified_name"):
            resultado["verified_name"] = numero["verified_name"]
        if numero.get("quality_rating"):
            resultado["quality_rating"] = numero["quality_rating"]
    except Exception as exc:
        logger.warning("Nao foi possivel consultar o numero na Meta: %s", exc)

    nome = dados["template_name"]
    waba = _text(cfg.get("waba_id"), 60)
    if nome and waba:
        try:
            resposta = requests.get(
                f"https://graph.facebook.com/{_GRAPH_VERSION}/{waba}/message_templates",
                params={"name": nome, "fields": "name,status"},
                headers={"Authorization": f"Bearer {dados['access_token']}"},
                timeout=15,
            )
            for item in (_resposta_json(resposta).get("data") or []):
                if item.get("name") == nome:
                    resultado["template_status"] = item.get("status")
                    break
        except Exception as exc:
            logger.warning("Nao foi possivel consultar o template na Meta: %s", exc)
    return resultado


def get_access_whatsapp_connection(*, refresh_qr: bool = False, site: Any = "", resumo: bool = False) -> Dict[str, Any]:
    """Estado real da conexao do canal ativo do site: Meta ou Evolution."""
    settings = db_store.load_app_settings()
    cfg = _access_whatsapp_cfg(settings, site)
    site_efetivo = _site_key(site)
    if _whatsapp_provider(cfg) == "evolution":
        return _evolution_connection_status(cfg, site_efetivo, refresh_qr=refresh_qr)
    return _cloud_connection_status(settings, cfg, site_efetivo, resumo=resumo)
```

**3c.** Em `_send_whatsapp` (linhas 512-516), adicionar o branch de provider:

```python
def _send_whatsapp(settings: Dict[str, Any], event: Dict[str, Any], message: str) -> str:
    cfg = _access_whatsapp_cfg(settings, event.get("site"))
    if not cfg.get("enabled"):
        return "whatsapp_skipped"
    if _whatsapp_provider(cfg) == "evolution":
        return _send_whatsapp_evolution(cfg, event, message, site_key=_site_key(event.get("site")))
    return _send_whatsapp_cloud(cfg, event, message)
```

**3d.** Em `send_access_whatsapp_text` (linhas 308-324), tornar provider-aware — sem isso, um site trocado para Evolution continuaria mandando respostas diretas do bot de triagem pela Meta travada:

```python
def send_access_whatsapp_text(number: Any, message: str, *, site: Any = "") -> Dict[str, Any]:
    """Envia uma resposta direta pelo mesmo canal usado nas notificacoes."""
    target = _numero_whatsapp(number)
    text = _text(message, 4000)
    cfg = _access_whatsapp_cfg(db_store.load_app_settings(), site)
    if not target:
        return {"ok": False, "status": "whatsapp_skipped", "error": "Numero invalido."}
    if not text:
        return {"ok": False, "status": "whatsapp_skipped", "error": "Mensagem vazia."}
    if not cfg.get("enabled"):
        return {"ok": False, "status": "whatsapp_skipped", "error": "WhatsApp desativado."}
    evento = {"guardian_phone": target, "whatsapp_enabled": True, "site": _site_key(site)}
    try:
        if _whatsapp_provider(cfg) == "evolution":
            status = _send_whatsapp_evolution(cfg, evento, text, site_key=_site_key(site))
        else:
            status = _send_whatsapp_cloud(cfg, evento, text)
    except Exception as exc:
        logger.warning("Falha ao enviar resposta WhatsApp de acesso: %s", exc)
        return {"ok": False, "status": "whatsapp_failed", "error": str(exc)}
    return {"ok": status == "whatsapp_sent", "status": status}
```

**3e.** Em `get_access_whatsapp_config` (linhas 519-550), preencher `base_url`/`instance` de verdade no branch Evolution:

```python
def get_access_whatsapp_config(site: Any = "") -> Dict[str, Any]:
    settings = db_store.load_app_settings()
    site_key = _site_key(site)
    site_configs = _access_whatsapp_site_configs(settings)
    cfg = _access_whatsapp_cfg(settings, site_key)
    provider = _whatsapp_provider(cfg)
    if provider == "cloud_api":
        base_url = ""
        instance = ""
        dados = _cloud_cfg(cfg)
        configured = bool(dados["phone_number_id"] and dados["access_token"])
    else:
        conn = _evolution_instance_cfg(cfg, site_key)
        base_url = conn["base_url"]
        instance = conn["instance"]
        configured = bool(conn["base_url"] and conn["api_key"])
    resultado = {
        "site": site_key,
        "enabled": bool(cfg.get("enabled")),
        "configured": configured,
        "site_configured": bool(site_key and site_key in site_configs),
        "provider": provider,
        "base_url": base_url,
        "instance": instance,
    }
    if provider == "cloud_api":
        resultado.update({
            "phone_number_id": _text(cfg.get("phone_number_id"), 60),
            "waba_id": _text(cfg.get("waba_id"), 60),
            "template_name": _text(cfg.get("template_name"), 120),
            "template_language": _text(cfg.get("template_language") or "pt_BR", 12),
            # o token nunca volta para a tela; so se ele existe
            "token_saved": bool(_text(cfg.get("access_token"), 600)),
        })
    return resultado
```

**3f.** Em `save_access_whatsapp_config` (linhas 553-586), trocar o fallback morto `"evolution"` por `"cloud_api"` e calcular o `instance` com o default único por tenant+site:

```python
def save_access_whatsapp_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    settings = db_store.load_app_settings()
    site_key = _site_key(payload.get("site"))
    site_configs = _access_whatsapp_site_configs(settings)
    old_global = settings.get("access_control_whatsapp_notifications") or {}
    if not isinstance(old_global, dict):
        old_global = {}
    old = site_configs.get(site_key, {}) if site_key else old_global
    provider = _whatsapp_provider({"provider": payload.get("provider") or old.get("provider") or "cloud_api"})
    api_key = _text(payload.get("api_key"), 300) or _text(old.get("api_key"), 300) or _text(old_global.get("api_key"), 300)
    instance = (
        _text(payload.get("instance") or payload.get("instance_name") or old.get("instance"), 120)
        or _evolution_default_instance(site_key)
    )
    saved_cfg = {
        "enabled": bool(payload.get("enabled")),
        "provider": provider,
        # api_key por site nao e mais usado para falar com o Evolution (a
        # credencial real vem da plataforma, ver _evolution_platform_cfg) --
        # mantido so por compatibilidade com o que ja foi salvo antes.
        "api_key": api_key,
        "instance": instance,
    }
    if provider == "cloud_api":
        # Campos da API oficial. Token e longo (200+ chars) e nao cabe em api_key,
        # que os provedores nao oficiais usam para chave curta de instancia.
        saved_cfg.update({
            "phone_number_id": _text(payload.get("phone_number_id") or old.get("phone_number_id"), 60),
            "waba_id": _text(payload.get("waba_id") or old.get("waba_id"), 60),
            "access_token": _cifrar_token(payload.get("access_token"), old.get("access_token")),
            "template_name": _text(payload.get("template_name") or old.get("template_name"), 120),
            "template_language": _text(payload.get("template_language") or old.get("template_language") or "pt_BR", 12),
            "app_secret": _cifrar_token(payload.get("app_secret"), old.get("app_secret")),
        })
    if site_key:
        site_configs[site_key] = saved_cfg
        settings["access_control_whatsapp_notifications_by_site"] = site_configs
    else:
        settings["access_control_whatsapp_notifications"] = saved_cfg
    db_store.save_app_settings(settings)
    return get_access_whatsapp_config(site_key)
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python scripts/sightops_whatsapp_evolution_service_test.py`
Expected: `whatsapp evolution service regression ok`

- [ ] **Step 5: Rodar os testes existentes para confirmar que nao ha regressao**

Run: `python scripts/sightops_access_control_notifications_test.py`
Expected: `access-control notifications regression ok`

Run: `python scripts/sightops_whatsapp_evolution_provider_test.py`
Expected: `whatsapp evolution provider regression ok`

- [ ] **Step 6: Commit**

```bash
git add app/services/access_control_notifications.py scripts/sightops_whatsapp_evolution_service_test.py
git commit -m "feat(whatsapp): restaura envio, conexao e desconexao via Evolution API"
```

---

### Task 3: Monitoramento (Dashboard/Zabbix) fica provider-aware

**Files:**
- Modify: `app/services/access_control_notifications.py:464-509` (`list_access_whatsapp_channels`)
- Test: `scripts/sightops_whatsapp_evolution_channels_test.py` (create)

**Interfaces:**
- Consumes: `_whatsapp_provider`, `get_access_whatsapp_connection`, `_evolution_instance_cfg` (Tasks 1-2).
- Produces: `list_access_whatsapp_channels() -> List[Dict[str, Any]]` — cada item ganha um campo novo `"provider"`; `"connected"` agora reflete o estado real também para canais Evolution. Consumida hoje por `app/services/monitoring_service.py:166,276-285` (Dashboard + Zabbix) — **essa função não muda nesta task**, o contrato de `list_access_whatsapp_channels()` continua o mesmo (lista de dicts com `site`/`label`/`configured`/`connected`/...).

**Contexto do problema a corrigir:** hoje `_channel()` calcula `"connected": bool(result.get("display_phone_number"))` para qualquer canal — um campo que só existe na resposta da Cloud API. Para um canal Evolution, `display_phone_number` nunca vem preenchido, então o card do Dashboard mostraria **todo canal Evolution como offline mesmo quando está realmente conectado** — o oposto do bug histórico, mas ainda errado. Além disso, o canal "padrão do cliente" (sem site) só entra na lista hoje se tiver `phone_number_id`+`access_token` da Meta preenchidos — um cliente cujo canal padrão está em Evolution nunca apareceria no Dashboard nem no Zabbix.

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/sightops_whatsapp_evolution_channels_test.py`:

```python
"""Confere que list_access_whatsapp_channels() -- a funcao que alimenta o
card do Dashboard e o Zabbix -- reflete o estado real de canais Evolution
(nao usa mais o campo display_phone_number, que so existe na Cloud API), e
que um canal padrao do cliente configurado em Evolution tambem aparece na
lista (hoje o gate de entrada so reconhece campos da Meta).

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

        # todo GET de connectionState devolve "connecting" -- exatamente o
        # estado real da instancia orfa "presidente-dutra" achada em producao
        def fake_get(url: str, **kwargs: Any) -> FakeResponse:
            if "connectionState" in url:
                return FakeResponse(200, {"instance": {"state": "connecting"}})
            return FakeResponse(200, {"base64": ""})

        import requests

        original_get = requests.get
        requests.get = fake_get
        token = set_current_tenant_slug("escola-canais")
        try:
            # canal padrao do cliente (sem site) configurado em Evolution
            save_access_whatsapp_config({"site": "", "enabled": True, "provider": "evolution"})

            canais = list_access_whatsapp_channels()
            assert len(canais) == 1, canais
            canal = canais[0]
            assert canal["provider"] == "evolution", canal
            assert canal["configured"] is True, canal
            # sessao presa em "connecting": tem que aparecer como offline no
            # Dashboard, nunca como conectada (era exatamente o bug real)
            assert canal["connected"] is False, canal
        finally:
            requests.get = original_get
            reset_current_tenant_slug(token)

    print("whatsapp evolution channels regression ok")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python scripts/sightops_whatsapp_evolution_channels_test.py`
Expected: `assert len(canais) == 1` falha com lista vazia — o gate de entrada do canal padrão ainda só reconhece campos da Meta.

- [ ] **Step 3: Implementar**

Substituir `list_access_whatsapp_channels` (linhas 464-509) por:

```python
def list_access_whatsapp_channels() -> List[Dict[str, Any]]:
    """Canais WhatsApp configurados, com status real de conexao de cada um.

    Provider-aware: "connected" para cloud_api continua exigindo que a
    consulta na Graph API tenha devolvido display_phone_number (so acontece
    com token valido); para evolution, exige estado "connected" na checagem
    ativa feita por get_access_whatsapp_connection() -- nunca so a
    configuracao estar presente.

    Um canal por site com config propria, mais o "padrao do cliente" quando
    ele tiver credenciais proprias (Meta ou Evolution) nao amarradas a
    nenhum site especifico. Usado para alimentar o card do Dashboard e o
    Zabbix -- ver refresh_from_inventory() em monitoring_service.py.
    """
    settings = db_store.load_app_settings()
    channels: List[Dict[str, Any]] = []

    def _channel(site: str, label: str) -> Dict[str, Any]:
        cfg = _access_whatsapp_cfg(settings, site)
        provider = _whatsapp_provider(cfg)
        result = get_access_whatsapp_connection(site=site)
        connected = bool(result.get("connected")) if provider == "evolution" else bool(result.get("display_phone_number"))
        return {
            "site": site, "label": label, "provider": provider,
            "configured": bool(result.get("configured")),
            "connected": connected,
            "phone_number_id": result.get("phone_number_id", ""),
            "display_phone_number": result.get("display_phone_number", ""),
            "quality_rating": result.get("quality_rating", ""),
        }

    global_raw = settings.get("access_control_whatsapp_notifications") or {}
    global_cfg = global_raw if isinstance(global_raw, dict) else {}
    if _whatsapp_provider(global_cfg) == "evolution":
        global_conn = _evolution_instance_cfg(global_cfg, "")
        global_ready = bool(global_conn["base_url"] and global_conn["api_key"])
    else:
        global_dados = _cloud_cfg(global_cfg)
        global_ready = bool(global_dados["phone_number_id"] and global_dados["access_token"])
    if global_ready:
        # O rotulo precisa ser unico por cliente: e ele que vira o nome visivel
        # do host no Zabbix (zabbix_monitoring_service.py), que exige nome unico
        # globalmente. Com o mesmo texto fixo para todo tenant, o host.create()
        # do segundo cliente com canal padrao falhava e abortava o ciclo de
        # monitoramento para todos os tenants processados depois dele.
        tenant_slug = str(get_current_tenant_slug() or "").strip().lower()
        label = f"Padrao do cliente ({tenant_slug})" if tenant_slug else "Padrao do cliente"
        channels.append(_channel("", label))

    for site_name in _access_whatsapp_site_configs(settings):
        channels.append(_channel(site_name, site_name))

    return channels
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python scripts/sightops_whatsapp_evolution_channels_test.py`
Expected: `whatsapp evolution channels regression ok`

- [ ] **Step 5: Rodar os testes anteriores para confirmar que nao ha regressao**

Run: `python scripts/sightops_access_control_notifications_test.py`
Expected: `access-control notifications regression ok`

Run: `python scripts/sightops_whatsapp_evolution_service_test.py`
Expected: `whatsapp evolution service regression ok`

- [ ] **Step 6: Commit**

```bash
git add app/services/access_control_notifications.py scripts/sightops_whatsapp_evolution_channels_test.py
git commit -m "fix(whatsapp): monitoramento fica provider-aware para canais Evolution"
```

---

### Task 4: Endpoints REST — refresh_qr, desconectar, default de instance

**Files:**
- Modify: `app/api/endpoints/access_control.py:51-59` (imports), `:208-214` (`AccessWhatsappConfigRequest`), `:269-274` (`GET /whatsapp/connection`)
- Test: `scripts/sightops_whatsapp_evolution_routes_test.py` (create)

**Interfaces:**
- Consumes: `get_access_whatsapp_connection`, `disconnect_access_whatsapp` (Task 2).
- Produces: `POST /api/access-control/whatsapp/disconnect` — body `{"site": str}`, resposta igual ao formato de `disconnect_access_whatsapp`; `GET /api/access-control/whatsapp/connection?refresh_qr=1` passa a de fato pedir QR novo.

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/sightops_whatsapp_evolution_routes_test.py`:

```python
"""Exercita pela HTTP o ciclo do provider Evolution: salvar config, ler
conexao com refresh_qr, desconectar. Confere tambem que o campo instance
nao volta mais fixo em "sightops" quando o front nao manda nada (colidiria
entre clientes no container Evolution compartilhado).

Roda direto: python scripts/sightops_whatsapp_evolution_routes_test.py
"""
import os
import sys
import tempfile
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

tmp = Path(tempfile.mkdtemp(prefix="rotas-whatsapp-evolution-"))
os.environ["DATA_DIR"] = str(tmp / "data")
os.environ["SIGHTOPS_DB_PATH"] = str(tmp / "data" / "sightops.db")
os.environ["DATABASE_BACKEND"] = "sqlite"
os.environ["AUTH_DATABASE_BACKEND"] = "sqlite"
os.environ["SIGHTOPS_SECRET_KEY"] = "chave-de-teste-evolution"
os.environ["AUTH_ENABLED"] = "0"
os.environ["ENABLE_LEGACY_STATE_IMPORT"] = "0"
os.environ["SIGHTOPS_EVOLUTION_URL"] = "http://evolution.teste:8090"
os.environ["SIGHTOPS_EVOLUTION_API_KEY"] = "chave-teste"
os.environ.pop("DATABASE_URL", None)

from fastapi.testclient import TestClient
import app.main as m

falhas = []


def check(cond, msg):
    if not cond:
        falhas.append(msg)


class FakeResponse:
    def __init__(self, status_code: int, body: dict[str, Any]):
        self.status_code = status_code
        self._body = body
        self.content = b"1" if body else b""
        self.text = str(body)

    def json(self) -> dict[str, Any]:
        return self._body


def fake_get(url: str, **kwargs: Any) -> FakeResponse:
    if "connectionState" in url:
        return FakeResponse(200, {"instance": {"state": "open"}})
    return FakeResponse(200, {"base64": "qr-fake"})


def fake_delete(url: str, **kwargs: Any) -> FakeResponse:
    return FakeResponse(200, {})


import requests

requests.get = fake_get
requests.delete = fake_delete

with TestClient(m.app) as c:
    r = c.put("/api/access-control/whatsapp", json={"site": "", "enabled": True, "provider": "evolution"})
    check(r.status_code == 200, f"salvar config evolution falhou: {r.status_code} {r.text[:200]}")
    dados = r.json()
    check(dados["provider"] == "evolution", dados)
    check(dados["instance"] != "sightops", f"instance nao pode voltar ser a string fixa 'sightops': {dados}")
    check(dados["instance"].endswith("-padrao"), dados)

    r = c.get("/api/access-control/whatsapp/connection?refresh_qr=1")
    check(r.status_code == 200, f"conexao com refresh_qr falhou: {r.status_code} {r.text[:200]}")
    conexao = r.json()
    check(conexao["connected"] is True, conexao)
    check(conexao["qrcode"] == "qr-fake", conexao)

    r = c.post("/api/access-control/whatsapp/disconnect", json={"site": ""})
    check(r.status_code == 200, f"desconectar falhou: {r.status_code} {r.text[:200]}")
    check(r.json()["state"] == "disconnected", r.json())

if falhas:
    print("FALHAS:")
    for f in falhas:
        print(f" - {f}")
    sys.exit(1)

print("whatsapp evolution routes regression ok")
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python scripts/sightops_whatsapp_evolution_routes_test.py`
Expected: `POST /api/access-control/whatsapp/disconnect` devolve 404 (rota ainda não existe) e `dados["instance"]` vem `"sightops"` (default fixo do modelo Pydantic).

- [ ] **Step 3: Implementar**

**3a.** Em `app/api/endpoints/access_control.py`, adicionar `disconnect_access_whatsapp` ao import de `access_control_notifications` (linhas 51-59):

```python
from app.services.access_control_notifications import (
    assinatura_webhook_valida,
    disconnect_access_whatsapp,
    get_access_whatsapp_connection,
    resolver_cliente_por_numero,
    get_access_whatsapp_config,
    save_access_whatsapp_config,
    send_access_whatsapp_text,
    test_access_whatsapp,
)
```

**3b.** Trocar o default de `instance` em `AccessWhatsappConfigRequest` (linha 211) de `"sightops"` para `""`. Sem essa mudança, o Pydantic sempre preenche `"sightops"` quando o front não manda o campo (o que é o caso hoje), e o default único por tenant+site calculado em `save_access_whatsapp_config` (Task 2) nunca é alcançado:

```python
class AccessWhatsappConfigRequest(BaseModel):
    site: str = ""
    enabled: bool = False
    provider: str = "cloud_api"
    base_url: str = ""
    api_key: str = ""
    instance: str = ""
```

(O default de `provider` também muda de `"evolution"` para `"cloud_api"` — resquício da versão em que Evolution era o único provedor; hoje é só o valor usado quando o front não manda o campo, e o comportamento seguro é continuar em `cloud_api`.)

**3c.** Adicionar um request model e um endpoint de desconexão, logo depois de `AccessWhatsappTestRequest` (linha 217-219) e do endpoint `GET /whatsapp/connection` (linha 274) respectivamente:

```python
class AccessWhatsappDisconnectRequest(BaseModel):
    site: str = ""
```

```python
@router.post("/whatsapp/disconnect")
def api_access_control_whatsapp_disconnect(req: AccessWhatsappDisconnectRequest) -> Dict[str, Any]:
    result = disconnect_access_whatsapp(req.site)
    if not result.get("ok"):
        raise HTTPException(status_code=502, detail=result.get("error") or "Falha ao desconectar WhatsApp.")
    return result
```

**3d.** Trocar `refresh_qr` de fixo em `False` para parâmetro de query no `GET /whatsapp/connection` (linha 269-274):

```python
@router.get("/whatsapp/connection")
def api_access_control_whatsapp_connection(site: str = Query(""), summary: bool = Query(False), refresh_qr: bool = Query(False)) -> Dict[str, Any]:
    result = get_access_whatsapp_connection(refresh_qr=refresh_qr, site=site, resumo=summary)
    if not result.get("ok") and result.get("state") == "error":
        raise HTTPException(status_code=502, detail=result.get("error") or "Falha ao consultar WhatsApp.")
    return result
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python scripts/sightops_whatsapp_evolution_routes_test.py`
Expected: `whatsapp evolution routes regression ok`

- [ ] **Step 5: Rodar os testes anteriores para confirmar que nao ha regressao**

Run: `python scripts/sightops_access_control_notifications_test.py`
Run: `python scripts/sightops_whatsapp_evolution_provider_test.py`
Run: `python scripts/sightops_whatsapp_evolution_service_test.py`
Run: `python scripts/sightops_whatsapp_evolution_channels_test.py`
Run: `python scripts/sightops_olt_routes_test.py`
Expected: todos terminam com a linha `... regression ok`.

- [ ] **Step 6: Commit**

```bash
git add app/api/endpoints/access_control.py scripts/sightops_whatsapp_evolution_routes_test.py
git commit -m "feat(whatsapp): endpoint de desconexao e refresh_qr real na rota de conexao"
```

---

### Task 5: Frontend — seletor de provider, caixa de QR Code, desconectar

**Files:**
- Modify: `frontend/index.html:2064-2067` (seletor de provider), `:2110-2132` (painel "Conexão WhatsApp"), `:6033` (versão do script), `:10` (versão do CSS)
- Modify: `frontend/js/accessControl.js:1268-1281` (toggle de UI), `:1320-1370` (salvar), `:1372-1412` (renderizar conexão), `:1446-1455` (carregar conexão)
- Modify: `frontend/styles.css` (estilos novos da caixa de QR Code)

**Interfaces:**
- Consumes: `GET/PUT /api/access-control/whatsapp`, `GET /api/access-control/whatsapp/connection?refresh_qr=`, `POST /api/access-control/whatsapp/disconnect` (Task 4).
- Produces: nenhuma interface nova para outras tasks — é a ponta final da cadeia.

Esta task é só frontend; não tem ciclo TDD com script Python. A verificação é manual no navegador (dev server já rodando) — testar: (1) escolher "Evolution API" no seletor esconde os campos da Meta e mostra a caixa de QR Code; (2) escolher "API Oficial (Meta)" volta ao normal; (3) salvar com Evolution e clicar "Verificar conexão" busca e mostra o QR Code; (4) botão "Desconectar" aparece só para Evolution e funciona.

- [ ] **Step 1: HTML — opção no seletor de provider e caixa de QR Code**

Em `frontend/index.html`, trocar o seletor de provider (linhas 2064-2067):

```html
                  <label for="accessWhatsappProvider">Provedor</label>
                  <select id="accessWhatsappProvider">
                    <option value="cloud_api">API Oficial (Meta)</option>
                    <option value="evolution">Evolution API (plano B manual)</option>
                  </select>
```

No painel "Conexão WhatsApp" (linhas 2110-2132), adicionar a caixa do Evolution depois de `accessWhatsappCloudBox` e um botão de desconectar:

```html
          <div class="panel access-connection-panel access-connection-status-panel">
            <div class="panel-header">
              <div>
                <h2>Conexao WhatsApp</h2>
                <p>Origem das mensagens enviadas aos responsaveis.</p>
              </div>
              <span class="badge badge-gray" id="accessWhatsappConnectionStatus">Aguardando</span>
            </div>
            <div class="access-connection-form">
              <div class="access-whatsapp-cloud" id="accessWhatsappCloudBox">
                <dl class="access-whatsapp-cloud-facts">
                  <div><dt>Numero remetente</dt><dd id="accessWhatsappCloudNumber">-</dd></div>
                  <div><dt>Nome exibido</dt><dd id="accessWhatsappCloudName">-</dd></div>
                  <div><dt>Modelo de mensagem</dt><dd id="accessWhatsappCloudTemplate">-</dd></div>
                  <div><dt>Qualidade da conta</dt><dd id="accessWhatsappCloudQuality">-</dd></div>
                </dl>
                <p class="access-whatsapp-cloud-note" id="accessWhatsappCloudHint">Sem QR Code e sem sessao: a autenticacao e um token permanente.</p>
              </div>
              <div class="access-whatsapp-evolution hidden" id="accessWhatsappEvolutionBox">
                <div class="access-whatsapp-evolution-qr">
                  <img id="accessWhatsappEvolutionQr" alt="QR Code do WhatsApp" hidden>
                  <span id="accessWhatsappEvolutionQrEmpty">Sem QR Code no momento.</span>
                </div>
                <dl class="access-whatsapp-cloud-facts">
                  <div><dt>Instancia</dt><dd id="accessWhatsappEvolutionInstance">-</dd></div>
                  <div><dt>Estado da sessao</dt><dd id="accessWhatsappEvolutionState">-</dd></div>
                </dl>
                <p class="access-whatsapp-cloud-note" id="accessWhatsappEvolutionHint">Escaneie o QR Code no WhatsApp do celular da escola (Aparelhos conectados).</p>
              </div>
              <div class="access-connection-actions">
                <button class="secondary-action" id="btnAccessWhatsappConnection" type="button"><i data-lucide="activity"></i> Verificar conexao</button>
                <button class="secondary-action hidden" id="btnAccessWhatsappDisconnect" type="button"><i data-lucide="log-out"></i> Desconectar</button>
              </div>
            </div>
          </div>
```

Bumpar as versões de cache (`?v=`): linha 10 (`styles.css?v=255` → `styles.css?v=256`) e linha 6033 (`accessControl.js?v=81` → `accessControl.js?v=82`).

- [ ] **Step 2: CSS — estilos da caixa de QR Code**

Em `frontend/styles.css`, logo depois do bloco `.access-whatsapp-cloud-note` (linha ~1120), adicionar:

```css
.access-whatsapp-evolution {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.access-whatsapp-evolution-qr {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
}

.access-whatsapp-evolution-qr img {
  width: 180px;
  height: 180px;
  image-rendering: pixelated;
}

.access-whatsapp-evolution-qr span {
  color: var(--muted);
  font-size: 13px;
  text-align: center;
  padding: 0 16px;
}
```

- [ ] **Step 3: JS — alternar visibilidade conforme o provider**

Em `frontend/js/accessControl.js`, substituir `updateAccessWhatsappProviderUi` (linhas 1278-1281):

```javascript
function updateAccessWhatsappProviderUi() {
  const cloud = isAccessWhatsappCloudProvider();
  const alterna = (id, mostrar) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', !mostrar);
  };
  alterna('accessWhatsappPhoneIdGroup', cloud);
  alterna('accessWhatsappCloudRow', cloud);
  alterna('accessWhatsappTemplateRow', cloud);
  alterna('accessWhatsappCloudBox', cloud);
  alterna('accessWhatsappEvolutionBox', !cloud);
  alterna('btnAccessWhatsappDisconnect', !cloud);
}
```

- [ ] **Step 4: JS — trocar o fallback do provider salvo (consistência com o default do backend)**

Em `saveAccessWhatsappConfig` (linha 1326), trocar o fallback de `'evolution'` para `'cloud_api'`:

```javascript
    provider: document.getElementById('accessWhatsappProvider')?.value || 'cloud_api',
```

E em `loadAccessWhatsappConfig` (linha 1298), mesma troca:

```javascript
    document.getElementById('accessWhatsappProvider').value = data.provider || 'cloud_api';
```

- [ ] **Step 5: JS — renderizar a caixa de QR Code / estado da sessao**

Em `setAccessWhatsappConnection` (linhas 1372-1412), adicionar o branch do Evolution logo antes do fechamento da função (depois da linha que escreve `accessWhatsappCloudHint`):

```javascript
  const ESTADOS_EVOLUTION = {
    connected: 'Conectado', waiting_qr: 'Aguardando leitura do QR Code',
    disconnected: 'Desconectado', not_configured: 'Nao configurado',
    error: 'Erro ao consultar', unknown: 'Desconhecido',
  };
  const estadoTexto = ESTADOS_EVOLUTION[String(data?.state || '')] || data?.state || '-';
  const escreveEvolution = (id, valor) => {
    const el = document.getElementById(id);
    if (el) el.textContent = valor || '-';
  };
  escreveEvolution('accessWhatsappEvolutionInstance', data?.instance);
  escreveEvolution('accessWhatsappEvolutionState', estadoTexto);
  const imgQr = document.getElementById('accessWhatsappEvolutionQr');
  const semQr = document.getElementById('accessWhatsappEvolutionQrEmpty');
  if (imgQr && semQr) {
    if (data?.qrcode) {
      imgQr.src = data.qrcode.startsWith('data:') ? data.qrcode : `data:image/png;base64,${data.qrcode}`;
      imgQr.hidden = false;
      semQr.hidden = true;
    } else {
      imgQr.hidden = true;
      semQr.hidden = false;
      semQr.textContent = data?.connected ? 'Sessao conectada: nenhum QR Code necessario.' : 'Sem QR Code no momento.';
    }
  }
  const notaEvolution = document.getElementById('accessWhatsappEvolutionHint');
  if (notaEvolution) {
    notaEvolution.textContent = data?.error || 'Escaneie o QR Code no WhatsApp do celular da escola (Aparelhos conectados).';
  }
```

- [ ] **Step 6: JS — pedir QR Code novo ao verificar conexao, e ligar o botao de desconectar**

Em `loadAccessWhatsappConnection` (linhas 1446-1455), mandar `refresh_qr=1` quando o provider ativo for Evolution. Trocar a montagem da URL de `accessWhatsappSiteQuery()` (que só lida com um parâmetro) para `URLSearchParams`, que lida com os dois sem concatenação frágil:

```javascript
async function loadAccessWhatsappConnection(force = false) {
  try {
    const params = new URLSearchParams();
    const site = accessWhatsappSiteValue();
    if (site) params.set('site', site);
    if (!isAccessWhatsappCloudProvider()) params.set('refresh_qr', '1');
    const query = params.toString() ? `?${params.toString()}` : '';
    const data = await apiJson(`/api/access-control/whatsapp/connection${query}`, { forceRefresh: force, cacheTtl: 0 });
    setAccessWhatsappConnection(data);
    return data;
  } catch (err) {
    setAccessWhatsappConnection({ state: 'error', error: err?.message || 'Nao foi possivel consultar a conexao.' });
    return null;
  }
}
```

Adicionar a função de desconectar e o listener do botão, logo depois de `verificarCanalWhatsapp` (depois da linha 1444):

```javascript
async function desconectarCanalWhatsapp() {
  const btn = document.getElementById('btnAccessWhatsappDisconnect');
  const htmlAntigo = btn?.innerHTML;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Desconectando';
    lucide.createIcons();
  }
  try {
    const res = await api('/api/access-control/whatsapp/disconnect', { method: 'POST', body: JSON.stringify({ site: accessWhatsappSiteValue() }) });
    const data = await jsonOrReadableError(res, 'Nao foi possivel desconectar o WhatsApp.');
    showToast('Sessao desconectada.');
    await loadAccessWhatsappConnection(true);
    return data;
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel desconectar o WhatsApp.', true);
    return null;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = htmlAntigo;
      lucide.createIcons();
    }
  }
}

document.getElementById('btnAccessWhatsappDisconnect')?.addEventListener('click', desconectarCanalWhatsapp);
```

- [ ] **Step 7: Verificação manual no navegador**

Com o dev server rodando:
1. Abrir a tela de Controle de Acesso → Conexões.
2. Trocar o provedor para "Evolution API (plano B manual)" → os campos da Meta (Phone Number ID, WABA ID, Token, Template) somem; a caixa de QR Code aparece.
3. Salvar. Clicar "Verificar conexão" → deve chamar `GET /whatsapp/connection?site=...&refresh_qr=1` (checar na aba Rede do DevTools) e mostrar o estado (`Aguardando leitura do QR Code`, já que nenhuma instância real vai existir em ambiente de teste local — sem o Evolution real rodando, vai aparecer erro de conexão, o que é o comportamento correto).
4. Trocar de volta para "API Oficial (Meta)" → a caixa de QR Code some, os campos da Meta voltam.

- [ ] **Step 8: Commit**

```bash
git add frontend/index.html frontend/js/accessControl.js frontend/styles.css
git commit -m "feat(whatsapp): tela de Conexoes ganha selecao de provedor Evolution e QR Code"
```

---

## Self-Review

**Cobertura da spec** (`docs/superpowers/specs/2026-08-27-whatsapp-evolution-fallback-design.md`):
- "Modelo de configuração" (campo `provider`, default `cloud_api`, credenciais de plataforma) → Tasks 1-2.
- "Envio de mensagem" (Evolution quando `provider == evolution`) → Task 2 (`_send_whatsapp`, `send_access_whatsapp_text`).
- "Verificação de saúde" (ativa, só `open` conta como conectado, alimenta Dashboard/Zabbix) → Tasks 2-3.
- "Conectar (QR Code)" → Task 2 (`_evolution_connection_status`) + Task 5 (UI).
- "Fora de escopo" (ACK de entrega, failover automático, reaproveitar "presidente-dutra") → respeitado; nenhuma task implementa isso.
- "Testes e validação" (todos os 5 itens da spec) → cobertos pelos testes das Tasks 1-4 (regressão de `cloud_api` sem mudança de comportamento, estado real refletido, QR Code da instância certa via nome único por tenant+site, trocar provider de um site não afeta outros — cada site tem sua própria entrada em `access_control_whatsapp_notifications_by_site`).

**Placeholders:** nenhum "TBD"/"implementar depois" — todo passo de código tem o código completo.

**Consistência de tipos:** `_evolution_instance_cfg`, `disconnect_access_whatsapp`, `_evolution_connection_status` usam os mesmos nomes de campo (`base_url`, `api_key`, `instance`, `state`, `connected`, `qrcode`) em todas as tasks que os consomem; `get_access_whatsapp_connection()` mantém a mesma assinatura (`refresh_qr`, `site`, `resumo`) que já era usada pelos endpoints e por `list_access_whatsapp_channels()`.

---

## Notas de Deploy (fora deste plano — para quando o usuário pedir)

Produção não roda a partir do git. Quando este código for para produção, seguir o padrão já usado nesta sessão (extrair arquivo do container rodando → aplicar só o diff → rebuildar a imagem → validar → trocar via `docker compose up -d --no-deps`), e além disso:

- Definir `SIGHTOPS_EVOLUTION_URL=http://10.10.12.7:8090` e `SIGHTOPS_EVOLUTION_API_KEY=c566849288c4cfac998bcdd2c740159acf6b13bd38175fc4` no `.env.production` do container `sightops-prod-api` (confirmado nesta sessão: o container alcança esse endereço).
- Não é preciso nenhuma mudança de rede Docker — a conectividade já foi validada via `docker exec sightops-prod-api ...` alcançando `10.10.12.7:8090` mesmo em redes Docker diferentes.
