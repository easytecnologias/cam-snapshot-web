from __future__ import annotations

import json
import os
import re
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import quote

from PIL import Image

from app.core.paths import DATA_DIR, NVR_INVENTORY_JSON_PATH
from app.services.db_store import decorate_legacy_rows, legacy_rows_from_db

NVR_AI_DIR = DATA_DIR / "nvr_ai"
NVR_AI_FRAMES_DIR = NVR_AI_DIR / "frames"
NVR_AI_INDEX_PATH = NVR_AI_DIR / "index.json"


def _safe_text(value: Any) -> str:
    return str(value or "").strip()


def _safe_slug(value: Any) -> str:
    raw = _safe_text(value).lower()
    raw = re.sub(r"[^a-z0-9_.-]+", "_", raw)
    return raw.strip("_") or "item"


def _load_json(path: Path, default: Any) -> Any:
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8") or "null")
    except Exception:
        pass
    return default


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def _parse_dt(value: Any) -> datetime:
    raw = _safe_text(value)
    if not raw:
        raise ValueError("data/hora obrigatoria")
    raw = raw.replace("T", " ")
    if len(raw) == 16:
        raw += ":00"
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"):
        try:
            return datetime.strptime(raw, fmt)
        except ValueError:
            continue
    raise ValueError("formato de data invalido; use YYYY-MM-DD HH:MM:SS")


def _read_nvr_inventory() -> List[Dict[str, Any]]:
    rows: List[Dict[str, Any]] = []
    try:
        rows = legacy_rows_from_db("nvr")
    except Exception:
        rows = []
    if not rows:
        try:
            obj = _load_json(Path(NVR_INVENTORY_JSON_PATH), [])
            rows = obj if isinstance(obj, list) else []
        except Exception:
            rows = []
    try:
        rows = decorate_legacy_rows("nvr", rows)
    except Exception:
        pass
    return [r for r in rows if isinstance(r, dict)]


def list_nvr_targets() -> Dict[str, Any]:
    rows = _read_nvr_inventory()
    targets: List[Dict[str, Any]] = []
    seen: set[tuple[str, int, int]] = set()
    for r in rows:
        host = _safe_text(r.get("host") or r.get("ip"))
        ch = int(r.get("channel") or 0)
        port = int(r.get("http_port") or 80)
        if not host or ch <= 0:
            continue
        key = (host, port, ch)
        if key in seen:
            continue
        seen.add(key)
        targets.append(
            {
                "host": host,
                "http_port": port,
                "channel": ch,
                "title": _safe_text(r.get("title") or r.get("titulo") or f"Canal {ch:02d}"),
                "local": _safe_text(r.get("local") or r.get("site") or r.get("site_name")),
                "camera_ip": _safe_text(r.get("camera_ip")),
                "status": _safe_text(r.get("status")),
            }
        )
    targets.sort(key=lambda x: (_safe_text(x.get("host")), int(x.get("channel") or 0)))
    return {"ok": True, "targets": targets, "count": len(targets)}


def _build_rtsp_url(
    *,
    host: str,
    channel: int,
    user: str,
    password: str,
    start_dt: datetime,
    end_dt: datetime,
    vendor: str = "auto",
    template: str = "",
    rtsp_port: int = 554,
) -> str:
    u = quote(user, safe="")
    p = quote(password, safe="")
    h = _safe_text(host)
    ch = int(channel)
    if template:
        return (
            template.replace("{user}", u)
            .replace("{password}", p)
            .replace("{host}", h)
            .replace("{channel}", str(ch))
            .replace("{rtsp_port}", str(int(rtsp_port)))
            .replace("{start_dahua}", start_dt.strftime("%Y_%m_%d_%H_%M_%S"))
            .replace("{end_dahua}", end_dt.strftime("%Y_%m_%d_%H_%M_%S"))
            .replace("{start_hik}", start_dt.strftime("%Y%m%dT%H%M%SZ"))
            .replace("{end_hik}", end_dt.strftime("%Y%m%dT%H%M%SZ"))
        )

    vendor_norm = _safe_text(vendor).lower()
    if vendor_norm in ("hik", "hikvision"):
        track = f"{ch}01"
        return (
            f"rtsp://{u}:{p}@{h}:{int(rtsp_port)}/Streaming/tracks/{track}"
            f"?starttime={start_dt.strftime('%Y%m%dT%H%M%SZ')}"
            f"&endtime={end_dt.strftime('%Y%m%dT%H%M%SZ')}"
        )

    return (
        f"rtsp://{u}:{p}@{h}:{int(rtsp_port)}/cam/playback"
        f"?channel={ch}&subtype=0"
        f"&starttime={start_dt.strftime('%Y_%m_%d_%H_%M_%S')}"
        f"&endtime={end_dt.strftime('%Y_%m_%d_%H_%M_%S')}"
    )


