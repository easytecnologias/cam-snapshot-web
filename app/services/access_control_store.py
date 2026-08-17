from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List

from app.core.crypto import decrypt, encrypt
from app.services import db_store


def _clean_text(value: Any, limit: int = 255) -> str:
    return str(value or "").strip()[:limit]


def _clean_phone(value: Any) -> str:
    raw = str(value or "").strip()
    return re.sub(r"[^\d+]", "", raw)[:32]


def _bool_int(value: Any, default: bool = True) -> int:
    if value is None:
        return 1 if default else 0
    if isinstance(value, str):
        return 0 if value.strip().lower() in {"0", "false", "nao", "não", "no", "off"} else 1
    return 1 if bool(value) else 0


# Colunas acrescentadas a tabelas que JA EXISTIAM antes deste plano
# (access_people e access_devices ja rodavam em homologacao). CREATE TABLE IF
# NOT EXISTS e no-op quando a tabela existe, entao sem esta migration aditiva
# o banco antigo nunca ganharia essas colunas e o primeiro list_people()/
# list_devices() quebraria com "no such column: site".
_ADDITIVE_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("access_people", "site", "TEXT NOT NULL DEFAULT ''"),
    ("access_devices", "password_enc", "TEXT NOT NULL DEFAULT ''"),
    ("access_devices", "status", "TEXT NOT NULL DEFAULT 'unknown'"),
    ("access_devices", "last_seen_at", "TEXT NOT NULL DEFAULT ''"),
    ("access_devices", "last_event_id", "TEXT NOT NULL DEFAULT ''"),
)


def _table_exists(c: Any, backend: str, table: str) -> bool:
    try:
        if str(backend or "sqlite").strip().lower() == "postgres":
            query = (
                "SELECT 1 AS ok FROM information_schema.tables "
                "WHERE table_name = ? AND table_schema NOT IN ('pg_catalog', 'information_schema')"
            )
        else:
            query = "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?"
        return c.execute(db_store._sql_for_backend(backend, query), (table,)).fetchone() is not None
    except Exception:
        return False


def _column_exists(c: Any, backend: str, table: str, column: str) -> bool:
    """Mesma convencao de db_store (_sqlite_columns no SQLite, information_schema no Postgres)."""
    try:
        if str(backend or "sqlite").strip().lower() == "postgres":
            query = "SELECT 1 AS ok FROM information_schema.columns WHERE table_name = ? AND column_name = ?"
            return c.execute(db_store._sql_for_backend(backend, query), (table, column)).fetchone() is not None
        return column in db_store._sqlite_columns(c, table)
    except Exception:
        return False


def _apply_additive_columns(c: Any, backend: str) -> None:
    """ALTER TABLE ... ADD COLUMN guardado, para bancos que ja tinham as tabelas.

    Roda ANTES do script de CREATE TABLE/CREATE INDEX de proposito: os indices
    idx_access_people_tenant_site / idx_access_devices_tenant_site referenciam
    justamente as colunas novas, entao num banco antigo o CREATE INDEX
    estouraria ("no such column: site") antes de qualquer ALTER que viesse
    depois. Instalacao nova cai no guard de tabela inexistente e e atendida
    normalmente pelo CREATE TABLE IF NOT EXISTS logo abaixo, que ja traz todas
    as colunas.
    """
    is_postgres = str(backend or "sqlite").strip().lower() == "postgres"
    for table, column, column_ddl in _ADDITIVE_COLUMNS:
        if not _table_exists(c, backend, table):
            continue
        if _column_exists(c, backend, table, column):
            continue
        # table/column/column_ddl vem so da constante acima, nunca de input.
        # No Postgres ainda usamos IF NOT EXISTS como segunda rede: a consulta a
        # information_schema nao filtra por schema, entao a checagem acima pode
        # errar num banco com search_path incomum -- e ai o ALTER cru abortaria
        # o ensure_access_control_schema inteiro. SQLite nao aceita essa clausula.
        if_not_exists = "IF NOT EXISTS " if is_postgres else ""
        c.execute(f"ALTER TABLE {table} ADD COLUMN {if_not_exists}{column} {column_ddl}")


