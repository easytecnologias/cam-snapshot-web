import { config } from '../../config.js';
import { createHash, pbkdf2Sync } from 'node:crypto';

type Json = Record<string, unknown>;
type UrBackupCredentials = { username?: string; password?: string };

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
  let url = `${base}${path}`;
  let body: string | undefined;
  let method = init?.method;
  if (path.startsWith('/x?')) {
    const query = path.split('?')[1] || '';
    const params = new URLSearchParams(query);
    const action = params.get('a') || '';
    params.delete('a');
    url = `${base}/x?a=${encodeURIComponent(action)}`;
    body = params.toString();
    method = 'POST';
  }
  const response = await fetch(url, {
    ...init,
    method,
    body: init?.body || body,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=utf-8',
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

async function login(credentials: UrBackupCredentials = {}): Promise<string> {
  if (session && !credentials.username && !credentials.password) return session;

  const username = String(credentials.username || config.urbackupUsername || '').trim();
  const password = String(credentials.password || config.urbackupPassword || '');

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
  const saltSession = String(saltPayload.ses || '');
  if (!salt || !rnd) {
    throw new Error('Usuario do UrBackup nao encontrado ou admin ainda nao foi criado no painel 55414.');
  }

  let passwordHash = md5(`${salt}${password}`);
  const rounds = Number(saltPayload.pbkdf2_rounds || 0);
  if (rounds > 0) {
    passwordHash = pbkdf2Sync(Buffer.from(passwordHash, 'hex'), salt, rounds, 32, 'sha256').toString('hex');
  }
  passwordHash = md5(`${rnd}${passwordHash}`);

  const loginPayload = await request(
    `/x?a=login&username=${encodeURIComponent(username)}&password=${encodeURIComponent(passwordHash)}${saltSession ? `&ses=${encodeURIComponent(saltSession)}` : ''}`,
  );
  if (loginPayload.error === 2) throw new Error('Senha do UrBackup invalida.');
  if (loginPayload.error === 3) throw new Error('UrBackup bloqueou login por muitas tentativas.');
  const nextSession = String(loginPayload.session || saltSession || '');
  if (!nextSession) {
    throw new Error('UrBackup nao retornou sessao apos login.');
  }
  session = nextSession;
  return session;
}

async function authedRequest(path: string, credentials: UrBackupCredentials = {}): Promise<Json> {
  await login(credentials);
  const payload = await request(withSession(path));
  if (payload.error === 1) {
    session = '';
    await login(credentials);
    return request(withSession(path));
  }
  return payload;
}

export const urbackupClient = {
  async health(credentials?: UrBackupCredentials) {
    return authedRequest('/x?a=status', credentials);
  },
  async clients(credentials?: UrBackupCredentials) {
    return authedRequest('/x?a=status', credentials);
  },
  async progress(credentials?: UrBackupCredentials) {
    return authedRequest('/x?a=progress', credentials);
  },
  async stopBackup(clientId: string, stopId: string, credentials?: UrBackupCredentials) {
    return authedRequest(`/x?a=progress&stop_clientid=${encodeURIComponent(clientId)}&stop_id=${encodeURIComponent(stopId)}`, credentials);
  },
  async backups(clientId: string, credentials?: UrBackupCredentials) {
    return authedRequest(`/x?a=backups&clientid=${encodeURIComponent(clientId)}`, credentials);
  },
  async startBackup(clientId: string, type: 'full_file' | 'incremental_file' | 'full_image' | 'incremental_image', credentials?: UrBackupCredentials) {
    return authedRequest(`/x?a=start_backup&clientid=${encodeURIComponent(clientId)}&backup_type=${encodeURIComponent(type)}`, credentials);
  },
  async logs(clientId: string, credentials?: UrBackupCredentials) {
    return authedRequest(`/x?a=logs&clientid=${encodeURIComponent(clientId)}`, credentials);
  },
};
