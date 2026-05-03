from __future__ import annotations

import asyncio
import secrets
import requests
from requests.auth import HTTPDigestAuth
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
import threading
import time

from app.core.settings import get_settings
from app.services.live_mjpeg_service import (
    _split_ipv4_host_port,
    _detect_rtsp_port,
    _rtsp_probe,
    _candidate_rtsp_urls,
    _pick_working_rtsp_url,
    _ffmpeg_available,
    _mjpeg_from_ffmpeg,
)
from app.services.camsnapshot.config import SETTINGS

router = APIRouter(tags=["cameras"], prefix="/api")

_LIVE_HINT_TTL_SEC = 20 * 60
_LIVE_SESSION_TTL_SEC = 15 * 60
_live_hint_lock = threading.Lock()
_live_hint_cache: dict[str, dict[str, str | float]] = {}
_live_session_lock = threading.Lock()
_live_session_cache: dict[str, dict[str, str | int | float]] = {}


class LiveSessionRequest(BaseModel):
    ip: str
    user: str = ""
    password: str = Field("", alias="pass")
    channel: int = 1
    subtype: int = 0
    rtsp_port: int = 554
    vendor: str = ""
    model: str = ""

    model_config = ConfigDict(populate_by_name=True)


def _live_session_get(token: str) -> dict[str, str | int | float] | None:
    raw = str(token or "").strip()
    if not raw:
        return None
    now = time.time()
    with _live_session_lock:
        item = _live_session_cache.get(raw)
        if not item:
            return None
        expires_at = float(item.get("expires_at") or 0)
        if expires_at <= now:
            _live_session_cache.pop(raw, None)
            return None
        return dict(item)


def _live_session_create(req: LiveSessionRequest) -> tuple[str, dict[str, str | int | float]]:
    token = secrets.token_urlsafe(32)
    item: dict[str, str | int | float] = {
        "ip": str(req.ip or "").strip(),
        "user": str(req.user or "").strip(),
        "password": str(req.password or ""),
        "channel": int(req.channel or 1),
        "subtype": int(req.subtype or 0),
        "rtsp_port": int(req.rtsp_port or 554),
        "vendor": str(req.vendor or "").strip(),
        "model": str(req.model or "").strip(),
        "expires_at": time.time() + _LIVE_SESSION_TTL_SEC,
    }
    with _live_session_lock:
        _live_session_cache[token] = item
    return token, item


def _direct_live_allowed() -> bool:
    return get_settings().app_env != "production"


def _live_creds_from_query_or_session(
    live_token: str,
    ip: str,
    user: str,
    password: str,
    channel: int,
    subtype: int = 0,
    rtsp_port: int = 554,
    vendor: str = "",
    model: str = "",
) -> dict[str, str | int]:
    session = _live_session_get(live_token)
    if session:
        return {
            "ip": str(session.get("ip") or "").strip(),
            "user": str(session.get("user") or "").strip(),
            "password": str(session.get("password") or ""),
            "channel": int(session.get("channel") or channel or 1),
            "subtype": int(session.get("subtype") or subtype or 0),
            "rtsp_port": int(session.get("rtsp_port") or rtsp_port or 554),
            "vendor": str(session.get("vendor") or vendor or "").strip(),
            "model": str(session.get("model") or model or "").strip(),
        }
    if _direct_live_allowed():
        return {
            "ip": str(ip or "").strip(),
            "user": str(user or "").strip(),
            "password": str(password or ""),
            "channel": int(channel or 1),
            "subtype": int(subtype or 0),
            "rtsp_port": int(rtsp_port or 554),
            "vendor": str(vendor or "").strip(),
            "model": str(model or "").strip(),
        }
    raise HTTPException(status_code=401, detail="sessao live obrigatoria")


def _live_hint_key(ip: str, user: str, channel: int, subtype: int) -> str:
    return f"{ip}|{user}|{int(channel)}|{int(subtype)}"


