from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
import colorsys
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import quote

import requests
from PIL import Image
from requests.auth import HTTPDigestAuth

from app.core.paths import DATA_DIR, NVR_INVENTORY_JSON_PATH
from app.core.tenant_context import get_current_tenant_slug, tenant_recorder_inventory_path
from app.services.db_store import decorate_legacy_rows, legacy_rows_from_db

NVR_AI_DIR = DATA_DIR / "nvr_ai"
NVR_AI_FRAMES_DIR = NVR_AI_DIR / "frames"
NVR_AI_INDEX_PATH = NVR_AI_DIR / "index.json"
NVR_AI_YOLO_MODEL = os.getenv("NVR_AI_YOLO_MODEL", "yolov8n.pt")
NVR_AI_YOLO_CONF = float(os.getenv("NVR_AI_YOLO_CONF", "0.20"))
NVR_AI_ATTR_PROVIDER = os.getenv("NVR_AI_ATTR_PROVIDER", "auto").strip().lower()
NVR_AI_PAR_MODEL_PATH = os.getenv("NVR_AI_PAR_MODEL_PATH", str(NVR_AI_DIR / "models" / "person_attribute_model.pth"))
NVR_AI_PAR_THRESHOLD = float(os.getenv("NVR_AI_PAR_THRESHOLD", "0.50"))
NVR_AI_CLIP_MODEL = os.getenv("NVR_AI_CLIP_MODEL", "openai/clip-vit-base-patch32")
NVR_AI_CLIP_THRESHOLD = float(os.getenv("NVR_AI_CLIP_THRESHOLD", "0.50"))
NVR_AI_VISION_VERSION = "par_clip_yolo_parts_v1"

_YOLO_MODEL: Any = None
_YOLO_LOAD_ATTEMPTED = False
_CLIP_MODEL: Any = None
_CLIP_PROCESSOR: Any = None
_CLIP_LOAD_ATTEMPTED = False
_PAR_MODEL: Any = None
_PAR_LOAD_ATTEMPTED = False
_CLOTHING_COLORS = {
    "vermelho",
    "azul",
    "verde",
    "amarelo",
    "roxo",
    "rosa",
    "laranja",
    "marrom",
    "cinza",
    "bege",
    "branco",
    "preto",
}
_CLOTHING_PARTS = {
    "camisa": ("camisa", "camiseta", "blusa", "roupa", "uniforme", "jaleco", "colete"),
    "chapeu": ("chapeu", "chapéu", "bone", "boné", "capacete"),
    "calca": ("calca", "calça", "bermuda", "short", "shorts"),
}
_PAR_LABELS = [
    "Age-Young", "Age-Adult", "Age-Old", "Gender-Female",
    "Hair-Length-Short", "Hair-Length-Long", "Hair-Length-Bald",
    "UpperBody-Length-Short",
    "UpperBody-Color-Black", "UpperBody-Color-Blue", "UpperBody-Color-Brown",
    "UpperBody-Color-Green", "UpperBody-Color-Grey", "UpperBody-Color-Orange",
    "UpperBody-Color-Pink", "UpperBody-Color-Purple", "UpperBody-Color-Red",
    "UpperBody-Color-White", "UpperBody-Color-Yellow", "UpperBody-Color-Other",
    "LowerBody-Length-Short",
    "LowerBody-Color-Black", "LowerBody-Color-Blue", "LowerBody-Color-Brown",
    "LowerBody-Color-Green", "LowerBody-Color-Grey", "LowerBody-Color-Orange",
    "LowerBody-Color-Pink", "LowerBody-Color-Purple", "LowerBody-Color-Red",
    "LowerBody-Color-White", "LowerBody-Color-Yellow", "LowerBody-Color-Other",
    "LowerBody-Type-Trousers&Shorts", "LowerBody-Type-Skirt&Dress",
    "Accessory-Backpack", "Accessory-Bag", "Accessory-Glasses-Normal",
    "Accessory-Glasses-Sun", "Accessory-Hat",
]
_PAR_COLOR_MAP = {
    "Black": "preto",
    "Blue": "azul",
    "Brown": "marrom",
    "Green": "verde",
    "Grey": "cinza",
    "Orange": "laranja",
    "Pink": "rosa",
    "Purple": "roxo",
    "Red": "vermelho",
    "White": "branco",
    "Yellow": "amarelo",
}
_CLIP_COLOR_PROMPTS = {
    "camisa": {
        "vermelho": "a photo of a red shirt",
        "azul": "a photo of a blue shirt",
        "verde": "a photo of a green shirt",
        "amarelo": "a photo of a yellow shirt",
        "roxo": "a photo of a purple shirt",
        "rosa": "a photo of a pink shirt",
        "laranja": "a photo of an orange shirt",
        "marrom": "a photo of a brown shirt",
        "cinza": "a photo of a gray shirt",
        "bege": "a photo of a beige shirt",
        "branco": "a photo of a white shirt",
        "preto": "a photo of a black shirt",
    },
    "calca": {
        "vermelho": "a photo of red pants",
        "azul": "a photo of blue pants",
        "verde": "a photo of green pants",
        "amarelo": "a photo of yellow pants",
        "roxo": "a photo of purple pants",
        "rosa": "a photo of pink pants",
        "laranja": "a photo of orange pants",
        "marrom": "a photo of brown pants",
        "cinza": "a photo of gray pants",
        "bege": "a photo of beige pants",
        "branco": "a photo of white pants",
        "preto": "a photo of black pants",
    },
    "chapeu": {
        "vermelho": "a photo of a red hat",
        "azul": "a photo of a blue hat",
        "verde": "a photo of a green hat",
        "amarelo": "a photo of a yellow hat",
        "roxo": "a photo of a purple hat",
        "rosa": "a photo of a pink hat",
        "laranja": "a photo of an orange hat",
        "marrom": "a photo of a brown hat",
        "cinza": "a photo of a gray hat",
        "bege": "a photo of a beige hat",
        "branco": "a photo of a white hat",
        "preto": "a photo of a black hat",
    },
}


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
    if get_current_tenant_slug():
        tenant_path = tenant_recorder_inventory_path("nvr")
        obj = _load_json(tenant_path, [])
        if isinstance(obj, list):
            rows = [r for r in obj if isinstance(r, dict)]
        if rows:
            try:
                db_rows = decorate_legacy_rows("nvr", legacy_rows_from_db("nvr"))
            except Exception:
                db_rows = []
            site_by_channel: Dict[tuple[str, int, int], str] = {}
            for db_row in db_rows:
                host = _safe_text(db_row.get("host") or db_row.get("ip"))
                ch = int(db_row.get("channel") or 0)
                port = int(db_row.get("http_port") or 80)
                site = _safe_text(db_row.get("site") or db_row.get("site_name") or db_row.get("local"))
                if host and ch > 0 and site:
                    site_by_channel[(host, port, ch)] = site
            for row in rows:
                if _safe_text(row.get("site") or row.get("site_name") or row.get("local")):
                    continue
                host = _safe_text(row.get("host") or row.get("ip"))
                ch = int(row.get("channel") or 0)
                port = int(row.get("http_port") or 80)
                site = site_by_channel.get((host, port, ch), "")
                if site:
                    row["site"] = site
                    row["site_name"] = site
            return rows
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
        site = _safe_text(r.get("site") or r.get("site_name") or r.get("local"))
        local = _safe_text(r.get("local"))
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
                "site": site,
                "local": local or site,
                "modelo": _safe_text(r.get("modelo") or r.get("recorder_model") or r.get("camera_model")),
                "fabricante": _safe_text(r.get("fabricante") or r.get("recorder_vendor")),
                "camera_ip": _safe_text(r.get("camera_ip")),
                "status": _safe_text(r.get("status")),
            }
        )
    targets.sort(key=lambda x: (_safe_text(x.get("site")), _safe_text(x.get("host")), int(x.get("channel") or 0)))
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
    stream_mode: str = "sub",
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
    stream_norm = _safe_text(stream_mode).lower()
    use_substream = stream_norm not in ("main", "principal", "0")
    if vendor_norm in ("hik", "hikvision"):
        track = f"{ch}02" if use_substream else f"{ch}01"
        return (
            f"rtsp://{u}:{p}@{h}:{int(rtsp_port)}/Streaming/tracks/{track}"
            f"?starttime={start_dt.strftime('%Y%m%dT%H%M%SZ')}"
            f"&endtime={end_dt.strftime('%Y%m%dT%H%M%SZ')}"
        )

    # Intelbras/Dahua playback often exposes only the recorded main stream.
    # Substream can work for live view but return RTSP 404 for historical playback.
    playback_subtype = 0
    return (
        f"rtsp://{u}:{p}@{h}:{int(rtsp_port)}/cam/playback"
        f"?channel={ch}&subtype={playback_subtype}"
        f"&starttime={start_dt.strftime('%Y_%m_%d_%H_%M_%S')}"
        f"&endtime={end_dt.strftime('%Y_%m_%d_%H_%M_%S')}"
    )


