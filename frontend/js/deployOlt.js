// Implantacao > OLT: cadastro das OLTs usadas na operacao.
//
// A senha nunca chega aqui -- a API devolve so `has_password`. Por isso o campo
// de senha nasce sempre vazio ao editar, e vazio significa "manter a atual"
// (ver olt_registry.save_olt no backend). Se um dia a tela passar a exibir a
// senha, o teste scripts/sightops_olt_routes_test.py quebra de proposito.

let _oltRegRows = [];
let _oltRegFiltered = [];

async function loadDeployOlt() {
  await Promise.all([_oltRegLoadConnectors(), _oltRegLoad()]);
}

async function _oltRegLoad() {
  const tbody = document.getElementById('oltRegRows');
  try {
    const res = await api('/api/olt/registry');
    _oltRegRows = Array.isArray(res?.items) ? res.items : [];
  } catch (err) {
    _oltRegRows = [];
    if (tbody) tbody.innerHTML = `<tr><td colspan="8">Falha ao carregar: ${esc(err?.message || err)}</td></tr>`;
    return;
  }
  _oltRegApplyFilter();
}

// O seletor de conector reusa a lista de conectores ja existente. Falhar aqui
// nao pode impedir o cadastro: OLT alcancavel direto na rede nao usa conector.
async function _oltRegLoadConnectors() {
  const sel = document.getElementById('oltRegConnector');
  if (!sel) return;
  try {
    const res = await api('/api/connectors');
    const itens = Array.isArray(res?.items) ? res.items : [];
    const atual = sel.value;
    sel.innerHTML = '<option value="">Acesso direto (sem conector)</option>'
      + itens.map(c => `<option value="${esc(c.id)}">${esc(c.name || c.id)}</option>`).join('');
    sel.value = atual;
  } catch (_) {
    /* segue com a opcao de acesso direto */
  }
}

function _oltRegApplyFilter() {
  const termo = (document.getElementById('oltRegSearch')?.value || '').trim().toLowerCase();
  _oltRegFiltered = !termo ? _oltRegRows : _oltRegRows.filter(o =>
    [o.name, o.host, o.vendor, o.model, o.username, o.notes]
      .some(v => String(v || '').toLowerCase().includes(termo)));
  _oltRegRender();
}

function _oltRegRender() {
  const tbody = document.getElementById('oltRegRows');
  const contador = document.getElementById('oltRegCount');
  if (!tbody) return;

  if (contador) {
    const total = _oltRegRows.length;
    const vendo = _oltRegFiltered.length;
    contador.textContent = total === 0 ? 'Nenhuma OLT cadastrada'
      : vendo === total ? `${total} OLT(s)`
      : `${vendo} de ${total} OLT(s)`;
  }

  if (!_oltRegFiltered.length) {
    tbody.innerHTML = `<tr><td colspan="8">${
      _oltRegRows.length ? 'Nenhuma OLT corresponde a busca.'
                         : 'Nenhuma OLT cadastrada. Use o formulario ao lado.'}</td></tr>`;
    return;
  }

  tbody.innerHTML = _oltRegFiltered.map(o => `
    <tr>
      <td><strong>${esc(o.name)}</strong>${o.notes ? `<br><span class="text-muted">${esc(o.notes)}</span>` : ''}</td>
      <td>${esc(o.host)}</td>
      <td>${esc(o.vendor) || '<span class="text-muted">--</span>'}</td>
      <td>${esc(o.model) || '<span class="text-muted">--</span>'}</td>
      <td>${esc(o.username) || '<span class="text-muted">--</span>'}</td>
      <td>${o.has_password
            ? '<span class="badge badge-green">cadastrada</span>'
            : '<span class="badge badge-amber">sem senha</span>'}</td>
      <td>${o.active
            ? '<span class="badge badge-green">ativa</span>'
            : '<span class="badge badge-gray">inativa</span>'}</td>
      <td style="text-align:right;white-space:nowrap">
        <button class="ghost-action" onclick="oltRegEdit(${Number(o.id)})" title="Editar"><i data-lucide="pencil"></i></button>
        <button class="ghost-action" onclick="oltRegDelete(${Number(o.id)})" title="Remover"><i data-lucide="trash-2"></i></button>
      </td>
    </tr>`).join('');
  lucide.createIcons();
}

