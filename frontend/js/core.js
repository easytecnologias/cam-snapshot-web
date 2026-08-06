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
let _currentUser = null; // ultimo /api/auth/me: role, is_platform_admin, acting_as, enabled_modules...
let _moduleCatalogCache = null; // /api/auth/modules/catalog, buscado uma vez por sessao

// Cache curto, somente em memoria e por sessao autenticada. Evita repetir
// respostas grandes ao alternar entre telas sem guardar dados entre usuarios.
const _apiJsonCache = new Map();
const API_JSON_CACHE_TTL_MS = 30000;

function clearApiJsonCache(match = '') {
  if (!match) {
    _apiJsonCache.clear();
    return;
  }
  for (const key of _apiJsonCache.keys()) {
    if (key.includes(match)) _apiJsonCache.delete(key);
  }
}

//  Helpers HTTP
async function api(path, opts = {}) {
  const { skipLogout, ...fetchOpts } = opts;
  const headers = { 'Content-Type': 'application/json', ...(fetchOpts.headers || {}) };
  if (_token) headers['Authorization'] = `Bearer ${_token}`;
  const res = await fetch(`${API_BASE}${path}`, { credentials: 'same-origin', ...fetchOpts, headers });
  const method = String(fetchOpts.method || 'GET').toUpperCase();
  if (res.ok && !['GET', 'HEAD'].includes(method)) clearApiJsonCache();
  if (res.status === 401 && !skipLogout) {
    _token = null;
    try { localStorage.removeItem('so_token'); } catch {}
    showLoginScreen();
    return null;
  }
  return res;
}

async function apiJson(path, opts = {}) {
  const { cacheTtl = API_JSON_CACHE_TTL_MS, forceRefresh = false, ...requestOpts } = opts;
  const method = String(requestOpts.method || 'GET').toUpperCase();
  const canCache = method === 'GET' && cacheTtl > 0;
  const cacheKey = `${_token || 'anonymous'}:${path}`;
  const now = Date.now();
  const cached = _apiJsonCache.get(cacheKey);
  if (canCache && !forceRefresh && cached && cached.expiresAt > now) return cached.data;

  const res = await api(path, requestOpts);
  if (!res || !res.ok) return null;
  const data = await res.json();
  if (canCache) _apiJsonCache.set(cacheKey, { data, expiresAt: now + cacheTtl });
  return data;
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
  const data = await apiJson('/api/auth/me', { forceRefresh: true });
  if (!data) return;
  const user = data.user || data;
  _currentUser = user;
  const name = user.full_name || user.username || user.email || '?';
  const role = user.role || user.perfil || '';
  document.getElementById('profileName').textContent = name;
  document.getElementById('profileRole').textContent = role;
  document.getElementById('profileAvatar').textContent = name[0].toUpperCase();
  applyModuleVisibility();
  applyPlatformAdminVisibility();
  renderActingAsBanner();
}

// Esconde do menu lateral qualquer tela que nao faca parte do "pacote" do
// cliente logado. `enabled_modules` nulo = sem restricao (mostra tudo,
// inclusive modulos criados depois que ninguem configurou ainda pra esse
// cliente). A chave de cada modulo E o data-view do item de menu -- ver
// MODULE_CATALOG em app/services/auth_store.py.
function applyModuleVisibility() {
  const enabled = _currentUser?.enabled_modules;
  document.querySelectorAll('.nav-item[data-view]').forEach(btn => {
    const key = btn.dataset.view;
    const restricted = Array.isArray(enabled);
    const visible = !restricted || enabled.includes(key);
    btn.classList.toggle('nav-item-hidden', !visible);
  });
  // Grupo "Snapshots": some por completo se as duas telas dele estiverem escondidas.
  const snapGroup = document.getElementById('ngSnapshots');
  if (snapGroup) {
    const subVisible = [...snapGroup.querySelectorAll('.nav-sub-item[data-view]')]
      .some(btn => !btn.classList.contains('nav-item-hidden'));
    snapGroup.classList.toggle('nav-item-hidden', !subVisible);
  }
}

