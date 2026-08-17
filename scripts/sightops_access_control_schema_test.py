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
