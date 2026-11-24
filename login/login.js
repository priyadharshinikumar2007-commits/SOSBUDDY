'use strict';
const PROD_API = 'https://sos-backend-production-0e25.up.railway.app';
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;
function pickApiBase(saved) {
  const q = new URLSearchParams(location.search).get('api');
  if (q) return q;
  if (saved) return saved;
  if (location.protocol === 'file:') return 'http://localhost:4000';
  if (/^https?:$/.test(location.protocol) && LOCAL_HOST.test(location.hostname)) return location.origin;
  return PROD_API;
}
const qs = new URLSearchParams(location.search);
const API_BASE = pickApiBase(null).replace(/\/$/, '');
try { if (qs.get('api')) sessionStorage.setItem('sosbuddy-api', qs.get('api')); else sessionStorage.removeItem('sosbuddy-api'); } catch (_) {}

const SECURITY_SESSION = 'sosbuddy-security-session';
const HEALTH_SESSION = 'sosbuddy-dashboard-auth';
const ROLE_NAMES = { Police: 'Police Responder', NGO: 'NGO Responder', Helper: 'Verified Helper' };
const OLD_SERVER = 'This account needs the updated server. Deploy the latest backend (sos-backend/server.js) and try again.';

const $ = id => document.getElementById(id);
const b64 = s => { const bytes = new TextEncoder().encode(s); let bin = ''; bytes.forEach(b => bin += String.fromCharCode(b)); return btoa(bin); };

async function login(e) {
  e.preventDefault();
  const role = $('loginRole').value, user = $('loginEmail').value.trim(), pass = $('loginPassword').value;
  const auth = 'Basic ' + b64(user + ':' + pass);
  const err = $('loginError'), btn = $('submitBtn');
  err.textContent = ''; btn.disabled = true;
  try {
    if (role === 'Hospital') {
      const r = await fetch(API_BASE + '/api/incidents', { headers: { Authorization: auth } });
      if (r.status === 401) { err.textContent = 'The username, password or selected team is incorrect.'; return; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      sessionStorage.setItem(HEALTH_SESSION, auth);
      location.href = '../health/index.html';
      return;
    }
    const r = await fetch(API_BASE + '/api/security-incidents', { headers: { Authorization: auth } });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401) {
      const known = data.error === 'Invalid responder credentials' || data.error === 'Responder auth required';
      err.textContent = known ? 'The username, password or selected team is incorrect.' : OLD_SERVER;
      return;
    }
    if (!r.ok || data.ok === false) throw new Error(data.error || 'HTTP ' + r.status);
    if (!data.role) { err.textContent = OLD_SERVER; return; }
    if (data.role !== role) { err.textContent = `These credentials belong to a ${data.role} account. Select "${ROLE_NAMES[data.role]}" to sign in.`; return; }
    sessionStorage.setItem(SECURITY_SESSION, JSON.stringify({ auth, role: data.role, email: user }));
    location.href = '../security/index.html';
  } catch (ex) {
    err.textContent = 'Cannot reach the server. Check your connection and try again.';
  } finally {
    btn.disabled = false;
  }
}

$('loginForm').addEventListener('submit', login);
$('togglePassword').addEventListener('click', () => {
  const p = $('loginPassword'); p.type = p.type === 'password' ? 'text' : 'password';
  $('togglePassword').textContent = p.type === 'password' ? 'Show' : 'Hide';
});
document.querySelectorAll('.acct').forEach(b => b.addEventListener('click', () => {
  $('loginRole').value = b.dataset.role; $('loginEmail').value = b.dataset.user; $('loginPassword').value = b.dataset.pass;
  $('loginError').textContent = ''; $('loginPassword').focus();
}));
