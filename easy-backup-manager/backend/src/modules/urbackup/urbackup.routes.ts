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
  const extraClients = payload.extra_clients;
  if (Array.isArray(extraClients)) return extraClients as Array<Record<string, unknown>>;
  return [];
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

urbackupRouter.get('/windows-client-script', requireAuth, asyncHandler(async (req, res) => {
  const proto = String(req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '10.10.12.7:8090');
  const appBaseUrl = easyBackupBaseUrl(host, proto);
  const serverHost = new URL(appBaseUrl).hostname || '10.10.12.7';
  const script = `# EASY Backup Manager - Instalador do UrBackup Client para Windows
# Execute este arquivo como Administrador no computador que sera protegido.
# Ele baixa o cliente oficial do UrBackup, instala silenciosamente e reinicia o servico.

$ErrorActionPreference = "Stop"
$ServerAddress = "${serverHost}"
$DownloadUrl = "${appBaseUrl}/api/urbackup/windows-client-download"
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

$svc = Get-Service | Where-Object { $_.Name -like "UrBackup*" -or $_.DisplayName -like "UrBackup*" } | Select-Object -First 1
if ($svc) {
  Write-Host "UrBackup Client ja esta instalado: $($svc.DisplayName). Pulando instalador." -ForegroundColor Yellow
} else {
  Write-Host "Baixando cliente UrBackup pelo servidor EASY Backup: $DownloadUrl" -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $Installer -UseBasicParsing -TimeoutSec 900
  } catch {
    Write-Host "Download local falhou: $($_.Exception.Message)" -ForegroundColor Yellow
    Write-Host "Tentando download oficial do UrBackup: $FallbackDownloadUrl" -ForegroundColor Yellow
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

Write-Host "Aguarde ate 60 segundos para o servidor descobrir o cliente na rede local." -ForegroundColor Cyan
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
  const payload = await urbackupClient.clients(credentials);
  if (payload.error) {
    throw new Error(`UrBackup retornou erro ${String(payload.error)} ao listar clientes.`);
  }
  mergeClients(clientMap, payload);
  for (const machine of knownMachines) {
    for (const hostname of [machine.ip, machine.name]) {
      const value = String(hostname || '').trim();
      if (!value) continue;
      const lookupPayload = await urbackupClient.clients(credentials, value);
      mergeClients(clientMap, lookupPayload);
    }
  }
  const clients = [...clientMap.values()];
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
  res.json({ ok: true, synced, rawCount: clients.length });
}));
