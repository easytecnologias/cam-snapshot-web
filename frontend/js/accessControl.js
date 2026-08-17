let _accessPeopleRows = [];
let _accessPeopleSelected = new Set();

function accessPersonTypeLabel(type) {
  const key = String(type || '').toLowerCase();
  if (key === 'employee') return 'Funcionario';
  if (key === 'visitor') return 'Visitante';
  return 'Aluno';
}

function accessPersonStatusBadge(active) {
  return active
    ? '<span class="pill success">Ativo</span>'
    : '<span class="pill neutral">Inativo</span>';
}

const ACCESS_TYPE_ICONS = { student: 'graduation-cap', employee: 'briefcase', visitor: 'user' };
function accessPersonTypeIcon(type) {
  const key = String(type || '').toLowerCase();
  const icon = ACCESS_TYPE_ICONS[key] || ACCESS_TYPE_ICONS.student;
  const cls = ACCESS_TYPE_ICONS[key] ? key : 'student';
  return `<span class="access-type-icon ${cls}"><i data-lucide="${icon}"></i></span>`;
}

// Numero fica salvo so com digitos (+ opcional na frente, ver _clean_phone no
// backend) -- aqui e so pra exibicao, nunca reenviado formatado.
function formatBrPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (digits.length === 11) return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return phone || '';
}

// Documento e texto livre no cadastro (CPF/RG) -- so aplica mascara de CPF
// quando bate exatamente com 11 digitos, senao mostra como foi digitado.
function formatDocument(doc) {
  const digits = String(doc || '').replace(/\D/g, '');
  if (digits.length === 11 && digits === String(doc || '').trim()) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  return doc || '';
}

function bindAccessControl() {
  document.getElementById('btnAccessPersonNew')?.addEventListener('click', () => openAccessPersonModal());
  document.getElementById('btnAccessPeopleRefresh')?.addEventListener('click', () => loadAccessControl(true));
  document.getElementById('accessPeopleSearch')?.addEventListener('input', debounceAccessPeopleSearch);
  document.getElementById('accessPeopleStatus')?.addEventListener('change', () => loadAccessControl(true));
  document.getElementById('accessPeopleType')?.addEventListener('change', () => loadAccessControl(true));
  document.getElementById('accessPeopleSite')?.addEventListener('change', () => loadAccessControl(true));
  document.getElementById('accessPeopleSelectAll')?.addEventListener('change', toggleAccessPeopleSelectAll);
  document.getElementById('btnAccessPersonClose')?.addEventListener('click', closeAccessPersonModal);
  document.getElementById('btnAccessPersonCancel')?.addEventListener('click', closeAccessPersonModal);
  document.getElementById('accessPersonForm')?.addEventListener('submit', saveAccessPersonFromForm);
  document.getElementById('accessPeopleBody')?.addEventListener('click', handleAccessPeopleBodyClick);
  loadAccessPeopleSiteOptions();
  bindAccessTabs();
  bindAccessDevices();
  bindAccessGroups();
}

let _accessPeopleSearchTimer = null;
function debounceAccessPeopleSearch() {
  clearTimeout(_accessPeopleSearchTimer);
  _accessPeopleSearchTimer = setTimeout(() => loadAccessControl(true), 280);
}

async function loadAccessControl(force = false) {
  const query = new URLSearchParams();
  const search = document.getElementById('accessPeopleSearch')?.value?.trim() || '';
  const active = document.getElementById('accessPeopleStatus')?.value || '';
  const type = document.getElementById('accessPeopleType')?.value || '';
  const site = document.getElementById('accessPeopleSite')?.value || '';
  if (search) query.set('search', search);
  if (active) query.set('active', active);
  if (type) query.set('person_type', type);
  if (site) query.set('site', site);

  try {
    const [summaryRes, peopleRes] = await Promise.all([
      apiJson('/api/access-control/summary', { forceRefresh: force, cacheTtl: 0 }),
      apiJson(`/api/access-control/people?${query.toString()}`, { forceRefresh: force, cacheTtl: 0 }),
    ]);
    const summary = summaryRes?.summary || {};
    _accessPeopleRows = peopleRes?.people || [];
    renderAccessControlSummary(summary);
    renderAccessPeople(_accessPeopleRows);
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel carregar controle de acesso.', true);
  }
}

async function loadAccessPeopleSiteOptions() {
  const select = document.getElementById('accessPeopleSite');
  if (!select) return;
  try {
    const res = await apiJson('/api/access-control/people/sites', { cacheTtl: 0 });
    const sites = res?.sites || [];
    const current = select.value;
    select.innerHTML = '<option value="">Todos os sites</option>'
      + sites.map(site => `<option value="${esc(site)}">${esc(site)}</option>`).join('');
    if (sites.includes(current)) select.value = current;
  } catch (err) {
    // Filtro fica so com "Todos os sites" se a busca falhar -- nao bloqueia a tela.
  }
}

function renderAccessControlSummary(summary) {
  setText('accessKpiStudents', summary.students || 0);
  setText('accessKpiPeopleSub', `${summary.people_active || 0} ativo(s) de ${summary.people_total || 0}`);
  setText('accessKpiDevices', summary.devices_active || 0);
  setText('accessKpiEvents', summary.events_today || 0);
  setText('accessKpiWhatsapp', summary.whatsapp_queue || 0);
}

