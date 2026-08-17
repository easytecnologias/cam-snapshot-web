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

        # Cross-tenant isolation check: verify another tenant sees none of cliente-b's data
        other_token = set_current_tenant_slug("cliente-c-isolation-check")
        try:
            assert list_groups() == [], "grupo vazou pra outro tenant"
            assert list_door_groups() == [], "grupo de porta vazou pra outro tenant"
            assert list_rules() == [], "regra vazou pra outro tenant"
        finally:
            reset_current_tenant_slug(other_token)
    finally:
        reset_current_tenant_slug(token)


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

        # Keep a genuinely pending row under cliente-c before switching --
        # otherwise the cross-tenant check below would pass even if
        # tenant_slug filtering were broken (nothing pending anywhere).
        upsert_provision_status("p2", device["id"], "pending")

        # Cross-tenant isolation check: p2's pending provision under cliente-c
        # must NOT be visible to cliente-d. If tenant_slug filter is broken, test fails.
        other_token = set_current_tenant_slug("cliente-d-isolation-check")
        try:
            assert list_pending_provisions() == [], "provision status vazou pra outro tenant"
        finally:
            reset_current_tenant_slug(other_token)
    finally:
        reset_current_tenant_slug(token)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="sightops-access-schema-") as tmp:
        db_store.SIGHTOPS_DB_PATH = Path(tmp) / "access.db"
        db_store.init_db()
        test_person_has_site_column()
        test_group_tables_exist()
        test_group_and_rule_crud()
        test_device_event_and_provision_status()
    print("OK access control schema: site em pessoa + tabelas de grupo")


if __name__ == "__main__":
    main()
