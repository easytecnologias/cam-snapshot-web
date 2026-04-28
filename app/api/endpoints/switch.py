from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter

from app.services.intelbras_switch_service import collect_switch_snapshot
from app.models.requests import SwitchCollectMacsRequest
from app.services.switch_service import collect_macs, list_macs, clear_macs

router = APIRouter(prefix="/api/switch", tags=["switch"])


def _as_str(v: Any) -> str:
    return str(v or "").strip()


@router.post("/intelbras/inspect")
def inspect_intelbras_switch(payload: Dict[str, Any]) -> Dict[str, Any]:
    host = _as_str(payload.get("host") or payload.get("ip"))
    user = _as_str(payload.get("user") or payload.get("username"))
    password = _as_str(payload.get("pass") or payload.get("password"))
    include_config = bool(payload.get("include_config", False))
    timeout = float(payload.get("timeout") or 10.0)
    port = int(payload.get("port") or 23)

    if not host or not user or not password:
        return {"ok": False, "error": "host/user/pass sao obrigatorios"}

    try:
        snapshot = collect_switch_snapshot(
            host=host,
            username=user,
            password=password,
            include_config=include_config,
            port=port,
            timeout=timeout,
        )
    except Exception as e:
        return {"ok": False, "error": str(e) or repr(e) or "falha ao consultar switch"}

    return {"ok": True, "host": host, "platform": "intelbras_telnet", "snapshot": snapshot}


@router.post("/collect-macs")
def api_switch_collect_macs(req: SwitchCollectMacsRequest) -> Dict[str, Any]:
    return collect_macs(req)


@router.get("/rows")
def api_switch_rows(site: str = "") -> Dict[str, Any]:
    return list_macs(site=site)


@router.post("/clear")
def api_switch_clear(site: str = "") -> Dict[str, Any]:
    return clear_macs(site=site)
