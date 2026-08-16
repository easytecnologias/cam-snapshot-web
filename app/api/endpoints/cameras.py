from __future__ import annotations

from typing import Any, Dict, List
import asyncio
import json
import time
import urllib3
from urllib3.exceptions import InsecureRequestWarning
from pathlib import Path
import shutil

from fastapi import APIRouter, HTTPException
from fastapi import Query
from app.services.ping_service import ping as ping_with_cache
from app.services.ws_scan_service import ping_via_connector
from app.services.connector_service import ensure_connector_targets_allowed

from pydantic import BaseModel

from app.core.paths import INVENTORY_JSON_PATH, SAIDA_DIR, DATA_DIR
from app.core.tenant_context import tenant_recorder_inventory_path
from app.services.inventory_json import inventory_row_key, load_inventory_json, save_inventory_json
from app.services.photo_store import attach_snapshot_fields, resolve_snapshot_file, snapshot_storage_dir
from app.services.scan_service import _enrich_inventory_with_olt, _enrich_inventory_with_switch
from app.services.camsnapshot.device_info import get_snapshot

# Requests para dispositivos locais costumam usar HTTPS com certificado self-signed.
# Evita poluir o console com InsecureRequestWarning em cada tentativa/fallback.
urllib3.disable_warnings(InsecureRequestWarning)


router = APIRouter(tags=["cameras"], prefix="/api")


def _txt(value: Any) -> str:
    return str(value or "").strip()


def _camera_inventory_mode(value: Any) -> str:
    raw = _txt(value).lower()
    if raw in {"switch", "sw", "via_switch", "via-switch"}:
        return "switch"
    if raw in {"basic", "basico", "básico", "base"}:
        return "basic"
    return "olt"


def _site_matches(row: dict[str, Any], wanted_site: str) -> bool:
    wanted = _txt(wanted_site).lower()
    if not wanted:
        return True
    return any(_txt(row.get(k)).lower() == wanted for k in ("site", "site_name", "local", "LOCAL"))


def _recorder_camera_ip(row: dict[str, Any]) -> str:
    return _txt(row.get("camera_ip") or row.get("ip_camera"))


def _recorder_snapshot_url(row: dict[str, Any]) -> str:
    return _txt(row.get("imgbb_url") or row.get("snapshot_url") or row.get("imgbb_thumb_url"))


def _load_recorder_camera_index(site: str = "", connector_id: str = "") -> dict[str, dict[str, Any]]:
    wanted_connector = _txt(connector_id)
    indexed: dict[str, dict[str, Any]] = {}
    for source in ("nvr", "dvr"):
        path = tenant_recorder_inventory_path(source)
        try:
            rows = json.loads(path.read_text(encoding="utf-8")) if path.exists() else []
        except Exception:
            rows = []
        if not isinstance(rows, list):
            continue
        for row in rows:
            if not isinstance(row, dict):
                continue
            camera_ip = _recorder_camera_ip(row)
            if not camera_ip:
                continue
            if not _site_matches(row, site):
                continue
            row_connector = _txt(row.get("remote_connector_id") or row.get("connector_id"))
            if wanted_connector and row_connector != wanted_connector:
                continue
            enriched = dict(row)
            enriched["_recorder_source"] = source
            current = indexed.get(camera_ip)
            if current is None:
                indexed[camera_ip] = enriched
                continue
            current_score = int(_txt(current.get("status")).lower() == "online") + int(bool(_recorder_snapshot_url(current)))
            new_score = int(_txt(enriched.get("status")).lower() == "online") + int(bool(_recorder_snapshot_url(enriched)))
            if new_score > current_score:
                indexed[camera_ip] = enriched

    return indexed


def _is_empty_camera_value(value: Any) -> bool:
    text = _txt(value)
    if not text:
        return True
    return text.lower() in {"-", "n/d", "nao informado", "nao identificado"}


def _apply_recorder_fallback(cam: dict[str, Any], rec: dict[str, Any]) -> dict[str, Any]:
    if not rec:
        return cam
    rec_status = _txt(rec.get("status")).lower()
    rec_video_loss = bool(rec.get("video_loss"))
    if _is_empty_camera_value(cam.get("titulo")):
        cam["titulo"] = _txt(rec.get("title") or rec.get("titulo"))
    if _is_empty_camera_value(cam.get("local")):
        cam["local"] = _txt(rec.get("local") or rec.get("site") or rec.get("site_name"))
    if _is_empty_camera_value(cam.get("mac")):
        cam["mac"] = _txt(rec.get("camera_mac") or rec.get("mac_camera") or rec.get("mac"))
    if _is_empty_camera_value(cam.get("modelo")):
        cam["modelo"] = _txt(rec.get("camera_model") or rec.get("modelo") or rec.get("model"))
        cam["model"] = cam["modelo"]
    if _is_empty_camera_value(cam.get("fabricante")) and cam.get("modelo"):
        model = _txt(cam.get("modelo")).upper()
        if model.startswith("DS-") or model.startswith("IPC-B"):
            cam["fabricante"] = "Hikvision"
    rec_snapshot = _recorder_snapshot_url(rec)
    if not _txt(cam.get("snapshot_url")) and rec_snapshot:
        cam["snapshot_url"] = rec_snapshot
    if not _txt(cam.get("imgbb_url")) and _txt(rec.get("imgbb_url")):
        cam["imgbb_url"] = _txt(rec.get("imgbb_url"))
    if rec_status == "online" and not rec_video_loss and _txt(cam.get("status")).lower() != "online":
        cam["direct_status"] = cam.get("status") or ""
        cam["status"] = "online"
    cam["via_recorder"] = True
    cam["recorder_source"] = _txt(rec.get("_recorder_source"))
    cam["recorder_host"] = _txt(rec.get("host") or rec.get("nvr_ip") or rec.get("dvr_ip"))
    cam["recorder_channel"] = _txt(rec.get("channel") or rec.get("ch"))
    return cam


