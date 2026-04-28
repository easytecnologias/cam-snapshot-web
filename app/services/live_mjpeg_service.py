from __future__ import annotations

from typing import Iterable, List, Optional, Tuple
import asyncio
import os
import re
import shutil
import subprocess
import time
import urllib.parse


def _ffmpeg_path() -> str:
    """Return ffmpeg executable path. Uses env FFMPEG_PATH if set, else PATH lookup."""
    p = (os.getenv("FFMPEG_PATH") or "").strip().strip('"')
    if p:
        return p
    found = shutil.which("ffmpeg")
    return found or "ffmpeg"


def _ffmpeg_available() -> bool:
    p = _ffmpeg_path()
    if os.path.isabs(p) or os.sep in p:
        return os.path.exists(p)
    return shutil.which(p) is not None


def _build_rtsp_url(*, host: str, user: str, password: str, port: int, channel: int, subtype: int) -> str:
    u = urllib.parse.quote(user or "", safe="")
    p = urllib.parse.quote(password or "", safe="")
    auth = ""
    if u or p:
        auth = f"{u}:{p}@"
    # caminho "genÃ©rico" (muitas marcas aceitam variaÃ§Ãµes; a escolha final vem de candidates)
    return f"rtsp://{auth}{host}:{int(port)}/cam/realmonitor?channel={int(channel)}&subtype={int(subtype)}"


def _candidate_rtsp_urls(
    *,
    host: str,
    port: int,
    user: str,
    password: str,
    channel: int,
    subtype: int,
    vendor: str = "",
    model: str = "",
) -> List[str]:
    u = urllib.parse.quote(user or "", safe="")
    p = urllib.parse.quote(password or "", safe="")
    auth = ""
    if u or p:
        auth = f"{u}:{p}@"

    c = int(channel)
    st = int(subtype)
    pp = int(port)

    vendor_l = str(vendor or "").strip().lower()
    model_l = str(model or "").strip().lower()

    base_candidates = [
        f"rtsp://{auth}{host}:{pp}/cam/realmonitor?channel={c}&subtype={st}",   # Dahua/Intelbras
        f"rtsp://{auth}{host}:{pp}/Streaming/Channels/{c}0{st+1}",               # Hikvision (101/102)
        f"rtsp://{auth}{host}:{pp}/Streaming/Channels/{c}{st+1}",                # variacao
        f"rtsp://{auth}{host}:{pp}/media/video{1 if st == 0 else 2}",            # UNV/Uniview
        f"rtsp://{auth}{host}:{pp}/media/video1",                                 # UNV main
        f"rtsp://{auth}{host}:{pp}/media/video2",                                 # UNV sub
        f"rtsp://{auth}{host}:{pp}/unicast/c{c}/s{st+1}/live",                    # UNV alternate
        f"rtsp://{auth}{host}:{pp}/h264/ch{c}/main/av_stream",                    # alguns OEMs
        f"rtsp://{auth}{host}:{pp}/user={u}&password={p}&channel={c}&stream={st}.sdp?",  # alguns OEMs
        f"rtsp://{auth}{host}:{pp}/live/ch{c}",                                   # generico
        f"rtsp://{auth}{host}:{pp}/live",                                         # generico
        f"rtsp://{auth}{host}:{pp}/h264",                                         # generico
        f"rtsp://{auth}{host}:{pp}/",                                             # ultimo recurso
    ]

    if ("dahua" in vendor_l) or ("intelbras" in vendor_l) or model_l.startswith("vip-"):
        preferred = [base_candidates[0], base_candidates[7], base_candidates[8], base_candidates[9]]
    elif ("hik" in vendor_l) or ("hilook" in vendor_l):
        preferred = [base_candidates[1], base_candidates[2], base_candidates[9], base_candidates[0]]
    elif ("unv" in vendor_l) or ("uniview" in vendor_l):
        preferred = [base_candidates[3], base_candidates[4], base_candidates[5], base_candidates[6]]
    else:
        preferred = base_candidates

    out: List[str] = []
    seen: set[str] = set()
    for url in preferred + base_candidates:
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _split_ipv4_host_port(target: str) -> Tuple[str, Optional[int]]:
    t = (target or "").strip()
    if ":" in t and t.count(":") == 1:
        h, p = t.split(":", 1)
        if p.isdigit():
            return h, int(p)
    return t, None


async def _rtsp_probe(host: str, port: int) -> bool:
    # probe rÃ¡pido com ffprobe/ffmpeg (legado fazia com ffmpeg -t)
    cmd = [_ffmpeg_path(), "-hide_banner", "-loglevel", "error", "-rtsp_transport", "tcp",
           "-i", f"rtsp://{host}:{int(port)}/", "-t", "1", "-f", "null", "-"]
    try:
        proc = await asyncio.create_subprocess_exec(*cmd, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE)
        try:
            await asyncio.wait_for(proc.communicate(), timeout=2.5)
        except asyncio.TimeoutError:
            proc.kill()
            return True  # consider "alive" se demorou
        return proc.returncode == 0
    except Exception:
        return False


async def _detect_rtsp_port(host: str, primary_port: int = 554) -> Optional[int]:
    # tenta portas comuns
    ports = [primary_port, 554, 8554, 10554, 7070]
    seen = set()
    for p in ports:
        if p in seen:
            continue
        seen.add(p)
        if await _rtsp_probe(host, p):
            return p
    return None


