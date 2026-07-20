/* 
   SightOps  Frontend SPA
    */

// O login nao pode depender do CDN de icones. Se o Lucide falhar, a UI segue viva.
window.lucide = window.lucide || { createIcons() {} };

//  Estado global 
let _token = null;
let _currentView = 'dashboard';
let _scanWs = null;
let _camAuthAction = null;

//  Helpers HTTP 
async function api(path, opts = {}) {
  const { skipLogout, ...fetchOpts } = opts;
  const headers = { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...fetchOpts, headers });
  if (res.status === 401 && !skipLogout) {
    _token = null;
    try { localStorage.removeItem('so_token'); } catch {}
    showLoginScreen();
    return null;
  }
  return res;
}

async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  if (!res || !res.ok) return null;
  return res.json();
}

async function jsonOrReadableError(res, fallback = 'Erro na requisicao.') {
  if (!res) throw new Error(fallback);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    const clean = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
    throw new Error(clean ? `Servidor retornou resposta inesperada: ${clean}` : fallback);
  }
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.detail || data?.error || data?.msg || data?.message || fallback);
  }
  return data;
}

//  Confirmacao customizada 
function showConfirm({ eyebrow = 'Confirmar', title = 'Tem certeza?', msg, label = 'Confirmar', danger = true } = {}) {
  return new Promise(resolve => {
    document.getElementById('confirmEyebrow').textContent = eyebrow;
    document.getElementById('confirmTitle').textContent   = title;
    document.getElementById('confirmMsg').textContent     = msg || '';
    const btn = document.getElementById('confirmOk');
    btn.innerHTML = `<i data-lucide="${danger ? 'trash-2' : 'check'}"></i> ${label}`;
    btn.style.background = danger ? 'var(--danger)' : 'var(--primary)';
    document.getElementById('modalConfirm').classList.remove('hidden');
    lucide.createIcons();

    const ok  = document.getElementById('confirmOk');
    const can = document.getElementById('confirmCancel');
    const close = (val) => {
      document.getElementById('modalConfirm').classList.add('hidden');
      ok.replaceWith(ok.cloneNode(true));
      can.replaceWith(can.cloneNode(true));
      resolve(val);
    };
    document.getElementById('confirmOk').addEventListener('click', () => close(true));
    document.getElementById('confirmCancel').addEventListener('click', () => close(false));
  });
}

//  Toast 
let _toastTimer;
function showToast(msg, isError = false) {
  const el = document.getElementById('toast');
  const span = document.getElementById('toastMsg');
  span.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

window.addEventListener('error', (event) => {
  console.error('[SightOps UI]', event.error || event.message);
  if (_token) showToast(event.message || 'Erro na interface.', true);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  console.error('[SightOps UI promise]', reason);
  if (_token) showToast(reason?.message || 'Acao falhou na interface.', true);
});

//  Auth 
async function login(user, pass) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, msg: err.detail || 'Credenciais invalidas' };
  }
  const data = await res.json();
  _token = data.access_token || data.token || null;
  try { localStorage.removeItem('so_token'); } catch {}
  const me = await fetch(`${API_BASE}/api/auth/me`, { credentials: 'same-origin' });
  if (me.ok) return { ok: true };
  return { ok: false, msg: 'Sessao nao confirmada apos login' };
}

function logout() {
  api('/api/auth/logout', { method: 'POST', skipLogout: true }).catch(() => {});
  _token = null;
  try { localStorage.removeItem('so_token'); } catch {}
  showLoginScreen();
}

async function loadProfile() {
  const data = await apiJson('/api/auth/me');
  if (!data) return;
  const user = data.user || data;
  const name = user.full_name || user.username || user.email || '?';
  const role = user.role || user.perfil || '';
  document.getElementById('profileName').textContent = name;
  document.getElementById('profileRole').textContent = role;
  document.getElementById('profileAvatar').textContent = name[0].toUpperCase();
}

