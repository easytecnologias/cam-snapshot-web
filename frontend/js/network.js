function updateOltOriginUi() {
  const sel = document.getElementById('oltConnector');
  const site = (document.getElementById('oltSite')?.value || document.getElementById('oltFilterSite')?.value || '').trim();
  const context = _networkContextForSite(site, sel?.value || '');
  const origin = context.connectorId ? 'connector' : 'local';
  const originEl = document.getElementById('oltOrigin');
  if (originEl) originEl.value = origin;
  const status = document.getElementById('oltConnectorStatus');
  if (sel) sel.disabled = false;

  if (origin !== 'connector') {
    if (status) status.innerHTML = 'Sem conector para este site: usando servidor local/VPN ja roteada.';
    return;
  }

  if (status) {
    status.innerHTML = context.online
      ? `<span style="color:var(--primary);font-weight:700">Online</span> -- ${esc(_connectorLabel(context.connector))}${context.hasTunnel ? ' -- VPN configurada para coleta real' : ' -- configure a VPN antes da coleta da OLT'}`
      : `<span style="color:var(--danger);font-weight:700">Offline</span> -- conector indisponivel.`;
  }
  const siteEl = document.getElementById('oltSite');
  if (context.connector?.site && siteEl && !siteEl.value.trim()) siteEl.value = context.connector.site;
}

function openOltCollectModal() {
  document.getElementById('modalOltCollect')?.classList.remove('hidden');
  const siteEl = document.getElementById('oltSite');
  const currentSite = document.getElementById('oltFilterSite')?.value || '';
  if (siteEl && currentSite && !siteEl.value.trim()) siteEl.value = currentSite;
  refreshOltConnectors().finally(updateOltOriginUi);
  lucide.createIcons();
}

