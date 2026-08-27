# Dashboard - Monitoramento de Controle de Acesso e WhatsApp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fazer as controladoras de Controle de Acesso e os canais de WhatsApp
aparecerem no Dashboard com contagem online/offline (como OLTs e Conectores
ja aparecem hoje) e serem enviados ao Zabbix pelo mesmo caminho que OLT/ONU
ja usam.

**Architecture:** O Dashboard ja le de uma tabela generica
`monitoring_entities` (entity_type/status), alimentada por
`refresh_from_inventory()` a cada 120s (`app/main.py:_monitoring_refresh_loop`).
Basta (1) fazer o status de cada controladora refletir a realidade sozinho
(hoje so atualiza sob demanda), (2) adicionar dois blocos novos em
`refresh_from_inventory()` que leem `access_devices` e os canais WhatsApp
configurados, e (3) incluir os dois `entity_type` novos na lista que
`sync_monitoring_to_zabbix()` envia. Frontend: como o Dashboard e a tela de
Monitoramento ja sao genericos por `entity_type`, so precisam de duas linhas
novas de rotulo/exibicao.

**Tech Stack:** FastAPI (Python), SQLite (tabelas `access_devices` e
`monitoring_entities`), vanilla JS no frontend. Testes deste repo NAO usam
pytest — sao scripts standalone em `scripts/sightops_*_test.py`, rodados com
`python scripts/arquivo_test.py` (ver Task 1 para o padrao exato).

## Global Constraints

- Reaproveitar a MESMA logica de teste que o botao "Testar" ja usa hoje
  (`poll_events` em `app/services/access_control_device.py`, que ja trata o
  caminho via conector RouterOS) — nao criar um novo metodo de checagem.
- Nao criar um novo loop em background: o loop `_access_control_sync_loop`
  em `app/main.py` (a cada 15s) ja chama `poll_device_events` para toda
  controladora ativa — a correcao entra dentro dele.
- `update_device_health()` faz `UPDATE` de uma linha por vez no banco (nao
  reescreve um arquivo inteiro) — confirmar que isso continua assim; e o que
  evita repetir o bug de race condition corrigido mais cedo nesta sessao em
  `app/api/endpoints/maintenance.py` (sync cheio sobrescrevendo dado
  concorrente).
- Nao alterar como Cameras, OLT, ONU, Conectores, Gravadores ou o botao
  "Testar" da tela de Controle de Acesso funcionam hoje.
- Sem placeholder de UI: os cards novos usam os MESMOS componentes CSS que
  os existentes (`dash-health-card`, `dash-status-row`) — nao criar CSS novo.

---

### Task 1: Controladora offline de verdade quando o teste falhar

**Files:**
- Modify: `app/services/access_control_sync.py:317-330` (funcao `poll_device_events`)
- Test: `scripts/sightops_access_control_health_poll_test.py` (criar)

**Interfaces:**
- Consumes: `update_device_health(device_id: str, *, status: str, model: str = "", last_seen_at: str = "") -> Dict[str, Any]` (ja existe em `app/services/access_control_store.py:833`, levanta `ValueError` se o dispositivo nao existir mais no tenant).
- Consumes: `poll_events(device: Dict[str, Any], since_id: str = "") -> List[Dict[str, Any]]` (ja existe em `app/services/access_control_device.py`, levanta `fastapi.HTTPException` quando o dispositivo/conector nao responde).
- Produces: `poll_device_events(device_id: str) -> int` continua com a mesma assinatura e retorno; a UNICA mudanca de comportamento e que agora tambem marca `status="offline"` quando a consulta falha (antes so marcava `"online"` quando dava certo, e nunca marcava `"offline"` sozinho).

Hoje, em `app/services/access_control_sync.py:317-321`:

```python
    try:
        events = poll_events(device, since_id=device.get("last_event_id") or "")
    except HTTPException as exc:
        logger.warning("Falha ao consultar eventos do dispositivo %s: %s", device_id, exc.detail)
        return 0
```

O status so e atualizado no caminho de sucesso (linhas 322-330). Isso significa que uma controladora desligada fica com o ULTIMO status bom para sempre, porque ninguem nunca escreve "offline" automaticamente.

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/sightops_access_control_health_poll_test.py`:

```python
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