def _color_tags_for_image(path: Path) -> tuple[List[str], Dict[str, float]]:
    tags: List[str] = []
    scores: Dict[str, float] = {}
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((240, 135))
            pixels = list(im.getdata())
    except Exception:
        return tags, scores
    total = max(1, len(pixels))
    red = blue = green = yellow = white = black = 0
    for r, g, b in pixels:
        if r > 120 and r > g * 1.35 and r > b * 1.35:
            red += 1
        if b > 120 and b > r * 1.25 and b > g * 1.15:
            blue += 1
        if g > 120 and g > r * 1.15 and g > b * 1.15:
            green += 1
        if r > 135 and g > 110 and b < 100:
            yellow += 1
        if r > 205 and g > 205 and b > 205:
            white += 1
        if r < 45 and g < 45 and b < 45:
            black += 1
    raw_scores = {
        "vermelho": red / total,
        "azul": blue / total,
        "verde": green / total,
        "amarelo": yellow / total,
        "branco": white / total,
        "preto": black / total,
    }
    for name, score in raw_scores.items():
        scores[name] = round(float(score), 4)
        if score >= 0.015:
            tags.append(name)
    return tags, scores


def _load_index() -> List[Dict[str, Any]]:
    obj = _load_json(NVR_AI_INDEX_PATH, [])
    return obj if isinstance(obj, list) else []


def _save_index(rows: List[Dict[str, Any]]) -> None:
    _write_json(NVR_AI_INDEX_PATH, rows)


def index_recording(req: Dict[str, Any]) -> Dict[str, Any]:
    host = _safe_text(req.get("host"))
    user = _safe_text(req.get("user") or "admin")
    password = _safe_text(req.get("password"))
    channel = int(req.get("channel") or 0)
    if not host:
        raise ValueError("host obrigatorio")
    if not password:
        raise ValueError("senha obrigatoria")
    if channel <= 0:
        raise ValueError("canal obrigatorio")

    start_dt = _parse_dt(req.get("start_time"))
    end_dt = _parse_dt(req.get("end_time"))
    if end_dt <= start_dt:
        raise ValueError("data final deve ser maior que a inicial")
    interval = max(1, min(300, int(req.get("interval_sec") or 10)))
    max_frames = max(1, min(500, int(req.get("max_frames") or 80)))
    vendor = _safe_text(req.get("vendor") or "auto")
    rtsp_port = int(req.get("rtsp_port") or 554)
    template = _safe_text(req.get("rtsp_template"))

    job_id = f"{int(time.time())}_{_safe_slug(host)}_ch{channel:02d}"
    out_dir = NVR_AI_FRAMES_DIR / job_id
    out_dir.mkdir(parents=True, exist_ok=True)
    out_pattern = str(out_dir / "frame_%05d.jpg")
    rtsp_url = _build_rtsp_url(
        host=host,
        channel=channel,
        user=user,
        password=password,
        start_dt=start_dt,
        end_dt=end_dt,
        vendor=vendor,
        template=template,
        rtsp_port=rtsp_port,
    )

    fps = f"fps=1/{interval}"
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-rtsp_transport",
        "tcp",
        "-i",
        rtsp_url,
        "-vf",
        fps,
        "-vframes",
        str(max_frames),
        "-q:v",
        "3",
        out_pattern,
    ]
    timeout_sec = max(60, min(3600, int(req.get("timeout_sec") or (max_frames * interval + 60))))
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec, check=False)
    files = sorted(out_dir.glob("frame_*.jpg"))
    if proc.returncode != 0 and not files:
        err = _safe_text(proc.stderr or proc.stdout)
        raise RuntimeError(f"ffmpeg nao retornou frames: {err[:600]}")

    existing = _load_index()
    created: List[Dict[str, Any]] = []
    local = _safe_text(req.get("local"))
    title = _safe_text(req.get("title") or f"CH {channel:02d}")
    for idx, path in enumerate(files, start=1):
        captured_at = start_dt + timedelta(seconds=(idx - 1) * interval)
        tags, scores = _color_tags_for_image(path)
        item_id = f"{job_id}_{idx:05d}"
        rel_url = f"/data/nvr_ai/frames/{job_id}/{path.name}"
        item = {
            "id": item_id,
            "job_id": job_id,
            "source": "nvr",
            "host": host,
            "channel": channel,
            "title": title,
            "local": local,
            "captured_at": captured_at.strftime("%Y-%m-%d %H:%M:%S"),
            "image_url": rel_url,
            "image_path": str(path),
            "tags": tags,
            "scores": scores,
            "notes": "analise inicial por cores; pronto para plugar IA visual",
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        }
        created.append(item)
    existing.extend(created)
    _save_index(existing)
    return {
        "ok": True,
        "job_id": job_id,
        "created": len(created),
        "total_indexed": len(existing),
        "stderr": _safe_text(proc.stderr)[:1200],
        "items": created[:20],
    }