//  Telas 
function showLoginScreen() {
  document.getElementById('loginScreen').removeAttribute('hidden');
  document.getElementById('appShell').setAttribute('hidden', '');
  document.getElementById('loginError').hidden = true;
  document.getElementById('loginUser').value = '';
  document.getElementById('loginPassword').value = '';
}

function showApp() {
  document.getElementById('loginScreen').setAttribute('hidden', '');
  document.getElementById('appShell').removeAttribute('hidden');
  loadProfile();
  navigateTo('dashboard');
  lucide.createIcons();
}

//  Navegacao 
const VIEW_META = {
  dashboard:       { title: 'Dashboard',        sub: 'Visao geral do parque' },
  'inv-olt':       { title: 'Cameras IP', sub: 'Varredura, filtros e casamento OLT/Switch' },
  'inv-switch':    { title: 'Cameras IP  Switch', sub: 'Cameras via switch gerenciavel' },
  'inv-dvr':       { title: 'Inventario  DVR',  sub: 'Gravadores DVR' },
  'inv-nvr':       { title: 'Gravadores', sub: 'Canais NVR com cameras associadas' },
  'inv-windows':   { title: 'Inventario - Windows', sub: 'Hosts Windows' },
  'snap-cam':      { title: 'Snapshots  Cameras', sub: 'Fotos das cameras IP' },
  'snap-dvr':      { title: 'Snapshots  DVR',   sub: 'Fotos dos canais DVR' },
  'snap-nvr':      { title: 'Snapshots  NVR',   sub: 'Fotos dos canais NVR' },
  'mnt-cam':       { title: 'Manutencao  Cameras', sub: 'Operacoes em lote' },
  'mnt-nvr':       { title: 'Manutencao - Gravadores',  sub: 'Operacoes em lote' },
  playback:        { title: 'Reproducao',       sub: 'Busca de gravacoes por DVR' },
  'ia-nvr':        { title: 'IA  NVR',          sub: 'Indexacao e busca inteligente' },
  'net-devices':   { title: 'Redes - Dispositivos', sub: 'Dispositivos monitorados' },
  'net-learn':     { title: 'Redes - Aprendizado', sub: '' },
  'net-operate':   { title: 'Redes - Operacoes',  sub: '' },
  'deploy-onu':    { title: 'Implantacao - ONU', sub: 'Provisionamento em campo' },
  'deploy-recorder': { title: 'Implantacao - Gravadores', sub: 'Cadastro de DVR/NVR' },
  'deploy-new':    { title: 'Implantacao - CFTV', sub: 'Assistente de campo' },
  olt:             { title: 'OLT',               sub: 'Coleta de MACs da OLT' },
  switch:          { title: 'Switch',            sub: 'Coleta de MACs do switch' },
  kmz:             { title: 'KMZ  Mapa',        sub: 'Localizacao das cameras' },
  'script-grafana':{ title: 'Scripts  Grafana', sub: '' },
  'script-zabbix': { title: 'Scripts  Zabbix',  sub: '' },
  connectors:      { title: 'Conectores',       sub: 'MikroTik RouterOS dos clientes' },
  tools:           { title: 'Ferramentas',       sub: '' },
  backup:          { title: 'Backup',            sub: 'Exportacao e importacao' },
  settings:        { title: 'Configuracoes',     sub: '' },
};

const VIEW_ID_MAP = {
  dashboard:        'viewDashboard',
  'inv-olt':        'viewInvOlt',
  'inv-switch':     'viewInvOlt',
  'inv-dvr':        'viewInvDvr',
  'inv-nvr':        'viewInvNvr',
  'inv-windows':    'viewInvWindows',
  'snap-cam':       'viewSnapCam',
  'snap-dvr':       'viewSnapDvr',
  'snap-nvr':       'viewSnapNvr',
  'mnt-cam':        'viewMntCam',
  'mnt-nvr':        'viewMntNvr',
  playback:         'viewPlayback',
  'ia-nvr':         'viewIaNvr',
  'net-devices':    'viewNetDevices',
  'net-learn':      'viewNetLearn',
  'net-operate':    'viewNetOperate',
  'deploy-onu':     'viewDeployOnu',
  'deploy-recorder':'viewDeployRecorder',
  'deploy-new':     'viewDeployNew',
  olt:              'viewOlt',
  switch:           'viewSwitch',
  kmz:              'viewKmz',
  'script-grafana': 'viewScriptGrafana',
  'script-zabbix':  'viewScriptZabbix',
  connectors:       'viewConnectors',
  tools:            'viewTools',
  backup:           'viewBackup',
  settings:         'viewSettings',
};

