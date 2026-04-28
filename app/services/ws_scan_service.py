from __future__ import annotations

import json
from typing import Any, Dict

import anyio
from fastapi import WebSocket

from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug
from app.models.requests import ScanRequest
from app.services.scan_service import run_http_scan


async def _ws_send(ws: WebSocket, obj: Dict[str, Any]) -> None:
    await ws.send_text(json.dumps(obj, ensure_ascii=False))


def _run_scan_in_tenant(req: ScanRequest, tenant_slug: str = "") -> Dict[str, Any]:
    ctx = set_current_tenant_slug(tenant_slug)
    try:
        return run_http_scan(req)
    finally:
        reset_current_tenant_slug(ctx)


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
    except Exception as e:
        msg = str(e) or repr(e) or "Erro interno no scan."
        await _ws_send(ws, {"type": "error", "message": msg})
        return

    # Se chegou aqui, o inventário foi atualizado
    await _ws_send(ws, {"type": "inventory_updated"})
    await _ws_send(ws, {"type": "done", "message": "Scan concluído. Inventário atualizado.", "result": result})