function renderAccessPeople(rows) {
  const body = document.getElementById('accessPeopleBody');
  if (!body) return;
  const countEl = document.getElementById('accessPeopleCount');
  if (countEl) countEl.textContent = rows.length === 1 ? '1 pessoa encontrada.' : `${rows.length} pessoas encontradas.`;
  _accessPeopleSelected.clear();
  syncAccessPeopleSelectAll();
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="10">Nenhuma pessoa encontrada com esses filtros.</td></tr>';
    scheduleResponsiveHydration(body);
    return;
  }
  body.innerHTML = rows.map(person => `
    <tr>
      <td class="access-checkbox-cell"><input type="checkbox" class="access-row-check" data-person-check="${esc(person.id)}" aria-label="Selecionar ${esc(person.full_name)}"></td>
      <td>
        <div class="access-person-name-cell" title="${esc(person.full_name)} (${esc(accessPersonTypeLabel(person.person_type))})">
          ${accessPersonTypeIcon(person.person_type)}
          <strong>${esc(person.full_name)}</strong>
        </div>
      </td>
      <td title="${esc(formatDocument(person.document_id) || '')}">${esc(formatDocument(person.document_id) || '-')}</td>
      <td title="${esc(person.site || '')}">${esc(person.site || '-')}</td>
      <td>${esc(person.enrollment_code || '-')}</td>
      <td title="${esc(person.class_name || '')}">${esc(person.class_name || '-')}</td>
      <td title="${esc(person.guardian_name || '')}">${esc(person.guardian_name || '-')}</td>
      <td>${esc(formatBrPhone(person.guardian_phone) || '-')}</td>
      <td>${accessPersonStatusBadge(person.active)}</td>
      <td class="access-checkbox-cell">
        <button class="icon-button row-menu-toggle" type="button" data-row-menu-person="${esc(person.id)}" aria-label="Mais acoes para ${esc(person.full_name)}"><i data-lucide="more-vertical"></i></button>
      </td>
    </tr>
  `).join('');
  scheduleResponsiveHydration(body);
  lucide.createIcons();
}

function openAccessPersonModal(person = null) {
  const item = person || {};
  setText('accessPersonModalTitle', item.id ? 'Editar pessoa' : 'Nova pessoa');
  document.getElementById('accessPersonId').value = item.id || '';
  document.getElementById('accessPersonName').value = item.full_name || '';
  document.getElementById('accessPersonType').value = item.person_type || 'student';
  document.getElementById('accessPersonEnrollment').value = item.enrollment_code || '';
  document.getElementById('accessPersonDocument').value = item.document_id || '';
  document.getElementById('accessPersonClass').value = item.class_name || '';
  // save_person() no backend faz UPDATE completo (ON CONFLICT DO UPDATE SET
  // site=excluded.site), entao o formulario precisa carregar e reenviar o site
  // atual -- sem este campo, qualquer edicao pela UI apagava o site da pessoa.
  document.getElementById('accessPersonSite').value = item.site || '';
  document.getElementById('accessPersonGuardian').value = item.guardian_name || '';
  document.getElementById('accessPersonPhone').value = item.guardian_phone || '';
  document.getElementById('accessPersonNotes').value = item.notes || '';
  document.getElementById('accessPersonWhatsapp').checked = item.whatsapp_enabled !== false;
  document.getElementById('accessPersonActive').checked = item.active !== false;
  document.getElementById('modalAccessPerson')?.classList.remove('hidden');
  setTimeout(() => document.getElementById('accessPersonName')?.focus(), 50);
  lucide.createIcons();

  const syncEl = document.getElementById('accessPersonSyncStatus');
  if (syncEl) {
    if (item.id) {
      syncEl.textContent = 'Carregando status de sincronizacao...';
      apiJson(`/api/access-control/events?person_id=${encodeURIComponent(item.id)}&limit=1`, { cacheTtl: 0 })
        .then(res => {
          const last = (res?.events || [])[0];
          syncEl.textContent = last ? `Ultimo evento: ${last.event_type} em ${last.occurred_at}` : 'Sem eventos registrados ainda.';
        })
        .catch(() => { syncEl.textContent = ''; });
    } else {
      syncEl.textContent = '';
    }
  }
}

function closeAccessPersonModal() {
  document.getElementById('modalAccessPerson')?.classList.add('hidden');
}