async function oltCollect() {
  const ip   = document.getElementById('oltIp')?.value.trim();
  const user = document.getElementById('oltUser')?.value.trim() || 'admin';
  const pass = document.getElementById('oltPassword')?.value;
  const site = document.getElementById('oltSite')?.value.trim();
  const pon  = document.getElementById('oltPon')?.value || 'all';
  const model= document.getElementById('oltModel')?.value || '8820i';
  const reuse= document.getElementById('oltReuse')?.checked || false;
  const context = _networkContextForSite(site, document.getElementById('oltConnector')?.value || '');
  const origin = context.connectorId ? 'connector' : 'local';
  const connectorId = context.connectorId;

  if (!ip) { showToast('Informe o IP da OLT', true); return; }
  if (origin === 'connector') {
    if (!context.online) {
      showToast('O conector selecionado esta offline.', true);
      return;
    }
    if (!context.hasTunnel) {
      showToast('Prepare a VPN do conector antes de coletar OLT remota.', true);
      return;
    }
  }

  // Abre terminal
  const term = document.getElementById('oltTerminal');
  const cons = document.getElementById('oltConsole');
  if (term) term.classList.remove('hidden');
  if (cons) cons.innerHTML = '';
  setText('oltTermTitle', `OLT  ${ip}`);
  setText('oltTermFooter', 'Iniciando');
  lucide.createIcons();

  // Conecta no WS de console (mantem vivo + recebe acks)
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  let ws = null;
  try {
    ws = new WebSocket(`${wsProto}://${location.host}/ws/olt-console`);
    ws.onopen = () => {};
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data);
        if (m.type === 'status' || m.type === 'log') {
          oltConsoleLog(m.message, 'info');
        }
      } catch {}
    };
  } catch {}

  // Sequencia de logs animados (refletem o que o servico realmente faz)
  const ponLabel = pon === 'all' ? 'TODAS as PONs' : `PON ${pon}`;
  const steps = [
    [0,    'info', `[INFO] Conectando em ${ip}${site ? ` [site: ${site}]` : ''}${origin === 'connector' ? ' via VPN do conector' : ''}...`],
    [600,  'info', `[INFO] Autenticando como "${user}"...`],
    [1100, 'info', `[INFO] Varredura automatica de PONs usando 'onu status gpon <pon>'`],
    [1800, 'info', `[INFO] Descobrindo PONs configuradas em ${ip}...`],
    [2500, 'info', pon === 'all'
      ? '[INFO] PON 1 encontrada (Configured ONUs).'
      : `[INFO] PON ${pon} encontrada (Configured ONUs).`],
  ];
  if (pon === 'all') {
    for (let p = 2; p <= 8; p++) {
      steps.push([2500 + p * 200, 'info', `[INFO] PON ${p} encontrada (Configured ONUs).`]);
    }
  }
  steps.push([3200, 'info', `[INFO] Lendo ONUs da ${ponLabel} com 'onu status gpon'...`]);
  steps.push([3800, 'info', `[INFO] Coletando MACs de ${ponLabel}...`]);

  const timers = steps.map(([delay, cls, msg]) =>
    setTimeout(() => oltConsoleLog(msg, cls), delay)
  );

  // Ticker "ainda trabalhando"
  let tick = 0;
  const tickTimer = setInterval(() => {
    tick++;
    setText('oltTermFooter', `Coletando via SSH ${tick}s`);
  }, 1000);

  const payload = {
    olt_ip: ip,
    user,
    password: pass,
    pon,
    olt_model: model,
    reuse_json: reuse,
    scan_origin: origin,
    connector_id: origin === 'connector' ? connectorId : '',
    remote_connector_id: origin === 'connector' ? connectorId : '',
    ...(site && { site }),
  };

  try {
    const res = await api('/api/olt/collect-macs', { method: 'POST', body: JSON.stringify(payload), skipLogout: true });
    timers.forEach(t => clearTimeout(t));
    clearInterval(tickTimer);
    if (ws) { try { ws.close(); } catch {} }

    if (res?.ok) {
      const data = await res.json();
      const total = data?.count ?? data?.total ?? (Array.isArray(data?.rows) ? data.rows.length : null) ?? '?';
      oltConsoleLog('[INFO] Salvando base OLT no banco...', 'info');
      oltConsoleLog(`[OK] Coleta concluida! Total: ${total} registros.`, 'ok');
      setText('oltTermFooter', `Concluido  ${total} registros`);
      loadOlt();
    } else {
      const err = await res?.json().catch(() => ({}));
      oltConsoleLog('[ERRO] ' + (err?.detail || 'Falha na coleta.'), 'err');
      setText('oltTermFooter', 'Erro na coleta.');
    }
  } catch (e) {
    timers.forEach(t => clearTimeout(t));
    clearInterval(tickTimer);
    if (ws) { try { ws.close(); } catch {} }
    oltConsoleLog('[ERRO] ' + (e.message || 'Erro de conexao.'), 'err');
    setText('oltTermFooter', 'Erro.');
  }
}

