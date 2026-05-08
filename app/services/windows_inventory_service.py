from __future__ import annotations

import ipaddress
import json
import socket
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

from app.core.paths import DATA_DIR

WINDOWS_INVENTORY_PATH = DATA_DIR / "windows-inventory.json"


def _text(value: Any) -> str:
    return str(value or "").strip()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse_targets(raw: str, limit: int = 2048) -> List[str]:
    targets: list[str] = []
    seen: set[str] = set()
    chunks = (
        str(raw or "")
        .replace("\r", "\n")
        .replace(",", "\n")
        .replace(";", "\n")
        .split()
    )
    for chunk in chunks:
        item = chunk.strip()
        if not item:
            continue
        try:
            if "/" in item:
                net = ipaddress.ip_network(item, strict=False)
                if net.version != 4:
                    continue
                for ip in net.hosts():
                    value = str(ip)
                    if value not in seen:
                        seen.add(value)
                        targets.append(value)
                    if len(targets) >= limit:
                        return targets
                continue
            if "-" in item:
                left, right = item.split("-", 1)
                start = ipaddress.ip_address(left.strip())
                if "." in right:
                    end = ipaddress.ip_address(right.strip())
                else:
                    octets = left.strip().split(".")
                    octets[-1] = right.strip()
                    end = ipaddress.ip_address(".".join(octets))
                if start.version != 4 or end.version != 4:
                    continue
                a, b = int(start), int(end)
                if b < a:
                    a, b = b, a
                for value_int in range(a, b + 1):
                    value = str(ipaddress.ip_address(value_int))
                    if value not in seen:
                        seen.add(value)
                        targets.append(value)
                    if len(targets) >= limit:
                        return targets
                continue
            ip = ipaddress.ip_address(item)
            if ip.version == 4:
                value = str(ip)
                if value not in seen:
                    seen.add(value)
                    targets.append(value)
        except Exception:
            continue
        if len(targets) >= limit:
            return targets
    return targets


def _tcp_open(ip: str, port: int, timeout: float) -> bool:
    try:
        with socket.create_connection((ip, int(port)), timeout=max(0.2, float(timeout or 1.0))):
            return True
    except Exception:
        return False


def _hostname(ip: str) -> str:
    try:
        return socket.gethostbyaddr(ip)[0] or ""
    except Exception:
        return ""


def _powershell_inventory_script() -> str:
    return r"""
$ErrorActionPreference = "SilentlyContinue"
$cs = Get-CimInstance Win32_ComputerSystem
$bios = Get-CimInstance Win32_BIOS
$bb = Get-CimInstance Win32_BaseBoard
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$mem = Get-CimInstance Win32_PhysicalMemory
$disks = Get-CimInstance Win32_DiskDrive | ForEach-Object {
  [PSCustomObject]@{
    model = $_.Model
    serial = $_.SerialNumber
    interface_type = $_.InterfaceType
    media_type = $_.MediaType
    size_gb = if ($_.Size) { [math]::Round([double]$_.Size / 1GB, 2) } else { $null }
  }
}
$net = Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled = True" | ForEach-Object {
  [PSCustomObject]@{
    description = $_.Description
    mac = $_.MACAddress
    ip = @($_.IPAddress)
    gateway = @($_.DefaultIPGateway)
    dns = @($_.DNSServerSearchOrder)
  }
}
$payload = [PSCustomObject]@{
  hostname = $env:COMPUTERNAME
  domain = $cs.Domain
  manufacturer = $cs.Manufacturer
  model = $cs.Model
  logged_user = $cs.UserName
  total_ram_gb = if ($cs.TotalPhysicalMemory) { [math]::Round([double]$cs.TotalPhysicalMemory / 1GB, 2) } else { $null }
  memory_slots = @($mem).Count
  os_name = $os.Caption
  os_version = $os.Version
  os_build = $os.BuildNumber
  os_arch = $os.OSArchitecture
  install_date = $os.InstallDate
  last_boot = $os.LastBootUpTime
  cpu = $cpu.Name
  cpu_cores = $cpu.NumberOfCores
  cpu_threads = $cpu.NumberOfLogicalProcessors
  bios_serial = $bios.SerialNumber
  bios_version = $bios.SMBIOSBIOSVersion
  motherboard_manufacturer = $bb.Manufacturer
  motherboard_model = $bb.Product
  motherboard_serial = $bb.SerialNumber
  disks = @($disks)
  network = @($net)
}
$payload | ConvertTo-Json -Depth 6 -Compress
"""


def _load_winrm_module() -> Any:
    try:
        import winrm  # type: ignore

        return winrm
    except Exception:
        return None


