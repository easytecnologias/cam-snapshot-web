from __future__ import annotations

import csv
import io
import ipaddress
import json
import uuid
from typing import Any, Dict, Iterable, List

from app.services.db_store import _conn, _current_tenant_slug


PROJECT_STATUSES = {"draft", "planned", "approved", "deploying", "completed"}
DEVICE_TYPES = {"camera", "onu", "ont", "olt", "switch", "injector", "cto", "recorder", "box", "pole", "other"}

KNOWN_CATALOG: Dict[str, Dict[str, List[str]]] = {
    "camera": {
        "Intelbras": ["VIP 1130 B G2", "VIP 1230 B G2", "VIP 3220 B", "VIP 3230 B", "VIP 3240 Z G2", "VIP 5230 SD"],
        "Hikvision": ["DS-2CD1023G0-I", "DS-2CD1123G0E-I", "DS-2CD2143G2-I"],
        "Dahua": ["IPC-HFW1230S", "IPC-HDW1230T", "IPC-HFW2431S-S2"],
        "Giga Security": ["GS0045", "GS0052"],
    },
    "onu": {
        "Intelbras": ["R1", "R1v2", "110Gi", "121W"],
        "FiberHome": ["AN5506-01-A", "AN5506-02-B", "HG6143D"],
        "Huawei": ["EG8010H", "EG8120L", "HG8245H"],
        "ZTE": ["F601", "F660", "F670L"],
    },
    "ont": {
        "Intelbras": ["110Gi", "121W"],
        "Huawei": ["EG8120L", "HG8245H"],
        "ZTE": ["F660", "F670L"],
    },
    "olt": {
        "Intelbras": ["8820i", "4840E"],
        "FiberHome": ["AN5516-01", "AN5516-04"],
        "Huawei": ["MA5608T", "MA5800-X7"],
        "ZTE": ["C320", "C600"],
    },
    "switch": {
        "Intelbras": ["S1026F-P", "S2328G-B", "SG 2404 PoE L2+"],
        "MikroTik": ["CRS112-8P-4S-IN", "CRS328-24P-4S+RM"],
        "Ubiquiti": ["USW-24-POE", "USW-Pro-24-POE"],
        "TP-Link": ["TL-SG2428P", "TL-SG3428XMP"],
    },
    "injector": {
        "Intelbras": ["Injetor PoE 15 W", "Injetor PoE 30 W"],
        "Ubiquiti": ["POE-24-12W", "U-POE-AF", "U-POE-AT"],
        "TP-Link": ["TL-POE150S", "TL-POE160S"],
    },
    "cto": {
        "Generica": ["CTO 1x8", "CTO 1x16"],
    },
    "recorder": {
        "Intelbras": ["NVD 1232", "NVD 1432", "NVD 3116 P", "MHDX 1216", "MHDX 1232"],
        "Hikvision": ["DS-7616NI-K2", "DS-7732NI-K4"],
        "Dahua": ["NVR4216-4KS2", "NVR4232-4KS2"],
    },
}


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


def list_equipment_catalog() -> List[Dict[str, str]]:
    """Une sugestoes conhecidas com fabricante/modelo ja usados pelo tenant."""
    tenant = _current_tenant_slug()
    values: set[tuple[str, str, str, str]] = set()
    for device_type, manufacturers in KNOWN_CATALOG.items():
        for manufacturer, models in manufacturers.items():
            for model in models:
                values.add((device_type, manufacturer, model, "known"))

    with _conn() as c:
        queries = (
            ("SELECT device_type, manufacturer, model FROM planning_devices WHERE tenant_slug=?", (tenant,), "project"),
            ("SELECT 'camera' AS device_type, fabricante AS manufacturer, modelo AS model FROM ip_cameras WHERE tenant_slug=?", (tenant,), "inventory"),
            ("SELECT 'olt' AS device_type, vendor AS manufacturer, model FROM olts WHERE tenant_slug=?", (tenant,), "inventory"),
            ("SELECT 'recorder' AS device_type, fabricante AS manufacturer, modelo AS model FROM recorders WHERE tenant_slug=?", (tenant,), "inventory"),
        )
        for query, params, source in queries:
            try:
                for row in c.execute(query, params).fetchall():
                    item = dict(row)
                    device_type = str(item.get("device_type") or "other").strip().lower()
                    manufacturer = str(item.get("manufacturer") or "").strip()
                    model = str(item.get("model") or "").strip()
                    if manufacturer or model:
                        values.add((device_type, manufacturer, model, source))
            except Exception:
                continue
    return [
        {"device_type": dtype, "manufacturer": manufacturer, "model": model, "source": source}
        for dtype, manufacturer, model, source in sorted(values, key=lambda value: (value[0], value[1].lower(), value[2].lower()))
    ]


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
    for device in devices:
        try:
            device["metadata"] = json.loads(device.get("metadata_json") or "{}")
        except (TypeError, ValueError):
            device["metadata"] = {}
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