async function loadSwitch() {
  const data = await apiJson('/api/switch/rows');
  const rows = data?.rows || data || [];
  const tbody = document.getElementById('switchTable');
  if (!rows.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="4">Nenhum dado. Execute a coleta.</td></tr>';
    setText('switchFooter', '0 registros');
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td class="text-muted">${esc(r.port || '')}</td>
      <td class="monospace">${esc(r.mac || '')}</td>
      <td class="text-muted">${esc(r.vlan || '')}</td>
      <td>${esc(r.camera_name || r.camera || '')}</td>
    </tr>`).join('');
  setText('switchFooter', `${rows.length} registro${rows.length !== 1 ? 's' : ''}`);
}

//  Backup 
async function loadBackup() {
  const data = await apiJson('/api/backup/status');
  const el = document.getElementById('backupStatus');
  if (!data) { el.textContent = 'Nao foi possivel carregar o status.'; return; }
  el.innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px">
      <div><strong>Tamanho do banco:</strong> ${esc(data.db_size || '')}</div>
      <div><strong>Cameras:</strong> ${esc(String(data.camera_count ?? ''))}</div>
      <div><strong>DVRs:</strong> ${esc(String(data.dvr_count ?? ''))}</div>
      <div><strong>NVRs:</strong> ${esc(String(data.nvr_count ?? ''))}</div>
      <div><strong>Ultimo backup:</strong> ${esc(data.last_backup || 'Nunca')}</div>
    </div>`;
}

//  Rede 
async function loadNetDevices() {
  const data = await apiJson('/api/network/devices');
  const devices = data?.devices || data || [];
  const tbody = document.getElementById('netDevicesTable');
  if (!devices.length) {
    tbody.innerHTML = '<tr class="empty-row"><td colspan="5">Nenhum dispositivo cadastrado.</td></tr>';
    return;
  }
  tbody.innerHTML = devices.map(d => `
    <tr>
      <td><strong>${esc(d.name || d.hostname || '')}</strong></td>
      <td class="monospace">${esc(d.ip || '')}</td>
      <td class="text-muted">${esc(d.type || '')}</td>
      <td>${statusBadge(d.status)}</td>
      <td></td>
    </tr>`).join('');
}

function netToolSetLog(html, status = '') {
  const log = document.getElementById('netToolLog');
  const statusEl = document.getElementById('netToolStatus');
  if (log) log.innerHTML = html || 'Nenhum resultado.';
  if (statusEl && status) statusEl.textContent = status;
}

function netToolText(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function netToolFormatLocal(data) {
  const result = data?.result || {};
  const items = result.items || [];
  if (Array.isArray(items) && items.length) {
    return items.map(item => {
      const ok = item.online === true || item.open === true || item.ok === true || (Number(item.status_code || 0) > 0 && Number(item.status_code || 0) < 500);
      const klass = ok ? 'network-tool-line-ok' : 'network-tool-line-fail';
      const parts = [
        ok ? 'OK' : 'FAIL',
        item.target || item.url || '',
        item.method ? `via ${item.method}` : '',
        item.port ? `porta ${item.port}` : '',
        item.status_code ? `HTTP ${item.status_code}` : '',
        item.rtt_ms ? `${item.rtt_ms}ms` : item.elapsed_ms ? `${item.elapsed_ms}ms` : '',
        item.server ? `server=${item.server}` : '',
        item.addresses ? `addr=${item.addresses.join(', ')}` : '',
        !ok && item.error ? `erro=${item.error}` : '',
      ].filter(Boolean).join(' ');
      return `<div class="${klass}">${esc(parts)}</div>`;
    }).join('');
  }
  if (result.stdout || result.stderr || result.error) {
    return `<div class="network-tool-line-muted">${esc([result.stdout, result.stderr, result.error].filter(Boolean).join('\n'))}</div>`;
  }
  return `<div>${esc(JSON.stringify(data, null, 2))}</div>`;
}

function netToolFormatJob(job) {
  const result = job?.result || {};
  const routerosPing = result.routeros_ping || result.result?.routeros_ping || '';
  const inventory = result.inventory || result.result?.inventory || null;
  if (routerosPing) {
    return routerosPing.split(/[;,]/).filter(Boolean).map(item => {
      const separator = item.includes('=') ? '=' : ':';
      const [target, ok] = item.split(separator);
      const normalized = String(ok || '').toLowerCase();
      const success = normalized === 'true' || normalized === '1';
      return `<div class="${success ? 'network-tool-line-ok' : 'network-tool-line-fail'}">${success ? 'OK' : 'FAIL'} ${esc(target || item)}</div>`;
    }).join('');
  }
  if (inventory) {
    return [
      `<div class="network-tool-line-ok">DHCP leases: ${esc(inventory.dhcp_leases ?? 0)}</div>`,
      `<div class="network-tool-line-ok">ARP entries: ${esc(inventory.arp_entries ?? 0)}</div>`,
      `<div class="network-tool-line-ok">Neighbors: ${esc(inventory.neighbors ?? 0)}</div>`,
    ].join('');
  }
  if (job?.error) return `<div class="network-tool-line-fail">${esc(job.error)}</div>`;
  return `<div class="network-tool-line-muted">Aguardando MikroTik.</div>`;
}

async function pollNetToolRemoteJob(connectorId, jobId) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 2500 : 5000));
    const data = await apiJson(`/api/connectors/${encodeURIComponent(connectorId)}/jobs`);
    const job = (data?.jobs || []).find(item => String(item.id || '') === String(jobId || ''));
    if (!job) continue;
    if (job.status === 'done' || job.status === 'failed') {
      netToolSetLog(netToolFormatJob(job), job.status === 'done' ? 'Job concluido.' : 'Job falhou.');
      return;
    }
    netToolSetLog(`<span class="network-tool-line-muted">Job ${esc(job.status || 'queued')} no MikroTik. Aguardando resultado...</span>`, 'Aguardando MikroTik...');
  }
  netToolSetLog('<span class="network-tool-line-muted">Job enviado, mas ainda sem resultado. Atualize ou execute novamente para consultar.</span>', 'Aguardando resultado.');
}

