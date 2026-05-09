import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';

export const alertsRouter = Router();

alertsRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const alerts = await prisma.alert.findMany({
    where: { tenantId: req.user!.tenantId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({ alerts });
}));
