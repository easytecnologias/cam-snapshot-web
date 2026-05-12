import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { urbackupClient } from './urbackupClient.js';

export const urbackupRouter = Router();

const windowsClientUrl = process.env.URBACKUP_WINDOWS_CLIENT_URL
  || 'https://hndl.urbackup.org/Client/2.5.30/UrBackup%20Client%202.5.30.exe';

function clientsFromStatus(payload: Record<string, unknown>) {
  const raw = payload.status;
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const clients = payload.clients;
  if (Array.isArray(clients)) return clients as Array<Record<string, unknown>>;
  return [];
}

function discoveryHintsFromStatus(payload: Record<string, unknown>) {
  const extraClients = payload.extra_clients;
  return Array.isArray(extraClients) ? extraClients as Array<Record<string, unknown>> : [];
}

function mergeClients(target: Map<string, Record<string, unknown>>, payload: Record<string, unknown>) {
  for (const client of clientsFromStatus(payload)) {
    const clientId = String(client.id || client.clientid || client.client_id || '').trim();
    const hostname = String(client.hostname || client.name || client.clientname || '').trim();
    const key = clientId || hostname;
    if (key) target.set(key, client);
  }
}

function easyBackupBaseUrl(reqHost: string, reqProto: string) {
  const configured = String(process.env.EASY_BACKUP_PUBLIC_URL || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  let host = reqHost.trim() || '10.10.12.7:8090';
  const hasPort = /:\d+$/.test(host);
  if (!hasPort && !host.includes('localhost') && !host.startsWith('127.')) {
    host = `${host}:${process.env.EASY_BACKUP_PUBLIC_PORT || '8090'}`;
  }
  return `${reqProto || 'http'}://${host}`;
}

urbackupRouter.get('/health', requireAuth, asyncHandler(async (_req, res) => {
  const status = await urbackupClient.health();
  res.json({ ok: true, status });
}));

urbackupRouter.get('/windows-client-download', asyncHandler(async (_req, res) => {
  const upstream = await fetch(windowsClientUrl);
  if (!upstream.ok) {
    res.status(502).json({
      error: 'urbackup_client_download_failed',
      status: upstream.status,
    });
    return;
  }

  const installer = Buffer.from(await upstream.arrayBuffer());
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="UrBackupClientSetup.exe"');
  res.setHeader('Content-Length', String(installer.length));
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(installer);
}));

urbackupRouter.post('/windows-custom-client-download', asyncHandler(async (req, res) => {
  const body = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    clientName: z.string().min(1).max(80),
  }).parse(req.body || {});
  const credentials = { username: body.username, password: body.password };
  const normalizedName = body.clientName.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 64);

  let newClient = await urbackupClient.addClient(normalizedName, credentials);
  let clientId = String(newClient.new_clientid || '').trim();
  let authKey = String(newClient.new_authkey || '').trim();

  if (!clientId && newClient.already_exists) {
    const status = await urbackupClient.clients(credentials);
    const downloads = Array.isArray(status.client_downloads) ? status.client_downloads as Array<Record<string, unknown>> : [];
    const existing = downloads.find((client) => String(client.name || '').trim() === normalizedName);
    clientId = String(existing?.id || '').trim();
  }

  if (!clientId) {
    const fallbackName = `${normalizedName}-${Date.now().toString(36)}`.slice(0, 80);
    newClient = await urbackupClient.addClient(fallbackName, credentials);
    clientId = String(newClient.new_clientid || '').trim();
    authKey = String(newClient.new_authkey || '').trim();
  }

  if (!clientId) {
    throw new Error('UrBackup nao criou o cliente personalizado. Verifique permissoes de add_client/settings para o usuario informado.');
  }

  const installer = await urbackupClient.downloadClient(clientId, authKey || undefined, credentials);
  if (installer.buffer.length < 10 * 1024) {
    throw new Error('UrBackup retornou um instalador invalido ou vazio.');
  }

  res.setHeader('Content-Type', installer.contentType);
  res.setHeader('Content-Disposition', 'attachment; filename="EasyBackup-UrBackup-Client.exe"');
  res.setHeader('Content-Length', String(installer.buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  res.send(installer.buffer);
}));