async function saveAccessPersonFromForm(event) {
  event.preventDefault();
  const btn = document.getElementById('btnAccessPersonSave');
  const oldHtml = btn?.innerHTML;
  const payload = {
    id: document.getElementById('accessPersonId').value.trim(),
    full_name: document.getElementById('accessPersonName').value.trim(),
    person_type: document.getElementById('accessPersonType').value,
    enrollment_code: document.getElementById('accessPersonEnrollment').value.trim(),
    document_id: document.getElementById('accessPersonDocument').value.trim(),
    class_name: document.getElementById('accessPersonClass').value.trim(),
    site: document.getElementById('accessPersonSite').value.trim(),
    guardian_name: document.getElementById('accessPersonGuardian').value.trim(),
    guardian_phone: document.getElementById('accessPersonPhone').value.trim(),
    notes: document.getElementById('accessPersonNotes').value.trim(),
    whatsapp_enabled: document.getElementById('accessPersonWhatsapp').checked,
    active: document.getElementById('accessPersonActive').checked,
  };
  if (!payload.full_name) {
    showToast('Informe o nome da pessoa.', true);
    return;
  }
  if (payload.whatsapp_enabled && !payload.guardian_phone) {
    showToast('Informe o WhatsApp do responsavel ou desmarque o envio de notificacoes.', true);
    document.getElementById('accessPersonPhone')?.focus();
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Salvando';
    lucide.createIcons();
  }
  try {
    const res = await api('/api/access-control/people', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    await jsonOrReadableError(res, 'Nao foi possivel salvar a pessoa.');
    closeAccessPersonModal();
    await loadAccessControl(true);
    loadAccessPeopleSiteOptions();
    showToast('Pessoa salva.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar a pessoa.', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldHtml || '<i data-lucide="save"></i> Salvar pessoa';
      lucide.createIcons();
    }
  }
}

let _accessDeviceRows = [];
let _accessDeviceDeleteConfirmId = '';

function bindAccessTabs() {
  document.querySelectorAll('.access-control-tabs .tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.dataset.accessTab;
      document.querySelectorAll('.access-control-tabs .tab-btn').forEach(b => {
        const active = b === btn;
        b.classList.toggle('active', active);
        b.setAttribute('aria-selected', active ? 'true' : 'false');
      });
      document.querySelectorAll('.access-tab-panel').forEach(panel => {
        panel.hidden = panel.dataset.accessPanel !== tab;
      });
      if (tab === 'devices') loadAccessDevices();
      if (tab === 'groups') loadAccessGroups();
      if (tab === 'rules') loadAccessRules();
    });
  });
}

function bindAccessDevices() {
  document.getElementById('btnAccessDeviceNew')?.addEventListener('click', () => openAccessDeviceModal());
  document.getElementById('btnAccessDevicesRefresh')?.addEventListener('click', () => loadAccessDevices(true));
  document.getElementById('btnAccessDeviceClose')?.addEventListener('click', closeAccessDeviceModal);
  document.getElementById('btnAccessDeviceCancel')?.addEventListener('click', closeAccessDeviceModal);
  document.getElementById('accessDeviceForm')?.addEventListener('submit', saveAccessDeviceFromForm);
  document.getElementById('accessDevicesBody')?.addEventListener('click', handleAccessDeviceAction);
}

async function loadAccessDevices(force = false) {
  try {
    const res = await apiJson('/api/access-control/devices', { forceRefresh: force, cacheTtl: 0 });
    _accessDeviceRows = res?.devices || [];
    renderAccessDevices(_accessDeviceRows);
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel carregar dispositivos.', true);
  }
}

function accessDeviceStatusBadge(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'online') return '<span class="pill success">online</span>';
  if (key === 'offline') return '<span class="pill neutral">offline</span>';
  return `<span class="pill neutral">${esc(status || 'desconhecido')}</span>`;
}

