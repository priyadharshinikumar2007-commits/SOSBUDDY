'use strict';
const DEFAULT_API = 'https://sos-backend-production-0e25.up.railway.app';
const onLocalhost = /^https?:$/.test(location.protocol) && /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
const savedApi = (() => { try { return sessionStorage.getItem('sosbuddy-api'); } catch (_) { return null; } })();
const API_BASE = (new URLSearchParams(location.search).get('api') || savedApi || (onLocalhost ? location.origin : DEFAULT_API)).replace(/\/$/, '');
const SESSION_KEY = 'sosbuddy-security-session';
const ROLE_NAMES = { Police: 'Police Responder', NGO: 'NGO Responder', Helper: 'Verified Helper' };
const ROLE_NOTES = {
  Police: 'Police: receive security alerts instantly, view the citizen\'s saved security profile and update response status.',
  NGO: 'NGO: receive the same live alerts and update response status.',
  Helper: 'Helper: receive live alerts. Incident history and access pages are not enabled for this role.'
};

let incidents = [];
let auth = null, currentRole = null, currentEmail = '';
let selectedIncident = null;
let streamAbort = null, reconnectTimer = null;
let seconds = 15, timerInterval = null;
let audioCtx = null;

const $ = id => document.getElementById(id);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtTime = iso => { const d = new Date(iso); return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }); };
const shortTime = iso => { const d = new Date(iso); return isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }); };
const val = v => (v === undefined || v === null || v === '') ? 'Not provided' : v;
const initials = n => (n || '').split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('') || 'SR';

/* ---------- status helpers ---------- */
const isNew = s => s === 'NEW' || s === 'WAITING FOR RESPONSE';
function statusLabel(s) { return isNew(s) ? 'Awaiting response' : s === 'RESOLVED' ? 'Resolved' : 'Accepted'; }
function statusClass(s) { return isNew(s) ? '' : 'accepted'; }

/* ---------- audio ---------- */
function updateSoundLabel() {
  const el = $('soundState'); if (!el) return;
  el.textContent = (audioCtx && audioCtx.state === 'running') ? 'Live alert channel · sound on' : 'Click anywhere to enable alert sound';
}
function ensureAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().then(updateSoundLabel);
    updateSoundLabel();
  } catch (_) { /* audio unavailable */ }
}
['click', 'keydown', 'touchstart'].forEach(ev => document.addEventListener(ev, ensureAudio));
function playSiren() {
  if (!audioCtx || audioCtx.state !== 'running') return;
  const t0 = audioCtx.currentTime;
  const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
  osc.type = 'sawtooth';
  for (let i = 0; i < 3; i++) {
    osc.frequency.setValueAtTime(800, t0 + i * 0.8);
    osc.frequency.linearRampToValueAtTime(1200, t0 + i * 0.8 + 0.4);
    osc.frequency.linearRampToValueAtTime(800, t0 + i * 0.8 + 0.8);
  }
  gain.gain.setValueAtTime(0.5, t0);
  gain.gain.linearRampToValueAtTime(0.0001, t0 + 2.4);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start(t0); osc.stop(t0 + 2.4);
}

/* ---------- api ---------- */
async function api(path, opts = {}) {
  const r = await fetch(API_BASE + path, { ...opts, headers: { ...(opts.headers || {}), Authorization: auth } });
  if (r.status === 401) { const e = new Error('unauthorized'); e.code = 401; throw e; }
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}
async function refreshIncidents() {
  const data = await api('/api/security-incidents');
  incidents = data.incidents || [];
  return data;
}
async function setStatus(id, status) {
  try {
    const data = await api('/api/security-incidents/' + encodeURIComponent(id), {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status })
    });
    upsert(data.incident);
    logActivity(status === 'RESOLVED' ? 'Incident resolved' : 'Response accepted', `${data.incident.name} · ${data.incident.incident_id}`, 'green');
    render();
    return true;
  } catch (e) {
    if (e.code === 401) return sessionExpired();
    showToast('Could not update the incident: ' + e.message);
    return false;
  }
}
function upsert(inc) {
  const i = incidents.findIndex(x => x.incident_id === inc.incident_id);
  if (i === -1) incidents.unshift(inc); else incidents[i] = inc;
}

