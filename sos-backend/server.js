'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const PORT = process.env.PORT || 4000;
const SOS_API_KEY = process.env.SOS_API_KEY || 'dev-local-shared-key-change-me';
const STAFF_USER = process.env.STAFF_USER || 'hospital';
const STAFF_PASS = process.env.STAFF_PASS || 'hospital123';

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
function nowIso() { return new Date().toISOString(); }
function sanitizeStr(v, max = 500) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s.length > max ? s.slice(0, max) : s;
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
function nextIncidentId() {
  const year = new Date().getUTCFullYear();
  const prefix = `SOS-${year}-`;
  const row = queryOne(
    `SELECT incident_id FROM incidents WHERE incident_id LIKE ?
     ORDER BY incident_id DESC LIMIT 1`, [prefix + '%']);
  let n = 1;
  if (row && row.incident_id) {
    const tail = parseInt(row.incident_id.slice(prefix.length), 10);
    if (!Number.isNaN(tail)) n = tail + 1;
  }
  return prefix + String(n).padStart(4, '0');
}
function requireApiKey(req, res, next) {
  const key = req.get('x-api-key') || req.query.apiKey;
  if (key !== SOS_API_KEY) return res.status(401).json({ ok: false, error: 'Invalid API key' });
  next();
}
function requireStaff(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Basic' || !token) {
    res.set('WWW-Authenticate', 'Basic realm="Hospital"');
    return res.status(401).json({ ok: false, error: 'Staff auth required' });
  }
  const [user, pass] = Buffer.from(token, 'base64').toString('utf8').split(':');
  if (user !== STAFF_USER || pass !== STAFF_PASS) {
    return res.status(401).json({ ok: false, error: 'Bad credentials' });
  }
  next();
}
function profileRowToJson(r) {
  if (!r) return null;
  return {
    profile_id: r.profile_id, name: r.name || '', dob: r.dob || '',
    age: computeAge(r.dob), blood: r.blood || '', allergies: r.allergies || '',
    conditions: r.conditions || '', medications: r.medications || '',
    other_info: r.other_info || '', updated_at: r.updated_at
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
    latitude: r.latitude, longitude: r.longitude,
    status: r.status, created_at: r.created_at, updated_at: r.updated_at,
    source: r.source || ''
  };
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
      status TEXT NOT NULL DEFAULT 'New',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      idempotency_key TEXT UNIQUE, source TEXT
    );
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_status ON incidents(status);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_incidents_profile ON incidents(profile_id);`);
  persistDb();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '64kb' }));

  const sseClients = new Set();
  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) { try { res.write(payload); } catch (_) {} }
  }

  app.get('/api/stream', requireStaff, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders?.();
    res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
    sseClients.add(res);
    const ping = setInterval(() => { try { res.write(`: ping\n\n`); } catch (_) {} }, 25000);
    req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
  });

  app.post('/api/profiles', requireApiKey, (req, res) => {
    try {
      const b = req.body || {};
      let profileId = sanitizeStr(b.profile_id, 60);
      const now = nowIso();
      const row = {
        name: sanitizeStr(b.name, 120), dob: sanitizeStr(b.dob, 40),
        blood: sanitizeStr(b.blood, 20), allergies: sanitizeStr(b.allergies, 500),
        conditions: sanitizeStr(b.conditions, 500), medications: sanitizeStr(b.medications, 500),
        other_info: sanitizeStr(b.other_info, 500)
      };
      if (!profileId) {
        profileId = randomProfileId();
        db.prepare(`INSERT INTO patients
          (profile_id, name, dob, blood, allergies, conditions, medications, other_info, created_at, updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`)
          .run([profileId, row.name, row.dob, row.blood, row.allergies,
                row.conditions, row.medications, row.other_info, now, now]);
      } else {
        const existing = queryOne(`SELECT profile_id FROM patients WHERE profile_id = ?`, [profileId]);
        if (existing) {
          db.prepare(`UPDATE patients SET
            name=?, dob=?, blood=?, allergies=?, conditions=?, medications=?, other_info=?, updated_at=?
            WHERE profile_id = ?`)
            .run([row.name, row.dob, row.blood, row.allergies,
                  row.conditions, row.medications, row.other_info, now, profileId]);
        } else {
          db.prepare(`INSERT INTO patients
            (profile_id, name, dob, blood, allergies, conditions, medications, other_info, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`)
            .run([profileId, row.name, row.dob, row.blood, row.allergies,
                  row.conditions, row.medications, row.other_info, now, now]);
        }
      }
      persistDb();
      const saved = queryOne(`SELECT * FROM patients WHERE profile_id = ?`, [profileId]);
      console.log(`[PROFILE] saved ${profileId} (${row.name})`);
      res.json({ ok: true, profile: profileRowToJson(saved) });
    } catch (err) {
      console.error('POST /api/profiles failed:', err);
      res.status(500).json({ ok: false, error: 'Failed to save profile' });
    }
  });
  app.get('/api/profiles/:id', (req, res) => {
    const row = queryOne(`SELECT * FROM patients WHERE profile_id = ?`, [req.params.id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Profile not found' });
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, profile: profileRowToJson(row) });
  });

  app.post('/api/incidents', requireApiKey, (req, res) => {
    try {
      const b = req.body || {};
      const clientKey = sanitizeStr(b.idempotency_key, 120);
      if (clientKey) {
        const existing = queryOne(`SELECT * FROM incidents WHERE idempotency_key = ?`, [clientKey]);
        if (existing) return res.json({ ok: true, incident: incidentRowToJson(existing), deduplicated: true });
      }
      const profileId = sanitizeStr(b.profile_id, 60);
      let latestProfile = null;
      if (profileId) {
        latestProfile = queryOne(`SELECT * FROM patients WHERE profile_id = ?`, [profileId]);
        const recent = queryOne(
          `SELECT * FROM incidents WHERE profile_id = ?
             AND status != 'Resolved'
             AND datetime(created_at) > datetime('now','-10 minutes')
           ORDER BY created_at DESC LIMIT 1`, [profileId]);
        if (recent) return res.json({ ok: true, incident: incidentRowToJson(recent), deduplicated: true });
      }
      const id = nextIncidentId();
      const now = nowIso();
      const merged = latestProfile ? {
        name: latestProfile.name || sanitizeStr(b.name, 120),
        dob: latestProfile.dob || sanitizeStr(b.dob, 40),
        blood: latestProfile.blood || sanitizeStr(b.blood, 20),
        allergies: latestProfile.allergies || sanitizeStr(b.allergies, 500),
        conditions: latestProfile.conditions || sanitizeStr(b.conditions, 500),
        medications: latestProfile.medications || sanitizeStr(b.medications, 500),
        other_info: latestProfile.other_info || sanitizeStr(b.other_info, 500)
      } : {
        name: sanitizeStr(b.name, 120), dob: sanitizeStr(b.dob, 40),
        blood: sanitizeStr(b.blood, 20), allergies: sanitizeStr(b.allergies, 500),
        conditions: sanitizeStr(b.conditions, 500), medications: sanitizeStr(b.medications, 500),
        other_info: sanitizeStr(b.other_info, 500)
      };
      const row = {
        incident_id: id, profile_id: profileId, ...merged,
        age: computeAge(merged.dob),
        latitude: Number.isFinite(+b.latitude) ? +b.latitude : null,
        longitude: Number.isFinite(+b.longitude) ? +b.longitude : null,
        status: 'New', created_at: now, updated_at: now,
        idempotency_key: clientKey || null,
        source: sanitizeStr(b.source, 40) || 'in-app'
      };
      db.prepare(`INSERT INTO incidents (
        incident_id, profile_id, name, dob, age, blood, allergies,
        conditions, medications, other_info, latitude, longitude,
        status, created_at, updated_at, idempotency_key, source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run([
        row.incident_id, row.profile_id, row.name, row.dob, row.age,
        row.blood, row.allergies, row.conditions, row.medications, row.other_info,
        row.latitude, row.longitude, row.status, row.created_at, row.updated_at,
        row.idempotency_key, row.source
      ]);
      persistDb();
      const json = incidentRowToJson(row);
      broadcast('incident', json);
      console.log(`[SOS] ${id} — ${row.name || 'Unknown'} (source: ${row.source})`);
      res.status(201).json({ ok: true, incident: json });
    } catch (err) {
      console.error('POST /api/incidents failed:', err);
      res.status(500).json({ ok: false, error: 'Failed to create incident' });
    }
  });
  app.get('/api/incidents', requireStaff, (_req, res) => {
    const rows = queryAll(`SELECT * FROM incidents ORDER BY created_at DESC LIMIT 500`);
    res.json({ ok: true, incidents: rows.map(incidentRowToJson) });
  });
  const ALLOWED = new Set(['New','Acknowledged','In Progress','Resolved','Dispatched']);
  app.patch('/api/incidents/:id', requireStaff, (req, res) => {
    const { id } = req.params;
    const status = sanitizeStr(req.body?.status, 40);
    if (!ALLOWED.has(status)) return res.status(400).json({ ok: false, error: 'Invalid status' });
    const row = queryOne(`SELECT * FROM incidents WHERE incident_id = ?`, [id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Not found' });
    run(`UPDATE incidents SET status = ?, updated_at = ? WHERE incident_id = ?`,
        [status, nowIso(), id]);
    const updated = queryOne(`SELECT * FROM incidents WHERE incident_id = ?`, [id]);
    const json = incidentRowToJson(updated);
    broadcast('incident-updated', json);
    res.json({ ok: true, incident: json });
  });
  app.get('/api/health', (_req, res) => res.json({ ok: true, time: nowIso() }));

  app.listen(PORT, () => {
    console.log(`SOS backend listening on http://localhost:${PORT}`);
    console.log(`DB file: ${DB_PATH}`);
  });
}

startServer().catch(err => { console.error('Fatal:', err); process.exit(1); });