function netToolSelectedConnector() {
  return document.getElementById('netToolConnector')?.value || '';
}

async function loadNetOperate() {
  const data = await apiJson('/api/connectors');
  _connectors = data?.connectors || _connectors || [];
  const sel = document.getElementById('netToolConnector');
  if (sel) {
    sel.innerHTML = _connectors.map(row => `<option value="${esc(row.id)}">${esc(row.name || row.id)} - ${esc(row.site || '')}</option>`).join('');
  }
  updateNetToolFormState();
  lucide.createIcons();
}

function updateNetToolFormState() {
  const origin = document.getElementById('netToolOrigin')?.value || 'local';
  const test = document.getElementById('netToolTest')?.value || 'ping';
  const conn = document.getElementById('netToolConnector');
  const ports = document.getElementById('netToolPorts');
  const targets = document.getElementById('netToolTargets');
  if (conn) conn.disabled = origin !== 'connector';
  if (ports) ports.disabled = !['tcp', 'port_scan', 'http'].includes(test);
  if (targets) {
    targets.disabled = test === 'lan_inventory';
    if (test === 'lan_inventory') targets.placeholder = 'A coleta LAN usa DHCP, ARP e Neighbors do MikroTik selecionado.';
    else targets.placeholder = '10.10.9.20, 192.168.20.1-192.168.20.20 ou 192.168.20.0/24';
  }
}

async function runNetTool(e) {
  e?.preventDefault();
  const origin = document.getElementById('netToolOrigin')?.value || 'local';
  const test = document.getElementById('netToolTest')?.value || 'ping';
  const targetsRaw = document.getElementById('netToolTargets')?.value.trim() || '';
  const ports = document.getElementById('netToolPorts')?.value.trim() || '';
  const timeout = Number(document.getElementById('netToolTimeout')?.value || 3);
  const concurrency = Number(document.getElementById('netToolConcurrency')?.value || 64);
  const btn = document.getElementById('btnRunNetTool');

  if (btn) { btn.disabled = true; btn.innerHTML = '<i data-lucide="loader"></i> Executando'; lucide.createIcons(); }
  netToolSetLog('<span class="network-tool-line-muted">Executando teste...</span>', 'Executando...');
  try {
    if (origin === 'connector') {
      const connectorId = netToolSelectedConnector();
      if (!connectorId) throw new Error('Selecione um conector MikroTik.');
      if (test !== 'ping' && test !== 'lan_inventory') {
        throw new Error('No MikroTik, esta primeira versao executa Ping e Coletar LAN. Para TCP/HTTP/DNS/Traceroute use Servidor local/VPN.');
      }
      const type = test === 'lan_inventory' ? 'lan_inventory' : 'ping_many';
      const targets = targetsRaw.split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
      if (type === 'ping_many' && !targets.length) throw new Error('Informe ao menos um alvo para ping.');
      const res = await api('/api/connectors/jobs', {
        method: 'POST',
        body: JSON.stringify({ connector_id: connectorId, type, payload: type === 'ping_many' ? { targets } : {} }),
      });
      const body = await res?.json().catch(() => ({}));
      if (!res?.ok || body?.ok === false) throw new Error(body?.detail || 'Erro ao criar job remoto.');
      netToolSetLog(`Job ${esc(type)} enviado para o MikroTik.\n\nAguardando o conector executar no proximo ciclo.\nID: ${esc(body?.job?.id || '-')}`, 'Job remoto enviado.');
      await loadConnectorJobs(connectorId);
      pollNetToolRemoteJob(connectorId, body?.job?.id || '');
      return;
    }

    if (!targetsRaw) throw new Error('Informe ao menos um alvo.');
    const res = await api('/api/network/tools/run', {
      method: 'POST',
      body: JSON.stringify({ test, targets: targetsRaw, ports, timeout, concurrency }),
    });
    const body = await res?.json().catch(() => ({}));
    if (!res?.ok || body?.ok === false) throw new Error(body?.detail || 'Falha ao executar teste.');
    netToolSetLog(netToolFormatLocal(body), `${body.count || 0} alvo(s) testado(s).`);
  } catch (err) {
    netToolSetLog(`<span class="network-tool-line-fail">${esc(err?.message || err)}</span>`, 'Falha no teste.');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="play"></i> Executar'; lucide.createIcons(); }
  }
}

