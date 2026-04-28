from __future__ import annotations

import asyncio
import requests
from requests.auth import HTTPDigestAuth
from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response, StreamingResponse
import threading
import time

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
_live_hint_lock = threading.Lock()
_live_hint_cache: dict[str, dict[str, str | float]] = {}


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


@router.get("/live/jpeg")
def api_live_jpeg(
    ip: str = Query(...),
    user: str = Query(""),
    password: str = Query("", alias="pass"),
    channel: int = Query(1, ge=1, le=32),
):
    target = (ip or "").strip()
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
    ip: str = Query(..., description="IP/host da câmera"),
    user: str = Query("", description="Usuário"),
    password: str = Query("", alias="pass", description="Senha"),
    channel: int = Query(1, ge=1, le=32),
    subtype: int = Query(0, ge=0, le=1),
    rtsp_port: int = Query(554, ge=1, le=65535),
    vendor: str = Query(""),
    model: str = Query(""),
):
    """Live dentro do navegador via MJPEG (RTSP -> ffmpeg -> MJPEG)."""
    if not _ffmpeg_available():
        raise HTTPException(
            status_code=503,
            detail="Conversor de video do servidor indisponivel (ffmpeg nao instalado no container).",
        )

    target = (ip or "").strip()
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

