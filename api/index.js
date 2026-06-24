const express = require('express');
const { initializeApp, cert, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const dotenv = require('dotenv');
const multer = require('multer');
const csvParser = require('csv-parser');
const { Readable } = require('stream');
const cors = require('cors');

dotenv.config();

const path = require('path');
const fs = require('fs');

// Initialize Firebase Admin with firebase-key.json
if (!getApps().length) {
    const serviceAccountPath = path.join(__dirname, '../firebase-key.json');
    if (fs.existsSync(serviceAccountPath)) {
        const serviceAccount = require(serviceAccountPath);
        initializeApp({
            credential: cert(serviceAccount)
        });
        console.log("Firebase Admin initialized using firebase-key.json");
    } else {
        initializeApp();
        console.log("Firebase Admin initialized with default credentials");
    }
}

const db = getFirestore();
const app = express();
app.use(cors());
app.use(express.json());

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../public')));

// Multer - store in memory
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Helper: sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Import WhatsApp Baileys logic
const { startWhatsAppSession, getSessionStatus, sendWhatsAppMessage, logoutWhatsApp } = require('./whatsapp');

// -- WHATSAPP QR CONNECTION API --
app.post('/api/whatsapp/start', async (req, res) => {
    const userId = req.headers['user-id'];
    if (!userId) return res.status(400).json({ error: 'Missing user-id header' });

    try {
        await startWhatsAppSession(userId, db);
        res.json({ success: true, message: 'Session started/starting' });
    } catch (err) {
        console.error('Failed to start session:', err);
        res.status(500).json({ error: 'Failed to start WhatsApp session' });
    }
});

app.get('/api/whatsapp/status', async (req, res) => {
    const userId = req.headers['user-id'];
    if (!userId) return res.status(400).json({ error: 'Missing user-id header' });

    try {
        const status = await getSessionStatus(userId);
        res.json(status); // { status: 'connecting'|'open'|'closed', qr: 'data:image...' }
    } catch (err) {
        res.status(500).json({ error: 'Failed to get status' });
    }
});

app.post('/api/whatsapp/logout', async (req, res) => {
    const userId = req.headers['user-id'];
    if (!userId) return res.status(400).json({ error: 'Missing user-id header' });

    try {
        await logoutWhatsApp(userId);
        res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to logout' });
    }
});


// -- EXTERNAL DEVELOPER API --
app.post('/api/v1/send-message', async (req, res) => {
    const { apiKey, number, message } = req.body;
    if (!apiKey || !number || !message) {
        return res.status(400).json({ error: 'Missing apiKey, number, or message' });
    }
    try {
        const snapshot = await db.collection('users').where('apiKey', '==', apiKey).limit(1).get();
        if (snapshot.empty) return res.status(401).json({ error: 'Invalid API Key' });
        
        const userId = snapshot.docs[0].id;
        
        await sendWhatsAppMessage(userId, number, message);
        res.json({ success: true, message: 'Message sent successfully' });
    } catch (error) {
        console.error('API Send Error:', error);
        res.status(500).json({ error: 'Failed to send message', details: error.message });
    }
});

// -- BULK SEND --
app.post('/api/bulk-send', upload.single('csvFile'), async (req, res) => {
    const userId = req.headers['user-id'];
    if (!userId) return res.status(400).json({ error: 'Missing user-id header' });
    if (!req.file) return res.status(400).json({ error: 'No CSV file uploaded' });

    try {
        const message = req.body.message || '';
        const templateId = req.body.templateId;
        if (!message.trim() && !templateId) return res.status(400).json({ error: 'Message is empty' });

        let templateData = null;
        if (templateId) {
            try {
                const tplDoc = await db.collection('templates').doc(userId).collection('userTemplates').doc(templateId).get();
                if (tplDoc.exists) {
                    templateData = tplDoc.data();
                }
            } catch(e) {
                console.error("Failed to fetch template:", e);
            }
        }

        // Parse CSV
        const rows = await parseCsvBuffer(req.file.buffer);
        if (rows.length === 0) return res.status(400).json({ error: 'CSV file is empty or invalid' });

        // Extract phone numbers (support "Phone" or "Number" column, case-insensitive)
        const phones = [];
        for (const row of rows) {
            const key = Object.keys(row).find(k => {
                const cleanKey = k.trim().toLowerCase();
                return cleanKey === 'phone' || cleanKey === 'number';
            });
            const codeKey = Object.keys(row).find(k => k.trim() === '91' || k.trim().toLowerCase() === 'countrycode' || k.trim().toLowerCase() === 'country code');
            
            if (key && row[key]) {
                let num = String(row[key]).replace(/\D/g, '');
                let code = (codeKey && row[codeKey]) ? String(row[codeKey]).replace(/\D/g, '') : '';
                
                // Prepend country code if missing
                if (code && !num.startsWith(code)) {
                    num = code + num;
                } else if (num.length === 10) {
                    num = '91' + num; // default to India
                }
                
                if (num.length >= 10) phones.push({ number: num, name: row['Name'] || row['name'] || '' });
            }
        }

        if (phones.length === 0) {
            return res.status(400).json({
                error: 'No phone numbers found. CSV must have a column named "Phone" or "Number".'
            });
        }

        // Check if whatsapp is connected before starting
        const sessionStatus = await getSessionStatus(userId);
        if (sessionStatus.status !== 'open') {
            return res.status(400).json({ error: 'WhatsApp is not connected. Please scan QR code in Settings first.' });
        }

        // Respond immediately so client doesn't timeout
        res.json({ success: true, message: `Campaign started! Sending to ${phones.length} contacts.`, total: phones.length });

        // Update uploaded stats initially
        try {
            const statsRef = db.collection('stats').doc(userId);
            await statsRef.set({
                uploaded: FieldValue.increment(phones.length),
                updatedAt: new Date().toISOString()
            }, { merge: true });
        } catch (err) {
            console.error('Failed to update uploaded stats:', err.message);
        }

        // Process in background with anti-ban delay (3-5 seconds)
        let sent = 0, failed = 0;
        for (const contact of phones) {
            try {
                let currentTemplate = templateData ? { ...templateData } : null;
                let personalizedMsg = message.replace(/\{\{name\}\}/gi, contact.name || 'Friend');
                
                if (currentTemplate && currentTemplate.message) {
                    currentTemplate.message = currentTemplate.message.replace(/\{\{name\}\}/gi, contact.name || 'Friend');
                    personalizedMsg = currentTemplate.message; // Use template message as fallback
                }
                
                await sendWhatsAppMessage(userId, contact.number, personalizedMsg, currentTemplate);
                sent++;
            } catch (err) {
                console.error(`Failed to send to ${contact.number}:`, err.message);
                failed++;
            }
            const delay = 3000 + Math.floor(Math.random() * 2000);
            await sleep(delay);
        }

        // Update stats
        try {
            const statsRef = db.collection('stats').doc(userId);
            const statsDoc = await statsRef.get();
            const existing = statsDoc.exists ? statsDoc.data() : { sent: 0, failed: 0 };
            await statsRef.set({
                sent: FieldValue.increment(sent),
                failed: FieldValue.increment(failed),
                updatedAt: new Date().toISOString()
            }, { merge: true });
        } catch (statsErr) {
            console.error('Failed to update stats:', statsErr.message);
        }

        console.log(`Bulk campaign done. Sent: ${sent}, Failed: ${failed}`);

    } catch (err) {
        console.error('Bulk send error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'Failed to process campaign: ' + err.message });
        }
    }
});

// Helper: parse CSV buffer into array of rows
function parseCsvBuffer(buffer) {
    return new Promise((resolve, reject) => {
        const results = [];
        const stream = Readable.from(buffer.toString('utf-8'));
        stream
            .pipe(csvParser())
            .on('data', (row) => results.push(row))
            .on('end', () => resolve(results))
            .on('error', reject);
    });
}

// -- INTERNAL DASHBOARD API --
app.post('/api/auth/create-user', async (req, res) => {
    const { email, password, uid } = req.body;
    try {
        await getAuth().createUser({ uid, email, password });
        res.json({ success: true });
    } catch(err) {
        res.json({ success: false, error: err.message });
    }
});

app.post('/api/chat/send', async (req, res) => {
    const { chatId, message } = req.body;
    const userId = req.headers['user-id'];
    if(!userId || !chatId || !message) return res.status(400).json({ error: 'Missing parameters' });
    try {
        await sendWhatsAppMessage(userId, chatId, message);
        res.json({ success: true });
    } catch(err) {
        console.error('Error sending chat message:', err);
        res.status(500).json({ error: 'Failed to send: ' + err.message });
    }
});

app.get('/api/chat/conversations', (req, res) => res.json({ success: true, chats: [] }));
app.get('/api/chat/messages/:id', (req, res) => res.json({ success: true, messages: [] }));
app.get('/api/scraper/groups', (req, res) => res.json({ success: true, groups: [] }));
app.get('/api/dashboard-stats', async (req, res) => {
    const userId = req.headers['user-id'];
    if (!userId) return res.json({ isAdmin: false, myStats: {} });
    try {
        const statsDoc = await db.collection('stats').doc(userId).get();
        if (statsDoc.exists) {
            res.json({ isAdmin: false, myStats: statsDoc.data() });
        } else {
            res.json({ isAdmin: false, myStats: {} });
        }
    } catch(err) {
        res.json({ isAdmin: false, myStats: {} });
    }
});

// Ping endpoint to keep server awake
app.get('/api/ping', (req, res) => {
    res.send('pong');
});

// Fallback for SPA routing
app.use((req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// For Render / Railway we need to listen on a port
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});

// We no longer export app for Vercel, this is a standalone server now.
