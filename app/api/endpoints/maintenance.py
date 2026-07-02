from __future__ import annotations

import json
import os
import subprocess
import sys
import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import quote, urlsplit, urlunsplit

import requests
from requests.auth import HTTPDigestAuth

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from app.api.endpoints.cameras import api_cameras_reboot, api_cameras_rename
from app.core.paths import BASE_DIR, INVENTORY_JSON_PATH, DVR_INVENTORY_JSON_PATH, NVR_INVENTORY_JSON_PATH, SAIDA_DIR, DATA_DIR
from app.core.tenant_context import get_current_tenant_slug, tenant_recorder_inventory_path
from app.services.inventory_json import load_inventory_json, save_inventory_json
from app.services.db_store import load_app_settings, save_app_settings, legacy_rows_from_db
from app.services.windows_inventory_service import load_windows_inventory

router = APIRouter(prefix="/api", tags=["maintenance"])


def _netwatch_slug(site: str) -> str:
    s = str(site or "").strip().lower()
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", s)
    s = "".join(ch for ch in s if not unicodedata.combining(ch))
    s = re.sub(r"[^a-z0-9]+", "_", s).strip("_")
    return s or "todos"


def _netwatch_output_name(site: str = "") -> str:
    slug = _netwatch_slug(site)
    return f"netwatch_setup_{slug}.rsc" if slug else "netwatch_setup.rsc"


def _netwatch_output_file(site: str = "") -> Path:
    fname = _netwatch_output_name(site)
    candidates = [
        BASE_DIR / "output" / fname,
        SAIDA_DIR / fname,
        DATA_DIR / fname,
    ]
    existing = [p for p in candidates if p.exists()]
    if existing:
        return sorted(existing, key=lambda p: p.stat().st_mtime, reverse=True)[0]
    return candidates[0]


def _netwatch_count_entries(script_content: str) -> int:
    return len(re.findall(r"(?m)^add\s+host=", str(script_content or "")))


def _as_str(v: Any) -> str:
    return str(v or "").strip()


def _normalize_zabbix_url(url: str) -> str:
    """Use the Docker-internal Zabbix route when users paste the macvlan IP."""
    raw = _as_str(url)
    if not raw:
        return ""
    try:
        parts = urlsplit(raw)
        host = (parts.hostname or "").strip().lower()
        if host in {"10.10.12.51", "zabbix-web"}:
            scheme = parts.scheme or "http"
            path = parts.path or "/api_jsonrpc.php"
            if not path.endswith("/api_jsonrpc.php"):
                path = "/api_jsonrpc.php"
            return urlunsplit((scheme, "zabbix-web:8080", path, "", ""))
    except Exception:
        pass
    return raw


def _settings_path() -> Path:
    return DATA_DIR / "settings.json"


def _load_settings() -> Dict[str, Any]:
    return load_app_settings()


def _save_settings(s: Dict[str, Any]) -> None:
    save_app_settings(s or {})


def _bool_ok(resp: requests.Response | None) -> bool:
    if resp is None:
        return False
    return resp.status_code in (200, 201, 202, 204)


def _request_with_auth(url: str, user: str, password: str, timeout: int = 8) -> tuple[bool, str]:
    last_err = ""
    for auth in (HTTPDigestAuth(user, password), (user, password)):
        try:
            r = requests.get(url, auth=auth, timeout=timeout, verify=False, headers={"Accept": "*/*"})
            if _bool_ok(r):
                return True, ""
            last_err = f"HTTP {r.status_code}"
        except Exception as e:
            last_err = str(e)
    return False, last_err or "falha de comunicacao"


def _persist_ip_change(old_ip: str, new_ip: str) -> None:
    old_ip = _as_str(old_ip)
    new_ip = _as_str(new_ip)
    if not old_ip or not new_ip or old_ip == new_ip:
        return

    rows = load_inventory_json() or []
    changed = False
    for r in rows:
        ip = _as_str(r.get("ip") or r.get("IP"))
        if ip == old_ip:
            if "ip" in r:
                r["ip"] = new_ip
            elif "IP" in r:
                r["IP"] = new_ip
            else:
                r["ip"] = new_ip
            changed = True
            break

    if changed:
        save_inventory_json(rows)


