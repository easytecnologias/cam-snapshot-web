from __future__ import annotations

import asyncio
import contextlib
import logging
import os

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.observability import RequestContextMiddleware, configure_logging
from app.core.paths import SAIDA_DIR, DATA_DIR, ensure_dirs
from app.core.security import AUTH_COOKIE_NAME, ApiAuthMiddleware
from app.core.settings import get_settings
from app.core.tenant_context import reset_current_tenant_slug, set_current_tenant_slug, tenant_snapshot_dir
from app.services.auth_store import get_user_by_token
from app.services.auth_store import init_auth_db
from app.services.db_store import init_db
from app.services.maintenance_ping_service import maintenance_ping_hub
from app.api.endpoints.maintenance import scripts_zabbix_status_sync
from app.api.endpoints import (
    auth_router,
    cameras_router,
    system_router,
    live_router,
    scan_router,
    olt_router,
    tools_router,
    maintenance_router,
    switch_router,
    ws_router,
    dvr_router,
    nvr_router,
    ia_router,
    database_router,
    dashboard_router,
    windows_router,
    backup_router,
    playback_router,
    connectors_router,
    network_tools_router,
    deployments_router,
)

ensure_dirs()
settings = get_settings()
configure_logging(settings)
logger = logging.getLogger("app.zabbix_status_sync")


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        if str(request.url.scheme or "").lower() == "https":
            response.headers.setdefault("Strict-Transport-Security", "max-age=15552000; includeSubDomains")
        return response

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    docs_url="/docs" if settings.enable_docs else None,
    redoc_url="/redoc" if settings.enable_docs else None,
    openapi_url="/openapi.json" if settings.enable_docs else None,
)
app.add_middleware(RequestContextMiddleware)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(ApiAuthMiddleware, settings=settings)

allowed_origins = [item.strip() for item in settings.allowed_origins.split(",") if item.strip()]
if allowed_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allowed_origins,
        allow_credentials="*" not in allowed_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )

# Routers (V7)
app.include_router(auth_router)
app.include_router(cameras_router)
app.include_router(system_router)
app.include_router(live_router)
app.include_router(scan_router)
app.include_router(olt_router)
app.include_router(tools_router)
app.include_router(maintenance_router)
app.include_router(switch_router)
app.include_router(ws_router)
app.include_router(dvr_router)
app.include_router(nvr_router)
app.include_router(ia_router)
app.include_router(database_router)
app.include_router(dashboard_router)
app.include_router(windows_router)
app.include_router(backup_router)
app.include_router(playback_router)
app.include_router(connectors_router)
app.include_router(network_tools_router)
app.include_router(deployments_router)

# Estado compartilhado (ex.: credencial do ultimo SCAN)
app.state.last_scan_auth = {"user": None, "pass": None}
app.state.settings = settings
app.state.zabbix_status_task = None
app.state.zabbix_status_last = {}


def _zabbix_status_interval_s() -> int:
    raw = os.getenv("SIGHTOPS_ZABBIX_STATUS_SYNC_INTERVAL", "60")
    try:
        value = int(raw)
    except Exception:
        value = 60
    return max(30, min(value, 3600))


def _zabbix_status_tenant_slug() -> str:
    return os.getenv("SIGHTOPS_ZABBIX_STATUS_TENANT", "default").strip().lower()


def _run_zabbix_status_sync_for_mode(mode: str, tenant_slug: str) -> dict:
    token = set_current_tenant_slug(tenant_slug)
    try:
        return scripts_zabbix_status_sync({"source": "ip", "mode": mode, "site": ""})
    finally:
        reset_current_tenant_slug(token)


async def _zabbix_status_sync_loop() -> None:
    interval = _zabbix_status_interval_s()
    tenant_slug = _zabbix_status_tenant_slug()
    await asyncio.sleep(10)
    while True:
        try:
            totals: list[str] = []
            last: dict[str, object] = {"ok": True, "interval_s": interval, "tenant": tenant_slug, "modes": {}}
            for mode in ("basic", "olt", "switch"):
                result = await asyncio.to_thread(
                    _run_zabbix_status_sync_for_mode,
                    mode,
                    tenant_slug,
                )
                last["modes"][mode] = result
                if result.get("ok"):
                    totals.append(
                        f"{mode}: {result.get('online', 0)}/{result.get('total', 0)} online, "
                        f"{result.get('offline', 0)} offline"
                    )
                elif result.get("error"):
                    last["ok"] = False
                    logger.debug("zabbix status sync skipped: %s", result.get("error"))
                    break
            app.state.zabbix_status_last = last
            if totals:
                logger.info("zabbix status sync updated: %s", "; ".join(totals))
        except asyncio.CancelledError:
            raise
        except Exception:
            app.state.zabbix_status_last = {"ok": False, "interval_s": interval, "error": "loop failed"}
            logger.exception("zabbix status sync loop failed")
        await asyncio.sleep(interval)


@app.get("/api/scripts/zabbix/status-sync/auto")
def zabbix_status_sync_auto_state() -> JSONResponse:
    task = getattr(app.state, "zabbix_status_task", None)
    return JSONResponse(
        content={
            "ok": True,
            "running": bool(task and not task.done()),
            "interval_s": _zabbix_status_interval_s(),
            "last": getattr(app.state, "zabbix_status_last", {}) or {},
        }
    )


