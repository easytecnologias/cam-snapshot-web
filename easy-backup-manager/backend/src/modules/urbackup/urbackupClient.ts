import { config } from '../../config.js';

type Json = Record<string, unknown>;

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

export const urbackupClient = {
  async health() {
    return request('/x?a=status');
  },
  async clients() {
    return request('/x?a=status');
  },
  async backups(clientId: string) {
    return request(`/x?a=backups&clientid=${encodeURIComponent(clientId)}`);
  },
  async startBackup(clientId: string, type: 'full_file' | 'incremental_file' | 'full_image' | 'incremental_image') {
    return request(`/x?a=start_backup&clientid=${encodeURIComponent(clientId)}&backup_type=${encodeURIComponent(type)}`);
  },
  async logs(clientId: string) {
    return request(`/x?a=logs&clientid=${encodeURIComponent(clientId)}`);
  },
};
