/* ═══════════════════════════════════════════════════════
   SightOps — Frontend SPA
   ═══════════════════════════════════════════════════════ */

// ── Estado global ──────────────────────────────────────
let _token = localStorage.getItem('so_token') || null;
let _currentView = 'dashboard';
let _scanWs = null;
let _camAuthAction = null;

// ── Helpers HTTP ───────────────────────────────────────
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

// ── Confirmação customizada ────────────────────────────
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

// ── Toast ───────────────────────────────────────────────
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

// ── Auth ────────────────────────────────────────────────
async function login(user, pass) {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    return { ok: false, msg: err.detail || 'Credenciais inválidas' };
  }
  const data = await res.json();
  _token = data.access_token || data.token || null;
  if (_token) {
    localStorage.setItem('so_token', _token);
    return { ok: true };
  }
  return { ok: false, msg: 'Token não recebido' };
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

// ── Telas ───────────────────────────────────────────────
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

// ── Navegação ───────────────────────────────────────────
const VIEW_META = {
  dashboard:       { title: 'Dashboard',        sub: 'Visão geral do parque' },
  'inv-olt':       { title: 'Câmeras IP', sub: 'Varredura, filtros e casamento OLT/Switch' },
  'inv-switch':    { title: 'Câmeras IP · Switch', sub: 'Câmeras via switch gerenciável' },
  'inv-dvr':       { title: 'Inventário · DVR',  sub: 'Gravadores DVR' },
  'inv-nvr':       { title: 'Gravadores', sub: 'Canais NVR com câmeras associadas' },
  'inv-windows':   { title: 'Inventário · Windows', sub: 'Hosts Windows' },
  'snap-cam':      { title: 'Snapshots · Câmeras', sub: 'Fotos das câmeras IP' },
  'snap-dvr':      { title: 'Snapshots · DVR',   sub: 'Fotos dos canais DVR' },
  'snap-nvr':      { title: 'Snapshots · NVR',   sub: 'Fotos dos canais NVR' },
  'mnt-cam':       { title: 'Manutenção · Câmeras', sub: 'Operações em lote' },
  'mnt-dvr':       { title: 'Manutenção · DVR',  sub: 'Operações em lote' },
  'mnt-nvr':       { title: 'Manutenção · NVR',  sub: 'Operações em lote' },
  playback:        { title: 'Reprodução',       sub: 'Busca de gravações por DVR' },
  'ia-nvr':        { title: 'IA · NVR',          sub: 'Indexação e busca inteligente' },
  'net-devices':   { title: 'Rede · Dispositivos', sub: 'Dispositivos monitorados' },
  'net-learn':     { title: 'Rede · Aprendizado', sub: '' },
  'net-operate':   { title: 'Rede · Operações',  sub: '' },
  olt:             { title: 'OLT',               sub: 'Coleta de MACs da OLT' },
  switch:          { title: 'Switch',            sub: 'Coleta de MACs do switch' },
  kmz:             { title: 'KMZ · Mapa',        sub: 'Localização das câmeras' },
  'script-grafana':{ title: 'Scripts · Grafana', sub: '' },
  'script-netwatch':{ title: 'Scripts · Netwatch', sub: '' },
  'script-zabbix': { title: 'Scripts · Zabbix',  sub: '' },
  tools:           { title: 'Ferramentas',       sub: '' },
  backup:          { title: 'Backup',            sub: 'Exportação e importação' },
  settings:        { title: 'Configurações',     sub: '' },
};

const VIEW_ID_MAP = {
  dashboard:        'viewDashboard',
  'inv-olt':        'viewInvOlt',
  'inv-switch':     'viewInvSwitch',
  'inv-dvr':        'viewInvDvr',
  'inv-nvr':        'viewInvNvr',
  'inv-windows':    'viewInvWindows',
  'snap-cam':       'viewSnapCam',
  'snap-dvr':       'viewSnapDvr',
  'snap-nvr':       'viewSnapNvr',
  'mnt-cam':        'viewMntCam',
  'mnt-dvr':        'viewMntDvr',
  'mnt-nvr':        'viewMntNvr',
  playback:         'viewPlayback',
  'ia-nvr':         'viewIaNvr',
  'net-devices':    'viewNetDevices',
  'net-learn':      'viewNetLearn',
  'net-operate':    'viewNetOperate',
  olt:              'viewOlt',
  switch:           'viewSwitch',
  kmz:              'viewKmz',
  'script-grafana': 'viewScriptGrafana',
  'script-netwatch':'viewScriptNetwatch',
  'script-zabbix':  'viewScriptZabbix',
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
    case 'inv-dvr':     loadInvDvr();       break;
    case 'inv-nvr':     loadInvNvr();       break;
    case 'inv-windows': loadInvWindows();   break;
    case 'snap-cam':    loadSnapCam();      break;
    case 'snap-dvr':    loadSnapDvr();      break;
    case 'snap-nvr':    loadSnapNvr();      break;
    case 'mnt-cam':     loadMntCam();       break;
    case 'mnt-dvr':     loadMntDvr();       break;
    case 'mnt-nvr':     loadMntNvr();       break;
    case 'playback':    loadPlayback();     break;
    case 'ia-nvr':      loadIaNvr();        break;
    case 'olt':         loadOlt();          break;
    case 'switch':      loadSwitch();       break;
    case 'kmz':         loadKmz();          break;
    case 'backup':      loadBackup();       break;
    case 'net-devices': loadNetDevices();   break;
  }
}

// ── Sidebar mobile ──────────────────────────────────────
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('mobileBackdrop').classList.add('open');
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('mobileBackdrop').classList.remove('open');
}

// ── Dashboard ───────────────────────────────────────────
// ── Dashboard Drawer ─────────────────────────────────────────────
let _dashDrawerData = null;

function _openDashDrawer(eyebrow, title) {
  document.getElementById('dashDrawerEyebrow').textContent = eyebrow;
  document.getElementById('dashDrawerTitle').textContent = title;
  document.getElementById('dashDrawerBody').innerHTML = '<div style="padding:32px 20px;text-align:center;color:var(--muted);font-size:13px">Carregando…</div>';
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

function _drawerGoToInventory(view, searchValue) {
  closeDashDrawer();
  if (view === 'inv-olt' && searchValue) {
    _pendingOpenCamIp = searchValue;
  }
  setTimeout(() => {
    navigateTo(view);
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
  _openDashDrawer('Inventário', 'Câmeras IP');
  if (!_dashDrawerData?.ip) {
    const res = await apiJson('/api/cameras?mode=olt');
    if (!_dashDrawerData) _dashDrawerData = {};
    _dashDrawerData.ip = res?.cameras || [];
  }
  const rows = _dashDrawerData.ip;
  const isOnline  = r => ['online','ok','up','ativo','active'].includes((r.status||'').toLowerCase());
  const isOffline = r => ['offline','down','inativo','inactive','auth_failed','timeout','erro','error'].includes((r.status||'').toLowerCase());
  const noSnap    = r => !r.snapshot_url && !r.imgbb_url;

  const sites = [...new Set(rows.map(r => r.local || '').filter(Boolean))].sort((a,b) => a.localeCompare(b,'pt'));
  const counts = { all: rows.length, online: rows.filter(isOnline).length, offline: rows.filter(isOffline).length, no_snap: rows.filter(noSnap).length };

  _drawerFilterBar(
    [{ key:'all', label:'Todos', count:counts.all }, { key:'online', label:'● Online', count:counts.online },
     { key:'offline', label:'● Offline', count:counts.offline }, { key:'no_snap', label:'Sem snapshot', count:counts.no_snap }],
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
    return `<div class="drawer-item" style="cursor:pointer" onclick="_drawerGoToInventory('inv-olt','${ip}')" title="Abrir no inventário">
      ${_drawerStatusDot(r.status)}
      <div class="drawer-item-main">
        <div class="drawer-item-title">${esc(r.titulo || r.ip || '—')}</div>
        <div class="drawer-item-sub">${esc(r.ip)} · ${esc(r.local || '—')} · ${esc(r.modelo || r.model || '—')}</div>
      </div>
      ${r.snapshot_url ? `<img src="${esc(r.snapshot_url)}" style="width:52px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0" loading="lazy">` : '<span style="width:52px;flex-shrink:0"></span>'}
      <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--muted);flex-shrink:0"></i>
    </div>`;
  }).join(''));
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
    [{ key:'all', label:'Todos', count:counts.all }, { key:'online', label:'● Online', count:counts.online }, { key:'offline', label:'● Offline', count:counts.offline }],
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
    return `<div class="drawer-item" style="cursor:pointer" onclick="_drawerGoToInventory('${view}','${host}')" title="Abrir no inventário">
      ${_drawerStatusDot(r.status)}
      <div class="drawer-item-main">
        <div class="drawer-item-title">CH${String(r.channel||0).padStart(2,'0')} · ${esc(r.title || r.titulo || '—')}</div>
        <div class="drawer-item-sub">${esc(r.host||r.ip||'—')} · ${esc(r.local||'—')}</div>
      </div>
      ${r.snapshot_url ? `<img src="${esc(r.snapshot_url)}" style="width:52px;height:36px;object-fit:cover;border-radius:4px;flex-shrink:0" loading="lazy">` : '<span style="width:52px;flex-shrink:0"></span>'}
      <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--muted);flex-shrink:0"></i>
    </div>`;
  }).join(''));
}

async function openDashDrawerWindows(filterKey) {
  filterKey = filterKey || 'all';
  _openDashDrawer('Inventário', 'Windows');
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
    [{ key:'all', label:'Todos', count:counts.all }, { key:'online', label:'● Online', count:counts.online }, { key:'offline', label:'● Offline', count:counts.offline }],
    filterKey, [], null,
    k => openDashDrawerWindows(k), () => {}
  );

  let filtered = rows;
  if (filterKey === 'online')  filtered = filtered.filter(isOnline);
  if (filterKey === 'offline') filtered = filtered.filter(isOffline);

  filtered.sort((a, b) => (a.hostname || a.ip || '').localeCompare(b.hostname || b.ip || '', 'pt', { numeric: true }));
  _drawerRenderRows(filtered.map(r => `
    <div class="drawer-item" style="cursor:pointer" onclick="_drawerGoToInventory('inv-windows','')" title="Abrir no inventário">
      ${_drawerStatusDot(r.status)}
      <div class="drawer-item-main">
        <div class="drawer-item-title">${esc(r.hostname || r.ip || '—')}</div>
        <div class="drawer-item-sub">${esc(r.ip||'—')} · ${esc(r.local||r.site||'—')} · SSD: ${r.has_ssd ? 'Sim' : 'Não'}</div>
      </div>
      <i data-lucide="chevron-right" style="width:13px;height:13px;color:var(--muted);flex-shrink:0"></i>
    </div>`).join(''));
}

