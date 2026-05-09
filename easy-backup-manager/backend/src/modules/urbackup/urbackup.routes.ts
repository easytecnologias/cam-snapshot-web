import { Router } from 'express';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth, requireRole } from '../../middleware/auth.js';
import { urbackupClient } from './urbackupClient.js';

export const urbackupRouter = Router();

function clientsFromStatus(payload: Record<string, unknown>) {
  const raw = payload.status;
  if (Array.isArray(raw)) return raw as Array<Record<string, unknown>>;
  const clients = payload.clients;
  if (Array.isArray(clients)) return clients as Array<Record<string, unknown>>;
  return [];
}

urbackupRouter.get('/health', requireAuth, asyncHandler(async (_req, res) => {
  const status = await urbackupClient.health();
  res.json({ ok: true, status });
}));

urbackupRouter.post('/sync-clients', requireAuth, requireRole('OPERATOR'), asyncHandler(async (req, res) => {
  const payload = await urbackupClient.clients();
  const clients = clientsFromStatus(payload);
  let synced = 0;
  for (const client of clients) {
    const clientId = String(client.id || client.clientid || client.client_id || '').trim();
    const name = String(client.name || client.hostname || clientId || '').trim();
    if (!clientId || !name) continue;
    await prisma.machine.upsert({
      where: { id: `urbackup-${clientId}` },
      create: {
        id: `urbackup-${clientId}`,
        tenantId: req.user!.tenantId,
        urbackupClientId: clientId,
        name,
        status: String(client.online || client.status || '').toLowerCase().includes('online') ? 'ONLINE' : 'UNKNOWN',
      },
      update: {
        urbackupClientId: clientId,
        name,
        lastSeenAt: new Date(),
      },
    });
    synced += 1;
  }
  res.json({ ok: true, synced, rawCount: clients.length });
}));
