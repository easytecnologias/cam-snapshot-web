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

function _dashNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function _dashPct(part, total) {
  const t = _dashNum(total);
  if (!t) return 0;
  return Math.max(0, Math.min(100, Math.round((_dashNum(part) / t) * 100)));
}

function _dashPriorityAction(action) {
  if (action === 'ip_offline') return openDashDrawerIp('offline');
  if (action === 'no_snapshot') return openDashDrawerIp('no_snap');
  if (action === 'dvr_offline') return openDashDrawerRecorder('dvr', 'offline');
  if (action === 'nvr_offline') return openDashDrawerRecorder('nvr', 'offline');
  if (action === 'windows_offline') return openDashDrawerWindows('offline');
  if (action === 'map') return navigateTo('kmz');
  return null;
}

function renderDashboardPriorities(data) {
  const inv = data.inventory || {};
  const ip = inv.ip || {};
  const dvr = inv.dvr || {};
  const nvr = inv.nvr || {};
  const win = inv.windows || {};
  const priorities = [
    { label: 'Cameras offline', sub: 'Abrir cameras com falha', count: _dashNum(ip.offline), icon: 'alert-circle', level: 'danger', action: 'ip_offline' },
    { label: 'Sem snapshot', sub: 'Cameras sem imagem recente', count: _dashNum(ip.missing_snapshot), icon: 'image-off', level: 'warning', action: 'no_snapshot' },
    { label: 'Sem local', sub: 'Itens sem site/local definido', count: _dashNum(ip.missing_local) + _dashNum(dvr.missing_local) + _dashNum(nvr.missing_local), icon: 'map-pin-off', level: 'info', action: 'map' },
    { label: 'Gravadores offline', sub: 'DVR/NVR com erro ou sem resposta', count: _dashNum(dvr.offline) + _dashNum(nvr.offline), icon: 'hard-drive', level: 'danger', action: 'dvr_offline' },
    { label: 'Windows offline', sub: 'Computadores sem resposta', count: _dashNum(win.offline), icon: 'monitor-x', level: 'info', action: 'windows_offline' },
  ].filter(item => item.count > 0).slice(0, 5);

  const el = document.getElementById('dashPriorityList');
  if (!el) return;
  if (!priorities.length) {
    el.innerHTML = `<div class="dash-priority-item" style="cursor:default">
      <span class="dash-priority-icon info"><i data-lucide="check-circle-2"></i></span>
      <span><span class="dash-priority-title">Sem pendencias criticas</span><span class="dash-priority-sub">O painel nao encontrou alertas principais agora.</span></span>
      <span class="dash-priority-count">OK</span>
    </div>`;
    return;
  }
  el.innerHTML = priorities.map(item => `
    <div class="dash-priority-item" data-priority-action="${esc(item.action)}">
      <span class="dash-priority-icon ${item.level === 'warning' ? 'warning' : item.level === 'info' ? 'info' : ''}"><i data-lucide="${item.icon}"></i></span>
      <span><span class="dash-priority-title">${esc(item.label)}</span><span class="dash-priority-sub">${esc(item.sub)}</span></span>
      <span class="dash-priority-count">${item.count}</span>
    </div>
  `).join('');
  el.querySelectorAll('[data-priority-action]').forEach(btn => {
    btn.addEventListener('click', () => _dashPriorityAction(btn.dataset.priorityAction));
  });
}

