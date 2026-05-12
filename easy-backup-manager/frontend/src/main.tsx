import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { Activity, AlertTriangle, Database, Download, HardDrive, PlayCircle, RefreshCw, Server, ShieldCheck } from 'lucide-react';
import './styles.css';

type User = { name: string; email: string; role: string; tenant: string };
type Dashboard = {
  totalMachines: number;
  online: number;
  offline: number;
  backupOk: number;
  failures: number;
  activeAlerts: number;
  usedBytes: string;
  totalBytes: string;
};
type Machine = {
  id: string;
  name: string;
  ip?: string;
  os?: string;
  group?: string;
  company?: string;
  status: 'ONLINE' | 'OFFLINE' | 'UNKNOWN';
  backupStatus: 'OK' | 'RUNNING' | 'FAILED' | 'WARNING' | 'UNKNOWN';
  lastBackupAt?: string;
  urbackupClientId?: string;
};
type BackupJob = { id: string; type: string; status: string; createdAt: string; machine?: Machine; error?: string };
type Alert = { id: string; severity: string; title: string; message: string; createdAt: string; resolved: boolean };
type BackupPolicy = {
  id: string;
  name: string;
  fileBackupMode: 'all_without_system' | 'user_profiles' | 'manual';
  imageBackupMode: 'system_volume' | 'all_internal' | 'manual';
  fileBackupSchedule: 'daily' | 'manual';
  imageBackupSchedule: 'weekly' | 'manual';
  retentionDays: number;
};

const tokenKey = 'easy_backup_token_v1';

function fmtBytes(raw?: string | number | null) {
  const value = Number(raw || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 GB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let size = value;
  let idx = 0;
  while (size >= 1024 && idx < units.length - 1) {
    size /= 1024;
    idx += 1;
  }
  return `${size.toFixed(idx < 3 ? 0 : 1)} ${units[idx]}`;
}

function fmtDate(value?: string | null) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('pt-BR');
  } catch {
    return value;
  }
}

function statusClass(value?: string) {
  const raw = String(value || '').toUpperCase();
  if (raw === 'ONLINE' || raw === 'OK') return 'text-emerald-300';
  if (raw === 'RUNNING' || raw === 'WARNING') return 'text-amber-300';
  if (raw === 'FAILED' || raw === 'OFFLINE') return 'text-rose-300';
  return 'text-slate-300';
}