urbackupRouter.get('/windows-client-script', requireAuth, asyncHandler(async (req, res) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '10.10.12.7:8090');
  const appBaseUrl = easyBackupBaseUrl(host, proto);
  const serverHost = new URL(appBaseUrl).hostname || '10.10.12.7';
  const script = `# EASY Backup Manager - Instalador do UrBackup Client para Windows
# Execute este arquivo como Administrador no computador que sera protegido.
# Ele cria um cliente personalizado no UrBackup, baixa o instalador do proprio servidor e reinicia o servico.

$ErrorActionPreference = "Stop"
$ServerAddress = "${serverHost}"
$DownloadUrl = "${appBaseUrl}/api/urbackup/windows-client-download"
$CustomDownloadUrl = "${appBaseUrl}/api/urbackup/windows-custom-client-download"
$FallbackDownloadUrl = "${windowsClientUrl}"
$Installer = Join-Path $env:TEMP "UrBackupClientSetup.exe"
$InstallTimeoutSeconds = 300

Write-Host "EASY Backup - Instalando UrBackup Client..." -ForegroundColor Cyan

$IsAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $IsAdmin) {
  if ($PSCommandPath) {
    Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ('"' + $PSCommandPath + '"'))
    exit 0
  }
  throw "Execute este PowerShell como Administrador."
}

Write-Host "Servidor EASY Backup/UrBackup: $ServerAddress" -ForegroundColor Cyan

$UrBackupUser = Read-Host "Usuario admin do UrBackup" 
if ([string]::IsNullOrWhiteSpace($UrBackupUser)) { $UrBackupUser = "admin" }
$UrBackupSecurePassword = Read-Host "Senha do UrBackup" -AsSecureString
$UrBackupPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($UrBackupSecurePassword))
$ClientName = $env:COMPUTERNAME

$svc = Get-Service | Where-Object { $_.Name -like "UrBackup*" -or $_.DisplayName -like "UrBackup*" } | Select-Object -First 1
if ($svc) {
  Write-Host "UrBackup Client ja esta instalado: $($svc.DisplayName). Vou reparar o pareamento e reinstalar o cliente personalizado." -ForegroundColor Yellow
  Stop-Service -Name $svc.Name -Force -ErrorAction SilentlyContinue
}

$InstallRoots = @(
  "$env:ProgramFiles\\UrBackup",
  "\${env:ProgramFiles(x86)}\\UrBackup"
) | Where-Object { $_ -and (Test-Path $_) }
foreach ($root in $InstallRoots) {
  $ident = Join-Path $root "server_idents.txt"
  if (Test-Path $ident) {
    $backupIdent = "$ident.easybackup.bak"
    Move-Item -Path $ident -Destination $backupIdent -Force
    Write-Host "Identidade antiga do servidor removida: $ident" -ForegroundColor Yellow
  }
}

try {
  Write-Host "Criando cliente personalizado no UrBackup e baixando instalador pelo EASY Backup..." -ForegroundColor Cyan
  $payload = @{
    username = $UrBackupUser
    password = $UrBackupPassword
    clientName = $ClientName
  } | ConvertTo-Json
  Invoke-WebRequest -Uri $CustomDownloadUrl -Method POST -Body $payload -ContentType "application/json" -OutFile $Installer -UseBasicParsing -TimeoutSec 900
} catch {
  Write-Host "Instalador personalizado falhou: $($_.Exception.Message)" -ForegroundColor Yellow
  Write-Host "Tentando cliente oficial do UrBackup como ultimo recurso: $FallbackDownloadUrl" -ForegroundColor Yellow
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -Uri $FallbackDownloadUrl -OutFile $Installer -UseBasicParsing -TimeoutSec 900
}

Write-Host "Instalando em modo silencioso..." -ForegroundColor Cyan
$process = Start-Process -FilePath $Installer -ArgumentList "/S" -PassThru
if (-not $process.WaitForExit($InstallTimeoutSeconds * 1000)) {
  try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
  throw "Instalador demorou mais de $InstallTimeoutSeconds segundos. Se o cliente ja apareceu instalado, execute este script novamente para concluir firewall/testes."
}
if ($process.ExitCode -ne 0) {
  Write-Host "Aviso: instalador retornou codigo $($process.ExitCode)." -ForegroundColor Yellow
}

Write-Host "Configurando firewall local do UrBackup Client..." -ForegroundColor Cyan
try {
  New-NetFirewallRule -DisplayName "EASY Backup - UrBackup Client TCP" -Direction Inbound -Protocol TCP -LocalPort 35621,35623 -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
  New-NetFirewallRule -DisplayName "EASY Backup - UrBackup Client UDP" -Direction Inbound -Protocol UDP -LocalPort 35622 -Action Allow -Profile Any -ErrorAction SilentlyContinue | Out-Null
  Write-Host "Firewall liberado para TCP 35621/35623 e UDP 35622." -ForegroundColor Green
} catch {
  Write-Host "Nao foi possivel criar regra de firewall automaticamente: $($_.Exception.Message)" -ForegroundColor Yellow
}

Start-Sleep -Seconds 3
$svc = Get-Service | Where-Object { $_.Name -like "UrBackup*" -or $_.DisplayName -like "UrBackup*" } | Select-Object -First 1
if ($svc) {
  Set-Service -Name $svc.Name -StartupType Automatic
  Start-Service -Name $svc.Name -ErrorAction SilentlyContinue
  Write-Host "Servico UrBackup ativo: $($svc.DisplayName)" -ForegroundColor Green
} else {
  Write-Host "Servico UrBackup nao encontrado. Reinicie o Windows se o instalador solicitar." -ForegroundColor Yellow
}

try {
  $tcp = Test-NetConnection $ServerAddress -Port 55414 -WarningAction SilentlyContinue
  if ($tcp.TcpTestSucceeded) {
    Write-Host "Interface UrBackup OK na porta 55414." -ForegroundColor Green
  } else {
    Write-Host "Nao conectou na porta 55414. Verifique rede/firewall entre este PC e $ServerAddress." -ForegroundColor Yellow
  }
} catch {
  Write-Host "Nao foi possivel testar a porta 55414: $($_.Exception.Message)" -ForegroundColor Yellow
}

try {
  $tcpInternet = Test-NetConnection $ServerAddress -Port 55415 -WarningAction SilentlyContinue
  if ($tcpInternet.TcpTestSucceeded) {
    Write-Host "Porta UrBackup Internet clients 55415 acessivel." -ForegroundColor Green
  } else {
    Write-Host "Porta 55415 nao acessivel. Para clientes fora da descoberta LAN, configure cliente preconfigurado/Internet client." -ForegroundColor Yellow
  }
} catch {
  Write-Host "Nao foi possivel testar a porta 55415: $($_.Exception.Message)" -ForegroundColor Yellow
}

Write-Host "Aguarde ate 60 segundos para o cliente personalizado conectar no servidor." -ForegroundColor Cyan
Write-Host ""
Write-Host "Concluido. Volte no EASY Backup e clique em Sincronizar UrBackup." -ForegroundColor Green
`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="easy-backup-instalar-cliente-urbackup.ps1"');
  res.send(script);
}));

