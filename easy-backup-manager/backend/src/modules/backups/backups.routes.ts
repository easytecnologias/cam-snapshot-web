import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { urbackupClient } from '../urbackup/urbackupClient.js';

export const backupsRouter = Router();

type BackupType = 'full_file' | 'incremental_file' | 'full_image' | 'incremental_image';
type UrBackupCredentials = { username?: string; password?: string };
type MachineRow = Awaited<ReturnType<typeof prisma.machine.findFirst>> extends infer T ? NonNullable<T> : never;

function asRows(payload: Record<string, unknown>, key: string) {
  const raw = payload[key];
  return Array.isArray(raw) ? raw as Array<Record<string, unknown>> : [];
}

function clientRows(payload: Record<string, unknown>) {
  return asRows(payload, 'status').length ? asRows(payload, 'status') : asRows(payload, 'clients');
}

function progressRows(payload: Record<string, unknown>) {
  const progress = asRows(payload, 'progress');
  if (progress.length) return progress;
  return asRows(payload, 'processes');
}

function field(row: Record<string, unknown>, names: string[]) {
  for (const name of names) {
    const value = String(row[name] || '').trim();
    if (value) return value;
  }
  return '';
}

function rowClientId(row: Record<string, unknown>) {
  return field(row, ['id', 'clientid', 'client_id', 'clientid_a', 'client_id_a']);
}

function rowName(row: Record<string, unknown>) {
  return field(row, ['name', 'hostname', 'clientname', 'client_name']);
}

function rowOnline(row: Record<string, unknown>) {
  const raw = String(row.online ?? row.status ?? '').toLowerCase();
  return raw === 'true' || raw === '1' || raw.includes('online') || raw === 'ok';
}

function matchesMachine(row: Record<string, unknown>, machine: MachineRow) {
  const name = rowName(row).toLowerCase();
  const ip = field(row, ['ip', 'addr', 'address']).toLowerCase();
  const machineName = String(machine.name || '').toLowerCase();
  const machineIp = String(machine.ip || '').toLowerCase();
  return (!!machineName && name === machineName) || (!!machineIp && (name === machineIp || ip === machineIp));
}

async function resolveUrBackupClient(machine: MachineRow, credentials: UrBackupCredentials) {
  const payloads = [await urbackupClient.clients(credentials)];
  for (const value of [machine.name, machine.ip]) {
    if (value) payloads.push(await urbackupClient.clients(credentials, value));
  }
  for (const payload of payloads) {
    const match = clientRows(payload).find((row) => {
      const clientId = rowClientId(row);
      return (!!machine.urbackupClientId && clientId === machine.urbackupClientId) || matchesMachine(row, machine);
    });
    if (!match) continue;
    const clientId = rowClientId(match);
    if (!clientId) continue;
    if (clientId !== machine.urbackupClientId) {
      await prisma.machine.update({
        where: { id: machine.id },
        data: { urbackupClientId: clientId },
      });
    }
    return { clientId, online: rowOnline(match), raw: match };
  }
  return null;
}

async function startBackupForMachine(machine: MachineRow, type: BackupType, credentials: UrBackupCredentials) {
  const resolved = await resolveUrBackupClient(machine, credentials);
  if (!resolved?.clientId) {
    return { skipped: { machineId: machine.id, name: machine.name, reason: 'urbackup_client_not_found' } };
  }
  if (!resolved.online) {
    return { skipped: { machineId: machine.id, name: machine.name, reason: 'urbackup_client_offline' } };
  }
  const result = await urbackupClient.startBackup(resolved.clientId, type, credentials);
  if (result.error) {
    return { skipped: { machineId: machine.id, name: machine.name, reason: `urbackup_error_${String(result.error)}`, raw: result } };
  }
  const job = await prisma.backupJob.create({
    data: {
      machineId: machine.id,
      type,
      status: 'RUNNING',
      raw: result as Prisma.InputJsonValue,
    },
  });
  await prisma.machine.update({
    where: { id: machine.id },
    data: {
      urbackupClientId: resolved.clientId,
      status: 'ONLINE',
      backupStatus: 'RUNNING',
      lastSeenAt: new Date(),
    },
  });
  return { job, urbackup: result };
}

backupsRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const jobs = await prisma.backupJob.findMany({
    where: { machine: { tenantId: req.user!.tenantId } },
    include: { machine: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ jobs });
}));

