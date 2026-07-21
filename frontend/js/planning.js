// Implantacao > Projetos: parque planejado, separado do inventario real.
let _planningProjects = [];
let _planningCurrent = null;
let _planningMap = null;
let _planningMapLayers = null;
let _planningMarkers = {};
let _planningCatalog = null;

const PLANNING_TYPES = {
  camera: 'Camera', onu: 'ONU', ont: 'ONT', olt: 'OLT', switch: 'Switch',
  recorder: 'Gravador', box: 'Caixa', pole: 'Poste', other: 'Outro',
};
const PLANNING_STATUS = {
  draft: 'Rascunho', planned: 'Planejado', approved: 'Aprovado',
  deploying: 'Em implantacao', completed: 'Concluido',
};

function planningEscape(value) {
  return typeof esc === 'function' ? esc(value ?? '') : String(value ?? '').replace(/[&<>"']/g, '');
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
  box.innerHTML = rows.map(item => `
    <article class="planning-device-row" data-device-id="${Number(item.id)}">
      <button class="planning-device-focus" onclick="focusPlanningDevice(${Number(item.id)})" title="Mostrar no mapa">
        <span class="planning-device-icon ${planningEscape(item.device_type)}">${item.reference_image_url ? `<img src="${planningEscape(item.reference_image_url)}" alt="Imagem ilustrativa" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{innerHTML:'&bull;'}))">` : `<i data-lucide="${planningDeviceIcon(item.device_type)}"></i>`}</span>
        <span class="planning-device-primary"><strong title="${planningEscape(item.name)}">${planningEscape(item.name)}</strong><small>${planningEscape(PLANNING_TYPES[item.device_type] || item.device_type)} · ${planningEscape(item.site_name || 'Sem site')}</small></span>
        <span class="planning-device-ip">${planningEscape(item.ip || 'IP a definir')}</span>
        <span class="planning-device-model"><strong>${planningEscape(item.model || 'Modelo a definir')}</strong><small>${planningEscape(item.manufacturer || 'Fabricante nao informado')}</small></span>
        <span class="planning-device-parent">${planningEscape(item.parent_name || (item.pon ? `PON ${item.pon}` : 'Sem vinculo'))}</span>
      </button>
      <div class="planning-row-actions">
        <button class="icon-button" onclick="openPlanningDeviceModal(${Number(item.id)})" aria-label="Editar"><i data-lucide="pencil"></i></button>
        <button class="icon-button danger" onclick="deletePlanningDevice(${Number(item.id)})" aria-label="Excluir"><i data-lucide="trash-2"></i></button>
      </div>
    </article>`).join('');
  lucide.createIcons();
}

function planningDeviceIcon(type) {
  return ({ camera: 'camera', onu: 'wifi', ont: 'wifi', olt: 'radio-tower', switch: 'server', recorder: 'hard-drive', box: 'package', pole: 'utility-pole' })[type] || 'box';
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

function planningField(label, id, value = '', extra = '') {
  return `<label class="planning-field"><span>${planningEscape(label)}</span><input id="${id}" value="${planningEscape(value)}" ${extra}></label>`;
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
      ${planningField('IP planejado', 'planDeviceIp', item.ip, 'placeholder="10.10.20.1"')}
      <label class="planning-field"><span>Site/local</span><select id="planDeviceSite">${planningSiteOptions(item.site_id)}</select></label>
      ${planningField('Fabricante', 'planDeviceManufacturer', item.manufacturer, 'list="planningManufacturerOptions" placeholder="Escolha ou digite um novo"')}
      ${planningField('Modelo', 'planDeviceModel', item.model, 'list="planningModelOptions" placeholder="Escolha ou digite um novo"')}
      <label class="planning-field"><span>Ligado a</span><select id="planDeviceParent">${planningParentOptions(item.parent_id, item.id)}</select></label>
      ${planningField('PON', 'planDevicePon', item.pon, 'placeholder="1"')}
      ${planningField('Posicao ONU', 'planDeviceOnu', item.onu_position, 'placeholder="4"')}
      ${planningField('Latitude', 'planDeviceLat', item.latitude ?? '', 'placeholder="-9.750000"')}
      ${planningField('Longitude', 'planDeviceLon', item.longitude ?? '', 'placeholder="-36.660000"')}
      ${planningField('Imagem de referencia', 'planDeviceImage', item.reference_image_url, 'placeholder="https://..."')}
      <label class="planning-field full"><span>Observacoes</span><textarea id="planDeviceNotes" rows="3">${planningEscape(item.notes || '')}</textarea></label>
      ${planningCatalogDatalists(item)}
    </div>`,
    onSave: async root => {
      const payload = planningDevicePayload(root);
      if (!payload.name) throw new Error('Informe o nome do equipamento.');
      const path = `/api/planning/projects/${_planningCurrent.id}/devices${item.id ? `/${item.id}` : ''}`;
      await planningRequest(path, { method: item.id ? 'PUT' : 'POST', body: JSON.stringify(payload) });
      _planningCatalog = null;
      closePlanningModal(); showToast(item.id ? 'Equipamento atualizado.' : 'Equipamento adicionado.'); await selectPlanningProject(_planningCurrent.id);
    },
  });
  refreshPlanningCatalogLists(modal);
  modal.querySelector('#planDeviceType')?.addEventListener('change', () => refreshPlanningCatalogLists(modal));
  modal.querySelector('#planDeviceManufacturer')?.addEventListener('input', () => refreshPlanningCatalogLists(modal));
}

