// Implantacao > Projetos: parque planejado, separado do inventario real.
let _planningProjects = [];
let _planningCurrent = null;
let _planningMap = null;
let _planningMapLayers = null;
let _planningMarkers = {};
let _planningCatalog = null;

const PLANNING_TYPES = {
  camera: 'Camera', onu: 'ONU', ont: 'ONT', olt: 'OLT', switch: 'Switch',
  injector: 'Injetor PoE', cto: 'CTO', recorder: 'Gravador', box: 'Caixa de CFTV', pole: 'Poste', other: 'Outro',
};
function planningPoeCapacity(metadata) {
  const poe = Number(metadata?.poe_port_capacity);
  return poe > 0 ? poe : Number(metadata?.port_capacity || 0);
}

const PLANNING_STATUS = {
  draft: 'Rascunho', planned: 'Planejado', approved: 'Aprovado',
  deploying: 'Em implantacao', completed: 'Concluido',
};

function planningEscape(value) {
  return typeof esc === 'function' ? esc(value ?? '') : String(value ?? '').replace(/[&<>"']/g, '');
}

function planningNaturalCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), 'pt-BR', { numeric: true, sensitivity: 'base' });
}

async function planningRequest(path, options = {}) {
  const res = await api(path, options);
  return jsonOrReadableError(res, 'Nao foi possivel concluir a operacao do projeto.');
}

async function planningMultipart(path, formData) {
  const headers = {};
  if (_token) headers.Authorization = `Bearer ${_token}`;
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', body: formData, headers, credentials: 'same-origin' });
  if (res.status === 401) {
    _token = null;
    showLoginScreen();
  }
  return jsonOrReadableError(res, 'Nao foi possivel importar o arquivo.');
}

async function loadPlanning(force = false) {
  const data = await apiJson('/api/planning/projects', { forceRefresh: force, cacheTtl: 0 });
  _planningProjects = data?.items || [];
  renderPlanningProjects();
  const currentId = Number(_planningCurrent?.id || 0);
  const next = _planningProjects.find(item => Number(item.id) === currentId) || _planningProjects[0];
  if (next) await selectPlanningProject(next.id);
  else showPlanningEmpty();
}

function renderPlanningProjects() {
  const box = document.getElementById('planningProjectList');
  const count = document.getElementById('planningProjectCount');
  if (!box || !count) return;
  count.textContent = `${_planningProjects.length} projeto(s).`;
  if (!_planningProjects.length) {
    box.innerHTML = '<div class="planning-list-empty">Nenhum projeto cadastrado.</div>';
    return;
  }
  box.innerHTML = _planningProjects.map(item => `
    <button class="planning-project-card ${Number(item.id) === Number(_planningCurrent?.id) ? 'active' : ''}" onclick="selectPlanningProject(${Number(item.id)})">
      <span class="planning-project-card-top"><strong>${planningEscape(item.name)}</strong><span>${planningEscape(PLANNING_STATUS[item.status] || item.status)}</span></span>
      <small>${planningEscape(item.client_name || 'Cliente nao informado')}</small>
      <span class="planning-project-card-stats">${Number(item.sites_count || 0)} sites · ${Number(item.cameras_count || 0)} cameras · ${Number(item.onus_count || 0)} ONUs</span>
    </button>`).join('');
}

function showPlanningEmpty() {
  _planningCurrent = null;
  document.getElementById('planningEmpty')?.classList.remove('hidden');
  document.getElementById('planningDetail')?.classList.add('hidden');
  renderPlanningProjects();
}

async function selectPlanningProject(projectId) {
  const data = await apiJson(`/api/planning/projects/${Number(projectId)}`, { forceRefresh: true, cacheTtl: 0 });
  if (!data?.item) return;
  _planningCurrent = data.item;
  document.getElementById('planningEmpty')?.classList.add('hidden');
  document.getElementById('planningDetail')?.classList.remove('hidden');
  renderPlanningProjects();
  renderPlanningDetail();
  setTimeout(() => renderPlanningMap(), 50);
}

function renderPlanningDetail() {
  const project = _planningCurrent;
  if (!project) return;
  const devices = project.devices || [];
  const cameras = devices.filter(item => item.device_type === 'camera').length;
  const onus = devices.filter(item => ['onu', 'ont'].includes(item.device_type)).length;
  document.getElementById('planningStatus').textContent = PLANNING_STATUS[project.status] || project.status;
  document.getElementById('planningStatus').dataset.status = project.status;
  document.getElementById('planningTitle').textContent = project.name;
  document.getElementById('planningSubtitle').textContent = [project.client_name, project.description].filter(Boolean).join(' · ') || 'Projeto sem descricao.';
  document.getElementById('planningSitesKpi').textContent = (project.sites || []).length;
  document.getElementById('planningCamerasKpi').textContent = cameras;
  document.getElementById('planningOnusKpi').textContent = onus;
  document.getElementById('planningDevicesKpi').textContent = devices.length;
  fillPlanningFilters();
  renderPlanningDevices();
}

function fillPlanningFilters() {
  const select = document.getElementById('planningSiteFilter');
  const current = select?.value || '';
  if (select) {
    select.innerHTML = '<option value="">Todos os sites</option>' + (_planningCurrent?.sites || []).map(site =>
      `<option value="${Number(site.id)}">${planningEscape(site.name)}</option>`).join('');
    select.value = current;
  }
}

function filteredPlanningDevices() {
  const term = String(document.getElementById('planningSearch')?.value || '').trim().toLowerCase();
  const type = document.getElementById('planningTypeFilter')?.value || '';
  const site = document.getElementById('planningSiteFilter')?.value || '';
  return (_planningCurrent?.devices || []).filter(item => {
    if (type && item.device_type !== type) return false;
    if (site && String(item.site_id || '') !== site) return false;
    if (!term) return true;
    return [item.name, item.ip, item.model, item.manufacturer, item.site_name, item.parent_name]
      .some(value => String(value || '').toLowerCase().includes(term));
  });
}