function renderAccessDevices(rows) {
  const body = document.getElementById('accessDevicesBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="6">Nenhum dispositivo cadastrado.</td></tr>';
    scheduleResponsiveHydration(body);
    return;
  }
  body.innerHTML = rows.map(device => `
    <tr>
      <td><strong>${esc(device.name)}</strong></td>
      <td>${esc(device.site || '-')}</td>
      <td>${esc(device.host)}</td>
      <td>${esc(device.model || '-')}</td>
      <td>${accessDeviceStatusBadge(device.status)}</td>
      <td>
        <div class="access-person-actions">
          <button class="icon-button" type="button" data-access-open-door="${esc(device.id)}" aria-label="Abrir porta de ${esc(device.name)}"><i data-lucide="door-open"></i></button>
          <button class="icon-button" type="button" data-access-edit-device="${esc(device.id)}" aria-label="Editar ${esc(device.name)}"><i data-lucide="pencil"></i></button>
          <button class="icon-button danger-action" type="button" data-access-delete-device="${esc(device.id)}" aria-label="Excluir ${esc(device.name)}"><i data-lucide="trash-2"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
  scheduleResponsiveHydration(body);
  lucide.createIcons();
}

function openAccessDeviceModal(device = null) {
  const item = device || {};
  setText('accessDeviceModalTitle', item.id ? 'Editar dispositivo' : 'Novo dispositivo');
  document.getElementById('accessDeviceId').value = item.id || '';
  // Preserva vendor/model do registro existente: o backend faz UPDATE completo
  // (ON CONFLICT DO UPDATE SET vendor=excluded.vendor, model=excluded.model), entao
  // se nao reenviarmos esses campos aqui, editar um dispositivo apaga o model salvo
  // e forca o vendor de volta para o default "dahua".
  document.getElementById('accessDeviceVendor').value = item.vendor || 'dahua';
  document.getElementById('accessDeviceModel').value = item.model || '';
  document.getElementById('accessDeviceName').value = item.name || '';
  document.getElementById('accessDeviceSite').value = item.site || '';
  document.getElementById('accessDeviceHost').value = item.host || '';
  document.getElementById('accessDeviceUsername').value = item.username || 'admin';
  // O backend nunca devolve a senha (get_device_with_password e uso interno) --
  // este campo fica sempre em branco, mesmo editando um dispositivo existente.
  document.getElementById('accessDevicePassword').value = '';
  document.getElementById('accessDeviceActive').checked = item.active !== false;
  document.getElementById('modalAccessDevice')?.classList.remove('hidden');
  setTimeout(() => document.getElementById('accessDeviceName')?.focus(), 50);
  lucide.createIcons();
}

function closeAccessDeviceModal() {
  document.getElementById('modalAccessDevice')?.classList.add('hidden');
}

async function saveAccessDeviceFromForm(event) {
  event.preventDefault();
  const btn = document.getElementById('btnAccessDeviceSave');
  const oldHtml = btn?.innerHTML;
  const payload = {
    id: document.getElementById('accessDeviceId').value.trim(),
    name: document.getElementById('accessDeviceName').value.trim(),
    site: document.getElementById('accessDeviceSite').value.trim(),
    vendor: document.getElementById('accessDeviceVendor').value.trim(),
    model: document.getElementById('accessDeviceModel').value.trim(),
    host: document.getElementById('accessDeviceHost').value.trim(),
    username: document.getElementById('accessDeviceUsername').value.trim(),
    password: document.getElementById('accessDevicePassword').value,
    active: document.getElementById('accessDeviceActive').checked,
  };
  if (!payload.name || !payload.host) {
    showToast('Informe nome e host do dispositivo.', true);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Salvando';
    lucide.createIcons();
  }
  try {
    const res = await api('/api/access-control/devices', { method: 'POST', body: JSON.stringify(payload) });
    await jsonOrReadableError(res, 'Nao foi possivel salvar o dispositivo.');
    closeAccessDeviceModal();
    await loadAccessDevices(true);
    showToast('Dispositivo salvo.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar o dispositivo.', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldHtml || '<i data-lucide="save"></i> Salvar dispositivo';
      lucide.createIcons();
    }
  }
}

async function handleAccessDeviceAction(event) {
  const openBtn = event.target.closest?.('[data-access-open-door]');
  const editBtn = event.target.closest?.('[data-access-edit-device]');
  const deleteBtn = event.target.closest?.('[data-access-delete-device]');
  if (openBtn) {
    openBtn.disabled = true;
    try {
      const res = await api(`/api/access-control/devices/${encodeURIComponent(openBtn.dataset.accessOpenDoor)}/open-door`, { method: 'POST' });
      await jsonOrReadableError(res, 'Nao foi possivel abrir a porta.');
      showToast('Porta liberada.');
    } catch (err) {
      showToast(err?.message || 'Nao foi possivel abrir a porta.', true);
    } finally {
      openBtn.disabled = false;
    }
    return;
  }
  if (editBtn) {
    const device = _accessDeviceRows.find(row => row.id === editBtn.dataset.accessEditDevice);
    if (device) openAccessDeviceModal(device);
    return;
  }
  if (deleteBtn) {
    const device = _accessDeviceRows.find(row => row.id === deleteBtn.dataset.accessDeleteDevice);
    if (!device) return;
    if (_accessDeviceDeleteConfirmId !== device.id) {
      _accessDeviceDeleteConfirmId = device.id;
      showToast(`Clique novamente para excluir ${device.name}.`);
      setTimeout(() => {
        if (_accessDeviceDeleteConfirmId === device.id) _accessDeviceDeleteConfirmId = '';
      }, 4500);
      return;
    }
    try {
      const res = await api(`/api/access-control/devices/${encodeURIComponent(device.id)}`, { method: 'DELETE' });
      await jsonOrReadableError(res, 'Nao foi possivel excluir o dispositivo.');
      _accessDeviceDeleteConfirmId = '';
      await loadAccessDevices(true);
      showToast('Dispositivo excluido.');
    } catch (err) {
      showToast(err?.message || 'Nao foi possivel excluir o dispositivo.', true);
    }
  }
}

async function deletePersonWithConfirm(person) {
  const ok = await showConfirm({
    title: 'Excluir pessoa',
    msg: `Excluir ${person.full_name} do controle de acesso? Isso remove o cadastro e o historico de sincronizacao.`,
    label: 'Excluir',
  });
  if (!ok) return;
  try {
    const res = await api(`/api/access-control/people/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
    await jsonOrReadableError(res, 'Nao foi possivel excluir a pessoa.');
    await loadAccessControl(true);
    showToast('Pessoa excluida.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel excluir a pessoa.', true);
  }
}

function handleAccessPeopleBodyClick(event) {
  const menuBtn = event.target.closest?.('[data-row-menu-person]');
  if (menuBtn) {
    const person = _accessPeopleRows.find(row => row.id === menuBtn.dataset.rowMenuPerson);
    if (!person) return;
    openRowActionsMenu(menuBtn, [
      { label: 'Editar', icon: 'pencil', onClick: () => openAccessPersonModal(person) },
      { label: 'Excluir', icon: 'trash-2', danger: true, onClick: () => deletePersonWithConfirm(person) },
    ]);
    return;
  }
  const check = event.target.closest?.('[data-person-check]');
  if (check) {
    if (check.checked) _accessPeopleSelected.add(check.dataset.personCheck);
    else _accessPeopleSelected.delete(check.dataset.personCheck);
    syncAccessPeopleSelectAll();
  }
}

function syncAccessPeopleSelectAll() {
  const master = document.getElementById('accessPeopleSelectAll');
  if (!master) return;
  const total = _accessPeopleRows.length;
  const selected = _accessPeopleSelected.size;
  master.checked = total > 0 && selected === total;
  master.indeterminate = selected > 0 && selected < total;
}