function planningDevicePayload(root) {
  const value = id => root.querySelector(`#${id}`)?.value?.trim() || '';
  return {
    device_type: value('planDeviceType'), name: value('planDeviceName'), ip: value('planDeviceIp'),
    site_id: value('planDeviceSite') || null, manufacturer: value('planDeviceManufacturer'), model: value('planDeviceModel'),
    parent_id: value('planDeviceParent') || null, pon: value('planDevicePon'), onu_position: value('planDeviceOnu'),
    latitude: value('planDeviceLat') || null, longitude: value('planDeviceLon') || null,
    reference_image_url: value('planDeviceImage'), notes: value('planDeviceNotes'), status: 'planned',
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

function openPlanningCsvModal() {
  if (!_planningCurrent) return;
  planningModal({
    title: 'Importar equipamentos por CSV', wide: true, primary: 'Importar CSV',
    body: `<div class="planning-form-grid">
      <label class="planning-field full"><span>Arquivo CSV</span><input id="planCsvFile" type="file" accept=".csv,text/csv"></label>
      <label class="planning-field"><span>Tipo padrao</span><select id="planCsvType">${Object.entries(PLANNING_TYPES).map(([key,label]) => `<option value="${key}">${label}</option>`).join('')}</select></label>
      <label class="planning-field"><span>Site padrao</span><select id="planCsvSite">${planningSiteOptions()}</select></label>
    </div><div class="planning-csv-example"><strong>Colunas aceitas</strong><code>tipo;nome;ip;site;fabricante;modelo;pon;onu;latitude;longitude;imagem;observacoes</code><span>O minimo obrigatorio e a coluna <b>nome</b>. Site informado no CSV e criado automaticamente.</span></div>`,
    onSave: async root => {
      const file = root.querySelector('#planCsvFile').files[0];
      if (!file) throw new Error('Escolha um arquivo CSV.');
      const form = new FormData(); form.append('file', file);
      form.append('defaults_json', JSON.stringify({ device_type: root.querySelector('#planCsvType').value, site_id: root.querySelector('#planCsvSite').value || null, status: 'planned' }));
      const data = await planningMultipart(`/api/planning/projects/${_planningCurrent.id}/import-csv`, form);
      _planningCatalog = null;
      closePlanningModal(); showToast(`${data.imported} item(ns) importado(s)${data.errors?.length ? `; ${data.errors.length} linha(s) com erro` : ''}.`, !!data.errors?.length); await selectPlanningProject(_planningCurrent.id);
    },
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

function bindPlanningUi() {
  const on = (id, event, handler) => { const el = document.getElementById(id); if (el) el.addEventListener(event, handler); };
  on('btnPlanningNew', 'click', () => openPlanningProjectModal(true));
  on('btnPlanningRefresh', 'click', () => loadPlanning(true));
  on('btnPlanningEdit', 'click', () => openPlanningProjectModal(false));
  on('btnPlanningSite', 'click', openPlanningSiteModal);
  on('btnPlanningKmz', 'click', openPlanningKmzModal);
  on('btnPlanningDelete', 'click', deletePlanningProject);
  on('btnPlanningAdd', 'click', () => openPlanningDeviceModal());
  on('btnPlanningGenerate', 'click', openPlanningGenerateModal);
  on('btnPlanningCsv', 'click', openPlanningCsvModal);
  on('planningSearch', 'input', renderPlanningDevices);
  on('planningTypeFilter', 'change', renderPlanningDevices);
  on('planningSiteFilter', 'change', renderPlanningDevices);
}