from fastapi import HTTPException


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DATA_DIR"] = tmp
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-access-health.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-access-health-test-key"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_store import (
            ensure_access_control_schema,
            list_devices,
            save_device,
        )
        from app.services import access_control_sync

        def _status_of(device_id: str) -> str:
            row = next(d for d in list_devices() if d["id"] == device_id)
            return row["status"]

        token = set_current_tenant_slug("escola-health-test")
        try:
            ensure_access_control_schema()
            device = save_device({
                "name": "Portaria Teste",
                "site": "ESCOLA",
                "host": "10.10.13.200",
                "username": "admin",
                "password": "SenhaTeste2011",
            })
            device_id = device["id"]

            # 1) poll com sucesso marca online
            with patch.object(access_control_sync, "poll_events", return_value=[]):
                access_control_sync.poll_device_events(device_id)
            assert _status_of(device_id) == "online", "deveria marcar online apos sucesso"

            # 2) poll que falha (dispositivo desligado) tem que marcar offline
            with patch.object(
                access_control_sync,
                "poll_events",
                side_effect=HTTPException(status_code=502, detail="Nao foi possivel conectar no IP do dispositivo."),
            ):
                access_control_sync.poll_device_events(device_id)
            status_apos_falha = _status_of(device_id)
            assert status_apos_falha == "offline", f"esperado offline, veio {status_apos_falha!r}"

            print("OK: poll_device_events marca offline quando a consulta falha")
        finally:
            reset_current_tenant_slug(token)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python scripts/sightops_access_control_health_poll_test.py`
Expected: `AssertionError: esperado offline, veio 'online'` (o status fica parado no ultimo "online" porque o codigo atual nunca escreve "offline" sozinho).

- [ ] **Step 3: Implementar a correcao minima**

Em `app/services/access_control_sync.py`, trocar o bloco (linhas ~317-321):

```python
    try:
        events = poll_events(device, since_id=device.get("last_event_id") or "")
    except HTTPException as exc:
        logger.warning("Falha ao consultar eventos do dispositivo %s: %s", device_id, exc.detail)
        return 0
```

por:

```python
    try:
        events = poll_events(device, since_id=device.get("last_event_id") or "")
    except HTTPException as exc:
        logger.warning("Falha ao consultar eventos do dispositivo %s: %s", device_id, exc.detail)
        try:
            update_device_health(device_id, status="offline")
        except ValueError:
            logger.warning("Nao foi possivel marcar dispositivo %s como offline", device_id)
        return 0
```

`update_device_health` ja esta importado nesse arquivo (usado logo abaixo, no caminho de sucesso) — nao precisa de import novo.

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python scripts/sightops_access_control_health_poll_test.py`
Expected: `OK: poll_device_events marca offline quando a consulta falha`

- [ ] **Step 5: Commit**

```bash
git add app/services/access_control_sync.py scripts/sightops_access_control_health_poll_test.py
git commit -m "fix(acesso): marca controladora offline quando o poll de eventos falha"
```

---

### Task 2: Controladoras entram no monitoramento generico (Dashboard)

**Files:**
- Modify: `app/services/monitoring_service.py:12-20` (`DEFAULT_PROFILES`)
- Modify: `app/services/monitoring_service.py:149-249` (`refresh_from_inventory`)
- Modify: `app/services/monitoring_service.py:281-291` (`list_monitoring_tenants`)
- Test: `scripts/sightops_monitoring_access_device_test.py` (criar)