function toggleAccessPeopleSelectAll(event) {
  const checked = event.target.checked;
  _accessPeopleSelected = new Set(checked ? _accessPeopleRows.map(p => p.id) : []);
  document.querySelectorAll('#accessPeopleBody [data-person-check]').forEach(el => { el.checked = checked; });
  syncAccessPeopleSelectAll();
}

// Menu flutuante de acoes por linha ("3 pontinhos") -- anexado no <body> (nao
// dentro da celula) e posicionado via getBoundingClientRect, pra nao ficar
// cortado pelo overflow:hidden do .table-wrap quando a linha esta perto da
// borda da tabela. Generico o bastante pra reaproveitar em outras tabelas
// deste arquivo (dispositivos, grupos, regras) se precisar.
let _openRowActionsMenu = null;
let _openRowActionsAnchor = null;
function closeRowActionsMenu() {
  if (!_openRowActionsMenu) return;
  _openRowActionsMenu.remove();
  _openRowActionsMenu = null;
  _openRowActionsAnchor = null;
  document.removeEventListener('click', _rowActionsOutsideHandler, true);
  document.removeEventListener('keydown', _rowActionsEscHandler, true);
  window.removeEventListener('scroll', closeRowActionsMenu, true);
  window.removeEventListener('resize', closeRowActionsMenu, true);
}
function _rowActionsOutsideHandler(e) {
  if (_openRowActionsMenu && !_openRowActionsMenu.contains(e.target) && e.target !== _openRowActionsAnchor) closeRowActionsMenu();
}
function _rowActionsEscHandler(e) {
  if (e.key === 'Escape') closeRowActionsMenu();
}
function openRowActionsMenu(anchorBtn, items) {
  const wasOpenForSameAnchor = _openRowActionsAnchor === anchorBtn;
  closeRowActionsMenu();
  if (wasOpenForSameAnchor) return;
  const panel = document.createElement('div');
  panel.className = 'row-actions-panel';
  panel.setAttribute('role', 'menu');
  panel.innerHTML = items.map((it, idx) => `
    <button type="button" class="${it.danger ? 'danger' : ''}" data-idx="${idx}" role="menuitem">
      <i data-lucide="${it.icon}"></i> ${esc(it.label)}
    </button>
  `).join('');
  document.body.appendChild(panel);
  panel.querySelectorAll('button').forEach((btn, idx) => {
    btn.addEventListener('click', () => { closeRowActionsMenu(); items[idx].onClick(); });
  });
  lucide.createIcons();

  const rect = anchorBtn.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const spaceBelow = window.innerHeight - rect.bottom;
  const top = spaceBelow >= panelRect.height + 8 ? rect.bottom + 4 : rect.top - panelRect.height - 4;
  let left = rect.right - panelRect.width;
  left = Math.max(8, Math.min(left, window.innerWidth - panelRect.width - 8));
  panel.style.top = `${Math.max(8, top)}px`;
  panel.style.left = `${left}px`;

  _openRowActionsMenu = panel;
  _openRowActionsAnchor = anchorBtn;
  setTimeout(() => document.addEventListener('click', _rowActionsOutsideHandler, true), 0);
  document.addEventListener('keydown', _rowActionsEscHandler, true);
  window.addEventListener('scroll', closeRowActionsMenu, true);
  window.addEventListener('resize', closeRowActionsMenu, true);
}

let _accessGroupRows = [];
let _accessDoorGroupRows = [];
let _accessRuleRows = [];
// true quando o checklist de pessoas do modal de grupo nao carregou -- salvar
// nesse estado enviaria member_ids incompleto e o backend apagaria os membros
// que faltaram (set_group_members faz DELETE + reinsert).
let _accessGroupPeopleLoadFailed = false;

function bindAccessGroups() {
  document.getElementById('btnAccessGroupNew')?.addEventListener('click', () => openAccessGroupModal());
  document.getElementById('btnAccessDoorGroupNew')?.addEventListener('click', () => openAccessDoorGroupModal());
  document.getElementById('btnAccessRuleNew')?.addEventListener('click', () => openAccessRuleModal());
  document.getElementById('accessGroupsBody')?.addEventListener('click', handleAccessGroupAction);
  document.getElementById('accessDoorGroupsBody')?.addEventListener('click', handleAccessDoorGroupAction);
  document.getElementById('accessRulesBody')?.addEventListener('click', handleAccessRuleAction);
  document.getElementById('btnAccessGroupClose')?.addEventListener('click', closeAccessGroupModal);
  document.getElementById('btnAccessGroupCancel')?.addEventListener('click', closeAccessGroupModal);
  document.getElementById('accessGroupForm')?.addEventListener('submit', saveAccessGroupFromForm);
  document.getElementById('btnAccessDoorGroupClose')?.addEventListener('click', closeAccessDoorGroupModal);
  document.getElementById('btnAccessDoorGroupCancel')?.addEventListener('click', closeAccessDoorGroupModal);
  document.getElementById('accessDoorGroupForm')?.addEventListener('submit', saveAccessDoorGroupFromForm);
  document.getElementById('btnAccessRuleClose')?.addEventListener('click', closeAccessRuleModal);
  document.getElementById('btnAccessRuleCancel')?.addEventListener('click', closeAccessRuleModal);
  document.getElementById('accessRuleForm')?.addEventListener('submit', saveAccessRuleFromForm);
}

