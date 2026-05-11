import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { urbackupClient } from '../urbackup/urbackupClient.js';

export const backupsRouter = Router();

backupsRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const jobs = await prisma.backupJob.findMany({
    where: { machine: { tenantId: req.user!.tenantId } },
    include: { machine: true },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ jobs });
}));

backupsRouter.post('/start', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = z.object({
    machineId: z.string().min(1),
    type: z.enum(['full_file', 'incremental_file', 'full_image', 'incremental_image']).default('incremental_file'),
  }).parse(req.body);
  const machine = await prisma.machine.findFirst({ where: { id: body.machineId, tenantId: req.user!.tenantId } });
  if (!machine) return res.status(404).json({ error: 'machine_not_found' });
  if (!machine.urbackupClientId) return res.status(400).json({ error: 'machine_without_urbackup_client' });
  const result = await urbackupClient.startBackup(machine.urbackupClientId, body.type);
  const job = await prisma.backupJob.create({
    data: {
      machineId: machine.id,
      type: body.type,
      status: 'RUNNING',
      raw: result as Prisma.InputJsonValue,
    },
  });
  res.status(202).json({ job, urbackup: result });
}));

backupsRouter.post('/start-bulk', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = z.object({
    machineIds: z.array(z.string().min(1)).min(1),
    type: z.enum(['full_file', 'incremental_file', 'full_image', 'incremental_image']).default('incremental_file'),
  }).parse(req.body);
  const machines = await prisma.machine.findMany({
    where: { id: { in: body.machineIds }, tenantId: req.user!.tenantId },
  });
  const jobs = [];
  const skipped = [];
  for (const machine of machines) {
    if (!machine.urbackupClientId) {
      skipped.push({ machineId: machine.id, reason: 'machine_without_urbackup_client' });
      continue;
    }
    const result = await urbackupClient.startBackup(machine.urbackupClientId, body.type);
    const job = await prisma.backupJob.create({
      data: {
        machineId: machine.id,
        type: body.type,
        status: 'RUNNING',
        raw: result as Prisma.InputJsonValue,
      },
    });
    jobs.push(job);
  }
  res.status(202).json({ jobs, skipped, requested: body.machineIds.length });
}));