function renderPlanningDevices() {
  const box = document.getElementById('planningDeviceList');
  if (!box) return;
  const rows = filteredPlanningDevices();
  box.closest('.planning-devices-panel')?.classList.toggle('is-empty', rows.length === 0);
  if (!rows.length) {
    box.innerHTML = '<div class="planning-list-empty"><strong>Nenhum equipamento encontrado.</strong><span>Adicione manualmente, importe um CSV ou gere cameras em lote.</span></div>';
    return;
  }
  const allDevices = _planningCurrent?.devices || [];
  box.innerHTML = rows.map(item => {
    const metadata = item.metadata || {};
    const childCount = allDevices.filter(child => Number(child.parent_id) === Number(item.id)).length;
    const relation = ['switch', 'injector'].includes(item.device_type) && metadata.port_capacity
      ? `${childCount}/${planningPoeCapacity(metadata)} portas PoE usadas`
      : item.device_type === 'box' ? `${childCount} equipamento(s) dentro`
      : (item.parent_name || (item.pon ? `PON ${item.pon}` : 'Sem vinculo'));
    return `
    <article class="planning-device-row" data-device-id="${Number(item.id)}">
      <button class="planning-device-focus" onclick="openPlanningDeviceDetails(${Number(item.id)})" title="${item.device_type === 'box' ? 'Ver equipamentos e cameras desta caixa' : 'Abrir detalhes do equipamento'}">
        <span class="planning-device-icon ${planningEscape(item.device_type)}">${item.reference_image_url ? `<img src="${planningEscape(item.reference_image_url)}" alt="Imagem ilustrativa" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'&bull;'}))">` : `<i data-lucide="${planningDeviceIcon(item.device_type)}"></i>`}</span>
        <span class="planning-device-primary"><strong title="${planningEscape(item.name)}">${planningEscape(item.name)}</strong><small>${planningEscape(PLANNING_TYPES[item.device_type] || item.device_type)} · ${planningEscape(item.site_name || 'Sem site')}</small></span>
        <span class="planning-device-ip">${planningEscape(item.ip || 'IP a definir')}</span>
        <span class="planning-device-model"><strong>${planningEscape(item.model || 'Modelo a definir')}</strong><small>${planningEscape(item.manufacturer || 'Fabricante nao informado')}</small></span>
        <span class="planning-device-parent">${planningEscape(relation)}</span>
      </button>
      <div class="planning-row-actions">
        <button class="icon-button" onclick="openPlanningDeviceModal(${Number(item.id)})" aria-label="Editar"><i data-lucide="pencil"></i></button>
        <button class="icon-button danger" onclick="deletePlanningDevice(${Number(item.id)})" aria-label="Excluir"><i data-lucide="trash-2"></i></button>
      </div>
    </article>`;
  }).join('');
  lucide.createIcons();
}

function planningDeviceIcon(type) {
  return ({ camera: 'camera', onu: 'wifi', ont: 'wifi', olt: 'radio-tower', switch: 'server', injector: 'plug-zap', cto: 'git-branch', recorder: 'hard-drive', box: 'package', pole: 'utility-pole' })[type] || 'box';
}

function planningDescendants(parentId) {
  const devices = _planningCurrent?.devices || [];
  const found = [];
  const visit = id => devices.filter(item => Number(item.parent_id) === Number(id)).forEach(item => {
    found.push(item);
    visit(item.id);
  });
  visit(parentId);
  return found;
}

function openPlanningDeviceDetails(deviceId) {
  const item = (_planningCurrent?.devices || []).find(row => Number(row.id) === Number(deviceId));
  if (!item) return;
  if (item.device_type !== 'box') {
    openPlanningDeviceModal(deviceId);
    return;
  }
  openPlanningBoxDetails(deviceId);
}

function openPlanningBoxDetails(deviceId) {
  const devices = _planningCurrent?.devices || [];
  const item = devices.find(row => Number(row.id) === Number(deviceId));
  if (!item) return;
  const direct = devices.filter(row => Number(row.parent_id) === Number(item.id));
  const descendants = planningDescendants(item.id);
  const internal = descendants.filter(row => row.device_type !== 'camera').sort((a, b) => planningNaturalCompare(a.name, b.name));
  const cameras = descendants.filter(row => row.device_type === 'camera').sort((a, b) => planningNaturalCompare(a.name, b.name));
  const distribution = internal.filter(row => ['switch', 'injector'].includes(row.device_type));
  const capacity = distribution.reduce((total, row) => total + planningPoeCapacity(row.metadata), 0);
  const usedPorts = cameras.length;
  const coordinate = [item.latitude, item.longitude].filter(value => value !== null && value !== undefined && value !== '').join(', ');
  const equipmentRows = internal.length ? internal.map(row => `
    <button class="planning-box-detail-row" type="button" onclick="closePlanningModal();openPlanningDeviceModal(${Number(row.id)})">
      <span class="planning-device-icon ${planningEscape(row.device_type)}"><i data-lucide="${planningDeviceIcon(row.device_type)}"></i></span>
      <span><strong>${planningEscape(row.name)}</strong><small>${planningEscape(PLANNING_TYPES[row.device_type] || row.device_type)} &middot; ${planningEscape([row.manufacturer, row.model].filter(Boolean).join(' / ') || 'Modelo a definir')}</small></span>
      <i data-lucide="chevron-right"></i>
    </button>`).join('') : '<div class="planning-box-empty">Nenhum equipamento interno cadastrado.</div>';
  const cameraRows = cameras.length ? cameras.map(row => {
    const distance = Number(row.metadata?.distance_to_box_m);
    const parent = devices.find(parent => Number(parent.id) === Number(row.parent_id));
    return `
      <button class="planning-box-camera-row" type="button" onclick="closePlanningModal();openPlanningDeviceModal(${Number(row.id)})">
        <span class="planning-device-icon camera"><i data-lucide="camera"></i></span>
        <span class="planning-box-camera-main"><strong>${planningEscape(row.name)}</strong><small>${planningEscape(parent?.name || 'Ligacao a definir')}</small></span>
        <span class="planning-box-camera-location"><strong>${planningEscape(row.ip || 'IP a definir')}</strong><small>${Number.isFinite(distance) ? `${distance.toFixed(1)} m da caixa` : 'Distancia a definir'}</small></span>
        <i data-lucide="chevron-right"></i>
      </button>`;
  }).join('') : '<div class="planning-box-empty">Nenhuma camera ligada a esta caixa.</div>';

  planningModal({
    eyebrow: 'Caixa de CFTV', title: item.name, wide: true, primary: 'Editar caixa',
    body: `<div class="planning-box-details">
      <div class="planning-box-summary-grid">
        <div><span>Site/local</span><strong>${planningEscape(item.site_name || 'Sem site')}</strong></div>
        <div><span>Coordenada da caixa</span><strong>${planningEscape(coordinate || 'A definir')}</strong></div>
        <div><span>Equipamentos internos</span><strong>${internal.length}</strong></div>
        <div><span>Cameras atendidas</span><strong>${cameras.length}</strong></div>
      </div>
      <div class="planning-box-capacity ${capacity && usedPorts > capacity ? 'danger' : ''}">
        <span><i data-lucide="network"></i><strong>Distribuicao PoE</strong></span>
        <span>${capacity ? `${usedPorts} de ${capacity} portas planejadas` : `${usedPorts} camera(s), capacidade ainda nao informada`}</span>
      </div>
      <section class="planning-box-section"><div class="planning-box-section-head"><div><h3>Dentro da caixa</h3><p>ONU/ONT, switch, injetor PoE e demais componentes no mesmo ponto da caixa.</p></div><span>${internal.length}</span></div>${equipmentRows}</section>
      <section class="planning-box-section"><div class="planning-box-section-head"><div><h3>Cameras ligadas</h3><p>As cameras permanecem nas coordenadas individuais e aparecem pelo vinculo com o switch ou injetor.</p></div><span>${cameras.length}</span></div>${cameraRows}</section>
    </div>`,
    onSave: async () => { closePlanningModal(); await openPlanningDeviceModal(item.id); },
  });
}

function planningModal({ eyebrow = 'Planejamento', title, body, primary = 'Salvar', onSave, wide = false }) {
  let root = document.getElementById('planningModal');
  if (!root) {
    root = document.createElement('div');
    root.id = 'planningModal';
    root.className = 'modal-backdrop hidden';
    document.body.appendChild(root);
  }
  root.innerHTML = `<div class="modal planning-modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-header"><div><p class="eyebrow">${planningEscape(eyebrow)}</p><h2>${planningEscape(title)}</h2></div><button class="icon-button" data-close><i data-lucide="x"></i></button></div>
    <div class="planning-modal-body">${body}</div>
    <div class="planning-modal-footer"><button class="secondary-action" data-close>Cancelar</button><button class="primary-action" data-save><i data-lucide="check"></i> ${planningEscape(primary)}</button></div>
  </div>`;
  root.classList.remove('hidden');
  root.onclick = event => { if (event.target === root) closePlanningModal(); };
  root.querySelectorAll('[data-close]').forEach(btn => btn.onclick = closePlanningModal);
  root.querySelector('[data-save]').onclick = async event => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try { await onSave(root); } catch (err) { showToast(err.message || 'Operacao nao concluida.', true); btn.disabled = false; }
  };
  lucide.createIcons();
  setTimeout(() => root.querySelector('input,select,textarea')?.focus(), 20);
  return root;
}

function closePlanningModal() {
  document.getElementById('planningModal')?.classList.add('hidden');
}

function planningField(label, id, value = '', extra = '', wrapAttrs = '') {
  return `<label class="planning-field" ${wrapAttrs}><span>${planningEscape(label)}</span><input id="${id}" value="${planningEscape(value)}" ${extra}></label>`;
}

// Caixa/poste/CTO sao elementos fisicos sem endereco de rede proprio;
// PON/posicao ONU so fazem sentido pra quem termina uma fibra (ONU/ONT).
const PLANNING_DEVICE_FIELD_RULES = {
  planDeviceIpField: { hideFor: ['box', 'pole', 'cto'] },
  planDevicePonField: { showOnlyFor: ['onu', 'ont'] },
  planDeviceOnuField: { showOnlyFor: ['onu', 'ont'] },
};

function refreshPlanningDeviceFields(modal) {
  const type = modal.querySelector('#planDeviceType')?.value || 'camera';
  for (const [fieldId, rule] of Object.entries(PLANNING_DEVICE_FIELD_RULES)) {
    const field = modal.querySelector(`#${fieldId}`);
    if (!field) continue;
    const hide = rule.hideFor ? rule.hideFor.includes(type) : !rule.showOnlyFor.includes(type);
    field.classList.toggle('hidden', hide);
  }
}