class CameraUpdate(BaseModel):
    ip: str
    inventory_key: str | None = None
    key: str | None = None
    remote_connector_id: str | None = None
    connector_id: str | None = None
    remote: bool | None = None
    site: str | None = None
    site_name: str | None = None
    mac: str | None = None
    fabricante: str | None = None
    model: str | None = None
    titulo: str | None = None
    status: str | None = None
    local: str | None = None
    pon: str | None = None
    onu_id: str | None = None
    onu_name: str | None = None
    onu_serial: str | None = None
    switch_name: str | None = None
    switch_ip: str | None = None
    switch_port: str | None = None
    switch_vlan: str | None = None


class CamerasSaveRequest(BaseModel):
    cameras: List[CameraUpdate]


class PingBatchItem(BaseModel):
    ip: str
    preferred_ports: List[int] | None = None


class PingBatchRequest(BaseModel):
    items: List[PingBatchItem] = []
    ips: List[str] | None = None
    timeout: int = 2
    method: str = "auto"
    force: int = 0
    concurrency: int = 48
    persist: bool = False


@router.get("/cameras")
def api_cameras(
    enrich: str = Query(default=""),
    mode: str = Query(default="olt"),
    site: str = Query(default=""),
    connector_id: str = Query(default=""),
) -> Dict[str, Any]:
    """Compat com legado: retorna {cameras:[...]} mesclando campos."""
    inventory_mode = _camera_inventory_mode(mode)
    rows = load_inventory_json(site=site, mode=mode) or []
    recorder_by_ip = _load_recorder_camera_index(site=site, connector_id=connector_id) if inventory_mode == "olt" else {}
    wanted_connector = str(connector_id or "").strip()
    if wanted_connector:
        rows = [
            row for row in rows
            if str((row or {}).get("remote_connector_id") or (row or {}).get("connector_id") or "").strip() == wanted_connector
        ]
    mode = (enrich or "").strip().lower() or inventory_mode
    if mode == "olt":
        rows, _ = _enrich_inventory_with_olt(list(rows), SAIDA_DIR / "olt-cpe-macs.json")
    elif mode == "switch":
        rows, _ = _enrich_inventory_with_switch(list(rows), DATA_DIR / "switch-mac-table.json")

    by_key: dict[str, dict[str, Any]] = {}
    seen_ips: set[str] = set()

    def make_key(row: dict) -> str:
        return inventory_row_key(row, fallback=f"ROW:{len(by_key)}")

    for r in rows:
        key = make_key(r)
        snapshot_url = r.get("snapshot_url") or r.get("thumb_url") or ""
        if not snapshot_url:
            snap_file = resolve_snapshot_file(
                path_hint=str(r.get("snapshot_path") or r.get("snapshot_file") or ""),
                ip=str(r.get("ip") or ""),
            )
            if snap_file is not None:
                snapshot_url = f"/data/snapshot/{snap_file.name}"

        cam: dict[str, Any] = {
            "inventory_key": key,
            "ip": r.get("ip") or "",
            "mac": r.get("mac") or "",
            "fabricante": r.get("fabricante") or r.get("manufacturer") or "",
            "modelo": r.get("modelo") or r.get("model") or "",
            "model": r.get("modelo") or r.get("model") or "",
            "titulo": r.get("titulo") or r.get("nome") or "",
            "status": r.get("status") or "",
            "local": r.get("local") or r.get("LOCAL") or "",
            "physical_location": r.get("physical_location") or r.get("location") or "",
            "lat": r.get("lat") or r.get("latitude") or "",
            "lon": r.get("lon") or r.get("lng") or r.get("longitude") or "",
            "snapshot_url": snapshot_url,
            "imgbb_url": r.get("imgbb_url") or "",
            "imgbb_thumb_url": r.get("imgbb_thumb_url") or "",
            "imgbb_status": r.get("imgbb_status") or "",
            "imgbb_updated_at": r.get("imgbb_updated_at") or "",
            "pon": r.get("pon") or "",
            "onu_id": r.get("onu_id") or "",
            "onu_name": r.get("onu_name") or "",
            "onu_serial": r.get("onu_serial") or "",
            "onu_oper_status": r.get("onu_oper_status") or r.get("oper_status") or "",
            "onu_omci_status": r.get("onu_omci_status") or r.get("omci_status") or "",
            "onu_rx": r.get("onu_rx") or "",
            "olt_rx": r.get("olt_rx") or "",
            "onu_telemetry_updated_at": r.get("onu_telemetry_updated_at") or r.get("telemetry_updated_at") or "",
            "switch_ip": r.get("switch_ip") or "",
            "switch_name": r.get("switch_name") or "",
            "switch_port": r.get("switch_port") or "",
            "switch_vlan": r.get("switch_vlan") or r.get("vlan") or "",
            "remote": bool(r.get("remote")),
            "remote_connector_id": r.get("remote_connector_id") or r.get("connector_id") or "",
            "remote_connector_name": r.get("remote_connector_name") or "",
            "site": r.get("site") or "",
            "site_name": r.get("site_name") or "",
        }
        ip = str(cam.get("ip") or "").strip()
        if ip:
            seen_ips.add(ip)
            rec = recorder_by_ip.get(ip)
            if rec:
                cam_connector = _txt(cam.get("remote_connector_id") or cam.get("connector_id"))
                rec_connector = _txt(rec.get("remote_connector_id") or rec.get("connector_id"))
                cam_site = _txt(cam.get("site") or cam.get("site_name") or cam.get("local"))
                same_connector = not cam_connector or not rec_connector or cam_connector == rec_connector
                same_site = not cam_site or _site_matches(rec, cam_site)
                if same_connector and same_site:
                    cam = _apply_recorder_fallback(cam, rec)

        health_label = r.get("ai_health_label") or ""
        if not health_label:
            quality = r.get("quality")
            try:
                qv = float(quality) if quality not in (None, "") else None
            except ValueError:
                qv = None
            if qv is not None:
                if qv >= 0.8:
                    health_label = "OK"
                elif qv >= 0.5:
                    health_label = "ATENÃ‡ÃƒO"
                else:
                    health_label = "RUIM"
        cam["health"] = health_label

        if key not in by_key:
            by_key[key] = cam
        else:
            base = by_key[key]
            for k, v in cam.items():
                if v is None or v == "":
                    continue
                if not base.get(k):
                    base[k] = v
            by_key[key] = base

    return {"cameras": list(by_key.values())}