async function loadAccessGroups(force = false) {
  try {
    // Busca dispositivos junto com os grupos -- sem isso, _accessDeviceRows so
    // seria preenchido ao visitar a aba Dispositivos. Se o usuario for direto de
    // Pessoas pra Grupos e editar um grupo de porta existente, o checklist de
    // dispositivos renderizaria vazio (nada marcado) e salvar sobrescreveria
    // device_ids com [] no backend, apagando os dispositivos reais do grupo.
    const [groupsRes, doorGroupsRes, devicesRes] = await Promise.all([
      apiJson('/api/access-control/groups', { forceRefresh: force, cacheTtl: 0 }),
      apiJson('/api/access-control/door-groups', { forceRefresh: force, cacheTtl: 0 }),
      apiJson('/api/access-control/devices', { forceRefresh: force, cacheTtl: 0 }),
    ]);
    _accessGroupRows = groupsRes?.groups || [];
    _accessDoorGroupRows = doorGroupsRes?.door_groups || [];
    _accessDeviceRows = devicesRes?.devices || [];
    renderAccessGroups(_accessGroupRows);
    renderAccessDoorGroups(_accessDoorGroupRows);
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel carregar grupos.', true);
  }
}

function renderAccessGroups(rows) {
  const body = document.getElementById('accessGroupsBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="4">Nenhum grupo cadastrado.</td></tr>';
    scheduleResponsiveHydration(body);
    return;
  }
  body.innerHTML = rows.map(group => `
    <tr>
      <td><strong>${esc(group.name)}</strong></td>
      <td>${esc(group.site || '-')}</td>
      <td>${(group.member_ids || []).length}</td>
      <td>
        <div class="access-person-actions">
          <button class="icon-button" type="button" data-access-edit-group="${esc(group.id)}" aria-label="Editar ${esc(group.name)}"><i data-lucide="pencil"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
  scheduleResponsiveHydration(body);
  lucide.createIcons();
}

function renderAccessDoorGroups(rows) {
  const body = document.getElementById('accessDoorGroupsBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="4">Nenhum grupo de porta cadastrado.</td></tr>';
    scheduleResponsiveHydration(body);
    return;
  }
  body.innerHTML = rows.map(group => `
    <tr>
      <td><strong>${esc(group.name)}</strong></td>
      <td>${esc(group.site || '-')}</td>
      <td>${(group.device_ids || []).length}</td>
      <td>
        <div class="access-person-actions">
          <button class="icon-button" type="button" data-access-edit-door-group="${esc(group.id)}" aria-label="Editar ${esc(group.name)}"><i data-lucide="pencil"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
  scheduleResponsiveHydration(body);
  lucide.createIcons();
}

async function loadAccessRules(force = false) {
  try {
    // Busca grupos e grupos de porta junto com as regras -- sem isso a tabela de
    // regras so teria os IDs crus (people_group_id/door_group_id) pra mostrar,
    // caso o usuario abra a aba Regras sem antes visitar a aba Grupos.
    const [groupsRes, doorGroupsRes, rulesRes] = await Promise.all([
      apiJson('/api/access-control/groups', { forceRefresh: force, cacheTtl: 0 }),
      apiJson('/api/access-control/door-groups', { forceRefresh: force, cacheTtl: 0 }),
      apiJson('/api/access-control/rules', { forceRefresh: force, cacheTtl: 0 }),
    ]);
    _accessGroupRows = groupsRes?.groups || [];
    _accessDoorGroupRows = doorGroupsRes?.door_groups || [];
    _accessRuleRows = rulesRes?.rules || [];
    renderAccessRules(_accessRuleRows);
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel carregar regras.', true);
  }
}

const ACCESS_WEEKDAY_LABELS = { 1: 'Seg', 2: 'Ter', 3: 'Qua', 4: 'Qui', 5: 'Sex', 6: 'Sab', 7: 'Dom' };

function accessRuleWeekdaysLabel(weekdays) {
  const digits = String(weekdays || '').split('').filter(d => ACCESS_WEEKDAY_LABELS[d]);
  if (digits.length === 7) return 'Todos os dias';
  if (!digits.length) return '-';
  return digits.map(d => ACCESS_WEEKDAY_LABELS[d]).join(', ');
}

function renderAccessRules(rows) {
  const body = document.getElementById('accessRulesBody');
  if (!body) return;
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">Nenhuma regra cadastrada.</td></tr>';
    scheduleResponsiveHydration(body);
    return;
  }
  const groupName = id => _accessGroupRows.find(g => g.id === id)?.name || id || '-';
  const doorGroupName = id => _accessDoorGroupRows.find(g => g.id === id)?.name || id || '-';
  body.innerHTML = rows.map(rule => `
    <tr>
      <td>${esc(groupName(rule.people_group_id))}</td>
      <td>${esc(doorGroupName(rule.door_group_id))}</td>
      <td>${esc(accessRuleWeekdaysLabel(rule.weekdays))}</td>
      <td>${esc(rule.time_start || '00:00')} - ${esc(rule.time_end || '23:59')}</td>
      <td>
        <div class="access-person-actions">
          <button class="icon-button" type="button" data-access-edit-rule="${esc(rule.id)}" aria-label="Editar regra"><i data-lucide="pencil"></i></button>
        </div>
      </td>
    </tr>
  `).join('');
  scheduleResponsiveHydration(body);
  lucide.createIcons();
}