/* ---------- live stream ---------- */
function setConn(state, text) {
  $('connText').textContent = text;
  $('connDot').style.background = state === 'ok' ? '#20a477' : state === 'err' ? '#c83f50' : '#b7791f';
}
async function startStream() {
  stopStream();
  const ctrl = new AbortController(); streamAbort = ctrl;
  try {
    const resp = await fetch(API_BASE + '/api/security-stream', { headers: { Authorization: auth }, signal: ctrl.signal });
    if (resp.status === 401) return sessionExpired();
    if (!resp.ok || !resp.body) throw new Error('stream HTTP ' + resp.status);
    setConn('ok', 'Live');
    const reader = resp.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) !== -1) { const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2); handleChunk(chunk); }
    }
    throw new Error('stream closed');
  } catch (e) {
    if (ctrl.signal.aborted || streamAbort !== ctrl) return;
    setConn('err', 'Reconnecting…');
    reconnectTimer = setTimeout(async () => {
      if (!auth) return;
      try { await refreshIncidents(); render(); } catch (err) { if (err.code === 401) return sessionExpired(); }
      startStream();
    }, 3000);
  }
}
function stopStream() {
  if (streamAbort) { streamAbort.abort(); streamAbort = null; }
  clearTimeout(reconnectTimer);
}
function handleChunk(chunk) {
  let event = 'message', data = '';
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event: ')) event = line.slice(7).trim();
    else if (line.startsWith('data: ')) data += line.slice(6);
  }
  if (!data) return;
  let inc; try { inc = JSON.parse(data); } catch { return; }
  if (event === 'security-incident' && inc.incident_id) {
    if (incidents.some(i => i.incident_id === inc.incident_id)) return;
    upsert(inc);
    logActivity('New security emergency', `${inc.name} · ${inc.incident_id}`, 'red');
    render();
    playSiren();
    showDetails(inc.incident_id, true);
  } else if (event === 'security-incident-updated' && inc.incident_id) {
    const prev = incidents.find(i => i.incident_id === inc.incident_id);
    upsert(inc);
    if (prev && prev.status !== inc.status) logActivity('Status: ' + statusLabel(inc.status), `${inc.name} · ${inc.incident_id}`, 'blue');
    render();
    if (selectedIncident && selectedIncident.incident_id === inc.incident_id) showDetails(inc.incident_id, false);
  }
}

