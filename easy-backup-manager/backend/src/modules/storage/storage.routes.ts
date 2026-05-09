import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';

export const storageRouter = Router();

storageRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const storage = await prisma.machine.aggregate({
    where: { tenantId: req.user!.tenantId },
    _sum: { usedBytes: true, totalBytes: true },
  });
  res.json({
    usedBytes: storage._sum.usedBytes?.toString() || '0',
    totalBytes: storage._sum.totalBytes?.toString() || '0',
    targets: [
      { type: 'local', path: '/backups', status: 'configured' },
      { type: 'nas', status: 'planned' },
      { type: 's3', status: 'planned' },
    ],
  });
}));