def _collect_winrm(
    ip: str,
    username: str,
    password: str,
    *,
    domain: str = "",
    use_https: bool = False,
    timeout: float = 8.0,
) -> Dict[str, Any]:
    winrm = _load_winrm_module()
    if winrm is None:
        return {
            "ok": False,
            "status": "dependency_missing",
            "error": "Dependencia pywinrm nao instalada no ambiente da API.",
        }

    user = _text(username)
    if domain and "\\" not in user and "@" not in user:
        user = f"{_text(domain)}\\{user}"

    scheme = "https" if use_https else "http"
    port = 5986 if use_https else 5985
    endpoint = f"{scheme}://{ip}:{port}/wsman"
    try:
        session = winrm.Session(
            endpoint,
            auth=(user, password),
            transport="ntlm",
            server_cert_validation="ignore",
            read_timeout_sec=max(10, int(timeout) + 8),
            operation_timeout_sec=max(6, int(timeout)),
        )
        result = session.run_ps(_powershell_inventory_script())
    except Exception as exc:
        return {"ok": False, "status": "auth_or_connection_failed", "error": str(exc)[:500]}

    stdout = bytes(result.std_out or b"").decode("utf-8", errors="replace").strip()
    stderr = bytes(result.std_err or b"").decode("utf-8", errors="replace").strip()
    if int(result.status_code or 0) != 0:
        return {
            "ok": False,
            "status": "command_failed",
            "error": (stderr or stdout or f"PowerShell retornou codigo {result.status_code}")[:500],
        }
    try:
        data = json.loads(stdout)
    except Exception:
        return {"ok": False, "status": "invalid_json", "error": stdout[:500]}
    if not isinstance(data, dict):
        return {"ok": False, "status": "invalid_payload", "error": "Payload WinRM inesperado."}
    return {"ok": True, "status": "online", "data": data}


def _disk_kind(disks: List[Dict[str, Any]]) -> str:
    found_ssd = False
    found_hdd = False
    for disk in disks or []:
        raw = " ".join(
            _text(disk.get(key))
            for key in ("media_type", "model", "interface_type")
        ).lower()
        if "ssd" in raw or "nvme" in raw:
            found_ssd = True
        elif raw:
            found_hdd = True
    if found_ssd and found_hdd:
        return "mixed"
    if found_ssd:
        return "ssd"
    if found_hdd:
        return "hdd_or_unknown"
    return "unknown"


def _normalize_inventory(ip: str, payload: Dict[str, Any], status: str = "online", error: str = "") -> Dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    disks = data.get("disks") if isinstance(data.get("disks"), list) else []
    network = data.get("network") if isinstance(data.get("network"), list) else []
    mac = ""
    if network and isinstance(network[0], dict):
        mac = _text(network[0].get("mac"))
    disk_kind = _disk_kind([d for d in disks if isinstance(d, dict)])
    return {
        "ip": ip,
        "hostname": _text(data.get("hostname")) or _hostname(ip),
        "status": status,
        "error": error,
        "domain": _text(data.get("domain")),
        "logged_user": _text(data.get("logged_user")),
        "manufacturer": _text(data.get("manufacturer")),
        "model": _text(data.get("model")),
        "serial": _text(data.get("bios_serial")),
        "motherboard": {
            "manufacturer": _text(data.get("motherboard_manufacturer")),
            "model": _text(data.get("motherboard_model")),
            "serial": _text(data.get("motherboard_serial")),
        },
        "os": {
            "name": _text(data.get("os_name")),
            "version": _text(data.get("os_version")),
            "build": _text(data.get("os_build")),
            "arch": _text(data.get("os_arch")),
            "last_boot": _text(data.get("last_boot")),
        },
        "cpu": {
            "name": _text(data.get("cpu")),
            "cores": data.get("cpu_cores"),
            "threads": data.get("cpu_threads"),
        },
        "ram_gb": data.get("total_ram_gb"),
        "memory_slots": data.get("memory_slots"),
        "disk_kind": disk_kind,
        "has_ssd": disk_kind in ("ssd", "mixed"),
        "disks": disks,
        "network": network,
        "mac": mac,
        "last_seen": _now() if status == "online" else "",
        "updated_at": _now(),
    }


def load_windows_inventory() -> List[Dict[str, Any]]:
    try:
        if not WINDOWS_INVENTORY_PATH.exists():
            return []
        data = json.loads(WINDOWS_INVENTORY_PATH.read_text(encoding="utf-8"))
    except Exception:
        return []
    if isinstance(data, list):
        return [row for row in data if isinstance(row, dict)]
    if isinstance(data, dict) and isinstance(data.get("inventory"), list):
        return [row for row in data["inventory"] if isinstance(row, dict)]
    return []


