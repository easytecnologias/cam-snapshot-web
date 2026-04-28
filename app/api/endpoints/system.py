from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict

from fastapi import APIRouter

from app.core.database_runtime import database_runtime_status
from app.core.settings import get_settings
from app.services.db_store import db_status, init_db

router = APIRouter(prefix="/api/system", tags=["system"])
STARTED_AT = datetime.now(timezone.utc).isoformat()


@router.get("/health/live")
def api_system_live() -> Dict[str, Any]:
    settings = get_settings()
    return {
        "ok": True,
        "status": "alive",
        "app": settings.app_name,
        "version": settings.app_version,
        "env": settings.app_env,
        "started_at": STARTED_AT,
    }


@router.get("/health/ready")
def api_system_ready() -> Dict[str, Any]:
    settings = get_settings()
    db = db_status()
    runtime = database_runtime_status()
    return {
        "ok": True,
        "status": "ready",
        "app": settings.app_name,
        "version": settings.app_version,
        "env": settings.app_env,
        "database": {
            "backend": settings.database_backend,
            "exists": bool(db.get("exists")),
            "path": db.get("db_path", ""),
            "configured": bool(runtime.get("configured")),
            "reachable": bool(runtime.get("reachable")),
            "detail": runtime.get("detail", ""),
            "host": runtime.get("host", ""),
            "port": runtime.get("port", 0),
            "name": runtime.get("database", ""),
        },
    }


@router.get("/info")
def api_system_info() -> Dict[str, Any]:
    settings = get_settings()
    return {"ok": True, "app": settings.public_dict(), "database_runtime": database_runtime_status()}


@router.post("/bootstrap")
def api_system_bootstrap() -> Dict[str, Any]:
    return {"ok": True, "database": init_db()}
