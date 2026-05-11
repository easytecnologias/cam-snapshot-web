import { config } from '../../config.js';
import { createHash, pbkdf2Sync } from 'node:crypto';

type Json = Record<string, unknown>;

let session = '';

function md5(value: string) {
  return createHash('md5').update(value).digest('hex');
}

function withSession(path: string) {
  if (!session) return path;
  return `${path}${path.includes('?') ? '&' : '?'}ses=${encodeURIComponent(session)}`;
}

async function request(path: string, init?: RequestInit): Promise<Json> {
  const base = config.urbackupBaseUrl.replace(/\/$/, '');
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers || {}),
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`UrBackup HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { raw: text };
  }
}

async function login(): Promise<string> {
  if (session) return session;

  const username = config.urbackupUsername;
  const password = config.urbackupPassword;

  const anonymous = await request('/x?a=login&langs=en');
  if (anonymous.success === true && typeof anonymous.session === 'string') {
    session = anonymous.session;
    return session;
  }

  if (!username || !password) {
    throw new Error('UrBackup exige login. Configure URBACKUP_USERNAME e URBACKUP_PASSWORD no servidor.');
  }

  const saltPayload = await request(`/x?a=salt&username=${encodeURIComponent(username)}`);
  const salt = String(saltPayload.salt || '');
  const rnd = String(saltPayload.rnd || '');
  if (!salt || !rnd) {
    throw new Error('UrBackup nao retornou desafio de autenticacao valido.');
  }

  let passwordHash = md5(`${salt}${password}`);
  const rounds = Number(saltPayload.pbkdf2_rounds || 0);
  if (rounds > 0) {
    passwordHash = pbkdf2Sync(Buffer.from(passwordHash, 'hex'), salt, rounds, 32, 'sha1').toString('hex');
  }
  passwordHash = md5(`${rnd}${passwordHash}`);

  const loginPayload = await request(
    `/x?a=login&username=${encodeURIComponent(username)}&password=${encodeURIComponent(passwordHash)}`,
  );
  if (loginPayload.error === 2) throw new Error('Senha do UrBackup invalida.');
  if (loginPayload.error === 3) throw new Error('UrBackup bloqueou login por muitas tentativas.');
  if (typeof loginPayload.session !== 'string' || !loginPayload.session) {
    throw new Error('UrBackup nao retornou sessao apos login.');
  }
  session = loginPayload.session;
  return session;
}

async function authedRequest(path: string): Promise<Json> {
  await login();
  const payload = await request(withSession(path));
  if (payload.error === 1) {
    session = '';
    await login();
    return request(withSession(path));
  }
  return payload;
}

export const urbackupClient = {
  async health() {
    return authedRequest('/x?a=status');
  },
  async clients() {
    return authedRequest('/x?a=status');
  },
  async backups(clientId: string) {
    return authedRequest(`/x?a=backups&clientid=${encodeURIComponent(clientId)}`);
  },
  async startBackup(clientId: string, type: 'full_file' | 'incremental_file' | 'full_image' | 'incremental_image') {
    return authedRequest(`/x?a=start_backup&clientid=${encodeURIComponent(clientId)}&backup_type=${encodeURIComponent(type)}`);
  },
  async logs(clientId: string) {
    return authedRequest(`/x?a=logs&clientid=${encodeURIComponent(clientId)}`);
  },
};
