import bcrypt from 'bcryptjs';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { config } from '../../config.js';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';

export const authRouter = Router();

authRouter.post('/login', asyncHandler(async (req, res) => {
  const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email }, include: { tenant: true } });
  if (!user || !user.active) return res.status(401).json({ error: 'invalid_credentials' });
  const ok = await bcrypt.compare(body.password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'invalid_credentials' });
  const token = jwt.sign({ id: user.id, tenantId: user.tenantId, role: user.role }, config.jwtSecret, { expiresIn: '12h' });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, tenant: user.tenant.name } });
}));

authRouter.post('/bootstrap', asyncHandler(async (req, res) => {
  const existing = await prisma.user.count();
  if (existing > 0) return res.status(409).json({ error: 'bootstrap_already_done' });
  const body = z.object({
    tenantName: z.string().min(2),
    name: z.string().min(2),
    email: z.string().email(),
    password: z.string().min(10),
  }).parse(req.body);
  const tenant = await prisma.tenant.create({
    data: {
      name: body.tenantName,
      slug: body.tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default',
      users: {
        create: {
          name: body.name,
          email: body.email,
          passwordHash: await bcrypt.hash(body.password, 12),
          role: 'OWNER',
        },
      },
    },
    include: { users: true },
  });
  res.status(201).json({ ok: true, tenant: { id: tenant.id, name: tenant.name }, user: { email: tenant.users[0].email } });
}));

authRouter.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id }, include: { tenant: true } });
  res.json({ user });
}));