def _parse_dahua_response(text: str) -> Dict[str, Any]:
    data: Dict[str, Any] = {}
    for raw_line in (text or "").splitlines():
        line = raw_line.strip()
        if not line or "=" not in line:
            continue
        key, value = line.split("=", 1)
        data[key.strip()] = value.strip()
    return data


def _segment_overlaps_window(segment: Dict[str, Any], start_dt: datetime, end_dt: datetime) -> bool:
    try:
        seg_start = _parse_dt(segment.get("start_time"))
        seg_end = _parse_dt(segment.get("end_time"))
    except Exception:
        return False
    return seg_start < end_dt and seg_end > start_dt


def _sample_times(start_dt: datetime, end_dt: datetime, interval: int, max_frames: int) -> List[datetime]:
    times: List[datetime] = []
    current = start_dt
    while current < end_dt and len(times) < max_frames:
        times.append(current)
        current += timedelta(seconds=interval)
    if not times:
        times.append(start_dt)
    return times


def _dahua_media_find_segments(
    *,
    host: str,
    http_port: int,
    user: str,
    password: str,
    channel: int,
    start_dt: datetime,
    end_dt: datetime,
) -> Dict[str, Any]:
    base_url = f"http://{host}:{int(http_port)}"
    auth = HTTPDigestAuth(user, password)
    session = requests.Session()
    timeout = (4, 12)
    token = ""
    try:
        create = session.get(
            f"{base_url}/cgi-bin/mediaFileFind.cgi",
            params={"action": "factory.create"},
            auth=auth,
            timeout=timeout,
        )
        if create.status_code in (401, 403):
            return {"ok": False, "segments": [], "warning": "NVR recusou usuario/senha na API de gravacoes."}
        create.raise_for_status()
        token = _parse_dahua_response(create.text).get("result", "")
        if not token:
            return {"ok": False, "segments": [], "warning": "NVR nao retornou token de busca de gravacoes."}

        # This CGI is picky: when spaces in date/time are encoded as "+",
        # some Intelbras/Dahua firmwares ignore the time and return midnight.
        # Build the query string manually so the space is always "%20".
        find_url = (
            f"{base_url}/cgi-bin/mediaFileFind.cgi"
            f"?action=findFile"
            f"&object={quote(token, safe='')}"
            f"&condition.Channel={int(channel)}"
            f"&condition.StartTime={quote(start_dt.strftime('%Y-%m-%d %H:%M:%S'), safe='')}"
            f"&condition.EndTime={quote(end_dt.strftime('%Y-%m-%d %H:%M:%S'), safe='')}"
            f"&condition.Types%5B0%5D=dav"
        )
        found = session.get(
            find_url,
            auth=auth,
            timeout=timeout,
        )
        if found.status_code in (400, 404):
            return {"ok": False, "segments": [], "warning": "NVR nao aceitou a consulta de gravacao para este canal/horario."}
        if found.status_code in (401, 403):
            return {"ok": False, "segments": [], "warning": "NVR recusou usuario/senha na consulta de gravacoes."}
        found.raise_for_status()

        next_file = session.get(
            f"{base_url}/cgi-bin/mediaFileFind.cgi",
            params={"action": "findNextFile", "object": token, "count": 100},
            auth=auth,
            timeout=timeout,
        )
        next_file.raise_for_status()
        parsed = _parse_dahua_response(next_file.text)
        segments_by_idx: Dict[int, Dict[str, Any]] = {}
        for key, value in parsed.items():
            m = re.match(r"items\[(\d+)\]\.([A-Za-z0-9_]+)$", key)
            if not m:
                continue
            idx = int(m.group(1))
            field = m.group(2)
            segments_by_idx.setdefault(idx, {})[field] = value
        segments: List[Dict[str, Any]] = []
        for idx in sorted(segments_by_idx):
            seg = segments_by_idx[idx]
            start = _safe_text(seg.get("StartTime"))
            end = _safe_text(seg.get("EndTime"))
            if not start or not end:
                continue
            segments.append(
                {
                    "channel": int(seg.get("Channel") or 0),
                    "start_time": start,
                    "end_time": end,
                    "stream": _safe_text(seg.get("VideoStream")),
                    "type": _safe_text(seg.get("Type")),
                    "length": int(seg.get("Length") or 0),
                    "file_path": _safe_text(seg.get("FilePath")),
                }
            )
        segments = [seg for seg in segments if _segment_overlaps_window(seg, start_dt, end_dt)]
        return {"ok": True, "segments": segments, "warning": ""}
    except requests.RequestException as e:
        return {"ok": False, "segments": [], "warning": f"API de gravacoes do NVR indisponivel: {_safe_text(e)[:180]}"}
    finally:
        if token:
            try:
                session.get(
                    f"{base_url}/cgi-bin/mediaFileFind.cgi",
                    params={"action": "destroy", "object": token},
                    auth=auth,
                    timeout=(3, 6),
                )
            except Exception:
                pass


