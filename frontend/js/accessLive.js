let _accessLiveTimer = null;
let _accessLiveBindingDone = false;
let _accessLiveLoading = false;
let _accessLiveLastLoadedAt = 0;
let _accessLiveSitesLoaded = false;
let _accessLiveDoorGroups = [];
let _accessLiveDevices = [];
let _accessLiveMetaLoaded = false;
let _accessLiveEventSource = null;
let _accessLiveStreamKey = '';
let _accessLiveStreamRetryTimer = null;

const ACCESS_LIVE_REFRESH_MS = 6000;

function accessLiveVisible() {
  return !document.getElementById('viewAccessLive')?.classList.contains('hidden');
}

function accessLiveEventTypeLabel(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'saida_manual') return 'saida manual';
  if (key === 'saida') return 'saida';
  return 'entrada';
}

function accessLiveEventBadge(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'saida_manual') return '<span class="pill amber">saida manual</span>';
  if (key === 'saida') return '<span class="pill neutral">saida</span>';
  return '<span class="pill success">entrada</span>';
}

function accessLiveNotificationBadge(status) {
  const raw = String(status || '').toLowerCase();
  if (!raw) return '<span class="pill neutral">sem envio</span>';
  if (raw.includes('sent') || raw.includes('enviad') || raw.includes('delivered')) return '<span class="pill success">enviada</span>';
  if (raw.includes('fail') || raw.includes('erro') || raw.includes('error')) return '<span class="pill danger">falha</span>';
  if (raw.includes('skip')) return '<span class="pill neutral">ignorada</span>';
  return `<span class="pill neutral">${esc(status)}</span>`;
}

function accessLivePersonName(event) {
  return String(event?.person_name || event?.person_name_raw || 'Pessoa nao identificada').trim();
}

function accessLivePersonMeta(event) {
  return [event?.person_enrollment || event?.person_document || '', event?.site || 'Sem site']
    .filter(Boolean)
    .join(' - ');
}

function accessLiveDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function accessLiveDateShort(value) {
  const date = accessLiveDate(value);
  if (!date) return '-';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function accessLiveTimeAgo(value) {
  const date = accessLiveDate(value);
  if (!date) return 'sem horario';
  const diff = Math.max(0, Date.now() - date.getTime());
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `${min} min atras`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h ${min % 60}min atras`;
  const days = Math.floor(hours / 24);
  return `${days}d atras`;
}

function accessLiveInitials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  const initials = parts.slice(0, 2).map(part => part[0]).join('').toUpperCase();
  return initials || '--';
}

function accessLiveBuildQuery() {
  const query = new URLSearchParams();
  query.set('period', 'today');
  query.set('limit', '120');
  const site = document.getElementById('accessLiveSite')?.value || '';
  const doorGroupId = document.getElementById('accessLiveDoorGroup')?.value || '';
  const deviceId = document.getElementById('accessLiveDevice')?.value || '';
  const type = document.getElementById('accessLiveType')?.value || '';
  if (site) query.set('site', site);
  if (deviceId) query.set('device_id', deviceId);
  else if (doorGroupId) query.set('door_group_id', doorGroupId);
  if (type) query.set('type', type);
  return query;
}

function accessLiveStreamUrl() {
  const query = accessLiveBuildQuery();
  query.delete('period');
  query.delete('limit');
  return `${API_BASE}/api/access-control/live/stream?${query.toString()}`;
}

function stopAccessLiveStream() {
  if (_accessLiveStreamRetryTimer) {
    clearTimeout(_accessLiveStreamRetryTimer);
    _accessLiveStreamRetryTimer = null;
  }
  if (_accessLiveEventSource) {
    _accessLiveEventSource.close();
    _accessLiveEventSource = null;
  }
  _accessLiveStreamKey = '';
}

function scheduleAccessLiveStreamReconnect() {
  if (_accessLiveStreamRetryTimer) return;
  _accessLiveStreamRetryTimer = setTimeout(() => {
    _accessLiveStreamRetryTimer = null;
    startAccessLiveStream(true);
  }, 5000);
}

function startAccessLiveStream(force = false) {
  if (typeof EventSource === 'undefined') return;
  if (!accessLiveVisible()) {
    stopAccessLiveStream();
    return;
  }
  const streamUrl = accessLiveStreamUrl();
  if (!force && _accessLiveEventSource && _accessLiveStreamKey === streamUrl) return;
  stopAccessLiveStream();
  _accessLiveStreamKey = streamUrl;
  _accessLiveEventSource = new EventSource(streamUrl);
  _accessLiveEventSource.addEventListener('ready', () => {
    setText('accessLiveState', 'ao vivo');
  });
  _accessLiveEventSource.addEventListener('access-event', () => {
    _accessLiveLastLoadedAt = 0;
    loadAccessLive(false);
  });
  _accessLiveEventSource.onerror = () => {
    if (!accessLiveVisible()) {
      stopAccessLiveStream();
      return;
    }
    setText('accessLiveState', 'reconectando');
    stopAccessLiveStream();
    scheduleAccessLiveStreamReconnect();
  };
}

function accessLiveCurrentSite() {
  return document.getElementById('accessLiveSite')?.value || '';
}

function accessLiveDeviceLabel(device) {
  return [device?.name || device?.host || 'Controladora', device?.access_direction || '']
    .filter(Boolean)
    .join(' - ');
}

function accessLiveMatchesSite(item, site) {
  return !site || String(item?.site || '').trim() === site;
}

function accessLiveDeviceInGroup(device, doorGroupId) {
  if (!doorGroupId) return true;
  const group = _accessLiveDoorGroups.find(item => String(item.id || '') === String(doorGroupId));
  const ids = Array.isArray(group?.device_ids) ? group.device_ids.map(String) : [];
  return ids.includes(String(device?.id || ''));
}

function accessLiveScopeLabel() {
  const site = accessLiveCurrentSite();
  const doorGroupId = document.getElementById('accessLiveDoorGroup')?.value || '';
  const deviceId = document.getElementById('accessLiveDevice')?.value || '';
  const device = _accessLiveDevices.find(item => String(item.id || '') === String(deviceId));
  const group = _accessLiveDoorGroups.find(item => String(item.id || '') === String(doorGroupId));
  if (device) return accessLiveDeviceLabel(device);
  if (group) return group.name || 'Grupo selecionado';
  if (site) return site;
  return 'Todos os setores';
}

function renderAccessLiveScope() {
  setText('accessLiveScope', accessLiveScopeLabel());
}

function populateAccessLiveDoorGroups() {
  const select = document.getElementById('accessLiveDoorGroup');
  if (!select) return;
  const site = accessLiveCurrentSite();
  const current = select.value;
  const groups = _accessLiveDoorGroups.filter(item => accessLiveMatchesSite(item, site));
  select.innerHTML = '<option value="">Todos os grupos</option>' + groups.map(group => {
    const count = Array.isArray(group.device_ids) ? group.device_ids.length : 0;
    const suffix = count ? ` (${count})` : '';
    return `<option value="${esc(group.id || '')}">${esc(group.name || 'Grupo')}${esc(suffix)}</option>`;
  }).join('');
  if (current && groups.some(group => String(group.id || '') === current)) select.value = current;
}

function populateAccessLiveDevices() {
  const select = document.getElementById('accessLiveDevice');
  if (!select) return;
  const site = accessLiveCurrentSite();
  const doorGroupId = document.getElementById('accessLiveDoorGroup')?.value || '';
  const current = select.value;
  const devices = _accessLiveDevices
    .filter(device => accessLiveMatchesSite(device, site))
    .filter(device => accessLiveDeviceInGroup(device, doorGroupId));
  select.innerHTML = '<option value="">Todas as controladoras</option>' + devices.map(device => (
    `<option value="${esc(device.id || '')}">${esc(accessLiveDeviceLabel(device))}</option>`
  )).join('');
  if (current && devices.some(device => String(device.id || '') === current)) select.value = current;
}

async function populateAccessLiveMeta(force = false) {
  if (_accessLiveMetaLoaded && !force) {
    populateAccessLiveDoorGroups();
    populateAccessLiveDevices();
    renderAccessLiveScope();
    return;
  }
  const [groupsRes, devicesRes] = await Promise.all([
    apiJson('/api/access-control/door-groups', { forceRefresh: true, cacheTtl: 0 }).catch(() => null),
    apiJson('/api/access-control/devices', { forceRefresh: true, cacheTtl: 0 }).catch(() => null),
  ]);
  _accessLiveDoorGroups = Array.isArray(groupsRes?.door_groups) ? groupsRes.door_groups : [];
  _accessLiveDevices = Array.isArray(devicesRes?.devices) ? devicesRes.devices : [];
  _accessLiveMetaLoaded = true;
  populateAccessLiveDoorGroups();
  populateAccessLiveDevices();
  renderAccessLiveScope();
}

function accessLivePeopleFromEvents(events) {
  const map = new Map();
  events.forEach(event => {
    const key = String(event.person_id || event.person_enrollment || event.person_document || accessLivePersonName(event)).trim();
    if (!key) return;
    const current = map.get(key);
    const eventTime = accessLiveDate(event.occurred_at)?.getTime() || 0;
    const currentTime = accessLiveDate(current?.latest?.occurred_at)?.getTime() || 0;
    const next = current || {
      key,
      personId: event.person_id || '',
      name: accessLivePersonName(event),
      meta: accessLivePersonMeta(event),
      site: event.site || '',
      entries: 0,
      exits: 0,
      manualExits: 0,
      latest: event,
      firstEntry: '',
      lastEntry: '',
      lastExit: '',
    };
    if (event.event_type === 'entrada') {
      next.entries += 1;
      next.lastEntry = next.lastEntry || event.occurred_at;
      next.firstEntry = event.occurred_at;
    } else if (event.event_type === 'saida' || event.event_type === 'saida_manual') {
      next.exits += 1;
      if (event.event_type === 'saida_manual') next.manualExits += 1;
      next.lastExit = next.lastExit || event.occurred_at;
    }
    if (eventTime >= currentTime) next.latest = event;
    map.set(key, next);
  });
  return [...map.values()].sort((a, b) => {
    const at = accessLiveDate(a.latest?.occurred_at)?.getTime() || 0;
    const bt = accessLiveDate(b.latest?.occurred_at)?.getTime() || 0;
    return bt - at;
  });
}

function accessLiveAttentionItems(events, people) {
  const items = [];
  events.filter(event => !String(event.person_id || '').trim()).slice(0, 3).forEach(event => {
    items.push({
      kind: 'Sem cadastro',
      title: accessLivePersonName(event),
      meta: `${event.site || 'Sem site'} - ${accessLiveDateShort(event.occurred_at)}`,
      icon: 'user-x',
    });
  });
  events.filter(event => {
    const status = String(event.notification_status || '').toLowerCase();
    return status.includes('fail') || status.includes('erro') || status.includes('error');
  }).slice(0, 3).forEach(event => {
    items.push({
      kind: 'Notificacao',
      title: accessLivePersonName(event),
      meta: event.notification_status || 'falha no envio',
      icon: 'message-circle',
    });
  });
  people.filter(item => {
    if (item.latest?.event_type !== 'entrada') return false;
    const date = accessLiveDate(item.lastEntry || item.firstEntry);
    return date && (Date.now() - date.getTime()) > 6 * 60 * 60 * 1000;
  }).slice(0, 3).forEach(item => {
    items.push({
      kind: 'Permanencia',
      title: item.name,
      meta: `${item.site || 'Sem site'} - ${accessLiveTimeAgo(item.lastEntry || item.firstEntry)}`,
      icon: 'clock',
    });
  });
  return items.slice(0, 6);
}

function renderAccessLiveLast(event) {
  const box = document.getElementById('accessLiveCurrent');
  if (!box) return;
  if (!event) {
    box.className = 'access-live-current is-empty';
    box.innerHTML = `
      <div class="access-live-photo-placeholder">--</div>
      <div class="access-live-current-copy">
        <span class="access-live-kind">sem evento</span>
        <h3>Nenhuma movimentacao carregada</h3>
        <p>Quando uma pessoa passar pela controladora, o evento aparece aqui primeiro.</p>
        <div class="access-live-facts">
          <span><small>Site</small><b>-</b></span>
          <span><small>Dispositivo</small><b>-</b></span>
          <span><small>Horario</small><b>-</b></span>
        </div>
      </div>
    `;
    setText('accessLiveLastSub', 'Aguardando evento.');
    return;
  }
  const name = accessLivePersonName(event);
  const kind = String(event.event_type || 'entrada').toLowerCase();
  const kindLabel = accessLiveEventTypeLabel(kind);
  const passLabel = kind === 'saida_manual'
    ? 'Saida manual registrada'
    : kind === 'saida'
      ? 'Saida confirmada'
      : 'Entrada confirmada';
  const passIcon = kind === 'entrada' ? 'log-in' : 'log-out';
  const photo = event.person_id
    ? `<img src="${API_BASE}/api/access-control/people/${encodeURIComponent(event.person_id)}/face-photo" alt="Foto de ${esc(name)}" loading="lazy" onerror="this.remove()">`
    : '';
  box.className = `access-live-current is-${esc(kind || 'entrada')}`;
  box.innerHTML = `
    <div class="access-live-photo">
      ${photo}
      <span>${esc(accessLiveInitials(name))}</span>
    </div>
    <div class="access-live-current-copy">
      <div class="access-live-pass-top">
        <span class="access-live-pass-state"><i data-lucide="${esc(passIcon)}"></i>${esc(passLabel)}</span>
        <span class="access-live-pass-age"><i data-lucide="clock-3"></i>${esc(accessLiveTimeAgo(event.occurred_at))}</span>
      </div>
      <span class="access-live-kind">${accessLiveEventBadge(event.event_type)} ${accessLiveNotificationBadge(event.notification_status)}</span>
      <h3>${esc(name)}</h3>
      <p>${esc(accessLivePersonMeta(event) || 'Sem identificacao complementar')}</p>
      <div class="access-live-facts">
        <span><small>Site</small><b>${esc(event.site || '-')}</b></span>
        <span><small>Dispositivo</small><b>${esc(event.device_name || event.device_id || '-')}</b></span>
        <span><small>Horario</small><b>${esc(accessLiveDateShort(event.occurred_at))}</b></span>
      </div>
    </div>
  `;
  setText('accessLiveLastSub', `${kindLabel} - ${accessLiveTimeAgo(event.occurred_at)}`);
}

function renderAccessLiveFeed(events) {
  const feed = document.getElementById('accessLiveFeed');
  if (!feed) return;
  if (!events.length) {
    feed.innerHTML = '<div class="access-live-empty">Nenhum evento no filtro atual.</div>';
    return;
  }
  feed.innerHTML = events.slice(0, 18).map(event => {
    const name = accessLivePersonName(event);
    return `
      <article class="access-live-feed-item">
        <div class="access-live-dot ${esc(event.event_type || 'entrada')}"></div>
        <div>
          <strong>${esc(name)}</strong>
          <span>${esc([event.site || '', event.device_name || event.device_id || ''].filter(Boolean).join(' - ') || 'Sem local')}</span>
        </div>
        <div class="access-live-feed-meta">
          ${accessLiveEventBadge(event.event_type)}
          <b>${esc(accessLiveDateShort(event.occurred_at))}</b>
        </div>
      </article>
    `;
  }).join('');
}

function renderAccessLiveInside(people) {
  const inside = people.filter(item => item.latest?.event_type === 'entrada');
  const list = document.getElementById('accessLiveInsideList');
  setText('accessLiveInsideCount', `${inside.length} pessoa${inside.length === 1 ? '' : 's'}`);
  if (!list) return;
  if (!inside.length) {
    list.innerHTML = '<div class="access-live-empty">Sem pessoas presentes no filtro atual.</div>';
    return;
  }
  list.innerHTML = inside.slice(0, 10).map(item => `
    <article class="access-live-person-row">
      <div class="access-live-avatar">${esc(accessLiveInitials(item.name))}</div>
      <div>
        <strong>${esc(item.name)}</strong>
        <span>${esc(item.meta || item.site || 'Sem site')}</span>
      </div>
      <b>${esc(accessLiveTimeAgo(item.lastEntry || item.firstEntry))}</b>
    </article>
  `).join('');
}

function renderAccessLiveAttention(items) {
  const list = document.getElementById('accessLiveAttentionList');
  setText('accessLiveAttentionCount', `${items.length} item${items.length === 1 ? '' : 's'}`);
  if (!list) return;
  if (!items.length) {
    list.innerHTML = '<div class="access-live-empty">Nenhuma pendencia no momento.</div>';
    return;
  }
  list.innerHTML = items.map(item => `
    <article class="access-live-attention-row">
      <div class="access-live-attention-icon"><i data-lucide="${esc(item.icon)}"></i></div>
      <div>
        <span>${esc(item.kind)}</span>
        <strong>${esc(item.title)}</strong>
        <small>${esc(item.meta)}</small>
      </div>
    </article>
  `).join('');
}

function renderAccessLive(summary, events) {
  const report = summary || {};
  const people = accessLivePeopleFromEvents(events);
  const attention = accessLiveAttentionItems(events, people);
  const notificationFailures = events.filter(event => {
    const status = String(event.notification_status || '').toLowerCase();
    return status.includes('fail') || status.includes('erro') || status.includes('error');
  }).length;
  const longPresent = people.filter(item => {
    if (item.latest?.event_type !== 'entrada') return false;
    const date = accessLiveDate(item.lastEntry || item.firstEntry);
    return date && (Date.now() - date.getTime()) > 6 * 60 * 60 * 1000;
  }).length;
  setText('accessLiveEntries', report.entries || 0);
  setText('accessLiveExits', Number(report.exits || 0) + Number(report.manual_exits || 0));
  setText('accessLiveInside', report.inside_now ?? people.filter(item => item.latest?.event_type === 'entrada').length);
  setText('accessLiveAttention', Number(report.without_person || 0) + notificationFailures + longPresent);
  setText('accessLiveState', events.length ? 'ao vivo' : 'sem eventos');
  renderAccessLiveLast(events[0] || null);
  renderAccessLiveFeed(events);
  renderAccessLiveInside(people);
  renderAccessLiveAttention(attention);
  lucide.createIcons();
}

async function populateAccessLiveSites(force = false) {
  const select = document.getElementById('accessLiveSite');
  if (!select || (_accessLiveSitesLoaded && !force)) return;
  const current = select.value;
  const data = await apiJson('/api/access-control/people/sites', { forceRefresh: force, cacheTtl: 0 }).catch(() => null);
  const sites = Array.isArray(data?.sites) ? data.sites : [];
  select.innerHTML = '<option value="">Todos os sites</option>' + sites
    .filter(Boolean)
    .map(site => `<option value="${esc(site)}">${esc(site)}</option>`)
    .join('');
  if (current && sites.includes(current)) select.value = current;
  _accessLiveSitesLoaded = true;
}

async function loadAccessLive(force = false) {
  if (_accessLiveLoading) return;
  if (!accessLiveVisible() && !force) return;
  _accessLiveLoading = true;
  const btn = document.getElementById('btnAccessLiveRefresh');
  const oldHtml = btn?.innerHTML;
  if (btn && force) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Atualizando';
    lucide.createIcons();
  }
  try {
    await populateAccessLiveSites(force);
    await populateAccessLiveMeta(force);
    const query = accessLiveBuildQuery();
    const [summaryRes, eventsRes] = await Promise.all([
      apiJson(`/api/access-control/reports/summary?${query.toString()}`, { forceRefresh: true, cacheTtl: 0 }),
      apiJson(`/api/access-control/reports/events?${query.toString()}`, { forceRefresh: true, cacheTtl: 0 }),
    ]);
    renderAccessLive(summaryRes?.summary || {}, eventsRes?.events || []);
    renderAccessLiveScope();
    _accessLiveLastLoadedAt = Date.now();
    startAccessLiveStream();
  } catch (err) {
    console.warn('SightOps access live failed', err);
    setText('accessLiveState', 'erro');
    if (force) showToast(err?.message || 'Nao foi possivel atualizar o acesso ao vivo.', true);
  } finally {
    _accessLiveLoading = false;
    if (btn && force) {
      btn.disabled = false;
      btn.innerHTML = oldHtml || '<i data-lucide="refresh-cw"></i> Atualizar';
      lucide.createIcons();
    }
  }
}

function bindAccessLive() {
  if (_accessLiveBindingDone) return;
  _accessLiveBindingDone = true;
  document.getElementById('btnAccessLiveRefresh')?.addEventListener('click', () => loadAccessLive(true));
  document.getElementById('accessLiveSite')?.addEventListener('change', () => {
    populateAccessLiveDoorGroups();
    populateAccessLiveDevices();
    renderAccessLiveScope();
    loadAccessLive(true);
    startAccessLiveStream(true);
  });
  document.getElementById('accessLiveDoorGroup')?.addEventListener('change', () => {
    populateAccessLiveDevices();
    renderAccessLiveScope();
    loadAccessLive(true);
    startAccessLiveStream(true);
  });
  document.getElementById('accessLiveDevice')?.addEventListener('change', () => {
    renderAccessLiveScope();
    loadAccessLive(true);
    startAccessLiveStream(true);
  });
  document.getElementById('accessLiveType')?.addEventListener('change', () => {
    loadAccessLive(true);
    startAccessLiveStream(true);
  });
  if (!_accessLiveTimer) {
    _accessLiveTimer = setInterval(() => {
      if (!accessLiveVisible()) {
        stopAccessLiveStream();
        return;
      }
      startAccessLiveStream();
      if (Date.now() - _accessLiveLastLoadedAt < ACCESS_LIVE_REFRESH_MS - 500) return;
      loadAccessLive(false);
    }, ACCESS_LIVE_REFRESH_MS);
  }
}

document.addEventListener('DOMContentLoaded', bindAccessLive);
