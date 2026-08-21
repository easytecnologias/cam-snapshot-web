# Controle de Acesso - Relatorios de entrada e saida Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Criar relatorios de entrada/saida no Controle de Acesso, com entrada por controladora, saida por controladora ou saida manual.

**Architecture:** O backend continua usando SQLite e `access_events` como fonte dos relatorios. Dispositivos ganham um papel operacional (`entrada`, `saida`, `entrada_saida`) e o frontend ganha uma aba `Relatorios` dentro de Controle de Acesso, consumindo endpoints filtrados e um endpoint de saida manual.

**Tech Stack:** FastAPI, SQLite via `app.services.db_store`, JavaScript vanilla em `frontend/js/accessControl.js`, HTML/CSS existentes em `frontend/index.html` e `frontend/styles.css`.

## Global Constraints

- Trabalhar na homologacao/local, nao em producao.
- Preservar isolamento por tenant em todas as consultas e escritas.
- Nunca identificar evento, pessoa ou dispositivo apenas por IP.
- Dispositivos existentes devem migrar com papel `entrada`.
- Saida manual nao chama equipamento fisico.
- WhatsApp real fica fora desta entrega; a tela mostra apenas status de notificacao quando existir.

---

## File Structure

- Modify: `app/services/access_control_store.py`
  - Evoluir schema de `access_devices` e `access_events`.
  - Criar funcoes de relatorio, resumo e saida manual.
- Modify: `app/services/access_control_sync.py`
  - Aplicar o papel operacional do dispositivo ao gravar eventos.
- Modify: `app/api/endpoints/access_control.py`
  - Expor filtros do relatorio e endpoint de saida manual.
- Modify: `frontend/index.html`
  - Adicionar aba `Relatorios`, filtros, cards e tabela.
  - Adicionar campo de papel operacional no modal de dispositivo.
- Modify: `frontend/js/accessControl.js`
  - Carregar relatorios, atualizar KPIs e registrar saida manual.
  - Enviar/receber `access_direction` dos dispositivos.
- Modify: `frontend/styles.css`
  - Ajustar layout da aba de relatorios com o padrao SightOps.
- Test: criar ou atualizar script focado em `scripts/sightops_access_control_reports_test.py`.

---

### Task 1: Schema e store de eventos

**Files:**
- Modify: `app/services/access_control_store.py`
- Test: `scripts/sightops_access_control_reports_test.py`

**Interfaces:**
- Produces: `normalize_access_event_type(value: str) -> str`
- Produces: `record_manual_exit(person_id: str, site: str = "", reason: str = "", operator_user: str = "") -> Dict[str, Any]`
- Produces: `list_access_report_events(filters: Dict[str, Any]) -> List[Dict[str, Any]]`
- Produces: `access_presence_summary(site: str = "") -> Dict[str, int]`

- [ ] **Step 1: Add failing schema/report test**

```python
def test_access_report_counts_entry_exit_and_manual_exit(tmp_path, monkeypatch):
    from app.services import db_store
    from app.services.access_control_store import (
        access_control_summary,
        access_presence_summary,
        ensure_access_control_schema,
        list_access_report_events,
        record_event,
        record_manual_exit,
        save_device,
        save_person,
    )

    db_path = tmp_path / "access.sqlite"
    monkeypatch.setattr(db_store, "DB_PATH", str(db_path))
    db_store.set_current_tenant_slug("tenant_a")
    ensure_access_control_schema()

    person = save_person({"full_name": "Aluno Teste", "person_type": "student", "site": "Sede"})
    device = save_device({"name": "Entrada", "host": "10.0.0.10", "site": "Sede", "access_direction": "entrada"})
    record_event({
        "site": "Sede",
        "device_id": device["id"],
        "person_id": person["id"],
        "person_name_raw": "Aluno Teste",
        "event_type": "entrada",
        "occurred_at": "2026-08-20 07:10:00",
    })
    record_manual_exit(person["id"], site="Sede", reason="Responsavel buscou", operator_user="elishafan")

    summary = access_control_summary()
    assert summary["events_today"] >= 2
    assert summary["entries_today"] >= 1
    assert summary["manual_exits_today"] >= 1

    presence = access_presence_summary(site="Sede")
    assert presence["inside_now"] == 0

    events = list_access_report_events({"site": "Sede", "type": "saida_manual", "limit": 20})
    assert len(events) == 1
    assert events[0]["operator_user"] == "elishafan"
```

- [ ] **Step 2: Run failing test**

Run: `python scripts/sightops_access_control_reports_test.py`
Expected: FAIL because report/manual-exit functions and new fields do not exist.

- [ ] **Step 3: Add migrations**

In `ensure_access_control_schema()`:

```python
_ensure_column(c, "access_devices", "access_direction", "TEXT NOT NULL DEFAULT 'entrada'")
_ensure_column(c, "access_events", "source", "TEXT NOT NULL DEFAULT 'device'")
_ensure_column(c, "access_events", "device_name", "TEXT NOT NULL DEFAULT ''")
_ensure_column(c, "access_events", "device_role", "TEXT NOT NULL DEFAULT 'entrada'")
_ensure_column(c, "access_events", "operator_user", "TEXT NOT NULL DEFAULT ''")
_ensure_column(c, "access_events", "manual_reason", "TEXT NOT NULL DEFAULT ''")
_ensure_column(c, "access_events", "notification_status", "TEXT NOT NULL DEFAULT ''")
_ensure_column(c, "access_events", "raw_event_id", "TEXT NOT NULL DEFAULT ''")
_ensure_column(c, "access_events", "raw_payload", "TEXT NOT NULL DEFAULT ''")
```

If `_ensure_column` does not exist in the file, create a small helper near schema setup:

```python
def _ensure_column(conn: Any, table: str, column: str, definition: str) -> None:
    columns = {str(row["name"]) for row in conn.execute(f"PRAGMA table_info({table})").fetchall()}
    if column not in columns:
        conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
```

- [ ] **Step 4: Persist device direction**

Update `save_device()` and returned device rows so `access_direction` is cleaned and stored:

```python
def normalize_access_direction(value: str) -> str:
    clean = _clean_text(value, 32).lower()
    return clean if clean in {"entrada", "saida", "entrada_saida"} else "entrada"
```

- [ ] **Step 5: Add report helpers**

Implement `normalize_access_event_type`, `record_manual_exit`, `list_access_report_events` and `access_presence_summary` using tenant-scoped SQL. Join events to `access_people` and `access_devices` with tenant plus IDs, not IP.

- [ ] **Step 6: Run test**

Run: `python scripts/sightops_access_control_reports_test.py`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add app/services/access_control_store.py scripts/sightops_access_control_reports_test.py
git commit -m "feat(access-control): Add entry exit report store"
```

---

### Task 2: Sync aplica papel operacional do dispositivo

**Files:**
- Modify: `app/services/access_control_sync.py`
- Test: `scripts/sightops_access_control_reports_test.py`

**Interfaces:**
- Consumes: `normalize_access_event_type(value: str) -> str`
- Produces: `poll_device_events(device_id: str) -> int` records normalized entry/exit events.

- [ ] **Step 1: Add failing poll normalization test**

```python
def test_poll_device_events_uses_device_direction_when_event_has_no_type(tmp_path, monkeypatch):
    from app.services import access_control_sync, db_store
    from app.services.access_control_store import ensure_access_control_schema, list_access_report_events, save_device

    db_path = tmp_path / "access.sqlite"
    monkeypatch.setattr(db_store, "DB_PATH", str(db_path))
    db_store.set_current_tenant_slug("tenant_a")
    ensure_access_control_schema()

    device = save_device({"name": "Saida", "host": "10.0.0.11", "site": "Sede", "access_direction": "saida"})
    monkeypatch.setattr(access_control_sync, "poll_events", lambda device, since_id="": [{
        "person_name_raw": "Aluno Teste",
        "occurred_at": "2026-08-20 11:55:00",
    }])

    access_control_sync.poll_device_events(device["id"])
    events = list_access_report_events({"site": "Sede", "type": "saida", "limit": 20})
    assert len(events) == 1
    assert events[0]["event_type"] == "saida"
```

- [ ] **Step 2: Run failing test**

Run: `python scripts/sightops_access_control_reports_test.py`
Expected: FAIL because poll does not apply device role.

- [ ] **Step 3: Normalize event type in polling**

In `poll_device_events()`, compute:

```python
event_type = event.get("event_type") or device.get("access_direction") or "entrada"
if event_type == "entrada_saida":
    event_type = "entrada"
```

Pass `device_name`, `device_role`, `source="device"`, `raw_event_id` and `raw_payload` into `record_event()`.

- [ ] **Step 4: Run test**

Run: `python scripts/sightops_access_control_reports_test.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/services/access_control_sync.py scripts/sightops_access_control_reports_test.py
git commit -m "feat(access-control): Respect device direction in event polling"
```

---

### Task 3: API de relatorios e saida manual

**Files:**
- Modify: `app/api/endpoints/access_control.py`
- Test: `scripts/sightops_access_control_reports_test.py`

**Interfaces:**
- Consumes: `list_access_report_events(filters: Dict[str, Any]) -> List[Dict[str, Any]]`
- Consumes: `record_manual_exit(person_id: str, site: str = "", reason: str = "", operator_user: str = "") -> Dict[str, Any]`
- Produces: `GET /api/access-control/reports/events`
- Produces: `GET /api/access-control/reports/summary`
- Produces: `POST /api/access-control/reports/manual-exit`

- [ ] **Step 1: Add endpoint smoke tests**

```python
def test_access_report_endpoints_exist():
    from app.api.endpoints import access_control

    routes = {route.path for route in access_control.router.routes}
    assert "/api/access-control/reports/events" in routes
    assert "/api/access-control/reports/summary" in routes
    assert "/api/access-control/reports/manual-exit" in routes