def _color_tags_for_image(path: Path) -> tuple[List[str], Dict[str, float]]:
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((240, 135))
            return _color_tags_for_pil(im, threshold=0.015)
    except Exception:
        return [], {}


def _color_tags_for_pixels(pixels: List[tuple[int, int, int]], threshold: float = 0.015) -> tuple[List[str], Dict[str, float]]:
    tags: List[str] = []
    scores: Dict[str, float] = {}
    total = max(1, len(pixels))
    red = blue = green = yellow = white = black = 0
    purple = pink = orange = brown = gray = beige = 0
    hsv_red = hsv_blue = hsv_green = hsv_yellow = 0
    hsv_purple = hsv_pink = hsv_orange = hsv_brown = 0
    for r, g, b in pixels:
        h, s, v = colorsys.rgb_to_hsv(r / 255.0, g / 255.0, b / 255.0)
        if v < 0.16:
            black += 1
            continue
        if s < 0.18:
            if v < 0.38:
                black += 1
            elif v > 0.80:
                white += 1
            else:
                gray += 1
            continue
        if r > 120 and r > g * 1.35 and r > b * 1.35:
            red += 1
        if b > 120 and s > 0.34 and b > r * 1.35 and b > g * 1.22:
            blue += 1
        if g > 120 and g > r * 1.15 and g > b * 1.15:
            green += 1
        if r > 135 and g > 110 and b < 100:
            yellow += 1
        if r > 205 and g > 205 and b > 205:
            white += 1
        if r < 60 and g < 60 and b < 60:
            black += 1
        if abs(r - g) < 28 and abs(r - b) < 28 and 55 <= r <= 190:
            gray += 1
        if r > 145 and g > 105 and b > 75 and abs(r - g) < 70 and r >= b * 1.15:
            beige += 1
        if s > 0.32 and v > 0.20:
            if h <= 0.04 or h >= 0.94:
                hsv_red += 1
            elif 0.10 <= h <= 0.20:
                hsv_yellow += 1
            elif 0.04 < h < 0.10:
                hsv_orange += 1
            elif 0.22 <= h <= 0.48:
                hsv_green += 1
            elif 0.52 <= h <= 0.75 and s > 0.38 and v > 0.28:
                hsv_blue += 1
            elif 0.75 < h <= 0.86:
                hsv_purple += 1
            elif 0.86 < h < 0.94:
                hsv_pink += 1
            if 0.05 <= h <= 0.12 and 0.20 <= v <= 0.55:
                hsv_brown += 1
    raw_scores = {
        "vermelho": max(red, hsv_red) / total,
        "azul": max(blue, hsv_blue) / total,
        "verde": max(green, hsv_green) / total,
        "amarelo": max(yellow, hsv_yellow) / total,
        "roxo": max(purple, hsv_purple) / total,
        "rosa": max(pink, hsv_pink) / total,
        "laranja": max(orange, hsv_orange) / total,
        "marrom": max(brown, hsv_brown) / total,
        "cinza": gray / total,
        "bege": beige / total,
        "branco": white / total,
        "preto": black / total,
    }
    for name, score in raw_scores.items():
        scores[name] = round(float(score), 4)
        color_threshold = min(threshold, 0.006) if name == "verde" else threshold
        if score >= color_threshold:
            tags.append(name)
    return tags, scores


