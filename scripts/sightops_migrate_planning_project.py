from __future__ import annotations

import argparse
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any

ROOT = Path(os.environ.get("SIGHTOPS_APP_ROOT") or ("/app" if Path("/app/app").is_dir() else Path(__file__).resolve().parents[1]))
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.core.tenant_context import set_current_tenant_slug  # noqa: E402
from app.services import db_store  # noqa: E402
from app.services.db_store import _conn, _fetchall_on  # noqa: E402


PROJECT_COLUMNS = (
    "project_key",
    "name",
    "client_name",
    "description",
    "status",
    "kmz_layer_id",
    "created_at",
    "updated_at",
)
SITE_COLUMNS = ("name", "notes", "created_at")
DEVICE_COLUMNS = (
    "device_key",
    "site_id",
    "parent_id",
    "device_type",
    "name",
    "ip",
    "manufacturer",
    "model",
    "pon",
    "onu_position",
    "latitude",
    "longitude",
    "reference_image_url",
    "notes",
    "metadata_json",
    "status",
    "created_at",
    "updated_at",
)


def _backend() -> str:
    return getattr(db_store, "_db_backend", lambda: "postgres")()


def _rows(sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
    with _conn() as c:
        return [dict(r) for r in _fetchall_on(c, _backend(), sql, params)]


def _one(sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
    rows = _rows(sql, params)
    return rows[0] if rows else None


def export_project(tenant: str, project_name: str) -> dict[str, Any]:
    set_current_tenant_slug(tenant)
    project = _one(
        """
        SELECT *
        FROM planning_projects
        WHERE tenant_slug=? AND lower(name)=lower(?)
        ORDER BY updated_at DESC, id DESC
        LIMIT 1
        """,
        (tenant, project_name),
    )
    if not project:
        raise SystemExit(f"Projeto {project_name!r} nao encontrado no tenant {tenant!r}.")

    project_id = int(project["id"])
    sites = _rows(
        "SELECT * FROM planning_project_sites WHERE tenant_slug=? AND project_id=? ORDER BY id",
        (tenant, project_id),
    )
    devices = _rows(
        "SELECT * FROM planning_devices WHERE tenant_slug=? AND project_id=? ORDER BY id",
        (tenant, project_id),
    )
    return {
        "source_tenant": tenant,
        "project": project,
        "sites": sites,
        "devices": devices,
    }


def import_project(payload: dict[str, Any], tenant: str, replace: bool = False) -> dict[str, Any]:
    set_current_tenant_slug(tenant)
    source_project = dict(payload["project"])
    sites = [dict(row) for row in payload.get("sites") or []]
    devices = [dict(row) for row in payload.get("devices") or []]
    project_name = str(source_project.get("name") or "").strip()
    if not project_name:
        raise SystemExit("Projeto exportado sem nome.")

    existing = _one(
        "SELECT id FROM planning_projects WHERE tenant_slug=? AND lower(name)=lower(?) ORDER BY id LIMIT 1",
        (tenant, project_name),
    )
    with _conn() as c:
        if existing:
            if not replace:
                raise SystemExit(f"Projeto {project_name!r} ja existe no tenant {tenant!r}. Use --replace para atualizar.")
            c.execute(
                "DELETE FROM planning_projects WHERE tenant_slug=? AND id=?",
                (tenant, int(existing["id"])),
            )

        key = str(source_project.get("project_key") or uuid.uuid4().hex)
        key_exists = c.execute(
            "SELECT id FROM planning_projects WHERE tenant_slug=? AND project_key=?",
            (tenant, key),
        ).fetchone()
        if key_exists:
            key = uuid.uuid4().hex

        cur = c.execute(
            """
            INSERT INTO planning_projects
              (tenant_slug, project_key, name, client_name, description, status, kmz_layer_id, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            RETURNING id
            """,
            (
                tenant,
                key,
                project_name,
                source_project.get("client_name") or "",
                source_project.get("description") or "",
                source_project.get("status") or "draft",
                source_project.get("kmz_layer_id") or "",
                source_project.get("created_at"),
                source_project.get("updated_at"),
            ),
        )
        new_project_id = int(cur.fetchone()["id"])

        site_id_map: dict[int, int] = {}
        for site in sites:
            cur = c.execute(
                """
                INSERT INTO planning_project_sites (tenant_slug, project_id, name, notes, created_at)
                VALUES (?,?,?,?,?)
                RETURNING id
                """,
                (
                    tenant,
                    new_project_id,
                    site.get("name") or "",
                    site.get("notes") or "",
                    site.get("created_at"),
                ),
            )
            site_id_map[int(site["id"])] = int(cur.fetchone()["id"])

        device_id_map: dict[int, int] = {}
        for device in devices:
            device_key = str(device.get("device_key") or uuid.uuid4().hex)
            key_exists = c.execute(
                "SELECT id FROM planning_devices WHERE tenant_slug=? AND device_key=?",
                (tenant, device_key),
            ).fetchone()
            if key_exists:
                device_key = uuid.uuid4().hex
            cur = c.execute(
                """
                INSERT INTO planning_devices
                  (tenant_slug, device_key, project_id, site_id, parent_id, device_type, name, ip,
                   manufacturer, model, pon, onu_position, latitude, longitude, reference_image_url,
                   notes, metadata_json, status, created_at, updated_at)
                VALUES (?,?,?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                RETURNING id
                """,
                (
                    tenant,
                    device_key,
                    new_project_id,
                    site_id_map.get(int(device["site_id"])) if device.get("site_id") else None,
                    device.get("device_type") or "other",
                    device.get("name") or "",
                    device.get("ip") or "",
                    device.get("manufacturer") or "",
                    device.get("model") or "",
                    device.get("pon") or "",
                    device.get("onu_position") or "",
                    device.get("latitude"),
                    device.get("longitude"),
                    device.get("reference_image_url") or "",
                    device.get("notes") or "",
                    device.get("metadata_json") or "{}",
                    device.get("status") or "planned",
                    device.get("created_at"),
                    device.get("updated_at"),
                ),
            )
            device_id_map[int(device["id"])] = int(cur.fetchone()["id"])

        for device in devices:
            parent_id = device.get("parent_id")
            if not parent_id:
                continue
            new_parent_id = device_id_map.get(int(parent_id))
            new_device_id = device_id_map.get(int(device["id"]))
            if new_parent_id and new_device_id:
                c.execute(
                    "UPDATE planning_devices SET parent_id=? WHERE tenant_slug=? AND project_id=? AND id=?",
                    (new_parent_id, tenant, new_project_id, new_device_id),
                )
        c.commit()

    counts = _rows(
        """
        SELECT p.id,
               COUNT(DISTINCT s.id) AS sites,
               COUNT(DISTINCT d.id) AS devices,
               COUNT(DISTINCT CASE WHEN d.device_type='camera' THEN d.id END) AS cameras,
               COUNT(DISTINCT CASE WHEN d.device_type IN ('onu','ont') THEN d.id END) AS onus,
               COUNT(DISTINCT CASE WHEN d.device_type='box' THEN d.id END) AS boxes
        FROM planning_projects p
        LEFT JOIN planning_project_sites s ON s.tenant_slug=p.tenant_slug AND s.project_id=p.id
        LEFT JOIN planning_devices d ON d.tenant_slug=p.tenant_slug AND d.project_id=p.id
        WHERE p.tenant_slug=? AND p.id=?
        GROUP BY p.id
        """,
        (tenant, new_project_id),
    )[0]
    return {"ok": True, "project_id": new_project_id, **counts}


def main() -> None:
    parser = argparse.ArgumentParser(description="Migra um projeto de implantacao do SightOps entre tenants/ambientes.")
    sub = parser.add_subparsers(dest="cmd", required=True)
    exp = sub.add_parser("export")
    exp.add_argument("--tenant", required=True)
    exp.add_argument("--project", required=True)
    exp.add_argument("--out", required=True)
    imp = sub.add_parser("import")
    imp.add_argument("--tenant", required=True)
    imp.add_argument("--infile", required=True)
    imp.add_argument("--replace", action="store_true")
    args = parser.parse_args()

    if args.cmd == "export":
        payload = export_project(args.tenant, args.project)
        Path(args.out).write_text(json.dumps(payload, ensure_ascii=False, default=str, indent=2), encoding="utf-8")
        print(json.dumps({"ok": True, "project": payload["project"]["name"], "sites": len(payload["sites"]), "devices": len(payload["devices"])}, ensure_ascii=False))
    elif args.cmd == "import":
        payload = json.loads(Path(args.infile).read_text(encoding="utf-8"))
        print(json.dumps(import_project(payload, args.tenant, args.replace), ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()
