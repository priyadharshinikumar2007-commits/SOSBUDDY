const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.json());

// Database Setup (Using your existing incidents.db)
const db = new sqlite3.Database('./incidents.db');

// Initialize Tables
db.serialize(() => {
    // QR Tokens table (Secure)
    db.run(`CREATE TABLE IF NOT EXISTS qr_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patient_id INTEGER,
        token_hash TEXT UNIQUE,
        active BOOLEAN DEFAULT 1
    )`);

    // Incidents table (Updated for Location & Deduplication)
    db.run(`CREATE TABLE IF NOT EXISTS incidents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT UNIQUE,
        patient_id INTEGER,
        qr_token_id INTEGER,
        status TEXT DEFAULT 'NEW',
        delivery_status TEXT DEFAULT 'QUEUED',
        scan_time DATETIME DEFAULT CURRENT_TIMESTAMP,
        location_source TEXT,
        location_owner TEXT,
        location_text TEXT
    )`);
});

// --- 1. AUTOMATIC QR SCANNING ENDPOINT ---
// Bystander scans QR -> Opens this URL: /api/scan/:token
app.get('/api/scan/:token', (req, res) => {
    const rawToken = req.params.token;
    const hash = crypto.createHash('sha256').update(rawToken).digest('hex');

    // 1. Verify Token
    db.get(`SELECT * FROM qr_tokens WHERE token_hash = ? AND active = 1`, [hash], (err, tokenRow) => {
        if (!tokenRow) return res.status(404).send("Invalid or expired QR code.");

        const patientId = tokenRow.patient_id;
        const now = new Date().toISOString();
        const publicId = "SOS-" + Date.now().toString().slice(-6);

        // 2. Deduplication Check (Prevent spam within 60 seconds)
        db.get(`SELECT public_id FROM incidents WHERE qr_token_id = ? AND scan_time > datetime('now', '-60 seconds')`, 
        [tokenRow.id], (err, recentIncident) => {
            
            if (recentIncident) {
                // Duplicate scan detected, return the existing active incident
                return res.json({ success: true, incidentId: recentIncident.public_id, isDuplicate: true });
            }

            // 3. Create New Incident (Location fallback to victim's registered address)
            // Note: We DO NOT ask for the bystander's GPS.
            const locationSource = 'victim_registered';
            const locationOwner = 'victim';
            const locationText = 'Registered Address on File'; // Replace with actual DB lookup

            const insertQ = `INSERT INTO incidents (public_id, patient_id, qr_token_id, scan_time, location_source, location_owner, location_text) 
                             VALUES (?, ?, ?, ?, ?, ?, ?)`;
            
            db.run(insertQ, [publicId, patientId, tokenRow.id, now, locationSource, locationOwner, locationText], function(err) {
                if (err) return res.status(500).send("Database error");

                // 4. AUTOMATIC HOSPITAL NOTIFICATION VIA SOCKET.IO
                const alertPayload = {
                    incidentId: publicId,
                    patientName: "John Doe", // Replace with actual patient lookup
                    age: 45,
                    scanTime: now,
                    location: { source: locationSource, owner: locationOwner, text: locationText }
                };
                
                // Emit to hospital dashboard
                io.emit("new_emergency", alertPayload);
                
                // Mark as delivered (simulating delivery acceptance)
                db.run(`UPDATE incidents SET delivery_status = 'DELIVERED' WHERE public_id = ?`, [publicId]);

                // 5. Return to Bystander
                res.json({ 
                    success: true, 
                    incidentId: publicId, 
                    message: "EMERGENCY ALERT SENT SUCCESSFULLY",
                    deliveryStatus: "DELIVERED"
                });
            });
        });
    });
});

// Socket Connection
io.on('connection', (socket) => {
    console.log('Hospital Dashboard Connected');
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));