def _pick_working_rtsp_url(candidates: List[str], timeout_sec: float = 6.0) -> Tuple[Optional[str], str, str]:
    """Testa URLs com ffmpeg para escolher uma que abra e o transporte (tcp/udp)."""
    last_err = ""
    for transport in ("tcp", "udp"):
        for url in candidates:
            cmd = [
                _ffmpeg_path(),
                "-hide_banner",
                "-loglevel", "error",
                "-rtsp_transport", transport,
                "-i", url,
                "-t", "1",
                "-f", "null",
                "-"
            ]
            try:
                proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout_sec)
                if proc.returncode == 0:
                    return url, transport, ""
                last_err = (proc.stderr or proc.stdout or "").strip()
            except subprocess.TimeoutExpired:
                # Timeout aqui costuma virar live "presa" sem primeiro frame.
                # Registramos o erro e seguimos tentando outras rotas/transportes.
                last_err = f"probe timeout em {transport}: {url}"
            except Exception as e:
                last_err = str(e)
    # Em falha explícita de autenticação, não forçamos fallback para evitar
    # deixar o endpoint MJPEG pendurado sem entregar nenhum frame.
    low_err = (last_err or "").lower()
    auth_markers = (
        "401",
        "403",
        "unauthorized",
        "authorization failed",
        "forbidden",
        "access denied",
        "invalid credentials",
        "user name or password",
    )
    if any(marker in low_err for marker in auth_markers):
        return None, "tcp", last_err

    return None, "tcp", last_err


def _mjpeg_from_ffmpeg(rtsp_url: str | List[str], subtype: int = 0, rtsp_transport: str = "tcp") -> Iterable[bytes]:
    """Generator: RTSP -> MJPEG multipart stream.

    Sends complete JPEG frames (SOI..EOI) to avoid corrupted frame boundaries.
    """
    # Perfis de qualidade do transcode para browser:
    # - subtype=0 (HD): prioriza nitidez (1280px, mais fps, JPEG com menos compresso)
    # - subtype=1 (SD): mais leve para links/laptops mais fracos
    is_hd = int(subtype or 0) == 0
    vf = "fps=18,scale=1280:-2" if is_hd else "fps=15,scale=960:-2"
    qv = "3" if is_hd else "5"  # menor = melhor qualidade no MJPEG

    preferred_transport = "udp" if str(rtsp_transport or "").lower() == "udp" else "tcp"
    transports = [preferred_transport] if preferred_transport == "udp" else ["tcp", "udp"]
    boundary = b"--frame\r\n"
    header = b"Content-Type: image/jpeg\r\n\r\n"
    soi = b"\xff\xd8"
    eoi = b"\xff\xd9"

    urls_to_try = list(rtsp_url) if isinstance(rtsp_url, list) else [rtsp_url]
    expanded_urls: List[str] = []
    seen_urls: set[str] = set()
    for url in urls_to_try:
        if not url:
            continue
        if url not in seen_urls:
            seen_urls.add(url)
            expanded_urls.append(url)
        # Alguns domes Intelbras/H.265 ficam "pretos" no stream principal.
        # Se nao sair frame em subtype=0, tenta automaticamente subtype=1.
        if "subtype=0" in url:
            alt = url.replace("subtype=0", "subtype=1")
            if alt not in seen_urls:
                seen_urls.add(alt)
                expanded_urls.append(alt)

    for transport in transports:
        for url_try in expanded_urls:
            cmd = [
                _ffmpeg_path(),
                "-hide_banner",
                "-loglevel", "error",
                "-fflags", "nobuffer",
                "-flags", "low_delay",
                "-probesize", "32768",
                "-analyzeduration", "1000000",
                "-rtsp_transport", transport,
                "-rw_timeout", "3000000",
                "-stimeout", "3000000",
                "-i", url_try,
                "-an",
                "-vf", vf + ",format=yuv420p",
                "-q:v", qv,
                "-f", "image2pipe",
                "-vcodec", "mjpeg",
                "pipe:1",
            ]

            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0)
            buf = bytearray()
            yielded_any = False
            read_cycles = 0
            max_warmup_cycles = 220  # limita tentativas lentas e libera fallback mais cedo
            try:
                while True:
                    chunk = proc.stdout.read(4096) if proc.stdout else b""
                    if not chunk:
                        break
                    read_cycles += 1
                    buf.extend(chunk)

                    while True:
                        s = buf.find(soi)
                        if s < 0:
                            if len(buf) > 2_000_000:
                                del buf[:-2]
                            break

                        e = buf.find(eoi, s + 2)
                        if e < 0:
                            if s > 0:
                                del buf[:s]
                            break

                        frame = bytes(buf[s:e + 2])
                        del buf[:e + 2]
                        yielded_any = True
                        yield boundary + header + frame + b"\r\n"

                    # Se esse profile/URL nao gera frame por tempo suficiente, tenta fallback.
                    if (not yielded_any) and (read_cycles >= max_warmup_cycles):
                        break
            finally:
                try:
                    proc.kill()
                except Exception:
                    pass

            if yielded_any:
                return
