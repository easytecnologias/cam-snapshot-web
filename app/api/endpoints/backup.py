from __future__ import annotations

import os
from urllib.error import URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Request as FastAPIRequest

router = APIRouter(prefix="/api/backup", tags=["backup"])


def _default_easy_backup_url(request: FastAPIRequest) -> str:
    host = os.getenv("EASY_BACKUP_HOST", "").strip()
    if not host:
        host = request.url.hostname or "127.0.0.1"
    port = os.getenv("EASY_BACKUP_PORT", "8090").strip() or "8090"
    return f"http://{host}:{port}"


@router.get("/status")
def backup_status(request: FastAPIRequest) -> dict:
    url = os.getenv("EASY_BACKUP_URL", "").strip() or _default_easy_backup_url(request)
    health_url = url.rstrip("/") + "/api/health"
    online = False
    detail = "not_checked"
    try:
        req = Request(health_url, headers={"Accept": "application/json"})
        with urlopen(req, timeout=2) as response:
            online = 200 <= response.status < 300
            detail = f"http_{response.status}"
    except URLError as exc:
        detail = str(exc.reason)[:160]
    except Exception as exc:
        detail = str(exc)[:160]
    return {
        "name": "EASY Backup Manager",
        "configured_url": url,
        "health_url": health_url,
        "online": online,
        "detail": detail,
        "engine": "UrBackup",
        "docker_service": "easy-backup-manager",
    }