def _query_terms(query: str) -> List[str]:
    q = _safe_text(query).lower()
    q = (
        q.replace("camisa", "")
        .replace("pessoa", "")
        .replace("de ", " ")
        .replace("com ", " ")
        .replace("roupa", "")
    )
    aliases = {
        "vermelha": "vermelho",
        "vermelhas": "vermelho",
        "red": "vermelho",
        "azuis": "azul",
        "blue": "azul",
        "verde": "verde",
        "green": "verde",
        "amarela": "amarelo",
        "yellow": "amarelo",
        "branca": "branco",
        "white": "branco",
        "preta": "preto",
        "black": "preto",
    }
    terms: List[str] = []
    for part in re.split(r"[^a-z0-9áéíóúãõç]+", q):
        if not part:
            continue
        terms.append(aliases.get(part, part))
    return terms


def search_events(query: str = "", host: str = "", channel: int = 0, limit: int = 80) -> Dict[str, Any]:
    rows = _load_index()
    terms = _query_terms(query)
    host_norm = _safe_text(host)
    ch = int(channel or 0)
    scored: List[Dict[str, Any]] = []
    for row in rows:
        if host_norm and _safe_text(row.get("host")) != host_norm:
            continue
        if ch > 0 and int(row.get("channel") or 0) != ch:
            continue
        hay = " ".join(
            [
                _safe_text(row.get("title")).lower(),
                _safe_text(row.get("local")).lower(),
                " ".join([_safe_text(t).lower() for t in row.get("tags") or []]),
                _safe_text(row.get("notes")).lower(),
            ]
        )
        score = 0.0
        for term in terms:
            if term and term in hay:
                score += 1.0
                try:
                    score += float((row.get("scores") or {}).get(term) or 0)
                except Exception:
                    pass
        if terms and score <= 0:
            continue
        rr = dict(row)
        rr["match_score"] = round(score, 4)
        scored.append(rr)
    scored.sort(key=lambda x: (float(x.get("match_score") or 0), _safe_text(x.get("captured_at"))), reverse=True)
    limit = max(1, min(500, int(limit or 80)))
    return {"ok": True, "query": query, "count": len(scored[:limit]), "results": scored[:limit]}


def stats() -> Dict[str, Any]:
    rows = _load_index()
    jobs = sorted({_safe_text(r.get("job_id")) for r in rows if _safe_text(r.get("job_id"))})
    return {"ok": True, "events": len(rows), "jobs": len(jobs), "index_path": str(NVR_AI_INDEX_PATH)}
