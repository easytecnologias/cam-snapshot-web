import http from 'http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { createApp } from './app.js';
import { configureUrBackupInternetServer } from './modules/urbackup/urbackup.routes.js';

const app = createApp();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

io.on('connection', (socket) => {
  socket.emit('status', { ok: true, message: 'connected' });
});

setInterval(() => {
  io.emit('heartbeat', { at: new Date().toISOString() });
}, 15_000);

server.listen(config.port, () => {
  console.log(`EASY Backup Manager API listening on ${config.port}`);
});

async function prepareUrBackupOnBoot(attempt = 1) {
  const url = process.env.EASY_BACKUP_PUBLIC_URL || '';
  const host = url ? new URL(url).hostname : '10.10.12.7';
  try {
    const result = await configureUrBackupInternetServer(host, 55415);
    console.log(`UrBackup internet server prepared: ${result.serverUrl}`);
  } catch (err) {
    if (attempt >= 12) {
      console.warn(`UrBackup internet server auto-prepare failed: ${err instanceof Error ? err.message : 'unknown_error'}`);
      return;
    }
    setTimeout(() => prepareUrBackupOnBoot(attempt + 1), 5000);
  }
}

prepareUrBackupOnBoot();
