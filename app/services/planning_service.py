from __future__ import annotations

import csv
import io
import ipaddress
import json
import uuid
from typing import Any, Dict, Iterable, List

from app.services.db_store import _conn, _current_tenant_slug


PROJECT_STATUSES = {"draft", "planned", "approved", "deploying", "completed"}
DEVICE_TYPES = {"camera", "onu", "ont", "olt", "switch", "recorder", "box", "pole", "other"}


def _project_row(row: Any) -> Dict[str, Any]:
    item = dict(row)
    item["id"] = int(item["id"])
    return item


def _require_project(c: Any, project_id: int, tenant: str) -> Dict[str, Any]:
    row = c.execute(
        "SELECT * FROM planning_projects WHERE id=? AND tenant_slug=?",
        (int(project_id), tenant),
    ).fetchone()
    if not row:
        raise LookupError("Projeto nao encontrado")
    return _project_row(row)


def list_projects() -> List[Dict[str, Any]]:
    tenant = _current_tenant_slug()
    with _conn() as c:
        rows = c.execute(
            """
            SELECT p.*,
                   COUNT(DISTINCT s.id) AS sites_count,
                   COUNT(DISTINCT d.id) AS devices_count,
                   COUNT(DISTINCT CASE WHEN d.device_type='camera' THEN d.id END) AS cameras_count,
                   COUNT(DISTINCT CASE WHEN d.device_type IN ('onu','ont') THEN d.id END) AS onus_count
            FROM planning_projects p
            LEFT JOIN planning_project_sites s ON s.project_id=p.id AND s.tenant_slug=p.tenant_slug
            LEFT JOIN planning_devices d ON d.project_id=p.id AND d.tenant_slug=p.tenant_slug
            WHERE p.tenant_slug=?
            GROUP BY p.id
            ORDER BY p.updated_at DESC, p.id DESC
            """,
            (tenant,),
        ).fetchall()
    return [_project_row(row) for row in rows]


def get_project(project_id: int) -> Dict[str, Any] | None:
    tenant = _current_tenant_slug()
    with _conn() as c:
        try:
            project = _require_project(c, project_id, tenant)
        except LookupError:
            return None
        sites = [dict(row) for row in c.execute(
            "SELECT * FROM planning_project_sites WHERE project_id=? AND tenant_slug=? ORDER BY name",
            (int(project_id), tenant),
        ).fetchall()]
        devices = [dict(row) for row in c.execute(
            """
            SELECT d.*, s.name AS site_name, p.name AS parent_name
            FROM planning_devices d
            LEFT JOIN planning_project_sites s ON s.id=d.site_id AND s.tenant_slug=d.tenant_slug
            LEFT JOIN planning_devices p ON p.id=d.parent_id AND p.tenant_slug=d.tenant_slug
            WHERE d.project_id=? AND d.tenant_slug=?
            ORDER BY CASE d.device_type WHEN 'olt' THEN 1 WHEN 'onu' THEN 2 WHEN 'ont' THEN 2
                     WHEN 'switch' THEN 3 WHEN 'camera' THEN 4 ELSE 5 END, d.name
            """,
            (int(project_id), tenant),
        ).fetchall()]
    project["sites"] = sites
    project["devices"] = devices
    return project


def save_project(payload: Dict[str, Any], project_id: int | None = None) -> Dict[str, Any]:
    tenant = _current_tenant_slug()
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("Informe o nome do projeto")
    status = str(payload.get("status") or "draft").strip().lower()
    if status not in PROJECT_STATUSES:
        raise ValueError("Situacao do projeto invalida")
    fields = {
        "name": name,
        "client_name": str(payload.get("client_name") or "").strip(),
        "description": str(payload.get("description") or "").strip(),
        "status": status,
        "kmz_layer_id": str(payload.get("kmz_layer_id") or "").strip(),
    }
    with _conn() as c:
        if project_id:
            _require_project(c, project_id, tenant)
            c.execute(
                """UPDATE planning_projects SET name=?, client_name=?, description=?, status=?,
                   kmz_layer_id=?, updated_at=datetime('now') WHERE id=? AND tenant_slug=?""",
                (*fields.values(), int(project_id), tenant),
            )
            saved_id = int(project_id)
        else:
            key = uuid.uuid4().hex
            c.execute(
                """INSERT INTO planning_projects
                   (tenant_slug, project_key, name, client_name, description, status, kmz_layer_id)
                   VALUES(?,?,?,?,?,?,?)""",
                (tenant, key, *fields.values()),
            )
            row = c.execute(
                "SELECT id FROM planning_projects WHERE tenant_slug=? AND project_key=?",
                (tenant, key),
            ).fetchone()
            saved_id = int(row["id"])
        c.commit()
    return get_project(saved_id) or {}