def _change_ip_one(
    ip: str,
    new_ip: str,
    mask: str,
    gateway: str,
    dns1: str,
    dns2: str,
    user: str,
    password: str,
) -> Dict[str, Any]:
    ip = _as_str(ip)
    new_ip = _as_str(new_ip)
    user = _as_str(user)
    password = _as_str(password)

    if not ip or not new_ip:
        return {"ok": False, "ip": ip, "new_ip": new_ip, "error": "ip e new_ip sao obrigatorios"}
    if not user or not password:
        return {"ok": False, "ip": ip, "new_ip": new_ip, "error": "user e pass sao obrigatorios"}

    params = [f"Network.eth0.IPAddress={quote(new_ip)}"]
    if _as_str(mask):
        params.append(f"Network.eth0.SubnetMask={quote(_as_str(mask))}")
    if _as_str(gateway):
        params.append(f"Network.eth0.DefaultGateway={quote(_as_str(gateway))}")
    if _as_str(dns1):
        params.append(f"Network.eth0.DnsServers[0]={quote(_as_str(dns1))}")
    if _as_str(dns2):
        params.append(f"Network.eth0.DnsServers[1]={quote(_as_str(dns2))}")

    q = "&".join(params)
    urls = [
        f"http://{ip}/cgi-bin/configManager.cgi?action=setConfig&{q}",
        f"https://{ip}/cgi-bin/configManager.cgi?action=setConfig&{q}",
    ]

    last_err = ""
    for url in urls:
        ok, err = _request_with_auth(url, user, password, timeout=8)
        if ok:
            _persist_ip_change(ip, new_ip)
            return {"ok": True, "ip": ip, "new_ip": new_ip, "url": url}
        last_err = err or "falha"

    return {"ok": False, "ip": ip, "new_ip": new_ip, "error": last_err or "falha ao trocar IP"}


def _set_ntp_one(ip: str, user: str, password: str, address: str, port: int, timezone: int, update_period: int) -> Dict[str, Any]:
    ip = _as_str(ip)
    user = _as_str(user)
    password = _as_str(password)
    address = _as_str(address)

    if not ip or not user or not password or not address:
        return {"ok": False, "ip": ip, "error": "ip/user/pass/address sao obrigatorios"}

    q = "&".join(
        [
            "NTP.Enable=true",
            f"NTP.Address={quote(address)}",
            f"NTP.Port={int(port)}",
            f"NTP.TimeZone={int(timezone)}",
            f"NTP.UpdatePeriod={int(update_period)}",
        ]
    )

    urls = [
        f"http://{ip}/cgi-bin/configManager.cgi?action=setConfig&{q}",
        f"https://{ip}/cgi-bin/configManager.cgi?action=setConfig&{q}",
    ]

    last_err = ""
    for url in urls:
        ok, err = _request_with_auth(url, user, password, timeout=8)
        if ok:
            return {"ok": True, "ip": ip, "url": url}
        last_err = err or "falha"

    return {"ok": False, "ip": ip, "error": last_err or "falha ao configurar NTP"}


def _set_datetime_one(ip: str, user: str, password: str, dt: str) -> Dict[str, Any]:
    ip = _as_str(ip)
    user = _as_str(user)
    password = _as_str(password)
    dt = _as_str(dt)
    if not ip or not user or not password or not dt:
        return {"ok": False, "ip": ip, "error": "ip/user/pass/datetime sao obrigatorios"}

    dt_norm = dt.replace("T", " ").strip()
    if len(dt_norm) == 16:
        dt_norm += ":00"
    q = "&".join(
        [
            "Time.SyncMode=0",
            f"Time.LocalTime={quote(dt_norm)}",
            f"Time.SystemTime={quote(dt_norm)}",
        ]
    )
    urls = [
        f"http://{ip}/cgi-bin/configManager.cgi?action=setConfig&{q}",
        f"https://{ip}/cgi-bin/configManager.cgi?action=setConfig&{q}",
    ]

    last_err = ""
    for url in urls:
        ok, err = _request_with_auth(url, user, password, timeout=8)
        if ok:
            return {"ok": True, "ip": ip, "url": url}
        last_err = err or "falha"
    return {"ok": False, "ip": ip, "error": last_err or "falha ao configurar data/hora"}