//  Implantacao
let _deployCurrentId = '';
let _deployConnectors = [];
let _deploySites = [];
let _deployAvailableRecorders = [];
let _deployRecorderListTimer = null;
let _deployPullTargetIp = ''; // IP achado no Mikrotik, so pra conectar/puxar -- nao vai no campo visivel
let _deployConfirmedCameraIp = ''; // ultimo IP confirmado por um pull bem sucedido (usado como alvo de conexao)
const DEPLOY_LOCAL_ORIGIN = '__local__';

function deploymentPreferredInventoryMode() {
  try {
    const value = localStorage.getItem('so_deployment_inventory_mode') || 'basic';
    return ['basic', 'olt', 'switch'].includes(value) ? value : 'basic';
  } catch { return 'basic'; }
}

function deploymentApplyPreferredInventoryMode() {
  const value = deploymentPreferredInventoryMode();
  document.querySelectorAll('.deployment-inventory-mode').forEach(select => { select.value = value; });
}

function deploymentSetPreferredInventoryMode(value) {
  const mode = ['basic', 'olt', 'switch'].includes(value) ? value : 'basic';
  try { localStorage.setItem('so_deployment_inventory_mode', mode); } catch {}
  document.querySelectorAll('.deployment-inventory-mode').forEach(select => { select.value = mode; });
}

function deployPayload() {
  return {
    id: _deployCurrentId || '',
    connector_id: deploySelectedConnectorId(),
    site: document.getElementById('deploySite')?.value.trim() || '',
    camera_mac: document.getElementById('deployCameraMac')?.value.trim() || '',
    camera_ip: document.getElementById('deployCameraIp')?.value.trim() || '',
    camera_title: document.getElementById('deployCameraTitle')?.value.trim() || '',
    camera_model: document.getElementById('deployCameraModel')?.value.trim() || '',
    camera_manufacturer: document.getElementById('deployCameraManufacturer')?.value.trim() || '',
    location: document.getElementById('deployCameraLocation')?.value.trim() || '',
    camera_user: document.getElementById('deployCameraUser')?.value.trim() || '',
    camera_password: document.getElementById('deployCameraPassword')?.value || '',
    inventory_mode: document.getElementById('deployInventoryMode')?.value || 'basic',
    recorder_type: document.getElementById('deployRecorderType')?.value || '',
    recorder_host: document.getElementById('deployRecorderHost')?.value.trim() || '',
    recorder_user: document.getElementById('deployRecorderUser')?.value.trim() || '',
    recorder_password: document.getElementById('deployRecorderPassword')?.value || '',
    recorder_channel: document.getElementById('deployRecorderChannel')?.value.trim() || '',
    recorder_camera_ip: document.getElementById('deployRecorderCameraIp')?.value.trim() || document.getElementById('deployCameraIp')?.value.trim() || '',
    recorder_title: document.getElementById('deployRecorderTitle')?.value.trim() || '',
  };
}

