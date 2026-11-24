'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');
const http = require('http');
const crypto = require('crypto');

const PORT = process.env.PORT || 4000;
const SOS_API_KEY = process.env.SOS_API_KEY || 'dev-local-shared-key-change-me';
const STAFF_USER = process.env.STAFF_USER || 'hospital@sosbuddy.demo';
const STAFF_PASS = process.env.STAFF_PASS || 'Hospital@2026';
const POLICE_USER = process.env.POLICE_USER || 'police@sosbuddy.demo';
const POLICE_PASS = process.env.POLICE_PASS || 'Police@2026';
const NGO_USER = process.env.NGO_USER || 'ngo@sosbuddy.demo';
const NGO_PASS = process.env.NGO_PASS || 'Ngo@2026';
const HELPER_USER = process.env.HELPER_USER || 'helper@sosbuddy.demo';
const HELPER_PASS = process.env.HELPER_PASS || 'Helper@2026';

const WAITING = 'WAITING FOR RESPONSE';
const DB_PATH = path.join(__dirname, 'incidents.db');
let db = null;

function persistDb() {
  try { fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
  catch (err) { console.error('persistDb failed:', err); }
}
function queryAll(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  const rows = []; while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free(); return rows;
}
function queryOne(sql, params = []) {
  const rows = queryAll(sql, params); return rows.length ? rows[0] : null;
}
function run(sql, params = []) {
  const stmt = db.prepare(sql); stmt.bind(params);
  stmt.step(); stmt.free(); persistDb();
}
function ensureColumn(table, column, type) {
  const cols = queryAll(`PRAGMA table_info(${table})`).map(c => c.name);
  if (!cols.includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
function nowIso() { return new Date().toISOString(); }
function sanitizeStr(v, max = 500) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
}
function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  return Number.isFinite(+v) ? +v : null;
}
function computeAge(dob) {
  if (!dob) return '';
  const d = new Date(dob); if (isNaN(d.getTime())) return '';
  const now = new Date();
  let age = now.getFullYear() - d.getFullYear();
  const m = now.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
  return age >= 0 ? String(age) : '';
}
function randomProfileId() {
  return 'P-' + Math.random().toString(36).slice(2, 8).toUpperCase()
             + Date.now().toString(36).toUpperCase().slice(-6);
}
function nextId(table, prefixText) {
  const prefix = `${prefixText}-${new Date().getUTCFullYear()}-`;
  const row = queryOne(
    `SELECT incident_id FROM ${table} WHERE incident_id LIKE ?
     ORDER BY incident_id DESC LIMIT 1`, [prefix + '%']);
  let n = 1;
  if (row && row.incident_id) {
    const tail = parseInt(row.incident_id.slice(prefix.length), 10);
    if (!Number.isNaN(tail)) n = tail + 1;
  }
  return prefix + String(n).padStart(4, '0');
}
const nextIncidentId = () => nextId('incidents', 'SOS');
const nextSecurityId = () => nextId('security_incidents', 'SEC');

function requireApiKey(req, res, next) {
  const key = req.get('x-api-key') || req.query.apiKey;
  if (key !== SOS_API_KEY) return res.status(401).json({ ok: false, error: 'Invalid API key' });
  next();
}
function basicCreds(req) {
  const [scheme, token] = (req.get('authorization') || '').split(' ');
  if (scheme !== 'Basic' || !token) return null;
  const decoded = Buffer.from(token, 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : [decoded.slice(0, i), decoded.slice(i + 1)];
}
function requireStaff(req, res, next) {
  const c = basicCreds(req);
  if (!c) {
    res.set('WWW-Authenticate', 'Basic realm="Hospital"');
    return res.status(401).json({ ok: false, error: 'Staff auth required' });
  }
  if (c[0] !== STAFF_USER || c[1] !== STAFF_PASS) {
    return res.status(401).json({ ok: false, error: 'Bad credentials' });
  }
  next();
}
function requireResponder(req, res, next) {
  const c = basicCreds(req);
  if (!c) {
    res.set('WWW-Authenticate', 'Basic realm="SOS Buddy Responder"');
    return res.status(401).json({ ok: false, error: 'Responder auth required' });
  }
  if (c[0] === POLICE_USER && c[1] === POLICE_PASS) { req.responderRole = 'Police'; return next(); }
  if (c[0] === NGO_USER && c[1] === NGO_PASS) { req.responderRole = 'NGO'; return next(); }
  if (c[0] === HELPER_USER && c[1] === HELPER_PASS) { req.responderRole = 'Helper'; return next(); }
  return res.status(401).json({ ok: false, error: 'Invalid responder credentials' });
}

function profileRowToJson(r) {
  if (!r) return null;
  return {
    profile_id: r.profile_id, name: r.name || '', dob: r.dob || '',
    age: computeAge(r.dob), blood: r.blood || '', allergies: r.allergies || '',
    conditions: r.conditions || '', medications: r.medications || '',
    other_info: r.other_info || '',
    contact_name: r.contact_name || '', contact_phone: r.contact_phone || '', contact_rel: r.contact_rel || '',
    updated_at: r.updated_at
  };
}
function incidentRowToJson(r) {
  if (!r) return null;
  return {
    incident_id: r.incident_id, profile_id: r.profile_id || '',
    name: r.name || '', dob: r.dob || '', age: r.age || '',
    blood: r.blood || '', allergies: r.allergies || '',
    conditions: r.conditions || '', medications: r.medications || '',
    other_info: r.other_info || '',
    contact_name: r.contact_name || '', contact_phone: r.contact_phone || '', contact_rel: r.contact_rel || '',
    latitude: r.latitude, longitude: r.longitude,
    status: r.status, created_at: r.created_at, updated_at: r.updated_at,
    source: r.source || '',
    location_source: r.location_source || 'unavailable',
    location_owner: r.location_owner || 'unknown',
    delivery_status: r.delivery_status || 'DELIVERED'
  };
}
function securityIncidentRowToJson(r) {
  if (!r) return null;
  let contacts = [];
  try { contacts = r.contacts ? JSON.parse(r.contacts) : []; } catch (_) { contacts = []; }
  const first = contacts[0] || {};
  return {
    incident_id: r.incident_id, profile_id: r.profile_id || '',
    name: r.name || '', age: r.age || '', phone: r.phone || '', address: r.address || '',
    contact_name: r.contact_name || first.name || '',
    contact_phone: r.contact_phone || first.phone || '',
    contact_rel: r.contact_rel || first.relationship || '',
    latitude: r.latitude, longitude: r.longitude,
    status: r.status, created_at: r.created_at, updated_at: r.updated_at,
    source: r.source || '',
    contacts
  };
}

// ---- incident builders (shared by app SOS buttons and the QR scan page)
function insertHealthIncident(p, o) {
  const now = nowIso();
  const lat = numOrNull(o.lat), lng = numOrNull(o.lng);
  const row = {
    incident_id: nextIncidentId(), profile_id: o.profileId || (p && p.profile_id) || '',
    name: (p && p.name) || o.name || 'Unknown', dob: (p && p.dob) || '', age: computeAge((p && p.dob) || ''),
    blood: (p && p.blood) || '', allergies: (p && p.allergies) || '',
    conditions: (p && p.conditions) || '', medications: (p && p.medications) || '',
    other_info: (p && p.other_info) || '',
    contact_name: (p && p.contact_name) || '', contact_phone: (p && p.contact_phone) || '',
    contact_rel: (p && p.contact_rel) || '',
    latitude: lat, longitude: lng, status: WAITING, created_at: now, updated_at: now,
    idempotency_key: o.idem || null, source: o.source || 'in-app',
    location_source: lat != null ? o.locSource : 'unavailable', location_owner: o.locOwner,
    delivery_status: 'DELIVERED'
  };
  db.prepare(`INSERT INTO incidents (
    incident_id, profile_id, name, dob, age, blood, allergies, conditions, medications, other_info,
    contact_name, contact_phone, contact_rel, latitude, longitude, status, created_at, updated_at,
    idempotency_key, source, location_source, location_owner, delivery_status
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run([
    row.incident_id, row.profile_id, row.name, row.dob, row.age, row.blood, row.allergies,
    row.conditions, row.medications, row.other_info, row.contact_name, row.contact_phone, row.contact_rel,
    row.latitude, row.longitude, row.status, row.created_at, row.updated_at,
    row.idempotency_key, row.source, row.location_source, row.location_owner, row.delivery_status
  ]);
  persistDb();
  return row;
}
function insertSecurityIncident(p, o) {
  const now = nowIso();
  const contactName = (p && p.contact_name) || o.contactName || '';
  const contactPhone = (p && p.contact_phone) || o.contactPhone || '';
  const contactRel = (p && p.contact_rel) || o.contactRel || '';
  let contacts = Array.isArray(o.contacts) ? o.contacts : [];
  if (!contacts.length && (contactName || contactPhone)) contacts = [{ name: contactName, phone: contactPhone, relationship: contactRel }];
  const row = {
    incident_id: nextSecurityId(), profile_id: o.profileId || (p && p.profile_id) || '',
    name: (p && p.name) || o.name || 'Unknown', age: (p && p.age) || o.age || '',
    phone: (p && p.phone) || o.phone || '', address: (p && p.address) || o.address || '',
    contact_name: contactName, contact_phone: contactPhone, contact_rel: contactRel,
    latitude: numOrNull(o.lat), longitude: numOrNull(o.lng),
    status: WAITING, contacts: JSON.stringify(contacts), created_at: now, updated_at: now,
    idempotency_key: o.idem || null, source: o.source || 'in-app'
  };
  db.prepare(`INSERT INTO security_incidents (
    incident_id, profile_id, name, age, phone, address, contact_name, contact_phone, contact_rel,
    latitude, longitude, status, contacts, created_at, updated_at, idempotency_key, source
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run([
    row.incident_id, row.profile_id, row.name, row.age, row.phone, row.address,
    row.contact_name, row.contact_phone, row.contact_rel, row.latitude, row.longitude,
    row.status, row.contacts, row.created_at, row.updated_at, row.idempotency_key, row.source
  ]);
  persistDb();
  return row;
}

async function startServer() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    db = new SQL.Database(fs.readFileSync(DB_PATH));
    console.log('Loaded existing DB:', DB_PATH);
  } else {
    db = new SQL.Database();
    console.log('Created new DB:', DB_PATH);
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS patients (
      profile_id TEXT PRIMARY KEY, name TEXT, dob TEXT, blood TEXT,
      allergies TEXT, conditions TEXT, medications TEXT, other_info TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS incidents (
      incident_id TEXT PRIMARY KEY, profile_id TEXT,
      name TEXT, dob TEXT, age TEXT, blood TEXT,
      allergies TEXT, conditions TEXT, medications TEXT, other_info TEXT,
      latitude REAL, longitude REAL,
      status TEXT NOT NULL DEFAULT 'WAITING FOR RESPONSE',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      idempotency_key TEXT UNIQUE, source TEXT,
      location_source TEXT DEFAULT 'unavailable',
      location_owner TEXT DEFAULT 'unknown',
      delivery_status TEXT DEFAULT 'DELIVERED'
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS qr_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id TEXT,
      token_hash TEXT UNIQUE,
      active BOOLEAN DEFAULT 1,
      created_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS security_incidents (
      incident_id TEXT PRIMARY KEY, profile_id TEXT,
      name TEXT, age TEXT, phone TEXT,
      latitude REAL, longitude REAL,
      status TEXT NOT NULL DEFAULT 'WAITING FOR RESPONSE',
      contacts TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS security_profiles (
      profile_id TEXT PRIMARY KEY,
      name TEXT, age TEXT, phone TEXT, address TEXT,
      contact_name TEXT, contact_phone TEXT, contact_rel TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  // Upgrade older databases in place (dashboard snapshots and incident delivery metadata)
  ensureColumn('patients', 'contact_name', 'TEXT');
  ensureColumn('patients', 'contact_phone', 'TEXT');
  ensureColumn('patients', 'contact_rel', 'TEXT');
  ensureColumn('incidents', 'contact_name', 'TEXT');
  ensureColumn('incidents', 'contact_phone', 'TEXT');
  ensureColumn('incidents', 'contact_rel', 'TEXT');
  ensureColumn('incidents', 'location_source', "TEXT DEFAULT 'unavailable'");
  ensureColumn('incidents', 'location_owner', "TEXT DEFAULT 'unknown'");
  ensureColumn('incidents', 'delivery_status', "TEXT DEFAULT 'DELIVERED'");
  ensureColumn('security_incidents', 'address', 'TEXT');
  ensureColumn('security_incidents', 'contact_name', 'TEXT');
  ensureColumn('security_incidents', 'contact_phone', 'TEXT');
  ensureColumn('security_incidents', 'contact_rel', 'TEXT');
  ensureColumn('security_incidents', 'idempotency_key', 'TEXT');
  ensureColumn('security_incidents', 'source', 'TEXT');

  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_profile ON incidents(profile_id);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_security_incidents_status ON security_incidents(status);`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_security_incidents_idem ON security_incidents(idempotency_key);`);
  persistDb();

  const app = express();
  const server = http.createServer(app);

  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  // ==========================================
  // STATIC PAGES (works whether this file sits at the project root or inside sos-backend/)
  // ==========================================
  const findDir = name => [path.join(__dirname, name), path.join(__dirname, '..', name)].find(p => fs.existsSync(p));
  for (const name of ['health', 'security', 'login', 'sosbuddy']) {
    const dir = findDir(name);
    if (dir) app.use('/' + name, express.static(dir));
  }
  app.get('/', (_req, res) => res.redirect('/login/'));
  app.get('/hospital-dashboard', (_req, res) => res.redirect('/health/'));
  app.get('/security-dashboard', (_req, res) => res.redirect('/security/'));

  // ==========================================
  // LIVE STREAMS (Server-Sent Events). Health -> hospital staff, Security -> police/NGO/helper.
  // ==========================================
  function makeStream() {
    const clients = new Set();
    return {
      broadcast(event, data) {
        const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const res of clients) { try { res.write(payload); } catch (_) {} }
      },
      handler(req, res) {
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        res.flushHeaders?.();
        res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
        clients.add(res);
        const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch (_) {} }, 25000);
        req.on('close', () => { clearInterval(ping); clients.delete(res); });
      }
    };
  }
  const healthStream = makeStream();
  const securityStream = makeStream();
  const broadcast = healthStream.broadcast;
  const broadcastSecurity = securityStream.broadcast;
  app.get('/api/stream', requireStaff, healthStream.handler);
  app.get('/api/security-stream', requireResponder, securityStream.handler);

  // ==========================================
  // QR SCAN: the bystander picks Health or Security (no account needed)
  // ==========================================
  function resolveScanProfileId(param) {
    const hash = crypto.createHash('sha256').update(String(param)).digest('hex');
    const t = queryOne('SELECT profile_id FROM qr_tokens WHERE token_hash = ? AND active = 1', [hash]);
    if (t) return t.profile_id;
    const id = sanitizeStr(param, 60);
    if (id && (queryOne('SELECT profile_id FROM patients WHERE profile_id = ?', [id]) ||
               queryOne('SELECT profile_id FROM security_profiles WHERE profile_id = ?', [id]))) return id;
    return null;
  }
  function recentOpenIncident(table, profileId) {
    const since = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    return queryOne(
      `SELECT * FROM ${table} WHERE profile_id = ? AND status NOT IN ('RESOLVED','CLOSED') AND created_at > ?
       ORDER BY created_at DESC LIMIT 1`, [profileId, since]);
  }

  app.get('/api/scan/:token', (req, res) => {
    const token = JSON.stringify(String(req.params.token)).replace(/</g, '\\u003c');
    res.type('html').send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOS Buddy - Emergency</title>
<style>
:root{--bg:#f3f6fb;--card:#fff;--text:#17243b;--muted:#64748b;--shadow:0 15px 40px rgba(23,36,59,.12);--link:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#0b1120;--card:#1e293b;--text:#f1f5f9;--muted:#aab8cc;--shadow:0 15px 40px rgba(0,0,0,.5);--link:#fca5a5}}
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:var(--card);border-radius:20px;max-width:420px;width:100%;padding:28px 22px;box-shadow:var(--shadow);text-align:center}
h1{font-size:22px;margin:0 0 6px}p{color:var(--muted);font-size:14px;line-height:1.5;margin:0 0 22px}
button{display:block;width:100%;border:0;border-radius:14px;padding:18px 14px;margin-bottom:12px;font-size:17px;font-weight:800;color:#fff;cursor:pointer;font-family:inherit}
button small{display:block;font-size:12px;font-weight:500;opacity:.92;margin-top:4px}
.health{background:#047857}.security{background:#1d4ed8}button:disabled{opacity:.55;cursor:default}
#status{font-size:14px;margin-top:8px;min-height:20px;font-weight:600}.ok{color:#16a34a}.err{color:#dc2626}
a{color:var(--link);font-weight:700}
</style></head><body><div class="card">
<h1>Someone needs help</h1>
<p>Choose the type of emergency. Responders will be alerted immediately with this person's saved details.</p>
<button class="health" id="bh" onclick="send('health')">Health Emergency<small>Alerts the hospital</small></button>
<button class="security" id="bs" onclick="send('security')">Security Emergency<small>Alerts police &amp; NGO responders</small></button>
<div id="status" role="status"></div>
<p style="margin-top:16px;font-size:12px">If life-threatening, also call <a href="tel:112">112</a>.</p>
</div>
<script>
const T=${token};
const st=document.getElementById('status');
function setBusy(b){document.getElementById('bh').disabled=b;document.getElementById('bs').disabled=b}
async function send(type){
  setBusy(true);st.className='';st.textContent='Getting location...';
  const go=async(lat,lng)=>{
    st.textContent='Sending alert...';
    try{
      const r=await fetch('/api/scan/'+encodeURIComponent(T)+'/'+type,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({latitude:lat,longitude:lng})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok||!d.ok)throw new Error(d.error||('HTTP '+r.status));
      st.className='ok';st.textContent='Alert sent. Incident '+d.incident_id+'. Help is being notified.';
    }catch(e){st.className='err';st.textContent='Could not send: '+e.message;setBusy(false)}
  };
  if(navigator.geolocation)navigator.geolocation.getCurrentPosition(p=>go(p.coords.latitude,p.coords.longitude),()=>go(null,null),{timeout:6000,maximumAge:30000});
  else go(null,null);
}
</script></body></html>`);
  });

  app.post('/api/scan/:token/:type', (req, res) => {
    try {
      const type = req.params.type;
      if (type !== 'health' && type !== 'security') return res.status(400).json({ ok: false, error: 'Unknown emergency type' });
      const profileId = resolveScanProfileId(req.params.token);
      if (!profileId) return res.status(404).json({ ok: false, error: 'Invalid or inactive QR code' });
      const b = req.body || {};
      const loc = { lat: numOrNull(b.latitude), lng: numOrNull(b.longitude) };

      if (type === 'health') {
        const p = queryOne('SELECT * FROM patients WHERE profile_id = ?', [profileId]);
        if (!p) return res.status(404).json({ ok: false, error: 'No health profile has been saved for this person.' });
        const dup = recentOpenIncident('incidents', profileId);
        if (dup) return res.json({ ok: true, incident_id: dup.incident_id, deduplicated: true });
        const row = insertHealthIncident(p, { profileId, ...loc, source: 'qr-scan', locSource: 'bystander-gps', locOwner: 'bystander' });
        broadcast('incident', incidentRowToJson(row));
        return res.json({ ok: true, incident_id: row.incident_id });
      }

      const p = queryOne('SELECT * FROM security_profiles WHERE profile_id = ?', [profileId]);
      if (!p) return res.status(404).json({ ok: false, error: 'No security profile has been saved for this person.' });
      const dup = recentOpenIncident('security_incidents', profileId);
      if (dup) return res.json({ ok: true, incident_id: dup.incident_id, deduplicated: true });
      const row = insertSecurityIncident(p, { profileId, ...loc, source: 'qr-scan' });
      broadcastSecurity('security-incident', securityIncidentRowToJson(row));
      return res.json({ ok: true, incident_id: row.incident_id });
    } catch (err) {
      console.error('QR scan error:', err);
      res.status(500).json({ ok: false, error: 'Unable to send the alert' });
    }
  });

  // ==========================================
  // SECURITY SOS (original endpoint kept; now also reaches the responder dashboards)
  // ==========================================
  app.post('/api/security-sos', requireApiKey, (req, res) => {
    try {
      const b = req.body || {};
      const profileId = sanitizeStr(b.profile_id, 60);
      const lat = numOrNull(b.latitude), lng = numOrNull(b.longitude);
      const name = sanitizeStr(b.name, 120);
      if (!name || lat === null || lng === null) {
        return res.status(400).json({ ok: false, error: 'Name and location are required' });
      }
      const p = profileId ? queryOne('SELECT * FROM security_profiles WHERE profile_id = ?', [profileId]) : null;
      const row = insertSecurityIncident(p, {
        profileId, name, age: sanitizeStr(b.age, 10), phone: sanitizeStr(b.phone, 20),
        address: sanitizeStr(b.address, 500), contacts: Array.isArray(b.contacts) ? b.contacts : [],
        lat, lng, source: 'in-app'
      });
      const json = securityIncidentRowToJson(row);
      broadcastSecurity('security-incident', json);
      res.json({ ok: true, incident: json });
    } catch (err) {
      console.error('Security SOS Error:', err);
      res.status(500).json({ ok: false, error: 'Failed to create security incident' });
    }
  });

  // Security SOS from the app: builds the incident from the person's saved Security Profile
  app.post('/api/security-incidents', requireApiKey, (req, res) => {
    try {
      const b = req.body || {};
      const profileId = sanitizeStr(b.profile_id, 60);
      const idem = sanitizeStr(b.idempotency_key, 120) || null;
      if (idem) {
        const dup = queryOne('SELECT * FROM security_incidents WHERE idempotency_key = ?', [idem]);
        if (dup) return res.json({ ok: true, incident: securityIncidentRowToJson(dup), deduplicated: true });
      }
      const p = profileId ? queryOne('SELECT * FROM security_profiles WHERE profile_id = ?', [profileId]) : null;
      if (!p) return res.status(404).json({ ok: false, error: 'Security profile not found. Save your Security Profile first.' });
      const row = insertSecurityIncident(p, {
        profileId, lat: b.latitude, lng: b.longitude, idem, source: sanitizeStr(b.source, 40) || 'in-app'
      });
      const json = securityIncidentRowToJson(row);
      broadcastSecurity('security-incident', json);
      res.status(201).json({ ok: true, incident: json });
    } catch (err) {
      console.error('POST /api/security-incidents error:', err);
      res.status(500).json({ ok: false, error: 'Failed to create security incident' });
    }
  });

  // ==========================================
  // HEALTH EMERGENCY (SOS button)
  // ==========================================
  app.post('/api/incidents', requireApiKey, (req, res) => {
    try {
      const b = req.body || {};
      const clientKey = sanitizeStr(b.idempotency_key, 120);
      if (clientKey) {
        const existing = queryOne(`SELECT * FROM incidents WHERE idempotency_key = ?`, [clientKey]);
        if (existing) return res.json({ ok: true, incident: incidentRowToJson(existing), deduplicated: true });
      }
      const profileId = sanitizeStr(b.profile_id, 60);
      const profile = profileId ? queryOne(`SELECT * FROM patients WHERE profile_id = ?`, [profileId]) : null;
      const row = insertHealthIncident(profile, {
        profileId, name: sanitizeStr(b.name, 120), lat: b.latitude, lng: b.longitude,
        idem: clientKey || null, source: sanitizeStr(b.source, 40) || 'in-app',
        locSource: 'user_device', locOwner: 'victim'
      });
      const json = incidentRowToJson(row);
      broadcast('incident', json);
      res.status(201).json({ ok: true, incident: json });
    } catch (err) {
      console.error('POST /api/incidents error:', err);
      res.status(500).json({ ok: false, error: 'Failed to create incident' });
    }
  });

  // ==========================================
  // PROFILES
  // ==========================================
  app.post('/api/generate-qr/:profile_id', requireStaff, (req, res) => {
    const profileId = req.params.profile_id;
    const profile = queryOne('SELECT profile_id FROM patients WHERE profile_id = ?', [profileId]);
    if (!profile) return res.status(404).json({ ok: false, error: 'Profile not found' });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');

    db.prepare('INSERT INTO qr_tokens (profile_id, token_hash, created_at) VALUES (?,?,?)').run([profileId, hash, nowIso()]);
    persistDb();

    const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://sos-backend-production-0e25.up.railway.app';
    res.json({ success: true, url: `${publicBaseUrl.replace(/\/$/, '')}/api/scan/${rawToken}` });
  });

  app.post('/api/profiles', requireApiKey, (req, res) => {
    try {
      const b = req.body || {};
      const profileId = sanitizeStr(b.profile_id, 60) || randomProfileId();
      const now = nowIso();
      const row = {
        name: sanitizeStr(b.name, 120), dob: sanitizeStr(b.dob, 40),
        blood: sanitizeStr(b.blood, 20), allergies: sanitizeStr(b.allergies, 500),
        conditions: sanitizeStr(b.conditions, 500), medications: sanitizeStr(b.medications, 500),
        other_info: sanitizeStr(b.other_info, 500),
        contact_name: sanitizeStr(b.contact_name, 120), contact_phone: sanitizeStr(b.contact_phone, 40),
        contact_rel: sanitizeStr(b.contact_rel, 40)
      };
      const existing = queryOne(`SELECT profile_id FROM patients WHERE profile_id = ?`, [profileId]);
      if (existing) {
        db.prepare(`UPDATE patients SET name=?, dob=?, blood=?, allergies=?, conditions=?, medications=?, other_info=?,
          contact_name=?, contact_phone=?, contact_rel=?, updated_at=? WHERE profile_id = ?`)
          .run([row.name, row.dob, row.blood, row.allergies, row.conditions, row.medications, row.other_info,
                row.contact_name, row.contact_phone, row.contact_rel, now, profileId]);
      } else {
        db.prepare(`INSERT INTO patients (profile_id, name, dob, blood, allergies, conditions, medications, other_info,
          contact_name, contact_phone, contact_rel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run([profileId, row.name, row.dob, row.blood, row.allergies, row.conditions, row.medications, row.other_info,
                row.contact_name, row.contact_phone, row.contact_rel, now, now]);
      }
      persistDb();
      const saved = queryOne(`SELECT * FROM patients WHERE profile_id = ?`, [profileId]);
      res.json({ ok: true, profile: profileRowToJson(saved) });
    } catch (err) {
      res.status(500).json({ ok: false, error: 'Failed to save profile' });
    }
  });

  app.get('/api/profiles/:id', requireStaff, (req, res) => {
    const row = queryOne('SELECT * FROM patients WHERE profile_id = ?', [req.params.id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Profile not found' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, profile: profileRowToJson(row) });
  });

  app.post('/api/security-profiles', requireApiKey, (req, res) => {
    try {
      const b = req.body || {};
      const profileId = sanitizeStr(b.profile_id, 60);
      if (!profileId) return res.status(400).json({ ok: false, error: 'Profile ID required' });

      const name = sanitizeStr(b.name, 120);
      const age = sanitizeStr(b.age, 10);
      const phone = sanitizeStr(b.phone, 20);
      const address = sanitizeStr(b.address, 500);
      const contactName = sanitizeStr(b.contactName, 120);
      const contactPhone = sanitizeStr(b.contactPhone, 20);
      const contactRel = sanitizeStr(b.contactRel, 40);
      const now = nowIso();

      const existing = queryOne(`SELECT profile_id FROM security_profiles WHERE profile_id = ?`, [profileId]);
      if (existing) {
        db.prepare(`UPDATE security_profiles SET
          name=?, age=?, phone=?, address=?, contact_name=?, contact_phone=?, contact_rel=?, updated_at=?
          WHERE profile_id = ?`).run([name, age, phone, address, contactName, contactPhone, contactRel, now, profileId]);
      } else {
        db.prepare(`INSERT INTO security_profiles
          (profile_id, name, age, phone, address, contact_name, contact_phone, contact_rel, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`).run([profileId, name, age, phone, address, contactName, contactPhone, contactRel, now, now]);
      }
      persistDb();
      const saved = queryOne(`SELECT * FROM security_profiles WHERE profile_id = ?`, [profileId]);
      res.json({ ok: true, profile: saved });
    } catch (err) {
      console.error('Security Profile Save Error:', err);
      res.status(500).json({ ok: false, error: 'Failed to save security profile' });
    }
  });

  app.get('/api/security-profiles/:id', requireApiKey, (req, res) => {
    const row = queryOne(`SELECT * FROM security_profiles WHERE profile_id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Profile not found' });
    res.json({ ok: true, profile: row });
  });

  // ==========================================
  // DASHBOARD DATA
  // ==========================================
  app.get('/api/incidents', requireStaff, (_req, res) => {
    const rows = queryAll(`SELECT * FROM incidents ORDER BY created_at DESC LIMIT 500`);
    res.json({ ok: true, incidents: rows.map(incidentRowToJson) });
  });

  app.get('/api/security-incidents', requireResponder, (req, res) => {
    const rows = queryAll(`SELECT * FROM security_incidents ORDER BY created_at DESC LIMIT 500`);
    res.json({ ok: true, role: req.responderRole, incidents: rows.map(securityIncidentRowToJson) });
  });

  const ALLOWED = new Set(['NEW', WAITING, 'ACKNOWLEDGED', 'IN PROGRESS', 'AMBULANCE DISPATCHED', 'PATIENT RECEIVED', 'RESOLVED', 'CLOSED']);
  app.patch('/api/incidents/:id', requireStaff, (req, res) => {
    const { id } = req.params;
    const status = sanitizeStr(req.body?.status, 40);
    if (!ALLOWED.has(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
    const row = queryOne(`SELECT * FROM incidents WHERE incident_id = ?`, [id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    run(`UPDATE incidents SET status = ?, updated_at = ? WHERE incident_id = ?`, [status, nowIso(), id]);
    const json = incidentRowToJson(queryOne(`SELECT * FROM incidents WHERE incident_id = ?`, [id]));
    broadcast('incident-updated', json);
    res.json({ ok: true, incident: json });
  });

  const ALLOWED_SECURITY = new Set(['NEW', WAITING, 'ACKNOWLEDGED', 'IN PROGRESS', 'RESOLVED']);
  app.patch('/api/security-incidents/:id', requireResponder, (req, res) => {
    const { id } = req.params;
    const status = sanitizeStr(req.body?.status, 40);
    if (!ALLOWED_SECURITY.has(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
    const row = queryOne(`SELECT * FROM security_incidents WHERE incident_id = ?`, [id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    run(`UPDATE security_incidents SET status = ?, updated_at = ? WHERE incident_id = ?`, [status, nowIso(), id]);
    const json = securityIncidentRowToJson(queryOne(`SELECT * FROM security_incidents WHERE incident_id = ?`, [id]));
    broadcastSecurity('security-incident-updated', json);
    res.json({ ok: true, incident: json });
  });

  app.get('/api/health', (_req, res) => res.json({ ok: true, time: nowIso() }));

  server.listen(PORT, () => {
    console.log(`SOS backend listening on http://localhost:${PORT}`);
    console.log(`DB file: ${DB_PATH}`);
  });
}

startServer().catch(err => { console.error('Fatal:', err); process.exit(1); });
