function startScan() {
  const base = _scanPayloadBase();
  if (!base) return;
  _runWsScan({
    ...base,
    snapshot:   document.getElementById('scanSnapshot')?.checked  || false,
    imgbb:      document.getElementById('scanImgbb')?.checked     || false,
    olt_enrich: document.getElementById('scanOltEnrich')?.checked || false,
  });
}

function appendLog(el, msg, cls = '') {
  el.innerHTML += `<span class="log-${cls}">${esc(msg)}</span>\n`;
  el.scrollTop = el.scrollHeight;
}

//  Download autenticado 
async function downloadWithAuth(path, filename) {
  showToast('Preparando download');
  const res = await api(path);
  if (!res || !res.ok) {
    const err = await res?.json().catch(() => ({}));
    showToast(err?.detail || 'Arquivo nao encontrado', true);
    return;
  }
  const blob = await res.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

//  Utilidades 
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function statusBadge(status) {
  if (!status) return '<span class="badge badge-gray"></span>';
  const s = String(status).toLowerCase();
  if (s === 'ok' || s === 'online' || s === 'acessivel') return '<span class="badge badge-green">Online</span>';
  if (s === 'fail' || s === 'offline' || s === 'erro') return '<span class="badge badge-red">Offline</span>';
  if (s === 'warn' || s === 'warning') return '<span class="badge badge-amber">Atencao</span>';
  return `<span class="badge badge-gray">${esc(status)}</span>`;
}

function pingBadge(ms) {
  if (ms == null) return '<span class="text-muted"></span>';
  const color = ms < 50 ? 'badge-green' : ms < 200 ? 'badge-amber' : 'badge-red';
  return `<span class="badge ${color}">${ms}ms</span>`;
}

function openCamera(ip) {
  window.open(`http://${ip}`, '_blank');
}

//  Filtros inline 
function filterTable(inputId, tableBodyId) {
  const q = document.getElementById(inputId)?.value.toLowerCase() || '';
  document.querySelectorAll(`#${tableBodyId} tr`).forEach(tr => {
    tr.style.display = tr.textContent.toLowerCase().includes(q) ? '' : 'none';
  });
}

//  Nav groups (accordion) 
function initNavGroups() {
  document.querySelectorAll('.nav-group-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const group = btn.closest('.nav-group');
      group.classList.toggle('open');
    });
  });
}

//  Eventos 