@app.on_event("startup")
async def startup_events() -> None:
    init_db()
    init_auth_db()
    await maintenance_ping_hub.start()
    app.state.zabbix_status_task = asyncio.create_task(
        _zabbix_status_sync_loop(),
        name="zabbix-status-sync-loop",
    )


@app.on_event("shutdown")
async def shutdown_events() -> None:
    task = getattr(app.state, "zabbix_status_task", None)
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task
    await maintenance_ping_hub.stop()


@app.get("/", include_in_schema=False)
def index_page() -> RedirectResponse:
    # Frontend legado (web/pages) aposentado -- /v2/ e a unica UI agora.
    return RedirectResponse(url="/v2/")


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> Response:
    # Evita 404 no browser (favicon opcional)
    return Response(status_code=204)


@app.get("/.well-known/appspecific/com.chrome.devtools.json", include_in_schema=False)
def chrome_devtools_manifest() -> JSONResponse:
    # Chrome DevTools faz essa requisicao em alguns cenarios; retornamos um JSON vazio.
    return JSONResponse(content={})


# Static
(DATA_DIR / "nvr_ai").mkdir(parents=True, exist_ok=True)


def _request_token(request: Request) -> str:
    raw = str(request.headers.get("authorization") or "").strip()
    scheme, _, token = raw.partition(" ")
    if scheme.lower() == "bearer" and token.strip():
        return token.strip()
    return str(request.cookies.get(AUTH_COOKIE_NAME) or "").strip()


def _media_context(request: Request) -> tuple[bool, str]:
    """(autorizado, tenant_slug) do dono da sessao.

    Rotas de midia ficam fora de /api/, entao o ApiAuthMiddleware nao roda e o
    contextvar de tenant nao esta populado -- o slug tem que sair do proprio
    usuario, nunca de env global.
    """
    if not settings.auth_enabled:
        return True, ""
    token = _request_token(request)
    if not token:
        return False, ""
    user = get_user_by_token(token)
    if not user:
        return False, ""
    return True, str(user.get("tenant_slug") or "").strip().lower()


# /saida e /data/nvr_ai NAO sao servidos por HTTP de proposito.
#
# Eram dois mounts estaticos de pasta inteira, sem escopo de tenant: qualquer
# usuario logado de qualquer cliente conseguia ler arquivo de outro sabendo o
# nome. Nada do produto consumia essas rotas -- o frontend nao as chama, e os
# clipes de IA sao servidos por /api/playback/files/, que passa pelo middleware
# de auth. SAIDA_DIR ainda guarda artefato operacional (inventario, dump de MAC
# da OLT, CSV) e continua acessivel pelas APIs proprias de cada recurso.
#
# Se um dia for preciso servir frame/clipe da busca de IA, criar um endpoint
# /api/... que resolva o arquivo dentro do tenant do usuario -- nunca reabrir um
# mount de pasta.

# Snapshots: URL estavel /data/snapshot/<arquivo> com fallback entre pastas.
(DATA_DIR / "snapshot").mkdir(parents=True, exist_ok=True)
(SAIDA_DIR / "snapshot").mkdir(parents=True, exist_ok=True)


@app.get("/data/snapshot/{filename:path}", include_in_schema=False)
def data_snapshot_file(filename: str, request: Request) -> Response:
    from pathlib import Path

    authorized, tenant_slug = _media_context(request)
    if not authorized:
        return JSONResponse(status_code=401, content={"detail": "autenticacao obrigatoria"})
    name = Path(filename).name
    candidates = [
        tenant_snapshot_dir("ip", tenant_slug) / name,
        DATA_DIR / "snapshot" / name,
        SAIDA_DIR / "snapshot" / name,
        SAIDA_DIR / "snapshot_manual" / name,
    ]
    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return FileResponse(p, headers={"Cache-Control": "no-cache"})
        except Exception:
            continue
    return Response(status_code=404)


@app.get("/data/dvr_snapshot/{filename:path}", include_in_schema=False)
def data_dvr_snapshot_file(filename: str, request: Request) -> Response:
    from pathlib import Path

    authorized, tenant_slug = _media_context(request)
    if not authorized:
        return JSONResponse(status_code=401, content={"detail": "autenticacao obrigatoria"})
    name = Path(filename).name
    candidates = [
        tenant_snapshot_dir("dvr", tenant_slug) / name,
        DATA_DIR / "dvr_snapshot" / name,
    ]
    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return FileResponse(p, headers={"Cache-Control": "no-cache"})
        except Exception:
            continue
    return Response(status_code=404)


@app.get("/data/nvr_snapshot/{filename:path}", include_in_schema=False)
def data_nvr_snapshot_file(filename: str, request: Request) -> Response:
    from pathlib import Path

    authorized, tenant_slug = _media_context(request)
    if not authorized:
        return JSONResponse(status_code=401, content={"detail": "autenticacao obrigatoria"})
    name = Path(filename).name
    candidates = [
        tenant_snapshot_dir("nvr", tenant_slug) / name,
        DATA_DIR / "nvr_snapshot" / name,
    ]
    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return FileResponse(p, headers={"Cache-Control": "no-cache"})
        except Exception:
            continue
    return Response(status_code=404)