def _color_tags_for_pil(im: Image.Image, threshold: float = 0.015) -> tuple[List[str], Dict[str, float]]:
    return _color_tags_for_pixels(list(im.convert("RGB").getdata()), threshold=threshold)


def _motion_shirt_tags_for_image(path: Path, ref_path: Path | None) -> tuple[List[str], Dict[str, float]]:
    if not ref_path:
        return [], {}
    try:
        with Image.open(path) as current, Image.open(ref_path) as previous:
            cur = current.convert("RGB")
            prev = previous.convert("RGB")
            cur.thumbnail((480, 270))
            prev = prev.resize(cur.size)
            cur_pixels = list(cur.getdata())
            prev_pixels = list(prev.getdata())
    except Exception:
        return [], {}
    moving_pixels: List[tuple[int, int, int]] = []
    width, height = cur.size
    for idx, (r, g, b) in enumerate(cur_pixels):
        x = idx % width
        y = idx // width
        if y < int(height * 0.18):
            continue
        pr, pg, pb = prev_pixels[idx]
        diff = abs(r - pr) + abs(g - pg) + abs(b - pb)
        if diff >= 45:
            moving_pixels.append((r, g, b))
    if len(moving_pixels) < 80:
        return [], {}
    motion_tags, motion_scores = _color_tags_for_pixels(moving_pixels, threshold=0.018)
    tags = ["movimento"]
    scores = {f"movimento_{k}": v for k, v in motion_scores.items()}
    return tags, scores


def _load_yolo_model() -> Any:
    global _YOLO_MODEL, _YOLO_LOAD_ATTEMPTED
    if _YOLO_LOAD_ATTEMPTED:
        return _YOLO_MODEL
    _YOLO_LOAD_ATTEMPTED = True
    try:
        from ultralytics import YOLO  # type: ignore

        _YOLO_MODEL = YOLO(NVR_AI_YOLO_MODEL)
    except Exception:
        _YOLO_MODEL = None
    return _YOLO_MODEL


def _load_clip_model() -> tuple[Any, Any]:
    global _CLIP_MODEL, _CLIP_PROCESSOR, _CLIP_LOAD_ATTEMPTED
    if _CLIP_LOAD_ATTEMPTED:
        return _CLIP_MODEL, _CLIP_PROCESSOR
    _CLIP_LOAD_ATTEMPTED = True
    try:
        from transformers import CLIPModel, CLIPProcessor  # type: ignore

        _CLIP_MODEL = CLIPModel.from_pretrained(NVR_AI_CLIP_MODEL)
        _CLIP_PROCESSOR = CLIPProcessor.from_pretrained(NVR_AI_CLIP_MODEL)
        try:
            _CLIP_MODEL.eval()
        except Exception:
            pass
    except Exception:
        _CLIP_MODEL = None
        _CLIP_PROCESSOR = None
    return _CLIP_MODEL, _CLIP_PROCESSOR


def _load_par_model() -> Any:
    global _PAR_MODEL, _PAR_LOAD_ATTEMPTED
    if _PAR_LOAD_ATTEMPTED:
        return _PAR_MODEL
    _PAR_LOAD_ATTEMPTED = True
    path = Path(NVR_AI_PAR_MODEL_PATH)
    if not path.exists():
        _PAR_MODEL = None
        return None
    try:
        import torch  # type: ignore

        _PAR_MODEL = torch.load(str(path), map_location="cpu")
        try:
            _PAR_MODEL.eval()
        except Exception:
            pass
    except Exception:
        _PAR_MODEL = None
    return _PAR_MODEL


def _yolo_person_boxes(im: Image.Image) -> List[tuple[int, int, int, int, float]]:
    model = _load_yolo_model()
    if model is None:
        return []
    try:
        import numpy as np  # type: ignore

        arr = np.array(im.convert("RGB"))
        results = model.predict(arr, classes=[0], conf=NVR_AI_YOLO_CONF, imgsz=960, max_det=12, verbose=False, device="cpu")
    except Exception:
        return []
    boxes_out: List[tuple[int, int, int, int, float]] = []
    for result in results[:1]:
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            continue
        for box in boxes[:8]:
            try:
                x1, y1, x2, y2 = [int(v) for v in box.xyxy[0].tolist()]
                conf = float(box.conf[0])
            except Exception:
                continue
            if x2 - x1 < 12 or y2 - y1 < 24:
                continue
            boxes_out.append((x1, y1, x2, y2, conf))
    return boxes_out