def delete_project(project_id: int) -> bool:
    tenant = _current_tenant_slug()
    with _conn() as c:
        cur = c.execute(
            "DELETE FROM planning_projects WHERE id=? AND tenant_slug=?",
            (int(project_id), tenant),
        )
        c.commit()
        return bool(cur.rowcount)


def save_site(project_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    tenant = _current_tenant_slug()
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("Informe o site/local")
    notes = str(payload.get("notes") or "").strip()
    with _conn() as c:
        _require_project(c, project_id, tenant)
        c.execute(
            """INSERT INTO planning_project_sites(tenant_slug, project_id, name, notes)
               VALUES(?,?,?,?) ON CONFLICT(tenant_slug, project_id, name)
               DO UPDATE SET notes=excluded.notes""",
            (tenant, int(project_id), name, notes),
        )
        row = c.execute(
            "SELECT * FROM planning_project_sites WHERE tenant_slug=? AND project_id=? AND name=?",
            (tenant, int(project_id), name),
        ).fetchone()
        c.commit()
    return dict(row)


def _optional_float(value: Any) -> float | None:
    if value in (None, ""):
        return None
    return float(str(value).replace(",", "."))


def save_device(project_id: int, payload: Dict[str, Any], device_id: int | None = None) -> Dict[str, Any]:
    tenant = _current_tenant_slug()
    dtype = str(payload.get("device_type") or "camera").strip().lower()
    if dtype not in DEVICE_TYPES:
        raise ValueError("Tipo de equipamento invalido")
    name = str(payload.get("name") or "").strip()
    if not name:
        raise ValueError("Informe o nome do equipamento")
    ip = str(payload.get("ip") or "").strip()
    if ip:
        ipaddress.ip_address(ip)
    site_id = int(payload["site_id"]) if payload.get("site_id") else None
    parent_id = int(payload["parent_id"]) if payload.get("parent_id") else None
    values = (
        site_id, parent_id, dtype, name, ip,
        str(payload.get("manufacturer") or "").strip(),
        str(payload.get("model") or "").strip(),
        str(payload.get("pon") or "").strip(),
        str(payload.get("onu_position") or "").strip(),
        _optional_float(payload.get("latitude")), _optional_float(payload.get("longitude")),
        str(payload.get("reference_image_url") or "").strip(),
        str(payload.get("notes") or "").strip(),
        json.dumps(payload.get("metadata") or {}, ensure_ascii=False),
        str(payload.get("status") or "planned").strip().lower(),
    )
    with _conn() as c:
        _require_project(c, project_id, tenant)
        if site_id:
            site = c.execute(
                "SELECT id FROM planning_project_sites WHERE id=? AND project_id=? AND tenant_slug=?",
                (site_id, int(project_id), tenant),
            ).fetchone()
            if not site:
                raise ValueError("Site nao pertence a este projeto")
        if device_id:
            row = c.execute(
                "SELECT id FROM planning_devices WHERE id=? AND project_id=? AND tenant_slug=?",
                (int(device_id), int(project_id), tenant),
            ).fetchone()
            if not row:
                raise LookupError("Equipamento planejado nao encontrado")
            c.execute(
                """UPDATE planning_devices SET site_id=?, parent_id=?, device_type=?, name=?, ip=?,
                   manufacturer=?, model=?, pon=?, onu_position=?, latitude=?, longitude=?,
                   reference_image_url=?, notes=?, metadata_json=?, status=?, updated_at=datetime('now')
                   WHERE id=? AND project_id=? AND tenant_slug=?""",
                (*values, int(device_id), int(project_id), tenant),
            )
            saved_id = int(device_id)
        else:
            key = uuid.uuid4().hex
            c.execute(
                """INSERT INTO planning_devices
                   (tenant_slug, device_key, project_id, site_id, parent_id, device_type, name, ip,
                    manufacturer, model, pon, onu_position, latitude, longitude, reference_image_url,
                    notes, metadata_json, status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (tenant, key, int(project_id), *values),
            )
            row = c.execute(
                "SELECT id FROM planning_devices WHERE tenant_slug=? AND device_key=?",
                (tenant, key),
            ).fetchone()
            saved_id = int(row["id"])
        c.execute(
            "UPDATE planning_projects SET updated_at=datetime('now') WHERE id=? AND tenant_slug=?",
            (int(project_id), tenant),
        )
        saved = c.execute(
            "SELECT * FROM planning_devices WHERE id=? AND tenant_slug=?",
            (saved_id, tenant),
        ).fetchone()
        c.commit()
    return dict(saved)


def delete_device(project_id: int, device_id: int) -> bool:
    tenant = _current_tenant_slug()
    with _conn() as c:
        cur = c.execute(
            "DELETE FROM planning_devices WHERE id=? AND project_id=? AND tenant_slug=?",
            (int(device_id), int(project_id), tenant),
        )
        c.commit()
        return bool(cur.rowcount)


def generate_devices(project_id: int, payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    count = max(1, min(int(payload.get("count") or 1), 500))
    first_number = int(payload.get("first_number") or 1)
    digits = max(1, min(int(payload.get("digits") or 2), 4))
    template = str(payload.get("name_template") or "{number} - CAMERA").strip()
    start_ip = str(payload.get("start_ip") or "").strip()
    base_ip = int(ipaddress.ip_address(start_ip)) if start_ip else None
    rows: List[Dict[str, Any]] = []
    for offset in range(count):
        number = str(first_number + offset).zfill(digits)
        item = dict(payload)
        item["name"] = template.replace("{number}", number).replace("{n}", str(first_number + offset))
        item["ip"] = str(ipaddress.ip_address(base_ip + offset)) if base_ip is not None else ""
        for key in ("count", "first_number", "digits", "name_template", "start_ip"):
            item.pop(key, None)
        rows.append(save_device(project_id, item))
    return rows


def import_csv(project_id: int, raw: bytes, defaults: Dict[str, Any]) -> Dict[str, Any]:
    text = raw.decode("utf-8-sig", errors="replace")
    sample = text[:4096]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    except csv.Error:
        dialect = csv.excel
    reader = csv.DictReader(io.StringIO(text), dialect=dialect)
    aliases = {
        "tipo": "device_type", "equipamento": "device_type", "nome": "name", "titulo": "name",
        "fabricante": "manufacturer", "modelo": "model", "pon": "pon", "onu": "onu_position",
        "latitude": "latitude", "lat": "latitude", "longitude": "longitude", "lon": "longitude",
        "imagem": "reference_image_url", "foto": "reference_image_url", "observacoes": "notes",
        "observacao": "notes", "ip": "ip", "site": "site", "local": "site",
    }
    imported: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    for line_number, row in enumerate(reader, start=2):
        normalized = dict(defaults)
        for key, value in row.items():
            clean = str(key or "").strip().lower()
            normalized[aliases.get(clean, clean)] = str(value or "").strip()
        if not normalized.get("name"):
            errors.append({"line": line_number, "error": "nome ausente"})
            continue
        try:
            site_name = str(normalized.pop("site", "") or "").strip()
            if site_name:
                normalized["site_id"] = save_site(project_id, {"name": site_name}).get("id")
            imported.append(save_device(project_id, normalized))
        except Exception as exc:
            errors.append({"line": line_number, "error": str(exc)})
    return {"ok": not errors, "imported": len(imported), "errors": errors, "items": imported}
