let _accessPeopleRows = [];
let _accessDeleteConfirmId = '';

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

function bindAccessControl() {
  document.getElementById('btnAccessPersonNew')?.addEventListener('click', () => openAccessPersonModal());
  document.getElementById('btnAccessPeopleRefresh')?.addEventListener('click', () => loadAccessControl(true));
  document.getElementById('accessPeopleSearch')?.addEventListener('input', debounceAccessPeopleSearch);
  document.getElementById('accessPeopleStatus')?.addEventListener('change', () => loadAccessControl(true));
  document.getElementById('btnAccessPersonClose')?.addEventListener('click', closeAccessPersonModal);
  document.getElementById('btnAccessPersonCancel')?.addEventListener('click', closeAccessPersonModal);
  document.getElementById('accessPersonForm')?.addEventListener('submit', saveAccessPersonFromForm);
  document.getElementById('accessPeopleBody')?.addEventListener('click', handleAccessPeopleAction);
  bindAccessTabs();
  bindAccessDevices();
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
  if (search) query.set('search', search);
  if (active) query.set('active', active);

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
  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="8">Nenhuma pessoa cadastrada.</td></tr>';
    scheduleResponsiveHydration(body);
    return;
  }
  body.innerHTML = rows.map(person => `
    <tr>
      <td><strong>${esc(person.full_name)}</strong><small class="muted-block">${esc(person.document_id || '')}</small></td>
      <td>${esc(accessPersonTypeLabel(person.person_type))}</td>
      <td>${esc(person.enrollment_code || '-')}</td>
      <td>${esc(person.class_name || '-')}</td>
      <td>${esc(person.guardian_name || '-')}</td>
      <td>${esc(person.guardian_phone || '-')}</td>
      <td>${accessPersonStatusBadge(person.active)}</td>
      <td>
        <div class="access-person-actions">
          <button class="icon-button" type="button" data-access-edit="${esc(person.id)}" aria-label="Editar ${esc(person.full_name)}"><i data-lucide="pencil"></i></button>
          <button class="icon-button danger-action" type="button" data-access-delete="${esc(person.id)}" aria-label="Excluir ${esc(person.full_name)}"><i data-lucide="trash-2"></i></button>
        </div>
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
  document.getElementById('accessPersonGuardian').value = item.guardian_name || '';
  document.getElementById('accessPersonPhone').value = item.guardian_phone || '';
  document.getElementById('accessPersonNotes').value = item.notes || '';
  document.getElementById('accessPersonWhatsapp').checked = item.whatsapp_enabled !== false;
  document.getElementById('accessPersonActive').checked = item.active !== false;
  document.getElementById('modalAccessPerson')?.classList.remove('hidden');
  setTimeout(() => document.getElementById('accessPersonName')?.focus(), 50);
  lucide.createIcons();
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

async function handleAccessPeopleAction(event) {
  const editBtn = event.target.closest?.('[data-access-edit]');
  const deleteBtn = event.target.closest?.('[data-access-delete]');
  if (editBtn) {
    const person = _accessPeopleRows.find(row => row.id === editBtn.dataset.accessEdit);
    if (person) openAccessPersonModal(person);
    return;
  }
  if (!deleteBtn) return;
  const person = _accessPeopleRows.find(row => row.id === deleteBtn.dataset.accessDelete);
  if (!person) return;
  if (_accessDeleteConfirmId !== person.id) {
    _accessDeleteConfirmId = person.id;
    showToast(`Clique novamente para excluir ${person.full_name}.`);
    setTimeout(() => {
      if (_accessDeleteConfirmId === person.id) _accessDeleteConfirmId = '';
    }, 4500);
    return;
  }
  try {
    const res = await api(`/api/access-control/people/${encodeURIComponent(person.id)}`, { method: 'DELETE' });
    await jsonOrReadableError(res, 'Nao foi possivel excluir a pessoa.');
    _accessDeleteConfirmId = '';
    await loadAccessControl(true);
    showToast('Pessoa excluida.');
  } catch (err) {
    showToast(err?.message || 'Nao foi possivel excluir a pessoa.', true);
  }
}