function oltRegEdit(id) {
  const olt = _oltRegRows.find(o => Number(o.id) === Number(id));
  if (!olt) return;
  const set = (campo, valor) => { const el = document.getElementById(campo); if (el) el.value = valor ?? ''; };
  set('oltRegId', olt.id);
  set('oltRegName', olt.name);
  set('oltRegHost', olt.host);
  set('oltRegVendor', olt.vendor);
  set('oltRegModel', olt.model);
  set('oltRegUsername', olt.username);
  set('oltRegPassword', '');          // nunca vem da API; vazio = manter
  set('oltRegConnector', olt.connector_id);
  set('oltRegNotes', olt.notes);
  const ativo = document.getElementById('oltRegActive');
  if (ativo) ativo.checked = !!olt.active;

  document.getElementById('oltRegFormTitle').textContent = `Editando: ${olt.name}`;
  document.getElementById('oltRegPassword').placeholder = olt.has_password
    ? 'deixe vazio para manter a atual'
    : 'sem senha cadastrada';
  document.getElementById('btnOltRegCancel')?.classList.remove('hidden');
  document.getElementById('oltRegName')?.focus();
}

function oltRegResetForm() {
  ['oltRegId', 'oltRegName', 'oltRegHost', 'oltRegVendor', 'oltRegModel',
   'oltRegUsername', 'oltRegPassword', 'oltRegNotes'].forEach(campo => {
    const el = document.getElementById(campo);
    if (el) el.value = '';
  });
  const conector = document.getElementById('oltRegConnector');
  if (conector) conector.value = '';
  const ativo = document.getElementById('oltRegActive');
  if (ativo) ativo.checked = true;
  document.getElementById('oltRegFormTitle').textContent = 'Nova OLT';
  document.getElementById('oltRegPassword').placeholder = 'deixe vazio para manter a atual';
  document.getElementById('btnOltRegCancel')?.classList.add('hidden');
}

async function oltRegSave() {
  const val = campo => (document.getElementById(campo)?.value || '').trim();
  const id = val('oltRegId');

  const payload = {
    name: val('oltRegName'),
    host: val('oltRegHost'),
    vendor: val('oltRegVendor'),
    model: val('oltRegModel'),
    username: val('oltRegUsername'),
    password: document.getElementById('oltRegPassword')?.value || '',
    connector_id: val('oltRegConnector'),
    notes: val('oltRegNotes'),
    active: !!document.getElementById('oltRegActive')?.checked,
  };
  if (id) payload.id = Number(id);

  if (!payload.name) { showToast('Informe o nome da OLT.', true); return; }
  if (!payload.host) { showToast('Informe o IP da OLT.', true); return; }

  try {
    await api('/api/olt/registry', { method: 'POST', body: JSON.stringify(payload) });
    showToast(id ? 'OLT atualizada.' : 'OLT cadastrada.');
    oltRegResetForm();
    await _oltRegLoad();
  } catch (err) {
    showToast(`Nao foi possivel salvar: ${err?.message || err}`, true);
  }
}

async function oltRegDelete(id) {
  const olt = _oltRegRows.find(o => Number(o.id) === Number(id));
  if (!olt) return;
  const ok = await showConfirm({
    eyebrow: 'Remover OLT',
    title: `${olt.name} (${olt.host})`,
    msg: 'As ONUs ja coletadas dela continuam no inventario. Apenas o cadastro sai.',
    label: 'Remover',
    danger: true,
  });
  if (!ok) return;
  try {
    await api(`/api/olt/registry/${Number(id)}`, { method: 'DELETE' });
    showToast('OLT removida.');
    if (String(document.getElementById('oltRegId')?.value || '') === String(id)) oltRegResetForm();
    await _oltRegLoad();
  } catch (err) {
    showToast(`Nao foi possivel remover: ${err?.message || err}`, true);
  }
}

function bindDeployOlt() {
  document.getElementById('btnOltRegSave')?.addEventListener('click', oltRegSave);
  document.getElementById('btnOltRegCancel')?.addEventListener('click', oltRegResetForm);
  document.getElementById('btnOltRegRefresh')?.addEventListener('click', loadDeployOlt);
  document.getElementById('oltRegSearch')?.addEventListener('input', _oltRegApplyFilter);
}