function navigateTo(view) {
  // Esconde todas as views
  document.querySelectorAll('[id^="view"]').forEach(el => el.classList.add('hidden'));

  // Mostra a view alvo
  const targetId = VIEW_ID_MAP[view];
  if (targetId) {
    const el = document.getElementById(targetId);
    if (el) el.classList.remove('hidden');
  }

  // Atualiza nav items
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  // Atualiza topbar
  const meta = VIEW_META[view] || { title: view, sub: '' };
  document.getElementById('topbarContext').querySelector('strong').textContent = meta.title;
  document.getElementById('topbarContext').querySelector('span').textContent = meta.sub;

  _currentView = view;

  // Fecha sidebar no mobile
  closeSidebar();

  // Carrega dados da view
  loadView(view);
}

function loadView(view) {
  switch (view) {
    case 'dashboard':   loadDashboard();    break;
    case 'inv-olt':     loadInvOlt();       break;
    case 'inv-switch':  setInvOltView('switch'); loadInvOlt(); break;
    case 'inv-dvr':     loadInvDvr();       break;
    case 'inv-nvr':     loadInvNvr();       break;
    case 'inv-windows': loadInvWindows();   break;
    case 'snap-cam':    loadSnapCam();      break;
    case 'snap-dvr':    loadSnapDvr();      break;
    case 'snap-nvr':    loadSnapNvr();      break;
    case 'mnt-cam':     loadMntCam();       break;
    case 'mnt-nvr':     loadMntNvr();       break;
    case 'playback':    loadPlayback();     break;
    case 'ia-nvr':      loadIaNvr();        break;
    case 'olt':         loadOlt();          break;
    case 'switch':      loadSwitch();       break;
    case 'kmz':         loadKmz();          break;
    case 'backup':      loadBackup();       break;
    case 'net-devices': loadNetDevices();   break;
    case 'net-learn':   loadStaticView();   break;
    case 'net-operate': loadNetOperate();   break;
    case 'deploy-onu':  loadDeployOnu();    break;
    case 'deploy-recorder': loadDeployRecorder(); break;
    case 'deploy-new':  loadDeployNew();    break;
    case 'connectors':  loadConnectors();   break;
    case 'script-grafana': loadScriptGrafana(); break;
    case 'script-zabbix':  loadScriptZabbix();  break;
    case 'tools':
    case 'settings':
      if (view === 'settings') loadSettings();
      else loadStaticView();
      break;
    default:
      loadStaticView();
      break;
  }
  scheduleResponsiveHydration();
}

let _responsiveHydrationQueued = false;
function scheduleResponsiveHydration(root = document) {
  if (_responsiveHydrationQueued) return;
  _responsiveHydrationQueued = true;
  requestAnimationFrame(() => {
    _responsiveHydrationQueued = false;
    hydrateResponsiveTables(root);
  });
}

function hydrateResponsiveTables(root = document) {
  const scope = root && root.querySelectorAll ? root : document;
  scope.querySelectorAll('table').forEach(table => {
    if (table.closest('.leaflet-container')) return;
    const headers = [...table.querySelectorAll('thead th')].map(th =>
      (th.textContent || '').replace(/\s+/g, ' ').trim()
    );
    if (!headers.length) return;
    table.classList.add('responsive-data-table');
    table.querySelectorAll('tbody tr').forEach(row => {
      row.querySelectorAll('td').forEach((td, idx) => {
        if (!td.dataset.label) td.dataset.label = headers[idx] || '';
      });
    });
  });
}

function loadStaticView() {
  lucide.createIcons();
}

