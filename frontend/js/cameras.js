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
  const candidates = [
    c.imgbb_url,
    c.imgbb_thumb_url,
    c.thumbnail_url,
    c.thumb_url,
    c.display_url,
    c.url,
    c.snapshot_url,
  ];
  return candidates.map(v => String(v || '').trim()).find(isImgbbUrl) || '';
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
  try {
    await _loadCamForMode(view);
    updateCamTabs();
    populateCamSiteFilter();
  } catch (e) {
    console.warn('Falha ao carregar visao', view, e);
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
  await _loadCamForMode(desired);
  updateCamTabs();
  populateCamSiteFilter();
  applyInvOltFilters();
}

async function _loadCamForMode(mode) {
  const inventoryMode = mode === 'switch' ? 'switch' : mode === 'basico' ? 'basico' : 'olt';
  const [camData, swData, oltData] = await Promise.all([
    apiJson(`/api/cameras?mode=${encodeURIComponent(inventoryMode)}&_=${Date.now()}`),
    mode === 'switch' ? apiJson('/api/switch/rows') : Promise.resolve(null),
    mode === 'olt'    ? apiJson(`/api/olt/rows?compact=true&_=${Date.now()}`) : Promise.resolve(null),
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
        pon:        olt.pon        || c.pon        || '',
        onu_id:     olt.onu_id     || c.onu_id     || '',
        onu_name:   olt.onu_name   || c.onu_name   || '',
        onu_serial: olt.onu_serial || c.onu_serial || '',
        onu_oper_status: olt.oper_status || c.onu_oper_status || '',
        onu_omci_status: olt.omci_status || c.onu_omci_status || '',
        onu_rx: olt.onu_rx || c.onu_rx || '',
        olt_rx: olt.olt_rx || c.olt_rx || '',
        onu_telemetry_updated_at: olt.telemetry_updated_at || c.onu_telemetry_updated_at || '',
      };
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

function cameraOnuHealth(cam = {}) {
  if (!cam.pon || !cam.onu_id) {
    return { state: 'unlinked', label: 'Nao associada', detail: 'Camera sem PON/ONU associada' };
  }
  const oper = String(cam.onu_oper_status || '').trim().toLowerCase();
  const omci = String(cam.onu_omci_status || '').trim().toLowerCase();
  const up = ['active', 'online', 'up'].includes(oper);
  const down = ['inactive', 'offline', 'down', 'los', 'dying-gasp', 'dying_gasp'].includes(oper);
  const signal = cam.onu_rx ? `ONU RX ${cam.onu_rx}` : '';
  if (up) return { state: 'up', label: 'ONU online', detail: [cam.onu_oper_status, omci ? `OMCI ${cam.onu_omci_status}` : '', signal].filter(Boolean).join(' - ') };
  if (down) return { state: 'down', label: 'ONU offline', detail: [cam.onu_oper_status, signal].filter(Boolean).join(' - ') };
  return { state: 'unknown', label: 'ONU nao verificada', detail: 'Atualize os estados no Monitoramento' };
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
  setText('cpIp',     cam.ip     || '');
  setText('cpMac',    cam.mac    || '');
  setText('cpModelo', cam.model  || '');
  setText('cpLocal',  cam.local  || '');
  setText('cpPonOnu', [cam.pon, cam.onu_id].filter(Boolean).join(' / ') || '');
  setText('cpSerial', cam.onu_serial || '');
  const onuHealth = cameraOnuHealth(cam);
  const onuStatus = document.getElementById('cpOnuStatus');
  if (onuStatus) {
    onuStatus.className = `cam-onu-status ${onuHealth.state}`;
    onuStatus.innerHTML = `<span class="cam-onu-status-dot"></span><span>${esc(onuHealth.label)}</span>`;
    onuStatus.title = onuHealth.detail;
  }

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
  closeCamPanelLive();
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

function openCamPanelLive() {
  if (!_invOltActive?.ip) return;
  const live = document.getElementById('cpInlineLive');
  const auth = document.getElementById('cpLiveAuth');
  const status = document.getElementById('cpLiveStatus');
  const video = document.getElementById('cpLiveVideo');
  if (!live || !auth || !status || !video) return;
  live.classList.remove('hidden');
  auth.style.display = '';
  status.classList.add('hidden');
  video.classList.add('hidden');
  video.srcObject = null;
  document.getElementById('cpLiveUser').value = document.getElementById('mntCamUser')?.value || 'admin';
  document.getElementById('cpLivePass').value = document.getElementById('mntCamPass')?.value || '';
  setTimeout(() => {
    const pass = document.getElementById('cpLivePass');
    if (pass && !pass.value) pass.focus();
    else document.getElementById('cpLiveStart')?.focus();
  }, 60);
  lucide.createIcons();
}

let _cpRtcPeer = null;
let _cpLiveIp = '';

function closeCamPanelLive() {
  if (_cpRtcPeer) { try { _cpRtcPeer.close(); } catch(e){} _cpRtcPeer = null; }
  _cpLiveIp = '';
  const video = document.getElementById('cpLiveVideo');
  if (video) { video.srcObject = null; video.classList.add('hidden'); }
  const live = document.getElementById('cpInlineLive');
  live?.classList.remove('playing', 'mobile-fullscreen');
  live?.classList.add('hidden');
  document.body.classList.remove('cam-live-lock');
  const status = document.getElementById('cpLiveStatus');
  if (status) status.classList.add('hidden');
}

function cameraStreamHint(ip, fallback = null) {
  const lists = [
    fallback ? [fallback] : [],
    _invOltActive ? [_invOltActive] : [],
    Array.isArray(_mntCamAll) ? _mntCamAll : [],
    _invCam?.basic || [],
    _invCam?.olt || [],
    _invCam?.switch || []
  ];
  for (const list of lists) {
    const cam = list.find?.(c => String(c?.ip || c?.host || '') === String(ip));
    if (cam) {
      return {
        vendor: cam.fabricante || cam.vendor || cam.brand || '',
        model: cam.modelo || cam.model || cam.camera_model || ''
      };
    }
  }
  return { vendor: '', model: '' };
}

function isHikvisionStream(hint = {}) {
  const txt = `${hint.vendor || ''} ${hint.model || ''}`.toLowerCase();
  return txt.includes('hikvision') || txt.includes('ds-2') || txt.includes('ipc-');
}

function buildCameraRtspUrl(ip, user, pass, subtype = 1, hint = {}) {
  const st = Number(subtype) === 0 ? 0 : 1;
  const auth = `${encodeURIComponent(user || 'admin')}:${encodeURIComponent(pass || '')}`;
  if (isHikvisionStream(hint)) {
    return `rtsp://${auth}@${ip}:554/Streaming/Channels/${st === 0 ? '101' : '102'}`;
  }
  return `rtsp://${auth}@${ip}:554/cam/realmonitor?channel=1&subtype=${st}`;
}

function toggleCamLivePassword() {
  const input = document.getElementById('cpLivePass');
  const btn = document.getElementById('cpLivePassToggle');
  if (!input || !btn) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.innerHTML = `<i data-lucide="${show ? 'eye-off' : 'eye'}"></i>`;
  btn.title = show ? 'Ocultar senha' : 'Mostrar senha';
  btn.setAttribute('aria-label', btn.title);
  lucide.createIcons();
}

function fullscreenCamPanelLive() {
  const live = document.getElementById('cpInlineLive');
  if (!live) return;
  const btn = document.getElementById('cpLiveFullscreen');
  const setIcon = (expanded) => {
    if (!btn) return;
    btn.innerHTML = `<i data-lucide="${expanded ? 'minimize-2' : 'maximize-2'}"></i>`;
    btn.title = expanded ? 'Reduzir video' : 'Ampliar video';
    lucide.createIcons();
  };

  if (live.classList.contains('mobile-fullscreen')) {
    live.classList.remove('mobile-fullscreen');
    document.body.classList.remove('cam-live-lock');
    setIcon(false);
    return;
  }

  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
    setIcon(false);
    return;
  }

  const useFallback = () => {
    live.classList.add('mobile-fullscreen');
    document.body.classList.add('cam-live-lock');
    setIcon(true);
  };

  if (live.requestFullscreen) {
    live.requestFullscreen()
      .then(() => setIcon(true))
      .catch(useFallback);
  } else {
    useFallback();
  }
}

async function startCamPanelLive() {
  if (!_invOltActive?.ip) return;
  const ip = _invOltActive.ip;
  const user = document.getElementById('cpLiveUser')?.value.trim() || 'admin';
  const pass = document.getElementById('cpLivePass')?.value || '';
  if (!pass) {
    showToast('Informe a senha da camera para ver ao vivo.', true);
    document.getElementById('cpLivePass')?.focus();
    return;
  }

  const auth = document.getElementById('cpLiveAuth');
  const status = document.getElementById('cpLiveStatus');
  const statusText = status?.querySelector('span');
  const video = document.getElementById('cpLiveVideo');
  if (!auth || !status || !video) return;

  if (_cpRtcPeer) { try { _cpRtcPeer.close(); } catch(e){} _cpRtcPeer = null; }
  _cpLiveIp = ip;
  auth.style.display = 'none';
  status.classList.remove('hidden');
  if (statusText) statusText.textContent = 'Conectando...';
  video.srcObject = null;
  video.classList.add('hidden');

  const subtype = 1;
  const streamName = `cam_${ip.replace(/\./g, '_')}_${subtype}`;
  const hint = cameraStreamHint(ip, _invOltActive);
  try {
    const params = new URLSearchParams({
      user,
      password: pass,
      subtype: String(subtype),
      vendor: hint.vendor || '',
      model: hint.model || ''
    });
    const regResp = await api(
      `/api/maintenance/stream_register/${ip}?${params.toString()}`,
      { method: 'POST' }
    );
    if (!regResp || !regResp.ok) {
      if (statusText) statusText.textContent = 'Falha ao registrar stream';
      auth.style.display = '';
      return;
    }
  } catch (e) {
    if (statusText) statusText.textContent = 'Servidor de stream indisponivel';
    auth.style.display = '';
    return;
  }

  if (_cpLiveIp !== ip) return;

  try {
    const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
    _cpRtcPeer = pc;

    pc.ontrack = ({ streams }) => {
      if (!streams[0] || _cpLiveIp !== ip) return;
      video.srcObject = streams[0];
      video.muted = true;
      video.classList.remove('hidden');
      document.getElementById('cpInlineLive')?.classList.add('playing');
      status.classList.add('hidden');
    };

    pc.oniceconnectionstatechange = () => {
      if (_cpLiveIp === ip && ['failed','disconnected'].includes(pc.iceConnectionState)) {
        if (statusText) statusText.textContent = 'Stream desconectado';
        status.classList.remove('hidden');
      }
    };

    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.addTransceiver('audio', { direction: 'recvonly' });

    const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${wsProto}://${location.host}/go2rtc/api/ws?src=${streamName}`);

    ws.onopen = async () => {
      if (statusText) statusText.textContent = 'Aguardando video...';
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
        if (statusText) statusText.textContent = 'Erro: ' + msg.value;
        status.classList.remove('hidden');
        auth.style.display = '';
      }
    };

    ws.onerror = () => {
      if (_cpLiveIp === ip && statusText) statusText.textContent = 'Erro de conexao WebSocket';
      status.classList.remove('hidden');
      auth.style.display = '';
    };
  } catch (e) {
    if (statusText) statusText.textContent = 'Erro: ' + (e.message || e);
    status.classList.remove('hidden');
    auth.style.display = '';
  }
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
    _fillTrocarIpNetwork(cam.ip, true);
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
