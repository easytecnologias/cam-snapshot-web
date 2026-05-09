import { Router } from 'express';
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