@router.post("/cameras/save")
def api_cameras_save(req: CamerasSaveRequest, mode: str = Query(default="olt")) -> Dict[str, Any]:
    """Compat com legado: edita campos no cam-inventory.json."""
    try:
        SAIDA_DIR.mkdir(parents=True, exist_ok=True)
    except Exception:
        pass

    rows = load_inventory_json(mode=mode) or []
    if not rows:
        base_rows: list[dict[str, Any]] = []
        for cam in req.cameras:
            ip = (cam.ip or "").strip()
            if not ip:
                continue
            base_rows.append(
                {
                    "ip": ip,
                    "mac": (cam.mac or ""),
                    "fabricante": (cam.fabricante or ""),
                    "model": (cam.model or ""),
                    "titulo": (cam.titulo or ""),
                    "status": (cam.status or ""),
                    "local": (cam.local or ""),
                    "pon": (cam.pon or ""),
                    "onu_id": (cam.onu_id or ""),
                    "onu_name": (cam.onu_name or ""),
                    "onu_serial": (cam.onu_serial or ""),
                    "switch_name": (cam.switch_name or ""),
                    "switch_ip": (cam.switch_ip or ""),
                    "switch_port": (cam.switch_port or ""),
                    "switch_vlan": (cam.switch_vlan or ""),
                }
            )
        if base_rows:
            save_inventory_json(base_rows, mode=mode)
            return {"ok": True, "updated": len(base_rows)}
        raise HTTPException(status_code=404, detail="Nenhum inventÃ¡rio encontrado para salvar ediÃ§Ã£o.")

    updates: dict[str, CameraUpdate] = {}
    for cam in req.cameras:
        ip = (cam.ip or "").strip()
        explicit_key = str(cam.inventory_key or cam.key or "").strip()
        if explicit_key:
            updates[explicit_key] = cam
        elif ip:
            updates[inventory_row_key({
                "ip": ip,
                "remote_connector_id": cam.remote_connector_id or cam.connector_id or "",
                "site": cam.site or cam.site_name or cam.local or "",
                "remote": bool(cam.remote or cam.remote_connector_id or cam.connector_id),
            })] = cam

    def apply_update(row: dict[str, Any], cam: CameraUpdate) -> dict[str, Any]:
        ip = (row.get("ip") or "").strip()
        if not ip or ip != (cam.ip or "").strip():
            return row

        if cam.mac is not None:
            row["mac"] = cam.mac

        if cam.fabricante is not None:
            if "fabricante" in row:
                row["fabricante"] = cam.fabricante
            elif "manufacturer" in row:
                row["manufacturer"] = cam.fabricante
            else:
                row["fabricante"] = cam.fabricante

        if cam.model is not None:
            if "modelo" in row:
                row["modelo"] = cam.model
            elif "model" in row:
                row["model"] = cam.model
            else:
                row["model"] = cam.model

        if cam.titulo is not None:
            if "titulo" in row:
                row["titulo"] = cam.titulo
            elif "nome" in row:
                row["nome"] = cam.titulo
            else:
                row["titulo"] = cam.titulo

        if cam.status is not None:
            row["status"] = cam.status
        if cam.local is not None:
            row["local"] = cam.local
        if cam.pon is not None:
            row["pon"] = cam.pon
        if cam.onu_id is not None:
            row["onu_id"] = cam.onu_id
        if cam.onu_name is not None:
            row["onu_name"] = cam.onu_name
        if cam.onu_serial is not None:
            row["onu_serial"] = cam.onu_serial
        if cam.switch_name is not None:
            row["switch_name"] = cam.switch_name
        if cam.switch_ip is not None:
            row["switch_ip"] = cam.switch_ip
        if cam.switch_port is not None:
            row["switch_port"] = cam.switch_port
        if cam.switch_vlan is not None:
            row["switch_vlan"] = cam.switch_vlan

        return row

    updated_count = 0
    found_keys: set[str] = set()
    for idx, row in enumerate(rows):
        row_key = inventory_row_key(row)
        if row_key in updates:
            found_keys.add(row_key)
            before = dict(row)
            row = apply_update(row, updates[row_key])
            if row != before:
                updated_count += 1
            rows[idx] = row

    for row_key, cam in updates.items():
        if row_key in found_keys:
            continue
        ip = (cam.ip or "").strip()
        new_row = {
            "ip": ip,
            "mac": cam.mac or "",
            "fabricante": cam.fabricante or "",
            "modelo": cam.model or "",
            "titulo": cam.titulo or "",
            "status": cam.status or "online",
            "local": cam.local or "",
            "pon": cam.pon or "",
            "onu_id": cam.onu_id or "",
            "onu_name": cam.onu_name or "",
            "onu_serial": cam.onu_serial or "",
        }
        connector_id = cam.remote_connector_id or cam.connector_id or ""
        if cam.remote or connector_id:
            new_row["remote"] = True
        if connector_id:
            new_row["remote_connector_id"] = connector_id
        if cam.site:
            new_row["site"] = cam.site
        if cam.site_name:
            new_row["site_name"] = cam.site_name
        rows.append(new_row)
        updated_count += 1

    save_inventory_json(rows, mode=mode)
    return {"ok": True, "path": str(INVENTORY_JSON_PATH), "updated": updated_count, "received": len(updates)}


def _status_from_ping(row: Dict[str, Any]) -> str:
    return "online" if bool(row.get("online")) else "offline"