// A aba "Clientes" (lista/cria outros tenants do SaaS) so faz sentido pra
// quem administra a PLATAFORMA -- um cliente comum nao deve nem saber que
// outros clientes existem.
function applyPlatformAdminVisibility() {
  const isPlatformAdmin = !!_currentUser?.is_platform_admin;
  // "Clientes" (lista outros tenants) e "Plataforma e segurança" (contagens
  // globais de tenants/usuarios, backend do banco) sao informacao da
  // PLATAFORMA, nao do cliente -- um dono de cliente real nao deve nem saber
  // que outros clientes existem, quanto mais ver contagem deles.
  document.querySelectorAll(
    '[data-settings-tab="tenants"], [data-settings-panel="tenants"], [data-settings-tab="platform"], [data-settings-panel="platform"]'
  ).forEach(el => {
    el.classList.toggle('nav-item-hidden', !isPlatformAdmin);
  });
  const activeTab = document.querySelector('.settings-nav-item.active')?.dataset.settingsTab;
  if (!isPlatformAdmin && (activeTab === 'tenants' || activeTab === 'platform')) {
    activateSettingsTab('overview');
  }
}

function renderActingAsBanner() {
  const el = document.getElementById('actingAsBanner');
  if (!el) return;
  if (_currentUser?.acting_as) {
    setText('actingAsBannerText', `Operando como: ${_currentUser.effective_tenant_name || _currentUser.effective_tenant_slug || ''}`);
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

async function actAsTenant(tenantSlug) {
  const res = await api('/api/auth/act-as', { method: 'POST', body: JSON.stringify({ tenant_slug: tenantSlug || '' }) });
  const data = await jsonOrReadableError(res, 'Nao foi possivel trocar de cliente.');
  showToast(tenantSlug ? `Operando como ${data?.user?.effective_tenant_name || tenantSlug}.` : 'Voltou para a propria conta.');
  // Recarrega a pagina inteira: e a forma mais segura de garantir que TODA
  // tela (cada uma com seu proprio cache/estado em memoria) recarregue os
  // dados do tenant novo, em vez de misturar dados de dois clientes na
  // mesma sessao de navegador.
  window.location.reload();
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
  'net-operate':   { title: 'Manutencao - Operacoes', sub: 'Ferramentas de diagnostico de rede' },
  planning:        { title: 'Projetos de CFTV', sub: 'Planejamento antes da implantacao' },
  'deploy-olt':    { title: 'Implantacao - OLT', sub: 'Cadastro das OLTs usadas na operacao' },
  'deploy-onu':    { title: 'Implantacao - ONU', sub: 'Provisionamento em campo' },
  'deploy-recorder': { title: 'Implantacao - Gravadores', sub: 'Cadastro de DVR/NVR' },
  'deploy-new':    { title: 'Implantacao - CFTV', sub: 'Assistente de campo' },
  olt:             { title: 'OLT',               sub: 'Coleta de MACs da OLT' },
  switch:          { title: 'Switch',            sub: 'Coleta de MACs do switch' },
  kmz:             { title: 'KMZ  Mapa',        sub: 'Localizacao das cameras' },
  'script-grafana':{ title: 'Scripts  Grafana', sub: '' },
  'script-zabbix': { title: 'Scripts  Zabbix',  sub: '' },
  connectors:      { title: 'Conectores',       sub: 'MikroTik RouterOS dos clientes' },
  monitoring:      { title: 'Monitoramento',     sub: 'Saude dos equipamentos e alertas' },
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
  'net-operate':    'viewNetOperate',
  planning:         'viewPlanning',
  'deploy-olt':     'viewDeployOlt',
  'deploy-onu':     'viewDeployOnu',
  'deploy-recorder':'viewDeployRecorder',
  'deploy-new':     'viewDeployNew',
  olt:              'viewOlt',
  switch:           'viewSwitch',
  kmz:              'viewKmz',
  'script-grafana': 'viewScriptGrafana',
  'script-zabbix':  'viewScriptZabbix',
  connectors:       'viewConnectors',
  monitoring:       'viewMonitoring',
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
    case 'net-operate': loadNetOperate();   break;
    case 'planning':    loadPlanning();     break;
    case 'deploy-olt':  loadDeployOlt();    break;
    case 'deploy-onu':  loadDeployOnu();    break;
    case 'deploy-recorder': loadDeployRecorder(); break;
    case 'deploy-new':  loadDeployNew();    break;
    case 'connectors':  loadConnectors();   break;
    case 'monitoring':  loadMonitoring();   break;
    case 'script-grafana': loadScriptGrafana(); break;
    case 'script-zabbix':  loadScriptZabbix();  break;
    case 'settings':
      loadSettings();
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

function activateSettingsTab(tab = 'overview') {
  const available = [...document.querySelectorAll('[data-settings-panel]')].map(panel => panel.dataset.settingsPanel);
  if (!available.includes(tab)) tab = 'overview';
  document.querySelectorAll('[data-settings-tab]').forEach(button => {
    const active = button.dataset.settingsTab === tab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  });
  document.querySelectorAll('[data-settings-panel]').forEach(panel => {
    panel.classList.toggle('active', panel.dataset.settingsPanel === tab);
  });
  sessionStorage.setItem('sightops.settings.tab', tab);
  scheduleResponsiveHydration(document.getElementById('viewSettings'));
  lucide.createIcons();
}

async function loadSettings() {
  const [me, tenants, users, authStatus, dbStatus, telegram] = await Promise.all([
    apiJson('/api/auth/me'),
    apiJson('/api/auth/tenants'),
    apiJson('/api/auth/users'),
    apiJson('/api/auth/status'),
    apiJson('/api/db/status'),
    apiJson('/api/monitoring/telegram', { forceRefresh: true }),
  ]);
  const currentUser = me?.user || {};
  const tenantRows = tenants?.tenants || [];
  const userRows = users?.users || [];

  const overview = document.getElementById('settingsOverviewStatus');
  if (overview) {
    const telegramState = telegram?.configured ? (telegram.enabled ? 'Ativo' : 'Configurado') : 'Não configurado';
    // "Clientes SaaS" e "Banco principal" sao enquadramento de PLATAFORMA
    // (revelam que existe um SaaS multi-cliente por tras e como ele roda) --
    // um dono de cliente real so quer ver o que importa pra empresa dele.
    const stats = [
      ['Cliente atual', currentUser.tenant_name || currentUser.tenant_slug || '-'],
      ['Seu perfil', currentUser.role || '-'],
      ['Usuários da equipe', userRows.length],
      ['Notificações', telegramState],
    ];
    if (currentUser.is_platform_admin) {
      stats.splice(2, 0, ['Clientes SaaS', tenantRows.length]);
      stats.push(['Banco principal', dbStatus?.backend || '-']);
    }
    overview.innerHTML = stats
      .map(([label, value]) => `<div class="settings-status-card"><span>${esc(label)}</span><strong title="${esc(value)}">${esc(value)}</strong></div>`).join('');
  }

  setText('settingsTenantsSummary', `${tenantRows.length} cliente${tenantRows.length === 1 ? '' : 's'} cadastrado${tenantRows.length === 1 ? '' : 's'}.`);
  const tenantsBody = document.getElementById('settingsTenantsBody');
  const isPlatformAdmin = !!currentUser.is_platform_admin;
  if (tenantsBody) {
    tenantsBody.innerHTML = tenantRows.length ? tenantRows.map(t => {
      const modulesLabel = Array.isArray(t.enabled_modules) ? `${t.enabled_modules.length} módulo(s)` : 'Sem restrição';
      const isEffectiveCurrent = (currentUser.effective_tenant_slug || currentUser.tenant_slug) === t.slug;
      const isHomeTenant = currentUser.tenant_slug === t.slug;
      // O botao "Operar como" fica disponivel pra TODAS as linhas, inclusive
      // a sua propria -- clicar nele na sua propria linha so limpa o act-as
      // (volta pra casa), em vez de marcar "operando como" a propria conta.
      const actAsCall = isHomeTenant ? `actAsTenant('')` : `actAsTenant('${esc(t.slug || '')}')`;
      const actions = isPlatformAdmin ? `
        <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          <button class="ghost-action" style="padding:4px 8px;font-size:11px" title="${esc(modulesLabel)}" onclick="openTenantModulesModal(${Number(t.id)}, '${esc(t.name || t.slug || '')}')"><i data-lucide="sliders-horizontal"></i> Módulos</button>
          <button class="ghost-action" style="padding:4px 8px;font-size:11px" onclick="${actAsCall}"><i data-lucide="log-in"></i> Operar como</button>
          ${isEffectiveCurrent ? `<span class="badge badge-gray" style="font-size:11px">Você está aqui</span>` : ''}
        </div>` : '';
      return `
      <tr>
        <td class="settings-cell-truncate" title="${esc(t.name || '')}"><strong>${esc(t.name || '')}</strong></td>
        <td class="settings-cell-truncate" title="${esc(t.slug || '')}"><span class="monospace">${esc(t.slug || '')}</span></td>
        <td class="settings-cell-center">${Number(t.active) ? '<span class="badge badge-green">Ativo</span>' : '<span class="badge badge-red">Inativo</span>'}</td>
        <td class="settings-cell-center">${esc(t.users ?? 0)}</td>
        <td class="settings-cell-date"><span class="text-muted">${esc(formatDateTimeShort(t.created_at || ''))}</span></td>
        <td>${actions}</td>
      </tr>`;
    }).join('') : '<tr class="empty-row"><td colspan="6">Nenhum cliente cadastrado.</td></tr>';
    lucide.createIcons();
  }

  setText('settingsUsersSummary', `${userRows.length} usuario${userRows.length === 1 ? '' : 's'} no cliente atual (${currentUser.tenant_name || currentUser.tenant_slug || '-'}).`);
  const usersBody = document.getElementById('settingsUsersBody');
  if (usersBody) {
    usersBody.innerHTML = userRows.length ? userRows.map(u => `
      <tr>
        <td class="settings-cell-truncate" title="${esc(u.username || '')}"><strong>${esc(u.username || '')}</strong></td>
        <td class="settings-cell-truncate" title="${esc(u.full_name || '-')}">${esc(u.full_name || '-')}</td>
        <td class="settings-cell-center"><span class="badge badge-gray">${esc(u.role || '')}</span></td>
        <td class="settings-cell-center">${Number(u.active) ? '<span class="badge badge-green">Ativo</span>' : '<span class="badge badge-red">Inativo</span>'}</td>
        <td class="settings-cell-truncate" title="${esc(u.tenant_name || u.tenant_slug || '')}">${esc(u.tenant_name || u.tenant_slug || '')}</td>
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
  if (telegram) {
    document.getElementById('telegramChatId').value = telegram.chat_id || '';
    document.getElementById('telegramWarnRx').value = telegram.warn_rx ?? -27;
    document.getElementById('telegramCriticalRx').value = telegram.critical_rx ?? -29;
    document.getElementById('telegramEnabled').checked = !!telegram.enabled;
    document.getElementById('telegramRecovery').checked = !!telegram.notify_recovery;
    const status = document.getElementById('telegramConfigStatus');
    status.textContent = telegram.configured ? (telegram.enabled ? 'Ativo' : 'Configurado') : 'Nao configurado';
    status.className = `badge ${telegram.configured ? 'badge-green' : 'badge-gray'}`;
  }

  scheduleResponsiveHydration(document.getElementById('viewSettings'));
  activateSettingsTab(sessionStorage.getItem('sightops.settings.tab') || 'overview');
  lucide.createIcons();
}

async function saveTelegramSettings() {
  const payload = {
    bot_token: document.getElementById('telegramBotToken')?.value || '',
    chat_id: document.getElementById('telegramChatId')?.value.trim() || '',
    warn_rx: Number(document.getElementById('telegramWarnRx')?.value || -27),
    critical_rx: Number(document.getElementById('telegramCriticalRx')?.value || -29),
    enabled: !!document.getElementById('telegramEnabled')?.checked,
    notify_recovery: !!document.getElementById('telegramRecovery')?.checked,
  };
  const res = await api('/api/monitoring/telegram', { method: 'PUT', body: JSON.stringify(payload) });
  const data = await jsonOrReadableError(res, 'Nao foi possivel salvar o Telegram.');
  document.getElementById('telegramBotToken').value = '';
  showToast(data.configured ? 'Telegram configurado.' : 'Configuracao salva; informe token e chat.');
  await loadSettings();
}

async function testTelegramSettings() {
  await saveTelegramSettings();
  const res = await api('/api/monitoring/telegram/test', { method: 'POST' });
  await jsonOrReadableError(res, 'Nao foi possivel enviar a mensagem de teste.');
  showToast('Mensagem de teste enviada ao Telegram.');
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

let _tenantModulesTarget = null; // { id, name }

async function _getModuleCatalog() {
  if (_moduleCatalogCache) return _moduleCatalogCache;
  const data = await apiJson('/api/auth/modules/catalog');
  _moduleCatalogCache = data?.modules || [];
  return _moduleCatalogCache;
}

async function openTenantModulesModal(tenantId, tenantName) {
  const tenants = await apiJson('/api/auth/tenants', { forceRefresh: true });
  const tenant = (tenants?.tenants || []).find(t => Number(t.id) === Number(tenantId));
  const current = Array.isArray(tenant?.enabled_modules) ? tenant.enabled_modules : null;
  const catalog = await _getModuleCatalog();

  _tenantModulesTarget = { id: tenantId, name: tenantName };
  setText('tenantModulesSubtitle', tenantName);
  document.getElementById('tenantModulesErro').hidden = true;

  const bySection = {};
  catalog.forEach(m => {
    bySection[m.section] = bySection[m.section] || [];
    bySection[m.section].push(m);
  });
  const body = document.getElementById('tenantModulesBody');
  body.innerHTML = Object.entries(bySection).map(([section, mods]) => `
    <div style="margin-bottom:12px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-bottom:6px">${esc(section)}</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
        ${mods.map(m => `
          <label style="display:flex;align-items:center;gap:6px;font-size:13px">
            <input type="checkbox" class="tenant-module-chk" value="${esc(m.key)}" ${(!current || current.includes(m.key)) ? 'checked' : ''}>
            ${esc(m.label)}
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');

  const unrestrictedChk = document.getElementById('tenantModulesUnrestricted');
  unrestrictedChk.checked = current === null;
  body.style.opacity = current === null ? '.45' : '1';
  body.style.pointerEvents = current === null ? 'none' : 'auto';

  document.getElementById('modalTenantModules').classList.remove('hidden');
  lucide.createIcons();
}

function _tenantModulesToggleUnrestricted() {
  const body = document.getElementById('tenantModulesBody');
  const on = document.getElementById('tenantModulesUnrestricted').checked;
  body.style.opacity = on ? '.45' : '1';
  body.style.pointerEvents = on ? 'none' : 'auto';
}

async function saveTenantModules() {
  if (!_tenantModulesTarget) return;
  const unrestricted = document.getElementById('tenantModulesUnrestricted').checked;
  const modules = unrestricted
    ? []
    : [...document.querySelectorAll('.tenant-module-chk:checked')].map(c => c.value);
  const btn = document.getElementById('btnSaveTenantModules');
  btn.disabled = true;
  const res = await api(`/api/auth/tenants/${_tenantModulesTarget.id}/modules`, {
    method: 'PUT',
    body: JSON.stringify({ modules, unrestricted }),
  });
  btn.disabled = false;
  const data = await res?.json().catch(() => ({}));
  if (!res?.ok || data?.ok === false) {
    const el = document.getElementById('tenantModulesErro');
    el.textContent = data?.detail || 'Não foi possível salvar os módulos.';
    el.hidden = false;
    return;
  }
  showToast(`Módulos de ${_tenantModulesTarget.name} atualizados.`);
  document.getElementById('modalTenantModules').classList.add('hidden');
  // Se o admin estiver operando como esse cliente agora, o proprio menu dele
  // muda -- recarrega pra refletir na hora, nao so na proxima troca de tela.
  if ((_currentUser?.effective_tenant_id) === _tenantModulesTarget.id) {
    await loadProfile();
  }
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

