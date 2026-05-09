import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { alertsRouter } from './modules/alerts/alerts.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { backupsRouter } from './modules/backups/backups.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { machinesRouter } from './modules/machines/machines.routes.js';
import { storageRouter } from './modules/storage/storage.routes.js';
import { urbackupRouter } from './modules/urbackup/urbackup.routes.js';

export function createApp() {
  const app = express();
  app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));
  app.use(helmet());
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(morgan('combined'));

  app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'easy-backup-manager' }));
  app.use('/api/auth', authRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/machines', machinesRouter);
  app.use('/api/backups', backupsRouter);
  app.use('/api/alerts', alertsRouter);
  app.use('/api/storage', storageRouter);
  app.use('/api/urbackup', urbackupRouter);

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = err instanceof Error ? err.message : 'internal_error';
    res.status(500).json({ error: message });
  });

  return app;
}