def save_windows_inventory(rows: List[Dict[str, Any]]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = WINDOWS_INVENTORY_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(WINDOWS_INVENTORY_PATH)


def clear_windows_inventory() -> Dict[str, Any]:
    save_windows_inventory([])
    return {"ok": True, "cleared": True}


def build_windows_prepare_script(username: str = "sightops_inv") -> str:
    user = _text(username) or "sightops_inv"
    safe_user = "".join(ch for ch in user if ch.isalnum() or ch in ("_", "-", "."))
    if not safe_user:
        safe_user = "sightops_inv"
    return f"""# SightOps - Preparar Windows para inventario remoto
# Execute este arquivo como Administrador no computador Windows alvo.
# O script NAO contem senha gravada: ele pede a senha localmente.

$ErrorActionPreference = "Stop"
$UserName = "{safe_user}"

Write-Host "Preparando WinRM/WMI para inventario SightOps..." -ForegroundColor Cyan

$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {{
  if ($PSCommandPath) {{
    Write-Host "Solicitando permissao de Administrador..." -ForegroundColor Yellow
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @(
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", "`"$PSCommandPath`""
    )
    exit 0
  }}
  Write-Error "Execute este PowerShell como Administrador."
  exit 1
}}

$Password = Read-Host "Digite a senha que sera usada para o usuario local $UserName" -AsSecureString
if (-not $Password) {{
  Write-Error "Senha obrigatoria."
  exit 1
}}

$Existing = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
if ($Existing) {{
  Set-LocalUser -Name $UserName -Password $Password -PasswordNeverExpires $true
  Enable-LocalUser -Name $UserName
  Write-Host "Usuario $UserName atualizado." -ForegroundColor Green
}} else {{
  New-LocalUser -Name $UserName -Password $Password -FullName "SightOps Inventory" -Description "Usuario local para inventario remoto SightOps" -PasswordNeverExpires
  Write-Host "Usuario $UserName criado." -ForegroundColor Green
}}

function Add-UserToLocalGroupBySid($Sid, $Member) {{
  $Group = Get-LocalGroup | Where-Object {{ $_.SID.Value -eq $Sid }} | Select-Object -First 1
  if (-not $Group) {{
    Write-Host "Aviso: grupo local com SID $Sid nao encontrado." -ForegroundColor Yellow
    return
  }}
  try {{
    Add-LocalGroupMember -Group $Group.Name -Member $Member -ErrorAction Stop
    Write-Host "Usuario $Member adicionado ao grupo $($Group.Name)." -ForegroundColor Green
  }} catch {{
    if ($_.Exception.Message -match "ja.*membro|already.*member") {{
      Write-Host "Usuario $Member ja pertence ao grupo $($Group.Name)." -ForegroundColor DarkGray
    }} else {{
      Write-Host "Aviso: nao foi possivel adicionar $Member ao grupo $($Group.Name): $($_.Exception.Message)" -ForegroundColor Yellow
    }}
  }}
}}

Add-UserToLocalGroupBySid "S-1-5-32-544" $UserName
Add-UserToLocalGroupBySid "S-1-5-32-580" $UserName

try {{
  $PublicProfiles = Get-NetConnectionProfile -ErrorAction Stop | Where-Object {{ $_.NetworkCategory -eq "Public" }}
  if ($PublicProfiles) {{
    Write-Host "Rede publica detectada. Alterando perfil ativo para Privada para liberar WinRM com seguranca operacional." -ForegroundColor Yellow
    $PublicProfiles | Set-NetConnectionProfile -NetworkCategory Private -ErrorAction Stop
  }}
}} catch {{
  Write-Host "Aviso: nao foi possivel alterar o perfil de rede automaticamente: $($_.Exception.Message)" -ForegroundColor Yellow
}}

Set-Service -Name WinRM -StartupType Automatic
Start-Service -Name WinRM
Enable-PSRemoting -Force -SkipNetworkProfileCheck
winrm set winrm/config/service/auth '@{{Basic="false"; Kerberos="true"; Negotiate="true"}}' | Out-Null
winrm set winrm/config/service '@{{AllowUnencrypted="true"}}' | Out-Null

Get-NetFirewallRule -DisplayName "SightOps WinRM HTTP 5985" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction SilentlyContinue
New-NetFirewallRule -DisplayName "SightOps WinRM HTTP 5985" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5985 -Profile Any | Out-Null

$LocalAccountTokenFilterPolicy = "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System"
New-Item -Path $LocalAccountTokenFilterPolicy -Force | Out-Null
New-ItemProperty -Path $LocalAccountTokenFilterPolicy -Name LocalAccountTokenFilterPolicy -Value 1 -PropertyType DWord -Force | Out-Null

Write-Host ""
Write-Host "Validando WinRM local..." -ForegroundColor Cyan
Test-WSMan localhost | Out-Null
try {{
  $Credential = New-Object System.Management.Automation.PSCredential("$env:COMPUTERNAME\\$UserName", $Password)
  Invoke-Command -ComputerName 127.0.0.1 -Credential $Credential -Authentication Negotiate -ScriptBlock {{ hostname }} | Out-Null
  Write-Host "Validacao de login remoto OK." -ForegroundColor Green
}} catch {{
  Write-Host "Aviso: WinRM respondeu, mas o login remoto ainda falhou: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Confira a senha digitada e rode este preparador novamente como Administrador." -ForegroundColor Yellow
}}

Write-Host ""
Write-Host "Preparacao concluida." -ForegroundColor Green
Write-Host "No SightOps, use:" -ForegroundColor Cyan
Write-Host "  Usuario: .\\$UserName"
Write-Host "  Senha: a senha digitada neste script"
Write-Host "  Porta: WinRM HTTP 5985"
Write-Host ""
Write-Host "Teste local opcional:"
Write-Host "  Test-WSMan localhost"
"""


def _merge_rows(old_rows: List[Dict[str, Any]], new_rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    index: dict[str, Dict[str, Any]] = {}
    order: list[str] = []
    for row in old_rows or []:
        ip = _text(row.get("ip"))
        if not ip:
            continue
        if ip not in index:
            order.append(ip)
        index[ip] = dict(row)
    for row in new_rows or []:
        ip = _text(row.get("ip"))
        if not ip:
            continue
        if ip not in index:
            order.append(ip)
        merged = dict(index.get(ip) or {})
        merged.update(row)
        index[ip] = merged
    return [index[ip] for ip in order if ip in index]


def scan_windows_inventory(payload: Dict[str, Any]) -> Dict[str, Any]:
    targets = _parse_targets(_text(payload.get("targets") or payload.get("alvo")), limit=int(payload.get("limit") or 2048))
    username = _text(payload.get("username") or payload.get("usuario") or payload.get("user"))
    password = _text(payload.get("password") or payload.get("senha") or payload.get("pass"))
    domain = _text(payload.get("domain") or payload.get("dominio"))
    use_https = bool(payload.get("use_https") or False)
    timeout = max(1.0, min(float(payload.get("timeout_sec") or 8.0), 30.0))
    concurrency = max(1, min(int(payload.get("concurrency") or 32), 128))
    save = bool(payload.get("save", True))

    if not targets:
        raise ValueError("Informe ao menos um alvo Windows.")
    if not username or not password:
        raise ValueError("Usuario e senha sao obrigatorios para inventario Windows remoto.")

    port = 5986 if use_https else 5985
    rows: list[dict[str, Any]] = []

    def scan_one(ip: str) -> Dict[str, Any]:
        host = _hostname(ip)
        if not _tcp_open(ip, port, timeout=min(timeout, 3.0)):
            return {
                "ip": ip,
                "hostname": host,
                "status": "winrm_closed",
                "error": f"Porta WinRM {port} fechada ou sem resposta.",
                "updated_at": _now(),
            }
        collected = _collect_winrm(
            ip,
            username,
            password,
            domain=domain,
            use_https=use_https,
            timeout=timeout,
        )
        if not collected.get("ok"):
            return {
                "ip": ip,
                "hostname": host,
                "status": _text(collected.get("status")) or "error",
                "error": _text(collected.get("error")),
                "updated_at": _now(),
            }
        return _normalize_inventory(ip, collected.get("data") or {}, status="online")

    with ThreadPoolExecutor(max_workers=min(concurrency, max(1, len(targets)))) as executor:
        futures = [executor.submit(scan_one, ip) for ip in targets]
        for future in as_completed(futures):
            rows.append(future.result())

    rows.sort(key=lambda row: tuple(int(part) for part in str(row.get("ip") or "0.0.0.0").split(".") if part.isdigit()))
    if save:
        current = load_windows_inventory()
        merged = _merge_rows(current, rows)
        save_windows_inventory(merged)
    online = sum(1 for row in rows if row.get("status") == "online")
    return {
        "ok": True,
        "scanned": len(targets),
        "online": online,
        "failed": max(0, len(rows) - online),
        "saved": save,
        "inventory_path": str(WINDOWS_INVENTORY_PATH),
        "rows": rows,
    }
