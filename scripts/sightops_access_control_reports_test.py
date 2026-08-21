from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path


def main() -> None:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    with tempfile.TemporaryDirectory() as tmp:
        os.environ["DATABASE_BACKEND"] = "sqlite"
        os.environ["SIGHTOPS_DB_PATH"] = os.path.join(tmp, "sightops-access-control.db")
        os.environ["SIGHTOPS_SECRET_KEY"] = "sightops-access-control-reports-test-key"

        from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
        from app.services.access_control_store import (
            access_report_summary,
            ensure_access_control_schema,
            list_access_report_events,
            list_devices,
            record_event,
            record_manual_exit,
            save_device,
            save_person,
        )

        token = set_current_tenant_slug("rads")
        try:
            ensure_access_control_schema()
            person = save_person(
                {
                    "full_name": "Aluno Teste",
                    "person_type": "student",
                    "document_id": "123",
                    "site": "ESCOLA",
                    "active": True,
                }
            )
            entry_device = save_device(
                {
                    "name": "Portaria Entrada",
                    "site": "ESCOLA",
                    "host": "10.0.0.10",
                    "username": "admin",
                    "password": "12345678",
                    "access_direction": "entrada",
                    "active": True,
                }
            )
            exit_device = save_device(
                {
                    "name": "Portaria Saida",
                    "site": "ESCOLA",
                    "host": "10.0.0.11",
                    "username": "admin",
                    "password": "12345678",
                    "access_direction": "saida",
                    "active": True,
                }
            )
            assert {row["access_direction"] for row in list_devices()} == {"entrada", "saida"}

            record_event(
                {
                    "device_id": entry_device["id"],
                    "device_role": entry_device["access_direction"],
                    "person_id": person["id"],
                    "person_name_raw": person["full_name"],
                    "event_type": "entrada",
                    "raw_event_id": "entry-1",
                    "occurred_at": "2026-08-20 07:10:00",
                }
            )
            record_event(
                {
                    "site": "ESCOLA",
                    "device_id": exit_device["id"],
                    "device_name": exit_device["name"],
                    "device_role": exit_device["access_direction"],
                    "person_id": person["id"],
                    "person_name_raw": person["full_name"],
                    "event_type": "saida",
                    "raw_event_id": "exit-1",
                    "occurred_at": "2026-08-20 11:40:00",
                }
            )
            manual = record_manual_exit(person["id"], site="ESCOLA", reason="responsavel buscou", operator_user="admin")

            summary = access_report_summary({"period": "all", "site": "ESCOLA"})
            assert summary["entries"] == 1, summary
            assert summary["exits"] == 1, summary
            assert summary["manual_exits"] == 1, summary
            assert summary["inside_now"] == 0, summary

            entry_events = list_access_report_events({"period": "all", "type": "entrada", "site": "ESCOLA"})
            assert len(entry_events) == 1, entry_events
            assert entry_events[0]["site"] == "ESCOLA", entry_events
            assert entry_events[0]["device_name"] == "Portaria Entrada", entry_events
            assert entry_events[0]["person_document"] == "123", entry_events

            manual_events = list_access_report_events({"period": "all", "type": "saida_manual", "site": "ESCOLA"})
            assert len(manual_events) == 1, manual_events
            assert manual_events[0]["id"] == manual["id"], manual_events
            assert manual_events[0]["source"] == "manual", manual_events
        finally:
            reset_current_tenant_slug(token)

        token = set_current_tenant_slug("outro-cliente")
        try:
            ensure_access_control_schema()
            assert list_access_report_events({"period": "all"}) == []
            assert access_report_summary({"period": "all"})["total"] == 0
        finally:
            reset_current_tenant_slug(token)

    print("access-control reports regression ok")


if __name__ == "__main__":
    main()