def _persist_camera_statuses(status_by_ip: Dict[str, str]) -> Dict[str, Any]:
    if not status_by_ip:
        return {"camera_rows": 0, "recorder_rows": 0}

    camera_rows = 0
    for mode in ("basic", "olt", "switch"):
        rows = load_inventory_json(mode=mode) or []
        changed = False
        for row in rows:
            if str(row.get("status_source") or "").strip().lower() == "zabbix":
                continue
            ip = str(row.get("ip") or row.get("IP") or "").strip()
            status = status_by_ip.get(ip)
            if status and str(row.get("status") or "").strip().lower() != status:
                row["status"] = status
                changed = True
                camera_rows += 1
        if changed:
            save_inventory_json(rows, mode=mode)

    # Nao persistir status de gravador (nvr/dvr) aqui: legacy_rows_from_db()/
    # replace_recorder_inventory_rows() leem e regravam a tabela `recorders`
    # inteira (todos os tenants que usam esse `source`), sem filtro de tenant --
    # replace_recorder_inventory_rows faz DELETE FROM recorders WHERE source=?
    # antes de reinserir. Chamar isso a partir desta rota (role "operator",
    # acessivel a qualquer cliente comum) permitiria um tenant apagar/sobrescrever
    # o cadastro de gravador de outro. O status de camera acima (bloco tenant-scoped
    # via save_inventory_json) ja cobre o caso de uso real desta rota; status de
    # recorder que vem do Zabbix segue seu proprio fluxo tenant-aware separado.
    return {"camera_rows": camera_rows, "recorder_rows": 0}


@router.get("/cameras/ping", summary="Ping (ICMP/TCP) com cache", tags=["cameras"])
async def api_cameras_ping(
    ip: str,
    timeout: int = 3,
    method: str = "auto",
    force: int = 0,
    persist: int = 0,
    remote_connector_id: str = "",
):
    """
    Ping (ICMP/TCP) com cache para evitar excesso de requisiÃ§Ãµes.

    - Cache por PING_CACHE_TTL (default 600s)
    - force=1 forÃ§a novo ping
    - method: auto|icmp|tcp
    - ip pode conter porta (ex: 45.164.52.138:81) â€” nesse caso faz TCP nessa porta.
    - remote_connector_id: camera marcada como remota (atras de um conector
      MikroTik, ver ws_scan_service._tag_rows_for_connector). Se o ping
      direto falhar, cai pro ping_many do proprio MikroTik antes de marcar
      offline -- sem isso, uma camera sem rota real ate a LAN do cliente
      (VPN ainda nao sincronizada) sempre aparecia offline mesmo estando
      online, porque o servidor nunca tinha como alcanca-la direto.
    """
    target = (ip or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="ip obrigatÃ³rio")

    method_n = (method or "auto").lower().strip()
    if method_n not in ("auto", "icmp", "tcp"):
        raise HTTPException(status_code=400, detail="method invÃ¡lido: use auto|icmp|tcp")

    result = await ping_with_cache(ip=target, timeout=timeout, method=method_n, force=force)
    connector_id = str(remote_connector_id or "").strip()
    if connector_id and not bool(result.get("online")):
        # O conector so deve confirmar alcance de IPs da propria LAN --
        # sem isso, um conector de um site consegue "confirmar online"
        # o IP de outro site/cliente que tenha rota de rede coincidente.
        ensure_connector_targets_allowed(connector_id, [target], "IP da camera")
        via_connector = await ping_via_connector(connector_id, target)
        result["via_connector"] = via_connector
        if via_connector:
            result["online"] = True
    status = _status_from_ping(result)
    result["status"] = status
    result["reachable"] = bool(result.get("online"))
    result["persisted"] = (
        _persist_camera_statuses({target: status})
        if bool(persist)
        else {"skipped": True, "reason": "diagnostic_ping"}
    )
    return result


@router.post("/cameras/ping_many", summary="Ping em lote (ICMP/TCP) com concorrencia limitada", tags=["cameras"])
async def api_cameras_ping_many(req: PingBatchRequest) -> Dict[str, Any]:
    items_in = list(req.items or [])
    for ip in req.ips or []:
        ip_s = str(ip or "").strip()
        if ip_s:
            items_in.append(PingBatchItem(ip=ip_s, preferred_ports=[]))
    items: list[PingBatchItem] = []
    seen: set[str] = set()
    for item in items_in:
        ip = (item.ip or "").strip()
        if not ip or ip in seen:
            continue
        seen.add(ip)
        items.append(PingBatchItem(ip=ip, preferred_ports=item.preferred_ports or []))

    if not items:
        return {"ok": True, "results": [], "count": 0}

    method_n = (req.method or "auto").lower().strip()
    if method_n not in ("auto", "icmp", "tcp"):
        raise HTTPException(status_code=400, detail="method invalido: use auto|icmp|tcp")

    timeout_i = max(1, min(int(req.timeout or 2), 30))
    concurrency = max(1, min(int(req.concurrency or 48), 128))
    semaphore = asyncio.Semaphore(concurrency)

    async def _run_one(item: PingBatchItem) -> Dict[str, Any]:
        async with semaphore:
            try:
                return await ping_with_cache(
                    ip=item.ip,
                    timeout=timeout_i,
                    method=method_n,
                    force=req.force,
                    preferred_ports=item.preferred_ports or [],
                )
            except Exception as exc:
                return {
                    "ip": item.ip,
                    "online": False,
                    "method": method_n,
                    "rtt_ms": None,
                    "error": str(exc),
                    "ok": False,
                    "cached": False,
                }

    results = await asyncio.gather(*[_run_one(item) for item in items])
    online_n = sum(1 for row in results if bool(row.get("online")))
    status_by_ip = {
        str(row.get("ip") or "").strip(): _status_from_ping(row)
        for row in results
        if str(row.get("ip") or "").strip()
    }
    persisted = (
        _persist_camera_statuses(status_by_ip)
        if bool(req.persist)
        else {"skipped": True, "reason": "diagnostic_ping"}
    )
    return {
        "ok": True,
        "count": len(results),
        "online": online_n,
        "offline": max(0, len(results) - online_n),
        "results": results,
        "updated_status": status_by_ip,
        "persisted": persisted,
    }