```

- [ ] **Step 2: Run failing test**

Run: `python scripts/sightops_access_control_reports_test.py`
Expected: FAIL because routes do not exist.

- [ ] **Step 3: Add request model**

```python
class AccessManualExitRequest(BaseModel):
    person_id: str
    site: str = ""
    reason: str = ""
```

- [ ] **Step 4: Add endpoints**

Implement:

```python
@router.get("/reports/events")
def api_access_control_report_events(...): ...

@router.get("/reports/summary")
def api_access_control_report_summary(...): ...

@router.post("/reports/manual-exit")
def api_access_control_manual_exit(req: AccessManualExitRequest): ...
```

Use `request.state.user` or equivalent existing auth context if available for `operator_user`; otherwise store empty string.

- [ ] **Step 5: Run test**

Run: `python scripts/sightops_access_control_reports_test.py`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/api/endpoints/access_control.py scripts/sightops_access_control_reports_test.py
git commit -m "feat(access-control): Add report and manual exit APIs"
```

---

### Task 4: Frontend de relatorios

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/accessControl.js`
- Modify: `frontend/styles.css`

**Interfaces:**
- Consumes: `GET /api/access-control/reports/events`
- Consumes: `GET /api/access-control/reports/summary`
- Consumes: `POST /api/access-control/reports/manual-exit`
- Produces: aba `Relatorios` com filtros, indicadores, tabela e modal de saida manual.

- [ ] **Step 1: Add HTML tab and panel**

Add a new tab button:

```html
<button type="button" class="tab-btn" data-access-tab="reports" role="tab" aria-selected="false">Relatorios</button>
```

Add a panel with IDs:

```html
<div class="access-tab-panel hidden" data-access-panel="reports">
  <div class="access-report-toolbar">
    <select id="accessReportPeriod">...</select>
    <input id="accessReportStart" type="date">
    <input id="accessReportEnd" type="date">
    <select id="accessReportType">...</select>
    <select id="accessReportSite">...</select>
    <input id="accessReportSearch" type="search" placeholder="Buscar pessoa, turma ou dispositivo">
    <button id="btnAccessManualExit" type="button" class="primary-action">Registrar saida</button>
  </div>
  <div class="metrics access-report-kpis">...</div>
  <table id="accessReportTable">...</table>
</div>
```

- [ ] **Step 2: Add JS state and loaders**

Create functions:

```javascript
async function loadAccessReports(force = false) { ... }
function renderAccessReportSummary(summary) { ... }
function renderAccessReportEvents(events) { ... }
function openAccessManualExitModal() { ... }
async function submitAccessManualExit() { ... }
```

Call `loadAccessReports(true)` when the active tab is `reports`.

- [ ] **Step 3: Add device direction field**

In the device modal, add/select:

```html
<select id="accessDeviceDirection">
  <option value="entrada">Entrada</option>
  <option value="saida">Saida</option>
  <option value="entrada_saida">Entrada e saida</option>
</select>
```

Include `access_direction` in device payload and render device list with label.

- [ ] **Step 4: Style reports**

Add compact report styles using existing table/card variables. Avoid nested cards inside cards. Keep filters in one row on desktop and wrapping on small screens.

- [ ] **Step 5: Syntax check**

Run:

```bash
node --check frontend/js/accessControl.js
```

Expected: no syntax errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/js/accessControl.js frontend/styles.css
git commit -m "feat(access-control): Add entry exit reports UI"
```

---

### Task 5: Homologation validation

**Files:**
- No source changes expected after this task.

**Interfaces:**
- Consumes: all tasks above.
- Produces: evidence that feature works and existing tabs still load.

- [ ] **Step 1: Run local checks**

Run:

```bash
python -m py_compile app/services/access_control_store.py app/services/access_control_sync.py app/api/endpoints/access_control.py
python scripts/sightops_access_control_reports_test.py
node --check frontend/js/accessControl.js
```

- [ ] **Step 2: Validate tabs manually in homologation**

Open homologation `/v2/` and check:

- Pessoas loads.
- Dispositivos loads.
- Grupos loads.
- Regras loads.
- Relatorios loads.

- [ ] **Step 3: Validate report flow**

Create or use one test person and one test device:

- Register an `entrada` event through the backend helper or real polling.
- Register `saida_manual` from the UI.
- Confirm report table shows both events.
- Confirm KPIs show entries/exits and present count.

- [ ] **Step 4: Validate tenant isolation**

Switch to another tenant and confirm the report does not show events from the first tenant.

- [ ] **Step 5: Final commit if needed**

```bash
git status --short
```

Only commit files changed by this feature.

---

## Self-Review

- Spec coverage: device roles, manual exit, report filters, KPIs, tenant isolation, WhatsApp status placeholder and multi-brand adapter boundary are covered.
- Placeholder scan: no TBD/TODO placeholders are used as implementation instructions.
- Type consistency: backend field is `access_direction`; event type is `event_type`; manual action is `saida_manual`.
- Scope check: WhatsApp delivery and full multi-brand firmware parsing stay outside this first implementation, but the schema/UI leave room for them.