function handleAccessGroupAction(event) {
  const editBtn = event.target.closest?.('[data-access-edit-group]');
  if (!editBtn) return;
  const group = _accessGroupRows.find(row => row.id === editBtn.dataset.accessEditGroup);
  if (group) openAccessGroupModal(group);
}

function handleAccessDoorGroupAction(event) {
  const editBtn = event.target.closest?.('[data-access-edit-door-group]');
  if (!editBtn) return;
  const doorGroup = _accessDoorGroupRows.find(row => row.id === editBtn.dataset.accessEditDoorGroup);
  if (doorGroup) openAccessDoorGroupModal(doorGroup);
}

function handleAccessRuleAction(event) {
  const editBtn = event.target.closest?.('[data-access-edit-rule]');
  if (!editBtn) return;
  const rule = _accessRuleRows.find(row => row.id === editBtn.dataset.accessEditRule);
  if (rule) openAccessRuleModal(rule);
}

async function openAccessGroupModal(group = null) {
  const item = group || {};
  setText('accessGroupModalTitle', item.id ? 'Editar grupo' : 'Novo grupo');
  document.getElementById('accessGroupId').value = item.id || '';
  document.getElementById('accessGroupName').value = item.name || '';
  document.getElementById('accessGroupSite').value = item.site || '';
  const checklist = document.getElementById('accessGroupMembersChecklist');
  const memberIds = new Set(item.member_ids || []);
  if (checklist) checklist.innerHTML = '<p class="muted-block">Carregando pessoas...</p>';
  document.getElementById('modalAccessGroup')?.classList.remove('hidden');
  lucide.createIcons();

  // O modal fica visivel (linha acima) antes do await abaixo terminar --
  // desabilita o Salvar enquanto a lista de pessoas carrega para o operador
  // nao conseguir salvar com o checklist ainda em "Carregando pessoas...",
  // o que postaria member_ids: [] e apagaria a composicao real do grupo.
  const groupSaveBtn = document.getElementById('btnAccessGroupSave');
  if (groupSaveBtn) groupSaveBtn.disabled = true;

  // Busca a lista COMPLETA de pessoas aqui, sem search/active -- NAO reusa
  // _accessPeopleRows, que carrega o resultado ja filtrado pelos controles da
  // aba Pessoas. Como saveAccessGroupFromForm envia os marcados como a lista
  // COMPLETA de member_ids e o backend faz DELETE + reinsert, montar o
  // checklist a partir de uma lista filtrada apagava do grupo todo mundo que
  // nao casava com o filtro ativo (ex: busca "Silva" na aba Pessoas, edita o
  // nome de um grupo de 30 pessoas, salva -> sobram so os "Silva").
  _accessGroupPeopleLoadFailed = false;
  let people = [];
  try {
    const res = await apiJson('/api/access-control/people', { forceRefresh: true, cacheTtl: 0 });
    // apiJson NAO lanca em resposta HTTP nao-2xx -- res.ok=false ou um 401
    // (onde api() ja devolve null) voltam como res == null, sem excecao. So
    // depender do try/catch aqui deixava esse caso passar como sucesso: res
    // era null, res?.people virava [] "silenciosamente" e o guard
    // _accessGroupPeopleLoadFailed nunca disparava -- exatamente o mesmo
    // data-loss que esse guard deveria evitar, so que por outro caminho.
    if (!res || !Array.isArray(res.people)) {
      throw new Error('Nao foi possivel carregar a lista de pessoas.');
    }
    people = res.people;
  } catch (err) {
    _accessGroupPeopleLoadFailed = true;
    if (checklist) checklist.innerHTML = '<p class="muted-block">Nao foi possivel carregar a lista de pessoas. Feche e reabra o grupo para tentar de novo.</p>';
    showToast(err?.message || 'Nao foi possivel carregar a lista de pessoas.', true);
    return;
  } finally {
    if (groupSaveBtn) groupSaveBtn.disabled = false;
  }
  if (checklist) {
    checklist.innerHTML = people.map(p => `
      <label class="access-checklist-item"><input type="checkbox" value="${esc(p.id)}" ${memberIds.has(p.id) ? 'checked' : ''}> ${esc(p.full_name)}</label>
    `).join('') || '<p class="muted-block">Cadastre pessoas primeiro.</p>';
  }
}

function closeAccessGroupModal() {
  document.getElementById('modalAccessGroup')?.classList.add('hidden');
}

async function saveAccessGroupFromForm(event) {
  event.preventDefault();
  const btn = document.getElementById('btnAccessGroupSave');
  const oldHtml = btn?.innerHTML;
  if (_accessGroupPeopleLoadFailed) {
    showToast('A lista de pessoas nao carregou -- feche e reabra o grupo antes de salvar.', true);
    return;
  }
  const memberIds = Array.from(document.querySelectorAll('#accessGroupMembersChecklist input:checked')).map(el => el.value);
  const payload = {
    id: document.getElementById('accessGroupId').value.trim(),
    name: document.getElementById('accessGroupName').value.trim(),
    site: document.getElementById('accessGroupSite').value.trim(),
    member_ids: memberIds,
  };
  if (!payload.name) {
    showToast('Informe o nome do grupo.', true);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Salvando';
    lucide.createIcons();
  }
  try {
    const res = await api('/api/access-control/groups', { method: 'POST', body: JSON.stringify(payload) });
    await jsonOrReadableError(res, 'Nao foi possivel salvar o grupo.');
    closeAccessGroupModal();
    await loadAccessGroups(true);
    showToast('Grupo salvo.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar o grupo.', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldHtml || '<i data-lucide="save"></i> Salvar grupo';
      lucide.createIcons();
    }
  }
}

