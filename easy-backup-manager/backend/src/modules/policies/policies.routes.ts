import type { BackupPolicy, Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { urbackupClient } from '../urbackup/urbackupClient.js';

export const policiesRouter = Router();

const policySchema = z.object({
  name: z.string().min(1).default('Politica padrao EASY'),
  fileBackupMode: z.enum(['all_without_system', 'user_profiles', 'manual']).default('all_without_system'),
  imageBackupMode: z.enum(['system_volume', 'all_internal', 'manual']).default('all_internal'),
  fileBackupSchedule: z.enum(['daily', 'manual']).default('daily'),
  imageBackupSchedule: z.enum(['weekly', 'manual']).default('weekly'),
  retentionDays: z.coerce.number().int().min(1).max(365).default(30),
});

const credentialsSchema = z.object({
  username: z.string().optional(),
  password: z.string().optional(),
});

function preferredBackupTypes(policy: BackupPolicy) {
  const types: Array<'full_file' | 'incremental_file' | 'full_image' | 'incremental_image'> = [];
  if (policy.fileBackupSchedule !== 'manual') types.push('incremental_file');
  if (policy.imageBackupSchedule !== 'manual') types.push('full_image');
  if (!types.length) types.push('incremental_file');
  return types;
}

policiesRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const policies = await prisma.backupPolicy.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: [{ active: 'desc' }, { createdAt: 'asc' }],
    take: 50,
  });
  res.json({ policies });
}));

policiesRouter.post('/default', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = policySchema.parse(req.body || {});
  const existing = await prisma.backupPolicy.findFirst({
    where: { tenantId: req.user!.tenantId, name: body.name },
  });
  const policy = existing
    ? await prisma.backupPolicy.update({ where: { id: existing.id }, data: body })
    : await prisma.backupPolicy.create({ data: { ...body, tenantId: req.user!.tenantId } });
  res.status(existing ? 200 : 201).json({ policy });
}));

policiesRouter.post('/apply', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = z.object({
    policyId: z.string().optional(),
    machineIds: z.array(z.string().min(1)).min(1),
  }).parse(req.body || {});

  const policy = body.policyId
    ? await prisma.backupPolicy.findFirst({ where: { id: body.policyId, tenantId: req.user!.tenantId } })
    : await prisma.backupPolicy.findFirst({ where: { tenantId: req.user!.tenantId, active: true }, orderBy: { createdAt: 'asc' } });
  if (!policy) return res.status(404).json({ error: 'backup_policy_not_found' });

  const update = await prisma.machine.updateMany({
    where: { id: { in: body.machineIds }, tenantId: req.user!.tenantId },
    data: { backupPolicyId: policy.id },
  });
  res.json({ ok: true, applied: update.count, policy });
}));

policiesRouter.post('/apply-and-run', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const body = z.object({
    policyId: z.string().optional(),
    machineIds: z.array(z.string().min(1)).min(1),
  }).merge(credentialsSchema).parse(req.body || {});

  const policy = body.policyId
    ? await prisma.backupPolicy.findFirst({ where: { id: body.policyId, tenantId: req.user!.tenantId } })
    : await prisma.backupPolicy.findFirst({ where: { tenantId: req.user!.tenantId, active: true }, orderBy: { createdAt: 'asc' } });
  if (!policy) return res.status(404).json({ error: 'backup_policy_not_found' });

  const machines = await prisma.machine.findMany({
    where: { id: { in: body.machineIds }, tenantId: req.user!.tenantId },
  });
  await prisma.machine.updateMany({
    where: { id: { in: machines.map((machine) => machine.id) }, tenantId: req.user!.tenantId },
    data: { backupPolicyId: policy.id },
  });

  const jobs = [];
  const skipped = [];
  for (const machine of machines) {
    if (!machine.urbackupClientId) {
      skipped.push({ machineId: machine.id, name: machine.name, reason: 'machine_without_urbackup_client' });
      continue;
    }
    for (const type of preferredBackupTypes(policy)) {
      const result = await urbackupClient.startBackup(machine.urbackupClientId, type, body);
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
        data: { backupStatus: 'RUNNING', lastSeenAt: new Date() },
      });
      jobs.push(job);
    }
  }
  res.status(202).json({ ok: true, policy, jobs, skipped });
}));