urbackupRouter.post('/sync-clients', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const credentials = z.object({
    username: z.string().optional(),
    password: z.string().optional(),
  }).parse(req.body || {});
  const knownMachines = await prisma.machine.findMany({
    where: { tenantId: req.user!.tenantId },
    select: { id: true, name: true, ip: true },
    take: 500,
  });
  const clientMap = new Map<string, Record<string, unknown>>();
  const discoveryMap = new Map<string, Record<string, unknown>>();
  const payload = await urbackupClient.clients(credentials);
  if (payload.error) {
    throw new Error(`UrBackup retornou erro ${String(payload.error)} ao listar clientes.`);
  }
  mergeClients(clientMap, payload);
  for (const hint of discoveryHintsFromStatus(payload)) {
    const key = String(hint.id || hint.hostname || '').trim();
    if (key) discoveryMap.set(key, hint);
  }
  for (const machine of knownMachines) {
    for (const hostname of [machine.ip, machine.name]) {
      const value = String(hostname || '').trim();
      if (!value) continue;
      const lookupPayload = await urbackupClient.clients(credentials, value);
      mergeClients(clientMap, lookupPayload);
      for (const hint of discoveryHintsFromStatus(lookupPayload)) {
        const key = String(hint.id || hint.hostname || '').trim();
        if (key) discoveryMap.set(key, hint);
      }
    }
  }
  const clients = [...clientMap.values()];
  const validClientIds = new Set(clients.map((client) => String(client.id || client.clientid || client.client_id || '').trim()).filter(Boolean));
  await prisma.machine.updateMany({
    where: {
      tenantId: req.user!.tenantId,
      urbackupClientId: { not: null },
      NOT: { urbackupClientId: { in: [...validClientIds] } },
    },
    data: { urbackupClientId: null, backupStatus: 'UNKNOWN' },
  });
  let synced = 0;
  for (const client of clients) {
    const clientId = String(client.id || client.clientid || client.client_id || '').trim();
    const name = String(client.name || client.hostname || client.clientname || clientId || '').trim();
    if (!clientId || !name) continue;
    const matched = knownMachines.find((machine) => [machine.ip, machine.name].filter(Boolean).includes(name));
    if (matched) {
      await prisma.machine.update({
        where: { id: matched.id },
        data: {
          urbackupClientId: clientId,
          status: String(client.online || client.status || '').toLowerCase().includes('true') || String(client.online || client.status || '').toLowerCase().includes('online') ? 'ONLINE' : 'UNKNOWN',
          lastSeenAt: new Date(),
        },
      });
    } else {
      await prisma.machine.upsert({
        where: { id: `urbackup-${clientId}` },
        create: {
          id: `urbackup-${clientId}`,
          tenantId: req.user!.tenantId,
          urbackupClientId: clientId,
          name,
          status: String(client.online || client.status || '').toLowerCase().includes('true') || String(client.online || client.status || '').toLowerCase().includes('online') ? 'ONLINE' : 'UNKNOWN',
        },
        update: {
          urbackupClientId: clientId,
          name,
          lastSeenAt: new Date(),
        },
      });
    }
    synced += 1;
  }
  res.json({ ok: true, synced, rawCount: clients.length, discoveryCount: discoveryMap.size });
}));