function App() {
  const [token, setToken] = useState(() => localStorage.getItem(tokenKey) || '');
  const [user, setUser] = useState<User | null>(null);
  const [view, setView] = useState('Dashboard');
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [machines, setMachines] = useState<Machine[]>([]);
  const [jobs, setJobs] = useState<BackupJob[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [policies, setPolicies] = useState<BackupPolicy[]>([]);
  const [message, setMessage] = useState('Entre ou crie o primeiro admin para operar o backup.');
  const [loading, setLoading] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'bootstrap'>('login');
  const [showUrBackupAuth, setShowUrBackupAuth] = useState(false);
  const [urbackupAuth, setUrbackupAuth] = useState({ username: 'admin', password: '' });
  const [selectedMachines, setSelectedMachines] = useState<string[]>([]);
  const [authForm, setAuthForm] = useState({
    tenantName: 'Default',
    name: 'Administrador',
    email: '',
    password: '',
  });
  const [machineForm, setMachineForm] = useState({ name: '', ip: '', os: 'Windows', group: '', company: '', urbackupClientId: '' });
  const [backupForm, setBackupForm] = useState({ machineId: '', type: 'incremental_file' });
  const [policyForm, setPolicyForm] = useState({
    name: 'Politica padrao EASY',
    fileBackupMode: 'all_without_system',
    imageBackupMode: 'all_internal',
    fileBackupSchedule: 'daily',
    imageBackupSchedule: 'weekly',
    retentionDays: 30,
  });

  const api = async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers || {});
    headers.set('Content-Type', 'application/json');
    if (token) headers.set('Authorization', `Bearer ${token}`);
    const resp = await fetch(path, { ...init, headers });
    const text = await resp.text();
    const body = text ? JSON.parse(text) : {};
    if (!resp.ok) throw new Error(body.error || body.detail || `HTTP ${resp.status}`);
    return body as T;
  };

  async function refreshAll(nextToken = token) {
    if (!nextToken) return;
    setLoading(true);
    try {
      const headers = { Authorization: `Bearer ${nextToken}` };
      const [me, dash, machineData, backupData, alertData, policyData] = await Promise.all([
        fetch('/api/auth/me', { headers }).then((r) => r.json()),
        fetch('/api/dashboard', { headers }).then((r) => r.json()),
        fetch('/api/machines', { headers }).then((r) => r.json()),
        fetch('/api/backups', { headers }).then((r) => r.json()),
        fetch('/api/alerts', { headers }).then((r) => r.json()),
        fetch('/api/policies', { headers }).then((r) => r.json()),
      ]);
      if (me.error || me.detail) throw new Error(me.error || me.detail);
      setUser(me.user ? { name: me.user.name, email: me.user.email, role: me.user.role, tenant: me.user.tenant?.name || '-' } : null);
      setDashboard(dash);
      setMachines(machineData.machines || []);
      setJobs(backupData.jobs || []);
      setAlerts(alertData.alerts || []);
      setPolicies(policyData.policies || []);
      if (policyData.policies?.[0]) {
        const policy = policyData.policies[0];
        setPolicyForm({
          name: policy.name,
          fileBackupMode: policy.fileBackupMode,
          imageBackupMode: policy.imageBackupMode,
          fileBackupSchedule: policy.fileBackupSchedule,
          imageBackupSchedule: policy.imageBackupSchedule,
          retentionDays: policy.retentionDays,
        });
      }
      setMessage('Dados atualizados da API real.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao carregar dados.');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (token) refreshAll(token);
  }, []);

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    try {
      const path = authMode === 'login' ? '/api/auth/login' : '/api/auth/bootstrap';
      const payload = authMode === 'login'
        ? { email: authForm.email, password: authForm.password }
        : authForm;
      const body = await api<{ token?: string; user?: User; ok?: boolean }>(path, { method: 'POST', body: JSON.stringify(payload) });
      if (authMode === 'bootstrap') {
        setAuthMode('login');
        setMessage('Primeiro admin criado. Agora entre com o e-mail e senha.');
        return;
      }
      if (!body.token) throw new Error('Token nao retornado.');
      localStorage.setItem(tokenKey, body.token);
      setToken(body.token);
      setUser(body.user || null);
      await refreshAll(body.token);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha de autenticacao.');
    } finally {
      setLoading(false);
    }
  }

  async function createMachine(event: FormEvent) {
    event.preventDefault();
    try {
      await api('/api/machines', { method: 'POST', body: JSON.stringify(machineForm) });
      setMachineForm({ name: '', ip: '', os: 'Windows', group: '', company: '', urbackupClientId: '' });
      await refreshAll();
      setMessage('Maquina cadastrada.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao cadastrar maquina.');
    }
  }

  async function syncUrBackup() {
    try {
      const body = await api<{ synced: number; rawCount: number; discoveryCount?: number }>('/api/urbackup/sync-clients', {
        method: 'POST',
        body: JSON.stringify(urbackupAuth.password ? urbackupAuth : {}),
      });
      await refreshAll();
      setMessage(body.synced > 0
        ? `UrBackup sincronizado: ${body.synced} cliente(s) importado(s), ${body.rawCount} ativo(s).`
        : `UrBackup ainda nao tem cliente ativo. ${body.discoveryCount || 0} dica(s) de descoberta encontrada(s). Baixe novamente o Cliente Windows e execute como Administrador para criar o cliente personalizado.`);
      setUrbackupAuth({ username: urbackupAuth.username || 'admin', password: '' });
      setShowUrBackupAuth(false);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao sincronizar UrBackup.');
    }
  }

  async function importWindowsInventory() {
    try {
      const body = await api<{ imported: number; skipped: number; total: number }>('/api/machines/import/windows-inventory', { method: 'POST', body: '{}' });
      await refreshAll();
      setMessage(`Inventario Windows importado: ${body.imported}/${body.total} maquina(s), ${body.skipped} ignorada(s).`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao importar inventario Windows.');
    }
  }

  async function downloadUrBackupClientScript() {
    try {
      const resp = await fetch('/api/urbackup/windows-client-script', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const text = await resp.text();
      if (!resp.ok) {
        let detail = text;
        try { detail = JSON.parse(text).error || JSON.parse(text).detail || text; } catch {}
        throw new Error(detail || `HTTP ${resp.status}`);
      }
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'easy-backup-instalar-cliente-urbackup.ps1';
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMessage('Instalador do cliente baixado. Execute no Windows como Administrador.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao baixar instalador do cliente.');
    }
  }

  async function startBackup(event: FormEvent) {
    event.preventDefault();
    if (!backupForm.machineId) return setMessage('Selecione uma maquina.');
    try {
      await api('/api/backups/start', { method: 'POST', body: JSON.stringify(backupForm) });
      await refreshAll();
      setMessage('Backup solicitado ao UrBackup.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao iniciar backup.');
    }
  }

  async function startSelectedBackups() {
    if (!selectedMachines.length) return setMessage('Selecione pelo menos uma maquina na tabela.');
    if (!urbackupAuth.password) {
      setShowUrBackupAuth(true);
      return setMessage('Informe usuario e senha do UrBackup antes de iniciar backup selecionado.');
    }
    try {
      const body = await api<{ jobs: BackupJob[]; skipped: Array<{ machineId: string; name?: string; reason: string }> }>('/api/backups/start-bulk', {
        method: 'POST',
        body: JSON.stringify({ machineIds: selectedMachines, type: backupForm.type, ...urbackupAuth }),
      });
      await refreshAll();
      setUrbackupAuth({ username: urbackupAuth.username || 'admin', password: '' });
      const skippedNames = body.skipped.map((item) => item.name || item.machineId).join(', ');
      setMessage(body.skipped.length
        ? `Backup solicitado para ${body.jobs.length} maquina(s). Ignoradas: ${body.skipped.length} (${skippedNames}) por falta de vinculo UrBackup. Sincronize UrBackup primeiro.`
        : `Backup solicitado para ${body.jobs.length} maquina(s).`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao iniciar backups selecionados.');
    }
  }

  async function savePolicy() {
    try {
      const body = await api<{ policy: BackupPolicy }>('/api/policies/default', {
        method: 'POST',
        body: JSON.stringify(policyForm),
      });
      await refreshAll();
      setMessage(`Politica salva: ${body.policy.name}.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao salvar politica.');
    }
  }

  async function applyPolicy() {
    if (!selectedMachines.length) return setMessage('Selecione pelo menos uma maquina para aplicar a politica.');
    const policyId = policies[0]?.id;
    if (!policyId) return setMessage('Salve a politica EASY antes de aplicar.');
    try {
      const body = await api<{ applied: number }>('/api/policies/apply', {
        method: 'POST',
        body: JSON.stringify({ policyId, machineIds: selectedMachines }),
      });
      await refreshAll();
      setMessage(`Politica aplicada em ${body.applied} maquina(s).`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao aplicar politica.');
    }
  }

  async function applyPolicyAndRun() {
    if (!selectedMachines.length) return setMessage('Selecione pelo menos uma maquina para aplicar e iniciar.');
    if (!urbackupAuth.password) {
      setShowUrBackupAuth(true);
      return setMessage('Informe usuario e senha do UrBackup para o EASY executar a politica.');
    }
    const policyId = policies[0]?.id;
    if (!policyId) return setMessage('Salve a politica EASY antes de iniciar.');
    try {
      const body = await api<{ jobs: BackupJob[]; skipped: Array<{ machineId: string; name?: string; reason: string }> }>('/api/policies/apply-and-run', {
        method: 'POST',
        body: JSON.stringify({ policyId, machineIds: selectedMachines, ...urbackupAuth }),
      });
      await refreshAll();
      setUrbackupAuth({ username: urbackupAuth.username || 'admin', password: '' });
      const skippedNames = body.skipped.map((item) => item.name || item.machineId).join(', ');
      setMessage(body.skipped.length
        ? `Politica iniciada com ${body.jobs.length} job(s). Ignoradas: ${skippedNames}.`
        : `Politica EASY iniciada com ${body.jobs.length} job(s).`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao aplicar e iniciar politica.');
    }
  }

  async function stopSelectedBackup() {
    if (selectedMachines.length !== 1) return setMessage('Selecione exatamente uma maquina para parar o backup.');
    if (!urbackupAuth.password) {
      setShowUrBackupAuth(true);
      return setMessage('Informe usuario e senha do UrBackup antes de parar o backup.');
    }
    try {
      await api('/api/backups/stop', {
        method: 'POST',
        body: JSON.stringify({ machineId: selectedMachines[0], ...urbackupAuth }),
      });
      await refreshAll();
      setUrbackupAuth({ username: urbackupAuth.username || 'admin', password: '' });
      setMessage('Backup parado com sucesso.');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao parar backup.');
    }
  }

  function logout() {
    localStorage.removeItem(tokenKey);
    setToken('');
    setUser(null);
    setDashboard(null);
    setMachines([]);
    setJobs([]);
    setAlerts([]);
  }

  const stats = useMemo(() => [
    { label: 'Total de PCs', value: dashboard?.totalMachines ?? 0, icon: Server, tone: 'text-sky-300' },
    { label: 'Online', value: dashboard?.online ?? 0, icon: Activity, tone: 'text-emerald-300' },
    { label: 'Backup OK', value: dashboard?.backupOk ?? 0, icon: Database, tone: 'text-teal-300' },
    { label: 'Falhas', value: dashboard?.failures ?? 0, icon: AlertTriangle, tone: 'text-rose-300' },
    { label: 'Espaco usado', value: fmtBytes(dashboard?.usedBytes), icon: HardDrive, tone: 'text-indigo-300' },
  ], [dashboard]);

  if (!token) {
    return (
      <main className="min-h-screen bg-ink px-6 py-12 text-slate-100">
        <section className="mx-auto max-w-md rounded-lg border border-line bg-panel p-6">
          <div className="text-sm uppercase text-sky-300">EASY</div>
          <h1 className="mt-1 text-2xl font-bold">Backup Manager</h1>
          <p className="mt-2 text-sm text-slate-400">{message}</p>
          <form className="mt-6 space-y-4" onSubmit={submitAuth}>
            {authMode === 'bootstrap' && (
              <>
                <input className="input" placeholder="Empresa" value={authForm.tenantName} onChange={(e) => setAuthForm({ ...authForm, tenantName: e.target.value })} />
                <input className="input" placeholder="Nome" value={authForm.name} onChange={(e) => setAuthForm({ ...authForm, name: e.target.value })} />
              </>
            )}
            <input className="input" placeholder="E-mail" type="email" value={authForm.email} onChange={(e) => setAuthForm({ ...authForm, email: e.target.value })} />
            <input className="input" placeholder="Senha" type="password" value={authForm.password} onChange={(e) => setAuthForm({ ...authForm, password: e.target.value })} />
            <button className="btn-primary w-full" disabled={loading}>{authMode === 'login' ? 'Entrar' : 'Criar primeiro admin'}</button>
          </form>
          <button className="mt-4 text-sm text-sky-300" onClick={() => setAuthMode(authMode === 'login' ? 'bootstrap' : 'login')}>
            {authMode === 'login' ? 'Primeiro acesso' : 'Ja tenho conta'}
          </button>
        </section>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-ink text-slate-100">
      <div className="mx-auto flex max-w-7xl gap-6 px-6 py-6">
        <aside className="hidden w-64 shrink-0 rounded-lg border border-line bg-panel p-5 lg:block">
          <div className="text-sm uppercase text-sky-300">EASY</div>
          <div className="mt-1 text-2xl font-bold">Backup Manager</div>
          <div className="mt-4 rounded-md bg-slate-900 p-3 text-xs text-slate-300">
            <strong>{user?.name || user?.email}</strong><br />{user?.tenant} - {user?.role}
          </div>
          <nav className="mt-8 space-y-2 text-sm text-slate-300">
            {['Dashboard', 'Politica', 'Maquinas', 'Backups', 'Alertas', 'Storage', 'UrBackup'].map((item) => (
              <button key={item} onClick={() => setView(item)} className={`block w-full rounded-md px-3 py-2 text-left ${view === item ? 'bg-slate-800 text-white' : 'hover:bg-slate-800'}`}>{item}</button>
            ))}
          </nav>
          <button className="mt-6 text-sm text-slate-400 hover:text-white" onClick={logout}>Sair</button>
        </aside>

        <section className="min-w-0 flex-1">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-3xl font-bold">{view === 'Dashboard' ? 'Dashboard de backups' : view}</h1>
              <p className="mt-1 text-sm text-slate-400">Dados reais da API EASY Backup conectada ao UrBackup.</p>
            </div>
            <div className="flex gap-2">
              <button className="btn-secondary" onClick={() => refreshAll()}><RefreshCw size={18} /> Atualizar</button>
              <button className="btn-secondary" onClick={downloadUrBackupClientScript}><Download size={18} /> Cliente Windows</button>
              <button className="btn-secondary" onClick={importWindowsInventory}><Server size={18} /> Importar Windows</button>
              <button className="btn-secondary" onClick={() => setShowUrBackupAuth((value) => !value)}><ShieldCheck size={18} /> Sincronizar UrBackup</button>
            </div>
          </header>

          {showUrBackupAuth && (
            <section className="mt-4 rounded-lg border border-line bg-panel p-4">
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                <input className="input" placeholder="Usuario UrBackup" value={urbackupAuth.username} onChange={(e) => setUrbackupAuth({ ...urbackupAuth, username: e.target.value })} />
                <input className="input" placeholder="Senha UrBackup" type="password" value={urbackupAuth.password} onChange={(e) => setUrbackupAuth({ ...urbackupAuth, password: e.target.value })} />
                <button className="btn-primary" onClick={syncUrBackup}><ShieldCheck size={18} /> Sincronizar</button>
              </div>
              <p className="mt-2 text-xs text-slate-400">A senha e usada somente para sincronizar ou iniciar backup e nao e salva no navegador.</p>
            </section>
          )}

          <div className="mt-4 rounded-md border border-line bg-slate-900 p-3 text-sm text-slate-300">{loading ? 'Carregando...' : message}</div>

          <div className={`mt-6 grid gap-4 md:grid-cols-5 ${view === 'Dashboard' ? '' : 'hidden'}`}>
            {stats.map(({ label, value, icon: Icon, tone }) => (
              <div key={label} className="rounded-lg border border-line bg-panel p-4">
                <div className={`mb-4 ${tone}`}><Icon size={22} /></div>
                <div className="text-2xl font-bold">{value}</div>
                <div className="text-sm text-slate-400">{label}</div>
              </div>
            ))}
          </div>

          <div className={`mt-6 grid gap-4 ${view === 'Dashboard' ? '' : 'hidden'}`}>
            <section className="rounded-lg border border-line bg-panel p-5">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Maquinas protegidas</h2>
                <span className="text-sm text-slate-400">{machines.length} endpoint(s)</span>
              </div>
              <div className="mb-4 flex flex-wrap items-center gap-2">
                <select className="input max-w-xs" value={backupForm.type} onChange={(e) => setBackupForm({ ...backupForm, type: e.target.value })}>
                  <option value="incremental_file">Arquivos incremental</option>
                  <option value="full_file">Arquivos completo</option>
                  <option value="incremental_image">Imagem incremental</option>
                  <option value="full_image">Imagem completa</option>
                </select>
                <button className="btn-primary" onClick={startSelectedBackups}><PlayCircle size={18} /> Backup selecionados</button>
                <button className="btn-secondary" onClick={stopSelectedBackup}>Parar</button>
                <span className="text-sm text-slate-400">{selectedMachines.length} selecionada(s)</span>
              </div>
              <MachineTable machines={machines} selectedIds={selectedMachines} onSelectionChange={setSelectedMachines} />
            </section>
          </div>

          <section className={`mt-6 rounded-lg border border-line bg-panel p-5 ${view === 'Politica' || view === 'Dashboard' ? '' : 'hidden'}`}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-semibold">Politica EASY Backup</h2>
                <p className="mt-1 text-sm text-slate-400">Padrao operacional para nao depender da tela do UrBackup.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <button className="btn-secondary" onClick={savePolicy}>Salvar politica</button>
                <button className="btn-secondary" onClick={applyPolicy}>Aplicar selecionadas</button>
                <button className="btn-primary" onClick={applyPolicyAndRun}><PlayCircle size={18} /> Aplicar e iniciar</button>
              </div>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm text-slate-300">
                <span>Nome</span>
                <input className="input" value={policyForm.name} onChange={(e) => setPolicyForm({ ...policyForm, name: e.target.value })} />
              </label>
              <label className="space-y-1 text-sm text-slate-300">
                <span>Arquivos</span>
                <select className="input" value={policyForm.fileBackupMode} onChange={(e) => setPolicyForm({ ...policyForm, fileBackupMode: e.target.value })}>
                  <option value="all_without_system">Todos, exceto sistema/cache</option>
                  <option value="user_profiles">Perfis dos usuarios</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              <label className="space-y-1 text-sm text-slate-300">
                <span>Imagem</span>
                <select className="input" value={policyForm.imageBackupMode} onChange={(e) => setPolicyForm({ ...policyForm, imageBackupMode: e.target.value })}>
                  <option value="all_internal">Todos os volumes internos</option>
                  <option value="system_volume">Volume do sistema</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              <label className="space-y-1 text-sm text-slate-300">
                <span>Backup de arquivos</span>
                <select className="input" value={policyForm.fileBackupSchedule} onChange={(e) => setPolicyForm({ ...policyForm, fileBackupSchedule: e.target.value })}>
                  <option value="daily">Diario</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              <label className="space-y-1 text-sm text-slate-300">
                <span>Imagem completa</span>
                <select className="input" value={policyForm.imageBackupSchedule} onChange={(e) => setPolicyForm({ ...policyForm, imageBackupSchedule: e.target.value })}>
                  <option value="weekly">Semanal</option>
                  <option value="manual">Manual</option>
                </select>
              </label>
              <label className="space-y-1 text-sm text-slate-300">
                <span>Retencao</span>
                <input className="input" type="number" min="1" max="365" value={policyForm.retentionDays} onChange={(e) => setPolicyForm({ ...policyForm, retentionDays: Number(e.target.value) })} />
              </label>
            </div>
            <p className="mt-3 text-xs text-slate-400">Nesta etapa o EASY Backup salva a politica, vincula nas maquinas e dispara os jobs no UrBackup. Agendamento automatico continuo entra na proxima rodada.</p>
          </section>

          <div className={`mt-6 grid gap-4 lg:grid-cols-2 ${view === 'Maquinas' || view === 'Backups' ? '' : 'hidden'}`}>
            <form className={`rounded-lg border border-line bg-panel p-5 ${view === 'Maquinas' ? '' : 'hidden'}`} onSubmit={createMachine}>
              <h2 className="text-lg font-semibold">Cadastrar maquina</h2>
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <input className="input" placeholder="Nome" value={machineForm.name} onChange={(e) => setMachineForm({ ...machineForm, name: e.target.value })} />
                <input className="input" placeholder="IP" value={machineForm.ip} onChange={(e) => setMachineForm({ ...machineForm, ip: e.target.value })} />
                <input className="input" placeholder="Sistema" value={machineForm.os} onChange={(e) => setMachineForm({ ...machineForm, os: e.target.value })} />
                <input className="input" placeholder="Grupo" value={machineForm.group} onChange={(e) => setMachineForm({ ...machineForm, group: e.target.value })} />
                <input className="input" placeholder="Empresa" value={machineForm.company} onChange={(e) => setMachineForm({ ...machineForm, company: e.target.value })} />
                <input className="input" placeholder="ID cliente UrBackup (opcional)" value={machineForm.urbackupClientId} onChange={(e) => setMachineForm({ ...machineForm, urbackupClientId: e.target.value })} />
              </div>
              <button className="btn-primary mt-4">Cadastrar</button>
              <p className="mt-3 text-sm text-slate-400">Para popular automaticamente, use Importar Windows. Para disparar backup, a maquina precisa ter o UrBackup Client instalado e sincronizado.</p>
            </form>

            <form className={`rounded-lg border border-line bg-panel p-5 ${view === 'Backups' ? '' : 'hidden'}`} onSubmit={startBackup}>
              <h2 className="text-lg font-semibold">Iniciar backup</h2>
              <div className="mt-4 grid gap-3">
                <select className="input" value={backupForm.machineId} onChange={(e) => setBackupForm({ ...backupForm, machineId: e.target.value })}>
                  <option value="">Selecione a maquina...</option>
                  {machines.map((machine) => <option key={machine.id} value={machine.id}>{machine.name} {machine.urbackupClientId ? '' : '(sem UrBackup ID)'}</option>)}
                </select>
                <select className="input" value={backupForm.type} onChange={(e) => setBackupForm({ ...backupForm, type: e.target.value })}>
                  <option value="incremental_file">Arquivos incremental</option>
                  <option value="full_file">Arquivos completo</option>
                  <option value="incremental_image">Imagem incremental</option>
                  <option value="full_image">Imagem completa</option>
                </select>
              </div>
              <button className="btn-primary mt-4"><PlayCircle size={18} /> Iniciar backup</button>
            </form>
          </div>

          <section className="mt-6 rounded-lg border border-line bg-panel p-5">
            <h2 className="text-lg font-semibold">{view}</h2>
            {view === 'Backups' && <JobList jobs={jobs} />}
            {view === 'Alertas' && <AlertList alerts={alerts} />}
            {view === 'Maquinas' && <div className="mt-3"><MachineTable machines={machines} selectedIds={selectedMachines} onSelectionChange={setSelectedMachines} /></div>}
            {view === 'Storage' && <p className="mt-3 text-slate-300">Usado: {fmtBytes(dashboard?.usedBytes)} de {fmtBytes(dashboard?.totalBytes)}. Targets planejados: local, NAS e S3.</p>}
            {view === 'UrBackup' && (
              <div className="mt-3 space-y-3 text-slate-300">
                <p>Engine em <a className="text-sky-300 underline" href="/urbackup/" target="_blank">/urbackup/</a>. Use “Sincronizar UrBackup” para importar clientes detectados.</p>
                <button className="btn-primary" onClick={downloadUrBackupClientScript}><Download size={18} /> Baixar instalador Windows</button>
                <p className="text-sm text-slate-400">Execute o PowerShell baixado como Administrador no computador que sera protegido.</p>
              </div>
            )}
            {view === 'Dashboard' && <p className="mt-3 text-slate-300">Use os cards e a tabela acima para acompanhar a operacao.</p>}
          </section>
        </section>
      </div>
    </main>
  );
}

function MachineTable({
  machines,
  selectedIds = [],
  onSelectionChange,
}: {
  machines: Machine[];
  selectedIds?: string[];
  onSelectionChange?: (ids: string[]) => void;
}) {
  if (!machines.length) return <div className="rounded-md border border-dashed border-line p-6 text-slate-400">Nenhuma maquina cadastrada. Sincronize o UrBackup ou cadastre manualmente.</div>;
  const selectable = !!onSelectionChange;
  const selected = new Set(selectedIds);
  const toggle = (id: string) => {
    if (!onSelectionChange) return;
    onSelectionChange(selected.has(id) ? selectedIds.filter((item) => item !== id) : [...selectedIds, id]);
  };
  const toggleAll = () => {
    if (!onSelectionChange) return;
    onSelectionChange(selectedIds.length === machines.length ? [] : machines.map((machine) => machine.id));
  };
  return (
    <div className="overflow-auto rounded-md border border-line">
      <table className="w-full min-w-[820px] text-left text-sm text-slate-200">
        <thead className="bg-slate-900 text-slate-300">
          <tr>
            {selectable && <th className="p-3"><input type="checkbox" checked={selectedIds.length === machines.length} onChange={toggleAll} /></th>}
            <th className={selectable ? '' : 'p-3'}>Nome</th><th>IP</th><th>Sistema</th><th>Status</th><th>Backup</th><th>Ultimo</th><th>Grupo</th><th>UrBackup</th>
          </tr>
        </thead>
        <tbody>
          {machines.map((m) => (
            <tr key={m.id} className="border-t border-line">
              {selectable && <td className="p-3"><input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} /></td>}
              <td className={selectable ? 'font-medium text-white' : 'p-3 font-medium text-white'}>{m.name}</td><td>{m.ip || '-'}</td><td>{m.os || '-'}</td>
              <td><span className={statusClass(m.status)}>{m.status}</span></td>
              <td><span className={statusClass(m.backupStatus)}>{m.backupStatus}</span></td>
              <td>{fmtDate(m.lastBackupAt)}</td><td>{m.group || '-'}</td><td>{m.urbackupClientId || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobList({ jobs }: { jobs: BackupJob[] }) {
  if (!jobs.length) return <p className="mt-3 text-slate-400">Nenhum job registrado ainda.</p>;
  return <div className="mt-3 space-y-2">{jobs.slice(0, 8).map((job) => <div className="rounded-md bg-slate-900 p-3 text-sm" key={job.id}>{job.machine?.name || 'Maquina'} - {job.type} - <span className={statusClass(job.status)}>{job.status}</span> - {fmtDate(job.createdAt)}</div>)}</div>;
}

function AlertList({ alerts }: { alerts: Alert[] }) {
  if (!alerts.length) return <p className="mt-3 text-slate-400">Nenhum alerta registrado.</p>;
  return <div className="mt-3 space-y-2">{alerts.slice(0, 8).map((alert) => <div className="rounded-md bg-slate-900 p-3 text-sm" key={alert.id}><strong>{alert.title}</strong><br />{alert.message}</div>)}</div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