async function loadSettings() {
  const [me, tenants, users, authStatus, dbStatus] = await Promise.all([
    apiJson('/api/auth/me'),
    apiJson('/api/auth/tenants'),
    apiJson('/api/auth/users'),
    apiJson('/api/auth/status'),
    apiJson('/api/db/status'),
  ]);
  const currentUser = me?.user || {};
  const tenantRows = tenants?.tenants || [];
  const userRows = users?.users || [];

  setText('settingsTenantsSummary', `${tenantRows.length} cliente${tenantRows.length === 1 ? '' : 's'} cadastrado${tenantRows.length === 1 ? '' : 's'}.`);
  const tenantsBody = document.getElementById('settingsTenantsBody');
  if (tenantsBody) {
    tenantsBody.innerHTML = tenantRows.length ? tenantRows.map(t => `
      <tr>
        <td><strong>${esc(t.name || '')}</strong></td>
        <td><span class="monospace">${esc(t.slug || '')}</span></td>
        <td>${Number(t.active) ? '<span class="badge badge-green">Ativo</span>' : '<span class="badge badge-red">Inativo</span>'}</td>
        <td>${esc(t.users ?? 0)}</td>
        <td><span class="text-muted">${esc(formatDateTimeShort(t.created_at || ''))}</span></td>
      </tr>
    `).join('') : '<tr class="empty-row"><td colspan="5">Nenhum cliente cadastrado.</td></tr>';
  }

  setText('settingsUsersSummary', `${userRows.length} usuario${userRows.length === 1 ? '' : 's'} no cliente atual (${currentUser.tenant_name || currentUser.tenant_slug || '-'}).`);
  const usersBody = document.getElementById('settingsUsersBody');
  if (usersBody) {
    usersBody.innerHTML = userRows.length ? userRows.map(u => `
      <tr>
        <td><strong>${esc(u.username || '')}</strong></td>
        <td>${esc(u.full_name || '-')}</td>
        <td><span class="badge badge-gray">${esc(u.role || '')}</span></td>
        <td>${Number(u.active) ? '<span class="badge badge-green">Ativo</span>' : '<span class="badge badge-red">Inativo</span>'}</td>
        <td>${esc(u.tenant_name || u.tenant_slug || '')}</td>
      </tr>
    `).join('') : '<tr class="empty-row"><td colspan="5">Nenhum usuario cadastrado.</td></tr>';
  }

  const storage = document.getElementById('settingsStorageStatus');
  if (storage) {
    const auth = authStatus?.storage || authStatus || {};
    const db = dbStatus || {};
    storage.innerHTML = [
      ['Auth backend', auth.backend || '-'],
      ['Tenants', auth.tenants ?? '-'],
      ['Usuarios', auth.users ?? '-'],
      ['Tokens ativos', auth.active_tokens ?? '-'],
      ['DB backend', db.backend || '-'],
      ['Sites', db.sites ?? '-'],
      ['Auth required', authStatus?.auth_required ? 'sim' : 'nao'],
      ['Legacy open', authStatus?.legacy_open ? 'sim' : 'nao'],
    ].map(([label, value]) => `<div class="settings-status-card"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`).join('');
  }

  scheduleResponsiveHydration(document.getElementById('viewSettings'));
  lucide.createIcons();
}

