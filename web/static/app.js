/* =========================================================
   cam-snapshot-web  app.js (corrigido, organizado, sem duplicacões)
   - Sem async/await (compatível)
   - 1 init unico
   - WS + fallback HTTP
   - Banner verde no final do scan + update reuse (WS/HTTP)
   - Botões Fechar dos banners funcionando via JS
   - Scripts: banner verde + limpar campos ao fechar + payload compatível com API
   ========================================================= */

/* =========================
   Helpers DOM / Log
   ========================= */
function $(sel) { return document.querySelector(sel); }
function $all(sel) { return document.querySelectorAll(sel); }
function byId(id) { return document.getElementById(id); }
function safeTrim(v) { return (v == null ? '' : String(v)).trim(); }

const AUTH_STORAGE_KEY = 'sightops_auth_v1';
let __authState = {
  enabled: false,
  auth_required: false,
  legacy_open: true,
  bootstrap_allowed: false,
  token: '',
  user: null
};
let __authAdminState = {
  users: [],
  audit: []
};
let __authSelectedUserId = 0;
let __authEditingUserId = 0;
let __appBootstrapped = false;

function authShouldGateUi() {
  return !!__authState.enabled;
}

function authLockUi() {
  try { document.body.classList.add('auth-locked'); } catch (e) {}
}

function authUnlockUi() {
  try { document.body.classList.remove('auth-locked'); } catch (e) {}
}

function bootAppModules() {
  if (__appBootstrapped) return;
  __appBootstrapped = true;

  initUiShell();
  initScanForm();
  initInventoryHandlers();
  initImgBBSettingsInline();
  initOltHandlers();
  initSwitchHandlers();
  initSnapshotHandlers();
  initMaintenanceHandlers();
  initKmzHandlers();
  initScriptsHandlers();
  initBannerCloseButtons();

  if (byId('inv-table') || byId('inventory-body')) {
    loadInventory();
    startInventoryDynamicStatus();
    try { Promise.resolve().finally(refreshInventorySiteOptionsAfterUpdate); } catch (_) {}
  }

  window.runScan = runScan;
  window.runInventoryUpdateClick = runInventoryUpdateClick;
  window.loadInventory = loadInventory;
  window.renderInventoryTable = renderInventoryTable;
  window.applyInventoryFilterDom = applyInventoryFilterDom;
  window.hideSwitchDoneBanner = hideSwitchDoneBanner;
  window.hideSwitchAuthErrorBanner = hideSwitchAuthErrorBanner;

  window.rescanSingleIp = rescanSingleIp;
  window.showInvSuccessBanner = showInvSuccessBanner;
  window.hideInvSuccessBanner = hideInvSuccessBanner;

  window.showEditSuccessBanner = showEditSuccessBanner;
  window.hideEditSuccessBanner = hideEditSuccessBanner;

  window.showScriptsSuccessBanner = showScriptsSuccessBanner;
  window.hideScriptsSuccessBanner = hideScriptsSuccessBanner;

  window.showSnapshotSuccessBanner = showSnapshotSuccessBanner;
  window.hideSnapshotSuccessBanner = hideSnapshotSuccessBanner;

  window.showOltDoneBanner = showOltDoneBanner;
  window.hideOltDoneBanner = hideOltDoneBanner;
  window.showOltAuthErrorBanner = showOltAuthErrorBanner;
  window.hideOltAuthErrorBanner = hideOltAuthErrorBanner;
}

function authRoleRank(role) {
  const r = safeTrim(role || '').toLowerCase();
  if (r === 'owner') return 40;
  if (r === 'admin') return 30;
  if (r === 'operator') return 20;
  return 10;
}

function authCanManageUsers() {
  return authRoleRank(__authState.user && __authState.user.role) >= 30;
}

function authRequiresInitialSetup() {
  const user = __authState.user || {};
  return !!user.setup_required || safeTrim(user.username || '').toLowerCase() === 'admin_teste';
}

function authReadStored() {
  try {
    const raw = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch (e) {
    return null;
  }
}

function authWriteStored(obj) {
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(obj || {}));
  } catch (e) {}
}

function authClearStored() {
  try { localStorage.removeItem(AUTH_STORAGE_KEY); } catch (e) {}
}

function authToken() {
  const active = safeTrim(__authState.token || '');
  if (active) return active;
  const stored = authReadStored();
  const token = safeTrim(stored && stored.token);
  if (token) __authState.token = token;
  if (token && stored && stored.user && !__authState.user) __authState.user = stored.user;
  return token;
}

function authSetSession(token, user) {
  __authState.token = safeTrim(token || '');
  __authState.user = user || null;
  if (__authState.token && __authState.user) {
    authWriteStored({ token: __authState.token, user: __authState.user });
  } else {
    authClearStored();
  }
  if (__authState.user || !authShouldGateUi()) {
    authUnlockUi();
    bootAppModules();
    try { Promise.resolve().finally(refreshInventorySiteOptionsAfterUpdate); } catch (_) {}
    try { window.dispatchEvent(new CustomEvent('sightops:auth-ready')); } catch (_) {}
  }
  renderAuthUi();
  if (__authState.user && authRequiresInitialSetup() && authCanManageUsers()) {
    setTimeout(function () {
      closeAuthModal();
      openAuthAdminModal();
      setAuthAdminStatus('Crie o usuario principal. Depois disso o admin_teste sera desativado automaticamente.');
      const role = byId('auth-new-role');
      const active = byId('auth-new-active');
      const username = byId('auth-new-username');
      if (role) role.value = 'owner';
      if (active) active.checked = true;
      if (username) {
        try { username.focus(); } catch (e) {}
      }
    }, 250);
  }
}

function authClearSession() {
  __authState.token = '';
  __authState.user = null;
  authClearStored();
  if (authShouldGateUi()) authLockUi();
  renderAuthUi();
}

function authIsSameOriginApi(url) {
  const raw = safeTrim(url || '');
  if (!raw) return false;
  if (raw.indexOf('/api/') === 0) return true;
  try {
    const u = new URL(raw, window.location.origin);
    return u.origin === window.location.origin && u.pathname.indexOf('/api/') === 0;
  } catch (e) {
    return false;
  }
}

function authIsPublicApi(url) {
  const raw = safeTrim(url || '');
  if (!authIsSameOriginApi(raw)) return true;
  try {
    const u = new URL(raw, window.location.origin);
    const p = u.pathname;
    return p === '/api/auth/status' ||
      p === '/api/auth/login' ||
      p === '/api/auth/bootstrap-admin' ||
      p === '/api/system/health/live' ||
      p === '/api/system/health/ready' ||
      p === '/api/system/info';
  } catch (e) {
    return true;
  }
}

function buildAuthedWsUrl(path) {
  const proto = (location.protocol === 'https:') ? 'wss' : 'ws';
  return proto + '://' + location.host + String(path || '');
}

function authAppendTokenParam(url) {
  const token = authToken();
  if (!token) return url;
  try {
    const u = new URL(String(url || ''), window.location.origin);
    if (u.origin !== window.location.origin || u.pathname.indexOf('/api/') !== 0) return url;
    if (!u.searchParams.has('auth_token')) u.searchParams.set('auth_token', token);
    return u.pathname + u.search + u.hash;
  } catch (e) {
    return url;
  }
}

function authIsSessionUnauthorizedPayload(payload) {
  const detail = safeTrim(
    (payload && (payload.detail || payload.error || payload.message || payload.msg)) || ''
  ).toLowerCase();
  if (!detail) return false;
  return detail.indexOf('autenticacao obrigatoria') >= 0 ||
    detail.indexOf('token invalido') >= 0 ||
    detail.indexOf('token inválido') >= 0 ||
    detail.indexOf('token expirado') >= 0 ||
    detail.indexOf('authorization ausente') >= 0 ||
    detail.indexOf('authorization invalida') >= 0 ||
    detail.indexOf('authorization inválida') >= 0;
}

function authShouldHandleUnauthorized(resp) {
  if (!resp || resp.status !== 401) return Promise.resolve(false);
  try {
    return resp.clone().json()
      .then(function (payload) { return authIsSessionUnauthorizedPayload(payload); })
      .catch(function () { return false; });
  } catch (e) {
    return Promise.resolve(false);
  }
}

function normalizeReportColor(value) {
  const raw = safeTrim(value || '');
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return '#' + raw;
  return '#0b2242';
}

function sendWsAuthFrame(ws) {
  if (!__authState.enabled) return;
  const token = safeTrim(authToken() || '');
  if (!token || !ws) return;
  ws.send(JSON.stringify({ type: 'auth', token: token }));
}

function installAuthFetchHook() {
  if (window.__sightopsAuthFetchWrapped) return;
  if (typeof window.fetch !== 'function') return;
  const nativeFetch = window.fetch.bind(window);
  window.__sightopsNativeFetch = nativeFetch;
  window.fetch = function (input, init) {
    let url = '';
    if (typeof input === 'string') url = input;
    else if (input && input.url) url = input.url;

    let nextInit = init ? Object.assign({}, init) : {};
    const shouldAttach = authIsSameOriginApi(url) && !authIsPublicApi(url);
    if (shouldAttach) {
      const hdrs = new Headers(nextInit.headers || (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined) || {});
      const token = authToken();
      if (token && !hdrs.has('Authorization')) {
        hdrs.set('Authorization', 'Bearer ' + token);
      }
      nextInit.headers = hdrs;
    }

    let nextInput = input;
    if (typeof Request !== 'undefined' && input instanceof Request && nextInit.headers) {
      nextInput = new Request(input, nextInit);
      nextInit = undefined;
    }

    return nativeFetch(nextInput, nextInit).then(function (resp) {
      if (resp && resp.status === 401 && shouldAttach) {
        authShouldHandleUnauthorized(resp).then(function (isSessionUnauthorized) {
          if (isSessionUnauthorized) authHandleUnauthorized();
        });
      }
      return resp;
    });
  };
  window.__sightopsAuthFetchWrapped = true;
}

installAuthFetchHook();

function ensureAuthShell() {
  const topbarRight = document.querySelector('.topbar-right');
  if (topbarRight && !byId('auth-shell')) {
    const wrap = document.createElement('div');
    wrap.id = 'auth-shell';
    wrap.className = 'auth-shell';
    wrap.innerHTML = ''
      + '<div id="auth-chip" class="auth-chip" style="display:none;"></div>'
      + '<button id="auth-admin-btn" class="topbar-btn" type="button" style="display:none;">Acessos</button>'
      + '<button id="auth-open-btn" class="topbar-btn" type="button">Entrar</button>'
      + '<button id="auth-logout-btn" class="topbar-btn" type="button" style="display:none;">Sair</button>';
    topbarRight.appendChild(wrap);
  }

  if (!byId('auth-backdrop')) {
    const host = document.createElement('div');
    host.innerHTML = ''
      + '<div id="auth-backdrop" class="modal-backdrop" style="display:none;" aria-hidden="true">'
      + '  <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="auth-modal-title">'
      + '    <div class="modal-header">'
      + '      <div>'
      + '        <div id="auth-modal-title" class="modal-title">Acesso ao SightOps</div>'
      + '        <div id="auth-modal-sub" class="modal-sub">Entre com sua conta para continuar.</div>'
      + '      </div>'
      + '      <button type="button" class="modal-close" id="auth-close-btn">x</button>'
      + '    </div>'
      + '    <div class="modal-body">'
      + '      <div id="auth-modal-status" class="status-line" style="margin-bottom:10px;"></div>'
      + '      <form id="auth-login-form" class="auth-form">'
      + '        <div class="field"><label for="auth-username">Usuario</label><input id="auth-username" type="text" autocomplete="username" /></div>'
      + '        <div class="field"><label for="auth-password">Senha</label><input id="auth-password" type="password" autocomplete="current-password" /></div>'
      + '        <div class="actions-row"><button id="auth-login-submit" type="submit" class="btn-primary" style="width:100%;">Entrar</button></div>'
      + '      </form>'
      + '      <form id="auth-bootstrap-form" class="auth-form" style="display:none;">'
      + '        <div class="field"><label for="auth-bootstrap-tenant">Empresa</label><input id="auth-bootstrap-tenant" type="text" placeholder="Default" /></div>'
      + '        <div class="field"><label for="auth-bootstrap-username">Usuario admin</label><input id="auth-bootstrap-username" type="text" autocomplete="username" /></div>'
      + '        <div class="field"><label for="auth-bootstrap-password">Senha</label><input id="auth-bootstrap-password" type="password" autocomplete="new-password" /></div>'
      + '        <div class="actions-row"><button id="auth-bootstrap-submit" type="submit" class="btn-primary" style="width:100%;">Criar primeiro admin</button></div>'
      + '      </form>'
      + '      <div class="auth-switch-row">'
      + '        <button id="auth-switch-login" type="button" class="btn-secondary btn-sm" style="display:none;">Ja tenho conta</button>'
      + '        <button id="auth-switch-bootstrap" type="button" class="btn-secondary btn-sm" style="display:none;">Primeiro acesso</button>'
      + '      </div>'
      + '    </div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(host.firstChild);
  }

  if (!byId('auth-admin-backdrop')) {
    const host = document.createElement('div');
    host.innerHTML = ''
      + '<div id="auth-admin-backdrop" class="modal-backdrop" style="display:none;" aria-hidden="true">'
      + '  <div class="modal auth-admin-modal" role="dialog" aria-modal="true" aria-labelledby="auth-admin-title">'
      + '    <div class="modal-header">'
      + '      <div>'
      + '        <div id="auth-admin-title" class="modal-title">Acessos</div>'
      + '        <div class="modal-sub">Gerencie usuarios, perfis e atividade recente da empresa.</div>'
      + '      </div>'
      + '      <button type="button" class="modal-close" id="auth-admin-close-btn">x</button>'
      + '    </div>'
      + '    <div class="modal-body auth-admin-body">'
      + '      <div id="auth-admin-status" class="status-line"></div>'
      + '      <div class="auth-admin-summary" aria-label="Resumo dos acessos">'
      + '        <div class="auth-summary-card"><span>Total</span><strong id="auth-admin-total-users">0</strong></div>'
      + '        <div class="auth-summary-card"><span>Ativos</span><strong id="auth-admin-active-users">0</strong></div>'
      + '        <div class="auth-summary-card"><span>Admins</span><strong id="auth-admin-admin-users">0</strong></div>'
      + '      </div>'
      + '      <div class="auth-admin-grid">'
      + '        <section class="auth-admin-panel auth-create-panel">'
      + '          <div class="auth-admin-panel-head">'
      + '            <div class="card-title">Novo acesso</div>'
      + '            <div class="card-sub">Crie usuarios com o menor perfil necessario para a rotina.</div>'
      + '          </div>'
      + '          <form id="auth-user-create-form" class="auth-form auth-form-grid">'
      + '            <div class="field"><label for="auth-new-username">Usuario</label><input id="auth-new-username" type="text" autocomplete="off" /></div>'
      + '            <div class="field"><label for="auth-new-full-name">Nome</label><input id="auth-new-full-name" type="text" autocomplete="off" /></div>'
      + '            <div class="field field-full"><label for="auth-new-email">Email</label><input id="auth-new-email" type="email" autocomplete="off" /></div>'
      + '            <div class="field"><label for="auth-new-role">Perfil</label><select id="auth-new-role"><option value="viewer">Visualizador</option><option value="operator">Operador</option><option value="admin">Admin</option><option value="owner">Owner</option></select></div>'
      + '            <div class="field"><label for="auth-new-password">Senha</label><input id="auth-new-password" type="password" autocomplete="new-password" /></div>'
      + '            <div class="check-row field-full"><input type="checkbox" id="auth-new-active" checked /><label for="auth-new-active">Usuario ativo</label></div>'
      + '            <div class="actions-row field-full"><button type="submit" class="btn-primary" style="width:100%;">Criar acesso</button></div>'
      + '          </form>'
      + '        </section>'
      + '        <section class="auth-admin-panel">'
      + '          <div class="auth-admin-panel-head auth-admin-panel-head-inline">'
      + '            <div><div class="card-title">Usuarios</div><div class="card-sub">Lista atual desta empresa.</div></div>'
      + '            <button type="button" id="auth-users-refresh-btn" class="btn-secondary btn-sm">Atualizar</button>'
      + '          </div>'
      + '          <div class="table-wrap auth-admin-table-wrap"><table class="inv-table auth-users-table"><thead><tr><th>Usuario</th><th>Perfil</th><th>Status</th><th>Empresa</th><th>Acoes</th></tr></thead><tbody id="auth-users-body"></tbody></table></div>'
      + '        </section>'
      + '      </div>'
      + '      <section class="auth-admin-panel auth-admin-audit-panel">'
      + '        <div class="auth-admin-panel-head auth-admin-panel-head-inline">'
      + '          <div><div class="card-title">Auditoria recente</div><div class="card-sub">Eventos mais recentes de acesso e administracao.</div></div>'
      + '          <button type="button" id="auth-audit-refresh-btn" class="btn-secondary btn-sm">Atualizar</button>'
      + '        </div>'
      + '        <div id="auth-audit-list" class="auth-audit-list"></div>'
      + '      </section>'
      + '    </div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(host.firstChild);
  }

  if (!byId('auth-password-backdrop')) {
    const host = document.createElement('div');
    host.innerHTML = ''
      + '<div id="auth-password-backdrop" class="modal-backdrop" style="display:none;" aria-hidden="true">'
      + '  <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="auth-password-title">'
      + '    <div class="modal-header">'
      + '      <div><div id="auth-password-title" class="modal-title">Redefinir senha</div><div id="auth-password-sub" class="modal-sub">Defina uma nova senha para o usuario selecionado.</div></div>'
      + '      <button type="button" class="modal-close" id="auth-password-close-btn">x</button>'
      + '    </div>'
      + '    <div class="modal-body">'
      + '      <div id="auth-password-status" class="status-line" style="margin-bottom:10px;"></div>'
      + '      <form id="auth-password-form" class="auth-form">'
      + '        <div class="field"><label for="auth-password-new">Nova senha</label><input id="auth-password-new" type="password" autocomplete="new-password" /></div>'
      + '        <div class="actions-row"><button type="submit" class="btn-primary" style="width:100%;">Salvar nova senha</button></div>'
      + '      </form>'
      + '    </div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(host.firstChild);
  }

  if (!byId('auth-edit-backdrop')) {
    const host = document.createElement('div');
    host.innerHTML = ''
      + '<div id="auth-edit-backdrop" class="modal-backdrop" style="display:none;" aria-hidden="true">'
      + '  <div class="modal modal-sm" role="dialog" aria-modal="true" aria-labelledby="auth-edit-title">'
      + '    <div class="modal-header">'
      + '      <div><div id="auth-edit-title" class="modal-title">Editar usuario</div><div id="auth-edit-sub" class="modal-sub">Atualize nome, email e perfil.</div></div>'
      + '      <button type="button" class="modal-close" id="auth-edit-close-btn">x</button>'
      + '    </div>'
      + '    <div class="modal-body">'
      + '      <div id="auth-edit-status" class="status-line" style="margin-bottom:10px;"></div>'
      + '      <form id="auth-edit-form" class="auth-form">'
      + '        <div class="field"><label for="auth-edit-full-name">Nome</label><input id="auth-edit-full-name" type="text" autocomplete="off" /></div>'
      + '        <div class="field"><label for="auth-edit-email">Email</label><input id="auth-edit-email" type="email" autocomplete="off" /></div>'
      + '        <div class="field"><label for="auth-edit-role">Perfil</label><select id="auth-edit-role"><option value="viewer">viewer</option><option value="operator">operator</option><option value="admin">admin</option><option value="owner">owner</option></select></div>'
      + '        <div class="actions-row"><button type="submit" class="btn-primary" style="width:100%;">Salvar alteracoes</button></div>'
      + '      </form>'
      + '    </div>'
      + '  </div>'
      + '</div>';
    document.body.appendChild(host.firstChild);
  }

  const openBtn = byId('auth-open-btn');
  const adminBtn = byId('auth-admin-btn');
  const logoutBtn = byId('auth-logout-btn');
  const closeBtn = byId('auth-close-btn');
  const loginForm = byId('auth-login-form');
  const bootstrapForm = byId('auth-bootstrap-form');
  const swLogin = byId('auth-switch-login');
  const swBootstrap = byId('auth-switch-bootstrap');
  const backdrop = byId('auth-backdrop');
  const adminBackdrop = byId('auth-admin-backdrop');
  const adminCloseBtn = byId('auth-admin-close-btn');
  const createUserForm = byId('auth-user-create-form');
  const usersRefreshBtn = byId('auth-users-refresh-btn');
  const auditRefreshBtn = byId('auth-audit-refresh-btn');
  const passwordBackdrop = byId('auth-password-backdrop');
  const passwordCloseBtn = byId('auth-password-close-btn');
  const passwordForm = byId('auth-password-form');
  const editBackdrop = byId('auth-edit-backdrop');
  const editCloseBtn = byId('auth-edit-close-btn');
  const editForm = byId('auth-edit-form');

  if (openBtn && !openBtn.dataset.bound) {
    openBtn.dataset.bound = '1';
    openBtn.addEventListener('click', function () {
      openAuthModal(__authState.bootstrap_allowed ? 'bootstrap' : 'login');
    });
  }
  if (logoutBtn && !logoutBtn.dataset.bound) {
    logoutBtn.dataset.bound = '1';
    logoutBtn.addEventListener('click', function () { authLogout(); });
  }
  if (adminBtn && !adminBtn.dataset.bound) {
    adminBtn.dataset.bound = '1';
    adminBtn.addEventListener('click', function () { openAuthAdminModal(); });
  }
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', function () { closeAuthModal(); });
  }
  if (backdrop && !backdrop.dataset.bound) {
    backdrop.dataset.bound = '1';
    backdrop.addEventListener('click', function (ev) {
      if (ev && ev.target === backdrop && !__authState.auth_required) closeAuthModal();
    });
  }
  if (adminBackdrop && !adminBackdrop.dataset.bound) {
    adminBackdrop.dataset.bound = '1';
    adminBackdrop.addEventListener('click', function (ev) {
      if (ev && ev.target === adminBackdrop) closeAuthAdminModal();
    });
  }
  if (adminCloseBtn && !adminCloseBtn.dataset.bound) {
    adminCloseBtn.dataset.bound = '1';
    adminCloseBtn.addEventListener('click', function () { closeAuthAdminModal(); });
  }
  if (swLogin && !swLogin.dataset.bound) {
    swLogin.dataset.bound = '1';
    swLogin.addEventListener('click', function () { setAuthMode('login'); });
  }
  if (swBootstrap && !swBootstrap.dataset.bound) {
    swBootstrap.dataset.bound = '1';
    swBootstrap.addEventListener('click', function () { setAuthMode('bootstrap'); });
  }
  if (loginForm && !loginForm.dataset.bound) {
    loginForm.dataset.bound = '1';
    loginForm.addEventListener('submit', function (ev) {
      if (ev) ev.preventDefault();
      authSubmitLogin();
    });
  }
  if (bootstrapForm && !bootstrapForm.dataset.bound) {
    bootstrapForm.dataset.bound = '1';
    bootstrapForm.addEventListener('submit', function (ev) {
      if (ev) ev.preventDefault();
      authSubmitBootstrap();
    });
  }
  if (createUserForm && !createUserForm.dataset.bound) {
    createUserForm.dataset.bound = '1';
    createUserForm.addEventListener('submit', function (ev) {
      if (ev) ev.preventDefault();
      authSubmitCreateUser();
    });
  }
  if (usersRefreshBtn && !usersRefreshBtn.dataset.bound) {
    usersRefreshBtn.dataset.bound = '1';
    usersRefreshBtn.addEventListener('click', function () { authLoadUsers(); });
  }
  if (auditRefreshBtn && !auditRefreshBtn.dataset.bound) {
    auditRefreshBtn.dataset.bound = '1';
    auditRefreshBtn.addEventListener('click', function () { authLoadAudit(); });
  }
  if (passwordBackdrop && !passwordBackdrop.dataset.bound) {
    passwordBackdrop.dataset.bound = '1';
    passwordBackdrop.addEventListener('click', function (ev) {
      if (ev && ev.target === passwordBackdrop) closeAuthPasswordModal();
    });
  }
  if (passwordCloseBtn && !passwordCloseBtn.dataset.bound) {
    passwordCloseBtn.dataset.bound = '1';
    passwordCloseBtn.addEventListener('click', function () { closeAuthPasswordModal(); });
  }
  if (passwordForm && !passwordForm.dataset.bound) {
    passwordForm.dataset.bound = '1';
    passwordForm.addEventListener('submit', function (ev) {
      if (ev) ev.preventDefault();
      authSubmitResetPassword();
    });
  }
  if (editBackdrop && !editBackdrop.dataset.bound) {
    editBackdrop.dataset.bound = '1';
    editBackdrop.addEventListener('click', function (ev) {
      if (ev && ev.target === editBackdrop) closeAuthEditModal();
    });
  }
  if (editCloseBtn && !editCloseBtn.dataset.bound) {
    editCloseBtn.dataset.bound = '1';
    editCloseBtn.addEventListener('click', function () { closeAuthEditModal(); });
  }
  if (editForm && !editForm.dataset.bound) {
    editForm.dataset.bound = '1';
    editForm.addEventListener('submit', function (ev) {
      if (ev) ev.preventDefault();
      authSubmitEditUser();
    });
  }
}

function setAuthStatusMessage(msg, ok) {
  const el = byId('auth-modal-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok ? '#15803d' : '';
}

function setAuthMode(mode) {
  const loginForm = byId('auth-login-form');
  const bootstrapForm = byId('auth-bootstrap-form');
  const swLogin = byId('auth-switch-login');
  const swBootstrap = byId('auth-switch-bootstrap');
  const title = byId('auth-modal-title');
  const sub = byId('auth-modal-sub');
  const isBootstrap = mode === 'bootstrap';

  if (loginForm) loginForm.style.display = isBootstrap ? 'none' : '';
  if (bootstrapForm) bootstrapForm.style.display = isBootstrap ? '' : 'none';
  if (swLogin) swLogin.style.display = isBootstrap ? '' : 'none';
  if (swBootstrap) swBootstrap.style.display = (!isBootstrap && __authState.bootstrap_allowed) ? '' : 'none';
  if (title) title.textContent = isBootstrap ? 'Primeiro acesso' : 'Acesso ao SightOps';
  if (sub) sub.textContent = isBootstrap
    ? 'Crie a conta proprietaria inicial da sua instancia.'
    : 'Entre com sua conta para continuar.';
  setAuthStatusMessage('');
}

function openAuthModal(mode) {
  const backdrop = byId('auth-backdrop');
  if (!backdrop) return;
  setAuthMode(mode || (__authState.bootstrap_allowed ? 'bootstrap' : 'login'));
  backdrop.style.display = 'flex';
  backdrop.setAttribute('aria-hidden', 'false');
}

function closeAuthModal() {
  const backdrop = byId('auth-backdrop');
  if (!backdrop) return;
  if (__authState.auth_required && !__authState.user) return;
  backdrop.style.display = 'none';
  backdrop.setAttribute('aria-hidden', 'true');
}

function renderAuthUi() {
  ensureAuthShell();
  const chip = byId('auth-chip');
  const adminBtn = byId('auth-admin-btn');
  const openBtn = byId('auth-open-btn');
  const logoutBtn = byId('auth-logout-btn');
  const user = __authState.user;

  if (!__authState.enabled) {
    if (chip) chip.style.display = 'none';
    if (adminBtn) adminBtn.style.display = 'none';
    if (openBtn) openBtn.style.display = 'none';
    if (logoutBtn) logoutBtn.style.display = 'none';
    closeAuthModal();
    closeAuthAdminModal();
    return;
  }

  if (user) {
    if (chip) {
      chip.style.display = 'inline-flex';
      chip.textContent = (user.full_name || user.username || 'Usuario') + '  ·  ' + (user.tenant_name || user.tenant_slug || 'Tenant');
    }
    if (openBtn) {
      openBtn.style.display = 'none';
    }
    if (adminBtn) {
      adminBtn.style.display = authCanManageUsers() ? '' : 'none';
    }
    if (logoutBtn) {
      logoutBtn.style.display = '';
    }
    closeAuthModal();
    return;
  }

  if (chip) {
    chip.style.display = 'inline-flex';
    chip.textContent = __authState.bootstrap_allowed ? 'Instancia sem admin' : 'Nao autenticado';
  }
  if (adminBtn) adminBtn.style.display = 'none';
  if (openBtn) {
    openBtn.style.display = '';
    openBtn.textContent = __authState.bootstrap_allowed ? 'Ativar acesso' : 'Entrar';
  }
  if (logoutBtn) logoutBtn.style.display = 'none';
}

function authHandleUnauthorized() {
  const hadToken = !!authToken();
  authClearSession();
  if (__authState.enabled && (__authState.auth_required || hadToken)) {
    authLockUi();
    openAuthModal(__authState.bootstrap_allowed ? 'bootstrap' : 'login');
    setAuthStatusMessage('Sua sessao expirou. Entre novamente.');
  }
}

function authLoadStoredSession() {
  const stored = authReadStored();
  if (!stored || !stored.token) return;
  __authState.token = safeTrim(stored.token || '');
  __authState.user = stored.user || null;
}

function authSubmitLogin() {
  const username = safeTrim(byId('auth-username')?.value || '');
  const password = safeTrim(byId('auth-password')?.value || '');
  if (!username || !password) {
    setAuthStatusMessage('Informe usuario e senha.');
    return;
  }
  setAuthStatusMessage('Entrando...');
  fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: username, password: password, label: 'web-ui' })
  })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (!data || !data.ok || !data.access_token) {
        throw new Error(data && data.detail ? data.detail : 'Falha no login.');
      }
      authSetSession(data.access_token, data.user || null);
      setAuthStatusMessage('Login realizado com sucesso.', true);
      setTimeout(function () { closeAuthModal(); }, 200);
    })
    .catch(function (err) {
      setAuthStatusMessage((err && err.message) ? err.message : 'Falha no login.');
    });
}

function authSubmitBootstrap() {
  const tenantName = safeTrim(byId('auth-bootstrap-tenant')?.value || 'Default');
  const username = safeTrim(byId('auth-bootstrap-username')?.value || '');
  const password = safeTrim(byId('auth-bootstrap-password')?.value || '');
  if (!tenantName || !username || !password) {
    setAuthStatusMessage('Preencha empresa, usuario e senha.');
    return;
  }
  setAuthStatusMessage('Criando admin inicial...');
  fetch('/api/auth/bootstrap-admin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: username,
      password: password,
      tenant_slug: tenantName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      tenant_name: tenantName
    })
  })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (!data || !data.ok) {
        throw new Error(data && data.detail ? data.detail : 'Falha ao criar admin inicial.');
      }
      __authState.bootstrap_allowed = false;
      setAuthMode('login');
      byId('auth-username').value = username;
      byId('auth-password').value = password;
      setAuthStatusMessage('Admin criado. Fazendo login...', true);
      authSubmitLogin();
    })
    .catch(function (err) {
      setAuthStatusMessage((err && err.message) ? err.message : 'Falha ao criar admin inicial.');
    });
}

function authLogout() {
  const token = authToken();
  if (!token) {
    authClearSession();
    return;
  }
  fetch('/api/auth/logout', { method: 'POST' })
    .finally(function () {
      closeAuthAdminModal();
      authClearSession();
      if (__authState.enabled) openAuthModal('login');
    });
}

function setAuthAdminStatus(msg, ok) {
  const el = byId('auth-admin-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok ? '#15803d' : '';
}

function setAuthPasswordStatus(msg, ok) {
  const el = byId('auth-password-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok ? '#15803d' : '';
}

function setAuthEditStatus(msg, ok) {
  const el = byId('auth-edit-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = ok ? '#15803d' : '';
}

function renderAuthUsersTable() {
  const body = byId('auth-users-body');
  if (!body) return;
  const rows = Array.isArray(__authAdminState.users) ? __authAdminState.users : [];
  const totalEl = byId('auth-admin-total-users');
  const activeEl = byId('auth-admin-active-users');
  const adminEl = byId('auth-admin-admin-users');
  const activeCount = rows.filter(function (u) { return !!u.active; }).length;
  const adminCount = rows.filter(function (u) {
    const role = safeTrim(u.role || '').toLowerCase();
    return role === 'admin' || role === 'owner';
  }).length;
  if (totalEl) totalEl.textContent = String(rows.length);
  if (activeEl) activeEl.textContent = String(activeCount);
  if (adminEl) adminEl.textContent = String(adminCount);
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">Nenhum usuario encontrado.</td></tr>';
    return;
  }
  const roleLabels = { viewer: 'Visualizador', operator: 'Operador', admin: 'Admin', owner: 'Owner' };
  body.innerHTML = rows.map(function (u) {
    const name = safeTrim(u.full_name || u.username || '');
    const username = safeTrim(u.username || '');
    const email = safeTrim(u.email || '');
    const role = safeTrim(u.role || '').toLowerCase();
    const roleLabel = roleLabels[role] || safeTrim(u.role || 'Perfil');
    const status = u.active ? 'Ativo' : 'Inativo';
    const canTouch = authRoleRank(__authState.user && __authState.user.role) >= 40 || safeTrim(u.role || '').toLowerCase() !== 'owner';
    const toggleLabel = u.active ? 'Inativar' : 'Ativar';
    const initial = escapeHtml((name || username || '?').charAt(0).toUpperCase());
    const userMeta = escapeHtml(username) + (email ? ' · ' + escapeHtml(email) : '');
    const tenant = safeTrim(u.tenant_name || u.tenant_slug || '');
    return '<tr>'
      + '<td><div class="auth-user-cell"><span class="auth-user-avatar">' + initial + '</span><span><strong>' + escapeHtml(name || username || 'Usuario') + '</strong><small>' + userMeta + '</small></span></div></td>'
      + '<td><span class="auth-role-badge auth-role-' + escapeHtml(role || 'viewer') + '">' + escapeHtml(roleLabel) + '</span></td>'
      + '<td><span class="auth-status-badge ' + (u.active ? 'is-active' : 'is-inactive') + '">' + status + '</span></td>'
      + '<td><span class="auth-tenant-name">' + escapeHtml(tenant || '-') + '</span></td>'
      + '<td><div class="auth-user-actions">'
      + '<button type="button" class="btn-secondary btn-sm auth-user-edit-btn" data-user-id="' + String(u.id || '') + '"' + (canTouch ? '' : ' disabled') + '>Editar</button>'
      + '<button type="button" class="btn-secondary btn-sm auth-user-toggle-btn" data-user-id="' + String(u.id || '') + '" data-next-active="' + (u.active ? '0' : '1') + '"' + (canTouch ? '' : ' disabled') + '>' + toggleLabel + '</button>'
      + '<button type="button" class="btn-secondary btn-sm auth-user-pass-btn" data-user-id="' + String(u.id || '') + '" data-user-name="' + escapeHtml(name || username || 'usuario') + '"' + (canTouch ? '' : ' disabled') + '>Senha</button>'
      + '</div></td>'
      + '</tr>';
  }).join('');
  bindAuthUserActionButtons();
}

function bindAuthUserActionButtons() {
  $all('.auth-user-edit-btn').forEach(function (btn) {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      const userId = parseInt(btn.getAttribute('data-user-id') || '0', 10);
      openAuthEditModal(userId);
    });
  });
  $all('.auth-user-toggle-btn').forEach(function (btn) {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      const userId = parseInt(btn.getAttribute('data-user-id') || '0', 10);
      const nextActive = String(btn.getAttribute('data-next-active') || '') === '1';
      authToggleUserActive(userId, nextActive);
    });
  });
  $all('.auth-user-pass-btn').forEach(function (btn) {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', function () {
      const userId = parseInt(btn.getAttribute('data-user-id') || '0', 10);
      const userName = safeTrim(btn.getAttribute('data-user-name') || 'usuario');
      openAuthPasswordModal(userId, userName);
    });
  });
}

function renderAuthAuditList() {
  const host = byId('auth-audit-list');
  if (!host) return;
  const rows = Array.isArray(__authAdminState.audit) ? __authAdminState.audit : [];
  if (!rows.length) {
    host.innerHTML = '<div class="muted">Sem eventos recentes.</div>';
    return;
  }
  host.innerHTML = rows.map(function (ev) {
    return '<div class="auth-audit-item">'
      + '<span class="auth-audit-dot"></span>'
      + '<div class="auth-audit-content"><div class="auth-audit-main">' + escapeHtml(safeTrim(ev.action || 'evento')) + '</div>'
      + '<div class="auth-audit-meta">' + escapeHtml(safeTrim(ev.created_at || '')) + (ev.resource_type ? ' · ' + escapeHtml(safeTrim(ev.resource_type)) : '') + (ev.resource_id ? ' · ' + escapeHtml(safeTrim(ev.resource_id)) : '') + '</div></div>'
      + '</div>';
  }).join('');
}

function authLoadUsers() {
  if (!authCanManageUsers()) return Promise.resolve();
  setAuthAdminStatus('Carregando usuarios...');
  return fetch('/api/auth/users?_=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (!data || !data.ok) throw new Error(data && data.detail ? data.detail : 'Falha ao carregar usuarios.');
      __authAdminState.users = Array.isArray(data.users) ? data.users : [];
      renderAuthUsersTable();
      setAuthAdminStatus('Usuarios atualizados.', true);
    })
    .catch(function (err) {
      setAuthAdminStatus((err && err.message) ? err.message : 'Falha ao carregar usuarios.');
    });
}

function authLoadAudit() {
  if (!authCanManageUsers()) return Promise.resolve();
  return fetch('/api/auth/audit?limit=20&_=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (!data || !data.ok) throw new Error(data && data.detail ? data.detail : 'Falha ao carregar auditoria.');
      __authAdminState.audit = Array.isArray(data.events) ? data.events : [];
      renderAuthAuditList();
    })
    .catch(function () {
      __authAdminState.audit = [];
      renderAuthAuditList();
    });
}

function authSubmitCreateUser() {
  if (!authCanManageUsers()) return;
  const payload = {
    username: safeTrim(byId('auth-new-username')?.value || ''),
    full_name: safeTrim(byId('auth-new-full-name')?.value || ''),
    email: safeTrim(byId('auth-new-email')?.value || ''),
    role: safeTrim(byId('auth-new-role')?.value || 'viewer'),
    password: safeTrim(byId('auth-new-password')?.value || ''),
    active: !!byId('auth-new-active')?.checked
  };
  if (!payload.username || !payload.password) {
    setAuthAdminStatus('Informe usuario e senha.');
    return;
  }
  setAuthAdminStatus('Criando usuario...');
  fetch('/api/auth/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (!data || !data.ok) throw new Error(data && data.detail ? data.detail : 'Falha ao criar usuario.');
      if (data.setup_completed) {
        const newUsername = payload.username;
        setAuthAdminStatus('Usuario principal criado. admin_teste foi desativado. Entre com o novo usuario.', true);
        const formDone = byId('auth-user-create-form');
        if (formDone) formDone.reset();
        setTimeout(function () {
          closeAuthAdminModal();
          authClearSession();
          openAuthModal('login');
          const loginUser = byId('auth-username');
          const loginPass = byId('auth-password');
          if (loginUser) loginUser.value = newUsername;
          if (loginPass) loginPass.value = '';
          setAuthStatusMessage('Entre com o usuario que acabou de criar.', true);
        }, 700);
        return null;
      }
      setAuthAdminStatus('Usuario criado com sucesso.', true);
      const form = byId('auth-user-create-form');
      if (form) form.reset();
      const active = byId('auth-new-active');
      if (active) active.checked = true;
      return Promise.all([authLoadUsers(), authLoadAudit()]);
    })
    .catch(function (err) {
      setAuthAdminStatus((err && err.message) ? err.message : 'Falha ao criar usuario.');
    });
}

function openAuthEditModal(userId) {
  const user = (__authAdminState.users || []).find(function (u) { return Number(u.id || 0) === Number(userId || 0); });
  if (!user) return;
  __authEditingUserId = Number(userId || 0);
  const backdrop = byId('auth-edit-backdrop');
  const sub = byId('auth-edit-sub');
  if (sub) sub.textContent = 'Atualize os dados de ' + safeTrim(user.username || 'usuario') + '.';
  const fullName = byId('auth-edit-full-name');
  const email = byId('auth-edit-email');
  const role = byId('auth-edit-role');
  if (fullName) fullName.value = safeTrim(user.full_name || '');
  if (email) email.value = safeTrim(user.email || '');
  if (role) role.value = safeTrim(user.role || 'viewer');
  setAuthEditStatus('');
  if (!backdrop) return;
  backdrop.style.display = 'flex';
  backdrop.setAttribute('aria-hidden', 'false');
}

function closeAuthEditModal() {
  __authEditingUserId = 0;
  const backdrop = byId('auth-edit-backdrop');
  if (!backdrop) return;
  backdrop.style.display = 'none';
  backdrop.setAttribute('aria-hidden', 'true');
}

function authSubmitEditUser() {
  if (!__authEditingUserId) return;
  const payload = {
    full_name: safeTrim(byId('auth-edit-full-name')?.value || ''),
    email: safeTrim(byId('auth-edit-email')?.value || ''),
    role: safeTrim(byId('auth-edit-role')?.value || 'viewer')
  };
  setAuthEditStatus('Salvando alteracoes...');
  fetch('/api/auth/users/' + encodeURIComponent(__authEditingUserId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (!data || !data.ok) throw new Error(data && data.detail ? data.detail : 'Falha ao atualizar usuario.');
      setAuthEditStatus('Usuario atualizado com sucesso.', true);
      return Promise.all([authLoadUsers(), authLoadAudit()]).then(function () {
        setTimeout(function () { closeAuthEditModal(); }, 220);
      });
    })
    .catch(function (err) {
      setAuthEditStatus((err && err.message) ? err.message : 'Falha ao atualizar usuario.');
    });
}

function authToggleUserActive(userId, active) {
  if (!userId) return;
  setAuthAdminStatus((active ? 'Ativando' : 'Inativando') + ' usuario...');
  fetch('/api/auth/users/' + encodeURIComponent(userId) + '/active', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: !!active })
  })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (!data || !data.ok) throw new Error(data && data.detail ? data.detail : 'Falha ao atualizar usuario.');
      setAuthAdminStatus('Usuario atualizado com sucesso.', true);
      return Promise.all([authLoadUsers(), authLoadAudit()]);
    })
    .catch(function (err) {
      setAuthAdminStatus((err && err.message) ? err.message : 'Falha ao atualizar usuario.');
    });
}

function openAuthPasswordModal(userId, userName) {
  if (!userId) return;
  __authSelectedUserId = userId;
  const backdrop = byId('auth-password-backdrop');
  const sub = byId('auth-password-sub');
  const inp = byId('auth-password-new');
  if (sub) sub.textContent = 'Defina uma nova senha para ' + (userName || 'o usuario selecionado') + '.';
  if (inp) inp.value = '';
  setAuthPasswordStatus('');
  if (!backdrop) return;
  backdrop.style.display = 'flex';
  backdrop.setAttribute('aria-hidden', 'false');
}

function closeAuthPasswordModal() {
  __authSelectedUserId = 0;
  const backdrop = byId('auth-password-backdrop');
  if (!backdrop) return;
  backdrop.style.display = 'none';
  backdrop.setAttribute('aria-hidden', 'true');
}

function authSubmitResetPassword() {
  if (!__authSelectedUserId) return;
  const newPassword = safeTrim(byId('auth-password-new')?.value || '');
  if (!newPassword) {
    setAuthPasswordStatus('Informe a nova senha.');
    return;
  }
  setAuthPasswordStatus('Salvando nova senha...');
  fetch('/api/auth/users/' + encodeURIComponent(__authSelectedUserId) + '/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ new_password: newPassword })
  })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      if (!data || !data.ok) throw new Error(data && data.detail ? data.detail : 'Falha ao redefinir senha.');
      setAuthPasswordStatus('Senha redefinida com sucesso.', true);
      authLoadAudit();
      setTimeout(function () { closeAuthPasswordModal(); }, 250);
    })
    .catch(function (err) {
      setAuthPasswordStatus((err && err.message) ? err.message : 'Falha ao redefinir senha.');
    });
}

function openAuthAdminModal() {
  if (!authCanManageUsers()) return;
  const backdrop = byId('auth-admin-backdrop');
  if (!backdrop) return;
  backdrop.style.display = 'flex';
  backdrop.setAttribute('aria-hidden', 'false');
  renderAuthUsersTable();
  renderAuthAuditList();
  authLoadUsers();
  authLoadAudit();
}

function closeAuthAdminModal() {
  const backdrop = byId('auth-admin-backdrop');
  if (!backdrop) return;
  backdrop.style.display = 'none';
  backdrop.setAttribute('aria-hidden', 'true');
}

function initAuthUi() {
  installAuthFetchHook();
  ensureAuthShell();
  authLoadStoredSession();
  authLockUi();
  renderAuthUi();

  return fetch('/api/auth/status?_=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (data) {
      __authState.enabled = !!(data && data.enabled);
      __authState.auth_required = !!(data && data.auth_required);
      __authState.legacy_open = !!(data && data.legacy_open);
      __authState.bootstrap_allowed = !!(data && data.bootstrap_allowed);
      renderAuthUi();

      if (!__authState.enabled) {
        authUnlockUi();
        bootAppModules();
        return true;
      }
      if (!authToken()) {
        if (authShouldGateUi() || __authState.bootstrap_allowed) {
          authLockUi();
          openAuthModal(__authState.bootstrap_allowed ? 'bootstrap' : 'login');
          return false;
        }
        authUnlockUi();
        bootAppModules();
        return true;
      }
      return fetch('/api/auth/me', { cache: 'no-store' })
        .then(function (r) { return r.json().catch(function () { return {}; }); })
        .then(function (me) {
          if (!me || !me.ok || !me.user) {
            authHandleUnauthorized();
            return false;
          }
          authSetSession(authToken(), me.user);
          return true;
        })
        .catch(function () {
          authHandleUnauthorized();
          return false;
        });
    })
    .catch(function () {
      if (!authShouldGateUi()) {
        authUnlockUi();
        bootAppModules();
      }
      renderAuthUi();
      return !authShouldGateUi();
    });
}

/* =========================
   UI Shell (Sidebar + Theme)
   - Sidebar e "drawer" (entra/sai)
   - Tema: dark/light via localStorage
   ========================= */

function uiSetTheme(theme) {
  try {
    const t = (theme === 'light') ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    if (document.body) document.body.setAttribute('data-theme', t);
    localStorage.setItem('sightops_theme', t);
    // Atualiza label do botao, se existir
    const btn = byId('theme-toggle');
    if (btn) {
      // Ícone-only (sem texto "Tema") para ficar mais SaaS
      btn.textContent = (t === 'light') ? '\u2600' : '\u263D';
      btn.setAttribute('title', (t === 'light') ? 'Tema claro' : 'Tema escuro');
      btn.setAttribute('aria-label', (t === 'light') ? 'Tema claro' : 'Tema escuro');
    }
  } catch (e) {}
}

// Inventory: painel de scan colapsavel (deixa a tabela livre)
function uiToggleInventoryPanel() {
  const tab = byId('tab-inventory');
  if (!tab) return;
  tab.classList.toggle('is-collapsed');
}

function uiToggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light';
  uiSetTheme(cur === 'dark' ? 'light' : 'dark');
}

function uiOpenSidebar() {
  document.body.classList.add('sidebar-open');
}

function uiCloseSidebar() {
  document.body.classList.remove('sidebar-open');
}

function uiToggleSidebar() {
  if (document.body.classList.contains('sidebar-open')) uiCloseSidebar();
  else uiOpenSidebar();
}

function initNavGroups() {
  const groups = $all('header .nav-group-toggle[data-nav-group]');
  if (!groups || !groups.length) return;

  function setExpanded(groupName, expanded) {
    const btn = document.querySelector('header .nav-group-toggle[data-nav-group="' + groupName + '"]');
    const panel = document.querySelector('header .nav-subgroup[data-nav-subgroup="' + groupName + '"]');
    if (!btn || !panel) return;
    btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    if (expanded) panel.removeAttribute('hidden');
    else panel.setAttribute('hidden', '');
  }

  function closeOtherGroups(activeGroupName) {
    groups.forEach(function (otherBtn) {
      const otherGroupName = otherBtn.getAttribute('data-nav-group') || '';
      if (!otherGroupName || otherGroupName === activeGroupName) return;
      setExpanded(otherGroupName, false);
    });
  }

  groups.forEach(function (btn) {
    const groupName = btn.getAttribute('data-nav-group') || '';
    if (!groupName) return;
    const panel = document.querySelector('header .nav-subgroup[data-nav-subgroup="' + groupName + '"]');
    if (!panel) return;

    const hasActiveSub = !!panel.querySelector('a.nav-subitem.active');
    setExpanded(groupName, hasActiveSub || btn.classList.contains('active'));

    btn.addEventListener('click', function (e) {
      if (e) e.preventDefault();
      const open = btn.getAttribute('aria-expanded') === 'true';
      if (open) {
        setExpanded(groupName, false);
      } else {
        closeOtherGroups(groupName);
        setExpanded(groupName, true);
      }
    });
  });
}
function initNestedNavSubmenus() {
  const labels = $all('header .nav-subitem-label');
  if (!labels || !labels.length) return;

  labels.forEach(function (label) {
    const children = [];
    let cur = label.nextElementSibling;
    while (cur && cur.classList && cur.classList.contains('nav-subitem-child')) {
      children.push(cur);
      cur = cur.nextElementSibling;
    }
    if (!children.length) return;

    function setExpanded(expanded) {
      label.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      label.classList.toggle('is-open', !!expanded);
      children.forEach(function (ch) {
        if (expanded) ch.removeAttribute('hidden');
        else ch.setAttribute('hidden', '');
      });
    }

    const hasActiveChild = children.some(function (ch) { return ch.classList.contains('active'); });
    setExpanded(hasActiveChild || label.classList.contains('active'));

    label.setAttribute('role', 'button');
    label.setAttribute('tabindex', '0');
    label.addEventListener('click', function (e) {
      if (e) e.preventDefault();
      const open = label.getAttribute('aria-expanded') === 'true';
      setExpanded(!open);
    });
    label.addEventListener('keydown', function (e) {
      if (!e) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const open = label.getAttribute('aria-expanded') === 'true';
        setExpanded(!open);
      }
    });
  });
}

function initUiShell() {
  // garante que nenhum overlay do menu fique preso ao trocar de pagina
  uiCloseSidebar();
  ensureDashboardNavLink();
  ensureWindowsNavLink();
  ensureBackupNavLink();
  // Tema inicial
  const forcedTheme = (document.body && document.body.dataset && document.body.dataset.forceTheme) || '';
  let stored = null;
  try { stored = localStorage.getItem('sightops_theme'); } catch (e) {}
  if (forcedTheme === 'light' || forcedTheme === 'dark') {
    uiSetTheme(forcedTheme);
  } else if (stored === 'light' || stored === 'dark') {
    uiSetTheme(stored);
  } else {
    uiSetTheme('dark');
  }

  // Fechar sidebar ao clicar no scrim
  const scrim = byId('scrim');
  if (scrim) {
    scrim.addEventListener('click', function () { uiCloseSidebar(); });
  }

  // Tecla ESC fecha
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') uiCloseSidebar();
  });


  // Fecha o menu ao clicar em qualquer item de navegacao (evita "travamento" por scrim)
  $all('header a.nav-item, header a.nav-subitem').forEach(function(a){
    a.addEventListener('click', function(){ uiCloseSidebar(); });
  });

  initNavGroups();
  initNestedNavSubmenus();

  // Expõe para onclick
  window.uiToggleSidebar = uiToggleSidebar;
  window.uiToggleTheme = uiToggleTheme;
  window.uiOpenSidebar = uiOpenSidebar;
  window.uiCloseSidebar = uiCloseSidebar;
  window.uiToggleInventoryPanel = uiToggleInventoryPanel;
}

function ensureDashboardNavLink() {
  const nav = document.querySelector('header nav');
  if (!nav || nav.querySelector('a[href="dashboard.html"]')) return;
  const link = document.createElement('a');
  link.className = 'nav-item';
  link.href = 'dashboard.html';
  link.textContent = 'Dashboard';
  const path = String(window.location.pathname || '').toLowerCase();
  if (path.endsWith('/dashboard.html')) link.classList.add('active');
  nav.insertBefore(link, nav.firstChild);
}

function ensureWindowsNavLink() {
  const inventoryGroup = document.querySelector('[data-nav-subgroup="inventory"]');
  if (!inventoryGroup || inventoryGroup.querySelector('a[href="windows.html"]')) return;
  const label = document.createElement('div');
  label.className = 'nav-subitem nav-subitem-label';
  label.textContent = 'Infraestrutura';
  const link = document.createElement('a');
  link.className = 'nav-subitem';
  link.href = 'windows.html';
  link.textContent = 'Windows';
  const path = String(window.location.pathname || '').toLowerCase();
  if (path.endsWith('/windows.html')) link.classList.add('active');
  const photoLabel = Array.from(inventoryGroup.querySelectorAll('.nav-subitem-label'))
    .find(function (item) { return String(item.textContent || '').toLowerCase().indexOf('foto') >= 0; });
  if (photoLabel) {
    inventoryGroup.insertBefore(label, photoLabel);
    inventoryGroup.insertBefore(link, photoLabel);
  } else {
    inventoryGroup.appendChild(label);
    inventoryGroup.appendChild(link);
  }
}

function ensureBackupNavLink() {
  const operationsGroup = document.querySelector('[data-nav-subgroup="operations"]');
  if (!operationsGroup || operationsGroup.querySelector('a[href="backup.html"]')) return;
  const link = document.createElement('a');
  link.className = 'nav-subitem';
  link.href = 'backup.html';
  link.textContent = 'Backup';
  const path = String(window.location.pathname || '').toLowerCase();
  if (path.endsWith('/backup.html')) link.classList.add('active');
  operationsGroup.appendChild(link);
}

/* =========================
   Progresso (Scan / OLT)
   ========================= */
function setScanProgress(value, label) {
  const bar = byId('scan-progress-fill');
  const text = byId('scan-progress-label');
  const container = byId('scan-progress');
  if (!bar || !container) return;
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  bar.style.width = v + '%';
  container.setAttribute('aria-hidden', v === 0 ? 'true' : 'false');
  if (text) text.textContent = v > 0 ? (label || (v + '% concluído')) : '';
}

function setOltProgress(value, label) {
  const bar = byId('olt-progress-fill');
  const text = byId('olt-progress-label');
  const container = byId('olt-progress');
  if (!bar || !container) return;
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  bar.style.width = v + '%';
  container.setAttribute('aria-hidden', v === 0 ? 'true' : 'false');
  if (text) text.textContent = v > 0 ? (label || (v + '% concluído')) : '';
}

/* =========================
   Banners genericos
   (usa status-banner se existir, senao run-status)
   ========================= */
function showBanner(type, message) {
  const host = byId('status-banner') || byId('run-status');
  if (!host) return;

  const ok = type === 'success';
  const bg = ok ? '#0f5132' : '#842029';
  const fg = ok ? '#d1e7dd' : '#f8d7da';
  const btnBg = ok ? '#198754' : '#dc3545';

  host.innerHTML = `
    <div style="
      background:${bg};
      color:${fg};
      padding:10px 14px;
      border-radius:6px;
      margin-top:10px;
      font-weight:600;
      display:flex;
      align-items:center;
      justify-content:space-between;
      gap:12px;
    ">
      <div>${message || (ok ? '[OK] OK' : '[ERRO] Erro')}</div>
      <button id="banner-close" type="button" style="
        background:${btnBg};
        border:none;
        color:white;
        padding:4px 10px;
        border-radius:4px;
        cursor:pointer;
      ">Fechar</button>
    </div>
  `;

  const closeBtn = byId('banner-close');
  if (closeBtn) closeBtn.onclick = function () { host.innerHTML = ''; };
}

/* =========================
   Banner sucesso inventario (Scan / Reuse / Corrigir IP)
   ========================= */
function showInvSuccessBanner(message) {
  const banner = byId('inv-success-banner');
  const textEl = byId('inv-success-text');
  if (!banner) {
    showBanner('success', message || '[OK] Inventario atualizado.');
    return;
  }
  if (textEl) textEl.innerHTML = message || ' <strong>Inventario atualizado.</strong>';
  banner.style.display = 'flex';
}

function clearSingleIpFields() {
  const ipField   = byId('single-ip');
  const userField = byId('rescan-user');
  const passField = byId('rescan-pass');
  const logEl     = byId('single-ip-log');
  if (ipField) ipField.value = '';
  if (userField) userField.value = '';
  if (passField) passField.value = '';
  if (logEl) logEl.textContent = '';
}

function hideInvSuccessBanner() {
  const banner = byId('inv-success-banner');
  if (banner) banner.style.display = 'none';

  // 1) limpa campos "Corrigir IP"
  clearSingleIpFields();

  // 2) limpa campos do SCAN (target/user/password)
  const targetEl = byId('target');
  const userEl   = byId('user');
  const passEl   = byId('password');

  // só limpa se nao estiver em "Reuse"
  const reuse = !!(byId('opt-reuse') && byId('opt-reuse').checked);

  if (targetEl && !targetEl.disabled && !reuse) targetEl.value = '';
  if (userEl && !userEl.disabled && !reuse) userEl.value = 'admin';
  if (passEl && !passEl.disabled && !reuse) passEl.value = '';

  // 3) limpa status + progresso
  const runStatus = byId('run-status');
  if (runStatus) runStatus.innerHTML = '';
  setScanProgress(0, '');

  // 4) limpa console ao vivo
  const liveLog = byId('live-log');
  if (liveLog) {
    liveLog.dataset.running = '0';
    liveLog.textContent = '';
  }
}

/* =========================
   Banner sucesso edicao (editar/apagar)
   ========================= */
function showEditSuccessBanner(message) {
  const b = byId('edit-success-banner');
  const t = byId('edit-success-text');
  if (!b) {
    showBanner('success', message || ' Edicao concluída.');
    return;
  }
  if (t) t.innerHTML = message || ' <strong>Edicao concluída.</strong>';
  b.style.display = 'flex';
}
function hideEditSuccessBanner() {
  const b = byId('edit-success-banner');
  if (b) b.style.display = 'none';
}

/* =========================
   Banner sucesso Scripts (Netwatch)
   - fecha e limpa campos/log
   ========================= */
function showScriptsSuccessBanner(message) {
  const b = byId('scripts-success-banner');
  const t = byId('scripts-success-text');
  if (!b) {
    showBanner('success', message || ' Script gerado com sucesso.');
    return;
  }
  if (t) t.innerHTML = message || ' <strong>Script gerado com sucesso.</strong>';
  b.style.display = 'flex';
}
function hideScriptsSuccessBanner() {
  const b = byId('scripts-success-banner');
  if (b) b.style.display = 'none';
}

function clearScriptsSuccessState() {
  hideScriptsSuccessBanner();
  // limpa campos da aba scripts
  const tokenEl = byId('script-token');
  const chatEl  = byId('script-chat');
  const intEl   = byId('script-interval');
  const toutEl  = byId('script-timeout');
  const logEl   = byId('log-netwatch');
  const downloadBtn = byId('btn-netwatch-download');
  const siteEl = byId('script-site');

  if (tokenEl) tokenEl.value = '';
  if (chatEl)  chatEl.value = '';
  if (intEl)   intEl.value = '1m';
  if (toutEl)  toutEl.value = '2s';
  if (siteEl) siteEl.value = '';
  if (logEl)   logEl.textContent = '';
  if (downloadBtn) downloadBtn.style.display = 'none';
}

function downloadNetwatchFile(evt) {
  if (evt) evt.preventDefault();
  const btn = byId('btn-netwatch-download');
  const logEl = byId('log-netwatch');
  if (btn) btn.disabled = true;
  const downloadUrl = (btn && btn.dataset && btn.dataset.downloadUrl) ? btn.dataset.downloadUrl : '/api/scripts/netwatch/download';
  fetch(downloadUrl, { cache: 'no-store' })
    .then(function (resp) {
      if (!resp.ok) {
        return resp.text().then(function (txt) {
          throw new Error(txt || ('HTTP ' + resp.status));
        });
      }
      return resp.blob().then(function (blob) {
        let filename = 'netwatch_setup.rsc';
        const disp = resp.headers.get('content-disposition') || '';
        const m = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(disp);
        if (m && m[1]) {
          try { filename = decodeURIComponent(m[1].replace(/"/g, '')); } catch (_) { filename = m[1].replace(/"/g, ''); }
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
        if (logEl) logEl.textContent += '\n[OK] Download iniciado: ' + filename + '\n';
      });
    })
    .catch(function (e) {
      const msg = (e && e.message) ? e.message : String(e || 'falha no download');
      if (logEl) logEl.textContent += '\n[ERRO] Download: ' + msg + '\n';
      showBanner('error', 'Falha ao baixar arquivo Netwatch.');
    })
    .finally(function () {
      if (btn) btn.disabled = false;
    });
}

/* =========================
   SNAPSHOT  Banner sucesso
   - aparece após capturar com sucesso
   - botao Fechar limpa campos + status/log
   ========================= */
function showSnapshotSuccessBanner(message) {
  const b = byId('snapshot-success-banner');
  const t = byId('snapshot-success-text');
  if (!b) {
    showBanner('success', message || ' Snapshot capturado com sucesso.');
    return;
  }
  if (t) t.innerHTML = message || ' <strong>Snapshot capturado com sucesso.</strong>';
  b.style.display = 'flex';
}

/* =========================
   KMZ  Import / Preview / Generate
   ========================= */
function initKmzHandlers() {
  var mapHost = byId('kmz-map');
  if (!mapHost || !window.L) return;
  var KMZ_SOURCE_STORAGE_KEY = 'kmz_source_pref';

  // mapa
  var map = L.map('kmz-map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap'
  }).addTo(map);
  map.setView([-9.66, -35.73], 11); // Maceió como default

  var layer = L.geoJSON([], {
    onEachFeature: function (feature, lyr) {
      try {
        var p = (feature && feature.properties) || {};
        var title = p.name || '';
        var desc = p.description || '';
        var html = '';
        if (title) html += '<div style="font-weight:700; margin-bottom:4px;">' + title + '</div>';
        if (desc) html += '<div class="kmz-popup">' + desc + '</div>';
        if (html) lyr.bindPopup(html);
      } catch (e) {}
    }
  }).addTo(map);

  function setText(id, txt) {
    var el = byId(id);
    if (el) el.textContent = txt || '';
  }
  function sourceLabel(src) {
    var s = String(src || '').toLowerCase();
    if (s === 'dvr') return 'DVR';
    if (s === 'nvr') return 'NVR';
    return 'Cameras IP';
  }
  function getKmzSource() {
    var sel = byId('kmz-source');
    var src = safeTrim((sel || {}).value || 'ip') || 'ip';
    if (src === 'dvr') return 'dvr';
    if (src === 'nvr') return 'nvr';
    return 'ip';
  }

  function fitGeojson(fc) {
    try {
      if (!fc || !fc.features || !fc.features.length) return;
      var b = layer.getBounds();
      if (b && b.isValid && b.isValid()) map.fitBounds(b.pad(0.1));
    } catch (e) {}
  }

  function loadGeojson(url) {
    if (!url) return;
    fetch(url).then(function (r) { return r.json(); }).then(function (fc) {
      layer.clearLayers();
      layer.addData(fc || { type: 'FeatureCollection', features: [] });
      fitGeojson(fc);
    }).catch(function () {
      // silencioso
    });
  }

  function downloadKmzFile(url, fallbackName, statusId) {
    if (!url) return;
    setText(statusId, 'Preparando download...');
    fetch(url)
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (txt) {
            var msg = 'Falha ao baixar KMZ.';
            try {
              var j = JSON.parse(txt || '{}');
              msg = j.detail || msg;
            } catch (e) {}
            throw new Error(msg);
          });
        }
        var disposition = r.headers.get('Content-Disposition') || '';
        var filename = fallbackName || 'mapa.kmz';
        var match = disposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
        if (match && match[1]) {
          try { filename = decodeURIComponent(match[1].replace(/"/g, '').trim()); }
          catch (e) { filename = match[1].replace(/"/g, '').trim(); }
        }
        return r.blob().then(function (blob) {
          return { blob: blob, filename: filename };
        });
      })
      .then(function (out) {
        var blobUrl = URL.createObjectURL(out.blob);
        var a = document.createElement('a');
        a.href = blobUrl;
        a.download = out.filename || fallbackName || 'mapa.kmz';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 1500);
        setText(statusId, 'Download iniciado: ' + a.download);
      })
      .catch(function (err) {
        setText(statusId, (err && err.message) ? err.message : 'Erro ao baixar KMZ.');
      });
  }

  // tentar carregar importado automaticamente (se existir)
  loadGeojson('/api/kmz/import/geojson');

  var sourceSel = byId('kmz-source');
  if (sourceSel) {
    try {
      var savedSource = safeTrim(localStorage.getItem(KMZ_SOURCE_STORAGE_KEY) || '');
      if (savedSource === 'ip' || savedSource === 'dvr' || savedSource === 'nvr') sourceSel.value = savedSource;
    } catch (e) {}
    sourceSel.addEventListener('change', function () {
      var src = getKmzSource();
      try { localStorage.setItem(KMZ_SOURCE_STORAGE_KEY, src); } catch (e) {}
      setText('kmz-loc-status', 'Origem selecionada: ' + sourceLabel(src) + '.');
    });
  }

  // IMPORT
  var btnImport = byId('btn-kmz-import');
  var fileInput = byId('kmz-file');
  var fileName = byId('kmz-file-name');
  if (fileInput && fileName) {
    fileInput.addEventListener('change', function () {
      var f = fileInput.files && fileInput.files[0];
      fileName.textContent = f ? f.name : 'Nenhum arquivo';
    });
  }

  if (btnImport) btnImport.onclick = function () {
    var inp = byId('kmz-file');
    if (!inp || !inp.files || !inp.files[0]) {
      setText('kmz-import-status', 'Selecione um KMZ primeiro.');
      return;
    }
    setText('kmz-import-status', 'Importando...');
    var fd = new FormData();
    fd.append('file', inp.files[0]);
    fetch('/api/kmz/import', { method: 'POST', body: fd })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          setText('kmz-import-status', '? Importado: ' + (j.filename || 'ok'));
          try { var gc = byId('kmz-generate-card'); if (gc) gc.style.display = 'block'; } catch(e) {}
          var a = byId('kmz-import-download');
          if (a) {
            a.href = '#';
            a.dataset.downloadUrl = '/api/kmz/import/download';
            a.style.display = 'inline-flex';
          }
          loadGeojson('/api/kmz/import/geojson');
        } else {
          setText('kmz-import-status', '? Falha ao importar.');
        }
      })
      .catch(function () {
        setText('kmz-import-status', '? Erro ao importar.');
      });
  };

  // GENERATE
  var btnGen = byId('btn-kmz-generate');
  if (btnGen) btnGen.onclick = function () {
    var source = getKmzSource();
    try { localStorage.setItem(KMZ_SOURCE_STORAGE_KEY, source); } catch (e) {}
    setText('kmz-generate-status', 'Gerando KMZ (' + sourceLabel(source) + ')...');
    fetch('/api/kmz/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source: source }) })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok && j.latest_url) {
          setText('kmz-generate-status', 'OK (' + sourceLabel(source) + '): ' + (j.latest || 'ok'));
          var a2 = byId('kmz-generated-download');
          if (a2) {
            a2.href = '#';
            a2.dataset.downloadUrl = j.latest_url;
            a2.dataset.filename = j.latest || 'sightops-kmz.kmz';
            a2.style.display = 'inline-flex';
          }
          var btnPrev = byId('btn-kmz-preview-generated');
          if (btnPrev) btnPrev.style.display = 'inline-flex';
        } else {
          var err = (j && (j.detail || j.stderr)) ? (j.detail || j.stderr) : 'Falha ao gerar.';
          setText('kmz-generate-status', ' ' + err);
        }
      })
      .catch(function () {
        setText('kmz-generate-status', '? Erro ao gerar KMZ.');
      });
  };

  // PREVIEW generated
  var btnPrev2 = byId('btn-kmz-preview-generated');
  if (btnPrev2) btnPrev2.onclick = function () {
    loadGeojson('/api/kmz/generated/geojson');
  };

  var importDownload = byId('kmz-import-download');
  if (importDownload) importDownload.onclick = function (ev) {
    if (ev) ev.preventDefault();
    downloadKmzFile(importDownload.dataset.downloadUrl || '/api/kmz/import/download', 'imported.kmz', 'kmz-import-status');
  };

  var generatedDownload = byId('kmz-generated-download');
  if (generatedDownload) generatedDownload.onclick = function (ev) {
    if (ev) ev.preventDefault();
    downloadKmzFile(
      generatedDownload.dataset.downloadUrl || '/api/kmz/generated/download',
      generatedDownload.dataset.filename || 'sightops-kmz.kmz',
      'kmz-generate-status'
    );
  };

  // APPLY LOCATIONS (KMZ -> Inventario)
  function fmtLocSummary(j) {
    if (!j) return '';
    return (
      '? Pontos: ' + (j.points_total || 0) +
      ' | Atualizadas: ' + (j.updated || 0) +
      ' | Sem match: ' + (j.no_match || 0) +
      (j.skipped_has_loc ? (' | Ja tinham local: ' + j.skipped_has_loc) : '')
    );
  }

  function runLoc(dryRun) {
    var ow = byId('kmz-loc-overwrite');
    var overwrite = !!(ow && ow.checked);
    var source = getKmzSource();
    try { localStorage.setItem(KMZ_SOURCE_STORAGE_KEY, source); } catch (e) {}
    setText('kmz-loc-status', dryRun ? ('Calculando previa em ' + sourceLabel(source) + '...') : ('Aplicando no inventario ' + sourceLabel(source) + '...'));
    fetch('/api/kmz/import/locations/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dry_run: !!dryRun, overwrite: overwrite, source: source })
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          var line = fmtLocSummary(j);
          if (dryRun) {
            line = sourceLabel(source) + ' | Previa: ' + line + ' (clique em "Aplicar" para gravar)';
          } else {
            line = sourceLabel(source) + ' | ' + line;
          }
          setText('kmz-loc-status', line);
        } else {
          var err = (j && (j.detail || j.error)) ? (j.detail || j.error) : 'Falha.';
          setText('kmz-loc-status', ' ' + err);
        }
      })
      .catch(function () {
        setText('kmz-loc-status', ' Erro ao processar localizacões.');
      });
  }

  var btnLocPrev = byId('btn-kmz-loc-preview');
  if (btnLocPrev) btnLocPrev.onclick = function () { runLoc(true); };

  var btnLocApply = byId('btn-kmz-loc-apply');
  if (btnLocApply) btnLocApply.onclick = function () { runLoc(false); };
}

function hideSnapshotSuccessBanner() {
  const b = byId('snapshot-success-banner');
  if (b) b.style.display = 'none';

  // limpa campos da captura (mas mantem a imagem resultante)
  const ipEl = byId('snapshot-ip');
  const userEl = byId('snapshot-user');
  const passEl = byId('snapshot-pass');
  const statusEl = byId('snapshot-status');
  const logEl = byId('snapshot-log');

  if (ipEl) ipEl.value = '';
  if (userEl) userEl.value = 'admin';
  if (passEl) passEl.value = '';
  if (statusEl) statusEl.textContent = '';
  if (logEl) logEl.textContent = '';
}

/* =========================
   INVENTÁRIO - filtro frontend
   ========================= */
let inventoryFilterMode = 'all';
let __inventoryCurrentRows = [];
let __inventoryAllRows = [];
try { window.__inventoryAllRows = __inventoryAllRows; } catch (_) {}

function inventoryRowMatchesSite(row, wantedSite) {
  const wanted = safeTrim(wantedSite || '').toLowerCase();
  if (!wanted || !row || typeof row !== 'object') return true;
  const vals = [
    safeTrim(row.site || ''),
    safeTrim(row.site_name || ''),
    safeTrim(row.local || row.LOCAL || '')
  ];
  return vals.some(function (v) { return v && v.toLowerCase() === wanted; });
}

function filterInventoryRowsBySite(rows, wantedSite) {
  const base = Array.isArray(rows) ? rows : [];
  const wanted = safeTrim(wantedSite || '');
  if (!wanted) return base.slice();
  return base.filter(function (row) {
    return inventoryRowMatchesSite(row, wanted);
  });
}

function getInventoryViewMode() {
  const mode = safeTrim(document.body?.getAttribute('data-inventory-view') || '').toLowerCase();
  return mode === 'switch' ? 'switch' : 'olt';
}

function getInventoryColumnConfig() {
  if (getInventoryViewMode() === 'switch') {
    return {
      emptyColspan: 12,
      columns: [
        'mac',
        'fabricante',
        'model',
        'titulo',
        'status',
        'imgbb',
        'local',
        'switch_ip',
        'switch_port',
        'switch_vlan',
      ],
    };
  }
  return {
    emptyColspan: 13,
    columns: [
      'mac',
      'fabricante',
      'model',
      'titulo',
      'status',
      'imgbb',
      'local',
      'pon',
      'onu_id',
      'onu_name',
      'onu_serial',
    ],
  };
}

function getInventoryCacheKey(selectedSite) {
  const site = safeTrim(selectedSite || '');
  const mode = getInventoryViewMode();
  const base = 'cam_snapshot_inventory_' + mode + '_last_v1';
  return site ? (base + '_site_' + site) : base;
}

function normalizeInvStatus(raw) {
  const v = safeTrim(raw).toLowerCase();
  if (!v) return '';
  if (v === 'camera_offline' || v === 'camera offline' || v === 'sem_camera' || v === 'sem camera' || v === 'no_camera' || v === 'no camera') return 'offline';
  if (v === 'auth_failed' || v === 'auth-failed' || v === 'auth failed' || v === '401' || v.includes('unauthorized')) return 'auth_failed';
  if (v === 'offline' || v === 'down' || v === 'falha' || v === 'off') return 'offline';
  if (v === 'online' || v === 'up' || v === 'ok' || v === 'ativo' || v === 'ativa' || v === 'on') return 'online';
  return v; // ex.: erro
}

function applyInventoryFilterDom() {
  const tbody = $('#inv-table tbody') || byId('inventory-body');
  if (!tbody) return;

  const rows = tbody.querySelectorAll('tr');
  rows.forEach((row) => {
    const cells = row.cells;
    if (!cells || cells.length < 2) { row.style.display = ''; return; }

    const getCellText = (idx) => (cells[idx] ? safeTrim(cells[idx].textContent) : '');

    const viewMode = getInventoryViewMode();
    const ip         = getCellText(1);
    const mac        = getCellText(2);
    const fabricante = getCellText(3);
    const modelo     = getCellText(4);
    const titulo     = getCellText(5);
    const status     = getCellText(6);
    const local      = getCellText(8);
    const extra1      = getCellText(9);
    const extra2      = getCellText(10);
    const extra3      = getCellText(11);
    const extra4      = getCellText(12);

    let show = true;

    switch (inventoryFilterMode) {
      case 'all': show = true; break;
      case 'status_online':
        show = (normalizeInvStatus(status) === 'online');
        break;
      case 'status_offline':
        show = (normalizeInvStatus(status) === 'offline');
        break;
      case 'status_auth_failed':
        show = (normalizeInvStatus(status) === 'auth_failed');
        break;
      case 'any_missing':
        show = (viewMode === 'switch')
          ? (!ip || !mac || !fabricante || !modelo || !titulo || !local || !extra1 || !extra2 || !extra3)
          : (!ip || !mac || !fabricante || !modelo || !titulo || !local || !extra1 || !extra2 || !extra3 || !extra4);
        break;
      case 'missing_ip': show = !ip; break;
      case 'missing_mac': show = !mac; break;
      case 'missing_fabricante': show = !fabricante; break;
      case 'missing_modelo': show = !modelo; break;
      case 'missing_titulo': show = !titulo; break;
      case 'missing_pon': show = (viewMode === 'olt') ? !extra1 : !extra2; break;
      case 'missing_onu_id': show = (viewMode === 'olt') ? !extra2 : !extra3; break;
      case 'missing_onu_name': show = (viewMode === 'olt') ? !extra3 : false; break;
      case 'missing_onu_serial': show = (viewMode === 'olt') ? !extra4 : false; break;
      default: show = true; break;
    }

    row.style.display = show ? '' : 'none';
    if (!show) {
      const cb = row.querySelector('input.inv-select[type="checkbox"]');
      if (cb) cb.checked = false;
    }
  });

  syncInventorySelectAllState();
  updateInventoryStats();
}


/* =========================
   INVENTÁRIO - contadores (online/visíveis)
   ========================= */
function isOnlineStatus(s) {
  const v = safeTrim(s).toLowerCase();
  if (!v) return false;
  // aceita variacões comuns
  return (v === 'online' || v === 'up' || v === 'ok' || v === 'ativo' || v === 'ativa' || v === 'on');
}

function updateInventoryStats() {
  const el = byId('inv-stats');
  const tbody = $('#inv-table tbody') || byId('inventory-body');
  if (!el || !tbody) return;

  const rows = Array.from(tbody.querySelectorAll('tr'));
  let total = 0;
  let online = 0;

  rows.forEach(function (row) {
    if (!isInventoryRowVisible(row)) return;

    const cells = row.cells;
    if (!cells || cells.length < 6) return;

    // ignora placeholders
    const t = safeTrim(row.textContent).toLowerCase();
    if (t.includes('nenhuma camera') || t.includes('carregando') || t.includes('erro ao carregar') || t.includes('inventario em andamento')) return;

    total += 1;
    // Pega pelo span (robusto caso colunas mudem)
    const stEl = row.querySelector('.inv-status');
    const st = stEl ? stEl.textContent : (cells[cells.length - 1] ? cells[cells.length - 1].textContent : '');
    if (isOnlineStatus(st)) online += 1;
  });

  const offline = Math.max(0, total - online);
  el.textContent = ' Total visíveis: ' + total + '   -    Online: ' + online + '   -    Offline: ' + offline;
}

/* =========================
   INVENTÁRIO - render / load
   ========================= */
function ipToNum(ip) {
  const parts = safeTrim(ip).split('.');
  if (parts.length !== 4) return Number.MAX_SAFE_INTEGER;
  let n = 0;
  for (let i = 0; i < 4; i++) {
    const o = parseInt(parts[i], 10);
    n = n * 256 + (isNaN(o) ? 0 : o);
  }
  return n;
}

function renderInventoryTable(inventory) {
  const tbody = byId('inventory-body') || $('#inv-table tbody');
  if (!tbody) return;
  __inventoryCurrentRows = Array.isArray(inventory) ? inventory.slice() : [];

  tbody.innerHTML = '';

  if (!Array.isArray(inventory) || inventory.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = getInventoryColumnConfig().emptyColspan;
    td.textContent = 'Nenhuma camera encontrada no inventario.';
    tr.appendChild(td);
    tbody.appendChild(tr);
    updateInventoryStats();
    return;
  }

  inventory.sort((a, b) => ipToNum(a.ip || a.IP || '') - ipToNum(b.ip || b.IP || ''));

  inventory.forEach((cam) => {
    const tr = document.createElement('tr');
    tr.dataset.ip = cam.ip || cam.IP || '';

    const rawStatus = (cam.status || cam.STATUS || '');
    const normStatus = normalizeInvStatus(rawStatus);
    if (normStatus) {
      tr.dataset.status = normStatus;
      tr.classList.add('inv-row');
      tr.classList.add('inv-row-' + normStatus);
    }

    // checkbox
    const tdCheck = document.createElement('td');
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    chk.className = 'inv-select';
    chk.dataset.ip = cam.ip || cam.IP || '';
    tdCheck.appendChild(chk);
    tr.appendChild(tdCheck);

    function addCell(v) {
      const td = document.createElement('td');
      td.textContent = v == null ? '' : String(v);
      tr.appendChild(td);
    }

    function addImgBBCell(camRow) {
      const td = document.createElement('td');
      const url = safeTrim(
        camRow.imgbb_url ||
        camRow.imgbbUrl ||
        (camRow.raw && (camRow.raw.imgbb_url || camRow.raw.imgbbUrl)) ||
        ''
      );
      if (url) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'inv-imgbb-link';
        a.title = 'Abrir imagem no ImgBB';
        a.textContent = 'OK';
        td.appendChild(a);
      } else {
        const span = document.createElement('span');
        span.className = 'inv-imgbb-empty';
        span.textContent = '-';
        td.appendChild(span);
      }
      tr.appendChild(td);
    }

    // IP clicavel: abre drawer com snapshot rapido
    {
      const td = document.createElement('td');
      const ip = (cam.ip || cam.IP || '');
      const a = document.createElement('a');
      a.href = '#';
      a.className = 'ip-link';
      a.textContent = ip;
      a.title = 'Ver snapshot rapido';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openInventoryIpDrawer(cam);
      });
      td.appendChild(a);
      tr.appendChild(td);
    }
    addCell(cam.mac || cam.MAC || cam.mac_address || '');
    addCell(cam.fabricante || cam.FABRICANTE || cam.manufacturer || '');
    addCell(cam.modelo || cam.MODELO || cam.model || '');
    addCell(cam.titulo || cam.TITULO || cam.title || cam.nome || '');

    // status com cor
    {
      const td = document.createElement('td');
      const span = document.createElement('span');
      span.className = 'inv-status inv-status-' + (normStatus || 'unknown');
      span.textContent = rawStatus == null ? '' : String(rawStatus);
      td.appendChild(span);
      tr.appendChild(td);
    }
    addImgBBCell(cam);

    // LOCAL (quando disponível)
    addCell(cam.local || cam.LOCAL || '');
    if (getInventoryViewMode() === 'switch') {
      addCell(cam.switch_ip || '');
      addCell(cam.switch_port || '');
      addCell(cam.switch_vlan || cam.vlan || '');
    } else {
      addCell(cam.pon || cam.PON || '');
      addCell(cam.onu_id || cam.ONU_ID || '');
      addCell(cam.onu_name || cam.ONU_NAME || '');
      addCell(cam.onu_serial || cam.ONU_SERIAL || '');
    }

    tbody.appendChild(tr);
  });

  updateInventoryStats();
}

function loadInventory() {
  const tbody = byId('inventory-body') || $('#inv-table tbody');
  const overlay = byId('inv-overlay');
  let selectedSite = '';
  try { selectedSite = safeTrim((byId('inventory-site') || {}).value || ''); } catch (_) {}

  // ---- Cache local (para nao "sumir" ao navegar entre paginas)
  const CACHE_KEY = getInventoryCacheKey(selectedSite);
  const cacheLoad = function () {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (obj && Array.isArray(obj.inventory)) return obj.inventory;
    } catch (_) {}
    return null;
  };
  const cacheSave = function (inv) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), inventory: inv || [] }));
    } catch (_) {}
  };

  // 1) Render imediato do cache (se existir)
  const cached = cacheLoad();
  if (cached && cached.length) {
    try {
      inventoryFilterMode = inventoryFilterMode || 'all';
      __inventoryAllRows = Array.isArray(cached) ? cached.slice() : [];
      try { window.__inventoryAllRows = __inventoryAllRows; } catch (_) {}
      renderInventoryTable(cached);
      applyInventoryFilterDom();
      if (overlay) overlay.classList.remove('show');
    } catch (e) {
      // se der erro renderizando cache, continua para o fetch
      console.warn('Falha ao renderizar cache do inventario:', e);
    }
  } else {
    // Sem cache: mostra loading
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="' + getInventoryColumnConfig().emptyColspan + '" class="muted">Carregando inventario...</td></tr>';
    }
  }

  // 2) Fetch com timeout (evita ficar preso em "Carregando" para sempre)
  const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const timeoutMs = 5000;
  let timer = null;
  if (controller) {
    timer = setTimeout(function () {
      try { controller.abort(); } catch (_) {}
    }, timeoutMs);
  }

  // Evita cache agressivo do browser
  let invUrl = `/api/inventory-last?_=${Date.now()}`;
  const enrichMode = getInventoryViewMode();
  if (enrichMode) invUrl += `&enrich=${encodeURIComponent(enrichMode)}`;
  try {
    if (selectedSite) invUrl += `&site=${encodeURIComponent(selectedSite)}`;
  } catch (_) {}
  return fetch(invUrl, controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' })
    .then(resp => resp.json().catch(() => ({})).then(data => ({ resp, data })))
    .then(({ resp, data }) => {
      if (timer) clearTimeout(timer);

      if (!resp.ok || data.ok !== true || !Array.isArray(data.inventory)) {
        // Se ja tinha cache renderizado, NO apaga.
        if (!(cached && cached.length)) {
          if (tbody) tbody.innerHTML = '<tr><td colspan="' + getInventoryColumnConfig().emptyColspan + '" class="muted">Nenhum inventario encontrado.</td></tr>';
          updateInventoryStats();
        }
        if (overlay) overlay.classList.remove('show');
        return;
      }

      // reset do filtro quando chega inventario novo
      inventoryFilterMode = 'all';
      const invFilterEl = byId('inventory-filter');
      if (invFilterEl) invFilterEl.value = 'all';

      __inventoryAllRows = Array.isArray(data.inventory) ? data.inventory.slice() : [];
      try { window.__inventoryAllRows = __inventoryAllRows; } catch (_) {}
      let nextInventory = filterInventoryRowsBySite(__inventoryAllRows, selectedSite);

      cacheSave(nextInventory);
      renderInventoryTable(nextInventory);
      applyInventoryFilterDom();
      if (overlay) overlay.classList.remove('show');
    })
    .catch((e) => {
      if (timer) clearTimeout(timer);
      console.error('Erro em loadInventory:', e);
      // Se ja tinha cache renderizado, NO apaga.
      if (!(cached && cached.length)) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="' + getInventoryColumnConfig().emptyColspan + '" class="muted">Erro ao carregar inventario.</td></tr>';
        updateInventoryStats();
      }
      if (overlay) overlay.classList.remove('show');
    });
}

// =========================
// Inventario: status dinamico (online/offline via ping)
// =========================
let __invDynTimer = null;
let __invDynRunning = false;
let __invDynCursor = 0;

function _invDynUpdateRowStatus(ip, isOnline) {
  const tbody = byId('inventory-body') || $('#inv-table tbody');
  if (!tbody || !ip) return;
  const row = tbody.querySelector('tr[data-ip="' + String(ip).replace(/"/g, '\\"') + '"]');
  if (!row) return;
  const cur = normalizeInvStatus((row.querySelector('.inv-status') || {}).textContent || row.dataset.status || '');
  if (cur === 'auth_failed') return;

  const norm = isOnline ? 'online' : 'offline';
  row.dataset.status = norm;
  row.classList.add('inv-row');
  row.classList.remove('inv-row-online', 'inv-row-offline', 'inv-row-auth_failed', 'inv-row-unknown');
  row.classList.add('inv-row-' + norm);

  const st = row.querySelector('.inv-status');
  if (st) {
    st.classList.remove('inv-status-online', 'inv-status-offline', 'inv-status-auth_failed', 'inv-status-unknown');
    st.classList.add('inv-status-' + norm);
    st.textContent = isOnline ? 'online' : 'offline';
  }
}

function _invDynCollectVisibleIps() {
  const tbody = byId('inventory-body') || $('#inv-table tbody');
  if (!tbody) return [];
  const rows = Array.from(tbody.querySelectorAll('tr[data-ip]'));
  return rows
    .filter((r) => r.style.display !== 'none')
    .map((r) => safeTrim(r.dataset.ip))
    .filter(Boolean);
}

function _invDynFetchPing(ip) {
  return fetch('/api/cameras/ping?ip=' + encodeURIComponent(ip) + '&timeout=2&method=auto')
    .then((r) => r.json().catch(() => ({})).then((j) => ({ ok: r.ok, j })))
    .then(({ ok, j }) => {
      if (!ok) return null;
      const online = !!(j.online ?? j.ok ?? j.reachable ?? false);
      _invDynUpdateRowStatus(ip, online);
      return online;
    })
    .catch(() => null);
}

async function _invDynRunSweep() {
  if (__invDynRunning) return;
  __invDynRunning = true;
  try {
    const ips = _invDynCollectVisibleIps();
    if (!ips.length) return;

    const batchSize = Math.max(4, Math.min(18, ips.length));
    const start = __invDynCursor % ips.length;
    const batch = [];
    for (let i = 0; i < batchSize; i++) batch.push(ips[(start + i) % ips.length]);
    __invDynCursor = (start + batchSize) % ips.length;

    const concurrency = Math.min(6, batch.length);
    let idx = 0;
    async function worker() {
      while (idx < batch.length) {
        const cur = batch[idx++];
        if (!cur) continue;
        await _invDynFetchPing(cur);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    updateInventoryStats();
  } finally {
    __invDynRunning = false;
  }
}

function startInventoryDynamicStatus() {
  if (!(byId('inv-table') || byId('inventory-body'))) return;
  if (__invDynTimer) {
    try { clearTimeout(__invDynTimer); } catch (_) {}
    __invDynTimer = null;
  }

  const loop = function () {
    _invDynRunSweep()
      .catch(() => {})
      .finally(() => {
        __invDynTimer = setTimeout(loop, 12000);
      });
  };

  __invDynTimer = setTimeout(loop, 1500);
}

// =========================
// Drawer: preview rapida ao clicar no IP (Inventario)
// =========================
let __invDrawerInitDone = false;
let __invDrawerPingAbort = null;
let __invDrawerCurrentIp = '';

function invSafeId(id){ return document.getElementById(id); }

function ipToSnapshotPath(ip){
  // IMPORTANT: Must match backend snapshot filename convention.
  // Backend uses: ip.replace('.', '_').replace(':', '__')
  // We also normalize any other unsafe chars to '_' as a fallback.
  const stem = String(ip || '')
    .trim()
    .replace(/\./g, '_')
    .replace(/:/g, '__')
    .replace(/[^0-9A-Za-z_]+/g, '_');
  return `/data/snapshot/${stem}.jpg`;
}

function refreshInventorySiteOptionsAfterUpdate() {
  try {
    if (typeof window.refreshInventorySiteOptions === 'function') {
      return window.refreshInventorySiteOptions();
    }
  } catch (_) {}
  try {
    document.dispatchEvent(new CustomEvent('inventory:updated'));
  } catch (_) {}
  return Promise.resolve();
}

function isInventoryRowVisible(row) {
  if (!row) return false;
  if (row.style && row.style.display === 'none') return false;
  if (row.classList && row.classList.contains('search-hidden')) return false;
  return true;
}

function updateInventoryCameraTitle(ip, newTitle) {
  const targetIp = safeTrim(ip);
  const title = safeTrim(newTitle);
  if (!targetIp) return;

  (__inventoryCurrentRows || []).forEach(function (cam) {
    if (!cam) return;
    const camIp = safeTrim(cam.ip || cam.IP || '');
    if (camIp !== targetIp) return;
    cam.titulo = title;
    if ('TITULO' in cam) cam.TITULO = title;
    if ('title' in cam) cam.title = title;
    if ('nome' in cam) cam.nome = title;
  });

  const tbody = byId('inventory-body') || $('#inv-table tbody');
  const row = tbody ? tbody.querySelector('tr[data-ip="' + String(targetIp).replace(/"/g, '\\"') + '"]') : null;
  if (row) {
    const titleCell = row.querySelector('td:nth-child(6)');
    if (titleCell) titleCell.textContent = title;
  }

  if (__invDrawerCurrentIp === targetIp) {
    const titleEl = invSafeId('ip-drawer-title');
    const nameEl = invSafeId('ip-drawer-name');
    const overlayTitleEl = invSafeId('ip-drawer-overlay-title');
    if (titleEl) titleEl.textContent = title || 'Camera';
    if (nameEl) nameEl.textContent = title || '-';
    if (overlayTitleEl) overlayTitleEl.textContent = title || targetIp || 'Camera';
  }

  try {
    const selectedSite = safeTrim((byId('inventory-site') || {}).value || '');
    const cacheKey = getInventoryCacheKey(selectedSite);
    const raw = localStorage.getItem(cacheKey);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (!obj || !Array.isArray(obj.inventory)) return;
    obj.inventory.forEach(function (cam) {
      if (!cam) return;
      const camIp = safeTrim(cam.ip || cam.IP || '');
      if (camIp !== targetIp) return;
      cam.titulo = title;
      if ('TITULO' in cam) cam.TITULO = title;
      if ('title' in cam) cam.title = title;
      if ('nome' in cam) cam.nome = title;
    });
    localStorage.setItem(cacheKey, JSON.stringify(obj));
  } catch (_) {}
}

function getVisibleInventoryDrawerCams() {
  const tbody = byId('inventory-body') || $('#inv-table tbody');
  const rows = tbody ? Array.from(tbody.querySelectorAll('tr[data-ip]')) : [];
  const ipOrder = rows
    .filter(isInventoryRowVisible)
    .map((row) => safeTrim(row.dataset.ip))
    .filter(Boolean);
  if (!ipOrder.length) return [];

  return ipOrder
    .map((ip) => (__inventoryCurrentRows || []).find((cam) => safeTrim(cam && (cam.ip || cam.IP || '')) === ip))
    .filter(Boolean);
}

function updateInventoryDrawerNav() {
  const prevBtn = invSafeId('ip-drawer-prev');
  const nextBtn = invSafeId('ip-drawer-next');
  const metaEl = invSafeId('ip-drawer-nav-meta');
  const cams = getVisibleInventoryDrawerCams();
  const total = cams.length;
  const idx = cams.findIndex((cam) => safeTrim(cam && (cam.ip || cam.IP || '')) === safeTrim(__invDrawerCurrentIp));
  const current = idx >= 0 ? (idx + 1) : 0;
  const disabled = total <= 1;
  if (prevBtn) prevBtn.disabled = disabled;
  if (nextBtn) nextBtn.disabled = disabled;
  if (metaEl) metaEl.textContent = total ? (String(current || 1) + '/' + String(total)) : '-/-';
}

function navigateInventoryDrawer(step) {
  const cams = getVisibleInventoryDrawerCams();
  if (!cams.length) return;
  const curIp = safeTrim(__invDrawerCurrentIp);
  let idx = cams.findIndex((cam) => safeTrim(cam && (cam.ip || cam.IP || '')) === curIp);
  if (idx < 0) idx = 0;
  else idx = (idx + step + cams.length) % cams.length;
  openInventoryIpDrawer(cams[idx]);
}

function openInventoryIpDrawer(cam){
  if (!cam) return;
  if (!__invDrawerInitDone) {
    __invDrawerInitDone = true;
    const backdrop = invSafeId('ip-drawer-backdrop');
    const closeBtn = invSafeId('ip-drawer-close');
    const prevBtn = invSafeId('ip-drawer-prev');
    const nextBtn = invSafeId('ip-drawer-next');
    if (backdrop) backdrop.addEventListener('click', closeInventoryIpDrawer);
    if (closeBtn) closeBtn.addEventListener('click', closeInventoryIpDrawer);
    if (prevBtn) prevBtn.addEventListener('click', () => navigateInventoryDrawer(-1));
    if (nextBtn) nextBtn.addEventListener('click', () => navigateInventoryDrawer(1));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeInventoryIpDrawer();
      const drawer = invSafeId('ip-drawer');
      const isOpen = !!(drawer && drawer.classList.contains('open'));
      if (!isOpen) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateInventoryDrawer(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateInventoryDrawer(1);
      }
    });
  }

  const drawer = invSafeId('ip-drawer');
  const backdrop = invSafeId('ip-drawer-backdrop');
  if (!drawer || !backdrop) return;

  const ip = (cam.ip || cam.IP || '').trim();
  __invDrawerCurrentIp = ip;
  const rawStatus = (cam.status || cam.STATUS || '');
  const normStatus = normalizeInvStatus(rawStatus);
  const title = (cam.titulo || cam.TITULO || cam.title || cam.nome || '').trim();
  const model = (cam.modelo || cam.MODELO || cam.model || '').trim();
  const mac = (cam.mac || cam.MAC || cam.mac_address || '').trim();

  const titleEl = invSafeId('ip-drawer-title');
  const subEl = invSafeId('ip-drawer-sub');
  const statusEl = invSafeId('ip-drawer-status');
  const nameEl = invSafeId('ip-drawer-name');
  const macEl = invSafeId('ip-drawer-mac');
  const modelEl = invSafeId('ip-drawer-model');
  const imgEl = invSafeId('ip-drawer-img');
  const overlayTitleEl = invSafeId('ip-drawer-overlay-title');
  const overlayTimeEl = invSafeId('ip-drawer-overlay-time');
  const hintEl = invSafeId('ip-drawer-img-hint');
  const openA = invSafeId('ip-drawer-open');
  const openIpA = invSafeId('ip-drawer-open-ip');
  const refreshBtn = invSafeId('ip-drawer-refresh');
  const renameBtn = invSafeId('ip-drawer-rename');
  const changeIpBtn = invSafeId('ip-drawer-change-ip');
  const changePassBtn = invSafeId('ip-drawer-change-pass');
  const ntpBtn = invSafeId('ip-drawer-ntp');
  const pingBtn = invSafeId('ip-drawer-ping');
  const pingStopBtn = invSafeId('ip-drawer-ping-stop');
  const clearBtn = invSafeId('ip-drawer-clear');
  const navMetaEl = invSafeId('ip-drawer-nav-meta');

  if (titleEl) titleEl.textContent = title ? title : 'Camera';
  if (overlayTitleEl) overlayTitleEl.textContent = title ? title : (ip ? ip : 'Camera');
  if (subEl) subEl.textContent = ip ? `IP: ${ip}` : 'IP: -';
  if (statusEl) {
    statusEl.textContent = rawStatus ? String(rawStatus) : (normStatus || '-');
    statusEl.className = 'v ' + (normStatus ? `inv-status inv-status-${normStatus}` : '');
  }
  if (nameEl) nameEl.textContent = title || '-';
  if (macEl) macEl.textContent = mac || '-';
  if (modelEl) modelEl.textContent = model || '-';
  if (navMetaEl) navMetaEl.textContent = '-/-';

  const getBaseUrl = () => {
    const imgbb = (cam.imgbb_url || cam.imgbbUrl || '').trim();
    const snap = (cam.snapshot_url || cam.snapshotUrl || '').trim();
    return imgbb || snap || ipToSnapshotPath(ip);
  };
  const loadImg = () => {
    if (!imgEl) return;
    if (hintEl) {
      hintEl.style.display = 'block';
      hintEl.textContent = 'Carregando snapshot...';
    }
    if (overlayTimeEl) overlayTimeEl.textContent = '...';
    const bust = `t=${Date.now()}`;
    const baseUrl = getBaseUrl();
    const url = baseUrl + (baseUrl.includes('?') ? '&' : '?') + bust;
    imgEl.onload = () => {
      if (hintEl) hintEl.style.display = 'none';
      if (overlayTimeEl) {
        const d = new Date();
        const dd = String(d.getDate()).padStart(2,'0');
        const mm = String(d.getMonth()+1).padStart(2,'0');
        const yyyy = d.getFullYear();
        const hh = String(d.getHours()).padStart(2,'0');
        const mi = String(d.getMinutes()).padStart(2,'0');
        const ss = String(d.getSeconds()).padStart(2,'0');
        overlayTimeEl.textContent = `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
      }
    };
    imgEl.onerror = () => {
      if (hintEl) {
        hintEl.style.display = 'block';
        hintEl.textContent = 'Sem snapshot salvo para este IP.';
      }
      if (overlayTimeEl) overlayTimeEl.textContent = '';
    };
    imgEl.src = url;
    if (openA) openA.href = url;
  };
  if (openIpA) {
    openIpA.href = ip ? (`http://${ip}`) : '#';
  }

  const outEl = invSafeId('ip-drawer-output');
  const outWrite = (line, opts = {}) => {
    if (!outEl) return;
    const prefix = opts.noTime ? '' : (() => {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2,'0');
      const mi = String(d.getMinutes()).padStart(2,'0');
      const ss = String(d.getSeconds()).padStart(2,'0');
      return `[${hh}:${mi}:${ss}] `;
    })();
    outEl.textContent += prefix + line + "\n";
    outEl.scrollTop = outEl.scrollHeight;
  };
  const outClear = (hint) => {
    if (!outEl) return;
    outEl.textContent = '';
    if (hint) outWrite(hint, {noTime:true});
  };

  async function drawerForcePing(repeat = 3, timeout = 2) {
    if (!ip) return;
    if (__invDrawerPingAbort) {
      try { __invDrawerPingAbort.abort(); } catch (_) {}
    }
    __invDrawerPingAbort = new AbortController();
    outClear(`Ping para ${ip}`);
    for (let i = 1; i <= repeat; i++) {
      if (!__invDrawerPingAbort) break;
      if (__invDrawerPingAbort.signal.aborted) {
        outWrite('Ping interrompido pelo usuario.');
        break;
      }
      outWrite(`Tentativa ${i}/${repeat}...`);
      try {
        const t0 = performance.now();
        const r = await fetch(
          `/api/cameras/ping?ip=${encodeURIComponent(ip)}&timeout=${timeout}&method=auto&force=1`,
          { signal: __invDrawerPingAbort.signal }
        );
        const data = await r.json().catch(() => ({}));
        const ms = Math.round(performance.now() - t0);
        const ok = !!(data.online ?? data.ok ?? data.reachable ?? false);
        const rtt = data.rtt_ms ?? data.rtt ?? data.ms ?? null;
        outWrite(`${ok ? 'OK' : 'OFF'}  ${ms}ms (rtt: ${rtt ?? '-'})`);
        if (i === repeat && statusEl) {
          statusEl.textContent = ok ? 'ONLINE' : 'OFFLINE';
          statusEl.className = 'v inv-status inv-status-' + (ok ? 'online' : 'offline');
        }
      } catch (e) {
        if (e && (e.name === 'AbortError' || String(e).toLowerCase().includes('aborted'))) {
          outWrite('Ping interrompido pelo usuario.');
          break;
        }
        outWrite(`Erro: ${e && e.message ? e.message : String(e)}`);
      }
      if (i < repeat) await new Promise(res => setTimeout(res, 450));
    }
    __invDrawerPingAbort = null;
  }

  async function drawerUpdateSnapshot(userOverride, passOverride) {
    if (!ip) return;
    const user = (userOverride != null ? String(userOverride) : (invSafeId('user')?.value || '')).trim();
    const pass = (passOverride != null ? String(passOverride) : (invSafeId('pass')?.value || '')).trim();

    outClear(`Snapshot para ${ip}`);
    outWrite('Conectando...');

    // feedback visual
    if (refreshBtn) {
      refreshBtn.disabled = true;
      refreshBtn.textContent = 'Atualizando...';
    }

    const ws = new WebSocket(buildAuthedWsUrl('/ws/snapshot'));

    const done = () => {
      try { ws.close(); } catch (_) {}
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Atualizar foto';
      }
    };

    ws.onopen = () => {
      outWrite('Enviando requisicao...');
      sendWsAuthFrame(ws);
      ws.send(JSON.stringify({ ip, usuario: user, senha: pass }));
    };

    ws.onmessage = async (ev) => {
      let msg = null;
      try { msg = JSON.parse(ev.data); } catch (_) {}
      if (!msg) return;

      if (msg.type === 'status') {
        outWrite(msg.message || 'status...');
        return;
      }
      if (msg.type === 'log') {
        outWrite(msg.line || '...');
        return;
      }
      if (msg.type === 'error') {
        if (!msg.message) {
          msg.message = 'Erro no WebSocket (mensagem vazia). Usando modo compatível (HTTP)...';
          // fallback para HTTP
          try { ws.close(); } catch (e) {}
          if (typeof httpFallbackScan === 'function') {
            httpFallbackScan(payload, btn, statusEl, overlay, counter, 'Scan concluído. Inventario atualizado.');
          }
        }

        wsFinished = true;
        try { clearTimeout(wsWatchdog); } catch (_) {}
        // backend envia erros quando nao consegue capturar snapshot (credencial, timeout, etc.)
        const errTxt = msg.error || msg.message || msg.detail || 'Falha ao capturar snapshot.';
        outWrite('Erro: ' + errTxt);
        done();
        return;
      }
      if (msg.type === 'snapshot') {
        outWrite('Snapshot recebido.');
        if (imgEl && msg.image_b64) {
          imgEl.src = 'data:image/jpeg;base64,' + msg.image_b64;
          if (openA) openA.href = imgEl.src;
          if (hintEl) hintEl.style.display = 'none';
          // atualiza horario no overlay
          if (overlayTimeEl) {
            const d = new Date();
            const dd = String(d.getDate()).padStart(2,'0');
            const mm = String(d.getMonth()+1).padStart(2,'0');
            const yyyy = d.getFullYear();
            const hh = String(d.getHours()).padStart(2,'0');
            const mi = String(d.getMinutes()).padStart(2,'0');
            const ss = String(d.getSeconds()).padStart(2,'0');
            overlayTimeEl.textContent = `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
          }
        }

        // Mesmo quando o backend nao envia image_b64 (para economizar trafego),
        // ele pode ter gerado e salvo o snapshot em disco. Entao recarregamos
        // a imagem padrao (com cache-bust) para refletir a atualizacao.
        const triggerReload = () => {
          if (hintEl) {
            hintEl.textContent = 'Atualizando snapshot...';
            hintEl.style.display = 'block';
          }
          setTimeout(() => {
            try { loadImg(); } catch (_) {}
          }, 350);
        };
        // persiste em /data/snapshot para o resto do sistema
        if (msg.path && msg.image_b64) {
          try {
            await fetch('/api/snapshot/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: msg.path, image_b64: msg.image_b64 })
            });
            outWrite('Salvo em disco.');
          } catch (e) {
            outWrite('Aviso: falha ao salvar snapshot.');
          }
          triggerReload();
        } else {
          // sem base64: backend provavelmente ja salvou. Só recarrega.
          triggerReload();
        }
        done();
        return;
      }
      if (msg.type === 'done') {
        outWrite(msg.message || 'Finalizado.');
        done();
      }
    };

    ws.onerror = () => {
      outWrite('Erro de conexao no WebSocket.');
      done();
    };

    ws.onclose = () => {
      // se fechou sem snapshot, só volta UI
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.textContent = 'Atualizar foto';
      }
    };
  }

  if (refreshBtn) {
    refreshBtn.onclick = () => {
      // DVR: abre modal de credenciais (igual Inventario IP) e atualiza apenas o canal.
      if (String(cam.source || '').toLowerCase() === 'dvr') {
        openSnapshotCredModal(
          (invSafeId('dvr-user')?.value || 'admin').trim(),
          ip,
          title,
          async (u, p) => {
            try {
              if (refreshBtn) {
                refreshBtn.disabled = true;
                refreshBtn.textContent = 'Atualizando...';
              }
              outClear(`Atualizando canal ${cam.channel || '-'} em ${ip}`);
              const payload = {
                ip: ip,
                user: (u || '').trim() || 'admin',
                password: (p || ''),
                http_port: parseInt(cam.http_port || 80, 10) || 80,
                channel: parseInt(cam.channel || 1, 10) || 1,
                timeout_sec: parseFloat(invSafeId('dvr-timeout')?.value || '6') || 6,
                imgbb: !!(invSafeId('dvr-opt-imgbb') && invSafeId('dvr-opt-imgbb').checked)
              };
              const r = await fetch('/api/dvr/snapshot/update', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
              });
              const j = await r.json().catch(() => ({}));
              if (!r.ok || !j || j.ok !== true) {
                throw new Error((j && (j.detail || j.error)) || ('HTTP ' + r.status));
              }
              if (j.row && j.row.snapshot_url) {
                cam.snapshot_url = String(j.row.snapshot_url);
              }
              if (j.row && j.row.imgbb_url) cam.imgbb_url = String(j.row.imgbb_url);
              if (j.row && j.row.imgbb_thumb_url) cam.imgbb_thumb_url = String(j.row.imgbb_thumb_url);
              cam.status = (j.row && j.row.status) || cam.status;
              outWrite('Snapshot atualizado com sucesso.');
              if (payload.imgbb) {
                if (j.row && j.row.imgbb_url) {
                  outWrite('ImgBB enviado: ' + String(j.row.imgbb_url));
                } else {
                  outWrite('ImgBB nao enviado: ' + String((j.row && j.row.imgbb_error) || j.imgbb_error || 'verifique API key/configuracao.'));
                }
              }
              loadImg();
              try {
                if (typeof window.dvrReloadInventory === 'function') window.dvrReloadInventory();
              } catch (_) {}
            } catch (e) {
              outWrite('Erro: ' + (e && e.message ? e.message : String(e)));
            } finally {
              if (refreshBtn) {
                refreshBtn.disabled = false;
                refreshBtn.textContent = 'Atualizar';
              }
            }
          }
        );
        return;
      }
      // Câmera IP: abre modal de credenciais e atualiza snapshot.
      openSnapshotCredModal(
        (invSafeId('user')?.value || '').trim(),
        ip,
        title,
        (u, p) => drawerUpdateSnapshot(u, p)
      );
    };
  }
  if (renameBtn) {
    renameBtn.onclick = () => {
      openRenameCameraModal({
        ip: ip,
        currentTitle: title,
        user: safeTrim(invSafeId('user')?.value || byId('maintenance-user')?.value || ''),
        pass: String(invSafeId('pass')?.value || byId('maintenance-pass')?.value || ''),
        onSaved: function (nextTitle) {
          updateInventoryCameraTitle(ip, nextTitle);
        }
      });
    };
  }
  if (changeIpBtn) {
    changeIpBtn.onclick = () => {
      openChangeIpModal({
        ip: ip,
        user: safeTrim(invSafeId('user')?.value || byId('maintenance-user')?.value || ''),
        pass: String(invSafeId('pass')?.value || byId('maintenance-pass')?.value || '')
      });
    };
  }
  if (changePassBtn) {
    changePassBtn.onclick = () => {
      openChangePasswordModal({
        ip: ip,
        user: safeTrim(invSafeId('user')?.value || byId('maintenance-user')?.value || ''),
        pass: String(invSafeId('pass')?.value || byId('maintenance-pass')?.value || '')
      });
    };
  }
  if (ntpBtn) {
    ntpBtn.onclick = () => {
      openNtpModal({
        ip: ip,
        user: safeTrim(invSafeId('user')?.value || byId('maintenance-user')?.value || ''),
        pass: String(invSafeId('pass')?.value || byId('maintenance-pass')?.value || '')
      });
    };
  }
  if (pingBtn) {
    pingBtn.onclick = async () => {
      if (!ip) return;
      try {
        pingBtn.disabled = true;
        pingBtn.textContent = 'Testando...';
        if (pingStopBtn) pingStopBtn.disabled = false;
        await drawerForcePing(4, 2);
      } finally {
        if (__invDrawerPingAbort) {
          try { __invDrawerPingAbort.abort(); } catch (_) {}
        }
        __invDrawerPingAbort = null;
        pingBtn.disabled = false;
        pingBtn.textContent = 'Testar ping';
        if (pingStopBtn) pingStopBtn.disabled = true;
      }
    };
  }
  if (pingStopBtn) {
    pingStopBtn.onclick = () => {
      if (__invDrawerPingAbort) {
        try { __invDrawerPingAbort.abort(); } catch (_) {}
      }
      if (pingStopBtn) pingStopBtn.disabled = true;
    };
  }
  // limpar terminal
  if (clearBtn) {
    clearBtn.onclick = () => {
      outClear('');
    };
  }


  // abrir
  drawer.classList.add('open');
  backdrop.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  backdrop.setAttribute('aria-hidden', 'false');
  document.body.classList.add('drawer-open');

  updateInventoryDrawerNav();
  loadImg();
}

function closeInventoryIpDrawer(){
  if (__invDrawerPingAbort) {
    try { __invDrawerPingAbort.abort(); } catch (_) {}
    __invDrawerPingAbort = null;
  }
  const drawer = invSafeId('ip-drawer');
  const backdrop = invSafeId('ip-drawer-backdrop');
  if (drawer) {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
  }
  if (backdrop) {
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden', 'true');
  }
  __invDrawerCurrentIp = '';
  document.body.classList.remove('drawer-open');
}

/* =========================
   HTTP fallback /api/scan
   ========================= */
function httpFallbackScan(payload, btn, statusEl, overlay, counter, successMessage) {
  return fetch('/api/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(resp => resp.json().catch(() => ({})).then(data => ({ resp, data })))
    .then(({ resp, data }) => {
      if (!resp.ok || data.success === false) {
        showBanner('error', data.message || 'Erro ao executar');
        return;
      }

      //  banner verde tambem no fallback HTTP
      showInvSuccessBanner(successMessage || ' <strong>Operacao concluída.</strong> Inventario atualizado.');

      if (data.inventory && Array.isArray(data.inventory)) {
        renderInventoryTable(data.inventory);
        applyInventoryFilterDom();
      } else {
        return loadInventory();
      }
      try { showAuthWarningFromScanResult(data); } catch (_) {}
    })
    .catch(err => {
      console.error(err);
      showBanner('error', 'Erro de comunicacao com a API');
    })
    .finally(() => {
      if (btn) btn.disabled = false;
      if (overlay) overlay.classList.remove('show');
      if (counter) counter.textContent = '';
      setScanProgress(0, '');
      if (statusEl) statusEl.textContent = '';
    });
}

function showAuthWarningFromScanResult(result) {
  if (!result || typeof result !== 'object') return;
  const warn = safeTrim(result.auth_warning || result.warning || '');
  const cnt = Number(result.auth_failed_count || 0);
  if (!warn) return;
  const msg = cnt > 0 ? (warn + ' (auth_failed: ' + cnt + ')') : warn;
  showBanner('error', msg);
}

function applyScanResultInventory(result) {
  if (!result || typeof result !== 'object' || !Array.isArray(result.inventory)) return false;
  try {
    renderInventoryTable(result.inventory);
    applyInventoryFilterDom();
    return true;
  } catch (e) {
    console.warn('Falha ao renderizar inventario do resultado do scan:', e);
    return false;
  }
}

/* =========================
   RUN SCAN (WS + fallback)
   ========================= */
function buildScanPayloadFromDom() {
  return {
    alvo: safeTrim(byId('target')?.value),
    usuario: safeTrim(byId('user')?.value),
    senha: byId('password') ? byId('password').value : '',
    snapshot: !!byId('opt-snapshot')?.checked,
    imgbb: !!byId('opt-imgbb')?.checked,
    excel: !!byId('opt-excel')?.checked,
    reuse_inventory: !!byId('opt-reuse')?.checked,
    inventory_mode: getInventoryViewMode(),
    olt_enrich: !!byId('opt-olt-enrich')?.checked,
    switch_enrich: !!byId('opt-switch-enrich')?.checked,
    kmz: !!byId('opt-kmz')?.checked,
    ia: !!byId('opt-ia')?.checked,
    nat_mode: !!byId('opt-nat-mode')?.checked,

    // Local padrao (opcional) para a rodada
    set_local: !!byId('opt-set-local')?.checked,
    local: safeTrim(byId('local-name')?.value)
  };
}

function scanConsoleAppend(line, kind) {
  const logEl = byId('live-log');
  if (!logEl) return;
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const tag = kind ? String(kind).toUpperCase() : 'INFO';
  logEl.textContent += `[${hh}:${mm}:${ss}] ${tag}  ${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function describeScanOptions(payload) {
  const opts = [];
  if (payload.snapshot) opts.push('Snapshot');
  if (payload.imgbb) opts.push('Upload ImgBB');
  if (payload.olt_enrich) opts.push('Enriquecer OLT');
  if (payload.switch_enrich) opts.push('Enriquecer Switch');
  if (payload.excel) opts.push('Excel');
  if (payload.kmz) opts.push('KMZ');
  if (payload.ia) opts.push('IA de imagem');
  if (payload.nat_mode) opts.push('Modo NAT');
  if (payload.set_local) opts.push('Local padrao: ' + (payload.local || '(vazio)'));
  return opts.length ? opts.join(', ') : 'nenhuma opcao extra';
}

function renderScanConsolePreview() {
  const logEl = byId('live-log');
  if (!logEl || logEl.dataset.running === '1') return;
  const payload = buildScanPayloadFromDom();
  const lines = [];
  lines.push('Console pronto. Aqui aparece o plano antes da rodada e os eventos ao vivo durante o scan.');
  lines.push('');
  if (payload.reuse_inventory) {
    lines.push('Modo: reutilizar inventario atual (sem nova varredura).');
  } else {
    lines.push('Alvo: ' + (payload.alvo || '(informe um CIDR, range ou IP)'));
    lines.push('Usuario: ' + (payload.usuario || '(nao informado)'));
    lines.push('Senha: ' + (payload.senha ? 'informada' : '(nao informada)'));
  }
  lines.push('Origem visual: ' + (payload.inventory_mode || 'ip'));
  lines.push('Opcoes: ' + describeScanOptions(payload));
  lines.push('');
  if (!payload.reuse_inventory && (!payload.alvo || !payload.usuario || !payload.senha)) {
    lines.push('Pendente: preencha alvo, usuario e senha para iniciar.');
  } else {
    lines.push('Pronto para iniciar.');
  }
  logEl.textContent = lines.join('\n');
}

function startScanConsole(payload) {
  const logEl = byId('live-log');
  if (!logEl) return;
  logEl.dataset.running = '1';
  logEl.textContent = '';
  scanConsoleAppend('Rodada iniciada.', 'start');
  scanConsoleAppend('Alvo: ' + (payload.reuse_inventory ? 'inventario atual' : payload.alvo), 'plan');
  scanConsoleAppend('Usuario: ' + (payload.reuse_inventory ? 'nao usado' : (payload.usuario || '-')), 'plan');
  scanConsoleAppend('Opcoes: ' + describeScanOptions(payload), 'plan');
  scanConsoleAppend('Abrindo canal WebSocket...', 'ws');
}

function finishScanConsole(line, kind) {
  const logEl = byId('live-log');
  if (line) scanConsoleAppend(line, kind || 'info');
  if (logEl) logEl.dataset.running = '0';
}

function runScan(evt) {
  if (evt) evt.preventDefault();

  const btn = byId('btn-run');
  const statusEl = byId('run-status');
  const logEl = byId('live-log');
  const overlay = byId('inv-overlay');
  const counter = byId('inv-counter');

  if (btn) btn.disabled = true;

  if (statusEl) statusEl.textContent = 'Iniciando inventario em tempo real...';
  if (overlay) overlay.classList.add('show');
  if (counter) counter.textContent = 'Aguardando primeiras cameras...';

  setScanProgress(0, '');

  const payload = buildScanPayloadFromDom();
  startScanConsole(payload);

  //  validacao: se NO estiver em reuse, precisa alvo + user + senha
  if (!payload.reuse_inventory) {
    if (!payload.alvo) {
      finishScanConsole('Rodada bloqueada: alvo nao informado.', 'erro');
      showBanner('error', 'Informe o alvo (CIDR/IP) ou marque "Reuse last inventory".');
      if (btn) btn.disabled = false;
      if (overlay) overlay.classList.remove('show');
      return;
    }

    if (!payload.usuario) {
      finishScanConsole('Rodada bloqueada: usuario nao informado.', 'erro');
      showBanner('error', 'Informe o usuario.');
      if (btn) btn.disabled = false;
      if (overlay) overlay.classList.remove('show');
      return;
    }

    if (!payload.senha) {
      finishScanConsole('Rodada bloqueada: senha nao informada.', 'erro');
      showBanner('error', 'Informe a senha para iniciar a varredura.');
      if (btn) btn.disabled = false;
      if (overlay) overlay.classList.remove('show');
      return;
    }
  }

  const tbody = $('#inv-table tbody') || byId('inventory-body');
  if (tbody) tbody.innerHTML = '<tr><td colspan="' + getInventoryColumnConfig().emptyColspan + '" class="muted">Inventario em andamento...</td></tr>';

  const wsUrl = buildAuthedWsUrl('/ws/scan');

  let loadedLines = 0;
  let ws = null;

  try {
    ws = new WebSocket(wsUrl);

    // --- WS robustness (fallback para HTTP em caso de WS travado) ---
    let wsGotAny = false;
    let wsFinished = false;
    let wsFallbackUsed = false;

    const fallbackHttpScan = async (why) => {
      if (wsFallbackUsed) return;
      wsFallbackUsed = true;
      try { if (ws) ws.close(); } catch (_) {}

      try {
        showBanner('warning', 'WebSocket sem resposta (' + (why || 'falha') + '). Usando modo compatível (HTTP)...');
      } catch (e) {}
      scanConsoleAppend('WebSocket sem resposta (' + (why || 'falha') + '). Entrando no fallback HTTP.', 'warn');

      try {
        // compat: alguns backends usam capture_snapshot alem de snapshot
        const httpPayload = Object.assign({}, payload, {
          capture_snapshot: !!payload.snapshot
        });

        const r = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(httpPayload)
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false) {
          const msg = data.message || ('HTTP ' + r.status);
          showBanner('error', msg);
          if (statusEl) statusEl.textContent = 'Erro: ' + msg;
          setScanProgress(0, '');
          if (overlay) overlay.classList.remove('show');
          if (btn) btn.disabled = false;
          return;
        }

        setScanProgress(100, 'Concluído.');
        finishScanConsole('Fallback HTTP concluido.', 'ok');
        if (statusEl) statusEl.textContent = data.message || 'Scan concluído.';
        if (overlay) overlay.classList.remove('show');
        if (btn) btn.disabled = false;
        if (applyScanResultInventory(data)) {
          Promise.resolve().finally(refreshInventorySiteOptionsAfterUpdate);
        } else {
          Promise.resolve(loadInventory()).finally(refreshInventorySiteOptionsAfterUpdate);
        }
        try { showAuthWarningFromScanResult(data); } catch (_) {}
        showInvSuccessBanner('? <strong>Scan concluído.</strong> Inventario atualizado.');
      } catch (e) {
        finishScanConsole('Falha no fallback HTTP: ' + (e?.message || e), 'erro');
        showBanner('error', 'Falha no modo compatível (HTTP): ' + (e?.message || e));
        setScanProgress(0, '');
        if (overlay) overlay.classList.remove('show');
        if (btn) btn.disabled = false;
      }
    };

    const wsWatchdog = setTimeout(() => {
      if (!wsGotAny && !wsFinished) fallbackHttpScan('timeout');
    }, 2500);

    ws.onerror = function () {
      if (!wsFinished) fallbackHttpScan('onerror');
    };

    ws.onclose = function () {
      if (!wsFinished && !wsGotAny) fallbackHttpScan('onclose');
    };


    ws.onopen = function () {
      setScanProgress(5, 'Conectado. Iniciando...');
      scanConsoleAppend('WebSocket conectado. Enviando parametros da rodada...', 'ws');
      sendWsAuthFrame(ws);
      ws.send(JSON.stringify(payload));
    };

    ws.onmessage = function (event) {
      wsGotAny = true;
      try { clearTimeout(wsWatchdog); } catch (_) {}
      let msg;
      try { msg = JSON.parse(event.data); }
      catch (e) { return; }

      if (msg.type === 'inventory_updated') {
        Promise.resolve(loadInventory()).finally(refreshInventorySiteOptionsAfterUpdate);
        return;
      }

      if (msg.type === 'status') {
        if (statusEl) statusEl.textContent = msg.message || '';
        if (msg.message) scanConsoleAppend(msg.message, 'status');
        const txt = (msg.message || '').toLowerCase();
        if (txt.includes('inventory_scan')) {
          setScanProgress(15, 'Inventario em andamento...');
        } else if (txt.includes('executando passos extras')) {
          setScanProgress(60, 'Inventario basico concluído.');
        }
        return;
      }

      if (msg.type === 'log') {
        loadedLines += 1;
        if (logEl) {
          const line = msg.line || msg.log || '';
          logEl.textContent += line + '\n';
          logEl.scrollTop = logEl.scrollHeight;
        }
        if (counter) counter.textContent = loadedLines + ' linhas de log...';
        const base = 20;
        const max = 80;
        const inc = Math.min(max, base + Math.log10(loadedLines + 1) * 20);
        setScanProgress(inc, 'Processando (' + loadedLines + ' linhas)...');
        return;
      }

      if (msg.type === 'error') {
        if (!msg.message) {
          msg.message = 'Erro no WebSocket (mensagem vazia). Usando modo compatível (HTTP)...';
          // fallback para HTTP
          try { ws.close(); } catch (e) {}
          if (typeof httpFallbackScan === 'function') {
            httpFallbackScan(payload, btn, statusEl, overlay, counter, 'Scan concluído. Inventario atualizado.');
          }
        }

        wsFinished = true;
        try { clearTimeout(wsWatchdog); } catch (_) {}
        if (statusEl) statusEl.textContent = 'Erro: ' + (msg.message || msg.error || '');
        finishScanConsole(msg.message || msg.error || 'Erro recebido do backend.', 'erro');
        showBanner('error', msg.message || msg.error || 'Erro');
        setScanProgress(0, '');
        if (overlay) overlay.classList.remove('show');
        if (btn) btn.disabled = false;
        return;
      }

      if (msg.type === 'done' || msg.done === true) {
        wsFinished = true;
        try { clearTimeout(wsWatchdog); } catch (_) {}
        if (statusEl) statusEl.textContent = msg.message || 'Scan concluído.';
        finishScanConsole(msg.message || 'Scan concluido.', 'ok');
        setScanProgress(100, 'Concluído.');

        if (overlay) overlay.classList.remove('show');
        if (counter) counter.textContent = '';

        if (applyScanResultInventory(msg.result || {})) {
          Promise.resolve().finally(refreshInventorySiteOptionsAfterUpdate);
        } else {
          Promise.resolve(loadInventory()).finally(refreshInventorySiteOptionsAfterUpdate);
        }
        try { showAuthWarningFromScanResult(msg.result || {}); } catch (_) {}

        //  banner verde no final do scan
        showInvSuccessBanner('? <strong>Scan concluído.</strong> Inventario atualizado.');

        //  se gerou Excel/KMZ, abre o download (precisa /saida montado no backend)
        try {
          if (byId('opt-excel')?.checked) window.open('/saida/cam-inventory.xlsx', '_blank');
          if (byId('opt-kmz')?.checked) window.open('/saida/cam-inventory.kmz', '_blank');
        } catch (e) {}

        if (btn) btn.disabled = false;

        try { ws.close(); } catch (_) {}
        return;
      }
    };
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = 'Erro ao iniciar WS, usando modo compatível...';
    scanConsoleAppend('Falha ao abrir WebSocket. Tentando modo compativel HTTP...', 'warn');
    setScanProgress(0, '');
    httpFallbackScan(payload, btn, statusEl, overlay, counter, ' <strong>Scan concluído.</strong> Inventario atualizado.');
  }
}

/* =========================
   UPDATE INVENTÁRIO (reuse_inventory)
   - Botao só habilita se opt-reuse marcado
   ========================= */
function runInventoryUpdateClick(evt) {
  if (evt) evt.preventDefault();

  const reuse = byId('opt-reuse');
  if (!reuse || !reuse.checked) {
    alert('Marque "Reuse last inventory" para atualizar sem rescanear.');
    return;
  }

  const statusEl = byId('run-status');
  const logEl = byId('live-log');
  const overlay = byId('inv-overlay');
  const counter = byId('inv-counter');
  const btnUpdate = byId('btn-refresh-inventory-left');

  if (logEl) logEl.textContent = '';
  if (btnUpdate) btnUpdate.disabled = true;
  if (statusEl) statusEl.textContent = 'Atualizando inventario (reutilizando base)...';
  if (overlay) overlay.classList.add('show');
  if (counter) counter.textContent = 'Reprocessando inventario...';

  setScanProgress(0, '');

  const payload = {
    alvo: '',
    usuario: '',
    senha: '',
    snapshot: false,
    imgbb: !!byId('opt-imgbb')?.checked,
    excel: !!byId('opt-excel')?.checked,
    reuse_inventory: true,
    inventory_mode: getInventoryViewMode(),
    olt_enrich: !!byId('opt-olt-enrich')?.checked,
    kmz: !!byId('opt-kmz')?.checked,
    ia: !!byId('opt-ia')?.checked
  };

  const wsUrl = buildAuthedWsUrl('/ws/scan');

  let ws;
  try { ws = new WebSocket(wsUrl); } catch (e) { ws = null; }

  if (!ws) {
    return httpFallbackScan(payload, null, statusEl, overlay, counter, ' <strong>Inventario atualizado.</strong> (Reuse)');
  }

  ws.onopen = function () {
    sendWsAuthFrame(ws);
    ws.send(JSON.stringify(payload));
  };

  ws.onmessage = function (ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { msg = { log: String(ev.data) }; }

    if (msg.log && logEl) logEl.textContent += msg.log + '\n';

    if (msg.type === 'inventory_updated' || msg.done === true || msg.type === 'done') {
      loadInventory()
        .finally(function () {
          if (overlay) overlay.classList.remove('show');
          if (counter) counter.textContent = '';
          if (statusEl) statusEl.textContent = 'Inventario atualizado.';
          if (btnUpdate) btnUpdate.disabled = !byId('opt-reuse')?.checked;

          //  banner verde no update reuse
          showInvSuccessBanner('? <strong>Inventario atualizado.</strong> (Reuse)');

          try { ws.close(); } catch (_) {}
        });
      return;
    }

    if (msg.error || msg.type === 'error') {
      if (statusEl) statusEl.textContent = msg.message || msg.error || 'Erro';
      if (overlay) overlay.classList.remove('show');
      if (counter) counter.textContent = '';
      if (btnUpdate) btnUpdate.disabled = !byId('opt-reuse')?.checked;
      try { ws.close(); } catch (_) {}
    }
  };

  ws.onerror = function () {
    httpFallbackScan(payload, null, statusEl, overlay, counter, ' <strong>Inventario atualizado.</strong> (Reuse)')
      .finally(function () {
        if (btnUpdate) btnUpdate.disabled = !byId('opt-reuse')?.checked;
        try { ws.close(); } catch (_) {}
      });
  };

  ws.onclose = function () {
    if (btnUpdate) btnUpdate.disabled = !byId('opt-reuse')?.checked;
  };
}

/* =========================
   Corrigir IP (/api/rescan-single-ip)
   ========================= */
function rescanSingleIp() {
  const ipField   = byId('single-ip');
  const userField = byId('rescan-user');
  const passField = byId('rescan-pass');
  const snapCb    = byId('opt-rescan-snapshot');
  const logEl     = byId('single-ip-log');

  const ip = safeTrim(ipField?.value);
  const user = safeTrim(userField?.value);
  const pass = passField ? passField.value : '';

  if (!ip) { if (logEl) logEl.textContent = 'Informe um IP para reprocessar.'; return; }
  if (!user || !pass) { if (logEl) logEl.textContent = 'Informe usuario e senha para Corrigir IP.'; return; }

  if (logEl) logEl.textContent = 'Reprocessando IP ' + ip + '...\n';

  const payload = {
    ip: ip,
    usuario: user,
    senha: pass,
    capture_snapshot: !!(snapCb && snapCb.checked),
    inventory_mode: getInventoryViewMode()
  };

  fetch('/api/rescan-single-ip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(resp => {
      if (!resp.ok) return resp.text().then(t => { throw new Error('HTTP ' + resp.status + ' - ' + t); });
      return resp.json().catch(() => ({}));
    })
    .then(data => {
      if (data.stderr && logEl) logEl.textContent += data.stderr + '\n';

      if (!data.success) {
        if (logEl) logEl.textContent += '[ERRO] Corrigir IP falhou.\n';
        showBanner('error', 'Falha ao corrigir IP.');
        return;
      }

      showInvSuccessBanner('? <strong>IP ' + ip + ' reprocessado.</strong> Inventario atualizado com sucesso.');

      if (Array.isArray(data.inventory)) {
        renderInventoryTable(data.inventory);
        applyInventoryFilterDom();
        if (logEl) logEl.textContent += '[OK] Inventario atualizado com retorno do backend.\n';
      } else {
        if (logEl) logEl.textContent += 'Recarregando inventario...\n';
        return loadInventory().then(function () {
          if (logEl) logEl.textContent += '[OK] Inventario recarregado após Corrigir IP.\n';
        });
      }
    })
    .catch(e => {
      console.error(e);
      if (logEl) logEl.textContent += '\n[EXCEPTION] ' + e + '\n';
      showBanner('error', 'Erro ao corrigir IP.');
    });
}

/* =========================
   INVENTÁRIO: edicao / apagar / limpar
   ========================= */
let inventoryEditing = false;

function getSelectedInventoryIps() {
  const tbody = byId('inventory-body');
  const inBody = tbody ? Array.from(tbody.querySelectorAll('input.inv-select[type="checkbox"]')) : [];
  const inTable = $all('#inv-table tbody input.inv-select[type="checkbox"]');
  const uniq = [];
  const seen = new Set();
  Array.from(inBody).concat(Array.from(inTable)).forEach(function (el) {
    if (!el || seen.has(el)) return;
    seen.add(el);
    uniq.push(el);
  });
  return Array.from(uniq)
    .filter(cb => cb.checked && cb.dataset.ip)
    .map(cb => cb.dataset.ip);
}

function getSelectedInventoryIpsParam() {
  const ips = getSelectedInventoryIps()
    .map(function (ip) { return safeTrim(ip); })
    .filter(Boolean);
  return ips.length ? ips.join(',') : '';
}

function getVisibleInventorySelectionCheckboxes() {
  const tbody = byId('inventory-body') || $('#inv-table tbody');
  if (!tbody) return [];
  return Array.from(tbody.querySelectorAll('tr[data-ip]'))
    .filter(isInventoryRowVisible)
    .map(function (row) { return row.querySelector('input.inv-select[type="checkbox"]'); })
    .filter(Boolean);
}

function syncInventorySelectAllState() {
  const selectAll = byId('inv-select-all');
  if (!selectAll) return;
  const visibleBoxes = getVisibleInventorySelectionCheckboxes();
  const visibleCount = visibleBoxes.length;
  const checkedCount = visibleBoxes.filter(function (cb) { return !!cb.checked; }).length;
  selectAll.indeterminate = visibleCount > 0 && checkedCount > 0 && checkedCount < visibleCount;
  selectAll.checked = visibleCount > 0 && checkedCount === visibleCount;
}

function setInventoryEditingMode(isEditing) {
  inventoryEditing = !!isEditing;

  const btnEdit   = byId('btn-inv-edit');
  const btnClear  = byId('btn-inv-clear');
  const btnSave   = byId('btn-inv-save');
  const btnDelete = byId('btn-inv-delete');
  const btnCancel = byId('btn-inv-cancel');

  if (btnEdit)   btnEdit.style.display   = isEditing ? 'none' : '';
  if (btnSave)   btnSave.style.display   = isEditing ? '' : 'none';
  if (btnCancel) btnCancel.style.display = isEditing ? '' : 'none';
  if (btnDelete) btnDelete.style.display = isEditing ? '' : 'none';
  if (btnClear)  btnClear.disabled = !!isEditing;
  if (btnDelete) btnDelete.textContent = 'Apagar selecionadas';
  syncInventorySelectAllState();
}

function enterInventoryEditMode() {
  const tbody = $('#inv-table tbody');
  if (!tbody) return;

  const ips = getSelectedInventoryIps();
  if (!ips.length) { alert('Selecione pelo menos uma camera para editar.'); return; }

  setInventoryEditingMode(true);

  const cfg = getInventoryColumnConfig();
  const colFieldMap = {};
  cfg.columns.forEach(function (field, idx) {
    colFieldMap[idx + 2] = field;
  });

  ips.forEach(function (ip) {
    const row = tbody.querySelector('tr[data-ip="' + ip + '"]');
    if (!row) return;

    for (let colIndex = 2; colIndex < (2 + cfg.columns.length); colIndex++) {
      const cell = row.cells[colIndex];
      const field = colFieldMap[colIndex];
      if (!cell || !field) continue;
      if (field === 'imgbb') continue;

      const current = safeTrim(cell.textContent);
      cell.innerHTML = '';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = current;
      input.dataset.field = field;
      input.className = 'inv-edit-input';
      input.style.width = '100%';
      input.style.boxSizing = 'border-box';
      input.style.fontSize = '12px';

      cell.appendChild(input);
    }
  });
}

function saveInventoryEdits() {
  const tbody = $('#inv-table tbody');
  if (!tbody) return;

  const ips = getSelectedInventoryIps();
  if (!ips.length) { alert('Nenhuma camera selecionada para salvar.'); return; }

  const payloadCams = [];

  ips.forEach(function (ip) {
    const row = tbody.querySelector('tr[data-ip="' + ip + '"]');
    if (!row) return;

    const cameradata = { ip: ip };
    const inputs = row.querySelectorAll('input.inv-edit-input');
    inputs.forEach(function (inp) {
      const field = inp.dataset.field;
      if (!field) return;
      cameradata[field] = safeTrim(inp.value);
    });

    payloadCams.push(cameradata);
  });

  if (!payloadCams.length) { alert('Nenhuma alteracao encontrada para salvar.'); return; }

  fetch('/api/cameras/save?mode=' + encodeURIComponent(getInventoryViewMode()), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cameras: payloadCams })
  })
    .then(resp => {
      if (!resp.ok) return resp.text().then(t => { throw new Error('HTTP ' + resp.status + ' - ' + t); });

      ips.forEach(function (ip) {
        const row = tbody.querySelector('tr[data-ip="' + ip + '"]');
        if (!row) return;
        const inputs = row.querySelectorAll('input.inv-edit-input');
        inputs.forEach(function (inp) {
          const cell = inp.parentElement;
          if (cell) cell.textContent = safeTrim(inp.value);
        });
      });

      showEditSuccessBanner('? <strong>' + ips.length + ' camera(s) editadas com sucesso.</strong>');
      setInventoryEditingMode(false);
      applyInventoryFilterDom();
    })
    .catch(err => {
      console.error(err);
      alert('Erro ao salvar edicões do inventario.');
    });
}

function deleteInventorySelected() {
  const ips = getSelectedInventoryIps();
  if (!ips.length) { alert('Nenhuma camera selecionada para apagar.'); return; }

  const msgConfirm = ips.length === 1
    ? ('Tem certeza que deseja apagar somente a camera selecionada (' + ips[0] + ') do inventario?')
    : ('Tem certeza que deseja apagar somente as ' + ips.length + ' cameras selecionadas do inventario?');

  if (!window.confirm(msgConfirm)) return;

  const btnDelete = byId('btn-inv-delete');
  if (btnDelete) { btnDelete.disabled = true; btnDelete.textContent = 'Apagando...'; }

  fetch('/api/inventory/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ips: ips, mode: getInventoryViewMode() })
  })
    .then(resp => resp.json().catch(() => ({})).then(data => ({ resp, data })))
    .then(({ resp, data }) => {
      if (!resp.ok || data.ok === false || data.success === false) {
        alert(data.error || 'Falha ao apagar cameras do inventario.');
        return;
      }

      if (Array.isArray(data.inventory)) {
        renderInventoryTable(data.inventory);
        applyInventoryFilterDom();
      } else {
        return loadInventory();
      }

      showEditSuccessBanner('? <strong>' + ips.length + ' camera(s) apagadas do inventario com sucesso.</strong>');
      setInventoryEditingMode(false);
    })
    .catch(e => {
      console.error(e);
      alert('Erro inesperado ao apagar cameras do inventario.');
    })
    .finally(() => {
      if (btnDelete) { btnDelete.disabled = false; btnDelete.textContent = 'Apagar selecionadas'; }
    });
}

function clearInventory() {
  const selectedSite = safeTrim((byId('inventory-site') || {}).value || '');
  const cacheKey = getInventoryCacheKey(selectedSite);
  const msg = selectedSite
    ? ('Apagar inventario?\nSite: ' + selectedSite + '\nEscopo: somente este site.')
    : 'Apagar inventario?\nSite: Todos os sites\nEscopo: todos os sites.';
  if (!confirm(msg)) return;

  fetch(`/api/inventory/clear?_=${Date.now()}`, {
    method: 'POST',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site: selectedSite || '', mode: getInventoryViewMode() }),
  })
    .then(resp => {
      if (!resp.ok) return resp.text().then(t => { throw new Error('HTTP ' + resp.status + ' - ' + t); });
      return resp.json().catch(() => ({}));
    })
    .then(() => {
      try { localStorage.removeItem(cacheKey); } catch (e) {}
      return loadInventory();
    })
    .catch(err => {
      console.error(err);
      alert('Erro ao apagar o inventario.');
      const tbody = $('#inv-table tbody') || byId('inventory-body');
      if (tbody) tbody.innerHTML = '<tr><td colspan="' + getInventoryColumnConfig().emptyColspan + '" class="muted">Nenhuma camera no inventario.</td></tr>';
    });
}

function exportInventoryBackup() {
  // forca download do JSON atual via backend
  const a = document.createElement('a');
  a.href = '/api/inventory/export?mode=' + encodeURIComponent(getInventoryViewMode());
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function exportInventoryPdfReport() {
  const selectedSite = safeTrim((byId('inventory-site') || {}).value || '');
  const companyName = safeTrim((byId('pdf-report-company') || {}).value || '');
  const reportColor = normalizeReportColor((byId('pdf-report-color-text') || byId('pdf-report-color') || {}).value || '');
  const reportMode = getInventoryViewMode();
  const selectedIps = getSelectedInventoryIpsParam();
  let url = '/api/inventory/report.pdf';
  const qs = [];
  if (selectedSite) qs.push('site=' + encodeURIComponent(selectedSite));
  if (companyName) qs.push('company_name=' + encodeURIComponent(companyName));
  if (reportColor) qs.push('report_color=' + encodeURIComponent(reportColor));
  if (reportMode) qs.push('mode=' + encodeURIComponent(reportMode));
  if (selectedIps) qs.push('ips=' + encodeURIComponent(selectedIps));
  qs.push('_=' + Date.now());
  if (qs.length) url += '?' + qs.join('&');
  url = authAppendTokenParam(url);
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function buildInventoryPdfPreviewUrl() {
  const selectedSite = safeTrim((byId('inventory-site') || {}).value || '');
  const companyName = safeTrim((byId('pdf-report-company') || {}).value || '');
  const reportColor = normalizeReportColor((byId('pdf-report-color-text') || byId('pdf-report-color') || {}).value || '');
  const reportMode = getInventoryViewMode();
  const selectedIps = getSelectedInventoryIpsParam();
  let url = '/api/inventory/report/preview.jpg';
  const qs = [];
  if (selectedSite) qs.push('site=' + encodeURIComponent(selectedSite));
  if (companyName) qs.push('company_name=' + encodeURIComponent(companyName));
  if (reportColor) qs.push('report_color=' + encodeURIComponent(reportColor));
  if (reportMode) qs.push('mode=' + encodeURIComponent(reportMode));
  if (selectedIps) qs.push('ips=' + encodeURIComponent(selectedIps));
  qs.push('_=' + Date.now());
  if (qs.length) url += '?' + qs.join('&');
  return authAppendTokenParam(url);
}

async function saveInventoryPdfSettings() {
  const companyName = safeTrim((byId('pdf-report-company') || {}).value || '');
  const reportColor = normalizeReportColor((byId('pdf-report-color-text') || byId('pdf-report-color') || {}).value || '');
  try {
    await fetch('/api/inventory/report/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ company_name: companyName, report_color: reportColor }),
    });
  } catch (_) {}
}

async function refreshInventoryPdfPreview() {
  const frame = byId('pdf-report-frame');
  const status = byId('pdf-report-status');
  if (!frame) return;
  const selectedCount = getSelectedInventoryIps().length;
  if (status) {
    status.textContent = selectedCount
      ? ('Gerando preview com ' + selectedCount + ' camera(s) selecionada(s)...')
      : 'Gerando preview...';
  }
  await saveInventoryPdfSettings();
  frame.onload = function () {
    if (!status) return;
    status.textContent = selectedCount
      ? ('Preview atualizado com ' + selectedCount + ' camera(s) selecionada(s).')
      : 'Preview atualizado.';
  };
  frame.onerror = function () { if (status) status.textContent = 'Erro ao gerar preview.'; };
  frame.src = buildInventoryPdfPreviewUrl();
}

function closeInventoryPdfPreview() {
  const backdrop = byId('pdf-report-backdrop');
  if (backdrop) backdrop.style.display = 'none';
}

async function openInventoryPdfPreview() {
  const backdrop = byId('pdf-report-backdrop');
  const frame = byId('pdf-report-frame');
  const status = byId('pdf-report-status');
  const companyEl = byId('pdf-report-company');
  const colorEl = byId('pdf-report-color');
  const colorTextEl = byId('pdf-report-color-text');
  if (!backdrop || !frame) return;
  backdrop.style.display = 'flex';
  if (status) status.textContent = 'Carregando configuracoes...';
  try {
    const r = await fetch('/api/inventory/report/settings?_=' + Date.now(), { cache: 'no-store' });
    const j = await r.json().catch(() => ({}));
    if (companyEl && j && j.company_name) companyEl.value = String(j.company_name);
    const color = normalizeReportColor((j && j.report_color) || '');
    if (colorEl) colorEl.value = color;
    if (colorTextEl) colorTextEl.value = color;
    if (status) {
      status.textContent = (j && j.has_logo)
        ? 'Logo carregada. Ajuste os campos e clique em Atualizar preview.'
        : 'Sem logo. Envie uma imagem para personalizar o cabecalho.';
    }
  } catch (_) {
    if (status) status.textContent = 'Falha ao carregar configuracoes.';
  }
  await refreshInventoryPdfPreview();
}

function exportFullBackupZip() {
  // forca download do ZIP completo via backend (data/)
  const a = document.createElement('a');
  a.href = '/api/backup/export';
  a.target = '_blank';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function importFullBackupZip(file) {
  if (!file) return;
  const msg = 'Restaurar um Backup ZIP ira substituir a pasta data/ atual (fotos, json, kmz, etc.).\n\nRecomendado: fazer um Backup ZIP antes.\n\nDeseja continuar?';
  if (!window.confirm(msg)) return;

  const form = new FormData();
  form.append('file', file);

  const overlay = byId('inv-overlay');
  if (overlay) {
    overlay.textContent = 'Restaurando backup ZIP';
    overlay.style.display = 'flex';
  }

  fetch('/api/backup/import', {
    method: 'POST',
    body: form
  })
    .then(resp => resp.json().catch(() => ({})).then(data => ({ resp, data })))
    .then(({ resp, data }) => {
      if (!resp.ok || !data || data.ok === false) {
        const msg2 = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + resp.status);
        throw new Error(msg2);
      }

      // Mostra um resumo do restore para dar confianca visual
      const invN = (typeof data.inventory_count === 'number') ? data.inventory_count : 0;
      const snapN = (typeof data.snapshots_restored === 'number') ? data.snapshots_restored : 0;
      const thumbsN = (typeof data.thumbs_restored === 'number') ? data.thumbs_restored : 0;
      const kmzFound = !!data.kmz_found;
      const kmzN = (typeof data.kmz_files === 'number') ? data.kmz_files : 0;

      const resumoHtml =
        ' <strong>Backup restaurado com sucesso.</strong>' +
        '<div class="muted" style="margin-top:6px; line-height:1.35">' +
        'Inventario: <strong>' + invN + '</strong> cameras<br>' +
        'Snapshots: <strong>' + snapN + '</strong> arquivo(s)<br>' +
        'Thumbs: <strong>' + thumbsN + '</strong> arquivo(s)<br>' +
        'KMZ/KML: <strong>' + (kmzFound ? ('encontrado (' + kmzN + ')') : 'nao encontrado') + '</strong>' +
        '</div>' +
        '<div class="muted" style="margin-top:6px">Recarregando</div>';

      showInvSuccessBanner(resumoHtml);
      setTimeout(function () {
        window.location.reload();
      }, 1500);
    })
    .catch(err => {
      console.error(err);
      alert('Falha ao restaurar Backup ZIP: ' + (err && err.message ? err.message : err));
    })
    .finally(() => {
      if (overlay) overlay.style.display = 'none';
    });
}

function importInventoryBackup(file) {
  if (!file) return;
  if (!window.confirm('Importar inventario ira SUBSTITUIR o inventario atual. Deseja continuar?')) return;

  const form = new FormData();
  form.append('file', file);

  // feedback simples
  const overlay = byId('inv-overlay');
  if (overlay) {
    overlay.textContent = 'Importando inventario';
    overlay.style.display = 'flex';
  }

  fetch('/api/inventory/import?mode=' + encodeURIComponent(getInventoryViewMode()), {
    method: 'POST',
    body: form
  })
    .then(resp => resp.json().catch(() => ({})).then(data => ({ resp, data })))
    .then(({ resp, data }) => {
      if (!resp.ok || !data || data.ok === false) {
        const msg = (data && (data.error || data.message)) ? (data.error || data.message) : ('HTTP ' + resp.status);
        throw new Error(msg);
      }

      if (Array.isArray(data.inventory)) {
        renderInventoryTable(data.inventory);
        applyInventoryFilterDom();
      } else {
        return loadInventory();
      }

      showInvSuccessBanner('? <strong>Inventario importado com sucesso.</strong>');
    })
    .catch(err => {
      console.error(err);
      alert('Falha ao importar inventario: ' + (err && err.message ? err.message : err));
    })
    .finally(() => {
      if (overlay) overlay.style.display = 'none';
    });
}

function cancelInventoryEdits() {
  setInventoryEditingMode(false);

  const inputs = $all('#inv-table tbody input.inv-edit-input');
  inputs.forEach(function (inp) {
    const cell = inp.parentElement;
    if (cell) cell.textContent = safeTrim(inp.value);
  });

  $all('#inv-table tbody input.inv-select[type="checkbox"]').forEach(function (cb) { cb.checked = false; });
  const selectAll = byId('inv-select-all');
  if (selectAll) {
    selectAll.checked = false;
    selectAll.indeterminate = false;
  }

  hideEditSuccessBanner();
  loadInventory();
}

/* =========================
   OLT UI / Banners / Logs
   ========================= */
const OLT_CACHE_KEY = 'cam_snapshot_olt_last_v1';

function oltLoadCache() {
  try {
    const raw = localStorage.getItem(OLT_CACHE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object') return null;
    return obj;
  } catch (_) {}
  return null;
}

function oltSaveCache(payload) {
  try {
    const base = oltLoadCache() || {};
    const next = Object.assign({}, base, payload || {}, { ts: Date.now() });
    localStorage.setItem(OLT_CACHE_KEY, JSON.stringify(next));
  } catch (_) {}
}

function oltClearCache() {
  try { localStorage.removeItem(OLT_CACHE_KEY); } catch (_) {}
}

function normalizeMacText(v) {
  const hex = String(v || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return hex;
}

function applyOltMacFilter() {
  const input = byId('olt-mac-search');
  const siteEl = byId('olt-site-filter');
  const tbody = $('#olt-macs-table tbody');
  if (!tbody) return;

  const q = safeTrim(input ? input.value : '').toLowerCase();
  const site = safeTrim(siteEl ? siteEl.value : '').toLowerCase();
  const rows = Array.from(tbody.querySelectorAll('tr'));
  if (!rows.length) return;

  let dataRows = 0;
  let visibleDataRows = 0;
  rows.forEach(function (tr) {
    const tds = tr.querySelectorAll('td');
    if (!tds || !tds.length) {
      tr.style.display = '';
      return;
    }
    const onlyCell = (tds.length === 1) ? tds[0] : null;
    if (onlyCell && Number(onlyCell.getAttribute('colspan') || '0') >= 6) {
      tr.style.display = q ? 'none' : '';
      return;
    }

    dataRows += 1;
    const rowTextNorm = String(tr.textContent || '').toLowerCase();
    const rowSite = safeTrim(tr.getAttribute('data-site') || '').toLowerCase();
    const siteOk = (!site) || (rowSite === site);
    const searchOk = (!q) || rowTextNorm.includes(q);
    const show = siteOk && searchOk;
    tr.style.display = show ? '' : 'none';
    if (show) visibleDataRows += 1;
  });

  // Evita "sumiço" da tabela quando o site selecionado ficou invalido apos reload/limpeza.
  if (!q && siteEl && site && dataRows > 0 && visibleDataRows === 0) {
    siteEl.value = '';
    applyOltMacFilter();
  }
}

function uploadInventoryImgBB() {
  const btn = byId('btn-inv-imgbb');
  const selectedIps = getSelectedInventoryIps();
  const hasSelection = selectedIps.length > 0;

  const ok = hasSelection
    ? window.confirm('Enviar para ImgBB apenas as ' + selectedIps.length + ' camera(s) selecionada(s)?')
    : window.confirm('Nenhuma camera selecionada. Enviar para ImgBB TODAS as cameras do inventario?');
  if (!ok) return;

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Enviando...';
  }

  fetch('/api/inventory/imgbb/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ips: selectedIps, mode: getInventoryViewMode() })
  })
    .then(resp => resp.json().catch(() => ({})).then(data => ({ resp, data })))
    .then(({ resp, data }) => {
      if (!resp.ok || !data || data.ok !== true) {
        throw new Error((data && (data.error || data.detail)) || ('HTTP ' + resp.status));
      }
      if (Array.isArray(data.inventory)) {
        renderInventoryTable(data.inventory);
        applyInventoryFilterDom();
      } else {
        return loadInventory();
      }
      const uploaded = Number(data.uploaded || 0);
      const processed = Number(data.processed || 0);
      const warn = safeTrim(data.error || '');
      let msg = '? <strong>ImgBB atualizado.</strong> Processadas: ' + processed + ' | Enviadas: ' + uploaded + '.';
      if (warn) msg += '<div class="muted" style="margin-top:6px;">' + warn + '</div>';
      showInvSuccessBanner(msg);
    })
    .catch(err => {
      console.error(err);
      alert('Erro ao enviar para ImgBB: ' + (err && err.message ? err.message : err));
    })
    .finally(() => {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Atualizar ImgBB';
      }
    });
}

function refreshOltSiteFilterOptions(rows) {
  const sel = byId('olt-site-filter');
  if (!sel) return;
  const cur = safeTrim(sel.value || '');
  const list = Array.isArray(rows) ? rows : [];
  const sites = Array.from(
    new Set(
      list.map(r => safeTrim((r && r.site) || '')).filter(Boolean)
    )
  ).sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));

  sel.innerHTML = '<option value="">Todos os sites</option>';
  sites.forEach(function (name) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  if (cur && sites.includes(cur)) sel.value = cur;
}

function renderOltRows(rows) {
  const tbody = $('#olt-macs-table tbody');
  if (!tbody) return;
  const list = Array.isArray(rows) ? rows : [];
  refreshOltSiteFilterOptions(list);
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Nenhum MAC coletado ainda.</td></tr>';
    applyOltMacFilter();
    return;
  }
  tbody.innerHTML = '';
  list.forEach(function (m) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-site', safeTrim(m.site || ''));
    tr.innerHTML = `
      <td>${m.pon || ''}</td>
      <td>${m.onu_id || ''}</td>
      <td>${m.onu_name || ''}</td>
      <td>${m.onu_serial || ''}</td>
      <td>${m.cpe_mac || ''}</td>
      <td>${m.vlan || ''}</td>
    `;
    tbody.appendChild(tr);
  });
  applyOltMacFilter();
}

function restoreOltFromCache() {
  const cache = oltLoadCache();
  if (!cache) return;

  const ipEl = byId('olt-ip');
  const siteEl = byId('olt-site');
  const userEl = byId('olt-user');
  const ponEl = byId('olt-pon');
  const modelEl = byId('olt-model');
  const statusEl = byId('olt-status');
  const reuseEl = byId('olt-reuse-json');

  if (modelEl && cache.model) modelEl.value = cache.model;
  refreshOltPonOptions();
  if (ponEl && cache.pon) ponEl.value = cache.pon;
  if (ipEl && cache.olt_ip) ipEl.value = cache.olt_ip;
  if (siteEl && cache.site) siteEl.value = cache.site;
  if (userEl && cache.user) userEl.value = cache.user;
  if (reuseEl && typeof cache.reuse_json === 'boolean') reuseEl.checked = cache.reuse_json;
  if (statusEl && cache.status) statusEl.textContent = cache.status;

  if (Array.isArray(cache.rows) && cache.rows.length) {
    renderOltRows(cache.rows);
    setOltProgress(100, 'Dados OLT restaurados do cache.');
  }

  const logEl = byId('olt-log');
  if (logEl && cache.log) logEl.textContent = String(cache.log);
}

function loadPersistedOltRows() {
  const statusEl = byId('olt-status');
  return fetch('/api/olt/rows?_=' + Date.now(), { method: 'GET', cache: 'no-store' })
    .then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; });
    })
    .then(function (o) {
      if (!o.ok || !o.j || o.j.ok !== true) throw new Error('Falha ao carregar base OLT');
      const rows = Array.isArray(o.j.rows) ? o.j.rows : [];
      if (!rows.length) return false;
      renderOltRows(rows);
      oltSaveCache({
        rows: rows,
        status: 'Base OLT restaurada do banco (total: ' + rows.length + ').',
      });
      if (statusEl && safeTrim(statusEl.textContent) === 'Pronto para scan da OLT.') {
        statusEl.textContent = 'Base OLT restaurada do banco (total: ' + rows.length + ').';
      }
      return true;
    })
    .catch(function () {
      return false;
    });
}

function clearOltForm() {
  const ipEl   = byId('olt-ip');
  const siteEl = byId('olt-site');
  const userEl = byId('olt-user');
  const passEl = byId('olt-password');
  const ponEl  = byId('olt-pon');
  const modelEl = byId('olt-model');
  const statusEl = byId('olt-status');

  if (ipEl) ipEl.value = '';
  if (siteEl) siteEl.value = '';
  if (userEl) userEl.value = 'admin';
  if (passEl) passEl.value = '';
  if (ponEl) ponEl.value = '';

  [ipEl, siteEl, userEl, passEl, ponEl].forEach(function (el) {
    if (!el) return;
    el.style.borderColor = 'var(--border-subtle)';
  });

  if (statusEl) { statusEl.textContent = 'Pronto para scan da OLT.'; statusEl.style.color = ''; }
  setOltProgress(0, '');
}

function oltClearLog() {
  const logEl = byId('olt-log');
  if (logEl) logEl.textContent = '';
}

function oltAppendLog(msg) {
  const logEl = byId('olt-log');
  if (!logEl) return;
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += '[' + ts + '] ' + msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function clearOltUi() {
  clearOltForm();
  oltClearLog();
  renderOltRows([]);
}

function showOltDoneBanner() {
  const el = byId('olt-done-banner');
  if (el) el.style.display = 'flex';
}
function hideOltDoneBanner() {
  const el = byId('olt-done-banner');
  if (el) el.style.display = 'none';
  clearOltForm();
}
function showOltAuthErrorBanner() {
  const el = byId('olt-auth-error-banner');
  if (el) el.style.display = 'flex';
}
function hideOltAuthErrorBanner() {
  const el = byId('olt-auth-error-banner');
  if (el) el.style.display = 'none';
  clearOltForm();
}

/* =========================
   OLT: carregar tabela (HTTP)
   ========================= */
function loadOltMacsTable(oltIp, user, pass, ponStr, oltModel, siteName) {
  const statusEl = byId('olt-status');
  const tbody = $('#olt-macs-table tbody');
  const reuseJson = !!(byId('olt-reuse-json') && byId('olt-reuse-json').checked);

  setOltProgress(70, 'Carregando MACs da OLT...');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="muted">Carregando MACs...</td></tr>';

  return fetch('/api/olt/collect-macs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      olt_ip: oltIp,
      user: user,
      password: pass,
      pon: ponStr,
      olt_model: (oltModel || '8820i'),
      site: (siteName || ''),
      reuse_json: reuseJson
    })
  })
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().catch(() => ({}));
    })
    .then(data => {
      const rows = data.rows_all || data.rows || [];
      const cliLog = data.cli_log || '';
      try { refreshOltSiteFilterOptions(rows); } catch (_) {}
      if (cliLog) {
        const logEl = byId('olt-log');
        if (logEl) {
          logEl.textContent += '\n' + cliLog;
          logEl.scrollTop = logEl.scrollHeight;
        }
      }

      if (!rows.length) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="muted">Nenhum MAC coletado.</td></tr>';
        if (statusEl) statusEl.textContent = 'Nenhum MAC coletado.';
        setOltProgress(100, 'Nenhum MAC coletado.');
        oltSaveCache({
          olt_ip: oltIp,
          user: user,
          site: (siteName || ''),
          pon: ponStr,
          model: (oltModel || '8820i'),
          reuse_json: reuseJson,
          status: 'Nenhum MAC coletado.',
          rows: [],
          log: (byId('olt-log') && byId('olt-log').textContent) || '',
        });
        return;
      }

      if (tbody) tbody.innerHTML = '';
      let idx = 0;
      const total = rows.length;
      const RENDER_CHUNK = 60;

      function addNextRow() {
        if (!tbody) return;
        if (idx >= total) {
          if (statusEl) statusEl.textContent = 'Base OLT atualizada (total salvo: ' + total + ').';
          setOltProgress(100, 'MACs coletados com sucesso.');
          oltSaveCache({
            olt_ip: oltIp,
            user: user,
            site: (siteName || ''),
            pon: ponStr,
            model: (oltModel || '8820i'),
            reuse_json: reuseJson,
            status: 'MACs coletados com sucesso (total: ' + total + ').',
            rows: rows,
            log: (byId('olt-log') && byId('olt-log').textContent) || '',
          });
          showOltDoneBanner();
          return;
        }
        const frag = document.createDocumentFragment();
        const lim = Math.min(total, idx + RENDER_CHUNK);
        while (idx < lim) {
          const m = rows[idx++];
          const tr = document.createElement('tr');
          tr.setAttribute('data-site', safeTrim(m.site || ''));
          tr.innerHTML = `
            <td>${m.pon || ''}</td>
            <td>${m.onu_id || ''}</td>
            <td>${m.onu_name || ''}</td>
            <td>${m.onu_serial || ''}</td>
            <td>${m.cpe_mac || ''}</td>
            <td>${m.vlan || ''}</td>
          `;
          frag.appendChild(tr);
        }
        tbody.appendChild(frag);
        applyOltMacFilter();

        if (statusEl) statusEl.textContent = 'Preenchendo tabela... (' + idx + '/' + total + ')';
        const frac = idx / total;
        const prog = 80 + Math.round(frac * 20);
        setOltProgress(prog, 'Preenchendo tabela... (' + idx + '/' + total + ')');

        setTimeout(addNextRow, 0);
      }

      addNextRow();
    })
    .catch(err => {
      console.error(err);
      if (statusEl) {
        statusEl.textContent = ' Erro ao coletar MACs. Verifique IP/usuario/senha e veja o log.';
        statusEl.style.color = '#f97373';
      }
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="muted">Erro ao coletar MACs.</td></tr>';
      setOltProgress(0, 'Erro ao coletar MACs.');
      oltSaveCache({
        olt_ip: oltIp,
        user: user,
        site: (siteName || ''),
        pon: ponStr,
        model: (oltModel || '8820i'),
        reuse_json: reuseJson,
        status: 'Erro ao coletar MACs. Verifique o log.',
        rows: [],
        log: (byId('olt-log') && byId('olt-log').textContent) || '',
      });
      showOltAuthErrorBanner();
    });
}

/* =========================
   OLT: WS console
   ========================= */
function oltCollectMacsWSLegacy() {
  const ipEl   = byId('olt-ip');
  const siteEl = byId('olt-site');
  const userEl = byId('olt-user');
  const passEl = byId('olt-password');
  const modelEl = byId('olt-model');
  const ponEl  = byId('olt-pon');
  const statusEl = byId('olt-status');
  const btnMacs  = byId('btn-olt-macs');

  [ipEl, siteEl, userEl, passEl, ponEl].forEach(function (el) { if (el) el.style.borderColor = 'var(--border-subtle)'; });
  if (statusEl) statusEl.style.color = '';

  const oltIp  = safeTrim(ipEl?.value);
  const siteName = safeTrim(siteEl?.value);
  const user   = safeTrim(userEl?.value);
  const pass   = passEl ? passEl.value : '';
  const ponRaw = safeTrim(ponEl?.value);
  const oltModel = safeTrim(modelEl?.value) || '8820i';

  const missing = [];
  if (!oltIp) missing.push('IP');
  if (!siteName) missing.push('site');
  if (!user) missing.push('usuario');
  if (!pass) missing.push('senha');
  if (!ponRaw) missing.push('PON');

  if (missing.length) {
    if (statusEl) { statusEl.textContent = 'Preencha ' + missing.join(', ') + ' da OLT.'; statusEl.style.color = '#f97373'; }
    if (!oltIp && ipEl) ipEl.style.borderColor = '#f97373';
    if (!siteName && siteEl) siteEl.style.borderColor = '#f97373';
    if (!user && userEl) userEl.style.borderColor = '#f97373';
    if (!pass && passEl) passEl.style.borderColor = '#f97373';
    if (!ponRaw && ponEl) ponEl.style.borderColor = '#f97373';
    return;
  }

  let ponStr = ponRaw.toLowerCase();
  if (ponStr !== 'all') {
    // 8820i: 1..8 | 4840e: 0/1..0/4
    if (oltModel === '4840e') {
      const ok = /^0\/(?:1|2|3|4)$/.test(ponStr);
      if (!ok) {
        if (statusEl) { statusEl.textContent = 'PON invalida para 4840E. Use 0/1..0/4 ou "all".'; statusEl.style.color = '#f97373'; }
        if (ponEl) ponEl.style.borderColor = '#f97373';
        return;
      }
    } else {
      const ponNum = Number(ponStr);
      if (!Number.isInteger(ponNum) || ponNum < 1) {
        if (statusEl) { statusEl.textContent = 'PON invalida. Use numero (ex: 1) ou "all".'; statusEl.style.color = '#f97373'; }
        if (ponEl) ponEl.style.borderColor = '#f97373';
        return;
      }
    }
  }

  oltClearLog();
  if (statusEl) { statusEl.textContent = 'Conectando na OLT ' + oltIp + ' [' + siteName + '] (PON: ' + ponStr + ')...'; statusEl.style.color = ''; }
  setOltProgress(5, 'Conectando na OLT...');
  oltAppendLog('Conectando em ' + oltIp + ' [site: ' + siteName + ']...');

  if (btnMacs) btnMacs.disabled = true;

  const tbody = $('#olt-macs-table tbody');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="muted">Coleta em andamento...</td></tr>';
  // Backend atual usa coleta via HTTP (/api/olt/collect-macs).
  // O WS /ws/olt-console ficou apenas como keepalive/compat e nao entrega "done".
  if (statusEl) statusEl.textContent = 'Sessao iniciada. Coletando MACs...';
  setOltProgress(20, 'Executando coleta na OLT...');

  loadOltMacsTable(oltIp, user, pass, ponStr, oltModel, siteName)
    .finally(function () {
      if (btnMacs) btnMacs.disabled = false;
    });
}

/* =========================
   SNAPSHOT (WS)
   ========================= */
function downloadSnapshotImage() {
  const img = byId('snapshot-image');
  if (!img || !img.src) {
    alert('Nenhum snapshot disponível para salvar.');
    return;
  }
  try {
    const link = document.createElement('a');
    link.href = img.src;
    link.download = 'snapshot_cam.jpg';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  } catch (err) {
    console.error('Erro ao baixar snapshot:', err);
    alert('Nao foi possível iniciar o download da imagem.');
  }
}

function runSnapshot(evt) {
  if (evt) evt.preventDefault();

  const ipInput = byId('snapshot-ip');
  const userInput = byId('snapshot-user');
  const passInput = byId('snapshot-pass');
  const statusEl = byId('snapshot-status');
  const logEl = byId('snapshot-log');
  const imgEl = byId('snapshot-image');
  const cardEl = byId('snapshot-result-card');
  const ipLabel = byId('snapshot-ip-label');
  const btn = byId('btn-snapshot-run');

  if (!ipInput || !userInput || !passInput || !statusEl || !logEl || !imgEl || !cardEl || !ipLabel || !btn) {
    console.warn('Elementos da aba Snapshot nao encontrados.');
    return;
  }

  const ip = safeTrim(ipInput.value);
  const usuario = safeTrim(userInput.value) || 'admin';
  const senha = passInput.value || 'admin';

  if (!ip) {
    statusEl.textContent = 'Informe um IP para capturar o snapshot.';
    return;
  }

  statusEl.textContent = 'Conectando à camera...';
  logEl.textContent = '';
  btn.disabled = true;
  var gotSnapshot = false;

  const wsUrl = buildAuthedWsUrl('/ws/snapshot');

  let ws;
  try { ws = new WebSocket(wsUrl); } catch (err) {
    statusEl.textContent = 'Falha ao abrir WebSocket: ' + (err.message || err);
    btn.disabled = false;
    return;
  }

  ws.onopen = function () {
    statusEl.textContent = 'Enviando requisicao...';
    sendWsAuthFrame(ws);
    ws.send(JSON.stringify({ ip: ip, usuario: usuario, senha: senha }));
  };

  ws.onmessage = function (ev) {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    if (msg.type === 'log') {
      logEl.textContent += (msg.line || '') + '\n';
      logEl.scrollTop = logEl.scrollHeight;
      return;
    }
    if (msg.type === 'status') {
      statusEl.textContent = msg.message || '';
      return;
    }
    if (msg.type === 'error') {
        if (!msg.message) {
          msg.message = 'Erro no WebSocket (mensagem vazia). Usando modo compatível (HTTP)...';
          // fallback para HTTP
          try { ws.close(); } catch (e) {}
          if (typeof httpFallbackScan === 'function') {
            httpFallbackScan(payload, btn, statusEl, overlay, counter, 'Scan concluído. Inventario atualizado.');
          }
        }

        wsFinished = true;
        try { clearTimeout(wsWatchdog); } catch (_) {}
      statusEl.textContent = msg.message || 'Erro ao capturar snapshot.';
      btn.disabled = false;
      return;
    }
    if (msg.type === 'snapshot') {
      if (msg.image_b64) {
        gotSnapshot = true;
        imgEl.src = msg.image_b64;
        cardEl.style.display = 'block';
        ipLabel.textContent = 'IP: ' + (msg.ip || ip);

        //  Registra sempre o snapshot local no backend para aparecer em Miniaturas
        // (antes só aparecia quando existia upload/ImgBB).
        try {
          var savePath = safeTrim(msg.path || msg.filepath || msg.out_path || '');
          if (savePath) {
            fetch('/api/snapshot/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ path: savePath, ip: (msg.ip || ip) })
            })
              .then(function (r) { return r.json().catch(function () { return {}; }); })
              .then(function (j) {
                if (j && j.ok) {
                  // permite recarregar a galeria imediatamente
                  __snapshotMiniLoadedOnce = false;
                }
              })
              .catch(function () { /* silent */ });
          }
        } catch (e) { /* silent */ }
      }
      return;
    }
    if (msg.type === 'done' || msg.done === true) {
        wsFinished = true;
        try { clearTimeout(wsWatchdog); } catch (_) {}
      statusEl.textContent = msg.message || 'Snapshot concluído.';
      btn.disabled = false;

      if (gotSnapshot) {
        var ipShown = (msg.ip || ip);
        showSnapshotSuccessBanner(' <strong>Snapshot capturado.</strong> IP: ' + ipShown);
      }

      try { ws.close(); } catch (_) {}
    }
  };

  ws.onerror = function () {
    statusEl.textContent = 'Erro de conexao WebSocket ao capturar snapshot.';
    btn.disabled = false;
  };
  ws.onclose = function () { btn.disabled = false; };
}

/* =========================
   INIT handlers
   ========================= */

// =========================
// Manutencao (aba/ pagina)
// - renderiza cards a partir do MESMO cache do inventario
// - sem depender de API para exibir
// - API (inventory-last) e usada apenas como refresh oportunista
// =========================

function getCachedInventory() {
  const CACHE_KEY = getInventoryCacheKey('');
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const obj = JSON.parse(raw);
    if (obj && Array.isArray(obj.inventory)) return obj.inventory;
  } catch (_) {}
  return [];
}

function setCachedInventory(inv) {
  const CACHE_KEY = getInventoryCacheKey('');
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), inventory: inv || [] }));
  } catch (_) {}
}

// =========================
// Estado de reboot (UI)
// =========================
function getRebootMap() {
  const KEY = 'cam_snapshot_rebooting_v1';
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : {};
  } catch (_) {}
  return {};
}

function setRebootMap(map) {
  const KEY = 'cam_snapshot_rebooting_v1';
  try {
    localStorage.setItem(KEY, JSON.stringify(map || {}));
  } catch (_) {}
}

function markRebooting(ip, seconds) {
  const map = getRebootMap();
  const now = Date.now();
  map[ip] = {
    started: now,
    until: now + (Math.max(10, (seconds || 90)) * 1000)
  };
  setRebootMap(map);
}

function clearRebooting(ip) {
  const map = getRebootMap();
  if (map && map[ip]) {
    delete map[ip];
    setRebootMap(map);
  }
}

function getRebootRemainingSeconds(ip) {
  const map = getRebootMap();
  const st = map ? map[ip] : null;
  if (!st || !st.until) return 0;
  const ms = st.until - Date.now();
  return Math.max(0, Math.ceil(ms / 1000));
}

function normalizeCamForUI(cam) {
  const ip = cam.ip || cam.IP || '';
  const title = cam.titulo || cam.TITULO || cam.title || cam.nome || '';
  const model = cam.modelo || cam.MODELO || cam.model || '';
  const fab  = cam.fabricante || cam.FABRICANTE || cam.manufacturer || '';
  const mac  = cam.mac || cam.MAC || cam.mac_address || '';
  const status = (cam.status || cam.STATUS || '').toLowerCase();
  const pon = cam.pon || cam.PON || '';
  const onuId = cam.onu_id || cam.ONU_ID || '';
  const onuName = cam.onu_name || cam.ONU_NAME || '';
  const onuSerial = cam.onu_serial || cam.ONU_SERIAL || '';

  const localSnap = snapshotLocalUrlFromPath(cam.snapshot_path || cam.snapshotPath || cam.snapshot_local || cam.local_snapshot || '');
  const img = localSnap || cam.snapshot_url || cam.thumb_url || cam.imgbb_url || '';

  return {
    ip: ip,
    title: title || ('CAM ' + ip),
    model: model,
    fab: fab,
    mac: mac,
    status: status,
    pon: pon,
    onuId: onuId,
    onuName: onuName,
    onuSerial: onuSerial,
    img: img,
    http_port: parseInt(cam.http_port || cam.HTTP_PORT || 80, 10) || 80,
    https_port: parseInt(cam.https_port || cam.HTTPS_PORT || 0, 10) || 0,
    rtsp_port: parseInt(cam.rtsp_port || cam.RTSP_PORT || 0, 10) || 0,
    server_port: parseInt(cam.server_port || cam.SERVER_PORT || 0, 10) || 0,
    open_ports: Array.isArray(cam.open_ports) ? cam.open_ports : [],
    raw: cam
  };
}

// =========================
// Manutencao  menu  (helpers)
// =========================
let __maintenanceMenuGlobalBound = false;
let __maintenanceShortcutsBound = false;
let __maintSelected = new Set();
let __maintLastRendered = []; // lista de cams (ja filtradas) da ultima renderizacao
let __maintOpenMenuIp = '';
let __maintBusyByIp = new Map(); // ip -> action
let __maintResultByIp = new Map(); // ip -> ok|error
let __maintResultClearTimer = null;
let __maintLiveIndex = -1;
let __maintLiveSubtype = 0; // 0=HD, 1=SD
let __maintLiveQualityManual = false;
let __maintLiveZoom = 1.0;
let __maintLiveCtx = { ip: "", user: "", pass: "", channel: 1, ptzCapable: false };
let __maintLivePtzOpen = false;
let __maintLiveSnapshotTimer = null;
const __maintLiveZoomMin = 1.0;
const __maintLiveZoomMax = 3.0;
const __maintLiveZoomStep = 0.25;
const __MAINT_CAMERA_CREDS_KEY = 'maint_camera_creds_v1';

function getMaintCameraCreds(ip) {
  const keyIp = safeTrim(ip || '');
  if (!keyIp) return { user: '', pass: '' };
  try {
    const raw = localStorage.getItem(__MAINT_CAMERA_CREDS_KEY);
    if (!raw) return { user: '', pass: '' };
    const obj = JSON.parse(raw);
    const item = obj && typeof obj === 'object' ? obj[keyIp] : null;
    return {
      user: safeTrim(item && item.user ? item.user : ''),
      pass: item && item.pass != null ? String(item.pass) : ''
    };
  } catch (_) {
    return { user: '', pass: '' };
  }
}

function setMaintCameraCreds(ip, user, pass) {
  const keyIp = safeTrim(ip || '');
  const u = safeTrim(user || '');
  const p = pass != null ? String(pass) : '';
  if (!keyIp || !u || !p) return;
  try {
    const raw = localStorage.getItem(__MAINT_CAMERA_CREDS_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const next = (obj && typeof obj === 'object') ? obj : {};
    next[keyIp] = { user: u, pass: p, ts: Date.now() };
    localStorage.setItem(__MAINT_CAMERA_CREDS_KEY, JSON.stringify(next));
  } catch (_) {}
}

let __maintCredsModalReady = false;
function ensureMaintCredsModal() {
  if (__maintCredsModalReady) return;
  __maintCredsModalReady = true;

  const backdrop = document.createElement('div');
  backdrop.id = 'maint-creds-backdrop';
  backdrop.className = 'inv-modal-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.innerHTML = '' +
    '<div class="inv-modal" style="width:min(520px,96vw); height:auto; max-height:80vh;">' +
      '<div class="inv-modal-header">' +
        '<div style="font-weight:700;">Credenciais da camera</div>' +
        '<button class="btn-ghost" id="btn-maint-creds-close" type="button">Fechar</button>' +
      '</div>' +
      '<div class="inv-modal-body">' +
        '<div class="muted" id="maint-creds-sub" style="font-size:13px; margin-bottom:10px;"></div>' +
        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="maint-creds-user">Usuario</label>' +
            '<input id="maint-creds-user" type="text" placeholder="admin" autocomplete="username" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="maint-creds-pass">Senha</label>' +
            '<input id="maint-creds-pass" type="password" placeholder="Informe a senha" autocomplete="current-password" />' +
          '</div>' +
        '</div>' +
        '<div class="muted" id="maint-creds-msg" style="font-size:12px; margin-top:10px;"></div>' +
        '<div class="actions-row" style="justify-content:flex-end; margin-top:14px;">' +
          '<button class="btn-secondary" id="btn-maint-creds-cancel" type="button">Cancelar</button>' +
          '<button class="btn-primary" id="btn-maint-creds-save" type="button">Salvar</button>' +
        '</div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', function (ev) {
    if (ev && ev.target === backdrop) backdrop.classList.remove('open');
  });
  const btnClose = backdrop.querySelector('#btn-maint-creds-close');
  const btnCancel = backdrop.querySelector('#btn-maint-creds-cancel');
  if (btnClose) btnClose.addEventListener('click', function () { backdrop.classList.remove('open'); });
  if (btnCancel) btnCancel.addEventListener('click', function () { backdrop.classList.remove('open'); });
}

function openMaintCredsModal(opts) {
  opts = opts || {};
  const ip = safeTrim(opts.ip || '');
  const onSaved = (typeof opts.onSaved === 'function') ? opts.onSaved : function () {};
  if (!ip) return;

  ensureMaintCredsModal();
  const cached = getMaintCameraCreds(ip);
  const backdrop = byId('maint-creds-backdrop');
  const sub = byId('maint-creds-sub');
  const userInput = byId('maint-creds-user');
  const passInput = byId('maint-creds-pass');
  const msg = byId('maint-creds-msg');
  const btnSave = byId('btn-maint-creds-save');
  if (!backdrop || !userInput || !passInput || !btnSave) return;

  if (sub) sub.textContent = 'IP: ' + ip;
  if (msg) msg.textContent = cached.user ? 'Essas credenciais serao usadas pela Live e pelas acoes desta camera.' : 'Salve a credencial individual desta camera.';
  userInput.value = safeTrim(opts.user || cached.user || '');
  passInput.value = String(opts.pass != null ? opts.pass : (cached.pass || ''));
  backdrop.classList.add('open');
  try { setTimeout(function () { userInput.focus(); userInput.select(); }, 60); } catch (_) {}

  btnSave.onclick = null;
  btnSave.onclick = function () {
    const user = safeTrim(userInput.value || '');
    const pass = String(passInput.value || '');
    if (!user || !pass) {
      if (msg) msg.textContent = 'Informe usuario e senha.';
      return;
    }
    setMaintCameraCreds(ip, user, pass);
    try { localStorage.setItem('maint_live_user', user); localStorage.setItem('maint_live_pass', pass); } catch (_) {}
    if (msg) msg.textContent = 'Credenciais salvas para ' + ip + '.';
    try { onSaved({ user: user, pass: pass }); } catch (_) {}
    try { setTimeout(function () { backdrop.classList.remove('open'); }, 250); } catch (_) {}
  };
}

function __getMaintRenderedList() {
  try {
    if (typeof window !== 'undefined' && Array.isArray(window.__maintLastRendered)) {
      return window.__maintLastRendered;
    }
  } catch (_) {}
  return (__maintLastRendered || []);
}

function _maintApplyLiveZoom() {
  const img = document.getElementById('maint-live-img');
  const btn = document.getElementById('maint-live-zoomreset');
  if (!img) return;
  img.style.transform = `scale(${__maintLiveZoom})`;
  if (btn) btn.textContent = `${Math.round(__maintLiveZoom * 100)}%`;
}

function _maintResetLiveZoom() {
  __maintLiveZoom = 1.0;
  _maintApplyLiveZoom();
}

async function _maintToggleLiveFullscreen() {
  const el = document.getElementById('maint-live-content');
  const btn = document.getElementById('maint-live-fullscreen');
  if (!el) return;
  try {
    if (!document.fullscreenElement) {
      await el.requestFullscreen();
      if (btn) btn.textContent = '⤢';
    } else {
      await document.exitFullscreen();
      if (btn) btn.textContent = '';
    }
  } catch (e) {
    // ignore
  }
}

function _maintSetLiveNavState() {
  const prev = document.getElementById('maint-live-prev');
  const next = document.getElementById('maint-live-next');
  const n = (__getMaintRenderedList() || []).length;
  if (prev) prev.disabled = !(n > 1 && __maintLiveIndex > 0);
  if (next) next.disabled = !(n > 1 && __maintLiveIndex >= 0 && __maintLiveIndex < n - 1);
}

function _maintLiveGotoIndex(newIndex) {
  const list = (__getMaintRenderedList() || []);
  if (!list.length) return;
  const idx = Math.max(0, Math.min(list.length - 1, newIndex));
  const cam = list[idx];
  if (!cam || !cam.ip) return;
  __maintLiveIndex = idx;
  openMaintLiveModal(cam, idx);
}

function maintLivePrev() {
  if (__maintLiveIndex <= 0) return;
  _maintLiveGotoIndex(__maintLiveIndex - 1);
}

function maintLiveNext() {
  const n = (__getMaintRenderedList() || []).length;
  if (n <= 0) return;
  if (__maintLiveIndex < 0) return _maintLiveGotoIndex(0);
  if (__maintLiveIndex >= n - 1) return;
  _maintLiveGotoIndex(__maintLiveIndex + 1);
}

function maintSelectedArray() {
  try { return Array.from(__maintSelected.values()); } catch (_) { return []; }
}

function updateMaintBatchBar() {
  const bar = byId('maint-batchbar');
  const count = byId('maint-selected-count');
  const modalSel = byId('maint-modal-selected');
  const inlineSel = byId('maintenance-selected-inline');
  const openBatchBtn = byId('maintenance-open-batch');
  const n = __maintSelected ? __maintSelected.size : 0;
  if (count) count.textContent = String(n);
  if (modalSel) modalSel.textContent = String(n) + ' selecionadas';
  if (inlineSel) inlineSel.textContent = String(n);
  if (openBatchBtn) openBatchBtn.disabled = (n <= 0);
  if (bar) bar.style.display = (n > 0) ? 'grid' : 'none';
  try { if (typeof window.__maintenance_update_guide === 'function') window.__maintenance_update_guide(); } catch (_) {}
}

function clearMaintSelection() {
  try { __maintSelected.clear(); } catch (_) { __maintSelected = new Set(); }
  updateMaintBatchBar();
  try { if (typeof window.__maintenance_render_from_cache === 'function') window.__maintenance_render_from_cache(); } catch (_) {}
}

function selectAllRenderedCams() {
  try {
    (__maintLastRendered || []).forEach(c => { if (c && c.ip) __maintSelected.add(c.ip); });
  } catch (_) {}
  updateMaintBatchBar();
  try { if (typeof window.__maintenance_render_from_cache === 'function') window.__maintenance_render_from_cache(); } catch (_) {}
}

function selectRenderedCamsByStatus(wantedStatus) {
  const status = safeTrim(wantedStatus || '').toLowerCase();
  if (!status) return;
  try {
    (__maintLastRendered || []).forEach(function (c) {
      if (!c || !c.ip) return;
      const st = safeTrim(c.status || '').toLowerCase();
      if (st === status) __maintSelected.add(c.ip);
    });
  } catch (_) {}
  updateMaintBatchBar();
  try { if (typeof window.__maintenance_render_from_cache === 'function') window.__maintenance_render_from_cache(); } catch (_) {}
}

function markMaintBatchBusy(ips, action) {
  try {
    (Array.isArray(ips) ? ips : []).forEach(function (ip) {
      const k = safeTrim(ip || '');
      if (k) __maintBusyByIp.set(k, safeTrim(action || 'run') || 'run');
    });
  } catch (_) {}
  try { if (typeof window.__maintenance_render_from_cache === 'function') window.__maintenance_render_from_cache(); } catch (_) {}
}

function clearMaintBatchBusy(ips) {
  try {
    (Array.isArray(ips) ? ips : []).forEach(function (ip) {
      const k = safeTrim(ip || '');
      if (k) __maintBusyByIp.delete(k);
    });
  } catch (_) {}
  try { if (typeof window.__maintenance_render_from_cache === 'function') window.__maintenance_render_from_cache(); } catch (_) {}
}

function applyMaintBatchResults(results) {
  try {
    __maintResultByIp.clear();
    (Array.isArray(results) ? results : []).forEach(function (r) {
      const ip = safeTrim((r && r.ip) ? r.ip : '');
      if (!ip) return;
      __maintResultByIp.set(ip, (r && r.ok) ? 'ok' : 'error');
    });
    if (__maintResultClearTimer) {
      clearTimeout(__maintResultClearTimer);
      __maintResultClearTimer = null;
    }
    __maintResultClearTimer = setTimeout(function () {
      try { __maintResultByIp.clear(); } catch (_) {}
      try { if (typeof window.__maintenance_render_from_cache === 'function') window.__maintenance_render_from_cache(); } catch (_) {}
    }, 9000);
  } catch (_) {}
  try { if (typeof window.__maintenance_render_from_cache === 'function') window.__maintenance_render_from_cache(); } catch (_) {}
}

function closeAllMaintenanceMenus(exceptEl) {
  try {
    const openMenus = document.querySelectorAll('.maint-menu.open');
    let keptOpen = false;
    openMenus.forEach(function (m) {
      if (exceptEl && m === exceptEl) {
        keptOpen = true;
        return;
      }
      m.classList.remove('open');
      try {
        const card = m.closest('.maint-card');
        const btn = card ? card.querySelector('.maint-kebab') : null;
        if (btn) btn.setAttribute('aria-expanded', 'false');
      } catch (_) {}
    });
    if (!keptOpen) __maintOpenMenuIp = '';
  } catch (_) {}
}

// =========================
// Live modal (RTSP  MJPEG)
// - abre dentro do cam-snapshot-web
// =========================
let __maintLiveReady = false;
let __maintLiveRunId = 0;
function ensureMaintLiveModal() {
  if (__maintLiveReady) return;
  const modal = byId('maint-live-modal');
  if (!modal) return;

  const btnClose = byId('maint-live-close');
  const img = byId('maint-live-img');

  function close() {
    try { if (__maintLiveSnapshotTimer) clearInterval(__maintLiveSnapshotTimer); } catch (_) {}
    __maintLiveSnapshotTimer = null;
    try {
      if (img) img.src = '';
    } catch (_) {}
    try { modal.style.display = 'none'; } catch (_) {}
    try { document.body.classList.remove('maint-live-open'); } catch (_) {}
    try { _maintResetLiveZoom(); } catch (_) {}
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (_) {}
  }

  if (btnClose) btnClose.addEventListener('click', function (e) { e.preventDefault(); close(); });

  // setinhas (click)
  const btnPrev = byId('maint-live-prev');
  const btnNext = byId('maint-live-next');
  if (btnPrev) btnPrev.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    maintLivePrev();
  });
  if (btnNext) btnNext.addEventListener('click', function (e) {
    e.preventDefault();
    e.stopPropagation();
    maintLiveNext();
  });

  // zoom / fullscreen
  const btnZoomOut = byId('maint-live-zoomout');
  const btnZoomIn = byId('maint-live-zoomin');
  const btnZoomReset = byId('maint-live-zoomreset');
  const btnFullscreen = byId('maint-live-fullscreen');
  const btnPtzToggle = byId('maint-live-ptz-toggle');
  const ptzUp = byId('maint-ptz-up');
  const ptzDown = byId('maint-ptz-down');
  const ptzLeft = byId('maint-ptz-left');
  const ptzRight = byId('maint-ptz-right');
  const ptzStop = byId('maint-ptz-stop');
  const ptzZoomIn = byId('maint-ptz-zoomin');
  const ptzZoomOut = byId('maint-ptz-zoomout');

  if (btnZoomOut) btnZoomOut.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    __maintLiveZoom = Math.max(__maintLiveZoomMin, __maintLiveZoom - __maintLiveZoomStep);
    _maintApplyLiveZoom();
  });
  if (btnZoomIn) btnZoomIn.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    __maintLiveZoom = Math.min(__maintLiveZoomMax, __maintLiveZoom + __maintLiveZoomStep);
    _maintApplyLiveZoom();
  });
  if (btnZoomReset) btnZoomReset.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    _maintResetLiveZoom();
  });
  if (btnFullscreen) btnFullscreen.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    _maintToggleLiveFullscreen();
  });
  if (btnPtzToggle) btnPtzToggle.addEventListener('click', function (e) {
    e.preventDefault(); e.stopPropagation();
    maintLiveSetPtzOpen(!__maintLivePtzOpen);
  });
  if (ptzUp) ptzUp.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); maintLivePtzMove('up'); });
  if (ptzDown) ptzDown.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); maintLivePtzMove('down'); });
  if (ptzLeft) ptzLeft.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); maintLivePtzMove('left'); });
  if (ptzRight) ptzRight.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); maintLivePtzMove('right'); });
  if (ptzStop) ptzStop.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); maintLivePtzMove('stop'); });
  if (ptzZoomIn) ptzZoomIn.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); maintLivePtzMove('zoomin'); });
  if (ptzZoomOut) ptzZoomOut.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); maintLivePtzMove('zoomout'); });

  document.addEventListener('fullscreenchange', function () {
    const b = byId('maint-live-fullscreen');
    if (!b) return;
    b.textContent = document.fullscreenElement ? '⤢' : '';
  });
  modal.addEventListener('click', function (e) {
    // clique no backdrop fecha; clique dentro do modal nao fecha
    if (e && e.target === modal) close();
  });
  document.addEventListener('keydown', function (e) {
    if (!modal || modal.style.display === 'none') return;
    if (e && e.key === 'Escape') return close();
    if (e && e.key === 'ArrowLeft') return maintLivePrev();
    if (e && e.key === 'ArrowRight') return maintLiveNext();
  });

  __maintLiveReady = true;
}

function openMaintLiveModal(cam, explicitIndex = null) {
  ensureMaintLiveModal();
  const modal = byId('maint-live-modal');
  const img = byId('maint-live-img');
  const title = byId('maint-live-title');
  const hint = byId('maint-live-hint');
  if (!modal || !img || !cam) return;
  const runId = ++__maintLiveRunId;
  try { if (__maintLiveSnapshotTimer) clearInterval(__maintLiveSnapshotTimer); } catch (_) {}
  __maintLiveSnapshotTimer = null;
  try {
    img.onload = null;
    img.onerror = null;
    img.removeAttribute('src');
    img.src = '';
  } catch (_) {}

  const ip = (cam.ip || '').toString().trim();
  if (!ip) return;
  const camSource = String((cam && cam.source) || '').toLowerCase();
  const isRecorderSource = camSource === 'nvr' || camSource === 'dvr';
  const cachedCreds = getMaintCameraCreds(ip);
  if (!isRecorderSource && !(cachedCreds.user && cachedCreds.pass)) {
    openMaintCredsModal({
      ip: ip,
      onSaved: function () {
        try { openMaintLiveModal(cam, explicitIndex); } catch (_) {}
      }
    });
    return;
  }

  // guarda índice para navegacao (setas)
  if (typeof explicitIndex === 'number' && Number.isFinite(explicitIndex)) {
    __maintLiveIndex = explicitIndex;
  } else {
    const list = (__getMaintRenderedList() || []);
    const camCh = Math.max(1, parseInt((cam && cam.channel) || 1, 10) || 1);
    let idx = list.findIndex(c => (
      c &&
      String(c.ip || '').trim() === ip &&
      Math.max(1, parseInt((c && c.channel) || 1, 10) || 1) === camCh
    ));
    if (idx < 0) {
      idx = list.findIndex(c => (c && String(c.ip || '').trim() === ip));
    }
    __maintLiveIndex = idx;
  }

  // credenciais vêm dos campos da própria aba Manutencao
  // manutencao.html usa ids maintenance-user / maintenance-pass
  // operacoes DVR usa dvr-user / dvr-pass
  const userEl = byId('maintenance-user') || byId('maint-user') || byId('dvr-user');
  const passEl = byId('maintenance-pass') || byId('maint-pass') || byId('dvr-pass');
  const topUser = userEl ? (userEl.value || '').trim() : '';
  const topPass = passEl ? (passEl.value || '') : '';
  const u = safeTrim(isRecorderSource ? (cachedCreds.user || topUser || '') : (cachedCreds.user || ''));
  const p = String(isRecorderSource ? (cachedCreds.pass || topPass || '') : (cachedCreds.pass || ''));
  try {
    if (u && p) setMaintCameraCreds(ip, u, p);
    localStorage.setItem('maint_live_user', topUser || u || '');
    localStorage.setItem('maint_live_pass', topPass || p || '');
  } catch (_) {}

  if (title) {
    const name = (cam.name || '').trim();
    title.textContent = name ? (name + '  ' + ip) : ('Live  ' + ip);
  }

  const camFab = safeTrim(cam.fab || (cam.raw && (cam.raw.fabricante || cam.raw.FABRICANTE || cam.raw.manufacturer)) || '').toLowerCase();
  const camModel = safeTrim(cam.model || (cam.raw && (cam.raw.modelo || cam.raw.MODELO || cam.raw.model)) || '').toLowerCase();
  const preferSdLive = isRecorderSource || /intelbras|dahua/.test(camFab) || /^vip-/.test(camModel);
  // NVR e varios Intelbras/Dahua/VIP ficam com live preta no stream principal; abre em SD por padrao.
  // Depois que o operador escolhe HD/SD no botao, respeitamos essa escolha.
  if (!__maintLiveQualityManual && preferSdLive && __maintLiveSubtype === 0) {
    __maintLiveSubtype = 1;
  }

  // botao HD/SD (subtype=0/1)
  const qbtn = byId('maint-live-quality');
  if (qbtn) {
    qbtn.textContent = (__maintLiveSubtype === 0) ? 'HD' : 'SD';
    qbtn.title = `Qualidade: ${qbtn.textContent} (clique para alternar)`;
    qbtn.onclick = (e) => {
      e.preventDefault();
      __maintLiveSubtype = (__maintLiveSubtype === 0) ? 1 : 0;
      __maintLiveQualityManual = true;
      // reabrir mantendo o mesmo card
      openMaintLiveModal(cam, __maintLiveIndex);
    };
  }

  // Importante: RTSP nao roda direto no browser, entao usamos /api/live/mjpeg
  // Para DVR, respeita o canal selecionado no card.
  const ch = Math.max(1, parseInt((cam && cam.channel) || 1, 10) || 1);
  const cameraIpFallback = String((cam && cam.camera_ip) || '').trim();
  const nvrIp = ip;
  const nvrCh = ch;
  const attempts = [];
  if (isRecorderSource) {
    // DVR/NVR: primeiro direto na camera IP quando existir, fallback para canal agregado no gravador.
    if (cameraIpFallback && cameraIpFallback !== nvrIp) {
      attempts.push({ ip: cameraIpFallback, ch: 1, label: 'direto na camera' });
    }
    attempts.push({ ip: nvrIp, ch: nvrCh, label: 'via NVR' });
  } else {
    attempts.push({ ip: nvrIp, ch: nvrCh, label: 'direto' });
  }
  let attemptIdx = 0;
  let currentIp = attempts[0].ip;
  let currentCh = attempts[0].ch;
  let loadedFrame = false;
  let attemptTimer = null;
  let snapshotFallbackOn = false;
  const rtspPort = Math.max(0, parseInt((cam && cam.rtsp_port) || (cam && cam.raw && cam.raw.rtsp_port) || 0, 10) || 0);
  const vendor = safeTrim((cam && cam.fab) || (cam && cam.raw && cam.raw.fabricante) || '');
  const model = safeTrim((cam && cam.model) || (cam && cam.raw && (cam.raw.modelo || cam.raw.model)) || '');
  let currentLiveSession = null;
  let url = '';
  const appendTs = function(rawUrl) {
    const base = String(rawUrl || '');
    return base + (base.indexOf('?') >= 0 ? '&' : '?') + '_ts=' + Date.now();
  };
  const createLiveSession = function(targetIp, targetCh) {
    return fetch('/api/live/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: targetIp,
        user: u,
        password: p,
        channel: targetCh,
        subtype: __maintLiveSubtype,
        rtsp_port: rtspPort || 554,
        vendor: vendor,
        model: model
      })
    })
      .then(function(resp) {
        return resp.json().catch(function(){ return {}; }).then(function(data){ return { resp: resp, data: data }; });
      })
      .then(function(o) {
        if (!o.resp.ok || !o.data || o.data.ok !== true || !o.data.mjpeg_url || !o.data.jpeg_url) {
          throw new Error((o.data && (o.data.detail || o.data.error || o.data.message)) || ('HTTP ' + o.resp.status));
        }
        return o.data;
      });
  };

  const clearAttemptTimer = function(){
    try { if (attemptTimer) clearTimeout(attemptTimer); } catch (_) {}
    attemptTimer = null;
  };
  const stopSnapshotFallback = function(){
    if (runId !== __maintLiveRunId) return;
    try { if (__maintLiveSnapshotTimer) clearInterval(__maintLiveSnapshotTimer); } catch (_) {}
    __maintLiveSnapshotTimer = null;
    snapshotFallbackOn = false;
  };
  const beginLiveAttempt = function(reason) {
    if (runId !== __maintLiveRunId) return;
    if (hint) {
      hint.textContent = reason || ('Conectando ao stream (' + attempts[attemptIdx].label + ')...');
      hint.classList.remove('bad');
    }
    createLiveSession(currentIp, currentCh)
      .then(function(session) {
        if (runId !== __maintLiveRunId) return;
        currentLiveSession = session;
        url = appendTs(session.mjpeg_url);
        loadedFrame = false;
        try { img.src = ''; } catch (_) {}
        img.src = url;
        __maintLiveCtx = { ip: currentIp, user: u, pass: p, channel: currentCh, ptzCapable: false };
        try { maintLiveDetectPtz(currentIp, u, p, currentCh); } catch (_) {}
        clearAttemptTimer();
        attemptTimer = setTimeout(function(){
          if (runId !== __maintLiveRunId) return;
          handleNoLiveFrame('Sem frame recebido. Alternando rota de stream...');
        }, 4500);
      })
      .catch(function(e) {
        if (runId !== __maintLiveRunId) return;
        if (hint) {
          hint.textContent = 'Falha ao criar sessao live: ' + (e && e.message ? e.message : e);
          hint.classList.add('bad');
        }
      });
  };
  const startSnapshotFallback = function(reason){
    if (runId !== __maintLiveRunId) return;
    stopSnapshotFallback();
    snapshotFallbackOn = true;
    loadedFrame = true;
    if (hint) {
        hint.textContent = reason || 'Live em tempo real indisponivel. Exibindo snapshots atualizados sem codec no computador.';
      hint.classList.add('bad');
    }
    const refreshStill = function(){
      if (runId !== __maintLiveRunId) return;
      try {
        if (!currentLiveSession || !currentLiveSession.jpeg_url) return;
        img.src = appendTs(currentLiveSession.jpeg_url);
      } catch (_) {}
    };
    refreshStill();
    __maintLiveSnapshotTimer = setInterval(refreshStill, 1000);
  };
  const tryNextAttempt = function(reason){
    if (runId !== __maintLiveRunId) return false;
    if ((attemptIdx + 1) >= attempts.length) return false;
    attemptIdx += 1;
    const nxt = attempts[attemptIdx];
    currentIp = nxt.ip;
    currentCh = nxt.ch;
    loadedFrame = false;
    currentLiveSession = null;
    if (hint) {
      hint.textContent = reason || ('Falha na tentativa anterior. Tentando ' + nxt.label + '...');
      hint.classList.add('bad');
    }
    clearAttemptTimer();
    beginLiveAttempt(reason || ('Tentando ' + nxt.label + '...'));
    return true;
  };
  const handleNoLiveFrame = function(reason){
    if (runId !== __maintLiveRunId) return;
    if (loadedFrame || snapshotFallbackOn) return;
    if (tryNextAttempt(reason || 'Sem frame recebido. Alternando rota de stream...')) return;
    startSnapshotFallback('Live em tempo real sem frames. Exibindo snapshot atualizado sem instalar codec no computador.');
  };

  if (hint) {
    hint.textContent = 'Conectando ao stream (' + attempts[0].label + ')...';
    hint.classList.remove('bad');
  }

  // PTZ inicia recolhido; usurio abre pelo boto PTZ na barra.
  maintLiveSetPtzOpen(false);
  img.onload = function () {
    try {
      if (runId !== __maintLiveRunId) return;
      loadedFrame = true;
      clearAttemptTimer();
      if (!snapshotFallbackOn) stopSnapshotFallback();
      if (!hint) return;
      hint.textContent = snapshotFallbackOn
        ? ('Snapshot ao vivo ativo (' + attempts[attemptIdx].label + ').')
        : ('Live conectada (' + attempts[attemptIdx].label + ').');
      if (!snapshotFallbackOn) hint.classList.remove('bad');
    } catch (_) {}
  };
  img.onerror = function () {
    try {
      if (runId !== __maintLiveRunId) return;
      clearAttemptTimer();
      if (tryNextAttempt('Falha ao abrir stream. Tentando rota alternativa...')) return;
      if (hint) {
        hint.textContent = 'Falha ao abrir live. Verificando detalhe...';
        hint.classList.add('bad');
      }
      const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      const t = setTimeout(function () { try { controller && controller.abort(); } catch (_) {} }, 6000);
      fetch(url, controller ? { signal: controller.signal } : undefined)
        .then(function (r) {
          if (runId !== __maintLiveRunId) return;
          clearTimeout(t);
          const ct = (r.headers.get('content-type') || '').toLowerCase();
          if (ct.includes('application/json')) {
            return r.json().then(function (j) {
              const detail = j && (j.detail || j.error || j.message) ? String(j.detail || j.error || j.message) : ('HTTP ' + r.status);
              startSnapshotFallback('Live em tempo real indisponivel. Usando snapshot atualizado. ' + detail);
            }).catch(function () {
              startSnapshotFallback('Live em tempo real indisponivel. Usando snapshot atualizado.');
            });
          }
          startSnapshotFallback('Live em tempo real indisponivel. Usando snapshot atualizado.');
        })
        .catch(function (e) {
          if (runId !== __maintLiveRunId) return;
          const msg = (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || ''))))
            ? 'Live RTSP sem frames. Usando snapshot atualizado.'
            : ('Falha na live. Usando snapshot atualizado. ' + (e && e.message ? e.message : 'erro de rede'));
          startSnapshotFallback(msg);
        });
    } catch (_) {}
  };
  try { img.src = ''; } catch (_) {}
  clearAttemptTimer();
  beginLiveAttempt('Conectando ao stream (' + attempts[0].label + ')...');

  _maintSetLiveNavState();

  modal.style.display = 'flex';
  try { document.body.classList.add('maint-live-open'); } catch (_) {}
  try { _maintResetLiveZoom(); } catch (_) {}
}

function maintLivePrev() {
  const i = (__maintLiveIndex ?? -1) - 1;
  _maintLiveGotoIndex(i);
}

function maintLivePtzSetEnabled(enabled) {
  const ids = ['maint-ptz-up', 'maint-ptz-down', 'maint-ptz-left', 'maint-ptz-right', 'maint-ptz-stop', 'maint-ptz-zoomin', 'maint-ptz-zoomout', 'maint-ptz-speed'];
  ids.forEach(function (id) {
    const el = byId(id);
    if (el) el.disabled = !enabled;
  });
}

function maintLivePtzSetStatus(text, capable) {
  const wrap = byId('maint-live-ptz');
  const st = byId('maint-live-ptz-status');
  if (wrap) wrap.style.display = 'block';
  if (st) st.textContent = text || '';
  __maintLiveCtx.ptzCapable = !!capable;
  maintLivePtzSetEnabled(!!capable);
}

function maintLiveSetPtzOpen(open) {
  __maintLivePtzOpen = !!open;
  const wrap = byId('maint-live-ptz');
  const btn = byId('maint-live-ptz-toggle');
  if (wrap) wrap.classList.toggle('is-collapsed', !__maintLivePtzOpen);
  if (btn) btn.classList.toggle('is-active', __maintLivePtzOpen);
}

async function maintLiveDetectPtz(ip, user, pass, channel) {
  if (!ip || !user || !pass) {
    maintLivePtzSetStatus('Informe usuario/senha para PTZ.', false);
    return;
  }
  maintLivePtzSetStatus('Detectando...', false);
  try {
    const r = await fetch('/api/cameras/ptz_capability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: ip, user: user, password: pass, channel: channel || 1 })
    });
    const j = await r.json().catch(function () { return {}; });
    if (j && j.ok && j.capable) {
      maintLivePtzSetStatus('PTZ disponivel (' + (j.brand || 'auto') + ').', true);
    } else if (j && j.ok) {
      maintLivePtzSetStatus('Esta camera nao respondeu como PTZ.', false);
    } else {
      maintLivePtzSetStatus('Falha ao detectar PTZ.', false);
    }
  } catch (_) {
    maintLivePtzSetStatus('Falha ao detectar PTZ.', false);
  }
}

async function maintLivePtzMove(direction) {
  if (!__maintLiveCtx || !__maintLiveCtx.ip) return;
  const ip = __maintLiveCtx.ip;
  const user = __maintLiveCtx.user || '';
  const pass = __maintLiveCtx.pass || '';
  const channel = __maintLiveCtx.channel || 1;
  const speed = parseInt(byId('maint-ptz-speed')?.value || '4', 10);
  if (!user || !pass) {
    maintLivePtzSetStatus('Informe usuario/senha para PTZ.', false);
    return;
  }
  try {
    const body = {
      ip: ip,
      user: user,
      password: pass,
      direction: direction,
      channel: channel,
      speed: (isFinite(speed) ? speed : 4),
      duration_ms: 300
    };
    const r = await fetch('/api/cameras/ptz_move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await r.json().catch(function () { return {}; });
    if (j && j.ok) {
      maintLivePtzSetStatus('PTZ: ' + direction + ' (' + (j.brand || 'ok') + ')', true);
    } else {
      maintLivePtzSetStatus('PTZ falhou: ' + (j && (j.error || j.message) ? (j.error || j.message) : 'erro'), false);
    }
  } catch (e) {
    maintLivePtzSetStatus('PTZ falhou: ' + (e && e.message ? e.message : 'erro'), false);
  }
}

function maintLiveNext() {
  const i = (__maintLiveIndex ?? -1) + 1;
  _maintLiveGotoIndex(i);
}

const MAINT_PING_FRESH_MS = 5 * 60 * 1000;
function maintPingIsFresh(pc) {
  const ts = pc && Number(pc.ts || 0);
  return !!ts && (Date.now() - ts) <= MAINT_PING_FRESH_MS;
}
function maintCamHasVisualEvidence(cam) {
  if (!cam) return false;
  return !!safeTrim(
    cam.snapshot_url || cam.thumb_url || cam.imgbb_url || cam.snapshot_path ||
    cam.snapshotUrl || cam.snapshotPath ||
    (cam.raw && (cam.raw.snapshot_url || cam.raw.thumb_url || cam.raw.imgbb_url || cam.raw.snapshot_path)) ||
    ''
  );
}

function renderMaintenanceGrid(inv, opts) {
  opts = opts || {};
  const grid = byId('maintenance-grid');
  const empty = byId('maintenance-empty');
  const countEl = byId('maintenance-count');
  const visibleEl = byId('maintenance-visible-count');
  if (!grid) return;

  const q = safeTrim(opts.query || '').toLowerCase();
  const mode = safeTrim(opts.mode || 'all');

  // Status na Manutencao e 100% baseado em ping.
  // pingCache: ip -> { online: bool, rtt_ms: number|null, ts: ms }
  const pingCache = opts.pingCache || {};

  function fmtAge(ts) {
    if (!ts) return '';
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m + 'm' + (r ? (' ' + r + 's') : '');
  }

  let cams = (Array.isArray(inv) ? inv : []).map(normalizeCamForUI);

  // Status: ping fresco tem prioridade; ping velho offline nao derruba camera com imagem.
  cams = cams.map(function (c) {
    const pc = c && c.ip ? pingCache[c.ip] : null;
    if (pc && typeof pc.online === 'boolean' && maintPingIsFresh(pc)) {
      c.status = pc.online ? 'online' : 'offline';
      c.__rtt_ms = (pc.rtt_ms ?? null);
      c.__ping_ts = (pc.ts ?? null);
    } else if (maintCamHasVisualEvidence(c)) {
      c.status = 'online';
      c.__rtt_ms = null;
      c.__ping_ts = null;
    } else {
      c.status = 'offline';
      c.__rtt_ms = null;
      c.__ping_ts = null;
    }
    return c;
  });

  // filtra por modo
  if (mode === 'online') {
    cams = cams.filter(c => c.status === 'online');
  } else if (mode === 'offline') {
    cams = cams.filter(c => c.status === 'offline');
  }

  // busca
  if (q) {
    cams = cams.filter(c => {
      return (
        (c.ip || '').toLowerCase().includes(q) ||
        (c.title || '').toLowerCase().includes(q) ||
        (c.model || '').toLowerCase().includes(q) ||
        (c.fab || '').toLowerCase().includes(q) ||
        (c.mac || '').toLowerCase().includes(q) ||
        (c.pon || '').toLowerCase().includes(q) ||
        (c.onuId || '').toLowerCase().includes(q) ||
        (c.onuName || '').toLowerCase().includes(q) ||
        (c.onuSerial || '').toLowerCase().includes(q)
      );
    });
  }

  cams.sort((a, b) => ipToNum(a.ip || '') - ipToNum(b.ip || ''));

  grid.innerHTML = '';

  if (countEl) countEl.textContent = String(cams.length);
  if (visibleEl) visibleEl.textContent = String(cams.length);

  if (!cams.length) {
    try { __maintLastRendered = []; } catch (_) {}
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  // guarda a lista (ja filtrada) para "selecionar tudo"
  try { __maintLastRendered = cams.slice(0); } catch (_) { __maintLastRendered = cams || []; }

  // atualiza barra lote (caso selecões tenham sido limpadas/alteradas)
  updateMaintBatchBar();

  cams.forEach((c, idx) => {
    const card = document.createElement('div');
    card.className = 'maint-card';
    card.dataset.ip = c.ip || '';
    const busyAction = (c.ip && __maintBusyByIp.has(c.ip)) ? (__maintBusyByIp.get(c.ip) || 'run') : '';
    const isBusy = !!busyAction;
    const resState = c.ip ? (__maintResultByIp.get(c.ip) || '') : '';
    if (isBusy) card.classList.add('is-busy');
    if (resState === 'ok') card.classList.add('is-ok-flash');
    if (resState === 'error') card.classList.add('is-error-flash');

    const imgWrap = document.createElement('div');
    imgWrap.className = 'maint-img';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = 'Snapshot ' + (c.ip || '');
    if (c.img) img.src = c.img;
    imgWrap.appendChild(img);

    // Checkbox de selecao (lote)
    const sel = document.createElement('input');
    sel.type = 'checkbox';
    sel.className = 'maint-select';
    sel.title = 'Selecionar'
    sel.disabled = isBusy;
    sel.checked = !!(__maintSelected && c.ip && __maintSelected.has(c.ip));
    sel.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });
    sel.addEventListener('change', function (ev) {
      ev.stopPropagation();
      if (!c.ip) return;
      if (sel.checked) __maintSelected.add(c.ip);
      else __maintSelected.delete(c.ip);
      updateMaintBatchBar();
    });
    imgWrap.appendChild(sel);
    if (isBusy) {
      const busyChip = document.createElement('div');
      busyChip.className = 'maint-busy-chip';
      busyChip.textContent = 'EXECUTANDO ' + String(busyAction || 'acao').toUpperCase();
      imgWrap.appendChild(busyChip);
    }

    // Botao  (acões) no canto superior direito do snapshot
    const kebab = document.createElement('button');
    kebab.type = 'button';
    kebab.className = 'maint-kebab';
    kebab.title = 'Acoes';
    kebab.setAttribute('aria-label', 'Abrir menu de acoes');
    kebab.setAttribute('aria-expanded', 'false');
    kebab.textContent = '⋯';

    const menu = document.createElement('div');
    menu.className = 'maint-menu';
    menu.dataset.ip = c.ip || '';
    menu.addEventListener('mousedown', function (ev) {
      ev.stopPropagation();
    });
    menu.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });

    const miCreds = document.createElement('button');
    miCreds.type = 'button';
    miCreds.className = 'menu-item';
    miCreds.textContent = 'Credenciais';
    miCreds.disabled = !c.ip;
    miCreds.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!c.ip) return;
      openMaintCredsModal({
        ip: c.ip,
        onSaved: function (creds) {
          try {
            if (c && c.ip && creds && creds.user && creds.pass) setMaintCameraCreds(c.ip, creds.user, creds.pass);
          } catch (_) {}
        }
      });
      try { menu.classList.remove('open'); __maintOpenMenuIp = ''; } catch (_) {}
    });

    // Live (abre interface web da camera)
    const miLive = document.createElement('button');
    miLive.type = 'button';
    miLive.className = 'menu-item';
    miLive.textContent = 'Live (RTSP)';
    miLive.disabled = !c.ip;
    miLive.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!c.ip) return;
      try { openMaintLiveModal(c, idx); } catch (_) {}
      try { menu.classList.remove('open'); __maintOpenMenuIp = ''; } catch (_) {}
    });

    // Editar nome (deixamos preparado, mas desativado por enquanto)
    const miEdit = document.createElement('button');
    miEdit.type = 'button';
    miEdit.className = 'menu-item';
    miEdit.textContent = 'Editar nome';
    miEdit.disabled = !c.ip;

    // Trocar IP
    const miIp = document.createElement('button');
    miIp.type = 'button';
    miIp.className = 'menu-item';
    miIp.textContent = 'Trocar IP';
    miIp.disabled = !c.ip;

    // Reiniciar
    const miReboot = document.createElement('button');
    miReboot.type = 'button';
    miReboot.className = 'menu-item danger';
    miReboot.dataset.ip = c.ip || '';
    const remMenu = getRebootRemainingSeconds(c.ip);
    miReboot.textContent = remMenu > 0 ? ('Reiniciar (reiniciando ' + remMenu + 's)') : 'Reiniciar';
    miReboot.disabled = remMenu > 0;

    menu.appendChild(miCreds);
    menu.appendChild(miLive);

    // Ver no mapa (Google Earth Desktop)  baixa um KML e o Earth "voa" pro ponto
    const miMap = document.createElement('button');
    miMap.type = 'button';
    miMap.className = 'menu-item';
    miMap.textContent = 'Ver no mapa (Google Earth)';
    const hasGeo = !!(c && c.raw && (c.raw.lat != null) && (c.raw.lon != null) && c.ip);
    miMap.disabled = !hasGeo;
    miMap.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!c.ip) return;
      const url = '/api/geo/camera.kml?ip=' + encodeURIComponent(c.ip);
      try { window.open(url, '_blank'); } catch (_) {}
      try { menu.classList.remove('open'); __maintOpenMenuIp = ''; } catch (_) {}
    });

    menu.appendChild(miMap);
    menu.appendChild(miEdit);
    menu.appendChild(miIp);
    menu.appendChild(miReboot);
    imgWrap.appendChild(kebab);
    imgWrap.appendChild(menu);

    const meta = document.createElement('div');
    meta.className = 'maint-meta';

    const top = document.createElement('div');
    top.className = 'maint-top';

    const t = document.createElement('div');
    t.className = 'maint-title';
    t.textContent = c.title || 'Camera';

    const pill = document.createElement('div');
    const rem = getRebootRemainingSeconds(c.ip);
    pill.dataset.ip = c.ip || '';
    if (rem > 0) {
      pill.className = 'maint-pill warn';
      pill.textContent = 'REINICIANDO';
    } else {
      pill.className = 'maint-pill ' + (c.status === 'online' ? 'ok' : (c.status === 'offline' ? 'bad' : ''));
      pill.textContent = (c.status === 'online') ? 'ONLINE' : (c.status === 'offline' ? 'OFFLINE' : (c.status ? c.status.toUpperCase() : ''));
    }

    top.appendChild(t);
    top.appendChild(pill);

    const sub = document.createElement('div');
    sub.className = 'maint-sub';
    const parts = [];
    if (c.ip) parts.push('IP: ' + c.ip);
    if (c.model) parts.push(c.model);
    if (c.fab) parts.push(c.fab);
    if (c.mac) parts.push('MAC: ' + c.mac);
    sub.textContent = parts.join('  -  ');

    const oltLine = document.createElement('div');
    oltLine.className = 'maint-sub muted';
    const oltParts = [];
    if (c.pon) oltParts.push('PON: ' + c.pon);
    if (c.onuId) oltParts.push('Posicao: ' + c.onuId);
    if (c.onuName) oltParts.push('ONU: ' + c.onuName);
    if (c.onuSerial) oltParts.push('Serial: ' + c.onuSerial);
    oltLine.textContent = oltParts.join('  -  ');
    oltLine.style.display = oltParts.length ? 'block' : 'none';

    // Linha de ping (RTT + idade)
    const pingLine = document.createElement('div');
    pingLine.className = 'maint-sub muted';
    pingLine.dataset.ip = c.ip || '';
    if (c.__ping_ts) {
      const rtt = (typeof c.__rtt_ms === 'number') ? (c.__rtt_ms + 'ms') : '';
      pingLine.textContent = 'Ping: ' + rtt + '  -  ha ' + fmtAge(c.__ping_ts);
    } else {
      pingLine.textContent = 'Ping: ';
    }

    // Acoes ficam no menu  (card fica mais limpo)


    // Handler: trocar IP (Manutencao)
    miIp.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!c.ip) return;

      const userEl = byId('maintenance-user');
      const passEl = byId('maintenance-pass');
      const user = safeTrim(userEl ? userEl.value : '');
      const pass = safeTrim(passEl ? passEl.value : '');

      if (!user || !pass) {
        alert('Informe Usuario e Senha no topo da aba Manutencao.');
        return;
      }

      openChangeIpModal({
        ip: c.ip,
        user: user,
        pass: pass,
        onSaved: function (newIp) {
          // Atualiza o cache do inventario
          try {
            const inv0 = getCachedInventory();
            const inv1 = (Array.isArray(inv0) ? inv0 : []).map(function (row) {
              const ip0 = (row && (row.ip || row.IP) ? String(row.ip || row.IP).trim() : '');
              if (ip0 && ip0 === c.ip) {
                if (row.ip != null) row.ip = newIp;
                else if (row.IP != null) row.IP = newIp;
                else row.ip = newIp;
              }
              return row;
            });
            setCachedInventory(inv1);
          } catch (_) {}

          // UI imediata
          try {
            c.ip = newIp;
            sub.textContent = (function () {
              const parts = [];
              if (c.ip) parts.push('IP: ' + c.ip);
              if (c.model) parts.push(c.model);
              if (c.fab) parts.push(c.fab);
              if (c.mac) parts.push('MAC: ' + c.mac);
              return parts.join('  -  ');
            })();
          } catch (_) {}

          // Re-render
          try { if (typeof window.__maintenance_render_from_cache === 'function') window.__maintenance_render_from_cache(); } catch (_) {}
        },
        user: user,
        pass: pass
      });

      try { menu.classList.remove('open'); __maintOpenMenuIp = ''; } catch (_) {}
    });

    // Handler de reboot (pelo menu )
    miReboot.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();

      const userEl = byId('maintenance-user');
      const passEl = byId('maintenance-pass');
      const user = safeTrim(userEl ? userEl.value : '');
      const pass = safeTrim(passEl ? passEl.value : '');

      if (!c.ip) {
        alert('IP da camera nao encontrado.');
        return;
      }
      if (!user || !pass) {
        alert('Informe Usuario e Senha no topo da aba Manutencao.');
        return;
      }

      const msg = `Reiniciar a camera ${c.title || ''} (${c.ip})?\nEla pode ficar offline por ~1 minuto.`;
      if (!confirm(msg)) return;

      // feedback visual imediato
      markRebooting(c.ip, 90);
      miReboot.disabled = true;
      miReboot.textContent = 'Reiniciar (reiniciando 90s)';
      pill.className = 'maint-pill warn';
      pill.textContent = 'REINICIANDO';

      rebootCameraByIp(c.ip, user, pass)
        .then(function (res) {
          if (res && res.ok) {
            alert('Comando de reboot enviado para ' + c.ip);
          } else {
            alert('Falha ao enviar reboot: ' + (res && (res.error || res.message) ? (res.error || res.message) : 'erro desconhecido'));
            clearRebooting(c.ip);
            miReboot.disabled = false;
            miReboot.textContent = 'Reiniciar';
            pill.className = 'maint-pill ' + (c.status === 'online' ? 'ok' : (c.status === 'offline' ? 'bad' : ''));
            pill.textContent = (c.status === 'online') ? 'ONLINE' : (c.status === 'offline' ? 'OFFLINE' : (c.status ? c.status.toUpperCase() : ''));
          }
        })
        .catch(function (e) {
          alert('Falha ao enviar reboot: ' + (e && e.message ? e.message : String(e)));
          clearRebooting(c.ip);
          miReboot.disabled = false;
          miReboot.textContent = 'Reiniciar';
          pill.className = 'maint-pill ' + (c.status === 'online' ? 'ok' : (c.status === 'offline' ? 'bad' : ''));
          pill.textContent = (c.status === 'online') ? 'ONLINE' : (c.status === 'offline' ? 'OFFLINE' : (c.status ? c.status.toUpperCase() : ''));
        })
        .finally(function () {
          // nao libera aqui; a UI e dirigida pelo countdown + ping monitor em loadMaintenance()
        });

      // fecha menu após acionar
      try { menu.classList.remove('open'); __maintOpenMenuIp = ''; } catch (_) {}
    });

    // Handler: editar nome (Manutencao)
    miEdit.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      if (!c.ip) return;

      openRenameCameraModal({
        ip: c.ip,
        currentTitle: (c.title || ''),
        user: user,
        pass: pass,
        onSaved: function (newTitle) {
          // Atualiza UI imediata
          try { t.textContent = newTitle; } catch (_) {}

          // Atualiza cache do inventario (fonte para Inventory/Snapshot/Manutencao)
          try {
            const inv0 = getCachedInventory();
            const inv1 = (Array.isArray(inv0) ? inv0 : []).map(function (row) {
              const ip = (row && (row.ip || row.IP) ? String(row.ip || row.IP).trim() : '');
              if (ip && ip === c.ip) {
                if (row.titulo != null) row.titulo = newTitle;
                else if (row.nome != null) row.nome = newTitle;
                else row.titulo = newTitle;
              }
              return row;
            });
            setCachedInventory(inv1);
          } catch (_) {}

          // Re-render para refletir busca/filtros
          try {
            if (typeof window.__maintenance_render_from_cache === 'function') {
              window.__maintenance_render_from_cache();
            }
          } catch (_) {}
        }
      });

      try { menu.classList.remove('open'); } catch (_) {}
    });

    kebab.addEventListener('mousedown', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
    });
    // Toggle do menu
    kebab.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      try {
        const isOpen = menu.classList.contains('open');
        closeAllMaintenanceMenus(null);
        if (isOpen) {
          menu.classList.remove('open');
          kebab.setAttribute('aria-expanded', 'false');
          __maintOpenMenuIp = '';
        } else {
          menu.classList.add('open');
          kebab.setAttribute('aria-expanded', 'true');
          __maintOpenMenuIp = safeTrim(c.ip || '');
        }
      } catch (_) {}
    });
    if (safeTrim(c.ip || '') && safeTrim(c.ip || '') === safeTrim(__maintOpenMenuIp)) {
      menu.classList.add('open');
      kebab.setAttribute('aria-expanded', 'true');
    }

    meta.appendChild(top);
    meta.appendChild(sub);
    meta.appendChild(oltLine);
    meta.appendChild(pingLine);

    card.appendChild(imgWrap);
    card.appendChild(meta);

    // Clique no card abre Live (RTSP) dentro do cam-snapshot-web.
    // Obs: nao dispara ao clicar em checkbox//menu.
    card.addEventListener('click', function (ev) {
      try {
        if (ev.target && ev.target.closest) {
          if (ev.target.closest('.maint-select')) return;
          if (ev.target.closest('.maint-kebab')) return;
          if (ev.target.closest('.maint-menu')) return;
        }
      } catch (_) {}
      if (!c || !c.ip) return;
      try { openMaintLiveModal(c); } catch (_) {}
    });

    grid.appendChild(card);
  });
}

// =========================
// Modal: Renomear camera (Manutencao)
// - cria 1 vez e reutiliza
// =========================
let __renameModalReady = false;
function ensureRenameModal() {
  if (__renameModalReady) return;
  __renameModalReady = true;

  const backdrop = document.createElement('div');
  backdrop.id = 'rename-modal-backdrop';
  backdrop.className = 'inv-modal-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.innerHTML = '' +
    '<div class="inv-modal" style="width:min(560px,96vw); height:auto; max-height:80vh;">' +
      '<div class="inv-modal-header">' +
        '<div style="font-weight:700;">Renomear camera</div>' +
        '<button class="btn-ghost" id="btn-rename-close" type="button">Fechar</button>' +
      '</div>' +
      '<div class="inv-modal-body">' +
        '<div class="muted" id="rename-modal-sub" style="font-size:13px; margin-bottom:10px;"></div>' +
        '<div class="field">' +
          '<label for="rename-new-title">Novo nome</label>' +
          '<input id="rename-new-title" type="text" placeholder="CAM-PORTARIA-01" />' +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="rename-user">Usuario</label>' +
            '<input id="rename-user" type="text" placeholder="admin" autocomplete="username" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="rename-pass">Senha</label>' +
            '<input id="rename-pass" type="password" placeholder="Informe a senha" autocomplete="current-password" />' +
          '</div>' +
        '</div>' +
        '<div class="muted" style="font-size:12px; margin-top:6px;">Credenciais opcionais para aplicar o nome diretamente na camera.</div>' +
        '<div class="actions-row" style="justify-content:flex-end; margin-top:14px;">' +
          '<button class="btn-secondary" id="btn-rename-cancel" type="button">Cancelar</button>' +
          '<button class="btn-primary" id="btn-rename-confirm" type="button">Salvar</button>' +
        '</div>' +
        '<div class="muted" id="rename-modal-msg" style="font-size:12px; margin-top:10px; display:none;"></div>' +
      '</div>' +
    '</div>';

  document.body.appendChild(backdrop);

  // fechar clicando fora
  backdrop.addEventListener('click', function (ev) {
    if (ev && ev.target === backdrop) backdrop.classList.remove('open');
  });

  const btnClose = backdrop.querySelector('#btn-rename-close');
  const btnCancel = backdrop.querySelector('#btn-rename-cancel');
  if (btnClose) btnClose.addEventListener('click', function () { backdrop.classList.remove('open'); });
  if (btnCancel) btnCancel.addEventListener('click', function () { backdrop.classList.remove('open'); });
}

function openRenameCameraModal(opts) {
  opts = opts || {};
  const ip = safeTrim(opts.ip || '');
  const cur = safeTrim(opts.currentTitle || '');
  const cachedCreds = getMaintCameraCreds(ip);
  const defaultUser = safeTrim(opts.user || cachedCreds.user || '');
  const defaultPass = opts.pass != null ? String(opts.pass) : String(cachedCreds.pass || '');
  const onSaved = (typeof opts.onSaved === 'function') ? opts.onSaved : function () {};
  if (!ip) return;

  ensureRenameModal();
  const backdrop = byId('rename-modal-backdrop');
  const sub = byId('rename-modal-sub');
  const input = byId('rename-new-title');
  const userInput = byId('rename-user');
  const passInput = byId('rename-pass');
  const msg = byId('rename-modal-msg');
  const btnConfirm = byId('btn-rename-confirm');
  if (!backdrop || !input || !btnConfirm) {
    // fallback
    const val = prompt('Novo nome para ' + ip + ':', cur || ('CAM ' + ip));
    if (val == null) return;
    const v = safeTrim(val);
    if (!v) return;
    renameCameraByIp(ip, v, defaultUser, defaultPass).then(function (r) {
      if (r && r.ok) onSaved(v);
      else alert('Falha ao renomear: ' + (r && (r.error || r.message) ? (r.error || r.message) : 'erro desconhecido'));
    }).catch(function (e) {
      alert('Falha ao renomear: ' + (e && e.message ? e.message : String(e)));
    });
    return;
  }

  if (sub) sub.textContent = (cur ? ('Atual: ' + cur + '  -  ') : '') + 'IP: ' + ip;
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }

  input.value = cur || ('CAM ' + ip);
  if (userInput) userInput.value = defaultUser || safeTrim(invSafeId('user')?.value || byId('maintenance-user')?.value || '');
  if (passInput) passInput.value = defaultPass || String(invSafeId('pass')?.value || byId('maintenance-pass')?.value || '');
  backdrop.classList.add('open');
  try { setTimeout(function () { input.focus(); input.select(); }, 60); } catch (_) {}

  // evita multiplos binds
  btnConfirm.onclick = null;
  btnConfirm.onclick = function () {
    const v = safeTrim(input.value || '');
    const renameUser = safeTrim(userInput && userInput.value ? userInput.value : '');
    const renamePass = safeTrim(passInput && passInput.value ? passInput.value : '');
    if (!v) {
      if (msg) { msg.style.display = 'block'; msg.textContent = 'Informe um nome.'; }
      return;
    }
    btnConfirm.disabled = true;
    if (msg) { msg.style.display = 'block'; msg.textContent = 'Salvando...'; }

    renameCameraByIp(ip, v, renameUser, renamePass)
      .then(function (r) {
        if (r && r.ok) {
          setMaintCameraCreds(ip, renameUser, renamePass);
          if (msg) msg.textContent = ' Nome atualizado.';
          backdrop.classList.remove('open');
          onSaved(v);
        } else {
          if (msg) msg.textContent = ' Falha: ' + (r && (r.error || r.message) ? (r.error || r.message) : 'erro desconhecido');
        }
      })
      .catch(function (e) {
        if (msg) msg.textContent = ' Falha: ' + (e && e.message ? e.message : String(e));
      })
      .finally(function () {
        btnConfirm.disabled = false;
      });
  };
}


// =========================
// Modal: Trocar senha (Inventario/Manutencao)
// =========================
let __passModalReady = false;
function ensureChangePasswordModal() {
  if (__passModalReady) return;
  __passModalReady = true;

  const backdrop = document.createElement('div');
  backdrop.id = 'pass-modal-backdrop';
  backdrop.className = 'inv-modal-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.innerHTML = '' +
    '<div class="inv-modal" style="width:min(620px,96vw); height:auto; max-height:84vh;">' +
      '<div class="inv-modal-header">' +
        '<div style="font-weight:700;">Trocar senha da camera</div>' +
        '<button class="btn-ghost" id="btn-pass-close" type="button">Fechar</button>' +
      '</div>' +
      '<div class="inv-modal-body">' +
        '<div class="muted" id="pass-modal-sub" style="font-size:13px; margin-bottom:10px;"></div>' +
        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="pass-user">Usuario</label>' +
            '<input id="pass-user" type="text" placeholder="admin" autocomplete="username" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="pass-old-pass">Senha atual</label>' +
            '<input id="pass-old-pass" type="password" placeholder="Informe a senha atual" autocomplete="current-password" />' +
          '</div>' +
        '</div>' +
        '<div class="field">' +
          '<label for="pass-new-pass">Nova senha</label>' +
          '<input id="pass-new-pass" type="password" placeholder="Informe a nova senha" autocomplete="new-password" />' +
        '</div>' +
        '<div class="actions-row" style="justify-content:flex-end; margin-top:14px;">' +
          '<button class="btn-secondary" id="btn-pass-cancel" type="button">Cancelar</button>' +
          '<button class="btn-primary" id="btn-pass-confirm" type="button">Aplicar</button>' +
        '</div>' +
        '<pre id="pass-modal-msg" class="log-box" style="margin-top:10px; display:none; max-height:220px;"></pre>' +
      '</div>' +
    '</div>';

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', function (ev) {
    if (ev && ev.target === backdrop) backdrop.classList.remove('open');
  });
  const btnClose = backdrop.querySelector('#btn-pass-close');
  const btnCancel = backdrop.querySelector('#btn-pass-cancel');
  if (btnClose) btnClose.addEventListener('click', function () { backdrop.classList.remove('open'); });
  if (btnCancel) btnCancel.addEventListener('click', function () { backdrop.classList.remove('open'); });
}

function openChangePasswordModal(opts) {
  opts = opts || {};
  const ip = safeTrim(opts.ip || '');
  const cachedCreds = getMaintCameraCreds(ip);
  const defaultUser = safeTrim(opts.user || cachedCreds.user || '');
  const defaultPass = opts.pass != null ? String(opts.pass) : String(cachedCreds.pass || '');
  const onSaved = (typeof opts.onSaved === 'function') ? opts.onSaved : function () {};
  if (!ip) return;

  ensureChangePasswordModal();
  const backdrop = byId('pass-modal-backdrop');
  const sub = byId('pass-modal-sub');
  const userInput = byId('pass-user');
  const oldPassInput = byId('pass-old-pass');
  const newPassInput = byId('pass-new-pass');
  const msg = byId('pass-modal-msg');
  const btnConfirm = byId('btn-pass-confirm');
  if (!backdrop || !userInput || !oldPassInput || !newPassInput || !btnConfirm) return;

  if (sub) sub.textContent = 'IP: ' + ip;
  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  userInput.value = defaultUser || safeTrim(invSafeId('user')?.value || byId('maintenance-user')?.value || '');
  oldPassInput.value = defaultPass || String(invSafeId('pass')?.value || byId('maintenance-pass')?.value || '');
  newPassInput.value = '';
  backdrop.classList.add('open');
  try { setTimeout(function () { oldPassInput.focus(); oldPassInput.select(); }, 60); } catch (_) {}

  btnConfirm.onclick = null;
  btnConfirm.onclick = function () {
    const user = safeTrim(userInput.value || '');
    const oldPass = safeTrim(oldPassInput.value || '');
    const newPass = safeTrim(newPassInput.value || '');
    if (!user || !oldPass || !newPass) {
      if (msg) { msg.style.display = 'block'; msg.textContent = 'Informe usuario, senha atual e nova senha.'; }
      return;
    }
    btnConfirm.disabled = true;
    if (msg) { msg.style.display = 'block'; msg.textContent = 'Aplicando...'; }
    changeCameraPasswordByIp(ip, user, oldPass, newPass)
      .then(function (r) {
        const lines = [];
        if (r && r.ok) {
          setMaintCameraCreds(ip, user, newPass);
          lines.push('OK: senha alterada com sucesso.');
          if (msg) msg.textContent = lines.join('\n');
          try { onSaved({ user: user, pass: newPass }); } catch (_) {}
          try { setTimeout(function () { backdrop.classList.remove('open'); }, 450); } catch (_) {}
        } else {
          lines.push('ERRO: ' + (r && (r.error || r.message) ? (r.error || r.message) : 'falha'));
          if (r && Array.isArray(r.results)) {
            r.results.forEach(function (it) {
              lines.push((it && it.ip ? it.ip : ip) + ' - ' + (it && (it.message || it.error || (it.ok ? 'ok' : 'falha')) ? (it.message || it.error || (it.ok ? 'ok' : 'falha')) : 'falha'));
            });
          }
          if (msg) msg.textContent = lines.join('\n');
        }
      })
      .catch(function (e) {
        if (msg) msg.textContent = 'ERRO: ' + (e && e.message ? e.message : String(e));
      })
      .finally(function () {
        btnConfirm.disabled = false;
      });
  };
}

// =========================
// Modal: Data/hora (NTP)
// =========================
let __ntpModalReady = false;
function ensureNtpModal() {
  if (__ntpModalReady) return;
  __ntpModalReady = true;

  const backdrop = document.createElement('div');
  backdrop.id = 'ntp-modal-backdrop';
  backdrop.className = 'inv-modal-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.innerHTML = '' +
    '<div class="inv-modal" style="width:min(680px,96vw); height:auto; max-height:84vh;">' +
      '<div class="inv-modal-header">' +
        '<div style="font-weight:700;">Ajustar data e hora</div>' +
        '<button class="btn-ghost" id="btn-ntp-close" type="button">Fechar</button>' +
      '</div>' +
      '<div class="inv-modal-body">' +
        '<div class="muted" id="ntp-modal-sub" style="font-size:13px; margin-bottom:10px;"></div>' +
        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="ntp-user">Usuario</label>' +
            '<input id="ntp-user" type="text" placeholder="admin" autocomplete="username" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="ntp-pass">Senha</label>' +
            '<input id="ntp-pass" type="password" placeholder="Informe a senha" autocomplete="current-password" />' +
          '</div>' +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="ntp-server">Servidor NTP</label>' +
            '<input id="ntp-server" type="text" placeholder="a.ntp.br" value="a.ntp.br" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="ntp-port">Porta</label>' +
            '<input id="ntp-port" type="number" min="1" max="65535" value="123" />' +
          '</div>' +
        '</div>' +
        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="ntp-timezone">Timezone</label>' +
            '<input id="ntp-timezone" type="number" value="22" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="ntp-period">Intervalo (min)</label>' +
            '<input id="ntp-period" type="number" min="1" value="60" />' +
          '</div>' +
        '</div>' +
        '<div class="actions-row" style="justify-content:flex-end; margin-top:14px;">' +
          '<button class="btn-secondary" id="btn-ntp-cancel" type="button">Cancelar</button>' +
          '<button class="btn-primary" id="btn-ntp-confirm" type="button">Aplicar</button>' +
        '</div>' +
        '<pre id="ntp-modal-msg" class="log-box" style="margin-top:10px; display:none; max-height:220px;"></pre>' +
      '</div>' +
    '</div>';

  document.body.appendChild(backdrop);
  backdrop.addEventListener('click', function (ev) {
    if (ev && ev.target === backdrop) backdrop.classList.remove('open');
  });
  const btnClose = backdrop.querySelector('#btn-ntp-close');
  const btnCancel = backdrop.querySelector('#btn-ntp-cancel');
  if (btnClose) btnClose.addEventListener('click', function () { backdrop.classList.remove('open'); });
  if (btnCancel) btnCancel.addEventListener('click', function () { backdrop.classList.remove('open'); });
}

function openNtpModal(opts) {
  opts = opts || {};
  const ip = safeTrim(opts.ip || '');
  const cachedCreds = getMaintCameraCreds(ip);
  const defaultUser = safeTrim(opts.user || cachedCreds.user || '');
  const defaultPass = opts.pass != null ? String(opts.pass) : String(cachedCreds.pass || '');
  if (!ip) return;

  ensureNtpModal();
  const backdrop = byId('ntp-modal-backdrop');
  const sub = byId('ntp-modal-sub');
  const userInput = byId('ntp-user');
  const passInput = byId('ntp-pass');
  const serverInput = byId('ntp-server');
  const portInput = byId('ntp-port');
  const tzInput = byId('ntp-timezone');
  const periodInput = byId('ntp-period');
  const msg = byId('ntp-modal-msg');
  const btnConfirm = byId('btn-ntp-confirm');
  if (!backdrop || !userInput || !passInput || !serverInput || !portInput || !tzInput || !periodInput || !msg || !btnConfirm) return;

  if (sub) sub.textContent = 'IP: ' + ip;
  msg.style.display = 'none';
  msg.textContent = '';
  userInput.value = defaultUser || safeTrim(invSafeId('user')?.value || byId('maintenance-user')?.value || '');
  passInput.value = defaultPass || String(invSafeId('pass')?.value || byId('maintenance-pass')?.value || '');
  backdrop.classList.add('open');
  try { setTimeout(function () { passInput.focus(); passInput.select(); }, 60); } catch (_) {}

  btnConfirm.onclick = null;
  btnConfirm.onclick = function () {
    const user = safeTrim(userInput.value || '');
    const pass = safeTrim(passInput.value || '');
    const address = safeTrim(serverInput.value || '');
    const port = parseInt(portInput.value || '123', 10);
    const timezone = parseInt(tzInput.value || '22', 10);
    const updatePeriod = parseInt(periodInput.value || '60', 10);
    if (!user || !pass || !address) {
      msg.style.display = 'block';
      msg.textContent = 'Informe usuario, senha e servidor NTP.';
      return;
    }
    btnConfirm.disabled = true;
    msg.style.display = 'block';
    msg.textContent = 'Aplicando...';
    setCameraNtpByIp(ip, user, pass, address, port, timezone, updatePeriod)
      .then(function (r) {
        const lines = [];
        if (r && r.ok) {
          setMaintCameraCreds(ip, user, pass);
          lines.push('OK: data/hora atualizada via NTP.');
          if (Array.isArray(r.results)) {
            r.results.forEach(function (it) {
              lines.push((it && it.ip ? it.ip : ip) + ' - ' + (it && (it.message || (it.ok ? 'ok' : 'falha')) ? (it.message || (it.ok ? 'ok' : 'falha')) : 'ok'));
            });
          }
          msg.textContent = lines.join('\n');
          try { setTimeout(function () { backdrop.classList.remove('open'); }, 450); } catch (_) {}
        } else {
          lines.push('ERRO: ' + (r && (r.error || r.message) ? (r.error || r.message) : 'falha'));
          if (Array.isArray(r.results)) {
            r.results.forEach(function (it) {
              lines.push((it && it.ip ? it.ip : ip) + ' - ' + (it && (it.message || it.error || (it.ok ? 'ok' : 'falha')) ? (it.message || it.error || (it.ok ? 'ok' : 'falha')) : 'falha'));
            });
          }
          msg.textContent = lines.join('\n');
        }
      })
      .catch(function (e) {
        msg.textContent = 'ERRO: ' + (e && e.message ? e.message : String(e));
      })
      .finally(function () {
        btnConfirm.disabled = false;
      });
  };
}

// =========================
// Modal: Trocar IP (Manutencao)
// =========================
let __ipModalReady = false;
function ensureChangeIpModal() {
  if (__ipModalReady) return;
  __ipModalReady = true;

  const backdrop = document.createElement('div');
  backdrop.id = 'ip-modal-backdrop';
  backdrop.className = 'inv-modal-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  backdrop.innerHTML = '' +
    '<div class="inv-modal" style="width:min(680px,96vw); height:auto; max-height:84vh;">' +
      '<div class="inv-modal-header">' +
        '<div style="font-weight:700;">Trocar IP da camera</div>' +
        '<button class="btn-ghost" id="btn-ip-close" type="button">Fechar</button>' +
      '</div>' +
      '<div class="inv-modal-body">' +
        '<div class="muted" id="ip-modal-sub" style="font-size:13px; margin-bottom:10px;"></div>' +

        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="ip-new-ip">Novo IP</label>' +
            '<input id="ip-new-ip" type="text" placeholder="10.10.11.155" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="ip-mask">Mascara</label>' +
            '<input id="ip-mask" type="text" value="255.255.255.0" />' +
          '</div>' +
        '</div>' +

        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="ip-gw">Gateway</label>' +
            '<input id="ip-gw" type="text" placeholder="ex: 10.10.11.1" />' +
          '</div>' +
          '<div class="field">' +
            '<label for="ip-dns1">DNS 1 (opcional)</label>' +
            '<input id="ip-dns1" type="text" placeholder="ex: 8.8.8.8" />' +
          '</div>' +
        '</div>' +

        '<div class="grid-2">' +
          '<div class="field">' +
            '<label for="ip-dns2">DNS 2 (opcional)</label>' +
            '<input id="ip-dns2" type="text" placeholder="ex: 1.1.1.1" />' +
          '</div>' +
          '<div class="field"></div>' +
        '</div>' +

        '<div class="muted" style="font-size:12px; margin-top:6px;">' +
          'Atencao: ao trocar o IP, a camera pode desconectar do IP antigo imediatamente.' +
        '</div>' +

        '<div class="actions-row" style="justify-content:flex-end; margin-top:14px;">' +
          '<button class="btn-secondary" id="btn-ip-cancel" type="button">Cancelar</button>' +
          '<button class="btn-danger" id="btn-ip-confirm" type="button">Aplicar</button>' +
        '</div>' +
        '<pre id="ip-modal-msg" class="log-box" style="margin-top:10px; display:none; max-height:220px;"></pre>' +
      '</div>' +
    '</div>';

  document.body.appendChild(backdrop);

  backdrop.addEventListener('click', function (ev) {
    if (ev && ev.target === backdrop) backdrop.classList.remove('open');
  });

  const btnClose = backdrop.querySelector('#btn-ip-close');
  const btnCancel = backdrop.querySelector('#btn-ip-cancel');
  if (btnClose) btnClose.addEventListener('click', function () { backdrop.classList.remove('open'); });
  if (btnCancel) btnCancel.addEventListener('click', function () { backdrop.classList.remove('open'); });
}

function openChangeIpModal(opts) {
  opts = opts || {};
  const ip = safeTrim(opts.ip || '');
  const cachedCreds = getMaintCameraCreds(ip);
  const user = safeTrim(opts.user || cachedCreds.user || '');
  const pass = safeTrim(opts.pass || cachedCreds.pass || '');
  const onSaved = (typeof opts.onSaved === 'function') ? opts.onSaved : function () {};
  if (!ip) return;

  ensureChangeIpModal();
  const backdrop = byId('ip-modal-backdrop');
  const sub = byId('ip-modal-sub');
  const inNew = byId('ip-new-ip');
  const inMask = byId('ip-mask');
  const inGw = byId('ip-gw');
  const inDns1 = byId('ip-dns1');
  const inDns2 = byId('ip-dns2');
  const msg = byId('ip-modal-msg');
  const btnConfirm = byId('btn-ip-confirm');

  if (sub) sub.textContent = 'IP atual: ' + ip;

  if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
  if (inNew) inNew.value = '';
  // Mascara e opcional: se vazio, o backend mantem a mascara atual da camera (via getConfig).
  if (inMask && !safeTrim(inMask.value)) inMask.value = '';
  if (inGw) inGw.value = '';
  if (inDns1) inDns1.value = '';
  if (inDns2) inDns2.value = '';

  if (backdrop) backdrop.classList.add('open');
  try { setTimeout(function () { inNew && inNew.focus(); }, 60); } catch (_) {}

  if (btnConfirm) {
    // evita multiplos binds
    btnConfirm.onclick = null;
    btnConfirm.onclick = function () {
      const newIp = safeTrim(inNew?.value || '');
      const mask = safeTrim(inMask?.value || '');
      const gw = safeTrim(inGw?.value || '');
      const dns1 = safeTrim(inDns1?.value || '');
      const dns2 = safeTrim(inDns2?.value || '');

      if (!newIp) { alert('Informe o novo IP.'); return; }
      // mascara/gateway/dns sao opcionais (se vazio, mantem os valores atuais)

      const msgc = `Trocar IP da camera ${ip}  ${newIp}?\nPode desconectar do IP antigo imediatamente.`;
      if (!confirm(msgc)) return;

      if (btnConfirm) btnConfirm.disabled = true;
      changeIpCameraByIp(ip, newIp, mask, gw, dns1, dns2, user, pass)
        .then(function (r) {
          const lines = [];
          if (r && r.ok) {
            setMaintCameraCreds(ip, user, pass);
            setMaintCameraCreds(newIp, user, pass);
            lines.push('OK: IP alterado (comando enviado).');
            lines.push('Antigo: ' + ip);
            lines.push('Novo: ' + newIp);
            if (msg) { msg.style.display = 'block'; msg.textContent = lines.join('\n'); }
            try { onSaved(newIp); } catch (_) {}
            // fecha após um instante
            try { setTimeout(function () { backdrop.classList.remove('open'); }, 450); } catch (_) {}
          } else {
            lines.push('ERRO: ' + (r && (r.error || r.message) ? (r.error || r.message) : 'falha'));
            if (r && r.detail) lines.push(JSON.stringify(r.detail, null, 2));
            if (msg) { msg.style.display = 'block'; msg.textContent = lines.join('\n'); }
          }
        })
        .catch(function (e) {
          if (msg) { msg.style.display = 'block'; msg.textContent = 'ERRO: ' + (e && e.message ? e.message : String(e)); }
        })
        .finally(function () {
          if (btnConfirm) btnConfirm.disabled = false;
        });
    };
  }
}

function changeIpCameraByIp(oldIp, newIp, mask, gw, dns1, dns2, user, pass) {
  // Troca IP na camera (Intelbras/Dahua HTTP API) e persiste no inventario.
  const u = safeTrim(user || byId('maintenance-user')?.value || '');
  const p = safeTrim(pass || byId('maintenance-pass')?.value || '');
  return fetch('/api/maintenance/change_ip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ip: oldIp,
      new_ip: newIp,
      mask: mask,
      gateway: gw,
      dns1: dns1,
      dns2: dns2,
      user: u,
      pass: p
    })
  }).then(function (r) { return r.json().catch(function () { return {}; }); });
}

function renameCameraByIp(ip, newTitle, userOverride, passOverride) {
  // Renomeia na camera (Intelbras HTTP API) e persiste no inventario.
  const userEl = byId('maintenance-user');
  const passEl = byId('maintenance-pass');

  const user = safeTrim(userOverride || (userEl && userEl.value ? userEl.value : ''));
  const pass = safeTrim(passOverride || (passEl && passEl.value ? passEl.value : ''));

  // Se nao tiver credencial, ao menos salva no inventario (com aviso no backend).
  return fetch('/api/cameras/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ip: ip,
      title: newTitle,
      user: user,
      pass: pass,
      // Defaults:
      port: 80,
      channel: 1
    })
  }).then(function (r) { return r.json().catch(function () { return {}; }); });
}

function changeCameraPasswordByIp(ip, user, oldPass, newPass) {
  return fetch('/api/maintenance/batch/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: safeTrim(user || ''),
      old_pass: safeTrim(oldPass || ''),
      new_pass: safeTrim(newPass || ''),
      ips: [safeTrim(ip || '')].filter(Boolean)
    })
  }).then(function (r) { return r.json().catch(function () { return {}; }); });
}

function setCameraNtpByIp(ip, user, pass, address, port, timezone, updatePeriod) {
  return fetch('/api/maintenance/batch/ntp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user: safeTrim(user || ''),
      pass: safeTrim(pass || ''),
      ips: [safeTrim(ip || '')].filter(Boolean),
      address: safeTrim(address || ''),
      port: isFinite(port) ? port : 123,
      timezone: isFinite(timezone) ? timezone : 22,
      update_period: isFinite(updatePeriod) ? updatePeriod : 60
    })
  }).then(function (r) { return r.json().catch(function () { return {}; }); });
}

function rebootCameraByIp(ip, user, pass) {
  return fetch('/api/cameras/reboot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip: ip, user: user, pass: pass })
  })
    .then(function (r) { return r.json().catch(function () { return {}; }); });
}

function loadMaintenance() {
  const grid = byId('maintenance-grid');
  if (!grid) return;

  // Contadores estilo Grafana (geral; nao muda com filtro/busca)
  const statOnlineEl = byId('maint-stat-online');
  const statOfflineEl = byId('maint-stat-offline');
  const statTotalEl = byId('maint-stat-total');

  // cards clicaveis (estilo Grafana): clique filtra Online/Offline/Todas
  const statOnlineCard = byId('maint-stat-online-card');
  const statOfflineCard = byId('maint-stat-offline-card');
  const statTotalCard = byId('maint-stat-total-card');

  const modeEl = byId('maintenance-filter');
  const sourceEl = byId('maintenance-source');
  const siteEl = byId('maintenance-site');
  const qEl = byId('maintenance-search');
  const refreshEl = byId('maintenance-refresh');
  const pingModeEl = byId('maintenance-pingmode');
  const btnReload = byId('maintenance-reload');
  const btnSelectVisible = byId('maintenance-select-visible');
  const btnSelectOnline = byId('maintenance-select-online');
  const btnOpenBatch = byId('maintenance-open-batch');
  const guideStep1 = byId('maint-guide-step1');
  const guideStep2 = byId('maint-guide-step2');
  const guideStep3 = byId('maint-guide-step3');
  const guideSel = byId('maint-guide-sel');
  const guideCred = byId('maint-guide-cred');
  const guideAction = byId('maint-guide-action');
  const consoleLogEl = byId('maint-console-log');
  const consoleClearEl = byId('maint-console-clear');
  const __maintConsoleLines = [];

  function maintNow() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return hh + ':' + mm + ':' + ss;
  }
  function maintLog(level, text) {
    if (!consoleLogEl) return;
    const lv = safeTrim(level || 'INFO').toUpperCase();
    __maintConsoleLines.push('[' + maintNow() + '] [' + lv + '] ' + String(text || ''));
    while (__maintConsoleLines.length > 220) __maintConsoleLines.shift();
    consoleLogEl.textContent = __maintConsoleLines.join('\n');
    consoleLogEl.scrollTop = consoleLogEl.scrollHeight;
  }
  function updateMaintGuide() {
    const n = __maintSelected ? __maintSelected.size : 0;
    const user = safeTrim(byId('maintenance-user')?.value || '');
    const pass = safeTrim(byId('maintenance-pass')?.value || '');
    const needsPass = !(activeTab === 'password' || activeTab === 'rename');
    const credOk = !!user && (!needsPass || !!pass);
    if (guideSel) guideSel.textContent = String(n);
    if (guideCred) guideCred.textContent = credOk ? 'ok' : 'pendente';
    if (guideAction) guideAction.textContent = safeTrim(activeTab || 'rename');
    if (guideStep1) guideStep1.classList.toggle('is-ok', n > 0);
    if (guideStep1) guideStep1.classList.toggle('is-warn', n <= 0);
    if (guideStep2) guideStep2.classList.toggle('is-ok', credOk);
    if (guideStep2) guideStep2.classList.toggle('is-warn', !credOk);
    if (guideStep3) guideStep3.classList.toggle('is-ok', !!activeTab);
    if (guideStep3) guideStep3.classList.toggle('is-warn', !activeTab);
  }
  try { window.__maintenance_update_guide = updateMaintGuide; } catch (_) {}

  let state = {
    source: 'olt',
    mode: 'all',
    query: ''
  };

  // ping cache em memória (nao persistente)
  const pingCache = {}; // ip -> { online: bool, rtt_ms: number|null, ts: ms }
  let maintPingWs = null;
  let maintPingWsConnected = false;
  let maintPingWsRetryTimer = null;
  let maintRenderTimer = null;
  let maintVisibleHintTimer = null;

  const progressEl = byId('maintenance-progress');

  // Progresso do ping (para confianca visual e contadores "ao vivo")
  let pingProgress = { running: false, done: 0, total: 0, label: '' };
  function updateProgressUI() {
    try {
      if (!progressEl) return;
      if (!pingProgress.running || !pingProgress.total) {
        progressEl.textContent = '';
        return;
      }
      const pct = Math.max(0, Math.min(100, Math.round((pingProgress.done / pingProgress.total) * 100)));
      progressEl.textContent = (pingProgress.label ? (pingProgress.label + ' ') : '') + pingProgress.done + '/' + pingProgress.total + ' (' + pct + '%)';
    } catch (_) {}
  }
  function startProgress(total, label) {
    pingProgress.running = true;
    pingProgress.done = 0;
    pingProgress.total = Math.max(0, total || 0);
    pingProgress.label = label || 'Atualizando';
    updateProgressUI();
  }
  function tickProgress() {
    pingProgress.done = Math.min(pingProgress.total, (pingProgress.done || 0) + 1);
    updateProgressUI();
  }
  function stopProgress() {
    pingProgress.running = false;
    pingProgress.done = 0;
    pingProgress.total = 0;
    pingProgress.label = '';
    updateProgressUI();
  }

  function scheduleMaintenanceRender(delayMs) {
    if (maintRenderTimer) clearTimeout(maintRenderTimer);
    maintRenderTimer = setTimeout(function () {
      maintRenderTimer = null;
      renderFromCache();
    }, Math.max(20, delayMs || 80));
  }


  // Modo Ping (impacta carga/estabilidade)
  // - light  : 90s, menos concorrência, timeout maior
  // - normal : 30s
  // - fast   : 10s, mais responsivo
  const PING_MODES = {
    eco:    { label: 'Econômico (10 min)', intervalMs: 600000, limit: 20, timeoutSec: 2, batch: 160, chunk: 160 },
    light:  { label: 'Leve (90s)',        intervalMs: 90000,  limit: 28, timeoutSec: 2, batch: 280, chunk: 220 },
    normal: { label: 'Normal (30s)',      intervalMs: 30000,  limit: 40, timeoutSec: 2, batch: 600, chunk: 300 },
    fast:   { label: 'Rapido (10s)',      intervalMs: 10000,  limit: 56, timeoutSec: 1, batch: 1200, chunk: 400 }
  };
  let pingMode = 'normal';
  function loadPingMode() {
    try {
      const saved = localStorage.getItem('maint_ping_mode');
      if (saved && PING_MODES[saved]) pingMode = saved;
    } catch (_) {}
    try { if (pingModeEl) pingModeEl.value = pingMode; } catch (_) {}
  }
  function savePingMode(v) {
    if (!PING_MODES[v]) return;
    pingMode = v;
    try { localStorage.setItem('maint_ping_mode', v); } catch (_) {}
    try { if (pingModeEl) pingModeEl.value = v; } catch (_) {}
    applyPingMode();
  }

  // Estado para estabilidade (anti-flapping): exige 2 falhas/sucessos seguidos para trocar ONLINE/OFFLINE
  const pingState = {}; // ip -> { okStreak:number, failStreak:number, stableOnline:bool|null }
  function updateStableOnline(ip, rawOnline) {
    const ps = pingState[ip] || { okStreak: 0, failStreak: 0, stableOnline: null };

    if (rawOnline) {
      ps.okStreak = (ps.okStreak || 0) + 1;
      ps.failStreak = 0;
      if (ps.stableOnline === null) ps.stableOnline = true;
      else if (ps.stableOnline !== true && ps.okStreak >= 2) ps.stableOnline = true;
    } else {
      ps.failStreak = (ps.failStreak || 0) + 1;
      ps.okStreak = 0;
      if (ps.stableOnline === null) ps.stableOnline = false;
      else if (ps.stableOnline !== false && ps.failStreak >= 2) ps.stableOnline = false;
    }

    pingState[ip] = ps;
    return ps.stableOnline;
  }

  function forceStableOnline(ip, online) {
    pingState[ip] = {
      okStreak: online ? 2 : 0,
      failStreak: online ? 0 : 2,
      stableOnline: !!online
    };
    return !!online;
  }

  function applyServerPingRow(row, updateDom) {
    const ip = safeTrim(row && row.ip);
    if (!ip) return;
    const rowTs = row && row.ts ? Number(row.ts) : Date.now();
    if (row && row.online === false && rowTs && (Date.now() - rowTs) > MAINT_PING_FRESH_MS) {
      return;
    }
    const stable = forceStableOnline(ip, !!(row && row.online));
    pingCache[ip] = {
      online: stable,
      rtt_ms: (stable ? (row.rtt_ms ?? null) : null),
      ts: rowTs
    };
    if (updateDom !== false) applyPingToCard(ip);
  }

  function maintenanceVisibleIps(limit) {
    const list = (__getMaintRenderedList() || []).map(function (c) { return safeTrim(c && c.ip); }).filter(Boolean);
    const max = Math.max(1, limit || 120);
    return list.slice(0, max);
  }

  function sendMaintenancePingHint(forceAll) {
    if (!maintPingWsConnected || !maintPingWs || maintPingWs.readyState !== 1) return;
    const inv = getCachedInventory();
    const ips = forceAll
      ? (Array.isArray(inv) ? inv.map(function (c) { return safeTrim(c && c.ip); }).filter(Boolean) : [])
      : maintenanceVisibleIps(160);
    if (!ips.length) return;
    try {
      maintPingWs.send(JSON.stringify({ type: 'visible', visible_ips: ips }));
    } catch (_) {}
  }

  function scheduleVisiblePingHint(forceAll) {
    if (maintVisibleHintTimer) clearTimeout(maintVisibleHintTimer);
    maintVisibleHintTimer = setTimeout(function () {
      maintVisibleHintTimer = null;
      sendMaintenancePingHint(!!forceAll);
    }, forceAll ? 40 : 120);
  }

  function connectMaintenancePingWs() {
    try {
      if (maintPingWs && (maintPingWs.readyState === 0 || maintPingWs.readyState === 1)) return;
    } catch (_) {}

    const ws = new WebSocket(buildAuthedWsUrl('/ws/maintenance_ping'));
    maintPingWs = ws;

    ws.onopen = function () {
      maintPingWsConnected = true;
      maintLog('info', 'Feed de ping conectado ao backend.');
      sendWsAuthFrame(ws);
      scheduleVisiblePingHint(true);
      try { ws.send(JSON.stringify({ type: 'snapshot' })); } catch (_) {}
    };
    ws.onmessage = function (ev) {
      let msg = {};
      try { msg = JSON.parse(ev.data || '{}'); } catch (_) { return; }
      if (msg.type === 'snapshot') {
        const rows = Array.isArray(msg.rows) ? msg.rows : [];
        rows.forEach(function (row) { applyServerPingRow(row, false); });
        scheduleStats();
        scheduleMaintenanceRender(60);
        return;
      }
      if (msg.type === 'ping_update' && msg.row) {
        applyServerPingRow(msg.row);
        scheduleStats();
        scheduleMaintenanceRender(80);
        return;
      }
      if (msg.type === 'status') {
        return;
      }
    };
    ws.onclose = function () {
      maintPingWsConnected = false;
      maintLog('warn', 'Feed de ping desconectado; usando fallback local.');
      if (maintPingWsRetryTimer) clearTimeout(maintPingWsRetryTimer);
      maintPingWsRetryTimer = setTimeout(connectMaintenancePingWs, 3000);
      scheduleNextPing(400);
    };
    ws.onerror = function () {};
  }

  // Atualiza contadores do topo (modo 1: geral)
  let __statsT = null;
  function updateMaintenanceStats(inv) {
    try {
      if (!statOnlineEl || !statOfflineEl || !statTotalEl) return;
      const cams = (Array.isArray(inv) ? inv : []).map(normalizeCamForUI).filter(c => !!c.ip);
      const total = cams.length;
      let online = 0;
      cams.forEach(function (c) {
        const pc = pingCache[c.ip];
        if (pc && pc.online === true && maintPingIsFresh(pc)) online++;
        else if ((!pc || !maintPingIsFresh(pc)) && maintCamHasVisualEvidence(c)) online++;
      });
      const offline = Math.max(0, total - online);
      statTotalEl.textContent = String(total);
      statOnlineEl.textContent = String(online);
      statOfflineEl.textContent = String(offline);
      statOnlineEl.classList.toggle('ok', true);
      statOfflineEl.classList.toggle('bad', true);
    } catch (_) {}
  }
  function scheduleStats() {
    if (__statsT) return;
    __statsT = setTimeout(function () {
      __statsT = null;
      updateMaintenanceStats(getCachedInventory());
    }, 100);
  }

  function pingCamera(ip) {
    const cfg = PING_MODES[pingMode] || PING_MODES.normal;
    const timeoutSec = cfg.timeoutSec || 2;
    return fetch('/api/cameras/ping?ip=' + encodeURIComponent(ip) + '&timeout=' + encodeURIComponent(timeoutSec) + '&method=auto')
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        if (data && data.ok === true) {
          const stable = updateStableOnline(ip, !!data.online);
          pingCache[ip] = { online: !!stable, rtt_ms: (stable ? (data.rtt_ms ?? null) : null), ts: Date.now() };
          scheduleStats();
          tickProgress();
          return pingCache[ip];
        }
        throw new Error('ping failed');
      });
  }

  function buildPreferredPorts(camLike) {
    const ports = [];
    const pushPort = function (v) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 65535 && !ports.includes(n)) ports.push(n);
    };
    if (camLike) {
      pushPort(camLike.http_port);
      pushPort(camLike.https_port);
      pushPort(camLike.rtsp_port);
      pushPort(camLike.server_port);
      if (Array.isArray(camLike.open_ports)) camLike.open_ports.slice(0, 6).forEach(pushPort);
      if (camLike.raw) {
        pushPort(camLike.raw.http_port);
        pushPort(camLike.raw.https_port);
        pushPort(camLike.raw.rtsp_port);
        pushPort(camLike.raw.server_port);
        if (Array.isArray(camLike.raw.open_ports)) camLike.raw.open_ports.slice(0, 6).forEach(pushPort);
      }
    }
    if (!ports.length) pushPort(80);
    return ports;
  }

  function chunkArray(list, size) {
    const chunkSize = Math.max(1, size || list.length || 1);
    const out = [];
    for (let i = 0; i < list.length; i += chunkSize) out.push(list.slice(i, i + chunkSize));
    return out;
  }

  function runPingBatch(items, limit, label) {
    const batchItems = Array.isArray(items) ? items.filter(it => it && it.ip) : [];
    if (!batchItems.length) return Promise.resolve();

    const cfg = PING_MODES[pingMode] || PING_MODES.normal;
    const concurrency = Math.max(1, Math.min(limit || cfg.limit || 40, 128));
    const chunkSize = Math.max(1, Math.min(cfg.chunk || batchItems.length, batchItems.length));
    const chunks = chunkArray(batchItems, chunkSize);

    startProgress(batchItems.length, label || 'Atualizando');

    return chunks.reduce(function (chain, chunk) {
      return chain.then(function () {
        return fetch('/api/cameras/ping_many', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: chunk.map(function (item) {
              return { ip: item.ip, preferred_ports: item.preferred_ports || [] };
            }),
            timeout: cfg.timeoutSec || 2,
            method: 'auto',
            force: 0,
            concurrency: concurrency
          })
        })
          .then(function (r) { return r.json().catch(function () { return {}; }); })
          .then(function (data) {
            const rows = Array.isArray(data.results) ? data.results : [];
            const byIp = new Map(rows.map(function (row) { return [String(row.ip || '').trim(), row || {}]; }));
            chunk.forEach(function (item) {
              const ip = String(item.ip || '').trim();
              const row = byIp.get(ip);
              if (row && row.ok !== false) {
                const stable = updateStableOnline(ip, !!row.online);
                pingCache[ip] = { online: !!stable, rtt_ms: (stable ? (row.rtt_ms ?? null) : null), ts: Date.now() };
              } else {
                const stable = updateStableOnline(ip, false);
                pingCache[ip] = { online: !!stable, rtt_ms: null, ts: Date.now() };
              }
              applyPingToCard(ip);
              tickProgress();
            });
            scheduleStats();
          })
          .catch(function () {
            chunk.forEach(function (item) {
              const ip = String(item.ip || '').trim();
              const stable = updateStableOnline(ip, false);
              pingCache[ip] = { online: !!stable, rtt_ms: null, ts: Date.now() };
              applyPingToCard(ip);
              tickProgress();
            });
            scheduleStats();
          });
      });
    }, Promise.resolve()).finally(function () {
      stopProgress();
      renderFromCache();
    });
  }

  function currentOpts() {
    state.source = safeTrim(sourceEl?.value) || 'olt';
    state.mode = safeTrim(modeEl?.value) || 'all';
    state.query = safeTrim(qEl?.value) || '';
    state.site = safeTrim(siteEl?.value) || '';
    return { source: state.source, mode: state.mode, query: state.query };
  }

  function renderFromCache() {
    const inv = getCachedInventory();
    const o = currentOpts();
    o.pingCache = pingCache;
    renderMaintenanceGrid(inv, o);
    try {
      const mode = safeTrim(o.mode || 'all');
      if (statOnlineCard) statOnlineCard.classList.toggle('is-active', mode === 'online');
      if (statOfflineCard) statOfflineCard.classList.toggle('is-active', mode === 'offline');
      if (statTotalCard) statTotalCard.classList.toggle('is-active', mode === 'all');
    } catch (_) {}
    updateMaintGuide();
    scheduleStats();
    scheduleVisiblePingHint(false);
  }

  // expõe um hook leve para re-render (usado por acões do menu , ex: renomear)
  try { window.__maintenance_render_from_cache = renderFromCache; } catch (_) {}

  // =========================
  // Acões em lote (UI + API)
  // =========================
  const btnBatch = byId('maintenance-batch');
  const barSelAll = byId('maint-select-all');
  const barClear = byId('maint-clear-selection');
  const modal = byId('maint-modal');
  const modalClose = byId('maint-modal-close');
  const modalCancel = byId('maint-modal-cancel');
  const modalRun = byId('maint-modal-run');
  const modalResults = byId('maint-modal-results');
  const modalSub = byId('maint-modal-sub');
  const tabsWrap = byId('maint-modal-tabs');

  let activeTab = 'rename';

  function setTab(t) {
    activeTab = t || 'rename';
    try {
      const tabs = (tabsWrap ? tabsWrap.querySelectorAll('.tab') : []);
      tabs.forEach(function (b) {
        b.classList.toggle('active', (b.dataset.tab === activeTab));
      });
      const panels = document.querySelectorAll('#maint-modal .modal-panel');
      panels.forEach(function (p) {
        const ok = (p && p.getAttribute('data-panel') === activeTab);
        p.style.display = ok ? 'block' : 'none';
      });
      if (modalSub) {
        const n = __maintSelected ? __maintSelected.size : 0;
        modalSub.textContent = n ? ('Acao: ' + activeTab + '  -  Selecionadas: ' + n) : 'Selecione as cameras no grid e execute uma acao.';
      }
      updateMaintGuide();
    } catch (_) {}
  }

  function openModal(tab) {
    setTab(tab || activeTab);
    updateMaintBatchBar();
    if (modalResults) { modalResults.style.display = 'none'; modalResults.textContent = ''; }
    if (modal) modal.style.display = 'flex';
  }
  function closeModal() {
    if (modal) modal.style.display = 'none';
  }

  function fetchJson(url, bodyObj) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyObj || {})
    }).then(function (r) {
      return r.json().catch(function () { return {}; });
    });
  }

  function currentSelectedCams() {
    const inv = getCachedInventory();
    const cams = (Array.isArray(inv) ? inv : []).map(normalizeCamForUI).filter(c => !!c.ip);
    const wanted = new Set(maintSelectedArray());
    return cams.filter(c => wanted.has(c.ip)).sort((a,b) => ipToNum(a.ip) - ipToNum(b.ip));
  }

  async function runBatch() {
    const ips = maintSelectedArray();
    if (!ips.length) { alert('Selecione pelo menos 1 camera.'); return; }

    const user = safeTrim(byId('maintenance-user')?.value || '');
    const pass = safeTrim(byId('maintenance-pass')?.value || '');

    if (!user) { alert('Informe o Usuario no topo da aba Manutencao.'); return; }

    if (activeTab !== 'password' && activeTab !== 'rename') {
      if (!pass) { alert('Informe a Senha no topo da aba Manutencao.'); return; }
    }

    if (activeTab === 'reboot') {
      const ok = !!(byId('batch-reboot-confirm')?.checked);
      if (!ok) { alert('Marque a confirmacao de reboot.'); return; }
    }

    if (modalRun) modalRun.disabled = true;
    maintLog('run', 'Iniciando acao "' + activeTab + '" em ' + ips.length + ' camera(s).');
    markMaintBatchBusy(ips, activeTab);
    try {
      let res;
      if (activeTab === 'rename') {
        const mode = safeTrim(byId('batch-rename-mode')?.value || 'inventory');
        const cams = currentSelectedCams();
        let targets = [];
        if (mode === 'prefix') {
          const prefix = safeTrim(byId('batch-rename-prefix')?.value || 'CAM-');
          const start = parseInt(byId('batch-rename-start')?.value || '1', 10);
          let n = isFinite(start) ? start : 1;
          targets = cams.map(function (c) {
            const title = prefix + String(n++).padStart(2, '0');
            return { ip: c.ip, title: title, port: 80, channel: 1 };
          });
        } else {
          targets = cams.map(function (c) {
            const title = safeTrim((c.raw && (c.raw.title || c.raw.titulo)) ? (c.raw.title || c.raw.titulo) : (c.title || 'CAM ' + c.ip));
            return { ip: c.ip, title: title, port: 80, channel: 1 };
          });
        }
        res = await fetchJson('/api/maintenance/batch/rename', { user: user, pass: pass, targets: targets });
      } else if (activeTab === 'password') {
        const oldPass = safeTrim(byId('batch-old-pass')?.value || '');
        const newPass = safeTrim(byId('batch-new-pass')?.value || '');
        if (!oldPass || !newPass) { alert('Informe senha antiga e nova.'); return; }
        // Para mudar senha, usamos a senha antiga no request (nao precisa do campo "Senha" do topo)
        res = await fetchJson('/api/maintenance/batch/password', { user: user, old_pass: oldPass, new_pass: newPass, ips: ips });
      
      } else if (activeTab === 'ip') {
        const mask = safeTrim(byId('batch-ip-mask')?.value || '');
        const gw = safeTrim(byId('batch-ip-gw')?.value || '');
        const dns1 = safeTrim(byId('batch-ip-dns1')?.value || '');
        const dns2 = safeTrim(byId('batch-ip-dns2')?.value || '');
        const mapTxt = String(byId('batch-ip-map')?.value || '').trim();
        // mascara/gateway/dns sao opcionais (se vazio, mantem os valores atuais da camera)
        if (!mapTxt) { alert('Cole o mapa de IPs (IP atual  IP novo).'); return; }

        const items = [];
        mapTxt.split(/\r?\n/).forEach(function (line) {
          const s = safeTrim(line || '');
          if (!s) return;
          // aceita: a=b, a,b, a;b, a b
          let a = '', b = '';
          if (s.includes('=')) {
            const p = s.split('=');
            a = safeTrim(p[0] || '');
            b = safeTrim(p.slice(1).join('=').trim());
          } else if (s.includes(',')) {
            const p = s.split(',');
            a = safeTrim(p[0] || '');
            b = safeTrim(p[1] || '');
          } else if (s.includes(';')) {
            const p = s.split(';');
            a = safeTrim(p[0] || '');
            b = safeTrim(p[1] || '');
          } else {
            const p = s.split(/\s+/);
            a = safeTrim(p[0] || '');
            b = safeTrim(p[1] || '');
          }
          if (!a || !b) return;
          // só aplica nos selecionados (seguranca)
          if (ips.indexOf(a) === -1) return;
          items.push({ ip: a, new_ip: b, mask: mask, gateway: gw, dns1: dns1, dns2: dns2 });
        });

        if (!items.length) { alert('Nenhuma linha valida (ou nenhum IP do mapa esta selecionado).'); return; }

        res = await fetchJson('/api/maintenance/batch/ip', { user: user, pass: pass, items: items });

        // se tiver algum ok, atualiza o cache local de inventario
        try {
          if (res && Array.isArray(res.results)) {
            const inv0 = getCachedInventory();
            const rows = Array.isArray(inv0) ? inv0 : [];
            const map = new Map();
            res.results.forEach(function (r) {
              if (r && r.ok && r.ip && r.new_ip) map.set(String(r.ip).trim(), String(r.new_ip).trim());
            });
            if (map.size) {
              const rows2 = rows.map(function (row) {
                const ip0 = (row && (row.ip || row.IP) ? String(row.ip || row.IP).trim() : '');
                const ip1 = map.get(ip0);
                if (ip1) {
                  if (row.ip != null) row.ip = ip1;
                  else if (row.IP != null) row.IP = ip1;
                  else row.ip = ip1;
                }
                return row;
              });
              setCachedInventory(rows2);
            }
          }
        } catch (_) {}
} else if (activeTab === 'ntp') {
        const address = safeTrim(byId('batch-ntp-server')?.value || '');
        const port = parseInt(byId('batch-ntp-port')?.value || '123', 10);
        const tz = parseInt(byId('batch-ntp-timezone')?.value || '22', 10);
        const period = parseInt(byId('batch-ntp-period')?.value || '60', 10);
        if (!address) { alert('Informe o servidor NTP.'); return; }
        res = await fetchJson('/api/maintenance/batch/ntp', { user: user, pass: pass, ips: ips, address: address, port: (isFinite(port) ? port : 123), timezone: (isFinite(tz) ? tz : 22), update_period: (isFinite(period) ? period : 60) });
      } else if (activeTab === 'reboot') {
        res = await fetchJson('/api/maintenance/batch/reboot', { user: user, pass: pass, ips: ips });
      } else {
        alert('Acao invalida.');
        return;
      }
      // Mostra resultados
      const lines = [];
      if (res && res.ok) {
        lines.push('OK: ' + (res.message || 'Acao executada.'));
        maintLog('ok', 'Acao "' + activeTab + '" concluida com sucesso.');
      } else {
        lines.push('ERRO: ' + (res && (res.error || res.message) ? (res.error || res.message) : 'falha'));
        maintLog('error', 'Acao "' + activeTab + '" retornou erro.');
      }
      if (res && Array.isArray(res.results)) {
        let okCount = 0;
        let errCount = 0;
        res.results.forEach(function (r) {
          if (r && r.ok) okCount++;
          else errCount++;
          lines.push((r.ok ? '' : '') + ' ' + (r.ip || '-') + (r.title ? (' - ' + r.title) : '') + (r.error ? (' - ' + r.error) : ''));
        });
        maintLog('info', 'Resumo: ok=' + okCount + ' erro=' + errCount + ' total=' + res.results.length + '.');
        applyMaintBatchResults(res.results);
      }
      if (modalResults) {
        modalResults.textContent = lines.join('\n');
        modalResults.style.display = 'block';
      }

      // Após renomear, forca refresh do inventario cache
      if (activeTab === 'rename') {
        refreshFromApi();
      }
    } catch (e) {
      alert('Falha: ' + (e && e.message ? e.message : String(e)));
      maintLog('error', 'Falha inesperada em lote: ' + (e && e.message ? e.message : String(e)));
    } finally {
      clearMaintBatchBusy(ips);
      if (modalRun) modalRun.disabled = false;
      updateMaintGuide();
    }
  }

  if (btnBatch) btnBatch.addEventListener('click', function () { openModal(activeTab); });
  if (btnOpenBatch) btnOpenBatch.addEventListener('click', function () {
    if (!(__maintSelected && __maintSelected.size > 0)) return;
    openModal(activeTab);
  });
  if (consoleClearEl) consoleClearEl.addEventListener('click', function () {
    __maintConsoleLines.length = 0;
    if (consoleLogEl) consoleLogEl.textContent = 'Console limpo.';
  });
  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalCancel) modalCancel.addEventListener('click', closeModal);
  if (modal) modal.addEventListener('click', function (ev) {
    // click fora fecha
    if (ev && ev.target === modal) closeModal();
  });
  if (tabsWrap) tabsWrap.addEventListener('click', function (ev) {
    const t = ev && ev.target ? ev.target : null;
    const tab = t && t.dataset ? t.dataset.tab : null;
    if (!tab) return;
    setTab(tab);
  });
  if (modalRun) modalRun.addEventListener('click', runBatch);

  // barra lote
  if (btnSelectVisible) btnSelectVisible.addEventListener('click', function () {
    selectAllRenderedCams();
    maintLog('info', 'Selecionadas cameras visiveis do filtro atual.');
  });
  if (btnSelectOnline) btnSelectOnline.addEventListener('click', function () {
    selectRenderedCamsByStatus('online');
    maintLog('info', 'Selecionadas cameras online do grid.');
  });
  if (barSelAll) barSelAll.addEventListener('click', selectAllRenderedCams);
  if (barClear) barClear.addEventListener('click', function () {
    clearMaintSelection();
    maintLog('info', 'Selecao limpa.');
  });
  // botões da barra (abrir modal ja na aba)
  try {
    const bar = byId('maint-batchbar');
    if (bar) {
      bar.addEventListener('click', function (ev) {
        const b = ev && ev.target ? ev.target.closest('button[data-batch-action]') : null;
        if (!b) return;
        const act = b.getAttribute('data-batch-action');
        if (act) openModal(act);
      });
    }
  } catch (_) {}

  // Renomear: mostrar/ocultar campos prefix
  const renameModeEl = byId('batch-rename-mode');
  const renamePrefixWrap = byId('batch-rename-prefix-wrap');
  function refreshRenameMode() {
    const m = safeTrim(renameModeEl?.value || 'inventory');
    if (renamePrefixWrap) renamePrefixWrap.style.display = (m === 'prefix') ? 'grid' : 'none';
  }
  if (renameModeEl) renameModeEl.addEventListener('change', refreshRenameMode);
  refreshRenameMode();


  // Clique nos contadores (modo 1): filtra a lista sem alterar os numeros do topo
  function bindStatClicks() {
    function setMode(v) {
      try { if (modeEl) modeEl.value = v; } catch (_) {}
      renderFromCache();
      try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0,0); }
    }
    function makeClickable(el, mode) {
      if (!el) return;
      el.style.cursor = 'pointer';
      el.title = 'Clique para filtrar';
      el.addEventListener('click', function () { setMode(mode); });
      el.addEventListener('keydown', function (e) {
        if (e && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setMode(mode); }
      });
      el.setAttribute('tabindex', '0');
      el.setAttribute('role', 'button');
    }
    makeClickable(statOnlineCard, 'online');
    makeClickable(statOfflineCard, 'offline');
    makeClickable(statTotalCard, 'all');
  }
  bindStatClicks();

  function syncMaintenanceSitesFromInventory(rows) {
    if (!siteEl) return;
    const cur = safeTrim(siteEl.value || '');
    const names = new Set();
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      [row.site, row.site_name, row.local, row.LOCAL].forEach(function (v) {
        const name = safeTrim(v || '');
        if (name) names.add(name);
      });
    });
    siteEl.innerHTML = '<option value="">Todos os sites</option>';
    Array.from(names).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); }).forEach(function (name) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      siteEl.appendChild(opt);
    });
    if (cur && names.has(cur)) siteEl.value = cur;
  }

  function loadMaintenanceSites() {
    syncMaintenanceSitesFromInventory(getCachedInventory());
    return Promise.resolve();
  }

  if (siteEl) {
    siteEl.addEventListener('change', function () {
      clearMaintSelection();
      refreshFromApi();
    });
  }
  if (sourceEl) {
    try {
      const savedSource = localStorage.getItem('maintenance_inventory_source');
      if (savedSource === 'switch' || savedSource === 'olt') sourceEl.value = savedSource;
    } catch (_) {}
    sourceEl.addEventListener('change', function () {
      try { localStorage.setItem('maintenance_inventory_source', safeTrim(sourceEl.value || 'olt') || 'olt'); } catch (_) {}
      clearMaintSelection();
      loadMaintenanceSites();
      refreshFromApi();
    });
  }

  function refreshFromApi() {
    // refresh oportunista (nao destrutivo)
    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const t = setTimeout(function () { try { controller && controller.abort(); } catch (_) {} }, 5000);

    var invUrl = '/api/inventory-last';
    try {
      var source = safeTrim((sourceEl && sourceEl.value) || 'olt') || 'olt';
      var site = safeTrim((siteEl && siteEl.value) || '');
      var qs = ['enrich=' + encodeURIComponent(source)];
      if (site) qs.push('site=' + encodeURIComponent(site));
      if (qs.length) invUrl += '?' + qs.join('&');
    } catch (_) {}
    return fetch(invUrl, controller ? { signal: controller.signal } : undefined)
      .then(function (r) {
        clearTimeout(t);
        return r.json().catch(function () { return {}; });
      })
      .then(function (data) {
        if (data && data.ok === true && Array.isArray(data.inventory)) {
          setCachedInventory(data.inventory);
          syncMaintenanceSitesFromInventory(data.inventory);
          const o = currentOpts();
          o.pingCache = pingCache;
          renderMaintenanceGrid(data.inventory, o);
          updateMaintenanceStats(data.inventory);
        }
      })
      .catch(function () {
        clearTimeout(t);
        // mantem cache renderizado
      });
  }

  // render inicial sempre do cache
  renderFromCache();

  loadMaintenanceSites().finally(function () {
    // tenta atualizar 1x em background
    refreshFromApi();
  });

  // =========================
  // Ping em background (ONLINE/OFFLINE 100% por ping)
  // =========================
  function escAttr(s) {
    try {
      return (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
    } catch (_) {
      return String(s).replace(/"/g, '\\"');
    }
  }

  function applyPingToCard(ip) {
    const eip = escAttr(ip);
    const pill = grid.querySelector('.maint-pill[data-ip="' + eip + '"]');
    const pingLine = grid.querySelector('.maint-sub.muted[data-ip="' + eip + '"]');
    if (!pill) return;

    // Se estiver reiniciando, mantem o warn ate o reboot terminar
    const rem = getRebootRemainingSeconds(ip);
    if (rem > 0) return;

    const pc = pingCache[ip];
    if (!pc || typeof pc.online !== 'boolean') {
      pill.className = 'maint-pill';
      pill.textContent = '';
      if (pingLine) pingLine.textContent = 'Ping: ';
      return;
    }
    pill.className = 'maint-pill ' + (pc.online ? 'ok' : 'bad');
    pill.textContent = pc.online ? 'ONLINE' : 'OFFLINE';
    if (pingLine) {
      const rtt = (typeof pc.rtt_ms === 'number') ? (pc.rtt_ms + 'ms') : '';
      const age = pc.ts ? Math.max(0, Math.floor((Date.now() - pc.ts) / 1000)) : null;
      pingLine.textContent = 'Ping: ' + rtt + (age !== null ? ('  -  ha ' + age + 's') : '');
    }
  }

  
  // Executa uma lista de pings com concorrência limitada e progresso visível
  function runPingList(listItems, limit, label) {
    const normalized = (Array.isArray(listItems) ? listItems : [])
      .map(function (item) {
        if (!item) return null;
        if (typeof item === 'string') return { ip: item, preferred_ports: [80] };
        return {
          ip: item.ip,
          preferred_ports: buildPreferredPorts(item)
        };
      })
      .filter(function (item) { return item && item.ip; });
    return runPingBatch(normalized, limit, label);
  }

  // Faz um sweep completo (todas as cameras) para "acertar" contadores rapidamente
  let __didFullSweep = false;
  function pingFullSweep() {
    const inv = getCachedInventory();
    const cams = (Array.isArray(inv) ? inv : []).map(normalizeCamForUI).filter(c => !!c.ip);
    if (!cams.length) return Promise.resolve();

    const cfg = PING_MODES[pingMode] || PING_MODES.normal;
    const safeLimit = Math.max(cfg.limit || 40, 40);

    __didFullSweep = true;
    return runPingList(cams, safeLimit, 'Atualizando');
  }

  function pingSweep() {
    const inv = getCachedInventory();
    const cams = (Array.isArray(inv) ? inv : []).map(normalizeCamForUI).filter(c => !!c.ip);
    if (!cams.length) return Promise.resolve();

    const cfg = PING_MODES[pingMode] || PING_MODES.normal;
    const limit = cfg.limit || 40;

    // Evita "rajada" de requisicões: pinga por lotes e vai alternando as cameras ao longo do tempo
    const batchSize = Math.max(1, Math.min(cfg.batch || cams.length, cams.length));
    let workCams = cams.slice(pingCursor, pingCursor + batchSize);
    if (workCams.length < batchSize) workCams = workCams.concat(cams.slice(0, batchSize - workCams.length));
    pingCursor = (pingCursor + batchSize) % cams.length;

    return runPingList(workCams, limit, 'Atualizando');
  }

// 1o sweep ao abrir e depois em intervalo configuravel (modo ping)
  // IMPORTANTE: evitamos sweeps sobrepostos (isso causava flapping e muitas requisicões)
  let pingTimer = null;
  let pingSweepRunning = false;
  let pingCursor = 0;
  function clearPingTimer() {
    if (pingTimer) { try { clearTimeout(pingTimer); } catch (_) {} pingTimer = null; }
  }
  function scheduleNextPing(delayMs) {
    clearPingTimer();
    const d = Math.max(250, delayMs || 0);
    pingTimer = setTimeout(runPingLoop, d);
  }
  function runPingLoop() {
    const cfg = PING_MODES[pingMode] || PING_MODES.normal;
    if (maintPingWsConnected) {
      scheduleNextPing(cfg.intervalMs || 30000);
      return;
    }
    if (pingSweepRunning) {
      scheduleNextPing(cfg.intervalMs || 30000);
      return;
    }
    pingSweepRunning = true;
    Promise.resolve()
      .then(function () { return (__didFullSweep ? pingSweep() : pingFullSweep()); })
      .catch(function () { /* ignora */ })
      .finally(function () {
        pingSweepRunning = false;
        const cfg2 = PING_MODES[pingMode] || PING_MODES.normal;
        scheduleNextPing(cfg2.intervalMs || 30000);
      });
  }
  function applyPingMode() {
    // troca o modo imediatamente e reprograma o loop
    scheduleNextPing(0);
    scheduleVisiblePingHint(true);
  }

  loadPingMode();
  connectMaintenancePingWs();
  scheduleNextPing(400);

  if (pingModeEl) {
    pingModeEl.addEventListener('change', function () {
      const v = safeTrim(pingModeEl.value) || 'normal';
      savePingMode(v);
    });
  }

  // listeners
  if (modeEl) modeEl.addEventListener('change', renderFromCache);
  if (modeEl) modeEl.addEventListener('change', updateMaintGuide);
  if (qEl) qEl.addEventListener('input', function () {
    // debounce simples
    if (qEl.__t) clearTimeout(qEl.__t);
    qEl.__t = setTimeout(renderFromCache, 120);
  });
  const maintUserEl = byId('maintenance-user');
  const maintPassEl = byId('maintenance-pass');
  try {
    if (maintUserEl && !safeTrim(maintUserEl.value || '')) maintUserEl.value = localStorage.getItem('maint_live_user') || '';
    if (maintPassEl && !safeTrim(maintPassEl.value || '')) maintPassEl.value = localStorage.getItem('maint_live_pass') || '';
  } catch (_) {}
  if (maintUserEl) maintUserEl.addEventListener('input', updateMaintGuide);
  if (maintPassEl) maintPassEl.addEventListener('input', updateMaintGuide);
  if (btnReload) btnReload.addEventListener('click', function () {
    maintLog('run', 'Atualizacao manual iniciada.');
    refreshFromApi()
      .catch(function () { /* ignora */ })
      .finally(function () {
        if (maintPingWsConnected) {
          scheduleVisiblePingHint(true);
          try { maintPingWs && maintPingWs.send(JSON.stringify({ type: 'snapshot' })); } catch (_) {}
        } else {
          // forca um sweep completo para acertar contadores rapidamente
          __didFullSweep = false;
          scheduleNextPing(0);
        }
        maintLog('ok', 'Atualizacao manual concluida.');
      });
  });

  // auto refresh so atualiza imagens (etapa 2); por enquanto so recarrega dados
  let intervalId = null;
  function setAutoRefresh(ms) {
    if (intervalId) { clearInterval(intervalId); intervalId = null; }
    if (!ms) return;
    intervalId = setInterval(function () {
      // Etapa 1: apenas re-render a partir do cache para refletir busca/filtro
      renderFromCache();
    }, ms);
  }
  if (refreshEl) {
    refreshEl.addEventListener('change', function () {
      const v = safeTrim(refreshEl.value);
      const ms = v ? parseInt(v, 10) : 0;
      setAutoRefresh(isFinite(ms) ? ms : 0);
      maintLog('info', 'Auto-atualizar ajustado para ' + (v || 'off') + '.');
    });
  }

  if (!__maintenanceShortcutsBound) {
    __maintenanceShortcutsBound = true;
    document.addEventListener('keydown', function (ev) {
      try {
        if (!byId('maintenance-grid')) return;
        if (!ev || !ev.altKey || ev.ctrlKey || ev.metaKey) return;
        const target = ev.target;
        const tag = target && target.tagName ? String(target.tagName).toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || tag === 'select' || (target && target.isContentEditable)) return;

        const key = String(ev.key || '').toLowerCase();
        if (key === 'a') {
          ev.preventDefault();
          selectAllRenderedCams();
          maintLog('info', 'Atalho ALT+A: selecionar visiveis.');
          return;
        }
        if (key === 'o') {
          ev.preventDefault();
          selectRenderedCamsByStatus('online');
          maintLog('info', 'Atalho ALT+O: selecionar online.');
          return;
        }
        if (key === 'l') {
          ev.preventDefault();
          clearMaintSelection();
          maintLog('info', 'Atalho ALT+L: limpar selecao.');
          return;
        }
        if (key === 'b') {
          ev.preventDefault();
          if (__maintSelected && __maintSelected.size > 0) openModal(activeTab);
          else maintLog('warn', 'Atalho ALT+B ignorado: nenhuma camera selecionada.');
          return;
        }
        if (key === 'u') {
          ev.preventDefault();
          if (btnReload) btnReload.click();
        }
      } catch (_) {}
    });
  }

  // =========================
  // Loop leve: countdown + ping durante reboot
  // =========================
  let lastPingAt = 0;
  function updateRebootUI() {
    function escAttr(s) {
      // IPs normalmente sao "10.0.0.1" e nao precisam de escape, mas mantemos seguro
      try {
        return (window.CSS && typeof CSS.escape === 'function') ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
      } catch (_) {
        return String(s).replace(/"/g, '\\"');
      }
    }
    const map = getRebootMap();
    const ips = Object.keys(map || {});
    const now = Date.now();

    // Atualiza textos de botao/pills (1x por segundo)
    ips.forEach(function (ip) {
      const rem = getRebootRemainingSeconds(ip);
      const eip = escAttr(ip);
      // item de menu "Reiniciar" (no )
      const btn = grid.querySelector('.maint-menu .menu-item.danger[data-ip="' + eip + '"]');
      const pill = grid.querySelector('.maint-pill[data-ip="' + eip + '"]');

      if (rem > 0) {
        if (btn) {
          btn.disabled = true;
          btn.textContent = 'Reiniciar (reiniciando ' + rem + 's)';
        }
        if (pill) {
          pill.className = 'maint-pill warn';
          pill.textContent = 'REINICIANDO';
        }
      } else {
        // expirou: libera botao e para de marcar como reiniciando
        clearRebooting(ip);
        if (btn) {
          btn.disabled = false;
          btn.textContent = 'Reiniciar';
        }
        // pill: usa ultimo ping se tiver; senao mantem o texto atual
        if (pill) {
          const pc = pingCache[ip];
          if (pc) {
            pill.className = 'maint-pill ' + (pc.online ? 'ok' : 'bad');
            pill.textContent = pc.online ? 'ONLINE' : 'OFFLINE';
          } else {
            pill.className = 'maint-pill';
            pill.textContent = '';
          }
        }
      }
    });

    // Ping apenas durante reboot (a cada 5s)
    if (ips.length && (now - lastPingAt) > 5000) {
      lastPingAt = now;
      ips.forEach(function (ip) {
        pingCamera(ip)
          .then(function (pc) {
            // Se voltou online antes do fim do timer, encerra reboot
            if (pc && pc.online) {
              clearRebooting(ip);
            }
          })
          .catch(function () { /* ignora */ });
      });
    }
  }

  // loop 1s (bem leve)
  setInterval(updateRebootUI, 1000);
  updateMaintGuide();
  maintLog('info', 'Operacoes pronta. Atalhos: ALT+A visiveis, ALT+O online, ALT+L limpar, ALT+B abrir lote, ALT+U atualizar.');
}

function initMaintenanceHandlers() {
  if (!byId('maintenance-grid')) return;
  // fecha menus ao clicar fora (1x)
  if (!__maintenanceMenuGlobalBound) {
    __maintenanceMenuGlobalBound = true;
    document.addEventListener('click', function () {
      closeAllMaintenanceMenus(null);
    });
    document.addEventListener('keydown', function (e) {
      if (e && e.key === 'Escape') closeAllMaintenanceMenus(null);
    });
  }
  loadMaintenance();
}
function initScanForm() {
  const form = byId('scan-form');
  if (!form) return;

  form.addEventListener('submit', function (e) { e.preventDefault(); });
  form.addEventListener('submit', runScan);

  const optReuse = byId('opt-reuse');
  const targetEl = byId('target');
  const userEl   = byId('user');
  const passEl   = byId('password');
  const optSnap  = byId('opt-snapshot');

  function syncReuseMode() {
    const reuse = !!(optReuse && optReuse.checked);

    // campos
    if (targetEl) {
      targetEl.required = !reuse;
      targetEl.disabled = reuse;
    }

    if (userEl) {
      userEl.required = !reuse;
      userEl.disabled = reuse;
    }

    if (passEl) {
      passEl.required = !reuse;
      passEl.disabled = reuse;
    }

    // snapshot nao faz sentido em reuse
    if (optSnap) {
      if (reuse) optSnap.checked = false;
      optSnap.disabled = reuse;
    }

    //  BOTO INICIAR VARREDURA
    const btnRun = byId('btn-run');
    if (btnRun) {
      btnRun.disabled = reuse;
      btnRun.style.opacity = reuse ? '0.5' : '';
      btnRun.style.cursor = reuse ? 'not-allowed' : '';
    }
  }

  if (optReuse) {
    optReuse.addEventListener('change', syncReuseMode);
    syncReuseMode();
  }

  [
    'target',
    'user',
    'password',
    'opt-snapshot',
    'opt-imgbb',
    'opt-excel',
    'opt-reuse',
    'opt-olt-enrich',
    'opt-switch-enrich',
    'opt-kmz',
    'opt-ia',
    'opt-nat-mode',
    'opt-set-local',
    'local-name'
  ].forEach(function (id) {
    const el = byId(id);
    if (!el) return;
    el.addEventListener('input', renderScanConsolePreview);
    el.addEventListener('change', renderScanConsolePreview);
  });
  renderScanConsolePreview();
}

/* =========================
   ImgBB settings (inline)
   - Aparece quando opt-imgbb e opt-reuse estao marcados
   ========================= */
function initImgBBSettingsInline() {
  const optImgBB = byId('opt-imgbb');
  const optReuse = byId('opt-reuse');
  const panel = byId('imgbb-settings-panel');
  if (!optImgBB || !optReuse || !panel) return;

  const viewConfigured = byId('imgbb-settings-view-configured');
  const viewEdit = byId('imgbb-settings-view-edit');
  const pill = byId('imgbb-configured-pill');
  const maskedEl = byId('imgbb-key-masked');
  const statusEl = byId('imgbb-settings-status');
  const inputEl = byId('imgbb-api-key');
  const btnSave = byId('btn-imgbb-save');
  const btnTest = byId('btn-imgbb-test');
  const btnEdit = byId('btn-imgbb-edit');

  let busy = false;

  function setBusy(on) {
    busy = !!on;
    if (btnSave) btnSave.disabled = busy;
    if (btnTest) btnTest.disabled = busy;
    if (btnEdit) btnEdit.disabled = busy;
  }

  function showEdit() {
    if (viewConfigured) viewConfigured.style.display = 'none';
    if (viewEdit) viewEdit.style.display = '';
    if (pill) pill.style.display = 'none';
    if (statusEl) statusEl.textContent = '';
    if (inputEl) inputEl.value = '';
  }

  function showConfigured(masked) {
    if (viewConfigured) viewConfigured.style.display = '';
    if (viewEdit) viewEdit.style.display = 'none';
    if (pill) pill.style.display = '';
    if (maskedEl) maskedEl.textContent = masked || '****';
    if (statusEl) statusEl.textContent = '';
  }

  function showNotConfigured() {
    if (viewConfigured) viewConfigured.style.display = 'none';
    if (viewEdit) viewEdit.style.display = '';
    if (pill) pill.style.display = 'none';
  }

  function renderPanelFromState(s) {
    const configured = !!(s && s.configured);
    if (configured) {
      showConfigured(s.masked || '****');
    } else {
      showNotConfigured();
    }
  }

  function loadState() {
    setBusy(true);
    return fetch('/api/settings/imgbb')
      .then(function (r) { return r.json(); })
      .then(function (data) {
        renderPanelFromState(data);
      })
      .catch(function () {
        // se der erro, deixa em modo edicao (melhor UX)
        showNotConfigured();
      })
      .finally(function () { setBusy(false); });
  }

  function syncVisibility() {
    const shouldShow = !!(optImgBB.checked && optReuse.checked);
    panel.style.display = shouldShow ? '' : 'none';
    if (shouldShow) loadState();
  }

  function postJson(url, payload) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }).then(function (r) { return r.json(); });
  }

  function setStatus(msg) {
    if (!statusEl) return;
    statusEl.innerHTML = msg || '';
  }

  function handleTest() {
    if (!inputEl) return;
    const key = safeTrim(inputEl.value);
    if (!key) {
      setStatus('Informe a API key do ImgBB.');
      return;
    }
    setBusy(true);
    setStatus('Testando...');
    postJson('/api/settings/imgbb/test', { api_key: key })
      .then(function (res) {
        if (res && res.ok) {
          setStatus(' API key valida.');
        } else {
          setStatus(' Falha ao validar: ' + (res && res.message ? res.message : 'erro desconhecido'));
        }
      })
      .catch(function () {
        setStatus(' Falha ao validar (erro de rede).');
      })
      .finally(function () { setBusy(false); });
  }

  function handleSave() {
    if (!inputEl) return;
    const key = safeTrim(inputEl.value);
    if (!key) {
      setStatus('Informe a API key do ImgBB.');
      return;
    }
    setBusy(true);
    setStatus('Salvando...');
    postJson('/api/settings/imgbb', { api_key: key, validate: true })
      .then(function (res) {
        if (res && res.ok) {
          setStatus(' Salvo com sucesso.');
          // Atualiza painel
          loadState();
        } else {
          setStatus(' Nao foi possível salvar: ' + (res && res.message ? res.message : 'erro desconhecido'));
        }
      })
      .catch(function () {
        setStatus(' Nao foi possível salvar (erro de rede).');
      })
      .finally(function () { setBusy(false); });
  }

  if (btnEdit) btnEdit.addEventListener('click', function () { showEdit(); });
  if (btnTest) btnTest.addEventListener('click', function () { if (!busy) handleTest(); });
  if (btnSave) btnSave.addEventListener('click', function () { if (!busy) handleSave(); });

  optImgBB.addEventListener('change', syncVisibility);
  optReuse.addEventListener('change', syncVisibility);

  syncVisibility();
}

function initInventoryHandlers() {
  const btnClear  = byId('btn-inv-clear');
  const btnImgBB  = byId('btn-inv-imgbb');
  const btnPdf    = byId('btn-inv-pdf');
  const btnPdfPreview = byId('btn-inv-pdf-preview');
  const btnEdit   = byId('btn-inv-edit');
  const btnSave   = byId('btn-inv-save');
  const btnDelete = byId('btn-inv-delete');
  const btnCancel = byId('btn-inv-cancel');
  const selectAll = byId('inv-select-all');
  // Botao compacto de backup (menu)
  const btnBackup = byId('btn-inv-backup');
  const backupMenu = byId('inv-backup-menu');
  const btnFullExport = byId('btn-full-export');
  const btnFullImport = byId('btn-full-import');
  const fullImportFile = byId('full-import-file');
  const pdfBackdrop = byId('pdf-report-backdrop');
  const pdfClose = byId('pdf-report-close');
  const pdfUploadLogo = byId('btn-pdf-report-logo-upload');
  const pdfPickLogo = byId('btn-pdf-report-logo-pick');
  const pdfRefresh = byId('btn-pdf-report-refresh');
  const pdfDownload = byId('btn-pdf-report-download');
  const pdfLogoFile = byId('pdf-report-logo-file');
  const pdfLogoName = byId('pdf-report-logo-name');
  const pdfColor = byId('pdf-report-color');
  const pdfColorText = byId('pdf-report-color-text');

  // Toggle do campo "Local" (scan)
  const optSetLocal = byId('opt-set-local');
  const localField = byId('local-field');
  if (optSetLocal && localField) {
    const syncLocalField = () => {
      localField.style.display = optSetLocal.checked ? 'block' : 'none';
    };
    syncLocalField();
    optSetLocal.addEventListener('change', syncLocalField);
  }

  // Atualizar inventario (somente se reuse marcado)
  const btnUpdate = byId('btn-refresh-inventory-left');
  const optReuse  = byId('opt-reuse');
  if (btnUpdate && optReuse) {
    btnUpdate.disabled = !optReuse.checked;
    optReuse.addEventListener('change', function () {
      btnUpdate.disabled = !optReuse.checked;
    });
    btnUpdate.addEventListener('click', function (e) {
      e.preventDefault();
      runInventoryUpdateClick(e);
    });
  }

  if (btnClear) btnClear.addEventListener('click', function (e) {
    e.preventDefault();
    if (inventoryEditing) return;
    clearInventory();
  });

  if (btnImgBB) btnImgBB.addEventListener('click', function (e) {
    e.preventDefault();
    if (inventoryEditing) return;
    uploadInventoryImgBB();
  });

  if (btnPdf) btnPdf.addEventListener('click', function (e) {
    e.preventDefault();
    if (inventoryEditing) return;
    exportInventoryPdfReport();
  });
  if (btnPdfPreview) btnPdfPreview.addEventListener('click', function (e) {
    e.preventDefault();
    if (inventoryEditing) return;
    openInventoryPdfPreview();
  });
  if (pdfClose) pdfClose.addEventListener('click', closeInventoryPdfPreview);
  if (pdfBackdrop) {
    pdfBackdrop.addEventListener('click', function (ev) {
      if (ev && ev.target === pdfBackdrop) closeInventoryPdfPreview();
    });
  }
  if (pdfRefresh) pdfRefresh.addEventListener('click', function (e) {
    e.preventDefault();
    refreshInventoryPdfPreview();
  });
  if (pdfPickLogo && pdfLogoFile) {
    pdfPickLogo.addEventListener('click', function (e) {
      e.preventDefault();
      pdfLogoFile.click();
    });
  }
  if (pdfLogoFile) {
    pdfLogoFile.addEventListener('change', function () {
      const f = (pdfLogoFile.files && pdfLogoFile.files[0]) ? pdfLogoFile.files[0] : null;
      if (pdfLogoName) pdfLogoName.textContent = f ? String(f.name) : 'Nenhum arquivo';
    });
  }
  if (pdfColor && pdfColorText) {
    pdfColor.addEventListener('input', function () {
      pdfColorText.value = normalizeReportColor(pdfColor.value);
    });
    pdfColorText.addEventListener('change', function () {
      const color = normalizeReportColor(pdfColorText.value);
      pdfColorText.value = color;
      pdfColor.value = color;
    });
  }
  if (pdfDownload) pdfDownload.addEventListener('click', function (e) {
    e.preventDefault();
    saveInventoryPdfSettings().then(function () { exportInventoryPdfReport(); });
  });
  if (pdfUploadLogo && pdfLogoFile) {
    pdfUploadLogo.addEventListener('click', async function (e) {
      e.preventDefault();
      const status = byId('pdf-report-status');
      const f = (pdfLogoFile.files && pdfLogoFile.files[0]) ? pdfLogoFile.files[0] : null;
      if (!f) {
        if (status) status.textContent = 'Escolha um arquivo de logo primeiro.';
        return;
      }
      const form = new FormData();
      form.append('file', f);
      if (status) status.textContent = 'Enviando logo...';
      try {
        const r = await fetch('/api/inventory/report/logo', { method: 'POST', body: form });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j || j.ok !== true) {
          throw new Error((j && (j.detail || j.error)) || ('HTTP ' + r.status));
        }
        if (status) status.textContent = 'Logo enviada com sucesso.';
        await refreshInventoryPdfPreview();
      } catch (err) {
        if (status) status.textContent = 'Erro no upload da logo: ' + ((err && err.message) ? err.message : err);
      }
    });
  }

  // Menu do botao "Backup"
  if (btnBackup && backupMenu) {
    btnBackup.addEventListener('click', function (e) {
      e.preventDefault();
      if (inventoryEditing) return;
      const isOpen = backupMenu.style.display !== 'none';
      backupMenu.style.display = isOpen ? 'none' : 'block';
    });

    // Fecha ao clicar fora
    document.addEventListener('click', function (evt) {
      if (!backupMenu) return;
      const wrap = byId('inv-backup-wrap');
      if (!wrap) return;
      if (wrap.contains(evt.target)) return;
      backupMenu.style.display = 'none';
    });
  }

  if (btnFullExport) btnFullExport.addEventListener('click', function (e) {
    e.preventDefault();
    if (inventoryEditing) return;
    if (backupMenu) backupMenu.style.display = 'none';
    exportFullBackupZip();
  });

  if (btnFullImport && fullImportFile) {
    btnFullImport.addEventListener('click', function (e) {
      e.preventDefault();
      if (inventoryEditing) return;
      if (backupMenu) backupMenu.style.display = 'none';
      fullImportFile.value = '';
      fullImportFile.click();
    });
    fullImportFile.addEventListener('change', function () {
      const f = (fullImportFile.files && fullImportFile.files[0]) ? fullImportFile.files[0] : null;
      if (!f) return;
      importFullBackupZip(f);
    });
  }

  // Import/Export de inventario (JSON) removidos da UI para nao poluir a tela.

  if (btnEdit) btnEdit.addEventListener('click', function (e) {
    e.preventDefault();
    if (inventoryEditing) return;
    enterInventoryEditMode();
  });

  if (btnSave) btnSave.addEventListener('click', function (e) {
    e.preventDefault();
    if (!inventoryEditing) return;
    saveInventoryEdits();
  });

  if (btnDelete) btnDelete.addEventListener('click', function (e) {
    e.preventDefault();
    if (!inventoryEditing) return;
    deleteInventorySelected();
  });

  if (btnCancel) btnCancel.addEventListener('click', function (e) {
    e.preventDefault();
    if (!inventoryEditing) return;
    cancelInventoryEdits();
  });

  if (selectAll) selectAll.addEventListener('change', function (e) {
    const checked = !!e.target.checked;
    const tbody = byId('inventory-body') || $('#inv-table tbody');
    const visibleBoxes = getVisibleInventorySelectionCheckboxes();
    visibleBoxes.forEach(function (cb) { cb.checked = checked; });
    if (tbody) Array.from(tbody.querySelectorAll('tr[data-ip]')).forEach(function (row) {
      if (!isInventoryRowVisible(row)) {
        const cb = row.querySelector('input.inv-select[type="checkbox"]');
        if (cb) cb.checked = false;
      }
    });
    syncInventorySelectAllState();
  });

  document.addEventListener('change', function (e) {
    const target = e && e.target;
    if (!target || !target.matches || !target.matches('#inventory-body input.inv-select[type="checkbox"], #inv-table tbody input.inv-select[type="checkbox"]')) return;
    syncInventorySelectAllState();
  });

  // filtro
  const invFilterEl = byId('inventory-filter');
  if (invFilterEl) {
    invFilterEl.addEventListener('change', function () {
      inventoryFilterMode = safeTrim(invFilterEl.value) || 'all';
      applyInventoryFilterDom();
    });
  }
}

function initOltHandlers() {
  const macSearchEl = byId('olt-mac-search');
  const siteFilterEl = byId('olt-site-filter');
  if (macSearchEl) {
    macSearchEl.addEventListener('input', function () {
      applyOltMacFilter();
    });
  }
  if (siteFilterEl) {
    siteFilterEl.addEventListener('change', function () {
      applyOltMacFilter();
    });
  }

  // Modelo da OLT (8820i/4840e) -> ajusta lista de PON
  const modelEl = byId('olt-model');
  if (modelEl) {
    modelEl.addEventListener('change', function () { refreshOltPonOptions(); });
    // inicializa
    setTimeout(refreshOltPonOptions, 50);
  }
  const btnMacs = byId('btn-olt-macs');
  if (btnMacs) btnMacs.addEventListener('click', function (e) {
    e.preventDefault();
    oltCollectMacsWSLegacy();
  });

  const btnClear = byId('btn-olt-clear');
  if (btnClear) btnClear.addEventListener('click', function (e) {
    e.preventDefault();
    const selectedSite = safeTrim((siteFilterEl && siteFilterEl.value) || '');
    const msg = selectedSite
      ? ('Apagar tabela OLT?\nSite: ' + selectedSite + '\nEscopo: somente este site.')
      : 'Apagar tabela OLT?\nSite: Todos os sites\nEscopo: todos os sites.';
    if (!confirm(msg)) return;
    const url = selectedSite ? ('/api/olt/clear?site=' + encodeURIComponent(selectedSite)) : '/api/olt/clear';
    fetch(url, { method: 'POST' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (o) {
        if (!o.ok || !o.j || o.j.ok !== true) throw new Error('Falha ao apagar tabela OLT');
        if (macSearchEl) macSearchEl.value = '';
        if (!selectedSite && siteFilterEl) siteFilterEl.value = '';
        if (selectedSite) {
          loadPersistedOltRows().then(function () { applyOltMacFilter(); });
          const statusEl = byId('olt-status');
          if (statusEl) statusEl.textContent = 'Tabela OLT do site "' + selectedSite + '" apagada do banco.';
          return;
        }
        clearOltUi();
        oltClearCache();
        hideOltDoneBanner();
        hideOltAuthErrorBanner();
        const statusEl = byId('olt-status');
        if (statusEl) statusEl.textContent = 'Tabela OLT apagada do banco.';
      })
      .catch(function (err) {
        const statusEl = byId('olt-status');
        if (statusEl) {
          statusEl.textContent = 'Erro ao apagar tabela OLT: ' + ((err && err.message) ? err.message : err);
          statusEl.style.color = '#f97373';
        }
      });
  });

  // banners OLT
  const doneBanner = byId('olt-done-banner');
  if (doneBanner) {
    const closeBtn = doneBanner.querySelector('button');
    const closeAndClear = function (ev) {
      if (ev) ev.stopPropagation();
      hideOltDoneBanner();
    };
    doneBanner.onclick = closeAndClear;
    if (closeBtn) closeBtn.onclick = closeAndClear;
  }

  const errBanner = byId('olt-auth-error-banner');
  if (errBanner) {
    const closeBtn = errBanner.querySelector('button');
    const closeAndClear = function (ev) {
      if (ev) ev.stopPropagation();
      hideOltAuthErrorBanner();
    };
    errBanner.onclick = closeAndClear;
    if (closeBtn) closeBtn.onclick = closeAndClear;
  }

  restoreOltFromCache();
  loadPersistedOltRows().then(function () {
    applyOltMacFilter();
  });
}

const SWITCH_CACHE_KEY = 'cam_snapshot_switch_last_v1';

function switchLoadCache() {
  try { return JSON.parse(localStorage.getItem(SWITCH_CACHE_KEY) || 'null'); } catch (_) { return null; }
}
function switchSaveCache(payload) {
  try {
    const base = switchLoadCache() || {};
    localStorage.setItem(SWITCH_CACHE_KEY, JSON.stringify(Object.assign(base, payload || {})));
  } catch (_) {}
}
function switchClearCache() {
  try { localStorage.removeItem(SWITCH_CACHE_KEY); } catch (_) {}
}
function setSwitchProgress(percent, label) {
  const bar = byId('switch-progress-fill');
  const text = byId('switch-progress-label');
  const container = byId('switch-progress');
  if (container) container.setAttribute('aria-hidden', percent > 0 ? 'false' : 'true');
  if (bar) bar.style.width = Math.max(0, Math.min(100, Number(percent) || 0)) + '%';
  if (text) text.textContent = label || '';
}
function switchClearLog() {
  const logEl = byId('switch-log');
  if (logEl) logEl.textContent = '';
}
function switchAppendLog(msg) {
  const logEl = byId('switch-log');
  if (!logEl) return;
  const ts = new Date().toLocaleTimeString();
  logEl.textContent += '[' + ts + '] ' + msg + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}
function applySwitchMacFilter() {
  const input = byId('switch-mac-search');
  const siteEl = byId('switch-site-filter');
  const tbody = $('#switch-macs-table tbody');
  if (!tbody) return;
  const q = safeTrim(input ? input.value : '').toLowerCase();
  const site = safeTrim(siteEl ? siteEl.value : '').toLowerCase();
  Array.from(tbody.querySelectorAll('tr')).forEach(function (tr) {
    const tds = tr.querySelectorAll('td');
    if (!tds || !tds.length) return;
    const onlyCell = (tds.length === 1) ? tds[0] : null;
    if (onlyCell && Number(onlyCell.getAttribute('colspan') || '0') >= 6) {
      tr.style.display = q ? 'none' : '';
      return;
    }
    const txt = String(tr.textContent || '').toLowerCase();
    const rowSite = safeTrim(tr.getAttribute('data-site') || '').toLowerCase();
    tr.style.display = ((!site || rowSite === site) && (!q || txt.includes(q))) ? '' : 'none';
  });
}
function refreshSwitchSiteFilterOptions(rows) {
  const sel = byId('switch-site-filter');
  if (!sel) return;
  const cur = safeTrim(sel.value || '');
  const sites = Array.from(new Set((Array.isArray(rows) ? rows : []).map(r => safeTrim((r && r.site) || '')).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  sel.innerHTML = '<option value="">Todos os sites</option>';
  sites.forEach(function (name) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  });
  if (cur && sites.includes(cur)) sel.value = cur;
}
function renderSwitchRows(rows) {
  const tbody = $('#switch-macs-table tbody');
  if (!tbody) return;
  const list = Array.isArray(rows) ? rows : [];
  refreshSwitchSiteFilterOptions(list);
  if (!list.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="muted">Nenhum MAC coletado ainda.</td></tr>';
    applySwitchMacFilter();
    return;
  }
  tbody.innerHTML = '';
  list.forEach(function (m) {
    const tr = document.createElement('tr');
    tr.setAttribute('data-site', safeTrim(m.site || ''));
    const role = safeTrim(m.port_role_guess || '').toLowerCase();
    const roleClass = role === 'uplink' ? 'switch-role-uplink' : 'switch-role-edge';
    tr.innerHTML = `
      <td>${m.switch_ip || ''}</td>
      <td>${m.switch_name || ''}</td>
      <td><span class="switch-role-badge ${roleClass}">${role || ''}</span></td>
      <td>${m.port || m.switch_port || ''}</td>
      <td>${m.mac || ''}</td>
      <td>${m.vlan || ''}</td>
    `;
    tbody.appendChild(tr);
  });
  applySwitchMacFilter();
}
function restoreSwitchFromCache() {
  const cache = switchLoadCache();
  if (!cache) return;
  const ipEl = byId('switch-ip');
  const siteEl = byId('switch-site');
  const nameEl = byId('switch-name');
  const userEl = byId('switch-user');
  const reuseEl = byId('switch-reuse-json');
  const statusEl = byId('switch-status');
  if (ipEl && cache.switch_ip) ipEl.value = cache.switch_ip;
  if (siteEl && cache.site) siteEl.value = cache.site;
  if (nameEl && cache.switch_name) nameEl.value = cache.switch_name;
  if (userEl && cache.user) userEl.value = cache.user;
  if (reuseEl && typeof cache.reuse_json === 'boolean') reuseEl.checked = cache.reuse_json;
  if (statusEl && cache.status) statusEl.textContent = cache.status;
  if (Array.isArray(cache.rows) && cache.rows.length) renderSwitchRows(cache.rows);
  const logEl = byId('switch-log');
  if (logEl && cache.log) logEl.textContent = String(cache.log);
}
function loadPersistedSwitchRows() {
  const statusEl = byId('switch-status');
  return fetch('/api/switch/rows?_=' + Date.now(), { method: 'GET', cache: 'no-store' })
    .then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok, j: j })))
    .then(o => {
      if (!o.ok || !o.j || o.j.ok !== true) throw new Error('Falha ao carregar base do switch');
      const rows = Array.isArray(o.j.rows) ? o.j.rows : [];
      if (!rows.length) return false;
      renderSwitchRows(rows);
      switchSaveCache({ rows: rows, status: 'Base do switch restaurada do banco (total: ' + rows.length + ').' });
      if (statusEl && safeTrim(statusEl.textContent) === 'Pronto para coletar dados do switch.') {
        statusEl.textContent = 'Base do switch restaurada do banco (total: ' + rows.length + ').';
      }
      return true;
    })
    .catch(() => false);
}
function clearSwitchForm() {
  const ipEl = byId('switch-ip');
  const siteEl = byId('switch-site');
  const nameEl = byId('switch-name');
  const userEl = byId('switch-user');
  const passEl = byId('switch-password');
  const statusEl = byId('switch-status');
  if (ipEl) ipEl.value = '';
  if (siteEl) siteEl.value = '';
  if (nameEl) nameEl.value = '';
  if (userEl) userEl.value = 'admin';
  if (passEl) passEl.value = '';
  [ipEl, siteEl, nameEl, userEl, passEl].forEach(function (el) {
    if (el) el.style.borderColor = 'var(--border-subtle)';
  });
  if (statusEl) { statusEl.textContent = 'Pronto para coletar dados do switch.'; statusEl.style.color = ''; }
  setSwitchProgress(0, '');
}
function clearSwitchUi() {
  clearSwitchForm();
  switchClearLog();
  renderSwitchRows([]);
}
function showSwitchDoneBanner() { const el = byId('switch-done-banner'); if (el) el.style.display = 'flex'; }
function hideSwitchDoneBanner() { const el = byId('switch-done-banner'); if (el) el.style.display = 'none'; clearSwitchForm(); }
function showSwitchAuthErrorBanner() { const el = byId('switch-auth-error-banner'); if (el) el.style.display = 'flex'; }
function hideSwitchAuthErrorBanner() { const el = byId('switch-auth-error-banner'); if (el) el.style.display = 'none'; clearSwitchForm(); }
function loadSwitchMacsTable(switchIp, user, pass, siteName, switchName) {
  const statusEl = byId('switch-status');
  const tbody = $('#switch-macs-table tbody');
  const reuseJson = !!(byId('switch-reuse-json') && byId('switch-reuse-json').checked);
  setSwitchProgress(70, 'Carregando MACs do switch...');
  if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="muted">Carregando MACs...</td></tr>';
  return fetch('/api/switch/collect-macs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      switch_ip: switchIp,
      user: user,
      password: pass,
      site: (siteName || ''),
      switch_name: (switchName || ''),
      reuse_json: reuseJson
    })
  })
    .then(res => {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json().catch(() => ({}));
    })
    .then(data => {
      const rows = data.rows_all || data.rows || [];
      renderSwitchRows(rows);
      switchAppendLog('Switch: ' + (data.system?.product_name || switchIp));
      switchAppendLog('Firmware: ' + (data.system?.software_version || ''));
      switchAppendLog('MACs coletados: ' + rows.length);
      if (statusEl) statusEl.textContent = 'Base do switch atualizada (total salvo: ' + rows.length + ').';
      setSwitchProgress(100, 'MACs do switch coletados com sucesso.');
      switchSaveCache({
        switch_ip: switchIp,
        switch_name: switchName,
        user: user,
        site: (siteName || ''),
        reuse_json: reuseJson,
        status: 'MACs do switch coletados com sucesso (total: ' + rows.length + ').',
        rows: rows,
        log: (byId('switch-log') && byId('switch-log').textContent) || '',
      });
      showSwitchDoneBanner();
    })
    .catch(err => {
      console.error(err);
      if (statusEl) {
        statusEl.textContent = 'Erro ao coletar MACs do switch. Verifique IP/usuario/senha.';
        statusEl.style.color = '#f97373';
      }
      if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="muted">Erro ao coletar MACs.</td></tr>';
      setSwitchProgress(0, 'Erro ao coletar MACs do switch.');
      showSwitchAuthErrorBanner();
    });
}
function switchCollectMacs() {
  const ipEl = byId('switch-ip');
  const siteEl = byId('switch-site');
  const nameEl = byId('switch-name');
  const userEl = byId('switch-user');
  const passEl = byId('switch-password');
  const statusEl = byId('switch-status');
  [ipEl, siteEl, nameEl, userEl, passEl].forEach(function (el) { if (el) el.style.borderColor = 'var(--border-subtle)'; });
  const switchIp = safeTrim(ipEl?.value);
  const siteName = safeTrim(siteEl?.value);
  const switchName = safeTrim(nameEl?.value);
  const user = safeTrim(userEl?.value) || 'admin';
  const pass = passEl ? passEl.value : '';
  const missing = [];
  if (!switchIp) missing.push('IP');
  if (!user) missing.push('Usuario');
  if (!pass) missing.push('Senha');
  if (missing.length) {
    if (!switchIp && ipEl) ipEl.style.borderColor = '#f97373';
    if (!user && userEl) userEl.style.borderColor = '#f97373';
    if (!pass && passEl) passEl.style.borderColor = '#f97373';
    if (statusEl) { statusEl.textContent = 'Preencha: ' + missing.join(', '); statusEl.style.color = '#f97373'; }
    return;
  }
  switchClearLog();
  switchAppendLog('Conectando ao switch ' + switchIp + (siteName ? (' [site: ' + siteName + ']') : '') + '...');
  if (statusEl) { statusEl.textContent = 'Conectando no switch ' + switchIp + '...'; statusEl.style.color = ''; }
  setSwitchProgress(25, 'Conectando ao switch...');
  loadSwitchMacsTable(switchIp, user, pass, siteName, switchName);
}
function initSwitchHandlers() {
  const searchEl = byId('switch-mac-search');
  const siteFilterEl = byId('switch-site-filter');
  if (searchEl) searchEl.addEventListener('input', function () { applySwitchMacFilter(); });
  if (siteFilterEl) siteFilterEl.addEventListener('change', function () { applySwitchMacFilter(); });
  const btnMacs = byId('btn-switch-macs');
  if (btnMacs) btnMacs.addEventListener('click', function (e) { e.preventDefault(); switchCollectMacs(); });
  const btnClear = byId('btn-switch-clear');
  if (btnClear) btnClear.addEventListener('click', function (e) {
    e.preventDefault();
    const selectedSite = safeTrim((siteFilterEl && siteFilterEl.value) || '');
    const msg = selectedSite
      ? ('Apagar tabela do switch?\nSite: ' + selectedSite + '\nEscopo: somente este site.')
      : 'Apagar tabela do switch?\nSite: Todos os sites\nEscopo: todos os sites.';
    if (!confirm(msg)) return;
    const url = selectedSite ? ('/api/switch/clear?site=' + encodeURIComponent(selectedSite)) : '/api/switch/clear';
    fetch(url, { method: 'POST' })
      .then(r => r.json().catch(() => ({})).then(j => ({ ok: r.ok, j: j })))
      .then(function (o) {
        if (!o.ok || !o.j || o.j.ok !== true) throw new Error('Falha ao apagar tabela do switch');
        if (searchEl) searchEl.value = '';
        if (!selectedSite && siteFilterEl) siteFilterEl.value = '';
        if (selectedSite) {
          loadPersistedSwitchRows().then(function () { applySwitchMacFilter(); });
          const statusEl = byId('switch-status');
          if (statusEl) statusEl.textContent = 'Tabela do switch do site "' + selectedSite + '" apagada do banco.';
          return;
        }
        clearSwitchUi();
        switchClearCache();
        hideSwitchDoneBanner();
        hideSwitchAuthErrorBanner();
        const statusEl = byId('switch-status');
        if (statusEl) statusEl.textContent = 'Tabela do switch apagada do banco.';
      })
      .catch(function (err) {
        const statusEl = byId('switch-status');
        if (statusEl) {
          statusEl.textContent = 'Erro ao apagar tabela do switch: ' + ((err && err.message) ? err.message : err);
          statusEl.style.color = '#f97373';
        }
      });
  });
  const doneBanner = byId('switch-done-banner');
  if (doneBanner) {
    const closeBtn = doneBanner.querySelector('button');
    const closeAndClear = function (ev) { if (ev) ev.stopPropagation(); hideSwitchDoneBanner(); };
    doneBanner.onclick = closeAndClear;
    if (closeBtn) closeBtn.onclick = closeAndClear;
  }
  const errBanner = byId('switch-auth-error-banner');
  if (errBanner) {
    const closeBtn = errBanner.querySelector('button');
    const closeAndClear = function (ev) { if (ev) ev.stopPropagation(); hideSwitchAuthErrorBanner(); };
    errBanner.onclick = closeAndClear;
    if (closeBtn) closeBtn.onclick = closeAndClear;
  }
  restoreSwitchFromCache();
  loadPersistedSwitchRows().then(function () { applySwitchMacFilter(); });
}

function initSnapshotHandlers() {
  const form = byId('snapshot-form');
  if (form) form.addEventListener('submit', runSnapshot);

  const saveBtn = byId('snapshot-save-btn');
  if (saveBtn) saveBtn.addEventListener('click', function (e) {
    e.preventDefault();
    downloadSnapshotImage();
  });

  // Banner sucesso Snapshot
  const snapBanner = byId('snapshot-success-banner');
  const snapClose = byId('btn-snapshot-success-close');
  if (snapClose) {
    snapClose.onclick = function (ev) {
      if (ev) ev.stopPropagation();
      hideSnapshotSuccessBanner();
    };
  }
  if (snapBanner) {
    snapBanner.onclick = function () { hideSnapshotSuccessBanner(); };
  }

  // Snapshot: galeria de miniaturas
  loadSnapshotMiniaturas();

  // Modal (miniaturas)
  const modalBackdrop = byId('snapshot-modal-backdrop');
  const modalClose = byId('snapshot-modal-close');
  if (modalBackdrop) {
    modalBackdrop.addEventListener('click', function (ev) {
      if (ev && ev.target === modalBackdrop) modalBackdrop.classList.remove('open');
    });
  }
  if (modalClose) {
    modalClose.addEventListener('click', function () {
      if (modalBackdrop) modalBackdrop.classList.remove('open');
    });
  }

  // Carrossel: botões anterior/próximo + teclado
  const modalPrev = byId('snapshot-modal-prev');
  const modalNext = byId('snapshot-modal-next');
  if (modalPrev) modalPrev.addEventListener('click', function (e) {
    if (e) e.preventDefault();
    openSnapshotModalByIndex(__snapshotCamsIndex - 1);
  });
  if (modalNext) modalNext.addEventListener('click', function (e) {
    if (e) e.preventDefault();
    openSnapshotModalByIndex(__snapshotCamsIndex + 1);
  });

  // Teclas:  /  / Esc (somente quando o modal estiver aberto)
  document.addEventListener('keydown', function (e) {
    if (!modalBackdrop || !modalBackdrop.classList.contains('open')) return;
    if (!e) return;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      openSnapshotModalByIndex(__snapshotCamsIndex - 1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      openSnapshotModalByIndex(__snapshotCamsIndex + 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      modalBackdrop.classList.remove('open');
    }
  });

}


// =========================
// Snapshot: helper (preferir snapshot local em /data/snapshot)
// =========================
function snapshotLocalUrlFromPath(p) {
  if (!p) return '';
  let s = String(p).trim();
  if (!s) return '';
  s = s.replace(/\\/g, '/');

  // ja vem montado pelo backend
  if (s.startsWith('/data/')) return s;

  // se for path absoluto e contiver /data/...
  const m = s.match(/(?:^|\/)data\/(.+)$/i);
  if (m && m[1]) return '/data/' + m[1];

  // se vier só com snapshot/... ou dvr_snapshot/... ou nvr_snapshot/...
  const m2 = s.match(/(?:^|\/)((?:[a-z]+_)?snapshot(?:_manual)?\/.+)$/i);
  if (m2 && m2[1]) return '/data/' + m2[1];

  // fallback: assume que esta em saida/snapshot/<arquivo>
  const base = s.split('/').pop();
  return base ? ('/data/snapshot/' + base) : '';
}

function getSnapshotSource() {
  try {
    const src = safeTrim(document.body && document.body.getAttribute('data-snapshot-source'));
    if (src === 'dvr' || src === 'nvr') return src;
  } catch (_) {}
  return 'cam_ip';
}

// =========================
// Snapshot: Miniaturas (galeria)
// - busca do inventario (snapshot_url / thumb_url)
// - abre modal ao clicar
// =========================
let __snapshotCams = [];
let __snapshotCamsIndex = -1;
let __snapshotMiniLoadedOnce = false;
let __snapshotInvRaw = [];
let __snapshotSource = 'cam_ip';
let __snapshotFilters = { q: '', site: '' };

function normalizeSnapshotStatus(v) {
  const s = safeTrim(v).toLowerCase();
  if (!s) return '';
  if (s.indexOf('online') >= 0 || s === 'up' || s === 'on' || s === 'ok') return 'online';
  if (s.indexOf('offline') >= 0 || s === 'down' || s === 'off' || s.indexOf('sem camera') >= 0) return 'offline';
  return s;
}

function snapshotSiteOf(cam) {
  if (!cam || typeof cam !== 'object') return '';
  return safeTrim(cam.site || cam.site_name || cam.local || cam.LOCAL || '');
}

function ensureSnapshotMiniFiltersUi(source) {
  const pane = byId('snapshot-miniaturas-pane');
  if (!pane) return;
  if (byId('snapshot-mini-filter-q')) return;

  const row = document.createElement('div');
  row.id = 'snapshot-mini-filter-row';
  row.className = 'field-row';
  row.style.marginTop = '4px';
  row.style.marginBottom = '10px';

  row.innerHTML = [
    '<div class="field snapshot-filter-field">',
      '<label for="snapshot-mini-filter-q">Buscar</label>',
      '<input id="snapshot-mini-filter-q" type="text" placeholder="Nome, IP, host, MAC, modelo, status..." />',
    '</div>',
    '<div class="field snapshot-filter-field">',
      '<label for="snapshot-mini-filter-site">Site</label>',
      '<select id="snapshot-mini-filter-site"><option value="">Todos os sites</option></select>',
    '</div>'
  ].join('');

  const sub = pane.querySelector('.card-sub');
  if (sub && sub.parentNode) sub.parentNode.insertBefore(row, sub.nextSibling);
  else pane.insertBefore(row, pane.firstChild);

  const qEl = byId('snapshot-mini-filter-q');
  const siteEl = byId('snapshot-mini-filter-site');
  if (qEl) {
    qEl.addEventListener('input', function () {
      __snapshotFilters.q = safeTrim(qEl.value || '').toLowerCase();
      renderSnapshotMiniaturas();
    });
  }
  if (siteEl) {
    siteEl.addEventListener('change', function () {
      __snapshotFilters.site = safeTrim(siteEl.value || '');
      renderSnapshotMiniaturas();
    });
  }

  loadSnapshotMiniSites(source);
}

function loadSnapshotMiniSites(source) {
  const siteEl = byId('snapshot-mini-filter-site');
  if (!siteEl) return;
  const src = (source === 'dvr' || source === 'nvr') ? source : 'ip';
  fetch('/api/db/sites?source=' + encodeURIComponent(src) + '&_=' + Date.now(), { cache: 'no-store' })
    .then(function (r) { return r.json().catch(function () { return {}; }); })
    .then(function (j) {
      const dbSites = (j && j.ok === true && Array.isArray(j.sites)) ? j.sites : [];
      const merged = new Set();
      dbSites.forEach(function (s) {
        const n = safeTrim((s && s.name) || '');
        if (n) merged.add(n);
      });
      (__snapshotInvRaw || []).forEach(function (cam) {
        const n = snapshotSiteOf(cam);
        if (n) merged.add(n);
      });

      const current = safeTrim(__snapshotFilters.site || siteEl.value || '');
      siteEl.innerHTML = '<option value="">Todos os sites</option>';
      Array.from(merged).sort(function (a, b) { return a.localeCompare(b, 'pt-BR'); }).forEach(function (name) {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        siteEl.appendChild(opt);
      });
      if (current) siteEl.value = current;
    })
    .catch(function () {});
}

function renderSnapshotMiniaturas() {
  const grid = byId('snapshot-miniaturas-grid');
  if (!grid) return;

  const source = __snapshotSource || getSnapshotSource();
  const inv = Array.isArray(__snapshotInvRaw) ? __snapshotInvRaw : [];
  const filterQ = safeTrim(__snapshotFilters.q || '').toLowerCase();
  const filterSite = safeTrim(__snapshotFilters.site || '').toLowerCase();

  let cams = inv.filter(function (c) {
    const url = c.thumb_url || c.snapshot_url || c.imgbb_url || c.snapshot_path || c.snapshot_file;
    return !!safeTrim(url);
  });

  if (filterQ) {
    cams = cams.filter(function (c) {
      const title = safeTrim(c.titulo || c.TITULO || c.title || c.nome || '');
      const ip = safeTrim(c.ip || c.IP || '');
      const host = safeTrim(c.host || '');
      const ch = safeTrim(c.channel || '');
      const mac = safeTrim(c.mac || c.MAC || c.mac_address || c.nvr_mac || c.camera_mac || '');
      const model = safeTrim(c.modelo || c.MODELO || c.model || c.camera_model || '');
      const vendor = safeTrim(c.fabricante || c.FABRICANTE || c.manufacturer || '');
      const status = safeTrim(c.status || '');
      const site = snapshotSiteOf(c);
      const blob = [title, ip, host, ch, mac, model, vendor, status, site].join(' ').toLowerCase();
      return blob.includes(filterQ);
    });
  }
  if (filterSite) {
    cams = cams.filter(function (c) {
      return snapshotSiteOf(c).toLowerCase() === filterSite;
    });
  }

  grid.innerHTML = '';

  cams.sort(function (a, b) {
    if (source === 'cam_ip') {
      return ipToNum(a.ip || a.IP || '') - ipToNum(b.ip || b.IP || '');
    }
    const ah = safeTrim(a.host || a.ip || '');
    const bh = safeTrim(b.host || b.ip || '');
    if (ah < bh) return -1;
    if (ah > bh) return 1;
    const ac = parseInt(a.channel || 0, 10) || 0;
    const bc = parseInt(b.channel || 0, 10) || 0;
    return ac - bc;
  });

  __snapshotCams = cams.map(function (cam) {
    const localSnap = snapshotLocalUrlFromPath(
      cam.snapshot_path || cam.snapshotPath || cam.snapshot_local || cam.local_snapshot || cam.snapshot_file || ''
    );
    const titleRaw = cam.titulo || cam.TITULO || cam.title || cam.nome || 'Camera';
    if (source === 'cam_ip') {
      const ip = cam.ip || cam.IP || '';
      const model = cam.modelo || cam.MODELO || cam.model || '';
      const fab  = cam.fabricante || cam.FABRICANTE || cam.manufacturer || '';
      const mac  = cam.mac || cam.MAC || cam.mac_address || '';
      const urlFull = localSnap || cam.snapshot_url || cam.imgbb_url || '';
      const urlThumb = localSnap || cam.thumb_url || cam.snapshot_url || cam.imgbb_url || '';
      const sub = 'IP: ' + ip + (model ? ('  -  ' + model) : '') + (fab ? ('  -  ' + fab) : '') + (mac ? ('  -  ' + mac) : '');
      return { ip: ip, title: titleRaw, sub: sub, urlFull: urlFull || urlThumb, urlThumb: urlThumb || urlFull };
    }

    const host = safeTrim(cam.host || cam.ip || '');
    const ch = Math.max(1, parseInt(cam.channel || 1, 10) || 1);
    const dvrMac = safeTrim(cam.nvr_mac || cam.mac || '');
    const camIp = safeTrim(cam.camera_ip || '');
    const camModel = safeTrim(cam.camera_model || cam.modelo || cam.model || '');
    const label = (source === 'nvr') ? 'NVR' : 'DVR';
    const title = 'CH ' + String(ch).padStart(2, '0') + ' - ' + titleRaw;
    const urlFull = localSnap || cam.snapshot_url || cam.imgbb_url || '';
    const urlThumb = localSnap || cam.thumb_url || cam.snapshot_url || cam.imgbb_url || '';
    const sub =
      label + ': ' + host +
      '  -  Canal: ' + ch +
      (camIp ? ('  -  IP Cam: ' + camIp) : '') +
      (camModel ? ('  -  Modelo: ' + camModel) : '') +
      (dvrMac ? ('  -  MAC: ' + dvrMac) : '');
    return { ip: host, title: title, sub: sub, urlFull: urlFull || urlThumb, urlThumb: urlThumb || urlFull };
  });

  const countEl = byId('snapshot-miniaturas-count');
  if (countEl) countEl.textContent = String(__snapshotCams.length);

  if (!__snapshotCams.length) {
    const div = document.createElement('div');
    div.className = 'muted';
    div.style.fontSize = '12px';
    div.textContent = 'Nenhuma miniatura encontrada para o filtro selecionado.';
    grid.appendChild(div);
    return;
  }

  __snapshotCams.forEach(function (cam, idx) {
    const ip = cam.ip;
    const title = cam.title;
    const urlThumb = cam.urlThumb;
    const sub = cam.sub;

    const card = document.createElement('div');
    card.className = 'snapshot-thumb-card';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'snapshot-thumb-img-wrapper';

    const img = document.createElement('img');
    img.className = 'snapshot-thumb-img';
    img.loading = 'lazy';
    img.alt = 'Snapshot ' + ip;
    img.src = urlThumb;
    imgWrap.appendChild(img);

    const meta = document.createElement('div');
    meta.className = 'snapshot-thumb-meta';
    meta.innerHTML =
      '<div class="snapshot-thumb-title">' + escapeHtml(title) + '</div>' +
      '<div class="snapshot-thumb-sub">' + escapeHtml(sub) + '</div>';

    card.appendChild(imgWrap);
    card.appendChild(meta);

    card.addEventListener('click', function () {
      openSnapshotModalByIndex(idx);
    });

    grid.appendChild(card);
  });
}

function updateSnapshotMiniCount() {
  const countEl = byId('snapshot-miniaturas-count');
  const grid = byId('snapshot-miniaturas-grid');
  if (!countEl) return;
  if (!grid) { countEl.textContent = '0'; return; }
  const n = grid.querySelectorAll('.snapshot-thumb-card').length;
  countEl.textContent = String(n);
}

function loadSnapshotMiniaturas() {
  if (__snapshotMiniLoadedOnce) {
    ensureSnapshotMiniFiltersUi(__snapshotSource || getSnapshotSource());
    renderSnapshotMiniaturas();
    return;
  }

  const grid = byId('snapshot-miniaturas-grid');
  const empty = byId('snapshot-miniaturas-empty');
  if (!grid) return;

  if (empty) empty.textContent = 'Carregando miniaturas...';

  const source = getSnapshotSource();
  __snapshotSource = source;
  ensureSnapshotMiniFiltersUi(source);
  const endpoint = (source === 'dvr')
    ? '/api/dvr/inventory'
    : (source === 'nvr' ? '/api/nvr/inventory' : '/api/inventory-last');

  fetch(endpoint)
    .then(function (resp) { return resp.json().catch(function () { return {}; }); })
    .then(function (data) {
      __snapshotMiniLoadedOnce = true;
      const inv = (data && data.ok === true && Array.isArray(data.inventory)) ? data.inventory : [];
      __snapshotInvRaw = inv.slice();

      //  Salva cache do inventario tambem (para a aba Inventory nao "sumir" ao navegar)
      try {
        localStorage.setItem('cam_snapshot_inventory_last_v1', JSON.stringify({ ts: Date.now(), inventory: inv }));
      } catch (_) {}
      loadSnapshotMiniSites(source);
      renderSnapshotMiniaturas();
    })
    .catch(function (e) {
      console.error('Erro ao carregar miniaturas:', e);
      if (empty) empty.textContent = 'Erro ao carregar miniaturas.';
    });
}

// =========================
// Snapshot modal: carrossel (próximo/anterior)
// =========================
function openSnapshotModalByIndex(i) {
  const modalBackdrop = byId('snapshot-modal-backdrop');
  if (!modalBackdrop) return;
  if (!Array.isArray(__snapshotCams) || !__snapshotCams.length) return;

  // wrap
  let idx = Number(i);
  if (!Number.isFinite(idx)) idx = 0;
  if (idx < 0) idx = __snapshotCams.length - 1;
  if (idx >= __snapshotCams.length) idx = 0;

  __snapshotCamsIndex = idx;
  const cam = __snapshotCams[__snapshotCamsIndex];
  openSnapshotModal({
    title: cam.title || 'Camera',
    sub: cam.sub || '',
    url: cam.urlFull || cam.urlThumb || ''
  });

  updateSnapshotModalNavState();
}

function updateSnapshotModalNavState() {
  const prev = byId('snapshot-modal-prev');
  const next = byId('snapshot-modal-next');
  const many = Array.isArray(__snapshotCams) && __snapshotCams.length > 1;
  if (prev) prev.disabled = !many;
  if (next) next.disabled = !many;
}

function openSnapshotModal(opts) {
  const modalBackdrop = byId('snapshot-modal-backdrop');
  const titleEl = byId('snapshot-modal-title');
  const subEl = byId('snapshot-modal-sub');
  const imgEl = byId('snapshot-modal-image');
  if (!modalBackdrop || !imgEl) return;

  if (titleEl) titleEl.textContent = opts && opts.title ? String(opts.title) : 'Camera';
  if (subEl) subEl.textContent = opts && opts.sub ? String(opts.sub) : '';
  imgEl.src = (opts && opts.url) ? String(opts.url) : '';
  modalBackdrop.classList.add('open');
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* =========================
   SCRIPTS  Netwatch (Mikrotik)
   - payload compatível com API:
     { token, chat, interval, timeout }
   - resposta compatível:
     { success, cameras, script, stdout, stderr, error }
   ========================= */
function runNetwatchGenerate(evt) {
  if (evt) evt.preventDefault();

  const btn = byId('btn-netwatch');
  const logEl = byId('log-netwatch');
  const tokenEl = byId('script-token');
  const chatEl = byId('script-chat');
  const intEl = byId('script-interval');
  const toutEl = byId('script-timeout');
  const siteEl = byId('script-site');

  if (!tokenEl || !chatEl || !logEl) return;

  const token = safeTrim(tokenEl.value);
  const chat = safeTrim(chatEl.value);
  const interval = safeTrim(intEl ? intEl.value : '1m') || '1m';
  const timeout = safeTrim(toutEl ? toutEl.value : '2s') || '2s';
  const site = safeTrim(siteEl ? siteEl.value : '');

  if (!token || !chat) {
    logEl.textContent = 'Informe TOKEN do Telegram e CHAT ID.\n';
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Gerando...';
  }

  logEl.textContent = 'Gerando script Netwatch com o inventario atual...\n';

  fetch('/api/scripts/netwatch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: token,
      chat: chat,
      interval: interval,
      timeout: timeout,
      site: site
    })
  })
    .then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        return { resp: resp, data: data };
      });
    })
    .then(function (r) {
      const resp = r.resp;
      const data = r.data || {};

      // API usa success (bool) e error (string)
      const ok = (resp.ok && data.success === true);

      if (!ok) {
        const err = data.error || data.message || ('HTTP ' + resp.status);
        logEl.textContent += '\n[ERRO] ' + err + '\n';
        showBanner('error', err);
        return;
      }

      const cameras = (data.cameras != null) ? data.cameras : '-';

      logEl.textContent += '[OK] Script gerado. Site: ' + (site || 'Todos os sites') + ' | Cameras: ' + cameras + '\n';

      if (data.stderr) {
        logEl.textContent += '\n[STDERR]\n' + String(data.stderr) + '\n';
      }
      if (data.stdout) {
        logEl.textContent += '\n[STDOUT]\n' + String(data.stdout) + '\n';
      }

      if (data.script) {
        logEl.textContent += '\n===== netwatch_setup.rsc =====\n';
        logEl.textContent += String(data.script) + '\n';
      } else if (data.script_error) {
        logEl.textContent += '\n[WARN] ' + String(data.script_error) + '\n';
      } else {
        logEl.textContent += '\n(Sem conteudo retornado pelo backend)\n';
      }

      //  banner verde na aba Scripts
      showScriptsSuccessBanner('? <strong>Script gerado.</strong> Cameras: ' + cameras);
      const downloadBtn = byId('btn-netwatch-download');
      if (downloadBtn) {
        downloadBtn.dataset.downloadUrl = data.download_url || (site ? ('/api/scripts/netwatch/download?site=' + encodeURIComponent(site)) : '/api/scripts/netwatch/download');
        downloadBtn.style.display = 'inline-flex';
      }
    })
    .catch(function (e) {
      console.error(e);
      logEl.textContent += '\n[EXCEPTION] ' + e + '\n';
      showBanner('error', 'Erro de comunicacao com a API');
    })
    .finally(function () {
      if (btn) {
        btn.disabled = false;
        btn.textContent = 'Gerar script Netwatch (.rsc)';
      }
    });
}

function initScriptsHandlers() {

  // botao gerar
  const btn = byId('btn-netwatch');
  if (btn) btn.addEventListener('click', runNetwatchGenerate);
  const btnDownload = byId('btn-netwatch-download');
  if (btnDownload) btnDownload.addEventListener('click', downloadNetwatchFile);

  // banner scripts: fechar esconde apenas o aviso; download continua disponivel.
  const b = byId('scripts-success-banner');
  if (b) {
    const closeBtn = b.querySelector('button');
    const closeAndClear = function (ev) {
      if (ev) ev.stopPropagation();
      hideScriptsSuccessBanner();
    };
    b.onclick = closeAndClear;
    if (closeBtn) closeBtn.onclick = closeAndClear;
  }

// alternancia Netwatch/Zabbix/Grafana
const typeNet = byId('btn-type-netwatch');
const typeZbx = byId('btn-type-zabbix');
const typeGf = byId('btn-type-grafana');
const pNet = byId('panel-netwatch');
const pZbx = byId('panel-zabbix');
const pGf = byId('panel-grafana');
const pIp = byId('panel-ipscan');
const pPs = byId('panel-portscan');
const modeSelect = byId('scripts-mode');

function setScriptsMode(mode) {
  // funciona com botões (legado) ou apenas com o select (novo)
// helper to set button styles
  function setBtn(btn, active) {
    if (!btn) return;
    btn.classList.remove(active ? 'btn-secondary' : 'btn-primary');
    btn.classList.add(active ? 'btn-primary' : 'btn-secondary');
  }

  const showNet = (mode === 'netwatch');
  const showZbx = (mode === 'zabbix');
  const showGf = (mode === 'grafana');
  const showIp = (mode === 'ipscan');
  const showPs = (mode === 'portscan');

  if (modeSelect) modeSelect.value = mode;

  setBtn(typeNet, showNet);
  setBtn(typeZbx, showZbx);
  if (typeGf) setBtn(typeGf, showGf);

  if (pNet) pNet.style.display = showNet ? '' : 'none';
  if (pZbx) pZbx.style.display = showZbx ? '' : 'none';
  if (pGf) pGf.style.display = showGf ? '' : 'none';
  if (pIp) pIp.style.display = showIp ? '' : 'none';
  if (pPs) pPs.style.display = showPs ? '' : 'none';

  //  Atualiza o título/subtítulo da pagina conforme o módulo selecionado
  const titleEl = byId('scripts-page-title') || byId('tools-page-title');
  const subEl = byId('scripts-page-sub') || byId('tools-page-sub');
  if (titleEl) {
    if (showNet) titleEl.textContent = 'Mikrotik';
    else if (showZbx) titleEl.textContent = 'Zabbix';
    else if (showGf) titleEl.textContent = 'Grafana';
    else if (showIp) titleEl.textContent = 'Scan IP';
    else if (showPs) titleEl.textContent = 'Port Scanner';
    else titleEl.textContent = 'Integracões';
  }
  if (subEl) {
    if (showNet) subEl.textContent = 'Gere o Netwatch (.rsc) a partir do inventario e envie alertas via Telegram.';
    else if (showZbx) subEl.textContent = 'Crie/atualize hosts no Zabbix e configure alertas (ex.: Telegram) a partir do inventario.';
    else if (showGf) subEl.textContent = 'Importe/atualize o dashboard de status de cameras via API do Grafana.';
    else if (showIp) subEl.textContent = 'Scan de IP unico com nome, fabricante, modelo, MAC e portas abertas.';
    else if (showPs) subEl.textContent = 'Varredura de portas TCP (connect scan) para achar dispositivos e portas alteradas.';
    else subEl.textContent = 'Ferramentas para integrar Mikrotik, Zabbix e Grafana ao inventario.';
  }
}

// Abre o painel correto quando vier por hash (menu Integracões  ...)
function applyScriptsHash() {
  const h = (location.hash || '').toLowerCase();
  if (h === '#mikrotik' || h === '#netwatch') setScriptsMode('netwatch');
  else if (h === '#zabbix') setScriptsMode('zabbix');
  else if (h === '#grafana') setScriptsMode('grafana');
  else if (h === '#portscan' || h === '#scanner') setScriptsMode('portscan');
  else {
    // Sem hash: usa o valor atual do select (ou Mikrotik por padrao)
    const current = (modeSelect && modeSelect.value) ? modeSelect.value : 'netwatch';
    setScriptsMode(current);
  }
}

function applyToolsHash() {
  const h = (location.hash || '').toLowerCase();
  if (h === '#portscan' || h === '#scanner') setScriptsMode('portscan');
  else setScriptsMode('ipscan');
}

if (typeNet) typeNet.addEventListener('click', function(){ setScriptsMode('netwatch'); });
if (typeZbx) typeZbx.addEventListener('click', function(){ setScriptsMode('zabbix'); });
if (typeGf) typeGf.addEventListener('click', function(){ setScriptsMode('grafana'); });

if (modeSelect) modeSelect.addEventListener('change', function(){ setScriptsMode(this.value); });

// aplica hash inicial e reage a mudancas (voltar/avancar do navegador)
const __path = (location.pathname || '').toLowerCase();
const __isScriptsPage = __path.endsWith('scripts.html');
const __isToolsPage = __path.endsWith('tools.html');
const __isDiscoveryPage = __path.endsWith('discovery.html');

if (__isDiscoveryPage) {
  // sem hash por enquanto
} else if (__isScriptsPage) {
  applyScriptsHash();
  window.addEventListener('hashchange', applyScriptsHash);
} else if (__isToolsPage) {
  applyToolsHash();
  window.addEventListener('hashchange', applyToolsHash);
}

// ------------------------
// Scan IP (single target)
// ------------------------
function ipScanSetStatus(text) {
  const el = byId('ipscan-status');
  if (el) el.textContent = text || '';
}

function ipScanRenderResult(data) {
  const tb = byId('ipscan-result');
  if (!tb) return;
  if (!data || !data.ok) {
    tb.innerHTML = '<tr><td class="muted">Nenhum scan executado.</td></tr>';
    return;
  }
  const onlineTxt = data.online ? 'online' : 'offline';
  const ports = Array.isArray(data.open_ports) ? data.open_ports : [];
  const portsTxt = ports.length
    ? ports.map(p => String(p.port) + (p.service ? (' (' + p.service + ')') : '')).join(', ')
    : '-';
  const rows = [
    ['IP', data.ip || '-'],
    ['Status', onlineTxt],
    ['Hostname', data.hostname || '-'],
    ['Fabricante', data.fabricante || '-'],
    ['Modelo', data.modelo || '-'],
    ['Titulo', data.titulo || '-'],
    ['MAC', data.mac || '-'],
    ['Portas abertas', portsTxt]
  ];
  tb.innerHTML = rows.map(([k, v]) => '<tr><th style="width:190px;">' + String(k) + '</th><td>' + String(v) + '</td></tr>').join('');
}

async function runSingleIpScan() {
  const ip = safeTrim((byId('ipscan-target') || {}).value || '');
  const usuario = safeTrim((byId('ipscan-user') || {}).value || '');
  const senha = (byId('ipscan-pass') || {}).value || '';
  const timeoutMs = parseInt((byId('ipscan-timeout') || {}).value || '900', 10);
  const ports = safeTrim((byId('ipscan-ports') || {}).value || '');

  if (!ip) {
    ipScanSetStatus('Informe um IP.');
    return;
  }

  ipScanSetStatus('Escaneando IP...');
  try {
    const res = await fetch('/api/tools/scan-ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ip: ip,
        usuario: usuario,
        senha: senha,
        timeout_ms: isFinite(timeoutMs) ? timeoutMs : 900,
        ports: ports
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data && (data.detail || data.message) ? (data.detail || data.message) : ('HTTP ' + res.status));
    ipScanRenderResult(data);
    ipScanSetStatus('Scan concluido.');
  } catch (e) {
    ipScanSetStatus('Erro no scan: ' + (e && e.message ? e.message : e));
  }
}

const btnIpScanRun = byId('btn-ipscan-run');
if (btnIpScanRun) btnIpScanRun.addEventListener('click', function(ev){ if (ev) ev.preventDefault(); runSingleIpScan(); });
const btnIpScanClear = byId('btn-ipscan-clear');
if (btnIpScanClear) btnIpScanClear.addEventListener('click', function(ev){
  if (ev) ev.preventDefault();
  const a = byId('ipscan-target'); if (a) a.value = '';
  const b = byId('ipscan-timeout'); if (b) b.value = '900';
  const c = byId('ipscan-ports'); if (c) c.value = '80,443,554,8000,37777,8291,22';
  const d = byId('ipscan-user'); if (d) d.value = '';
  const e2 = byId('ipscan-pass'); if (e2) e2.value = '';
  ipScanRenderResult({ ok: false });
  ipScanSetStatus('Pronto para escanear.');
});

// ------------------------
// Discovery (inventory)
// ------------------------
function discSetStatus(text) {
  const el = byId('disc-status');
  if (el) el.textContent = text || '';
}

function discRenderRows(rows) {
  const tb = byId('disc-tbody');
  if (!tb) return;
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    tb.innerHTML = '<tr><td colspan="6" class="muted">Nenhum dispositivo encontrado.</td></tr>';
    return;
  }
  tb.innerHTML = '';
  list.forEach(function(r){
    const tr = document.createElement('tr');
    const tdIp = document.createElement('td'); tdIp.textContent = r.ip || '';
    const tdHost = document.createElement('td'); tdHost.textContent = r.hostname || '-';
    const tdFab = document.createElement('td'); tdFab.textContent = r.fabricante || '-';
    const tdMod = document.createElement('td'); tdMod.textContent = r.modelo || '-';
    const tdMac = document.createElement('td'); tdMac.textContent = r.mac || '-';
    const tdPorts = document.createElement('td');
    const ports = Array.isArray(r.open_ports) ? r.open_ports : [];
    tdPorts.textContent = ports.length
      ? ports.map(function(p){ return String(p.port) + (p.service ? (' (' + p.service + ')') : ''); }).join(', ')
      : '-';
    tr.appendChild(tdIp);
    tr.appendChild(tdHost);
    tr.appendChild(tdFab);
    tr.appendChild(tdMod);
    tr.appendChild(tdMac);
    tr.appendChild(tdPorts);
    tb.appendChild(tr);
  });
}

async function runDiscoveryScan() {
  const targets = safeTrim((byId('disc-targets') || {}).value || '');
  const ports = safeTrim((byId('disc-ports') || {}).value || '');
  const timeoutMs = parseInt((byId('disc-timeout') || {}).value || '650', 10);
  const concurrency = parseInt((byId('disc-concurrency') || {}).value || '256', 10);
  const usuario = safeTrim((byId('disc-user') || {}).value || '');
  const senha = (byId('disc-pass') || {}).value || '';
  const fastMode = !!(byId('disc-fast-mode') && byId('disc-fast-mode').checked);
  const collectInfo = !!(byId('disc-collect-info') && byId('disc-collect-info').checked);

  if (!targets) { discSetStatus('Informe os alvos da descoberta.'); return; }
  discSetStatus('Executando descoberta...');
  try {
    const res = await fetch('/api/discovery/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        targets: targets,
        ports: ports,
        timeout_ms: isFinite(timeoutMs) ? timeoutMs : 650,
        concurrency: isFinite(concurrency) ? concurrency : 256,
        usuario: usuario,
        senha: senha,
        fast_mode: fastMode,
        collect_info: collectInfo
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data && (data.detail || data.message) ? (data.detail || data.message) : ('HTTP ' + res.status));
    discRenderRows(data.results || []);
    discSetStatus(`Concluido. Alvos: ${data.targets_checked || 0}/${data.targets_total || 0}. Encontrados: ${data.found || 0}.`);
  } catch (e) {
    discSetStatus('Erro na descoberta: ' + (e && e.message ? e.message : e));
  }
}

const btnDiscRun = byId('btn-disc-run');
if (btnDiscRun) btnDiscRun.addEventListener('click', function(ev){ if (ev) ev.preventDefault(); runDiscoveryScan(); });
const btnDiscClear = byId('btn-disc-clear');
if (btnDiscClear) btnDiscClear.addEventListener('click', function(ev){
  if (ev) ev.preventDefault();
  const a = byId('disc-targets'); if (a) a.value = '';
  const b = byId('disc-ports'); if (b) b.value = '80,443,554,8000,37777,8291,161,22,23';
  const c = byId('disc-timeout'); if (c) c.value = '650';
  const d = byId('disc-concurrency'); if (d) d.value = '256';
  const e2 = byId('disc-user'); if (e2) e2.value = '';
  const f = byId('disc-pass'); if (f) f.value = '';
  const g = byId('disc-fast-mode'); if (g) g.checked = true;
  const h = byId('disc-collect-info'); if (h) h.checked = true;
  discRenderRows([]);
  discSetStatus('Pronto para executar.');
});

// ------------------------
// Port Scanner (WebSocket)
// ------------------------
let psWS = null;
// host -> Set(ports)
let psOpenMap = new Map();
// host -> Map(port -> serviceLabel)
let psSvcMap = new Map();
let psMeta = { total: 0, scanned: 0, found: 0, started: 0, rate: 0 };

const PS_PRESETS = {
  // sensacao APS: presets uteis de verdade
  wellknown: "1-1024",
  full: "1-65535",
  top100: "22,23,53,80,81,82,83,84,88,110,123,135,137,138,139,143,161,389,443,445,554,631,8000,8080,8081,8291,8728,8729,3389,37777,34567",
  cftv: "80,81,82,83,84,88,443,554,555,556,8000,8001,8002,8003,8004,8899,37777,37778,34567,10554",
  hik:  "80,443,554,8000,8200,8080,8081,8443",
  dahua:"80,443,554,37777,37778,34567,5000,10554",
  infra:"22,23,53,80,443,161,3389,8291,8728,8729,8080,8081,9100",
  mikrotik:"22,23,80,443,8291,8728,8729,8720"
};

function psLog(line) {
  const box = byId('ps-log');
  if (!box) return;
  const t = (box.textContent || '');
  box.textContent = (t ? (t + "\n") : '') + line;
  box.scrollTop = box.scrollHeight;
}

function psSetStatus(text) {
  const el = byId('ps-status');
  if (el) el.textContent = text || '';
}

function psSetProgress(pct, text) {
  const bar = byId('ps-progress-bar');
  const txt = byId('ps-progress-text');
  if (bar) bar.style.width = (Math.max(0, Math.min(100, pct)) || 0) + '%';
  if (txt) txt.textContent = text || '';
}

function psClearResults() {
  const tb = byId('ps-tbody');
  if (!tb) return;
  psOpenMap = new Map();
  psSvcMap = new Map();
  psMeta = { total: 0, scanned: 0, found: 0, started: 0, rate: 0 };
  tb.innerHTML = '<tr><td colspan="2" class="muted">Nenhuma execucao ainda.</td></tr>';
  psSetProgress(0, '');
}

function psFmtPort(host, port) {
  const svc = (psSvcMap.get(host) && psSvcMap.get(host).get(Number(port))) ? psSvcMap.get(host).get(Number(port)) : '';
  return svc ? (String(port) + ' (' + svc + ')') : String(port);
}

function psAddOpen(host, port, service) {
  const tb = byId('ps-tbody');
  if (!tb) return;

  // agrega por host (evita duplicar IP por linha)
  if (!psOpenMap.has(host)) psOpenMap.set(host, new Set());
  psOpenMap.get(host).add(Number(port));

  if (!psSvcMap.has(host)) psSvcMap.set(host, new Map());
  if (service) psSvcMap.get(host).set(Number(port), String(service));

  if (tb.querySelector('tr td[colspan]')) tb.innerHTML = '';

  // tenta achar a linha existente do host
  let tr = tb.querySelector('tr[data-host="' + host + '"]');
  if (!tr) {
    tr = document.createElement('tr');
    tr.setAttribute('data-host', host);
    const tdH = document.createElement('td');
    const tdP = document.createElement('td');
    tdH.textContent = host;
    tdP.textContent = '';
    tr.appendChild(tdH);
    tr.appendChild(tdP);
    tb.appendChild(tr);
  }

  // atualiza lista de portas (ordenada)
  const portsArr = Array.from(psOpenMap.get(host) || []).filter(n => isFinite(n));
  portsArr.sort((a,b) => a-b);
  const tdPorts = tr.children[1];
  if (tdPorts) tdPorts.textContent = portsArr.map(p => psFmtPort(host, p)).join(', ');
}

function psGetResultsObj() {
  const out = {};
  psOpenMap.forEach((setPorts, host) => {
    const arr = Array.from(setPorts || []).filter(n => isFinite(n)).map(n => Number(n));
    arr.sort((a,b)=>a-b);
    out[host] = arr;
  });
  return out;
}

function psGetResultsObjWithSvc() {
  const out = {};
  psOpenMap.forEach((setPorts, host) => {
    const arr = Array.from(setPorts || []).filter(n => isFinite(n)).map(n => Number(n));
    arr.sort((a,b)=>a-b);
    const svcMap = psSvcMap.get(host) || new Map();
    out[host] = arr.map(p => ({ port: p, service: svcMap.get(p) || '' }));
  });
  return out;
}

function psCopyIpPort() {
  const parts = [];
  const obj = psGetResultsObj();
  Object.keys(obj).sort().forEach(ip => {
    (obj[ip] || []).forEach(p => parts.push(ip + ':' + p));
  });
  const text = parts.join(',');
  if (!text) { psSetStatus('Nada para copiar.'); return; }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => psSetStatus('Copiado para a area de transferência.')).catch(() => {
      window.prompt('Copie:', text);
    });
  } else {
    window.prompt('Copie:', text);
  }
}

function psDownload(filename, content, mime) {
  const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function psExportCSV() {
  const obj = psGetResultsObjWithSvc();
  const ips = Object.keys(obj).sort();
  if (!ips.length) { psSetStatus('Nada para exportar.'); return; }
  let csv = 'ip,port,service\n';
  ips.forEach(ip => {
    (obj[ip] || []).forEach(row => {
      const svc = (row.service || '').replaceAll('"', '""');
      csv += `"${ip}",${row.port},"${svc}"\n`;
    });
  });
  psDownload('portscan.csv', csv, 'text/csv;charset=utf-8');
  psSetStatus('CSV exportado.');
}

function psExportJSON() {
  const obj = psGetResultsObjWithSvc();
  const ips = Object.keys(obj).sort();
  if (!ips.length) { psSetStatus('Nada para exportar.'); return; }
  psDownload('portscan.json', JSON.stringify(obj, null, 2), 'application/json;charset=utf-8');
  psSetStatus('JSON exportado.');
}

async function psApplyInventory() {
  const results = psGetResultsObj();
  const ips = Object.keys(results);
  if (!ips.length) { psSetStatus('Nada para aplicar no inventario.'); return; }

  const noOverwrite = !!(byId('ps-apply-no-overwrite') && byId('ps-apply-no-overwrite').checked);

  psSetStatus('Aplicando no inventario...');
  try {
    const res = await fetch('/api/portscan/apply', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ results, no_overwrite: noOverwrite })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data && data.message ? data.message : ('HTTP ' + res.status));
    psSetStatus(`Inventario atualizado: ${data.updated_hosts || 0} host(s). Campos preenchidos: ${data.fields_set || 0}.`);
    psLog('[apply] ' + JSON.stringify(data));
  } catch (e) {
    psSetStatus('Erro ao aplicar no inventario: ' + (e && e.message ? e.message : e));
    psLog('[erro] ' + (e && e.message ? e.message : e));
  }
}

function psStopScan() {
  if (!psWS || psWS.readyState !== 1) { psSetStatus('Nenhuma varredura em execucao.'); return; }
  try { psWS.send(JSON.stringify({ type: 'cancel' })); } catch(e) {}
  psSetStatus('Parando...');
}

function runPortScan() {
  const targets = safeTrim((byId('ps-targets') || {}).value || '');
  const ports = safeTrim((byId('ps-ports') || {}).value || '');
  const timeoutMs = parseInt((byId('ps-timeout') || {}).value || '700', 10);
  const conc = parseInt((byId('ps-concurrency') || {}).value || '200', 10);
  const fastDiscovery = !!(byId('ps-fast-discovery') && byId('ps-fast-discovery').checked);
  const detectService = !!(byId('ps-detect-service') && byId('ps-detect-service').checked);

  if (!targets) { psSetStatus('Informe o alvo.'); return; }
  if (!ports) { psSetStatus('Informe as portas.'); return; }

  // encerra scan anterior
  try { if (psWS) psWS.close(); } catch(e) {}
  psWS = null;
  psClearResults();
  const log = byId('ps-log');
  if (log) log.textContent = '';

  psSetStatus('Conectando...');
  psSetProgress(0, '');
  const wsUrl = buildAuthedWsUrl('/ws/portscan');
  psWS = new WebSocket(wsUrl);

  psWS.onopen = function() {
    psSetStatus('Iniciando...');
    sendWsAuthFrame(psWS);
    psWS.send(JSON.stringify({
      targets: targets,
      ports: ports,
      timeout_ms: isFinite(timeoutMs) ? timeoutMs : 700,
      concurrency: isFinite(conc) ? conc : 200,
      fast_discovery: fastDiscovery,
      detect_service: detectService
    }));
  };

  psWS.onmessage = function(ev) {
    let msg = null;
    try { msg = JSON.parse(ev.data); } catch(e) { return; }
    const t = msg.type || '';
    if (t === 'status') {
      psSetStatus(msg.message || '');
      psLog('[status] ' + (msg.message || ''));
    } else if (t === 'progress') {
      const scanned = msg.scanned || 0;
      const total = msg.total || 0;
      const found = msg.found || 0;
      const rate = msg.rate || 0;
      const eta = msg.eta_s || 0;
      const pct = total > 0 ? (scanned * 100.0 / total) : 0;
      psSetProgress(pct, `Progresso: ${scanned}/${total} | abertas: ${found} | ${rate} chk/s | ETA ~ ${eta}s`);
      psSetStatus(`Concluído: ${scanned} teste(s). Abertas: ${found}.`);
    } else if (t === 'open') {
      psAddOpen(msg.host, msg.port, msg.service || '');
    } else if (t === 'done') {
      psSetStatus(msg.message || 'Concluído.');
      psLog('[done] ' + (msg.message || ''));
      psSetProgress(100, msg.message || '');
      try { psWS.close(); } catch(e) {}
      psWS = null;
    } else if (t === 'error') {
      psSetStatus(msg.message || 'Erro.');
      psLog('[erro] ' + (msg.message || ''));
      try { psWS.close(); } catch(e) {}
      psWS = null;
    }
  };

  psWS.onerror = function() {
    psSetStatus('Erro de conexao no WebSocket.');
  };
  psWS.onclose = function() {};
}

const btnPS = byId('btn-portscan');
if (btnPS) btnPS.addEventListener('click', function(ev){ if (ev) ev.preventDefault(); runPortScan(); });

const btnPSStop = byId('btn-portscan-stop');
if (btnPSStop) btnPSStop.addEventListener('click', function(ev){ if (ev) ev.preventDefault(); psStopScan(); });

const btnPSClear = byId('btn-portscan-clear');
if (btnPSClear) btnPSClear.addEventListener('click', function(ev){ if (ev) ev.preventDefault();
  const t = byId('ps-targets');
  const p = byId('ps-ports');
  const presetSel = byId('ps-preset');
  if (t) t.value = '';
  if (p) p.value = '80,443,554,8000,8291,37777';
  if (presetSel) presetSel.value = '';
  const fd = byId('ps-fast-discovery'); if (fd) fd.checked = true;
  const ds = byId('ps-detect-service'); if (ds) ds.checked = true;
  psSetStatus('Pronto para escanear.');
  psClearResults();
  const log = byId('ps-log'); if (log) log.textContent = '';
});

const btnPSCopy = byId('btn-ps-copy');
if (btnPSCopy) btnPSCopy.addEventListener('click', function(ev){ if (ev) ev.preventDefault(); psCopyIpPort(); });

const btnPSExport = byId('btn-ps-export');
if (btnPSExport) btnPSExport.addEventListener('click', function(ev){ if (ev) ev.preventDefault(); psExportCSV(); });

const btnPSExportJson = byId('btn-ps-export-json');
if (btnPSExportJson) btnPSExportJson.addEventListener('click', function(ev){ if (ev) ev.preventDefault(); psExportJSON(); });

const btnPSApplyInv = byId('btn-ps-apply-inventory');
if (btnPSApplyInv) btnPSApplyInv.addEventListener('click', function(ev){ if (ev) ev.preventDefault(); psApplyInventory(); });

const btnPreset = byId('btn-ps-apply-preset');
if (btnPreset) btnPreset.addEventListener('click', function(ev){
  if (ev) ev.preventDefault();
  const sel = byId('ps-preset');
  const ports = byId('ps-ports');
  if (!sel || !ports) return;
  const key = (sel.value || '').trim();
  if (!key || !PS_PRESETS[key]) return;
  ports.value = PS_PRESETS[key];
  psSetStatus('Preset aplicado.');
});


// botao zabbix
const btnZ = byId('btn-zabbix');
if (btnZ) btnZ.addEventListener('click', runZabbixGenerate);

// botao grafana
const btnGf = byId('btn-grafana');
if (btnGf) btnGf.addEventListener('click', function (ev) {
  if (ev) ev.preventDefault();
  runGrafanaImport({
    url: safeTrim((byId('gf-url-only') || {}).value || ''),
    api_key: (byId('gf-key-only') || {}).value || '',
    folder_uid: safeTrim((byId('gf-folder-only') || {}).value || '')
  });
});

// checkbox: importar grafana depois do zabbix
const cbAfter = byId('zbx-after-grafana');
const pAfter = byId('panel-zabbix-grafana');
if (cbAfter && pAfter) {
  const sync = function () { pAfter.style.display = cbAfter.checked ? '' : 'none'; };
  cbAfter.addEventListener('change', sync);
  sync();
}

const zbxSourceEl = byId('zbx-source');
if (zbxSourceEl) {
  zbxSourceEl.addEventListener('change', syncZabbixTemplateBySource);
  syncZabbixTemplateBySource();
}

function loadZabbixSiteOptions() {
  const sel = byId('zbx-site');
  if (!sel) return Promise.resolve();
    return fetch('/api/db/sites?source=ip&_=' + Date.now(), { cache: 'no-store' })
    .then(r => r.json().catch(() => ({})))
    .then(j => {
      const sites = (j && j.ok === true && Array.isArray(j.sites)) ? j.sites : [];
      const cur = safeTrim(sel.value || '');
      sel.innerHTML = '<option value="">Todos os sites</option>';
      sites.forEach(function (s) {
        const name = safeTrim((s && s.name) || '');
        if (!name) return;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
      if (cur) sel.value = cur;
    })
    .catch(() => {});
}
loadZabbixSiteOptions();

function loadNetwatchSiteOptions() {
  const sel = byId('script-site');
  if (!sel) return Promise.resolve();
  return fetch('/api/db/sites?source=ip&_=' + Date.now(), { cache: 'no-store' })
    .then(r => r.json().catch(() => ({})))
    .then(j => {
      const sites = (j && j.ok === true && Array.isArray(j.sites)) ? j.sites : [];
      const cur = safeTrim(sel.value || '');
      sel.innerHTML = '<option value="">Todos os sites</option>';
      sites.forEach(function (s) {
        const name = safeTrim((s && s.name) || '');
        if (!name) return;
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        sel.appendChild(opt);
      });
      if (cur) sel.value = cur;
      sel.addEventListener('change', function () {
        const downloadBtn = byId('btn-netwatch-download');
        if (downloadBtn) {
          downloadBtn.style.display = 'none';
          downloadBtn.dataset.downloadUrl = '';
        }
        const logEl = byId('log-netwatch');
        if (logEl) logEl.textContent = 'Filtro alterado. Gere o script novamente antes de baixar.\n';
      }, { once: false });
    })
    .catch(() => {});
}
loadNetwatchSiteOptions();



// limpar campos (modal de confirmacao)
const clearBackdrop = byId('clear-modal-backdrop');
const clearText = byId('clear-modal-text');
const clearBtnConfirm = byId('btn-clear-confirm');
const clearBtnCancel = byId('btn-clear-cancel');
const clearBtnClose = byId('btn-clear-close');
let clearOnConfirm = null;

function openClearModal(message, onConfirm) {
  if (!clearBackdrop) {
    // fallback: sem modal, limpa direto
    if (onConfirm) onConfirm();
    return;
  }
  clearOnConfirm = onConfirm || null;
  if (clearText) clearText.textContent = message || 'Limpar campos?';
  clearBackdrop.style.display = 'flex';
  clearBackdrop.classList.add('open');
}

function closeClearModal() {
  if (!clearBackdrop) return;
  clearBackdrop.classList.remove('open');
  clearBackdrop.style.display = 'none';
  clearOnConfirm = null;
}

function clearLogBox() {
  const log = byId('log-netwatch');
  if (log) log.textContent = '';
}

function clearNetwatchFields() {
  const token = byId('script-token');
  const chat = byId('script-chat');
  const interval = byId('script-interval');
  const timeout = byId('script-timeout');
  const site = byId('script-site');
  if (token) token.value = '';
  if (chat) chat.value = '';
  interval && (interval.value = '1m');
  timeout && (timeout.value = '2s');
  site && (site.value = '');
  clearLogBox();
  const downloadBtn = byId('btn-netwatch-download');
  if (downloadBtn) downloadBtn.style.display = 'none';
}

function clearZabbixFields() {
  const zurl = byId('zbx-url');
  const zuser = byId('zbx-user');
  const zpass = byId('zbx-pass');
  const zgroup = byId('zbx-group');
  const ztpl = byId('zbx-template');
  const zsrc = byId('zbx-source');
  const zsite = byId('zbx-site');
  const zdvrUser = byId('zbx-dvr-user');
  const zdvrPass = byId('zbx-dvr-pass');
  const zauto = byId('zbx-auto-tg');
  const tgtk = byId('zbx-tg-token');
  const tgchat = byId('zbx-tg-chat');
  const after = byId('zbx-after-grafana');
  const gfUrl = byId('gf-url');
  const gfFolder = byId('gf-folder');
  const gfKey = byId('gf-key');
  const pAfter = byId('panel-zabbix-grafana');

  if (zurl) zurl.value = '';
  if (zuser) zuser.value = '';
  if (zpass) zpass.value = '';
  if (tgtk) tgtk.value = '';
  if (tgchat) tgchat.value = '';

  // defaults que você costuma usar
  if (zgroup) zgroup.value = zgroup.value || 'Cameras';
  if (ztpl) ztpl.value = 'Template Cam-Snapshot DVR Channel';
  if (zsrc) zsrc.value = 'nvr';
  if (zsite) zsite.value = '';
  if (zdvrUser) zdvrUser.value = zdvrUser.value || 'admin';
  if (zdvrPass) zdvrPass.value = '';
  if (zauto) zauto.checked = true;

  if (after) after.checked = false;
  if (pAfter) pAfter.style.display = 'none';
  if (gfUrl) gfUrl.value = '';
  if (gfFolder) gfFolder.value = '';
  if (gfKey) gfKey.value = '';

  syncZabbixTemplateBySource();
  clearLogBox();
}

function clearGrafanaFields() {
  const url = byId('gf-url-only');
  const folder = byId('gf-folder-only');
  const key = byId('gf-key-only');
  if (url) url.value = '';
  if (folder) folder.value = '';
  if (key) key.value = '';
  clearLogBox();
}

// bind modal controls
if (clearBackdrop) {
  clearBackdrop.addEventListener('click', function (ev) {
    if (ev && ev.target === clearBackdrop) closeClearModal();
  });
}
if (clearBtnCancel) clearBtnCancel.addEventListener('click', closeClearModal);
if (clearBtnClose) clearBtnClose.addEventListener('click', closeClearModal);
if (clearBtnConfirm) clearBtnConfirm.addEventListener('click', function () {
  const fn = clearOnConfirm;
  closeClearModal();
  try { if (fn) fn(); } catch (e) { console.error(e); }
});

// bind clear buttons
const btnClearNet = byId('btn-clear-netwatch');
if (btnClearNet) btnClearNet.addEventListener('click', function () {
  openClearModal('Limpar campos do Netwatch (MikroTik) e apagar o log?', clearNetwatchFields);
});

const btnClearZbx = byId('btn-clear-zabbix');
if (btnClearZbx) btnClearZbx.addEventListener('click', function () {
  openClearModal('Limpar campos do Zabbix e apagar o log?', clearZabbixFields);
});

const btnClearGf = byId('btn-clear-grafana');
if (btnClearGf) btnClearGf.addEventListener('click', function () {
  openClearModal('Limpar campos do Grafana e apagar o log?', clearGrafanaFields);
});
// modo default e definido por applyScriptsHash()/select; nao sobrescrever hash aqui

}

/* =========================
   Conserta botões Fechar dos banners
   (mesmo que o HTML esteja sem onclick)
   ========================= */
function initBannerCloseButtons() {
  const inv = byId('inv-success-banner');
  if (inv) {
    const btn = inv.querySelector('button');
    if (btn) btn.onclick = function (ev) {
      if (ev) ev.stopPropagation();
      hideInvSuccessBanner();
    };
    inv.onclick = function () { hideInvSuccessBanner(); };
  }

  const edit = byId('edit-success-banner');
  if (edit) {
    const btn = edit.querySelector('button');
    if (btn) btn.onclick = function (ev) {
      if (ev) ev.stopPropagation();
      hideEditSuccessBanner();
    };
    edit.onclick = function () { hideEditSuccessBanner(); };
  }

  // snapshot banner tambem
  const snap = byId('snapshot-success-banner');
  if (snap) {
    const btn = snap.querySelector('button');
    if (btn) btn.onclick = function (ev) {
      if (ev) ev.stopPropagation();
      hideSnapshotSuccessBanner();
    };
    snap.onclick = function () { hideSnapshotSuccessBanner(); };
  }

  // scripts banner tambem (caso initScriptsHandlers nao rode por algum motivo)
  const scr = byId('scripts-success-banner');
  if (scr) {
    const btn = scr.querySelector('button');
    if (btn) btn.onclick = function (ev) {
      if (ev) ev.stopPropagation();
      hideScriptsSuccessBanner();
    };
    scr.onclick = function () { hideScriptsSuccessBanner(); };
  }
}

/* =========================
   INIT unico
   ========================= */
document.addEventListener('DOMContentLoaded', function () {
  initAuthUi();
});


function refreshOltPonOptions() {
  const modelEl = byId('olt-model');
  const ponEl = byId('olt-pon');
  const titleEl = byId('olt-form-title');
  if (!ponEl) return;

  const model = safeTrim(modelEl?.value) || '8820i';
  const current = safeTrim(ponEl.value);

  // limpa
  ponEl.innerHTML = '';

  const opt0 = document.createElement('option');
  opt0.value = '';
  opt0.textContent = 'Selecione a PON...';
  ponEl.appendChild(opt0);

  const optAll = document.createElement('option');
  optAll.value = 'all';
  optAll.textContent = 'TODAS (ALL)';
  ponEl.appendChild(optAll);

  let opts = [];
  if (model === '4840e') {
    // 4840E EPON (4 portas PON no modelo mais comum)
    opts = ['0/1','0/2','0/3','0/4'];
  } else {
    // 8820i GPON (8 portas)
    opts = ['1','2','3','4','5','6','7','8'];
  }

  // Atualiza o título do card conforme modelo
  if (titleEl) {
    titleEl.textContent = (model === '4840e')
      ? 'Scan OLT (Intelbras 4840E)'
      : 'Scan OLT (Intelbras 8820i)';
  }

  opts.forEach(function (v) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = (model === '4840e') ? ('PON ' + v) : ('PON ' + v);
    ponEl.appendChild(o);
  });

  // tenta manter selecao anterior
  if (current && [...ponEl.options].some(o => o.value === current)) {
    ponEl.value = current;
  } else {
    ponEl.value = '';
  }
}


/* =========================
   Scripts  Grafana
   - Importa/atualiza o dashboard do projeto via Grafana HTTP API
   ========================= */
function runGrafanaImport(params, logEl) {
  const logBox = logEl || byId('log-netwatch');
  if (!logBox) return;

  const url = safeTrim((params || {}).url || '');
  const apiKey = (params || {}).api_key || '';
  const folderUid = safeTrim((params || {}).folder_uid || '');

  if (!url || !apiKey) {
    logBox.textContent += 'Informe Grafana URL e Grafana API Key.\n';
    return;
  }

  const btn = byId('btn-grafana');
  if (btn) { btn.disabled = true; btn.textContent = 'Importando...'; }

  fetch('/api/scripts/grafana', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: url,
      api_key: apiKey,
      folder_uid: folderUid,
      overwrite: true
    })
  })
    .then(r => r.json())
    .then(j => {
      if (btn) { btn.disabled = false; btn.textContent = 'Importar dashboard no Grafana'; }
      if (!j) return;

      if (j.error) {
        logBox.textContent += 'ERRO: ' + j.error + '\n';
        if (j.stdout) logBox.textContent += j.stdout + '\n';
        if (j.stderr) logBox.textContent += j.stderr + '\n';
        return;
      }

      if (j.stdout) logBox.textContent += j.stdout + '\n';
      if (j.stderr) logBox.textContent += j.stderr + '\n';
      logBox.textContent += ' Dashboard importado/atualizado no Grafana.\n';
    })
    .catch(err => {
      if (btn) { btn.disabled = false; btn.textContent = 'Importar dashboard no Grafana'; }
      logBox.textContent += '\nErro: ' + err;
    });
}



/* =========================
   Scripts  Zabbix (Telegram)
   - Cria/atualiza hosts + configura Telegram automaticamente (opcional)
   ========================= */
function runZabbixGenerate(evt) {
  if (evt) evt.preventDefault();

  const btn = byId('btn-zabbix');
  const logEl = byId('log-netwatch'); // reaproveita o mesmo log box
  if (!logEl) return;

  const url = safeTrim((byId('zbx-url') || {}).value || '');
  const user = safeTrim((byId('zbx-user') || {}).value || '');
  const pass = (byId('zbx-pass') || {}).value || '';
  const group = safeTrim((byId('zbx-group') || {}).value || 'Cameras') || 'Cameras';
  const tplSelected = safeTrim((byId('zbx-template') || {}).value || 'Template Module ICMP Ping') || 'Template Module ICMP Ping';
  const source = safeTrim((byId('zbx-source') || {}).value || 'nvr') || 'nvr';
  const site = safeTrim((byId('zbx-site') || {}).value || '');
  const tpl = tplSelected;
  const tplDvr = ((source === 'dvr') || (source === 'nvr')) ? tplSelected : 'Template Cam-Snapshot DVR Channel';
  const dvrUser = safeTrim((byId('zbx-dvr-user') || {}).value || 'admin') || 'admin';
  const dvrPass = (byId('zbx-dvr-pass') || {}).value || '';

  const tgAuto = !!((byId('zbx-auto-tg') || {}).checked);
  const tgToken = safeTrim((byId('zbx-tg-token') || {}).value || '');
  const tgChat = safeTrim((byId('zbx-tg-chat') || {}).value || '');

  if (!url || !user || !pass) {
    logEl.textContent = 'Informe Zabbix URL, Usuario e Senha.\n';
    return;
  }
  if ((source === 'dvr' || source === 'nvr') && (!dvrUser || !dvrPass)) {
    logEl.textContent = 'Para origem DVR/NVR, informe Usuario e Senha do gravador.\n';
    return;
  }
  if (tgAuto && (!tgToken || !tgChat)) {
    logEl.textContent = 'Para Telegram automatico, informe Token e Chat ID.\n';
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Gerando...'; }
  logEl.textContent = 'Executando Zabbix com origem: ' + source + (site ? (' | site: ' + site) : ' | site: todos') + ' ...\n';

  fetch('/api/scripts/zabbix', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: url,
      user: user,
      pass: pass,
        group: group,
        template: tpl,
        template_dvr: tplDvr,
        source: source,
        site: site,
        dvr_user: dvrUser,
        dvr_pass: dvrPass,
        tg_auto: tgAuto,
        tg_token: tgToken,
        tg_chat: tgChat
    })
  })
  .then(r => r.json())
  .then(j => {
    if (btn) { btn.disabled = false; btn.textContent = 'Gerar Zabbix + Telegram'; }
    if (!j) return;
    if (j.error) {
      logEl.textContent += 'ERRO: ' + j.error + '\n';
      if (j.stdout) logEl.textContent += j.stdout + '\n';
      if (j.stderr) logEl.textContent += j.stderr + '\n';
      return;
    }
    if (j.stdout) logEl.textContent += j.stdout + '\n';
    if (j.stderr) logEl.textContent += j.stderr + '\n';
    logEl.textContent += ' Concluído.\n';

    // Se o usuario marcar, importa o dashboard no Grafana automaticamente
    const cbAfter = byId('zbx-after-grafana');
    if (cbAfter && cbAfter.checked) {
      const gfUrl = safeTrim((byId('gf-url') || {}).value || '');
      const gfKey = (byId('gf-key') || {}).value || '';
      const gfFolder = safeTrim((byId('gf-folder') || {}).value || '');

      if (!gfUrl || !gfKey) {
        logEl.textContent += '\n[WARN] Marcou importar Grafana, mas faltou Grafana URL/API Key.\n';
        return;
      }

      logEl.textContent += '\n Importando dashboard no Grafana...\n';
      runGrafanaImport({ url: gfUrl, api_key: gfKey, folder_uid: gfFolder }, logEl);
    }
  })
  .catch(err => {
    if (btn) { btn.disabled = false; btn.textContent = 'Gerar Zabbix + Telegram'; }
    logEl.textContent += '\nErro: ' + err;
  });
}

function syncZabbixTemplateBySource() {
  const sourceEl = byId('zbx-source');
  const tplEl = byId('zbx-template');
  const dvrCredsEl = byId('zbx-dvr-creds');
  if (!sourceEl || !tplEl) return;
  const source = safeTrim(sourceEl.value || 'nvr') || 'nvr';
  const isRecorder = (source === 'dvr' || source === 'nvr');
  tplEl.value = isRecorder ? 'Template Cam-Snapshot DVR Channel' : 'Template Module ICMP Ping';
  if (dvrCredsEl) dvrCredsEl.style.display = isRecorder ? '' : 'none';
}


// =========================
// Modal: limpar campos (Scripts)
// =========================
function setupClearFieldsModal(){
  const backdrop = byId('clear-modal-backdrop');
  const sub = byId('clear-modal-sub');
  const btnClose = byId('clear-modal-close');
  const btnCancel = byId('clear-modal-cancel');
  const btnConfirm = byId('clear-modal-confirm');
  if (!backdrop || !btnConfirm) return;

  let onConfirm = null;

  function close(){
    backdrop.classList.remove('open');
    backdrop.setAttribute('aria-hidden','true');
    onConfirm = null;
  }
  function open(message, cb){
    if (sub) sub.textContent = message || 'Confirme para limpar os campos deste painel.';
    onConfirm = cb || null;
    backdrop.classList.add('open');
    backdrop.setAttribute('aria-hidden','false');
  }

  // clicks
  if (btnClose) btnClose.addEventListener('click', close);
  if (btnCancel) btnCancel.addEventListener('click', close);
  backdrop.addEventListener('click', function(ev){
    if (ev && ev.target === backdrop) close();
  });
  btnConfirm.addEventListener('click', function(){
    try { if (typeof onConfirm === 'function') onConfirm(); } finally { close(); }
  });

  // expose helpers for scripts page
  window.__openClearFieldsModal = open;
}

function clearScriptsPanel(panel){
  // panel: 'netwatch' | 'zabbix' | 'grafana'
  const pre = byId('scripts-log');
  if (pre) pre.textContent = '';

  if (panel === 'netwatch'){
    setValue('netwatch-token','');
    setValue('netwatch-chat','');
    // Mantem defaults de intervalo/timeout se existirem
    if (byId('netwatch-interval') && !byId('netwatch-interval').value) setValue('netwatch-interval','1m');
    if (byId('netwatch-timeout') && !byId('netwatch-timeout').value) setValue('netwatch-timeout','2s');
    return;
  }

  if (panel === 'zabbix'){
    setValue('zbx-url','');
    setValue('zbx-user','');
    setValue('zbx-pass','');
    setValue('zbx-group','');
    setValue('zbx-template','');
    setValue('zbx-dvr-user','');
    setValue('zbx-dvr-pass','');
    setValue('tg-token','');
    setValue('tg-chat','');
    const cb = byId('zbx-send-telegram');
    if (cb) cb.checked = true;

    const after = byId('zbx-after-grafana');
    if (after) after.checked = false;
    const row = byId('grafana-after-row');
    if (row) row.style.display = 'none';

    setValue('gf-url','');
    setValue('gf-folder','');
    setValue('gf-api-key','');
    return;
  }

  if (panel === 'grafana'){
    // Campos do painel Grafana (import dashboard)
    setValue('gf-url-only','');
    setValue('gf-folder-only','');
    setValue('gf-api-key-only','');
    return;
  }
}

function setupScriptsClearButtons(){
  const bNet = byId('btn-clear-netwatch');
  const bZbx = byId('btn-clear-zabbix');
  const bGf  = byId('btn-clear-grafana');

  function ask(panel, msg){
    if (!window.__openClearFieldsModal) return;
    window.__openClearFieldsModal(msg, function(){ clearScriptsPanel(panel); });
  }

  if (bNet) bNet.addEventListener('click', function(){
    ask('netwatch', 'Limpar campos do Mikrotik / Netwatch? (token, chat e log)');
  });
  if (bZbx) bZbx.addEventListener('click', function(){
    ask('zabbix', 'Limpar campos do Zabbix + Telegram (e opcao do Grafana) e limpar o log?');
  });
  if (bGf) bGf.addEventListener('click', function(){
    ask('grafana', 'Limpar campos do Grafana (URL, pasta, API key) e limpar o log?');
  });
}
  // Modal de credenciais para atualizar snapshot (evita depender do user/senha global)
  function openSnapshotCredModal(defaultUser, ip, title, onOk) {
    const bd = invSafeId('snapshot-cred-backdrop');
    const u = invSafeId('snapshot-cred-user');
    const p = invSafeId('snapshot-cred-pass');
    const ok = invSafeId('snapshot-cred-ok');
    const cancel = invSafeId('snapshot-cred-cancel');
    const close = invSafeId('snapshot-cred-close');
    const sub = invSafeId('snapshot-cred-sub');

    if (!bd || !u || !p || !ok || !cancel) {
      // fallback: chama direto
      return onOk((defaultUser || '').trim(), '');
    }

    // preenche defaults
    const baseUser = (defaultUser != null ? String(defaultUser) : (invSafeId('user')?.value || '')).trim();
    u.value = baseUser || 'admin';
    p.value = '';
    const safeIp = (ip != null ? String(ip) : '').trim();
    const safeTitle = (title != null ? String(title) : '').trim();
    if (sub) {
      const label = safeTitle ? `${safeTitle} (${safeIp || 'IP'})` : (safeIp || 'esta camera');
      sub.textContent = `Informe usuario e senha para capturar um snapshot novo de ${label}.`;
    }

    const hide = () => {
      bd.style.display = 'none';
      bd.setAttribute('aria-hidden', 'true');
      document.removeEventListener('keydown', onKey);
      ok.onclick = null;
      cancel.onclick = null;
      if (close) close.onclick = null;
      bd.onclick = null;
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); hide(); }
      if (e.key === 'Enter') { e.preventDefault(); ok.click(); }
    };

    ok.onclick = () => {
      const uu = (u.value || '').trim();
      const pp = (p.value || '').trim();
      hide();
      onOk(uu, pp);
    };

    cancel.onclick = () => hide();
    if (close) close.onclick = () => hide();

    // clicar fora fecha
    bd.onclick = (e) => { if (e.target === bd) hide(); };

    bd.style.display = 'flex';
    bd.setAttribute('aria-hidden', 'false');
    setTimeout(() => { try { p.focus(); } catch(_){} }, 50);

    document.addEventListener('keydown', onKey);
  }