**Interfaces:**
- Consumes: `list_devices(site: str = "") -> List[Dict[str, Any]]` de `app/services/access_control_store.py:817` — cada item tem `id, site, name, vendor, model, host, connector_id, status, last_seen_at, active` (bool).
- Consumes: `_observe_many(rows: Iterable[Dict[str, Any]], prune_entity_type: str = "") -> int` (ja existe, `monitoring_service.py:124`).
- Produces: a partir desta task, `entity_type="access_device"` passa a existir em `monitoring_entities` — e o que a Task 4 (Zabbix) e a Task 5 (frontend) vao consumir pelo nome exato `access_device`.

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/sightops_monitoring_access_device_test.py`:

```python
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
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-monitoring-access.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-monitoring-access-test-key"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_store import ensure_access_control_schema, save_device
        from app.services.monitoring_service import list_entities, refresh_from_inventory

        token = set_current_tenant_slug("escola-monitoring-test")
        try:
            ensure_access_control_schema()
            save_device({"name": "Portaria Online", "site": "ESCOLA", "host": "10.10.13.10", "status": "online"})
            offline = save_device({"name": "Portaria Offline", "site": "ESCOLA", "host": "10.10.13.11"})
            # save_device nao aceita status direto -- forcar offline como o
            # poll real faria, via update_device_health.
            from app.services.access_control_store import update_device_health
            update_device_health(offline["id"], status="offline")

            refresh_from_inventory()

            rows = list_entities(entity_type="access_device")
            assert len(rows) == 2, f"esperado 2 controladoras monitoradas, veio {len(rows)}"
            by_name = {r["display_name"]: r["status"] for r in rows}
            assert by_name.get("Portaria Online") == "up", by_name
            assert by_name.get("Portaria Offline") == "down", by_name
            print("OK: controladoras aparecem em monitoring_entities com status certo")
        finally:
            reset_current_tenant_slug(token)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python scripts/sightops_monitoring_access_device_test.py`
Expected: `AssertionError: esperado 2 controladoras monitoradas, veio 0` (nao existe bloco nenhum para `access_device` em `refresh_from_inventory` ainda).

- [ ] **Step 3: Implementar**

Em `app/services/monitoring_service.py`, adicionar `"access-device-default"` a `DEFAULT_PROFILES` (linha ~19, junto dos outros):

```python
DEFAULT_PROFILES = (
    ("connector-default", "Conector MikroTik", "connector", 60, 2),
    ("olt-default", "OLT", "olt", 60, 2),
    ("onu-default", "ONU/ONT", "onu", 120, 2),
    ("camera-default", "Camera IP", "camera", 60, 2),
    ("nvr-default", "NVR", "nvr", 60, 2),
    ("dvr-default", "DVR", "dvr", 60, 2),
    ("windows-default", "Computador Windows", "windows", 120, 2),
    ("access-device-default", "Controladora de Acesso", "access_device", 180, 2),
    ("whatsapp-default", "Canal WhatsApp", "whatsapp", 300, 1),
)
```

(o perfil `whatsapp-default` ja entra aqui, mesmo que a Task 3 seja quem usa
o entity_type `whatsapp` de verdade — evita ter que editar esta tupla duas
vezes.)

Em `refresh_from_inventory()` (`monitoring_service.py:149-249`), adicionar o
import local junto dos outros (topo da funcao, ~linha 150-155) e o bloco
novo logo depois do bloco `windows` (antes do `return`, linha ~249):

```python
    from app.services.access_control_store import list_devices as list_access_devices
```

```python
    access_devices = list_access_devices()
    counts["access_device"] = _observe_many(({
        "entity_key": f"access_device:{r.get('id')}", "entity_type": "access_device", "entity_id": r.get("id"),
        "site": r.get("site"), "connector_id": r.get("connector_id"), "display_name": r.get("name") or r.get("host"),
        "status": r.get("status") if r.get("active") else "maintenance",
        "detail": {"host": r.get("host"), "vendor": r.get("vendor"), "model": r.get("model"), "last_seen_at": r.get("last_seen_at")},
    } for r in access_devices if r.get("id")), prune_entity_type="access_device")
```

Por fim, em `list_monitoring_tenants()` (`monitoring_service.py:281-291`),
adicionar `"access_devices"` a lista de tabelas verificadas — sem isso, um
tenant que so usa Controle de Acesso (sem camera/OLT/site cadastrado) nunca
entraria na lista de tenants que o loop de fundo processa:

```python
        for table in ("sites", "ip_cameras", "recorders", "olts", "monitoring_profiles", "access_devices"):
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python scripts/sightops_monitoring_access_device_test.py`
Expected: `OK: controladoras aparecem em monitoring_entities com status certo`

- [ ] **Step 5: Commit**

```bash
git add app/services/monitoring_service.py scripts/sightops_monitoring_access_device_test.py
git commit -m "feat(dashboard): controladoras de acesso entram no monitoramento generico"
```

---

### Task 3: Canais de WhatsApp entram no monitoramento generico

**Files:**
- Modify: `app/services/access_control_notifications.py` (nova funcao publica, perto de `get_access_whatsapp_connection`)
- Modify: `app/services/monitoring_service.py` (`refresh_from_inventory`, bloco novo)
- Test: `scripts/sightops_monitoring_whatsapp_test.py` (criar)

**Interfaces:**
- Consumes: `get_access_whatsapp_connection(*, refresh_qr: bool = False, site: Any = "", resumo: bool = False) -> Dict[str, Any]` (ja existe, `access_control_notifications.py:371`) — devolve `configured`, `connected`, `phone_number_id`, `display_phone_number`, `quality_rating`.
- Consumes: `_access_whatsapp_site_configs(settings: Dict[str, Any]) -> Dict[str, Dict[str, Any]]` e `_cloud_cfg(cfg: Dict[str, Any]) -> Dict[str, str]` (ja existem no mesmo arquivo, privadas — uso interno, mesmo modulo).
- Produces: `list_access_whatsapp_channels() -> List[Dict[str, Any]]`, cada item com `site: str, label: str, configured: bool, connected: bool, phone_number_id: str, display_phone_number: str, quality_rating: str`. A Task 2 (`refresh_from_inventory`) e a Task 5 (dashboard) consomem essa lista pelo nome exato.

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/sightops_monitoring_whatsapp_test.py`:

```python
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, patch


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DATA_DIR"] = tmp
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-monitoring-whatsapp.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-monitoring-whatsapp-test-key"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.db_store import save_app_settings
        from app.services.access_control_notifications import list_access_whatsapp_channels

        token = set_current_tenant_slug("escola-whatsapp-test")
        try:
            save_app_settings({
                "access_control_whatsapp_notifications_by_site": {
                    "ESCOLA A": {
                        "phone_number_id": "111111",
                        "access_token": "token-escola-a",
                        "template_name": "aviso_acesso_aluno",
                    },
                    "ESCOLA B": {
                        "phone_number_id": "222222",
                        "access_token": "token-escola-b",
                        "template_name": "aviso_acesso_aluno",
                    },
                },
            })

            fake_ok = MagicMock(status_code=200)
            fake_ok.json.return_value = {"display_phone_number": "+55 82 90000-0000", "quality_rating": "GREEN"}
            fake_fail = MagicMock(status_code=401)
            fake_fail.json.return_value = {"error": {"message": "token invalido"}}

            def fake_get(url: str, **kwargs):
                # ESCOLA B tem token invalido -- simula token expirado/errado
                return fake_fail if "222222" in url else fake_ok

            with patch("app.services.access_control_notifications.requests.get", side_effect=fake_get):
                channels = list_access_whatsapp_channels()

            by_site = {c["site"]: c for c in channels}
            assert len(channels) == 2, f"esperado 2 canais configurados, veio {len(channels)}"
            assert by_site["ESCOLA A"]["connected"] is True, by_site["ESCOLA A"]
            assert by_site["ESCOLA B"]["connected"] is False, by_site["ESCOLA B"]
            assert by_site["ESCOLA B"]["configured"] is True, by_site["ESCOLA B"]
            print("OK: list_access_whatsapp_channels devolve um canal por site configurado")
        finally:
            reset_current_tenant_slug(token)


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python scripts/sightops_monitoring_whatsapp_test.py`
Expected: `ImportError: cannot import name 'list_access_whatsapp_channels'` (a funcao ainda nao existe).

- [ ] **Step 3: Implementar**

Em `app/services/access_control_notifications.py`, adicionar a funcao nova
logo apos `get_access_whatsapp_connection` (depois da linha 460):

```python
def list_access_whatsapp_channels() -> List[Dict[str, Any]]:
    """Canais WhatsApp configurados, com status real de conexao de cada um.

    "connected" aqui exige uma chamada bem-sucedida na Graph API, nao so
    credencial presente: get_access_whatsapp_connection() ja marca
    "connected: True" apenas por existir phone_number_id + token gravados
    (mesmo com token revogado) -- so "display_phone_number" vem preenchido
    quando a consulta na Meta realmente deu certo (ver
    access_control_notifications.py:427-442), entao esse e o sinal usado
    aqui como conectividade de verdade, sem mudar o contrato da funcao que
    a tela de Conexoes ja usa.

    Um canal por site com config propria, mais o "padrao do cliente" quando
    ele tiver credenciais proprias (nao amarradas a nenhum site especifico).
    Usado para alimentar o card do Dashboard e o Zabbix -- ver
    refresh_from_inventory() em monitoring_service.py.
    """
    settings = db_store.load_app_settings()
    channels: List[Dict[str, Any]] = []

    def _channel(site: str, label: str) -> Dict[str, Any]:
        result = get_access_whatsapp_connection(site=site)
        return {
            "site": site, "label": label,
            "configured": bool(result.get("configured")),
            "connected": bool(result.get("display_phone_number")),
            "phone_number_id": result.get("phone_number_id", ""),
            "display_phone_number": result.get("display_phone_number", ""),
            "quality_rating": result.get("quality_rating", ""),
        }

    global_cfg = _cloud_cfg(settings.get("access_control_whatsapp_notifications") or {})
    if global_cfg["phone_number_id"] and global_cfg["access_token"]:
        channels.append(_channel("", "Padrao do cliente"))

    for site_name in _access_whatsapp_site_configs(settings):
        channels.append(_channel(site_name, site_name))

    return channels
```