def ensure_access_control_schema() -> None:
    backend = db_store._db_backend()
    with db_store._conn() as c:
        _apply_additive_columns(c, backend)
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
            """,
        )


def _row_dict(row: Any) -> Dict[str, Any]:
    data = dict(row)
    data["whatsapp_enabled"] = bool(int(data.get("whatsapp_enabled") or 0))
    data["active"] = bool(int(data.get("active") or 0))
    return data


def list_people(search: str = "", active: str = "") -> List[Dict[str, Any]]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    term = _clean_text(search, 120).lower()
    active_filter = str(active or "").strip().lower()
    where = ["tenant_slug = ?"]
    params: list[Any] = [tenant]
    if term:
        like = f"%{term}%"
        where.append(
            "(lower(full_name) LIKE ? OR lower(document_id) LIKE ? OR lower(enrollment_code) LIKE ? OR lower(guardian_phone) LIKE ?)"
        )
        params.extend([like, like, like, like])
    if active_filter in {"1", "true", "active", "ativo"}:
        where.append("active = 1")
    elif active_filter in {"0", "false", "inactive", "inativo"}:
        where.append("active = 0")

    with db_store._conn() as c:
        rows = c.execute(
            f"""
            SELECT id, tenant_slug, full_name, person_type, document_id, enrollment_code,
                   class_name, site, guardian_name, guardian_phone, whatsapp_enabled, active,
                   notes, created_at, updated_at
            FROM access_people
            WHERE {' AND '.join(where)}
            ORDER BY active DESC, full_name COLLATE NOCASE
            """,
            tuple(params),
        ).fetchall()
    return [_row_dict(r) for r in rows]


def save_person(payload: Dict[str, Any]) -> Dict[str, Any]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    person_id = _clean_text(payload.get("id"), 80) or uuid.uuid4().hex
    full_name = _clean_text(payload.get("full_name") or payload.get("name"), 160)
    if not full_name:
        raise ValueError("Informe o nome da pessoa.")
    person_type = _clean_text(payload.get("person_type") or "student", 32).lower() or "student"
    document_id = _clean_text(payload.get("document_id"), 64)
    enrollment_code = _clean_text(payload.get("enrollment_code"), 64)
    class_name = _clean_text(payload.get("class_name"), 80)
    site = _clean_text(payload.get("site"), 120)
    guardian_name = _clean_text(payload.get("guardian_name"), 160)
    guardian_phone = _clean_phone(payload.get("guardian_phone"))
    whatsapp_enabled = _bool_int(payload.get("whatsapp_enabled"), True)
    active = _bool_int(payload.get("active"), True)
    notes = _clean_text(payload.get("notes"), 500)

    with db_store._conn() as c:
        c.execute(
            """
            INSERT INTO access_people(
              id, tenant_slug, full_name, person_type, document_id, enrollment_code,
              class_name, site, guardian_name, guardian_phone, whatsapp_enabled, active,
              notes, created_at, updated_at
            )
            VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
            ON CONFLICT(id) DO UPDATE SET
              full_name=excluded.full_name,
              person_type=excluded.person_type,
              document_id=excluded.document_id,
              enrollment_code=excluded.enrollment_code,
              class_name=excluded.class_name,
              site=excluded.site,
              guardian_name=excluded.guardian_name,
              guardian_phone=excluded.guardian_phone,
              whatsapp_enabled=excluded.whatsapp_enabled,
              active=excluded.active,
              notes=excluded.notes,
              updated_at=datetime('now')
            WHERE access_people.tenant_slug=excluded.tenant_slug
            """,
            (
                person_id,
                tenant,
                full_name,
                person_type,
                document_id,
                enrollment_code,
                class_name,
                site,
                guardian_name,
                guardian_phone,
                whatsapp_enabled,
                active,
                notes,
            ),
        )
        row = c.execute(
            """
            SELECT id, tenant_slug, full_name, person_type, document_id, enrollment_code,
                   class_name, site, guardian_name, guardian_phone, whatsapp_enabled, active,
                   notes, created_at, updated_at
            FROM access_people
            WHERE tenant_slug=? AND id=?
            """,
            (tenant, person_id),
        ).fetchone()
    if row is None:
        raise ValueError("Pessoa nao encontrada neste cliente.")
    return _row_dict(row)


def delete_person(person_id: str) -> bool:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    pid = _clean_text(person_id, 80)
    if not pid:
        return False
    with db_store._conn() as c:
        cur = c.execute("DELETE FROM access_people WHERE tenant_slug=? AND id=?", (tenant, pid))
        return int(cur.rowcount or 0) > 0


def access_control_summary() -> Dict[str, Any]:
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    with db_store._conn() as c:
        people = c.execute(
            """
            SELECT
              COUNT(1) AS total,
              SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active_total,
              SUM(CASE WHEN person_type='student' THEN 1 ELSE 0 END) AS students
            FROM access_people
            WHERE tenant_slug=?
            """,
            (tenant,),
        ).fetchone()
        devices = c.execute(
            """
            SELECT
              COUNT(1) AS total,
              SUM(CASE WHEN active=1 THEN 1 ELSE 0 END) AS active_total
            FROM access_devices
            WHERE tenant_slug=?
            """,
            (tenant,),
        ).fetchone()
    people_data = dict(people) if people else {}
    devices_data = dict(devices) if devices else {}
    return {
        "people_total": int(people_data.get("total") or 0),
        "people_active": int(people_data.get("active_total") or 0),
        "students": int(people_data.get("students") or 0),
        "devices_total": int(devices_data.get("total") or 0),
        "devices_active": int(devices_data.get("active_total") or 0),
        "events_today": 0,
        "whatsapp_queue": 0,
    }


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
    """Grava um evento de acesso, ignorando duplicatas.

    O device do controle de acesso ainda nao filtra por since_id (ver
    poll_device_events em access_control_sync.py), entao cada poll do loop
    de fundo (Task 7) reenvia o indice de eventos inteiro do equipamento.
    Sem essa deduplicacao, access_events cresceria sem limite com o mesmo
    conjunto de eventos repetido a cada ciclo. Tratamos como duplicata
    qualquer evento com a mesma tupla (tenant_slug, device_id,
    person_name_raw, event_type, occurred_at) ja gravada -- se ja existir,
    devolve o id existente em vez de inserir de novo.
    """
    ensure_access_control_schema()
    tenant = db_store._current_tenant_slug()
    device_id = _clean_text(event.get("device_id"), 80)
    person_name_raw = _clean_text(event.get("person_name_raw"), 160)
    event_type = _clean_text(event.get("event_type"), 20) or "entrada"
    occurred_at = _clean_text(event.get("occurred_at"), 40)
    with db_store._conn() as c:
        existing = c.execute(
            """
            SELECT id FROM access_events
            WHERE tenant_slug = ? AND device_id = ? AND person_name_raw = ?
              AND event_type = ? AND occurred_at = ?
            """,
            (tenant, device_id, person_name_raw, event_type, occurred_at),
        ).fetchone()
        if existing:
            return str(existing["id"])
        event_id = uuid.uuid4().hex
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
                device_id,
                _clean_text(event.get("person_id"), 80),
                person_name_raw,
                event_type,
                occurred_at,
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