function deploySyncRecorderCameraIp() {
  const el = document.getElementById('deployRecorderCameraIp');
  if (!el) return;
  const ip = document.getElementById('deployCameraIp')?.value.trim() || _deployConfirmedCameraIp || _deployPullTargetIp || '';
  el.value = ip;
}

function deployConnectorKey(conn) {
  return String(conn?.id || conn?.connector_id || '');
}

function deployConnectorRawValue() {
  return document.getElementById('deployConnector')?.value || '';
}

function deployIsLocalOrigin() {
  return deployConnectorRawValue() === DEPLOY_LOCAL_ORIGIN;
}

function deploySelectedConnectorId() {
  const raw = deployConnectorRawValue();
  return raw && raw !== DEPLOY_LOCAL_ORIGIN ? raw : '';
}

function deployConnectorSite(conn) {
  return String(conn?.site || conn?.client || '').trim();
}

function deployConnectorOnline(conn) {
  return _connectorIsOnline(conn);
}

function deployConnectorVpnReady(conn) {
  return _connectorHasTunnel(conn);
}

function deployConnectorLabel(conn) {
  return _connectorLabel(conn);
}

function deployOriginReady() {
  if (deployIsLocalOrigin()) return true;
  const conn = deploySelectedConnector();
  return Boolean(conn && deployConnectorOnline(conn) && deployConnectorVpnReady(conn));
}

function deployApplyOriginFields() {
  const site = document.getElementById('deploySite');
  const raw = deployConnectorRawValue();
  const conn = deploySelectedConnector();
  if (!site) return;
  site.disabled = !raw;
  site.readOnly = false;
  if (!raw) site.value = '';
  if (conn && !deployIsLocalOrigin()) site.value = deployConnectorSite(conn);
}

function deploySelectedConnector() {
  const id = deploySelectedConnectorId();
  return _deployConnectors.find(c => deployConnectorKey(c) === id) || null;
}

function deployRenderConnectorStatus() {
  const box = document.getElementById('deployConnectorStatus');
  if (!box) return;
  const raw = deployConnectorRawValue();
  if (!raw) {
    box.innerHTML = 'Escolha Local/VPN do servidor ou um conector online com VPN. Os dados do CFTV ficam bloqueados ate definir a origem.';
    box.classList.add('error');
    return;
  }
  if (deployIsLocalOrigin()) {
    box.innerHTML = '<b style="color:var(--primary)">● Local / VPN do servidor</b> -- informe o site/local e use apenas redes acessiveis pelo servidor.';
    box.classList.remove('error');
    return;
  }
  const conn = deploySelectedConnector();
  if (!conn) {
    box.innerHTML = 'Conector nao encontrado. Atualize a lista.';
    box.classList.add('error');
    return;
  }
  const online = deployConnectorOnline(conn);
  const vpnReady = deployConnectorVpnReady(conn);
  const inv = conn.inventory || {};
  const counts = [
    inv.dhcp_leases != null ? `${esc(inv.dhcp_leases)} DHCP` : '',
    inv.arp_entries != null ? `${esc(inv.arp_entries)} ARP` : '',
    inv.neighbors != null ? `${esc(inv.neighbors)} vizinhos` : '',
  ].filter(Boolean).join(' / ');
  const lastSeen = conn.last_seen ? esc(formatDateTimeShort(conn.last_seen)) : 'nunca';
  box.classList.toggle('error', !online || !vpnReady);
  box.innerHTML = `<b style="color:${online && vpnReady ? 'var(--primary)' : 'var(--danger)'}">${online ? '● Online' : '○ Offline'}</b> -- ${esc(deployConnectorLabel(conn))} - ${vpnReady ? 'VPN pronta' : 'sem VPN configurada'} - Ultimo sinal: ${lastSeen} - ${counts || 'sem inventario recebido ainda'}`;
}