backupsRouter.get('/runtime', requireAuth, asyncHandler(async (req, res) => {
  const progress = await urbackupClient.progress();
  const processes = progressRows(progress);
  const tenantId = req.user!.tenantId;

  if (!processes.length) {
    await prisma.backupJob.updateMany({
      where: { status: 'RUNNING', machine: { tenantId } },
      data: { status: 'WARNING', error: 'UrBackup nao reporta job ativo no momento.', finishedAt: new Date() },
    });
    await prisma.machine.updateMany({
      where: { tenantId, backupStatus: 'RUNNING' },
      data: { backupStatus: 'UNKNOWN' },
    });
  } else {
    const machines = await prisma.machine.findMany({ where: { tenantId } });
    for (const machine of machines) {
      const active = processes.some((row) => {
        const clientId = rowClientId(row);
        const name = rowName(row).toLowerCase();
        return (!!machine.urbackupClientId && clientId === machine.urbackupClientId)
          || (!!machine.name && name === machine.name.toLowerCase());
      });
      if (active) {
        await prisma.machine.update({
          where: { id: machine.id },
          data: { backupStatus: 'RUNNING', status: 'ONLINE', lastSeenAt: new Date() },
        });
      }
    }
  }

  res.json({ ok: true, processes, raw: progress });
}));

backupsRouter.post('/start', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = z.object({
    machineId: z.string().min(1),
    type: z.enum(['full_file', 'incremental_file', 'full_image', 'incremental_image']).default('incremental_file'),
    username: z.string().optional(),
    password: z.string().optional(),
  }).parse(req.body);
  const machine = await prisma.machine.findFirst({ where: { id: body.machineId, tenantId: req.user!.tenantId } });
  if (!machine) return res.status(404).json({ error: 'machine_not_found' });
  const result = await startBackupForMachine(machine, body.type, body);
  if (result.skipped) return res.status(409).json({ error: result.skipped.reason, skipped: [result.skipped] });
  res.status(202).json(result);
}));

backupsRouter.post('/start-bulk', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = z.object({
    machineIds: z.array(z.string().min(1)).min(1),
    type: z.enum(['full_file', 'incremental_file', 'full_image', 'incremental_image']).default('incremental_file'),
    username: z.string().optional(),
    password: z.string().optional(),
  }).parse(req.body);
  const machines = await prisma.machine.findMany({
    where: { id: { in: body.machineIds }, tenantId: req.user!.tenantId },
  });
  const jobs = [];
  const skipped = [];
  for (const machine of machines) {
    const result = await startBackupForMachine(machine, body.type, body);
    if (result.skipped) skipped.push(result.skipped);
    if (result.job) jobs.push(result.job);
  }
  res.status(202).json({ jobs, skipped, requested: body.machineIds.length });
}));

backupsRouter.post('/stop', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = z.object({
    machineId: z.string().min(1),
    username: z.string().optional(),
    password: z.string().optional(),
  }).parse(req.body);
  const machine = await prisma.machine.findFirst({ where: { id: body.machineId, tenantId: req.user!.tenantId } });
  if (!machine) return res.status(404).json({ error: 'machine_not_found' });
  if (!machine.urbackupClientId) return res.status(400).json({ error: 'machine_without_urbackup_client' });

  const progress = await urbackupClient.progress(body);
  const rawProcesses = Array.isArray(progress.progress)
    ? progress.progress
    : Array.isArray(progress.processes)
      ? progress.processes
      : [];
  const process = rawProcesses.find((item) => {
    if (!item || typeof item !== 'object') return false;
    const row = item as Record<string, unknown>;
    const clientId = String(row.clientid || row.client_id || row.clientid_a || row.client_id_a || '').trim();
    const name = String(row.name || row.clientname || row.client_name || '').trim();
    return clientId === machine.urbackupClientId || name === machine.name;
  }) as Record<string, unknown> | undefined;
  const stopId = String(process?.id || process?.process_id || process?.stop_id || '').trim();
  if (!stopId) return res.status(404).json({ error: 'running_backup_not_found', progress });
  const result = await urbackupClient.stopBackup(machine.urbackupClientId, stopId, body);
  res.json({ ok: true, stopped: { machineId: machine.id, stopId }, urbackup: result });
}));
