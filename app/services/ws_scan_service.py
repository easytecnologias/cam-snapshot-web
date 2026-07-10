from __future__ import annotations

import json
import ipaddress
import time
from typing import Any, Dict

import anyio
from fastapi import WebSocket

from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
from app.models.requests import ScanRequest
from app.services.connector_service import create_job, list_connectors, list_jobs
from app.services.inventory_json import inventory_row_key, load_inventory_json, save_inventory_json
from app.services.scan_service import run_http_scan


async def _ws_send(ws: WebSocket, obj: Dict[str, Any]) -> None:
    await ws.send_text(json.dumps(obj, ensure_ascii=False))


def _run_scan_in_tenant(req: ScanRequest, tenant_slug: str = "") -> Dict[str, Any]:
    ctx = set_current_tenant_slug(tenant_slug)
    try:
        return run_http_scan(req)
    finally:
        reset_current_tenant_slug(ctx)


def _expand_remote_targets(raw: str, limit: int = 256) -> list[str]:
    out: list[str] = []
    for part in str(raw or "").replace("\n", ",").split(","):
        item = part.strip()
        if not item:
            continue
        try:
            if "/" in item:
                net = ipaddress.ip_network(item, strict=False)
                for ip in net.hosts():
                    out.append(str(ip))
                    if len(out) >= limit:
                        return list(dict.fromkeys(out))
                continue
            if "-" in item:
                left, right = [p.strip() for p in item.split("-", 1)]
                start = ipaddress.ip_address(left)
                end = ipaddress.ip_address(right if "." in right else f"{left.rsplit('.', 1)[0]}.{right}")
                first, last = sorted((int(start), int(end)))
                for value in range(first, last + 1):
                    out.append(str(ipaddress.ip_address(value)))
                    if len(out) >= limit:
                        return list(dict.fromkeys(out))
                continue
            ipaddress.ip_address(item)
            out.append(item)
        except Exception:
            if all(ch.isalnum() or ch in ".:-_" for ch in item):
                out.append(item)
        if len(out) >= limit:
            return list(dict.fromkeys(out))
    return list(dict.fromkeys(out))


def _connector_for_site(site: str) -> dict[str, Any] | None:
    wanted = str(site or "").strip().lower()
    if not wanted:
        return None
    matches: list[dict[str, Any]] = []
    for row in list_connectors().get("connectors") or []:
        if str(row.get("type") or "").lower() != "routeros":
            continue
        keys = [
            str(row.get("site") or "").strip().lower(),
            str(row.get("name") or "").strip().lower(),
            str(row.get("client") or "").strip().lower(),
        ]
        if wanted in keys:
            matches.append(row)
    online = [row for row in matches if row.get("status") == "online"]
    return (online or matches or [None])[0]


def _parse_routeros_ping(result: Any) -> dict[str, bool]:
    text = str((result or {}).get("routeros_ping") or "") if isinstance(result, dict) else str(result or "")
    parsed: dict[str, bool] = {}
    for item in text.replace(";", ",").split(","):
        item = item.strip()
        if not item:
            continue
        sep = ":" if ":" in item else "="
        target, ok = (item.split(sep, 1) + [""])[:2]
        target = target.strip()
        if target:
            parsed[target] = ok.strip().lower() in {"1", "true", "ok", "online"}
    return parsed


