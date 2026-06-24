const { default: makeWASocket, DisconnectReason } = require('@whiskeysockets/baileys');
const { useFirebaseAuthState } = require('./firebaseAuthState');
const { FieldValue } = require('firebase-admin/firestore');
const qrcode = require('qrcode');
const pino = require('pino');

const sessions = new Map(); // Store active sockets
const qrCodes = new Map();  // Store latest QR code per user
const connectionStates = new Map(); // Store connection state (connecting, open, close)

async function startWhatsAppSession(userId, db) {
    if (sessions.has(userId) && connectionStates.get(userId) === 'open') {
        return { status: 'already_connected' };
    }

    const { state, saveCreds } = await useFirebaseAuthState(db, userId);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }),
        browser: ['AutoMsgElite', 'Chrome', '1.0.0']
    });

    sessions.set(userId, sock);
    connectionStates.set(userId, 'connecting');

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            try {
                const qrDataURL = await qrcode.toDataURL(qr);
                qrCodes.set(userId, qrDataURL);
            } catch (err) {
                console.error('QR Generate Error:', err);
            }
        }

        if (connection === 'close') {
            const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log(`Connection closed for user ${userId}. Reconnecting: ${shouldReconnect}`);
            connectionStates.set(userId, 'closed');
            if (shouldReconnect) {
                setTimeout(() => startWhatsAppSession(userId, db), 5000);
            } else {
                // Logged out
                sessions.delete(userId);
                qrCodes.delete(userId);
                connectionStates.delete(userId);
                // We should also delete the firebase auth data here ideally, 
                // but the user can just re-scan to overwrite.
            }
        } else if (connection === 'open') {
            console.log(`Connection opened for user ${userId}`);
            connectionStates.set(userId, 'open');
            qrCodes.delete(userId); // clear QR code once connected
        }
    });

    // Track Message Receipts (Delivered & Read)
    sock.ev.on('messages.update', async (updates) => {
        try {
            let delivered = 0;
            let read = 0;
            for (const { update } of updates) {
                if (update.status === 3) delivered++; // DELIVERY_ACK
                if (update.status === 4) read++; // READ
            }
            if (delivered > 0 || read > 0) {
                const updatesObj = {};
                if (delivered > 0) updatesObj.delivered = FieldValue.increment(delivered);
                if (read > 0) updatesObj.read = FieldValue.increment(read);
                await db.collection('stats').doc(userId).set(updatesObj, { merge: true });
            }
        } catch (err) {
            console.error('Failed to update receipt stats:', err);
        }
    });

    // Handle incoming messages for Chatbot and Replies
    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            let newReplies = 0;
            for (const msg of m.messages) {
                if (!msg.key.fromMe && msg.message) {
                    newReplies++;
                    const textMessage = msg.message.conversation || msg.message.extendedTextMessage?.text;
                    const from = msg.key.remoteJid;
                    
                    if (textMessage) {
                        // Check Chatbot config
                        try {
                            const chatbotDoc = await db.collection('chatbots').doc(userId).get();
                            if (chatbotDoc.exists) {
                                const config = chatbotDoc.data();
                                if (config.dmEnabled && config.dmMessage) {
                                    await sock.sendMessage(from, { text: config.dmMessage });
                                }
                            }
                        } catch(err) {
                            console.error('Chatbot reply error:', err);
                        }
                    }
                }
            }
            if (newReplies > 0) {
                try {
                    await db.collection('stats').doc(userId).set({
                        replies: FieldValue.increment(newReplies)
                    }, { merge: true });
                } catch (err) {}
            }
        }
    });

    return { status: 'starting' };
}

async function getSessionStatus(userId) {
    return {
        status: connectionStates.get(userId) || 'disconnected',
        qr: qrCodes.get(userId) || null
    };
}

async function sendWhatsAppMessage(userId, to, message, templateData = null) {
    const sock = sessions.get(userId);
    if (!sock || connectionStates.get(userId) !== 'open') {
        throw new Error('WhatsApp is not connected. Please scan QR code first.');
    }
    // Baileys needs the number in format 1234567890@s.whatsapp.net
    const formattedTo = to.includes('@s.whatsapp.net') ? to : `${to}@s.whatsapp.net`;
    
    if (templateData) {
        let payload = { text: templateData.message || message };
        const msgText = templateData.message || message || '';
        
        if (templateData.type === 'image' && templateData.mediaUrl) {
            payload = { image: { url: templateData.mediaUrl }, caption: msgText };
        } else if (templateData.type === 'video' && templateData.mediaUrl) {
            payload = { video: { url: templateData.mediaUrl }, caption: msgText };
        } else if (templateData.type === 'document' && templateData.mediaUrl) {
            payload = { document: { url: templateData.mediaUrl }, mimetype: 'application/pdf', fileName: 'Document.pdf', caption: msgText };
        }
        
        // Add Button fallbacks as text
        if (templateData.buttons && templateData.buttons.length > 0) {
            let btnText = "\n\n";
            templateData.buttons.forEach(b => {
                if (b.type === 'url') btnText += `🔗 ${b.text}: ${b.value}\n`;
                else if (b.type === 'call') btnText += `📞 ${b.text}: ${b.value}\n`;
                else btnText += `▶️ ${b.text}\n`;
            });
            if (payload.text) payload.text += btnText;
            if (payload.caption) payload.caption += btnText;
        }

        await sock.sendMessage(formattedTo, payload);
    } else {
        await sock.sendMessage(formattedTo, { text: message });
    }
}

async function logoutWhatsApp(userId) {
    const sock = sessions.get(userId);
    if (sock) {
        sock.logout();
        sessions.delete(userId);
        connectionStates.delete(userId);
        qrCodes.delete(userId);
    }
}

module.exports = {
    startWhatsAppSession,
    getSessionStatus,
    sendWhatsAppMessage,
    logoutWhatsApp,
    sessions
};