class PortscanApplyRequest(BaseModel):
    results: Dict[str, List[int]] = {}
    no_overwrite: bool = True


class SnapshotSaveRequest(BaseModel):
    path: str = ""
    ip: str | None = None


class SnapshotCaptureRequest(BaseModel):
    ip: str
    user: str = "admin"
    password: str = ""
    timeout_sec: float = 5.0
    mode: str = "olt"


class PTZMoveRequest(BaseModel):
    ip: str
    user: str
    password: str
    direction: str
    channel: int = 1
    speed: int = 4
    duration_ms: int = 350


@router.post("/portscan/apply", tags=["cameras"])
def api_portscan_apply(req: PortscanApplyRequest) -> Dict[str, Any]:
    rows = load_inventory_json() or []
    if not rows:
        return {"ok": True, "updated_hosts": 0, "fields_set": 0, "message": "InventÃ¡rio vazio."}

    idx: Dict[str, dict[str, Any]] = {}
    for r in rows:
        ip = str(r.get("ip") or "").strip()
        if ip:
            idx[ip] = r

    updated_hosts = 0
    fields_set = 0

    def _maybe_set(row: dict[str, Any], key: str, val: Any):
        nonlocal fields_set
        if val is None:
            return
        if req.no_overwrite and str(row.get(key) or "").strip():
            return
        row[key] = val
        fields_set += 1

    for host, ports in (req.results or {}).items():
        host = str(host or "").strip()
        if host not in idx:
            continue
        try:
            ports_list = sorted({int(p) for p in (ports or []) if 1 <= int(p) <= 65535})
        except Exception:
            continue
        row = idx[host]
        before = fields_set

        http_candidates = [p for p in ports_list if p in (80, 81, 82, 83, 84, 88, 8008, 8080, 8081, 8088)]
        https_candidates = [p for p in ports_list if p in (443, 444, 445, 446, 8443)]
        rtsp_candidates = [p for p in ports_list if p in (554, 555, 556, 8554, 10554)]
        server_candidates = [p for p in ports_list if 8000 <= p <= 9000]

        if http_candidates:
            _maybe_set(row, "http_port", http_candidates[0])
        if https_candidates:
            _maybe_set(row, "https_port", https_candidates[0])
        if rtsp_candidates:
            _maybe_set(row, "rtsp_port", rtsp_candidates[0])
        if server_candidates:
            sp = 8000 if 8000 in server_candidates else server_candidates[0]
            _maybe_set(row, "server_port", sp)

        _maybe_set(row, "open_ports", ports_list)

        if fields_set != before:
            updated_hosts += 1

    save_inventory_json(rows)
    return {"ok": True, "updated_hosts": updated_hosts, "fields_set": fields_set}


@router.post("/snapshot/save", tags=["cameras"])
def api_snapshot_save(req: SnapshotSaveRequest) -> Dict[str, Any]:
    # resolve_snapshot_file so procura em diretorios de snapshot conhecidos
    # (tenant-scoped + legado), usando so o nome do arquivo (Path(...).name).
    # Nao aceitar mais um path absoluto arbitrario aqui -- isso permitia
    # copiar qualquer arquivo legivel do disco do servidor (ex: .env) pra
    # pasta publica de snapshots via /data/snapshot/<nome>.
    src = resolve_snapshot_file(path_hint=req.path, ip=(req.ip or ""))

    if src is None:
        raise HTTPException(status_code=404, detail=f"Arquivo de snapshot nao encontrado: {req.path}")

    # /data/snapshot e a URL canonica no frontend.
    dst_dir = snapshot_storage_dir()

    if src.parent.resolve() == dst_dir.resolve():
        dst = src
    else:
        filename = src.name
        if req.ip:
            safe_ip = str(req.ip).replace(":", "__").replace(".", "_").replace("/", "_")
            if src.name != f"{safe_ip}.jpg":
                filename = f"{safe_ip}_{src.stem}{src.suffix}"
        dst = dst_dir / filename
        shutil.copy2(src, dst)

    if req.ip:
        ip = str(req.ip).strip()
        try:
            inv = load_inventory_json() or []
            updated = False
            for cam in inv:
                if not isinstance(cam, dict):
                    continue
                if str(cam.get("ip") or "").strip() == ip:
                    attach_snapshot_fields(cam, ip, dst.name)
                    updated = True
                    break
            if not updated:
                new_cam = {"ip": ip, "titulo": "Captura manual"}
                attach_snapshot_fields(new_cam, ip, dst.name)
                inv.append(new_cam)
            save_inventory_json(inv)
        except Exception:
            pass

    return {"ok": True, "message": f"Snapshot salvo em {dst.name}", "filename": dst.name, "path": str(dst)}


@router.post("/cameras/snapshot/capture", tags=["cameras"])
def api_cameras_snapshot_capture(req: SnapshotCaptureRequest) -> Dict[str, Any]:
    ip = str(req.ip or "").strip()
    user = str(req.user or "admin").strip()
    password = str(req.password or "")
    if not ip:
        raise HTTPException(status_code=400, detail="ip obrigatorio")
    if not user or not password:
        raise HTTPException(status_code=400, detail="usuario e senha obrigatorios")

    dst_dir = snapshot_storage_dir()
    dst_dir.mkdir(parents=True, exist_ok=True)
    saved_path = get_snapshot(ip, user, password, str(dst_dir), timeout=(1.5, float(req.timeout_sec or 5.0)), retries=1)
    safe_ip = ip.replace(":", "__").replace(".", "_").replace("/", "_")
    out_name = f"{safe_ip}.jpg"
    out_path = dst_dir / out_name

    try:
        legacy = Path(str(saved_path)) if saved_path else dst_dir / f"{ip}.jpg"
        if legacy.exists() and legacy.is_file():
            if legacy.resolve() != out_path.resolve():
                if out_path.exists():
                    out_path.unlink()
                shutil.move(str(legacy), str(out_path))
    except Exception:
        pass

    if not out_path.exists() or not out_path.is_file():
        raise HTTPException(status_code=502, detail="Nao foi possivel capturar snapshot da camera.")

    mode = (req.mode or "olt").strip().lower()
    rows = load_inventory_json(mode=mode) or []
    updated = False
    for cam in rows:
        if not isinstance(cam, dict):
            continue
        if str(cam.get("ip") or "").strip() == ip:
            attach_snapshot_fields(cam, ip, out_name)
            updated = True
            break
    if not updated:
        cam = {"ip": ip, "titulo": "Captura manual"}
        attach_snapshot_fields(cam, ip, out_name)
        rows.append(cam)
    save_inventory_json(rows, mode=mode)
    return {"ok": True, "url": f"/data/snapshot/{out_name}", "filename": out_name}

