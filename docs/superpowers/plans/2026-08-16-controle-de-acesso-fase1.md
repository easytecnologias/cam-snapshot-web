# Controle de Acesso — Fase 1 (Dispositivo Dahua) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrar o SightOps com a catraca de reconhecimento facial Dahua ASI6214S-W (e compatíveis da mesma família), permitindo cadastrar grupos de pessoas e de portas, ligar os dois por regra de horário/dia, provisionar a credencial da pessoa automaticamente no equipamento, abrir a porta manualmente pelo painel, e gravar o histórico de entrada/saída reportado pelo dispositivo.

**Architecture:** Um cliente HTTP dedicado (`access_control_device.py`) fala o protocolo CGI com autenticação Digest da Dahua (já confirmado funcionando ao vivo em `10.10.13.33`, credenciais em `app/core/crypto`). Um módulo de orquestração (`access_control_sync.py`) resolve `pessoa → grupo → regra → grupo de porta → dispositivo` e chama o cliente; o mesmo módulo alimenta um loop periódico em `app/main.py` (mesmo padrão de `_olt_telemetry_loop`) que reenvia provisionamentos pendentes e busca eventos novos. Tudo isolado por `tenant_slug`, seguindo o padrão de `access_control_store.py`/`db_store.py` já existente.

**Tech Stack:** FastAPI, `requests` (Digest auth via `requests.auth.HTTPDigestAuth`), SQLite/Postgres via `db_store.py`, `app.core.crypto` (Fernet) pra senha do dispositivo, JS vanilla no frontend (mesmo padrão de `accessControl.js`).

## Global Constraints

- Toda tabela nova carrega `tenant_slug` e toda consulta filtra por `db_store._current_tenant_slug()` — isolamento entre clientes é inegociável neste projeto (violá-lo já causou vazamento real corrigido nesta mesma sessão).
- Senha de dispositivo cifrada com `app.core.crypto.encrypt`/`decrypt` — nunca texto puro (ver Global Constraint espelhando o achado da auditoria LGPD desta sessão sobre DVR/NVR).
- Nenhuma chamada ao dispositivo pode bloquear a resposta HTTP de salvar uma pessoa/regra — sempre via loop de fundo ou `asyncio.to_thread`.
- Erro do dispositivo (senha errada, offline, cheio) propagado com o texto real da Dahua, nunca uma mensagem genérica tipo "falha ao salvar".
- Seguir o padrão de teste já usado no projeto: scripts standalone em `scripts/sightops_*_test.py`, sem framework, com `assert` e `print("OK ...")`, usando `tempfile.TemporaryDirectory` + `db_store.SIGHTOPS_DB_PATH` pra isolar o banco de teste (ver `scripts/sightops_monitoring_test.py` como referência).

---

## File Structure

- **Modify** `app/services/access_control_store.py` — schema (coluna `site` em `access_people`, colunas novas em `access_devices`, tabelas `access_groups`, `access_group_members`, `access_door_groups`, `access_door_group_members`, `access_rules`, `access_events`, `access_provision_status`) + funções CRUD pra cada uma.
- **Create** `app/services/access_control_device.py` — cliente HTTP Digest pra falar com a catraca Dahua (`get_system_info`, `provision_person`, `remove_person`, `open_door`, `poll_events`).
- **Create** `app/services/access_control_sync.py` — orquestração: resolve dispositivos-alvo de uma pessoa, dispara provisionamento, retry de pendentes, polling de eventos por tenant.
- **Modify** `app/api/endpoints/access_control.py` — endpoints novos (devices, groups, door-groups, rules, open-door, sync, events).
- **Modify** `app/main.py` — registra o loop de fundo `_access_control_sync_loop`.
- **Modify** `frontend/js/accessControl.js` — UI de Dispositivos, Grupos, Regras, botão abrir porta, status de sincronização na ficha da pessoa.
- **Modify** `frontend/index.html` — markup das abas/modais novos dentro da view Controle de Acesso.
- **Modify** `frontend/styles.css` — estilos das abas/pills novos.
- **Create** `scripts/sightops_access_control_schema_test.py` — CRUD de groups/door-groups/rules/events/provision-status + isolamento entre tenants.
- **Create** `scripts/sightops_access_control_device_test.py` — cliente Dahua com HTTP mockado.
- **Create** `scripts/sightops_access_control_sync_test.py` — resolução de regra→dispositivo e orquestração de provisionamento/eventos com device client mockado.

---

## Task 1: Schema — coluna `site` em pessoas, colunas novas em dispositivos, tabelas de grupo

**Files:**
- Modify: `app/services/access_control_store.py`
- Test: `scripts/sightops_access_control_schema_test.py`

**Interfaces:**
- Produces: `ensure_access_control_schema()` (já existe, expandida), tabelas `access_groups`, `access_group_members`, `access_door_groups`, `access_door_group_members` no banco.

- [ ] **Step 1: Write the failing test**

Criar `scripts/sightops_access_control_schema_test.py`:

```python
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
from app.services import db_store
from app.services.access_control_store import (
    ensure_access_control_schema,
    save_person,
)


def test_person_has_site_column() -> None:
    token = set_current_tenant_slug("cliente-a")
    try:
        person = save_person({"full_name": "Joao Teste", "site": "Sede"})
        assert person["site"] == "Sede"
    finally:
        reset_current_tenant_slug(token)


def test_group_tables_exist() -> None:
    ensure_access_control_schema()
    with db_store._conn() as c:
        c.execute("INSERT INTO access_groups(id, tenant_slug, site, name) VALUES('g1','cliente-a','Sede','Alunos Manha')")
        c.execute("INSERT INTO access_door_groups(id, tenant_slug, site, name) VALUES('d1','cliente-a','Sede','Portao Principal')")
        c.execute("INSERT INTO access_group_members(tenant_slug, group_id, person_id) VALUES('cliente-a','g1','p1')")
        c.execute("INSERT INTO access_door_group_members(tenant_slug, door_group_id, device_id) VALUES('cliente-a','d1','dev1')")
        row = c.execute("SELECT name FROM access_groups WHERE id='g1'").fetchone()
        assert row["name"] == "Alunos Manha"


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="sightops-access-schema-") as tmp:
        db_store.SIGHTOPS_DB_PATH = Path(tmp) / "access.db"
        db_store.init_db()
        test_person_has_site_column()
        test_group_tables_exist()
    print("OK access control schema: site em pessoa + tabelas de grupo")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_schema_test.py`
Expected: FAIL — `KeyError: 'site'` (coluna não existe ainda) ou `sqlite3.OperationalError: no such table: access_groups`.

- [ ] **Step 3: Write minimal implementation**

Em `app/services/access_control_store.py`, dentro de `ensure_access_control_schema()`, adicionar ao script SQL existente (mantendo o `CREATE TABLE IF NOT EXISTS access_people`/`access_devices` como estão, só acrescentando):

```python
def ensure_access_control_schema() -> None:
    backend = db_store._db_backend()
    with db_store._conn() as c:
        db_store._exec_many_statements(
            c,
            backend,
            """
            CREATE TABLE IF NOT EXISTS access_people (
              id TEXT PRIMARY KEY,
              tenant_slug TEXT NOT NULL,
              full_name TEXT NOT NULL,
              person_type TEXT NOT NULL DEFAULT 'student',
              document_id TEXT NOT NULL DEFAULT '',
              enrollment_code TEXT NOT NULL DEFAULT '',
              class_name TEXT NOT NULL DEFAULT '',
              site TEXT NOT NULL DEFAULT '',
              guardian_name TEXT NOT NULL DEFAULT '',
              guardian_phone TEXT NOT NULL DEFAULT '',
              whatsapp_enabled INTEGER NOT NULL DEFAULT 1,
              active INTEGER NOT NULL DEFAULT 1,
              notes TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_access_people_tenant_name
              ON access_people(tenant_slug, full_name);
            CREATE INDEX IF NOT EXISTS idx_access_people_tenant_status
              ON access_people(tenant_slug, active, person_type);
            CREATE INDEX IF NOT EXISTS idx_access_people_tenant_site
              ON access_people(tenant_slug, site);

            CREATE TABLE IF NOT EXISTS access_devices (
              id TEXT PRIMARY KEY,
              tenant_slug TEXT NOT NULL,
              site TEXT NOT NULL DEFAULT '',
              name TEXT NOT NULL,
              vendor TEXT NOT NULL DEFAULT '',
              model TEXT NOT NULL DEFAULT '',
              host TEXT NOT NULL DEFAULT '',
              connector_id TEXT NOT NULL DEFAULT '',
              username TEXT NOT NULL DEFAULT '',
              password_enc TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL DEFAULT 'unknown',
              last_seen_at TEXT NOT NULL DEFAULT '',
              last_event_id TEXT NOT NULL DEFAULT '',
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_access_devices_tenant_site
              ON access_devices(tenant_slug, site, active);

            CREATE TABLE IF NOT EXISTS access_groups (
              id TEXT PRIMARY KEY,
              tenant_slug TEXT NOT NULL,
              site TEXT NOT NULL DEFAULT '',
              name TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_access_groups_tenant
              ON access_groups(tenant_slug, site, active);

            CREATE TABLE IF NOT EXISTS access_group_members (
              tenant_slug TEXT NOT NULL,
              group_id TEXT NOT NULL,
              person_id TEXT NOT NULL,
              PRIMARY KEY (tenant_slug, group_id, person_id)
            );
            CREATE INDEX IF NOT EXISTS idx_access_group_members_person
              ON access_group_members(tenant_slug, person_id);

            CREATE TABLE IF NOT EXISTS access_door_groups (
              id TEXT PRIMARY KEY,
              tenant_slug TEXT NOT NULL,
              site TEXT NOT NULL DEFAULT '',
              name TEXT NOT NULL,
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_access_door_groups_tenant
              ON access_door_groups(tenant_slug, site, active);

            CREATE TABLE IF NOT EXISTS access_door_group_members (
              tenant_slug TEXT NOT NULL,
              door_group_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              PRIMARY KEY (tenant_slug, door_group_id, device_id)
            );
            CREATE INDEX IF NOT EXISTS idx_access_door_group_members_device
              ON access_door_group_members(tenant_slug, device_id);
            """,
        )
```

E na assinatura de `save_person`/`_row_dict`, incluir o campo `site` (ver Task 1, Step 3b abaixo).

- [ ] **Step 3b: Adicionar `site` nas funções de pessoa existentes**

Em `save_person`, junto das outras leituras de payload:

```python
    site = _clean_text(payload.get("site"), 120)
```

