from __future__ import annotations

import re
import shutil
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Literal
from urllib.parse import quote

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from requests.auth import HTTPDigestAuth

from app.core.paths import DATA_DIR

router = APIRouter(prefix="/api/playback", tags=["playback"])

EXPORT_DIR = DATA_DIR / "playback_exports"
SAFE_FILE = re.compile(r"^[A-Za-z0-9_.-]+$")


class PlaybackClipRequest(BaseModel):
    host: str = Field(min_length=3, max_length=128)
    user: str = Field(default="admin", min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=160)
    channel: int = Field(ge=0, le=256)
    start: str
    end: str
    format: Literal["mp4", "dav"] = "mp4"
    timeout_sec: int = Field(default=180, ge=10, le=900)


class PlaybackSnapshotRequest(BaseModel):
    host: str = Field(min_length=3, max_length=128)
    user: str = Field(default="admin", min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=160)
    channel: int = Field(ge=0, le=256)
    timestamp: str
    timeout_sec: int = Field(default=45, ge=10, le=180)


class PlaybackFramesRequest(PlaybackClipRequest):
    interval_seconds: int = Field(default=60, ge=1, le=3600)


def _parse_dt(value: str) -> datetime:
    text = value.strip()
    for fmt in ("%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    try:
        return datetime.fromisoformat(text)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Data/hora inválida.") from exc


def _clean_host(host: str) -> str:
    cleaned = host.strip()
    cleaned = re.sub(r"^https?://", "", cleaned, flags=re.I)
    cleaned = cleaned.split("/", 1)[0].strip()
    if not cleaned or any(ch.isspace() for ch in cleaned) or "\\" in cleaned:
        raise HTTPException(status_code=422, detail="DVR inválido.")
    return cleaned


def _safe_stem(host: str, channel: int, start: datetime, end: datetime) -> str:
    host_part = re.sub(r"[^A-Za-z0-9_.-]+", "_", host)
    return f"{host_part}_ch{channel}_{start:%Y%m%d_%H%M%S}_{end:%H%M%S}_{int(time.time())}"


def _file_url(path: Path) -> str:
    return f"/api/playback/files/{quote(path.name)}"


def _validate_range(start: datetime, end: datetime) -> None:
    if end <= start:
        raise HTTPException(status_code=422, detail="O fim precisa ser maior que o início.")
    if end - start > timedelta(minutes=60):
        raise HTTPException(status_code=422, detail="Trecho limitado a 60 minutos por consulta.")


def _validate_frame_count(start: datetime, end: datetime, interval_seconds: int) -> int:
    total_seconds = int((end - start).total_seconds())
    count = (total_seconds // interval_seconds) + 1
    if count > 720:
        raise HTTPException(status_code=422, detail="Sequência limitada a 720 frames. Aumente o intervalo.")
    return count


def _download_dav(payload: PlaybackClipRequest, start: datetime, end: datetime, out_path: Path) -> None:
    host = _clean_host(payload.host)
    start_s = quote(start.strftime("%Y-%m-%d %H:%M:%S"))
    end_s = quote(end.strftime("%Y-%m-%d %H:%M:%S"))
    url = (
        f"http://{host}/cgi-bin/loadfile.cgi?action=startLoad"
        f"&channel={payload.channel}&startTime={start_s}&endTime={end_s}"
    )
    try:
        with requests.get(
            url,
            auth=HTTPDigestAuth(payload.user, payload.password),
            stream=True,
            timeout=(8, payload.timeout_sec),
        ) as res:
            if res.status_code in (401, 403):
                raise HTTPException(status_code=401, detail="Credencial recusada pelo DVR.")
            if res.status_code == 404:
                raise HTTPException(status_code=404, detail="Gravação não encontrada no DVR.")
            if res.status_code >= 400:
                raise HTTPException(status_code=502, detail=f"DVR respondeu HTTP {res.status_code}.")

            out_path.parent.mkdir(parents=True, exist_ok=True)
            total = 0
            with out_path.open("wb") as fh:
                for chunk in res.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    total += len(chunk)
                    fh.write(chunk)
            if total < 1024:
                raise HTTPException(status_code=404, detail="DVR retornou arquivo vazio.")
    except HTTPException:
        raise
    except requests.RequestException as exc:
        raise HTTPException(status_code=502, detail=f"Falha ao consultar DVR: {exc}") from exc


def _run_ffmpeg(args: list[str], timeout_sec: int) -> None:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise HTTPException(status_code=503, detail="ffmpeg não está disponível no servidor.")
    cmd = [ffmpeg, "-y", "-hide_banner", "-loglevel", "error", *args]
    try:
        subprocess.run(cmd, check=True, timeout=timeout_sec, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except subprocess.TimeoutExpired as exc:
        raise HTTPException(status_code=504, detail="Conversão excedeu o tempo limite.") from exc
    except subprocess.CalledProcessError as exc:
        msg = exc.stderr.decode("utf-8", errors="ignore").strip()
        raise HTTPException(status_code=502, detail=msg or "Falha ao converter gravação.") from exc


@router.post("/clip")
def create_clip(payload: PlaybackClipRequest) -> dict:
    start = _parse_dt(payload.start)
    end = _parse_dt(payload.end)
    _validate_range(start, end)

    host = _clean_host(payload.host)
    stem = _safe_stem(host, payload.channel, start, end)
    dav_path = EXPORT_DIR / f"{stem}.dav"
    _download_dav(payload, start, end, dav_path)

    if payload.format == "dav":
        return {
            "ok": True,
            "format": "dav",
            "url": _file_url(dav_path),
            "filename": dav_path.name,
            "size": dav_path.stat().st_size,
        }

    mp4_path = EXPORT_DIR / f"{stem}.mp4"
    try:
        _run_ffmpeg(
            ["-i", str(dav_path), "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-movflags", "+faststart", "-an", str(mp4_path)],
            payload.timeout_sec,
        )
    except HTTPException as exc:
        return {
            "ok": True,
            "format": "dav",
            "url": _file_url(dav_path),
            "filename": dav_path.name,
            "size": dav_path.stat().st_size,
            "warning": exc.detail,
        }

    return {
        "ok": True,
        "format": "mp4",
        "url": _file_url(mp4_path),
        "filename": mp4_path.name,
        "size": mp4_path.stat().st_size,
        "source_url": _file_url(dav_path),
    }


@router.post("/snapshot")
def create_snapshot(payload: PlaybackSnapshotRequest) -> dict:
    ts = _parse_dt(payload.timestamp)
    start = ts - timedelta(seconds=2)
    end = ts + timedelta(seconds=3)
    clip_payload = PlaybackClipRequest(
        host=payload.host,
        user=payload.user,
        password=payload.password,
        channel=payload.channel,
        start=start.strftime("%Y-%m-%d %H:%M:%S"),
        end=end.strftime("%Y-%m-%d %H:%M:%S"),
        format="dav",
        timeout_sec=payload.timeout_sec,
    )

    host = _clean_host(payload.host)
    stem = _safe_stem(host, payload.channel, start, end)
    dav_path = EXPORT_DIR / f"{stem}.dav"
    jpg_path = EXPORT_DIR / f"{stem}.jpg"
    _download_dav(clip_payload, start, end, dav_path)
    _run_ffmpeg(["-ss", "00:00:02", "-i", str(dav_path), "-frames:v", "1", "-q:v", "3", str(jpg_path)], payload.timeout_sec)

    return {
        "ok": True,
        "format": "jpg",
        "url": _file_url(jpg_path),
        "filename": jpg_path.name,
        "size": jpg_path.stat().st_size,
        "source_url": _file_url(dav_path),
    }


@router.post("/frames")
def create_frames(payload: PlaybackFramesRequest) -> dict:
    start = _parse_dt(payload.start)
    end = _parse_dt(payload.end)
    _validate_range(start, end)
    expected = _validate_frame_count(start, end, payload.interval_seconds)

    host = _clean_host(payload.host)
    stem = _safe_stem(host, payload.channel, start, end)
    dav_path = EXPORT_DIR / f"{stem}.dav"
    _download_dav(payload, start, end, dav_path)

    pattern = EXPORT_DIR / f"{stem}_frame_%04d.jpg"
    _run_ffmpeg(
        [
            "-i", str(dav_path),
            "-vf", f"fps=1/{payload.interval_seconds},scale=1280:-2",
            "-q:v", "3",
            str(pattern),
        ],
        payload.timeout_sec,
    )

    files = sorted(EXPORT_DIR.glob(f"{stem}_frame_*.jpg"))
    frames = []
    for idx, path in enumerate(files):
        frames.append(
            {
                "index": idx + 1,
                "timestamp": (start + timedelta(seconds=idx * payload.interval_seconds)).strftime("%Y-%m-%d %H:%M:%S"),
                "url": _file_url(path),
                "filename": path.name,
                "size": path.stat().st_size,
            }
        )

    if not frames:
        raise HTTPException(status_code=404, detail="Nenhum frame extraído.")

    return {
        "ok": True,
        "format": "frames",
        "interval_seconds": payload.interval_seconds,
        "expected": expected,
        "count": len(frames),
        "frames": frames,
        "source_url": _file_url(dav_path),
    }


@router.get("/files/{filename}")
def get_playback_file(filename: str) -> FileResponse:
    if not SAFE_FILE.match(filename):
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")
    path = EXPORT_DIR / filename
    try:
        path.resolve().relative_to(EXPORT_DIR.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.") from exc
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Arquivo não encontrado.")

    media = "application/octet-stream"
    if path.suffix.lower() == ".mp4":
        media = "video/mp4"
    elif path.suffix.lower() in (".jpg", ".jpeg"):
        media = "image/jpeg"
    return FileResponse(path, media_type=media, filename=path.name, headers={"Cache-Control": "no-cache"})