@router.get("/cameras/ptz_capability", tags=["cameras"])
def api_cameras_ptz_capability(
    ip: str = Query(...),
    user: str = Query(""),
    password: str = Query("", alias="pass"),
    channel: int = Query(1, ge=1, le=32),
) -> Dict[str, Any]:
    import requests
    from requests.auth import HTTPDigestAuth

    ip = (ip or "").strip()
    user = (user or "").strip()
    password = (password or "").strip()
    if not ip:
        return {"ok": False, "error": "ip obrigatorio"}
    if not user or not password:
        return {"ok": False, "error": "usuario/senha obrigatorios"}

    brand = ""
    model = ""
    title = ""
    try:
        inv = load_inventory_json() or []
        for r in inv:
            if str(r.get("ip") or "").strip() == ip:
                brand = str(r.get("fabricante") or "").strip().lower()
                model = str(r.get("modelo") or r.get("model") or "").strip().lower()
                title = str(r.get("titulo") or r.get("title") or "").strip().lower()
                break
    except Exception:
        pass

    hint_text = " ".join([brand, model, title]).lower()
    hint_is_ptz = any(k in hint_text for k in ["ptz", "speed dome", "speeddome", "sd5", "sd6", "sd49", "sd59"])

    def _try_get(url: str):
        for auth in (HTTPDigestAuth(user, password), (user, password)):
            try:
                r = requests.get(url, auth=auth, timeout=4, verify=False, headers={"Accept": "*/*"})
                if r.status_code == 200:
                    return True, r.status_code
            except Exception:
                continue
        return False, None

    probe_ok = False
    probe_url = ""

    if ("hik" in brand) or ("hilook" in brand):
        probe_url = f"http://{ip}/ISAPI/PTZCtrl/channels/{int(channel)}/capabilities"
        probe_ok, _ = _try_get(probe_url)
    elif ("dahua" in brand) or ("intelbras" in brand):
        probe_url = f"http://{ip}/cgi-bin/ptz.cgi?action=getStatus&channel={max(0, int(channel)-1)}"
        probe_ok, _ = _try_get(probe_url)
    else:
        # Best effort: testa os dois formatos
        probe_url = f"http://{ip}/cgi-bin/ptz.cgi?action=getStatus&channel={max(0, int(channel)-1)}"
        probe_ok, _ = _try_get(probe_url)
        if not probe_ok:
            probe_url = f"http://{ip}/ISAPI/PTZCtrl/channels/{int(channel)}/capabilities"
            probe_ok, _ = _try_get(probe_url)

    capable = bool(probe_ok or hint_is_ptz)
    return {
        "ok": True,
        "capable": capable,
        "probe_ok": bool(probe_ok),
        "hint_is_ptz": bool(hint_is_ptz),
        "brand": brand or "",
        "model": model or "",
        "probe_url": probe_url,
    }


@router.post("/cameras/ptz_capability", tags=["cameras"])
def api_cameras_ptz_capability_post(payload: Dict[str, Any]) -> Dict[str, Any]:
    return api_cameras_ptz_capability(
        ip=str(payload.get("ip") or ""),
        user=str(payload.get("user") or payload.get("username") or ""),
        password=str(payload.get("pass") or payload.get("password") or ""),
        channel=int(payload.get("channel") or 1),
    )