async function createTenantFromSettings() {
  const name = document.getElementById('tenantName')?.value.trim() || '';
  const slug = document.getElementById('tenantSlug')?.value.trim() || '';
  const owner_username = document.getElementById('tenantOwnerUser')?.value.trim() || '';
  const owner_password = document.getElementById('tenantOwnerPass')?.value || '';
  if (!name) {
    showToast('Informe o nome do cliente.', true);
    return;
  }
  const res = await api('/api/auth/tenants', {
    method: 'POST',
    body: JSON.stringify({ name, slug, owner_username, owner_password }),
  });
  if (!res?.ok) {
    const err = await res?.json().catch(() => ({}));
    showToast(err?.detail || 'Nao foi possivel criar o cliente.', true);
    return;
  }
  ['tenantName', 'tenantSlug', 'tenantOwnerUser', 'tenantOwnerPass'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  showToast('Cliente criado.');
  loadSettings();
}

async function createUserFromSettings() {
  const username = document.getElementById('newUserName')?.value.trim() || '';
  const password = document.getElementById('newUserPass')?.value || '';
  const role = document.getElementById('newUserRole')?.value || 'viewer';
  const full_name = document.getElementById('newUserFullName')?.value.trim() || '';
  if (!username || !password) {
    showToast('Informe usuario e senha.', true);
    return;
  }
  const res = await api('/api/auth/users', {
    method: 'POST',
    body: JSON.stringify({ username, password, role, full_name }),
  });
  if (!res?.ok) {
    const err = await res?.json().catch(() => ({}));
    showToast(err?.detail || 'Nao foi possivel criar o usuario.', true);
    return;
  }
  ['newUserName', 'newUserPass', 'newUserFullName'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  showToast('Usuario criado.');
  loadSettings();
}

function loadScriptGrafana() {
  const log = document.getElementById('grafanaLog');
  if (log && !log.textContent.trim()) log.textContent = 'Aguardando configuracao.';
  lucide.createIcons();
}

function loadScriptZabbix() {
  const source = document.getElementById('zbxSource');
  if (source) source.dispatchEvent(new Event('change'));
  const log = document.getElementById('zabbixLog');
  if (log && !log.textContent.trim()) log.textContent = 'Aguardando configuracao.';
  lucide.createIcons();
}

//  Sidebar mobile 
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('mobileBackdrop').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mobileBackdrop').classList.remove('open');
}

//  Dashboard 
//  Dashboard Drawer 
let _dashDrawerData = null;

function _openDashDrawer(eyebrow, title) {
  document.getElementById('dashDrawerEyebrow').textContent = eyebrow;
  document.getElementById('dashDrawerTitle').textContent = title;
  document.getElementById('dashDrawerBody').innerHTML = '<div style="padding:32px 20px;text-align:center;color:var(--muted);font-size:13px">Carregando</div>';
  document.getElementById('dashDrawerFilters').innerHTML = '';
  const drawer  = document.getElementById('dashDrawer');
  const overlay = document.getElementById('dashDrawerOverlay');
  drawer.classList.remove('hidden');
  overlay.classList.remove('hidden');
  requestAnimationFrame(() => requestAnimationFrame(() => drawer.classList.add('open')));
  lucide.createIcons();
}

function closeDashDrawer() {
  const drawer  = document.getElementById('dashDrawer');
  const overlay = document.getElementById('dashDrawerOverlay');
  drawer.classList.remove('open');
  setTimeout(() => { drawer.classList.add('hidden'); overlay.classList.add('hidden'); }, 270);
}

function _drawerGoToInventory(view, searchValue, camMode) {
  closeDashDrawer();
  if (view === 'inv-olt' && searchValue) {
    _pendingOpenCamIp = searchValue;
  }
  setTimeout(() => {
    navigateTo(view);
    if (view === 'inv-olt' && camMode) {
      setTimeout(() => setInvOltView(camMode), 120);
    }
    if (searchValue && view !== 'inv-olt') {
      setTimeout(() => {
        const inputMap = { 'inv-dvr': 'searchInvDvr', 'inv-nvr': 'searchInvNvr' };
        const inp = document.getElementById(inputMap[view]);
        if (inp) inp.value = searchValue;
      }, 300);
    }
  }, 150);
}

function _drawerStatusDot(status) {
  const s = (status || '').toLowerCase();
  const online  = ['online','ok','up','ativo','active'].includes(s);
  const offline = ['offline','down','inativo','inactive','auth_failed','timeout','erro','error'].includes(s);
  const color = online ? 'var(--primary)' : offline ? 'var(--danger)' : 'var(--muted)';
  return `<span style="width:8px;height:8px;border-radius:50%;background:${color};flex-shrink:0;display:inline-block"></span>`;
}
