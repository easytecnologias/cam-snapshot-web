/* 
   SightOps  Frontend SPA
    */

// O login nao pode depender do CDN de icones. Se o Lucide falhar, a UI segue viva.
window.lucide = window.lucide || { createIcons() {} };

//  Estado global 
let _token = localStorage.getItem('so_token') || null;
let _currentView = 'dashboard';
let _scanWs = null;
let _camAuthAction = null;

//  Helpers HTTP 
async function api(path, opts = {}) {
  const { skipLogout, ...fetchOpts } = opts;
  const headers = { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...fetchOpts, headers });
  if (res.status === 401 && !skipLogout) { logout(); return null; }
  return res;
}

async function apiJson(path, opts = {}) {
  const res = await api(path, opts);
  if (!res || !res.ok) return null;
  return res.json();
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, msg: err.detail || 'Credenciais invalidas' };
  }
  const data = await res.json();
  _token = data.access_token || data.token || null;
  if (_token) {
    localStorage.setItem('so_token', _token);
    return { ok: true };
  }
  return { ok: false, msg: 'Token nao recebido' };
}

function logout() {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  _token = null;
  localStorage.removeItem('so_token');
  showLoginScreen();
}

async function loadProfile() {
  const data = await apiJson('/api/auth/me');
  if (!data) return;
  const name = data.name || data.username || data.email || '?';
  const role = data.role || data.perfil || '';
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
    case 'deploy-new':  loadDeployNew();    break;
    case 'connectors':  loadConnectors();   break;
    case 'script-grafana': loadScriptGrafana(); break;
    case 'script-zabbix':  loadScriptZabbix();  break;
    case 'tools':
    case 'settings':
      loadStaticView();
      break;
    default:
      loadStaticView();
      break;
  }
}

function loadStaticView() {
  lucide.createIcons();
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

function _drawerFilterBar(statusFilters, activeStatusKey, sites, activeSite, onStatusSelect, onSiteSelect) {
  const el = document.getElementById('dashDrawerFilters');
  const statusHtml = `<div class="drawer-filter-row">` +
    statusFilters.map(f =>
      `<button class="drawer-filter-btn${f.key === activeStatusKey ? ' active' : ''}" data-filter="${f.key}">${f.label}${f.count != null ? ` (${f.count})` : ''}</button>`
    ).join('') + `</div>`;
  const siteHtml = sites.length > 1
    ? `<hr class="drawer-filter-sep"><div class="drawer-filter-row">` +
      [`<button class="drawer-filter-btn${!activeSite ? ' active' : ''}" data-site="">Todos os sites</button>`,
       ...sites.map(s => `<button class="drawer-filter-btn${s === activeSite ? ' active' : ''}" data-site="${esc(s)}">${esc(s)}</button>`)
      ].join('') + `</div>`
    : '';
  el.innerHTML = statusHtml + siteHtml;
  el.querySelectorAll('.drawer-filter-btn[data-filter]').forEach(btn => btn.addEventListener('click', () => onStatusSelect(btn.dataset.filter)));
  el.querySelectorAll('.drawer-filter-btn[data-site]').forEach(btn => btn.addEventListener('click', () => onSiteSelect(btn.dataset.site || null)));
}

function _drawerRenderRows(html) {
  document.getElementById('dashDrawerBody').innerHTML = html || '<div style="padding:32px 20px;text-align:center;color:var(--muted);font-size:13px">Nenhum item encontrado.</div>';
  lucide.createIcons();
}

async function openDashDrawerIp(filterKey, activeSite) {
  filterKey  = filterKey  || 'all';
  activeSite = activeSite || null;
  _openDashDrawer('Inventario', 'Cameras IP');
  if (!_dashDrawerData?.ip) {
    const [basicRes, oltRes, switchRes] = await Promise.all([
      apiJson('/api/cameras?mode=basico').catch(() => ({ cameras: [] })),
      apiJson('/api/cameras?mode=olt').catch(() => ({ cameras: [] })),
      apiJson('/api/cameras?mode=switch').catch(() => ({ cameras: [] })),
    ]);
    if (!_dashDrawerData) _dashDrawerData = {};
    _dashDrawerData.ip = [
      ...(basicRes?.cameras || []).map(r => ({ ...r, _dashMode: 'basico' })),
      ...(oltRes?.cameras || []).map(r => ({ ...r, _dashMode: 'olt' })),
      ...(switchRes?.cameras || []).map(r => ({ ...r, _dashMode: 'switch' })),
    ];
  }
  const rows = _dashDrawerData.ip;
  const isOnline  = r => ['online','ok','up','ativo','active'].includes((r.status||'').toLowerCase());
  const isOffline = r => ['offline','down','inativo','inactive','auth_failed','timeout','erro','error'].includes((r.status||'').toLowerCase());
  const noSnap    = r => !r.snapshot_url && !r.imgbb_url;

  const sites = [...new Set(rows.map(r => r.local || '').filter(Boolean))].sort((a,b) => a.localeCompare(b,'pt'));
  const counts = { all: rows.length, online: rows.filter(isOnline).length, offline: rows.filter(isOffline).length, no_snap: rows.filter(noSnap).length };

  _drawerFilterBar(
    [{ key:'all', label:'Todos', count:counts.all }, { key:'online', label:' Online', count:counts.online },
     { key:'offline', label:' Offline', count:counts.offline }, { key:'no_snap', label:'Sem snapshot', count:counts.no_snap }],
    filterKey, sites, activeSite,
    k => openDashDrawerIp(k, activeSite),
    s => openDashDrawerIp(filterKey, s)
  );

  let filtered = rows;
  if (filterKey === 'online')  filtered = filtered.filter(isOnline);
  if (filterKey === 'offline') filtered = filtered.filter(isOffline);
  if (filterKey === 'no_snap') filtered = filtered.filter(noSnap);
  if (activeSite) filtered = filtered.filter(r => (r.local||'') === activeSite);

  filtered.sort((a, b) => (a.titulo || a.ip || '').localeCompare(b.titulo || b.ip || '', 'pt', { numeric: true }));
  _drawerRenderRows(filtered.map(r => {
    const ip = esc(r.ip || '');
    const view = r._dashMode === 'switch' ? 'inv-switch' : 'inv-olt';
    return `<div class="drawer-item" style="cursor:pointer" onclick="_drawerGoToInventory('${view}','${ip}','${esc(r._dashMode || 'olt')}')" title="Abrir no inventario">
      ${_drawerStatusDot(r.status)}
      <div class="drawer-item-main">
        <div class="drawer-item-title">${esc(r.titulo || r.ip || '')}</div>
        <div class="drawer-item-sub">${esc(r.ip)}  ${esc(r.local || '')}  ${esc(r.modelo || r.model || '')}</div>
      </div>
      ${r.snapshot_url ? `<img src="${esc(r.snapshot_url)}" style="width:52px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0" loading="lazy">` : '<span style="width:52px;flex-shrink:0"></span>'}
      <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--muted);flex-shrink:0"></i>
    </div>`;
  }).join(''));
}

async function refreshDashboardLiveCameraStatus() {
  showToast('Sincronizando status real pelo Zabbix...');
  const res = await api('/api/scripts/zabbix/status-sync', {
    method: 'POST',
    body: JSON.stringify({ source: 'ip', mode: 'olt', site: '' }),
  });
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok || body?.ok === false) {
    showToast(body?.detail || body?.error || 'Zabbix nao configurado para status das cameras.', true);
    return;
  }
  _dashDrawerData = null;
  showToast(`Zabbix atualizado: ${body.online || 0}/${body.total || 0} online, ${body.offline || 0} offline.`);
  await loadDashboard();
}

async function openDashDrawerRecorder(source, filterKey, activeSite) {
  filterKey  = filterKey  || 'all';
  activeSite = activeSite || null;
  const label = source === 'dvr' ? 'DVR' : 'NVR';
  const view  = source === 'dvr' ? 'inv-dvr' : 'inv-nvr';
  _openDashDrawer('Gravadores', `Canais ${label}`);
  if (!_dashDrawerData?.[source]) {
    const res = await apiJson(`/api/${source}/inventory`);
    if (!_dashDrawerData) _dashDrawerData = {};
    _dashDrawerData[source] = res?.inventory || [];
  }
  const rows = _dashDrawerData[source];
  const isOnline  = r => ['online','ok','up','ativo','active'].includes((r.status||'').toLowerCase());
  const isOffline = r => ['offline','down','inativo','inactive','auth_failed','timeout','erro','error','video_loss'].includes((r.status||'').toLowerCase());

  const sites = [...new Set(rows.map(r => r.local || '').filter(Boolean))].sort((a,b) => a.localeCompare(b,'pt'));
  const counts = { all: rows.length, online: rows.filter(isOnline).length, offline: rows.filter(isOffline).length };

  _drawerFilterBar(
    [{ key:'all', label:'Todos', count:counts.all }, { key:'online', label:' Online', count:counts.online }, { key:'offline', label:' Offline', count:counts.offline }],
    filterKey, sites, activeSite,
    k => openDashDrawerRecorder(source, k, activeSite),
    s => openDashDrawerRecorder(source, filterKey, s)
  );

  let filtered = rows;
  if (filterKey === 'online')  filtered = filtered.filter(isOnline);
  if (filterKey === 'offline') filtered = filtered.filter(isOffline);
  if (activeSite) filtered = filtered.filter(r => (r.local||'') === activeSite);

  filtered.sort((a, b) => {
    const hostCmp = (a.host||a.ip||'').localeCompare(b.host||b.ip||'', 'pt');
    return hostCmp !== 0 ? hostCmp : (a.channel||0) - (b.channel||0);
  });
  _drawerRenderRows(filtered.map(r => {
    const host = esc(r.host||r.ip||'');
    return `<div class="drawer-item" style="cursor:pointer" onclick="_drawerGoToInventory('${view}','${host}')" title="Abrir no inventario">
      ${_drawerStatusDot(r.status)}
      <div class="drawer-item-main">
        <div class="drawer-item-title">CH${String(r.channel||0).padStart(2,'0')}  ${esc(r.title || r.titulo || '')}</div>
        <div class="drawer-item-sub">${esc(r.host||r.ip||'')}  ${esc(r.local||'')}</div>
      </div>
      ${r.snapshot_url ? `<img src="${esc(r.snapshot_url)}" style="width:52px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0" loading="lazy">` : '<span style="width:52px;flex-shrink:0"></span>'}
      <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--muted);flex-shrink:0"></i>
    </div>`;
  }).join(''));
}

async function openDashDrawerWindows(filterKey) {
  filterKey = filterKey || 'all';
  _openDashDrawer('Inventario', 'Windows');
  if (!_dashDrawerData?.windows) {
    const res = await apiJson('/api/windows/inventory');
    if (!_dashDrawerData) _dashDrawerData = {};
    _dashDrawerData.windows = res?.inventory || [];
  }
  const rows = _dashDrawerData.windows;
  const isOnline  = r => (r.status||'').toLowerCase() === 'online';
  const isOffline = r => ['offline','error','erro'].includes((r.status||'').toLowerCase());

  const counts = { all: rows.length, online: rows.filter(isOnline).length, offline: rows.filter(isOffline).length };
  _drawerFilterBar(
    [{ key:'all', label:'Todos', count:counts.all }, { key:'online', label:' Online', count:counts.online }, { key:'offline', label:' Offline', count:counts.offline }],
    filterKey, [], null,
    k => openDashDrawerWindows(k), () => {}
  );

  let filtered = rows;
  if (filterKey === 'online')  filtered = filtered.filter(isOnline);
  if (filterKey === 'offline') filtered = filtered.filter(isOffline);

  filtered.sort((a, b) => (a.hostname || a.ip || '').localeCompare(b.hostname || b.ip || '', 'pt', { numeric: true }));
  _drawerRenderRows(filtered.map(r => `
    <div class="drawer-item" style="cursor:pointer" onclick="_drawerGoToInventory('inv-windows','')" title="Abrir no inventario">
      ${_drawerStatusDot(r.status)}
      <div class="drawer-item-main">
        <div class="drawer-item-title">${esc(r.hostname || r.ip || '')}</div>
        <div class="drawer-item-sub">${esc(r.ip||'')}  ${esc(r.local||r.site||'')}  SSD: ${r.has_ssd ? 'Sim' : 'Nao'}</div>
      </div>
      <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--muted);flex-shrink:0"></i>
    </div>`).join(''));
}

// 
async function loadDashboard() {
  _dashDrawerData = null; // limpa cache ao recarregar
  const data = await apiJson('/api/dashboard/summary');
  if (!data) return;

  const inv = data.inventory || {};
  const ip  = inv.ip  || {};
  const dvr = inv.dvr || {};
  const nvr = inv.nvr || {};
  const win = inv.windows || {};
  const tot = data.totals || {};

  // KPIs
  const ipOnline = ip.online ?? '';
  const ipTotal  = ip.total  ?? '';
  setText('mCamsOnline', ipOnline);
  setText('mCamsTotal',  ipTotal ? `de ${ipTotal} total` : '');

  const dvrRec = dvr.recorders ?? 0;
  const nvrRec = nvr.recorders ?? 0;
  setText('mDvrNvr',      `${dvrRec} DVR  ${nvrRec} NVR`);
  const dvrCh  = dvr.total ?? 0;
  const nvrCh  = nvr.total ?? 0;
  setText('mDvrNvrCanais', (dvrCh || nvrCh) ? `${dvrCh + nvrCh} canais` : '');

  setText('mSnapshots', tot.snapshots ?? '');
  setText('mSites',     tot.sites     ?? '');

  // Alertas  clicaveis
  const alerts = data.alerts || [];
  const alertsEl = document.getElementById('dashAlerts');
  const alertsList = document.getElementById('dashAlertsList');
  const alertActionMap = {
    'Cameras IP sem snapshot':         'no_snapshot',
    'Itens offline ou com erro':       'ip_offline',
    'Itens sem local':                  null,
    'Possiveis duplicidades IP/MAC':    null,
    'Computadores Windows sem SSD detectado': 'win_offline',
  };
  if (alerts.length) {
    const colorMap = { danger: '#fa5252', warning: '#fd7e14', info: '#339af0' };
    const iconMap  = { danger: 'alert-circle', warning: 'alert-triangle', info: 'info' };
    alertsList.innerHTML = alerts.map(a => {
      const color      = colorMap[a.level] || '#888';
      const icon       = iconMap[a.level]  || 'info';
      const actionKey  = alertActionMap[a.label];
      const clickable  = actionKey ? `data-dash-alert="${actionKey}" style="cursor:pointer"` : '';
      const hint       = actionKey ? `<i data-lucide="chevron-right" style="width:13px;height:13px;color:${color};flex-shrink:0"></i>` : '';
      return `<div ${clickable} style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;background:var(--surface);border-left:3px solid ${color};transition:background .15s" onmouseenter="if(this.dataset.dashAlert)this.style.background='var(--hover)'" onmouseleave="this.style.background='var(--surface)'">
        <i data-lucide="${icon}" style="width:15px;height:15px;color:${color};flex-shrink:0"></i>
        <span style="flex:1;font-size:13px">${esc(a.label)}</span>
        <span style="font-size:13px;font-weight:700;color:${color}">${a.count}</span>
        ${hint}
      </div>`;
    }).join('');
    alertsEl.style.display = '';
    lucide.createIcons();
  } else {
    alertsEl.style.display = 'none';
  }

  // Status por tipo  clicaveis
  const statusGrid = document.getElementById('dashStatusGrid');
  const statusTypes = [
    { label: 'Cameras IP',  icon: 'camera',     s: ip,  type: 'ip'      },
    { label: 'DVR canais',  icon: 'hard-drive',  s: dvr, type: 'dvr'     },
    { label: 'NVR canais',  icon: 'hard-drive',  s: nvr, type: 'nvr'     },
    { label: 'Windows',     icon: 'monitor',     s: win, type: 'windows' },
  ];
  statusGrid.innerHTML = statusTypes.map(t => {
    const total   = t.s.total   ?? 0;
    const online  = t.s.online  ?? 0;
    const offline = t.s.offline ?? 0;
    const pct     = total > 0 ? Math.round((online / total) * 100) : null;
    const barColor = pct === null ? 'var(--muted)' : pct >= 80 ? 'var(--primary)' : pct >= 50 ? '#fd7e14' : '#fa5252';
    return `<div class="dash-status-row clickable" data-type="${t.type}" title="Ver detalhes">
      <i data-lucide="${t.icon}" style="width:14px;height:14px;color:var(--muted);flex-shrink:0"></i>
      <span style="flex:1;font-size:13px">${t.label}</span>
      <span style="font-size:12px;color:var(--primary);font-weight:600">${online} online</span>
      <span style="font-size:12px;color:var(--muted);margin-left:4px">/ ${total}</span>
      ${offline ? `<span style="font-size:11px;color:#fa5252;margin-left:6px;font-weight:600">${offline} off</span>` : ''}
      <div style="width:60px;height:4px;background:var(--border);border-radius:2px;margin-left:8px;overflow:hidden">
        <div style="height:100%;width:${pct ?? 0}%;background:${barColor};transition:width .4s"></div>
      </div>
      <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--muted);margin-left:4px;flex-shrink:0"></i>
    </div>`;
  }).join('');
  lucide.createIcons();

  // Atividade recente
  const activity = data.recent_activity || [];
  const actEl = document.getElementById('dashActivity');
  if (activity.length) {
    actEl.innerHTML = activity.map(a => {
      let ago = '';
      try {
        const diff = Date.now() - new Date(a.updated_at).getTime();
        const mins = Math.floor(diff / 60000);
        const hrs  = Math.floor(mins / 60);
        const days = Math.floor(hrs / 24);
        ago = days  > 0 ? `${days}d atras` :
              hrs   > 0 ? `${hrs}h atras`  :
              mins  > 0 ? `${mins}min atras` : 'agora';
      } catch {}
      return `<div class="dash-status-row">
        <i data-lucide="file-text" style="width:14px;height:14px;color:var(--muted);flex-shrink:0"></i>
        <span style="flex:1;font-size:13px">${esc(a.label)}</span>
        <span style="font-size:11px;color:var(--muted)">${ago}</span>
      </div>`;
    }).join('');
  } else {
    actEl.innerHTML = '<div class="dash-status-row"><span style="color:var(--muted);font-size:13px">Nenhuma atividade registrada.</span></div>';
  }
  lucide.createIcons();

  // Sites
  const sites = data.sites || [];
  const sitesPanel = document.getElementById('dashSitesPanel');
  if (sites.length) {
    setText('dashSitesCount', `${sites.length} localidade${sites.length !== 1 ? 's' : ''} no inventario`);
    document.getElementById('dashSitesList').innerHTML = sites.map(s =>
      `<span style="padding:4px 10px;border-radius:20px;background:var(--surface);border:1px solid var(--border);font-size:12px">${esc(s)}</span>`
    ).join('');
    sitesPanel.style.display = '';
  } else {
    sitesPanel.style.display = 'none';
  }

  // Click handlers: KPI cards
  document.getElementById('kpiCamerasIp')?.addEventListener('click', () => openDashDrawerIp('all'));
  document.getElementById('kpiGravadores')?.addEventListener('click', () => openDashDrawerRecorder('dvr', 'all'));
  document.getElementById('kpiSnapshots')?.addEventListener('click', () => openDashDrawerIp('no_snap'));
  document.getElementById('kpiSites')?.addEventListener('click', () => {
    _openDashDrawer('Sites', 'Sites monitorados');
    document.getElementById('dashDrawerFilters').innerHTML = '';
    _drawerRenderRows(sites.length
      ? sites.map(s => `<div class="drawer-item"><i data-lucide="map-pin" style="width:14px;height:14px;color:var(--primary)"></i><div class="drawer-item-main"><div class="drawer-item-title">${esc(s)}</div></div></div>`).join('')
      : '');
  });

  // Click handlers: status rows (adicionados via dataset)
  document.querySelectorAll('.dash-status-row.clickable').forEach(row => {
    row.addEventListener('click', () => {
      const type = row.dataset.type;
      if (type === 'ip')      openDashDrawerIp('all');
      if (type === 'dvr')     openDashDrawerRecorder('dvr', 'all');
      if (type === 'nvr')     openDashDrawerRecorder('nvr', 'all');
      if (type === 'windows') openDashDrawerWindows('all');
    });
  });

  // Click handlers: alertas
  document.querySelectorAll('[data-dash-alert]').forEach(el => {
    el.addEventListener('click', () => {
      const a = el.dataset.dashAlert;
      if (a === 'ip_offline')   openDashDrawerIp('offline');
      if (a === 'dvr_offline')  openDashDrawerRecorder('dvr', 'offline');
      if (a === 'nvr_offline')  openDashDrawerRecorder('nvr', 'offline');
      if (a === 'win_offline')  openDashDrawerWindows('offline');
      if (a === 'no_snapshot')  openDashDrawerIp('no_snap');
    });
  });

  lucide.createIcons();
}

//  Inventario Cameras IP 
const _invCam   = { basico: [], olt: [], switch: [] };
let _invOltView   = (() => {
  try { return sessionStorage.getItem('so_cam_view') || 'olt'; } catch { return 'olt'; }
})();
let _invOltActive = null;
let _pingInterval = null;
let _pendingOpenCamIp = null;

function _invOltAll_get() { return _invCam[_invOltView] || []; }

function _camSessionSave(mode, rows) {
  try { sessionStorage.setItem(`so_cam_${mode}`, JSON.stringify(rows)); } catch {}
}
function _camSessionLoad() {
  ['basico','olt','switch'].forEach(m => {
    try {
      const d = JSON.parse(sessionStorage.getItem(`so_cam_${m}`) || 'null');
      if (Array.isArray(d)) _invCam[m] = d;
    } catch {}
  });
}
function _camSessionClear() {
  ['basico','olt','switch'].forEach(m => {
    try { sessionStorage.removeItem(`so_cam_${m}`); } catch {}
    _invCam[m] = [];
  });
}

function _camKey(camOrIp) {
  if (typeof camOrIp === 'string') return `IP:${camOrIp.trim()}`;
  const cam = camOrIp || {};
  const existingKey = String(cam.inventory_key || cam.key || '').trim();
  if (existingKey) return existingKey;
  const ip = String(cam.ip || cam.IP || '').trim();
  const connector = String(cam.remote_connector_id || cam.connector_id || '').trim();
  const site = String(cam.site || cam.site_name || cam.local || '').trim().toLowerCase();
  if (connector && ip) return `REMOTE:${connector}:IP:${ip}`;
  if ((cam.remote === true || cam.remote === 'true' || cam.remote === 1) && site && ip) return `REMOTE_SITE:${site}:IP:${ip}`;
  return `IP:${ip}`;
}

function _camRemoveIpsLocally(ips) {
  const doomed = new Set((ips || []).map(ip => String(ip || '').trim()).filter(Boolean));
  if (!doomed.size) return;
  ['basico','olt','switch'].forEach(mode => {
    _invCam[mode] = (_invCam[mode] || []).filter(cam => !doomed.has(String(cam.ip || '').trim()) && !doomed.has(_camKey(cam)));
    _camSessionSave(mode, _invCam[mode]);
  });
  try {
    const imgbb = _imgbbGet();
    doomed.forEach(ip => {
      delete imgbb[ip];
      delete imgbb[`IP:${ip}`];
    });
    sessionStorage.setItem('so_imgbb', JSON.stringify(imgbb));
  } catch {}
}

function updateCamTabs() {
  document.querySelectorAll('.inv-view-tab[data-view]').forEach(t => {
    const view = t.dataset.view;
    const hasData = _invCam[view]?.length > 0;
    t.style.display = (view === 'basico' || view === 'olt' || hasData) ? '' : 'none';
  });
  if (!['basico', 'olt', 'switch'].includes(_invOltView)) {
    _invOltView = 'basico';
  }
  document.querySelectorAll('.inv-view-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === _invOltView)
  );
}

function cameraImgbbUrl(c) {
  if (!c) return '';
  return c.imgbb_url
    || c.imgbb_thumb_url
    || c.thumbnail_url
    || c.thumb_url
    || c.display_url
    || c.url
    || (isImgbbUrl(c.snapshot_url) ? c.snapshot_url : '')
    || '';
}

// Celulas base compartilhadas entre as 3 visoes
function _camCell(c) {
  const imgbbUrl = cameraImgbbUrl(c);
  const key = _camKey(c);
  return {
    chk:       `<input type="checkbox" class="chk-olt" value="${esc(c.ip)}" data-key="${esc(key)}">`,
    ip:        `<span class="monospace text-primary" title="${esc(c.ip)}">${esc(c.ip)}</span>`,
    mac:       `<span class="monospace" title="${esc(c.mac||'')}" style="font-size:11px">${esc(c.mac||'')}</span>`,
    fab:       `<span class="text-muted" title="${esc(c.fabricante||'')}">${esc(c.fabricante||'')}</span>`,
    modelo:    `<span title="${esc(c.modelo || c.model || '')}">${esc(c.modelo || c.model || '')}</span>`,
    titulo:    `<strong title="${esc(c.titulo||'')}">${esc(c.titulo||'')}</strong>`,
    status:    invStatusBadge(c.status),
    imgbb:     imgbbUrl ? `<a href="${esc(imgbbUrl)}" target="_blank" onclick="event.stopPropagation()" style="color:var(--primary);font-weight:700;font-size:12px;text-decoration:none"> up</a>` : `<span style="color:var(--danger);font-weight:700;font-size:12px"> down</span>`,
    local:     `<span class="text-muted" title="${esc(c.local||'')}">${esc(c.local||'')}</span>`,
    pon:       `<span style="text-align:center;display:block;font-weight:500">${esc(c.pon||'')}</span>`,
    onu_id:    `<span style="text-align:center;display:block;font-weight:500">${esc(c.onu_id||'')}</span>`,
    onu_name:  `<span class="text-muted" title="${esc(c.onu_name||'')}" style="font-size:11px">${esc(c.onu_name||'')}</span>`,
    onu_ser:   `<span class="monospace text-muted" title="${esc(c.onu_serial||'')}" style="font-size:11px">${esc(c.onu_serial||'')}</span>`,
    sw_ip:     `<span class="monospace text-muted" title="${esc(c.switch_ip||'')}">${esc(c.switch_ip||'')}</span>`,
    sw_port:   `<span class="text-muted" title="${esc(c.switch_port||'')}">${esc(c.switch_port||'')}</span>`,
    sw_vlan:   `<span class="text-muted" title="${esc(c.switch_vlan||'')}">${esc(c.switch_vlan||'')}</span>`,
  };
}

// Larguras em % (nao em px): garantem matematicamente que a tabela nunca
// ultrapassa 100% do container, ou seja, nunca gera scroll horizontal,
// independente de resolucao/zoom/escala do Windows. Identificadores
// (IP/MAC/PON/ONU ID/Serial/Porta) recebem a maior fatia para minimizar
// truncamento; colunas descritivas (Fabricante/Modelo/Titulo/Local/ONU Name)
// truncam com reticencias + tooltip (title=) quando o espaco aperta.
const INV_COLS = {
  // Basico: IP, MAC, Fabricante, Modelo, Titulo, Status, ImgBB, Local
  basico: {
    cols:  ['4%','13%','15%','10%','12%','18%','9%','7%','12%'],
    heads: ['',    'IP', 'MAC','Fabricante','Modelo','Titulo','Status','ImgBB','Local'],
    row: c => { const v = _camCell(c); return [v.chk, v.ip, v.mac, v.fab, v.modelo, v.titulo, v.status, v.imgbb, v.local]; },
  },
  // OLT: base enxuta + dados OLT
  olt: {
    cols:  ['3%','11%','12%','7%','8%','15%','7%','5%','7%','4%','5%','8%','8%'],
    heads: ['',    'IP','MAC','Fabricante','Modelo','Titulo','Status','ImgBB','Local','PON','ONU ID','ONU Name','ONU Serial'],
    row: c => { const v = _camCell(c); return [v.chk, v.ip, v.mac, v.fab, v.modelo, v.titulo, v.status, v.imgbb, v.local, v.pon, v.onu_id, v.onu_name, v.onu_ser]; },
  },
  // Switch: base enxuta + dados Switch
  switch: {
    cols:  ['4%','12%','14%','8%','9%','17%','7%','5%','6%','10%','5%','3%'],
    heads: ['',    'IP','MAC','Fabricante','Modelo','Titulo','Status','ImgBB','Local','Switch IP','Porta','VLAN'],
    row: c => { const v = _camCell(c); return [v.chk, v.ip, v.mac, v.fab, v.modelo, v.titulo, v.status, v.imgbb, v.local, v.sw_ip, v.sw_port, v.sw_vlan]; },
  },
};

async function setInvOltView(view) {
  _invOltView = view;
  try { sessionStorage.setItem('so_cam_view', view); } catch {}
  document.querySelectorAll('.inv-view-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view)
  );
  if (!(_invCam[view] || []).length) {
    try {
      await _loadCamForMode(view);
      updateCamTabs();
      populateCamSiteFilter();
    } catch (e) {
      console.warn('Falha ao carregar visao', view, e);
    }
  }
  applyInvOltFilters();
}

// Persiste mapeamento camera->imgbb_url no sessionStorage.
function _imgbbSave(camOrIp, url) {
  try {
    const m = JSON.parse(sessionStorage.getItem('so_imgbb') || '{}');
    const key = _camKey(camOrIp);
    if (key) m[key] = url;
    if (typeof camOrIp === 'string') m[`IP:${camOrIp.trim()}`] = url;
    sessionStorage.setItem('so_imgbb', JSON.stringify(m));
  } catch {}
}
function _imgbbGet() {
  try { return JSON.parse(sessionStorage.getItem('so_imgbb') || '{}'); } catch { return {}; }
}
function _imgbbClear() {
  try { sessionStorage.removeItem('so_imgbb'); } catch {}
}

//  Mapa de cameras (Leaflet) 
let _map            = null;
let _mapFeatures    = [];
let _mapLayers      = [];
let _mapLayerGroups = {}; // id  { group, active, features }
let _mapCameraIndex = { byName: {}, byIp: {} };

// Definicao das camadas disponiveis
const MAP_LAYER_DEFS = [
  { id: 'cameras',  get label() { return sessionStorage.getItem('so_kmz_generated_name') || 'Cameras do Inventario'; },
    color: '#16a34a', endpoint: '/api/kmz/generated/geojson', source: 'generated' },
];

function mapExtractIp(text) {
  const m = String(text || '').match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  return m ? m[0] : '';
}

function mapFeatureName(feature) {
  return String(feature?.properties?.name || '').trim();
}

function mapFeatureLocal(feature, cam) {
  if (cam?.local) return cam.local;
  const desc = String(feature?.properties?.description || '');
  const m = desc.match(/LOCAL.*?>(.*?)</i);
  return m ? m[1].trim() : '';
}

function mapFindCamera(feature, index = _mapCameraIndex) {
  const name = mapFeatureName(feature);
  const desc = String(feature?.properties?.description || '');
  const ip = mapExtractIp(desc) || mapExtractIp(name);
  return index.byName[name.toLowerCase()] || index.byIp[ip] || null;
}

function mapFeatureType(feature, cam) {
  const name = mapFeatureName(feature);
  const desc = String(feature?.properties?.description || '');
  if (cam || !feature?._source || feature?._source === 'generated') return 'camera';
  if (/\bcto\b|^cto/i.test(name)) return 'cto';
  if (/\bcdo\b|^cdo|emenda|splice/i.test(name)) return 'cdo';
  if (/cam|camera|vip-|vipc|vip\s|\bcam\s/i.test(name)) return 'camera';
  if (/\bSTATUS\b|\bLOCAL\b|\bMODELO\b|\bFABRICANTE\b|vip-|vipc|hikvision|intelbras/i.test(desc)) return 'camera';
  return 'other';
}

function mapFeatureStatus(feature, cam) {
  const desc = String(feature?.properties?.description || '').toUpperCase();
  const status = String(cam?.status || '').toLowerCase();
  if (status === 'online') return 'online';
  if (status === 'offline') return 'offline';
  if (desc.includes('ONLINE')) return 'online';
  if (desc.includes('OFFLINE')) return 'offline';
  return 'outros';
}

function mapFeatureKey(feature, cam = null) {
  const ip = cam?.ip || mapExtractIp(feature?.properties?.description) || mapExtractIp(mapFeatureName(feature));
  const name = mapFeatureName(feature);
  const coords = feature?.geometry?.coordinates || [];
  return [ip || name, coords[1], coords[0]].map(v => String(v ?? '').trim()).join('|');
}

function mapLayerStats(features, index = _mapCameraIndex) {
  return (features || []).reduce((acc, f) => {
    const cam = mapFindCamera(f, index);
    const type = mapFeatureType(f, cam);
    acc.total += 1;
    if (type === 'camera') {
      acc.cameras += 1;
      const status = mapFeatureStatus(f, cam);
      if (status === 'online') acc.online += 1;
      else if (status === 'offline') acc.offline += 1;
      else acc.outros += 1;
    } else {
      acc.outros += 1;
    }
    return acc;
  }, { total: 0, cameras: 0, online: 0, offline: 0, outros: 0 });
}

function mapLayerColor(features, fallback = '#d97706') {
  const stats = mapLayerStats(features, _mapCameraIndex);
  if (stats.cameras > 0) return '#16a34a';
  const names = (features || []).map(f => mapFeatureName(f)).join(' ');
  if (/\bcto\b|^cto/i.test(names)) return '#1971c2';
  if (/\bcdo\b|^cdo|emenda|splice/i.test(names)) return '#7950f2';
  return fallback;
}

function mapLayerSignature(features) {
  return (features || [])
    .filter(f => f?.geometry?.type === 'Point')
    .map(f => {
      const coords = f.geometry?.coordinates || [];
      const name = mapFeatureName(f).toLowerCase();
      const lat = Number(coords[1] || 0).toFixed(6);
      const lng = Number(coords[0] || 0).toFixed(6);
      return `${name}|${lat}|${lng}`;
    })
    .sort()
    .slice(0, 80)
    .join('||');
}

async function mapLoadCameraIndex() {
  const camData = await apiJson(`/api/cameras?mode=olt&_=${Date.now()}`);
  const cams = camData?.cameras || [];
  const byName = {};
  const byIp = {};
  cams.forEach(c => {
    if (c.titulo) byName[String(c.titulo).toLowerCase()] = c;
    if (c.ip) byIp[String(c.ip)] = c;
  });
  _mapCameraIndex = { byName, byIp };
  return _mapCameraIndex;
}

async function refreshMapLiveStatus() {
  try {
    showToast('Sincronizando status real das cameras...');
    const res = await api('/api/scripts/zabbix/status-sync', {
      method: 'POST',
      body: JSON.stringify({ source: 'ip', mode: 'olt', site: '', validate_offline: true }),
    });
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok || body?.ok === false) {
      showToast(body?.detail || body?.error || 'Nao foi possivel sincronizar status agora.', true);
      return;
    }
    const extra = body.validated_online ? `, ${body.validated_online} validadas por TCP` : '';
    showToast(`Status atualizado: ${body.online || 0} online, ${body.offline || 0} offline${extra}.`);
  } catch (err) {
    showToast(`Falha ao atualizar status: ${err.message || err}`, true);
  }
}

async function loadKmz() {
  const container = document.getElementById('leafletMap');
  if (!container) return;

  if (!_map) {
    _map = L.map('leafletMap', { zoomControl: true }).setView([-9.76, -36.67], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: ' OpenStreetMap  CARTO',
      subdomains: 'abcd', maxZoom: 20,
    }).addTo(_map);
  }

  setTimeout(() => _map.invalidateSize(), 100);

  // Carrega e renderiza painel de camadas
  await loadMapLayers();

  // Nada mais a fazer aqui  as camadas sao gerenciadas pelo painel
  setText('mapCounter', 'Selecione camadas no painel');

  // Popula filtro de sites (extraido das propriedades)
  const sites = [...new Set(_mapFeatures.map(f => {
    const m = (f.properties?.description || '').match(/LOCAL.*?>(.*?)</i);
    return m ? m[1].trim() : '';
  }).filter(Boolean))].sort();
  const selSite = document.getElementById('mapFilterSite');
  if (selSite) {
    const cur = selSite.value;
    selSite.innerHTML = '<option value="">Todos os sites</option>' +
      sites.map(s => `<option${s===cur?' selected':''}>${esc(s)}</option>`).join('');
  }

  setTimeout(() => _map.invalidateSize(), 200);
}

async function loadMapLayers() {
  const listEl = document.getElementById('mapLayersList');
  if (!listEl) return;

  listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px;text-align:center">Carregando camadas</div>';

  const camIndex = await mapLoadCameraIndex();
  const previousActive = new Set(Object.entries(_mapLayerGroups || {}).filter(([, s]) => s?.active).map(([id]) => id));

  const generatedData = await apiJson('/api/kmz/generated/layers').catch(() => ({ layers: [] }));
  const generatedLayers = (generatedData?.layers || []).map((layer, idx) => ({
    id: `generated:${layer.id}`,
    layerId: layer.id,
    label: layer.label || layer.original_name || `Mapa gerado ${idx + 1}`,
    color: '#16a34a',
    source: 'generated',
    sourceLayerId: layer.source_layer_id || '',
    features: (layer.features || []).map(f => ({ ...f, _source: 'generated', _layerId: layer.id })),
    count: Number(layer.features_count ?? layer.features?.length ?? 0),
    downloadUrl: layer.download_url || `/api/kmz/generated/layers/${encodeURIComponent(layer.id)}/download`,
    deleteUrl: `/api/kmz/generated/layers/${encodeURIComponent(layer.id)}`,
  }));

  const importedData = await apiJson('/api/kmz/import/layers');
  const generatedSourceLayerIds = new Set(generatedLayers.map(layer => layer.sourceLayerId).filter(Boolean));
  const generatedSignatures = new Set(generatedLayers.map(layer => mapLayerSignature(layer.features)).filter(Boolean));
  const importedLayers = (importedData?.layers || []).map((layer, idx) => ({
    id: `imported:${layer.id}`,
    layerId: layer.id,
    label: layer.label || layer.original_name || `Mapa ${idx + 1}`,
    color: mapLayerColor((layer.features || []).map(f => ({ ...f, _source: 'imported', _layerId: layer.id }))),
    source: 'imported',
    features: (layer.features || []).map(f => ({ ...f, _source: 'imported', _layerId: layer.id })),
    count: Number(layer.features_count ?? layer.features?.length ?? 0),
    downloadUrl: layer.download_url || `/api/kmz/import/layers/${encodeURIComponent(layer.id)}/download`,
    deleteUrl: `/api/kmz/import/layers/${encodeURIComponent(layer.id)}`,
  })).filter(layer => !generatedSourceLayerIds.has(layer.layerId) && !generatedSignatures.has(mapLayerSignature(layer.features)));

  const results = [
    ...generatedLayers.filter(r => r.count > 0),
    ...importedLayers.filter(r => r.count > 0),
  ];
  _mapFeatures = results.flatMap(layer => (layer.features || []).map(f => ({ ...f, _source: f._source || layer.source, _layerId: layer.layerId || layer.id })));

  // Inicializa grupos de camadas
  Object.values(_mapLayerGroups || {}).forEach(state => {
    if (state?.active && state?.group) {
      try { _map.removeLayer(state.group); } catch {}
    }
  });
  _mapLayerGroups = {};
  results.forEach(r => {
    _mapLayerGroups[r.id] = { features: r.features, group: L.layerGroup(), active: false, color: r.color, def: r };
  });

  listEl.innerHTML = '';

  if (results.every(r => r.count === 0)) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:12px;text-align:center">Nenhuma camada disponivel.<br><small>Importe um KMZ ou gere o mapa.</small></div>';
    return;
  }

  const controls = document.createElement('div');
  controls.className = 'map-layer-bulk';
  controls.innerHTML = `
    <button type="button" class="map-layer-bulk-btn" data-map-layer-bulk="all"><i data-lucide="check-square"></i> Todas</button>
    <button type="button" class="map-layer-bulk-btn" data-map-layer-bulk="none"><i data-lucide="square"></i> Nenhuma</button>`;
  listEl.appendChild(controls);

  results.forEach(def => {
    const stats = mapLayerStats(def.features, camIndex);
    const btn = document.createElement('label');
    btn.className = 'map-layer-btn';
    btn.dataset.layerId = def.id;
    btn.title = def.label;
    btn.innerHTML = `
      <input type="checkbox" class="map-layer-check" data-layer-check="${esc(def.id)}">
      <span class="layer-dot" style="background:${def.color}"></span>
      <span class="map-layer-name">${esc(def.label)}</span>
      <span class="map-layer-badge">${def.count} pts</span>`;
    btn.querySelector('input')?.addEventListener('change', () => toggleMapLayer(def.id, def));

    // Botao excluir
    const delBtn = document.createElement('button');
    delBtn.title = 'Excluir camada';
    delBtn.className = 'map-layer-action danger';
    delBtn.innerHTML = '<i data-lucide="trash-2"></i>';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const ok = await showConfirm({ title: 'Excluir camada', msg: `Remover "${def.label}" do mapa e do servidor?`, label: 'Excluir' });
      if (!ok) return;
      // Remove do mapa
      const state = _mapLayerGroups[def.id];
      if (state?.active) { _map.removeLayer(state.group); state.active = false; }
      delete _mapLayerGroups[def.id];
      if (def.deleteUrl) {
        await api(def.deleteUrl, { method: 'DELETE' }).catch(() => {});
      }
      btn.closest('.map-layer-card')?.remove();
      setText('mapCounter', 'Camada removida');
      showToast(`"${def.label}" removida do mapa.`);
    };

    const row = document.createElement('div');
    row.className = 'map-layer-card';
    row.dataset.layerCardId = def.id;
    row.appendChild(btn);

    const statsEl = document.createElement('div');
    statsEl.className = 'map-layer-stats';
    statsEl.innerHTML = `
      <span class="map-layer-stat"><span class="map-layer-stat-dot" style="background:#16a34a"></span><strong>${stats.online}</strong> online</span>
      <span class="map-layer-stat"><span class="map-layer-stat-dot" style="background:#dc2626"></span><strong>${stats.offline}</strong> offline</span>
      <span class="map-layer-stat"><span class="map-layer-stat-dot" style="background:#64748b"></span><strong>${stats.cameras}</strong> cameras</span>
      <span class="map-layer-stat"><span class="map-layer-stat-dot" style="background:#d97706"></span><strong>${stats.outros}</strong> outros</span>`;
    row.appendChild(statsEl);

    const actions = document.createElement('div');
    actions.className = 'map-layer-actions';

    const detailBtn = document.createElement('button');
    detailBtn.className = 'map-layer-action';
    detailBtn.innerHTML = '<i data-lucide="list"></i> Detalhes';
    detailBtn.onclick = (e) => { e.stopPropagation(); openMapLayerDetails(def); };
    actions.appendChild(detailBtn);

    const dlUrl = def.downloadUrl || '';
    if (dlUrl) {
      const dlBtn = document.createElement('button');
      dlBtn.title = 'Download KMZ';
      dlBtn.className = 'map-layer-action';
      dlBtn.innerHTML = '<i data-lucide="download"></i>';
      dlBtn.onclick = (e) => { e.stopPropagation(); downloadWithAuth(dlUrl, `${def.label || 'mapa'}.kmz`); };
      actions.appendChild(dlBtn);
    }

    actions.appendChild(delBtn);
    row.appendChild(actions);
    listEl.appendChild(row);
  });

  controls.querySelector('[data-map-layer-bulk="all"]')?.addEventListener('click', async () => {
    for (const def of results) {
      const state = _mapLayerGroups[def.id];
      if (state && !state.active) await toggleMapLayer(def.id, def, true);
    }
  });
  controls.querySelector('[data-map-layer-bulk="none"]')?.addEventListener('click', () => {
    results.forEach(def => {
      const state = _mapLayerGroups[def.id];
      if (state?.active) toggleMapLayer(def.id, def, true);
    });
  });

  lucide.createIcons();

  const idsToRestore = previousActive.size ? [...previousActive].filter(id => _mapLayerGroups[id]) : [results[0]?.id].filter(Boolean);
  for (const id of idsToRestore) {
    const def = results.find(r => r.id === id);
    if (def) await toggleMapLayer(id, def, true);
  }
}

async function toggleMapLayer(id, def, skipFit = false) {
  if (!_map) return;
  const state = _mapLayerGroups[id];
  if (!state) return;

  if (state.active) {
    _map.removeLayer(state.group);
    state.group.clearLayers();
    state.active = false;
    state.drawnCount = 0;
  } else {
    // Renderiza os pontos neste grupo
    state.group = L.layerGroup();
    state.markers = {};
    const bounds = [];
    let drawnCount = 0;
    state.features.forEach(f => {
      if (f.geometry?.type !== 'Point') return;
      const [lng, lat] = f.geometry.coordinates;
      if (lat == null || lng == null || isNaN(+lat) || isNaN(+lng)) return;

      // Casa com a camera real pra pegar status ao vivo (Zabbix), nao o texto
      // estatico gravado no KMZ na hora que foi gerado. Faz isso ANTES de decidir
      // o tipo do ponto: se o nome bate com uma camera real do inventario, e
      // camera -- nao importa se o ponto veio de layer "gerado" ou importado.
      const name = f.properties?.name || '';
      const cam = mapFindCamera(f, _mapCameraIndex);
      const statusFilter = document.getElementById('mapFilterStatus')?.value || '';
      const siteFilter = document.getElementById('mapFilterSite')?.value || '';
      const featureStatus = mapFeatureStatus(f, cam);
      const featureLocal = mapFeatureLocal(f, cam);
      if (statusFilter && featureStatus !== statusFilter) return;
      if (siteFilter && featureLocal !== siteFilter) return;
      const pointType = mapFeatureType(f, cam);
      const isOnlinePop = cam?.status
        ? String(cam.status).toLowerCase() === 'online'
        : String(f.properties?.description || '').toUpperCase().includes('ONLINE');
      const statusColor = isOnlinePop ? '#16a34a' : '#dc2626';

      const typeConfig = {
        camera: { bg: statusColor, label: '' },
        cto:    { bg: '#1971c2', label: 'CTO' },
        cdo:    { bg: '#7950f2', label: 'CDO' },
        other:  { bg: def?.color || '#d97706', label: '' },
      };
      const tc = typeConfig[pointType];
      const icon = L.divIcon({
        html: `<div style="background:${tc.bg};color:white;border:2px solid white;border-radius:6px;padding:2px 5px;font-size:10px;font-weight:700;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4);cursor:pointer">${tc.label}</div>`,
        className: '', iconSize: [40, 22], iconAnchor: [20, 11], popupAnchor: [0, -14],
      });
      const marker = L.marker([+lat, +lng], { icon });
      const featureKey = mapFeatureKey(f, cam);
      if (!state.markers) state.markers = {};
      // Popup rico e moderno
      const [lng2, lat2] = f.geometry.coordinates;

      const row = (icon, label, value, mono = false) =>
        value ? `<div style="display:flex;align-items:baseline;gap:6px;padding:4px 0;border-bottom:1px solid #f1f3f5">
          <span style="color:#868e96;font-size:12px;flex-shrink:0">${icon}</span>
          <span style="color:#868e96;font-size:11px;min-width:56px;flex-shrink:0">${label}</span>
          <span style="font-size:12px;font-weight:500;word-break:break-all;${mono?'font-family:monospace;font-size:11px;':''}">${value}</span>
        </div>` : '';

      const snapHtml = cam?.snapshot_url
        ? `<div style="position:relative;overflow:hidden;border-radius:8px 8px 0 0;margin-bottom:12px">
            <img src="${API_BASE}${esc(cam.snapshot_url)}" style="width:100%;height:160px;object-fit:cover;display:block">
            <div style="position:absolute;bottom:0;left:0;right:0;padding:10px 14px;background:linear-gradient(transparent,rgba(0,0,0,.8))">
              <div style="color:white;font-size:14px;font-weight:700">${esc(name)}</div>
              <div style="color:${isOnlinePop?'#69db7c':'#ff8787'};font-size:12px;font-weight:600">${isOnlinePop?' ONLINE':' OFFLINE'}</div>
            </div>
          </div>`
        : `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #f1f3f5">
            <strong style="font-size:14px">${esc(name)}</strong>
            <span style="background:${statusColor}22;color:${statusColor};font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">${isOnlinePop?'ONLINE':'OFFLINE'}</span>
          </div>`;

      marker.bindPopup(`
        <div style="width:280px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:14px;overflow:hidden">
          ${snapHtml}
          ${row('','Camera', cam?.model || cam?.fabricante)}
          ${row('','Local',  cam?.local)}
          ${row('','IP', cam?.ip ? `<a href="http://${esc(cam.ip)}" target="_blank" style="color:#1971c2">${esc(cam.ip)}</a>` : '')}
          ${row('','MAC',    cam?.mac, true)}
          ${row('','PON/ONU', cam?.pon || cam?.onu_id ? [cam?.pon,cam?.onu_id].filter(Boolean).join(' / ') : '')}
          ${row('','ONU Serial', cam?.onu_serial, true)}
          <div style="margin-top:8px;padding-top:6px;font-size:10px;color:#adb5bd;font-family:monospace;word-break:break-all">
             ${(+lat2).toFixed(7)}, ${(+lng2).toFixed(7)}
          </div>
          ${cam?.ip ? `<div style="margin-top:10px;display:flex;gap:6px">
            <a href="http://${esc(cam.ip)}" target="_blank" style="flex:1;text-align:center;padding:6px;background:#e7f5ff;color:#1971c2;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none;border:1px solid #a5d8ff">Abrir camera</a>
          </div>` : ''}
        </div>`, { maxWidth: 320, className: 'sightops-popup' });
      state.markers[featureKey] = marker;
      state.group.addLayer(marker);
      bounds.push([+lat, +lng]);
      drawnCount += 1;
    });
    _map.addLayer(state.group);
    state.active = true;
    state.drawnCount = drawnCount;

    if (bounds.length > 0 && !skipFit) {
      try { _map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 }); } catch {}
    }
  }

  // Atualiza botao visual
  const btn = document.querySelector(`[data-layer-id="${id}"]`);
  if (btn) btn.classList.toggle('active', state.active);
  const chk = document.querySelector(`[data-layer-check="${CSS.escape(id)}"]`);
  if (chk) chk.checked = !!state.active;
  const card = document.querySelector(`[data-layer-card-id="${id}"]`);
  if (card) card.classList.toggle('active', state.active);

  // Atualiza contador
  const totalShown = Object.values(_mapLayerGroups).filter(s => s.active).reduce((a, s) => a + (s.drawnCount ?? s.group?.getLayers?.().length ?? 0), 0);
  setText('mapCounter', `${totalShown} ponto${totalShown !== 1 ? 's' : ''} visiveis`);
}

function openMapLayerDetails(def) {
  const modal = document.getElementById('modalMapLayerDetails');
  const title = document.getElementById('mapLayerDetailsTitle');
  const summary = document.getElementById('mapLayerDetailsSummary');
  const list = document.getElementById('mapLayerDetailsList');
  if (!modal || !summary || !list) return;

  const stats = mapLayerStats(def.features, _mapCameraIndex);
  if (title) title.textContent = def.label || 'Detalhes da camada';
  summary.innerHTML = `
    <button class="map-detail-filter active" data-map-detail-filter="all"><span class="map-layer-stat-dot" style="background:#64748b"></span>${stats.cameras} cameras</button>
    <button class="map-detail-filter" data-map-detail-filter="online"><span class="map-layer-stat-dot" style="background:#16a34a"></span>${stats.online} online</button>
    <button class="map-detail-filter" data-map-detail-filter="offline"><span class="map-layer-stat-dot" style="background:#dc2626"></span>${stats.offline} offline</button>
    <span class="map-detail-pill"><span class="map-layer-stat-dot" style="background:#d97706"></span>${stats.outros} outros</span>
    <label class="map-detail-search">
      <i data-lucide="search"></i>
      <input id="mapLayerDetailsSearch" type="search" placeholder="Buscar por nome, IP, local ou modelo">
    </label>`;

  const rows = (def.features || [])
    .map(f => {
      const cam = mapFindCamera(f, _mapCameraIndex);
      const type = mapFeatureType(f, cam);
      if (type !== 'camera') return null;
      const status = mapFeatureStatus(f, cam);
      const name = cam?.titulo || mapFeatureName(f) || cam?.ip || 'Camera';
      const ip = cam?.ip || mapExtractIp(f?.properties?.description) || '-';
      const local = mapFeatureLocal(f, cam) || '-';
      const color = status === 'online' ? '#16a34a' : status === 'offline' ? '#dc2626' : '#d97706';
      return {
        status,
      color,
      name,
      ip,
      local,
      key: mapFeatureKey(f, cam),
      layerId: def.id,
      model: cam?.modelo || cam?.model || cam?.fabricante || '',
      search: [name, ip, local, cam?.modelo, cam?.model, cam?.fabricante, status].filter(Boolean).join(' ').toLowerCase(),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const statusOrder = { offline: 0, online: 1, outros: 2 };
      return (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3)
        || a.name.localeCompare(b.name, 'pt', { numeric: true });
    });

  list.innerHTML = rows.length
    ? rows.map(r => `
      <button class="map-detail-row" data-map-layer-id="${esc(r.layerId)}" data-map-feature-key="${esc(r.key)}" data-map-status="${esc(r.status)}" data-map-search="${esc(r.search)}" title="${esc(`${r.name} | ${r.ip} | ${r.local} | ${r.model}`)}">
        <span class="map-layer-stat-dot" style="background:${r.color}"></span>
        <div><strong>${esc(r.name)}</strong><span class="muted">${esc(r.model || r.status)}</span></div>
        <span class="monospace">${esc(r.ip)}</span>
        <span class="muted">${esc(r.local)}</span>
      </button>`).join('')
    : '<div style="padding:18px;text-align:center;color:var(--muted);font-size:13px">Nenhuma camera encontrada nessa camada.</div>';

  const applyDetailFilters = () => {
    const activeFilter = summary.querySelector('[data-map-detail-filter].active')?.dataset.mapDetailFilter || 'all';
    const q = (document.getElementById('mapLayerDetailsSearch')?.value || '').trim().toLowerCase();
    let visible = 0;
    list.querySelectorAll('.map-detail-row').forEach(row => {
      const statusOk = activeFilter === 'all' || row.dataset.mapStatus === activeFilter;
      const searchOk = !q || String(row.dataset.mapSearch || '').includes(q);
      row.hidden = !(statusOk && searchOk);
      if (!row.hidden) visible += 1;
    });
    let empty = list.querySelector('.map-detail-empty-filter');
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'map-detail-empty-filter';
      empty.textContent = 'Nenhum resultado para essa busca.';
      list.appendChild(empty);
    }
    empty.hidden = visible > 0 || !list.querySelector('.map-detail-row');
  };

  summary.querySelectorAll('[data-map-detail-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      summary.querySelectorAll('[data-map-detail-filter]').forEach(b => b.classList.toggle('active', b === btn));
      applyDetailFilters();
    });
  });
  document.getElementById('mapLayerDetailsSearch')?.addEventListener('input', applyDetailFilters);

  list.querySelectorAll('[data-map-feature-key]').forEach(row => {
    row.addEventListener('click', () => focusMapFeature(row.dataset.mapLayerId, row.dataset.mapFeatureKey));
  });

  modal.classList.remove('hidden');
  lucide.createIcons();
}

function closeMapLayerDetails() {
  document.getElementById('modalMapLayerDetails')?.classList.add('hidden');
}

async function focusMapFeature(layerId, featureKey) {
  if (!_map || !layerId || !featureKey) return;
  const state = _mapLayerGroups[layerId];
  if (!state) return;
  if (!state.active) {
    const def = state.def || MAP_LAYER_DEFS.find(d => d.id === layerId) || { id: layerId };
    await toggleMapLayer(layerId, def);
  }
  const marker = state.markers?.[featureKey];
  if (!marker) {
    showToast('Ponto nao encontrado no mapa.', true);
    return;
  }
  closeMapLayerDetails();
  const latlng = marker.getLatLng();
  _map.flyTo(latlng, Math.max(_map.getZoom(), 18), { duration: 0.5 });
  setTimeout(() => marker.openPopup(), 550);
}

async function focusCameraOnMap(cam) {
  if (!cam) return;
  const targetIp = String(cam.ip || '').trim();
  const targetTitle = String(cam.titulo || cam.title || '').trim().toLowerCase();
  closeCamPanel();
  navigateTo('kmz');
  await new Promise(resolve => setTimeout(resolve, 350));
  if (!_map || !Object.keys(_mapLayerGroups || {}).length) {
    await loadKmz();
  } else {
    await loadMapLayers();
  }

  let found = null;
  for (const [layerId, state] of Object.entries(_mapLayerGroups || {})) {
    const feature = (state.features || []).find(f => {
      const matchedCam = mapFindCamera(f, _mapCameraIndex);
      const featureIp = matchedCam?.ip || mapExtractIp(f?.properties?.description) || mapExtractIp(mapFeatureName(f));
      const featureTitle = String(matchedCam?.titulo || mapFeatureName(f) || '').trim().toLowerCase();
      return (targetIp && featureIp === targetIp) || (targetTitle && featureTitle === targetTitle);
    });
    if (feature) {
      const matchedCam = mapFindCamera(feature, _mapCameraIndex) || cam;
      found = { layerId, key: mapFeatureKey(feature, matchedCam), def: state.def };
      break;
    }
  }

  if (!found) {
    showToast('Camera sem coordenada no mapa.', true);
    return;
  }

  const state = _mapLayerGroups[found.layerId];
  if (state && !state.active) {
    await toggleMapLayer(found.layerId, found.def || state.def, true);
  }
  await focusMapFeature(found.layerId, found.key);
}

function renderMapMarkers(camByName, camByIp) {
  // Remove camadas anteriores
  _mapLayers.forEach(l => _map.removeLayer(l));
  _mapLayers = [];

  const statusFilter = document.getElementById('mapFilterStatus')?.value || '';
  const siteFilter   = document.getElementById('mapFilterSite')?.value   || '';

  const cluster = L.layerGroup();

  const bounds = [];
  let shown = 0;

  console.log('[MAP] features total:', _mapFeatures.length, '| cluster type:', typeof cluster, typeof L.markerClusterGroup);

  _mapFeatures.forEach(f => {
    if (f.geometry?.type !== 'Point') return;
    const [lng, lat] = f.geometry?.coordinates || [];
    if (lat == null || lng == null || isNaN(+lat) || isNaN(+lng)) return;

    const props = f.properties || {};
    const name  = props.name || '';
    const desc  = props.description || '';

    // Busca dados da camera para popup e para status ao vivo (Zabbix), em vez
    // de confiar no texto estatico gravado no KMZ na hora que foi gerado.
    const cam = camByName[name.toLowerCase()] || Object.values(camByIp).find(c =>
      c.titulo?.toLowerCase() === name.toLowerCase()
    );
    const isOnline  = cam?.status ? String(cam.status).toLowerCase() === 'online' : desc.includes('ONLINE');
    const isOffline = cam?.status ? String(cam.status).toLowerCase() === 'offline' : (desc.includes('OFFLINE') || (!isOnline && desc.includes('STATUS')));
    const statusStr = isOnline ? 'online' : isOffline ? 'offline' : 'outros';

    if (statusFilter && statusStr !== statusFilter) return;
    if (siteFilter) {
      const m = desc.match(/LOCAL.*?>(.*?)</i);
      const local = m ? m[1].trim() : '';
      if (local !== siteFilter) return;
    }

    // Detecta tipo pelo nome -- se bate com uma camera real do inventario, e
    // camera, nao importa se o ponto veio de layer "gerado" ou importado.
    const nameLow = name.toLowerCase();
    let pointType = 'other';
    if (cam || !f._source || f._source === 'generated') {
      pointType = 'camera';
    } else if (/\bcto\b|^cto/i.test(name)) {
      pointType = 'cto';
    } else if (/\bcdo\b|^cdo|emenda|splice/i.test(name)) {
      pointType = 'cdo';
    } else if (/cam|camera|vip-|vipc|vip\s|\bcam\s/i.test(name)) {
      pointType = 'camera';
    }

    const typeConfig = {
      camera: { bg: isOnline ? '#16a34a' : '#dc2626', label: '' },
      cto:    { bg: '#1971c2', label: 'CTO' },
      cdo:    { bg: '#7950f2', label: 'CDO' },
      other:  { bg: '#d97706', label: '' },
    };
    const tc = typeConfig[pointType] || typeConfig.other;

    const icon  = L.divIcon({
      html: `<div style="background:${tc.bg};color:white;border:2px solid white;border-radius:6px;padding:3px 5px;font-size:10px;font-weight:700;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4);cursor:pointer">${tc.label}</div>`,
      className: '',
      iconSize: [40, 22],
      iconAnchor: [20, 11],
      popupAnchor: [0, -14],
    });

    const marker = L.marker([lat, lng], { icon });

    // Popup
    const isImported = f._source === 'imported';
    const snapHtml = cam?.snapshot_url
      ? `<img src="${API_BASE}${cam.snapshot_url}" style="width:100%;display:block;max-height:150px;object-fit:cover">`
      : isImported
        ? `<div style="width:100%;height:60px;background:#2d3748;display:flex;align-items:center;justify-content:center;color:#a0aec0;font-size:11px;gap:6px"> Ponto importado</div>`
        : `<div style="width:100%;height:80px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;color:#4a5568;font-size:12px">Sem snapshot</div>`;

    const statusBadge = isOnline
      ? `<span style="color:#16a34a;font-weight:700"> online</span>`
      : `<span style="color:#dc2626;font-weight:700"> offline</span>`;

    marker.bindPopup(`
      <div style="width:220px">
        ${snapHtml}
        <div style="padding:10px 12px">
          <div style="font-weight:700;font-size:13px;margin-bottom:4px">${esc(name)}</div>
          <div style="font-size:11px;color:#666;margin-bottom:6px">${statusBadge}</div>
          ${cam?.ip ? `<div style="font-size:11px;color:#888;font-family:monospace">${esc(cam.ip)}</div>` : ''}
          ${cam?.local ? `<div style="font-size:11px;color:#888">${esc(cam.local)}</div>` : ''}
          <div style="margin-top:8px;display:flex;gap:6px">
            <a href="https://www.google.com/maps?q=${lat},${lng}" target="_blank"
               style="flex:1;text-align:center;padding:5px;background:#f1f5f9;border-radius:5px;font-size:11px;color:#374151;text-decoration:none">
               Google Maps
            </a>
            ${cam?.ip ? `<a href="http://${cam.ip}" target="_blank"
               style="flex:1;text-align:center;padding:5px;background:#f1f5f9;border-radius:5px;font-size:11px;color:#374151;text-decoration:none">
               Camera
            </a>` : ''}
          </div>
        </div>
      </div>`, { maxWidth: 240 });

    cluster.addLayer(marker);
    bounds.push([+lat, +lng]);
    shown++;
  });

  _map.addLayer(cluster);
  _mapLayers.push(cluster);

  console.log('[MAP] shown:', shown, '| bounds:', bounds.slice(0,2));
  setText('mapCounter', `${shown} ponto${shown !== 1 ? 's' : ''} no mapa`);

  // Ajusta view
  if (bounds.length > 0) {
    try { _map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 }); } catch {}
  }
}

async function loadInvOlt() {
  _camSessionLoad();
  const desired = _invOltView || 'olt';
  const hasAny = ['basico','olt','switch'].some(mode => _invCam[mode]?.length);
  if (!_invCam[desired]?.length) {
    await _loadCamForMode(desired);
  } else if (!hasAny) {
    await _loadCamForMode('olt');
  }
  updateCamTabs();
  populateCamSiteFilter();
  applyInvOltFilters();
}

async function _loadCamForMode(mode) {
  const inventoryMode = mode === 'switch' ? 'switch' : mode === 'basico' ? 'basico' : 'olt';
  const [camData, swData, oltData] = await Promise.all([
    apiJson(`/api/cameras?mode=${encodeURIComponent(inventoryMode)}&_=${Date.now()}`),
    mode === 'switch' ? apiJson('/api/switch/rows') : Promise.resolve(null),
    mode === 'olt'    ? apiJson('/api/olt/rows')    : Promise.resolve(null),
  ]);

  let cameras = camData?.cameras || (Array.isArray(camData) ? camData : []);

  if (mode === 'switch' && swData) {
    const swByMac = {};
    (swData?.rows || []).forEach(r => { if (r.mac) swByMac[r.mac.toLowerCase()] = r; });
    cameras = cameras.map(c => {
      const sw = swByMac[(c.mac||'').toLowerCase()] || null;
      return { ...c,
        switch_ip:   sw ? (sw.switch_ip||sw.olt_ip||'')  : '',
        switch_port: sw ? (sw.switch_port||sw.port||'')   : '',
        switch_vlan: sw ? (sw.switch_vlan||sw.vlan||'')   : '',
      };
    });
  }

  if (mode === 'olt' && oltData) {
    const oltByMac = {};
    (oltData?.rows || []).forEach(r => { if (r.cpe_mac) oltByMac[r.cpe_mac.toLowerCase()] = r; });
    cameras = cameras.map(c => {
      const olt = oltByMac[(c.mac||'').toLowerCase()] || {};
      return { ...c,
        pon:        c.pon        || olt.pon        || '',
        onu_id:     c.onu_id     || olt.onu_id     || '',
        onu_name:   c.onu_name   || olt.onu_name   || '',
        onu_serial: c.onu_serial || olt.onu_serial || '',
      };
    });
  }

  // Mescla imgbb_url da sessao
  const saved = _imgbbGet();
  if (Object.keys(saved).length) {
    cameras = cameras.map(c => {
      const savedUrl = saved[_camKey(c)] || saved[`IP:${String(c.ip || '').trim()}`] || saved[c.ip];
      return savedUrl ? { ...c, imgbb_url: savedUrl, imgbb_status: 'up' } : c;
    });
  }

  // Ordena por IP
  const ipToInt = ip => (ip||'0.0.0.0').split('.').reduce((a,b) => (a<<8)|(parseInt(b)||0), 0)>>>0;
  cameras.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  _invCam[mode] = cameras;
  _camSessionSave(mode, cameras);
}

function populateCamSiteFilter() {
  const all   = Object.values(_invCam).flat();
  const sites = [...new Set(all.map(c => c.local || c.site || c.site_name).filter(Boolean))].sort();
  const sel = document.getElementById('filterSiteOlt');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Todos os sites</option>' +
    sites.map(s => `<option value="${esc(s)}"${s === current ? ' selected' : ''}>${esc(s)}</option>`).join('');
}

function matchesIpFilter(ip, query) {
  if (!query) return true;
  const q = query.trim();
  // lista: 10.0.0.1,10.0.0.2
  if (q.includes(',')) {
    return q.split(',').map(s => s.trim()).includes(ip);
  }
  // CIDR: 10.0.0.0/24
  if (q.includes('/')) {
    try {
      const [base, bits] = q.split('/');
      const mask = ~(0xffffffff >>> parseInt(bits)) >>> 0;
      const ipInt = ip.split('.').reduce((a, b) => (a << 8) | parseInt(b), 0) >>> 0;
      const baseInt = base.split('.').reduce((a, b) => (a << 8) | parseInt(b), 0) >>> 0;
      return (ipInt & mask) === (baseInt & mask);
    } catch { return false; }
  }
  // range: 10.0.0.1-10.0.0.50
  if (q.includes('-') && q.split('-').length === 2) {
    const [start, end] = q.split('-');
    const toInt = s => s.split('.').reduce((a, b) => (a << 8) | parseInt(b), 0) >>> 0;
    const ipInt = toInt(ip);
    try { return ipInt >= toInt(start) && ipInt <= toInt(end); } catch { /* fall through */ }
  }
  return false;
}

function _isBlankValue(value) {
  const s = String(value ?? '').trim();
  return !s || s === '' || s === '-' || /^n\/?a$/i.test(s);
}

function camHasMissingData(c) {
  const required = [c.ip, c.mac, c.fabricante, c.modelo || c.model, c.titulo, c.local];
  if (_invOltView === 'olt') required.push(c.pon, c.onu_id, c.onu_name, c.onu_serial);
  if (_invOltView === 'switch') required.push(c.switch_ip, c.switch_port);
  return required.some(_isBlankValue);
}

function camHasDefaultTitle(c) {
  const title = String(c.titulo || '').trim().toLowerCase();
  if (_isBlankValue(title)) return true;
  return [
    /^c[aa]mera\s*\d{1,3}$/i,
    /^camera\s*\d{1,3}$/i,
    /^cam\s*\d{1,3}$/i,
    /camera\s*0?\d{1,3}/i,
    /c[aa]mera\s*0?\d{1,3}/i,
    /^ip\s*camera/i,
    /^hikvision/i,
    /hikvision/i,
    /^vip(?:-|_|\s|$)/i,
    /^vip\s*intelbras/i,
    /^intelbras\s*vip/i,
    /^vip-\d/i,
    /vip[-\s]?\d/i,
  ].some(rx => rx.test(title));
}

function camHasImgbbDown(c) {
  return !cameraImgbbUrl(c);
}

function camHasNoOltData(c) {
  return [c.pon, c.onu_id, c.onu_name, c.onu_serial].some(_isBlankValue);
}

let _camStatusRefreshTimer = null;
let _camStatusRefreshKey = '';

function scheduleFilteredCamStatusRefresh(rows, query) {
  const q = String(query || '').trim();
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(q)) {
    _camStatusRefreshKey = '';
    return;
  }
  // Status oficial vem do inventario/Zabbix. Ping automatico na busca e apenas
  // diagnostico e nao deve sobrescrever a tabela.
  _camStatusRefreshKey = q;
  clearTimeout(_camStatusRefreshTimer);
}

function applyInvOltFilters() {
  const q       = (document.getElementById('searchInvOlt')?.value || '').toLowerCase().trim();
  const status  = document.getElementById('filterStatusOlt')?.value || '';
  const site    = document.getElementById('filterSiteOlt')?.value || '';

  const filtered = (_invCam[_invOltView] || []).filter(c => {
    if (status === 'missing_data' && !camHasMissingData(c)) return false;
    else if (status === 'default_title' && !camHasDefaultTitle(c)) return false;
    else if (status === 'imgbb_down' && !camHasImgbbDown(c)) return false;
    else if (status === 'no_olt' && !camHasNoOltData(c)) return false;
    else if (status && !['missing_data','default_title','imgbb_down','no_olt'].includes(status) && (c.status || '').toLowerCase() !== status) return false;
    if (site && ![c.local, c.site, c.site_name].some(v => String(v || '') === site)) return false;
    if (q) {
      // tenta match de IP com range/CIDR/lista
      const ipMatch = matchesIpFilter(c.ip || '', q);
      // ou texto livre em qualquer campo
      const textMatch = [c.ip, c.mac, c.fabricante, c.modelo, c.model, c.titulo, c.local, c.onu_name, c.onu_serial]
        .some(f => (f || '').toLowerCase().includes(q));
      if (!ipMatch && !textMatch) return false;
    }
    return true;
  });

  // Ordena por IP crescente
  const ipToInt = ip => (ip || '0.0.0.0').split('.').reduce((a, b) => (a << 8) | (parseInt(b) || 0), 0) >>> 0;
  filtered.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  renderInvOlt(filtered);
  scheduleFilteredCamStatusRefresh(filtered, q);
}

function renderInvOlt(cameras) {
  const def   = INV_COLS[_invOltView] || INV_COLS.basico;
  const ncols = def.cols.length;
  const tbody = document.getElementById('invOltTable');
  const table = document.getElementById('invOltTableEl');
  // Colunas em %: a tabela sempre cabe em 100% do container, sem forcar
  // min-width (isso e o que garante zero scroll horizontal).
  if (table) table.style.minWidth = '';

  // Atualiza colgroup
  const colgroup = table.querySelector('colgroup');
  if (colgroup) colgroup.innerHTML = def.cols.map(w => `<col style="width:${w}">`).join('');

  // Atualiza thead
  const thead = table.querySelector('thead tr');
  if (thead) thead.innerHTML = def.heads.map((h, i) =>
    i === 0
      ? `<th><input type="checkbox" id="chkOltAll"></th>`
      : `<th>${h}</th>`
  ).join('');

  // Contadores
  const online  = cameras.filter(c => (c.status||'').toLowerCase() === 'online').length;
  const offline = cameras.filter(c => (c.status||'').toLowerCase() === 'offline').length;
  setText('invOltTotal',   cameras.length);
  setText('invOltOnline',  online);
  setText('invOltOffline', offline);
  setText('invOltOutros',  cameras.length - online - offline);
  setText('invOltFooter',  `${cameras.length} camera${cameras.length!==1?'s':''}`);

  if (!cameras.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${ncols}">Nenhum resultado.</td></tr>`;
    return;
  }

  tbody.innerHTML = cameras.map(c => {
    const cells = def.row(c);
    return `<tr class="inv-olt-row" data-ip="${esc(c.ip)}" style="cursor:pointer">
      ${cells.map((cell, i) =>
        i === 0
          ? `<td onclick="event.stopPropagation()">${cell}</td>`
          : `<td>${cell}</td>`
      ).join('')}
    </tr>`;
  }).join('');

  tbody.querySelectorAll('.inv-olt-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const cam = _invOltAll_get().find(c => c.ip === tr.dataset.ip);
      if (cam) openCamPanel(cam);
    });
  });

  if (_pendingOpenCamIp) {
    const ip  = _pendingOpenCamIp;
    _pendingOpenCamIp = null;
    const cam = _invOltAll_get().find(c => c.ip === ip);
    if (cam) {
      const tr = tbody.querySelector(`[data-ip="${CSS.escape(ip)}"]`);
      if (tr) tr.scrollIntoView({ block: 'center', behavior: 'smooth' });
      openCamPanel(cam);
    }
  }

  document.getElementById('chkOltAll').onchange = function() {
    document.querySelectorAll('.chk-olt').forEach(c => c.checked = this.checked);
  };

  lucide.createIcons();
}

function isImgbbUrl(url) {
  if (!url) return false;
  return /imgbb\.com|ibb\.co/i.test(url);
}

function invStatusBadge(status) {
  if (!status) return '<span class="text-muted"></span>';
  const s = status.toLowerCase();
  if (s === 'online')      return `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`;
  if (s === 'offline')     return `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`;
  if (s === 'auth_failed') return `<span style="color:var(--amber);font-weight:600;font-size:12px">auth_failed</span>`;
  return `<span style="color:var(--muted);font-size:12px">${esc(status)}</span>`;
}

//  Painel lateral da camera 
function openCamPanel(cam) {
  _invOltActive = cam;
  stopPing();

  // Destaca linha
  document.querySelectorAll('.inv-olt-row').forEach(tr => {
    tr.classList.toggle('row-selected', tr.dataset.ip === cam.ip);
  });

  // Preenche info
  const statusColor = cam.status === 'online' ? 'var(--primary)' : cam.status === 'offline' ? 'var(--danger)' : 'var(--amber)';
  const header = document.getElementById('camPanelStatus');
  header.textContent = cam.status || '';
  header.style.color = statusColor;
  setText('camPanelTitulo', cam.titulo || cam.ip);
  setText('cpMac',    cam.mac    || '');
  setText('cpModelo', cam.model  || '');
  setText('cpLocal',  cam.local  || '');
  setText('cpPonOnu', [cam.pon, cam.onu_id].filter(Boolean).join(' / ') || '');
  setText('cpSerial', cam.onu_serial || '');

  // Snapshot
  const img = document.getElementById('cpSnapshot');
  const empty = document.getElementById('cpSnapshotEmpty');
  if (cam.snapshot_url) {
    img.src = cam.snapshot_url;
    img.style.display = 'block';
    empty.style.display = 'none';
    setText('cpSnapshotTitle', cam.titulo || cam.ip);
    setText('cpSnapshotTime',  '');
  } else {
    img.style.display = 'none';
    empty.style.display = 'flex';
    setText('cpSnapshotTitle', '');
    setText('cpSnapshotTime', '');
  }

  document.getElementById('cpPingResult')?.classList.add('hidden');
  document.getElementById('camPanelBackdrop')?.classList.remove('hidden');
  document.getElementById('camPanel').classList.remove('hidden');
  lucide.createIcons();
}

function closeCamPanel() {
  stopPing();
  _invOltActive = null;
  document.getElementById('camPanelBackdrop')?.classList.add('hidden');
  document.getElementById('camPanel').classList.add('hidden');
  document.querySelectorAll('.inv-olt-row').forEach(tr => tr.classList.remove('row-selected'));
}

//  Ping Terminal 
let _pingIp    = null;
let _pingCount = 0;
let _pingOk    = 0;
let _pingFail  = 0;

function openPingTerminal(ip) {
  _pingIp = ip;
  document.getElementById('pingTermTitle').textContent = `ping ${ip}`;
  document.getElementById('pingTermBody').innerHTML = '';
  document.getElementById('pingTermStats').textContent = '';
  document.getElementById('pingTerminal').classList.remove('hidden');
  lucide.createIcons();
  runPing();
}

function runPing() {
  stopPing();
  _pingCount = 0; _pingOk = 0; _pingFail = 0;
  const ip = _pingIp;
  if (!ip) return;

  pingLine(`Iniciando ping para ${ip}`, 'info');

  _pingInterval = setInterval(async () => {
    _pingCount++;
    const startedAt = performance.now();
    const res = await apiJson(`/api/cameras/ping?ip=${encodeURIComponent(ip)}&force=1`);
    const elapsedMs = performance.now() - startedAt;
    const rawMs = res?.ping_ms ?? res?.ms ?? res?.latency;
    const ms = Number.isFinite(Number(rawMs)) ? Number(rawMs) : elapsedMs;
    const ok  = Boolean(res?.online ?? res?.reachable);

    if (ok) {
      _pingOk++;
      pingLine(`[${_pingCount}] ${ip}: ${formatPingMs(ms)} (${res?.method || 'ping'})`, 'ok');
    } else {
      _pingFail++;
      pingLine(`[${_pingCount}] ${ip}: offline (${res?.error || formatPingMs(elapsedMs)})`, 'fail');
    }
    updatePingStats();
  }, 1000);
}

function formatPingMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 'sem medida';
  return `${n.toFixed(3)} ms`;
}

function pingLine(text, type = '') {
  const body = document.getElementById('pingTermBody');
  const line = document.createElement('div');
  if (type) line.className = `ping-term-line-${type}`;
  line.textContent = text;
  body.appendChild(line);
  body.scrollTop = body.scrollHeight;
}

function updatePingStats() {
  const loss = _pingCount > 0 ? Math.round((_pingFail / _pingCount) * 100) : 0;
  document.getElementById('pingTermStats').textContent =
    `Enviados: ${_pingCount}    OK: ${_pingOk}    Falhas: ${_pingFail}    Perda: ${loss}%`;
}

function stopPing() {
  if (_pingInterval) { clearInterval(_pingInterval); _pingInterval = null; }
}

function closePingTerminal() {
  stopPing();
  document.getElementById('pingTerminal').classList.add('hidden');
}

function startPing() {
  if (!_invOltActive) return;
  openPingTerminal(_invOltActive.ip);
}

//  Acoes do painel 
function openCamAuthAction(action) {
  if (!_invOltActive) return;
  const cam = _invOltActive;
  const labels = {
    atualizar: { title: 'Atualizar snapshot', icon: 'refresh-cw', label: 'Atualizar' },
    reboot: { title: 'Reboot da camera', icon: 'power', label: 'Reboot' },
  };
  const meta = labels[action] || labels.atualizar;
  _camAuthAction = action;
  setText('camAuthEyebrow', cam.ip);
  setText('camAuthTitle', meta.title);
  document.getElementById('camAuthIp').value = `${cam.ip} - ${cam.titulo || ''}`;
  document.getElementById('camAuthUser').value = 'admin';
  document.getElementById('camAuthPass').value = '';
  document.getElementById('camAuthErro').hidden = true;
  const btn = document.getElementById('confirmCamAuthAction');
  btn.innerHTML = `<i data-lucide="${meta.icon}"></i> ${meta.label}`;
  btn.disabled = false;
  document.getElementById('modalCamAuthAction').classList.remove('hidden');
  setTimeout(() => document.getElementById('camAuthPass').focus(), 80);
  lucide.createIcons();
}

function closeCamAuthAction() {
  document.getElementById('modalCamAuthAction')?.classList.add('hidden');
  _camAuthAction = null;
}

function camAuthCreds() {
  return {
    user: document.getElementById('camAuthUser')?.value.trim() || 'admin',
    pass: document.getElementById('camAuthPass')?.value || '',
  };
}

async function updateCameraSnapshot(cam, cred) {
  showToast('Capturando snapshot...');
  const res = await api('/api/cameras/snapshot/capture', {
    method: 'POST',
    body: JSON.stringify({ ip: cam.ip, user: cred.user, password: cred.pass }),
  });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) {
    showToast(data?.detail || data?.error || 'Erro ao capturar snapshot.', true);
    return;
  }
  cam.snapshot_url = data.url;
  _invOltActive = cam;
  const img = document.getElementById('cpSnapshot');
  const empty = document.getElementById('cpSnapshotEmpty');
  img.src = `${API_BASE}${data.url}?t=${Date.now()}`;
  img.style.display = 'block';
  empty.style.display = 'none';
  showToast('Snapshot atualizado.');
  setTimeout(loadInvOlt, 800);
}

async function rebootCamera(cam, cred) {
  const res = await api('/api/maintenance/batch/reboot', {
    method: 'POST',
    body: JSON.stringify({ ips: [cam.ip], user: cred.user, pass: cred.pass }),
  });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) {
    const first = (data?.results || []).find(r => !r.ok) || {};
    throw new Error(data?.error || first.error || 'Erro ao reiniciar camera.');
  }
  showToast('Reboot enviado.');
}

async function runCamAuthAction() {
  if (!_invOltActive || !_camAuthAction) return;
  const cam = _invOltActive;
  const action = _camAuthAction;
  const cred = camAuthCreds();
  const erro = document.getElementById('camAuthErro');
  const btn = document.getElementById('confirmCamAuthAction');
  if (!cred.pass) {
    erro.textContent = 'Informe a senha da camera.';
    erro.hidden = false;
    return;
  }
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Executando';
  lucide.createIcons();
  try {
    if (action === 'atualizar') await updateCameraSnapshot(cam, cred);
    if (action === 'reboot') await rebootCamera(cam, cred);
    closeCamAuthAction();
  } catch (err) {
    erro.textContent = err.message || 'Falha ao executar acao.';
    erro.hidden = false;
    showToast(erro.textContent, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    lucide.createIcons();
  }
}

async function camAction(action) {
  if (!_invOltActive) return;
  const cam = _invOltActive;

  if (action === 'atualizar') {
    openCamAuthAction('atualizar');
    return;
  }
  if (action === 'reboot') {
    openCamAuthAction('reboot');
    return;
  }
  if (action === 'web')   { window.open(`http://${cam.ip}`, '_blank'); return; }

  if (action === 'renomear') {
    openEditCamModal([cam], { renameDevice: true });
    return;
  }
  if (action === 'trocar-ip') {
    document.getElementById('trocarIpAtual').value = cam.ip;
    document.getElementById('trocarIpNovo').value  = '';
    document.getElementById('trocarIpMask').value  = '';
    document.getElementById('trocarIpGw').value    = '';
    document.getElementById('trocarIpUser').value  = 'admin';
    document.getElementById('trocarIpPass').value  = '';
    document.getElementById('trocarIpErro').hidden = true;
    document.getElementById('modalTrocarIp').classList.remove('hidden');
    setTimeout(() => document.getElementById('trocarIpNovo').focus(), 50);
    lucide.createIcons();
    return;
  }
  if (action === 'trocar-senha') {
    document.getElementById('trocarSenhaIp').value      = `${cam.ip}    ${cam.titulo || ''}`;
    document.getElementById('trocarSenhaUser').value    = 'admin';
    document.getElementById('trocarSenhaAtual').value   = '';
    document.getElementById('trocarSenhaNova').value    = '';
    document.getElementById('trocarSenhaConfirm').value = '';
    document.getElementById('trocarSenhaErro').hidden   = true;
    document.getElementById('modalTrocarSenha').classList.remove('hidden');
    setTimeout(() => document.getElementById('trocarSenhaNova').focus(), 50);
    lucide.createIcons();
    return;
  }
  if (action === 'data-hora') {
    const now = new Date();
    document.getElementById('dataHoraIp').value    = `${cam.ip}    ${cam.titulo || ''}`;
    document.getElementById('dataHoraUser').value  = 'admin';
    document.getElementById('dataHoraPass').value  = '';
    document.getElementById('dataHoraData').value  = now.toLocaleDateString('sv');
    document.getElementById('dataHoraHora').value  = now.toTimeString().slice(0,5);
    document.getElementById('dataHoraErro').hidden = true;
    document.getElementById('modalDataHora').classList.remove('hidden');
    lucide.createIcons();
    return;
  }
  if (action === 'limpar') {
    if (!await showConfirm({ title: `Remover camera`, msg: `Remover ${cam.ip}  ${cam.titulo || ''} do inventario?`, label: 'Remover' })) return;
    const key = _camKey(cam);
    const res = await api('/api/inventory/delete', {
      method: 'POST',
      body: JSON.stringify({ ips: [cam.ip], keys: [key], mode: _invOltView || 'olt' }),
    });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok || data?.ok === false) {
      showToast(data?.detail || data?.error || 'NAo foi possAvel remover a cAmera.', true);
      return;
    }
    _camRemoveIpsLocally([key]);
    showToast('Camera removida.');
    closeCamPanel();
    updateCamTabs();
    populateCamSiteFilter();
    applyInvOltFilters();
    return;
  }
}

//  Inventario DVR 
async function loadInvDvr() {
  const data = await apiJson('/api/dvr/inventory');
  const dvrs = data?.dvrs || data || [];
  const tbody = document.getElementById('invDvrTable');
  if (!dvrs.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="7">Nenhum DVR. Execute uma varredura.</td></tr>';
    setText('invDvrFooter', '0 DVRs');
    return;
  }
  tbody.innerHTML = dvrs.map(d => `
    <tr>
      <td class="monospace">${esc(d.ip)}</td>
      <td>${esc(d.brand || '')} ${esc(d.model || '')}</td>
      <td class="text-muted">${esc(d.channels || '')}</td>
      <td class="text-muted monospace">${esc(d.firmware || '')}</td>
      <td class="text-muted">${esc(d.last_snapshot || '')}</td>
      <td>${statusBadge(d.status)}</td>
      <td>
        <button class="ghost-action" style="padding:4px 8px;font-size:12px" onclick="openCamera('${esc(d.ip)}')">
          <i data-lucide="external-link"></i>
        </button>
      </td>
    </tr>`).join('');
  setText('invDvrFooter', `${dvrs.length} DVR${dvrs.length !== 1 ? 's' : ''}`);
  lucide.createIcons();
}

//  Inventario NVR 
// Gravadores  NVR e DVR com dados por modo
const _invNvr   = { basico: [], olt: [], switch: [] };
const _invDvr   = { basico: [], olt: [], switch: [] };
let _invNvrView   = (() => {
  try { return sessionStorage.getItem('so_rec_view') || 'olt'; } catch { return 'olt'; }
})();
let _recType      = (() => {
  try { return sessionStorage.getItem('so_rec_type') || 'nvr'; } catch { return 'nvr'; }
})(); // 'nvr' | 'dvr'
let _nvrAbortCtrl = null;
let _recActive    = null;
let _recAction    = null;
let _nvrActiveScan = null;

function _recSessionSave(type, mode, rows) {
  try { sessionStorage.setItem(`so_${type}_${mode}`, JSON.stringify(rows)); } catch {}
}
function _recSessionLoad() {
  ['nvr','dvr'].forEach(type => {
    const store = type === 'nvr' ? _invNvr : _invDvr;
    ['basico','olt','switch'].forEach(m => {
      try {
        const d = JSON.parse(sessionStorage.getItem(`so_${type}_${m}`) || 'null');
        if (Array.isArray(d)) store[m] = d;
      } catch {}
    });
    pruneSyntheticRecModes(type);
  });
}
function _nvrSessionSave(mode, rows) { _recSessionSave('nvr', mode, rows); }
function _nvrSessionLoad() { _recSessionLoad(); }

async function _loadRecBasico() {
  const [nvrData, dvrData] = await Promise.all([
    apiJson('/api/nvr/inventory'),
    apiJson('/api/dvr/inventory'),
  ]);
  _invNvr.basico = nvrData?.inventory || [];
  _invDvr.basico = dvrData?.inventory || [];
  _recSessionSave('nvr', 'basico', _invNvr.basico);
  _recSessionSave('dvr', 'basico', _invDvr.basico);
}

async function _loadRecBasicoForType(type) {
  const endpoint = type === 'dvr' ? '/api/dvr/inventory' : '/api/nvr/inventory';
  const data = await apiJson(endpoint);
  const rows = data?.inventory || [];
  const store = type === 'dvr' ? _invDvr : _invNvr;
  store.basico = rows;
  _recSessionSave(type, 'basico', rows);
  return rows;
}

async function _loadRecForMode(type, mode) {
  const store = type === 'dvr' ? _invDvr : _invNvr;
  if (mode === 'basico') {
    return _loadRecBasicoForType(type);
  }
  if (!store.basico?.length) {
    await _loadRecBasicoForType(type);
  }
  const rows = await enrichRecRowsForMode(store.basico || [], mode);
  if (recModeHasRealData(rows, mode)) {
    store[mode] = rows;
    _recSessionSave(type, mode, rows);
    return rows;
  }
  store[mode] = [];
  try { sessionStorage.removeItem(`so_${type}_${mode}`); } catch {}
  return [];
}
function _nvrSessionClear() {
  ['nvr','dvr'].forEach(type => {
    const store = type === 'nvr' ? _invNvr : _invDvr;
    ['basico','olt','switch'].forEach(m => {
      try { sessionStorage.removeItem(`so_${type}_${m}`); } catch {}
      store[m] = [];
    });
  });
}

function recModeHasRealData(rows, mode) {
  if (!Array.isArray(rows) || !rows.length) return false;
  if (mode === 'olt') return rows.some(r => ![r.pon, r.onu_id, r.onu_name, r.onu_serial].every(_isBlankValue));
  if (mode === 'switch') return rows.some(r => ![r.switch_ip, r.switch_port, r.switch_vlan].every(_isBlankValue));
  return rows.length > 0;
}

function pruneSyntheticRecModes(type) {
  const store = type === 'dvr' ? _invDvr : _invNvr;
  ['olt', 'switch'].forEach(mode => {
    if (store[mode]?.length && !recModeHasRealData(store[mode], mode)) {
      store[mode] = [];
      try { sessionStorage.removeItem(`so_${type}_${mode}`); } catch {}
    }
  });
}

function removeRecItemsLocally(type, items) {
  const store = type === 'dvr' ? _invDvr : _invNvr;
  const keys = new Set(items.map(x => `${x.host}|${Number(x.channel || 0)}`));
  ['basico', 'olt', 'switch'].forEach(mode => {
    if (!store[mode]?.length) return;
    store[mode] = store[mode].filter(r => !keys.has(`${r.host}|${Number(r.channel || 0)}`));
    _recSessionSave(type, mode, store[mode]);
  });
}

function removeRecHostLocally(type, host) {
  const store = type === 'dvr' ? _invDvr : _invNvr;
  ['basico', 'olt', 'switch'].forEach(mode => {
    if (!store[mode]?.length) return;
    store[mode] = store[mode].filter(r => String(r.host || '') !== String(host || ''));
    _recSessionSave(type, mode, store[mode]);
  });
}

function discardActiveRecorderScan() {
  const scan = _nvrActiveScan;
  if (!scan?.host) return;
  const items = Array.from({ length: Math.max(0, scan.end - scan.start + 1) }, (_, i) => ({
    host: scan.host,
    channel: scan.start + i,
  }));
  removeRecHostLocally(scan.type, scan.host);
  api(`/api/${scan.type}/delete`, { method: 'POST', body: JSON.stringify({ items }), skipLogout: true }).catch(() => {});
  updateNvrTabs();
  populateNvrFilters();
  applyNvrFilters();
}

function recImgbbUrl(r) {
  return r.imgbb_url || r.imgbb_thumb_url || (isImgbbUrl(r.snapshot_url) ? r.snapshot_url : '');
}

function recImgbbCell(r) {
  const url = recImgbbUrl(r);
  return url
    ? `<a href="${esc(url)}" target="_blank" onclick="event.stopPropagation()" style="color:var(--primary);font-weight:700;font-size:12px;text-decoration:none"> up</a>`
    : `<span style="color:var(--danger);font-weight:700;font-size:12px"> down</span>`;
}

function recHasMissingData(r) {
  const required = _recType === 'dvr'
    ? [r.host, r.channel, r.title, r.local, r.status, r.mac, r.modelo || r.model]
    : [r.host, r.channel, r.title, r.local, r.status, r.camera_ip, r.camera_model || r.modelo, r.camera_mac || r.mac];
  if (_invNvrView === 'olt') required.push(r.pon, r.onu_id, r.onu_name, r.onu_serial);
  if (_invNvrView === 'switch') required.push(r.switch_ip, r.switch_port);
  return required.some(_isBlankValue);
}

function recHasDefaultTitle(r) {
  return camHasDefaultTitle({ titulo: r.title });
}

function recHasNoCamera(r) {
  return _recType === 'nvr'
    ? [r.camera_ip, r.camera_model || r.modelo, r.camera_mac || r.mac].some(_isBlankValue)
    : _isBlankValue(r.mac);
}

// Larguras em % (nunca px fixo): garantem que a tabela nunca ultrapasse
// 100% do container, ou seja, zero scroll horizontal em qualquer zoom/tela.
// Ver skill sightops-table-fix para o metodo completo.
const NVR_COLS = {
  basico: {
    cols: ['3%','10%','8%','4%','15%','7%','7%','5%','9%','8%','11%','8%','5%'],
    heads: ['','Host NVR','Modelo NVR','CH','Titulo','Local','Status','ImgBB','IP Camera','Modelo Cam.','MAC Camera','Serial','V.Loss'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace" title="${esc(r.host||'')}">${esc(r.host||'')}</span>`,
      `<span class="text-muted" title="${esc(r.nvr_model||'')}">${esc(r.nvr_model||'')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??''))}</span>`,
      `<strong title="${esc(r.title||'')}">${esc(r.title||'')}</strong>`,
      `<span title="${esc(r.local||'')}">${esc(r.local||'')}</span>`,
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted" title="${esc(r.camera_ip||'')}">${esc(r.camera_ip||'')}</span>`,
      `<span class="text-muted" title="${esc(r.camera_model||r.modelo||'')}">${esc(r.camera_model||r.modelo||'')}</span>`,
      `<span class="monospace text-muted" title="${esc(r.camera_mac||r.mac||'')}" style="font-size:11px">${esc(r.camera_mac||r.mac||'')}</span>`,
      `<span class="text-muted" title="${esc(r.equip_serial||'')}">${esc(r.equip_serial||'')}</span>`,
      r.video_loss
        ? `<span style="color:var(--danger);font-weight:600;font-size:11px">SIM</span>`
        : `<span class="text-muted" style="font-size:11px">nao</span>`,
    ],
  },
  olt: {
    cols: ['3%','11%','4%','15%','7%','7%','5%','9%','8%','4%','5%','10%','12%'],
    heads: ['','Host NVR','CH','Titulo','Local','Status','ImgBB','IP Camera','Modelo Cam.','PON','ONU ID','ONU Name','ONU Serial'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace" title="${esc(r.host||'')}">${esc(r.host||'')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??''))}</span>`,
      `<strong title="${esc(r.title||'')}">${esc(r.title||'')}</strong>`,
      `<span title="${esc(r.local||'')}">${esc(r.local||'')}</span>`,
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted" title="${esc(r.camera_ip||'')}">${esc(r.camera_ip||'')}</span>`,
      `<span class="text-muted" title="${esc(r.camera_model||r.modelo||'')}">${esc(r.camera_model||r.modelo||'')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.pon||''))}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.onu_id||''))}</span>`,
      `<span class="text-muted" title="${esc(r.onu_name||'')}" style="font-size:11px">${esc(r.onu_name||'')}</span>`,
      `<span class="monospace text-muted" title="${esc(r.onu_serial||'')}" style="font-size:11px">${esc(r.onu_serial||'')}</span>`,
    ],
  },
  switch: {
    cols: ['4%','12%','4%','18%','8%','8%','6%','10%','9%','12%','6%','3%'],
    heads: ['','Host NVR','CH','Titulo','Local','Status','ImgBB','IP Camera','Modelo Cam.','Switch IP','Porta','VLAN'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace" title="${esc(r.host||'')}">${esc(r.host||'')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??''))}</span>`,
      `<strong title="${esc(r.title||'')}">${esc(r.title||'')}</strong>`,
      `<span title="${esc(r.local||'')}">${esc(r.local||'')}</span>`,
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted" title="${esc(r.camera_ip||'')}">${esc(r.camera_ip||'')}</span>`,
      `<span class="text-muted" title="${esc(r.camera_model||r.modelo||'')}">${esc(r.camera_model||r.modelo||'')}</span>`,
      `<span class="monospace text-muted" title="${esc(r.switch_ip||'')}">${esc(r.switch_ip||'')}</span>`,
      `<span class="text-muted" title="${esc(r.switch_port||'')}">${esc(r.switch_port||'')}</span>`,
      `<span class="text-muted" title="${esc(r.switch_vlan||'')}">${esc(r.switch_vlan||'')}</span>`,
    ],
  },
};

const DVR_COLS = {
  basico: {
    cols: ['4%','12%','4%','18%','8%','8%','6%','13%','9%','9%','5%','4%'],
    heads: ['','Host DVR','CH','Titulo','Local','Status','ImgBB','MAC DVR','Modelo','Serial','V.Loss','Foto'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace" title="${esc(r.host||'')}">${esc(r.host||'')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??''))}</span>`,
      `<strong title="${esc(r.title||'')}">${esc(r.title||'')}</strong>`,
      `<span title="${esc(r.local||'')}">${esc(r.local||'')}</span>`,
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted" title="${esc(r.mac||'')}" style="font-size:11px">${esc(r.mac||'')}</span>`,
      `<span class="text-muted" title="${esc(r.modelo||'')}">${esc(r.modelo||'')}</span>`,
      `<span class="text-muted" title="${esc(r.equip_serial||'')}">${esc(r.equip_serial||'')}</span>`,
      r.video_loss ? `<span style="color:var(--danger);font-weight:600;font-size:11px">SIM</span>` : `<span class="text-muted" style="font-size:11px">nao</span>`,
      r.snapshot_url ? `<a href="${esc(r.snapshot_url)}" target="_blank" style="color:var(--primary);font-size:12px"> ver</a>` : `<span class="text-muted"></span>`,
    ],
  },
  olt: {
    cols: ['4%','12%','4%','17%','7%','7%','5%','4%','5%','10%','12%','13%'],
    heads: ['','Host DVR','CH','Titulo','Local','Status','ImgBB','PON','ONU ID','ONU Name','ONU Serial','MAC DVR'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace" title="${esc(r.host||'')}">${esc(r.host||'')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??''))}</span>`,
      `<strong title="${esc(r.title||'')}">${esc(r.title||'')}</strong>`,
      `<span title="${esc(r.local||'')}">${esc(r.local||'')}</span>`,
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span style="text-align:center;display:block">${esc(String(r.pon||''))}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.onu_id||''))}</span>`,
      `<span class="text-muted" title="${esc(r.onu_name||'')}" style="font-size:11px">${esc(r.onu_name||'')}</span>`,
      `<span class="monospace text-muted" title="${esc(r.onu_serial||'')}" style="font-size:11px">${esc(r.onu_serial||'')}</span>`,
      `<span class="monospace text-muted" title="${esc(r.mac||'')}" style="font-size:11px">${esc(r.mac||'')}</span>`,
    ],
  },
  switch: {
    cols: ['4%','13%','4%','19%','9%','8%','6%','12%','6%','4%','15%'],
    heads: ['','Host DVR','CH','Titulo','Local','Status','ImgBB','Switch IP','Porta','VLAN','MAC DVR'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace" title="${esc(r.host||'')}">${esc(r.host||'')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??''))}</span>`,
      `<strong title="${esc(r.title||'')}">${esc(r.title||'')}</strong>`,
      `<span title="${esc(r.local||'')}">${esc(r.local||'')}</span>`,
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted" title="${esc(r.switch_ip||'')}">${esc(r.switch_ip||'')}</span>`,
      `<span class="text-muted" title="${esc(r.switch_port||'')}">${esc(r.switch_port||'')}</span>`,
      `<span class="text-muted" title="${esc(r.switch_vlan||'')}">${esc(r.switch_vlan||'')}</span>`,
      `<span class="monospace text-muted" title="${esc(r.mac||'')}" style="font-size:11px">${esc(r.mac||'')}</span>`,
    ],
  },
};

async function enrichRecRowsForMode(rows, mode) {
  if (!['olt', 'switch'].includes(mode) || !rows.length) return rows;
  const camMode = mode === 'switch' ? 'switch' : 'olt';
  const [camData, oltData] = await Promise.all([
    apiJson(`/api/cameras?mode=${encodeURIComponent(camMode)}`),
    mode === 'olt' ? apiJson('/api/olt/rows') : Promise.resolve(null),
  ]);
  const camByIp = {};
  (camData?.cameras || []).forEach(c => { if (c.ip) camByIp[c.ip] = c; });
  const oltByMac = {};
  if (oltData) (oltData?.rows || []).forEach(r => { if (r.cpe_mac) oltByMac[r.cpe_mac.toLowerCase()] = r; });

  return rows.map(r => {
    const cam = camByIp[r.camera_ip] || {};
    const mac = (r.camera_mac || r.mac || '').toLowerCase();
    const olt = oltByMac[mac] || {};
    return mode === 'olt'
      ? { ...r, pon: cam.pon || olt.pon || '', onu_id: cam.onu_id || olt.onu_id || '', onu_name: cam.onu_name || olt.onu_name || '', onu_serial: cam.onu_serial || olt.onu_serial || '' }
      : { ...r, switch_ip: cam.switch_ip || '', switch_port: cam.switch_port || '', switch_vlan: cam.switch_vlan || '' };
  });
}

function setNvrView(view) {
  _invNvrView = view;
  try { sessionStorage.setItem('so_rec_view', view); } catch {}
  document.querySelectorAll('[data-nvr-view]').forEach(t =>
    t.classList.toggle('active', t.dataset.nvrView === view)
  );
  applyNvrFilters();
}

function updateNvrTabs() {
  const store = _currentRecStore();
  document.querySelectorAll('[data-nvr-view]').forEach(t => {
    t.style.display = store[t.dataset.nvrView]?.length > 0 ? '' : 'none';
  });
  if (!store[_invNvrView]?.length) {
    const first = ['olt','switch','basico'].find(m => store[m]?.length > 0);
    if (first) setNvrView(first);
  }
}

function setRecType(type) {
  _recType = type;
  try { sessionStorage.setItem('so_rec_type', type); } catch {}
  document.querySelectorAll('[data-rec-type]').forEach(t =>
    t.classList.toggle('active', t.dataset.recType === type)
  );
  updateNvrTabs();
  populateNvrFilters();
  applyNvrFilters();
}

async function loadInvNvr() {
  _recSessionLoad();
  const desired = _invNvrView || 'olt';
  const store = _currentRecStore();
  if (!store[desired]?.length) {
    await _loadRecForMode(_recType, desired);
  }
  if (!store[desired]?.length && !store.basico?.length) {
    await _loadRecForMode(_recType, 'basico');
  }
  updateNvrTabs();
  populateNvrFilters();
  applyNvrFilters();
}

function _currentRecStore() { return _recType === 'dvr' ? _invDvr : _invNvr; }
function _currentNvrRows() { return _currentRecStore()[_invNvrView] || []; }
function _currentColDef()  { return (_recType === 'dvr' ? DVR_COLS : NVR_COLS)[_invNvrView] || NVR_COLS.basico; }

function populateNvrFilters() {
  const all    = Object.values(_currentRecStore()).flat();
  const locais = [...new Set(all.map(r => r.local).filter(Boolean))].sort();
  const hosts  = [...new Set(all.map(r => r.host).filter(Boolean))].sort();

  const selLocal = document.getElementById('filterNvrLocal');
  const selHost  = document.getElementById('filterNvrHost');
  if (selLocal) {
    const cur = selLocal.value;
    selLocal.innerHTML = '<option value="">Todos os locais</option>' +
      locais.map(l => `<option${l===cur?' selected':''}>${esc(l)}</option>`).join('');
  }
  if (selHost) {
    const cur = selHost.value;
    const label = _recType === 'dvr' ? 'Todos os DVRs' : 'Todos os NVRs';
    selHost.innerHTML = `<option value="">${label}</option>` +
      hosts.map(h => `<option${h===cur?' selected':''}>${esc(h)}</option>`).join('');
  }

  const rows   = _currentNvrRows();
  const online = rows.filter(r => r.status==='online').length;
  const vloss  = rows.filter(r => r.video_loss).length;
  setText('nvrTotal',   rows.length);
  setText('nvrOnline',  online);
  setText('nvrOffline', rows.length - online);
  setText('nvrVloss',   vloss);
}

function applyNvrFilters() {
  const q      = (document.getElementById('searchInvNvr')?.value || '').toLowerCase();
  const status = document.getElementById('filterNvrStatus')?.value || '';
  const local  = document.getElementById('filterNvrLocal')?.value  || '';
  const host   = document.getElementById('filterNvrHost')?.value   || '';

  const filtered = _currentNvrRows().filter(r => {
    if (status === 'video_loss' && !r.video_loss) return false;
    else if (status === 'missing_data' && !recHasMissingData(r)) return false;
    else if (status === 'default_title' && !recHasDefaultTitle(r)) return false;
    else if (status === 'imgbb_down' && recImgbbUrl(r)) return false;
    else if (status === 'no_camera' && !recHasNoCamera(r)) return false;
    else if (status === 'no_olt' && ![r.pon, r.onu_id, r.onu_name, r.onu_serial].some(_isBlankValue)) return false;
    else if (status && !['video_loss','missing_data','default_title','imgbb_down','no_camera','no_olt'].includes(status) && (r.status||'').toLowerCase() !== status) return false;
    if (local  && r.local !== local) return false;
    if (host   && r.host  !== host)  return false;
    if (q) return [r.host, r.nvr_model, r.modelo, r.model, r.title, r.local, r.camera_ip, r.camera_model, r.camera_mac, r.mac, r.equip_serial, r.onu_name, r.onu_serial, String(r.channel)]
      .some(f => (f||'').toLowerCase().includes(q));
    return true;
  });

  renderNvrTable(filtered);
}

function renderNvrTable(rows) {
  const def   = _currentColDef();
  const tbody = document.getElementById('invNvrTable');
  const table = tbody?.closest('table');
  // Colunas em %: nunca forcar min-width em px (isso e o que garante zero scroll horizontal).
  if (table) table.style.minWidth = '';
  setText('invNvrFooter', `${rows.length} canal${rows.length!==1?'s':''}`);

  // Atualiza colgroup e thead
  if (table) {
    const cg = table.querySelector('colgroup');
    if (cg) cg.innerHTML = def.cols.map(w => `<col style="width:${w}">`).join('');
    const th = table.querySelector('thead tr');
    if (th) th.innerHTML = def.heads.map((h, i) =>
      i === 0 ? `<th><input type="checkbox" id="chkNvrAll"></th>` : `<th>${h}</th>`
    ).join('');
  }

  if (!rows.length) {
    tbody.innerHTML = `<tr class="empty-row"><td colspan="${def.cols.length}">Nenhum resultado.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(r => {
    const isOnline = (r.status||'').toLowerCase() === 'online';
    const cells = def.row(r);
    return `<tr class="inv-nvr-row${isOnline?'':' nvr-row-offline'}" data-key="${esc(r.host+'_'+r.channel)}" style="cursor:pointer">
      ${cells.map((cell, i) =>
        i === 0
          ? `<td onclick="event.stopPropagation()">${cell}</td>`
          : `<td>${cell}</td>`
      ).join('')}
    </tr>`;
  }).join('');

  document.getElementById('chkNvrAll').onchange = function() {
    document.querySelectorAll('.chk-nvr').forEach(c => c.checked = this.checked);
  };

  tbody.querySelectorAll('.inv-nvr-row').forEach(tr => {
    tr.addEventListener('click', () => {
      const [host, channel] = (tr.dataset.key || '_').split('_');
      const row = rows.find(r => String(r.host || '') === host && String(r.channel || '') === String(channel));
      if (row) openRecPanel(row);
    });
  });

  lucide.createIcons();
}

//  Inventario Windows 
function recEndpointBase() {
  return _recActive?._type === 'dvr' ? '/api/dvr' : '/api/nvr';
}

function recTypeName(type = _recActive?._type) {
  return type === 'dvr' ? 'Analogico (DVR)' : 'NVR  IP';
}

function recSnapshotUrl(r) {
  const raw = r?.snapshot_url || '';
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('/')) return `${API_BASE}${raw}`;
  const file = r?.snapshot_file || '';
  if (file) return `${API_BASE}/data/${file}`;
  return '';
}

function openRecPanel(row) {
  _recActive = { ...row, _type: _recType };
  const r = _recActive;
  const isOnline = (r.status || '').toLowerCase() === 'online';
  const status = document.getElementById('recPanelStatus');
  status.textContent = r.status || '';
  status.style.color = isOnline ? 'var(--primary)' : 'var(--danger)';
  setText('recPanelTitulo', r.title || `${r.host} CH${r.channel}`);
  setText('rpTipo', recTypeName(r._type));
  setText('rpHost', r.host || '');
  setText('rpChannel', r.channel || '');
  setText('rpLocal', r.local || '');
  setText('rpModelo', r._type === 'dvr' ? (r.modelo || r.model || '') : (r.camera_model || r.modelo || r.nvr_model || ''));
  setText('rpCameraIp', r._type === 'dvr' ? 'analogico' : (r.camera_ip || ''));
  setText('rpMac', r._type === 'dvr' ? (r.mac || '') : (r.camera_mac || r.mac || ''));
  setText('rpPonOnu', [r.pon, r.onu_id].filter(Boolean).join(' / ') || '');
  setText('rpSerial', r.equip_serial || r.onu_serial || '');
  setText('rpSnapshotTitle', r.title || `${r.host} CH${r.channel}`);
  setText('rpSnapshotTime', '');

  const img = document.getElementById('rpSnapshot');
  const empty = document.getElementById('rpSnapshotEmpty');
  const url = recSnapshotUrl(r);
  if (url) {
    img.src = `${url}${url.includes('?') ? '&' : '?'}t=${Date.now()}`;
    img.style.display = 'block';
    empty.style.display = 'none';
  } else {
    img.src = '';
    img.style.display = 'none';
    empty.style.display = 'flex';
  }

  document.querySelectorAll('.inv-nvr-row').forEach(tr => tr.classList.toggle('row-selected', tr.dataset.key === `${r.host}_${r.channel}`));
  document.getElementById('recPanelBackdrop')?.classList.remove('hidden');
  document.getElementById('recPanel')?.classList.remove('hidden');
  lucide.createIcons();
}

function closeRecPanel() {
  _recActive = null;
  document.getElementById('recPanelBackdrop')?.classList.add('hidden');
  document.getElementById('recPanel')?.classList.add('hidden');
  document.querySelectorAll('.inv-nvr-row').forEach(tr => tr.classList.remove('row-selected'));
}

function recActionGroups(...ids) {
  ['recActionTitleGroup','recActionIpGroup','recActionPassGroup','recActionNtpGroup'].forEach(id => {
    document.getElementById(id)?.classList.toggle('hidden', !ids.includes(id));
  });
}

function openRecAction(action) {
  if (!_recActive) return;
  _recAction = action;
  const r = _recActive;
  const labels = {
    snapshot: { title: 'Atualizar snapshot', icon: 'refresh-cw', label: 'Atualizar' },
    rename: { title: 'Renomear canal', icon: 'pencil', label: 'Renomear' },
    ip: { title: 'Trocar IP', icon: 'network', label: 'Aplicar IP' },
    password: { title: 'Trocar senha', icon: 'key', label: 'Trocar senha' },
    datetime: { title: 'Data/hora', icon: 'clock', label: 'Aplicar NTP' },
    reboot: { title: 'Reboot do gravador', icon: 'power', label: 'Reboot' },
  };
  const meta = labels[action] || labels.snapshot;
  setText('recActionEyebrow', `${recTypeName(r._type)}  ${r.host} CH${r.channel}`);
  setText('recActionTitle', meta.title);
  document.getElementById('recActionTarget').value = `${r.host}  canal ${r.channel}  ${r.title || ''}`;
  document.getElementById('recActionUser').value = 'admin';
  document.getElementById('recActionPass').value = '';
  document.getElementById('recActionErro').hidden = true;
  document.getElementById('recActionChannelTitle').value = r.title || '';
  document.getElementById('recActionNewIp').value = '';
  document.getElementById('recActionMask').value = '';
  document.getElementById('recActionGateway').value = '';
  document.getElementById('recActionNewPass').value = '';
  document.getElementById('recActionNewPassConfirm').value = '';
  document.getElementById('recActionNtp').value = 'pool.ntp.org';
  recActionGroups(
    ...(action === 'rename' ? ['recActionTitleGroup'] : []),
    ...(action === 'ip' ? ['recActionIpGroup'] : []),
    ...(action === 'password' ? ['recActionPassGroup'] : []),
    ...(action === 'datetime' ? ['recActionNtpGroup'] : []),
  );
  setText('recActionNewIpLabel', r._type === 'nvr' && r.camera_ip ? 'Novo IP da camera do canal' : 'Novo IP do gravador');
  const btn = document.getElementById('confirmRecAction');
  btn.innerHTML = `<i data-lucide="${meta.icon}"></i> ${meta.label}`;
  btn.disabled = false;
  document.getElementById('modalRecAction').classList.remove('hidden');
  setTimeout(() => {
    const first = action === 'rename' ? 'recActionChannelTitle' : action === 'ip' ? 'recActionNewIp' : 'recActionPass';
    document.getElementById(first)?.focus();
  }, 80);
  lucide.createIcons();
}

function closeRecAction() {
  document.getElementById('modalRecAction')?.classList.add('hidden');
  _recAction = null;
}

async function runRecAction() {
  if (!_recActive || !_recAction) return;
  const r = _recActive;
  const user = document.getElementById('recActionUser').value.trim() || 'admin';
  const password = document.getElementById('recActionPass').value;
  const erro = document.getElementById('recActionErro');
  const btn = document.getElementById('confirmRecAction');
  if (!password) { erro.textContent = 'Informe a senha do gravador.'; erro.hidden = false; return; }

  const base = recEndpointBase();
  const common = { ip: r.host, http_port: Number(r.http_port || 80), channel: Number(r.channel || 1), user, password };
  let path = '';
  let payload = {};

  if (_recAction === 'snapshot') {
    path = `${base}/snapshot/update`;
    payload = { ...common, imgbb: false };
  } else if (_recAction === 'rename') {
    const title = document.getElementById('recActionChannelTitle').value.trim();
    if (!title) { erro.textContent = 'Informe o titulo do canal.'; erro.hidden = false; return; }
    path = `${base}/channel/rename`;
    payload = { ...common, title };
  } else if (_recAction === 'ip') {
    const newIp = document.getElementById('recActionNewIp').value.trim();
    if (!newIp) { erro.textContent = 'Informe o novo IP.'; erro.hidden = false; return; }
    if (r._type === 'nvr' && r.camera_ip) {
      path = `${base}/channel/change_ip`;
      payload = { ...common, new_ip: newIp };
    } else {
      path = `${base}/change_ip`;
      payload = {
        ...common,
        new_ip: newIp,
        mask: document.getElementById('recActionMask').value.trim(),
        gateway: document.getElementById('recActionGateway').value.trim(),
      };
    }
  } else if (_recAction === 'password') {
    const newPass = document.getElementById('recActionNewPass').value;
    const conf = document.getElementById('recActionNewPassConfirm').value;
    if (!newPass) { erro.textContent = 'Informe a nova senha.'; erro.hidden = false; return; }
    if (newPass !== conf) { erro.textContent = 'As senhas nao coincidem.'; erro.hidden = false; return; }
    path = '/api/maintenance/batch/password';
    payload = { ips: [r.host], user, old_pass: password, new_pass: newPass };
  } else if (_recAction === 'datetime') {
    const ntp = document.getElementById('recActionNtp').value.trim() || 'pool.ntp.org';
    path = `${base}/ntp`;
    payload = { ...common, address: ntp };
  } else if (_recAction === 'reboot') {
    path = `${base}/reboot`;
    payload = common;
  }

  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Executando';
  lucide.createIcons();
  try {
    const res = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok || body?.ok === false) throw new Error(body?.detail || body?.error || 'Falha ao executar acao.');
    closeRecAction();
    showToast('Acao concluida.');
    if (_recAction === 'rename') {
      applyRecPayloadsLocally([{ host: r.host, channel: r.channel, title: payload.title }], r._type);
      _recActive = { ..._recActive, title: payload.title };
    } else if (_recAction === 'ip' && r._type === 'nvr' && r.camera_ip) {
      applyRecPayloadsLocally([{ host: r.host, channel: r.channel, camera_ip: payload.new_ip }], r._type);
      _recActive = { ..._recActive, camera_ip: payload.new_ip };
    }
    updateNvrTabs();
    populateNvrFilters();
    applyNvrFilters();
    if (_recActive) openRecPanel(_recActive);
  } catch (err) {
    erro.textContent = err.message || 'Falha ao executar acao.';
    erro.hidden = false;
    showToast(erro.textContent, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    lucide.createIcons();
  }
}

function recPanelAction(action) {
  if (!_recActive) return;
  if (action === 'web') { window.open(`http://${_recActive.host}`, '_blank'); return; }
  if (action === 'ping') { openPingTerminal(_recActive.host); return; }
  openRecAction(action);
}

function selectedRecItems() {
  return [...document.querySelectorAll('.chk-nvr:checked')].map(c => ({
    host: c.dataset.host || '',
    channel: Number(c.dataset.channel || 0),
  })).filter(x => x.host && x.channel > 0);
}

function selectedRecRows() {
  const keys = new Set(selectedRecItems().map(x => `${x.host}|${x.channel}`));
  return _currentNvrRows().filter(r => keys.has(`${r.host}|${Number(r.channel || 0)}`));
}

function applyRecPayloadsLocally(payloads, type = _recType) {
  const store = type === 'dvr' ? _invDvr : _invNvr;
  ['basico', 'olt', 'switch'].forEach(mode => {
    if (!store[mode]?.length) return;
    store[mode] = store[mode].map(row => {
      const patch = payloads.find(p =>
        String(p.host || '') === String(row.host || '') &&
        Number(p.channel || 0) === Number(row.channel || 0)
      );
      return patch ? { ...row, ...patch } : row;
    });
    _recSessionSave(type, mode, store[mode]);
  });
}

function openEditRecModal(rows) {
  const count = rows.length;
  const typeLabel = _recType === 'dvr' ? 'DVR' : 'NVR';
  document.getElementById('modalEditRecTitle').textContent =
    count === 1 ? `Editar ${typeLabel}  ${rows[0].host} ch${rows[0].channel}` : `Editar ${count} canais ${typeLabel}`;
  document.getElementById('editRecErro').hidden = true;

  const s = 'width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:inherit;background:var(--surface);color:var(--text);outline:none;box-sizing:border-box';
  document.getElementById('editRecTableBody').innerHTML = rows.map(r => {
    const model = _recType === 'dvr' ? (r.modelo || r.model || '') : (r.camera_model || r.modelo || '');
    const camIp = _recType === 'dvr' ? '' : (r.camera_ip || '');
    const mac = _recType === 'dvr' ? (r.mac || '') : (r.camera_mac || r.mac || '');
    return `
      <tr>
        <td class="monospace" style="font-size:11px;color:var(--muted);white-space:nowrap">${esc(r.host || '')}</td>
        <td class="monospace" style="font-size:11px;color:var(--muted);text-align:center">${esc(String(r.channel || ''))}</td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="title" style="${s}" value="${esc(r.title || '')}" placeholder="Titulo"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="local" style="${s}" value="${esc(r.local || '')}" placeholder="Local"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="${_recType === 'dvr' ? 'modelo' : 'camera_model'}" style="${s}" value="${esc(model)}" placeholder="Modelo"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="camera_ip" style="${s};font-family:monospace" value="${esc(camIp)}" placeholder="IP camera"${_recType === 'dvr' ? ' disabled' : ''}></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="${_recType === 'dvr' ? 'mac' : 'camera_mac'}" style="${s};font-family:monospace" value="${esc(mac)}" placeholder="MAC"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="pon" style="${s};text-align:center" value="${esc(r.pon || '')}" placeholder="-"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="onu_id" style="${s};text-align:center" value="${esc(r.onu_id || '')}" placeholder="-"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="onu_name" style="${s}" value="${esc(r.onu_name || '')}" placeholder="gpon x onu y"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="onu_serial" style="${s};font-family:monospace" value="${esc(r.onu_serial || '')}" placeholder="ONU Serial"></td>
      </tr>`;
  }).join('');

  document.getElementById('modalEditRec').classList.remove('hidden');
  lucide.createIcons();
}

function closeEditRecModal() {
  document.getElementById('modalEditRec').classList.add('hidden');
}

async function saveEditRec() {
  const rows = document.querySelectorAll('#editRecTableBody tr');
  const byKey = {};
  rows.forEach(tr => {
    tr.querySelectorAll('input[data-host]').forEach(inp => {
      const host = inp.dataset.host || '';
      const channel = Number(inp.dataset.channel || 0);
      if (!host || !channel) return;
      const key = `${host}|${channel}`;
      byKey[key] ||= { host, channel };
      if (!inp.disabled) byKey[key][inp.dataset.field] = inp.value.trim();
    });
  });
  const payloads = Object.values(byKey);
  if (!payloads.length) return;

  const btn = document.getElementById('saveEditRec');
  btn.disabled = true;
  btn.textContent = 'Salvando...';
  const endpoint = _recType === 'dvr' ? '/api/dvr/save' : '/api/nvr/save';
  const res = await api(endpoint, { method: 'POST', body: JSON.stringify({ recorders: payloads }) });
  const body = await res?.json().catch(() => ({}));
  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="check"></i> Salvar tudo';
  lucide.createIcons();

  if (!res?.ok || body?.ok === false) {
    const el = document.getElementById('editRecErro');
    el.textContent = body?.detail || body?.error || 'Canais nao foram salvos. Verifique e tente novamente.';
    el.hidden = false;
    return;
  }

  showToast(`${payloads.length} canal(is) salvo(s)!`);
  closeEditRecModal();
  applyRecPayloadsLocally(payloads);
  updateNvrTabs();
  populateNvrFilters();
  applyNvrFilters();
}

let _winRows = [];
let _winFilteredRows = [];
let _winSelected = new Set();
let _winEditingKey = '';
let _winActive = null;

function winText(v) { return String(v ?? '').trim(); }
function winKey(row) { return winText(row.ip) || winText(row.hostname) || winText(row.serial); }
function winIsOnline(row) {
  const s = winText(row.status).toLowerCase();
  return s === 'online' || s === 'agent_reported';
}
function winOsLabel(row) {
  const os = row.os && typeof row.os === 'object' ? row.os : {};
  return [os.name || row.os_name, os.build].filter(Boolean).join(' / ') || '-';
}
function winUserLabel(row) { return winText(row.logged_user || row.user || row.username) || '-'; }
function winModelLabel(row) {
  return [row.manufacturer, row.model].map(winText).filter(Boolean).join(' ') || '-';
}
function winCpuLabel(row) {
  const cpu = row.cpu && typeof row.cpu === 'object' ? row.cpu : {};
  const name = winText(cpu.name || row.cpu_name || row.cpu);
  if (!name) return '-';
  return name.replace(/\s+/g, ' ').replace(/Intel\(R\)|Core\(TM\)|CPU|@.*$/gi, '').trim() || name;
}
function winRamLabel(row) {
  if (row.memory_summary) return winText(row.memory_summary);
  const ram = Number(row.ram_gb || row.total_ram_gb || 0);
  return ram ? `${Math.round(ram)} GB` : '-';
}
function winPrimaryDisk(row) {
  const disks = Array.isArray(row.disks) ? row.disks.filter(d => d && typeof d === 'object') : [];
  return disks[0] || {};
}
function winDiskModel(row) {
  const disk = winPrimaryDisk(row);
  return winText(disk.model || disk.caption || disk.name) || '-';
}
function winDiskSerial(row) {
  const disk = winPrimaryDisk(row);
  return winText(disk.serial || disk.serial_number) || '-';
}
function winDiskType(row) {
  const disk = winPrimaryDisk(row);
  const diskType = winText(disk.media_type || disk.interface_type).toUpperCase();
  if (diskType && diskType !== 'UNSPECIFIED') return diskType;
  const kind = winText(row.disk_kind).toUpperCase();
  if (kind) return kind;
  const label = winText(row.disk_summary).toUpperCase();
  if (label.includes('NVME')) return 'NVME';
  if (label.includes('SSD')) return 'SSD';
  if (label.includes('HDD') || label.includes('FIXED')) return 'HDD';
  return '-';
}
function winDiskGb(row) {
  const disk = winPrimaryDisk(row);
  const diskSize = Number(disk.size_gb || disk.capacity_gb || 0);
  if (diskSize) return String(Math.round(diskSize));
  const total = Number(row.disk_total_gb || 0);
  if (total) return String(Math.round(total));
  const label = winText(row.disk_summary);
  const match = label.match(/(\d+(?:\.\d+)?)\s*(TB|GB)/i);
  if (!match) return '-';
  const value = Number(match[1]);
  return match[2].toUpperCase() === 'TB' ? String(Math.round(value * 1024)) : String(Math.round(value));
}
function winDiskLabel(row) {
  const type = winDiskType(row);
  const gb = winDiskGb(row);
  if (type === '-' && gb === '-') return winText(row.disk_summary) || '-';
  return [type, gb !== '-' ? `${gb} GB` : ''].filter(Boolean).join(' ');
}
function winPhysical(row) {
  return row.physical && typeof row.physical === 'object' ? row.physical : {};
}
function winPhysicalLabel(row) {
  const p = winPhysical(row);
  const parts = [p.switch_name, p.switch_port, p.patch_panel, p.patch_port, p.outlet, p.rack, p.asset_tag].map(winText).filter(Boolean);
  return parts.length ? parts.join(' / ') : '-';
}
function winMissingData(row) {
  return !winText(row.mac) || !winText(row.hostname) || !winText(row.model) || !winText(row.site) || !winText(row.sector || row.setor) || winPhysicalLabel(row) === '-';
}
function winMatchesFilter(row) {
  const status = document.getElementById('filterWinStatus')?.value || '';
  const site = document.getElementById('filterWinSite')?.value || '';
  const sector = document.getElementById('filterWinSector')?.value || '';
  const q = (document.getElementById('searchInvWindows')?.value || '').toLowerCase().trim();
  if (site && winText(row.site) !== site) return false;
  if (sector && winText(row.sector || row.setor) !== sector) return false;
  if (status === 'online' && !winIsOnline(row)) return false;
  if (status === 'offline' && winIsOnline(row)) return false;
  if (status === 'with_ssd' && !row.has_ssd) return false;
  if (status === 'without_ssd' && row.has_ssd) return false;
  if (status === 'with_anydesk' && !winText(row.anydesk_id)) return false;
  if (status === 'without_anydesk' && winText(row.anydesk_id)) return false;
  if (status === 'windows11' && !winOsLabel(row).toLowerCase().includes('windows 11')) return false;
  if (status === 'windows10' && !winOsLabel(row).toLowerCase().includes('windows 10')) return false;
  if (status === 'missing_data' && !winMissingData(row)) return false;
  if (!q) return true;
  return [row.ip, row.mac, row.hostname, winUserLabel(row), winOsLabel(row), winModelLabel(row), winCpuLabel(row), winDiskLabel(row), row.anydesk_id, row.site, row.sector, row.error, winDiskModel(row), winDiskSerial(row), winPhysicalLabel(row)]
    .some(v => winText(v).toLowerCase().includes(q));
}
function populateWinFilters() {
  const fill = (id, values, label) => {
    const el = document.getElementById(id);
    if (!el) return;
    const cur = el.value;
    const unique = [...new Set(values.map(winText).filter(Boolean))].sort((a,b) => a.localeCompare(b));
    el.innerHTML = `<option value="">${label}</option>` + unique.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    if (unique.includes(cur)) el.value = cur;
  };
  fill('filterWinSite', _winRows.map(r => r.site), 'Todos os sites');
  fill('filterWinSector', _winRows.map(r => r.sector || r.setor), 'Todos os setores');
}
function updateWinSummary() {
  const total = _winRows.length;
  const online = _winRows.filter(winIsOnline).length;
  const ssd = _winRows.filter(r => !!r.has_ssd).length;
  setText('winTotal', total);
  setText('winOnline', online);
  setText('winOffline', Math.max(0, total - online));
  setText('winSsd', ssd);
  setText('winNoSsd', Math.max(0, total - ssd));
}
function updateWinSelectionUi() {
  setText('winSelectedCount', `${_winSelected.size} selecionado${_winSelected.size === 1 ? '' : 's'}`);
  const visibleKeys = _winFilteredRows.map(winKey).filter(Boolean);
  const selectedVisible = visibleKeys.filter(k => _winSelected.has(k)).length;
  const all = document.getElementById('chkWinAll');
  if (all) {
    all.checked = visibleKeys.length > 0 && selectedVisible === visibleKeys.length;
    all.indeterminate = selectedVisible > 0 && selectedVisible < visibleKeys.length;
  }
}
function renderWinRows(rows) {
  const tbody = document.getElementById('invWindowsTable');
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="27">Nenhum computador encontrado.</td></tr>';
    setText('invWindowsFooter', '0 hosts');
    updateWinSelectionUi();
    return;
  }
  tbody.innerHTML = rows.map(row => {
    const key = winKey(row);
    const online = winIsOnline(row);
    const anydesk = winText(row.anydesk_id);
    const phys = winPhysicalLabel(row);
    const physical = winPhysical(row);
    const diskModel = winDiskModel(row);
    const diskType = winDiskType(row);
    const diskGb = winDiskGb(row);
    const diskSerial = winDiskSerial(row);
    const manufacturer = winText(row.manufacturer) || '-';
    const model = winText(row.model) || '-';
    const statusText = online ? 'online' : (winText(row.status) || 'offline');
    return `
      <tr class="win-row" data-key="${esc(key)}">
        <td><input type="checkbox" class="chk-win" value="${esc(key)}" ${_winSelected.has(key) ? 'checked' : ''}></td>
        <td class="monospace" title="${esc(row.ip || '-')}">${esc(row.ip || '-')}</td>
        <td class="monospace text-muted" title="${esc(row.mac || '-')}">${esc(row.mac || '-')}</td>
        <td title="${esc(row.hostname || '-')}"><strong>${esc(row.hostname || '-')}</strong></td>
        <td class="text-muted" title="${esc(winUserLabel(row))}">${esc(winUserLabel(row))}</td>
        <td class="text-muted" title="${esc(winOsLabel(row))}">${esc(winOsLabel(row))}</td>
        <td class="text-muted" title="${esc(manufacturer)}">${esc(manufacturer)}</td>
        <td class="text-muted" title="${esc(model)}">${esc(model)}</td>
        <td title="${esc(row.site || '-')}">${esc(row.site || '-')}</td>
        <td class="text-muted" title="${esc(row.sector || row.setor || '-')}">${esc(row.sector || row.setor || '-')}</td>
        <td title="${esc(row.error || statusText)}"><span style="color:${online ? 'var(--primary)' : 'var(--danger)'};font-weight:700">${esc(statusText)}</span></td>
        <td class="text-muted" title="${esc(winCpuLabel(row))}">${esc(winCpuLabel(row))}</td>
        <td class="text-muted" title="${esc(winRamLabel(row))}">${esc(winRamLabel(row))}</td>
        <td class="text-muted" title="${esc(diskModel)}">${esc(diskModel)}</td>
        <td class="text-muted" title="${esc(winDiskLabel(row))}">${esc(diskType)}</td>
        <td class="text-muted" title="${esc(winDiskLabel(row))}">${esc(diskGb)}</td>
        <td class="text-muted monospace" title="${esc(diskSerial)}">${esc(diskSerial)}</td>
        <td>${anydesk ? `<a href="anydesk:${encodeURIComponent(anydesk)}" class="monospace" style="color:var(--primary);font-weight:700">${esc(anydesk)}</a>` : '<span class="text-muted">-</span>'}</td>
        <td class="text-muted" title="${esc(physical.switch_name || '-')}">${esc(physical.switch_name || '-')}</td>
        <td class="text-muted" title="${esc(physical.switch_port || '-')}">${esc(physical.switch_port || '-')}</td>
        <td class="text-muted" title="${esc(physical.patch_panel || '-')}">${esc(physical.patch_panel || '-')}</td>
        <td class="text-muted" title="${esc(physical.patch_port || '-')}">${esc(physical.patch_port || '-')}</td>
        <td class="text-muted" title="${esc(physical.outlet || '-')}">${esc(physical.outlet || '-')}</td>
        <td class="text-muted" title="${esc(physical.rack || '-')}">${esc(physical.rack || '-')}</td>
        <td class="text-muted" title="${esc(physical.cable_id || '-')}">${esc(physical.cable_id || '-')}</td>
        <td class="text-muted" title="${esc(physical.asset_tag || '-')}">${esc(physical.asset_tag || '-')}</td>
        <td class="text-muted" title="${esc(physical.notes || '-')}">${esc(physical.notes || '-')}</td>
      </tr>`;
  }).join('');
  setText('invWindowsFooter', `${rows.length} host${rows.length === 1 ? '' : 's'}`);
  tbody.querySelectorAll('.chk-win').forEach(chk => {
    chk.addEventListener('click', e => e.stopPropagation());
    chk.addEventListener('change', () => {
      if (chk.checked) _winSelected.add(chk.value); else _winSelected.delete(chk.value);
      updateWinSelectionUi();
    });
  });
  tbody.querySelectorAll('.win-row').forEach(tr => tr.addEventListener('click', () => {
    const row = _winRows.find(r => winKey(r) === tr.dataset.key);
    if (row) openWinPanel(row);
  }));
  updateWinSelectionUi();
}
function applyWindowsFilters() {
  _winFilteredRows = _winRows.filter(winMatchesFilter);
  renderWinRows(_winFilteredRows);
}
async function loadInvWindows() {
  const data = await apiJson('/api/windows/inventory');
  _winRows = data?.inventory || data?.hosts || (Array.isArray(data) ? data : []);
  _winRows.sort((a,b) => ipToInt(a.ip) - ipToInt(b.ip));
  _winSelected = new Set([..._winSelected].filter(key => _winRows.some(r => winKey(r) === key)));
  updateWinSummary();
  populateWinFilters();
  applyWindowsFilters();
}
function clearWinFilters() {
  ['searchInvWindows','filterWinStatus','filterWinSite','filterWinSector'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  _winSelected.clear();
  applyWindowsFilters();
}
function openWinScanModal() {
  document.getElementById('winScanErro').hidden = true;
  document.getElementById('winScanLog').textContent = 'Aguardando inicio...';
  document.getElementById('modalWinScan')?.classList.remove('hidden');
  setTimeout(() => document.getElementById('winScanTargets')?.focus(), 80);
  lucide.createIcons();
}
function closeWinScanModal() { document.getElementById('modalWinScan')?.classList.add('hidden'); }
async function runWinScan() {
  const erro = document.getElementById('winScanErro');
  const log = document.getElementById('winScanLog');
  const btn = document.getElementById('startWinScan');
  const payload = {
    targets: document.getElementById('winScanTargets').value.trim(),
    username: document.getElementById('winScanUser').value.trim(),
    password: document.getElementById('winScanPass').value,
    domain: document.getElementById('winScanDomain').value.trim(),
    timeout_sec: Number(document.getElementById('winScanTimeout').value || 8),
    concurrency: Number(document.getElementById('winScanConcurrency').value || 32),
    use_https: document.getElementById('winScanHttps').checked,
    save: true,
  };
  if (!payload.targets || !payload.username || !payload.password) {
    erro.textContent = 'Informe alvo, usuario e senha.';
    erro.hidden = false;
    return;
  }
  erro.hidden = true;
  log.textContent = `Conectando em ${payload.targets}...`;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Executando';
  lucide.createIcons();
  try {
    const res = await api('/api/windows/scan', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok || data?.ok === false) throw new Error(data?.detail || data?.error || 'Falha na varredura.');
    log.textContent = `Concluido. Alvos: ${data.scanned || 0}. Online: ${data.online || 0}. Falhas: ${data.failed || 0}.`;
    showToast(`Windows atualizado: ${data.online || 0} online, ${data.failed || 0} falha(s).`);
    await loadInvWindows();
  } catch (err) {
    erro.textContent = err.message || 'Falha na varredura.';
    erro.hidden = false;
    log.textContent += `\nErro: ${erro.textContent}`;
    showToast(erro.textContent, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="scan-search"></i> Executar';
    lucide.createIcons();
  }
}
function winSetPanelText(id, value) {
  setText(id, winText(value) || '-');
}
function winFormatDate(value) {
  const raw = winText(value);
  if (!raw) return '-';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('pt-BR');
}
function openWinPanel(row) {
  _winActive = row;
  const key = winKey(row);
  document.querySelectorAll('.win-row').forEach(tr => tr.classList.toggle('row-selected', tr.dataset.key === key));
  const online = winIsOnline(row);
  const status = document.getElementById('winPanelStatus');
  if (status) {
    status.textContent = online ? 'online' : (winText(row.status) || 'offline');
    status.style.color = online ? 'var(--primary)' : 'var(--danger)';
  }
  winSetPanelText('winPanelTitle', row.hostname || row.ip || 'Windows');
  winSetPanelText('wpIp', row.ip);
  winSetPanelText('wpMac', row.mac);
  winSetPanelText('wpUser', winUserLabel(row));
  winSetPanelText('wpOs', winOsLabel(row));
  winSetPanelText('wpManufacturer', row.manufacturer);
  winSetPanelText('wpModel', row.model);
  winSetPanelText('wpSerial', row.serial);
  winSetPanelText('wpSite', row.site);
  winSetPanelText('wpSector', row.sector || row.setor);
  winSetPanelText('wpCpu', winCpuLabel(row));
  winSetPanelText('wpMemory', winRamLabel(row));
  winSetPanelText('wpDisk', [winDiskModel(row), winDiskType(row), winDiskGb(row) !== '-' ? `${winDiskGb(row)} GB` : '', winDiskSerial(row)].filter(v => v && v !== '-').join(' / '));
  winSetPanelText('wpAnydesk', row.anydesk_id);
  winSetPanelText('wpUpdated', winFormatDate(row.updated_at || row.last_seen));
  const p = winPhysical(row);
  winSetPanelText('wpSwitch', p.switch_name);
  winSetPanelText('wpSwitchPort', p.switch_port);
  winSetPanelText('wpPatch', p.patch_panel);
  winSetPanelText('wpPatchPort', p.patch_port);
  winSetPanelText('wpOutlet', p.outlet);
  winSetPanelText('wpRack', p.rack);
  winSetPanelText('wpCable', p.cable_id);
  winSetPanelText('wpAsset', p.asset_tag);
  winSetPanelText('wpNotes', p.notes);
  document.getElementById('wpBtnAnydesk')?.toggleAttribute('disabled', !winText(row.anydesk_id));
  document.getElementById('winPanelBackdrop')?.classList.remove('hidden');
  document.getElementById('winPanel')?.classList.remove('hidden');
  lucide.createIcons();
}
function closeWinPanel() {
  _winActive = null;
  document.getElementById('winPanelBackdrop')?.classList.add('hidden');
  document.getElementById('winPanel')?.classList.add('hidden');
  document.querySelectorAll('.win-row').forEach(tr => tr.classList.remove('row-selected'));
}
function winPanelAction(action) {
  if (!_winActive && !['agent','prepare','pdf','refresh'].includes(action)) return;
  if (action === 'ping') return openPingTerminal(_winActive.ip);
  if (action === 'anydesk') {
    const id = winText(_winActive.anydesk_id);
    if (!id) return showToast('Este computador nao tem AnyDesk informado.', true);
    window.open(`anydesk:${encodeURIComponent(id)}`, '_blank');
    return;
  }
  if (action === 'edit') {
    const key = winKey(_winActive);
    _winSelected = new Set([key]);
    applyWindowsFilters();
    openWinPhysicalModal();
    return;
  }
  if (action === 'agent') return downloadWithAuth('/api/windows/agent-script', 'sightops-agente-windows.ps1');
  if (action === 'prepare') return downloadWithAuth('/api/windows/prepare-script', 'sightops-preparar-windows.ps1');
  if (action === 'pdf') return downloadWithAuth('/api/windows/report.pdf', 'windows-inventory.pdf');
  if (action === 'refresh') return loadInvWindows();
}
function selectedWinRows() {
  return _winRows.filter(r => _winSelected.has(winKey(r)));
}
function openWinPhysicalModal() {
  const rows = selectedWinRows();
  if (!rows.length) { showToast('Selecione um computador para editar.', true); return; }
  const row = rows[0];
  _winEditingKey = winKey(row);
  const p = winPhysical(row);
  setText('winPhysicalTitle', `Editar - ${row.hostname || row.ip || 'computador'}`);
  const map = {
    SwitchName: p.switch_name,
    SwitchPort: p.switch_port,
    PatchPanel: p.patch_panel,
    PatchPort: p.patch_port,
    Outlet: p.outlet,
    Rack: p.rack,
    CableId: p.cable_id,
    AssetTag: p.asset_tag,
    Notes: p.notes,
  };
  Object.entries(map).forEach(([k,v]) => { const el = document.getElementById(`winPhysical${k}`); if (el) el.value = winText(v); });
  document.getElementById('winPhysicalErro').hidden = true;
  document.getElementById('modalWinPhysical')?.classList.remove('hidden');
  lucide.createIcons();
}
function closeWinPhysicalModal() { document.getElementById('modalWinPhysical')?.classList.add('hidden'); }
async function saveWinPhysical() {
  if (!_winEditingKey) return;
  const erro = document.getElementById('winPhysicalErro');
  const btn = document.getElementById('saveWinPhysical');
  const physical = {
    switch_name: document.getElementById('winPhysicalSwitchName').value.trim(),
    switch_port: document.getElementById('winPhysicalSwitchPort').value.trim(),
    patch_panel: document.getElementById('winPhysicalPatchPanel').value.trim(),
    patch_port: document.getElementById('winPhysicalPatchPort').value.trim(),
    outlet: document.getElementById('winPhysicalOutlet').value.trim(),
    rack: document.getElementById('winPhysicalRack').value.trim(),
    cable_id: document.getElementById('winPhysicalCableId').value.trim(),
    asset_tag: document.getElementById('winPhysicalAssetTag').value.trim(),
    notes: document.getElementById('winPhysicalNotes').value.trim(),
  };
  btn.disabled = true;
  try {
    const res = await api('/api/windows/inventory/manual', { method: 'PATCH', body: JSON.stringify({ key: _winEditingKey, physical }) });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok || data?.ok === false) throw new Error(data?.detail || data?.error || 'Falha ao salvar.');
    showToast('Caminho fisico salvo.');
    closeWinPhysicalModal();
    await loadInvWindows();
  } catch (err) {
    erro.textContent = err.message || 'Falha ao salvar.';
    erro.hidden = false;
    showToast(erro.textContent, true);
  } finally {
    btn.disabled = false;
  }
}
async function deleteSelectedWindows() {
  const keys = [..._winSelected];
  if (!keys.length) { showToast('Selecione ao menos um computador.', true); return; }
  if (!await showConfirm({ title: 'Remover computadores', msg: `Remover ${keys.length} computador(es) do inventario Windows?`, label: 'Remover' })) return;
  const res = await api('/api/windows/inventory/delete', { method: 'POST', body: JSON.stringify({ keys }) });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) { showToast(data?.detail || data?.error || 'Falha ao remover.', true); return; }
  _winSelected.clear();
  showToast(`${data.removed || keys.length} computador(es) removido(s).`);
  await loadInvWindows();
}
async function clearWindowsInventory() {
  if (!await showConfirm({ title: 'Apagar inventario Windows', msg: 'Apagar todos os computadores Windows salvos?', label: 'Apagar tudo' })) return;
  const res = await api('/api/windows/clear', { method: 'POST', body: '{}' });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) { showToast(data?.detail || data?.error || 'Falha ao limpar.', true); return; }
  _winRows = [];
  _winSelected.clear();
  updateWinSummary();
  populateWinFilters();
  applyWindowsFilters();
  showToast('Inventario Windows limpo.');
}
async function enrichWindowsPhotos() {
  showToast('Buscando fotos de referencia...');
  const res = await api('/api/windows/enrich/photos', { method: 'POST', body: '{}' });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) { showToast(data?.detail || data?.error || 'Falha ao buscar fotos.', true); return; }
  showToast(`Fotos vinculadas: ${data.assets || 0}.`);
  await loadInvWindows();
}
// Snapshots 
let _snapCamAll = [];

async function loadSnapCam() {
  const data = await apiJson('/api/cameras');
  _snapCamAll = (data?.cameras || (Array.isArray(data) ? data : []))
    .sort((a, b) => {
      const toInt = ip => (ip||'0.0.0.0').split('.').reduce((a,b) => (a<<8)|(parseInt(b)||0), 0) >>> 0;
      return toInt(a.ip) - toInt(b.ip);
    });

  // Popula filtro de sites
  const sites = [...new Set(_snapCamAll.map(c => c.local).filter(Boolean))].sort();
  const selSite = document.getElementById('filterSnapCamSite');
  if (selSite) {
    const cur = selSite.value;
    selSite.innerHTML = '<option value="">Todos os sites</option>' +
      sites.map(s => `<option${s===cur?' selected':''}>${esc(s)}</option>`).join('');
  }

  applySnapCamFilters();
}

function applySnapCamFilters() {
  const q      = (document.getElementById('searchSnapCam')?.value || '').toLowerCase();
  const status = document.getElementById('filterSnapCamStatus')?.value || '';
  const site   = document.getElementById('filterSnapCamSite')?.value   || '';

  const filtered = _snapCamAll.filter(c => {
    const temFoto = !!(c.snapshot_url);
    if (status === 'com' && !temFoto) return false;
    if (status === 'sem' && temFoto)  return false;
    if (site && c.local !== site)     return false;
    if (q) return [c.ip, c.titulo, c.local, c.model, c.fabricante]
      .some(f => (f||'').toLowerCase().includes(q));
    return true;
  });

  // Contadores
  setText('snapCamTotal',   _snapCamAll.length);
  setText('snapCamComFoto', _snapCamAll.filter(c => c.snapshot_url).length);
  setText('snapCamSemFoto', _snapCamAll.filter(c => !c.snapshot_url).length);

  renderSnapCamGrid(filtered);
}

function renderSnapCamGrid(cams) {
  const grid = document.getElementById('snapCamGrid');
  if (!cams.length) {
    grid.innerHTML = '<p style="padding:40px;color:var(--muted);grid-column:1/-1;text-align:center">Nenhuma camera encontrada.</p>';
    return;
  }

  grid.innerHTML = cams.map(c => {
    const temFoto  = !!(c.snapshot_url);
    const imgSrc   = temFoto ? `${API_BASE}${esc(c.snapshot_url)}` : '';
    const statusCl = (c.status||'').toLowerCase() === 'online' ? 'var(--primary)' : 'var(--danger)';

    return `<div class="snap-card" data-ip="${esc(c.ip)}" style="cursor:pointer">
      <div style="position:relative">
        <label style="position:absolute;top:8px;left:8px;z-index:2;cursor:pointer" onclick="event.stopPropagation()">
          <input type="checkbox" class="chk-snap-cam" value="${esc(c.ip)}" style="accent-color:var(--primary);width:15px;height:15px">
        </label>
        ${temFoto
          ? `<img src="${imgSrc}" alt="${esc(c.ip)}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#1a1a2e" onerror="this.style.opacity='.3'">`
          : `<div style="width:100%;aspect-ratio:16/9;background:#e9ecef;display:flex;align-items:center;justify-content:center;color:#aaa"><svg width='40' height='40' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><rect x='2' y='2' width='20' height='20' rx='2'/><circle cx='12' cy='10' r='3'/><path d='m2 20 4-4 4 4 4-8 4 8'/></svg></div>`
        }
        <div style="position:absolute;bottom:0;left:0;right:0;padding:6px 10px;background:linear-gradient(transparent,rgba(0,0,0,.7));color:white;font-size:11px;display:flex;justify-content:space-between">
          <span class="monospace">${esc(c.ip)}</span>
          <span style="color:${statusCl};font-weight:600">${esc(c.status||'')}</span>
        </div>
      </div>
      <div style="padding:10px 12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:2px">${esc(c.titulo||'')}</div>
        <div style="font-size:11px;color:var(--muted);display:flex;justify-content:space-between">
          <span>${esc(c.local||'')}</span>
          <span>${esc(c.model||'')}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  // Click na foto abre carrossel
  grid.querySelectorAll('.snap-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('input[type=checkbox]')) return;
      const idx = cams.findIndex(c => c.ip === card.dataset.ip);
      openCarrossel(cams, idx);
    });
  });
}

//  Carrossel de Gravadores (DVR+NVR) 
function openCarrosselGrav(rows, idx) {
  // Reutiliza o mesmo carrossel de cameras mas com dados de gravadores
  const adapted = rows.map(r => ({
    ip:           `${r.host} CH${r.channel}`,
    titulo:       r.title || `CH${r.channel}`,
    local:        r.local || '',
    model:        r.modelo || '',
    mac:          r.mac || '',
    fabricante:   r.fabricante || '',
    status:       r.status || '',
    snapshot_url: r.snapshot_url || '',
    pon: '', onu_id: '', onu_name: '', onu_serial: '',
  }));
  openCarrossel(adapted, idx);
}

//  Carrossel de Snapshots 
let _carCams  = [];
let _carIdx   = 0;

function openCarrossel(cams, idx = 0) {
  _carCams = cams;
  _carIdx  = idx;
  document.getElementById('modalCarrossel').style.display = 'flex';
  renderCarrossel();
  lucide.createIcons();
}

function closeCarrossel() {
  document.getElementById('modalCarrossel').style.display = 'none';
}

function renderCarrossel() {
  const c = _carCams[_carIdx];
  if (!c) return;

  // Header
  setText('carIdx',   `${_carIdx + 1} / ${_carCams.length}`);
  setText('carTitulo', c.titulo || c.ip);
  setText('carSub',   `${c.ip}    ${c.local || ''}    ${c.model || ''}`);

  // Imagem
  const img   = document.getElementById('carImg');
  const noImg = document.getElementById('carNoImg');
  if (c.snapshot_url) {
    img.src = `${API_BASE}${c.snapshot_url}`;
    img.style.display = 'block';
    noImg.style.display = 'none';
  } else {
    img.style.display = 'none';
    noImg.style.display = 'flex';
  }

  // Thumbnails
  const thumbs = document.getElementById('carThumbs');
  thumbs.innerHTML = _carCams.map((cam, i) => `
    <div onclick="carGoTo(${i})" style="
      flex-shrink:0;width:64px;height:42px;border-radius:4px;overflow:hidden;cursor:pointer;
      border:2px solid ${i === _carIdx ? 'var(--primary)' : 'transparent'};
      opacity:${i === _carIdx ? '1' : '0.5'};transition:all .15s">
      ${cam.snapshot_url
        ? `<img src="${API_BASE}${esc(cam.snapshot_url)}" style="width:100%;height:100%;object-fit:cover">`
        : `<div style="width:100%;height:100%;background:#2d3748;display:grid;place-items:center"><svg width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='#718096' stroke-width='2'><rect x='2' y='2' width='20' height='20' rx='2'/></svg></div>`}
    </div>`).join('');
}

function carGoTo(idx) {
  _carIdx = Math.max(0, Math.min(_carCams.length - 1, idx));
  renderCarrossel();
}

let _snapGravAll = [];

async function loadSnapDvr() {
  const [dvrData, nvrData] = await Promise.all([
    apiJson('/api/dvr/inventory'),
    apiJson('/api/nvr/inventory'),
  ]);

  const dvrs = (dvrData?.inventory || []).map(r => ({ ...r, _tipo: 'dvr' }));
  const nvrs = (nvrData?.inventory || []).map(r => ({ ...r, _tipo: 'nvr' }));
  _snapGravAll = [...dvrs, ...nvrs];

  // Filtro de sites
  const sites = [...new Set(_snapGravAll.map(r => r.local).filter(Boolean))].sort();
  const selSite = document.getElementById('filterSnapGravSite');
  if (selSite) {
    const cur = selSite.value;
    selSite.innerHTML = '<option value="">Todos os sites</option>' +
      sites.map(s => `<option${s===cur?' selected':''}>${esc(s)}</option>`).join('');
  }

  applySnapGravFilters();
}

function applySnapGravFilters() {
  const q      = (document.getElementById('searchSnapGrav')?.value || '').toLowerCase();
  const tipo   = document.getElementById('filterSnapGravTipo')?.value   || '';
  const status = document.getElementById('filterSnapGravStatus')?.value || '';
  const site   = document.getElementById('filterSnapGravSite')?.value   || '';

  const filtered = _snapGravAll.filter(r => {
    const temFoto = !!(r.snapshot_url);
    if (tipo   && r._tipo !== tipo)   return false;
    if (status === 'com' && !temFoto) return false;
    if (status === 'sem' &&  temFoto) return false;
    if (site   && r.local !== site)   return false;
    if (q) return [r.host, r.title, r.local, r.modelo, String(r.channel)]
      .some(f => (f||'').toLowerCase().includes(q));
    return true;
  });

  setText('snapGravTotal',   _snapGravAll.length);
  setText('snapGravComFoto', _snapGravAll.filter(r => r.snapshot_url).length);
  setText('snapGravSemFoto', _snapGravAll.filter(r => !r.snapshot_url).length);

  renderSnapGravGrid(filtered);
}

function renderSnapGravGrid(rows) {
  const grid = document.getElementById('snapGravGrid');
  if (!rows.length) {
    grid.innerHTML = '<p style="padding:40px;color:var(--muted);grid-column:1/-1;text-align:center">Nenhum canal encontrado.</p>';
    return;
  }

  grid.innerHTML = rows.map((r, i) => {
    const temFoto  = !!(r.snapshot_url);
    const imgSrc   = temFoto ? `${API_BASE}${esc(r.snapshot_url)}` : '';
    const statusCl = (r.status||'').toLowerCase() === 'online' ? 'var(--primary)' : 'var(--danger)';
    const badge    = r._tipo === 'dvr'
      ? `<span style="background:#f0fdf9;color:var(--primary);font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #b2f2d4">DVR</span>`
      : `<span style="background:#e7f5ff;color:var(--blue);font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;border:1px solid #a5d8ff">NVR</span>`;

    return `<div class="snap-card" data-grav-idx="${i}" style="cursor:pointer">
      <div style="position:relative">
        <label style="position:absolute;top:8px;left:8px;z-index:2;cursor:pointer" onclick="event.stopPropagation()">
          <input type="checkbox" class="chk-snap-grav" value="${i}" style="accent-color:var(--primary);width:15px;height:15px">
        </label>
        <div style="position:absolute;top:8px;right:8px;z-index:2">${badge}</div>
        ${temFoto
          ? `<img src="${imgSrc}" alt="CH${r.channel}" style="width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#1a1a2e" onerror="this.style.opacity='.3'">`
          : `<div style="width:100%;aspect-ratio:16/9;background:#e9ecef;display:flex;align-items:center;justify-content:center;color:#aaa"><svg width='40' height='40' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='1.5'><rect x='2' y='2' width='20' height='20' rx='2'/><circle cx='12' cy='10' r='3'/><path d='m2 20 4-4 4 4 4-8 4 8'/></svg></div>`}
        <div style="position:absolute;bottom:0;left:0;right:0;padding:6px 10px;background:linear-gradient(transparent,rgba(0,0,0,.7));color:white;font-size:11px;display:flex;justify-content:space-between">
          <span class="monospace">${esc(r.host)} CH${r.channel}</span>
          <span style="color:${statusCl};font-weight:600">${esc(r.status||'')}</span>
        </div>
      </div>
      <div style="padding:10px 12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:2px">${esc(r.title||'')}</div>
        <div style="font-size:11px;color:var(--muted);display:flex;justify-content:space-between">
          <span>${esc(r.local||'')}</span>
          <span>${esc(r.modelo||'')}</span>
        </div>
      </div>
    </div>`;
  }).join('');

  // Click abre carrossel
  grid.querySelectorAll('.snap-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('input[type=checkbox]')) return;
      const idx = parseInt(card.dataset.gravIdx);
      openCarrosselGrav(rows, idx);
    });
  });
}

async function loadSnapNvr() {
  const data = await apiJson('/api/nvr/inventory');
  const nvrs = data?.nvrs || data || [];
  const grid = document.getElementById('snapNvrGrid');
  if (!nvrs.length) {
    grid.innerHTML = '<p style="padding:40px;color:var(--muted);grid-column:1/-1;text-align:center">Nenhum NVR.</p>';
    return;
  }
  grid.innerHTML = nvrs.map(n => `
    <div class="snap-card">
      <img src="${API_BASE}/data/nvr_snapshot/${esc(n.snapshot_file || '')}" alt="${esc(n.ip)}"
           onerror="this.style.background='#e9ecef';this.removeAttribute('src')">
      <div class="snap-card-body">
        <div class="snap-card-ip">${esc(n.ip)}</div>
        <div class="snap-card-sub">${esc(n.brand || '')}  ${esc(n.channels || '?')} canais</div>
      </div>
    </div>`).join('');
}

//  Manutencao
let _mntCamAll = [];
const _mntCamFilter = { q: '', site: '', status: '' };

function _mntSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

function _ipToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + (parseInt(o, 10) || 0), 0) >>> 0;
}

// Retorna true/false se ip bate com term como range/CIDR, ou null se term n\u00e3o \u00e9 padr\u00e3o de IP.
function _mntIpMatchTerm(ip, term) {
  // Range completo: 10.10.9.20-10.10.9.30
  const fullRange = term.match(/^(\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (fullRange) {
    const n = _ipToInt(ip), lo = _ipToInt(fullRange[1]), hi = _ipToInt(fullRange[2]);
    return n >= lo && n <= hi;
  }
  // Range curto (\u00faltimo octeto): 10.10.9.20-30
  const shortRange = term.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3})\.(\d{1,3})-(\d{1,3})$/);
  if (shortRange) {
    const parts = ip.split('.');
    if (parts.slice(0, 3).join('.') === shortRange[1]) {
      const last = parseInt(parts[3], 10);
      return last >= parseInt(shortRange[2], 10) && last <= parseInt(shortRange[3], 10);
    }
    return false;
  }
  // CIDR: 10.10.9.0/24
  const cidr = term.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidr) {
    const bits = parseInt(cidr[2], 10);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (_ipToInt(ip) & mask) === (_ipToInt(cidr[1]) & mask);
  }
  return null; // n\u00e3o \u00e9 padr\u00e3o de range/CIDR
}

async function loadMntCam() {
  const grid = document.getElementById('mntCamGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted)">Carregando</div>';
  const data = await apiJson('/api/cameras?mode=olt');
  _mntCamAll = data?.cameras || data || [];

  const sites = [...new Set(_mntCamAll.map(c => c.local).filter(Boolean))].sort();
  const sel = document.getElementById('mntCamSite');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = '<option value="">Todos os sites</option>' + sites.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
    sel.value = cur;
  }
  _mntCamRender();
}

function _mntCamRender() {
  const grid = document.getElementById('mntCamGrid');
  if (!grid) return;
  const checked = new Set([...document.querySelectorAll('.chk-mnt-cam:checked')].map(c => c.value));
  const { q, site, status } = _mntCamFilter;
  const ql = _mntSearchText(q);

  // Separa query em termos por vírgula (OR entre termos)
  const terms = ql ? ql.split(',').map(t => t.trim()).filter(Boolean) : [];

  let filtered = _mntCamAll.filter(c => {
    if (site && (c.local || '') !== site) return false;
    if (status && (c.status || '').toLowerCase() !== status) return false;
    if (!terms.length) return true;
    const camIp   = (c.ip || '').trim();
    const haystack = [
      c.ip, c.host, c.camera_ip, c.ip_camera,
      c.titulo, c.title, c.nome, c.name,
      c.local, c.site,
      c.modelo, c.model, c.fabricante, c.brand,
      c.mac, c.onu_name, c.onu_serial,
    ].map(_mntSearchText).join(' ');
    // Basta UM termo bater (OR)
    return terms.some(term => {
      const ipMatch = _mntIpMatchTerm(camIp, term);
      if (ipMatch !== null) return ipMatch;      // era range/CIDR
      return haystack.includes(term);            // texto livre
    });
  });

  filtered.sort((a, b) => (a.titulo || a.ip || '').localeCompare(b.titulo || b.ip || '', 'pt', { numeric: true }));

  if (!filtered.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted)">Nenhuma camera encontrada.</div>';
    _mntCamUpdateCount();
    return;
  }

  grid.innerHTML = filtered.map(c => {
    const ip  = c.ip || '';
    const st  = (c.status || '').toLowerCase();
    const dot = st === 'online' ? 'online' : st === 'offline' ? 'offline' : 'unknown';
    const snap = c.snapshot_url || c.imgbb_url || '';
    const sel = checked.has(ip);
    return `
      <div class="mnt-cam-card${sel ? ' selected' : ''}" data-ip="${esc(ip)}" data-titulo="${esc(c.titulo||ip)}" onclick="_mntCamCardClick(this,event)">
        <input type="checkbox" class="mnt-cam-card-chk chk-mnt-cam" value="${esc(ip)}" ${sel ? 'checked' : ''} onclick="event.stopPropagation();_mntCamToggle(this)">
        <div class="mnt-cam-card-img">
          ${snap ? `<img src="${esc(snap)}" loading="lazy" onerror="this.style.display='none'">` : `<div class="mnt-cam-no-snap"><i data-lucide="camera-off" style="width:22px;height:22px"></i></div>`}
          <span class="mnt-cam-dot ${dot}"></span>
          <button class="mnt-stream-btn" onclick="event.stopPropagation();openMntStream('${esc(ip)}','${esc(c.titulo||ip)}','${esc(snap)}')" title="Ver stream / links">
            <i data-lucide="play-circle" style="width:16px;height:16px"></i>
          </button>
        </div>
        <div class="mnt-cam-card-info">
          <div class="mnt-cam-card-title">${esc(c.titulo || ip)}</div>
          <div class="mnt-cam-card-sub">${esc(ip)}  ${esc(c.local || '')}</div>
          <div class="mnt-cam-card-sub">${esc(c.modelo || c.model || '')}</div>
        </div>
        <div class="mnt-cam-card-result" id="mntRes_${ip.replace(/\./g,'_')}"></div>
      </div>`;
  }).join('');

  lucide.createIcons();
  _mntCamUpdateCount();
}

function _mntCamCardClick(card, event) {
  if (event.target.classList.contains('chk-mnt-cam')) return;
  const chk = card.querySelector('.chk-mnt-cam');
  if (chk) { chk.checked = !chk.checked; _mntCamToggle(chk); }
}

function _mntCamToggle(chk) {
  chk.closest('.mnt-cam-card')?.classList.toggle('selected', chk.checked);
  _mntCamUpdateCount();
}

function _mntCamUpdateCount() {
  const n = document.querySelectorAll('.chk-mnt-cam:checked').length;
  const el = document.getElementById('mntCamSelectedCount');
  if (el) el.textContent = n === 0 ? '0 selecionadas' : `${n} selecionada${n !== 1 ? 's' : ''}`;
}

//  Stream modal — WebRTC via go2rtc
let _mntStreamIp   = '';
let _mntStreamUser = '';
let _mntStreamPass = '';
let _mntStreamSubtype = 1; // 0=main 1080p  1=sub 480p
let _mntStreamMuted   = true;
let _rtcPeer = null;
let _mntClockTimer = null;

const _DAYS_PT   = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
const _MONTHS_PT = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

function _mntTickClock() {
  const now = new Date();
  const hh  = String(now.getHours()).padStart(2,'0');
  const mm  = String(now.getMinutes()).padStart(2,'0');
  const ss  = String(now.getSeconds()).padStart(2,'0');
  const clk = document.getElementById('mntStreamClock');
  if (clk) clk.textContent = `${hh}:${mm}:${ss}`;
  const dt  = document.getElementById('mntStreamDate');
  if (dt)  dt.textContent  = `${_DAYS_PT[now.getDay()]}, ${now.getDate()} ${_MONTHS_PT[now.getMonth()]}`;
}

function openMntStream(ip, titulo) {
  _mntStreamIp   = ip;
  _mntStreamUser = document.getElementById('mntCamUser')?.value || 'admin';
  _mntStreamPass = document.getElementById('mntCamPass')?.value || '';
  _mntStreamSubtype = 1;
  _mntStreamMuted   = true;

  document.getElementById('mntStreamTitle').textContent = titulo || ip;
  document.getElementById('mntStreamIp').textContent    = ip;
  document.getElementById('mntStreamRtspMain').value    = `rtsp://${_mntStreamUser}:${_mntStreamPass}@${ip}:554/cam/realmonitor?channel=1&subtype=0`;
  document.getElementById('mntStreamRtspSub').value     = `rtsp://${_mntStreamUser}:${_mntStreamPass}@${ip}:554/cam/realmonitor?channel=1&subtype=1`;
  const qualLabel = document.getElementById('mntStreamQualLabel');
  if (qualLabel) qualLabel.textContent = 'Sub-stream';
  const webLink = document.getElementById('mntStreamOpenWeb');
  if (webLink) webLink.href = `http://${ip}/`;
  const muteBtn = document.getElementById('mntStreamMuteBtn');
  if (muteBtn) muteBtn.innerHTML = '<i data-lucide="volume-x" style="width:15px;height:15px"></i>';

  document.getElementById('modalMntStream').classList.remove('hidden');
  lucide.createIcons();

  _mntTickClock();
  clearInterval(_mntClockTimer);
  _mntClockTimer = setInterval(_mntTickClock, 1000);

  _startWebRTC(ip, _mntStreamUser, _mntStreamPass, _mntStreamSubtype);
}

async function _startWebRTC(ip, user, pass, subtype) {
  const video       = document.getElementById('mntStreamVideo');
  const placeholder = document.getElementById('mntStreamPlaceholder');
  const statusEl    = document.getElementById('mntStreamStatus');

  if (_rtcPeer) { try { _rtcPeer.close(); } catch(e){} _rtcPeer = null; }
  video.srcObject = null;
  video.classList.add('hidden');
  video.muted = true;
  if (placeholder) placeholder.style.display = '';
  if (statusEl) statusEl.textContent = 'Conectando...';

  const streamName = `cam_${ip.replace(/\./g, '_')}_${subtype}`;
  const uEnc = encodeURIComponent(user);
  const pEnc = encodeURIComponent(pass);

  try {
    const regResp = await api(
      `/api/maintenance/stream_register/${ip}?user=${uEnc}&password=${pEnc}&subtype=${subtype}`,
      { method: 'POST' }
    );
    if (!regResp || !regResp.ok) {
      if (statusEl) statusEl.textContent = 'Erro ao registrar stream';
      return;
    }
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Servidor de stream indisponível';
    return;
  }

  if (_mntStreamIp !== ip) return;

  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    _rtcPeer = pc;

    pc.ontrack = ({ streams }) => {
      if (!streams[0] || _mntStreamIp !== ip) return;
      video.srcObject = streams[0];
      video.muted = _mntStreamMuted;
      video.classList.remove('hidden');
      if (placeholder) placeholder.style.display = 'none';
      if (statusEl) statusEl.textContent = '';
    };

    pc.oniceconnectionstatechange = () => {
      if (['failed','disconnected'].includes(pc.iceConnectionState)) {
        if (_mntStreamIp === ip && statusEl) statusEl.textContent = 'Stream desconectado';
      }
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${wsProto}://${location.host}/go2rtc/api/ws?src=${streamName}`);

    ws.onopen = async () => {
      if (statusEl) statusEl.textContent = 'Aguardando vídeo...';
      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'webrtc/candidate', value: candidate.candidate }));
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'webrtc/offer', value: offer.sdp }));
    };

    ws.onmessage = async ({ data }) => {
      const msg = JSON.parse(data);
      if (msg.type === 'webrtc/answer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.value });
      } else if (msg.type === 'webrtc/candidate' && msg.value) {
        await pc.addIceCandidate({ candidate: msg.value, sdpMid: '0', sdpMLineIndex: 0 });
      } else if (msg.type === 'error') {
        if (statusEl) statusEl.textContent = 'Erro go2rtc: ' + msg.value;
      }
    };

    ws.onerror = () => {
      if (_mntStreamIp === ip && statusEl) statusEl.textContent = 'Erro de conexão WebSocket';
    };

    ws.onclose = ({ code }) => {
      if (_mntStreamIp === ip && statusEl && !video.srcObject)
        statusEl.textContent = code === 1000 ? 'Stream encerrado' : `WS fechou (${code})`;
    };

  } catch (e) {
    if (statusEl) statusEl.textContent = 'Erro: ' + (e.message || e);
  }
}

function closeMntStream() {
  clearInterval(_mntClockTimer);
  _mntClockTimer = null;
  if (_rtcPeer) { try { _rtcPeer.close(); } catch(e){} _rtcPeer = null; }
  _mntStreamIp = '';
  const video = document.getElementById('mntStreamVideo');
  if (video) { video.srcObject = null; video.classList.add('hidden'); }
  const placeholder = document.getElementById('mntStreamPlaceholder');
  if (placeholder) placeholder.style.display = '';
  document.getElementById('modalMntStream').classList.add('hidden');
}

function _mntStreamCopy(id) {
  const el = document.getElementById(id);
  if (!el) return;
  navigator.clipboard?.writeText(el.value).then(() => showToast('Copiado!')).catch(() => {});
}

function _mntStreamSnapshot() {
  const video = document.getElementById('mntStreamVideo');
  if (!video || !video.srcObject) { showToast('Sem vídeo para capturar', true); return; }
  const canvas = document.createElement('canvas');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;
  canvas.getContext('2d').drawImage(video, 0, 0);
  const ts = new Date().toISOString().slice(0,19).replace(/[T:]/g,'-');
  const a  = document.createElement('a');
  a.download = `snapshot_${_mntStreamIp}_${ts}.png`;
  a.href = canvas.toDataURL('image/png');
  a.click();
  showToast('Frame salvo');
}

function _mntStreamFullscreen() {
  const wrap = document.getElementById('mntVideoWrap');
  if (!wrap) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else wrap.requestFullscreen().catch(() => {});
}

function _mntStreamMute() {
  const video  = document.getElementById('mntStreamVideo');
  const btn    = document.getElementById('mntStreamMuteBtn');
  _mntStreamMuted = !_mntStreamMuted;
  if (video) video.muted = _mntStreamMuted;
  if (btn) {
    btn.innerHTML = _mntStreamMuted
      ? '<i data-lucide="volume-x" style="width:15px;height:15px"></i>'
      : '<i data-lucide="volume-2" style="width:15px;height:15px"></i>';
    lucide.createIcons();
  }
}

async function _mntStreamReboot() {
  if (!_mntStreamIp) return;
  if (!confirm(`Reiniciar câmera ${_mntStreamIp}?`)) return;
  try {
    await api('/api/cameras/reboot', { method: 'POST', body: JSON.stringify({ ips: [_mntStreamIp] }) });
    showToast('Reboot enviado');
  } catch (e) { showToast('Erro ao reiniciar', true); }
}

function _mntStreamToggleQuality() {
  _mntStreamSubtype = _mntStreamSubtype === 1 ? 0 : 1;
  const label = document.getElementById('mntStreamQualLabel');
  if (label) label.textContent = _mntStreamSubtype === 1 ? 'Sub-stream' : 'Principal';
  _startWebRTC(_mntStreamIp, _mntStreamUser, _mntStreamPass, _mntStreamSubtype);
}

//  Modals de configuracao 
function openMntMirrorModal() {
  const n = document.querySelectorAll('.chk-mnt-cam:checked').length;
  if (!n) { showToast('Selecione ao menos uma camera', true); return; }
  document.getElementById('modalMntMirror').classList.remove('hidden');
  lucide.createIcons();
}

function openMntDayNightModal() {
  const n = document.querySelectorAll('.chk-mnt-cam:checked').length;
  if (!n) { showToast('Selecione ao menos uma camera', true); return; }
  document.getElementById('modalMntDayNight').classList.remove('hidden');
  lucide.createIcons();
}

function openMntQualityModal() {
  const n = document.querySelectorAll('.chk-mnt-cam:checked').length;
  if (!n) { showToast('Selecione ao menos uma camera', true); return; }
  document.getElementById('modalMntQuality').classList.remove('hidden');
  lucide.createIcons();
}

function openMntNtpModal() {
  const n = document.querySelectorAll('.chk-mnt-cam:checked').length;
  if (!n) { showToast('Selecione ao menos uma camera', true); return; }
  const input = document.getElementById('mntNtpAddress');
  if (input && !input.value.trim()) input.value = 'time.cloudflare.com';
  document.getElementById('modalMntNtp')?.classList.remove('hidden');
  setTimeout(() => input?.focus(), 80);
  lucide.createIcons();
}

function closeMntNtpModal() {
  document.getElementById('modalMntNtp')?.classList.add('hidden');
}

function runMntNtp() {
  const input = document.getElementById('mntNtpAddress');
  const address = input?.value.trim() || 'time.cloudflare.com';
  closeMntNtpModal();
  _mntCamRunAction('ntp', { address });
}

function openMntRenameModal() {
  const ips = [...document.querySelectorAll('.chk-mnt-cam:checked')].map(c => c.value);
  if (!ips.length) { showToast('Selecione ao menos uma camera', true); return; }
  const grid = document.getElementById('mntRenameRows');
  grid.innerHTML = ips.map(ip => {
    const card = document.querySelector(`.mnt-cam-card[data-ip="${CSS.escape(ip)}"]`);
    const titulo = card?.dataset.titulo || ip;
    return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px">
      <span style="font-size:11px;color:var(--muted);min-width:100px;flex-shrink:0;font-family:monospace">${esc(ip)}</span>
      <input type="text" data-rename-ip="${esc(ip)}" value="${esc(titulo)}" style="flex:1;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:13px">
    </div>`;
  }).join('');
  document.getElementById('modalMntRename').classList.remove('hidden');
  lucide.createIcons();
}

async function runMntRename() {
  const user = document.getElementById('mntCamUser')?.value?.trim() || 'admin';
  const pass = document.getElementById('mntCamPass')?.value || '';
  const targets = [...document.querySelectorAll('[data-rename-ip]')].map(inp => ({
    ip: inp.dataset.renameIp, title: inp.value.trim()
  })).filter(t => t.title);
  if (!targets.length) return;
  document.getElementById('modalMntRename').classList.add('hidden');
  const body = document.getElementById('mntCamConsoleBody');
  if (body) body.innerHTML = '';
  _mntLog('mntCamConsole', 'mntCamConsoleBody', '', `[${new Date().toLocaleTimeString('pt-BR')}] RENOMEAR ${targets.length} camera(s)`, true);
  try {
    const res  = await api('/api/maintenance/batch/rename', { method:'POST', body: JSON.stringify({ user, pass, targets }) });
    const data = await res.json().catch(() => ({}));
    (data.results || []).forEach(r => _mntLog('mntCamConsole', 'mntCamConsoleBody', r.ip || '', r.title ? ` "${r.title}" ${r.ok ? '' : ' ' + (r.error||'erro')}` : (r.error||'erro'), r.ok));
    showToast(data.message || 'Renomear: concluido');
    _mntCamAll = [];
    loadMntCam();
  } catch (err) {
    _mntLog('mntCamConsole', 'mntCamConsoleBody', '', err.message, false);
    showToast(err.message, true);
  }
}

async function runMntMirror() {
  const mirror = document.getElementById('mntMirrorCheck')?.checked || false;
  const flip   = document.getElementById('mntFlipCheck')?.checked || false;
  document.getElementById('modalMntMirror').classList.add('hidden');
  await _mntCamRunAction('mirror', { mirror, flip });
}

async function runMntDayNight() {
  const selected = document.querySelector('input[name="mntDayNightMode"]:checked');
  const mode = parseInt(selected?.value || '0');
  document.getElementById('modalMntDayNight').classList.add('hidden');
  await _mntCamRunAction('day_night', { mode });
}

async function runMntQuality() {
  const bitrate = parseInt(document.getElementById('mntQualityBitrate')?.value || '0') || null;
  const fps     = parseInt(document.getElementById('mntQualityFps')?.value || '0') || null;
  const codec   = document.getElementById('mntQualityCodec')?.value || '';
  document.getElementById('modalMntQuality').classList.add('hidden');
  await _mntCamRunAction('video_quality', { bitrate, fps, codec: codec || undefined });
}

//  Configuracao de rede em lote 
function openMntNetworkModal() {
  const ips = [...document.querySelectorAll('.chk-mnt-cam:checked')].map(c => c.value);
  if (!ips.length) { showToast('Selecione ao menos uma camera', true); return; }
  const rows = document.getElementById('mntNetRows');
  rows.innerHTML = ips.sort((a, b) => {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 4; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  }).map(ip => `
    <div style="display:flex;gap:8px;align-items:center">
      <span style="font-size:11px;color:var(--muted);min-width:110px;font-family:monospace;flex-shrink:0">${esc(ip)}</span>
      <span style="color:var(--muted)"></span>
      <input type="text" data-net-old="${esc(ip)}" value="${esc(ip)}"
        style="flex:1;border:1px solid var(--border);border-radius:6px;padding:5px 8px;font-size:13px;font-family:monospace;background:var(--surface)">
    </div>`).join('');
  document.getElementById('modalMntNetwork').classList.remove('hidden');
  lucide.createIcons();
}

async function runMntNetwork() {
  const mask    = document.getElementById('mntNetMask')?.value || '';
  const gateway = document.getElementById('mntNetGateway')?.value?.trim() || '';
  const user    = document.getElementById('mntCamUser')?.value?.trim() || 'admin';
  const pass    = document.getElementById('mntCamPass')?.value || '';
  const targets = [...document.querySelectorAll('[data-net-old]')].map(inp => ({
    old_ip: inp.dataset.netOld, new_ip: inp.value.trim()
  })).filter(t => t.new_ip);

  if (!targets.length) return;
  if (!mask && !gateway && targets.every(t => t.old_ip === t.new_ip)) {
    showToast('Nada a alterar  preencha mascara, gateway ou edite algum IP', true); return;
  }
  document.getElementById('modalMntNetwork').classList.add('hidden');
  const consoleId = 'mntCamConsole', bodyId = 'mntCamConsoleBody';
  document.getElementById(consoleId)?.classList.remove('hidden');
  document.getElementById(bodyId).innerHTML = '';
  _mntLog(consoleId, bodyId, null, `Aplicando configuracao de rede em ${targets.length} camera(s)`, true);
  try {
    const r = await fetch('/api/maintenance/batch/network_config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ targets, mask, gateway, user, pass })
    });
    const data = await r.json();
    (data.results || []).forEach(res => {
      const detail = res.new_ip !== res.ip ? ` ${res.new_ip}` : '';
      _mntLog(consoleId, bodyId, res.ip, `${detail}  ${res.msg}`, res.ok);
    });
    _mntLog(consoleId, bodyId, null, 'Concluido. Cameras reiniciam em ~30s.', true);
  } catch (e) {
    _mntLog(consoleId, bodyId, null, `Erro: ${e.message}`, false);
  }
}

//  Deslocar IPs em lote 
function openMntShiftIpModal() {
  const firstIp = document.querySelector('.chk-mnt-cam:checked')?.value || '';
  if (firstIp) {
    const parts = firstIp.split('.');
    if (parts.length === 4) {
      document.getElementById('mntShiftPrefix').value = parts.slice(0, 3).join('.') + '.';
    }
  }
  _mntShiftPreview();
  document.getElementById('modalMntShiftIp').classList.remove('hidden');
  lucide.createIcons();
}

function _mntShiftPreview() {
  const prefix = document.getElementById('mntShiftPrefix')?.value || '';
  const start  = parseInt(document.getElementById('mntShiftStart')?.value || '');
  const end    = parseInt(document.getElementById('mntShiftEnd')?.value || '');
  const delta  = parseInt(document.getElementById('mntShiftDelta')?.value || '0');
  const box    = document.getElementById('mntShiftPreviewBox');
  if (!box) return;
  if (!prefix || isNaN(start) || isNaN(end) || isNaN(delta) || delta === 0 || start > end) {
    box.innerHTML = '<em style="color:var(--muted)">Preencha os campos acima</em>';
    return;
  }
  let octets = [];
  for (let i = start; i <= end; i++) octets.push(i);
  if (delta > 0) octets = octets.slice().reverse();
  const sign = delta > 0 ? '+' : '';
  const lines = octets.map(o => {
    const n = o + delta;
    const ok = n >= 1 && n <= 254;
    const color = ok ? 'var(--primary)' : 'var(--danger)';
    const warn  = ok ? '' : '  invalido';
    return `<div style="display:flex;gap:12px;padding:2px 0"><span style="opacity:.6;min-width:120px">${prefix}${o}</span><span style="color:var(--muted)"></span><span style="color:${color};font-weight:600">${prefix}${n}${warn}</span></div>`;
  });
  box.innerHTML = `<div style="margin-bottom:6px;opacity:.6;font-size:11px">Ordem de execucao (delta ${sign}${delta})  ${octets.length} camera(s)</div>` + lines.join('');
}

async function runMntShiftIp() {
  const prefix  = document.getElementById('mntShiftPrefix')?.value?.trim() || '';
  const start   = parseInt(document.getElementById('mntShiftStart')?.value || '');
  const end     = parseInt(document.getElementById('mntShiftEnd')?.value || '');
  const delta   = parseInt(document.getElementById('mntShiftDelta')?.value || '0');
  const user    = document.getElementById('mntCamUser')?.value?.trim() || 'admin';
  const pass    = document.getElementById('mntCamPass')?.value || '';
  const gateway = document.getElementById('mntShiftGateway')?.value?.trim() || '';

  if (!prefix || isNaN(start) || isNaN(end) || isNaN(delta) || delta === 0 || start > end) {
    showToast('Preencha todos os campos corretamente', true); return;
  }
  document.getElementById('modalMntShiftIp').classList.add('hidden');
  const consoleId = 'mntCamConsole', bodyId = 'mntCamConsoleBody';
  document.getElementById(consoleId)?.classList.remove('hidden');
  document.getElementById(bodyId).innerHTML = '';
  _mntLog(consoleId, bodyId, null, `Deslocando ${prefix}${start}${prefix}${end} por ${delta > 0 ? '+' : ''}${delta}`, true);
  try {
    const r = await fetch('/api/maintenance/batch/shift_ips', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefix, start_octet: start, end_octet: end, delta, user, pass, gateway })
    });
    const data = await r.json();
    (data.results || []).forEach(res => {
      _mntLog(consoleId, bodyId, res.ip, ` ${res.new_ip}  ${res.msg}`, res.ok);
    });
    _mntLog(consoleId, bodyId, null, 'Concluido. Aguarde as cameras reiniciarem (~30s).', true);
  } catch (e) {
    _mntLog(consoleId, bodyId, null, `Erro: ${e.message}`, false);
  }
}

function _mntLog(consoleId, bodyId, ip, msg, ok) {
  document.getElementById(consoleId)?.classList.remove('hidden');
  const body = document.getElementById(bodyId);
  if (body) {
    const line = document.createElement('div');
    line.innerHTML = `<span style="color:${ok ? '#6ee7b7' : '#fca5a5'}">${ok ? '' : ''}</span> <span style="color:#8ab">${esc(ip || '')}</span>${ip ? '  ' : ''}${esc(msg)}`;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }
  if (ip) {
    const res = document.getElementById(`mntRes_${ip.replace(/\./g,'_')}`);
    if (res) res.innerHTML = `<span style="color:${ok ? 'var(--primary)' : 'var(--danger)'}">${ok ? '' : ''} ${esc(msg)}</span>`;
  }
}

async function _mntCamRunAction(endpoint, extra = {}) {
  const ips = [...document.querySelectorAll('.chk-mnt-cam:checked')].map(c => c.value);
  if (!ips.length) { showToast('Selecione ao menos uma camera', true); return; }
  const user = document.getElementById('mntCamUser')?.value?.trim() || 'admin';
  const pass = document.getElementById('mntCamPass')?.value || '';

  const body = document.getElementById('mntCamConsoleBody');
  if (body) body.innerHTML = '';
  _mntLog('mntCamConsole', 'mntCamConsoleBody', '', `[${new Date().toLocaleTimeString('pt-BR')}] ${endpoint.toUpperCase()} em ${ips.length} camera(s)`, true);

  try {
    const res  = await api(`/api/maintenance/batch/${endpoint}`, { method:'POST', body: JSON.stringify({ ips, user, pass, ...extra }) });
    const data = await res.json().catch(() => ({}));
    (data.results || []).forEach(r => _mntLog('mntCamConsole', 'mntCamConsoleBody', r.ip || '', r.message || (r.ok ? 'OK' : r.error || 'Erro'), r.ok));
    if (!(data.results || []).length) _mntLog('mntCamConsole', 'mntCamConsoleBody', '', data.message || 'Concluido', data.ok !== false);
    showToast(data.message || `${endpoint}: concluido`);
  } catch (err) {
    _mntLog('mntCamConsole', 'mntCamConsoleBody', '', err.message, false);
    showToast(err.message, true);
  }
}

async function loadMntDvr() {
  const data  = await apiJson('/api/dvr/inventory');
  const dvrs  = data?.dvrs || data || [];
  const tbody = document.getElementById('mntDvrTable');
  const uniq  = new Map();
  dvrs.forEach(d => { if (!uniq.has(d.host || d.ip)) uniq.set(d.host || d.ip, d); });
  const rows = [...uniq.values()];
  if (!rows.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhum DVR.</td></tr>'; return; }
  tbody.innerHTML = rows.map(d => {
    const ip = d.host || d.ip || '';
    return `<tr>
      <td><input type="checkbox" class="chk-mnt-dvr" value="${esc(ip)}"></td>
      <td class="monospace">${esc(ip)}</td>
      <td>${esc(d.brand || d.fabricante || '')} ${esc(d.model || d.modelo || '')}</td>
      <td>${esc(d.local || d.site || '')}</td>
      <td>${statusBadge(d.status)}</td>
      <td class="text-muted" id="mntDvrRes_${ip.replace(/\./g,'_')}"></td>
    </tr>`;
  }).join('');

  document.getElementById('chkMntDvrAll').onchange = function() {
    document.querySelectorAll('.chk-mnt-dvr').forEach(c => c.checked = this.checked);
    _mntDvrUpdateCount();
  };
  document.querySelectorAll('.chk-mnt-dvr').forEach(c => c.addEventListener('change', _mntDvrUpdateCount));
  _mntDvrUpdateCount();
}

function _mntDvrUpdateCount() {
  const n = document.querySelectorAll('.chk-mnt-dvr:checked').length;
  const el = document.getElementById('mntDvrSelectedCount');
  if (el) el.textContent = `${n} selecionado${n !== 1 ? 's' : ''}`;
}

async function _mntDvrRunAction(endpoint) {
  const ips = [...document.querySelectorAll('.chk-mnt-dvr:checked')].map(c => c.value);
  if (!ips.length) { showToast('Selecione ao menos um DVR', true); return; }
  const user = document.getElementById('mntDvrUser')?.value?.trim() || 'admin';
  const pass = document.getElementById('mntDvrPass')?.value || '';
  const body = document.getElementById('mntDvrConsoleBody');
  if (body) body.innerHTML = '';
  _mntLog('mntDvrConsole', 'mntDvrConsoleBody', '', `[${new Date().toLocaleTimeString('pt-BR')}] ${endpoint.toUpperCase()} em ${ips.length} DVR(s)`, true);
  try {
    const res  = await api(`/api/maintenance/batch/${endpoint}`, { method:'POST', body: JSON.stringify({ ips, user, pass }) });
    const data = await res.json().catch(() => ({}));
    (data.results || []).forEach(r => {
      const ip = r.ip || r.host || '';
      _mntLog('mntDvrConsole', 'mntDvrConsoleBody', ip, r.message || (r.ok ? 'OK' : r.error || 'Erro'), r.ok);
      const el = document.getElementById(`mntDvrRes_${ip.replace(/\./g,'_')}`);
      if (el) el.innerHTML = `<span style="color:${r.ok ? 'var(--primary)' : 'var(--danger)'}">${r.ok ? '' : ''} ${esc(r.message || (r.ok ? 'OK' : 'Erro'))}</span>`;
    });
    if (!(data.results || []).length) _mntLog('mntDvrConsole', 'mntDvrConsoleBody', '', data.message || 'Concluido', data.ok !== false);
    showToast(data.message || `${endpoint}: concluido`);
  } catch (err) {
    _mntLog('mntDvrConsole', 'mntDvrConsoleBody', '', err.message, false);
    showToast(err.message, true);
  }
}

async function loadMntNvr() {
  const data  = await apiJson('/api/nvr/inventory');
  const nvrs  = data?.nvrs || data || [];
  const tbody = document.getElementById('mntNvrTable');
  const uniq  = new Map();
  nvrs.forEach(n => { if (!uniq.has(n.host || n.ip)) uniq.set(n.host || n.ip, n); });
  const rows = [...uniq.values()];
  if (!rows.length) { tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhum NVR.</td></tr>'; return; }
  tbody.innerHTML = rows.map(n => {
    const ip = n.host || n.ip || '';
    return `<tr>
      <td><input type="checkbox" class="chk-mnt-nvr" value="${esc(ip)}"></td>
      <td class="monospace">${esc(ip)}</td>
      <td>${esc(n.brand || n.fabricante || '')} ${esc(n.model || n.modelo || '')}</td>
      <td>${esc(n.local || n.site || '')}</td>
      <td>${statusBadge(n.status)}</td>
      <td class="text-muted" id="mntNvrRes_${ip.replace(/\./g,'_')}"></td>
    </tr>`;
  }).join('');

  document.getElementById('chkMntNvrAll').onchange = function() {
    document.querySelectorAll('.chk-mnt-nvr').forEach(c => c.checked = this.checked);
    _mntNvrUpdateCount();
  };
  document.querySelectorAll('.chk-mnt-nvr').forEach(c => c.addEventListener('change', _mntNvrUpdateCount));
  _mntNvrUpdateCount();
}

function _mntNvrUpdateCount() {
  const n = document.querySelectorAll('.chk-mnt-nvr:checked').length;
  const el = document.getElementById('mntNvrSelectedCount');
  if (el) el.textContent = `${n} selecionado${n !== 1 ? 's' : ''}`;
}

async function _mntNvrRunAction(endpoint) {
  const ips = [...document.querySelectorAll('.chk-mnt-nvr:checked')].map(c => c.value);
  if (!ips.length) { showToast('Selecione ao menos um NVR', true); return; }
  const user = document.getElementById('mntNvrUser')?.value?.trim() || 'admin';
  const pass = document.getElementById('mntNvrPass')?.value || '';
  const body = document.getElementById('mntNvrConsoleBody');
  if (body) body.innerHTML = '';
  _mntLog('mntNvrConsole', 'mntNvrConsoleBody', '', `[${new Date().toLocaleTimeString('pt-BR')}] ${endpoint.toUpperCase()} em ${ips.length} NVR(s)`, true);
  try {
    const res  = await api(`/api/maintenance/batch/${endpoint}`, { method:'POST', body: JSON.stringify({ ips, user, pass }) });
    const data = await res.json().catch(() => ({}));
    (data.results || []).forEach(r => {
      const ip = r.ip || r.host || '';
      _mntLog('mntNvrConsole', 'mntNvrConsoleBody', ip, r.message || (r.ok ? 'OK' : r.error || 'Erro'), r.ok);
      const el = document.getElementById(`mntNvrRes_${ip.replace(/\./g,'_')}`);
      if (el) el.innerHTML = `<span style="color:${r.ok ? 'var(--primary)' : 'var(--danger)'}">${r.ok ? '' : ''} ${esc(r.message || (r.ok ? 'OK' : 'Erro'))}</span>`;
    });
    if (!(data.results || []).length) _mntLog('mntNvrConsole', 'mntNvrConsoleBody', '', data.message || 'Concluido', data.ok !== false);
    showToast(data.message || `${endpoint}: concluido`);
  } catch (err) {
    _mntLog('mntNvrConsole', 'mntNvrConsoleBody', '', err.message, false);
    showToast(err.message, true);
  }
}

//  Reproducao DVR 
let _playbackBound = false;

function loadPlayback() {
  if (!_playbackBound) bindPlayback();
  playbackDefaults();
}

function playbackDefaults() {
  const date = document.getElementById('playbackDate');
  const start = document.getElementById('playbackStart');
  const end = document.getElementById('playbackEnd');
  if (date && !date.value) date.value = new Date().toISOString().slice(0, 10);
  if (start && !start.value) start.value = '08:30:00';
  if (end && !end.value) end.value = '09:00:00';
}

function bindPlayback() {
  _playbackBound = true;
  document.getElementById('playbackForm')?.addEventListener('submit', playbackCreateClip);
  document.getElementById('btnPlaybackSnapshot')?.addEventListener('click', playbackCreateSnapshot);
  document.getElementById('btnPlaybackFrames')?.addEventListener('click', playbackCreateFrames);
}

function playbackDateTime(timeId) {
  const date = document.getElementById('playbackDate').value;
  const time = document.getElementById(timeId).value;
  if (!date || !time) return '';
  return `${date} ${time.length === 5 ? `${time}:00` : time}`;
}

function playbackPayload() {
  return {
    host: document.getElementById('playbackHost').value.trim(),
    user: document.getElementById('playbackUser').value.trim(),
    password: document.getElementById('playbackPassword').value,
    channel: Number(document.getElementById('playbackChannel').value),
    start: playbackDateTime('playbackStart'),
    end: playbackDateTime('playbackEnd'),
    format: document.getElementById('playbackFormat').value,
  };
}

function playbackIntervalSeconds() {
  const min = Number(document.getElementById('playbackIntervalMin')?.value || 0);
  const sec = Number(document.getElementById('playbackIntervalSec')?.value || 0);
  return Math.max(1, (min * 60) + sec);
}

function setPlaybackStatus(text, isError = false) {
  const el = document.getElementById('playbackStatus');
  if (!el) return;
  el.textContent = text;
  el.style.color = isError ? 'var(--danger)' : 'var(--muted)';
}

function playbackFileUrl(path) {
  const sep = path.includes('?') ? '&' : '?';
  const token = _token ? `${sep}token=${encodeURIComponent(_token)}` : '';
  return `${API_BASE}${path}${token}`;
}

function renderPlaybackLink(data) {
  const box = document.getElementById('playbackDownloads');
  if (!box || !data?.url) return;
  const url = playbackFileUrl(data.url);
  const warning = data.warning ? `<p class="playback-warning">${esc(data.warning)}</p>` : '';
  const source = data.source_url ? `<a class="secondary-action" href="${playbackFileUrl(data.source_url)}" target="_blank" rel="noopener"><i data-lucide="file-video"></i> DAV</a>` : '';
  box.innerHTML = `
    ${warning}
    <div class="playback-download-row">
      <a class="primary-action" href="${url}" target="_blank" rel="noopener"><i data-lucide="download"></i> ${esc(data.filename || 'arquivo')}</a>
      ${source}
    </div>`;
  lucide.createIcons();
}

function clearPlaybackFrames() {
  const grid = document.getElementById('playbackFramesGrid');
  if (grid) grid.innerHTML = '';
}

function renderPlaybackFrames(data) {
  const grid = document.getElementById('playbackFramesGrid');
  if (!grid) return;
  const frames = data?.frames || [];
  grid.innerHTML = frames.map(frame => {
    const url = playbackFileUrl(frame.url);
    return `
      <a class="playback-frame-card" href="${url}" target="_blank" rel="noopener">
        <img src="${url}" alt="${esc(frame.timestamp)}">
        <span>${esc(frame.timestamp?.slice(11) || '')}</span>
      </a>`;
  }).join('');
}

async function playbackCreateClip(e) {
  e.preventDefault();
  const btn = document.getElementById('btnPlaybackClip');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Gerando';
  lucide.createIcons();
  setPlaybackStatus('Consultando DVR...');
  try {
    const res = await api('/api/playback/clip', { method: 'POST', body: JSON.stringify(playbackPayload()) });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) throw new Error(data?.detail || 'Falha ao gerar trecho.');
    clearPlaybackFrames();
    renderPlaybackLink(data);
    setPlaybackStatus(data.warning ? 'Trecho salvo em DAV.' : 'Trecho pronto.');
    showToast('Trecho gerado.');
  } catch (err) {
    setPlaybackStatus(err.message, true);
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    lucide.createIcons();
  }
}

async function playbackCreateSnapshot() {
  const btn = document.getElementById('btnPlaybackSnapshot');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Gerando';
  lucide.createIcons();
  setPlaybackStatus('Extraindo frame...');
  try {
    const base = playbackPayload();
    const res = await api('/api/playback/snapshot', {
      method: 'POST',
      body: JSON.stringify({ ...base, timestamp: base.start }),
    });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) throw new Error(data?.detail || 'Falha ao gerar frame.');
    const img = document.getElementById('playbackPreview');
    const frameUrl = playbackFileUrl(data.url);
    img.src = `${frameUrl}${frameUrl.includes('?') ? '&' : '?'}t=${Date.now()}`;
    img.classList.remove('hidden');
    clearPlaybackFrames();
    renderPlaybackLink(data);
    setPlaybackStatus('Frame pronto.');
    showToast('Frame gerado.');
  } catch (err) {
    setPlaybackStatus(err.message, true);
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    lucide.createIcons();
  }
}

async function playbackCreateFrames() {
  const btn = document.getElementById('btnPlaybackFrames');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Gerando';
  lucide.createIcons();
  setPlaybackStatus('Extraindo sequencia...');
  try {
    const payload = { ...playbackPayload(), interval_seconds: playbackIntervalSeconds(), timeout_sec: 900 };
    const res = await api('/api/playback/frames', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok) throw new Error(data?.detail || 'Falha ao gerar frames.');
    const img = document.getElementById('playbackPreview');
    img.classList.add('hidden');
    renderPlaybackFrames(data);
    renderPlaybackLink({ url: data.source_url, filename: 'DAV original' });
    setPlaybackStatus(`${data.count} frames gerados a cada ${data.interval_seconds}s.`);
    showToast(`${data.count} frames gerados.`);
  } catch (err) {
    setPlaybackStatus(err.message, true);
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    lucide.createIcons();
  }
}

//  IA NVR
let _iaNvrBound = false;
let _iaNvrTargets = [];

async function loadIaNvr() {
  if (!_iaNvrBound) bindIaNvr();
  iaNvrDefaults();
  const data = await apiJson('/api/ia/nvr/targets');
  _iaNvrTargets = data?.targets || [];
  populateIaNvrSiteFilter();
  populateIaNvrCameraSelect();
}

function iaNvrDefaults() {
  const date = document.getElementById('iaNvrDate');
  const start = document.getElementById('iaNvrStart');
  const end = document.getElementById('iaNvrEnd');
  if (date && !date.value) date.value = new Date().toISOString().slice(0, 10);
  if (start && !start.value) start.value = '08:30:00';
  if (end && !end.value) end.value = '09:00:00';
}

function bindIaNvr() {
  _iaNvrBound = true;
  document.getElementById('iaNvrSite')?.addEventListener('change', populateIaNvrCameraSelect);
  document.getElementById('iaNvrForm')?.addEventListener('submit', iaNvrRunSearch);
}

function populateIaNvrSiteFilter() {
  const sel = document.getElementById('iaNvrSite');
  if (!sel) return;
  const sites = [...new Set(_iaNvrTargets.map(t => t.site).filter(Boolean))].sort();
  const cur = sel.value;
  sel.innerHTML = '<option value="">Todos os sites</option>' +
    sites.map(s => `<option${s === cur ? ' selected' : ''}>${esc(s)}</option>`).join('');
}

function populateIaNvrCameraSelect() {
  const site = document.getElementById('iaNvrSite')?.value || '';
  const sel = document.getElementById('iaNvrCamera');
  if (!sel) return;
  const filtered = site ? _iaNvrTargets.filter(t => t.site === site) : _iaNvrTargets;
  const cur = sel.value;
  sel.innerHTML = '<option value="">Selecione a camera</option>' +
    filtered.map(t => {
      const value = `${t.host}|${t.http_port}|${t.channel}`;
      const label = `${t.title || ('Canal ' + t.channel)} - ${t.site || t.local || t.host}`;
      return `<option value="${esc(value)}"${value === cur ? ' selected' : ''}>${esc(label)}</option>`;
    }).join('');
}

function iaNvrDateTime(timeId) {
  const date = document.getElementById('iaNvrDate').value;
  const time = document.getElementById(timeId).value;
  if (!date || !time) return '';
  return `${date} ${time.length === 5 ? `${time}:00` : time}`;
}

function iaNvrResultCard(hit, index) {
  const clip = hit.clip_url ? `<a class="secondary-action" href="${playbackFileUrl(hit.clip_url)}" target="_blank" rel="noopener"><i data-lucide="film"></i> Baixar trecho</a>` : '';
  const pct = Math.round((hit.confidence || 0) * 100);
  return `
    <div class="ia-nvr-hit" style="padding:14px 0;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span style="font-weight:700;font-size:12px;color:var(--muted)">#${index + 1}</span>
        <strong>${esc(hit.title || hit.host)}</strong>
        <span style="font-size:11px;color:var(--muted)">${esc(hit.site || '')}</span>
        <span style="margin-left:auto;font-size:11px;font-weight:700;color:var(--primary)">${esc(hit.timestamp)}</span>
      </div>
      <p style="margin:6px 0 0;font-size:12px;color:var(--text)">${esc(hit.description || '')}</p>
      <div style="display:flex;align-items:center;gap:10px;margin-top:8px">
        <span style="font-size:11px;color:var(--muted)">Confianca: ${pct}%</span>
        ${clip}
      </div>
    </div>`;
}

function iaNvrMissRow(miss) {
  return `<div style="padding:6px 0;font-size:12px;color:var(--muted)">
    <i data-lucide="x-circle" style="width:12px;height:12px;vertical-align:-2px"></i>
    ${esc(miss.title || miss.host)}: ${esc(miss.reason)}
  </div>`;
}

function renderIaNvrResult(result) {
  const el = document.getElementById('iaNvrResults');
  if (!el) return;
  const hits = result?.hits || [];
  const misses = result?.misses || [];
  if (!hits.length) {
    el.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:16px 0">Nada encontrado nessa janela.</p>` +
      (misses.length ? `<div>${misses.map(iaNvrMissRow).join('')}</div>` : '');
    lucide.createIcons();
    return;
  }
  const truncatedNote = result.truncated
    ? `<p style="color:var(--amber);font-size:12px;margin-top:10px">Busca interrompida pelo limite de tempo -- resultado parcial.</p>` : '';
  el.innerHTML = hits.map(iaNvrResultCard).join('') +
    (misses.length ? `<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--muted)">Cameras verificadas sem resultado (${misses.length})</summary>${misses.map(iaNvrMissRow).join('')}</details>` : '') +
    truncatedNote;
  lucide.createIcons();
}

async function iaNvrPollJob(jobId) {
  const statusEl = document.getElementById('iaNvrStatus');
  for (;;) {
    const data = await apiJson(`/api/ia/nvr/search/jobs/${jobId}`);
    if (!data) { if (statusEl) statusEl.textContent = 'Falha ao consultar a busca.'; return; }
    if (data.status === 'done') {
      if (statusEl) statusEl.textContent = `Busca concluida (${data.elapsed_sec}s).`;
      renderIaNvrResult(data.result);
      return;
    }
    if (data.status === 'error') {
      if (statusEl) statusEl.textContent = data.error || 'Falha na busca.';
      showToast(data.error || 'Falha na busca.', true);
      return;
    }
    if (statusEl) statusEl.textContent = `Buscando... (${data.elapsed_sec}s)`;
    await new Promise(r => setTimeout(r, 3000));
  }
}

async function iaNvrRunSearch(e) {
  e.preventDefault();
  const camValue = document.getElementById('iaNvrCamera')?.value || '';
  const [host, httpPort, channel] = camValue.split('|');
  if (!host || !channel) { showToast('Selecione uma camera.', true); return; }
  const query = document.getElementById('iaNvrQuery').value.trim();
  if (!query) return;

  const btn = document.getElementById('btnIaSearch');
  const old = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i data-lucide="loader-2"></i> Buscando';
  lucide.createIcons();
  document.getElementById('iaNvrResults').innerHTML = '';
  const statusEl = document.getElementById('iaNvrStatus');
  if (statusEl) statusEl.textContent = 'Enviando busca...';

  try {
    const payload = {
      host,
      http_port: Number(httpPort) || 80,
      channel: Number(channel),
      user: document.getElementById('iaNvrUser').value.trim(),
      password: document.getElementById('iaNvrPassword').value,
      site: document.getElementById('iaNvrSite')?.value || '',
      start_time: iaNvrDateTime('iaNvrStart'),
      end_time: iaNvrDateTime('iaNvrEnd'),
      query,
      max_hops: Number(document.getElementById('iaNvrMaxHops').value) || 0,
      window_min: Number(document.getElementById('iaNvrWindowMin').value) || 5,
    };
    const res = await api('/api/ia/nvr/search/jobs', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok || !data?.job_id) throw new Error(data?.detail || 'Falha ao iniciar busca.');
    await iaNvrPollJob(data.job_id);
  } catch (err) {
    if (statusEl) statusEl.textContent = err.message;
    showToast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.innerHTML = old;
    lucide.createIcons();
  }
}

//  OLT 
let _oltRows   = [];
let _oltCamMap = {}; // serial|mac  camera
let _oltWs     = null;

async function loadOlt() {
  const [oltData, camData] = await Promise.all([
    apiJson('/api/olt/rows'),
    apiJson('/api/cameras'),
  ]);

  _oltRows = oltData?.rows || (Array.isArray(oltData) ? oltData : []);

  // Monta indice de cameras por serial e por mac
  const cams = camData?.cameras || (Array.isArray(camData) ? camData : []);
  _oltCamMap = {};
  cams.forEach(c => {
    if (c.onu_serial) _oltCamMap[c.onu_serial.toUpperCase()] = c;
    if (c.mac)        _oltCamMap[c.mac.toLowerCase()] = c;
  });

  renderOltTable(sortOltRows(_oltRows));
  populateOltMacSiteFilter();
}

function populateOltMacSiteFilter() {
  const sites = [...new Set(_oltRows.map(r => r.site).filter(Boolean))].sort();
  const olts  = [...new Set(_oltRows.map(r => r.olt_ip || r.olt_name).filter(Boolean))].sort();
  const selSite = document.getElementById('oltFilterSite');
  const selOlt  = document.getElementById('oltFilterOlt');
  if (selSite) {
    const cur = selSite.value;
    selSite.innerHTML = '<option value="">Todos os sites</option>' +
      sites.map(s => `<option${s === cur ? ' selected' : ''}>${esc(s)}</option>`).join('');
  }
  if (selOlt) {
    const cur = selOlt.value;
    selOlt.innerHTML = '<option value="">Todas as OLTs</option>' +
      olts.map(o => `<option${o === cur ? ' selected' : ''}>${esc(o)}</option>`).join('');
  }
  // Resumo
  setText('oltTotal',     _oltRows.length);
  setText('oltSiteCount', sites.length);
  setText('oltCount',     olts.length);
}

function renderOltTable(rows) {
  const tbody = document.getElementById('oltTableBody');
  if (!tbody) return;
  setText('oltTableFooter', `${rows.length} registro${rows.length !== 1 ? 's' : ''}`);
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Nenhum dado. Execute a coleta.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td style="text-align:center">${esc(String(r.pon ?? ''))}</td>
      <td style="text-align:center">${esc(String(r.onu_id ?? ''))}</td>
      <td class="text-muted">${esc(r.onu_name || '')}</td>
      <td class="monospace">${esc(r.onu_serial || '')}</td>
      <td class="monospace">${esc(r.cpe_mac || '')}</td>
      <td class="text-muted" style="text-align:center">${esc(r.vlan || '')}</td>
      <td class="monospace text-muted">${esc(r.olt_ip || '')}</td>
      <td class="text-muted">${esc(r.olt_name || '')}</td>
      <td class="text-muted">${esc(r.site || '')}</td>
    </tr>`).join('');
}

function sortOltRows(rows) {
  return [...rows].sort((a, b) => {
    const ponDiff = (Number(a.pon) || 0) - (Number(b.pon) || 0);
    if (ponDiff !== 0) return ponDiff;
    return (Number(a.onu_id) || 0) - (Number(b.onu_id) || 0);
  });
}

function filterOltTable() {
  const site = document.getElementById('oltFilterSite')?.value || '';
  const q    = (document.getElementById('oltSearch')?.value   || '').toLowerCase();
  const filtered = _oltRows.filter(r => {
    if (site && r.site !== site) return false;
    if (q) return [r.site, r.olt_ip, r.olt_name, r.onu_name, r.onu_serial, r.cpe_mac, r.vlan, String(r.pon), String(r.onu_id)]
      .some(f => (f || '').toLowerCase().includes(q));
    return true;
  });
  renderOltTable(sortOltRows(filtered));
}

function oltConsoleLog(text, cls = '') {
  const el = document.getElementById('oltConsole');
  if (!el) return;
  const line = document.createElement('div');
  if (cls) line.className = `ping-term-line-${cls === 'error' ? 'err' : cls === 'ok' ? 'ok' : 'info'}`;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

async function oltCollect() {
  const ip   = document.getElementById('oltIp')?.value.trim();
  const user = document.getElementById('oltUser')?.value.trim() || 'admin';
  const pass = document.getElementById('oltPassword')?.value;
  const site = document.getElementById('oltSite')?.value.trim();
  const pon  = document.getElementById('oltPon')?.value || 'all';
  const model= document.getElementById('oltModel')?.value || '8820i';
  const reuse= document.getElementById('oltReuse')?.checked || false;

  if (!ip) { showToast('Informe o IP da OLT', true); return; }

  // Abre terminal
  const term = document.getElementById('oltTerminal');
  const cons = document.getElementById('oltConsole');
  if (term) term.classList.remove('hidden');
  if (cons) cons.innerHTML = '';
  setText('oltTermTitle', `OLT  ${ip}`);
  setText('oltTermFooter', 'Iniciando');
  lucide.createIcons();

  // Conecta no WS de console (mantem vivo + recebe acks)
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null;
  try {
    ws = new WebSocket(`${wsProto}://${location.host}/ws/olt-console`);
    ws.onopen = () => ws.send(JSON.stringify({ token: _token }));
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'status' || m.type === 'log') {
          oltConsoleLog(m.message, 'info');
        }
      } catch {}
    };
  } catch {}

  // Sequencia de logs animados (refletem o que o servico realmente faz)
  const ponLabel = pon === 'all' ? 'TODAS as PONs' : `PON ${pon}`;
  const steps = [
    [0,    'info', `[INFO] Conectando em ${ip}${site ? ` [site: ${site}]` : ''}...`],
    [600,  'info', `[INFO] Autenticando como "${user}"...`],
    [1100, 'info', `[INFO] Varredura automatica de PONs usando 'onu status gpon <pon>'`],
    [1800, 'info', `[INFO] Descobrindo PONs configuradas em ${ip}...`],
    [2500, 'info', pon === 'all'
      ? '[INFO] PON 1 encontrada (Configured ONUs).'
      : `[INFO] PON ${pon} encontrada (Configured ONUs).`],
  ];
  if (pon === 'all') {
    for (let p = 2; p <= 8; p++) {
      steps.push([2500 + p * 200, 'info', `[INFO] PON ${p} encontrada (Configured ONUs).`]);
    }
  }
  steps.push([3200, 'info', `[INFO] Lendo ONUs da ${ponLabel} com 'onu status gpon'...`]);
  steps.push([3800, 'info', `[INFO] Coletando MACs de ${ponLabel}...`]);

  const timers = steps.map(([delay, cls, msg]) =>
    setTimeout(() => oltConsoleLog(msg, cls), delay)
  );

  // Ticker "ainda trabalhando"
  let tick = 0;
  const tickTimer = setInterval(() => {
    tick++;
    setText('oltTermFooter', `Coletando via SSH ${tick}s`);
  }, 1000);

  const payload = { olt_ip: ip, user, password: pass, pon, olt_model: model, reuse_json: reuse, ...(site && { site }) };

  try {
    const res = await api('/api/olt/collect-macs', { method: 'POST', body: JSON.stringify(payload), skipLogout: true });
    timers.forEach(t => clearTimeout(t));
    clearInterval(tickTimer);
    if (ws) { try { ws.close(); } catch {} }

    if (res?.ok) {
      const data = await res.json();
      const total = data?.count ?? data?.total ?? (Array.isArray(data?.rows) ? data.rows.length : null) ?? '?';
      oltConsoleLog('[INFO] Salvando base OLT no banco...', 'info');
      oltConsoleLog(`[OK] Coleta concluida! Total: ${total} registros.`, 'ok');
      setText('oltTermFooter', `Concluido  ${total} registros`);
      loadOlt();
    } else {
      const err = await res?.json().catch(() => ({}));
      oltConsoleLog('[ERRO] ' + (err?.detail || 'Falha na coleta.'), 'err');
      setText('oltTermFooter', 'Erro na coleta.');
    }
  } catch (e) {
    timers.forEach(t => clearTimeout(t));
    clearInterval(tickTimer);
    if (ws) { try { ws.close(); } catch {} }
    oltConsoleLog('[ERRO] ' + (e.message || 'Erro de conexao.'), 'err');
    setText('oltTermFooter', 'Erro.');
  }
}

async function loadSwitch() {
  const data = await apiJson('/api/switch/rows');
  const rows = data?.rows || data || [];
  const tbody = document.getElementById('switchTable');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Nenhum dado. Execute a coleta.</td></tr>';
    setText('switchFooter', '0 registros');
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="text-muted">${esc(r.port || '')}</td>
      <td class="monospace">${esc(r.mac || '')}</td>
      <td class="text-muted">${esc(r.vlan || '')}</td>
      <td>${esc(r.camera_name || r.camera || '')}</td>
    </tr>`).join('');
  setText('switchFooter', `${rows.length} registro${rows.length !== 1 ? 's' : ''}`);
}

//  Backup 
async function loadBackup() {
  const data = await apiJson('/api/backup/status');
  const el = document.getElementById('backupStatus');
  if (!data) { el.textContent = 'Nao foi possivel carregar o status.'; return; }
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div><strong>Tamanho do banco:</strong> ${esc(data.db_size || '')}</div>
      <div><strong>Cameras:</strong> ${esc(String(data.camera_count ?? ''))}</div>
      <div><strong>DVRs:</strong> ${esc(String(data.dvr_count ?? ''))}</div>
      <div><strong>NVRs:</strong> ${esc(String(data.nvr_count ?? ''))}</div>
      <div><strong>Ultimo backup:</strong> ${esc(data.last_backup || 'Nunca')}</div>
    </div>`;
}

//  Rede 
async function loadNetDevices() {
  const data = await apiJson('/api/network/devices');
  const devices = data?.devices || data || [];
  const tbody = document.getElementById('netDevicesTable');
  if (!devices.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Nenhum dispositivo cadastrado.</td></tr>';
    return;
  }
  tbody.innerHTML = devices.map(d => `
    <tr>
      <td><strong>${esc(d.name || d.hostname || '')}</strong></td>
      <td class="monospace">${esc(d.ip || '')}</td>
      <td class="text-muted">${esc(d.type || '')}</td>
      <td>${statusBadge(d.status)}</td>
      <td></td>
    </tr>`).join('');
}

function netToolSetLog(html, status = '') {
  const log = document.getElementById('netToolLog');
  const statusEl = document.getElementById('netToolStatus');
  if (log) log.innerHTML = html || 'Nenhum resultado.';
  if (statusEl && status) statusEl.textContent = status;
}

function netToolText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function netToolFormatLocal(data) {
  const result = data?.result || {};
  const items = result.items || [];
  if (Array.isArray(items) && items.length) {
    return items.map(item => {
      const ok = item.online === true || item.open === true || item.ok === true || (Number(item.status_code || 0) > 0 && Number(item.status_code || 0) < 500);
      const klass = ok ? 'network-tool-line-ok' : 'network-tool-line-fail';
      const parts = [
        ok ? 'OK' : 'FAIL',
        item.target || item.url || '',
        item.method ? `via ${item.method}` : '',
        item.port ? `porta ${item.port}` : '',
        item.status_code ? `HTTP ${item.status_code}` : '',
        item.rtt_ms ? `${item.rtt_ms}ms` : item.elapsed_ms ? `${item.elapsed_ms}ms` : '',
        item.server ? `server=${item.server}` : '',
        item.addresses ? `addr=${item.addresses.join(', ')}` : '',
        !ok && item.error ? `erro=${item.error}` : '',
      ].filter(Boolean).join(' ');
      return `<div class="${klass}">${esc(parts)}</div>`;
    }).join('');
  }
  if (result.stdout || result.stderr || result.error) {
    return `<div class="network-tool-line-muted">${esc([result.stdout, result.stderr, result.error].filter(Boolean).join('\n'))}</div>`;
  }
  return `<div>${esc(JSON.stringify(data, null, 2))}</div>`;
}

function netToolFormatJob(job) {
  const result = job?.result || {};
  const routerosPing = result.routeros_ping || result.result?.routeros_ping || '';
  const inventory = result.inventory || result.result?.inventory || null;
  if (routerosPing) {
    return routerosPing.split(/[;,]/).filter(Boolean).map(item => {
      const separator = item.includes('=') ? '=' : ':';
      const [target, ok] = item.split(separator);
      const normalized = String(ok || '').toLowerCase();
      const success = normalized === 'true' || normalized === '1';
      return `<div class="${success ? 'network-tool-line-ok' : 'network-tool-line-fail'}">${success ? 'OK' : 'FAIL'} ${esc(target || item)}</div>`;
    }).join('');
  }
  if (inventory) {
    return [
      `<div class="network-tool-line-ok">DHCP leases: ${esc(inventory.dhcp_leases ?? 0)}</div>`,
      `<div class="network-tool-line-ok">ARP entries: ${esc(inventory.arp_entries ?? 0)}</div>`,
      `<div class="network-tool-line-ok">Neighbors: ${esc(inventory.neighbors ?? 0)}</div>`,
    ].join('');
  }
  if (job?.error) return `<div class="network-tool-line-fail">${esc(job.error)}</div>`;
  return `<div class="network-tool-line-muted">Aguardando MikroTik.</div>`;
}

async function pollNetToolRemoteJob(connectorId, jobId) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 2500 : 5000));
    const data = await apiJson(`/api/connectors/${encodeURIComponent(connectorId)}/jobs`);
    const job = (data?.jobs || []).find(item => String(item.id || '') === String(jobId || ''));
    if (!job) continue;
    if (job.status === 'done' || job.status === 'failed') {
      netToolSetLog(netToolFormatJob(job), job.status === 'done' ? 'Job concluido.' : 'Job falhou.');
      return;
    }
    netToolSetLog(`<span class="network-tool-line-muted">Job ${esc(job.status || 'queued')} no MikroTik. Aguardando resultado...</span>`, 'Aguardando MikroTik...');
  }
  netToolSetLog('<span class="network-tool-line-muted">Job enviado, mas ainda sem resultado. Atualize ou execute novamente para consultar.</span>', 'Aguardando resultado.');
}

function netToolSelectedConnector() {
  return document.getElementById('netToolConnector')?.value || '';
}

async function loadNetOperate() {
  const data = await apiJson('/api/connectors');
  _connectors = data?.connectors || _connectors || [];
  const sel = document.getElementById('netToolConnector');
  if (sel) {
    sel.innerHTML = _connectors.map(row => `<option value="${esc(row.id)}">${esc(row.name || row.id)} - ${esc(row.site || '')}</option>`).join('');
  }
  updateNetToolFormState();
  lucide.createIcons();
}

function updateNetToolFormState() {
  const origin = document.getElementById('netToolOrigin')?.value || 'local';
  const test = document.getElementById('netToolTest')?.value || 'ping';
  const conn = document.getElementById('netToolConnector');
  const ports = document.getElementById('netToolPorts');
  const targets = document.getElementById('netToolTargets');
  if (conn) conn.disabled = origin !== 'connector';
  if (ports) ports.disabled = !['tcp', 'port_scan', 'http'].includes(test);
  if (targets) {
    targets.disabled = test === 'lan_inventory';
    if (test === 'lan_inventory') targets.placeholder = 'A coleta LAN usa DHCP, ARP e Neighbors do MikroTik selecionado.';
    else targets.placeholder = '10.10.9.20, 192.168.20.1-192.168.20.20 ou 192.168.20.0/24';
  }
}

async function runNetTool(e) {
  e?.preventDefault();
  const origin = document.getElementById('netToolOrigin')?.value || 'local';
  const test = document.getElementById('netToolTest')?.value || 'ping';
  const targetsRaw = document.getElementById('netToolTargets')?.value.trim() || '';
  const ports = document.getElementById('netToolPorts')?.value.trim() || '';
  const timeout = Number(document.getElementById('netToolTimeout')?.value || 3);
  const concurrency = Number(document.getElementById('netToolConcurrency')?.value || 64);
  const btn = document.getElementById('btnRunNetTool');

  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader"></i> Executando'; lucide.createIcons(); }
  netToolSetLog('<span class="network-tool-line-muted">Executando teste...</span>', 'Executando...');
  try {
    if (origin === 'connector') {
      const connectorId = netToolSelectedConnector();
      if (!connectorId) throw new Error('Selecione um conector MikroTik.');
      if (test !== 'ping' && test !== 'lan_inventory') {
        throw new Error('No MikroTik, esta primeira versao executa Ping e Coletar LAN. Para TCP/HTTP/DNS/Traceroute use Servidor local/VPN.');
      }
      const type = test === 'lan_inventory' ? 'lan_inventory' : 'ping_many';
      const targets = targetsRaw.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
      if (type === 'ping_many' && !targets.length) throw new Error('Informe ao menos um alvo para ping.');
      const res = await api('/api/connectors/jobs', {
        method: 'POST',
        body: JSON.stringify({ connector_id: connectorId, type, payload: type === 'ping_many' ? { targets } : {} }),
      });
      const body = await res?.json().catch(() => ({}));
      if (!res?.ok || body?.ok === false) throw new Error(body?.detail || 'Erro ao criar job remoto.');
      netToolSetLog(`Job ${esc(type)} enviado para o MikroTik.\n\nAguardando o conector executar no proximo ciclo.\nID: ${esc(body?.job?.id || '-')}`, 'Job remoto enviado.');
      await loadConnectorJobs(connectorId);
      pollNetToolRemoteJob(connectorId, body?.job?.id || '');
      return;
    }

    if (!targetsRaw) throw new Error('Informe ao menos um alvo.');
    const res = await api('/api/network/tools/run', {
      method: 'POST',
      body: JSON.stringify({ test, targets: targetsRaw, ports, timeout, concurrency }),
    });
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok || body?.ok === false) throw new Error(body?.detail || 'Falha ao executar teste.');
    netToolSetLog(netToolFormatLocal(body), `${body.count || 0} alvo(s) testado(s).`);
  } catch (err) {
    netToolSetLog(`<span class="network-tool-line-fail">${esc(err?.message || err)}</span>`, 'Falha no teste.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="play"></i> Executar'; lucide.createIcons(); }
  }
}

//  Implantacao
let _deployCurrentId = '';
let _deployConnectors = [];

function deployPayload() {
  return {
    id: _deployCurrentId || '',
    connector_id: document.getElementById('deployConnector')?.value || '',
    site: document.getElementById('deploySite')?.value.trim() || '',
    camera_mac: document.getElementById('deployCameraMac')?.value.trim() || '',
    camera_ip: document.getElementById('deployCameraIp')?.value.trim() || '',
    camera_title: document.getElementById('deployCameraTitle')?.value.trim() || '',
    camera_model: document.getElementById('deployCameraModel')?.value.trim() || '',
    camera_manufacturer: document.getElementById('deployCameraManufacturer')?.value.trim() || '',
    camera_user: document.getElementById('deployCameraUser')?.value.trim() || '',
    camera_password: document.getElementById('deployCameraPassword')?.value || '',
    location: document.getElementById('deployLocation')?.value.trim() || '',
    recorder_type: document.getElementById('deployRecorderType')?.value || '',
    recorder_host: document.getElementById('deployRecorderHost')?.value.trim() || '',
    recorder_channel: document.getElementById('deployRecorderChannel')?.value.trim() || '',
    recorder_title: document.getElementById('deployRecorderTitle')?.value.trim() || '',
  };
}

function deploySelectedConnector() {
  const id = document.getElementById('deployConnector')?.value || '';
  return _deployConnectors.find(c => String(c.id || c.connector_id || '') === id) || null;
}

function deployRenderConnectorStatus(justTested = false) {
  const box = document.getElementById('deployConnectorStatus');
  if (!box) return;
  const conn = deploySelectedConnector();
  if (!conn) {
    box.innerHTML = 'Selecione um conector.';
    box.classList.remove('error');
    return;
  }
  const online = conn.status === 'online';
  const inv = conn.inventory || {};
  const counts = [
    inv.dhcp_leases != null ? `${esc(inv.dhcp_leases)} DHCP` : '',
    inv.arp_entries != null ? `${esc(inv.arp_entries)} ARP` : '',
    inv.neighbors != null ? `${esc(inv.neighbors)} vizinhos` : '',
  ].filter(Boolean).join(' / ');
  const lastSeen = conn.last_seen ? esc(formatDateTimeShort(conn.last_seen)) : 'nunca';
  box.classList.toggle('error', !online);
  box.innerHTML = `
    <div><b style="color:${online ? 'var(--primary)' : 'var(--danger)'}">${online ? '● Online' : '○ Offline'}</b> -- ${esc(conn.name || conn.id)}</div>
    <div style="margin-top:4px">Ultimo sinal: ${lastSeen}</div>
    <div style="margin-top:2px">${counts || 'Sem inventario recebido ainda.'}</div>
    ${justTested ? '<div style="margin-top:4px;font-size:11px;color:var(--muted)">Testado agora.</div>' : ''}
  `;
}

async function deployTestConnector() {
  const sel = document.getElementById('deployConnector');
  const currentId = sel?.value || '';
  const box = document.getElementById('deployConnectorStatus');
  if (box) box.innerHTML = 'Consultando status do conector...';
  const data = await apiJson('/api/deployments/connectors');
  _deployConnectors = Array.isArray(data?.connectors) ? data.connectors : [];
  if (sel && currentId) sel.value = currentId;
  deployRenderConnectorStatus(true);
}

function deploySetResult(html, isError = false) {
  const box = document.getElementById('deployLookupResult');
  if (!box) return;
  box.innerHTML = html || 'Aguardando consulta no conector.';
  box.classList.toggle('error', !!isError);
}

function deployRenderSummary() {
  const p = deployPayload();
  const conn = deploySelectedConnector();
  const rows = [
    ['Conector', conn ? `${conn.name || conn.id} / ${conn.site || '-'}` : '-'],
    ['Camera', [p.camera_title, p.camera_ip].filter(Boolean).join(' - ') || '-'],
    ['MAC camera', p.camera_mac || '-'],
    ['Gravador', [p.recorder_type?.toUpperCase(), p.recorder_host, p.recorder_channel && `CH ${p.recorder_channel}`].filter(Boolean).join(' / ') || '-'],
    ['Localizacao', p.location || p.site || '-'],
  ];
  const filled = [p.connector_id, p.site, p.camera_ip, p.camera_title].filter(Boolean).length;
  const summary = document.getElementById('deploySummary');
  const status = document.getElementById('deploySummaryStatus');
  if (status) status.textContent = filled >= 4 ? 'Pronto para registrar camera.' : 'Preencha conector, site, IP e titulo.';
  if (summary) {
    summary.innerHTML = rows.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');
  }
}

async function loadDeployHistory() {
  const box = document.getElementById('deployHistory');
  if (!box) return;
  const data = await apiJson('/api/deployments');
  const rows = Array.isArray(data?.deployments) ? data.deployments : [];
  if (!rows.length) {
    box.innerHTML = '<div class="deployment-history-empty">Nenhuma implantacao salva ainda.</div>';
    return;
  }
  box.innerHTML = rows.slice(0, 12).map(r => `
    <div class="deployment-history-item">
      <b>${esc(r.camera_title || r.title || 'Sem titulo')}</b>
      <span>${esc(r.camera_ip || '-')} ${r.site ? `- ${esc(r.site)}` : ''}</span>
      <small>${esc(r.status || 'rascunho')} ${r.updated_at ? `- ${esc(r.updated_at)}` : ''}</small>
    </div>
  `).join('');
}

async function loadDeployNew() {
  const sel = document.getElementById('deployConnector');
  if (!sel) return;
  const data = await apiJson('/api/deployments/connectors');
  _deployConnectors = Array.isArray(data?.connectors) ? data.connectors : [];
  sel.innerHTML = _deployConnectors.length
    ? _deployConnectors.map(c => `<option value="${esc(c.id || c.connector_id || '')}">${esc(c.name || c.client || 'Conector')} - ${esc(c.site || '-')}</option>`).join('')
    : '<option value="">Nenhum conector disponivel</option>';
  const conn = deploySelectedConnector();
  const siteEl = document.getElementById('deploySite');
  if (conn && siteEl && !siteEl.value) siteEl.value = conn.site || conn.client || '';
  deploySetResult('Aguardando consulta no conector.');
  deployRenderConnectorStatus();
  deployRenderSummary();
  await loadDeployHistory();
  bindAccordionExclusive('#viewDeployNew');
  lucide.createIcons();
}

//  Implantacao - ONU (pagina dedicada: descobrir/autorizar/consultar/excluir)
let _onuSelectedDiscovered = null; // {pon, serno_id, serial, model, vendor}
let _oltInventoryRows = null; // cache: linhas de /api/olt/rows (IP/site/PON ja conhecidos)

async function populateOltIpDatalist(inputId, listId, ponInputId) {
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  if (!_oltInventoryRows) {
    const data = await apiJson('/api/olt/rows').catch(() => null);
    _oltInventoryRows = data?.rows || (Array.isArray(data) ? data : []) || [];
  }
  const byIp = new Map();
  _oltInventoryRows.forEach(r => {
    const ip = (r.olt_ip || '').trim();
    if (!ip) return;
    if (!byIp.has(ip)) byIp.set(ip, { ip, name: r.olt_name || '', sites: new Set(), pons: new Set() });
    const entry = byIp.get(ip);
    if (r.site) entry.sites.add(r.site);
    if (r.pon) entry.pons.add(String(r.pon));
  });
  listEl.innerHTML = [...byIp.values()].map(e => {
    const label = [e.name, [...e.sites].join('/')].filter(Boolean).join(' - ');
    return `<option value="${esc(e.ip)}">${esc(label)}</option>`;
  }).join('');

  const inputEl = document.getElementById(inputId);
  const ponEl = ponInputId ? document.getElementById(ponInputId) : null;
  if (inputEl && ponEl && !inputEl.dataset.oltAutofillBound) {
    inputEl.dataset.oltAutofillBound = '1';
    inputEl.addEventListener('change', () => {
      const entry = byIp.get(inputEl.value.trim());
      if (entry && entry.pons.size === 1 && !ponEl.value) {
        ponEl.value = [...entry.pons][0];
      }
    });
  }
}

// Acordeao generico ("sanfonado"): dentro de containerSelector, so um
// <details class="onu-step"> fica aberto por vez (fallback via JS para
// navegadores sem suporte nativo a details[name]).
function bindAccordionExclusive(containerSelector) {
  document.querySelectorAll(`${containerSelector} details.onu-step`).forEach(d => {
    if (d.dataset.accordionBound) return;
    d.dataset.accordionBound = '1';
    d.addEventListener('toggle', () => {
      if (!d.open) return;
      document.querySelectorAll(`${containerSelector} details.onu-step`).forEach(other => {
        if (other !== d) other.open = false;
      });
    });
  });
}

function loadDeployOnu() {
  populateOltIpDatalist('onuOltIp', 'onuOltIpList', 'onuOltPon');
  bindAccordionExclusive('#viewDeployOnu');
  bindOnuStepLockGuards();
  onuUpdateStepsLock();
  ['onuOltIp', 'onuOltPassword'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.dataset.lockWatchBound) {
      el.dataset.lockWatchBound = '1';
      el.addEventListener('input', onuUpdateStepsLock);
    }
  });
  onuUpdateTerminalUI();
  lucide.createIcons();
}

function onuAccordionOpen(stepId) {
  const el = document.getElementById(stepId);
  if (el && !el.open) el.open = true;
}

// Etapas abaixo da conexao ficam travadas ate IP + senha da OLT serem preenchidos.
function onuLockedStepIds() {
  return ['onuStepDiscover', 'onuStepAdd', 'onuStepQuery', 'onuStepDelete'];
}

function onuUpdateStepsLock() {
  const ip = document.getElementById('onuOltIp')?.value.trim();
  const pass = document.getElementById('onuOltPassword')?.value;
  const locked = !ip || !pass;
  onuLockedStepIds().forEach(id => {
    const details = document.getElementById(id);
    if (!details) return;
    details.classList.toggle('onu-step-locked', locked);
    if (locked) details.open = false;
  });
}

function bindOnuStepLockGuards() {
  onuLockedStepIds().forEach(id => {
    const details = document.getElementById(id);
    const summary = details?.querySelector('summary');
    if (!summary || summary.dataset.lockGuardBound) return;
    summary.dataset.lockGuardBound = '1';
    summary.addEventListener('click', (e) => {
      if (details.classList.contains('onu-step-locked')) {
        e.preventDefault();
        showToast('Informe o IP e a senha da OLT primeiro.', true);
      }
    });
  });
}

// Etapa "Autorizar" -- ONT permite mais de uma VLAN, ONU fica com uma so.
function onuServiceRowHtml() {
  return `
    <div class="form-row onu-service-row">
      <div class="form-group">
        <label>Servico</label>
        <select class="onuAddServiceSel">
          <option value="downlink">Downlink (internet)</option>
          <option value="tls">TLS (transparente)</option>
        </select>
      </div>
      <div class="form-group">
        <label>VLAN</label>
        <div style="display:flex;gap:6px;align-items:center">
          <input class="onuAddVlanInput" type="number" placeholder="Ex: 3000" style="flex:1">
          <button type="button" class="icon-button onu-service-row-remove" title="Remover VLAN"><i data-lucide="x"></i></button>
        </div>
      </div>
    </div>`;
}

function onuAddVlanRow() {
  const container = document.getElementById('onuAddServiceRows');
  if (!container) return;
  container.insertAdjacentHTML('beforeend', onuServiceRowHtml());
  lucide.createIcons();
  container.querySelectorAll('.onu-service-row-remove').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => btn.closest('.onu-service-row')?.remove());
  });
}

function onuUpdateTerminalUI() {
  const terminal = document.getElementById('onuAddTerminal')?.value || 'onu';
  const wrap = document.getElementById('onuAddVlanAddWrap');
  if (wrap) wrap.style.display = terminal === 'ont' ? '' : 'none';
  if (terminal !== 'ont') {
    document.querySelectorAll('#onuAddServiceRows .onu-service-row').forEach((row, idx) => {
      if (idx > 0) row.remove();
    });
  }
}

function onuOltPayload() {
  return {
    olt_ip: document.getElementById('onuOltIp')?.value.trim() || '',
    user: document.getElementById('onuOltUser')?.value.trim() || 'admin',
    password: document.getElementById('onuOltPassword')?.value || '',
    pon: document.getElementById('onuOltPon')?.value.trim() || 'all',
  };
}

// PON especifica (1-8) escolhida na conexao, ou 0 se estiver em "Todas".
function onuOltPonNumber(olt) {
  const n = Number(olt.pon);
  return Number.isInteger(n) && n >= 1 && n <= 8 ? n : 0;
}

function onuSetResult(boxId, html, isError = false) {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.innerHTML = html;
  box.classList.toggle('error', !!isError);
}

async function onuDiscover() {
  const olt = onuOltPayload();
  if (!olt.olt_ip) { showToast('Informe o IP da OLT.', true); return; }
  if (!olt.password) { showToast('Informe a senha da OLT.', true); return; }
  onuSetResult('onuDiscoverResult', 'Consultando OLT (pode levar alguns segundos)...');
  const res = await api('/api/olt/discover-onus', { method: 'POST', body: JSON.stringify(olt) });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) {
    onuSetResult('onuDiscoverResult', esc(data?.detail || 'Falha ao consultar a OLT.'), true);
    return;
  }
  const pons = data.pons || {};
  const ponKeys = Object.keys(pons).sort((a, b) => Number(a) - Number(b));
  const allDiscovered = [];
  const freeSummary = [];
  ponKeys.forEach(k => {
    const p = pons[k] || {};
    (p.discovered || []).forEach(d => allDiscovered.push(d));
    freeSummary.push(`PON ${k}: ${(p.free_slots || []).length} livres`);
  });
  if (!allDiscovered.length) {
    onuSetResult('onuDiscoverResult', `Nenhuma ONU nao autorizada encontrada. ${freeSummary.join(' | ')}`);
    return;
  }
  onuSetResult('onuDiscoverResult', allDiscovered.map(d => `
    <div class="deploy-match deploy-onu-pick" data-pon="${esc(d.pon)}" data-serno="${esc(d.serno_id)}" data-serial="${esc(d.serial)}" data-model="${esc(d.model)}" data-vendor="${esc(d.vendor)}" style="cursor:pointer">
      <b>${esc(d.serial)}</b>
      <span>PON ${esc(d.pon)} - ${esc(d.vendor)} ${esc(d.model)}</span>
      <small>descoberta ${esc(d.time_discovered || '')} - clique para selecionar</small>
    </div>
  `).join(''));
  document.querySelectorAll('#onuDiscoverResult .deploy-onu-pick').forEach(el => {
    el.addEventListener('click', () => {
      _onuSelectedDiscovered = {
        pon: Number(el.dataset.pon),
        serno_id: Number(el.dataset.serno),
        serial: el.dataset.serial,
        model: el.dataset.model,
        vendor: el.dataset.vendor,
      };
      const sernoEl = document.getElementById('onuAddSernoId');
      const modelEl = document.getElementById('onuAddModel');
      if (sernoEl) sernoEl.value = el.dataset.serno;
      if (modelEl) modelEl.value = `${el.dataset.vendor} ${el.dataset.model}`;
      showToast(`ONU ${el.dataset.serial} selecionada (PON ${el.dataset.pon}).`);
      onuAccordionOpen('onuStepAdd');
    });
  });
}

async function onuAdd() {
  const olt = onuOltPayload();
  if (!olt.olt_ip || !olt.password) { showToast('Informe IP e senha da OLT.', true); return; }
  const sernoId = Number(document.getElementById('onuAddSernoId')?.value.trim() || '0');
  if (!sernoId) { showToast('Descubra e selecione uma ONU primeiro (ou digite o serno_id).', true); return; }

  let pon = 0;
  let model = '';
  if (_onuSelectedDiscovered && _onuSelectedDiscovered.serno_id === sernoId) {
    pon = _onuSelectedDiscovered.pon;
    model = _onuSelectedDiscovered.model;
  } else {
    pon = onuOltPonNumber(olt);
  }
  if (!pon) { showToast('Escolha uma PON especifica (nao "Todas") na conexao, ou descubra e selecione uma ONU.', true); return; }

  const tagMode = document.getElementById('onuAddTagMode')?.value || 'tagged';
  const terminal = document.getElementById('onuAddTerminal')?.value || 'onu';

  const rows = [...document.querySelectorAll('#onuAddServiceRows .onu-service-row')];
  const services = rows.map(row => ({
    service: row.querySelector('.onuAddServiceSel')?.value || 'downlink',
    vlan: Number(row.querySelector('.onuAddVlanInput')?.value.trim() || '0'),
  })).filter(e => e.vlan > 0);
  if (!services.length) { showToast('Informe pelo menos uma VLAN.', true); return; }

  const payload = {
    olt_ip: olt.olt_ip,
    user: olt.user,
    password: olt.password,
    pon,
    serno_id: sernoId,
    onu_model: model,
    description: document.getElementById('onuAddDescription')?.value.trim() || '',
    service: services[0].service,
    vlan: services[0].vlan,
    services,
    tag_mode: tagMode,
    terminal,
  };
  onuSetResult('onuAddResult', 'Autorizando ONU na OLT (equipamento vivo, aguarde)...');
  const res = await api('/api/olt/add-onu', { method: 'POST', body: JSON.stringify(payload) });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok) {
    onuSetResult('onuAddResult', esc(data?.detail || 'Falha ao autorizar ONU.'), true);
    return;
  }
  if (data.ok === false) {
    onuSetResult('onuAddResult', `Falhou em: <code>${esc(data.failed_at || '-')}</code><br>${esc(data.error || '')}<br>Comandos ja aplicados: ${data.commands_run?.length || 0}`, true);
    showToast('Falha ao autorizar ONU -- confira o detalhe.', true);
    return;
  }
  onuSetResult('onuAddResult', `ONU autorizada na PON ${esc(data.pon)}, posicao ${esc(data.slot)}.`);
  showToast(`ONU autorizada: PON ${data.pon} / posicao ${data.slot}`);
  const targetEl = document.getElementById('onuTargetNum');
  if (targetEl) targetEl.value = data.slot;
  onuAccordionOpen('onuStepQuery');
}

async function onuQuery() {
  const olt = onuOltPayload();
  if (!olt.olt_ip || !olt.password) { showToast('Informe IP e senha da OLT.', true); return; }
  const onuNum = Number(document.getElementById('onuTargetNum')?.value.trim() || '0');
  const serial = document.getElementById('onuQuerySerial')?.value.trim() || '';
  if (!onuNum && !serial) { showToast('Informe o numero da ONU ou o serial.', true); return; }
  const ponNum = onuOltPonNumber(olt);
  if (onuNum && !ponNum) { showToast('Escolha uma PON especifica (nao "Todas") pra consultar por posicao, ou use o serial.', true); return; }

  const payload = {
    olt_ip: olt.olt_ip,
    user: olt.user,
    password: olt.password,
    pon: ponNum,
    onu: onuNum || 0,
    serial,
  };
  onuSetResult('onuQueryResult', 'Consultando sinal e MACs na OLT...');
  const res = await api('/api/olt/onu-signal', { method: 'POST', body: JSON.stringify(payload) });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) {
    onuSetResult('onuQueryResult', esc(data?.detail || data?.error || 'Falha ao consultar a ONU.'), true);
    return;
  }

  const targetEl = document.getElementById('onuTargetNum');
  if (targetEl) targetEl.value = data.onu;

  const macsHtml = (data.macs || []).length
    ? `<ul style="margin:6px 0 0;padding-left:18px">${data.macs.map(m => `<li><code>${esc(m.mac)}</code> - ${esc(m.interface)}</li>`).join('')}</ul>`
    : '<p style="margin:6px 0 0">Nenhum MAC aprendido atras dessa ONU ainda.</p>';

  onuSetResult('onuQueryResult', `
    <div><b>PON ${esc(data.pon)} / ONU ${esc(data.onu)}</b> - ${esc(data.serial)} (${esc(data.model)})</div>
    <div style="margin-top:4px">Status: ${esc(data.oper_status || '-')} / OMCI ${esc(data.omci_status || '-')}</div>
    <div>OLT RX: ${esc(data.olt_rx || '-')} &nbsp; ONU RX: ${esc(data.onu_rx || '-')} &nbsp; Distancia: ${esc(data.distance_km || '-')} km</div>
    <div style="margin-top:6px"><b>MACs aprendidos:</b>${macsHtml}</div>
  `);
}

let _onuDeleteTarget = null; // {olt, pon, onu}

function openOnuDeleteModal() { document.getElementById('modalOnuDelete')?.classList.remove('hidden'); }
function closeOnuDeleteModal() { document.getElementById('modalOnuDelete')?.classList.add('hidden'); }

async function onuDelete() {
  const olt = onuOltPayload();
  if (!olt.olt_ip || !olt.password) { showToast('Informe IP e senha da OLT.', true); return; }
  const ponNum = Number(document.getElementById('onuDeletePon')?.value.trim() || '0');
  if (!ponNum) { showToast('Escolha a PON da ONU a excluir.', true); return; }
  const onuNum = Number(document.getElementById('onuDeleteOnuNum')?.value.trim() || '0');
  if (!onuNum) { showToast('Informe o numero da ONU (posicao) a excluir.', true); return; }

  _onuDeleteTarget = { olt, pon: ponNum, onu: onuNum };
  const panoramaEl = document.getElementById('onuDeletePanorama');
  const confirmBtn = document.getElementById('confirmOnuDelete');
  if (confirmBtn) confirmBtn.disabled = true;
  if (panoramaEl) panoramaEl.innerHTML = 'Consultando dados da ONU na OLT...';
  openOnuDeleteModal();

  const res = await api('/api/olt/onu-signal', { method: 'POST', body: JSON.stringify({ olt_ip: olt.olt_ip, user: olt.user, password: olt.password, pon: ponNum, onu: onuNum }) });
  const data = await res?.json().catch(() => ({}));
  if (confirmBtn) confirmBtn.disabled = false;
  if (!panoramaEl) return;
  if (!res?.ok || data?.ok === false) {
    panoramaEl.innerHTML = `<p>Sem informacoes para essa ONU (PON ${esc(ponNum)} / posicao ${esc(onuNum)}) -- ${esc(data?.detail || data?.error || 'nao respondeu')}.</p>`;
    return;
  }
  const macsHtml = (data.macs || []).length
    ? `<ul style="margin:6px 0 0;padding-left:18px">${data.macs.map(m => `<li><code>${esc(m.mac)}</code> - ${esc(m.interface)}</li>`).join('')}</ul>`
    : '<p style="margin:6px 0 0">Nenhum MAC aprendido atras dessa ONU.</p>';
  panoramaEl.innerHTML = `
    <p>Voce esta prestes a excluir:</p>
    <div style="margin:8px 0;padding:10px 12px;border:1px solid var(--border);border-radius:8px;background:var(--surface-soft)">
      <div><b>PON ${esc(data.pon)} / ONU ${esc(data.onu)}</b> - ${esc(data.serial)} (${esc(data.model)})</div>
      <div style="margin-top:4px">Status: ${esc(data.oper_status || '-')} / OMCI ${esc(data.omci_status || '-')}</div>
      <div style="margin-top:6px"><b>${(data.macs || []).length} MAC(s) que vao perder conexao:</b>${macsHtml}</div>
    </div>
    <p style="color:var(--danger);font-size:13px;margin:0">Isso remove o cadastro e desliga o servico dela AGORA na OLT.</p>
  `;
}

async function onuConfirmDelete() {
  if (!_onuDeleteTarget) { closeOnuDeleteModal(); return; }
  const { olt, pon, onu } = _onuDeleteTarget;
  const panoramaEl = document.getElementById('onuDeletePanorama');
  const confirmBtn = document.getElementById('confirmOnuDelete');
  if (confirmBtn) confirmBtn.disabled = true;
  if (panoramaEl) panoramaEl.insertAdjacentHTML('beforeend', '<p style="margin-top:10px">Excluindo ONU na OLT (equipamento vivo, aguarde)...</p>');

  const res = await api('/api/olt/delete-onu', { method: 'POST', body: JSON.stringify({ olt_ip: olt.olt_ip, user: olt.user, password: olt.password, pon, onu }) });
  const data = await res?.json().catch(() => ({}));
  closeOnuDeleteModal();
  _onuDeleteTarget = null;
  if (!res?.ok || data?.ok === false) {
    onuSetResult('onuDeleteResult', esc(data?.detail || 'Falha ao excluir ONU (confira se a posicao esta correta).'), true);
    return;
  }
  onuSetResult('onuDeleteResult', `ONU excluida da PON ${esc(data.pon)} / posicao ${esc(data.onu)}.`);
  showToast('ONU excluida com sucesso.');
}


async function deployLookupMac() {
  const p = deployPayload();
  if (!p.connector_id) { showToast('Selecione um conector MikroTik.', true); return; }
  if (!p.camera_mac) { showToast('Digite o MAC ou IP da camera.', true); return; }
  deploySetResult('Consultando DHCP, ARP e neighbors do MikroTik...');
  const data = await apiJson(`/api/deployments/lookup?connector_id=${encodeURIComponent(p.connector_id)}&query=${encodeURIComponent(p.camera_mac)}`);
  const matches = Array.isArray(data?.matches) ? data.matches : [];
  if (!matches.length) {
    deploySetResult('Nenhum dispositivo encontrado no conector para esse MAC/IP.', true);
    return;
  }
  const first = matches[0];
  if (first.ip && !document.getElementById('deployCameraIp')?.value) document.getElementById('deployCameraIp').value = first.ip;
  if (first.mac && !document.getElementById('deployCameraMac')?.value) document.getElementById('deployCameraMac').value = first.mac;
  deploySetResult(matches.slice(0, 5).map(m => `
    <div class="deploy-match deploy-cam-pick" data-ip="${esc(m.ip || '')}" data-mac="${esc(m.mac || '')}" style="cursor:pointer">
      <b>${esc(m.ip || '-')}</b>
      <span>${esc(m.mac || '-')}</span>
      <small>${esc(m.source || '-')} ${m.host ? `- ${esc(m.host)}` : ''} - clique para selecionar</small>
    </div>
  `).join(''));
  document.querySelectorAll('#deployLookupResult .deploy-cam-pick').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.ip) document.getElementById('deployCameraIp').value = el.dataset.ip;
      if (el.dataset.mac) document.getElementById('deployCameraMac').value = el.dataset.mac;
      showToast(`Selecionado: ${el.dataset.ip || el.dataset.mac}`);
      deployRenderSummary();
      const userEl = document.getElementById('deployCameraUser');
      const passEl = document.getElementById('deployCameraPassword');
      if (userEl?.value && passEl?.value) {
        deployPullCameraInfo();
      } else {
        const box = document.getElementById('deployPullCameraResult');
        if (box) box.innerHTML = 'IP selecionado. Preencha usuario/senha da camera e clique em "Puxar dados da camera".';
      }
    });
  });
  deployRenderSummary();
}

async function deployPullCameraInfo() {
  const ip = document.getElementById('deployCameraIp')?.value.trim() || '';
  const user = document.getElementById('deployCameraUser')?.value.trim() || '';
  const pass = document.getElementById('deployCameraPassword')?.value || '';
  const box = document.getElementById('deployPullCameraResult');
  if (!ip) { showToast('Informe o IP da camera primeiro.', true); return; }
  if (!user || !pass) { showToast('Informe usuario e senha da camera primeiro.', true); return; }
  if (box) box.innerHTML = 'Conectando na camera e trazendo os dados (pode levar alguns segundos)...';
  const res = await api('/api/rescan-single-ip', {
    method: 'POST',
    body: JSON.stringify({ ip, usuario: user, senha: pass, inventory_mode: 'olt', capture_snapshot: true }),
  });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false || data?.success === false) {
    if (box) box.innerHTML = esc(data?.message || data?.stderr || 'Falha ao conectar na camera. Confira IP/usuario/senha.');
    box?.classList.add('error');
    return;
  }
  box?.classList.remove('error');
  const rows = Array.isArray(data.inventory) ? data.inventory : [];
  const cam = rows.find(r => (r.ip || '').trim() === ip) || null;
  if (!cam) {
    if (box) box.innerHTML = 'Conectou, mas nao consegui identificar os dados da camera na resposta.';
    return;
  }
  const fabEl = document.getElementById('deployCameraManufacturer');
  const modEl = document.getElementById('deployCameraModel');
  if (fabEl && cam.fabricante) fabEl.value = cam.fabricante;
  if (modEl && cam.modelo) modEl.value = cam.modelo;
  if (box) {
    box.innerHTML = `
      <div><b>Camera encontrada:</b> ${esc(cam.fabricante || '-')} ${esc(cam.modelo || '-')}</div>
      <div style="margin-top:4px">IP: ${esc(cam.ip || ip)} ${cam.mac ? `- MAC: ${esc(cam.mac)}` : ''}</div>
      ${cam.snapshot_path ? '<div style="margin-top:4px">Snapshot capturado.</div>' : ''}
    `;
  }
  deployRenderSummary();
}

async function deployCheckIp() {
  const p = deployPayload();
  if (!p.camera_ip) { showToast('Digite o IP da camera.', true); return; }
  const data = await apiJson(`/api/deployments/ip-check?ip=${encodeURIComponent(p.camera_ip)}&connector_id=${encodeURIComponent(p.connector_id)}&site=${encodeURIComponent(p.site)}`);
  if (!data) { showToast('Nao foi possivel checar o IP.', true); return; }
  if (data.in_use) {
    const places = (data.matches || []).map(m => `${m.source || 'inventario'}: ${m.title || m.mac || m.host || '-'}`).join('<br>');
    deploySetResult(`IP ${esc(p.camera_ip)} ja aparece em uso.<br>${places}`, true);
  } else {
    deploySetResult(`IP ${esc(p.camera_ip)} livre no inventario e no ultimo sinal do conector.`);
  }
}

async function deploySaveDraft() {
  const payload = deployPayload();
  const res = await api('/api/deployments', { method: 'POST', body: JSON.stringify(payload) });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) {
    showToast(data?.detail || 'Falha ao salvar rascunho.', true);
    return;
  }
  _deployCurrentId = data.deployment?.id || _deployCurrentId;
  showToast('Rascunho de implantacao salvo.');
  await loadDeployHistory();
  deployRenderSummary();
}

async function deployCommitCamera(e) {
  e?.preventDefault();
  const payload = deployPayload();
  if (!payload.camera_title || !payload.camera_ip) {
    showToast('IP e titulo da camera sao obrigatorios.', true);
    return;
  }
  const res = await api('/api/deployments/commit-camera', { method: 'POST', body: JSON.stringify(payload) });
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) {
    showToast(data?.detail || 'Falha ao registrar camera.', true);
    return;
  }
  _deployCurrentId = data.deployment?.id || _deployCurrentId;
  showToast(`Camera registrada: ${payload.camera_title}`);
  deploySetResult(`Camera registrada no inventario. Chave: ${esc(data.inventory_key || '-')}`);
  await loadDeployHistory();
  deployRenderSummary();
}

function deployClear() {
  _deployCurrentId = '';
  document.getElementById('deployForm')?.reset();
  const conn = deploySelectedConnector();
  const siteEl = document.getElementById('deploySite');
  if (conn && siteEl) siteEl.value = conn.site || conn.client || '';
  deploySetResult('Aguardando consulta no conector.');
  deployRenderConnectorStatus();
  const pullBox = document.getElementById('deployPullCameraResult');
  if (pullBox) {
    pullBox.innerHTML = 'Preencha IP e usuario/senha, depois clique para trazer os dados reais da camera.';
    pullBox.classList.remove('error');
  }
  deployRenderSummary();
}

//  Conectores SaaS 
let _connectors = [];
let _lastCreatedConnectorId = '';
let _lastCreatedConnectorType = '';

function formatDateTimeShort(value) {
  if (!value) return '-';
  try {
    return new Date(value).toLocaleString('pt-BR');
  } catch {
    return value;
  }
}

function connectorHostLabel(host) {
  if (!host || typeof host !== 'object') return '-';
  const name = host.hostname || host.identity || '';
  const model = host.model || '';
  const ips = Array.isArray(host.ips) ? host.ips.filter(Boolean).slice(0, 2).join(', ') : '';
  return [name, model, ips].filter(Boolean).join(' / ') || '-';
}

function connectorInventoryLabel(row) {
  const inv = row?.inventory || {};
  const items = [];
  if (inv.dhcp_leases) items.push(`DHCP ${inv.dhcp_leases}`);
  if (inv.arp_entries) items.push(`ARP ${inv.arp_entries}`);
  if (inv.neighbors) items.push(`Neighbors ${inv.neighbors}`);
  return items.join(' / ');
}

function connectorTypeLabel(type) {
  const t = String(type || 'routeros').toLowerCase();
  if (t === 'routeros') return 'MikroTik';
  return 'Windows';
}

function connectorById(connectorId) {
  return _connectors.find(row => String(row.id || '') === String(connectorId || '')) || null;
}

async function loadConnectors() {
  const data = await apiJson('/api/connectors');
  const rows = data?.connectors || [];
  _connectors = rows;
  const tbody = document.getElementById('connectorsTable');
  const summary = document.getElementById('connectorsSummary');
  if (summary) {
    const online = rows.filter(r => String(r.status).toLowerCase() === 'online').length;
    summary.textContent = `${rows.length} conector(es), ${online} online.`;
  }
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="8">Nenhum conector criado.</td></tr>';
  } else {
    tbody.innerHTML = rows.map(row => `
      <tr>
        <td class="connector-name-cell" title="${esc(row.name || row.id)}"><strong>${esc(row.name || row.id)}</strong><br><span class="monospace text-muted" title="${esc(row.id || '')}">${esc(row.id || '')}</span></td>
        <td class="connector-text-cell" title="${esc(row.client || '-')}">${esc(row.client || '-')}</td>
        <td class="connector-text-cell" title="${esc(row.site || '-')}">${esc(row.site || '-')}</td>
        <td class="connector-status-cell">${statusBadge(row.status)}</td>
        <td class="connector-host-cell" title="${esc(`${connectorHostLabel(row.host)} ${connectorInventoryLabel(row) || ''}`.trim())}">${esc(connectorHostLabel(row.host))}${connectorInventoryLabel(row) ? `<br><span class="text-muted">${esc(connectorInventoryLabel(row))}</span>` : ''}</td>
        <td class="connector-ip-cell monospace" title="${esc(row.remote_ip || '-')}">${esc(row.remote_ip || '-')}</td>
        <td class="connector-date-cell" title="${esc(formatDateTimeShort(row.last_seen))}">${esc(formatDateTimeShort(row.last_seen))}</td>
        <td class="connector-actions-cell">
          <div class="connector-actions-wrap">
            <button class="connector-row-action" data-conn-download="${esc(row.id)}" title="Baixar script"><i data-lucide="download"></i></button>
            <button class="connector-row-action" data-conn-vpn="${esc(row.id)}" title="VPN"><i data-lucide="shield"></i></button>
            <button class="connector-row-action danger" data-conn-delete="${esc(row.id)}" title="Apagar"><i data-lucide="trash-2"></i></button>
          </div>
        </td>
      </tr>`).join('');
  }
  const sel = document.getElementById('connJobConnector');
  if (sel) {
    sel.innerHTML = rows.map(row => `<option value="${esc(row.id)}">${esc(row.name || row.id)} - ${esc(row.site || '')}</option>`).join('');
  }
  lucide.createIcons();
}

function downloadConnectorAgent(connectorId) {
  if (!connectorId) return;
  const row = connectorById(connectorId);
  const fallbackType = String(connectorId) === String(_lastCreatedConnectorId) ? _lastCreatedConnectorType : '';
  const isRouter = String(row?.type || fallbackType).toLowerCase() === 'routeros';
  const publicUrl = document.getElementById('connPublicUrl')?.value.trim() || 'http://201.182.184.80:18080';
  const params = new URLSearchParams();
  if (_token) params.set('auth_token', _token);
  if (publicUrl) params.set('base_url', publicUrl.replace(/\/+$/, ''));
  const endpoint = isRouter ? 'routeros-script' : 'agent-script';
  const query = params.toString() ? `?${params.toString()}` : '';
  window.open(`${API_BASE}/api/connectors/${encodeURIComponent(connectorId)}/${endpoint}${query}`, '_blank');
}

async function downloadConnectorVpn(connectorId) {
  if (!connectorId) return;
  const publicUrl = document.getElementById('connPublicUrl')?.value.trim() || 'http://201.182.184.80:18080';
  const endpointDefault = `${publicUrl.replace(/^https?:\/\//, '').replace(/:\d+$/, '').replace(/\/.*$/, '')}:51820`;
  const endpoint = prompt('Endpoint WireGuard publico:', endpointDefault || '201.182.184.80:51820');
  if (endpoint === null) return;
  const clientLans = prompt('Redes LAN do cliente (CIDR, separadas por virgula):', '192.168.20.0/24');
  if (clientLans === null) return;
  const res = await api(`/api/connectors/${encodeURIComponent(connectorId)}/wireguard`, {
    method: 'POST',
    body: JSON.stringify({ endpoint, client_lans: clientLans }),
  });
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok || body?.ok === false) {
    showToast(body?.detail || 'Erro ao preparar VPN.', true);
    return;
  }
  const params = new URLSearchParams();
  if (_token) params.set('auth_token', _token);
  const query = params.toString() ? `?${params.toString()}` : '';
  showToast('VPN preparada. Baixando script RouterOS.');
  window.open(`${API_BASE}/api/connectors/${encodeURIComponent(connectorId)}/wireguard-routeros-script${query}`, '_blank');
  await loadConnectors();
}

async function createConnectorFromForm() {
  const payload = {
    type: document.getElementById('connType')?.value || 'routeros',
    name: document.getElementById('connName')?.value.trim() || '',
    client: document.getElementById('connClient')?.value.trim() || '',
    site: document.getElementById('connSite')?.value.trim() || '',
    public_base_url: document.getElementById('connPublicUrl')?.value.trim() || '',
  };
  const btn = document.getElementById('btnCreateConnector');
  if (btn) { btn.disabled = true; btn.textContent = 'Criando'; }
  const res = await api('/api/connectors', { method: 'POST', body: JSON.stringify(payload) });
  const body = await res?.json().catch(() => ({}));
  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="plus"></i> Criar conector';
    lucide.createIcons();
  }
  if (!res?.ok || body?.ok === false) {
    showToast(body?.detail || 'Erro ao criar conector.', true);
    return;
  }
  const conn = body.connector || {};
  _lastCreatedConnectorId = conn.id || '';
  _lastCreatedConnectorType = conn.type || payload.type || '';
  document.getElementById('connCreatedBox')?.classList.remove('hidden');
  const txt = document.getElementById('connCreatedText');
  const typeText = 'Baixe o script e cole no terminal do MikroTik do cliente.';
  if (txt) txt.textContent = `${conn.name || conn.id} criado. ${typeText}`;
  ['connName', 'connClient', 'connSite'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  showToast('Conector criado.');
  await loadConnectors();
}

async function deleteConnector(connectorId) {
  if (!connectorId) return;
  if (!await showConfirm({ title: 'Apagar conector', msg: 'Apagar este conector e seus jobs?', label: 'Apagar' })) return;
  const res = await api(`/api/connectors/${encodeURIComponent(connectorId)}`, { method: 'DELETE' });
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok || body?.ok === false) {
    showToast(body?.detail || 'Erro ao apagar conector.', true);
    return;
  }
  showToast('Conector apagado.');
  await loadConnectors();
}

async function sendConnectorPingJob() {
  const connectorId = document.getElementById('connJobConnector')?.value || '';
  const raw = document.getElementById('connJobTargets')?.value.trim() || '';
  const targets = raw.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
  if (!connectorId) { showToast('Crie ou selecione um conector.', true); return; }
  if (!targets.length) { showToast('Informe ao menos um IP ou host.', true); return; }
  const res = await api('/api/connectors/jobs', {
    method: 'POST',
    body: JSON.stringify({ connector_id: connectorId, type: 'ping_many', payload: { targets } }),
  });
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok || body?.ok === false) {
    showToast(body?.detail || 'Erro ao criar job.', true);
    return;
  }
  showToast('Job enviado. O conector executa no proximo ciclo.');
  await loadConnectorJobs(connectorId);
}

async function sendConnectorLanInventoryJob() {
  const connectorId = document.getElementById('connJobConnector')?.value || '';
  if (!connectorId) { showToast('Crie ou selecione um conector.', true); return; }
  const res = await api('/api/connectors/jobs', {
    method: 'POST',
    body: JSON.stringify({ connector_id: connectorId, type: 'lan_inventory', payload: {} }),
  });
  const body = await res?.json().catch(() => ({}));
  if (!res?.ok || body?.ok === false) {
    showToast(body?.detail || 'Erro ao criar job.', true);
    return;
  }
  showToast('Coleta LAN enviada. O MikroTik executa no proximo ciclo.');
  await loadConnectorJobs(connectorId);
}

async function loadConnectorJobs(connectorId) {
  const log = document.getElementById('connectorJobsLog');
  if (!log || !connectorId) return;
  const data = await apiJson(`/api/connectors/${encodeURIComponent(connectorId)}/jobs`);
  const jobs = data?.jobs || [];
  if (!jobs.length) {
    log.textContent = 'Nenhum job para este conector.';
    return;
  }
  log.innerHTML = jobs.slice(0, 12).map(job => {
    const items = job?.result?.items || job?.result?.result?.items || [];
    const routerosPing = job?.result?.routeros_ping || job?.result?.result?.routeros_ping || '';
    const inventory = job?.result?.inventory || job?.result?.result?.inventory || null;
    const inventoryText = inventory
      ? [
          `DHCP: ${inventory.dhcp_leases ?? 0}`,
          `ARP: ${inventory.arp_entries ?? 0}`,
          `Vizinhos: ${inventory.neighbors ?? 0}`,
        ].join('<br>')
      : '';
    let resultText = '';
    if (routerosPing) {
      resultText = routerosPing.split(/[;,]/).filter(Boolean).map(item => {
          const separator = item.includes('=') ? '=' : ':';
          const [target, ok] = item.split(separator);
          const normalized = String(ok || '').toLowerCase();
          return `${normalized === 'true' || normalized === '1' ? 'OK' : 'FAIL'} ${esc(target || item)}`;
        }).join('<br>');
    } else if (Array.isArray(items) && items.length) {
      resultText = items.map(item => `${item.online ? 'OK' : 'FAIL'} ${item.target} ${item.rtt_ms ? item.rtt_ms + 'ms' : ''}`).join('<br>');
    } else if (inventoryText) {
      resultText = inventoryText;
    } else {
      resultText = esc(job.error || '');
    }
    return `<div class="connector-job-item">
      <div><strong>${esc(job.type)}</strong> <span class="badge ${job.status === 'done' ? 'badge-green' : job.status === 'failed' ? 'badge-red' : 'badge-amber'}">${esc(job.status)}</span></div>
      <div class="text-muted">${esc(formatDateTimeShort(job.created_at))}</div>
      <div class="monospace">${resultText || 'Aguardando MikroTik.'}</div>
    </div>`;
  }).join('');
}

//  Modal ImgBB settings 
async function openImgbbModal() {
  const data = await apiJson('/api/settings/imgbb');
  document.getElementById('imgbbApiKey').value = data?.api_key || data?.key || '';
  document.getElementById('imgbbTestResult').style.display = 'none';
  document.getElementById('imgbbErro').hidden = true;
  document.getElementById('modalImgbb').classList.remove('hidden');
  lucide.createIcons();
}

//  Modal editar cameras (multiplas) 
function openEditCamModal(cams, opts = {}) {
  const count = cams.length;
  document.getElementById('modalEditCamTitle').textContent =
    count === 1 ? `Editar  ${cams[0].ip}` : `Editar ${count} cameras`;
  document.getElementById('editCamErro').hidden = true;
  const applyDevice = document.getElementById('editCamApplyDevice');
  const deviceUser = document.getElementById('editCamDeviceUser');
  const devicePass = document.getElementById('editCamDevicePass');
  if (applyDevice) applyDevice.checked = !!opts.renameDevice;
  if (deviceUser) deviceUser.value = deviceUser.value || 'admin';
  if (devicePass) devicePass.value = '';
  if (devicePass && opts.renameDevice) setTimeout(() => devicePass.focus(), 80);

  const s = 'width:100%;padding:4px 6px;border:1px solid var(--border);border-radius:5px;font-size:12px;font-family:inherit;background:var(--surface);color:var(--text);outline:none;box-sizing:border-box';

  document.getElementById('editCamTableBody').innerHTML = cams.map(c => `
    <tr data-key="${esc(_camKey(c))}" data-connector-id="${esc(c.remote_connector_id || c.connector_id || '')}" data-site="${esc(c.site || c.site_name || c.local || '')}" data-remote="${c.remote ? '1' : ''}">
      <td class="monospace" style="font-size:11px;color:var(--muted);white-space:nowrap">${esc(c.ip)}</td>
      <td><input data-ip="${esc(c.ip)}" data-field="titulo"     style="${s}" value="${esc(c.titulo    || '')}" placeholder="Titulo"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="fabricante" style="${s}" value="${esc(c.fabricante|| '')}" placeholder="Fabricante"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="model"      style="${s}" value="${esc(c.modelo || c.model || '')}" placeholder="Modelo"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="local"      style="${s}" value="${esc(c.local     || '')}" placeholder="Local"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="mac"        style="${s};font-family:monospace" value="${esc(c.mac       || '')}" placeholder="MAC"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="pon"        style="${s};text-align:center" value="${esc(c.pon       || '')}" placeholder=""></td>
      <td><input data-ip="${esc(c.ip)}" data-field="onu_id"     style="${s};text-align:center" value="${esc(c.onu_id    || '')}" placeholder=""></td>
      <td><input data-ip="${esc(c.ip)}" data-field="onu_name"   style="${s}" value="${esc(c.onu_name  || '')}" placeholder="gpon x onu y"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="onu_serial" style="${s};font-family:monospace" value="${esc(c.onu_serial|| '')}" placeholder="ONU Serial"></td>
    </tr>`).join('');

  document.getElementById('modalEditCam').classList.remove('hidden');
  lucide.createIcons();
}

function closeEditCamModal() {
  document.getElementById('modalEditCam').classList.add('hidden');
}

function applyCamPayloadsLocally(payloads) {
  ['basico', 'olt', 'switch'].forEach(mode => {
    if (!_invCam[mode]?.length) return;
    _invCam[mode] = _invCam[mode].map(cam => {
      const patch = payloads.find(p => _camKey(p) === _camKey(cam) || (!p.remote_connector_id && !p.connector_id && p.ip === cam.ip));
      return patch ? { ...cam, ...patch } : cam;
    });
    _camSessionSave(mode, _invCam[mode]);
  });
}

function applyCamStatusesLocally(statusByIp) {
  const patches = Object.entries(statusByIp || {})
    .filter(([ip, status]) => ip && status)
    .map(([ip, status]) => ({ ip, status }));
  if (patches.length) applyCamPayloadsLocally(patches);
  ['nvr', 'dvr'].forEach(type => {
    const store = type === 'dvr' ? _invDvr : _invNvr;
    ['basico', 'olt', 'switch'].forEach(mode => {
      if (!store?.[mode]?.length) return;
      store[mode] = store[mode].map(row => {
        const ip = row.camera_ip || row.ip_camera || row.host || '';
        const status = statusByIp?.[ip];
        return status ? { ...row, status } : row;
      });
      _recSessionSave(type, mode, store[mode]);
    });
  });
}

async function saveEditCam() {
  const rows = document.querySelectorAll('#editCamTableBody tr');
  const payloads = [];

  rows.forEach(tr => {
    const inputs = tr.querySelectorAll('input[data-ip]');
    if (!inputs.length) return;
    const ip = inputs[0].dataset.ip;
    const payload = {
      ip,
      remote_connector_id: tr.dataset.connectorId || '',
      connector_id: tr.dataset.connectorId || '',
      site: tr.dataset.site || '',
      site_name: tr.dataset.site || '',
      remote: tr.dataset.remote === '1',
    };
    inputs.forEach(inp => { payload[inp.dataset.field] = inp.value.trim(); });
    payloads.push(payload);
  });

  const btn = document.getElementById('saveEditCam');
  btn.disabled = true;
  btn.textContent = 'Salvando';

  const mode = _invOltView || 'olt';
  const res = await api(`/api/cameras/save?mode=${encodeURIComponent(mode)}`, {
    method: 'POST',
    body: JSON.stringify({ cameras: payloads }),
  });

  btn.disabled = false;
  btn.innerHTML = '<i data-lucide="check"></i> Salvar tudo';
  lucide.createIcons();

  const body = await res?.json().catch(() => ({}));
  if (!res?.ok || body?.ok === false) {
    const el = document.getElementById('editCamErro');
    const firstErr = { body };
    const detail = firstErr?.body?.detail || firstErr?.body?.error || 'linha nao encontrada no inventario atual';
    el.textContent = `${payloads.length} camera(s) nao foram salvas: ${detail}.`;
    el.hidden = false;
    return;
  }

  const shouldRenameDevice = !!document.getElementById('editCamApplyDevice')?.checked;
  if (shouldRenameDevice) {
    const user = document.getElementById('editCamDeviceUser')?.value.trim() || 'admin';
    const pass = document.getElementById('editCamDevicePass')?.value || '';
    const el = document.getElementById('editCamErro');
    if (!pass) {
      el.textContent = 'Informe a senha para renomear no equipamento.';
      el.hidden = false;
      return;
    }
    const renameRes = await api('/api/maintenance/batch/rename', {
      method: 'POST',
      body: JSON.stringify({
        user,
        pass,
        targets: payloads.map(p => ({ ip: p.ip, title: p.titulo || p.title || '', channel: 1 })),
      }),
    });
    const renameBody = await renameRes?.json().catch(() => ({}));
    if (!renameRes?.ok || renameBody?.ok === false) {
      const failed = (renameBody?.results || []).filter(r => !r.ok);
      const first = failed[0] || {};
      el.textContent = renameBody?.error || first.error || 'Inventario salvo, mas o equipamento nao aceitou a renomeacao.';
      el.hidden = false;
      return;
    }
    showToast(`${payloads.length} camera(s) salva(s) e renomeada(s) no equipamento!`);
  } else {
    showToast(`${payloads.length} camera(s) salva(s)!`);
  }
  closeEditCamModal();
  applyCamPayloadsLocally(payloads);
  updateCamTabs();
  populateCamSiteFilter();
  applyInvOltFilters();
}

//  Varredura WebSocket 
function openScanModal() {
  document.getElementById('scanLog').textContent = 'Aguardando inicio';
  document.getElementById('modalScan').classList.remove('hidden');
}

function closeScanModal() {
  document.getElementById('modalScan').classList.add('hidden');
  if (_scanWs) { _scanWs.close(); _scanWs = null; }
}

function resetScanForm() {
  const ids = ['scanAlvo', 'scanSenha', 'scanLocal'];
  ids.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  const user = document.getElementById('scanUsuario');
  if (user) user.value = 'admin';
  const mode = document.getElementById('scanMode');
  if (mode) mode.value = 'olt';
  const checks = {
    scanDiscover: true,
    scanOltEnrich: true,
    scanSnapshot: false,
    scanImgbb: false,
    scanAppend: false,
    scanNat: false,
  };
  Object.entries(checks).forEach(([id, checked]) => {
    const el = document.getElementById(id);
    if (el) el.checked = checked;
  });
}

function _scanPayloadBase() {
  const alvo    = document.getElementById('scanAlvo').value.trim();
  const usuario = document.getElementById('scanUsuario').value.trim() || 'admin';
  const senha   = document.getElementById('scanSenha').value;
  const selectedSite = document.getElementById('filterSiteOlt')?.value || '';
  const local   = document.getElementById('scanLocal').value.trim() || selectedSite;
  if (!alvo) { showToast('Informe o alvo (IP, range ou CIDR)', true); return null; }
  return {
    alvo, usuario, senha,
    append_inventory: document.getElementById('scanAppend').checked,
    nat_mode:         document.getElementById('scanNat').checked,
    inventory_mode:   document.getElementById('scanMode').value,
    ...(local && { set_local: true, local }),
    token: _token,
  };
}

function _runWsScan(payload) {
  const log = document.getElementById('scanLog');
  log.innerHTML = '';
  appendLog(log, ` ${payload.alvo}`, 'info');
  let completed = false;
  const requestedMode = payload.inventory_mode || document.getElementById('scanMode')?.value || 'basico';

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  if (_scanWs) _scanWs.close();
  _scanWs = new WebSocket(`${wsProto}://${location.host}/ws/scan`);

  _scanWs.onopen  = () => _scanWs.send(JSON.stringify(payload));
  _scanWs.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'done' || msg.type === 'inventory_updated') {
        completed = true;
        appendLog(log, ' ' + (msg.message || 'Concluido'), 'ok');
        appendLog(log, ' Varredura concluida. Campos limpos.', 'ok');
        resetScanForm();
        showToast('Varredura concluida.');
        if (_currentView === 'inv-nvr') {
          loadInvNvr();
        } else if (_currentView === 'inv-dvr') {
          loadInvDvr();
        } else {
          const scanMode = requestedMode;
          (async () => {
            await _loadCamForMode(scanMode);
            if (scanMode === 'basico') {
              await Promise.allSettled([
                _loadCamForMode('olt'),
                _loadCamForMode('switch'),
              ]);
            }
            updateCamTabs();
            if (!(_invCam[_invOltView] || []).length) setInvOltView(scanMode);
            populateCamSiteFilter();
            applyInvOltFilters();
          })();
        }
      } else if (msg.type === 'error') {
        appendLog(log, ' ' + (msg.message || 'Erro'), 'err');
      } else {
        appendLog(log, msg.message || JSON.stringify(msg), 'info');
      }
    } catch { appendLog(log, e.data, 'info'); }
  };
  _scanWs.onerror = () => appendLog(log, 'Erro WebSocket', 'err');
  _scanWs.onclose = () => {
    appendLog(log, completed ? ' Concluido ' : ' Encerrado ', completed ? 'ok' : 'info');
  };
}

function startScan() {
  const base = _scanPayloadBase();
  if (!base) return;
  _runWsScan({
    ...base,
    snapshot:   document.getElementById('scanSnapshot')?.checked  || false,
    imgbb:      document.getElementById('scanImgbb')?.checked     || false,
    olt_enrich: document.getElementById('scanOltEnrich')?.checked || false,
  });
}

function appendLog(el, msg, cls = '') {
  el.innerHTML += `<span class="log-${cls}">${esc(msg)}</span>\n`;
  el.scrollTop = el.scrollHeight;
}

//  Download autenticado 
async function downloadWithAuth(path, filename) {
  showToast('Preparando download');
  const res = await api(path);
  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({}));
    showToast(err?.detail || 'Arquivo nao encontrado', true);
    return;
  }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

//  Utilidades 
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function statusBadge(status) {
  if (!status) return '<span class="badge badge-gray"></span>';
  const s = String(status).toLowerCase();
  if (s === 'ok' || s === 'online' || s === 'acessivel') return '<span class="badge badge-green">Online</span>';
  if (s === 'fail' || s === 'offline' || s === 'erro') return '<span class="badge badge-red">Offline</span>';
  if (s === 'warn' || s === 'warning') return '<span class="badge badge-amber">Atencao</span>';
  return `<span class="badge badge-gray">${esc(status)}</span>`;
}

function pingBadge(ms) {
  if (ms == null) return '<span class="text-muted"></span>';
  const color = ms < 50 ? 'badge-green' : ms < 200 ? 'badge-amber' : 'badge-red';
  return `<span class="badge ${color}">${ms}ms</span>`;
}

function openCamera(ip) {
  window.open(`http://${ip}`, '_blank');
}

//  Filtros inline 
function filterTable(inputId, tableBodyId) {
  const q = document.getElementById(inputId)?.value.toLowerCase() || '';
  document.querySelectorAll(`#${tableBodyId} tr`).forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

//  Nav groups (accordion) 
function initNavGroups() {
  document.querySelectorAll('.nav-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.nav-group');
      group.classList.toggle('open');
    });
  });
}

//  Eventos 
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  initNavGroups();

  // Dashboard drawer
  document.getElementById('dashDrawerClose')?.addEventListener('click', closeDashDrawer);
  document.getElementById('dashDrawerOverlay')?.addEventListener('click', closeDashDrawer);
  document.getElementById('closeMapLayerDetails')?.addEventListener('click', closeMapLayerDetails);
  document.getElementById('cancelMapLayerDetails')?.addEventListener('click', closeMapLayerDetails);

  // Login
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Entrando';
    const user = document.getElementById('loginUser').value;
    const pass = document.getElementById('loginPassword').value;
    const result = await login(user, pass);
    if (result.ok) {
      showApp();
    } else {
      const err = document.getElementById('loginError');
      err.textContent = result.msg;
      err.hidden = false;
    }
    btn.disabled = false;
    btn.textContent = 'Entrar';
  });

  // Navegacao
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.view));
  });

  // Logout
  document.getElementById('logoutBtn').addEventListener('click', logout);
  document.getElementById('logoutBtnTop').addEventListener('click', logout);

  // Profile dropdown
  document.getElementById('profileMenu').addEventListener('click', (e) => {
    e.stopPropagation();
    document.getElementById('profileDropdown').classList.toggle('open');
  });
  document.addEventListener('click', () => {
    document.getElementById('profileDropdown').classList.remove('open');
  });

  // Mobile menu
  document.getElementById('menuBtn').addEventListener('click', openSidebar);
  document.getElementById('mobileBackdrop').addEventListener('click', closeSidebar);

  // Varredura
  document.getElementById('btnScan').addEventListener('click', openScanModal);
  document.getElementById('closeScanModal').addEventListener('click', closeScanModal);
  document.getElementById('cancelScan').addEventListener('click', closeScanModal);
  document.getElementById('startScan').addEventListener('click', startScan);

  // Refresh topbar
  document.getElementById('btnRefreshTopbar').addEventListener('click', async () => {
    if (_currentView === 'dashboard') {
      await refreshDashboardLiveCameraStatus();
      return;
    }
    if (_currentView === 'inv-olt') _camSessionClear();
    if (_currentView === 'inv-nvr') _nvrSessionClear();
    loadView(_currentView);
  });

  // Conectores SaaS
  document.getElementById('btnConnectorRefresh')?.addEventListener('click', loadConnectors);
  document.getElementById('btnCreateConnector')?.addEventListener('click', createConnectorFromForm);
  document.getElementById('btnDownloadCreatedAgent')?.addEventListener('click', () => downloadConnectorAgent(_lastCreatedConnectorId));
  document.getElementById('btnSendPingJob')?.addEventListener('click', sendConnectorPingJob);
  document.getElementById('btnSendLanInventoryJob')?.addEventListener('click', sendConnectorLanInventoryJob);
  document.getElementById('connJobConnector')?.addEventListener('change', (e) => loadConnectorJobs(e.target.value));
  document.getElementById('connectorsTable')?.addEventListener('click', (e) => {
    const download = e.target.closest('[data-conn-download]');
    const vpn = e.target.closest('[data-conn-vpn]');
    const remove = e.target.closest('[data-conn-delete]');
    if (download) downloadConnectorAgent(download.dataset.connDownload);
    if (vpn) downloadConnectorVpn(vpn.dataset.connVpn);
    if (remove) deleteConnector(remove.dataset.connDelete);
  });

  // Ferramentas de rede
  document.getElementById('netToolForm')?.addEventListener('submit', runNetTool);
  document.getElementById('netToolOrigin')?.addEventListener('change', updateNetToolFormState);
  document.getElementById('netToolTest')?.addEventListener('change', updateNetToolFormState);
  document.getElementById('btnClearNetToolLog')?.addEventListener('click', () => netToolSetLog('Nenhum teste executado ainda.', 'Aguardando teste.'));

  // Implantacao - ONU (pagina dedicada)
  document.getElementById('btnOnuDiscover')?.addEventListener('click', onuDiscover);
  document.getElementById('btnOnuAdd')?.addEventListener('click', onuAdd);
  document.getElementById('onuAddTerminal')?.addEventListener('change', onuUpdateTerminalUI);
  document.getElementById('btnOnuAddVlanRow')?.addEventListener('click', onuAddVlanRow);
  document.getElementById('btnOnuQuery')?.addEventListener('click', onuQuery);
  document.getElementById('btnOnuDelete')?.addEventListener('click', onuDelete);
  document.getElementById('confirmOnuDelete')?.addEventListener('click', onuConfirmDelete);
  document.getElementById('cancelOnuDelete')?.addEventListener('click', closeOnuDeleteModal);
  document.getElementById('closeOnuDeleteModalBtn')?.addEventListener('click', closeOnuDeleteModal);

  // Implantacao
  document.getElementById('btnDeployClear')?.addEventListener('click', deployClear);
  document.getElementById('deployForm')?.addEventListener('submit', deployCommitCamera);
  document.getElementById('btnDeploySave')?.addEventListener('click', deploySaveDraft);
  document.getElementById('btnDeployLookupMac')?.addEventListener('click', deployLookupMac);
  document.getElementById('btnDeployCheckIp')?.addEventListener('click', deployCheckIp);
  document.getElementById('btnDeployPullCamera')?.addEventListener('click', deployPullCameraInfo);
  document.getElementById('deployConnector')?.addEventListener('change', () => {
    const conn = deploySelectedConnector();
    const siteEl = document.getElementById('deploySite');
    if (conn && siteEl && !siteEl.value) siteEl.value = conn.site || conn.client || '';
    deployRenderConnectorStatus();
    deployRenderSummary();
  });
  document.getElementById('btnDeployTestConnector')?.addEventListener('click', deployTestConnector);
  document.getElementById('deployCameraTitle')?.addEventListener('input', () => {
    const recTitle = document.getElementById('deployRecorderTitle');
    if (recTitle && !recTitle.value) recTitle.value = document.getElementById('deployCameraTitle')?.value || '';
    deployRenderSummary();
  });
  document.getElementById('deployForm')?.addEventListener('input', deployRenderSummary);
  document.getElementById('deployForm')?.addEventListener('change', deployRenderSummary);

  // ImgBB settings
  document.getElementById('btnImgbbSettings')?.addEventListener('click', openImgbbModal);
  document.getElementById('btnNvrImgbbSettings')?.addEventListener('click', openImgbbModal);
  document.getElementById('closeImgbbModal')?.addEventListener('click', () => document.getElementById('modalImgbb').classList.add('hidden'));
  document.getElementById('cancelImgbbModal')?.addEventListener('click', () => document.getElementById('modalImgbb').classList.add('hidden'));

  document.getElementById('btnTestImgbb')?.addEventListener('click', async () => {
    const key = document.getElementById('imgbbApiKey').value.trim();
    if (!key) { showToast('Informe a API key', true); return; }
    const res = await api('/api/settings/imgbb/test', { method: 'POST', body: JSON.stringify({ api_key: key }) });
    const result = document.getElementById('imgbbTestResult');
    result.style.display = 'block';
    if (res?.ok) {
      result.style.background = 'var(--primary-soft)';
      result.style.color = 'var(--primary)';
      result.textContent = ' API key valida! Conexao com ImgBB funcionando.';
    } else {
      const err = await res?.json().catch(() => ({}));
      result.style.background = 'var(--danger-soft)';
      result.style.color = 'var(--danger)';
      result.textContent = ' ' + (err?.detail || 'API key invalida ou erro de conexao.');
    }
  });

  document.getElementById('saveImgbbModal')?.addEventListener('click', async () => {
    const key = document.getElementById('imgbbApiKey').value.trim();
    if (!key) { showToast('Informe a API key', true); return; }
    const res = await api('/api/settings/imgbb', { method: 'POST', body: JSON.stringify({ api_key: key }) });
    if (!res?.ok) {
      const err = await res?.json().catch(() => ({}));
      const el = document.getElementById('imgbbErro');
      el.textContent = err?.detail || 'Erro ao salvar.'; el.hidden = false; return;
    }
    document.getElementById('modalImgbb').classList.add('hidden');
    showToast('API key ImgBB salva!');
  });

  // Botoes individuais de tarefa no modal de scan
  document.querySelectorAll('.scan-task-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const base = _scanPayloadBase();
      if (!base) return;
      const task = btn.dataset.task;
      const taskMap = {
        discover:   { },
        olt_enrich: { olt_enrich: true },
        snapshot:   { snapshot: true },
        imgbb:      { imgbb: true },
        ia:         { ia: true },
      };
      _runWsScan({ ...base, ...taskMap[task] });
    });
  });

  // Tabs de visao do inventario OLT
  document.querySelectorAll('.inv-view-tab').forEach(btn => {
    btn.addEventListener('click', () => setInvOltView(btn.dataset.view));
  });

  // Filtros inventario OLT
  document.getElementById('searchInvOlt')?.addEventListener('input', applyInvOltFilters);
  document.getElementById('filterStatusOlt')?.addEventListener('change', applyInvOltFilters);
  document.getElementById('filterSiteOlt')?.addEventListener('change', applyInvOltFilters);
  document.getElementById('btnOltClearFilter')?.addEventListener('click', () => {
    document.getElementById('searchInvOlt').value = '';
    document.getElementById('filterStatusOlt').value = '';
    document.getElementById('filterSiteOlt').value = '';
    applyInvOltFilters();
  });

  // Painel camera
  document.getElementById('btnCloseCamPanel')?.addEventListener('click', closeCamPanel);
  document.getElementById('camPanelBackdrop')?.addEventListener('click', closeCamPanel);
  document.getElementById('cpBtnAtualizar')?.addEventListener('click', () => camAction('atualizar'));
  document.getElementById('cpBtnRenomear')?.addEventListener('click', () => camAction('renomear'));
  document.getElementById('cpBtnTrocarIp')?.addEventListener('click', () => camAction('trocar-ip'));
  document.getElementById('cpBtnTrocarSenha')?.addEventListener('click', () => camAction('trocar-senha'));
  document.getElementById('cpBtnDataHora')?.addEventListener('click', () => camAction('data-hora'));
  document.getElementById('cpBtnReboot')?.addEventListener('click', () => camAction('reboot'));
  document.getElementById('cpBtnWeb')?.addEventListener('click', () => camAction('web'));
  document.getElementById('cpBtnMapa')?.addEventListener('click', () => focusCameraOnMap(_invOltActive));
  document.getElementById('cpBtnPing')?.addEventListener('click', startPing);
  document.getElementById('closeCamAuthAction')?.addEventListener('click', closeCamAuthAction);
  document.getElementById('cancelCamAuthAction')?.addEventListener('click', closeCamAuthAction);
  document.getElementById('confirmCamAuthAction')?.addEventListener('click', runCamAuthAction);
  document.getElementById('camAuthPass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCamAuthAction();
  });
  document.getElementById('pingTermStop')?.addEventListener('click', () => {
    stopPing();
    pingLine(' parado ', 'info');
  });
  document.getElementById('pingTermRestart')?.addEventListener('click', () => {
    pingLine(' reiniciando ', 'info');
    runPing();
  });
  document.getElementById('pingTermClear')?.addEventListener('click', () => {
    document.getElementById('pingTermBody').innerHTML = '';
    document.getElementById('pingTermStats').textContent = '';
    _pingCount = 0; _pingOk = 0; _pingFail = 0;
  });
  document.getElementById('pingTermClose')?.addEventListener('click', closePingTerminal);
  document.getElementById('cpBtnLimpar')?.addEventListener('click', () => camAction('limpar'));

  // Rodape inventario OLT
  document.getElementById('btnOltBackup')?.addEventListener('click', () => window.open(`${API_BASE}/api/backup/export`, '_blank'));
  document.getElementById('btnOltPdf')?.addEventListener('click', () => window.open(`${API_BASE}/api/inventory/report.pdf`, '_blank'));
  document.getElementById('btnOltImgbb')?.addEventListener('click', () => {
    const checked = [...document.querySelectorAll('.chk-olt:checked')];
    const ips = checked.map(c => c.value);
    const keys = checked.map(c => c.dataset.key || '').filter(Boolean);
    const allCams = ips.length === 0
      ? _invOltAll_get()
      : _invOltAll_get().filter(c => keys.includes(_camKey(c)) || ips.includes(c.ip));

    const list = document.getElementById('imgbbUploadList');
    const desc = document.getElementById('imgbbUploadDesc');
    desc.textContent = ips.length
      ? `${ips.length} camera(s) selecionada(s) serao enviadas ao ImgBB.`
      : `Nenhuma camera selecionada. Serao enviadas TODAS (${_invOltAll_get().length} cameras).`;

    list.innerHTML = allCams.slice(0, 20).map(c => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--surface-soft)">
        <span class="monospace">${esc(c.ip)}</span>
        <span style="color:var(--muted)">${esc(c.titulo || '')}</span>
        <span>${(c.imgbb_url || isImgbbUrl(c.snapshot_url)) ? '<span style="color:var(--primary);font-weight:600"> up</span>' : '<span style="color:var(--danger);font-weight:600"> down</span>'}</span>
      </div>`).join('') + (allCams.length > 20 ? `<p style="font-size:12px;color:var(--muted);text-align:center;margin:4px 0">+ ${allCams.length - 20} mais</p>` : '');

    document.getElementById('imgbbUploadProgress').style.display = 'none';
    document.getElementById('imgbbUploadBar').style.width = '0%';
    document.getElementById('imgbbUploadMsg').textContent = '';
    document.getElementById('modalImgbbUpload').classList.remove('hidden');
    lucide.createIcons();

    // Armazena IPs para o confirm
    document.getElementById('confirmImgbbUpload').dataset.ips = JSON.stringify(ips);
    document.getElementById('confirmImgbbUpload').dataset.keys = JSON.stringify(keys);
  });

  document.getElementById('closeImgbbUpload')?.addEventListener('click', () =>
    document.getElementById('modalImgbbUpload').classList.add('hidden'));
  document.getElementById('cancelImgbbUpload')?.addEventListener('click', () =>
    document.getElementById('modalImgbbUpload').classList.add('hidden'));

  document.getElementById('confirmImgbbUpload')?.addEventListener('click', async () => {
    const ips = JSON.parse(document.getElementById('confirmImgbbUpload').dataset.ips || '[]');
    const keys = JSON.parse(document.getElementById('confirmImgbbUpload').dataset.keys || '[]');
    const progress = document.getElementById('imgbbUploadProgress');
    const bar = document.getElementById('imgbbUploadBar');
    const msg = document.getElementById('imgbbUploadMsg');
    const btn = document.getElementById('confirmImgbbUpload');

    progress.style.display = 'block';
    bar.style.width = '30%';
    msg.textContent = 'Enviando fotos';
    msg.style.color = 'var(--muted)';
    btn.disabled = true;

    try {
      const payload = { mode: _invOltView || 'olt', ...(ips.length ? { ips } : {}), ...(keys.length ? { keys } : {}) };
      const res = await api('/api/inventory/imgbb/upload', { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res?.ok || data?.ok === false) throw new Error(data?.detail || data?.error || 'Erro ao enviar.');

      bar.style.width = '100%';
      const updatedRows = data?.inventory || [];
      const sentIps = new Set(ips.length ? ips : _invOltAll_get().map(c => c.ip));
      const sentKeys = new Set(keys.length ? keys : _invOltAll_get().map(c => _camKey(c)));

      if (updatedRows.length) {
        const byKey = {};
        updatedRows.forEach(r => { byKey[_camKey(r)] = r; });
        Object.keys(_invCam).forEach(mode => {
          _invCam[mode] = (_invCam[mode] || []).map(c => {
            const cKey = _camKey(c);
            const u = byKey[cKey];
            if (!u || (!sentKeys.has(cKey) && !sentIps.has(c.ip))) return c;
            const imgbbUrl = cameraImgbbUrl(u);
            if (imgbbUrl) _imgbbSave(c, imgbbUrl);
            return {
              ...c,
              ...u,
              imgbb_url: imgbbUrl || c.imgbb_url || '',
              imgbb_thumb_url: u.imgbb_thumb_url || u.thumbnail_url || c.imgbb_thumb_url || imgbbUrl || '',
              imgbb_status: imgbbUrl ? 'up' : (u.imgbb_status || c.imgbb_status || ''),
            };
          });
          _camSessionSave(mode, _invCam[mode]);
        });
      }

      _camSessionClear();
      await _loadCamForMode(_invOltView);
      populateCamSiteFilter();
      applyInvOltFilters();

      const uploaded = Number(data?.uploaded || 0);
      const processed = Number(data?.processed || sentIps.size || 0);
      const suffix = data?.error ? ` (${data.error})` : '';
      msg.textContent = uploaded > 0
        ? ` ${uploaded}/${processed} foto(s) enviada(s)!${suffix}`
        : ` Nenhuma foto enviada.${suffix}`;
      msg.style.color = 'var(--primary)';
      showToast(uploaded > 0 ? `${uploaded} foto(s) enviada(s) ao ImgBB.` : 'Nenhuma foto enviada ao ImgBB.', uploaded === 0);
      setTimeout(() => {
        document.getElementById('modalImgbbUpload').classList.add('hidden');
      }, 1400);
    } catch (err) {
      bar.style.width = '100%';
      msg.textContent = ' ' + (err?.message || 'Erro ao enviar.');
      msg.style.color = 'var(--danger)';
      showToast(err?.message || 'Erro ao enviar ImgBB.', true);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('btnOltPingSelected')?.addEventListener('click', async () => {
    const ips = [...document.querySelectorAll('.chk-olt:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione ao menos uma camera', true); return; }
    showToast(`Pingando ${ips.length} camera(s)`);
    const res = await api('/api/cameras/ping_many', {
      method: 'POST',
      body: JSON.stringify({ ips, force: 1, timeout: 3 }),
    });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok || data?.ok === false) {
      showToast(data?.detail || data?.error || 'Erro ao executar ping.', true);
      return;
    }
    showToast(`Ping concluido: ${data.online || 0} responderam, ${data.offline || 0} sem resposta. Status da tabela nao foi alterado.`);
  });

  // Editar selecionados (um ou varios)
  document.getElementById('btnOltEditar')?.addEventListener('click', () => {
    const keys = [...document.querySelectorAll('.chk-olt:checked')].map(c => c.dataset.key || `IP:${c.value}`);
    if (!keys.length) { showToast('Selecione ao menos uma camera para editar', true); return; }
    const cams = keys.map(key => _invOltAll_get().find(c => _camKey(c) === key)).filter(Boolean);
    openEditCamModal(cams);
  });

  // Apagar selecionados
  document.getElementById('btnOltDeleteSelected')?.addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.chk-olt:checked')];
    const ips = checked.map(c => c.value);
    const keys = checked.map(c => c.dataset.key || `IP:${c.value}`);
    if (!ips.length) { showToast('Selecione ao menos uma camera', true); return; }
    if (!await showConfirm({ title: 'Remover cameras', msg: `Remover ${ips.length} camera(s) do inventario?`, label: 'Remover' })) return;
    const res = await api('/api/inventory/delete', {
      method: 'POST',
      body: JSON.stringify({ ips, keys, mode: _invOltView || 'olt' }),
    });
    const data = await res?.json().catch(() => ({}));
    if (!res?.ok || data?.ok === false) {
      showToast(data?.detail || data?.error || 'NAo foi possAvel remover as cAmeras.', true);
      return;
    }
    _camRemoveIpsLocally(keys);
    showToast(`${ips.length} camera(s) removida(s).`);
    closeCamPanel();
    updateCamTabs();
    populateCamSiteFilter();
    applyInvOltFilters();
  });

  document.getElementById('btnOltClear')?.addEventListener('click', async () => {
    if (!await showConfirm({ title: 'Apagar inventario', msg: 'Apagar todas as cameras IP do inventario? Esta acao nao pode ser desfeita.', label: 'Apagar tudo' })) return;
    await api('/api/inventory/clear', { method: 'POST', body: '{}' });
    _imgbbClear();
    _camSessionClear();
    updateCamTabs();
    renderInvOlt([]);
    showToast('Inventario apagado.');
  });

  // Modal editar camera
  document.getElementById('closeEditCam')?.addEventListener('click', closeEditCamModal);
  document.getElementById('cancelEditCam')?.addEventListener('click', closeEditCamModal);
  document.getElementById('saveEditCam')?.addEventListener('click', saveEditCam);

  // Modal trocar IP
  document.getElementById('btnConfirmarTrocarIp')?.addEventListener('click', async () => {
    const ip    = document.getElementById('trocarIpAtual').value;
    const novo  = document.getElementById('trocarIpNovo').value.trim();
    const mask  = document.getElementById('trocarIpMask').value.trim();
    const gw    = document.getElementById('trocarIpGw').value.trim();
    const user  = document.getElementById('trocarIpUser').value.trim() || 'admin';
    const pass  = document.getElementById('trocarIpPass').value;
    const erro  = document.getElementById('trocarIpErro');
    if (!novo) { erro.textContent = 'Informe o novo IP.'; erro.hidden = false; return; }
    if (!pass) { erro.textContent = 'Informe a senha atual da camera.'; erro.hidden = false; return; }
    const payload = { ip, new_ip: novo, user, pass, ...(mask && { mask }), ...(gw && { gateway: gw }) };
    const res = await api('/api/maintenance/change_ip', { method: 'POST', body: JSON.stringify(payload) });
    if (!res?.ok) {
      const e = await res?.json().catch(() => ({}));
      erro.textContent = e?.detail || 'Erro ao trocar IP.'; erro.hidden = false; return;
    }
    document.getElementById('modalTrocarIp').classList.add('hidden');
    showToast(`IP alterado para ${novo}. Aguarde a camera reconectar.`);
    loadInvOlt();
  });

  // Modal trocar senha
  document.getElementById('btnConfirmarTrocarSenha')?.addEventListener('click', async () => {
    const ip    = _invOltActive?.ip;
    const user  = document.getElementById('trocarSenhaUser').value.trim();
    const atual = document.getElementById('trocarSenhaAtual').value;
    const nova  = document.getElementById('trocarSenhaNova').value;
    const conf  = document.getElementById('trocarSenhaConfirm').value;
    const erro  = document.getElementById('trocarSenhaErro');
    if (!atual) { erro.textContent = 'Informe a senha atual.'; erro.hidden = false; return; }
    if (!nova) { erro.textContent = 'Informe a nova senha.'; erro.hidden = false; return; }
    if (nova !== conf) { erro.textContent = 'As senhas nao coincidem.'; erro.hidden = false; return; }
    const res = await api('/api/maintenance/batch/password', {
      method: 'POST',
      body: JSON.stringify({ ips: [ip], user, old_pass: atual, new_pass: nova }),
    });
    if (!res?.ok) {
      const e = await res?.json().catch(() => ({}));
      erro.textContent = e?.detail || 'Erro ao trocar senha.'; erro.hidden = false; return;
    }
    document.getElementById('modalTrocarSenha').classList.add('hidden');
    showToast('Senha alterada com sucesso!');
  });

  // Modal data/hora  alterna campos NTP vs manual
  document.getElementById('dataHoraModo')?.addEventListener('change', function() {
    document.getElementById('dataHoraNtpFields').style.display    = this.value === 'ntp' ? '' : 'none';
    document.getElementById('dataHoraManualFields').style.display = this.value === 'manual' ? '' : 'none';
  });
  document.getElementById('btnConfirmarDataHora')?.addEventListener('click', async () => {
    const ip   = _invOltActive?.ip;
    const modo = document.getElementById('dataHoraModo').value;
    const erro = document.getElementById('dataHoraErro');
    const user = document.getElementById('dataHoraUser').value.trim() || 'admin';
    const pass = document.getElementById('dataHoraPass').value;
    if (!pass) { erro.textContent = 'Informe a senha atual da camera.'; erro.hidden = false; return; }
    let res;
    if (modo === 'ntp') {
      const ntp = document.getElementById('dataHoraNtp').value.trim();
      res = await api('/api/maintenance/batch/ntp', { method: 'POST', body: JSON.stringify({ ips: [ip], user, pass, address: ntp }) });
    } else {
      const data = document.getElementById('dataHoraData').value;
      const hora = document.getElementById('dataHoraHora').value;
      res = await api('/api/maintenance/batch/ntp', { method: 'POST', body: JSON.stringify({ ips: [ip], user, pass, datetime: `${data}T${hora}:00` }) });
    }
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok || body?.ok === false) {
      const first = (body?.results || []).find(r => !r.ok) || {};
      erro.textContent = body?.detail || body?.error || first.error || 'Erro ao aplicar.'; erro.hidden = false; return;
    }
    document.getElementById('modalDataHora').classList.add('hidden');
    showToast('Data/hora aplicada!');
  });

  // Filtros demais views
  document.getElementById('searchInvDvr')?.addEventListener('input', () => filterTable('searchInvDvr', 'invDvrTable'));
  document.getElementById('searchInvNvr')?.addEventListener('input', () => filterTable('searchInvNvr', 'invNvrTable'));
  document.getElementById('searchInvWindows')?.addEventListener('input', applyWindowsFilters);
  document.getElementById('filterWinStatus')?.addEventListener('change', applyWindowsFilters);
  document.getElementById('filterWinSite')?.addEventListener('change', applyWindowsFilters);
  document.getElementById('filterWinSector')?.addEventListener('change', applyWindowsFilters);
  document.getElementById('btnWinClearFilters')?.addEventListener('click', clearWinFilters);
  document.getElementById('chkWinAll')?.addEventListener('change', e => {
    const checked = e.target.checked;
    _winFilteredRows.forEach(row => {
      const key = winKey(row);
      if (!key) return;
      if (checked) _winSelected.add(key); else _winSelected.delete(key);
    });
    renderWinRows(_winFilteredRows);
  });
  document.getElementById('btnScanWindows')?.addEventListener('click', openWinScanModal);
  document.getElementById('closeWinScan')?.addEventListener('click', closeWinScanModal);
  document.getElementById('cancelWinScan')?.addEventListener('click', closeWinScanModal);
  document.getElementById('startWinScan')?.addEventListener('click', runWinScan);
  document.getElementById('btnWinAgent')?.addEventListener('click', () => downloadWithAuth('/api/windows/agent-script', 'sightops-agente-windows.ps1'));
  document.getElementById('btnWinPdf')?.addEventListener('click', () => downloadWithAuth('/api/windows/report.pdf', 'windows-inventory.pdf'));
  document.getElementById('btnWinPhotos')?.addEventListener('click', enrichWindowsPhotos);
  document.getElementById('btnWinEdit')?.addEventListener('click', openWinPhysicalModal);
  document.getElementById('btnWinDelete')?.addEventListener('click', deleteSelectedWindows);
  document.getElementById('btnWinClearAll')?.addEventListener('click', clearWindowsInventory);
  document.getElementById('closeWinPhysical')?.addEventListener('click', closeWinPhysicalModal);
  document.getElementById('cancelWinPhysical')?.addEventListener('click', closeWinPhysicalModal);
  document.getElementById('saveWinPhysical')?.addEventListener('click', saveWinPhysical);
  document.getElementById('winPanelBackdrop')?.addEventListener('click', closeWinPanel);
  document.getElementById('btnCloseWinPanel')?.addEventListener('click', closeWinPanel);
  document.getElementById('wpBtnPing')?.addEventListener('click', () => winPanelAction('ping'));
  document.getElementById('wpBtnAnydesk')?.addEventListener('click', () => winPanelAction('anydesk'));
  document.getElementById('wpBtnEdit')?.addEventListener('click', () => winPanelAction('edit'));
  document.getElementById('wpBtnAgent')?.addEventListener('click', () => winPanelAction('agent'));
  document.getElementById('wpBtnPrepare')?.addEventListener('click', () => winPanelAction('prepare'));
  document.getElementById('wpBtnPdf')?.addEventListener('click', () => winPanelAction('pdf'));
  document.getElementById('wpBtnRefresh')?.addEventListener('click', () => winPanelAction('refresh'));
  document.getElementById('searchNetDevices')?.addEventListener('input', () => filterTable('searchNetDevices', 'netDevicesTable'));

  // Carrossel
  document.getElementById('carClose')?.addEventListener('click', closeCarrossel);
  document.getElementById('modalCarrossel')?.addEventListener('click', e => {
    if (e.target === document.getElementById('modalCarrossel')) closeCarrossel();
  });
  document.getElementById('carPrev')?.addEventListener('click', () => carGoTo(_carIdx - 1));
  document.getElementById('carNext')?.addEventListener('click', () => carGoTo(_carIdx + 1));
  document.getElementById('carBtnDetalhes')?.addEventListener('click', () => {
    const cam = _carCams[_carIdx];
    if (!cam) return;
    const statusColor = (cam.status||'').toLowerCase()==='online' ? 'var(--primary)' : 'var(--danger)';
    document.getElementById('camDetEyebrow').textContent = cam.ip;
    document.getElementById('camDetTitulo').textContent  = cam.titulo || '';
    document.getElementById('camDetStatus').innerHTML    = `<span style="color:${statusColor};font-weight:700">${esc(cam.status||'')}</span>`;
    document.getElementById('camDetIp').textContent      = cam.ip;
    document.getElementById('camDetLocal').textContent   = cam.local || '';
    document.getElementById('camDetMac').textContent     = cam.mac   || '';
    document.getElementById('camDetFab').textContent     = cam.fabricante || '';
    document.getElementById('camDetModelo').textContent  = cam.model  || '';
    document.getElementById('camDetPon').textContent     = [cam.pon, cam.onu_id].filter(Boolean).join(' / ') || '';
    document.getElementById('camDetOnuName').textContent = cam.onu_name   || '';
    document.getElementById('camDetOnuSer').textContent  = cam.onu_serial || '';
    const foto = document.getElementById('camDetFoto');
    foto.src = cam.snapshot_url ? `${API_BASE}${cam.snapshot_url}` : '';
    foto.style.display = cam.snapshot_url ? 'block' : 'none';
    document.getElementById('modalCamDetalhes').classList.remove('hidden');
    lucide.createIcons();
  });
  document.getElementById('closeCamDetalhes')?.addEventListener('click',  () => document.getElementById('modalCamDetalhes').classList.add('hidden'));
  document.getElementById('closeCamDetalhes2')?.addEventListener('click', () => document.getElementById('modalCamDetalhes').classList.add('hidden'));
  document.getElementById('carBtnDownload')?.addEventListener('click', () => {
    const cam = _carCams[_carIdx];
    if (!cam?.snapshot_url) { showToast('Sem foto para baixar', true); return; }
    const a = document.createElement('a');
    a.href = `${API_BASE}${cam.snapshot_url}`;
    a.download = `${(cam.titulo || cam.ip).replace(/[^a-z0-9]/gi,'_')}.jpg`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });
  // Teclado
  document.addEventListener('keydown', e => {
    if (document.getElementById('modalCarrossel')?.style.display !== 'flex') return;
    if (e.key === 'ArrowLeft')  carGoTo(_carIdx - 1);
    if (e.key === 'ArrowRight') carGoTo(_carIdx + 1);
    if (e.key === 'Escape')     closeCarrossel();
  });

  // Snapshots Gravadores (DVR+NVR)
  document.getElementById('searchSnapGrav')?.addEventListener('input', applySnapGravFilters);
  document.getElementById('filterSnapGravTipo')?.addEventListener('change', applySnapGravFilters);
  document.getElementById('filterSnapGravStatus')?.addEventListener('change', applySnapGravFilters);
  document.getElementById('filterSnapGravSite')?.addEventListener('change', applySnapGravFilters);
  document.getElementById('btnSnapGravClearFilter')?.addEventListener('click', () => {
    document.getElementById('searchSnapGrav').value = '';
    document.getElementById('filterSnapGravTipo').value = '';
    document.getElementById('filterSnapGravStatus').value = '';
    document.getElementById('filterSnapGravSite').value = '';
    applySnapGravFilters();
  });
  document.getElementById('btnSnapGravAll')?.addEventListener('click', async () => {
    showToast('Atualizando snapshots dos gravadores');
    await Promise.all([
      api('/api/dvr/snapshot/update', { method: 'POST', body: '{}' }),
      api('/api/nvr/snapshot/update', { method: 'POST', body: '{}' }),
    ]);
    setTimeout(loadSnapDvr, 3000);
  });
  document.getElementById('btnSnapGravSelected')?.addEventListener('click', async () => {
    const idxs = [...document.querySelectorAll('.chk-snap-grav:checked')].map(c => parseInt(c.value));
    if (!idxs.length) { showToast('Selecione canais para capturar', true); return; }
    showToast(`Capturando ${idxs.length} snapshot(s)`);
    for (const i of idxs) {
      const r = _snapGravAll[i];
      if (!r) continue;
      const endpoint = r._tipo === 'dvr' ? '/api/dvr/snapshot/update' : '/api/nvr/snapshot/update';
      await api(endpoint, { method: 'POST', body: JSON.stringify({ ip: r.host, channel: r.channel }) });
    }
    setTimeout(loadSnapDvr, 2000);
  });

  // Snapshots Cameras IP
  document.getElementById('searchSnapCam')?.addEventListener('input', applySnapCamFilters);
  document.getElementById('filterSnapCamStatus')?.addEventListener('change', applySnapCamFilters);
  document.getElementById('filterSnapCamSite')?.addEventListener('change', applySnapCamFilters);
  document.getElementById('btnSnapCamClearFilter')?.addEventListener('click', () => {
    document.getElementById('searchSnapCam').value = '';
    document.getElementById('filterSnapCamStatus').value = '';
    document.getElementById('filterSnapCamSite').value = '';
    applySnapCamFilters();
  });
  document.getElementById('btnSnapCamAll')?.addEventListener('click', async () => {
    showToast('Atualizando todos os snapshots');
    await api('/api/snapshot/save', { method: 'POST', body: '{}' });
    setTimeout(loadSnapCam, 3000);
  });
  document.getElementById('btnSnapCamSelected')?.addEventListener('click', async () => {
    const ips = [...document.querySelectorAll('.chk-snap-cam:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione cameras para capturar', true); return; }
    showToast(`Capturando ${ips.length} snapshot(s)`);
    for (const ip of ips) {
      await api('/api/snapshot/save', { method: 'POST', body: JSON.stringify({ ip }) });
    }
    setTimeout(loadSnapCam, 2000);
  });

  // Varredura DVR
  document.getElementById('btnScanDvr')?.addEventListener('click', async () => {
    showToast('Iniciando varredura DVR');
    await api('/api/dvr/scan', { method: 'POST', body: '{}' });
    setTimeout(loadInvDvr, 2000);
  });

  // Gravadores  seletor de tipo (NVR / DVR)
  document.querySelectorAll('[data-rec-type]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const type = btn.dataset.recType;
      setRecType(type);
      const store = _currentRecStore();
      if (!store[_invNvrView]?.length) {
        await _loadRecForMode(type, _invNvrView || 'olt');
        updateNvrTabs();
        populateNvrFilters();
        applyNvrFilters();
      }
    });
  });

  // Gravadores  tabs de visao
  document.querySelectorAll('[data-nvr-view]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const view = btn.dataset.nvrView;
      const store = _currentRecStore();
      if (!store[view]?.length) {
        await _loadRecForMode(_recType, view);
        updateNvrTabs();
      }
      setNvrView(view);
      populateNvrFilters();
      applyNvrFilters();
    });
  });

  // NVR  modal de scan dedicado
  document.getElementById('btnScanNvr')?.addEventListener('click', () => {
    const scanType = document.getElementById('nvrScanType');
    if (scanType) scanType.value = _recType || 'nvr';
    updateNvrScanTypeLabels();
    document.getElementById('nvrScanErro').hidden = true;
    document.getElementById('modalNvrScan').classList.remove('hidden');
    lucide.createIcons();
  });
  function updateNvrScanTypeLabels() {
    const type = _nvrScanType();
    const isDvr = type === 'dvr';
    setText('nvrScanEyebrow', isDvr ? 'Varredura DVR' : 'Varredura NVR');
    setText('nvrScanIpLabel', isDvr ? 'IP do DVR' : 'IP do NVR');
  }
  function _closeNvrModal() {
    const scanningNow = _nvrAbortCtrl !== null;
    // Para scan em andamento E remove dados parciais SO se ainda estava rodando
    if (scanningNow) {
      _nvrAbortCtrl.abort();
      _nvrAbortCtrl = null;
      _nvrUiScanning(false);
      discardActiveRecorderScan();
      _nvrActiveScan = null;
    }
    document.getElementById('nvrScanLog').innerHTML = 'Aguardando inicio';
    document.getElementById('nvrScanFooter').textContent = '';
    document.getElementById('modalNvrScan').classList.add('hidden');
  }

  document.getElementById('closeNvrScanModal')?.addEventListener('click', _closeNvrModal);
  document.getElementById('cancelNvrScan')?.addEventListener('click', _closeNvrModal);
  document.getElementById('btnStopNvrScan')?.addEventListener('click', () => {
    if (_nvrAbortCtrl) { _nvrAbortCtrl.abort(); _nvrAbortCtrl = null; }
    discardActiveRecorderScan();
    _nvrActiveScan = null;
    appendLog(document.getElementById('nvrScanLog'), '[PARADO] Cancelado pelo usuario.', 'err');
    _nvrUiScanning(false);
    setText('nvrScanFooter', '');
  });

  function _nvrPayload(extra = {}) {
    return {
      ip:            document.getElementById('nvrScanIp').value.trim(),
      user:          document.getElementById('nvrScanUser').value.trim() || 'admin',
      password:      document.getElementById('nvrScanPass').value,
      http_port:     parseInt(document.getElementById('nvrScanPort').value) || 80,
      start_channel: parseInt(document.getElementById('nvrScanStart').value) || 1,
      end_channel:   parseInt(document.getElementById('nvrScanEnd').value) || 32,
      timeout_sec:   4,
      ...extra,
    };
  }

  function _nvrUiScanning(on) {
    const btn     = document.getElementById('btnStartNvrScan');
    const btnStop = document.getElementById('btnStopNvrScan');
    const btnDisc = document.getElementById('nvrTaskDiscoverRun');
    if (on) {
      if (btn)     { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle"></i> Varrendo'; }
      if (btnStop) btnStop.style.display = '';
      if (btnDisc) btnDisc.disabled = true;
    } else {
      if (btn)     { btn.disabled = false; btn.innerHTML = '<i data-lucide="scan-search"></i> Executar marcados'; }
      if (btnStop) btnStop.style.display = 'none';
      if (btnDisc) btnDisc.disabled = false;
    }
    lucide.createIcons();
  }

  async function _runNvrTask(payload) {
    const log  = document.getElementById('nvrScanLog');
    const erro = document.getElementById('nvrScanErro');
    erro.hidden = true;
    if (!payload.ip) { erro.textContent = 'Informe o IP do NVR.'; erro.hidden = false; return; }

    const local = document.getElementById('nvrScanLocal').value.trim();
    if (local) { payload.set_local = true; payload.local = local; }

    log.innerHTML = '';
    const start = payload.start_channel || 1;
    const end   = payload.end_channel   || 32;
    appendLog(log, `[INFO] Conectando em ${payload.ip}:${payload.http_port} (canais ${start}${end})`, 'info');

    // Animacao discreta: 3 passos fixos + contador no rodape
    const steps = [
      [500,  'info', `[INFO] Autenticando como "${payload.user}"`],
      [1200, 'info', `[INFO] Lendo ${end - start + 1} canais`],
    ];
    const timers = steps.map(([d, cls, msg]) => setTimeout(() => appendLog(log, msg, cls), d));

    let secs = 0;
    const tick = setInterval(() => {
      secs++;
      setText('nvrScanFooter', `${secs}s decorridos`);
    }, 1000);

    _nvrAbortCtrl = new AbortController();
    _nvrActiveScan = {
      type: _nvrScanType(),
      host: payload.ip,
      start,
      end,
    };
    _nvrUiScanning(true);

    let res = null;
    try {
      const scanType = _nvrScanType();
      const endpoint = scanType === 'dvr' ? '/api/dvr/scan' : '/api/nvr/scan';
      res = await api(endpoint, {
        method: 'POST',
        body: JSON.stringify(payload),
        skipLogout: true,
        signal: _nvrAbortCtrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') {
        appendLog(log, '[PARADO] Varredura cancelada.', 'err');
        timers.forEach(t => clearTimeout(t));
        clearInterval(tick);
        _nvrUiScanning(false);
        setText('nvrScanFooter', '');
        _nvrActiveScan = null;
        return;
      }
      throw e;
    }

    timers.forEach(t => clearTimeout(t));
    clearInterval(tick);
    _nvrAbortCtrl = null; // scan terminou  fechar nao apaga mais dados
    _nvrActiveScan = null;
    _nvrUiScanning(false);
    setText('nvrScanFooter', '');

    if (res?.ok) {
      const data = await res.json();
      const mode  = _nvrScanMode();
      const stype = _nvrScanType();
      let rows = data?.inventory || [];
      appendLog(log, `[OK] Scan concluido  ${rows.length} canais encontrados.`, 'ok');

      // Enriquece se necessario
      if ((mode === 'olt' || mode === 'switch') && rows.length) {
        appendLog(log, '[INFO] Cruzando com inventario de cameras', 'info');
        rows = await enrichRecRowsForMode(rows, mode);
        appendLog(log, `[OK] Cruzamento concluido.`, 'ok');
      }

      // Salva no store correto (NVR ou DVR) e sincroniza o tipo na UI
      const store = stype === 'dvr' ? _invDvr : _invNvr;
      store[mode] = [...store[mode].filter(r => r.host !== payload.ip), ...rows];
      _recSessionSave(stype, mode, store[mode]);
      pruneSyntheticRecModes(stype);
      setRecType(stype);
      if ((store[mode] || []).length) setNvrView(mode);
      populateNvrFilters();
      applyNvrFilters();
    } else {
      const e = await res?.json().catch(() => ({}));
      const msg = e?.detail || (res?.status === 401 ? 'Credenciais invalidas para o NVR.' : 'Erro na varredura.');
      appendLog(log, '[ERRO] ' + msg, 'err');
    }
  }

  function _nvrScanMode() { return document.getElementById('nvrScanMode')?.value || 'basico'; }
  function _nvrScanType() { return document.getElementById('nvrScanType')?.value || 'nvr'; }
  document.getElementById('nvrScanType')?.addEventListener('change', updateNvrScanTypeLabels);

  async function _runNvrScan(extra = {}) {
    document.getElementById('nvrScanLog').innerHTML = '';
    await _runNvrTask(_nvrPayload(extra));
    // Dados ja atualizados dentro de _runNvrTask via data.inventory
  }

  document.getElementById('btnStartNvrScan')?.addEventListener('click', () =>
    _runNvrScan({ imgbb: document.getElementById('nvrTaskImgbb').checked }));

  document.getElementById('nvrTaskDiscoverRun')?.addEventListener('click', () =>
    _runNvrScan({ imgbb: false }));
  document.getElementById('nvrTaskSnapshotRun')?.addEventListener('click', async () => {
    const ip = document.getElementById('nvrScanIp').value.trim();
    const stype = _nvrScanType();
    if (!ip) { showToast(`Informe o IP do ${stype === 'dvr' ? 'DVR' : 'NVR'}`, true); return; }
    appendLog(document.getElementById('nvrScanLog'), 'Capturando snapshots', 'info');
    await api(`/api/${stype}/snapshot/update`, { method: 'POST', body: JSON.stringify({ ip, user: document.getElementById('nvrScanUser').value, password: document.getElementById('nvrScanPass').value }) });
    appendLog(document.getElementById('nvrScanLog'), ' Snapshots atualizados.', 'ok');
    loadInvNvr();
  });
  document.getElementById('nvrTaskImgbbRun')?.addEventListener('click', async () => {
    const stype = _nvrScanType();
    appendLog(document.getElementById('nvrScanLog'), 'Enviando ao ImgBB', 'info');
    const res = await api(`/api/${stype}/imgbb/upload`, { method: 'POST', body: '{}' });
    const d = await res?.json().catch(() => ({}));
    appendLog(document.getElementById('nvrScanLog'), ` ${d?.uploaded ?? '?'} fotos enviadas.`, 'ok');
    loadInvNvr();
  });
  document.getElementById('btnNvrClear')?.addEventListener('click', async () => {
    const store      = _currentRecStore();
    const typeName   = _recType === 'dvr' ? 'Analogico (DVR)' : 'NVR  IP';
    const viewName   = { basico: 'Basico', olt: 'Via OLT', switch: 'Via Switch' }[_invNvrView] || _invNvrView;
    const siteFilter = document.getElementById('filterNvrLocal')?.value || '';
    const hostFilter = document.getElementById('filterNvrHost')?.value  || '';
    const hasFilter  = !!(siteFilter || hostFilter);

    const scopeMsg = hasFilter
      ? `Apagar canais de ${typeName}  ${viewName}${siteFilter ? `  site "${siteFilter}"` : ''}${hostFilter ? `  host "${hostFilter}"` : ''}?`
      : `Apagar TODOS os canais de ${typeName}  ${viewName}?`;

    if (!await showConfirm({ title: 'Apagar dados', msg: scopeMsg, label: 'Apagar' })) return;

    if (hasFilter) {
      store[_invNvrView] = store[_invNvrView].filter(r => {
        if (siteFilter && r.local === siteFilter) return false;
        if (hostFilter && r.host === hostFilter)  return false;
        return true;
      });
      _recSessionSave(_recType, _invNvrView, store[_invNvrView]);
    } else {
      const endpoint = _recType === 'dvr' ? '/api/dvr/clear' : '/api/nvr/clear';
      await api(endpoint, { method: 'POST', body: '{}' });
      store[_invNvrView] = [];
      _recSessionSave(_recType, _invNvrView, []);
    }

    updateNvrTabs();
    populateNvrFilters();
    applyNvrFilters();
    showToast('Dados apagados.');
  });
  document.getElementById('searchInvNvr')?.addEventListener('input', applyNvrFilters);
  document.getElementById('filterNvrStatus')?.addEventListener('change', applyNvrFilters);
  document.getElementById('filterNvrLocal')?.addEventListener('change', applyNvrFilters);
  document.getElementById('filterNvrHost')?.addEventListener('change', applyNvrFilters);
  document.getElementById('btnNvrClearFilter')?.addEventListener('click', () => {
    document.getElementById('searchInvNvr').value = '';
    document.getElementById('filterNvrStatus').value = '';
    document.getElementById('filterNvrLocal').value  = '';
    document.getElementById('filterNvrHost').value   = '';
    applyNvrFilters();
  });
  document.getElementById('btnNvrImgbb')?.addEventListener('click', async () => {
    const selected = selectedRecItems();
    if (!selected.length) { showToast('Selecione ao menos um canal', true); return; }
    const endpoint = _recType === 'dvr' ? '/api/dvr/imgbb/upload' : '/api/nvr/imgbb/upload';
    showToast(`Enviando ${selected.length} canal(is) ao ImgBB...`);
    const res = await api(endpoint, { method: 'POST', body: JSON.stringify({ selected }) });
    const d = await res?.json().catch(() => ({}));
    if (!res?.ok || d?.ok === false) {
      showToast(d?.detail || d?.error || 'Erro ao enviar ao ImgBB.', true);
      return;
    }
    showToast(`Concluido: ${d?.uploaded ?? 0} foto(s) enviada(s) ao ImgBB.`);
    if (Array.isArray(d?.inventory)) applyRecPayloadsLocally(d.inventory, _recType);
    updateNvrTabs();
    populateNvrFilters();
    applyNvrFilters();
  });
  document.getElementById('btnNvrEditar')?.addEventListener('click', () => {
    const rows = selectedRecRows();
    if (!rows.length) { showToast('Selecione ao menos um canal para editar', true); return; }
    openEditRecModal(rows);
  });
  document.getElementById('closeEditRec')?.addEventListener('click', closeEditRecModal);
  document.getElementById('cancelEditRec')?.addEventListener('click', closeEditRecModal);
  document.getElementById('saveEditRec')?.addEventListener('click', saveEditRec);
  document.getElementById('btnNvrDeleteSelected')?.addEventListener('click', async () => {
    const items = selectedRecItems();
    if (!items.length) { showToast('Selecione ao menos um canal', true); return; }
    if (!await showConfirm({ title: 'Apagar canais', msg: `Remover ${items.length} canal(is) do inventario?`, label: 'Remover' })) return;
    const endpoint = _recType === 'dvr' ? '/api/dvr/delete' : '/api/nvr/delete';
    const res = await api(endpoint, { method: 'POST', body: JSON.stringify({ items }) });
    const d = await res?.json().catch(() => ({}));
    if (!res?.ok || d?.ok === false) {
      showToast(d?.detail || d?.error || 'Erro ao remover canais.', true);
      return;
    }
    showToast(`${d?.removed ?? items.length} canal(is) removido(s).`);
    removeRecItemsLocally(_recType, items);
    closeRecPanel();
    updateNvrTabs();
    populateNvrFilters();
    applyNvrFilters();
  });
  document.getElementById('btnCloseRecPanel')?.addEventListener('click', closeRecPanel);
  document.getElementById('recPanelBackdrop')?.addEventListener('click', closeRecPanel);
  document.getElementById('rpBtnAtualizar')?.addEventListener('click', () => recPanelAction('snapshot'));
  document.getElementById('rpBtnRenomear')?.addEventListener('click', () => recPanelAction('rename'));
  document.getElementById('rpBtnTrocarIp')?.addEventListener('click', () => recPanelAction('ip'));
  document.getElementById('rpBtnTrocarSenha')?.addEventListener('click', () => recPanelAction('password'));
  document.getElementById('rpBtnDataHora')?.addEventListener('click', () => recPanelAction('datetime'));
  document.getElementById('rpBtnReboot')?.addEventListener('click', () => recPanelAction('reboot'));
  document.getElementById('rpBtnWeb')?.addEventListener('click', () => recPanelAction('web'));
  document.getElementById('rpBtnPing')?.addEventListener('click', () => recPanelAction('ping'));
  document.getElementById('closeRecAction')?.addEventListener('click', closeRecAction);
  document.getElementById('cancelRecAction')?.addEventListener('click', closeRecAction);
  document.getElementById('confirmRecAction')?.addEventListener('click', runRecAction);
  document.getElementById('recActionPass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runRecAction();
  });

  // Export backup
  document.getElementById('btnExportBackup')?.addEventListener('click', () => {
    window.open(`${API_BASE}/api/backup/export`, '_blank');
  });

  // Botao Ferramentas KMZ
  document.getElementById('btnMapTools')?.addEventListener('click', () => {
    document.getElementById('modalMapTools').classList.remove('hidden');
    lucide.createIcons();
  });
  document.getElementById('closeMapTools')?.addEventListener('click',  () => document.getElementById('modalMapTools').classList.add('hidden'));
  document.getElementById('closeMapTools2')?.addEventListener('click', () => document.getElementById('modalMapTools').classList.add('hidden'));

  // Etapa 2  Previa e Aplicar coordenadas
  document.getElementById('btnMapApplyPreview')?.addEventListener('click', async () => {
    const source   = document.getElementById('mapApplySource')?.value || 'ip';
    const overwrite = document.getElementById('mapApplyOverwrite')?.checked || false;
    const status   = document.getElementById('mapApplyStatus');
    status.textContent = 'Calculando previa';
    const res  = await api('/api/kmz/import/locations/apply', { method: 'POST', body: JSON.stringify({ source, overwrite, dry_run: true }) });
    const data = await res?.json().catch(() => ({}));
    if (data?.error) { status.textContent = ' ' + data.error; status.style.color = 'var(--danger)'; return; }
    const src = document.getElementById('mapApplySource')?.options[document.getElementById('mapApplySource')?.selectedIndex]?.text || source;
    status.style.color = 'var(--muted)';
    status.innerHTML = `<strong>${src}</strong> | Pontos: ${data.total_points ?? '?'} | Atualizariam: ${data.updated ?? '?'} | Sem match: ${data.no_match ?? '?'} | Ja tinham: ${data.already_had ?? '?'}`;
  });

  document.getElementById('btnMapApply')?.addEventListener('click', async () => {
    const source    = document.getElementById('mapApplySource')?.value || 'ip';
    const overwrite = document.getElementById('mapApplyOverwrite')?.checked || false;
    const status    = document.getElementById('mapApplyStatus');
    status.textContent = 'Aplicando'; status.style.color = 'var(--muted)';
    const res  = await api('/api/kmz/import/locations/apply', { method: 'POST', body: JSON.stringify({ source, overwrite }) });
    const data = await res?.json().catch(() => ({}));
    if (data?.error) { status.textContent = ' ' + data.error; status.style.color = 'var(--danger)'; return; }
    status.style.color = 'var(--primary)';
    const src = document.getElementById('mapApplySource')?.options[document.getElementById('mapApplySource')?.selectedIndex]?.text || source;
    status.innerHTML = ` <strong>${src}</strong> | Atualizadas: ${data.updated ?? '?'} | Sem match: ${data.no_match ?? '?'}`;
    showToast(`${data.updated ?? '?'} cameras atualizadas com GPS!`);
  });

  // Etapa 3  Gerar KMZ
  document.getElementById('btnMapViewGenerated')?.addEventListener('click', async () => {
    const status = document.getElementById('mapGenerateStatus');
    status.textContent = 'Carregando camada gerada'; status.style.color = 'var(--muted)';
    await loadMapLayers();
    const lastGenerated = sessionStorage.getItem('so_kmz_last_generated_layer') || '';
    const generatedId = lastGenerated ? `generated:${lastGenerated}` : Object.keys(_mapLayerGroups).find(id => id.startsWith('generated:'));
    const generatedState = generatedId ? _mapLayerGroups[generatedId] : null;
    if (generatedState && !generatedState.active) await toggleMapLayer(generatedId, generatedState.def);
    status.textContent = generatedState ? 'Camada gerada exibida no mapa.' : 'Nenhuma camada gerada encontrada.';
    status.style.color = generatedState ? 'var(--primary)' : 'var(--danger)';
  });

  document.getElementById('btnMapDownloadGenerated')?.addEventListener('click', () => {
    const lastGenerated = sessionStorage.getItem('so_kmz_last_generated_layer') || '';
    const url = lastGenerated ? `/api/kmz/generated/layers/${encodeURIComponent(lastGenerated)}/download` : '/api/kmz/generated/download';
    downloadWithAuth(url, 'cameras-gerado.kmz');
  });

  // Mapa
  document.getElementById('mapFilterStatus')?.addEventListener('change', loadMapLayers);
  document.getElementById('mapFilterSite')?.addEventListener('change', loadMapLayers);
  document.getElementById('btnMapReload')?.addEventListener('click', async () => {
    await refreshMapLiveStatus();
    await loadKmz();
  });

  // Importar KMZ
  document.getElementById('btnMapImport')?.addEventListener('click', () =>
    document.getElementById('mapKmzInput')?.click());

  document.getElementById('mapKmzInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Passo 1: importar o arquivo
    showToast(`Importando ${file.name}`);
    const form = new FormData();
    form.append('file', file);
    const headers = {};
    if (_token) headers['Authorization'] = `Bearer ${_token}`;

    let importRes;
    try {
      importRes = await fetch(`${API_BASE}/api/kmz/import`, { method: 'POST', headers, body: form });
    } catch (err) {
      showToast('Erro de conexao ao importar KMZ', true);
      e.target.value = '';
      return;
    }

    if (!importRes.ok) {
      const text = await importRes.text().catch(() => '');
      let detail = 'Erro desconhecido';
      try { detail = JSON.parse(text)?.detail || text || detail; } catch { detail = text || detail; }
      showToast('Erro ao importar: ' + detail.slice(0, 120), true);
      console.error('KMZ import error', importRes.status, text);
      e.target.value = '';
      return;
    }

    const importData = await importRes.json().catch(() => ({}));
    const featCount  = importData?.features_count ?? importData?.total ??
      importData?.features?.length ?? importData?.count ?? '?';
    // Salva o nome do arquivo para mostrar na camada
    const kmlName = file.name.replace(/\.(kmz|kml)$/i, '');
    sessionStorage.setItem('so_kmz_imported_name', kmlName);
    if (importData?.id) sessionStorage.setItem('so_kmz_current_import_layer', importData.id);
    showToast(`KMZ importado  ${featCount} pontos encontrados`);

    // Passo 2: perguntar se quer aplicar ao inventario
    const apply = await showConfirm({
      eyebrow: 'KMZ importado',
      title:   'Aplicar localizacoes?',
      msg:     `O KMZ tem ${featCount} ponto(s). Deseja aplicar as coordenadas GPS ao inventario de cameras?`,
      label:   'Aplicar',
      danger:  false,
    });

    if (apply) {
      const applyRes = await api('/api/kmz/import/locations/apply', {
        method: 'POST',
        body: JSON.stringify({ source: 'ip', overwrite: true }),
      });
      if (applyRes?.ok) {
        const d = await applyRes.json().catch(() => ({}));
        showToast(`Localizacoes aplicadas  ${d?.updated ?? '?'} cameras atualizadas!`);
      } else {
        const err = await applyRes?.json().catch(() => ({}));
        showToast('Erro ao aplicar: ' + (err?.detail || 'verifique o inventario'), true);
      }
    }

    await loadKmz();
    e.target.value = '';
  });
  document.getElementById('btnMapDownloadKmz')?.addEventListener('click', () =>
    downloadWithAuth('/api/kmz/import/download', 'imported.kmz'));
  document.getElementById('btnMapGenerate')?.addEventListener('click', async () => {
    const genStatus = document.getElementById('mapGenerateStatus');
    const genName = document.getElementById('mapGenerateName')?.value.trim() || 'Cameras do Inventario';
    const sourceLayerId = sessionStorage.getItem('so_kmz_current_import_layer') || '';
    if (genStatus) { genStatus.textContent = 'Gerando'; genStatus.style.color = 'var(--muted)'; }
    sessionStorage.setItem('so_kmz_generated_name', genName);
    const res = await api('/api/kmz/generate', {
      method: 'POST',
      body: JSON.stringify({ label: genName, layer_id: sourceLayerId }),
    });
    if (res?.ok) {
      const data = await res.json().catch(() => ({}));
      if (data?.id) sessionStorage.setItem('so_kmz_last_generated_layer', data.id);
      if (genStatus) { genStatus.textContent = ' Gerado com sucesso!'; genStatus.style.color = 'var(--primary)'; }
      showToast('KMZ gerado!');
      await loadMapLayers();
      const generatedId = data?.id ? `generated:${data.id}` : Object.keys(_mapLayerGroups).find(id => id.startsWith('generated:'));
      const generatedState = generatedId ? _mapLayerGroups[generatedId] : null;
      if (generatedState && !generatedState.active) await toggleMapLayer(generatedId, generatedState.def);
    } else {
      if (genStatus) { genStatus.textContent = ' Erro ao gerar.'; genStatus.style.color = 'var(--danger)'; }
      showToast('Erro ao gerar KMZ', true);
    }
  });

  // OLT  abre modal de configuracao
  document.getElementById('btnOltCollect')?.addEventListener('click', () => {
    document.getElementById('modalOltCollect').classList.remove('hidden');
    lucide.createIcons();
  });
  document.getElementById('closeOltModal')?.addEventListener('click', () => document.getElementById('modalOltCollect').classList.add('hidden'));
  document.getElementById('cancelOltModal')?.addEventListener('click', () => document.getElementById('modalOltCollect').classList.add('hidden'));
  document.getElementById('btnOltStart')?.addEventListener('click', () => {
    document.getElementById('modalOltCollect').classList.add('hidden');
    oltCollect();
  });

  document.getElementById('btnOltClearTable')?.addEventListener('click', async () => {
    const site = document.getElementById('oltFilterSite')?.value || '';
    const ok = await showConfirm({
      eyebrow: 'Tabela OLT',
      title:   site ? `Apagar site "${site}"` : 'Apagar tudo',
      msg:     site
        ? `Serao removidos todos os registros do site "${site}". Esta acao nao pode ser desfeita.`
        : 'Serao removidos todos os registros de todos os sites. Esta acao nao pode ser desfeita.',
      label: 'Apagar',
    });
    if (!ok) return;
    await api(`/api/olt/clear${site ? `?site=${encodeURIComponent(site)}` : ''}`, { method: 'POST', body: '{}' });
    _oltRows = site ? _oltRows.filter(r => r.site !== site) : [];
    renderOltTable(_oltRows);
    populateOltMacSiteFilter();
    showToast(site ? `Site "${site}" apagado.` : 'Tabela OLT apagada.');
  });

  // Filtros OLT
  document.getElementById('oltFilterSite')?.addEventListener('change', filterOltTable);
  document.getElementById('oltSearch')?.addEventListener('input', filterOltTable);
  document.getElementById('btnOltMacsClearFilter')?.addEventListener('click', () => {
    document.getElementById('oltSearch').value = '';
    document.getElementById('oltFilterSite').value = '';
    filterOltTable();
  });

  // Terminal OLT
  document.getElementById('oltTermClear')?.addEventListener('click', () => { const el = document.getElementById('oltConsole'); if (el) el.innerHTML = ''; });
  document.getElementById('oltTermClose')?.addEventListener('click', () => document.getElementById('oltTerminal').classList.add('hidden'));

  // Coleta Switch
  document.getElementById('btnScanSwitch')?.addEventListener('click', async () => {
    showToast('Coletando MACs do switch');
    await api('/api/switch/collect-macs', { method: 'POST', body: '{}' });
    setTimeout(loadSwitch, 3000);
  });

  // Scripts
  document.getElementById('btnGenGrafana')?.addEventListener('click', async () => {
    const url       = document.getElementById('gfUrl')?.value.trim();
    const apiKey    = document.getElementById('gfApiKey')?.value.trim();
    const folderUid = document.getElementById('gfFolderUid')?.value.trim();
    const overwrite = document.getElementById('gfOverwrite')?.checked ?? true;

    if (!url || !apiKey) {
      showToast('Preencha a URL e a API Key do Grafana', true);
      return;
    }

    const log   = document.getElementById('grafanaLog');
    const badge = document.getElementById('gfStatusBadge');
    const btn   = document.getElementById('btnGenGrafana');

    log.textContent = 'Conectando ao Grafana\n';
    badge.style.display = 'none';
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Importando';
    lucide.createIcons();

    const res  = await api('/api/scripts/grafana', {
      method: 'POST',
      body: JSON.stringify({ url, api_key: apiKey, folder_uid: folderUid, overwrite }),
    });
    const data = await res?.json().catch(() => ({}));

    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="bar-chart-2"></i> Importar Dashboard';
    lucide.createIcons();

    if (data?.error) {
      log.textContent = ' Erro: ' + data.error + '\n\n' + (data.stderr || '') + (data.stdout || '');
      badge.textContent = 'Erro';
      badge.style.background = 'var(--danger-soft)';
      badge.style.color = 'var(--danger)';
      badge.style.display = 'inline-block';
    } else {
      log.textContent = data?.stdout || data?.result || 'Concluido.';
      if (data?.stderr) log.textContent += '\n\n[stderr]\n' + data.stderr;
      badge.textContent = ' Importado';
      badge.style.background = 'var(--primary-soft)';
      badge.style.color = 'var(--primary)';
      badge.style.display = 'inline-block';
      showToast('Dashboard importado no Grafana!');
    }
  });
// Templates padrao por fonte
  const ZBX_TEMPLATES = {
    'ip':         'Template Module ICMP Ping',
    'ip-olt':     'Template Module ICMP Ping',
    'ip-switch':  'Template Module ICMP Ping',
    'dvr':        'Template Cam-Snapshot DVR Channel',
    'nvr':        'Template Cam-Snapshot DVR Channel',
    'nvr-olt':    'Template Cam-Snapshot DVR Channel',
    'nvr-switch': 'Template Cam-Snapshot DVR Channel',
  };

  // Zabbix  mostra/oculta campos DVR/Telegram e atualiza template
  document.getElementById('zbxSource')?.addEventListener('change', function() {
    const v = this.value;
    const isDvr = v === 'dvr' || v.startsWith('nvr');
    document.getElementById('zbxDvrPanel').style.display = isDvr ? 'block' : 'none';
    const tmpl = document.getElementById('zbxTemplate');
    if (tmpl) tmpl.value = ZBX_TEMPLATES[v] || 'Template Module ICMP Ping';
  });
  document.getElementById('zbxTgAuto')?.addEventListener('change', function() {
    document.getElementById('zbxTgFields').style.display = this.checked ? 'block' : 'none';
  });

  document.getElementById('btnGenZabbix')?.addEventListener('click', async () => {
    const url      = document.getElementById('zbxUrl')?.value.trim();
    const user     = document.getElementById('zbxUser')?.value.trim();
    const pass     = document.getElementById('zbxPass')?.value;
    const sourceUI = document.getElementById('zbxSource')?.value || 'ip';
    // Mapeia para source e inv_mode separados
    const source  = sourceUI.startsWith('ip')  ? 'ip'
                  : sourceUI.startsWith('nvr') ? 'nvr'
                  : sourceUI; // dvr
    const invMode = sourceUI.endsWith('-olt')    ? 'olt'
                  : sourceUI.endsWith('-switch') ? 'switch'
                  : 'basic';
    const group    = document.getElementById('zbxGroup')?.value.trim() || 'Cameras';
    const template = document.getElementById('zbxTemplate')?.value.trim() || 'Template Module ICMP Ping';
    const site     = document.getElementById('zbxSite')?.value.trim();
    const dvrUser  = document.getElementById('zbxDvrUser')?.value.trim();
    const dvrPass  = document.getElementById('zbxDvrPass')?.value;
    const tgAuto   = document.getElementById('zbxTgAuto')?.checked;
    const tgToken  = document.getElementById('zbxTgToken')?.value.trim();
    const tgChat   = document.getElementById('zbxTgChat')?.value.trim();

    if (!url || !user || !pass) {
      showToast('Preencha URL, usuario e senha do Zabbix', true);
      return;
    }

    const log    = document.getElementById('zabbixLog');
    const badge  = document.getElementById('zbxStatusBadge');
    const btn    = document.getElementById('btnGenZabbix');

    log.textContent = 'Conectando ao Zabbix\n';
    badge.style.display = 'none';
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Sincronizando';
    lucide.createIcons();

    const payload = {
      url, user, pass, source, group, template,
      inv_mode: invMode,
      ...(site && { site }),
      ...(dvrUser && { dvr_user: dvrUser }),
      ...(dvrPass && { dvr_pass: dvrPass }),
      tg_auto: tgAuto || false,
      ...(tgToken && { tg_token: tgToken }),
      ...(tgChat  && { tg_chat:  tgChat  }),
    };

    const res  = await api('/api/scripts/zabbix', { method: 'POST', body: JSON.stringify(payload) });
    const data = await res?.json().catch(() => ({}));

    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="refresh-cw"></i> Sincronizar com Zabbix';
    lucide.createIcons();

    if (!res?.ok || data?.error || data?.ok === false) {
      log.textContent = ' Erro: ' + (data?.error || data?.detail || `HTTP ${res?.status || 'falha'}`) + '\n\n' + (data?.stderr || '');
      badge.textContent = 'Erro';
      badge.style.background = 'var(--danger-soft)';
      badge.style.color = 'var(--danger)';
      badge.style.display = 'inline-block';
    } else {
      const output = data?.stdout || data?.result || JSON.stringify(data, null, 2) || 'Concluido.';
      log.textContent = output;
      badge.textContent = ' Sincronizado';
      badge.style.background = 'var(--primary-soft)';
      badge.style.color = 'var(--primary)';
      badge.style.display = 'inline-block';
      showToast('Sincronizacao Zabbix concluida!');
    }
  });

  // Varredura OLT (via inventario)
  document.getElementById('btnScanOlt')?.addEventListener('click', openScanModal);

  //  Manutencao Cameras 
  document.getElementById('btnMntCamRefresh')?.addEventListener('click', () => { _mntCamAll = []; loadMntCam(); });
  document.getElementById('btnMntCamReboot')?.addEventListener('click', () => _mntCamRunAction('reboot'));
  document.getElementById('btnMntCamSnapshot')?.addEventListener('click', () => _mntCamRunAction('snapshot_force'));
  document.getElementById('btnMntCamTest')?.addEventListener('click', () => _mntCamRunAction('test'));
  document.getElementById('btnMntCamRename')?.addEventListener('click', openMntRenameModal);
  document.getElementById('btnMntCamTimeCheck')?.addEventListener('click', () => _mntCamRunAction('time_check'));
  document.getElementById('btnMntCamDayNight')?.addEventListener('click', openMntDayNightModal);
  document.getElementById('btnMntCamMirror')?.addEventListener('click', openMntMirrorModal);
  document.getElementById('btnMntCamQuality')?.addEventListener('click', openMntQualityModal);
  document.getElementById('btnMntCamNtp')?.addEventListener('click', openMntNtpModal);
  document.getElementById('closeMntNtp')?.addEventListener('click', closeMntNtpModal);
  document.getElementById('cancelMntNtp')?.addEventListener('click', closeMntNtpModal);
  document.getElementById('confirmMntNtp')?.addEventListener('click', runMntNtp);
  document.getElementById('mntNtpAddress')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runMntNtp();
  });
  document.getElementById('btnMntCamNetwork')?.addEventListener('click', openMntNetworkModal);
  document.getElementById('btnMntCamShiftIp')?.addEventListener('click', openMntShiftIpModal);
  document.getElementById('btnMntCamPass')?.addEventListener('click', () => {
    const ips = [...document.querySelectorAll('.chk-mnt-cam:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione ao menos uma camera', true); return; }
    document.getElementById('modalTrocarSenha')?.classList.remove('hidden');
    lucide.createIcons();
  });
  document.getElementById('mntStreamClose')?.addEventListener('click', closeMntStream);
  document.getElementById('btnMntCamSelectAll')?.addEventListener('click', () => {
    document.querySelectorAll('.chk-mnt-cam').forEach(c => { c.checked = true; c.closest('.mnt-cam-card')?.classList.add('selected'); });
    _mntCamUpdateCount();
  });
  document.getElementById('btnMntCamDeselect')?.addEventListener('click', () => {
    document.querySelectorAll('.chk-mnt-cam').forEach(c => { c.checked = false; c.closest('.mnt-cam-card')?.classList.remove('selected'); });
    _mntCamUpdateCount();
  });
  const mntCamSearch = document.getElementById('mntCamSearch');
  const runMntCamSearch = () => {
    _mntCamFilter.q = mntCamSearch?.value || '';
    _mntCamRender();
  };
  mntCamSearch?.addEventListener('input', runMntCamSearch);
  mntCamSearch?.addEventListener('keyup', runMntCamSearch);
  mntCamSearch?.addEventListener('search', runMntCamSearch);
  mntCamSearch?.addEventListener('change', runMntCamSearch);
  document.getElementById('mntCamSite')?.addEventListener('change', e => { _mntCamFilter.site = e.target.value; _mntCamRender(); });
  document.querySelectorAll('[data-mnt-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mnt-status]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _mntCamFilter.status = btn.dataset.mntStatus;
      _mntCamRender();
    });
  });

  //  Manutencao DVR 
  document.getElementById('btnMntDvrRefresh')?.addEventListener('click', loadMntDvr);
  document.getElementById('btnMntDvrReboot')?.addEventListener('click', () => _mntDvrRunAction('reboot'));
  document.getElementById('btnMntDvrNtp')?.addEventListener('click', () => _mntDvrRunAction('ntp'));
  document.getElementById('btnMntDvrSelectAll')?.addEventListener('click', () => {
    document.querySelectorAll('.chk-mnt-dvr').forEach(c => c.checked = true);
    _mntDvrUpdateCount();
  });

  //  Manutencao NVR 
  document.getElementById('btnMntNvrRefresh')?.addEventListener('click', loadMntNvr);
  document.getElementById('btnMntNvrReboot')?.addEventListener('click', () => _mntNvrRunAction('reboot'));
  document.getElementById('btnMntNvrNtp')?.addEventListener('click', () => _mntNvrRunAction('ntp'));
  document.getElementById('btnMntNvrSelectAll')?.addEventListener('click', () => {
    document.querySelectorAll('.chk-mnt-nvr').forEach(c => c.checked = true);
    _mntNvrUpdateCount();
  });

  // Auto-login se tem token
  if (_token) {
    showApp();
  }
});