@router.post("/cameras/ptz_move", tags=["cameras"])
def api_cameras_ptz_move(payload: PTZMoveRequest) -> Dict[str, Any]:
    import requests
    from requests.auth import HTTPDigestAuth

    ip = (payload.ip or "").strip()
    user = (payload.user or "").strip()
    password = (payload.password or "").strip()
    direction = (payload.direction or "").strip().lower()
    channel = int(payload.channel or 1)
    speed = max(1, min(8, int(payload.speed or 4)))
    duration_ms = max(80, min(5000, int(payload.duration_ms or 350)))

    if not ip or not user or not password:
        return {"ok": False, "error": "ip/user/password obrigatorios"}

    brand = ""
    try:
        inv = load_inventory_json() or []
        for r in inv:
            if str(r.get("ip") or "").strip() == ip:
                brand = str(r.get("fabricante") or "").strip().lower()
                break
    except Exception:
        pass

    if direction in ("left", "right", "up", "down"):
        dh_code_map = {"left": "Left", "right": "Right", "up": "Up", "down": "Down"}
        hk_vec_map = {
            "left": (-speed * 10, 0, 0),
            "right": (speed * 10, 0, 0),
            "up": (0, speed * 10, 0),
            "down": (0, -speed * 10, 0),
        }
    elif direction in ("zoomin", "zoomout"):
        dh_code_map = {"zoomin": "ZoomTele", "zoomout": "ZoomWide"}
        hk_vec_map = {
            "zoomin": (0, 0, speed * 10),
            "zoomout": (0, 0, -speed * 10),
        }
    elif direction == "stop":
        dh_code_map = {}
        hk_vec_map = {}
    else:
        return {"ok": False, "error": "direction invalida"}

    def _request(method: str, url: str, data: str | None = None) -> requests.Response | None:
        for auth in (HTTPDigestAuth(user, password), (user, password)):
            try:
                if method == "PUT":
                    r = requests.put(url, auth=auth, timeout=6, verify=False, data=data, headers={"Content-Type": "application/xml"})
                else:
                    r = requests.get(url, auth=auth, timeout=6, verify=False)
                if r.status_code in (200, 201, 202, 204):
                    return r
            except Exception:
                continue
        return None

    # Hikvision/HiLook path
    if ("hik" in brand) or ("hilook" in brand):
        base = f"http://{ip}/ISAPI/PTZCtrl/channels/{int(channel)}/continuous"
        if direction == "stop":
            stop_xml = "<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>"
            r = _request("PUT", base, stop_xml)
            return {"ok": bool(r), "brand": "hikvision", "method": "isapi.stop"}
        pan, tilt, zoom = hk_vec_map.get(direction, (0, 0, 0))
        move_xml = f"<PTZData><pan>{pan}</pan><tilt>{tilt}</tilt><zoom>{zoom}</zoom></PTZData>"
        stop_xml = "<PTZData><pan>0</pan><tilt>0</tilt><zoom>0</zoom></PTZData>"
        r1 = _request("PUT", base, move_xml)
        if not r1:
            return {"ok": False, "error": "falha ao iniciar PTZ (Hikvision)"}
        time.sleep(duration_ms / 1000.0)
        _request("PUT", base, stop_xml)
        return {"ok": True, "brand": "hikvision", "method": "isapi.continuous"}

    # Dahua/Intelbras path
    ch0 = max(0, int(channel) - 1)
    if direction == "stop":
        # stop abrangente
        for code in ("Left", "Right", "Up", "Down", "ZoomTele", "ZoomWide"):
            stop_url = f"http://{ip}/cgi-bin/ptz.cgi?action=stop&channel={ch0}&code={code}&arg1=0&arg2={speed}&arg3=0"
            _request("GET", stop_url)
        return {"ok": True, "brand": "dahua/intelbras", "method": "ptz.stop"}

    code = dh_code_map.get(direction)
    if not code:
        return {"ok": False, "error": "direction invalida para dahua/intelbras"}

    start_url = f"http://{ip}/cgi-bin/ptz.cgi?action=start&channel={ch0}&code={code}&arg1=0&arg2={speed}&arg3=0"
    stop_url = f"http://{ip}/cgi-bin/ptz.cgi?action=stop&channel={ch0}&code={code}&arg1=0&arg2={speed}&arg3=0"
    r1 = _request("GET", start_url)
    if not r1:
        return {"ok": False, "error": "falha ao iniciar PTZ"}
    time.sleep(duration_ms / 1000.0)
    _request("GET", stop_url)
    return {"ok": True, "brand": "dahua/intelbras", "method": "ptz.cgi"}


@router.post("/cameras/reboot", tags=["cameras"])
def api_cameras_reboot(payload: Dict[str, Any]) -> Dict[str, Any]:
    import requests
    from requests.auth import HTTPDigestAuth

    ip = (payload.get("ip") or "").strip()
    user = (payload.get("user") or "").strip()
    password = (payload.get("pass") or payload.get("password") or "").strip()

    if not ip:
        return {"ok": False, "error": "IP obrigatÃ³rio"}
    if not user or not password:
        return {"ok": False, "error": "UsuÃ¡rio e senha obrigatÃ³rios"}

    brand = ""
    try:
        inv = load_inventory_json() or []
        for r in inv:
            if str(r.get("ip") or "").strip() == ip:
                brand = str(r.get("fabricante") or "").strip().lower()
                break
    except Exception:
        brand = ""

    attempts: list[tuple[str, str, str]] = []

    def add_attempt(name: str, method: str, url: str):
        attempts.append((name, method, url))
        if url.startswith("http://"):
            attempts.append((name + "_https", method, "https://" + url[len("http://"):]))

    is_hik = ("hik" in brand) or ("hilook" in brand)
    is_dahua = ("dahua" in brand) or ("intelbras" in brand)

    if is_hik:
        add_attempt("hikvision_isapi", "PUT", f"http://{ip}/ISAPI/System/reboot")
    if is_dahua:
        add_attempt("magicbox", "GET", f"http://{ip}/cgi-bin/magicBox.cgi?action=reboot")
        add_attempt("configManager", "GET", f"http://{ip}/cgi-bin/configManager.cgi?action=reboot")

    add_attempt("isapi", "PUT", f"http://{ip}/ISAPI/System/reboot")
    add_attempt("magicbox_fallback", "GET", f"http://{ip}/cgi-bin/magicBox.cgi?action=reboot")
    add_attempt("configManager_fallback", "GET", f"http://{ip}/cgi-bin/configManager.cgi?action=reboot")

    last_err = ""
    # Guarda separadamente o ultimo erro que veio de uma resposta HTTP real
    # (a camera respondeu, so recusou) -- isso e muito mais util pro usuario
    # do que "Sem resposta" de uma tentativa https tardia numa porta que
    # nem esta aberta. Sem isso, um 401 real (senha errada/sem permissao no
    # endpoint certo) podia ficar escondido atras do erro de conexao da
    # ultima tentativa da lista.
    best_status_err = ""
    for name, method, url in attempts:
        try:
            auths = [HTTPDigestAuth(user, password), (user, password)]
            r = None
            for auth in auths:
                try:
                    if method == "PUT":
                        r = requests.put(url, auth=auth, timeout=5, verify=False, headers={"Accept": "application/xml"}, data=b"")
                    else:
                        r = requests.get(url, auth=auth, timeout=5, verify=False, headers={"Accept": "application/xml"})
                    if r.status_code in (200, 201, 202, 204):
                        break
                except Exception:
                    r = None
                    continue
            if r is None:
                raise Exception("Sem resposta")
            # 401/403 NAO e sucesso: e a camera recusando o comando por
            # credencial errada ou usuario sem permissao de "Gerenciamento
            # do Sistema" no ISAPI (comum na Hikvision) -- contar isso como
            # "ok" fazia o front mostrar "reboot enviado" mesmo quando a
            # camera nunca recebeu um comando autenticado e nao reiniciava.
            if r.status_code in (200, 201, 202, 204):
                return {"ok": True, "method": name, "status": r.status_code}
            last_err = f"{name}: HTTP {r.status_code}"
            if not best_status_err:
                best_status_err = last_err
        except Exception as e:
            last_err = f"{name}: {str(e)}"
            continue

    return {"ok": False, "error": best_status_err or last_err or "Falha ao reiniciar"}


