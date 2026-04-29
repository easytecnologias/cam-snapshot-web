from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.nvr_ai_service import index_recording, list_nvr_targets, query_recording_segments, search_events, stats

router = APIRouter(prefix="/api/ia", tags=["ia"])


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