def _candidate_person_part_crops(im: Image.Image) -> List[tuple[str, str, Image.Image, float, bool]]:
    width, height = im.size
    crops: List[tuple[str, str, Image.Image, float, bool]] = []

    for x1, y1, x2, y2, conf in _yolo_person_boxes(im):
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(width, x2)
        y2 = min(height, y2)
        w = x2 - x1
        h = y2 - y1
        if w <= 0 or h <= 0:
            continue
        touches_edge = x1 <= 3 or y1 <= 3 or x2 >= width - 3 or y2 >= height - 3
        full_body_like = h >= max(70, width * 0.20) and y2 < height - 6 and y1 > 3
        pad_x = int(w * 0.08)
        part_boxes = {
            "chapeu": (x1 + int(w * 0.18), y1, x2 - int(w * 0.18), y1 + int(h * 0.18)),
            "camisa": (x1 + int(w * 0.14), y1 + int(h * 0.23), x2 - int(w * 0.14), y1 + int(h * 0.48)),
            "calca": (x1 + int(w * 0.16), y1 + int(h * 0.64), x2 - int(w * 0.16), y1 + int(h * 0.94)),
        }
        for part, box in part_boxes.items():
            if part == "calca" and (touches_edge or not full_body_like):
                continue
            px1, py1, px2, py2 = box
            if px2 - px1 < 8 or py2 - py1 < 8:
                continue
            crops.append((part, "yolo", im.crop((max(0, px1), max(0, py1), min(width, px2), min(height, py2))), conf, touches_edge))
    if crops:
        return crops
    return []


def _candidate_person_crops_for_attributes(im: Image.Image) -> List[tuple[Image.Image, float, bool, bool]]:
    width, height = im.size
    crops: List[tuple[Image.Image, float, bool, bool]] = []
    for x1, y1, x2, y2, conf in _yolo_person_boxes(im):
        x1 = max(0, x1)
        y1 = max(0, y1)
        x2 = min(width, x2)
        y2 = min(height, y2)
        w = x2 - x1
        h = y2 - y1
        if w <= 0 or h <= 0:
            continue
        touches_edge = x1 <= 3 or y1 <= 3 or x2 >= width - 3 or y2 >= height - 3
        full_body_like = h >= max(70, width * 0.20) and y2 < height - 6 and y1 > 3
        pad_x = int(w * 0.06)
        crop = im.crop((max(0, x1 - pad_x), y1, min(width, x2 + pad_x), y2))
        crops.append((crop, conf, touches_edge, full_body_like))
    return crops


def _focused_part_crop(crop: Image.Image, part: str) -> Image.Image:
    width, height = crop.size
    if width < 12 or height < 12:
        return crop
    if part == "camisa":
        box = (int(width * 0.12), int(height * 0.05), int(width * 0.88), int(height * 0.82))
    elif part == "calca":
        box = (int(width * 0.16), int(height * 0.08), int(width * 0.84), int(height * 0.95))
    elif part == "chapeu":
        box = (int(width * 0.10), 0, int(width * 0.90), int(height * 0.92))
    else:
        return crop
    x1, y1, x2, y2 = box
    if x2 <= x1 or y2 <= y1:
        return crop
    return crop.crop(box)


def _clip_color_scores(crop: Image.Image, part: str) -> Dict[str, float]:
    if NVR_AI_ATTR_PROVIDER not in ("auto", "clip"):
        return {}
    model, processor = _load_clip_model()
    prompts = _CLIP_COLOR_PROMPTS.get(part) or {}
    if model is None or processor is None or not prompts:
        return {}
    colors = list(prompts.keys())
    texts = [prompts[color] for color in colors]
    try:
        import torch  # type: ignore

        inputs = processor(text=texts, images=crop.convert("RGB"), return_tensors="pt", padding=True)
        with torch.no_grad():
            outputs = model(**inputs)
            probs = outputs.logits_per_image.softmax(dim=1)[0].detach().cpu().tolist()
    except Exception:
        return {}
    return {color: round(float(prob), 4) for color, prob in zip(colors, probs)}


def _par_attribute_scores(person_crop: Image.Image, allow_lower_body: bool) -> Dict[str, Dict[str, float]]:
    if NVR_AI_ATTR_PROVIDER not in ("auto", "par"):
        return {}
    model = _load_par_model()
    if model is None:
        return {}
    try:
        import numpy as np  # type: ignore
        import torch  # type: ignore

        image = person_crop.convert("RGB").resize((224, 224))
        arr = np.asarray(image).astype("float32") / 255.0
        mean = np.asarray((0.485, 0.456, 0.406), dtype="float32")
        std = np.asarray((0.229, 0.224, 0.225), dtype="float32")
        arr = (arr - mean) / std
        tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0).float()
        with torch.no_grad():
            output = model(tensor)
            if isinstance(output, (list, tuple)):
                output = output[0]
            probs = torch.sigmoid(output).detach().cpu().numpy()[0].astype(float).tolist()
    except Exception:
        return {}

    scores: Dict[str, Dict[str, float]] = {"camisa": {}, "calca": {}, "chapeu": {}}
    for label, prob in zip(_PAR_LABELS, probs):
        if label.startswith("UpperBody-Color-"):
            color = _PAR_COLOR_MAP.get(label.replace("UpperBody-Color-", ""))
            if color:
                scores["camisa"][color] = round(float(prob), 4)
        elif allow_lower_body and label.startswith("LowerBody-Color-"):
            color = _PAR_COLOR_MAP.get(label.replace("LowerBody-Color-", ""))
            if color:
                scores["calca"][color] = round(float(prob), 4)
        elif label == "Accessory-Hat":
            scores["chapeu"]["presenca"] = round(float(prob), 4)
    return {part: part_scores for part, part_scores in scores.items() if part_scores}