E incluir `site` na tupla de `INSERT`/`ON CONFLICT DO UPDATE` (mesma posição relativa em `VALUES`, coluna, e `excluded.site` no `SET`) e no `SELECT` de `save_person`/`list_people` (adicionar `site` à lista de colunas selecionadas nos dois).

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_schema_test.py`
Expected: `OK access control schema: site em pessoa + tabelas de grupo`

- [ ] **Step 5: Commit**

```bash
git add app/services/access_control_store.py scripts/sightops_access_control_schema_test.py
git commit -m "feat(access-control): schema de site em pessoa e tabelas de grupo/porta"
```

---

## Task 2: CRUD de grupos, grupos de porta, membership e regras

**Files:**
- Modify: `app/services/access_control_store.py`
- Modify: `scripts/sightops_access_control_schema_test.py`

**Interfaces:**
- Consumes: tabelas da Task 1.
- Produces:
  - `list_groups(site: str = "") -> list[dict]`, `save_group(payload: dict) -> dict`, `delete_group(group_id: str) -> bool`
  - `set_group_members(group_id: str, person_ids: list[str]) -> None`, `list_group_members(group_id: str) -> list[str]`
  - `list_door_groups(site: str = "") -> list[dict]`, `save_door_group(payload: dict) -> dict`, `delete_door_group(door_group_id: str) -> bool`
  - `set_door_group_members(door_group_id: str, device_ids: list[str]) -> None`, `list_door_group_members(door_group_id: str) -> list[str]`
  - `list_rules() -> list[dict]`, `save_rule(payload: dict) -> dict`, `delete_rule(rule_id: str) -> bool`

- [ ] **Step 1: Write the failing test**

Adicionar em `scripts/sightops_access_control_schema_test.py`, antes de `main()`:

```python
def test_group_and_rule_crud() -> None:
    from app.services.access_control_store import (
        list_door_groups,
        list_group_members,
        list_groups,
        list_rules,
        save_door_group,
        save_group,
        save_rule,
        set_door_group_members,
        set_group_members,
    )

    token = set_current_tenant_slug("cliente-b")
    try:
        person = save_person({"full_name": "Maria Teste", "site": "Sede"})
        group = save_group({"name": "Alunos Manha", "site": "Sede"})
        set_group_members(group["id"], [person["id"]])
        assert list_group_members(group["id"]) == [person["id"]]
        assert list_groups()[0]["name"] == "Alunos Manha"

        door_group = save_door_group({"name": "Portao Principal", "site": "Sede"})
        set_door_group_members(door_group["id"], ["dev1"])
        assert list_door_groups()[0]["name"] == "Portao Principal"

        rule = save_rule({
            "people_group_id": group["id"],
            "door_group_id": door_group["id"],
            "weekdays": "12345",
            "time_start": "06:00",
            "time_end": "19:00",
        })
        assert rule["weekdays"] == "12345"
        assert list_rules()[0]["door_group_id"] == door_group["id"]
    finally:
        reset_current_tenant_slug(token)
