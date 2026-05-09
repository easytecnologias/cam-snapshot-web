import http from 'http';
import { Server } from 'socket.io';
import { config } from './config.js';
import { createApp } from './app.js';

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