def _tag_rows_for_connector(payload: Dict[str, Any], result: Dict[str, Any], tenant_slug: str = "") -> Dict[str, Any]:
    site = str(payload.get("local") or "").strip()
    connector = _connector_for_site(site)
    if not connector:
        return result
    targets = set(_expand_remote_targets(str(payload.get("alvo") or "")))
    if not targets:
        return result
    mode = str(payload.get("inventory_mode") or "olt").strip().lower() or "olt"
    ctx = set_current_tenant_slug(str(tenant_slug or "").strip().lower())
    try:
        rows = load_inventory_json(mode=mode) or []
        changed = False
        for row in rows:
            if not isinstance(row, dict):
                continue
            ip = str(row.get("ip") or row.get("IP") or "").strip()
            if ip not in targets:
                continue
            if site:
                row["local"] = row.get("local") or site
                row["site"] = row.get("site") or site
                row["site_name"] = row.get("site_name") or site
            row["remote"] = True
            row["remote_connector_id"] = connector.get("id")
            row["remote_connector_name"] = connector.get("name") or site
            if str(row.get("status") or "").strip().lower() == "online":
                row.pop("error", None)
            changed = True
        if changed:
            save_inventory_json(rows, mode=mode)
            result["inventory"] = rows
            result["inventory_count"] = len(rows)
    finally:
        reset_current_tenant_slug(ctx)
    return result


