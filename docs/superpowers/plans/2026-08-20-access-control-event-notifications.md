# Controle de Acesso - Notificacoes de eventos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enviar notificacoes Telegram/WhatsApp para eventos novos de entrada, saida e saida manual do Controle de Acesso.

**Architecture:** `access_events` continua sendo a fonte de verdade. Um novo servico isolado formata e envia notificacoes sem bloquear o registro do evento; `record_event()` dispara o servico somente depois de inserir um evento novo, nunca em duplicatas. Telegram usa a configuracao existente; WhatsApp usa configuracao propria via webhook enquanto nao houver provedor oficial no repo.

**Tech Stack:** Python, SQLite/Postgres via `db_store`, `requests`, scripts de regressao existentes.

## Global Constraints

- Preservar isolamento por tenant.
- Nao travar ingestao de eventos se Telegram/WhatsApp falhar.
- Nao enviar notificacao para evento duplicado.
- Reaproveitar `telegram_notifications` existente.
- WhatsApp deve ficar desativado quando nao houver webhook configurado.

---

### Task 1: Notification Adapter

**Files:**
- Create: `app/services/access_control_notifications.py`
- Modify: `app/services/access_control_store.py`
- Test: `scripts/sightops_access_control_notifications_test.py`

**Interfaces:**
- Consumes: `db_store.load_app_settings()`, `requests.post()`, event dicts from `access_events`.
- Produces: `notify_access_event(event: Dict[str, Any]) -> Dict[str, Any]`.

- [ ] **Step 1: Write the failing test**

```python
def test_record_event_sends_telegram_and_whatsapp_once_for_new_event():
    # configure telegram_notifications and access_control_whatsapp_notifications
    # monkeypatch requests.post
    # save person/device, call record_event twice with the same raw_event_id
    # assert two outbound requests total: one Telegram, one WhatsApp
    # assert duplicate event does not send again
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_notifications_test.py`
Expected: FAIL because notification service / hook does not exist.

- [ ] **Step 3: Write minimal implementation**

```python
def notify_access_event(event: Dict[str, Any]) -> Dict[str, Any]:
    # load config, build plain event message, send Telegram and optional WhatsApp webhook
    # catch exceptions and return status; never raise into record_event
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_notifications_test.py`
Expected: prints `access-control notifications regression ok`.

- [ ] **Step 5: Run focused existing regression**

Run: `python scripts/sightops_access_control_reports_test.py`
Expected: prints `access-control reports regression ok`.