O topo do arquivo (`app/services/access_control_notifications.py:8`) hoje
tem `from typing import Any, Dict` — falta `List`. Trocar essa linha por:

```python
from typing import Any, Dict, List
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python scripts/sightops_monitoring_whatsapp_test.py`
Expected: `OK: list_access_whatsapp_channels devolve um canal por site configurado`

- [ ] **Step 5: Adicionar o bloco em refresh_from_inventory e cobrir com teste**

Em `app/services/monitoring_service.py`, adicionar o import local (junto dos
outros, topo de `refresh_from_inventory`):

```python
    from app.services.access_control_notifications import list_access_whatsapp_channels
```

E o bloco novo, logo apos o bloco de `access_device` da Task 2, antes do
`return`:

```python
    whatsapp_channels = list_access_whatsapp_channels()
    counts["whatsapp"] = _observe_many(({
        "entity_key": f"whatsapp:{c.get('site') or 'default'}", "entity_type": "whatsapp",
        "entity_id": c.get("site") or "default", "site": c.get("site"), "display_name": c.get("label"),
        "status": "online" if c.get("connected") else "offline",
        "detail": {
            "phone_number_id": c.get("phone_number_id"), "display_phone_number": c.get("display_phone_number"),
            "quality_rating": c.get("quality_rating"),
        },
    } for c in whatsapp_channels), prune_entity_type="whatsapp")
```

Estender `scripts/sightops_monitoring_whatsapp_test.py` (mesmo arquivo do
Step 1) com uma segunda verificacao, dentro do mesmo `try`, logo apos o
`print("OK: list_access_whatsapp_channels ...")`:

```python
            from app.services.monitoring_service import refresh_from_inventory
            from app.services.monitoring_service import list_entities as list_monitoring_entities

            with patch("app.services.access_control_notifications.requests.get", side_effect=fake_get):
                refresh_from_inventory()

            rows = list_monitoring_entities(entity_type="whatsapp")
            by_site2 = {r["site"]: r["status"] for r in rows}
            assert by_site2.get("ESCOLA A") == "up", by_site2
            assert by_site2.get("ESCOLA B") == "down", by_site2
            print("OK: canais WhatsApp aparecem em monitoring_entities com status certo")
```

Run: `python scripts/sightops_monitoring_whatsapp_test.py`
Expected: as duas linhas `OK: ...` impressas, sem traceback.

- [ ] **Step 6: Commit**

```bash
git add app/services/access_control_notifications.py app/services/monitoring_service.py scripts/sightops_monitoring_whatsapp_test.py
git commit -m "feat(dashboard): canais de WhatsApp entram no monitoramento generico"
```

---

### Task 4: Controladoras e WhatsApp passam a ir para o Zabbix

**Files:**
- Modify: `app/services/zabbix_monitoring_service.py:115`
- Test: `scripts/sightops_zabbix_monitoring_types_test.py` (criar)

**Interfaces:**
- Consumes: nenhuma nova — so muda o valor padrao de um parametro ja existente.
- Produces: `sync_monitoring_to_zabbix()` chamado SEM argumentos (como todo
  chamador do repo ja faz: `app/main.py:210`, `app/api/endpoints/monitoring.py:39,47`,
  `scripts/sightops_refresh_onu_telemetry.py:23`) passa a incluir tambem
  `access_device` e `whatsapp`.

Todos os 4 lugares que chamam `sync_monitoring_to_zabbix()` no repo chamam
sem argumento nenhum, contando com o valor padrao — entao a mudanca certa e
so no default, um lugar so, e todo mundo herda.

- [ ] **Step 1: Escrever o teste que falha**

Criar `scripts/sightops_zabbix_monitoring_types_test.py`:

```python
from __future__ import annotations

import inspect
import sys
from pathlib import Path


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from app.services.zabbix_monitoring_service import sync_monitoring_to_zabbix

    default = inspect.signature(sync_monitoring_to_zabbix).parameters["entity_types"].default
    assert "access_device" in default, f"access_device deveria estar no default, veio {default}"
    assert "whatsapp" in default, f"whatsapp deveria estar no default, veio {default}"
    assert "olt" in default and "onu" in default, "nao pode remover olt/onu do default"
    print("OK: sync_monitoring_to_zabbix inclui access_device e whatsapp por padrao")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Rodar e confirmar que falha**

Run: `python scripts/sightops_zabbix_monitoring_types_test.py`
Expected: `AssertionError: access_device deveria estar no default, veio ('olt', 'onu')`

- [ ] **Step 3: Implementar**

Em `app/services/zabbix_monitoring_service.py:115`, trocar:

```python
def sync_monitoring_to_zabbix(entity_types: tuple[str, ...] = ("olt", "onu")) -> Dict[str, Any]:
```

por:

```python
def sync_monitoring_to_zabbix(entity_types: tuple[str, ...] = ("olt", "onu", "access_device", "whatsapp")) -> Dict[str, Any]:
```

- [ ] **Step 4: Rodar e confirmar que passa**

Run: `python scripts/sightops_zabbix_monitoring_types_test.py`
Expected: `OK: sync_monitoring_to_zabbix inclui access_device e whatsapp por padrao`

- [ ] **Step 5: Commit**

```bash
git add app/services/zabbix_monitoring_service.py scripts/sightops_zabbix_monitoring_types_test.py
git commit -m "feat(dashboard): controladoras e whatsapp passam a ser enviados ao Zabbix"
```

---

### Task 5: Cards novos no Dashboard e na tela de Monitoramento

**Files:**
- Modify: `frontend/js/monitoring.js:3-6` (`MONITORING_LABELS`)
- Modify: `frontend/js/dashboard.js:282-289` (grid de saude, `renderDashboardHealth`)
- Modify: `frontend/js/dashboard.js:436-444` (grid de status, dentro de `loadDashboard`)
- Modify: `frontend/index.html` (subir `?v=` de `monitoring.js` e `dashboard.js`)

**Interfaces:**
- Consumes: `data.monitoring.types.access_device` e `data.monitoring.types.whatsapp`, que chegam prontos de `GET /api/dashboard/summary` a partir da Task 2/3 (mesmo formato `{total, up, down, unstable, unknown, maintenance}` que `olt`/`connector` ja usam — nenhum parsing novo necessario).
- Produces: nada consumido por outra task — e o passo visual final.

Este projeto nao roda localmente para testar via browser real (ver
`docs/CONTINUAR-edicao-pontos-mapa.md` e a memoria do deploy) — a validacao
visual deste passo acontece so depois do deploy (ultimo item da checklist).

- [ ] **Step 1: Rotulos na tela de Monitoramento**

Em `frontend/js/monitoring.js:3-6`, trocar:

```javascript
const MONITORING_LABELS = {
  connector: 'Conectores', olt: 'OLTs', onu: 'ONUs/ONTs', camera: 'Cameras',
  nvr: 'NVRs', dvr: 'DVRs', windows: 'Computadores',
};
```

por:

```javascript
const MONITORING_LABELS = {
  connector: 'Conectores', olt: 'OLTs', onu: 'ONUs/ONTs', camera: 'Cameras',
  nvr: 'NVRs', dvr: 'DVRs', windows: 'Computadores',
  access_device: 'Controladoras de Acesso', whatsapp: 'WhatsApp',
};
```

Isso sozinho ja faz a tela de Monitoramento (`navigateTo('monitoring')`) e o
drawer de atencao (`openMonitoringAttentionDrawer`) listarem os dois tipos
novos, porque esses componentes ja iteram `Object.entries(MONITORING_LABELS)`
(`frontend/js/monitoring.js:233`) sem nenhum outro codigo por tipo.

- [ ] **Step 2: Card no grid de saude do Dashboard**

Em `frontend/js/dashboard.js`, dentro de `renderDashboardHealth` (linhas
275-289), adicionar duas variaveis logo apos `const connectors = ...`
(linha 278):

```javascript
  const accessDevices = availability(monitoring.access_device);
  const whatsapp = availability(monitoring.whatsapp);