def _merge_remote_rows(existing: list[dict[str, Any]], new_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged = [dict(row) for row in existing if isinstance(row, dict)]
    by_key = {inventory_row_key(row, fallback=f"ROW:{idx}"): row for idx, row in enumerate(merged)}
    for row in new_rows:
        ip = str(row.get("ip") or "").strip()
        if not ip:
            continue
        row_key = inventory_row_key(row)
        current = by_key.get(row_key)
        if current:
            for key, value in row.items():
                if key in {"status", "local", "site", "site_name", "remote", "remote_connector_id", "remote_connector_name"}:
                    current[key] = value
                elif not str(current.get(key) or "").strip():
                    current[key] = value
        else:
            merged.append(row)
            by_key[row_key] = row
    return merged


async def _remote_inventory_via_connector(ws: WebSocket, payload: Dict[str, Any], result: Dict[str, Any], tenant_slug: str = "") -> Dict[str, Any]:
    site = str(payload.get("local") or "").strip()
    connector = _connector_for_site(site)
    if not connector:
        return result
    if connector.get("status") != "online":
        await _ws_send(ws, {"type": "status", "message": f"Conector {connector.get('name') or site} offline. Coleta remota nao executada."})
        return result
    targets = _expand_remote_targets(str(payload.get("alvo") or ""))
    if not targets:
        return result

    await _ws_send(ws, {"type": "status", "message": f"{site} via conector: testando {len(targets)} alvo(s)..."})

    online_targets: list[str] = []
    connector_id = str(connector.get("id") or "")
    chunks = [targets[i:i + 50] for i in range(0, len(targets), 50)] or [targets]
    for idx, chunk in enumerate(chunks, start=1):
        if len(chunks) > 1:
            await _ws_send(ws, {"type": "status", "message": f"{site} via conector: lote {idx}/{len(chunks)} ({len(chunk)} alvo(s))..."})
        job = create_job({"connector_id": connector_id, "type": "ping_many", "payload": {"targets": chunk}}).get("job") or {}
        job_id = str(job.get("id") or "")
        final_job: dict[str, Any] | None = None
        deadline = time.time() + 150
        while time.time() < deadline:
            await anyio.sleep(3)
            jobs = list_jobs(connector_id).get("jobs") or []
            final_job = next((item for item in jobs if str(item.get("id") or "") == job_id), None)
            if final_job and final_job.get("status") in {"done", "failed"}:
                break

        if not final_job or final_job.get("status") != "done":
            await _ws_send(ws, {"type": "status", "message": f"Conector nao devolveu o lote {idx}/{len(chunks)} dentro do tempo."})
            continue

        for target, ok in _parse_routeros_ping(final_job.get("result") or {}).items():
            if ok:
                online_targets.append(target)

    online_targets = list(dict.fromkeys(online_targets))
    if not online_targets:
        await _ws_send(ws, {"type": "status", "message": "Conector respondeu, mas nenhum alvo ficou online."})
        return result

    mode = str(payload.get("inventory_mode") or "olt").strip().lower() or "olt"
    ctx = set_current_tenant_slug(str(tenant_slug or "").strip().lower())
    try:
        existing = load_inventory_json(mode=mode) or []
        rows = [
            {
                "ip": ip,
                "host": ip,
                "http_port": 80,
                "title": ip,
                "local": site,
                "site": site,
                "site_name": site,
                "status": "online",
                "remote": True,
                "remote_connector_id": connector.get("id"),
                "remote_connector_name": connector.get("name"),
            }
            for ip in online_targets
        ]
        merged = _merge_remote_rows(existing, rows)
        save_inventory_json(merged, mode=mode)
    finally:
        reset_current_tenant_slug(ctx)

    result["inventory"] = merged
    result["inventory_count"] = len(merged)
    result["discovered_count"] = len(online_targets)
    result["remote_discovered"] = len(online_targets)
    await _ws_send(ws, {"type": "status", "message": f"Conector {connector.get('name') or site}: {len(online_targets)} IP(s) ativo(s) gravado(s) no inventario."})
    return result


async def run_ws_scan(ws: WebSocket, payload: Dict[str, Any], tenant_slug: str = "") -> None:
    """
    WS /ws/scan

    Importante (Windows): Uvicorn costuma usar WindowsSelectorEventLoopPolicy com --reload,
    e asyncio.create_subprocess_exec pode lançar NotImplementedError.
    Por isso, aqui executamos o scan via run_http_scan() em thread (subprocess.run),
    mantendo compatibilidade e evitando travar o loop.
    """
    alvo = (payload.get("alvo") or "").strip()
    usuario = (payload.get("usuario") or "admin").strip() or "admin"
    senha = (payload.get("senha") or "admin").strip() or "admin"

    # Compatibilidade de payload:
    # - Front atual usa: snapshot/imgbb/excel/olt_enrich/ia
    # - Alguns clientes usam: capture_snapshot/upload_imgbb/generate_spreadsheet/enrich_with_olt/run_image_health_ai
    snapshot = bool(payload.get("snapshot", payload.get("capture_snapshot", False)))
    imgbb = bool(payload.get("imgbb", payload.get("upload_imgbb", False)))
    excel = bool(payload.get("excel", payload.get("generate_spreadsheet", False)))
    olt_enrich = bool(payload.get("olt_enrich", payload.get("enrich_with_olt", False)))
    ia = bool(payload.get("ia", payload.get("run_image_health_ai", False)))

    req = ScanRequest(
        alvo=alvo,
        usuario=usuario,
        senha=senha,
        capture_snapshot=snapshot,
        snapshot=snapshot,
        imgbb=imgbb,
        excel=excel,
        olt_enrich=olt_enrich,
        ia=ia,
        append_inventory=bool(payload.get("append_inventory", False)),
        reuse_inventory=bool(payload.get("reuse_inventory", False)),
        nat_mode=bool(payload.get("nat_mode", False)),
        set_local=bool(payload.get("set_local", False)),
        local=(payload.get("local") or ""),
        inventory_mode=str(payload.get("inventory_mode") or "olt"),
    )

    await _ws_send(ws, {"type": "status", "message": "Executando inventory_scan..."})

    try:
        # roda em thread para não bloquear o loop e não depender de subprocess async
        result = await anyio.to_thread.run_sync(_run_scan_in_tenant, req, str(tenant_slug or "").strip().lower())
        result = _tag_rows_for_connector(payload, result, str(tenant_slug or "").strip().lower())
        result = await _remote_inventory_via_connector(ws, payload, result, str(tenant_slug or "").strip().lower())
    except Exception as e:
        msg = str(e) or repr(e) or "Erro interno no scan."
        await _ws_send(ws, {"type": "error", "message": msg})
        return

    # Se chegou aqui, o inventário foi atualizado
    await _ws_send(ws, {"type": "inventory_updated"})
    await _ws_send(ws, {"type": "done", "message": "Scan concluído. Inventário atualizado.", "result": result})