// ─────────────────────────────────────────────────────────────────
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
  const ipOnline = ip.online ?? '—';
  const ipTotal  = ip.total  ?? '';
  setText('mCamsOnline', ipOnline);
  setText('mCamsTotal',  ipTotal ? `de ${ipTotal} total` : '');

  const dvrRec = dvr.recorders ?? 0;
  const nvrRec = nvr.recorders ?? 0;
  setText('mDvrNvr',      `${dvrRec} DVR · ${nvrRec} NVR`);
  const dvrCh  = dvr.total ?? 0;
  const nvrCh  = nvr.total ?? 0;
  setText('mDvrNvrCanais', (dvrCh || nvrCh) ? `${dvrCh + nvrCh} canais` : '');

  setText('mSnapshots', tot.snapshots ?? '—');
  setText('mSites',     tot.sites     ?? '—');

  // Alertas — clicáveis
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

  // Status por tipo — clicáveis
  const statusGrid = document.getElementById('dashStatusGrid');
  const statusTypes = [
    { label: 'Câmeras IP',  icon: 'camera',     s: ip,  type: 'ip'      },
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
        ago = days  > 0 ? `${days}d atrás` :
              hrs   > 0 ? `${hrs}h atrás`  :
              mins  > 0 ? `${mins}min atrás` : 'agora';
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
    setText('dashSitesCount', `${sites.length} localidade${sites.length !== 1 ? 's' : ''} no inventário`);
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

// ── Inventário Câmeras IP ──────────────────────────────
const _invCam   = { basico: [], olt: [], switch: [] };
let _invOltView   = 'basico';
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

function updateCamTabs() {
  document.querySelectorAll('.inv-view-tab[data-view]').forEach(t => {
    const hasData = _invCam[t.dataset.view]?.length > 0;
    t.style.display = hasData ? '' : 'none';
  });
  if (!_invCam[_invOltView]?.length) {
    const first = ['basico','olt','switch'].find(m => _invCam[m]?.length > 0);
    if (first) setInvOltView(first);
  }
}

// Células base compartilhadas entre as 3 visões
function _camCell(c) {
  const imgbbUrl = c.imgbb_url || (isImgbbUrl(c.snapshot_url) ? c.snapshot_url : '');
  return {
    chk:       `<input type="checkbox" class="chk-olt" value="${esc(c.ip)}">`,
    ip:        `<span class="monospace text-primary">${esc(c.ip)}</span>`,
    mac:       `<span class="monospace" style="font-size:11px">${esc(c.mac||'—')}</span>`,
    fab:       `<span class="text-muted">${esc(c.fabricante||'—')}</span>`,
    modelo:    esc(c.modelo || c.model || '—'),
    titulo:    `<strong>${esc(c.titulo||'—')}</strong>`,
    status:    invStatusBadge(c.status),
    imgbb:     imgbbUrl ? `<a href="${esc(imgbbUrl)}" target="_blank" onclick="event.stopPropagation()" style="color:var(--primary);font-weight:700;font-size:12px;text-decoration:none">↑ up</a>` : `<span style="color:var(--danger);font-weight:700;font-size:12px">↓ down</span>`,
    local:     `<span class="text-muted">${esc(c.local||'—')}</span>`,
    pon:       `<span style="text-align:center;display:block;font-weight:500">${esc(c.pon||'—')}</span>`,
    onu_id:    `<span style="text-align:center;display:block;font-weight:500">${esc(c.onu_id||'—')}</span>`,
    onu_name:  `<span class="text-muted" style="font-size:11px">${esc(c.onu_name||'—')}</span>`,
    onu_ser:   `<span class="monospace text-muted" style="font-size:11px">${esc(c.onu_serial||'—')}</span>`,
    sw_ip:     `<span class="monospace text-muted">${esc(c.switch_ip||'—')}</span>`,
    sw_port:   `<span class="text-muted">${esc(c.switch_port||'—')}</span>`,
    sw_vlan:   `<span class="text-muted">${esc(c.switch_vlan||'—')}</span>`,
  };
}

const INV_COLS = {
  // Básico: IP, MAC, Fabricante, Modelo, Título, Status, ImgBB, Local  → 100%
  basico: {
    cols:  ['32px','10%','13%','9%','10%','20%','8%','6%','24%'],
    heads: ['',    'IP', 'MAC','Fabricante','Modelo','Título','Status','ImgBB','Local'],
    row: c => { const v = _camCell(c); return [v.chk, v.ip, v.mac, v.fab, v.modelo, v.titulo, v.status, v.imgbb, v.local]; },
  },
  // OLT: base enxuta + dados OLT  → 100%
  olt: {
    cols:  ['32px','8%','12%','8%','8%','11%','7%','6%','7%','5%','5%','12%','11%'],
    heads: ['',    'IP','MAC','Fabricante','Modelo','Título','Status','ImgBB','Local','PON','ONU ID','ONU Name','ONU Serial'],
    row: c => { const v = _camCell(c); return [v.chk, v.ip, v.mac, v.fab, v.modelo, v.titulo, v.status, v.imgbb, v.local, v.pon, v.onu_id, v.onu_name, v.onu_ser]; },
  },
  // Switch: base enxuta + dados Switch  → 100%
  switch: {
    cols:  ['32px','8%','12%','8%','8%','12%','7%','6%','8%','13%','8%','10%'],
    heads: ['',    'IP','MAC','Fabricante','Modelo','Título','Status','ImgBB','Local','Switch IP','Porta','VLAN'],
    row: c => { const v = _camCell(c); return [v.chk, v.ip, v.mac, v.fab, v.modelo, v.titulo, v.status, v.imgbb, v.local, v.sw_ip, v.sw_port, v.sw_vlan]; },
  },
};

function setInvOltView(view) {
  _invOltView = view;
  document.querySelectorAll('.inv-view-tab').forEach(t =>
    t.classList.toggle('active', t.dataset.view === view)
  );
  applyInvOltFilters();
}

// Persiste mapeamento ip→imgbb_url no sessionStorage
function _imgbbSave(ip, url) {
  try {
    const m = JSON.parse(sessionStorage.getItem('so_imgbb') || '{}');
    m[ip] = url;
    sessionStorage.setItem('so_imgbb', JSON.stringify(m));
  } catch {}
}
function _imgbbGet() {
  try { return JSON.parse(sessionStorage.getItem('so_imgbb') || '{}'); } catch { return {}; }
}
function _imgbbClear() {
  try { sessionStorage.removeItem('so_imgbb'); } catch {}
}

// ── Mapa de câmeras (Leaflet) ───────────────────────────
let _map            = null;
let _mapFeatures    = [];
let _mapLayers      = [];
let _mapLayerGroups = {}; // id → { group, active, features }

// Definição das camadas disponíveis
const MAP_LAYER_DEFS = [
  { id: 'cameras',  get label() { return sessionStorage.getItem('so_kmz_generated_name') || 'Câmeras do Inventário'; },
    color: '#16a34a', endpoint: '/api/kmz/generated/geojson', source: 'generated' },
  { id: 'imported', label: 'KMZ Importado', color: '#1971c2', endpoint: '/api/kmz/import/geojson', source: 'imported' },
];

async function loadKmz() {
  const container = document.getElementById('leafletMap');
  if (!container) return;

  if (!_map) {
    _map = L.map('leafletMap', { zoomControl: true }).setView([-9.76, -36.67], 14);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '© OpenStreetMap © CARTO',
      subdomains: 'abcd', maxZoom: 20,
    }).addTo(_map);
  }

  setTimeout(() => _map.invalidateSize(), 100);

  // Carrega e renderiza painel de camadas
  await loadMapLayers();

  // Nada mais a fazer aqui — as camadas são gerenciadas pelo painel
  setText('mapCounter', 'Selecione camadas no painel');

  // Índice de câmeras por nome
  const camByName = {};
  const camByIp   = {};
  (camData?.cameras || []).forEach(c => {
    if (c.titulo) camByName[c.titulo.toLowerCase()] = c;
    if (c.ip)     camByIp[c.ip] = c;
  });

  // Popula filtro de sites (extraído das propriedades)
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

  // Aguarda o container ter tamanho real antes de plotar
  setTimeout(() => {
    _map.invalidateSize();
    renderMapMarkers(camByName, camByIp);
  }, 200);
}

async function loadMapLayers() {
  const listEl = document.getElementById('mapLayersList');
  if (!listEl) return;

  listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:8px;text-align:center">Verificando…</div>';

  // Carrega cada camada em paralelo — importado já traz o original_name
  const results = await Promise.all(MAP_LAYER_DEFS.map(async def => {
    const data = await apiJson(def.endpoint);
    const features = data?.features || [];
    const label = def.id === 'imported' && data?.original_name
      ? data.original_name.replace(/\.(kmz|kml)$/i, '')
      : def.label;
    return { ...def, features, count: features.length, label };
  }));

  // Adiciona câmeras do inventário como camada especial
  const camData = await apiJson('/api/cameras');
  const cams = camData?.cameras || [];
  const camFeatures = cams
    .filter(c => c.lat && c.lon)
    .map(c => ({ type: 'Feature', _source: 'cameras',
      geometry: { type: 'Point', coordinates: [parseFloat(c.lon), parseFloat(c.lat)] },
      properties: { name: c.titulo || c.ip, description: `${c.ip} | ${c.status}` }
    }));

  // Monta painel de camadas
  const allLayers = [
    ...results,
    { id: 'cam-inventory', label: 'Câmeras (Inventário)', color: '#16a34a', features: _mapFeatures.filter(f => f._source === 'generated'), count: _mapFeatures.filter(f => f._source === 'generated').length, source: 'generated' }
  ].filter(l => l.count > 0 || l.id === 'imported');

  // Inicializa grupos de camadas
  _mapLayerGroups = {};
  results.forEach(r => {
    _mapLayerGroups[r.id] = { features: r.features, group: L.layerGroup(), active: false, color: r.color };
  });

  listEl.innerHTML = '';

  if (results.every(r => r.count === 0)) {
    listEl.innerHTML = '<div style="font-size:12px;color:var(--muted);padding:12px;text-align:center">Nenhuma camada disponível.<br><small>Importe um KMZ ou gere o mapa.</small></div>';
    return;
  }

  // Se o gerado existe, não mostra o importado (já foi processado)
  const generatedExists = results.find(r => r.id === 'cameras')?.count > 0;
  const visibleResults  = generatedExists
    ? results.filter(r => r.id !== 'imported')
    : results.filter(r => r.count > 0);

  visibleResults.forEach(def => {
    const btn = document.createElement('button');
    btn.className = 'map-layer-btn';
    btn.dataset.layerId = def.id;
    btn.innerHTML = `
      <span class="layer-dot" style="background:${def.color}"></span>
      <span style="flex:1;line-height:1.3">${def.label}</span>
      <span class="map-layer-badge">${def.count} pts</span>`;
    btn.onclick = () => toggleMapLayer(def.id, def);

    // Botão excluir
    const delBtn = document.createElement('button');
    delBtn.title = 'Excluir camada';
    delBtn.style.cssText = 'width:26px;height:26px;flex-shrink:0;border:1px solid #ffc9c9;border-radius:6px;background:var(--danger-soft);color:var(--danger);cursor:pointer;display:grid;place-items:center;margin-left:4px';
    delBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      const ok = await showConfirm({ title: 'Excluir camada', msg: `Remover "${def.label}" do mapa e do servidor?`, label: 'Excluir' });
      if (!ok) return;
      // Remove do mapa
      const state = _mapLayerGroups[def.id];
      if (state?.active) { _map.removeLayer(state.group); state.active = false; }
      delete _mapLayerGroups[def.id];
      // Tenta limpar no servidor
      if (def.id === 'imported') {
        await api('/api/kmz/import/locations/apply', { method: 'POST', body: '{}', skipLogout: true }).catch(() => {});
      }
      btn.closest('.map-layer-row')?.remove();
      setText('mapCounter', 'Camada removida');
      showToast(`"${def.label}" removida do mapa.`);
    };

    const row = document.createElement('div');
    row.className = 'map-layer-row';
    row.style.cssText = 'display:flex;align-items:center;gap:0';
    row.appendChild(btn);

    // Botão download — adicionado ao row após criação
    const dlEndpoints = { cameras: '/api/kmz/generated/download', imported: '/api/kmz/import/download' };
    const dlFilenames = { cameras: 'cameras-gerado.kmz', imported: 'importado.kmz' };
    if (dlEndpoints[def.id]) {
      const dlBtn = document.createElement('button');
      dlBtn.title = 'Download KMZ';
      dlBtn.style.cssText = 'width:26px;height:26px;flex-shrink:0;border:1px solid var(--border);border-radius:6px;background:var(--surface-soft);color:var(--muted);cursor:pointer;display:grid;place-items:center';
      dlBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
      dlBtn.onclick = (e) => { e.stopPropagation(); downloadWithAuth(dlEndpoints[def.id], dlFilenames[def.id]); };
      row.appendChild(dlBtn);
    }

    row.appendChild(delBtn);
    listEl.appendChild(row);
  });

  // Ativa automaticamente a primeira camada visível com dados
  const first = visibleResults.find(r => r.count > 0);
  if (first) toggleMapLayer(first.id, first);
}