def _change_password_one(ip: str, user: str, old_pass: str, new_pass: str) -> Dict[str, Any]:
    ip = _as_str(ip)
    user = _as_str(user)
    old_pass = _as_str(old_pass)
    new_pass = _as_str(new_pass)

    if not ip or not user or not old_pass or not new_pass:
        return {"ok": False, "ip": ip, "error": "ip/user/old_pass/new_pass sao obrigatorios"}

    q = (
        "action=modifyPassword"
        f"&name={quote(user)}"
        f"&pwdOld={quote(old_pass)}"
        f"&pwdNew={quote(new_pass)}"
    )

    urls = [
        f"http://{ip}/cgi-bin/userManager.cgi?{q}",
        f"https://{ip}/cgi-bin/userManager.cgi?{q}",
    ]

    last_err = ""
    for url in urls:
        ok, err = _request_with_auth(url, user, old_pass, timeout=8)
        if ok:
            return {"ok": True, "ip": ip, "url": url}
        last_err = err or "falha"

    return {"ok": False, "ip": ip, "error": last_err or "falha ao trocar senha"}


def _run_script(script_path: Path, env: Dict[str, str], args: List[str] | None = None) -> tuple[bool, str, str, str]:
    args = args or []
    cmd = [sys.executable, str(script_path), *args]
    merged_env = os.environ.copy()
    merged_env.update(env)

    try:
        proc = subprocess.run(
            cmd,
            cwd=str(BASE_DIR),
            capture_output=True,
            text=True,
            check=False,
            env=merged_env,
        )
    except Exception as e:
        return False, "", "", str(e)

    ok = proc.returncode == 0
    err = "" if ok else (proc.stderr.strip() or proc.stdout.strip() or f"exit {proc.returncode}")
    return ok, proc.stdout or "", proc.stderr or "", err


def _load_rows_for_source(source: str, site: str = "") -> list[dict[str, Any]]:
    src = _as_str(source).lower()
    site_name = _as_str(site)
    if src == "windows":
        rows = load_windows_inventory()
        if site_name:
            s = site_name.strip().lower()
            rows = [
                r for r in rows
                if isinstance(r, dict)
                and (
                    _as_str(r.get("site")).lower() == s
                    or _as_str(r.get("site_name")).lower() == s
                    or _as_str(r.get("local")).lower() == s
                )
            ]
        return rows
    if src in ("dvr", "nvr"):
        db_rows = legacy_rows_from_db(src, site=site_name)
        if db_rows:
            return db_rows
        p = tenant_recorder_inventory_path(src) if get_current_tenant_slug() else Path(DVR_INVENTORY_JSON_PATH if src == "dvr" else NVR_INVENTORY_JSON_PATH)
        if not p.exists():
            return []
        try:
            data = json.loads(p.read_text(encoding="utf-8") or "[]")
            rows = data if isinstance(data, list) else []
            if site_name:
                s = site_name.strip().lower()
                rows = [
                    r for r in rows
                    if isinstance(r, dict)
                    and (
                        _as_str(r.get("site")).lower() == s
                        or _as_str(r.get("site_name")).lower() == s
                        or _as_str(r.get("local")).lower() == s
                    )
                ]
            return rows
        except Exception:
            return []
    return load_inventory_json(site=site_name) or []


