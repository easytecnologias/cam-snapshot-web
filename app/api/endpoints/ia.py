from __future__ import annotations

import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.nvr_ai_service import clear_index, index_recording, list_nvr_targets, query_recording_segments, search_events, stats

router = APIRouter(prefix="/api/ia", tags=["ia"])
_INDEX_EXECUTOR = ThreadPoolExecutor(max_workers=1)
_INDEX_JOBS: Dict[str, Dict[str, Any]] = {}


class NvrAiIndexRequest(BaseModel):
    host: str
    channel: int = Field(default=1, ge=1, le=256)
    user: str = "admin"
    password: str
    start_time: str
    end_time: str
    http_port: int = Field(default=80, ge=1, le=65535)
    rtsp_port: int = Field(default=554, ge=1, le=65535)
    vendor: str = "auto"
    rtsp_template: str = ""
    stream_mode: str = "sub"
    interval_sec: int = Field(default=10, ge=1, le=300)
    max_frames: int = Field(default=80, ge=1, le=500)
    timeout_sec: int = Field(default=0, ge=0, le=3600)
    visual_filter: str = ""
    title: str = ""
    local: str = ""


@router.get("/nvr/targets")
def api_ia_nvr_targets() -> Dict[str, Any]:
    return list_nvr_targets()


@router.get("/nvr/stats")
def api_ia_nvr_stats() -> Dict[str, Any]:
    return stats()


@router.post("/nvr/index")
def api_ia_nvr_index(req: NvrAiIndexRequest) -> Dict[str, Any]:
    try:
        return index_recording(req.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


def _run_index_job(job_id: str, payload: Dict[str, Any]) -> None:
    job = _INDEX_JOBS.get(job_id)
    if not job:
        return
    job["status"] = "running"
    job["started_at"] = time.time()
    try:
        result = index_recording(payload)
        job["status"] = "done"
        job["result"] = result
        job["finished_at"] = time.time()
    except Exception as e:
        job["status"] = "error"
        job["error"] = str(e)
        job["finished_at"] = time.time()


@router.post("/nvr/index/jobs")
def api_ia_nvr_index_job(req: NvrAiIndexRequest) -> Dict[str, Any]:
    job_id = uuid.uuid4().hex
    payload = req.model_dump()
    _INDEX_JOBS[job_id] = {
        "ok": True,
        "job_id": job_id,
        "status": "queued",
        "created_at": time.time(),
        "payload": {
            "host": payload.get("host"),
            "channel": payload.get("channel"),
            "start_time": payload.get("start_time"),
            "end_time": payload.get("end_time"),
            "interval_sec": payload.get("interval_sec"),
            "max_frames": payload.get("max_frames"),
        },
    }
    _INDEX_EXECUTOR.submit(_run_index_job, job_id, payload)
    return {"ok": True, "job_id": job_id, "status": "queued"}


@router.get("/nvr/index/jobs/{job_id}")
def api_ia_nvr_index_job_status(job_id: str) -> Dict[str, Any]:
    job = _INDEX_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job nao encontrado")
    elapsed = int(time.time() - float(job.get("created_at") or time.time()))
    return {
        "ok": True,
        "job_id": job_id,
        "status": job.get("status"),
        "elapsed_sec": elapsed,
        "payload": job.get("payload") or {},
        "result": job.get("result"),
        "error": job.get("error") or "",
    }


@router.post("/nvr/recordings")
def api_ia_nvr_recordings(req: NvrAiIndexRequest) -> Dict[str, Any]:
    try:
        return query_recording_segments(req.model_dump())
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e)) from e


@router.get("/nvr/search")
def api_ia_nvr_search(q: str = "", host: str = "", channel: int = 0, limit: int = 80) -> Dict[str, Any]:
    return search_events(query=q, host=host, channel=channel, limit=limit)


@router.delete("/nvr/index")
def api_ia_nvr_clear_index() -> Dict[str, Any]:
    return clear_index()