function renderDashboardHealth(data) {
  const inv = data.inventory || {};
  const ip = inv.ip || {};
  const dvr = inv.dvr || {};
  const nvr = inv.nvr || {};
  const totals = data.totals || {};
  const recTotal = _dashNum(dvr.total) + _dashNum(nvr.total);
  const recOnline = _dashNum(dvr.online) + _dashNum(nvr.online);
  const health = [
    { label: 'Disponibilidade IP', value: `${_dashPct(ip.online, ip.total)}%`, sub: `${_dashNum(ip.online)} online de ${_dashNum(ip.total)}`, pct: _dashPct(ip.online, ip.total) },
    { label: 'Cobertura snapshot', value: `${_dashPct(_dashNum(ip.total) - _dashNum(ip.missing_snapshot), ip.total)}%`, sub: `${_dashNum(ip.missing_snapshot)} sem snapshot`, pct: _dashPct(_dashNum(ip.total) - _dashNum(ip.missing_snapshot), ip.total) },
    { label: 'Gravadores', value: `${_dashPct(recOnline, recTotal)}%`, sub: `${recOnline} canais online de ${recTotal}`, pct: _dashPct(recOnline, recTotal) },
    { label: 'Pendencias', value: _dashNum(totals.offline), sub: 'itens offline ou com erro', pct: 100 - _dashPct(totals.offline, totals.items) },
  ];
  const el = document.getElementById('dashHealthGrid');
  if (!el) return;
  el.innerHTML = health.map(item => `
    <div class="dash-health-card">
      <div class="dash-health-label">${esc(item.label)}</div>
      <div class="dash-health-value">${esc(item.value)}</div>
      <div class="dash-health-sub">${esc(item.sub)}</div>
      <div class="dash-meter"><span style="width:${item.pct}%"></span></div>
    </div>
  `).join('');
}

function renderDashboardSiteSummary(data) {
  const rows = Array.isArray(data.site_summary) ? data.site_summary.slice(0, 8) : [];
  const el = document.getElementById('dashSiteSummary');
  if (!el) return;
  if (!rows.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = rows.map(site => `
    <div class="dash-site-card" data-dash-site="${esc(site.site || '')}">
      <div class="dash-site-head">
        <span class="dash-site-name" title="${esc(site.site || '')}">${esc(site.site || '')}</span>
        <span class="dash-site-total">${_dashNum(site.total)} itens</span>
      </div>
      <div class="dash-site-stats">
        <span><i class="dash-dot online"></i>${_dashNum(site.online)} online</span>
        <span><i class="dash-dot offline"></i>${_dashNum(site.offline)} offline</span>
        <span><i class="dash-dot warning"></i>${_dashNum(site.missing_snapshot)} sem foto</span>
      </div>
    </div>
  `).join('');
  el.querySelectorAll('[data-dash-site]').forEach(card => {
    card.addEventListener('click', () => {
      _openDashDrawer('Site', card.dataset.dashSite || 'Site');
      document.getElementById('dashDrawerFilters').innerHTML = '';
      _drawerRenderRows(`<div class="drawer-item"><i data-lucide="map-pin" style="width:14px;height:14px;color:var(--primary)"></i><div class="drawer-item-main"><div class="drawer-item-title">${esc(card.dataset.dashSite || '')}</div><div class="drawer-item-sub">Use o filtro de site nos inventarios para ver os itens.</div></div></div>`);
    });
  });
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

  renderDashboardPriorities(data);
  renderDashboardHealth(data);

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
    renderDashboardSiteSummary(data);
    sitesPanel.style.display = '';
  } else {
    renderDashboardSiteSummary(data);
    sitesPanel.style.display = 'none';
  }

  // Click handlers: KPI cards
  const kpiCamerasIp = document.getElementById('kpiCamerasIp');
  if (kpiCamerasIp) kpiCamerasIp.onclick = () => openDashDrawerIp('all');
  const kpiGravadores = document.getElementById('kpiGravadores');
  if (kpiGravadores) kpiGravadores.onclick = () => openDashDrawerRecorder('dvr', 'all');
  const kpiSnapshots = document.getElementById('kpiSnapshots');
  if (kpiSnapshots) kpiSnapshots.onclick = () => openDashDrawerIp('no_snap');
  const kpiSites = document.getElementById('kpiSites');
  if (kpiSites) kpiSites.onclick = () => {
    _openDashDrawer('Sites', 'Sites monitorados');
    document.getElementById('dashDrawerFilters').innerHTML = '';
    _drawerRenderRows(sites.length
      ? sites.map(s => `<div class="drawer-item"><i data-lucide="map-pin" style="width:14px;height:14px;color:var(--primary)"></i><div class="drawer-item-main"><div class="drawer-item-title">${esc(s)}</div></div></div>`).join('')
      : '');
  };

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
