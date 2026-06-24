const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function useFirebaseAuthState(db, userId) {
    const sessionRef = db.collection('whatsapp_sessions').doc(userId);

    const writeData = async (data, id) => {
        try {
            const safeId = encodeURIComponent(id);
            const dataString = JSON.stringify(data, BufferJSON.replacer);
            const dataObj = JSON.parse(dataString);
            await sessionRef.collection('keys').doc(safeId).set(dataObj);
        } catch (error) {
            console.error('Error writing auth data to Firebase:', error);
        }
    };

    const readData = async (id) => {
        try {
            const safeId = encodeURIComponent(id);
            const doc = await sessionRef.collection('keys').doc(safeId).get();
            if (doc.exists) {
                const dataObj = doc.data();
                const dataString = JSON.stringify(dataObj);
                return JSON.parse(dataString, BufferJSON.reviver);
            }
            return null;
        } catch (error) {
            console.error('Error reading auth data from Firebase:', error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            const safeId = encodeURIComponent(id);
            await sessionRef.collection('keys').doc(safeId).delete();
        } catch (error) {
            console.error('Error removing auth data from Firebase:', error);
        }
    };

    // Load initial creds
    let creds = await readData('creds');
    if (!creds) {
        creds = initAuthCreds();
        await writeData(creds, 'creds');
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = BufferJSON.reviver('', value);
                            }
                            if (value) {
                                data[id] = value;
                            }
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category of Object.keys(data)) {
                        for (const id of Object.keys(data[category])) {
                            const value = data[category][id];
                            const keyId = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, keyId));
                            } else {
                                tasks.push(removeData(keyId));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
}

module.exports = { useFirebaseAuthState };