```

E adicionar a chamada `test_group_and_rule_crud()` dentro de `main()`, depois de `test_group_tables_exist()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_schema_test.py`
Expected: FAIL — `ImportError: cannot import name 'list_groups'` (funções ainda não existem).

- [ ] **Step 3: Write minimal implementation**

Adicionar em `app/services/access_control_store.py`, depois da tabela `access_rules` (também precisa existir no schema do Step 1 da Task 1 — adicionar agora):

```python
            CREATE TABLE IF NOT EXISTS access_rules (
              id TEXT PRIMARY KEY,
              tenant_slug TEXT NOT NULL,
              people_group_id TEXT NOT NULL,
              door_group_id TEXT NOT NULL,
              weekdays TEXT NOT NULL DEFAULT '1234567',
              time_start TEXT NOT NULL DEFAULT '',
              time_end TEXT NOT NULL DEFAULT '',
              active INTEGER NOT NULL DEFAULT 1,
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_access_rules_tenant
              ON access_rules(tenant_slug, active);
```

(anexar esse bloco dentro da mesma string SQL de `ensure_access_control_schema` criada na Task 1, antes do fechamento das aspas triplas.)

E as funções, no fim do arquivo:

```python
def list_groups(site: str = "") -> List[Dict[str, Any]]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    where = ["tenant_slug = ?"]
    params: list[Any] = [tenant]
    if site:
        where.append("site = ?")
        params.append(_clean_text(site, 120))
    with db_store._conn() as c:
        rows = c.execute(
            f"SELECT * FROM access_groups WHERE {' AND '.join(where)} ORDER BY active DESC, name COLLATE NOCASE",
            tuple(params),
        ).fetchall()
    return [dict(r) for r in rows]


def save_group(payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    group_id = _clean_text(payload.get("id"), 80) or uuid.uuid4().hex
    name = _clean_text(payload.get("name"), 160)
    if not name:
        raise ValueError("Informe o nome do grupo.")
    site = _clean_text(payload.get("site"), 120)
    active = _bool_int(payload.get("active"), True)
    with db_store._conn() as c:
        c.execute(
            """
            INSERT INTO access_groups(id, tenant_slug, site, name, active, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              site=excluded.site, name=excluded.name, active=excluded.active, updated_at=datetime('now')
            WHERE access_groups.tenant_slug=excluded.tenant_slug
            """,
            (group_id, tenant, site, name, active),
        )
        row = c.execute("SELECT * FROM access_groups WHERE tenant_slug=? AND id=?", (tenant, group_id)).fetchone()
    if row is None:
        raise ValueError("Grupo nao encontrado neste cliente.")
    return dict(row)


def delete_group(group_id: str) -> bool:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    gid = _clean_text(group_id, 80)
    if not gid:
        return False
    with db_store._conn() as c:
        cur = c.execute("DELETE FROM access_groups WHERE tenant_slug=? AND id=?", (tenant, gid))
        c.execute("DELETE FROM access_group_members WHERE tenant_slug=? AND group_id=?", (tenant, gid))
        return int(cur.rowcount or 0) > 0


def set_group_members(group_id: str, person_ids: List[str]) -> None:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    gid = _clean_text(group_id, 80)
    with db_store._conn() as c:
        c.execute("DELETE FROM access_group_members WHERE tenant_slug=? AND group_id=?", (tenant, gid))
        for pid in person_ids:
            clean_pid = _clean_text(pid, 80)
            if clean_pid:
                c.execute(
                    "INSERT OR IGNORE INTO access_group_members(tenant_slug, group_id, person_id) VALUES(?, ?, ?)",
                    (tenant, gid, clean_pid),
                )


def list_group_members(group_id: str) -> List[str]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    gid = _clean_text(group_id, 80)
    with db_store._conn() as c:
        rows = c.execute(
            "SELECT person_id FROM access_group_members WHERE tenant_slug=? AND group_id=?", (tenant, gid)
        ).fetchall()
    return [r["person_id"] for r in rows]


def list_door_groups(site: str = "") -> List[Dict[str, Any]]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    where = ["tenant_slug = ?"]
    params: list[Any] = [tenant]
    if site:
        where.append("site = ?")
        params.append(_clean_text(site, 120))
    with db_store._conn() as c:
        rows = c.execute(
            f"SELECT * FROM access_door_groups WHERE {' AND '.join(where)} ORDER BY active DESC, name COLLATE NOCASE",
            tuple(params),
        ).fetchall()
    return [dict(r) for r in rows]


def save_door_group(payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    door_group_id = _clean_text(payload.get("id"), 80) or uuid.uuid4().hex
    name = _clean_text(payload.get("name"), 160)
    if not name:
        raise ValueError("Informe o nome do grupo de portas.")
    site = _clean_text(payload.get("site"), 120)
    active = _bool_int(payload.get("active"), True)
    with db_store._conn() as c:
        c.execute(
            """
            INSERT INTO access_door_groups(id, tenant_slug, site, name, active, created_at, updated_at)
            VALUES(?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              site=excluded.site, name=excluded.name, active=excluded.active, updated_at=datetime('now')
            WHERE access_door_groups.tenant_slug=excluded.tenant_slug
            """,
            (door_group_id, tenant, site, name, active),
        )
        row = c.execute(
            "SELECT * FROM access_door_groups WHERE tenant_slug=? AND id=?", (tenant, door_group_id)
        ).fetchone()
    if row is None:
        raise ValueError("Grupo de portas nao encontrado neste cliente.")
    return dict(row)


def delete_door_group(door_group_id: str) -> bool:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    did = _clean_text(door_group_id, 80)
    if not did:
        return False
    with db_store._conn() as c:
        cur = c.execute("DELETE FROM access_door_groups WHERE tenant_slug=? AND id=?", (tenant, did))
        c.execute("DELETE FROM access_door_group_members WHERE tenant_slug=? AND door_group_id=?", (tenant, did))
        return int(cur.rowcount or 0) > 0


def set_door_group_members(door_group_id: str, device_ids: List[str]) -> None:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    did = _clean_text(door_group_id, 80)
    with db_store._conn() as c:
        c.execute("DELETE FROM access_door_group_members WHERE tenant_slug=? AND door_group_id=?", (tenant, did))
        for dev_id in device_ids:
            clean_dev = _clean_text(dev_id, 80)
            if clean_dev:
                c.execute(
                    "INSERT OR IGNORE INTO access_door_group_members(tenant_slug, door_group_id, device_id) VALUES(?, ?, ?)",
                    (tenant, did, clean_dev),
                )


def list_door_group_members(door_group_id: str) -> List[str]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    did = _clean_text(door_group_id, 80)
    with db_store._conn() as c:
        rows = c.execute(
            "SELECT device_id FROM access_door_group_members WHERE tenant_slug=? AND door_group_id=?", (tenant, did)
        ).fetchall()
    return [r["device_id"] for r in rows]


def list_rules() -> List[Dict[str, Any]]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    with db_store._conn() as c:
        rows = c.execute(
            "SELECT * FROM access_rules WHERE tenant_slug=? ORDER BY active DESC, created_at",
            (tenant,),
        ).fetchall()
    return [dict(r) for r in rows]


def save_rule(payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    rule_id = _clean_text(payload.get("id"), 80) or uuid.uuid4().hex
    people_group_id = _clean_text(payload.get("people_group_id"), 80)
    door_group_id = _clean_text(payload.get("door_group_id"), 80)
    if not people_group_id or not door_group_id:
        raise ValueError("Informe o grupo de pessoas e o grupo de portas.")
    weekdays = re.sub(r"[^1-7]", "", str(payload.get("weekdays") or "1234567")) or "1234567"
    time_start = _clean_text(payload.get("time_start"), 5)
    time_end = _clean_text(payload.get("time_end"), 5)
    active = _bool_int(payload.get("active"), True)
    with db_store._conn() as c:
        c.execute(
            """
            INSERT INTO access_rules(
              id, tenant_slug, people_group_id, door_group_id, weekdays, time_start, time_end,
              active, created_at, updated_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              people_group_id=excluded.people_group_id,
              door_group_id=excluded.door_group_id,
              weekdays=excluded.weekdays,
              time_start=excluded.time_start,
              time_end=excluded.time_end,
              active=excluded.active,
              updated_at=datetime('now')
            WHERE access_rules.tenant_slug=excluded.tenant_slug
            """,
            (rule_id, tenant, people_group_id, door_group_id, weekdays, time_start, time_end, active),
        )
        row = c.execute("SELECT * FROM access_rules WHERE tenant_slug=? AND id=?", (tenant, rule_id)).fetchone()
    if row is None:
        raise ValueError("Regra nao encontrada neste cliente.")
    return dict(row)


def delete_rule(rule_id: str) -> bool:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    rid = _clean_text(rule_id, 80)
    if not rid:
        return False
    with db_store._conn() as c:
        cur = c.execute("DELETE FROM access_rules WHERE tenant_slug=? AND id=?", (tenant, rid))
        return int(cur.rowcount or 0) > 0
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_schema_test.py`
Expected: `OK access control schema: site em pessoa + tabelas de grupo`

- [ ] **Step 5: Commit**

```bash
git add app/services/access_control_store.py scripts/sightops_access_control_schema_test.py
git commit -m "feat(access-control): CRUD de grupos, grupos de porta e regras"
```

---

## Task 3: Tabelas e funções de dispositivo, evento e status de provisionamento

**Files:**
- Modify: `app/services/access_control_store.py`
- Modify: `scripts/sightops_access_control_schema_test.py`

**Interfaces:**
- Produces:
  - `list_devices(site: str = "") -> list[dict]`, `save_device(payload: dict) -> dict` (senha cifrada via `app.core.crypto.encrypt` antes de gravar, nunca retornada em texto puro), `delete_device(device_id: str) -> bool`, `get_device_with_password(device_id: str) -> dict | None` (única função que devolve senha decifrada — só pra uso interno do cliente Dahua)
  - `record_event(event: dict) -> str` (retorna `id` gerado), `list_events(person_id: str = "", site: str = "", limit: int = 200) -> list[dict]`
  - `upsert_provision_status(person_id: str, device_id: str, status: str, last_error: str = "") -> None`, `list_pending_provisions() -> list[dict]`

- [ ] **Step 1: Write the failing test**

Adicionar em `scripts/sightops_access_control_schema_test.py`:

```python
def test_device_event_and_provision_status() -> None:
    from app.services.access_control_store import (
        get_device_with_password,
        list_devices,
        list_events,
        list_pending_provisions,
        record_event,
        save_device,
        upsert_provision_status,
    )

    token = set_current_tenant_slug("cliente-c")
    try:
        device = save_device({
            "name": "Catraca Portao",
            "site": "Sede",
            "vendor": "dahua",
            "model": "ASI6214S-W",
            "host": "10.10.13.33",
            "username": "admin",
            "password": "xzydsP2011",
        })
        assert "password" not in device and "password_enc" not in device
        full = get_device_with_password(device["id"])
        assert full["password"] == "xzydsP2011"
        assert list_devices()[0]["host"] == "10.10.13.33"

        event_id = record_event({
            "device_id": device["id"],
            "site": "Sede",
            "person_id": "p1",
            "person_name_raw": "Joao Teste",
            "event_type": "entrada",
            "occurred_at": "2026-08-16T07:55:00",
        })
        assert event_id
        events = list_events(person_id="p1")
        assert events[0]["event_type"] == "entrada"

        upsert_provision_status("p1", device["id"], "pending")
        pending = list_pending_provisions()
        assert pending[0]["person_id"] == "p1" and pending[0]["status"] == "pending"
        upsert_provision_status("p1", device["id"], "ok")
        assert list_pending_provisions() == []
    finally:
        reset_current_tenant_slug(token)
```

E adicionar a chamada em `main()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_schema_test.py`
Expected: FAIL — `ImportError: cannot import name 'save_device'`.

- [ ] **Step 3: Write minimal implementation**

Adicionar ao schema SQL da Task 1 (dentro da mesma string, dois blocos a mais):

```python
            CREATE TABLE IF NOT EXISTS access_events (
              id TEXT PRIMARY KEY,
              tenant_slug TEXT NOT NULL,
              site TEXT NOT NULL DEFAULT '',
              device_id TEXT NOT NULL,
              person_id TEXT NOT NULL DEFAULT '',
              person_name_raw TEXT NOT NULL DEFAULT '',
              event_type TEXT NOT NULL,
              occurred_at TEXT NOT NULL,
              synced_at TEXT NOT NULL DEFAULT (datetime('now'))
            );
            CREATE INDEX IF NOT EXISTS idx_access_events_tenant_time
              ON access_events(tenant_slug, occurred_at DESC);
            CREATE INDEX IF NOT EXISTS idx_access_events_person
              ON access_events(tenant_slug, person_id, occurred_at DESC);

            CREATE TABLE IF NOT EXISTS access_provision_status (
              tenant_slug TEXT NOT NULL,
              person_id TEXT NOT NULL,
              device_id TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'pending',
              last_error TEXT NOT NULL DEFAULT '',
              updated_at TEXT NOT NULL DEFAULT (datetime('now')),
              PRIMARY KEY (tenant_slug, person_id, device_id)
            );
            CREATE INDEX IF NOT EXISTS idx_access_provision_status_pending
              ON access_provision_status(tenant_slug, status);
```

E as funções, no fim do arquivo (novo import no topo: `from app.core.crypto import decrypt, encrypt`):

```python
def _device_row_dict(row: Any) -> Dict[str, Any]:
    data = dict(row)
    data.pop("password_enc", None)
    data["active"] = bool(int(data.get("active") or 0))
    return data


def list_devices(site: str = "") -> List[Dict[str, Any]]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    where = ["tenant_slug = ?"]
    params: list[Any] = [tenant]
    if site:
        where.append("site = ?")
        params.append(_clean_text(site, 120))
    with db_store._conn() as c:
        rows = c.execute(
            f"SELECT * FROM access_devices WHERE {' AND '.join(where)} ORDER BY active DESC, name COLLATE NOCASE",
            tuple(params),
        ).fetchall()
    return [_device_row_dict(r) for r in rows]


def save_device(payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    device_id = _clean_text(payload.get("id"), 80) or uuid.uuid4().hex
    name = _clean_text(payload.get("name"), 160)
    if not name:
        raise ValueError("Informe o nome do dispositivo.")
    site = _clean_text(payload.get("site"), 120)
    vendor = _clean_text(payload.get("vendor"), 60)
    model = _clean_text(payload.get("model"), 60)
    host = _clean_text(payload.get("host"), 120)
    connector_id = _clean_text(payload.get("connector_id"), 80)
    username = _clean_text(payload.get("username"), 80)
    active = _bool_int(payload.get("active"), True)
    raw_password = payload.get("password")
    with db_store._conn() as c:
        if raw_password:
            password_enc = encrypt(str(raw_password))
            c.execute(
                """
                INSERT INTO access_devices(
                  id, tenant_slug, site, name, vendor, model, host, connector_id, username,
                  password_enc, active, created_at, updated_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                  site=excluded.site, name=excluded.name, vendor=excluded.vendor, model=excluded.model,
                  host=excluded.host, connector_id=excluded.connector_id, username=excluded.username,
                  password_enc=excluded.password_enc, active=excluded.active, updated_at=datetime('now')
                WHERE access_devices.tenant_slug=excluded.tenant_slug
                """,
                (device_id, tenant, site, name, vendor, model, host, connector_id, username, password_enc, active),
            )
        else:
            c.execute(
                """
                INSERT INTO access_devices(
                  id, tenant_slug, site, name, vendor, model, host, connector_id, username,
                  active, created_at, updated_at
                )
                VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                  site=excluded.site, name=excluded.name, vendor=excluded.vendor, model=excluded.model,
                  host=excluded.host, connector_id=excluded.connector_id, username=excluded.username,
                  active=excluded.active, updated_at=datetime('now')
                WHERE access_devices.tenant_slug=excluded.tenant_slug
                """,
                (device_id, tenant, site, name, vendor, model, host, connector_id, username, active),
            )
        row = c.execute("SELECT * FROM access_devices WHERE tenant_slug=? AND id=?", (tenant, device_id)).fetchone()
    if row is None:
        raise ValueError("Dispositivo nao encontrado neste cliente.")
    return _device_row_dict(row)


def delete_device(device_id: str) -> bool:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    did = _clean_text(device_id, 80)
    if not did:
        return False
    with db_store._conn() as c:
        cur = c.execute("DELETE FROM access_devices WHERE tenant_slug=? AND id=?", (tenant, did))
        c.execute("DELETE FROM access_door_group_members WHERE tenant_slug=? AND device_id=?", (tenant, did))
        c.execute("DELETE FROM access_provision_status WHERE tenant_slug=? AND device_id=?", (tenant, did))
        return int(cur.rowcount or 0) > 0


def get_device_with_password(device_id: str) -> Dict[str, Any] | None:
    """Uso interno (access_control_device.py) -- unica funcao que devolve a senha decifrada."""
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    did = _clean_text(device_id, 80)
    with db_store._conn() as c:
        row = c.execute("SELECT * FROM access_devices WHERE tenant_slug=? AND id=?", (tenant, did)).fetchone()
    if row is None:
        return None
    data = dict(row)
    enc = data.pop("password_enc", "")
    data["password"] = decrypt(enc) if enc else ""
    data["active"] = bool(int(data.get("active") or 0))
    return data


def record_event(event: Dict[str, Any]) -> str:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    event_id = uuid.uuid4().hex
    with db_store._conn() as c:
        c.execute(
            """
            INSERT INTO access_events(
              id, tenant_slug, site, device_id, person_id, person_name_raw, event_type,
              occurred_at, synced_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
            """,
            (
                event_id,
                tenant,
                _clean_text(event.get("site"), 120),
                _clean_text(event.get("device_id"), 80),
                _clean_text(event.get("person_id"), 80),
                _clean_text(event.get("person_name_raw"), 160),
                _clean_text(event.get("event_type"), 20) or "entrada",
                _clean_text(event.get("occurred_at"), 40),
            ),
        )
    return event_id


def list_events(person_id: str = "", site: str = "", limit: int = 200) -> List[Dict[str, Any]]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    where = ["tenant_slug = ?"]
    params: list[Any] = [tenant]
    if person_id:
        where.append("person_id = ?")
        params.append(_clean_text(person_id, 80))
    if site:
        where.append("site = ?")
        params.append(_clean_text(site, 120))
    with db_store._conn() as c:
        rows = c.execute(
            f"SELECT * FROM access_events WHERE {' AND '.join(where)} ORDER BY occurred_at DESC LIMIT ?",
            tuple(params) + (max(1, min(int(limit or 200), 1000)),),
        ).fetchall()
    return [dict(r) for r in rows]


def upsert_provision_status(person_id: str, device_id: str, status: str, last_error: str = "") -> None:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    pid = _clean_text(person_id, 80)
    did = _clean_text(device_id, 80)
    with db_store._conn() as c:
        c.execute(
            """
            INSERT INTO access_provision_status(tenant_slug, person_id, device_id, status, last_error, updated_at)
            VALUES(?, ?, ?, ?, ?, datetime('now'))
            ON CONFLICT(tenant_slug, person_id, device_id) DO UPDATE SET
              status=excluded.status, last_error=excluded.last_error, updated_at=datetime('now')
            """,
            (tenant, pid, did, _clean_text(status, 20) or "pending", _clean_text(last_error, 500)),
        )


def list_pending_provisions() -> List[Dict[str, Any]]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    with db_store._conn() as c:
        rows = c.execute(
            "SELECT * FROM access_provision_status WHERE tenant_slug=? AND status IN ('pending','failed')",
            (tenant,),
        ).fetchall()
    return [dict(r) for r in rows]


def list_provision_status_for_person(person_id: str) -> List[Dict[str, Any]]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    pid = _clean_text(person_id, 80)
    with db_store._conn() as c:
        rows = c.execute(
            "SELECT * FROM access_provision_status WHERE tenant_slug=? AND person_id=?", (tenant, pid)
        ).fetchall()
    return [dict(r) for r in rows]
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_schema_test.py`
Expected: `OK access control schema: site em pessoa + tabelas de grupo`

- [ ] **Step 5: Commit**

```bash
git add app/services/access_control_store.py scripts/sightops_access_control_schema_test.py
git commit -m "feat(access-control): dispositivo com senha cifrada, eventos e status de provisionamento"
```

---

## Task 4: Cliente HTTP Digest da Dahua

**Files:**
- Create: `app/services/access_control_device.py`
- Create: `scripts/sightops_access_control_device_test.py`

**Interfaces:**
- Consumes: `requests.auth.HTTPDigestAuth`.
- Produces:
  - `get_system_info(device: dict) -> dict` — `device` é o dict de `get_device_with_password` (tem `host`, `username`, `password`).
  - `open_door(device: dict, channel: int = 1) -> dict`
  - `provision_person(device: dict, person: dict, photo_bytes: bytes | None = None) -> dict`
  - `poll_events(device: dict, since_id: str = "") -> list[dict]` — cada item: `{"event_type": "entrada"|"saida"|"negado", "person_name_raw": str, "occurred_at": str, "raw_id": str}`

- [ ] **Step 1: Write the failing test**

Criar `scripts/sightops_access_control_device_test.py`:

```python
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_device_test.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.access_control_device'`.

- [ ] **Step 3: Write minimal implementation**

Criar `app/services/access_control_device.py`:

```python
from __future__ import annotations

from typing import Any, Dict, List
from urllib.parse import quote

import requests
from fastapi import HTTPException
from requests.auth import HTTPDigestAuth

_TIMEOUT = 10.0


def _base_url(device: Dict[str, Any]) -> str:
    host = str(device.get("host") or "").strip()
    if not host:
        raise HTTPException(status_code=400, detail="Dispositivo sem host configurado.")
    return f"http://{host}"


def _auth(device: Dict[str, Any]) -> HTTPDigestAuth:
    return HTTPDigestAuth(str(device.get("username") or "admin"), str(device.get("password") or ""))


def _get(device: Dict[str, Any], path: str, params: Dict[str, Any] | None = None) -> requests.Response:
    url = f"{_base_url(device)}{path}"
    try:
        resp = requests.get(url, auth=_auth(device), params=params, timeout=_TIMEOUT)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel falar com o dispositivo: {exc}") from exc
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Usuario/senha invalidos no dispositivo.")
    resp.raise_for_status()
    return resp


def _parse_kv_text(text: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        out[key.strip()] = value.strip()
    return out


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


def provision_person(device: Dict[str, Any], person: Dict[str, Any], photo_bytes: bytes | None = None) -> Dict[str, Any]:
    full_name = str(person.get("full_name") or "").strip()
    person_id = str(person.get("id") or "").strip()
    if not full_name or not person_id:
        raise HTTPException(status_code=400, detail="Pessoa sem nome/id para provisionar.")
    info = {
        "UserID": person_id,
        "UserName": full_name,
        "UserType": 0,
        "Doors": [0],
        "ValidFrom": "2020-01-01 00:00:00",
        "ValidTo": "2037-12-31 23:59:59",
    }
    files = {"json": (None, str({"action": "insertMulti", "Info": [info]}))}
    if photo_bytes:
        files["Photo"] = ("face.jpg", photo_bytes, "image/jpeg")
    url = f"{_base_url(device)}/cgi-bin/AccessUser.cgi"
    try:
        resp = requests.post(url, auth=_auth(device), files=files, timeout=_TIMEOUT)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel provisionar no dispositivo: {exc}") from exc
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Usuario/senha invalidos no dispositivo.")
    resp.raise_for_status()
    text = (resp.text or "").strip()
    if "Error" in text or "error" in text:
        raise HTTPException(status_code=502, detail=f"Dispositivo recusou o cadastro: {text}")
    return {"ok": True, "raw": text}


def remove_person(device: Dict[str, Any], person_id: str) -> Dict[str, Any]:
    url = f"{_base_url(device)}/cgi-bin/AccessUser.cgi"
    files = {"json": (None, str({"action": "removeMulti", "UserIDList": [str(person_id)]}))}
    try:
        resp = requests.post(url, auth=_auth(device), files=files, timeout=_TIMEOUT)
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Nao foi possivel remover no dispositivo: {exc}") from exc
    resp.raise_for_status()
    return {"ok": True, "raw": (resp.text or "").strip()}


def poll_events(device: Dict[str, Any], since_id: str = "") -> List[Dict[str, Any]]:
    """Placeholder de parsing -- shape real confirmado/ajustado na Task 4 Step 6 (smoke test ao vivo)."""
    resp = _get(device, "/cgi-bin/accessControl.cgi", {"action": "getRecordList", "sinceId": since_id})
    text = (resp.text or "").strip()
    events: List[Dict[str, Any]] = []
    for line in text.splitlines():
        parts = line.split(",")
        if len(parts) < 3:
            continue
        events.append({
            "raw_id": parts[0],
            "occurred_at": parts[1],
            "person_name_raw": parts[2],
            "event_type": "entrada",
        })
    return events
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_device_test.py`
Expected: `OK access control device client: getSystemInfo, openDoor`

- [ ] **Step 5: Commit**

```bash
git add app/services/access_control_device.py scripts/sightops_access_control_device_test.py
git commit -m "feat(access-control): cliente HTTP Digest para catraca Dahua"
```

- [ ] **Step 6: Smoke test ao vivo contra o dispositivo real (10.10.13.33) e ajuste de `poll_events`/`provision_person`**

`poll_events` e o parsing de `provision_person` acima são a melhor hipótese com base na API pública da Dahua para Controle de Acesso, mas **não foram confirmados byte-a-byte contra este firmware** (só `getSystemInfo`/`magicBox.cgi` foi validado ao vivo nesta sessão). Antes de considerar a Task 4 fechada:

1. Rodar manualmente contra `10.10.13.33` (mesmo padrão usado pra validar o parser da OLT 4840E nesta sessão — comparar a saída real com o que o parser espera):
   ```bash
   curl -s --digest -u admin:xzydsP2011 'http://10.10.13.33/cgi-bin/accessControl.cgi?action=openDoor&channel=1&UserID=SightOps&Type=Remote'
   curl -s --digest -u admin:xzydsP2011 'http://10.10.13.33/cgi-bin/accessControl.cgi?action=getRecordList'
   ```
2. Se o formato de resposta real divergir do parser acima (schema de campos, delimitador, nome da action), ajustar `poll_events`/`provision_person`/`open_door` pra bater com o texto real devolvido — igual foi feito com `_PON_LINE_RE` da OLT 4840E nesta mesma sessão (parser ajustado a partir do dado real, não do que a documentação genérica sugere).
3. Atualizar os `assert` de `scripts/sightops_access_control_device_test.py` pra refletir o formato confirmado, re-rodar o teste, e comitar a correção separadamente com o texto real observado citado na mensagem do commit (mesmo padrão das entradas de `docs/HANDOFF_AGENTES.md` desta sessão).

---

## Task 5: Orquestração — resolver dispositivos-alvo de uma pessoa e provisionar

**Files:**
- Create: `app/services/access_control_sync.py`
- Create: `scripts/sightops_access_control_sync_test.py`

**Interfaces:**
- Consumes: `access_control_store.{list_group_members, list_rules, list_door_group_members, list_devices, get_device_with_password, upsert_provision_status}`, `access_control_device.provision_person`.
- Produces: `resolve_target_devices_for_person(person_id: str) -> list[dict]`, `provision_person_everywhere(person: dict) -> dict` (retorna `{"ok": bool, "results": [{"device_id": str, "status": "ok"|"failed", "error": str}]}`).

- [ ] **Step 1: Write the failing test**

Criar `scripts/sightops_access_control_sync_test.py`:

```python
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
from app.services import db_store
from app.services.access_control_store import (
    save_device,
    save_door_group,
    save_group,
    save_person,
    save_rule,
    set_door_group_members,
    set_group_members,
    list_provision_status_for_person,
)
from app.services.access_control_sync import provision_person_everywhere, resolve_target_devices_for_person


def test_resolve_and_provision() -> None:
    token = set_current_tenant_slug("cliente-sync")
    try:
        person = save_person({"full_name": "Ana Teste", "site": "Sede"})
        device = save_device({
            "name": "Catraca Portao", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.33", "username": "admin", "password": "xzydsP2011",
        })
        group = save_group({"name": "Alunos", "site": "Sede"})
        set_group_members(group["id"], [person["id"]])
        door_group = save_door_group({"name": "Portao", "site": "Sede"})
        set_door_group_members(door_group["id"], [device["id"]])
        save_rule({"people_group_id": group["id"], "door_group_id": door_group["id"]})

        targets = resolve_target_devices_for_person(person["id"])
        assert len(targets) == 1 and targets[0]["id"] == device["id"]

        with patch("app.services.access_control_sync.provision_person", return_value={"ok": True, "raw": "OK"}):
            result = provision_person_everywhere(person)
        assert result["ok"] is True
        assert result["results"][0]["device_id"] == device["id"]
        assert result["results"][0]["status"] == "ok"
        status = list_provision_status_for_person(person["id"])
        assert status[0]["status"] == "ok"
    finally:
        reset_current_tenant_slug(token)


def test_provision_failure_is_recorded_not_raised() -> None:
    from fastapi import HTTPException

    token = set_current_tenant_slug("cliente-sync-2")
    try:
        person = save_person({"full_name": "Bruno Teste", "site": "Sede"})
        device = save_device({
            "name": "Catraca Portao", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.33", "username": "admin", "password": "xzydsP2011",
        })
        group = save_group({"name": "Alunos", "site": "Sede"})
        set_group_members(group["id"], [person["id"]])
        door_group = save_door_group({"name": "Portao", "site": "Sede"})
        set_door_group_members(door_group["id"], [device["id"]])
        save_rule({"people_group_id": group["id"], "door_group_id": door_group["id"]})

        with patch(
            "app.services.access_control_sync.provision_person",
            side_effect=HTTPException(status_code=502, detail="device is full"),
        ):
            result = provision_person_everywhere(person)
        assert result["ok"] is False
        assert result["results"][0]["status"] == "failed"
        assert "device is full" in result["results"][0]["error"]
        status = list_provision_status_for_person(person["id"])
        assert status[0]["status"] == "failed"
        assert "device is full" in status[0]["last_error"]
    finally:
        reset_current_tenant_slug(token)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="sightops-access-sync-") as tmp:
        db_store.SIGHTOPS_DB_PATH = Path(tmp) / "access.db"
        db_store.init_db()
        test_resolve_and_provision()
        test_provision_failure_is_recorded_not_raised()
    print("OK access control sync: resolucao de regra e provisionamento nao bloqueante")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_sync_test.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'app.services.access_control_sync'`.

- [ ] **Step 3: Write minimal implementation**

Criar `app/services/access_control_sync.py`:

```python
from __future__ import annotations

import logging
from typing import Any, Dict, List

from fastapi import HTTPException

from app.services.access_control_device import poll_events, provision_person
from app.services.access_control_store import (
    get_device_with_password,
    list_devices,
    list_door_group_members,
    list_group_members,
    list_groups,
    list_pending_provisions,
    list_rules,
    record_event,
    upsert_provision_status,
)

logger = logging.getLogger("cam-snapshot")


def resolve_target_devices_for_person(person_id: str) -> List[Dict[str, Any]]:
    """Pessoa -> grupos que ela participa -> regras ativas -> grupos de porta -> dispositivos (unico por id)."""
    person_groups = {
        group["id"]
        for group in list_groups()
        if person_id in list_group_members(group["id"])
    }
    if not person_groups:
        return []
    door_group_ids = {
        rule["door_group_id"]
        for rule in list_rules()
        if rule.get("active") and rule.get("people_group_id") in person_groups
    }
    if not door_group_ids:
        return []
    device_ids: set[str] = set()
    for door_group_id in door_group_ids:
        device_ids.update(list_door_group_members(door_group_id))
    devices_by_id = {d["id"]: d for d in list_devices() if d.get("active")}
    return [devices_by_id[did] for did in device_ids if did in devices_by_id]


def provision_person_everywhere(person: Dict[str, Any]) -> Dict[str, Any]:
    targets = resolve_target_devices_for_person(person["id"])
    results: List[Dict[str, Any]] = []
    overall_ok = True
    for device in targets:
        upsert_provision_status(person["id"], device["id"], "pending")
        full_device = get_device_with_password(device["id"])
        try:
            provision_person(full_device, person)
            upsert_provision_status(person["id"], device["id"], "ok")
            results.append({"device_id": device["id"], "status": "ok", "error": ""})
        except HTTPException as exc:
            overall_ok = False
            error_text = str(exc.detail)
            upsert_provision_status(person["id"], device["id"], "failed", error_text)
            results.append({"device_id": device["id"], "status": "failed", "error": error_text})
            logger.warning("Falha ao provisionar pessoa %s no dispositivo %s: %s", person["id"], device["id"], error_text)
    return {"ok": overall_ok, "results": results}


def retry_pending_provisions() -> Dict[str, Any]:
    from app.services.access_control_store import list_people  # import tardio evita ciclo

    pending = list_pending_provisions()
    if not pending:
        return {"ok": True, "retried": 0}
    people_by_id = {p["id"]: p for p in list_people()}
    retried = 0
    for item in pending:
        person = people_by_id.get(item["person_id"])
        device = get_device_with_password(item["device_id"])
        if not person or not device:
            continue
        try:
            provision_person(device, person)
            upsert_provision_status(item["person_id"], item["device_id"], "ok")
        except HTTPException as exc:
            upsert_provision_status(item["person_id"], item["device_id"], "failed", str(exc.detail))
        retried += 1
    return {"ok": True, "retried": retried}


def poll_device_events(device_id: str) -> int:
    device = get_device_with_password(device_id)
    if not device:
        return 0
    events = poll_events(device, since_id=device.get("last_event_id") or "")
    for event in events:
        record_event({
            "site": device.get("site", ""),
            "device_id": device_id,
            "person_id": "",
            "person_name_raw": event.get("person_name_raw", ""),
            "event_type": event.get("event_type", "entrada"),
            "occurred_at": event.get("occurred_at", ""),
        })
    return len(events)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_sync_test.py`
Expected: `OK access control sync: resolucao de regra e provisionamento nao bloqueante`

- [ ] **Step 5: Commit**

```bash
git add app/services/access_control_sync.py scripts/sightops_access_control_sync_test.py
git commit -m "feat(access-control): resolve regra->dispositivo e provisiona sem bloquear"
```

---

## Task 6: Endpoints — dispositivos, grupos, grupos de porta, regras, abrir porta, sync manual, eventos

**Files:**
- Modify: `app/api/endpoints/access_control.py`
- Create: `scripts/sightops_access_control_routes_test.py`

**Interfaces:**
- Consumes: tudo de `access_control_store.py` e `access_control_sync.py`.
- Produces: rotas HTTP novas sob `/api/access-control/*`.

- [ ] **Step 1: Write the failing test**

Criar `scripts/sightops_access_control_routes_test.py` (verifica só que as rotas existem e usam os módulos certos, sem subir servidor de verdade — mesmo padrão de `sightops_olt_routes_test.py`):

```python
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.api.endpoints.access_control import router


def test_new_routes_registered() -> None:
    paths = {(route.path, tuple(sorted(route.methods))) for route in router.routes}
    expected = {
        ("/api/access-control/devices", ("GET", "POST")),
        ("/api/access-control/devices/{device_id}", ("DELETE",)),
        ("/api/access-control/devices/{device_id}/open-door", ("POST",)),
        ("/api/access-control/groups", ("GET", "POST")),
        ("/api/access-control/groups/{group_id}", ("DELETE",)),
        ("/api/access-control/door-groups", ("GET", "POST")),
        ("/api/access-control/door-groups/{door_group_id}", ("DELETE",)),
        ("/api/access-control/rules", ("GET", "POST")),
        ("/api/access-control/rules/{rule_id}", ("DELETE",)),
        ("/api/access-control/people/{person_id}/sync", ("POST",)),
        ("/api/access-control/events", ("GET",)),
    }
    missing = expected - paths
    assert not missing, f"rotas faltando: {missing}"


def main() -> None:
    test_new_routes_registered()
    print("OK access control routes: dispositivos, grupos, regras, sync e eventos registrados")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_routes_test.py`
Expected: FAIL — `AssertionError: rotas faltando: {...}` (nenhuma rota nova existe ainda).

- [ ] **Step 3: Write minimal implementation**

Em `app/api/endpoints/access_control.py`, expandir os imports e adicionar as rotas:

```python
from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.services.access_control_store import (
    access_control_summary,
    delete_device,
    delete_door_group,
    delete_group,
    delete_person,
    delete_rule,
    list_devices,
    list_door_groups,
    list_events,
    list_group_members,
    list_groups,
    list_people,
    list_rules,
    save_device,
    save_door_group,
    save_group,
    save_person,
    save_rule,
    set_door_group_members,
    set_group_members,
    upsert_provision_status,
)
from app.services.access_control_device import open_door as device_open_door
from app.services.access_control_sync import provision_person_everywhere, resolve_target_devices_for_person

router = APIRouter(prefix="/api/access-control", tags=["access-control"])


class AccessPersonRequest(BaseModel):
    id: Optional[str] = ""
    full_name: str = Field(min_length=1, max_length=160)
    person_type: str = "student"
    document_id: str = ""
    enrollment_code: str = ""
    class_name: str = ""
    site: str = ""
    guardian_name: str = ""
    guardian_phone: str = ""
    whatsapp_enabled: bool = True
    active: bool = True
    notes: str = ""


class AccessDeviceRequest(BaseModel):
    id: Optional[str] = ""
    name: str = Field(min_length=1, max_length=160)
    site: str = ""
    vendor: str = "dahua"
    model: str = ""
    host: str = Field(min_length=1)
    connector_id: str = ""
    username: str = "admin"
    password: Optional[str] = ""
    active: bool = True


class AccessGroupRequest(BaseModel):
    id: Optional[str] = ""
    name: str = Field(min_length=1, max_length=160)
    site: str = ""
    active: bool = True
    member_ids: List[str] = []


class AccessDoorGroupRequest(BaseModel):
    id: Optional[str] = ""
    name: str = Field(min_length=1, max_length=160)
    site: str = ""
    active: bool = True
    device_ids: List[str] = []


class AccessRuleRequest(BaseModel):
    id: Optional[str] = ""
    people_group_id: str
    door_group_id: str
    weekdays: str = "1234567"
    time_start: str = ""
    time_end: str = ""
    active: bool = True


@router.get("/summary")
def api_access_control_summary() -> Dict[str, Any]:
    return {"ok": True, "summary": access_control_summary()}


@router.get("/people")
def api_access_control_people(
    search: str = Query(""),
    active: str = Query(""),
) -> Dict[str, Any]:
    people = list_people(search=search, active=active)
    return {"ok": True, "count": len(people), "people": people}


@router.post("/people")
def api_access_control_save_person(req: AccessPersonRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        person = save_person(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    # Nao chama o dispositivo aqui -- so marca "pending" e devolve na hora.
    # O loop de fundo (Task 7, `retry_pending_provisions`) e quem realmente
    # fala com a catraca, a cada 60-900s. Chamar o dispositivo de forma
    # sincrona aqui prenderia a resposta HTTP de salvar pessoa ate o
    # timeout se a catraca estiver lenta/offline -- proibido pelo Global
    # Constraint deste plano ("Nenhuma chamada ao dispositivo pode
    # bloquear a resposta HTTP de salvar uma pessoa/regra").
    for device in resolve_target_devices_for_person(person["id"]):
        upsert_provision_status(person["id"], device["id"], "pending")
    return {"ok": True, "person": person}


@router.delete("/people/{person_id}")
def api_access_control_delete_person(person_id: str) -> Dict[str, Any]:
    removed = delete_person(person_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Pessoa nao encontrada neste cliente.")
    return {"ok": True, "removed": True}


@router.post("/people/{person_id}/sync")
def api_access_control_sync_person(person_id: str) -> Dict[str, Any]:
    people = list_people()
    person = next((p for p in people if p["id"] == person_id), None)
    if not person:
        raise HTTPException(status_code=404, detail="Pessoa nao encontrada neste cliente.")
    result = provision_person_everywhere(person)
    return {"ok": True, **result}


@router.get("/devices")
def api_access_control_devices() -> Dict[str, Any]:
    return {"ok": True, "devices": list_devices()}


@router.post("/devices")
def api_access_control_save_device(req: AccessDeviceRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        device = save_device(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "device": device}


@router.delete("/devices/{device_id}")
def api_access_control_delete_device(device_id: str) -> Dict[str, Any]:
    removed = delete_device(device_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Dispositivo nao encontrado neste cliente.")
    return {"ok": True, "removed": True}


@router.post("/devices/{device_id}/open-door")
def api_access_control_open_door(device_id: str, channel: int = 1) -> Dict[str, Any]:
    from app.services.access_control_store import get_device_with_password

    device = get_device_with_password(device_id)
    if not device:
        raise HTTPException(status_code=404, detail="Dispositivo nao encontrado neste cliente.")
    result = device_open_door(device, channel=channel)
    return {"ok": True, **result}


@router.get("/groups")
def api_access_control_groups() -> Dict[str, Any]:
    groups = list_groups()
    for group in groups:
        group["member_ids"] = list_group_members(group["id"])
    return {"ok": True, "groups": groups}


@router.post("/groups")
def api_access_control_save_group(req: AccessGroupRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        member_ids = payload.pop("member_ids", [])
        group = save_group(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    set_group_members(group["id"], member_ids)
    group["member_ids"] = member_ids
    return {"ok": True, "group": group}


@router.delete("/groups/{group_id}")
def api_access_control_delete_group(group_id: str) -> Dict[str, Any]:
    removed = delete_group(group_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Grupo nao encontrado neste cliente.")
    return {"ok": True, "removed": True}


@router.get("/door-groups")
def api_access_control_door_groups() -> Dict[str, Any]:
    from app.services.access_control_store import list_door_group_members

    door_groups = list_door_groups()
    for door_group in door_groups:
        door_group["device_ids"] = list_door_group_members(door_group["id"])
    return {"ok": True, "door_groups": door_groups}


@router.post("/door-groups")
def api_access_control_save_door_group(req: AccessDoorGroupRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        device_ids = payload.pop("device_ids", [])
        door_group = save_door_group(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    set_door_group_members(door_group["id"], device_ids)
    door_group["device_ids"] = device_ids
    return {"ok": True, "door_group": door_group}


@router.delete("/door-groups/{door_group_id}")
def api_access_control_delete_door_group(door_group_id: str) -> Dict[str, Any]:
    removed = delete_door_group(door_group_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Grupo de portas nao encontrado neste cliente.")
    return {"ok": True, "removed": True}


@router.get("/rules")
def api_access_control_rules() -> Dict[str, Any]:
    return {"ok": True, "rules": list_rules()}


@router.post("/rules")
def api_access_control_save_rule(req: AccessRuleRequest) -> Dict[str, Any]:
    try:
        payload = req.model_dump() if hasattr(req, "model_dump") else req.dict()
        rule = save_rule(payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"ok": True, "rule": rule}


@router.delete("/rules/{rule_id}")
def api_access_control_delete_rule(rule_id: str) -> Dict[str, Any]:
    removed = delete_rule(rule_id)
    if not removed:
        raise HTTPException(status_code=404, detail="Regra nao encontrada neste cliente.")
    return {"ok": True, "removed": True}


@router.get("/events")
def api_access_control_events(
    person_id: str = Query(""),
    site: str = Query(""),
    limit: int = Query(200),
) -> Dict[str, Any]:
    events = list_events(person_id=person_id, site=site, limit=limit)
    return {"ok": True, "count": len(events), "events": events}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_routes_test.py`
Expected: `OK access control routes: dispositivos, grupos, regras, sync e eventos registrados`

- [ ] **Step 5: Run full backend regression before moving on**

Run: `python -m py_compile app/api/endpoints/access_control.py app/services/access_control_store.py app/services/access_control_device.py app/services/access_control_sync.py`
Run: `python scripts/sightops_access_control_schema_test.py && python scripts/sightops_access_control_device_test.py && python scripts/sightops_access_control_sync_test.py && python scripts/sightops_access_control_routes_test.py`
Expected: todos `OK`.

- [ ] **Step 6: Commit**

```bash
git add app/api/endpoints/access_control.py scripts/sightops_access_control_routes_test.py
git commit -m "feat(access-control): endpoints de dispositivo, grupo, regra, abrir porta e eventos"
```

---

## Task 7: Loop de fundo — retry de provisionamento e polling de eventos

**Files:**
- Modify: `app/main.py`

**Interfaces:**
- Consumes: `access_control_sync.{retry_pending_provisions, poll_device_events}`, `access_control_store.list_devices`, `list_monitoring_tenants` (já importado em `main.py`), `set_current_tenant_slug`/`reset_current_tenant_slug` (já importados).
- Produces: `app.state.access_control_sync_task`, `app.state.access_control_sync_last`.

- [ ] **Step 1: Escrever o loop (mesmo padrão de `_olt_telemetry_loop`)**

Em `app/main.py`, adicionar import no topo (junto dos outros `from app.services import ...`):

```python
from app.services.access_control_sync import poll_device_events, retry_pending_provisions
from app.services.access_control_store import list_devices as list_access_devices
```

E, logo depois de `_olt_telemetry_loop` (mesma região do arquivo):

```python
async def _access_control_sync_loop() -> None:
    try:
        interval = max(60, min(int(os.getenv("SIGHTOPS_ACCESS_CONTROL_SYNC_INTERVAL", "120")), 900))
    except Exception:
        interval = 120
    await asyncio.sleep(30)
    while True:
        results: dict[str, object] = {}
        try:
            for tenant_slug in await asyncio.to_thread(list_monitoring_tenants):
                token = set_current_tenant_slug(tenant_slug)
                try:
                    retry_result = await asyncio.to_thread(retry_pending_provisions)
                    events_count = 0
                    for device in await asyncio.to_thread(list_access_devices):
                        if not device.get("active"):
                            continue
                        events_count += await asyncio.to_thread(poll_device_events, device["id"])
                    results[tenant_slug] = {"retried": retry_result.get("retried", 0), "events": events_count}
                finally:
                    reset_current_tenant_slug(token)
            app.state.access_control_sync_last = {"ok": True, "interval_s": interval, "tenants": results}
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            app.state.access_control_sync_last = {"ok": False, "interval_s": interval, "error": str(exc)}
            logger.exception("access control sync loop failed")
        await asyncio.sleep(interval)
```

- [ ] **Step 2: Registrar no startup/shutdown**

Em `startup_events()`, junto das outras `create_task`:

```python
    app.state.access_control_sync_task = asyncio.create_task(
        _access_control_sync_loop(), name="access-control-sync-loop"
    )
```

Em `shutdown_events()`, adicionar `"access_control_sync_task"` à tupla `("zabbix_status_task", "monitoring_refresh_task", "olt_telemetry_task")`.

- [ ] **Step 3: Verify it starts cleanly**

Run: `python -m py_compile app/main.py`
Run: `python -c "import app.main"` (confere que o import não quebra por ciclo — se `access_control_sync` importar algo de `main.py` por engano, isso falha aqui)
Expected: sem erro.

- [ ] **Step 4: Commit**

```bash
git add app/main.py
git commit -m "feat(access-control): loop de fundo retry de provisionamento + polling de eventos"
```

---

## Task 8: Frontend — aba Dispositivos (listar, cadastrar, abrir porta)

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/accessControl.js`
- Modify: `frontend/styles.css`
- Modify: `scripts/sightops_access_control_shell_test.py`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/access-control/devices`, `POST /api/access-control/devices/{id}/open-door`.
- Produces: `loadAccessDevices()`, `renderAccessDevices(rows)`, `openAccessDeviceModal(device)`, `saveAccessDeviceFromForm(event)`, `handleAccessDeviceAction(event)` em `accessControl.js`.

- [ ] **Step 1: Write the failing test**

Adicionar em `scripts/sightops_access_control_shell_test.py`:

```python
def test_access_devices_tab_exists() -> None:
    html = _read(INDEX_HTML)
    access_js = _read(ACCESS_JS)
    assert 'id="accessTabDevices"' in html
    assert 'id="accessDevicesTable"' in html
    assert 'id="btnAccessDeviceNew"' in html
    assert "function loadAccessDevices" in access_js
    assert "function renderAccessDevices" in access_js
    assert "data-access-open-door" in access_js
```

E adicionar a chamada `test_access_devices_tab_exists()` no bloco `if __name__ == "__main__":`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_shell_test.py`
Expected: FAIL — `assert 'id="accessTabDevices"' in html` (aba ainda não existe).

- [ ] **Step 3: Write minimal implementation**

Em `frontend/index.html`, dentro de `<div id="viewAccessControl">` (mesma seção que já tem a tabela de pessoas), adicionar navegação por abas antes da tabela de pessoas existente (se ainda não tiver um contêiner de abas, envolver o conteúdo atual de "Pessoas" numa aba também):

```html
<div class="tabs access-control-tabs">
  <button type="button" class="tab-btn active" data-access-tab="people">Pessoas</button>
  <button type="button" class="tab-btn" id="accessTabDevices" data-access-tab="devices">Dispositivos</button>
  <button type="button" class="tab-btn" data-access-tab="groups">Grupos</button>
  <button type="button" class="tab-btn" data-access-tab="rules">Regras</button>
</div>

<div class="access-tab-panel" data-access-panel="devices" hidden>
  <div class="access-control-toolbar">
    <button type="button" class="btn primary" id="btnAccessDeviceNew"><i data-lucide="plus"></i> Novo dispositivo</button>
    <button type="button" class="btn ghost" id="btnAccessDevicesRefresh"><i data-lucide="refresh-cw"></i> Atualizar</button>
  </div>
  <table class="data-table" id="accessDevicesTable">
    <thead>
      <tr><th>Nome</th><th>Site</th><th>Host</th><th>Modelo</th><th>Status</th><th></th></tr>
    </thead>
    <tbody id="accessDevicesBody"></tbody>
  </table>
</div>

<div class="modal hidden" id="modalAccessDevice">
  <div class="modal-content">
    <div class="modal-header">
      <h3 id="accessDeviceModalTitle">Novo dispositivo</h3>
      <button type="button" class="icon-button" id="btnAccessDeviceClose"><i data-lucide="x"></i></button>
    </div>
    <form id="accessDeviceForm">
      <input type="hidden" id="accessDeviceId">
      <label>Nome<input type="text" id="accessDeviceName" required></label>
      <label>Site<input type="text" id="accessDeviceSite"></label>
      <label>Host/IP<input type="text" id="accessDeviceHost" required></label>
      <label>Usuário<input type="text" id="accessDeviceUsername" value="admin"></label>
      <label>Senha<input type="password" id="accessDevicePassword" placeholder="Deixe em branco para manter"></label>
      <label><input type="checkbox" id="accessDeviceActive" checked> Ativo</label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="btnAccessDeviceCancel">Cancelar</button>
        <button type="submit" class="btn primary" id="btnAccessDeviceSave"><i data-lucide="save"></i> Salvar dispositivo</button>
      </div>
    </form>
  </div>
</div>
```

Em `frontend/js/accessControl.js`, adicionar (e chamar `bindAccessDevices()`/`bindAccessTabs()` de dentro de `bindAccessControl()`):

```javascript
let _accessDeviceRows = [];

function bindAccessTabs() {
  document.querySelectorAll('.access-control-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.accessTab;
      document.querySelectorAll('.access-control-tabs .tab-btn').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.access-tab-panel').forEach(panel => {
        panel.hidden = panel.dataset.accessPanel !== tab;
      });
      if (tab === 'devices') loadAccessDevices();
    });
  });
}

