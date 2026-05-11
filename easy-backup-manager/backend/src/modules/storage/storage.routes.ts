import { Router } from 'express';
import { statfs } from 'node:fs/promises';
import { prisma } from '../../db/prisma.js';
import { asyncHandler } from '../../lib/asyncHandler.js';
import { requireAuth } from '../../middleware/auth.js';

export const storageRouter = Router();

const backupStoragePath = process.env.URBACKUP_BACKUP_PATH || '/backups';

async function readServerStorage() {
  const stats = await statfs(backupStoragePath);
  const totalBytes = BigInt(stats.blocks) * BigInt(stats.bsize);
  const freeBytes = BigInt(stats.bavail) * BigInt(stats.bsize);
  const usedBytes = totalBytes > freeBytes ? totalBytes - freeBytes : 0n;
  return {
    type: 'local',
    path: backupStoragePath,
    status: 'configured',
    totalBytes: totalBytes.toString(),
    freeBytes: freeBytes.toString(),
    usedBytes: usedBytes.toString(),
  };
}

storageRouter.get('/server', asyncHandler(async (_req, res) => {
  try {
    res.json({ ok: true, storage: await readServerStorage() });
  } catch (err) {
    res.status(503).json({
      ok: false,
      error: 'server_storage_unavailable',
      path: backupStoragePath,
      detail: err instanceof Error ? err.message : 'statfs_failed',
    });
  }
}));

storageRouter.get('/', requireAuth, asyncHandler(async (req, res) => {
  const storage = await prisma.machine.aggregate({
    where: { tenantId: req.user!.tenantId },
    _sum: { usedBytes: true, totalBytes: true },
  });
  let serverStorage = null;
  try {
    serverStorage = await readServerStorage();
  } catch {
    serverStorage = null;
  }
  res.json({
    protectedUsedBytes: storage._sum.usedBytes?.toString() || '0',
    protectedTotalBytes: storage._sum.totalBytes?.toString() || '0',
    usedBytes: serverStorage?.usedBytes || storage._sum.usedBytes?.toString() || '0',
    totalBytes: serverStorage?.totalBytes || storage._sum.totalBytes?.toString() || '0',
    freeBytes: serverStorage?.freeBytes || '0',
    targets: [
      serverStorage || { type: 'local', path: backupStoragePath, status: 'unavailable' },
      { type: 'nas', status: 'planned' },
      { type: 's3', status: 'planned' },
    ],
  });
}));
