from __future__ import annotations

import json
import os
from urllib.error import URLError
from urllib.request import Request, urlopen

from fastapi import APIRouter, Request as FastAPIRequest

from app.core.paths import DATA_DIR

router = APIRouter(prefix="/api/backup", tags=["backup"])


def _default_easy_backup_url(request: FastAPIRequest) -> str:
    host = os.getenv("EASY_BACKUP_HOST", "").strip()
    if not host:
        host = request.url.hostname or "127.0.0.1"
    port = os.getenv("EASY_BACKUP_PORT", "8090").strip() or "8090"
    return f"http://{host}:{port}"


def _num(value: object) -> float:
    try:
        return float(value or 0)
    except Exception:
        return 0.0


def _load_windows_summary() -> dict:
    path = DATA_DIR / "windows-inventory.json"
    rows: list[dict] = []
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        raw_rows = payload.get("inventory") if isinstance(payload, dict) else payload
        if isinstance(raw_rows, list):
            rows = [row for row in raw_rows if isinstance(row, dict)]
    except Exception:
        rows = []

    total = len(rows)
    online = sum(1 for row in rows if str(row.get("status") or "").lower() in {"online", "agent_reported"})
    disk_total_gb = sum(_num(row.get("disk_total_gb")) for row in rows)
    ssd = sum(1 for row in rows if str(row.get("disk_type") or "").lower() == "ssd")
    last_seen = ""
    for row in rows:
        value = str(row.get("last_seen") or "").strip()
        if value and value > last_seen:
            last_seen = value

    return {
        "total": total,
        "online": online,
        "offline": max(total - online, 0),
        "ssd": ssd,
        "disk_total_gb": round(disk_total_gb, 2),
        "last_seen": last_seen,
    }


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
        "windows_inventory": _load_windows_summary(),
    }
