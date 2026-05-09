import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';

export const dashboardRouter = Router();

dashboardRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const tenantId = req.user!.tenantId;
  const [total, online, offline, ok, failed, alerts] = await Promise.all([
    prisma.machine.count({ where: { tenantId } }),
    prisma.machine.count({ where: { tenantId, status: 'ONLINE' } }),
    prisma.machine.count({ where: { tenantId, status: 'OFFLINE' } }),
    prisma.machine.count({ where: { tenantId, backupStatus: 'OK' } }),
    prisma.machine.count({ where: { tenantId, backupStatus: 'FAILED' } }),
    prisma.alert.count({ where: { tenantId, resolved: false } }),
  ]);
  const storage = await prisma.machine.aggregate({ where: { tenantId }, _sum: { usedBytes: true, totalBytes: true } });
  res.json({
    totalMachines: total,
    online,
    offline,
    backupOk: ok,
    failures: failed,
    activeAlerts: alerts,
    usedBytes: storage._sum.usedBytes?.toString() || '0',
    totalBytes: storage._sum.totalBytes?.toString() || '0',
  });
}));