async function toggleMapLayer(id, def) {
  if (!_map) return;
  const state = _mapLayerGroups[id];
  if (!state) return;

  if (state.active) {
    _map.removeLayer(state.group);
    state.group.clearLayers();
    state.active = false;
  } else {
    // Índice de câmeras para o popup rico
    const camData2 = await apiJson('/api/cameras');
    const camByName2 = {}, camByIp2 = {};
    (camData2?.cameras || []).forEach(c => {
      if (c.titulo) camByName2[c.titulo.toLowerCase()] = c;
      if (c.ip)     camByIp2[c.ip] = c;
    });

    // Renderiza os pontos neste grupo
    state.group = L.layerGroup();
    const bounds = [];
    state.features.forEach(f => {
      if (f.geometry?.type !== 'Point') return;
      const [lng, lat] = f.geometry.coordinates;
      if (lat == null || lng == null || isNaN(+lat) || isNaN(+lng)) return;

      // Detecta tipo pelo nome para ícone correto
      const name = f.properties?.name || '';
      const pointType = /\bcto\b|^cto/i.test(name) ? 'cto'
                      : /\bcdo\b|^cdo|emenda|splice/i.test(name) ? 'cdo'
                      : f._source === 'generated' ? 'camera' : 'other';
      const typeConfig = {
        camera: { bg: '#16a34a', label: '📷' },
        cto:    { bg: '#1971c2', label: 'CTO' },
        cdo:    { bg: '#7950f2', label: 'CDO' },
        other:  { bg: def?.color || '#d97706', label: '●' },
      };
      const tc = typeConfig[pointType];
      const icon = L.divIcon({
        html: `<div style="background:${tc.bg};color:white;border:2px solid white;border-radius:6px;padding:2px 5px;font-size:10px;font-weight:700;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.4);cursor:pointer">${tc.label}</div>`,
        className: '', iconSize: [40, 22], iconAnchor: [20, 11], popupAnchor: [0, -14],
      });
      const marker = L.marker([+lat, +lng], { icon });
      // Popup rico e moderno
      const cam = camByName2[name.toLowerCase()] || Object.values(camByIp2).find(c => c.titulo?.toLowerCase() === name.toLowerCase()) || null;
      const isOnlinePop = (f.properties?.description || '').includes('ONLINE');
      const statusColor = isOnlinePop ? '#16a34a' : '#dc2626';
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
              <div style="color:${isOnlinePop?'#69db7c':'#ff8787'};font-size:12px;font-weight:600">${isOnlinePop?'● ONLINE':'○ OFFLINE'}</div>
            </div>
          </div>`
        : `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;padding-bottom:8px;border-bottom:2px solid #f1f3f5">
            <strong style="font-size:14px">${esc(name)}</strong>
            <span style="background:${statusColor}22;color:${statusColor};font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px">${isOnlinePop?'ONLINE':'OFFLINE'}</span>
          </div>`;

      marker.bindPopup(`
        <div style="width:280px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:14px;overflow:hidden">
          ${snapHtml}
          ${row('📷','Câmera', cam?.model || cam?.fabricante)}
          ${row('📍','Local',  cam?.local)}
          ${row('🌐','IP', cam?.ip ? `<a href="http://${esc(cam.ip)}" target="_blank" style="color:#1971c2">${esc(cam.ip)}</a>` : '')}
          ${row('💾','MAC',    cam?.mac, true)}
          ${row('📡','PON/ONU', cam?.pon || cam?.onu_id ? [cam?.pon,cam?.onu_id].filter(Boolean).join(' / ') : '')}
          ${row('🔑','ONU Serial', cam?.onu_serial, true)}
          <div style="margin-top:8px;padding-top:6px;font-size:10px;color:#adb5bd;font-family:monospace;word-break:break-all">
            📌 ${(+lat2).toFixed(7)}, ${(+lng2).toFixed(7)}
          </div>
          ${cam?.ip ? `<div style="margin-top:10px;display:flex;gap:6px">
            <a href="http://${esc(cam.ip)}" target="_blank" style="flex:1;text-align:center;padding:6px;background:#e7f5ff;color:#1971c2;border-radius:6px;font-size:11px;font-weight:600;text-decoration:none;border:1px solid #a5d8ff">Abrir câmera</a>
          </div>` : ''}
        </div>`, { maxWidth: 320, className: 'sightops-popup' });
      state.group.addLayer(marker);
      bounds.push([+lat, +lng]);
    });

    _map.addLayer(state.group);
    state.active = true;

    if (bounds.length > 0) {
      try { _map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 }); } catch {}
    }
  }

  // Atualiza botão visual
  const btn = document.querySelector(`[data-layer-id="${id}"]`);
  if (btn) btn.classList.toggle('active', state.active);

  // Atualiza contador
  const totalShown = Object.values(_mapLayerGroups).filter(s => s.active).reduce((a, s) => a + s.features.length, 0);
  setText('mapCounter', `${totalShown} ponto${totalShown !== 1 ? 's' : ''} visíveis`);
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
    const isOnline  = desc.includes('ONLINE');
    const isOffline = desc.includes('OFFLINE') || (!isOnline && desc.includes('STATUS'));
    const statusStr = isOnline ? 'online' : isOffline ? 'offline' : 'outros';

    if (statusFilter && statusStr !== statusFilter) return;
    if (siteFilter) {
      const m = desc.match(/LOCAL.*?>(.*?)</i);
      const local = m ? m[1].trim() : '';
      if (local !== siteFilter) return;
    }

    // Busca dados da câmera para popup
    const cam = camByName[name.toLowerCase()] || Object.values(camByIp).find(c =>
      c.titulo?.toLowerCase() === name.toLowerCase()
    );

    // Detecta tipo pelo nome
    const nameLow = name.toLowerCase();
    let pointType = 'other';
    if (!f._source || f._source === 'generated') {
      pointType = 'camera';
    } else if (/\bcto\b|^cto/i.test(name)) {
      pointType = 'cto';
    } else if (/\bcdo\b|^cdo|emenda|splice/i.test(name)) {
      pointType = 'cdo';
    } else if (/cam|camera|vip-|vipc|vip\s|\bcam\s/i.test(name)) {
      pointType = 'camera';
    }

    const typeConfig = {
      camera: { bg: isOnline ? '#16a34a' : '#dc2626', label: '📷' },
      cto:    { bg: '#1971c2', label: 'CTO' },
      cdo:    { bg: '#7950f2', label: 'CDO' },
      other:  { bg: '#d97706', label: '●' },
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
    const snapHtml = cam?.snapshot_url
      ? `<img src="${API_BASE}${cam.snapshot_url}" style="width:100%;display:block;max-height:150px;object-fit:cover">`
      : isImported
        ? `<div style="width:100%;height:60px;background:#2d3748;display:flex;align-items:center;justify-content:center;color:#a0aec0;font-size:11px;gap:6px">📍 Ponto importado</div>`
        : `<div style="width:100%;height:80px;background:#1a1a2e;display:flex;align-items:center;justify-content:center;color:#4a5568;font-size:12px">Sem snapshot</div>`;

    const statusBadge = isOnline
      ? `<span style="color:#16a34a;font-weight:700">● online</span>`
      : `<span style="color:#dc2626;font-weight:700">○ offline</span>`;

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
              📍 Google Maps
            </a>
            ${cam?.ip ? `<a href="http://${cam.ip}" target="_blank"
               style="flex:1;text-align:center;padding:5px;background:#f1f5f9;border-radius:5px;font-size:11px;color:#374151;text-decoration:none">
              🔗 Câmera
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
  if (!_invCam.basico.length && !_invCam.olt.length && !_invCam.switch.length) {
    await _loadCamForMode(_invOltView);
  }
  updateCamTabs();
  populateCamSiteFilter();
  applyInvOltFilters();
}

async function _loadCamForMode(mode) {
  const [camData, swData, oltData] = await Promise.all([
    apiJson('/api/cameras'),
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

  // Mescla imgbb_url da sessão
  const saved = _imgbbGet();
  if (Object.keys(saved).length) {
    cameras = cameras.map(c => saved[c.ip] ? { ...c, imgbb_url: saved[c.ip] } : c);
  }

  // Ordena por IP
  const ipToInt = ip => (ip||'0.0.0.0').split('.').reduce((a,b) => (a<<8)|(parseInt(b)||0), 0)>>>0;
  cameras.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));

  _invCam[mode] = cameras;
  _camSessionSave(mode, cameras);
}

function populateCamSiteFilter() {
  const all   = Object.values(_invCam).flat();
  const sites = [...new Set(all.map(c => c.local).filter(Boolean))].sort();
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
  // texto livre
  return true;
}

function _isBlankValue(value) {
  const s = String(value ?? '').trim();
  return !s || s === '—' || s === '-' || /^n\/?a$/i.test(s);
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
    /^c[âa]mera\s*\d{1,3}$/i,
    /^camera\s*\d{1,3}$/i,
    /^cam\s*\d{1,3}$/i,
    /camera\s*0?\d{1,3}/i,
    /c[âa]mera\s*0?\d{1,3}/i,
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
  return !(c.imgbb_url || isImgbbUrl(c.snapshot_url));
}

function camHasNoOltData(c) {
  return [c.pon, c.onu_id, c.onu_name, c.onu_serial].some(_isBlankValue);
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
    if (site   && c.local !== site) return false;
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
}

function renderInvOlt(cameras) {
  const def   = INV_COLS[_invOltView] || INV_COLS.basico;
  const ncols = def.cols.length;
  const tbody = document.getElementById('invOltTable');
  const table = document.getElementById('invOltTableEl');

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
  setText('invOltFooter',  `${cameras.length} câmera${cameras.length!==1?'s':''}`);

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
  if (!status) return '<span class="text-muted">—</span>';
  const s = status.toLowerCase();
  if (s === 'online')      return `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`;
  if (s === 'offline')     return `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`;
  if (s === 'auth_failed') return `<span style="color:var(--amber);font-weight:600;font-size:12px">auth_failed</span>`;
  return `<span style="color:var(--muted);font-size:12px">${esc(status)}</span>`;
}

// ── Painel lateral da câmera ────────────────────────────
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
  header.textContent = cam.status || '—';
  header.style.color = statusColor;
  setText('camPanelTitulo', cam.titulo || cam.ip);
  setText('cpMac',    cam.mac    || '—');
  setText('cpModelo', cam.model  || '—');
  setText('cpLocal',  cam.local  || '—');
  setText('cpPonOnu', [cam.pon, cam.onu_id].filter(Boolean).join(' / ') || '—');
  setText('cpSerial', cam.onu_serial || '—');

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

// ── Ping Terminal ───────────────────────────────────────
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

  pingLine(`Iniciando ping para ${ip}…`, 'info');

  _pingInterval = setInterval(async () => {
    _pingCount++;
    const startedAt = performance.now();
    const res = await apiJson(`/api/cameras/ping?ip=${encodeURIComponent(ip)}`);
    const elapsedMs = performance.now() - startedAt;
    const rawMs = res?.ping_ms ?? res?.ms ?? res?.latency;
    const ms = Number.isFinite(Number(rawMs)) ? Number(rawMs) : elapsedMs;
    const ok  = res?.ok ?? res?.reachable ?? (ms != null && ms >= 0);

    if (ok) {
      _pingOk++;
      pingLine(`[${_pingCount}] ${ip}: ${formatPingMs(ms)}`, 'ok');
    } else {
      _pingFail++;
      pingLine(`[${_pingCount}] ${ip}: timeout (${formatPingMs(elapsedMs)})`, 'fail');
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
    `Enviados: ${_pingCount}  ·  OK: ${_pingOk}  ·  Falhas: ${_pingFail}  ·  Perda: ${loss}%`;
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

// ── Ações do painel ─────────────────────────────────────
function openCamAuthAction(action) {
  if (!_invOltActive) return;
  const cam = _invOltActive;
  const labels = {
    atualizar: { title: 'Atualizar snapshot', icon: 'refresh-cw', label: 'Atualizar' },
    reboot: { title: 'Reboot da câmera', icon: 'power', label: 'Reboot' },
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
    throw new Error(data?.error || first.error || 'Erro ao reiniciar câmera.');
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
    erro.textContent = 'Informe a senha da câmera.';
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
    erro.textContent = err.message || 'Falha ao executar ação.';
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
    document.getElementById('trocarSenhaIp').value      = `${cam.ip}  —  ${cam.titulo || ''}`;
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
    document.getElementById('dataHoraIp').value    = `${cam.ip}  —  ${cam.titulo || ''}`;
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
    if (!await showConfirm({ title: `Remover câmera`, msg: `Remover ${cam.ip} — ${cam.titulo || ''} do inventário?`, label: 'Remover' })) return;
    await api('/api/inventory/delete', { method: 'POST', body: JSON.stringify({ ips: [cam.ip] }) });
    showToast('Câmera removida.');
    closeCamPanel();
    loadInvOlt();
    return;
  }
}

// ── Inventário DVR ──────────────────────────────────────
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
      <td>${esc(d.brand || '—')} ${esc(d.model || '')}</td>
      <td class="text-muted">${esc(d.channels || '—')}</td>
      <td class="text-muted monospace">${esc(d.firmware || '—')}</td>
      <td class="text-muted">${esc(d.last_snapshot || '—')}</td>
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

// ── Inventário NVR ──────────────────────────────────────
// Gravadores — NVR e DVR com dados por modo
const _invNvr   = { basico: [], olt: [], switch: [] };
const _invDvr   = { basico: [], olt: [], switch: [] };
let _invNvrView   = 'basico';
let _recType      = 'nvr'; // 'nvr' | 'dvr'
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
    ? `<a href="${esc(url)}" target="_blank" onclick="event.stopPropagation()" style="color:var(--primary);font-weight:700;font-size:12px;text-decoration:none">↑ up</a>`
    : `<span style="color:var(--danger);font-weight:700;font-size:12px">↓ down</span>`;
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

const NVR_COLS = {
  basico: {
    cols: ['32px','9%','8%','4%','14%','8%','7%','6%','9%','10%','12%','9%','5%'],
    heads: ['','Host NVR','Modelo NVR','CH','Título','Local','Status','ImgBB','IP Câmera','Modelo Câm.','MAC Câmera','Serial','V.Loss'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace">${esc(r.host||'—')}</span>`,
      `<span class="text-muted">${esc(r.nvr_model||'—')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??'—'))}</span>`,
      `<strong>${esc(r.title||'—')}</strong>`,
      esc(r.local||'—'),
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted">${esc(r.camera_ip||'—')}</span>`,
      `<span class="text-muted">${esc(r.camera_model||r.modelo||'—')}</span>`,
      `<span class="monospace text-muted" style="font-size:11px">${esc(r.camera_mac||r.mac||'—')}</span>`,
      `<span class="text-muted">${esc(r.equip_serial||'—')}</span>`,
      r.video_loss
        ? `<span style="color:var(--danger);font-weight:600;font-size:11px">SIM</span>`
        : `<span class="text-muted" style="font-size:11px">não</span>`,
    ],
  },
  olt: {
    cols: ['32px','9%','4%','13%','8%','7%','6%','9%','10%','4%','5%','14%','13%'],
    heads: ['','Host NVR','CH','Título','Local','Status','ImgBB','IP Câmera','Modelo Câm.','PON','ONU ID','ONU Name','ONU Serial'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace">${esc(r.host||'—')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??'—'))}</span>`,
      `<strong>${esc(r.title||'—')}</strong>`,
      esc(r.local||'—'),
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted">${esc(r.camera_ip||'—')}</span>`,
      `<span class="text-muted">${esc(r.camera_model||r.modelo||'—')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.pon||'—'))}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.onu_id||'—'))}</span>`,
      `<span class="text-muted" style="font-size:11px">${esc(r.onu_name||'—')}</span>`,
      `<span class="monospace text-muted" style="font-size:11px">${esc(r.onu_serial||'—')}</span>`,
    ],
  },
  switch: {
    cols: ['32px','10%','4%','14%','8%','7%','6%','10%','10%','12%','9%','10%'],
    heads: ['','Host NVR','CH','Título','Local','Status','ImgBB','IP Câmera','Modelo Câm.','Switch IP','Porta','VLAN'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace">${esc(r.host||'—')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??'—'))}</span>`,
      `<strong>${esc(r.title||'—')}</strong>`,
      esc(r.local||'—'),
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted">${esc(r.camera_ip||'—')}</span>`,
      `<span class="text-muted">${esc(r.camera_model||r.modelo||'—')}</span>`,
      `<span class="monospace text-muted">${esc(r.switch_ip||'—')}</span>`,
      `<span class="text-muted">${esc(r.switch_port||'—')}</span>`,
      `<span class="text-muted">${esc(r.switch_vlan||'—')}</span>`,
    ],
  },
};

const DVR_COLS = {
  basico: {
    cols: ['32px','11%','5%','16%','9%','7%','6%','13%','10%','11%','6%','6%'],
    heads: ['','Host DVR','CH','Título','Local','Status','ImgBB','MAC DVR','Modelo','Serial','V.Loss','Foto'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace">${esc(r.host||'—')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??'—'))}</span>`,
      `<strong>${esc(r.title||'—')}</strong>`,
      esc(r.local||'—'),
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted" style="font-size:11px">${esc(r.mac||'—')}</span>`,
      `<span class="text-muted">${esc(r.modelo||'—')}</span>`,
      `<span class="text-muted">${esc(r.equip_serial||'—')}</span>`,
      r.video_loss ? `<span style="color:var(--danger);font-weight:600;font-size:11px">SIM</span>` : `<span class="text-muted" style="font-size:11px">não</span>`,
      r.snapshot_url ? `<a href="${esc(r.snapshot_url)}" target="_blank" style="color:var(--primary);font-size:12px">↑ ver</a>` : `<span class="text-muted">—</span>`,
    ],
  },
  olt: {
    cols: ['32px','10%','4%','13%','8%','7%','6%','5%','5%','14%','13%','15%'],
    heads: ['','Host DVR','CH','Título','Local','Status','ImgBB','PON','ONU ID','ONU Name','ONU Serial','MAC DVR'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace">${esc(r.host||'—')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??'—'))}</span>`,
      `<strong>${esc(r.title||'—')}</strong>`,
      esc(r.local||'—'),
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span style="text-align:center;display:block">${esc(String(r.pon||'—'))}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.onu_id||'—'))}</span>`,
      `<span class="text-muted" style="font-size:11px">${esc(r.onu_name||'—')}</span>`,
      `<span class="monospace text-muted" style="font-size:11px">${esc(r.onu_serial||'—')}</span>`,
      `<span class="monospace text-muted" style="font-size:11px">${esc(r.mac||'—')}</span>`,
    ],
  },
  switch: {
    cols: ['32px','11%','4%','15%','8%','7%','6%','12%','10%','11%','16%'],
    heads: ['','Host DVR','CH','Título','Local','Status','ImgBB','Switch IP','Porta','VLAN','MAC DVR'],
    row: r => [
      `<input type="checkbox" class="chk-nvr" value="${esc(r.host+'_'+r.channel)}" data-host="${esc(r.host||'')}" data-channel="${esc(String(r.channel||''))}">`,
      `<span class="monospace">${esc(r.host||'—')}</span>`,
      `<span style="text-align:center;display:block">${esc(String(r.channel??'—'))}</span>`,
      `<strong>${esc(r.title||'—')}</strong>`,
      esc(r.local||'—'),
      (r.status||'').toLowerCase()==='online'
        ? `<span style="color:var(--primary);font-weight:600;font-size:12px">online</span>`
        : `<span style="color:var(--danger);font-weight:600;font-size:12px">offline</span>`,
      recImgbbCell(r),
      `<span class="monospace text-muted">${esc(r.switch_ip||'—')}</span>`,
      `<span class="text-muted">${esc(r.switch_port||'—')}</span>`,
      `<span class="text-muted">${esc(r.switch_vlan||'—')}</span>`,
      `<span class="monospace text-muted" style="font-size:11px">${esc(r.mac||'—')}</span>`,
    ],
  },
};

async function enrichRecRowsForMode(rows, mode) {
  if (!['olt', 'switch'].includes(mode) || !rows.length) return rows;
  const [camData, oltData] = await Promise.all([
    apiJson('/api/cameras'),
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
    const first = ['basico','olt','switch'].find(m => store[m]?.length > 0);
    if (first) setNvrView(first);
  }
}

function setRecType(type) {
  _recType = type;
  document.querySelectorAll('[data-rec-type]').forEach(t =>
    t.classList.toggle('active', t.dataset.recType === type)
  );
  updateNvrTabs();
  populateNvrFilters();
  applyNvrFilters();
}

async function loadInvNvr() {
  _recSessionLoad(); // restaura NVR e DVR da sessão
  const hasAny = ['basico','olt','switch'].some(m => _invNvr[m]?.length || _invDvr[m]?.length);
  if (!hasAny) {
    await _loadRecBasico();
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

// ── Inventário Windows ──────────────────────────────────
function recEndpointBase() {
  return _recActive?._type === 'dvr' ? '/api/dvr' : '/api/nvr';
}

function recTypeName(type = _recActive?._type) {
  return type === 'dvr' ? 'Analógico (DVR)' : 'NVR · IP';
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
  status.textContent = r.status || '—';
  status.style.color = isOnline ? 'var(--primary)' : 'var(--danger)';
  setText('recPanelTitulo', r.title || `${r.host} CH${r.channel}`);
  setText('rpTipo', recTypeName(r._type));
  setText('rpHost', r.host || '—');
  setText('rpChannel', r.channel || '—');
  setText('rpLocal', r.local || '—');
  setText('rpModelo', r._type === 'dvr' ? (r.modelo || r.model || '—') : (r.camera_model || r.modelo || r.nvr_model || '—'));
  setText('rpCameraIp', r._type === 'dvr' ? 'analógico' : (r.camera_ip || '—'));
  setText('rpMac', r._type === 'dvr' ? (r.mac || '—') : (r.camera_mac || r.mac || '—'));
  setText('rpPonOnu', [r.pon, r.onu_id].filter(Boolean).join(' / ') || '—');
  setText('rpSerial', r.equip_serial || r.onu_serial || '—');
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
  setText('recActionEyebrow', `${recTypeName(r._type)} · ${r.host} CH${r.channel}`);
  setText('recActionTitle', meta.title);
  document.getElementById('recActionTarget').value = `${r.host} · canal ${r.channel} · ${r.title || ''}`;
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
  setText('recActionNewIpLabel', r._type === 'nvr' && r.camera_ip ? 'Novo IP da câmera do canal' : 'Novo IP do gravador');
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
    if (!title) { erro.textContent = 'Informe o título do canal.'; erro.hidden = false; return; }
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
    if (newPass !== conf) { erro.textContent = 'As senhas não coincidem.'; erro.hidden = false; return; }
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
    if (!res?.ok || body?.ok === false) throw new Error(body?.detail || body?.error || 'Falha ao executar ação.');
    closeRecAction();
    showToast('Ação concluída.');
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
    erro.textContent = err.message || 'Falha ao executar ação.';
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
    count === 1 ? `Editar ${typeLabel} · ${rows[0].host} ch${rows[0].channel}` : `Editar ${count} canais ${typeLabel}`;
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
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="title" style="${s}" value="${esc(r.title || '')}" placeholder="Título"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="local" style="${s}" value="${esc(r.local || '')}" placeholder="Local"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="${_recType === 'dvr' ? 'modelo' : 'camera_model'}" style="${s}" value="${esc(model)}" placeholder="Modelo"></td>
        <td><input data-host="${esc(r.host || '')}" data-channel="${esc(String(r.channel || ''))}" data-field="camera_ip" style="${s};font-family:monospace" value="${esc(camIp)}" placeholder="IP câmera"${_recType === 'dvr' ? ' disabled' : ''}></td>
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
    el.textContent = body?.detail || body?.error || 'Canais não foram salvos. Verifique e tente novamente.';
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

async function loadInvWindows() {
  const data = await apiJson('/api/windows/inventory');
  const hosts = data?.hosts || data || [];
  const tbody = document.getElementById('invWindowsTable');
  if (!hosts.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhum host encontrado.</td></tr>';
    setText('invWindowsFooter', '0 hosts');
    return;
  }
  tbody.innerHTML = hosts.map(h => `
    <tr>
      <td class="monospace">${esc(h.ip)}</td>
      <td>${esc(h.hostname || '—')}</td>
      <td class="text-muted">${esc(h.os || '—')}</td>
      <td class="text-muted">${esc(h.user || '—')}</td>
      <td class="text-muted">${esc(h.last_scan || '—')}</td>
      <td></td>
    </tr>`).join('');
  setText('invWindowsFooter', `${hosts.length} host${hosts.length !== 1 ? 's' : ''}`);
}

// ── Snapshots ───────────────────────────────────────────
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
    grid.innerHTML = '<p style="padding:40px;color:var(--muted);grid-column:1/-1;text-align:center">Nenhuma câmera encontrada.</p>';
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
          <span style="color:${statusCl};font-weight:600">${esc(c.status||'—')}</span>
        </div>
      </div>
      <div style="padding:10px 12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:2px">${esc(c.titulo||'—')}</div>
        <div style="font-size:11px;color:var(--muted);display:flex;justify-content:space-between">
          <span>${esc(c.local||'—')}</span>
          <span>${esc(c.model||'—')}</span>
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

// ── Carrossel de Gravadores (DVR+NVR) ───────────────────
function openCarrosselGrav(rows, idx) {
  // Reutiliza o mesmo carrossel de câmeras mas com dados de gravadores
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

// ── Carrossel de Snapshots ──────────────────────────────
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
  setText('carSub',   `${c.ip}  ·  ${c.local || ''}  ·  ${c.model || ''}`);

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
          <span style="color:${statusCl};font-weight:600">${esc(r.status||'—')}</span>
        </div>
      </div>
      <div style="padding:10px 12px">
        <div style="font-weight:600;font-size:13px;margin-bottom:2px">${esc(r.title||'—')}</div>
        <div style="font-size:11px;color:var(--muted);display:flex;justify-content:space-between">
          <span>${esc(r.local||'—')}</span>
          <span>${esc(r.modelo||'—')}</span>
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
        <div class="snap-card-sub">${esc(n.brand || '')} · ${esc(n.channels || '?')} canais</div>
      </div>
    </div>`).join('');
}

// ── Manutenção ──────────────────────────────────────────
let _mntCamAll = [];
const _mntCamFilter = { q: '', site: '', status: '' };

async function loadMntCam() {
  const grid = document.getElementById('mntCamGrid');
  if (!grid) return;
  grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted)">Carregando…</div>';
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

  let filtered = _mntCamAll.filter(c => {
    if (site && (c.local || '') !== site) return false;
    if (status && (c.status || '').toLowerCase() !== status) return false;
    if (q) {
      const ql = q.toLowerCase();
      if (![c.ip, c.titulo, c.local, c.modelo, c.model].some(f => (f || '').toLowerCase().includes(ql))) return false;
    }
    return true;
  });

  filtered.sort((a, b) => (a.titulo || a.ip || '').localeCompare(b.titulo || b.ip || '', 'pt', { numeric: true }));

  if (!filtered.length) {
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--muted)">Nenhuma câmera encontrada.</div>';
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
      <div class="mnt-cam-card${sel ? ' selected' : ''}" data-ip="${esc(ip)}" onclick="_mntCamCardClick(this,event)">
        <input type="checkbox" class="mnt-cam-card-chk chk-mnt-cam" value="${esc(ip)}" ${sel ? 'checked' : ''} onclick="event.stopPropagation();_mntCamToggle(this)">
        <div class="mnt-cam-card-img">
          ${snap ? `<img src="${esc(snap)}" loading="lazy" onerror="this.style.display='none'">` : `<div class="mnt-cam-no-snap"><i data-lucide="camera-off" style="width:22px;height:22px"></i></div>`}
          <span class="mnt-cam-dot ${dot}"></span>
        </div>
        <div class="mnt-cam-card-info">
          <div class="mnt-cam-card-title">${esc(c.titulo || ip)}</div>
          <div class="mnt-cam-card-sub">${esc(ip)} · ${esc(c.local || '—')}</div>
          <div class="mnt-cam-card-sub">${esc(c.modelo || c.model || '—')}</div>
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

function _mntLog(consoleId, bodyId, ip, msg, ok) {
  document.getElementById(consoleId)?.classList.remove('hidden');
  const body = document.getElementById(bodyId);
  if (body) {
    const line = document.createElement('div');
    line.innerHTML = `<span style="color:${ok ? '#6ee7b7' : '#fca5a5'}">${ok ? '✓' : '✗'}</span> <span style="color:#8ab">${esc(ip || '')}</span>${ip ? ' — ' : ''}${esc(msg)}`;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }
  if (ip) {
    const res = document.getElementById(`mntRes_${ip.replace(/\./g,'_')}`);
    if (res) res.innerHTML = `<span style="color:${ok ? 'var(--primary)' : 'var(--danger)'}">${ok ? '✓' : '✗'} ${esc(msg)}</span>`;
  }
}

async function _mntCamRunAction(endpoint, extra = {}) {
  const ips = [...document.querySelectorAll('.chk-mnt-cam:checked')].map(c => c.value);
  if (!ips.length) { showToast('Selecione ao menos uma câmera', true); return; }
  const user = document.getElementById('mntCamUser')?.value?.trim() || 'admin';
  const pass = document.getElementById('mntCamPass')?.value || '';

  const body = document.getElementById('mntCamConsoleBody');
  if (body) body.innerHTML = '';
  _mntLog('mntCamConsole', 'mntCamConsoleBody', '', `[${new Date().toLocaleTimeString('pt-BR')}] ${endpoint.toUpperCase()} em ${ips.length} câmera(s)…`, true);

  try {
    const res  = await api(`/api/maintenance/batch/${endpoint}`, { method:'POST', body: JSON.stringify({ ips, user, pass, ...extra }) });
    const data = await res.json().catch(() => ({}));
    (data.results || []).forEach(r => _mntLog('mntCamConsole', 'mntCamConsoleBody', r.ip || '', r.message || (r.ok ? 'OK' : r.error || 'Erro'), r.ok));
    if (!(data.results || []).length) _mntLog('mntCamConsole', 'mntCamConsoleBody', '', data.message || 'Concluído', data.ok !== false);
    showToast(data.message || `${endpoint}: concluído`);
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
      <td>${esc(d.brand || d.fabricante || '—')} ${esc(d.model || d.modelo || '')}</td>
      <td>${esc(d.local || d.site || '—')}</td>
      <td>${statusBadge(d.status)}</td>
      <td class="text-muted" id="mntDvrRes_${ip.replace(/\./g,'_')}">—</td>
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
  _mntLog('mntDvrConsole', 'mntDvrConsoleBody', '', `[${new Date().toLocaleTimeString('pt-BR')}] ${endpoint.toUpperCase()} em ${ips.length} DVR(s)…`, true);
  try {
    const res  = await api(`/api/maintenance/batch/${endpoint}`, { method:'POST', body: JSON.stringify({ ips, user, pass }) });
    const data = await res.json().catch(() => ({}));
    (data.results || []).forEach(r => {
      const ip = r.ip || r.host || '';
      _mntLog('mntDvrConsole', 'mntDvrConsoleBody', ip, r.message || (r.ok ? 'OK' : r.error || 'Erro'), r.ok);
      const el = document.getElementById(`mntDvrRes_${ip.replace(/\./g,'_')}`);
      if (el) el.innerHTML = `<span style="color:${r.ok ? 'var(--primary)' : 'var(--danger)'}">${r.ok ? '✓' : '✗'} ${esc(r.message || (r.ok ? 'OK' : 'Erro'))}</span>`;
    });
    if (!(data.results || []).length) _mntLog('mntDvrConsole', 'mntDvrConsoleBody', '', data.message || 'Concluído', data.ok !== false);
    showToast(data.message || `${endpoint}: concluído`);
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
      <td>${esc(n.brand || n.fabricante || '—')} ${esc(n.model || n.modelo || '')}</td>
      <td>${esc(n.local || n.site || '—')}</td>
      <td>${statusBadge(n.status)}</td>
      <td class="text-muted" id="mntNvrRes_${ip.replace(/\./g,'_')}">—</td>
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
  _mntLog('mntNvrConsole', 'mntNvrConsoleBody', '', `[${new Date().toLocaleTimeString('pt-BR')}] ${endpoint.toUpperCase()} em ${ips.length} NVR(s)…`, true);
  try {
    const res  = await api(`/api/maintenance/batch/${endpoint}`, { method:'POST', body: JSON.stringify({ ips, user, pass }) });
    const data = await res.json().catch(() => ({}));
    (data.results || []).forEach(r => {
      const ip = r.ip || r.host || '';
      _mntLog('mntNvrConsole', 'mntNvrConsoleBody', ip, r.message || (r.ok ? 'OK' : r.error || 'Erro'), r.ok);
      const el = document.getElementById(`mntNvrRes_${ip.replace(/\./g,'_')}`);
      if (el) el.innerHTML = `<span style="color:${r.ok ? 'var(--primary)' : 'var(--danger)'}">${r.ok ? '✓' : '✗'} ${esc(r.message || (r.ok ? 'OK' : 'Erro'))}</span>`;
    });
    if (!(data.results || []).length) _mntLog('mntNvrConsole', 'mntNvrConsoleBody', '', data.message || 'Concluído', data.ok !== false);
    showToast(data.message || `${endpoint}: concluído`);
  } catch (err) {
    _mntLog('mntNvrConsole', 'mntNvrConsoleBody', '', err.message, false);
    showToast(err.message, true);
  }
}

// ── Reprodução DVR ───────────────────────────────────────────
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
  setPlaybackStatus('Extraindo sequência...');
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

// ── IA NVR ─────────────────────────────────────────────
async function loadIaNvr() {
  const stats = await apiJson('/api/ia/nvr/stats');
  if (stats) {
    setText('mIaIndexed', stats.total_indexed ?? '—');
    setText('mIaSearches', stats.total_searches ?? '—');
  }
}

// ── OLT ────────────────────────────────────────────────
let _oltRows   = [];
let _oltCamMap = {}; // serial|mac → câmera
let _oltWs     = null;

async function loadOlt() {
  const [oltData, camData] = await Promise.all([
    apiJson('/api/olt/rows'),
    apiJson('/api/cameras'),
  ]);

  _oltRows = oltData?.rows || (Array.isArray(oltData) ? oltData : []);

  // Monta índice de câmeras por serial e por mac
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
      <td style="text-align:center">${esc(String(r.pon ?? '—'))}</td>
      <td style="text-align:center">${esc(String(r.onu_id ?? '—'))}</td>
      <td class="text-muted">${esc(r.onu_name || '—')}</td>
      <td class="monospace">${esc(r.onu_serial || '—')}</td>
      <td class="monospace">${esc(r.cpe_mac || '—')}</td>
      <td class="text-muted" style="text-align:center">${esc(r.vlan || '—')}</td>
      <td class="monospace text-muted">${esc(r.olt_ip || '—')}</td>
      <td class="text-muted">${esc(r.olt_name || '—')}</td>
      <td class="text-muted">${esc(r.site || '—')}</td>
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
  setText('oltTermTitle', `OLT · ${ip}`);
  setText('oltTermFooter', 'Iniciando…');
  lucide.createIcons();

  // Conecta no WS de console (mantém vivo + recebe acks)
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

  // Sequência de logs animados (refletem o que o serviço realmente faz)
  const ponLabel = pon === 'all' ? 'TODAS as PONs' : `PON ${pon}`;
  const steps = [
    [0,    'info', `[INFO] Conectando em ${ip}${site ? ` [site: ${site}]` : ''}...`],
    [600,  'info', `[INFO] Autenticando como "${user}"...`],
    [1100, 'info', `[INFO] Varredura automática de PONs usando 'onu status gpon <pon>'`],
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
    setText('oltTermFooter', `Coletando via SSH… ${tick}s`);
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
      oltConsoleLog(`[OK] Coleta concluída! Total: ${total} registros.`, 'ok');
      setText('oltTermFooter', `Concluído — ${total} registros`);
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
    oltConsoleLog('[ERRO] ' + (e.message || 'Erro de conexão.'), 'err');
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
      <td class="text-muted">${esc(r.port || '—')}</td>
      <td class="monospace">${esc(r.mac || '—')}</td>
      <td class="text-muted">${esc(r.vlan || '—')}</td>
      <td>${esc(r.camera_name || r.camera || '—')}</td>
    </tr>`).join('');
  setText('switchFooter', `${rows.length} registro${rows.length !== 1 ? 's' : ''}`);
}

// ── Backup ──────────────────────────────────────────────
async function loadBackup() {
  const data = await apiJson('/api/backup/status');
  const el = document.getElementById('backupStatus');
  if (!data) { el.textContent = 'Não foi possível carregar o status.'; return; }
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div><strong>Tamanho do banco:</strong> ${esc(data.db_size || '—')}</div>
      <div><strong>Câmeras:</strong> ${esc(String(data.camera_count ?? '—'))}</div>
      <div><strong>DVRs:</strong> ${esc(String(data.dvr_count ?? '—'))}</div>
      <div><strong>NVRs:</strong> ${esc(String(data.nvr_count ?? '—'))}</div>
      <div><strong>Último backup:</strong> ${esc(data.last_backup || 'Nunca')}</div>
    </div>`;
}

// ── Rede ─────────────────────────────────────────────────
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
      <td><strong>${esc(d.name || d.hostname || '—')}</strong></td>
      <td class="monospace">${esc(d.ip || '—')}</td>
      <td class="text-muted">${esc(d.type || '—')}</td>
      <td>${statusBadge(d.status)}</td>
      <td></td>
    </tr>`).join('');
}

// ── Modal ImgBB settings ────────────────────────────────
async function openImgbbModal() {
  const data = await apiJson('/api/settings/imgbb');
  document.getElementById('imgbbApiKey').value = data?.api_key || data?.key || '';
  document.getElementById('imgbbTestResult').style.display = 'none';
  document.getElementById('imgbbErro').hidden = true;
  document.getElementById('modalImgbb').classList.remove('hidden');
  lucide.createIcons();
}

// ── Modal editar câmeras (múltiplas) ───────────────────
function openEditCamModal(cams, opts = {}) {
  const count = cams.length;
  document.getElementById('modalEditCamTitle').textContent =
    count === 1 ? `Editar · ${cams[0].ip}` : `Editar ${count} câmeras`;
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
    <tr>
      <td class="monospace" style="font-size:11px;color:var(--muted);white-space:nowrap">${esc(c.ip)}</td>
      <td><input data-ip="${esc(c.ip)}" data-field="titulo"     style="${s}" value="${esc(c.titulo    || '')}" placeholder="Título"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="fabricante" style="${s}" value="${esc(c.fabricante|| '')}" placeholder="Fabricante"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="model"      style="${s}" value="${esc(c.modelo || c.model || '')}" placeholder="Modelo"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="local"      style="${s}" value="${esc(c.local     || '')}" placeholder="Local"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="mac"        style="${s};font-family:monospace" value="${esc(c.mac       || '')}" placeholder="MAC"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="pon"        style="${s};text-align:center" value="${esc(c.pon       || '')}" placeholder="—"></td>
      <td><input data-ip="${esc(c.ip)}" data-field="onu_id"     style="${s};text-align:center" value="${esc(c.onu_id    || '')}" placeholder="—"></td>
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
      const patch = payloads.find(p => p.ip === cam.ip);
      return patch ? { ...cam, ...patch } : cam;
    });
    _camSessionSave(mode, _invCam[mode]);
  });
}

async function saveEditCam() {
  const rows = document.querySelectorAll('#editCamTableBody tr');
  const payloads = [];

  rows.forEach(tr => {
    const inputs = tr.querySelectorAll('input[data-ip]');
    if (!inputs.length) return;
    const ip = inputs[0].dataset.ip;
    const payload = { ip };
    inputs.forEach(inp => { payload[inp.dataset.field] = inp.value.trim(); });
    payloads.push(payload);
  });

  const btn = document.getElementById('saveEditCam');
  btn.disabled = true;
  btn.textContent = 'Salvando…';

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
    const detail = firstErr?.body?.detail || firstErr?.body?.error || 'linha não encontrada no inventário atual';
    el.textContent = `${payloads.length} câmera(s) não foram salvas: ${detail}.`;
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
      el.textContent = renameBody?.error || first.error || 'Inventário salvo, mas o equipamento não aceitou a renomeação.';
      el.hidden = false;
      return;
    }
    showToast(`${payloads.length} câmera(s) salva(s) e renomeada(s) no equipamento!`);
  } else {
    showToast(`${payloads.length} câmera(s) salva(s)!`);
  }
  closeEditCamModal();
  applyCamPayloadsLocally(payloads);
  updateCamTabs();
  populateCamSiteFilter();
  applyInvOltFilters();
}

// ── Varredura WebSocket ─────────────────────────────────
function openScanModal() {
  document.getElementById('scanLog').textContent = 'Aguardando início…';
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
  const local   = document.getElementById('scanLocal').value.trim();
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
  appendLog(log, `→ ${payload.alvo}`, 'info');
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
        appendLog(log, '✓ ' + (msg.message || 'Concluído'), 'ok');
        appendLog(log, '✓ Varredura concluída. Campos limpos.', 'ok');
        resetScanForm();
        showToast('Varredura concluída.');
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
        appendLog(log, '✗ ' + (msg.message || 'Erro'), 'err');
      } else {
        appendLog(log, msg.message || JSON.stringify(msg), 'info');
      }
    } catch { appendLog(log, e.data, 'info'); }
  };
  _scanWs.onerror = () => appendLog(log, 'Erro WebSocket', 'err');
  _scanWs.onclose = () => {
    appendLog(log, completed ? '── Concluído ──' : '── Encerrado ──', completed ? 'ok' : 'info');
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

// ── Download autenticado ────────────────────────────────
async function downloadWithAuth(path, filename) {
  showToast('Preparando download…');
  const res = await api(path);
  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({}));
    showToast(err?.detail || 'Arquivo não encontrado', true);
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

// ── Utilidades ──────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function statusBadge(status) {
  if (!status) return '<span class="badge badge-gray">—</span>';
  const s = String(status).toLowerCase();
  if (s === 'ok' || s === 'online' || s === 'acessível') return '<span class="badge badge-green">Online</span>';
  if (s === 'fail' || s === 'offline' || s === 'erro') return '<span class="badge badge-red">Offline</span>';
  if (s === 'warn' || s === 'warning') return '<span class="badge badge-amber">Atenção</span>';
  return `<span class="badge badge-gray">${esc(status)}</span>`;
}

function pingBadge(ms) {
  if (ms == null) return '<span class="text-muted">—</span>';
  const color = ms < 50 ? 'badge-green' : ms < 200 ? 'badge-amber' : 'badge-red';
  return `<span class="badge ${color}">${ms}ms</span>`;
}

function openCamera(ip) {
  window.open(`http://${ip}`, '_blank');
}

// ── Filtros inline ──────────────────────────────────────
function filterTable(inputId, tableBodyId) {
  const q = document.getElementById(inputId)?.value.toLowerCase() || '';
  document.querySelectorAll(`#${tableBodyId} tr`).forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

// ── Nav groups (accordion) ──────────────────────────────
function initNavGroups() {
  document.querySelectorAll('.nav-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.nav-group');
      group.classList.toggle('open');
    });
  });
}

// ── Eventos ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  lucide.createIcons();
  initNavGroups();

  // Dashboard drawer
  document.getElementById('dashDrawerClose')?.addEventListener('click', closeDashDrawer);
  document.getElementById('dashDrawerOverlay')?.addEventListener('click', closeDashDrawer);

  // Login
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('loginBtn');
    btn.disabled = true;
    btn.textContent = 'Entrando…';
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

  // Navegação
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
  document.getElementById('btnRefreshTopbar').addEventListener('click', () => loadView(_currentView));

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
      result.textContent = '✓ API key válida! Conexão com ImgBB funcionando.';
    } else {
      const err = await res?.json().catch(() => ({}));
      result.style.background = 'var(--danger-soft)';
      result.style.color = 'var(--danger)';
      result.textContent = '✗ ' + (err?.detail || 'API key inválida ou erro de conexão.');
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

  // Botões individuais de tarefa no modal de scan
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

  // Tabs de visão do inventário OLT
  document.querySelectorAll('.inv-view-tab').forEach(btn => {
    btn.addEventListener('click', () => setInvOltView(btn.dataset.view));
  });

  // Filtros inventário OLT
  document.getElementById('searchInvOlt')?.addEventListener('input', applyInvOltFilters);
  document.getElementById('filterStatusOlt')?.addEventListener('change', applyInvOltFilters);
  document.getElementById('filterSiteOlt')?.addEventListener('change', applyInvOltFilters);
  document.getElementById('btnOltClearFilter')?.addEventListener('click', () => {
    document.getElementById('searchInvOlt').value = '';
    document.getElementById('filterStatusOlt').value = '';
    document.getElementById('filterSiteOlt').value = '';
    applyInvOltFilters();
  });

  // Painel câmera
  document.getElementById('btnCloseCamPanel')?.addEventListener('click', closeCamPanel);
  document.getElementById('camPanelBackdrop')?.addEventListener('click', closeCamPanel);
  document.getElementById('cpBtnAtualizar')?.addEventListener('click', () => camAction('atualizar'));
  document.getElementById('cpBtnRenomear')?.addEventListener('click', () => camAction('renomear'));
  document.getElementById('cpBtnTrocarIp')?.addEventListener('click', () => camAction('trocar-ip'));
  document.getElementById('cpBtnTrocarSenha')?.addEventListener('click', () => camAction('trocar-senha'));
  document.getElementById('cpBtnDataHora')?.addEventListener('click', () => camAction('data-hora'));
  document.getElementById('cpBtnReboot')?.addEventListener('click', () => camAction('reboot'));
  document.getElementById('cpBtnWeb')?.addEventListener('click', () => camAction('web'));
  document.getElementById('cpBtnPing')?.addEventListener('click', startPing);
  document.getElementById('closeCamAuthAction')?.addEventListener('click', closeCamAuthAction);
  document.getElementById('cancelCamAuthAction')?.addEventListener('click', closeCamAuthAction);
  document.getElementById('confirmCamAuthAction')?.addEventListener('click', runCamAuthAction);
  document.getElementById('camAuthPass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runCamAuthAction();
  });
  document.getElementById('pingTermStop')?.addEventListener('click', () => {
    stopPing();
    pingLine('— parado —', 'info');
  });
  document.getElementById('pingTermRestart')?.addEventListener('click', () => {
    pingLine('— reiniciando —', 'info');
    runPing();
  });
  document.getElementById('pingTermClear')?.addEventListener('click', () => {
    document.getElementById('pingTermBody').innerHTML = '';
    document.getElementById('pingTermStats').textContent = '';
    _pingCount = 0; _pingOk = 0; _pingFail = 0;
  });
  document.getElementById('pingTermClose')?.addEventListener('click', closePingTerminal);
  document.getElementById('cpBtnLimpar')?.addEventListener('click', () => camAction('limpar'));

  // Rodapé inventário OLT
  document.getElementById('btnOltBackup')?.addEventListener('click', () => window.open(`${API_BASE}/api/backup/export`, '_blank'));
  document.getElementById('btnOltPdf')?.addEventListener('click', () => window.open(`${API_BASE}/api/inventory/report.pdf`, '_blank'));
  document.getElementById('btnOltImgbb')?.addEventListener('click', () => {
    const ips = [...document.querySelectorAll('.chk-olt:checked')].map(c => c.value);
    const allCams = ips.length === 0
      ? _invOltAll_get()
      : _invOltAll_get().filter(c => ips.includes(c.ip));

    const list = document.getElementById('imgbbUploadList');
    const desc = document.getElementById('imgbbUploadDesc');
    desc.textContent = ips.length
      ? `${ips.length} câmera(s) selecionada(s) serão enviadas ao ImgBB.`
      : `Nenhuma câmera selecionada. Serão enviadas TODAS (${_invOltAll_get().length} câmeras).`;

    list.innerHTML = allCams.slice(0, 20).map(c => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 10px;border:1px solid var(--border);border-radius:6px;font-size:12px;background:var(--surface-soft)">
        <span class="monospace">${esc(c.ip)}</span>
        <span style="color:var(--muted)">${esc(c.titulo || '—')}</span>
        <span>${(c.imgbb_url || isImgbbUrl(c.snapshot_url)) ? '<span style="color:var(--primary);font-weight:600">↑ up</span>' : '<span style="color:var(--danger);font-weight:600">↓ down</span>'}</span>
      </div>`).join('') + (allCams.length > 20 ? `<p style="font-size:12px;color:var(--muted);text-align:center;margin:4px 0">+ ${allCams.length - 20} mais…</p>` : '');

    document.getElementById('imgbbUploadProgress').style.display = 'none';
    document.getElementById('imgbbUploadBar').style.width = '0%';
    document.getElementById('imgbbUploadMsg').textContent = '';
    document.getElementById('modalImgbbUpload').classList.remove('hidden');
    lucide.createIcons();

    // Armazena IPs para o confirm
    document.getElementById('confirmImgbbUpload').dataset.ips = JSON.stringify(ips);
  });

  document.getElementById('closeImgbbUpload')?.addEventListener('click', () =>
    document.getElementById('modalImgbbUpload').classList.add('hidden'));
  document.getElementById('cancelImgbbUpload')?.addEventListener('click', () =>
    document.getElementById('modalImgbbUpload').classList.add('hidden'));

  document.getElementById('confirmImgbbUpload')?.addEventListener('click', async () => {
    const ips = JSON.parse(document.getElementById('confirmImgbbUpload').dataset.ips || '[]');
    const progress = document.getElementById('imgbbUploadProgress');
    const bar = document.getElementById('imgbbUploadBar');
    const msg = document.getElementById('imgbbUploadMsg');
    const btn = document.getElementById('confirmImgbbUpload');

    progress.style.display = 'block';
    bar.style.width = '30%';
    msg.textContent = 'Enviando fotos…';
    msg.style.color = 'var(--muted)';
    btn.disabled = true;

    try {
      const payload = { mode: _invOltView || 'olt', ...(ips.length ? { ips } : {}) };
      const res = await api('/api/inventory/imgbb/upload', { method: 'POST', body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res?.ok || data?.ok === false) throw new Error(data?.detail || data?.error || 'Erro ao enviar.');

      bar.style.width = '100%';
      const updatedRows = data?.inventory || [];
      const sentIps = new Set(ips.length ? ips : _invOltAll_get().map(c => c.ip));

      if (updatedRows.length) {
        const byIp = {};
        updatedRows.forEach(r => { if (r.ip) byIp[r.ip] = r; });
        Object.keys(_invCam).forEach(mode => {
          _invCam[mode] = (_invCam[mode] || []).map(c => {
            const u = byIp[c.ip];
            if (!u || !sentIps.has(c.ip)) return c;
            const imgbbUrl = u.imgbb_url || '';
            if (imgbbUrl) _imgbbSave(c.ip, imgbbUrl);
            return { ...c, imgbb_url: imgbbUrl };
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
        ? `✓ ${uploaded}/${processed} foto(s) enviada(s)!${suffix}`
        : `⚠ Nenhuma foto enviada.${suffix}`;
      msg.style.color = 'var(--primary)';
      showToast(uploaded > 0 ? `${uploaded} foto(s) enviada(s) ao ImgBB.` : 'Nenhuma foto enviada ao ImgBB.', uploaded === 0);
      setTimeout(() => {
        document.getElementById('modalImgbbUpload').classList.add('hidden');
      }, 1400);
    } catch (err) {
      bar.style.width = '100%';
      msg.textContent = '✗ ' + (err?.message || 'Erro ao enviar.');
      msg.style.color = 'var(--danger)';
      showToast(err?.message || 'Erro ao enviar ImgBB.', true);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('btnOltPingSelected')?.addEventListener('click', async () => {
    const ips = [...document.querySelectorAll('.chk-olt:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione ao menos uma câmera', true); return; }
    showToast(`Pingando ${ips.length} câmera(s)…`);
    await api('/api/cameras/ping_many', { method: 'POST', body: JSON.stringify({ ips }) });
    setTimeout(loadInvOlt, 3000);
  });

  // Editar selecionados (um ou vários)
  document.getElementById('btnOltEditar')?.addEventListener('click', () => {
    const ips = [...document.querySelectorAll('.chk-olt:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione ao menos uma câmera para editar', true); return; }
    const cams = ips.map(ip => _invOltAll_get().find(c => c.ip === ip)).filter(Boolean);
    openEditCamModal(cams);
  });

  // Apagar selecionados
  document.getElementById('btnOltDeleteSelected')?.addEventListener('click', async () => {
    const ips = [...document.querySelectorAll('.chk-olt:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione ao menos uma câmera', true); return; }
    if (!await showConfirm({ title: 'Remover câmeras', msg: `Remover ${ips.length} câmera(s) do inventário?`, label: 'Remover' })) return;
    await api('/api/inventory/delete', { method: 'POST', body: JSON.stringify({ ips }) });
    showToast(`${ips.length} câmera(s) removida(s).`);
    closeCamPanel();
    loadInvOlt();
  });

  document.getElementById('btnOltClear')?.addEventListener('click', async () => {
    if (!await showConfirm({ title: 'Apagar inventário', msg: 'Apagar todas as câmeras IP do inventário? Esta ação não pode ser desfeita.', label: 'Apagar tudo' })) return;
    await api('/api/inventory/clear', { method: 'POST', body: '{}' });
    _imgbbClear();
    _camSessionClear();
    updateCamTabs();
    renderInvOlt([]);
    showToast('Inventário apagado.');
  });

  // Modal editar câmera
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
    if (!pass) { erro.textContent = 'Informe a senha atual da câmera.'; erro.hidden = false; return; }
    const payload = { ip, new_ip: novo, user, pass, ...(mask && { mask }), ...(gw && { gateway: gw }) };
    const res = await api('/api/maintenance/change_ip', { method: 'POST', body: JSON.stringify(payload) });
    if (!res?.ok) {
      const e = await res?.json().catch(() => ({}));
      erro.textContent = e?.detail || 'Erro ao trocar IP.'; erro.hidden = false; return;
    }
    document.getElementById('modalTrocarIp').classList.add('hidden');
    showToast(`IP alterado para ${novo}. Aguarde a câmera reconectar.`);
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
    if (nova !== conf) { erro.textContent = 'As senhas não coincidem.'; erro.hidden = false; return; }
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

  // Modal data/hora — alterna campos NTP vs manual
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
    if (!pass) { erro.textContent = 'Informe a senha atual da câmera.'; erro.hidden = false; return; }
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
  document.getElementById('searchInvWindows')?.addEventListener('input', () => filterTable('searchInvWindows', 'invWindowsTable'));
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
    document.getElementById('camDetTitulo').textContent  = cam.titulo || '—';
    document.getElementById('camDetStatus').innerHTML    = `<span style="color:${statusColor};font-weight:700">${esc(cam.status||'—')}</span>`;
    document.getElementById('camDetIp').textContent      = cam.ip;
    document.getElementById('camDetLocal').textContent   = cam.local || '—';
    document.getElementById('camDetMac').textContent     = cam.mac   || '—';
    document.getElementById('camDetFab').textContent     = cam.fabricante || '—';
    document.getElementById('camDetModelo').textContent  = cam.model  || '—';
    document.getElementById('camDetPon').textContent     = [cam.pon, cam.onu_id].filter(Boolean).join(' / ') || '—';
    document.getElementById('camDetOnuName').textContent = cam.onu_name   || '—';
    document.getElementById('camDetOnuSer').textContent  = cam.onu_serial || '—';
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
    showToast('Atualizando snapshots dos gravadores…');
    await Promise.all([
      api('/api/dvr/snapshot/update', { method: 'POST', body: '{}' }),
      api('/api/nvr/snapshot/update', { method: 'POST', body: '{}' }),
    ]);
    setTimeout(loadSnapDvr, 3000);
  });
  document.getElementById('btnSnapGravSelected')?.addEventListener('click', async () => {
    const idxs = [...document.querySelectorAll('.chk-snap-grav:checked')].map(c => parseInt(c.value));
    if (!idxs.length) { showToast('Selecione canais para capturar', true); return; }
    showToast(`Capturando ${idxs.length} snapshot(s)…`);
    for (const i of idxs) {
      const r = _snapGravAll[i];
      if (!r) continue;
      const endpoint = r._tipo === 'dvr' ? '/api/dvr/snapshot/update' : '/api/nvr/snapshot/update';
      await api(endpoint, { method: 'POST', body: JSON.stringify({ ip: r.host, channel: r.channel }) });
    }
    setTimeout(loadSnapDvr, 2000);
  });

  // Snapshots Câmeras IP
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
    showToast('Atualizando todos os snapshots…');
    await api('/api/snapshot/save', { method: 'POST', body: '{}' });
    setTimeout(loadSnapCam, 3000);
  });
  document.getElementById('btnSnapCamSelected')?.addEventListener('click', async () => {
    const ips = [...document.querySelectorAll('.chk-snap-cam:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione câmeras para capturar', true); return; }
    showToast(`Capturando ${ips.length} snapshot(s)…`);
    for (const ip of ips) {
      await api('/api/snapshot/save', { method: 'POST', body: JSON.stringify({ ip }) });
    }
    setTimeout(loadSnapCam, 2000);
  });

  // Varredura DVR
  document.getElementById('btnScanDvr')?.addEventListener('click', async () => {
    showToast('Iniciando varredura DVR…');
    await api('/api/dvr/scan', { method: 'POST', body: '{}' });
    setTimeout(loadInvDvr, 2000);
  });

  // Gravadores — seletor de tipo (NVR / DVR)
  document.querySelectorAll('[data-rec-type]').forEach(btn => {
    btn.addEventListener('click', () => setRecType(btn.dataset.recType));
  });

  // Gravadores — tabs de visão
  document.querySelectorAll('[data-nvr-view]').forEach(btn => {
    btn.addEventListener('click', () => setNvrView(btn.dataset.nvrView));
  });

  // NVR — modal de scan dedicado
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
    // Para scan em andamento E remove dados parciais SÓ se ainda estava rodando
    if (scanningNow) {
      _nvrAbortCtrl.abort();
      _nvrAbortCtrl = null;
      _nvrUiScanning(false);
      discardActiveRecorderScan();
      _nvrActiveScan = null;
    }
    document.getElementById('nvrScanLog').innerHTML = 'Aguardando início…';
    document.getElementById('nvrScanFooter').textContent = '';
    document.getElementById('modalNvrScan').classList.add('hidden');
  }

  document.getElementById('closeNvrScanModal')?.addEventListener('click', _closeNvrModal);
  document.getElementById('cancelNvrScan')?.addEventListener('click', _closeNvrModal);
  document.getElementById('btnStopNvrScan')?.addEventListener('click', () => {
    if (_nvrAbortCtrl) { _nvrAbortCtrl.abort(); _nvrAbortCtrl = null; }
    discardActiveRecorderScan();
    _nvrActiveScan = null;
    appendLog(document.getElementById('nvrScanLog'), '[PARADO] Cancelado pelo usuário.', 'err');
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
      if (btn)     { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader-circle"></i> Varrendo…'; }
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
    appendLog(log, `[INFO] Conectando em ${payload.ip}:${payload.http_port} (canais ${start}–${end})…`, 'info');

    // Animação discreta: 3 passos fixos + contador no rodapé
    const steps = [
      [500,  'info', `[INFO] Autenticando como "${payload.user}"…`],
      [1200, 'info', `[INFO] Lendo ${end - start + 1} canais…`],
    ];
    const timers = steps.map(([d, cls, msg]) => setTimeout(() => appendLog(log, msg, cls), d));

    let secs = 0;
    const tick = setInterval(() => {
      secs++;
      setText('nvrScanFooter', `${secs}s decorridos…`);
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
    _nvrAbortCtrl = null; // scan terminou — fechar não apaga mais dados
    _nvrActiveScan = null;
    _nvrUiScanning(false);
    setText('nvrScanFooter', '');

    if (res?.ok) {
      const data = await res.json();
      const mode  = _nvrScanMode();
      const stype = _nvrScanType();
      let rows = data?.inventory || [];
      appendLog(log, `[OK] Scan concluído — ${rows.length} canais encontrados.`, 'ok');

      // Enriquece se necessário
      if ((mode === 'olt' || mode === 'switch') && rows.length) {
        appendLog(log, '[INFO] Cruzando com inventário de câmeras…', 'info');
        rows = await enrichRecRowsForMode(rows, mode);
        appendLog(log, `[OK] Cruzamento concluído.`, 'ok');
      }

      // Salva no store correto (NVR ou DVR) e sincroniza o tipo na UI
      const store = stype === 'dvr' ? _invDvr : _invNvr;
      store[mode] = [...store[mode].filter(r => r.host !== payload.ip), ...rows];
      _recSessionSave(stype, mode, store[mode]);
      pruneSyntheticRecModes(stype);
      setRecType(stype);
      if (!(store[_invNvrView] || []).length) setNvrView(mode);
      populateNvrFilters();
      applyNvrFilters();
    } else {
      const e = await res?.json().catch(() => ({}));
      const msg = e?.detail || (res?.status === 401 ? 'Credenciais inválidas para o NVR.' : 'Erro na varredura.');
      appendLog(log, '[ERRO] ' + msg, 'err');
    }
  }

  function _nvrScanMode() { return document.getElementById('nvrScanMode')?.value || 'basico'; }
  function _nvrScanType() { return document.getElementById('nvrScanType')?.value || 'nvr'; }
  document.getElementById('nvrScanType')?.addEventListener('change', updateNvrScanTypeLabels);

  async function _runNvrScan(extra = {}) {
    document.getElementById('nvrScanLog').innerHTML = '';
    await _runNvrTask(_nvrPayload(extra));
    // Dados já atualizados dentro de _runNvrTask via data.inventory
  }

  document.getElementById('btnStartNvrScan')?.addEventListener('click', () =>
    _runNvrScan({ imgbb: document.getElementById('nvrTaskImgbb').checked }));

  document.getElementById('nvrTaskDiscoverRun')?.addEventListener('click', () =>
    _runNvrScan({ imgbb: false }));
  document.getElementById('nvrTaskSnapshotRun')?.addEventListener('click', async () => {
    const ip = document.getElementById('nvrScanIp').value.trim();
    const stype = _nvrScanType();
    if (!ip) { showToast(`Informe o IP do ${stype === 'dvr' ? 'DVR' : 'NVR'}`, true); return; }
    appendLog(document.getElementById('nvrScanLog'), 'Capturando snapshots…', 'info');
    await api(`/api/${stype}/snapshot/update`, { method: 'POST', body: JSON.stringify({ ip, user: document.getElementById('nvrScanUser').value, password: document.getElementById('nvrScanPass').value }) });
    appendLog(document.getElementById('nvrScanLog'), '✓ Snapshots atualizados.', 'ok');
    loadInvNvr();
  });
  document.getElementById('nvrTaskImgbbRun')?.addEventListener('click', async () => {
    const stype = _nvrScanType();
    appendLog(document.getElementById('nvrScanLog'), 'Enviando ao ImgBB…', 'info');
    const res = await api(`/api/${stype}/imgbb/upload`, { method: 'POST', body: '{}' });
    const d = await res?.json().catch(() => ({}));
    appendLog(document.getElementById('nvrScanLog'), `✓ ${d?.uploaded ?? '?'} fotos enviadas.`, 'ok');
    loadInvNvr();
  });
  document.getElementById('btnNvrClear')?.addEventListener('click', async () => {
    const store      = _currentRecStore();
    const typeName   = _recType === 'dvr' ? 'Analógico (DVR)' : 'NVR · IP';
    const viewName   = { basico: 'Básico', olt: 'Via OLT', switch: 'Via Switch' }[_invNvrView] || _invNvrView;
    const siteFilter = document.getElementById('filterNvrLocal')?.value || '';
    const hostFilter = document.getElementById('filterNvrHost')?.value  || '';
    const hasFilter  = !!(siteFilter || hostFilter);

    const scopeMsg = hasFilter
      ? `Apagar canais de ${typeName} · ${viewName}${siteFilter ? ` — site "${siteFilter}"` : ''}${hostFilter ? ` — host "${hostFilter}"` : ''}?`
      : `Apagar TODOS os canais de ${typeName} · ${viewName}?`;

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
    showToast(`Concluído: ${d?.uploaded ?? 0} foto(s) enviada(s) ao ImgBB.`);
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
    if (!await showConfirm({ title: 'Apagar canais', msg: `Remover ${items.length} canal(is) do inventário?`, label: 'Remover' })) return;
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

  // Indexar IA
  document.getElementById('btnIaIndex')?.addEventListener('click', async () => {
    showToast('Indexação iniciada…');
    await api('/api/ia/nvr/index', { method: 'POST', body: '{}' });
  });

  // Busca IA
  document.getElementById('btnIaSearch')?.addEventListener('click', async () => {
    const q = document.getElementById('iaNvrQuery').value.trim();
    if (!q) return;
    const data = await apiJson(`/api/ia/nvr/search?q=${encodeURIComponent(q)}`);
    const el = document.getElementById('iaNvrResults');
    if (!data?.results?.length) {
      el.textContent = 'Nenhum resultado encontrado.';
      return;
    }
    el.innerHTML = data.results.map(r => `
      <div style="padding:10px 0;border-bottom:1px solid var(--border)">
        <strong>${esc(r.camera || r.file || '—')}</strong>
        <span style="margin-left:8px;font-size:11px;color:var(--muted)">${esc(r.timestamp || '')}</span>
        <p style="margin:4px 0 0;font-size:12px;color:var(--muted)">${esc(r.description || '')}</p>
      </div>`).join('');
  });

  // Botão Ferramentas KMZ
  document.getElementById('btnMapTools')?.addEventListener('click', () => {
    document.getElementById('modalMapTools').classList.remove('hidden');
    lucide.createIcons();
  });
  document.getElementById('closeMapTools')?.addEventListener('click',  () => document.getElementById('modalMapTools').classList.add('hidden'));
  document.getElementById('closeMapTools2')?.addEventListener('click', () => document.getElementById('modalMapTools').classList.add('hidden'));

  // Etapa 2 — Prévia e Aplicar coordenadas
  document.getElementById('btnMapApplyPreview')?.addEventListener('click', async () => {
    const source   = document.getElementById('mapApplySource')?.value || 'ip';
    const overwrite = document.getElementById('mapApplyOverwrite')?.checked || false;
    const status   = document.getElementById('mapApplyStatus');
    status.textContent = 'Calculando prévia…';
    const res  = await api('/api/kmz/import/locations/apply', { method: 'POST', body: JSON.stringify({ source, overwrite, dry_run: true }) });
    const data = await res?.json().catch(() => ({}));
    if (data?.error) { status.textContent = '✗ ' + data.error; status.style.color = 'var(--danger)'; return; }
    const src = document.getElementById('mapApplySource')?.options[document.getElementById('mapApplySource')?.selectedIndex]?.text || source;
    status.style.color = 'var(--muted)';
    status.innerHTML = `<strong>${src}</strong> | Pontos: ${data.total_points ?? '?'} | Atualizariam: ${data.updated ?? '?'} | Sem match: ${data.no_match ?? '?'} | Já tinham: ${data.already_had ?? '?'}`;
  });

  document.getElementById('btnMapApply')?.addEventListener('click', async () => {
    const source    = document.getElementById('mapApplySource')?.value || 'ip';
    const overwrite = document.getElementById('mapApplyOverwrite')?.checked || false;
    const status    = document.getElementById('mapApplyStatus');
    status.textContent = 'Aplicando…'; status.style.color = 'var(--muted)';
    const res  = await api('/api/kmz/import/locations/apply', { method: 'POST', body: JSON.stringify({ source, overwrite }) });
    const data = await res?.json().catch(() => ({}));
    if (data?.error) { status.textContent = '✗ ' + data.error; status.style.color = 'var(--danger)'; return; }
    status.style.color = 'var(--primary)';
    const src = document.getElementById('mapApplySource')?.options[document.getElementById('mapApplySource')?.selectedIndex]?.text || source;
    status.innerHTML = `✓ <strong>${src}</strong> | Atualizadas: ${data.updated ?? '?'} | Sem match: ${data.no_match ?? '?'}`;
    showToast(`${data.updated ?? '?'} câmeras atualizadas com GPS!`);
  });

  // Etapa 3 — Gerar KMZ
  document.getElementById('btnMapViewGenerated')?.addEventListener('click', async () => {
    const status = document.getElementById('mapGenerateStatus');
    status.textContent = 'Carregando camada gerada…'; status.style.color = 'var(--muted)';
    await loadMapLayers();
    // Ativa camada gerada se disponível
    const generatedState = _mapLayerGroups['cameras'];
    if (generatedState && !generatedState.active) toggleMapLayer('cameras', MAP_LAYER_DEFS[0]);
    status.textContent = 'Camada gerada exibida no mapa.'; status.style.color = 'var(--primary)';
  });

  document.getElementById('btnMapDownloadGenerated')?.addEventListener('click', () =>
    downloadWithAuth('/api/kmz/generated/download', 'cameras-gerado.kmz'));

  // Mapa
  document.getElementById('mapFilterStatus')?.addEventListener('change', () => {
    const camByName = {}; const camByIp = {};
    (_invCam['basico']||[]).forEach(c => {
      if (c.titulo) camByName[c.titulo.toLowerCase()] = c;
      if (c.ip)     camByIp[c.ip] = c;
    });
    renderMapMarkers(camByName, camByIp);
  });
  document.getElementById('mapFilterSite')?.addEventListener('change', () => {
    const camByName = {}; const camByIp = {};
    (_invCam['basico']||[]).forEach(c => {
      if (c.titulo) camByName[c.titulo.toLowerCase()] = c;
      if (c.ip)     camByIp[c.ip] = c;
    });
    renderMapMarkers(camByName, camByIp);
  });
  document.getElementById('btnMapReload')?.addEventListener('click', loadKmz);

  // Importar KMZ
  document.getElementById('btnMapImport')?.addEventListener('click', () =>
    document.getElementById('mapKmzInput')?.click());

  document.getElementById('mapKmzInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Passo 1: importar o arquivo
    showToast(`Importando ${file.name}…`);
    const form = new FormData();
    form.append('file', file);
    const headers = {};
    if (_token) headers['Authorization'] = `Bearer ${_token}`;

    let importRes;
    try {
      importRes = await fetch(`${API_BASE}/api/kmz/import`, { method: 'POST', headers, body: form });
    } catch (err) {
      showToast('Erro de conexão ao importar KMZ', true);
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
    showToast(`KMZ importado — ${featCount} pontos encontrados`);

    // Passo 2: perguntar se quer aplicar ao inventário
    const apply = await showConfirm({
      eyebrow: 'KMZ importado',
      title:   'Aplicar localizações?',
      msg:     `O KMZ tem ${featCount} ponto(s). Deseja aplicar as coordenadas GPS ao inventário de câmeras?`,
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
        showToast(`Localizações aplicadas — ${d?.updated ?? '?'} câmeras atualizadas!`);
      } else {
        const err = await applyRes?.json().catch(() => ({}));
        showToast('Erro ao aplicar: ' + (err?.detail || 'verifique o inventário'), true);
      }
    }

    await loadKmz();
    e.target.value = '';
  });
  document.getElementById('btnMapDownloadKmz')?.addEventListener('click', () =>
    downloadWithAuth('/api/kmz/import/download', 'imported.kmz'));
  document.getElementById('btnMapGenerate')?.addEventListener('click', async () => {
    const genStatus = document.getElementById('mapGenerateStatus');
    const genName = document.getElementById('mapGenerateName')?.value.trim() || 'Câmeras do Inventário';
    if (genStatus) { genStatus.textContent = 'Gerando…'; genStatus.style.color = 'var(--muted)'; }
    sessionStorage.setItem('so_kmz_generated_name', genName);
    const res = await api('/api/kmz/generate', { method: 'POST', body: '{}' });
    if (res?.ok) {
      if (genStatus) { genStatus.textContent = '✓ Gerado com sucesso!'; genStatus.style.color = 'var(--primary)'; }
      showToast('KMZ gerado!');
      // Remove a camada importada — foi incorporada ao gerado
      if (_mapLayerGroups['imported']?.active) _map.removeLayer(_mapLayerGroups['imported'].group);
      delete _mapLayerGroups['imported'];
      sessionStorage.removeItem('so_kmz_imported_name');
      // Recarrega mostrando só o gerado e ativa automaticamente
      await loadMapLayers();
      if (_mapLayerGroups['cameras'] && !_mapLayerGroups['cameras'].active)
        toggleMapLayer('cameras', MAP_LAYER_DEFS[0]);
    } else {
      if (genStatus) { genStatus.textContent = '✗ Erro ao gerar.'; genStatus.style.color = 'var(--danger)'; }
      showToast('Erro ao gerar KMZ', true);
    }
  });

  // OLT — abre modal de configuração
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
        ? `Serão removidos todos os registros do site "${site}". Esta ação não pode ser desfeita.`
        : 'Serão removidos todos os registros de todos os sites. Esta ação não pode ser desfeita.',
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
    showToast('Coletando MACs do switch…');
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

    log.textContent = 'Conectando ao Grafana…\n';
    badge.style.display = 'none';
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Importando…';
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
      log.textContent = '✗ Erro: ' + data.error + '\n\n' + (data.stderr || '') + (data.stdout || '');
      badge.textContent = 'Erro';
      badge.style.background = 'var(--danger-soft)';
      badge.style.color = 'var(--danger)';
      badge.style.display = 'inline-block';
    } else {
      log.textContent = data?.stdout || data?.result || 'Concluído.';
      if (data?.stderr) log.textContent += '\n\n[stderr]\n' + data.stderr;
      badge.textContent = '✓ Importado';
      badge.style.background = 'var(--primary-soft)';
      badge.style.color = 'var(--primary)';
      badge.style.display = 'inline-block';
      showToast('Dashboard importado no Grafana!');
    }
  });

  document.getElementById('btnGenNetwatch')?.addEventListener('click', async () => {
    const log = document.getElementById('netwatchLog');
    log.textContent = 'Gerando…';
    const data = await apiJson('/api/scripts/netwatch', { method: 'POST', body: '{}' });
    log.textContent = data?.result || JSON.stringify(data, null, 2) || 'Concluído.';
  });

  document.getElementById('btnDownloadNetwatch')?.addEventListener('click', () => {
    window.open(`${API_BASE}/api/scripts/netwatch/download`, '_blank');
  });

  // Templates padrão por fonte
  const ZBX_TEMPLATES = {
    'ip':         'Template Module ICMP Ping',
    'ip-olt':     'Template Module ICMP Ping',
    'ip-switch':  'Template Module ICMP Ping',
    'dvr':        'Template Cam-Snapshot DVR Channel',
    'nvr':        'Template Cam-Snapshot DVR Channel',
    'nvr-olt':    'Template Cam-Snapshot DVR Channel',
    'nvr-switch': 'Template Cam-Snapshot DVR Channel',
  };

  // Zabbix — mostra/oculta campos DVR/Telegram e atualiza template
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
      showToast('Preencha URL, usuário e senha do Zabbix', true);
      return;
    }

    const log    = document.getElementById('zabbixLog');
    const badge  = document.getElementById('zbxStatusBadge');
    const btn    = document.getElementById('btnGenZabbix');

    log.textContent = 'Conectando ao Zabbix…\n';
    badge.style.display = 'none';
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Sincronizando…';
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

    if (data?.error) {
      log.textContent = '✗ Erro: ' + data.error + '\n\n' + (data.stderr || '');
      badge.textContent = 'Erro';
      badge.style.background = 'var(--danger-soft)';
      badge.style.color = 'var(--danger)';
      badge.style.display = 'inline-block';
    } else {
      const output = data?.stdout || data?.result || JSON.stringify(data, null, 2) || 'Concluído.';
      log.textContent = output;
      badge.textContent = '✓ Sincronizado';
      badge.style.background = 'var(--primary-soft)';
      badge.style.color = 'var(--primary)';
      badge.style.display = 'inline-block';
      showToast('Sincronização Zabbix concluída!');
    }
  });

  // Varredura OLT (via inventário)
  document.getElementById('btnScanOlt')?.addEventListener('click', openScanModal);

  // ── Manutenção Câmeras ──
  document.getElementById('btnMntCamRefresh')?.addEventListener('click', () => { _mntCamAll = []; loadMntCam(); });
  document.getElementById('btnMntCamReboot')?.addEventListener('click', () => _mntCamRunAction('reboot'));
  document.getElementById('btnMntCamNtp')?.addEventListener('click', () => {
    const addr = prompt('Servidor NTP (deixe vazio para usar servidor padrão):', '');
    if (addr === null) return;
    _mntCamRunAction('ntp', addr ? { address: addr } : { address: 'time.cloudflare.com' });
  });
  document.getElementById('btnMntCamIp')?.addEventListener('click', () => {
    const ips = [...document.querySelectorAll('.chk-mnt-cam:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione ao menos uma câmera', true); return; }
    document.getElementById('modalTrocarIp')?.classList.remove('hidden');
    lucide.createIcons();
  });
  document.getElementById('btnMntCamPass')?.addEventListener('click', () => {
    const ips = [...document.querySelectorAll('.chk-mnt-cam:checked')].map(c => c.value);
    if (!ips.length) { showToast('Selecione ao menos uma câmera', true); return; }
    document.getElementById('modalTrocarSenha')?.classList.remove('hidden');
    lucide.createIcons();
  });
  document.getElementById('btnMntCamSelectAll')?.addEventListener('click', () => {
    document.querySelectorAll('.chk-mnt-cam').forEach(c => { c.checked = true; c.closest('.mnt-cam-card')?.classList.add('selected'); });
    _mntCamUpdateCount();
  });
  document.getElementById('btnMntCamDeselect')?.addEventListener('click', () => {
    document.querySelectorAll('.chk-mnt-cam').forEach(c => { c.checked = false; c.closest('.mnt-cam-card')?.classList.remove('selected'); });
    _mntCamUpdateCount();
  });
  document.getElementById('mntCamSearch')?.addEventListener('input', e => { _mntCamFilter.q = e.target.value; _mntCamRender(); });
  document.getElementById('mntCamSite')?.addEventListener('change', e => { _mntCamFilter.site = e.target.value; _mntCamRender(); });
  document.querySelectorAll('[data-mnt-status]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-mnt-status]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      _mntCamFilter.status = btn.dataset.mntStatus;
      _mntCamRender();
    });
  });

  // ── Manutenção DVR ──
  document.getElementById('btnMntDvrRefresh')?.addEventListener('click', loadMntDvr);
  document.getElementById('btnMntDvrReboot')?.addEventListener('click', () => _mntDvrRunAction('reboot'));
  document.getElementById('btnMntDvrNtp')?.addEventListener('click', () => _mntDvrRunAction('ntp'));
  document.getElementById('btnMntDvrSelectAll')?.addEventListener('click', () => {
    document.querySelectorAll('.chk-mnt-dvr').forEach(c => c.checked = true);
    _mntDvrUpdateCount();
  });

  // ── Manutenção NVR ──
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