/* ---------- rendering ---------- */
function updateStats() {
  const active = incidents.filter(i => i.status !== 'RESOLVED').length;
  const pending = incidents.filter(i => isNew(i.status)).length;
  const accepted = incidents.filter(i => i.status === 'ACKNOWLEDGED' || i.status === 'IN PROGRESS').length;
  const resolved = incidents.filter(i => i.status === 'RESOLVED').length;
  const pct = active ? Math.round(accepted / active * 100) : 0;
  $('activeCount').textContent = active; $('pendingCount').textContent = pending;
  $('acceptedCount').textContent = accepted; $('resolvedCount').textContent = resolved;
  $('navCount').textContent = active; $('liveTotal').textContent = incidents.length + (incidents.length === 1 ? ' incident' : ' incidents');
  $('legendAccepted').textContent = accepted; $('legendPending').textContent = pending;
  $('responsePercent').textContent = pct + '%';
  document.querySelector('.donut').style.background = `conic-gradient(var(--green) 0 ${pct}%,#e3e9f0 ${pct}% 100%)`;
}
function renderAlerts() {
  const list = incidents.filter(i => i.status !== 'RESOLVED');
  $('alertList').innerHTML = list.map(i => `<article class="alert-card ${isNew(i.status) ? 'critical' : 'accepted'}"><div class="alert-avatar">${isNew(i.status) ? '!' : '⌖'}</div><div class="alert-main"><div class="alert-title"><b>${esc(i.name || 'Unknown')}</b><span class="priority ${isNew(i.status) ? '' : 'accepted'}">${isNew(i.status) ? 'NEW ALERT' : 'ACCEPTED'}</span></div><div class="alert-meta">Security Emergency · ${esc(i.address || 'Address not provided')}</div><div class="alert-meta">◷ ${esc(fmtTime(i.created_at))} &nbsp; · &nbsp; ${esc(i.incident_id)}</div><div class="alert-actions"><button class="small-btn" data-details="${esc(i.incident_id)}">View details</button>${isNew(i.status) ? `<button class="small-btn accept" data-accept="${esc(i.incident_id)}">✓ Accept emergency</button>` : '<button class="small-btn" disabled>Assigned</button>'}</div></div></article>`).join('')
    || '<div class="empty-state">No active security emergencies. New alerts appear here instantly.</div>';
}
function renderRows() {
  const q = $('incidentSearch').value.toLowerCase(), f = $('statusFilter').value;
  const list = incidents.filter(i => (`${i.name} ${i.address} ${i.incident_id}`).toLowerCase().includes(q) && (f === 'All' || statusLabel(i.status) === f));
  $('incidentRows').innerHTML = list.map(i => `<tr><td><div class="person-cell"><b>${esc(i.name || 'Unknown')}</b><small>${esc(i.incident_id)} · Security Emergency</small></div></td><td>${esc(i.address || '—')}</td><td>${esc(fmtTime(i.created_at))}</td><td><span class="status-pill ${statusClass(i.status)}">${esc(statusLabel(i.status))}</span></td><td><button class="table-action" data-details="${esc(i.incident_id)}">View / respond</button></td></tr>`).join('')
    || '<tr><td colspan="5">No matching incidents.</td></tr>';
}
function renderHistory() {
  const done = incidents.filter(i => i.status === 'RESOLVED');
  $('historyCards').innerHTML = done.map(i => `<article class="history-card"><span class="history-check">✓</span><div><b>${esc(i.name || 'Unknown')} · ${esc(i.incident_id)}</b><small>Resolved · ${esc(i.address || 'Address not provided')}</small></div><time>${esc(shortTime(i.updated_at))}</time></article>`).join('')
    || '<div class="empty-state">No resolved incidents yet.</div>';
}
/* ---------- live map ---------- */
const DEFAULT_CENTER = [13.0827, 80.2707];
let map = null, markerLayer = null, mapKey = '';
function initMap() {
  if (map || typeof L === 'undefined' || !$('liveMap')) return;
  map = L.map('liveMap').setView(DEFAULT_CENTER, 11);
  let tileErrors = 0, usingFallback = false;
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}';
  const primary = L.tileLayer(ESRI, { maxZoom:19, attribution:'Tiles © Esri — Esri, HERE, Garmin, OpenStreetMap contributors' }).addTo(map);
  primary.on('tileerror', () => {
    if (usingFallback || ++tileErrors < 4) return;
    usingFallback = true; map.removeLayer(primary);
    L.tileLayer('https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', { maxZoom:19, subdomains:'abc', attribution:'© OpenStreetMap contributors, tiles by OpenStreetMap France' }).addTo(map);
  });
  markerLayer = L.layerGroup().addTo(map);
}
function renderMap() {
  initMap();
  if (!map) return;
  markerLayer.clearLayers();
  const pts = [];
  incidents.filter(i => i.status !== 'RESOLVED' && i.latitude != null && i.longitude != null).forEach(i => {
    const ll = [i.latitude, i.longitude]; pts.push(ll);
    L.marker(ll, { icon: L.divIcon({ className: '', html: `<div class="inc-pin ${isNew(i.status) ? '' : 'accepted'}">!</div>`, iconSize: [26, 26], iconAnchor: [13, 13] }) })
      .bindPopup(`<b>${esc(i.name || 'Unknown')}</b><br>${esc(i.address || 'Address not provided')}<br><small>${esc(i.incident_id)} · ${esc(statusLabel(i.status))}</small>`)
      .addTo(markerLayer);
  });
  const key = pts.map(p => p.join(',')).join('|');
  if (key !== mapKey) {
    mapKey = key;
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.3), { maxZoom: 15 }); else map.setView(DEFAULT_CENTER, 11);
  }
}
function render() {
  updateStats(); renderAlerts(); renderRows(); renderHistory(); renderMap();
  const name = ROLE_NAMES[currentRole] || currentRole;
  $('userRoleName').textContent = name; $('signedRole').textContent = currentRole.toUpperCase() + ' ACCESS';
  $('signedEmail').textContent = currentEmail; $('accessRole').textContent = name; $('accessRoleValue').textContent = currentRole;
  $('userAvatar').textContent = $('accessAvatar').textContent = initials(currentRole);
  $('rolePermissionNote').textContent = ROLE_NOTES[currentRole] || '';
}

/* ---------- incident popup / details ---------- */
function showDetails(id, isAlert) {
  const inc = incidents.find(i => i.incident_id === id);
  if (!inc) return;
  selectedIncident = inc;
  $('modalKicker').textContent = isAlert ? '🚨 NEW SECURITY EMERGENCY — ACTION REQUIRED' : 'SECURITY INCIDENT';
  $('incidentModal').classList.toggle('alerting', !!isAlert);
  $('modalName').textContent = inc.name || 'Unknown';
  $('modalId').textContent = inc.incident_id;
  const gps = (inc.latitude != null && inc.longitude != null)
    ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(inc.latitude)},${encodeURIComponent(inc.longitude)}" target="_blank" rel="noopener">${esc(Number(inc.latitude).toFixed(5))}, ${esc(Number(inc.longitude).toFixed(5))}</a>`
    : 'Not shared';
  const box = (label, html, wide) => `<div class="detail-box"${wide ? ' style="grid-column:1/-1"' : ''}><small>${label}</small><b>${html}</b></div>`;
  $('modalDetails').innerHTML = [
    box('EMERGENCY TYPE', 'Security Emergency'),
    box('INCIDENT TIME', esc(fmtTime(inc.created_at))),
    box('FULL NAME', esc(val(inc.name))),
    box('AGE', inc.age ? esc(inc.age) + ' years' : 'Not provided'),
    box('ADDRESS', esc(val(inc.address)), true),
    box('PHONE NUMBER', esc(val(inc.phone))),
    box('STATUS', esc(statusLabel(inc.status))),
    box('EMERGENCY CONTACT', esc(val(inc.contact_name)) + (inc.contact_rel ? ' <small style="font-weight:500">(' + esc(inc.contact_rel) + ')</small>' : '')),
    box('EMERGENCY CONTACT PHONE', esc(val(inc.contact_phone))),
    box('GPS LOCATION', gps, true)
  ].join('');
  $('modalAccept').style.display = isNew(inc.status) ? 'inline-block' : 'none';
  $('modalResolve').style.display = (inc.status === 'ACKNOWLEDGED' || inc.status === 'IN PROGRESS') ? 'inline-block' : 'none';
  $('incidentModal').classList.add('open');
}
function closeModal() { $('incidentModal').classList.remove('open', 'alerting'); selectedIncident = null; }