```

E dois itens no array `health` (linhas 282-289), entre `Conectores` e
`Gravadores`:

```javascript
    { label: 'Controladoras de Acesso', value: accessDevices.pct == null ? '--' : `${accessDevices.pct}%`, sub: accessDevices.total ? `${accessDevices.online} online de ${accessDevices.total}` : 'nenhuma cadastrada', pct: accessDevices.pct, action: 'access_devices' },
    { label: 'WhatsApp', value: whatsapp.pct == null ? '--' : `${whatsapp.pct}%`, sub: whatsapp.total ? `${whatsapp.online} conectado(s) de ${whatsapp.total} configurado(s)` : 'nenhum canal configurado', pct: whatsapp.pct, action: 'whatsapp' },
```

E dois `if` novos no handler de clique logo abaixo (linhas 301-309), junto
dos outros `if (action === ...)`:

```javascript
    if (action === 'access_devices' && typeof openMonitoringDrawer === 'function') openMonitoringDrawer('access_device', 'all');
    if (action === 'whatsapp' && typeof openMonitoringDrawer === 'function') openMonitoringDrawer('whatsapp', 'all');
```

- [ ] **Step 3: Linha no grid de status do Dashboard**

Em `frontend/js/dashboard.js`, dentro de `loadDashboard` (array
`statusTypes`, linhas 436-444), adicionar duas linhas entre `ONUs/ONTs` e
`Cameras IP`:

```javascript
    { label: 'Controladoras', icon: 'shield-check', s: monitoring.access_device || {}, type: 'monitoring' },
    { label: 'WhatsApp',      icon: 'message-circle', s: monitoring.whatsapp || {},    type: 'monitoring' },
```

`type: 'monitoring'` e o mesmo valor usado por Conectores/OLTs/ONUs — o
clique ja navega para a tela de Monitoramento (`frontend/js/dashboard.js:529`,
`if (type === 'monitoring') navigateTo('monitoring')`), sem precisar de
nenhum `if` novo no handler de clique da grid de status.

- [ ] **Step 4: Subir a versao dos scripts**

Em `frontend/index.html`, localizar as linhas de `<script src="js/monitoring.js?v=NNN">`
e `<script src="js/dashboard.js?v=NNN">` (buscar com
`grep -n "monitoring.js?v=\|dashboard.js?v=" frontend/index.html`) e
incrementar os dois numeros em 1 cada — sem isso o navegador serve o JS
antigo em cache. Confirmar o numero atual antes de editar; nao reusar um
numero ja usado antes.

- [ ] **Step 5: Checar sintaxe dos dois arquivos**

Run: `node --check frontend/js/monitoring.js && node --check frontend/js/dashboard.js && echo SYNTAX_OK`
Expected: `SYNTAX_OK`

- [ ] **Step 6: Commit**

```bash
git add frontend/js/monitoring.js frontend/js/dashboard.js frontend/index.html
git commit -m "feat(dashboard): cards de Controladoras de Acesso e WhatsApp"
```

---

### Task 6: Rodar toda a bateria de testes junta e validar contra producao (sem publicar)

**Files:** nenhum arquivo novo — so validacao.

- [ ] **Step 1: Rodar todos os testes novos em sequencia**

```bash
python scripts/sightops_access_control_health_poll_test.py
python scripts/sightops_monitoring_access_device_test.py
python scripts/sightops_monitoring_whatsapp_test.py
python scripts/sightops_zabbix_monitoring_types_test.py
```

Expected: cada um imprime sua(s) linha(s) `OK: ...`, nenhum traceback.

- [ ] **Step 2: Rodar a suite de testes de acesso ja existente, pra garantir que nada quebrou**

```bash
python scripts/sightops_access_control_device_test.py
python scripts/sightops_access_control_notifications_test.py
```

Expected: sem traceback (esses arquivos ja existiam antes deste plano — so
confirmando que a Task 1 nao quebrou `poll_device_events` para quem ja
dependia dele).

- [ ] **Step 3: Import geral da aplicacao**

```bash
python -c "import app.main; print('IMPORT_OK')"
```

Expected: `IMPORT_OK`, sem exception (confirma que os imports novos em
`monitoring_service.py` e `access_control_notifications.py` nao criaram
import circular).

**Nao faz parte deste plano:** publicar em producao. Producao deste projeto
nao roda a partir do git — o processo de deploy real (extrair arquivo da
imagem Docker rodando, aplicar so o diff, buildar, validar contra dado real,
trocar o container) fica para quando o usuario pedir, seguindo o mesmo
procedimento ja usado nesta sessao (memoria `sightops-deploy-producao-real`).