def assemble_gpon_box(project_id: int, payload: Dict[str, Any]) -> Dict[str, Any]:
    """Cria a hierarquia fisica e logica de uma caixa GPON planejada."""
    box_name = str(payload.get("box_name") or "").strip()
    if not box_name:
        raise ValueError("Informe o nome da caixa hermetica")
    site_id = int(payload["site_id"]) if payload.get("site_id") else None
    latitude = _optional_float(payload.get("latitude"))
    longitude = _optional_float(payload.get("longitude"))
    onu_count = max(1, min(int(payload.get("onu_count") or 1), 4))
    distribution_count = max(1, min(int(payload.get("distribution_count") or 1), 4))
    distribution_type = str(payload.get("distribution_type") or "switch").strip().lower()
    if distribution_type not in {"switch", "injector"}:
        raise ValueError("Distribuicao deve ser switch ou injetor PoE")
    port_capacity = max(1, min(int(payload.get("port_capacity") or 5), 48))
    camera_count = max(0, min(int(payload.get("camera_count") or 0), 100))
    total_ports = distribution_count * port_capacity
    if camera_count > total_ports:
        raise ValueError(f"A caixa possui {total_ports} porta(s), mas recebeu {camera_count} camera(s)")

    start_ip = str(payload.get("camera_start_ip") or "").strip()
    base_ip = int(ipaddress.ip_address(start_ip)) if start_ip else None
    first_number = int(payload.get("camera_first_number") or 1)
    name_template = str(payload.get("camera_name_template") or "{number} - CAMERA").strip()
    created: List[Dict[str, Any]] = []
    try:
        box = save_device(project_id, {
            "device_type": "box", "name": box_name, "site_id": site_id,
            "latitude": latitude, "longitude": longitude, "notes": payload.get("box_notes") or "",
            "metadata": {"assembly": "gpon_box", "member_count": onu_count + distribution_count + camera_count + (1 if payload.get("include_cto") else 0)},
        })
        created.append(box)

        onus: List[Dict[str, Any]] = []
        for index in range(onu_count):
            onu_type = str(payload.get("onu_type") or "onu").lower()
            onu = save_device(project_id, {
                "device_type": onu_type, "name": f"{box_name} - {onu_type.upper()} {index + 1}",
                "site_id": site_id, "parent_id": box["id"], "manufacturer": payload.get("onu_manufacturer") or "",
                "model": payload.get("onu_model") or "", "pon": payload.get("pon") or "", "onu_position": payload.get("onu_position") or "",
                "latitude": latitude, "longitude": longitude, "metadata": {"container_id": box["id"], "role": "optical_terminal"},
            })
            created.append(onu)
            onus.append(onu)

        cto = None
        if payload.get("include_cto"):
            cto = save_device(project_id, {
                "device_type": "cto", "name": str(payload.get("cto_name") or f"{box_name} - CTO").strip(),
                "site_id": site_id, "parent_id": box["id"], "model": payload.get("cto_model") or "",
                "latitude": latitude, "longitude": longitude, "metadata": {"container_id": box["id"], "optional": True},
            })
            created.append(cto)

        distributors: List[Dict[str, Any]] = []
        for index in range(distribution_count):
            label = "SWITCH POE" if distribution_type == "switch" else "INJETOR POE"
            distributor = save_device(project_id, {
                "device_type": distribution_type, "name": f"{box_name} - {label} {index + 1}",
                "site_id": site_id, "parent_id": box["id"], "manufacturer": payload.get("distribution_manufacturer") or "",
                "model": payload.get("distribution_model") or "", "latitude": latitude, "longitude": longitude,
                "metadata": {"container_id": box["id"], "uplink_device_id": onus[0]["id"], "port_capacity": port_capacity, "poe": True},
            })
            created.append(distributor)
            distributors.append(distributor)

        cameras: List[Dict[str, Any]] = []
        for index in range(camera_count):
            number = str(first_number + index).zfill(2)
            distributor = distributors[min(index // port_capacity, len(distributors) - 1)]
            camera = save_device(project_id, {
                "device_type": "camera", "name": name_template.replace("{number}", number).replace("{n}", str(first_number + index)),
                "ip": str(ipaddress.ip_address(base_ip + index)) if base_ip is not None else "",
                "site_id": site_id, "parent_id": distributor["id"], "manufacturer": payload.get("camera_manufacturer") or "",
                "model": payload.get("camera_model") or "", "latitude": latitude, "longitude": longitude,
                "reference_image_url": payload.get("camera_image_url") or "",
                "metadata": {"container_id": box["id"], "power_device_id": distributor["id"], "port_number": (index % port_capacity) + 1, "coordinates_inherited": True},
            })
            created.append(camera)
            cameras.append(camera)
        return {"box": box, "onus": onus, "cto": cto, "distributors": distributors, "cameras": cameras, "items": created}
    except Exception:
        for item in reversed(created):
            delete_device(project_id, int(item["id"]))
        raise


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