/* ---------- misc ui ---------- */
function logActivity(title, sub, color) {
  const empty = $('activityEmpty'); if (empty) empty.remove();
  const row = document.createElement('div'); row.className = 'activity-row';
  row.innerHTML = `<i class="activity-dot ${color}-bg"></i><p><b>${esc(title)}</b><small>${esc(sub)}</small></p><time>${esc(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))}</time>`;
  $('activityList').prepend(row);
  while ($('activityList').children.length > 8) $('activityList').lastChild.remove();
}
function showToast(msg) { const t = $('toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 3200); }
function navigate(view) {
  if (currentRole === 'Helper' && (view === 'history' || view === 'access')) { showToast('This section is not enabled for the helper role.'); return; }
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(view + 'View').classList.add('active');
  if (view === 'overview' && map) setTimeout(() => map.invalidateSize(), 50);
  document.querySelectorAll('.nav-link').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  $('sidebar').classList.remove('open');
}

/* ---------- session ---------- */
const LOGIN_URL = '../login/index.html';
function goToLogin() { location.href = LOGIN_URL; }
function enterDashboard() {
  document.title = 'SOS Buddy | ' + currentRole + ' Response Dashboard';
  const hide = currentRole === 'Helper';
  document.querySelector('[data-view="history"]').style.display = hide ? 'none' : 'flex';
  document.querySelector('[data-view="access"]').style.display = hide ? 'none' : 'flex';
  render(); navigate('overview'); setConn('warn', 'Connecting…'); startStream(); updateSoundLabel();
}
function signOut() {
  stopStream(); clearInterval(timerInterval);
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
  goToLogin();
}
function sessionExpired() { signOut(); return false; }
async function restoreSession() {
  let s = null; try { s = JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch (_) {}
  if (!s || !s.auth) { goToLogin(); return; }
  auth = s.auth;
  try {
    const data = await refreshIncidents();
    if (!data.role) throw new Error('old server');
    currentRole = data.role; currentEmail = s.email || ''; enterDashboard();
  } catch (_) { signOut(); }
}

/* ---------- wiring ---------- */
$('logoutBtn').addEventListener('click', signOut);
document.querySelectorAll('.nav-link').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.goto)));
$('incidentSearch').addEventListener('input', renderRows); $('statusFilter').addEventListener('change', renderRows);
document.addEventListener('click', e => {
  const d = e.target.closest('[data-details]'); if (d) { showDetails(d.dataset.details, false); return; }
  const a = e.target.closest('[data-accept]'); if (a) setStatus(a.dataset.accept, 'ACKNOWLEDGED');
});
$('modalClose').onclick = $('modalClose2').onclick = closeModal;
$('incidentModal').addEventListener('click', e => { if (e.target === $('incidentModal')) closeModal(); });
$('modalAccept').onclick = async () => { if (selectedIncident && await setStatus(selectedIncident.incident_id, 'ACKNOWLEDGED')) showDetails(selectedIncident.incident_id, false); };
$('modalResolve').onclick = async () => { if (selectedIncident && await setStatus(selectedIncident.incident_id, 'RESOLVED')) closeModal(); };
$('menuBtn').onclick = () => $('sidebar').classList.add('open'); $('closeNav').onclick = () => $('sidebar').classList.remove('open');
$('simulateEscalation').onclick = () => {
  seconds = 15; clearInterval(timerInterval); $('timerBadge').textContent = '15s'; $('timerBar').style.width = '100%';
  showToast('Escalation countdown started.');
  timerInterval = setInterval(() => {
    seconds--; $('timerBadge').textContent = seconds + 's'; $('timerBar').style.width = (seconds / 15 * 100) + '%';
    if (seconds <= 0) { clearInterval(timerInterval); logActivity('Escalation countdown finished', 'Helpers would be notified next', 'amber'); showToast('Countdown complete.'); }
  }, 1000);
};
$('todayLabel').textContent = new Date().toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
ensureAudio();
restoreSession();
