import { Router } from 'express';
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';

export const machinesRouter = Router();

machinesRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const machines = await prisma.machine.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: [{ status: 'asc' }, { name: 'asc' }],
    take: 500,
  });
  res.json({ machines });
}));

machinesRouter.post('/', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = z.object({
    name: z.string().min(1),
    ip: z.string().optional(),
    os: z.string().optional(),
    group: z.string().optional(),
    company: z.string().optional(),
    urbackupClientId: z.string().optional(),
  }).parse(req.body);
  const machine = await prisma.machine.create({ data: { ...body, tenantId: req.user!.tenantId } });
  res.status(201).json({ machine });
}));

function text(value: unknown) {
  return String(value || '').trim();
}

function numberValue(value: unknown) {
  const out = Number(value || 0);
  return Number.isFinite(out) ? out : 0;
}

function bytesFromGb(value: unknown) {
  const gb = numberValue(value);
  return gb > 0 ? BigInt(Math.round(gb * 1024 * 1024 * 1024)) : null;
}

function usedBytesFromVolumes(volumes: unknown) {
  if (!Array.isArray(volumes)) return null;
  let totalGb = 0;
  let freeGb = 0;
  for (const volume of volumes) {
    if (!volume || typeof volume !== 'object') continue;
    const item = volume as Record<string, unknown>;
    totalGb += numberValue(item.size_gb);
    freeGb += numberValue(item.free_gb);
  }
  const usedGb = Math.max(0, totalGb - freeGb);
  return usedGb > 0 ? bytesFromGb(usedGb) : null;
}

function windowsStatus(value: unknown) {
  const raw = text(value).toLowerCase();
  if (raw === 'online' || raw === 'agent_reported') return 'ONLINE';
  if (raw.includes('closed') || raw.includes('failed') || raw.includes('error')) return 'OFFLINE';
  return 'UNKNOWN';
}

machinesRouter.post('/import/windows-inventory', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const inventoryPath = process.env.SIGHTOPS_WINDOWS_INVENTORY_PATH || '/sightops-data/windows-inventory.json';
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(inventoryPath, 'utf8'));
  } catch (err) {
    return res.status(404).json({
      error: 'windows_inventory_not_found',
      path: inventoryPath,
      detail: err instanceof Error ? err.message : 'read_failed',
    });
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).inventory))
      ? (parsed as Record<string, unknown>).inventory as unknown[]
      : [];

  let imported = 0;
  let skipped = 0;
  const machines = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      skipped += 1;
      continue;
    }
    const item = row as Record<string, unknown>;
    const hostname = text(item.hostname);
    const ip = text(item.ip);
    const serial = text(item.serial);
    const stableKey = serial || ip || hostname;
    if (!stableKey || !hostname) {
      skipped += 1;
      continue;
    }
    const os = item.os && typeof item.os === 'object' ? item.os as Record<string, unknown> : {};
    const id = `windows-${Buffer.from(stableKey).toString('base64url').slice(0, 32)}`;
    const diskBytes = bytesFromGb(item.disk_total_gb);
    const usedBytes = usedBytesFromVolumes(item.volumes);
    const machine = await prisma.machine.upsert({
      where: { id },
      create: {
        id,
        tenantId: req.user!.tenantId,
        name: hostname,
        ip: ip || null,
        os: [text(os.name), text(os.build)].filter(Boolean).join(' / ') || null,
        group: text(item.domain) || null,
        company: text(item.manufacturer) || null,
        status: windowsStatus(item.status),
        totalBytes: diskBytes,
        usedBytes,
        lastSeenAt: item.last_seen ? new Date(text(item.last_seen)) : null,
      },
      update: {
        name: hostname,
        ip: ip || null,
        os: [text(os.name), text(os.build)].filter(Boolean).join(' / ') || null,
        group: text(item.domain) || null,
        company: text(item.manufacturer) || null,
        status: windowsStatus(item.status),
        totalBytes: diskBytes,
        usedBytes,
        lastSeenAt: item.last_seen ? new Date(text(item.last_seen)) : null,
      },
    });
    machines.push(machine);
    imported += 1;
  }

  res.json({ ok: true, imported, skipped, total: rows.length, machines });
}));
