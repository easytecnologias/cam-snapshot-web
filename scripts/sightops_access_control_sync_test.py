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


def test_resolve_ignores_inactive_rule_and_inactive_device() -> None:
    token = set_current_tenant_slug("cliente-sync-3")
    try:
        person = save_person({"full_name": "Carla Teste", "site": "Sede"})
        device = save_device({
            "name": "Catraca Portao", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.33", "username": "admin", "password": "xzydsP2011",
        })
        inactive_device = save_device({
            "name": "Catraca Desligada", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.34", "username": "admin", "password": "xzydsP2011",
            "active": False,
        })
        group = save_group({"name": "Alunos", "site": "Sede"})
        set_group_members(group["id"], [person["id"]])
        door_group = save_door_group({"name": "Portao", "site": "Sede"})
        set_door_group_members(door_group["id"], [device["id"], inactive_device["id"]])
        save_rule({"people_group_id": group["id"], "door_group_id": door_group["id"]})
        inactive_group = save_group({"name": "Ex-Alunos", "site": "Sede"})
        set_group_members(inactive_group["id"], [person["id"]])
        other_door_group = save_door_group({"name": "Outra Porta", "site": "Sede"})
        another_device = save_device({
            "name": "Catraca Outra", "site": "Sede", "vendor": "dahua",
            "host": "10.10.13.35", "username": "admin", "password": "xzydsP2011",
        })
        set_door_group_members(other_door_group["id"], [another_device["id"]])
        save_rule({
            "people_group_id": inactive_group["id"],
            "door_group_id": other_door_group["id"],
            "active": False,
        })

        targets = resolve_target_devices_for_person(person["id"])
        target_ids = {t["id"] for t in targets}
        assert target_ids == {device["id"]}
    finally:
        reset_current_tenant_slug(token)


def test_resolve_returns_empty_for_person_with_no_groups() -> None:
    token = set_current_tenant_slug("cliente-sync-4")
    try:
        person = save_person({"full_name": "Diego Teste", "site": "Sede"})
        targets = resolve_target_devices_for_person(person["id"])
        assert targets == []
    finally:
        reset_current_tenant_slug(token)


def main() -> None:
    with tempfile.TemporaryDirectory(prefix="sightops-access-sync-") as tmp:
        db_store.SIGHTOPS_DB_PATH = Path(tmp) / "access.db"
        db_store.init_db()
        test_resolve_and_provision()
        test_provision_failure_is_recorded_not_raised()
        test_resolve_ignores_inactive_rule_and_inactive_device()
        test_resolve_returns_empty_for_person_with_no_groups()
    print("OK access control sync: resolucao de regra e provisionamento nao bloqueante")


if __name__ == "__main__":
    main()