function openAccessDoorGroupModal(doorGroup = null) {
  const item = doorGroup || {};
  setText('accessDoorGroupModalTitle', item.id ? 'Editar grupo de porta' : 'Novo grupo de porta');
  document.getElementById('accessDoorGroupId').value = item.id || '';
  document.getElementById('accessDoorGroupName').value = item.name || '';
  document.getElementById('accessDoorGroupSite').value = item.site || '';
  const checklist = document.getElementById('accessDoorGroupDevicesChecklist');
  const deviceIds = new Set(item.device_ids || []);
  if (checklist) {
    checklist.innerHTML = _accessDeviceRows.map(d => `
      <label class="access-checklist-item"><input type="checkbox" value="${esc(d.id)}" ${deviceIds.has(d.id) ? 'checked' : ''}> ${esc(d.name)}</label>
    `).join('') || '<p class="muted-block">Cadastre dispositivos primeiro.</p>';
  }
  document.getElementById('modalAccessDoorGroup')?.classList.remove('hidden');
  lucide.createIcons();
}

function closeAccessDoorGroupModal() {
  document.getElementById('modalAccessDoorGroup')?.classList.add('hidden');
}

async function saveAccessDoorGroupFromForm(event) {
  event.preventDefault();
  const btn = document.getElementById('btnAccessDoorGroupSave');
  const oldHtml = btn?.innerHTML;
  const deviceIds = Array.from(document.querySelectorAll('#accessDoorGroupDevicesChecklist input:checked')).map(el => el.value);
  const payload = {
    id: document.getElementById('accessDoorGroupId').value.trim(),
    name: document.getElementById('accessDoorGroupName').value.trim(),
    site: document.getElementById('accessDoorGroupSite').value.trim(),
    device_ids: deviceIds,
  };
  if (!payload.name) {
    showToast('Informe o nome do grupo de porta.', true);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Salvando';
    lucide.createIcons();
  }
  try {
    const res = await api('/api/access-control/door-groups', { method: 'POST', body: JSON.stringify(payload) });
    await jsonOrReadableError(res, 'Nao foi possivel salvar o grupo de porta.');
    closeAccessDoorGroupModal();
    await loadAccessGroups(true);
    showToast('Grupo de porta salvo.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar o grupo de porta.', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldHtml || '<i data-lucide="save"></i> Salvar grupo de porta';
      lucide.createIcons();
    }
  }
}

function openAccessRuleModal(rule = null) {
  const item = rule || {};
  setText('accessRuleModalTitle', item.id ? 'Editar regra' : 'Nova regra');
  document.getElementById('accessRuleId').value = item.id || '';
  const peopleSelect = document.getElementById('accessRulePeopleGroup');
  const doorSelect = document.getElementById('accessRuleDoorGroup');
  if (peopleSelect) {
    peopleSelect.innerHTML = _accessGroupRows.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')
      || '<option value="">Cadastre um grupo primeiro</option>';
    peopleSelect.value = item.people_group_id || '';
  }
  if (doorSelect) {
    doorSelect.innerHTML = _accessDoorGroupRows.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('')
      || '<option value="">Cadastre um grupo de porta primeiro</option>';
    doorSelect.value = item.door_group_id || '';
  }
  document.getElementById('accessRuleWeekdays').value = item.weekdays || '1234567';
  document.getElementById('accessRuleTimeStart').value = item.time_start || '';
  document.getElementById('accessRuleTimeEnd').value = item.time_end || '';
  document.getElementById('modalAccessRule')?.classList.remove('hidden');
  lucide.createIcons();
}

function closeAccessRuleModal() {
  document.getElementById('modalAccessRule')?.classList.add('hidden');
}

async function saveAccessRuleFromForm(event) {
  event.preventDefault();
  const btn = document.getElementById('btnAccessRuleSave');
  const oldHtml = btn?.innerHTML;
  const payload = {
    id: document.getElementById('accessRuleId').value.trim(),
    people_group_id: document.getElementById('accessRulePeopleGroup').value,
    door_group_id: document.getElementById('accessRuleDoorGroup').value,
    weekdays: document.getElementById('accessRuleWeekdays').value.trim() || '1234567',
    time_start: document.getElementById('accessRuleTimeStart').value,
    time_end: document.getElementById('accessRuleTimeEnd').value,
  };
  if (!payload.people_group_id || !payload.door_group_id) {
    showToast('Escolha o grupo de pessoas e o grupo de portas.', true);
    return;
  }
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i data-lucide="loader-circle"></i> Salvando';
    lucide.createIcons();
  }
  try {
    const res = await api('/api/access-control/rules', { method: 'POST', body: JSON.stringify(payload) });
    await jsonOrReadableError(res, 'Nao foi possivel salvar a regra.');
    closeAccessRuleModal();
    await loadAccessRules(true);
    showToast('Regra salva.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel salvar a regra.', true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = oldHtml || '<i data-lucide="save"></i> Salvar regra';
      lucide.createIcons();
    }
  }
}
