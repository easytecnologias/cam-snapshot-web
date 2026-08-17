from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List

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