def _person_shirt_tags_for_image(path: Path) -> tuple[List[str], Dict[str, float]]:
    tags: List[str] = []
    scores: Dict[str, float] = {}
    try:
        with Image.open(path) as im:
            im = im.convert("RGB")
            im.thumbnail((960, 540))
            part_crops = _candidate_person_part_crops(im)
            person_crops = _candidate_person_crops_for_attributes(im)
    except Exception:
        return tags, scores
    best: Dict[str, Dict[str, float]] = {}
    person_confidence = 0.0
    for person_crop, confidence, touches_edge, full_body_like in person_crops:
        if confidence < NVR_AI_YOLO_CONF:
            continue
        par_scores = _par_attribute_scores(person_crop, allow_lower_body=(full_body_like and not touches_edge))
        if not par_scores:
            continue
        person_confidence = max(person_confidence, confidence)
        for part, color_scores in par_scores.items():
            if part == "chapeu":
                continue
            scores[f"{part}_provider_par"] = 1.0
            part_best = best.setdefault(part, {})
            for color, score in color_scores.items():
                part_best[color] = max(part_best.get(color, 0.0), float(score or 0.0))
                scores[f"{part}_{color}"] = round(part_best[color], 4)
    for part, source, crop, confidence, touches_edge in part_crops:
        if source != "yolo" or confidence < NVR_AI_YOLO_CONF:
            continue
        if float(scores.get(f"{part}_provider_par") or 0) >= 1.0:
            continue
        if touches_edge and part in ("calca", "chapeu"):
            continue
        crop = _focused_part_crop(crop, part)
        crop.thumbnail((160, 220))
        crop_scores = _clip_color_scores(crop, part)
        if crop_scores:
            crop_tags = [max(crop_scores.items(), key=lambda item: float(item[1] or 0.0))[0]]
            scores[f"{part}_provider_clip"] = 1.0
        else:
            if NVR_AI_ATTR_PROVIDER == "clip":
                continue
            crop_tags, crop_scores = _color_tags_for_pil(crop, threshold=0.025)
            scores[f"{part}_provider_hsv"] = 1.0
        if crop_tags:
            person_confidence = max(person_confidence, confidence)
        for color, score in crop_scores.items():
            if color in _CLOTHING_COLORS:
                part_best = best.setdefault(part, {})
                part_best[color] = max(part_best.get(color, 0.0), float(score or 0.0))
                scores[f"{part}_{color}"] = round(part_best[color], 4)
    for part, color_scores in best.items():
        ranked = sorted(color_scores.items(), key=lambda item: float(item[1] or 0.0), reverse=True)
        if not ranked:
            continue
        color, score = ranked[0]
        runner_up = float(ranked[1][1] or 0.0) if len(ranked) > 1 else 0.0
        if float(scores.get(f"{part}_provider_par") or 0) >= 1.0:
            min_score = NVR_AI_PAR_THRESHOLD
            dominance_margin = 1.05
        elif float(scores.get(f"{part}_provider_clip") or 0) >= 1.0:
            min_score = NVR_AI_CLIP_THRESHOLD
            dominance_margin = 1.12
        else:
            min_score = 0.10
            if color in ("verde", "roxo"):
                min_score = 0.08
            if color in ("branco", "preto", "cinza"):
                min_score = 0.18
            dominance_margin = 1.45 if color in ("preto", "branco", "cinza") else 1.25
        if score < min_score:
            continue
        if runner_up and score < runner_up * dominance_margin:
            continue
        clothing_tag = f"{part}_{color}"
        if clothing_tag not in tags:
            tags.append(clothing_tag)
    if tags:
        tags.insert(0, "pessoa")
        scores["pessoa_conf"] = round(max(scores.get("pessoa_conf", 0.0), person_confidence), 4)
    return tags, scores


def _load_index() -> List[Dict[str, Any]]:
    obj = _load_json(NVR_AI_INDEX_PATH, [])
    return obj if isinstance(obj, list) else []


def _save_index(rows: List[Dict[str, Any]]) -> None:
    _write_json(NVR_AI_INDEX_PATH, rows)