function bindAccessDevices() {
  document.getElementById('btnAccessDeviceNew')?.addEventListener('click', () => openAccessDeviceModal());
  document.getElementById('btnAccessDevicesRefresh')?.addEventListener('click', () => loadAccessDevices(true));
  document.getElementById('btnAccessDeviceClose')?.addEventListener('click', closeAccessDeviceModal);
  document.getElementById('btnAccessDeviceCancel')?.addEventListener('click', closeAccessDeviceModal);
  document.getElementById('accessDeviceForm')?.addEventListener('submit', saveAccessDeviceFromForm);
  document.getElementById('accessDevicesBody')?.addEventListener('click', handleAccessDeviceAction);
}

async function loadAccessDevices(force = false) {
  try {
    const res = await apiJson('/api/access-control/devices', { forceRefresh: force, cacheTtl: 0 });
    _accessDeviceRows = res?.devices || [];
    renderAccessDevices(_accessDeviceRows);
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel carregar dispositivos.', true);
  }
}

function renderAccessDevices(rows) {
  const body = document.getElementById('accessDevicesBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhum dispositivo cadastrado.</td></tr>';
    return;
  }
  body.innerHTML = rows.map(device => `
    <tr>
      <td><strong>${esc(device.name)}</strong></td>
      <td>${esc(device.site || '-')}</td>
      <td>${esc(device.host)}</td>
      <td>${esc(device.model || '-')}</td>
      <td>${esc(device.status || 'desconhecido')}</td>
      <td>
        <div class="access-person-actions">
          <button class="icon-button" type="button" data-access-open-door="${esc(device.id)}" aria-label="Abrir porta"><i data-lucide="door-open"></i></button>
          <button class="icon-button" type="button" data-access-edit-device="${esc(device.id)}" aria-label="Editar"><i data-lucide="pencil"></i></button>
          <button class="icon-button danger-action" type="button" data-access-delete-device="${esc(device.id)}" aria-label="Excluir"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
  lucide.createIcons();
}

function openAccessDeviceModal(device = null) {
  const item = device || {};
  setText('accessDeviceModalTitle', item.id ? 'Editar dispositivo' : 'Novo dispositivo');
  document.getElementById('accessDeviceId').value = item.id || '';
  document.getElementById('accessDeviceName').value = item.name || '';
  document.getElementById('accessDeviceSite').value = item.site || '';
  document.getElementById('accessDeviceHost').value = item.host || '';
  document.getElementById('accessDeviceUsername').value = item.username || 'admin';
  document.getElementById('accessDevicePassword').value = '';
  document.getElementById('accessDeviceActive').checked = item.active !== false;
  document.getElementById('modalAccessDevice')?.classList.remove('hidden');
}

function closeAccessDeviceModal() {
  document.getElementById('modalAccessDevice')?.classList.add('hidden');
}

async function saveAccessDeviceFromForm(event) {
  event.preventDefault();
  const payload = {
    id: document.getElementById('accessDeviceId').value.trim(),
    name: document.getElementById('accessDeviceName').value.trim(),
    site: document.getElementById('accessDeviceSite').value.trim(),
    host: document.getElementById('accessDeviceHost').value.trim(),
    username: document.getElementById('accessDeviceUsername').value.trim(),
    password: document.getElementById('accessDevicePassword').value,
    active: document.getElementById('accessDeviceActive').checked,
  };
  if (!payload.name || !payload.host) {
    showToast('Informe nome e host do dispositivo.', true);
    return;
  }
  try {
    const res = await api('/api/access-control/devices', { method: 'POST', body: JSON.stringify(payload) });
    await jsonOrReadableError(res, 'Nao foi possivel salvar o dispositivo.');
    closeAccessDeviceModal();
    await loadAccessDevices(true);
    showToast('Dispositivo salvo.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar o dispositivo.', true);
  }
}

async function handleAccessDeviceAction(event) {
  const openBtn = event.target.closest?.('[data-access-open-door]');
  const editBtn = event.target.closest?.('[data-access-edit-device]');
  const deleteBtn = event.target.closest?.('[data-access-delete-device]');
  if (openBtn) {
    try {
      const res = await api(`/api/access-control/devices/${encodeURIComponent(openBtn.dataset.accessOpenDoor)}/open-door`, { method: 'POST' });
      await jsonOrReadableError(res, 'Nao foi possivel abrir a porta.');
      showToast('Porta liberada.');
    } catch (err) {
      showToast(err?.message || 'Nao foi possivel abrir a porta.', true);
    }
    return;
  }
  if (editBtn) {
    const device = _accessDeviceRows.find(row => row.id === editBtn.dataset.accessEditDevice);
    if (device) openAccessDeviceModal(device);
    return;
  }
  if (deleteBtn) {
    try {
      const res = await api(`/api/access-control/devices/${encodeURIComponent(deleteBtn.dataset.accessDeleteDevice)}`, { method: 'DELETE' });
      await jsonOrReadableError(res, 'Nao foi possivel excluir o dispositivo.');
      await loadAccessDevices(true);
      showToast('Dispositivo excluido.');
    } catch (err) {
      showToast(err?.message || 'Nao foi possivel excluir o dispositivo.', true);
    }
  }
}
```

E dentro de `bindAccessControl()` (função já existente), adicionar as duas chamadas:

```javascript
  bindAccessTabs();
  bindAccessDevices();
```

Em `frontend/styles.css`, adicionar estilos básicos de aba (se `.tabs`/`.tab-btn` já existirem em outra parte do CSS, reaproveitar — só criar `.access-control-tabs`/`.access-tab-panel` se não houver componente de aba genérico já pronto no projeto):

```css
.access-control-tabs { display: flex; gap: 8px; margin-bottom: 16px; border-bottom: 1px solid var(--border); }
.access-tab-panel[hidden] { display: none; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_shell_test.py`
Expected: `OK access control shell`

- [ ] **Step 5: Bump cache-busting version**

Em `frontend/index.html`, incrementar `js/accessControl.js?v=1` pra `?v=2` (e a cada task de frontend seguinte, incrementar de novo).

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/js/accessControl.js frontend/styles.css scripts/sightops_access_control_shell_test.py
git commit -m "feat(access-control): aba de dispositivos com cadastro e abrir porta manual"
```

---

## Task 9: Frontend — abas Grupos e Regras

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/accessControl.js`
- Modify: `scripts/sightops_access_control_shell_test.py`

**Interfaces:**
- Consumes: `GET/POST/DELETE /api/access-control/groups`, `/door-groups`, `/rules`.
- Produces: `loadAccessGroups()`, `renderAccessGroups(rows)`, `loadAccessRules()`, `renderAccessRules(rows)` em `accessControl.js`.

- [ ] **Step 1: Write the failing test**

Adicionar em `scripts/sightops_access_control_shell_test.py`:

```python
def test_access_groups_and_rules_tabs_exist() -> None:
    html = _read(INDEX_HTML)
    access_js = _read(ACCESS_JS)
    assert 'data-access-panel="groups"' in html
    assert 'data-access-panel="rules"' in html
    assert 'id="btnAccessGroupNew"' in html
    assert 'id="btnAccessRuleNew"' in html
    assert "function loadAccessGroups" in access_js
    assert "function loadAccessRules" in access_js
```

E adicionar a chamada no `if __name__ == "__main__":`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_shell_test.py`
Expected: FAIL — `assert 'data-access-panel="groups"' in html`.

- [ ] **Step 3: Write minimal implementation**

Em `frontend/index.html`, adicionar dois painéis novos (mesmo padrão do painel `devices` da Task 8), depois dele:

```html
<div class="access-tab-panel" data-access-panel="groups" hidden>
  <div class="access-groups-grid">
    <div>
      <div class="access-control-toolbar">
        <h4>Grupos de pessoas</h4>
        <button type="button" class="btn primary" id="btnAccessGroupNew"><i data-lucide="plus"></i> Novo grupo</button>
      </div>
      <table class="data-table" id="accessGroupsTable">
        <thead><tr><th>Nome</th><th>Site</th><th>Pessoas</th><th></th></tr></thead>
        <tbody id="accessGroupsBody"></tbody>
      </table>
    </div>
    <div>
      <div class="access-control-toolbar">
        <h4>Grupos de porta</h4>
        <button type="button" class="btn primary" id="btnAccessDoorGroupNew"><i data-lucide="plus"></i> Novo grupo de porta</button>
      </div>
      <table class="data-table" id="accessDoorGroupsTable">
        <thead><tr><th>Nome</th><th>Site</th><th>Dispositivos</th><th></th></tr></thead>
        <tbody id="accessDoorGroupsBody"></tbody>
      </table>
    </div>
  </div>
</div>

<div class="access-tab-panel" data-access-panel="rules" hidden>
  <div class="access-control-toolbar">
    <button type="button" class="btn primary" id="btnAccessRuleNew"><i data-lucide="plus"></i> Nova regra</button>
  </div>
  <table class="data-table" id="accessRulesTable">
    <thead><tr><th>Grupo de pessoas</th><th>Grupo de portas</th><th>Dias</th><th>Horário</th><th></th></tr></thead>
    <tbody id="accessRulesBody"></tbody>
  </table>
</div>
```

Em `frontend/js/accessControl.js`, adicionar:

```javascript
let _accessGroupRows = [];
let _accessDoorGroupRows = [];
let _accessRuleRows = [];

function bindAccessGroups() {
  document.getElementById('btnAccessGroupNew')?.addEventListener('click', () => openAccessGroupModal());
  document.getElementById('btnAccessDoorGroupNew')?.addEventListener('click', () => openAccessDoorGroupModal());
  document.getElementById('btnAccessRuleNew')?.addEventListener('click', () => openAccessRuleModal());
}

async function loadAccessGroups() {
  try {
    const [groupsRes, doorGroupsRes] = await Promise.all([
      apiJson('/api/access-control/groups', { cacheTtl: 0 }),
      apiJson('/api/access-control/door-groups', { cacheTtl: 0 }),
    ]);
    _accessGroupRows = groupsRes?.groups || [];
    _accessDoorGroupRows = doorGroupsRes?.door_groups || [];
    renderAccessGroups(_accessGroupRows);
    renderAccessDoorGroups(_accessDoorGroupRows);
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel carregar grupos.', true);
  }
}

function renderAccessGroups(rows) {
  const body = document.getElementById('accessGroupsBody');
  if (!body) return;
  body.innerHTML = rows.length
    ? rows.map(g => `<tr><td>${esc(g.name)}</td><td>${esc(g.site || '-')}</td><td>${(g.member_ids || []).length}</td><td><button class="icon-button" type="button" data-access-edit-group="${esc(g.id)}"><i data-lucide="pencil"></i></button></td></tr>`).join('')
    : '<tr class="empty-row"><td colspan="4">Nenhum grupo cadastrado.</td></tr>';
  lucide.createIcons();
}

function renderAccessDoorGroups(rows) {
  const body = document.getElementById('accessDoorGroupsBody');
  if (!body) return;
  body.innerHTML = rows.length
    ? rows.map(g => `<tr><td>${esc(g.name)}</td><td>${esc(g.site || '-')}</td><td>${(g.device_ids || []).length}</td><td><button class="icon-button" type="button" data-access-edit-door-group="${esc(g.id)}"><i data-lucide="pencil"></i></button></td></tr>`).join('')
    : '<tr class="empty-row"><td colspan="4">Nenhum grupo de porta cadastrado.</td></tr>';
  lucide.createIcons();
}

async function loadAccessRules() {
  try {
    const res = await apiJson('/api/access-control/rules', { cacheTtl: 0 });
    _accessRuleRows = res?.rules || [];
    renderAccessRules(_accessRuleRows);
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel carregar regras.', true);
  }
}

function renderAccessRules(rows) {
  const body = document.getElementById('accessRulesBody');
  if (!body) return;
  const groupName = id => _accessGroupRows.find(g => g.id === id)?.name || id;
  const doorGroupName = id => _accessDoorGroupRows.find(g => g.id === id)?.name || id;
  body.innerHTML = rows.length
    ? rows.map(r => `<tr><td>${esc(groupName(r.people_group_id))}</td><td>${esc(doorGroupName(r.door_group_id))}</td><td>${esc(r.weekdays)}</td><td>${esc(r.time_start || '00:00')}-${esc(r.time_end || '23:59')}</td><td><button class="icon-button" type="button" data-access-edit-rule="${esc(r.id)}"><i data-lucide="pencil"></i></button></td></tr>`).join('')
    : '<tr class="empty-row"><td colspan="5">Nenhuma regra cadastrada.</td></tr>';
  lucide.createIcons();
}

function openAccessGroupModal(group = null) {
  // TODO seguir mesmo padrao de modal de openAccessPersonModal/openAccessDeviceModal
  // com checklist de pessoas (member_ids) -- reaproveita o mesmo estilo de modal.
}

function openAccessDoorGroupModal(doorGroup = null) {
  // TODO mesmo padrao, checklist de dispositivos (device_ids).
}

function openAccessRuleModal(rule = null) {
  // TODO select de grupo de pessoas + select de grupo de porta + checkboxes de dia + horario.
}
```

**Nota:** os três `openAccess*Modal` acima ficam com corpo mínimo nesta task — o objetivo aqui é fechar o **fluxo de dados** (listar/renderizar grupos e regras, tabelas populadas via API real). O modal completo de cada um (HTML do formulário + submit) é responsabilidade da Task 10, que os implementa seguindo exatamente o mesmo padrão de `openAccessDeviceModal`/`saveAccessDeviceFromForm` da Task 8 — sem isso a Task 9 sozinha não teria um "produto fechado", mas o teste desta task cobre só o que ela promete (abas existem, listagem carrega).

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_shell_test.py`
Expected: `OK access control shell`

- [ ] **Step 5: Bump cache-busting version e commit**

Incrementar `js/accessControl.js?v=2` pra `?v=3` em `frontend/index.html`.

```bash
git add frontend/index.html frontend/js/accessControl.js scripts/sightops_access_control_shell_test.py
git commit -m "feat(access-control): abas de grupos e regras (listagem)"
```

---

## Task 10: Frontend — modais de grupo/grupo de porta/regra completos + status de sincronização na ficha da pessoa

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/js/accessControl.js`
- Modify: `scripts/sightops_access_control_shell_test.py`

**Interfaces:**
- Consumes: `POST /api/access-control/groups`, `/door-groups`, `/rules`, `GET /api/access-control/events?person_id=`.
- Produces: `saveAccessGroupFromForm`, `saveAccessDoorGroupFromForm`, `saveAccessRuleFromForm`, atualização de `openAccessPersonModal` pra mostrar status de sync.

- [ ] **Step 1: Write the failing test**

Adicionar em `scripts/sightops_access_control_shell_test.py`:

```python
def test_access_group_and_rule_modals_are_functional() -> None:
    access_js = _read(ACCESS_JS)
    assert "function saveAccessGroupFromForm" in access_js
    assert "function saveAccessDoorGroupFromForm" in access_js
    assert "function saveAccessRuleFromForm" in access_js
    assert "accessPersonSyncStatus" in access_js
```

E adicionar a chamada no `if __name__ == "__main__":`.

- [ ] **Step 2: Run test to verify it fails**

Run: `python scripts/sightops_access_control_shell_test.py`
Expected: FAIL — `assert "function saveAccessGroupFromForm" in access_js`.

- [ ] **Step 3: Write minimal implementation**

Substituir os três `openAccess*Modal` com corpo `// TODO` da Task 9 pela versão completa. Em `frontend/index.html`, adicionar os três modais (mesma estrutura de `#modalAccessDevice` da Task 8 — formulário com `<input type="hidden">` de id, campos de nome/site, e um checklist):

```html
<div class="modal hidden" id="modalAccessGroup">
  <div class="modal-content">
    <div class="modal-header"><h3 id="accessGroupModalTitle">Novo grupo</h3><button type="button" class="icon-button" id="btnAccessGroupClose"><i data-lucide="x"></i></button></div>
    <form id="accessGroupForm">
      <input type="hidden" id="accessGroupId">
      <label>Nome<input type="text" id="accessGroupName" required></label>
      <label>Site<input type="text" id="accessGroupSite"></label>
      <label>Pessoas</label>
      <div class="access-checklist" id="accessGroupMembersChecklist"></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="btnAccessGroupCancel">Cancelar</button>
        <button type="submit" class="btn primary">Salvar grupo</button>
      </div>
    </form>
  </div>
</div>

<div class="modal hidden" id="modalAccessDoorGroup">
  <div class="modal-content">
    <div class="modal-header"><h3 id="accessDoorGroupModalTitle">Novo grupo de porta</h3><button type="button" class="icon-button" id="btnAccessDoorGroupClose"><i data-lucide="x"></i></button></div>
    <form id="accessDoorGroupForm">
      <input type="hidden" id="accessDoorGroupId">
      <label>Nome<input type="text" id="accessDoorGroupName" required></label>
      <label>Site<input type="text" id="accessDoorGroupSite"></label>
      <label>Dispositivos</label>
      <div class="access-checklist" id="accessDoorGroupDevicesChecklist"></div>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="btnAccessDoorGroupCancel">Cancelar</button>
        <button type="submit" class="btn primary">Salvar grupo de porta</button>
      </div>
    </form>
  </div>
</div>

<div class="modal hidden" id="modalAccessRule">
  <div class="modal-content">
    <div class="modal-header"><h3>Nova regra</h3><button type="button" class="icon-button" id="btnAccessRuleClose"><i data-lucide="x"></i></button></div>
    <form id="accessRuleForm">
      <input type="hidden" id="accessRuleId">
      <label>Grupo de pessoas<select id="accessRulePeopleGroup" required></select></label>
      <label>Grupo de portas<select id="accessRuleDoorGroup" required></select></label>
      <label>Dias (1=seg .. 7=dom)<input type="text" id="accessRuleWeekdays" value="1234567"></label>
      <label>Horário início<input type="time" id="accessRuleTimeStart"></label>
      <label>Horário fim<input type="time" id="accessRuleTimeEnd"></label>
      <div class="modal-actions">
        <button type="button" class="btn ghost" id="btnAccessRuleCancel">Cancelar</button>
        <button type="submit" class="btn primary">Salvar regra</button>
      </div>
    </form>
  </div>
</div>
```

Em `frontend/js/accessControl.js`, substituir os três placeholders:

```javascript
function openAccessGroupModal(group = null) {
  const item = group || {};
  setText('accessGroupModalTitle', item.id ? 'Editar grupo' : 'Novo grupo');
  document.getElementById('accessGroupId').value = item.id || '';
  document.getElementById('accessGroupName').value = item.name || '';
  document.getElementById('accessGroupSite').value = item.site || '';
  const checklist = document.getElementById('accessGroupMembersChecklist');
  const memberIds = new Set(item.member_ids || []);
  checklist.innerHTML = _accessPeopleRows.map(p => `
    <label class="access-checklist-item"><input type="checkbox" value="${esc(p.id)}" ${memberIds.has(p.id) ? 'checked' : ''}> ${esc(p.full_name)}</label>
  `).join('') || '<p class="muted-block">Cadastre pessoas primeiro.</p>';
  document.getElementById('modalAccessGroup')?.classList.remove('hidden');
}

function closeAccessGroupModal() {
  document.getElementById('modalAccessGroup')?.classList.add('hidden');
}

async function saveAccessGroupFromForm(event) {
  event.preventDefault();
  const memberIds = Array.from(document.querySelectorAll('#accessGroupMembersChecklist input:checked')).map(el => el.value);
  const payload = {
    id: document.getElementById('accessGroupId').value.trim(),
    name: document.getElementById('accessGroupName').value.trim(),
    site: document.getElementById('accessGroupSite').value.trim(),
    member_ids: memberIds,
  };
  if (!payload.name) { showToast('Informe o nome do grupo.', true); return; }
  try {
    const res = await api('/api/access-control/groups', { method: 'POST', body: JSON.stringify(payload) });
    await jsonOrReadableError(res, 'Nao foi possivel salvar o grupo.');
    closeAccessGroupModal();
    await loadAccessGroups();
    showToast('Grupo salvo.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar o grupo.', true);
  }
}

function openAccessDoorGroupModal(doorGroup = null) {
  const item = doorGroup || {};
  setText('accessDoorGroupModalTitle', item.id ? 'Editar grupo de porta' : 'Novo grupo de porta');
  document.getElementById('accessDoorGroupId').value = item.id || '';
  document.getElementById('accessDoorGroupName').value = item.name || '';
  document.getElementById('accessDoorGroupSite').value = item.site || '';
  const checklist = document.getElementById('accessDoorGroupDevicesChecklist');
  const deviceIds = new Set(item.device_ids || []);
  checklist.innerHTML = _accessDeviceRows.map(d => `
    <label class="access-checklist-item"><input type="checkbox" value="${esc(d.id)}" ${deviceIds.has(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>
  `).join('') || '<p class="muted-block">Cadastre dispositivos primeiro.</p>';
  document.getElementById('modalAccessDoorGroup')?.classList.remove('hidden');
}

function closeAccessDoorGroupModal() {
  document.getElementById('modalAccessDoorGroup')?.classList.add('hidden');
}

async function saveAccessDoorGroupFromForm(event) {
  event.preventDefault();
  const deviceIds = Array.from(document.querySelectorAll('#accessDoorGroupDevicesChecklist input:checked')).map(el => el.value);
  const payload = {
    id: document.getElementById('accessDoorGroupId').value.trim(),
    name: document.getElementById('accessDoorGroupName').value.trim(),
    site: document.getElementById('accessDoorGroupSite').value.trim(),
    device_ids: deviceIds,
  };
  if (!payload.name) { showToast('Informe o nome do grupo de porta.', true); return; }
  try {
    const res = await api('/api/access-control/door-groups', { method: 'POST', body: JSON.stringify(payload) });
    await jsonOrReadableError(res, 'Nao foi possivel salvar o grupo de porta.');
    closeAccessDoorGroupModal();
    await loadAccessGroups();
    showToast('Grupo de porta salvo.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar o grupo de porta.', true);
  }
}

function openAccessRuleModal(rule = null) {
  const item = rule || {};
  document.getElementById('accessRuleId').value = item.id || '';
  const peopleSelect = document.getElementById('accessRulePeopleGroup');
  const doorSelect = document.getElementById('accessRuleDoorGroup');
  peopleSelect.innerHTML = _accessGroupRows.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  doorSelect.innerHTML = _accessDoorGroupRows.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
  peopleSelect.value = item.people_group_id || '';
  doorSelect.value = item.door_group_id || '';
  document.getElementById('accessRuleWeekdays').value = item.weekdays || '1234567';
  document.getElementById('accessRuleTimeStart').value = item.time_start || '';
  document.getElementById('accessRuleTimeEnd').value = item.time_end || '';
  document.getElementById('modalAccessRule')?.classList.remove('hidden');
}

function closeAccessRuleModal() {
  document.getElementById('modalAccessRule')?.classList.add('hidden');
}

async function saveAccessRuleFromForm(event) {
  event.preventDefault();
  const payload = {
    id: document.getElementById('accessRuleId').value.trim(),
    people_group_id: document.getElementById('accessRulePeopleGroup').value,
    door_group_id: document.getElementById('accessRuleDoorGroup').value,
    weekdays: document.getElementById('accessRuleWeekdays').value.trim() || '1234567',
    time_start: document.getElementById('accessRuleTimeStart').value,
    time_end: document.getElementById('accessRuleTimeEnd').value,
  };
  if (!payload.people_group_id || !payload.door_group_id) { showToast('Escolha os dois grupos.', true); return; }
  try {
    const res = await api('/api/access-control/rules', { method: 'POST', body: JSON.stringify(payload) });
    await jsonOrReadableError(res, 'Nao foi possivel salvar a regra.');
    closeAccessRuleModal();
    await loadAccessRules();
    showToast('Regra salva.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar a regra.', true);
  }
}
```

E dentro de `bindAccessControl()`, mais listeners:

```javascript
  document.getElementById('btnAccessGroupClose')?.addEventListener('click', closeAccessGroupModal);
  document.getElementById('btnAccessGroupCancel')?.addEventListener('click', closeAccessGroupModal);
  document.getElementById('accessGroupForm')?.addEventListener('submit', saveAccessGroupFromForm);
  document.getElementById('btnAccessDoorGroupClose')?.addEventListener('click', closeAccessDoorGroupModal);
  document.getElementById('btnAccessDoorGroupCancel')?.addEventListener('click', closeAccessDoorGroupModal);
  document.getElementById('accessDoorGroupForm')?.addEventListener('submit', saveAccessDoorGroupFromForm);
  document.getElementById('btnAccessRuleClose')?.addEventListener('click', closeAccessRuleModal);
  document.getElementById('btnAccessRuleCancel')?.addEventListener('click', closeAccessRuleModal);
  document.getElementById('accessRuleForm')?.addEventListener('submit', saveAccessRuleFromForm);
```

Por fim, status de sincronização na ficha da pessoa — em `openAccessPersonModal` (já existe), adicionar ao final da função:

```javascript
  const syncEl = document.getElementById('accessPersonSyncStatus');
  if (syncEl) {
    if (item.id) {
      syncEl.textContent = 'Carregando status de sincronizacao...';
      apiJson(`/api/access-control/events?person_id=${encodeURIComponent(item.id)}&limit=1`, { cacheTtl: 0 })
        .then(res => {
          const last = (res?.events || [])[0];
          syncEl.textContent = last ? `Ultimo evento: ${last.event_type} em ${last.occurred_at}` : 'Sem eventos registrados ainda.';
        })
        .catch(() => { syncEl.textContent = ''; });
    } else {
      syncEl.textContent = '';
    }
  }
```

E em `frontend/index.html`, dentro de `#modalAccessPerson` (modal de pessoa já existente), adicionar `<p id="accessPersonSyncStatus" class="muted-block"></p>` logo abaixo do campo de notas.

- [ ] **Step 4: Run test to verify it passes**

Run: `python scripts/sightops_access_control_shell_test.py`
Expected: `OK access control shell`

- [ ] **Step 5: Bump cache-busting version, rodar suite completa e commit**

Incrementar `js/accessControl.js?v=3` pra `?v=4` em `frontend/index.html`.

Run: `node --check frontend/js/accessControl.js`
Run: `python scripts/check.py` (suíte completa do projeto — confirmar que nada quebrou fora do esperado, comparando contra os 5 grupos de falha pré-existentes já catalogados em `docs/HANDOFF_AGENTES.md`)

```bash
git add frontend/index.html frontend/js/accessControl.js scripts/sightops_access_control_shell_test.py
git commit -m "feat(access-control): modais completos de grupo/regra + status de sync na ficha da pessoa"
```

---

## Self-Review

**1. Cobertura da spec:**
- Grupo de pessoas / grupo de portas / regra com horário e dia → Tasks 1, 2, 9, 10. ✓
- Provisionar credencial automaticamente → Tasks 4, 5, 6 (`api_access_control_save_person` chama `provision_person_everywhere`). ✓
- Botão de abrir porta manual → Tasks 4, 6, 8. ✓
- Ingestão de eventos de entrada/saída → Tasks 3, 5, 7. ✓
- Senha de dispositivo cifrada → Task 3 (`encrypt`/`decrypt`, nunca devolvida em `_device_row_dict`). ✓
- Erro real do dispositivo propagado → Task 4 (`HTTPException` com `resp.text`). ✓
- Provisionamento não bloqueia salvar pessoa → Task 6 (`api_access_control_save_person` só marca `pending`; quem chama o dispositivo de fato é o loop de fundo da Task 7). ✓
- Fase 2 (calendário/WhatsApp) → explicitamente fora deste plano, conforme spec.

**Ajuste feito nesta auto-revisão (já aplicado no texto da Task 6 acima, não é uma nota separada a aplicar depois):** a primeira versão deste plano tinha `api_access_control_save_person` chamando `provision_person_everywhere` de forma síncrona antes de responder — se o dispositivo estivesse lento/offline, a request HTTP de salvar pessoa ficaria presa até o timeout, contradizendo o Global Constraint. O código do endpoint na Task 6 acima já está corrigido (só marca `pending` via `upsert_provision_status`, sem chamar o dispositivo). `provision_person_everywhere` continua existindo e é usado só pelo endpoint explícito `/people/{id}/sync`, onde o usuário está esperando ativamente uma ação imediata e um timeout curto é aceitável.

(marca como `pending` na hora, sem chamar o dispositivo — o loop de fundo da Task 7, que já roda a cada 60-900s, pega e provisiona de verdade). `provision_person_everywhere` continua existindo e sendo usado só pelo endpoint explícito `/people/{id}/sync` (Task 6), onde o usuário está esperando ativamente uma ação imediata e um timeout curto é aceitável.

**2. Placeholder scan:** os únicos `// TODO` do plano (Task 9, `openAccess*Modal` vazios) são explicitamente resolvidos na Task 10 seguinte, com o motivo documentado — não são placeholders esquecidos, são decomposição de task intencional.

**3. Consistência de tipos:** `resolve_target_devices_for_person(person_id: str) -> list[dict]` (Task 5) é consumido em Task 6 com a mesma assinatura; `provision_person_everywhere(person: dict) -> dict` idem. `get_device_with_password` devolve `password` em texto claro (só usado internamente por `access_control_device.py`/`access_control_sync.py`, nunca serializado numa resposta HTTP) — consistente em todas as tasks que o usam.

**4. Escopo:** o plano cobre só a Fase 1. Fase 2 fica de fora, como combinado.

---

Plan complete and saved to `docs/superpowers/plans/2026-08-16-controle-de-acesso-fase1.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