def _build_zabbix_rows(source: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    src = _as_str(source).lower()
    if src == "windows":
        out: list[dict[str, Any]] = []
        for r in rows or []:
            if not isinstance(r, dict):
                continue
            ip = _as_str(r.get("ip") or r.get("primary_ipv4"))
            hostname = _as_str(r.get("hostname") or r.get("host") or r.get("nome"))
            if not ip or not hostname:
                continue
            os_info = r.get("os") if isinstance(r.get("os"), dict) else {}
            cpu_info = r.get("cpu") if isinstance(r.get("cpu"), dict) else {}
            remote_access = r.get("remote_access") if isinstance(r.get("remote_access"), dict) else {}
            anydesk = remote_access.get("anydesk") if isinstance(remote_access.get("anydesk"), dict) else {}
            site = _as_str(r.get("site"))
            sector = _as_str(r.get("sector") or r.get("setor"))
            local = " / ".join([x for x in (site, sector) if x])
            mac = _as_str(r.get("mac"))
            if not mac:
                network = r.get("network") if isinstance(r.get("network"), list) else []
                for n in network:
                    if isinstance(n, dict) and _as_str(n.get("mac")):
                        mac = _as_str(n.get("mac"))
                        break
            out.append(
                {
                    "source": "windows",
                    "ip": ip,
                    "host": hostname,
                    "hostname": hostname,
                    "title": hostname,
                    "titulo": hostname,
                    "nome": hostname,
                    "local": local,
                    "site": site,
                    "sector": sector,
                    "mac": mac,
                    "modelo": _as_str(r.get("model")),
                    "manufacturer": _as_str(r.get("manufacturer")),
                    "serial": _as_str(r.get("serial")),
                    "os_name": _as_str(os_info.get("name")),
                    "os_build": _as_str(os_info.get("build")),
                    "logged_user": _as_str(r.get("logged_user")),
                    "cpu": _as_str(cpu_info.get("name")),
                    "ram_gb": _as_str(r.get("ram_gb")),
                    "disk_summary": _as_str(r.get("disk_summary")),
                    "anydesk_id": _as_str(r.get("anydesk_id") or anydesk.get("id")),
                    "zabbix_agent_status": _as_str((r.get("zabbix_agent") or {}).get("service_status")) if isinstance(r.get("zabbix_agent"), dict) else "",
                    "host_key": f"WIN-{hostname}",
                }
            )
        return out
    if src not in ("dvr", "nvr"):
        return rows

    out: list[dict[str, Any]] = []
    for r in rows or []:
        if not isinstance(r, dict):
            continue
        host_ip = _as_str(r.get("host") or r.get("ip"))
        if not host_ip:
            continue
        ch = int(r.get("channel") or 0)
        http_port = int(r.get("http_port") or 80)
        ch_txt = f"{ch:02d}" if ch > 0 else "00"
        title = _as_str(r.get("title") or r.get("titulo")) or f"CH {ch_txt}"
        map_url = ""
        lat = _as_str(r.get("lat"))
        lon = _as_str(r.get("lon"))
        if lat and lon:
            map_url = f"https://www.google.com/maps?q={lat},{lon}"
        out.append(
            {
                # mk_zabbix_from_inventory já entende o fluxo por "dvr" (host por canal).
                # Para origem NVR, reaproveitamos a mesma modelagem de host por canal.
                "source": "dvr",
                "ip": host_ip,
                "channel": ch,
                "http_port": http_port,
                "title": f"CH {ch_txt} - {title}",
                "titulo": f"CH {ch_txt} - {title}",
                "local": _as_str(r.get("local")),
                "mac": _as_str(r.get("mac")),
                "modelo": _as_str(r.get("modelo")),
                "snapshot_url": _as_str(r.get("imgbb_url") or r.get("snapshot_url")),
                "host_key": f"DVR-{host_ip}-CH{ch_txt}",
                "map_url": map_url,
                "lat": lat,
                "lon": lon,
            }
        )
    return out


@router.post("/maintenance/batch/rename")
def maintenance_batch_rename(payload: Dict[str, Any]) -> Dict[str, Any]:
    user = _as_str(payload.get("user"))
    password = _as_str(payload.get("pass"))
    targets = payload.get("targets") or []

    if not isinstance(targets, list) or not targets:
        return {"ok": False, "error": "targets vazio"}

    results: List[Dict[str, Any]] = []
    for t in targets:
        if not isinstance(t, dict):
            continue

        ip = _as_str(t.get("ip"))
        title = _as_str(t.get("title"))
        if not ip or not title:
            results.append({"ok": False, "ip": ip, "title": title, "error": "ip/title obrigatorios"})
            continue

        r = api_cameras_rename(
            {
                "ip": ip,
                "title": title,
                "user": user,
                "pass": password,
                "port": t.get("port", 80),
                "channel": t.get("channel", 1),
            }
        )
        results.append({"ok": bool(r.get("ok")), "ip": ip, "title": title, "error": r.get("error")})

    ok_n = sum(1 for r in results if r.get("ok"))
    fail_n = len(results) - ok_n
    return {
        "ok": fail_n == 0,
        "message": f"Renomeacao concluida: {ok_n} ok, {fail_n} falhas.",
        "results": results,
    }


@router.post("/maintenance/batch/password")
def maintenance_batch_password(payload: Dict[str, Any]) -> Dict[str, Any]:
    user = _as_str(payload.get("user"))
    old_pass = _as_str(payload.get("old_pass"))
    new_pass = _as_str(payload.get("new_pass"))
    ips = payload.get("ips") or []

    if not user or not old_pass or not new_pass:
        return {"ok": False, "error": "user, old_pass e new_pass sao obrigatorios"}
    if not isinstance(ips, list) or not ips:
        return {"ok": False, "error": "ips vazio"}

    results = [_change_password_one(_as_str(ip), user, old_pass, new_pass) for ip in ips]
    ok_n = sum(1 for r in results if r.get("ok"))
    fail_n = len(results) - ok_n
    return {"ok": fail_n == 0, "message": f"Troca de senha: {ok_n} ok, {fail_n} falhas.", "results": results}


@router.post("/maintenance/change_ip")
def maintenance_change_ip(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _change_ip_one(
        ip=_as_str(payload.get("ip")),
        new_ip=_as_str(payload.get("new_ip")),
        mask=_as_str(payload.get("mask")),
        gateway=_as_str(payload.get("gateway")),
        dns1=_as_str(payload.get("dns1")),
        dns2=_as_str(payload.get("dns2")),
        user=_as_str(payload.get("user")),
        password=_as_str(payload.get("pass")),
    )


@router.post("/maintenance/batch/ip")
def maintenance_batch_ip(payload: Dict[str, Any]) -> Dict[str, Any]:
    user = _as_str(payload.get("user"))
    password = _as_str(payload.get("pass"))
    items = payload.get("items") or []

    if not user or not password:
        return {"ok": False, "error": "user e pass sao obrigatorios"}
    if not isinstance(items, list) or not items:
        return {"ok": False, "error": "items vazio"}

    results: List[Dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue

        results.append(
            _change_ip_one(
                ip=_as_str(it.get("ip")),
                new_ip=_as_str(it.get("new_ip")),
                mask=_as_str(it.get("mask")),
                gateway=_as_str(it.get("gateway")),
                dns1=_as_str(it.get("dns1")),
                dns2=_as_str(it.get("dns2")),
                user=user,
                password=password,
            )
        )

    ok_n = sum(1 for r in results if r.get("ok"))
    fail_n = len(results) - ok_n
    return {"ok": fail_n == 0, "message": f"Troca de IP: {ok_n} ok, {fail_n} falhas.", "results": results}


@router.post("/maintenance/batch/ntp")
def maintenance_batch_ntp(payload: Dict[str, Any]) -> Dict[str, Any]:
    user = _as_str(payload.get("user"))
    password = _as_str(payload.get("pass"))
    ips = payload.get("ips") or []
    address = _as_str(payload.get("address"))
    if not address:
        address = _as_str(payload.get("ntp_server"))
    datetime_value = _as_str(payload.get("datetime"))
    port = int(payload.get("port") or 123)
    timezone = int(payload.get("timezone") or 22)
    update_period = int(payload.get("update_period") or 60)

    if not user or not password:
        return {"ok": False, "error": "user e pass sao obrigatorios"}
    if not isinstance(ips, list) or not ips:
        return {"ok": False, "error": "ips vazio"}

    if datetime_value:
        results = [_set_datetime_one(_as_str(ip), user, password, datetime_value) for ip in ips]
        label = "Data/hora aplicada"
    else:
        if not address:
            return {"ok": False, "error": "address e obrigatorio"}
        results = [_set_ntp_one(_as_str(ip), user, password, address, port, timezone, update_period) for ip in ips]
        label = "NTP aplicado"
    ok_n = sum(1 for r in results if r.get("ok"))
    fail_n = len(results) - ok_n
    return {"ok": fail_n == 0, "message": f"{label}: {ok_n} ok, {fail_n} falhas.", "results": results}


@router.post("/maintenance/batch/reboot")
def maintenance_batch_reboot(payload: Dict[str, Any]) -> Dict[str, Any]:
    user = _as_str(payload.get("user"))
    password = _as_str(payload.get("pass"))
    ips = payload.get("ips") or []

    if not user or not password:
        return {"ok": False, "error": "user e pass sao obrigatorios"}
    if not isinstance(ips, list) or not ips:
        return {"ok": False, "error": "ips vazio"}

    results: List[Dict[str, Any]] = []
    for ip in ips:
        sip = _as_str(ip)
        r = api_cameras_reboot({"ip": sip, "user": user, "pass": password})
        results.append({"ok": bool(r.get("ok")), "ip": sip, "error": r.get("error"), "method": r.get("method")})

    ok_n = sum(1 for r in results if r.get("ok"))
    fail_n = len(results) - ok_n
    return {"ok": fail_n == 0, "message": f"Reboot em lote: {ok_n} ok, {fail_n} falhas.", "results": results}


@router.post("/scripts/netwatch")
def scripts_netwatch(payload: Dict[str, Any]) -> Dict[str, Any]:
    token = _as_str(payload.get("token"))
    chat = _as_str(payload.get("chat"))
    interval = _as_str(payload.get("interval")) or "1m"
    timeout = _as_str(payload.get("timeout")) or "2s"
    site = _as_str(payload.get("site"))

    if not token or not chat:
        return {"success": False, "error": "token e chat sao obrigatorios"}

    script = BASE_DIR / "tools" / "mk_netwatch_from_inventory.py"
    args = ["--token", token, "--chat", chat, "--interval", interval, "--timeout", timeout]
    if site:
        args.extend(["--site", site])
    tenant_slug = get_current_tenant_slug()
    if tenant_slug:
        args.extend(["--tenant", tenant_slug])
    ok, stdout, stderr, err = _run_script(script, env={}, args=args)

    out_file = _netwatch_output_file(site)
    script_content = ""
    try:
        if out_file.exists():
            script_content = out_file.read_text(encoding="utf-8")
    except Exception:
        script_content = ""
    cameras = _netwatch_count_entries(script_content)

    if not ok:
        return {"success": False, "error": err, "stdout": stdout, "stderr": stderr, "cameras": cameras}

    return {
        "success": True,
        "cameras": cameras,
        "site": site,
        "filename": out_file.name,
        "download_url": f"/api/scripts/netwatch/download?site={quote(site)}" if site else "/api/scripts/netwatch/download",
        "script": script_content,
        "stdout": stdout,
        "stderr": stderr,
    }


@router.get("/scripts/netwatch/download")
def scripts_netwatch_download(site: str = "") -> FileResponse:
    out_file = _netwatch_output_file(site)
    if not out_file.exists():
        raise HTTPException(status_code=404, detail="Gere o script Netwatch antes de baixar.")
    return FileResponse(
        path=out_file,
        media_type="text/plain",
        filename=out_file.name,
    )


@router.post("/scripts/zabbix")
def scripts_zabbix(payload: Dict[str, Any]) -> Dict[str, Any]:
    url = _normalize_zabbix_url(payload.get("url"))
    user = _as_str(payload.get("user"))
    password = _as_str(payload.get("pass"))
    group = _as_str(payload.get("group")) or "Cameras"
    template = _as_str(payload.get("template")) or "Template Module ICMP Ping"
    template_dvr = _as_str(payload.get("template_dvr")) or "Template Cam-Snapshot DVR Channel"
    dvr_user = _as_str(payload.get("dvr_user")) or "admin"
    dvr_pass = _as_str(payload.get("dvr_pass"))
    tg_auto = bool(payload.get("tg_auto", False))
    tg_token = _as_str(payload.get("tg_token"))
    tg_chat = _as_str(payload.get("tg_chat"))
    source = _as_str(payload.get("source") or "ip").lower()
    site = _as_str(payload.get("site"))

    if not url or not user or not password:
        return {"error": "url, user e pass sao obrigatorios"}
    if source in ("dvr", "nvr") and (not dvr_user or not dvr_pass):
        return {"error": "Para source=dvr/nvr informe dvr_user e dvr_pass"}

    script = BASE_DIR / "tools" / "mk_zabbix_from_inventory.py"
    inv_rows = _build_zabbix_rows(source, _load_rows_for_source(source, site=site))
    tmp_inv = SAIDA_DIR / "zabbix-source-inventory.json"
    try:
        tmp_inv.write_text(json.dumps(inv_rows, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception as e:
        return {"error": f"falha ao preparar inventario para Zabbix: {e}"}

    env = {
        "INV_PATH": str(tmp_inv),
        "ZBX_URL": url,
        "ZBX_USER": user,
        "ZBX_PASS": password,
        "ZBX_GROUP": group,
        "ZBX_TEMPLATE": template,
        "ZBX_TEMPLATE_DVR": template_dvr,
        "ZBX_DVR_USER": dvr_user,
        "ZBX_DVR_PASS": dvr_pass,
        "ZBX_TG_AUTO": "1" if tg_auto else "0",
        "ZBX_TG_TOKEN": tg_token,
        "ZBX_TG_CHAT": tg_chat,
    }

    ok, stdout, stderr, err = _run_script(script, env=env, args=[])
    if not ok:
        return {"error": err, "stdout": stdout, "stderr": stderr}

    # Persistimos a última configuração DVR para sincronismo automático de status
    # no fluxo de varredura DVR (scan/snapshot update).
    if source in ("dvr", "nvr"):
        try:
            s = _load_settings()
            s["zabbix_dvr_sync"] = {
                "enabled": True,
                "url": url,
                "user": user,
                "pass": password,
                "group": group,
                "template": template,
                "template_dvr": template_dvr,
                "dvr_user": dvr_user,
                "dvr_pass": dvr_pass,
            }
            _save_settings(s)
        except Exception:
            pass

    return {"ok": True, "source": source, "site": site, "rows_used": len(inv_rows), "stdout": stdout, "stderr": stderr}


@router.post("/scripts/grafana")
def scripts_grafana(payload: Dict[str, Any]) -> Dict[str, Any]:
    url = _as_str(payload.get("url"))
    api_key = _as_str(payload.get("api_key"))
    folder_uid = _as_str(payload.get("folder_uid"))
    overwrite = bool(payload.get("overwrite", True))

    if not url or not api_key:
        return {"error": "url e api_key sao obrigatorios"}

    script = BASE_DIR / "tools" / "mk_grafana_import_dashboard.py"
    env = {
        "GRAFANA_URL": url,
        "GRAFANA_API_KEY": api_key,
        "GRAFANA_FOLDER_UID": folder_uid,
        "GRAFANA_OVERWRITE": "1" if overwrite else "0",
    }

    ok, stdout, stderr, err = _run_script(script, env=env, args=[])
    if not ok:
        return {"error": err, "stdout": stdout, "stderr": stderr}

    return {"ok": True, "stdout": stdout, "stderr": stderr}