def query_recording_segments(req: Dict[str, Any]) -> Dict[str, Any]:
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

    vendor = _safe_text(req.get("vendor") or "auto").lower()
    if vendor not in ("", "auto", "dahua", "intelbras", "intelbras/dahua", "dvr"):
        return {
            "ok": True,
            "record_segments": [],
            "nvr_api_warning": "Consulta rapida de gravacoes ainda esta implementada para Intelbras/Dahua.",
            "message": "Use a indexacao por RTSP para este padrao de equipamento.",
        }

    media_find = _dahua_media_find_segments(
        host=host,
        http_port=int(req.get("http_port") or 80),
        user=user,
        password=password,
        channel=channel,
        start_dt=start_dt,
        end_dt=end_dt,
    )
    segments = media_find.get("segments") if isinstance(media_find.get("segments"), list) else []
    warning = _safe_text(media_find.get("warning"))
    if segments:
        first = segments[0]
        last = segments[-1]
        message = (
            f"NVR retornou {len(segments)} trecho(s) gravado(s): "
            f"{first.get('start_time')} ate {last.get('end_time')}."
        )
    elif warning:
        message = "Nao foi possivel consultar o indice de gravacoes do NVR."
    else:
        message = "O NVR respondeu: nao existe gravacao nesse canal/horario."
    return {
        "ok": True,
        "record_segments": segments,
        "nvr_api_warning": warning,
        "message": message,
    }


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
    http_port = int(req.get("http_port") or 80)
    rtsp_port = int(req.get("rtsp_port") or 554)
    template = _safe_text(req.get("rtsp_template"))
    stream_mode = _safe_text(req.get("stream_mode") or "sub")
    vendor_norm = vendor.lower()
    visual_filter = _safe_text(req.get("visual_filter")).lower()

    record_segments: List[Dict[str, Any]] = []
    nvr_api_warning = ""
    if vendor_norm in ("", "auto", "dahua", "intelbras", "intelbras/dahua", "dvr"):
        recording_probe = query_recording_segments(req)
        record_segments = (
            recording_probe.get("record_segments")
            if isinstance(recording_probe.get("record_segments"), list)
            else []
        )
        nvr_api_warning = _safe_text(recording_probe.get("nvr_api_warning"))
        if not nvr_api_warning and not record_segments:
            existing = _load_index()
            return {
                "ok": True,
                "job_id": "",
                "created": 0,
                "total_indexed": len(existing),
                "record_segments": [],
                "nvr_api_warning": "",
                "message": "O NVR respondeu rapido: nao existe gravacao nesse canal/horario.",
                "items": [],
            }

    job_id = f"{int(time.time())}_{_safe_slug(host)}_ch{channel:02d}"
    out_dir = NVR_AI_FRAMES_DIR / job_id
    out_dir.mkdir(parents=True, exist_ok=True)
    duration_sec = max(1, int((end_dt - start_dt).total_seconds()))
    sample_times = _sample_times(start_dt, end_dt, interval, max_frames)
    requested_timeout = int(req.get("timeout_sec") or 0)
    per_sample_timeout = max(8, min(25, int(requested_timeout / max(1, len(sample_times))) if requested_timeout else 15))
    extracted: List[tuple[Path, datetime]] = []
    stderr_parts: List[str] = []
    for idx, sample_dt in enumerate(sample_times, start=1):
        sample_end = min(end_dt, sample_dt + timedelta(seconds=max(5, min(interval, 15))))
        if sample_end <= sample_dt:
            sample_end = sample_dt + timedelta(seconds=5)
        out_file = out_dir / f"frame_{idx:05d}.jpg"
        rtsp_url = _build_rtsp_url(
            host=host,
            channel=channel,
            user=user,
            password=password,
            start_dt=sample_dt,
            end_dt=sample_end,
            vendor=vendor,
            template=template,
            rtsp_port=rtsp_port,
            stream_mode=stream_mode,
        )
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-rtsp_transport",
            "tcp",
            "-analyzeduration",
            "1000000",
            "-probesize",
            "512000",
            "-i",
            rtsp_url,
            "-an",
            "-sn",
            "-dn",
            "-map",
            "0:v:0",
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2",
            "-q:v",
            "3",
            str(out_file),
        ]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=per_sample_timeout, check=False)
        except subprocess.TimeoutExpired as e:
            stderr_parts.append(f"{sample_dt.strftime('%H:%M:%S')}: timeout apos {per_sample_timeout}s")
            continue
        if proc.returncode == 0 and out_file.exists():
            extracted.append((out_file, sample_dt))
        else:
            err = _safe_text(proc.stderr or proc.stdout)
            if err:
                stderr_parts.append(f"{sample_dt.strftime('%H:%M:%S')}: {err[:180]}")
    if not extracted:
        err = "\n".join(stderr_parts)
        raise RuntimeError(f"ffmpeg nao retornou frames: {err[:600]}")

    existing = _load_index()
    created: List[Dict[str, Any]] = []
    skipped_by_filter = 0
    local = _safe_text(req.get("local"))
    title = _safe_text(req.get("title") or f"CH {channel:02d}")
    previous_path: Path | None = None
    for idx, (path, captured_at) in enumerate(extracted, start=1):
        _frame_tags, scores = _color_tags_for_image(path)
        tags: List[str] = []
        shirt_tags, shirt_scores = _person_shirt_tags_for_image(path)
        motion_tags, motion_scores = _motion_shirt_tags_for_image(path, previous_path)
        previous_path = path
        for tag in shirt_tags:
            if tag not in tags:
                tags.append(tag)
        for tag in motion_tags:
            if tag not in tags:
                tags.append(tag)
        scores.update(shirt_scores)
        scores.update(motion_scores)
        if visual_filter and visual_filter not in tags:
            skipped_by_filter += 1
            try:
                path.unlink()
            except Exception:
                pass
            continue
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
            "vision_version": NVR_AI_VISION_VERSION,
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
        "skipped_by_filter": skipped_by_filter,
        "visual_filter": visual_filter,
        "total_indexed": len(existing),
        "record_segments": record_segments[:100],
        "nvr_api_warning": nvr_api_warning,
        "sampling_strategy": "point_samples",
        "sample_count": len(sample_times),
        "stderr": "\n".join(stderr_parts)[:1200],
        "items": created[:20],
    }