@router.post("/cameras/rename", tags=["cameras"])
def api_cameras_rename(payload: Dict[str, Any]) -> Dict[str, Any]:
    import requests
    import urllib.parse
    from requests.auth import HTTPDigestAuth

    ip = (payload.get("ip") or "").strip()
    title = (payload.get("title") or payload.get("titulo") or "").strip()
    user = (payload.get("user") or payload.get("username") or "").strip()
    password = (payload.get("pass") or payload.get("password") or "").strip()

    port = payload.get("port", 80)
    channel = payload.get("channel", 1)

    try:
        port = int(port) if port is not None else 80
    except Exception:
        port = 80

    try:
        channel = int(channel) if channel is not None else 1
    except Exception:
        channel = 1

    if not ip:
        return {"ok": False, "error": "IP obrigatÃ³rio"}
    if not title:
        return {"ok": False, "error": "TÃ­tulo obrigatÃ³rio"}
    if channel < 1:
        return {"ok": False, "error": "Channel deve ser >= 1"}

    def _persist_inventory_title() -> bool:
        try:
            rows = load_inventory_json() or []
            changed = False
            for r in rows:
                if str(r.get("ip") or "").strip() == ip:
                    r["titulo"] = title
                    changed = True
                    break
            if changed:
                save_inventory_json(rows)
            return changed
        except Exception:
            return False

    if not user or not password:
        return {
            "ok": False,
            "error": "Informe usuÃ¡rio e senha no topo da aba ManutenÃ§Ã£o",
            "ip": ip,
            "title": title,
            "inventory_updated": _persist_inventory_title(),
        }

    # Brand hint from inventory (helps route first attempt for Hikvision/HiLook)
    brand = ""
    try:
        inv = load_inventory_json() or []
        for r in inv:
            if str(r.get("ip") or "").strip() == ip:
                brand = str(r.get("fabricante") or "").strip().lower()
                break
    except Exception:
        brand = ""

    is_hik = ("hik" in brand) or ("hilook" in brand)
    idx0 = channel - 1
    q_title = urllib.parse.quote(title)

    # Candidate ports: requested port first, then common management ports.
    port_candidates: list[int] = []
    for p in [port, 80, 8000, 443]:
        try:
            pp = int(p)
            if 1 <= pp <= 65535 and pp not in port_candidates:
                port_candidates.append(pp)
        except Exception:
            continue

    attempts: list[dict[str, Any]] = []

    def _add_attempt(name: str, method: str, url: str, data: str | None = None, content_type: str | None = None) -> None:
        attempts.append({"name": name, "method": method, "url": url, "data": data, "content_type": content_type})

    # Hikvision/HiLook rename via ISAPI (preferred for Hikvision)
    hik_xml = f"<VideoInputChannel><id>{int(channel)}</id><name>{title}</name></VideoInputChannel>"
    hik_proxy_xml = f"<InputProxyChannel><id>{int(channel)}</id><name>{title}</name></InputProxyChannel>"

    for p in port_candidates:
        for scheme in ("http", "https"):
            # Avoid very common dead combinations that waste time.
            if scheme == "https" and p == 80:
                continue
            if scheme == "http" and p == 443:
                continue

            base = f"{scheme}://{ip}:{p}"
            _add_attempt(
                "hikvision_isapi_videoinput",
                "PUT",
                f"{base}/ISAPI/System/Video/inputs/channels/{int(channel)}",
                hik_xml,
                "application/xml",
            )
            _add_attempt(
                "hikvision_isapi_inputproxy",
                "PUT",
                f"{base}/ISAPI/ContentMgmt/InputProxy/channels/{int(channel)}",
                hik_proxy_xml,
                "application/xml",
            )

            # Dahua/Intelbras style rename (also used as fallback)
            _add_attempt(
                "dahua_configmanager",
                "GET",
                f"{base}/cgi-bin/configManager.cgi?action=setConfig&ChannelTitle[{idx0}].Name={q_title}",
            )

    # Try family-specific path first, then generic fallback.
    if is_hik:
        attempts.sort(key=lambda a: 0 if str(a.get("name", "")).startswith("hikvision_") else 1)
    else:
        attempts.sort(key=lambda a: 0 if str(a.get("name", "")).startswith("dahua_") else 1)

    last_err = ""
    for at in attempts:
        method = str(at.get("method") or "GET").upper()
        url = str(at.get("url") or "")
        data = at.get("data")
        ctype = at.get("content_type")
        name = str(at.get("name") or "rename")
        headers = {"Accept": "*/*"}
        if ctype:
            headers["Content-Type"] = ctype

        for auth in (HTTPDigestAuth(user, password), (user, password)):
            try:
                if method == "PUT":
                    r = requests.put(url, auth=auth, timeout=(2.5, 5.5), verify=False, headers=headers, data=data)
                else:
                    r = requests.get(url, auth=auth, timeout=(2.5, 5.5), verify=False, headers=headers)

                if r.status_code in (200, 201, 202, 204):
                    _persist_inventory_title()
                    return {"ok": True, "status": r.status_code, "url": url, "method": name}
                last_err = f"{name}: HTTP {r.status_code}"
            except requests.exceptions.ReadTimeout:
                last_err = f"{name}: timeout"
                continue
            except Exception as e:
                last_err = f"{name}: {str(e)}"
                continue

    return {"ok": False, "error": last_err or "Falha ao renomear", "inventory_updated": False}