def _live_hint_get(key: str) -> tuple[str, str] | None:
    now = time.time()
    with _live_hint_lock:
        item = _live_hint_cache.get(key)
        if not item:
            return None
        ts = float(item.get("ts") or 0)
        if (now - ts) > _LIVE_HINT_TTL_SEC:
            _live_hint_cache.pop(key, None)
            return None
        url = str(item.get("url") or "").strip()
        transport = str(item.get("transport") or "tcp").strip().lower() or "tcp"
        if not url:
            return None
        return url, transport


def _live_hint_set(key: str, url: str, transport: str) -> None:
    with _live_hint_lock:
        _live_hint_cache[key] = {
            "ts": time.time(),
            "url": str(url or ""),
            "transport": str(transport or "tcp"),
        }


def _live_stream_response(rtsp_url: str, subtype: int, transport: str) -> StreamingResponse:
    return StreamingResponse(
        _mjpeg_from_ffmpeg(rtsp_url, subtype=subtype, rtsp_transport=transport),
        media_type="multipart/x-mixed-replace; boundary=frame",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


def _fetch_snapshot_bytes(ip: str, user: str, password: str, channel: int = 1, timeout: float = 6.0) -> tuple[bytes | None, str]:
    urls = [
        f"http://{ip}/cgi-bin/snapshot.cgi?channel={int(channel)}",
        f"http://{ip}/cgi-bin/snapshot.cgi",
        f"http://{ip}/onvifsnapshot/media?channel={int(channel)}&subtype=0",
    ]
    last_err = ""
    for url in urls:
        for auth in (HTTPDigestAuth(user, password), (user, password)):
            try:
                r = requests.get(
                    url,
                    auth=auth,
                    timeout=(2.0, float(timeout)),
                    stream=True,
                    verify=False,
                    headers={"Accept": "*/*"},
                )
                if r.status_code == 200:
                    blob = r.content or b""
                    if blob:
                        return blob, ""
                    last_err = "snapshot vazio"
                else:
                    last_err = f"HTTP {r.status_code}"
            except Exception as e:
                last_err = str(e)
    return None, last_err or "falha ao capturar snapshot"


@router.post("/live/session")
def api_live_session(req: LiveSessionRequest) -> dict[str, object]:
    target = str(req.ip or "").strip()
    if not target:
        raise HTTPException(status_code=400, detail="missing ip")
    if not req.user or not req.password:
        raise HTTPException(status_code=400, detail="Credenciais obrigatorias para live.")
    if int(req.channel or 1) < 1 or int(req.channel or 1) > 32:
        raise HTTPException(status_code=400, detail="channel invalido")
    if int(req.subtype or 0) not in (0, 1):
        raise HTTPException(status_code=400, detail="subtype invalido")
    token, _ = _live_session_create(req)
    qs_common = f"live_token={token}&channel={int(req.channel or 1)}"
    return {
        "ok": True,
        "live_token": token,
        "expires_in": _LIVE_SESSION_TTL_SEC,
        "mjpeg_url": f"/api/live/mjpeg?{qs_common}",
        "jpeg_url": f"/api/live/jpeg?{qs_common}",
    }


@router.get("/live/jpeg")
def api_live_jpeg(
    ip: str = Query(""),
    user: str = Query(""),
    password: str = Query("", alias="pass"),
    channel: int = Query(1, ge=1, le=32),
    live_token: str = Query(""),
):
    live = _live_creds_from_query_or_session(live_token, ip, user, password, channel)
    target = str(live["ip"] or "").strip()
    user = str(live["user"] or "")
    password = str(live["password"] or "")
    channel = int(live["channel"] or channel)
    if not target:
        raise HTTPException(status_code=400, detail="missing ip")
    if not user or not password:
        raise HTTPException(status_code=400, detail="Credenciais obrigatorias para o snapshot live.")
    blob, err = _fetch_snapshot_bytes(target, user, password, channel=channel)
    if not blob:
        low_err = (err or "").lower()
        if "401" in low_err or "403" in low_err:
            raise HTTPException(status_code=401, detail="Credenciais invalidas para a camera.")
        raise HTTPException(status_code=502, detail=f"Nao consegui obter snapshot live de {target}. {err}".strip())
    return Response(
        content=blob,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@router.get("/live/mjpeg")
async def api_live_mjpeg(
    request: Request,
    ip: str = Query("", description="IP/host da camera"),
    user: str = Query("", description="Usuario"),
    password: str = Query("", alias="pass", description="Senha"),
    channel: int = Query(1, ge=1, le=32),
    subtype: int = Query(0, ge=0, le=1),
    rtsp_port: int = Query(554, ge=1, le=65535),
    vendor: str = Query(""),
    model: str = Query(""),
    live_token: str = Query(""),
):
    """Live dentro do navegador via MJPEG (RTSP -> ffmpeg -> MJPEG)."""
    if not _ffmpeg_available():
        raise HTTPException(
            status_code=503,
            detail="Conversor de video do servidor indisponivel (ffmpeg nao instalado no container).",
        )

    live = _live_creds_from_query_or_session(
        live_token, ip, user, password, channel, subtype=subtype, rtsp_port=rtsp_port, vendor=vendor, model=model
    )
    target = str(live["ip"] or "").strip()
    user = str(live["user"] or "")
    password = str(live["password"] or "")
    channel = int(live["channel"] or channel)
    subtype = int(live["subtype"] or subtype)
    rtsp_port = int(live["rtsp_port"] or rtsp_port)
    vendor = str(live["vendor"] or vendor or "")
    model = str(live["model"] or model or "")
    if not target:
        raise HTTPException(status_code=400, detail="missing ip")

    # Fallback: se o front não mandar user/pass, usa o último user/pass do SCAN.
    if (not user) or (not password):
        last = getattr(request.app.state, "last_scan_auth", None) or {}
        user = user or (last.get("user") or "")
        password = password or (last.get("pass") or "")
    if (not user) or (not password):
        user = user or str(SETTINGS.get("DEFAULT_USER") or "").strip()
        password = password or str(SETTINGS.get("DEFAULT_PASS") or "")

    host, http_port = _split_ipv4_host_port(target)

    chosen_rtsp_port = int(rtsp_port or 554)
    if http_port is not None and chosen_rtsp_port == http_port:
        chosen_rtsp_port = 554

    hint_key = _live_hint_key(target, user, channel, subtype)
    hinted = _live_hint_get(hint_key)
    if hinted:
        hinted_url, hinted_transport = hinted
        return _live_stream_response(hinted_url, subtype, hinted_transport)

    candidate_subtypes = [int(subtype)]
    alt_subtype = 0 if int(subtype) == 1 else 1
    if alt_subtype not in candidate_subtypes:
        candidate_subtypes.append(alt_subtype)

    candidates_to_try: list[str] = []
    for candidate_subtype in candidate_subtypes:
        candidates = _candidate_rtsp_urls(
            host=host,
            port=chosen_rtsp_port,
            user=user,
            password=password,
            channel=channel,
            subtype=candidate_subtype,
            vendor=vendor,
            model=model,
        )
        candidates_to_try.extend(candidates[:10] if len(candidates) > 10 else candidates)
    deduped_candidates: list[str] = []
    seen_candidates: set[str] = set()
    for item in candidates_to_try:
        if item and item not in seen_candidates:
            seen_candidates.add(item)
            deduped_candidates.append(item)
    if not deduped_candidates:
        raise HTTPException(status_code=400, detail=f"Nao consegui montar RTSP para {target}.")

    chosen_url, chosen_transport, err = await asyncio.to_thread(
        _pick_working_rtsp_url,
        deduped_candidates,
        3.0,
    )
    if not chosen_url:
        detail = f"Nao encontrei RTSP funcional para {target}."
        if err:
            detail = f"{detail} Ultimo erro: {err[:240]}"
        raise HTTPException(status_code=502, detail=detail)

    _live_hint_set(hint_key, chosen_url, chosen_transport)
    return _live_stream_response(chosen_url, subtype, chosen_transport)