def _query_terms(query: str) -> List[str]:
    raw_query = _safe_text(query).lower()
    wants_person = "pessoa" in raw_query
    aliases = {
        "pessoa": "pessoa",
        "vermelha": "vermelho",
        "vermelhas": "vermelho",
        "vermelhos": "vermelho",
        "red": "vermelho",
        "azuis": "azul",
        "blue": "azul",
        "verde": "verde",
        "green": "verde",
        "amarela": "amarelo",
        "amarelas": "amarelo",
        "amarelos": "amarelo",
        "yellow": "amarelo",
        "roxa": "roxo",
        "roxas": "roxo",
        "roxos": "roxo",
        "purple": "roxo",
        "violeta": "roxo",
        "rosa": "rosa",
        "pink": "rosa",
        "laranja": "laranja",
        "orange": "laranja",
        "marrom": "marrom",
        "brown": "marrom",
        "cinza": "cinza",
        "gray": "cinza",
        "grey": "cinza",
        "bege": "bege",
        "beige": "bege",
        "branca": "branco",
        "brancas": "branco",
        "brancos": "branco",
        "white": "branco",
        "preta": "preto",
        "pretas": "preto",
        "pretos": "preto",
        "black": "preto",
    }
    tokens: List[str] = []
    for part in re.split(r"[^a-z0-9áéíóúãõç]+", raw_query):
        if part:
            tokens.append(aliases.get(part, part))

    terms: List[str] = []
    used_positions: set[int] = set()
    for idx, token in enumerate(tokens):
        selected_part = ""
        for part_name, aliases_for_part in _CLOTHING_PARTS.items():
            if token in aliases_for_part:
                selected_part = part_name
                break
        if not selected_part:
            continue
        used_positions.add(idx)
        for near in range(idx + 1, min(len(tokens), idx + 4)):
            if tokens[near] in _CLOTHING_COLORS:
                terms.append(f"{selected_part}_{tokens[near]}")
                used_positions.add(near)
                break

    for idx, token in enumerate(tokens):
        if idx in used_positions:
            continue
        if token in {"de", "da", "do", "com", "e", "a", "o", "uma", "um"}:
            continue
        terms.append(token)
    if wants_person and "pessoa" not in terms:
        terms.append("pessoa")
    return terms


def _row_has_term(row: Dict[str, Any], term: str, hay: str) -> bool:
    scores = row.get("scores") or {}
    clothing_part = ""
    clothing_color = ""
    for part in _CLOTHING_PARTS:
        prefix = f"{part}_"
        if term.startswith(prefix):
            clothing_part = part
            clothing_color = term.replace(prefix, "", 1)
            break
    if clothing_part:
        if _safe_text(row.get("vision_version")) != NVR_AI_VISION_VERSION:
            return False
        tags = {_safe_text(t).lower() for t in row.get("tags") or []}
        if term not in tags:
            return False
        try:
            part_score = float(scores.get(term) or 0)
        except Exception:
            part_score = 0.0
        runner_up = 0.0
        for color in _CLOTHING_COLORS:
            if color == clothing_color:
                continue
            try:
                runner_up = max(runner_up, float(scores.get(f"{clothing_part}_{color}") or 0))
            except Exception:
                pass
        part_thresholds = {
            "verde": 0.08,
            "roxo": 0.08,
            "branco": 0.18,
            "preto": 0.18,
            "cinza": 0.18,
        }
        if float(scores.get(f"{clothing_part}_provider_par") or 0) >= 1.0:
            min_score = NVR_AI_PAR_THRESHOLD
            dominance_margin = 1.05
        elif float(scores.get(f"{clothing_part}_provider_clip") or 0) >= 1.0:
            min_score = NVR_AI_CLIP_THRESHOLD
            dominance_margin = 1.12
        else:
            min_score = part_thresholds.get(clothing_color, 0.10)
            dominance_margin = 1.45 if clothing_color in ("preto", "branco", "cinza") else 1.25
        if part_score < min_score:
            return False
        return not runner_up or part_score >= runner_up * dominance_margin
    try:
        score = float(scores.get(term) or 0)
    except Exception:
        score = 0.0
    if term in _CLOTHING_COLORS:
        if _safe_text(row.get("vision_version")) == NVR_AI_VISION_VERSION:
            tags = {_safe_text(t).lower() for t in row.get("tags") or []}
            return any(f"{part}_{term}" in tags for part in _CLOTHING_PARTS)
        return score >= 0.04
    if term in hay:
        return True
    return False


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
        required_terms = sorted({term for term in terms if term})
        if required_terms and any(not _row_has_term(row, term, hay) for term in required_terms):
            continue
        score = 0.0
        for term in terms:
            if term and _row_has_term(row, term, hay):
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


def clear_index() -> Dict[str, Any]:
    rows = _load_index()
    jobs = sorted({_safe_text(r.get("job_id")) for r in rows if _safe_text(r.get("job_id"))})
    removed_files = 0
    removed_jobs = 0
    for job_id in jobs:
        job_dir = NVR_AI_FRAMES_DIR / _safe_slug(job_id)
        if not job_dir.exists() or not job_dir.is_dir():
            continue
        try:
            removed_files += len([p for p in job_dir.rglob("*") if p.is_file()])
            shutil.rmtree(job_dir)
            removed_jobs += 1
        except Exception:
            pass
    _save_index([])
    return {
        "ok": True,
        "removed_events": len(rows),
        "removed_jobs": removed_jobs,
        "removed_files": removed_files,
    }


def stats() -> Dict[str, Any]:
    rows = _load_index()
    jobs = sorted({_safe_text(r.get("job_id")) for r in rows if _safe_text(r.get("job_id"))})
    return {"ok": True, "events": len(rows), "jobs": len(jobs), "index_path": str(NVR_AI_INDEX_PATH)}