function openPlanningProjectModal(isNew = false) {
  const item = isNew ? {} : (_planningCurrent || {});
  planningModal({
    title: item.id ? 'Editar projeto' : 'Novo projeto',
    body: `<div class="planning-form-grid">
      ${planningField('Nome do projeto', 'planProjectName', item.name, 'placeholder="Ex: CFTV Condominio Reserva"')}
      ${planningField('Cliente', 'planProjectClient', item.client_name, 'placeholder="Nome do cliente"')}
      <label class="planning-field"><span>Situacao</span><select id="planProjectStatus">${Object.entries(PLANNING_STATUS).map(([key,label]) => `<option value="${key}" ${item.status === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      <label class="planning-field full"><span>Descricao</span><textarea id="planProjectDescription" rows="3" placeholder="Escopo e observacoes do projeto">${planningEscape(item.description || '')}</textarea></label>
    </div>`,
    onSave: async root => {
      const payload = {
        name: root.querySelector('#planProjectName').value.trim(),
        client_name: root.querySelector('#planProjectClient').value.trim(),
        status: root.querySelector('#planProjectStatus').value,
        description: root.querySelector('#planProjectDescription').value.trim(),
        kmz_layer_id: item.kmz_layer_id || '',
      };
      if (!payload.name) throw new Error('Informe o nome do projeto.');
      const path = item.id ? `/api/planning/projects/${item.id}` : '/api/planning/projects';
      const data = await planningRequest(path, { method: item.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      closePlanningModal();
      _planningCurrent = data.item;
      showToast(item.id ? 'Projeto atualizado.' : 'Projeto criado.');
      await loadPlanning(true);
    },
  });
}

function openPlanningSiteModal() {
  if (!_planningCurrent) return;
  planningModal({
    title: 'Adicionar site/local',
    body: `<div class="planning-form-grid one">${planningField('Nome do site/local', 'planSiteName', '', 'placeholder="Ex: Bloco A"')}<label class="planning-field"><span>Observacoes</span><textarea id="planSiteNotes" rows="3"></textarea></label></div>`,
    onSave: async root => {
      const name = root.querySelector('#planSiteName').value.trim();
      if (!name) throw new Error('Informe o site/local.');
      await planningRequest(`/api/planning/projects/${_planningCurrent.id}/sites`, { method: 'POST', body: JSON.stringify({ name, notes: root.querySelector('#planSiteNotes').value.trim() }) });
      closePlanningModal(); showToast('Site adicionado.'); await selectPlanningProject(_planningCurrent.id);
    },
  });
}

function planningSiteOptions(selected = '') {
  return '<option value="">Sem site</option>' + (_planningCurrent?.sites || []).map(site => `<option value="${Number(site.id)}" ${String(selected) === String(site.id) ? 'selected' : ''}>${planningEscape(site.name)}</option>`).join('');
}

function planningParentOptions(selected = '', selfId = '') {
  return '<option value="">Sem equipamento pai</option>' + (_planningCurrent?.devices || []).filter(item => Number(item.id) !== Number(selfId) && ['olt','onu','ont','switch','recorder','box','pole'].includes(item.device_type)).map(item => `<option value="${Number(item.id)}" ${String(selected) === String(item.id) ? 'selected' : ''}>${planningEscape(item.name)} (${planningEscape(PLANNING_TYPES[item.device_type])})</option>`).join('');
}

async function loadPlanningCatalog() {
  if (_planningCatalog) return _planningCatalog;
  const data = await apiJson('/api/planning/catalog', { forceRefresh: true, cacheTtl: 0 });
  _planningCatalog = data?.items || [];
  return _planningCatalog;
}

function planningCatalogDatalists(item = {}) {
  return `<datalist id="planningManufacturerOptions"></datalist><datalist id="planningModelOptions"></datalist>
    <div class="planning-catalog-hint full"><i data-lucide="list-plus"></i><span>Escolha uma sugestao ou digite um fabricante/modelo novo. Ao salvar, o novo valor passa a fazer parte das sugestoes deste cliente.</span></div>`;
}

function refreshPlanningCatalogLists(root) {
  const type = root.querySelector('#planDeviceType')?.value || 'camera';
  const manufacturer = root.querySelector('#planDeviceManufacturer')?.value.trim().toLowerCase() || '';
  const relevant = (_planningCatalog || []).filter(item => item.device_type === type || (type === 'ont' && item.device_type === 'onu'));
  const manufacturers = [...new Set(relevant.map(item => item.manufacturer).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const models = [...new Set(relevant.filter(item => !manufacturer || !item.manufacturer || item.manufacturer.toLowerCase() === manufacturer).map(item => item.model).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const manufacturerList = root.querySelector('#planningManufacturerOptions');
  const modelList = root.querySelector('#planningModelOptions');
  if (manufacturerList) manufacturerList.innerHTML = manufacturers.map(value => `<option value="${planningEscape(value)}"></option>`).join('');
  if (modelList) modelList.innerHTML = models.map(value => `<option value="${planningEscape(value)}"></option>`).join('');
}

async function openPlanningDeviceModal(deviceId = 0) {
  if (!_planningCurrent) return;
  await loadPlanningCatalog();
  const item = (_planningCurrent.devices || []).find(row => Number(row.id) === Number(deviceId)) || { device_type: 'camera' };
  const modal = planningModal({
    title: item.id ? 'Editar equipamento planejado' : 'Adicionar equipamento', wide: true,
    body: `<div class="planning-form-grid">
      <label class="planning-field"><span>Tipo</span><select id="planDeviceType">${Object.entries(PLANNING_TYPES).map(([key,label]) => `<option value="${key}" ${item.device_type === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      ${planningField('Nome/titulo', 'planDeviceName', item.name, 'placeholder="01 - ENTRADA"')}
      ${planningField('IP planejado', 'planDeviceIp', item.ip, 'placeholder="10.10.20.1"', 'id="planDeviceIpField"')}
      <label class="planning-field"><span>Site/local</span><select id="planDeviceSite">${planningSiteOptions(item.site_id)}</select></label>
      ${planningField('Fabricante', 'planDeviceManufacturer', item.manufacturer, 'list="planningManufacturerOptions" placeholder="Escolha ou digite um novo"')}
      ${planningField('Modelo', 'planDeviceModel', item.model, 'list="planningModelOptions" placeholder="Escolha ou digite um novo"')}
      <label class="planning-field"><span>Ligado a</span><select id="planDeviceParent">${planningParentOptions(item.parent_id, item.id)}</select></label>
      ${planningField('PON', 'planDevicePon', item.pon, 'placeholder="1"', 'id="planDevicePonField"')}
      ${planningField('Posicao ONU', 'planDeviceOnu', item.onu_position, 'placeholder="4"', 'id="planDeviceOnuField"')}
      ${planningField('Latitude', 'planDeviceLat', item.latitude ?? '', 'placeholder="-9.750000"')}
      ${planningField('Longitude', 'planDeviceLon', item.longitude ?? '', 'placeholder="-36.660000"')}
      ${planningField('Imagem de referencia', 'planDeviceImage', item.reference_image_url, 'placeholder="https://..."')}
      <label class="planning-field full"><span>Observacoes</span><textarea id="planDeviceNotes" rows="3">${planningEscape(item.notes || '')}</textarea></label>
      ${planningCatalogDatalists(item)}
    </div>`,
    onSave: async root => {
      const payload = planningDevicePayload(root, item.metadata || {});
      if (!payload.name) throw new Error('Informe o nome do equipamento.');
      const path = `/api/planning/projects/${_planningCurrent.id}/devices${item.id ? `/${item.id}` : ''}`;
      await planningRequest(path, { method: item.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      _planningCatalog = null;
      closePlanningModal(); showToast(item.id ? 'Equipamento atualizado.' : 'Equipamento adicionado.'); await selectPlanningProject(_planningCurrent.id);
    },
  });
  refreshPlanningCatalogLists(modal);
  refreshPlanningDeviceFields(modal);
  modal.querySelector('#planDeviceType')?.addEventListener('change', () => { refreshPlanningCatalogLists(modal); refreshPlanningDeviceFields(modal); });
  modal.querySelector('#planDeviceManufacturer')?.addEventListener('input', () => refreshPlanningCatalogLists(modal));
}

function planningDevicePayload(root, metadata = {}) {
  const value = id => root.querySelector(`#${id}`)?.value?.trim() || '';
  return {
    device_type: value('planDeviceType'), name: value('planDeviceName'), ip: value('planDeviceIp'),
    site_id: value('planDeviceSite') || null, manufacturer: value('planDeviceManufacturer'), model: value('planDeviceModel'),
    parent_id: value('planDeviceParent') || null, pon: value('planDevicePon'), onu_position: value('planDeviceOnu'),
    latitude: value('planDeviceLat') || null, longitude: value('planDeviceLon') || null,
    reference_image_url: value('planDeviceImage'), notes: value('planDeviceNotes'), metadata, status: 'planned',
  };
}

function openPlanningGenerateModal() {
  if (!_planningCurrent) return;
  planningModal({
    title: 'Gerar equipamentos em lote', wide: true, primary: 'Gerar equipamentos',
    body: `<div class="planning-form-grid">
      <label class="planning-field"><span>Tipo</span><select id="planGenType">${Object.entries(PLANNING_TYPES).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
      <label class="planning-field"><span>Site/local</span><select id="planGenSite">${planningSiteOptions()}</select></label>
      ${planningField('IP inicial', 'planGenIp', '10.10.20.1', 'placeholder="10.10.20.1"')}
      ${planningField('Quantidade', 'planGenCount', '10', 'type="number" min="1" max="500"')}
      ${planningField('Numero inicial', 'planGenFirst', '1', 'type="number" min="0"')}
      ${planningField('Digitos', 'planGenDigits', '2', 'type="number" min="1" max="4"')}
      ${planningField('Padrao do nome', 'planGenTemplate', '{number} - CAMERA', 'placeholder="{number} - CAMERA PERIMETRAL"')}
      <label class="planning-field"><span>Ligado a</span><select id="planGenParent">${planningParentOptions()}</select></label>
      ${planningField('Fabricante', 'planGenManufacturer', '', 'placeholder="Intelbras"')}
      ${planningField('Modelo', 'planGenModel', '', 'placeholder="VIP 3230 B"')}
      ${planningField('Imagem ilustrativa do modelo', 'planGenImage', '', 'placeholder="https://..."')}
      ${planningField('PON', 'planGenPon', '', 'placeholder="Opcional"')}
    </div><div class="planning-info"><i data-lucide="info"></i><span>Use <strong>{number}</strong> para a sequencia com zeros, por exemplo 01, 02 e 03. Os IPs serao incrementados automaticamente.</span></div>`,
    onSave: async root => {
      const value = id => root.querySelector(`#${id}`).value.trim();
      const payload = { device_type: value('planGenType'), site_id: value('planGenSite') || null, start_ip: value('planGenIp'), count: Number(value('planGenCount')), first_number: Number(value('planGenFirst')), digits: Number(value('planGenDigits')), name_template: value('planGenTemplate'), parent_id: value('planGenParent') || null, manufacturer: value('planGenManufacturer'), model: value('planGenModel'), reference_image_url: value('planGenImage'), pon: value('planGenPon'), status: 'planned' };
      const data = await planningRequest(`/api/planning/projects/${_planningCurrent.id}/generate`, { method: 'POST', body: JSON.stringify(payload) });
      _planningCatalog = null;
      closePlanningModal(); showToast(`${data.count} equipamento(s) gerado(s).`); await selectPlanningProject(_planningCurrent.id);
    },
  });
}

async function openPlanningBoxModal() {
  if (!_planningCurrent) return;
  await loadPlanningCatalog();
  const modal = planningModal({
    eyebrow: 'Projeto de CFTV', title: 'Montar caixa de CFTV', wide: true, primary: 'Criar caixa e equipamentos',
    body: `<div class="planning-box-wizard">
      <section class="planning-wizard-section"><div class="planning-wizard-heading"><span>1</span><div><strong>Caixa e localizacao</strong><small>Todos os equipamentos e cameras nascem neste ponto.</small></div></div><div class="planning-form-grid">
        ${planningField('Nome da caixa', 'planBoxName', '', 'placeholder="CX-01 - ENTRADA"')}
        <label class="planning-field"><span>Site/local</span><select id="planBoxSite">${planningSiteOptions()}</select></label>
        ${planningField('Latitude', 'planBoxLat', '', 'placeholder="-9.750000"')}${planningField('Longitude', 'planBoxLon', '', 'placeholder="-36.660000"')}
      </div></section>
      <section class="planning-wizard-section"><div class="planning-wizard-heading"><span>2</span><div><strong>Rede optica dentro da caixa</strong><small>Uma ONU por padrao; adicione mais quando o projeto exigir.</small></div></div><div class="planning-form-grid">
        <label class="planning-field"><span>Terminal optico</span><select id="planBoxOnuType"><option value="onu">ONU</option><option value="ont">ONT</option></select></label>
        ${planningField('Quantidade', 'planBoxOnuCount', '1', 'type="number" min="1" max="4"')}
        ${planningField('Fabricante ONU/ONT', 'planBoxOnuManufacturer', '', 'list="planningBoxOnuManufacturers" placeholder="Escolha ou digite"')}
        ${planningField('Modelo ONU/ONT', 'planBoxOnuModel', '', 'list="planningBoxOnuModels" placeholder="Escolha ou digite"')}
        ${planningField('PON', 'planBoxPon', '', 'placeholder="1"')}${planningField('Posicao ONU', 'planBoxOnuPosition', '', 'placeholder="4"')}
        <label class="planning-check full"><input id="planBoxCto" type="checkbox"><span><strong>Incluir CTO nesta caixa</strong><small>Opcional. Tambem pode ser adicionada ou editada depois.</small></span></label>
        <div class="planning-cto-fields full hidden" id="planningCtoFields">${planningField('Nome da CTO', 'planBoxCtoName', '', 'placeholder="CTO-01"')}${planningField('Modelo/capacidade', 'planBoxCtoModel', '', 'list="planningBoxCtoModels" placeholder="CTO 1x8 ou CTO 1x16"')}</div>
      </div></section>
      <section class="planning-wizard-section"><div class="planning-wizard-heading"><span>3</span><div><strong>Alimentacao das cameras</strong><small>Use switch PoE ou injetor PoE quando nao houver switch.</small></div></div><div class="planning-form-grid">
        <label class="planning-field"><span>Equipamento</span><select id="planBoxDistributionType"><option value="switch">Switch PoE</option><option value="injector">Injetor PoE</option></select></label>
        ${planningField('Quantidade', 'planBoxDistributionCount', '1', 'type="number" min="1" max="4"')}
        ${planningField('Fabricante', 'planBoxDistributionManufacturer', '', 'list="planningBoxDistributionManufacturers" placeholder="Escolha ou digite"')}
        ${planningField('Modelo', 'planBoxDistributionModel', '', 'list="planningBoxDistributionModels" placeholder="Escolha ou digite"')}
        <label class="planning-field"><span>Portas por equipamento</span><select id="planBoxPorts"><option value="1">1 porta</option><option value="5" selected>5 portas</option><option value="8">8 portas</option><option value="16">16 portas</option><option value="24">24 portas</option></select></label>
        <div class="planning-capacity-card"><span>Capacidade da caixa</span><strong id="planBoxCapacity">5 cameras</strong><small id="planBoxAvailability">5 portas livres</small></div>
      </div></section>
      <section class="planning-wizard-section"><div class="planning-wizard-heading"><span>4</span><div><strong>Cameras que saem da caixa</strong><small>As coordenadas sao herdadas da caixa e podem ser alteradas individualmente.</small></div></div><div class="planning-form-grid">
        ${planningField('Quantidade de cameras', 'planBoxCameraCount', '5', 'type="number" min="0" max="100"')}
        ${planningField('IP inicial', 'planBoxCameraIp', '', 'placeholder="10.10.20.1"')}
        ${planningField('Numero inicial', 'planBoxCameraFirst', '1', 'type="number" min="0"')}
        ${planningField('Padrao dos nomes', 'planBoxCameraTemplate', '{number} - CAMERA', 'placeholder="{number} - CAMERA"')}
        ${planningField('Fabricante das cameras', 'planBoxCameraManufacturer', '', 'list="planningBoxCameraManufacturers" placeholder="Escolha ou digite"')}
        ${planningField('Modelo das cameras', 'planBoxCameraModel', '', 'list="planningBoxCameraModels" placeholder="Escolha ou digite"')}
      </div></section>
      <datalist id="planningBoxOnuManufacturers"></datalist><datalist id="planningBoxOnuModels"></datalist><datalist id="planningBoxCtoModels"></datalist>
      <datalist id="planningBoxDistributionManufacturers"></datalist><datalist id="planningBoxDistributionModels"></datalist><datalist id="planningBoxCameraManufacturers"></datalist><datalist id="planningBoxCameraModels"></datalist>
    </div>`,
    onSave: async root => {
      const value = id => root.querySelector(`#${id}`)?.value?.trim() || '';
      const payload = {
        box_name: value('planBoxName'), site_id: value('planBoxSite') || null, latitude: value('planBoxLat') || null, longitude: value('planBoxLon') || null,
        onu_type: value('planBoxOnuType'), onu_count: Number(value('planBoxOnuCount')), onu_manufacturer: value('planBoxOnuManufacturer'), onu_model: value('planBoxOnuModel'), pon: value('planBoxPon'), onu_position: value('planBoxOnuPosition'),
        include_cto: root.querySelector('#planBoxCto').checked, cto_name: value('planBoxCtoName'), cto_model: value('planBoxCtoModel'),
        distribution_type: value('planBoxDistributionType'), distribution_count: Number(value('planBoxDistributionCount')), distribution_manufacturer: value('planBoxDistributionManufacturer'), distribution_model: value('planBoxDistributionModel'), port_capacity: Number(value('planBoxPorts')),
        camera_count: Number(value('planBoxCameraCount')), camera_start_ip: value('planBoxCameraIp'), camera_first_number: Number(value('planBoxCameraFirst')), camera_name_template: value('planBoxCameraTemplate'), camera_manufacturer: value('planBoxCameraManufacturer'), camera_model: value('planBoxCameraModel'),
      };
      if (!payload.box_name) throw new Error('Informe o nome da caixa de CFTV.');
      const data = await planningRequest(`/api/planning/projects/${_planningCurrent.id}/assemble-gpon-box`, { method: 'POST', body: JSON.stringify(payload) });
      _planningCatalog = null; closePlanningModal(); showToast(`Caixa montada com ${data.count - 1} equipamento(s).`); await selectPlanningProject(_planningCurrent.id);
    },
  });
  const catalogFor = type => (_planningCatalog || []).filter(item => item.device_type === type || (type === 'ont' && item.device_type === 'onu'));
  const fill = (listId, values) => { const list = modal.querySelector(`#${listId}`); if (list) list.innerHTML = [...new Set(values.filter(Boolean))].sort().map(value => `<option value="${planningEscape(value)}"></option>`).join(''); };
  const refreshCatalog = (type, manufacturerId, manufacturerListId, modelListId) => {
    const rows = catalogFor(type); const manufacturer = modal.querySelector(`#${manufacturerId}`)?.value.trim().toLowerCase() || '';
    fill(manufacturerListId, rows.map(item => item.manufacturer)); fill(modelListId, rows.filter(item => !manufacturer || item.manufacturer.toLowerCase() === manufacturer).map(item => item.model));
  };
  const refreshCapacity = () => {
    const count = Number(modal.querySelector('#planBoxDistributionCount').value || 0);
    const portsPerUnit = Number(modal.querySelector('#planBoxPorts').value || 0);
    const isSwitch = modal.querySelector('#planBoxDistributionType').value === 'switch';
    const uplinkPerUnit = isSwitch && portsPerUnit > 1 ? 1 : 0;
    const poePerUnit = Math.max(1, portsPerUnit - uplinkPerUnit);
    const capacity = count * poePerUnit;
    const used = Number(modal.querySelector('#planBoxCameraCount').value || 0); modal.querySelector('#planBoxCapacity').textContent = `${capacity} camera${capacity === 1 ? '' : 's'}`;
    const free = capacity - used;
    const uplinkNote = uplinkPerUnit ? ` (${count * uplinkPerUnit} porta${count * uplinkPerUnit === 1 ? '' : 's'} reservada${count * uplinkPerUnit === 1 ? '' : 's'} p/ uplink)` : '';
    modal.querySelector('#planBoxAvailability').textContent = (free < 0 ? `${Math.abs(free)} acima da capacidade` : `${free} porta${free === 1 ? '' : 's'} PoE livre${free === 1 ? '' : 's'}`) + uplinkNote;
    modal.querySelector('.planning-capacity-card').classList.toggle('danger', used > capacity);
  };
  const refreshDistribution = () => refreshCatalog(modal.querySelector('#planBoxDistributionType').value, 'planBoxDistributionManufacturer', 'planningBoxDistributionManufacturers', 'planningBoxDistributionModels');
  const refreshOnu = () => refreshCatalog(modal.querySelector('#planBoxOnuType').value, 'planBoxOnuManufacturer', 'planningBoxOnuManufacturers', 'planningBoxOnuModels');
  refreshOnu(); refreshDistribution(); refreshCatalog('camera', 'planBoxCameraManufacturer', 'planningBoxCameraManufacturers', 'planningBoxCameraModels'); fill('planningBoxCtoModels', catalogFor('cto').map(item => item.model)); refreshCapacity();
  ['planBoxOnuType','planBoxOnuManufacturer'].forEach(id => modal.querySelector(`#${id}`)?.addEventListener('input', refreshOnu));
  ['planBoxDistributionType','planBoxDistributionManufacturer'].forEach(id => modal.querySelector(`#${id}`)?.addEventListener('input', refreshDistribution));
  modal.querySelector('#planBoxCameraManufacturer')?.addEventListener('input', () => refreshCatalog('camera', 'planBoxCameraManufacturer', 'planningBoxCameraManufacturers', 'planningBoxCameraModels'));
  ['planBoxDistributionType','planBoxDistributionCount','planBoxPorts','planBoxCameraCount'].forEach(id => modal.querySelector(`#${id}`)?.addEventListener('input', refreshCapacity));
  modal.querySelector('#planBoxCto')?.addEventListener('change', event => modal.querySelector('#planningCtoFields').classList.toggle('hidden', !event.target.checked));
}

function openPlanningCsvModal() {
  if (!_planningCurrent) return;
  const columns = ['tipo', 'nome', 'ip', 'site', 'fabricante', 'modelo', 'equipamento_pai', 'pon', 'onu', 'latitude', 'longitude', 'imagem', 'metadata', 'observacoes'];
  const modal = planningModal({
    title: 'Importar equipamentos por CSV', wide: true, primary: 'Importar CSV',
    body: `<div class="planning-csv-import">
      <input class="planning-file-input" id="planCsvFile" type="file" accept=".csv,text/csv">
      <label class="planning-upload-zone" for="planCsvFile">
        <span class="planning-upload-icon"><i data-lucide="file-up"></i></span>
        <span class="planning-upload-copy"><strong class="planning-upload-title">Escolha o arquivo CSV</strong><small class="planning-upload-meta">Clique para selecionar ou arraste o arquivo para esta area</small></span>
        <span class="planning-upload-action">Selecionar arquivo</span>
      </label>
      <section class="planning-csv-defaults">
        <div class="planning-csv-section-head"><div><strong>Valores de apoio</strong><small>Usados somente quando uma linha do CSV nao informar tipo ou site.</small></div><span>Opcional</span></div>
        <div class="planning-form-grid">
          <label class="planning-field"><span>Tipo padrao</span><select id="planCsvType">${Object.entries(PLANNING_TYPES).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
          <label class="planning-field"><span>Site padrao</span><select id="planCsvSite">${planningSiteOptions()}</select></label>
        </div>
      </section>
      <details class="planning-csv-columns">
        <summary><span><i data-lucide="columns-3"></i><strong>Estrutura aceita pelo importador</strong></span><small>${columns.length} colunas disponiveis</small></summary>
        <div class="planning-column-chips">${columns.map(column => `<code>${column}</code>`).join('')}</div>
      </details>
      <div class="planning-csv-note"><i data-lucide="git-branch"></i><span>Apenas <strong>nome</strong> e obrigatorio. A hierarquia e montada por <strong>equipamento_pai</strong>, mesmo quando o pai aparece depois no arquivo.</span></div>
    </div>`,
    onSave: async root => {
      const file = root.querySelector('#planCsvFile').files[0];
      if (!file) throw new Error('Escolha um arquivo CSV.');
      const preview = (await file.slice(0, 4096).text()).replace(/^\uFEFF/, '');
      const firstLine = preview.split(/\r?\n/, 1)[0] || '';
      const separator = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
      const headers = firstLine.split(separator).map(value => value.trim().replace(/^"|"$/g, '').toLowerCase());
      if (!headers.some(value => ['nome', 'titulo'].includes(value))) {
        const isDistanceReport = headers.includes('caixa') && headers.includes('camera') && headers.some(value => value.includes('distancia'));
        throw new Error(isDistanceReport
          ? 'Este e o relatorio de distancias e nao pode ser importado como equipamento. Selecione o arquivo "proposta-caixas-cftv-telha-rotas-viarias.csv".'
          : 'CSV incompatível: falta a coluna obrigatoria "nome".');
      }
      const form = new FormData(); form.append('file', file);
      form.append('defaults_json', JSON.stringify({ device_type: root.querySelector('#planCsvType').value, site_id: root.querySelector('#planCsvSite').value || null, status: 'planned' }));
      const data = await planningMultipart(`/api/planning/projects/${_planningCurrent.id}/import-csv`, form);
      _planningCatalog = null;
      closePlanningModal();
      const typeFilter = document.getElementById('planningTypeFilter');
      if (typeFilter) typeFilter.value = 'box';
      showToast(`${data.imported} item(ns) importado(s)${data.errors?.length ? `; ${data.errors.length} linha(s) com erro` : ''}.`, !!data.errors?.length);
      await selectPlanningProject(_planningCurrent.id);
    },
  });
  const input = modal.querySelector('#planCsvFile');
  const zone = modal.querySelector('.planning-upload-zone');
  const save = modal.querySelector('[data-save]');
  save.disabled = true;
  const showFile = file => {
    if (!file) return;
    zone.classList.add('has-file');
    zone.querySelector('.planning-upload-title').textContent = file.name;
    zone.querySelector('.planning-upload-meta').textContent = `${Math.max(1, Math.round(file.size / 1024))} KB · pronto para importar`;
    zone.querySelector('.planning-upload-action').textContent = 'Trocar arquivo';
    save.disabled = false;
  };
  input.addEventListener('change', () => showFile(input.files[0]));
  ['dragenter', 'dragover'].forEach(name => zone.addEventListener(name, event => { event.preventDefault(); zone.classList.add('dragging'); }));
  ['dragleave', 'drop'].forEach(name => zone.addEventListener(name, event => { event.preventDefault(); zone.classList.remove('dragging'); }));
  zone.addEventListener('drop', event => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files; showFile(file);
  });
}

function openPlanningKmzModal() {
  if (!_planningCurrent) return;
  planningModal({
    title: 'Importar mapa KMZ', wide: true, primary: 'Importar mapa',
    body: `<div class="planning-form-grid">
      <label class="planning-field full"><span>Arquivo KMZ</span><input id="planKmzFile" type="file" accept=".kmz,application/vnd.google-earth.kmz"></label>
      <label class="planning-check full"><input id="planKmzCreateCameras" type="checkbox" checked><span><strong>Criar cameras planejadas para os pontos do KMZ</strong><small>Linhas e areas ficam apenas como desenho no mapa.</small></span></label>
      <label class="planning-field"><span>Site das cameras</span><select id="planKmzSite">${planningSiteOptions()}</select></label>
      ${planningField('Fabricante padrao', 'planKmzManufacturer', '', 'placeholder="Intelbras"')}
      ${planningField('Modelo padrao', 'planKmzModel', '', 'placeholder="VIP 3230 B"')}
      ${planningField('IP inicial opcional', 'planKmzIp', '', 'placeholder="10.10.20.1"')}
    </div><div class="planning-info"><i data-lucide="image"></i><span>Fotos de internet devem ser cadastradas como imagem ilustrativa do modelo, nunca como snapshot real.</span></div>`,
    onSave: async root => {
      const file = root.querySelector('#planKmzFile').files[0];
      if (!file) throw new Error('Escolha um arquivo KMZ.');
      const form = new FormData(); form.append('file', file);
      const imported = await planningMultipart('/api/kmz/import', form);
      const updated = { name: _planningCurrent.name, client_name: _planningCurrent.client_name, description: _planningCurrent.description, status: _planningCurrent.status, kmz_layer_id: imported.id };
      await planningRequest(`/api/planning/projects/${_planningCurrent.id}`, { method: 'PUT', body: JSON.stringify(updated) });
      let created = 0;
      if (root.querySelector('#planKmzCreateCameras').checked) {
        const layers = await apiJson('/api/kmz/import/layers?include_features=true', { forceRefresh: true, cacheTtl: 0 });
        const layer = (layers?.layers || []).find(item => item.id === imported.id);
        const points = (layer?.features || []).filter(feature => String(feature?.geometry?.type).toLowerCase() === 'point');
        let ipValue = root.querySelector('#planKmzIp').value.trim();
        let ipNumber = ipValue ? planningIpToNumber(ipValue) : null;
        const plannedPoints = [];
        for (let index = 0; index < points.length; index += 1) {
          const feature = points[index]; const coords = feature.geometry.coordinates || [];
          const payload = { device_type: 'camera', name: feature.properties?.name || `${String(index + 1).padStart(2, '0')} - CAMERA`, ip: ipNumber === null ? '' : planningNumberToIp(ipNumber + index), site_id: root.querySelector('#planKmzSite').value || null, manufacturer: root.querySelector('#planKmzManufacturer').value.trim(), model: root.querySelector('#planKmzModel').value.trim(), longitude: coords[0], latitude: coords[1], notes: feature.properties?.description || '', status: 'planned' };
          plannedPoints.push(payload);
        }
        if (plannedPoints.length) {
          const bulk = await planningRequest(`/api/planning/projects/${_planningCurrent.id}/devices/bulk`, { method: 'POST', body: JSON.stringify({ items: plannedPoints }) });
          created = Number(bulk.count || 0);
          _planningCatalog = null;
        }
      }
      closePlanningModal(); showToast(`Mapa importado${created ? ` e ${created} camera(s) criada(s)` : ''}.`); await loadPlanning(true);
    },
  });
}

function planningIpToNumber(ip) { return ip.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0; }
function planningNumberToIp(value) { return [24,16,8,0].map(shift => (value >>> shift) & 255).join('.'); }

async function deletePlanningDevice(deviceId) {
  const item = (_planningCurrent?.devices || []).find(row => Number(row.id) === Number(deviceId));
  if (!item || !await showConfirm({ eyebrow: 'Projeto', title: 'Excluir equipamento planejado?', msg: item.name, label: 'Excluir' })) return;
  await planningRequest(`/api/planning/projects/${_planningCurrent.id}/devices/${deviceId}`, { method: 'DELETE' });
  showToast('Equipamento removido.'); await selectPlanningProject(_planningCurrent.id);
}

async function deletePlanningProject() {
  if (!_planningCurrent || !await showConfirm({ eyebrow: 'Projeto', title: 'Excluir projeto completo?', msg: `${_planningCurrent.name}. Sites e equipamentos planejados serao removidos.`, label: 'Excluir projeto' })) return;
  await planningRequest(`/api/planning/projects/${_planningCurrent.id}`, { method: 'DELETE' });
  showToast('Projeto removido.'); _planningCurrent = null; await loadPlanning(true);
}

async function renderPlanningMap() {
  const container = document.getElementById('planningMap');
  if (!container || !_planningCurrent || typeof L === 'undefined') return;
  if (!_planningMap) {
    _planningMap = L.map('planningMap', { zoomControl: true }).setView([-9.76, -36.67], 14);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, attribution: '&copy; OpenStreetMap' }).addTo(_planningMap);
  }
  if (_planningMapLayers) _planningMapLayers.remove();
  _planningMapLayers = L.layerGroup().addTo(_planningMap);
  _planningMarkers = {};
  const bounds = [];
  if (_planningCurrent.kmz_layer_id) {
    const data = await apiJson('/api/kmz/import/layers?include_features=true', { forceRefresh: true, cacheTtl: 0 });
    const layer = (data?.layers || []).find(item => item.id === _planningCurrent.kmz_layer_id);
    if (layer?.features?.length) {
      const geo = L.geoJSON({ type: 'FeatureCollection', features: layer.features }, { style: { color: '#5f3dc4', weight: 3, fillOpacity: .08 }, pointToLayer: (_feature, latlng) => L.circleMarker(latlng, { radius: 5, color: '#5f3dc4', fillOpacity: .7 }) }).addTo(_planningMapLayers);
      if (geo.getBounds().isValid()) bounds.push(...[geo.getBounds().getSouthWest(), geo.getBounds().getNorthEast()]);
    }
  }
  (_planningCurrent.devices || []).forEach(item => {
    const lat = Number(item.latitude); const lon = Number(item.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    const color = item.device_type === 'camera' ? '#087f5b' : ['onu','ont'].includes(item.device_type) ? '#1971c2' : '#b86b00';
    const referenceImage = item.reference_image_url
      ? `<img class="planning-popup-image" src="${planningEscape(item.reference_image_url)}" alt="Imagem ilustrativa" loading="lazy"><small>Imagem ilustrativa do modelo</small>` : '';
    const marker = L.circleMarker([lat, lon], { radius: item.device_type === 'camera' ? 7 : 9, color: '#fff', weight: 2, fillColor: color, fillOpacity: 1 })
      .bindPopup(`<div class="planning-popup">${referenceImage}<strong>${planningEscape(item.name)}</strong><span>${planningEscape(PLANNING_TYPES[item.device_type] || item.device_type)} · ${planningEscape(item.site_name || 'Sem site')}</span><code>${planningEscape(item.ip || 'IP a definir')}</code><span>${planningEscape([item.manufacturer,item.model].filter(Boolean).join(' / ') || 'Modelo a definir')}</span></div>`)
      .addTo(_planningMapLayers);
    _planningMarkers[item.id] = marker; bounds.push([lat, lon]);
  });
  document.getElementById('planningMapHint').textContent = bounds.length ? `${bounds.length} referencia(s) posicionada(s).` : 'Importe um KMZ ou informe coordenadas.';
  if (bounds.length) _planningMap.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 18 });
  setTimeout(() => _planningMap.invalidateSize(), 100);
}

function focusPlanningDevice(deviceId) {
  const marker = _planningMarkers[deviceId];
  if (!marker || !_planningMap) { openPlanningDeviceModal(deviceId); return; }
  const position = marker.getLatLng();
  _planningMap.flyTo(position, Math.max(_planningMap.getZoom(), 18), { duration: .45 });
  setTimeout(() => marker.openPopup(), 480);
}

async function exportPlanningKmz() {
  if (!_planningCurrent) return;
  const button = document.getElementById('btnPlanningExportKmz');
  if (button) button.disabled = true;
  try {
    const headers = {};
    if (_token) headers.Authorization = `Bearer ${_token}`;
    const response = await fetch(`${API_BASE}/api/planning/projects/${Number(_planningCurrent.id)}/export-kmz`, { headers, credentials: 'same-origin' });
    if (!response.ok) {
      const raw = await response.text();
      let message = raw;
      try { const data = JSON.parse(raw); message = data.detail || data.message || raw; } catch (_error) { /* resposta textual */ }
      throw new Error(message || 'Nao foi possivel exportar o KMZ.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || `${_planningCurrent.name || 'projeto-cftv'}.kmz`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('KMZ do projeto exportado.');
  } catch (error) {
    showToast(error.message || 'Nao foi possivel exportar o KMZ.', true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function downloadPlanningNetworkPdf() {
  if (!_planningCurrent) return;
  const button = document.getElementById('btnPlanningNetworkPdf');
  if (button) button.disabled = true;
  try {
    const headers = {};
    if (_token) headers.Authorization = `Bearer ${_token}`;
    const response = await fetch(`${API_BASE}/api/planning/projects/${Number(_planningCurrent.id)}/network-document.pdf`, { headers, credentials: 'same-origin' });
    if (!response.ok) {
      const raw = await response.text();
      let message = raw;
      try { const data = JSON.parse(raw); message = data.detail || data.message || raw; } catch (_error) { /* resposta textual */ }
      throw new Error(message || 'Nao foi possivel gerar o documento de rede.');
    }
    const blob = await response.blob();
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="?([^";]+)"?/i);
    const filename = match?.[1] || `${_planningCurrent.name || 'projeto-cftv'}-documento-rede.pdf`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Documento de rede gerado em PDF.');
  } catch (error) {
    showToast(error.message || 'Nao foi possivel gerar o documento de rede.', true);
  } finally {
    if (button) button.disabled = false;
  }
}

function planningProposalGroups() {
  const groups = new Map();
  (_planningCurrent?.devices || []).forEach(item => {
    const key = [item.device_type, item.manufacturer || '', item.model || ''].join('|');
    if (!groups.has(key)) groups.set(key, { device_type: item.device_type, manufacturer: item.manufacturer || '', model: item.model || '', count: 0 });
    groups.get(key).count += 1;
  });
  const result = [...groups.values()];
  const cableQuote = planningLoadCableQuote();
  if (cableQuote?.spools > 0) result.push({
    device_type: 'network_cable', label: 'Cabo de rede CAT5e', manufacturer: 'Cabo para instalacao',
    model: `Caixa de 305 m · ${cableQuote.purchaseMeters.toFixed(0)} m calculados`, count: cableQuote.spools,
  });
  return result.sort((a, b) => (a.label || PLANNING_TYPES[a.device_type] || a.device_type).localeCompare(b.label || PLANNING_TYPES[b.device_type] || b.device_type));
}

function planningProposalGroupLabel(group) {
  return group.label || PLANNING_TYPES[group.device_type] || group.device_type;
}

function planningCurrency(value) {
  return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function openPlanningProposalModal() {
  if (!_planningCurrent) return;
  const groups = planningProposalGroups();
  const cableQuote = planningLoadCableQuote();
  const boxes = (_planningCurrent.devices || []).filter(item => item.device_type === 'box').length;
  const cameras = (_planningCurrent.devices || []).filter(item => item.device_type === 'camera').length;
  const modal = planningModal({
    eyebrow: 'Documento para o cliente', title: 'Proposta e especificacoes', wide: true, primary: 'Gerar documento',
    body: `<div class="planning-proposal-form">
      <div class="planning-info"><i data-lucide="info"></i><span>Os quantitativos vieram do projeto. Preencha somente os valores que deseja apresentar; itens sem preco ficam como <strong>A definir</strong>.${cableQuote ? ` Cabos incluidos: <strong>${cableQuote.purchaseMeters.toFixed(0)} m / ${cableQuote.spools} caixa(s) de 305 m</strong>.` : ' Execute o calculo de cabos e use <strong>Incluir na proposta</strong> para adicionar esse material.'}</span></div>
      <div class="planning-form-grid">
        ${planningField('Validade da proposta', 'planProposalValidity', '15 dias')}
        ${planningField('Prazo estimado', 'planProposalDeadline', 'A definir apos aprovacao')}
        <label class="planning-field full"><span>Condicoes e observacoes comerciais</span><textarea id="planProposalNotes" rows="3" placeholder="Instalacao, garantia, forma de pagamento e itens nao inclusos."></textarea></label>
      </div>
      <div class="planning-proposal-table"><div class="planning-proposal-head"><span>Item / especificacao</span><span>Qtd.</span><span>Valor unitario</span></div>
        ${groups.map((group, index) => `<div class="planning-proposal-row"><span><strong>${planningEscape(planningProposalGroupLabel(group))}</strong><small>${planningEscape([group.manufacturer, group.model].filter(Boolean).join(' / ') || 'Fabricante e modelo a definir')}</small></span><strong>${group.count}</strong><label><span>R$</span><input id="planProposalPrice${index}" type="number" min="0" step="0.01" placeholder="0,00"></label></div>`).join('')}
      </div>
    </div>`,
    onSave: async root => {
      const prices = groups.map((_group, index) => Number(root.querySelector(`#planProposalPrice${index}`)?.value || 0));
      const validity = root.querySelector('#planProposalValidity').value.trim();
      const deadline = root.querySelector('#planProposalDeadline').value.trim();
      const notes = root.querySelector('#planProposalNotes').value.trim();
      const total = groups.reduce((sum, group, index) => sum + (group.count * prices[index]), 0);
      const rows = groups.map((group, index) => `<tr><td><strong>${planningEscape(planningProposalGroupLabel(group))}</strong><small>${planningEscape([group.manufacturer, group.model].filter(Boolean).join(' / ') || 'Fabricante e modelo a definir')}</small></td><td>${group.count}</td><td>${prices[index] ? planningCurrency(prices[index]) : 'A definir'}</td><td>${prices[index] ? planningCurrency(group.count * prices[index]) : 'A definir'}</td></tr>`).join('');
      const cableSummary = cableQuote ? `<p><strong>Dimensionamento dos cabos:</strong> ${cableQuote.installedMeters.toFixed(0)} m estimados para instalacao; ${cableQuote.purchaseMeters.toFixed(0)} m previstos para compra; ${cableQuote.spools} caixa(s) de 305 m; ${cableQuote.overLimit} trecho(s) para revisao.</p>` : '';
      const report = window.open('', '_blank');
      if (!report) throw new Error('O navegador bloqueou o documento. Libere pop-ups para o SightOps.');
      report.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${planningEscape(_planningCurrent.name)} - Proposta</title><style>body{margin:0;color:#17232b;font:14px Arial,sans-serif}.page{max-width:980px;margin:auto;padding:38px}.brand{color:#087f5b;font-size:13px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}h1{margin:8px 0 4px;font-size:28px}h2{margin:28px 0 10px;font-size:18px}.muted,small{display:block;color:#667782}.summary{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:22px 0}.summary div{padding:14px;border:1px solid #dce3e7;border-radius:8px}.summary span{display:block;color:#667782;font-size:11px;text-transform:uppercase}.summary strong{display:block;margin-top:5px;font-size:22px}table{width:100%;border-collapse:collapse}th,td{padding:11px 10px;border-bottom:1px solid #dce3e7;text-align:left}th{color:#667782;background:#f6f8f9;font-size:11px;text-transform:uppercase}td:nth-child(n+2),th:nth-child(n+2){text-align:right}.total{margin-top:16px;text-align:right;font-size:19px}.note{padding:14px;border:1px solid #b7decf;border-radius:8px;background:#effaf6;white-space:pre-wrap}.footer{margin-top:34px;padding-top:12px;border-top:1px solid #dce3e7;color:#667782;font-size:11px}@media print{.page{padding:18px}.no-print{display:none}}</style></head><body><main class="page"><div class="brand">SightOps &middot; Projeto de CFTV</div><h1>${planningEscape(_planningCurrent.name)}</h1><p class="muted">${planningEscape(_planningCurrent.client_name || 'Cliente nao informado')} &middot; ${planningEscape(_planningCurrent.description || 'Planejamento de infraestrutura de CFTV')}</p><section class="summary"><div><span>Sites</span><strong>${(_planningCurrent.sites || []).length}</strong></div><div><span>Caixas de CFTV</span><strong>${boxes}</strong></div><div><span>Cameras</span><strong>${cameras}</strong></div><div><span>Total de itens</span><strong>${(_planningCurrent.devices || []).length}</strong></div></section><h2>Escopo tecnico</h2><p>Projeto planejado com caixas de CFTV, infraestrutura optica, distribuicao PoE e cameras em coordenadas individuais. Os percursos e distancias devem ser validados em campo antes da execucao.</p>${cableSummary}<h2>Quantitativos e especificacoes</h2><table><thead><tr><th>Item</th><th>Quantidade</th><th>Valor unitario</th><th>Subtotal</th></tr></thead><tbody>${rows}</tbody></table><div class="total"><strong>Total dos itens precificados: ${planningCurrency(total)}</strong></div><h2>Condicoes</h2><div class="note"><strong>Validade:</strong> ${planningEscape(validity || 'A definir')}\n<strong>Prazo:</strong> ${planningEscape(deadline || 'A definir')}\n\n${planningEscape(notes || 'Valores, instalacao, garantia e forma de pagamento a definir.')}</div><div class="footer">Documento gerado pelo SightOps em ${new Date().toLocaleString('pt-BR')}. Itens planejados nao representam equipamentos instalados.</div><p class="no-print"><button onclick="window.print()">Imprimir ou salvar em PDF</button></p></main></body></html>`);
      report.document.close();
      closePlanningModal();
    },
  });
  return modal;
}

function planningDistanceMeters(lat1, lon1, lat2, lon2) {
  const radians = value => Number(value) * Math.PI / 180;
  const earth = 6371000;
  const dLat = radians(lat2 - lat1);
  const dLon = radians(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(dLon / 2) ** 2;
  return earth * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function planningCameraBox(camera, byId) {
  const visited = new Set();
  let current = camera;
  while (current?.parent_id && !visited.has(Number(current.parent_id))) {
    visited.add(Number(current.parent_id));
    current = byId.get(Number(current.parent_id));
    if (current?.device_type === 'box') return current;
  }
  return null;
}

function planningCableCalculation(config) {
  const devices = _planningCurrent?.devices || [];
  const byId = new Map(devices.map(item => [Number(item.id), item]));
  const rows = devices.filter(item => item.device_type === 'camera').map(camera => {
    const box = planningCameraBox(camera, byId);
    const coordinates = [camera.latitude, camera.longitude, box?.latitude, box?.longitude].map(Number);
    if (!box || coordinates.some(value => !Number.isFinite(value))) return { camera, box, error: !box ? 'Camera sem caixa vinculada' : 'Coordenadas incompletas' };
    const straight = planningDistanceMeters(...coordinates);
    const route = Number(camera.metadata?.route_distance_m);
    if (!Number.isFinite(route)) return { camera, box, straight, error: 'Percurso viario ainda nao calculado' };
    const installed = (route * (1 + config.routePercent / 100)) + config.slackMeters;
    const purchase = installed * (1 + config.reservePercent / 100);
    return { camera, box, straight, route, installed, purchase, overLimit: installed > config.maxMeters };
  });
  return rows.sort((a, b) => planningNaturalCompare(a.box?.name, b.box?.name) || planningNaturalCompare(a.camera?.name, b.camera?.name));
}

function planningCableConfig(root) {
  const number = (id, fallback) => {
    const value = Number(root.querySelector(`#${id}`)?.value);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  return {
    routePercent: number('planCableRoute', 15), slackMeters: number('planCableSlack', 5),
    reservePercent: number('planCableReserve', 10), maxMeters: number('planCableMax', 100), spoolMeters: 305,
  };
}

function planningCableQuoteKey() {
  return `sightops:planning:cables:${Number(_planningCurrent?.id || 0)}`;
}

function planningLoadCableQuote() {
  if (!_planningCurrent?.id) return null;
  try {
    const value = JSON.parse(localStorage.getItem(planningCableQuoteKey()) || sessionStorage.getItem(planningCableQuoteKey()) || 'null');
    return value && Number(value.projectId) === Number(_planningCurrent.id) ? value : null;
  } catch (_error) {
    return null;
  }
}

function planningSaveCableQuote(root) {
  const config = planningCableConfig(root);
  const rows = renderPlanningCableResults(root);
  const valid = rows.filter(row => !row.error);
  const invalid = rows.filter(row => row.error);
  if (!valid.length) throw new Error('Nenhum cabo valido foi calculado para adicionar ao orcamento.');
  if (invalid.length) throw new Error(`${invalid.length} camera(s) ainda estao sem percurso calculado. Corrija o projeto antes de adicionar os cabos ao orcamento.`);
  const installedMeters = valid.reduce((sum, row) => sum + row.installed, 0);
  const purchaseMeters = valid.reduce((sum, row) => sum + row.purchase, 0);
  const quote = {
    projectId: Number(_planningCurrent.id), calculatedAt: new Date().toISOString(), config,
    cameras: valid.length, installedMeters, purchaseMeters,
    spools: Math.ceil(purchaseMeters / config.spoolMeters), overLimit: valid.filter(row => row.overLimit).length,
  };
  localStorage.setItem(planningCableQuoteKey(), JSON.stringify(quote));
  sessionStorage.removeItem(planningCableQuoteKey());
  return quote;
}

function renderPlanningCableResults(root) {
  const target = root.querySelector('#planningCableResults');
  if (!target) return [];
  const config = planningCableConfig(root);
  const rows = planningCableCalculation(config);
  const valid = rows.filter(row => !row.error);
  const missing = rows.filter(row => row.error);
  const overLimit = valid.filter(row => row.overLimit);
  const totalInstalled = valid.reduce((sum, row) => sum + row.installed, 0);
  const totalPurchase = valid.reduce((sum, row) => sum + row.purchase, 0);
  const boxes = [...new Map(valid.map(row => [Number(row.box.id), row.box])).values()].sort((a, b) => planningNaturalCompare(a.name, b.name));
  const boxSections = boxes.map(box => {
    const items = valid.filter(row => Number(row.box.id) === Number(box.id)).sort((a, b) => planningNaturalCompare(a.camera.name, b.camera.name));
    const subtotal = items.reduce((sum, row) => sum + row.purchase, 0);
    return `<details class="planning-cable-box" open><summary><span><strong>${planningEscape(box.name)}</strong><small>${items.length} camera(s) &middot; ${planningEscape(box.site_name || 'Sem site')}</small></span><strong>${subtotal.toFixed(1)} m</strong></summary>
      <div class="planning-cable-table-head"><span>Camera</span><span>Aerea</span><span>Via ruas</span><span>Instalado</span><span>Para compra</span><span>Situacao</span></div>
      ${items.map(row => `<div class="planning-cable-row"><strong title="${planningEscape(row.camera.name)}">${planningEscape(row.camera.name)}</strong><span>${row.straight.toFixed(1)} m</span><span>${row.route.toFixed(1)} m</span><span>${row.installed.toFixed(1)} m</span><span>${row.purchase.toFixed(1)} m</span><span class="planning-cable-status ${row.overLimit ? 'danger' : ''}">${row.overLimit ? 'Revisar rota' : 'Dentro do limite'}</span></div>`).join('')}</details>`;
  }).join('');
  const warnings = [];
  if (overLimit.length) warnings.push(`${overLimit.length} trecho(s) ultrapassam ${config.maxMeters} m instalados. Considere reposicionar a caixa ou adicionar outra distribuicao.`);
  if (missing.length) warnings.push(`${missing.length} camera(s) nao puderam ser calculadas por falta de vinculo ou coordenadas.`);
  target.innerHTML = `<div class="planning-cable-summary"><div><span>Cameras calculadas</span><strong>${valid.length}</strong></div><div><span>Cabo instalado</span><strong>${totalInstalled.toFixed(0)} m</strong></div><div><span>Cabo para compra</span><strong>${totalPurchase.toFixed(0)} m</strong></div><div><span>Caixas de 305 m</span><strong>${Math.ceil(totalPurchase / config.spoolMeters)}</strong></div></div>${warnings.length ? `<div class="planning-cable-warning">${warnings.map(planningEscape).join('<br>')}</div>` : ''}${boxSections || '<div class="planning-cable-empty">Nenhuma camera com caixa e coordenadas disponiveis.</div>'}`;
  lucide.createIcons();
  root._planningCableRows = rows;
  return rows;
}

function planningCsvValue(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function downloadPlanningCableCsv(root) {
  const config = planningCableConfig(root);
  const rows = renderPlanningCableResults(root);
  const lines = [['caixa','camera','site','distancia_aerea_m','percurso_viario_m','cabo_instalado_m','cabo_compra_m','limite_m','situacao']];
  rows.forEach(row => lines.push([row.box?.name || '', row.camera.name || '', row.camera.site_name || '', row.straight?.toFixed(1) || '', row.route?.toFixed(1) || '', row.installed?.toFixed(1) || '', row.purchase?.toFixed(1) || '', config.maxMeters, row.error || (row.overLimit ? 'revisar rota' : 'dentro do limite')]));
  const content = '\ufeff' + lines.map(line => line.map(planningCsvValue).join(';')).join('\r\n');
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const link = document.createElement('a');
  link.href = url; link.download = `${String(_planningCurrent.name || 'projeto-cftv').replace(/[^a-z0-9_-]+/gi, '-')}-cabos.csv`; document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast('Calculo de cabos exportado.');
}

function openPlanningCableModal() {
  if (!_planningCurrent) return;
  const modal = planningModal({
    eyebrow: 'Dimensionamento', title: 'Calcular cabos de rede', wide: true, primary: 'Adicionar cabos ao orcamento',
    body: `<div class="planning-cable-tool">
      <div class="planning-cable-settings">
        ${planningField('Margem sobre a rota (%)', 'planCableRoute', '15', 'type="number" min="0" step="1"')}
        ${planningField('Folga tecnica por camera (m)', 'planCableSlack', '5', 'type="number" min="0" step="1"')}
        ${planningField('Reserva para compra (%)', 'planCableReserve', '10', 'type="number" min="0" step="1"')}
        ${planningField('Limite do trecho instalado (m)', 'planCableMax', '100', 'type="number" min="1" step="1"')}
      </div>
      <div class="planning-csv-note"><i data-lucide="route"></i><span><strong>Instalado</strong> = percurso pelas ruas + margem de passagem + folga. A distancia aerea aparece apenas como referencia. A reserva entra somente na compra.</span></div>
      <div class="planning-info"><i data-lucide="file-plus-2"></i><span>Depois de conferir as metragens, clique em <strong>Adicionar cabos ao orcamento</strong>. O item aparecera automaticamente em <strong>Gerar proposta</strong>, com a quantidade de caixas de 305 m.</span></div>
      <div class="planning-cable-results" id="planningCableResults"></div>
    </div>`,
    onSave: async root => {
      const quote = planningSaveCableQuote(root);
      closePlanningModal(); showToast(`${quote.spools} caixa(s) de cabo adicionadas ao orcamento.`);
    },
  });
  const footer = modal.querySelector('.planning-modal-footer');
  const saveButton = footer?.querySelector('[data-save]');
  if (footer && saveButton) {
    const download = document.createElement('button');
    download.type = 'button'; download.className = 'secondary-action';
    download.innerHTML = '<i data-lucide="download"></i> Baixar CSV';
    download.onclick = () => downloadPlanningCableCsv(modal);
    footer.insertBefore(download, saveButton);
  }
  ['planCableRoute', 'planCableSlack', 'planCableReserve', 'planCableMax'].forEach(id => modal.querySelector(`#${id}`)?.addEventListener('input', () => renderPlanningCableResults(modal)));
  renderPlanningCableResults(modal);
  lucide.createIcons();
}

function bindPlanningUi() {
  const on = (id, event, handler) => { const el = document.getElementById(id); if (el) el.addEventListener(event, handler); };
  on('btnPlanningNew', 'click', () => openPlanningProjectModal(true));
  on('btnPlanningRefresh', 'click', () => loadPlanning(true));
  on('btnPlanningEdit', 'click', () => openPlanningProjectModal(false));
  on('btnPlanningSite', 'click', openPlanningSiteModal);
  on('btnPlanningKmz', 'click', openPlanningKmzModal);
  on('btnPlanningExportKmz', 'click', exportPlanningKmz);
  on('btnPlanningProposal', 'click', openPlanningProposalModal);
  on('btnPlanningDelete', 'click', deletePlanningProject);
  on('btnPlanningAdd', 'click', () => openPlanningDeviceModal());
  on('btnPlanningBox', 'click', openPlanningBoxModal);
  on('btnPlanningCables', 'click', openPlanningCableModal);
  on('btnPlanningNetworkPdf', 'click', downloadPlanningNetworkPdf);
  on('btnPlanningGenerate', 'click', openPlanningGenerateModal);
  on('btnPlanningCsv', 'click', openPlanningCsvModal);
  on('planningSearch', 'input', renderPlanningDevices);
  on('planningTypeFilter', 'change', renderPlanningDevices);
  on('planningSiteFilter', 'change', renderPlanningDevices);
}
