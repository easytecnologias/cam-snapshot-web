from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from app.core.observability import RequestContextMiddleware, configure_logging
from app.core.paths import WEB_DIR, STATIC_DIR, SAIDA_DIR, DATA_DIR, ensure_dirs
from app.core.security import ApiAuthMiddleware
from app.core.settings import get_settings
from app.core.tenant_context import tenant_snapshot_dir
from app.services.auth_store import init_auth_db
from app.services.db_store import init_db
from app.services.maintenance_ping_service import maintenance_ping_hub
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
)

ensure_dirs()
settings = get_settings()
configure_logging(settings)

app = FastAPI(
    title=settings.app_name,
    version=settings.app_version,
    docs_url="/docs" if settings.enable_docs else None,
    redoc_url="/redoc" if settings.enable_docs else None,
    openapi_url="/openapi.json" if settings.enable_docs else None,
)
app.add_middleware(RequestContextMiddleware)
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

# Estado compartilhado (ex.: credencial do ultimo SCAN)
app.state.last_scan_auth = {"user": None, "pass": None}
app.state.settings = settings


@app.on_event("startup")
async def startup_events() -> None:
    init_db()
    init_auth_db()
    await maintenance_ping_hub.start()


@app.on_event("shutdown")
async def shutdown_events() -> None:
    await maintenance_ping_hub.stop()


@app.get("/", include_in_schema=False)
def index_page() -> FileResponse:
    return FileResponse(WEB_DIR / "dashboard.html")


@app.get("/inventory.html", include_in_schema=False)
def inventory_page() -> FileResponse:
    return FileResponse(WEB_DIR / "inventory.html")


@app.get("/inventory_switch.html", include_in_schema=False)
def inventory_switch_page() -> FileResponse:
    return FileResponse(WEB_DIR / "inventory_switch.html")


@app.get("/index.html", include_in_schema=False)
def index_alias() -> FileResponse:
    return FileResponse(WEB_DIR / "dashboard.html")


@app.get("/dashboard.html", include_in_schema=False)
def dashboard_page() -> FileResponse:
    return FileResponse(WEB_DIR / "dashboard.html")


@app.get("/windows.html", include_in_schema=False)
def windows_page() -> FileResponse:
    return FileResponse(WEB_DIR / "windows.html")


@app.get("/olt.html", include_in_schema=False)
def olt_page() -> FileResponse:
    return FileResponse(WEB_DIR / "olt.html")


@app.get("/switch.html", include_in_schema=False)
def switch_page() -> FileResponse:
    return FileResponse(WEB_DIR / "switch.html")


@app.get("/snapshot.html", include_in_schema=False)
def snapshot_page() -> FileResponse:
    return FileResponse(WEB_DIR / "snapshot.html")


@app.get("/snapshot_dvr.html", include_in_schema=False)
def snapshot_dvr_page() -> FileResponse:
    return FileResponse(WEB_DIR / "snapshot_dvr.html")


@app.get("/snapshot_nvr.html", include_in_schema=False)
def snapshot_nvr_page() -> FileResponse:
    return FileResponse(WEB_DIR / "snapshot_nvr.html")


@app.get("/dvr.html", include_in_schema=False)
def dvr_page() -> FileResponse:
    return FileResponse(WEB_DIR / "dvr.html")


@app.get("/nvr.html", include_in_schema=False)
def nvr_page() -> FileResponse:
    return FileResponse(WEB_DIR / "nvr.html")


@app.get("/ia_nvr.html", include_in_schema=False)
def ia_nvr_page() -> FileResponse:
    return FileResponse(WEB_DIR / "ia_nvr.html")


@app.get("/discovery.html", include_in_schema=False)
def discovery_page() -> FileResponse:
    return FileResponse(WEB_DIR / "discovery.html")


@app.get("/kmz.html", include_in_schema=False)
def kmz_page() -> FileResponse:
    return FileResponse(WEB_DIR / "kmz.html")


@app.get("/scripts.html", include_in_schema=False)
def scripts_page() -> FileResponse:
    return FileResponse(WEB_DIR / "scripts.html")


@app.get("/tools.html", include_in_schema=False)
def tools_page() -> FileResponse:
    return FileResponse(WEB_DIR / "tools.html")


@app.get("/grafana.html", include_in_schema=False)
def grafana_page() -> FileResponse:
    return FileResponse(WEB_DIR / "grafana.html")


@app.get("/maintenance.html", include_in_schema=False)
def maintenance_page() -> FileResponse:
    return FileResponse(WEB_DIR / "maintenance.html")


@app.get("/maintenance_dvr.html", include_in_schema=False)
def maintenance_dvr_page() -> FileResponse:
    return FileResponse(WEB_DIR / "maintenance_dvr.html")


@app.get("/maintenance_nvr.html", include_in_schema=False)
def maintenance_nvr_page() -> FileResponse:
    return FileResponse(WEB_DIR / "maintenance_nvr.html")


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
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")
app.mount("/saida", StaticFiles(directory=str(SAIDA_DIR)), name="saida")
app.mount("/data/nvr_ai", StaticFiles(directory=str(DATA_DIR / "nvr_ai")), name="nvr_ai")

# Snapshots: URL estavel /data/snapshot/<arquivo> com fallback entre pastas.
(DATA_DIR / "snapshot").mkdir(parents=True, exist_ok=True)
(SAIDA_DIR / "snapshot").mkdir(parents=True, exist_ok=True)


@app.get("/data/snapshot/{filename:path}", include_in_schema=False)
def data_snapshot_file(filename: str) -> Response:
    from pathlib import Path

    name = Path(filename).name
    candidates = [
        DATA_DIR / "snapshot" / name,
        SAIDA_DIR / "snapshot" / name,
        SAIDA_DIR / "snapshot_manual" / name,
    ]
    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return FileResponse(p)
        except Exception:
            continue
    return Response(status_code=404)


@app.get("/data/dvr_snapshot/{filename:path}", include_in_schema=False)
def data_dvr_snapshot_file(filename: str) -> Response:
    from pathlib import Path

    name = Path(filename).name
    candidates = [DATA_DIR / "dvr_snapshot" / name]
    tenants_root = DATA_DIR / "tenants"
    try:
        if tenants_root.exists():
            for tenant_dir in tenants_root.iterdir():
                if tenant_dir.is_dir():
                    candidates.append(tenant_snapshot_dir("dvr", tenant_dir.name) / name)
    except Exception:
        pass
    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return FileResponse(p)
        except Exception:
            continue
    return Response(status_code=404)


@app.get("/data/nvr_snapshot/{filename:path}", include_in_schema=False)
def data_nvr_snapshot_file(filename: str) -> Response:
    from pathlib import Path

    name = Path(filename).name
    candidates = [DATA_DIR / "nvr_snapshot" / name]
    tenants_root = DATA_DIR / "tenants"
    try:
        if tenants_root.exists():
            for tenant_dir in tenants_root.iterdir():
                if tenant_dir.is_dir():
                    candidates.append(tenant_snapshot_dir("nvr", tenant_dir.name) / name)
    except Exception:
        pass
    for p in candidates:
        try:
            if p.exists() and p.is_file():
                return FileResponse(p)
        except Exception:
            continue
    return Response(status_code=404)
