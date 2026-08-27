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
        from app.services.db_store import init_db

        token = set_current_tenant_slug("escola-monitoring-test")
        try:
            init_db()
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
