const admin = require('firebase-admin');
const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const logger = require('../../utils/logger');
const { normalizeMacHex } = require('../protocol/binaryProtocol');

class FirebaseStore {
  constructor() {
    this.db = null;
    this.auth = null;
    this.initialized = false;
    this.devicesCollection = process.env.FIREBASE_DEVICES_COLLECTION || 'devices';
    this.usersCollection = process.env.FIREBASE_USERS_COLLECTION || 'users';
  }

  loadServiceAccountFromEnv() {
    // Option 1: Full JSON string (or Base64 encoded JSON) in FIREBASE_SERVICE_ACCOUNT_JSON
    if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON.trim();
      const jsonStr = raw.startsWith('{')
        ? raw
        : Buffer.from(raw, 'base64').toString('utf8');
      return JSON.parse(jsonStr);
    }

    // Option 2: Individual env vars (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY)
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY
      ? process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      : undefined;

    if (projectId && clientEmail && privateKey) {
      return {
        projectId,
        clientEmail,
        privateKey
      };
    }

    throw new Error(
      '[v1/FirebaseStore] Missing Firebase credentials in .env. ' +
      'Provide FIREBASE_SERVICE_ACCOUNT_JSON or (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY).'
    );
  }

  async initialize() {
    if (this.initialized) return;

    const serviceAccount = this.loadServiceAccountFromEnv();

    if (!getApps().length) {
      initializeApp({
        credential: cert(serviceAccount),
        projectId: serviceAccount.projectId || serviceAccount.project_id
      });
    }

    this.db = getFirestore();
    this.auth = getAuth();
    this.initialized = true;

    logger.info('[v1/FirebaseStore] Connected to Firebase Auth & Firestore');
  }

  /**
   * Load all registered devices from Firestore on startup to warm the in-memory cache.
   * Document ID = canonical 16-char uppercase hex MAC string (e.g. "0000A4CF1289B304")
   */
  async loadAllDevices() {
    const snapshot = await this.db.collection(this.devicesCollection).get();
    const devices = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      let deviceMac;
      try {
        deviceMac = normalizeMacHex(data.deviceMac || data.deviceId || doc.id);
      } catch (_) {
        logger.warn(`[v1/FirebaseStore] Skipping device doc with invalid MAC id: "${doc.id}"`);
        return;
      }
      devices.push({
        deviceMac,
        docId: doc.id,
        name: data.name || deviceMac,
        assignedUsers: Array.isArray(data.assignedUsers)
          ? data.assignedUsers.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
          : [],
        firmwareVersion: data.firmwareVersion || data.deviceInfo?.firmwareVersion || '',
        createdAt: data.createdAt || null,
        updatedAt: data.updatedAt || null
      });
    });
    return devices;
  }

  /**
   * Load all known users from Firestore on startup.
   */
  async loadAllUsers() {
    const snapshot = await this.db.collection(this.usersCollection).get();
    const users = [];
    snapshot.forEach((doc) => {
      const data = doc.data();
      const email = String(data.email || doc.id || '').trim().toLowerCase();
      if (email) {
        users.push({
          email,
          assignedDevices: Array.isArray(data.assignedDevices)
            ? data.assignedDevices.map((m) => {
                try { return normalizeMacHex(m); } catch (_) { return null; }
              }).filter(Boolean)
            : []
        });
      }
    });
    return users;
  }

  /**
   * Ensure a user email document exists in Firestore when they sign in.
   */
  async ensureUser(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) return;
    const now = new Date().toISOString();
    const userRef = this.db.collection(this.usersCollection).doc(normalizedEmail);
    await userRef.set(
      {
        email: normalizedEmail,
        updatedAt: now
      },
      { merge: true }
    );
  }

  /**
   * Create or update a device record in Firestore.
   */
  async upsertDevice(deviceMacInput, deviceData = {}) {
    const deviceMac = normalizeMacHex(deviceMacInput);
    const now = new Date().toISOString();
    const docRef = this.db.collection(this.devicesCollection).doc(deviceMac);
    const payload = {
      ...deviceData,
      deviceMac,
      deviceId: deviceMac,
      updatedAt: now
    };
    await docRef.set(payload, { merge: true });
    return payload;
  }

  /**
   * Delete/unregister a device record from Firestore and remove it from any assigned user documents.
   */
  async deleteDevice(deviceMacInput, assignedEmails = []) {
    const deviceMac = normalizeMacHex(deviceMacInput);
    const batch = this.db.batch();
    const deviceRef = this.db.collection(this.devicesCollection).doc(deviceMac);
    batch.delete(deviceRef);

    for (const email of assignedEmails) {
      const normalizedEmail = String(email || '').trim().toLowerCase();
      if (!normalizedEmail) continue;
      const userRef = this.db.collection(this.usersCollection).doc(normalizedEmail);
        batch.set(
          userRef,
          {
            assignedDevices: FieldValue.arrayRemove(deviceMac),
            updatedAt: new Date().toISOString()
          },
          { merge: true }
        );
      }

      await batch.commit();
    }

    /**
     * Update the user-friendly display name of an ESP32 device in Firestore.
     */
    async renameDevice(deviceMacInput, newName) {
      const deviceMac = normalizeMacHex(deviceMacInput);
      const cleanName = String(newName || '').trim() || deviceMac;
      const now = new Date().toISOString();
      const docRef = this.db.collection(this.devicesCollection).doc(deviceMac);
      await docRef.set({ name: cleanName, updatedAt: now }, { merge: true });
      return cleanName;
    }

    /**
     * Assign an ESP32 deviceMac to a user email (persisted in both devices and users collections).
     */
    async assignDeviceToUser(deviceMacInput, email) {
      const deviceMac = normalizeMacHex(deviceMacInput);
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const now = new Date().toISOString();

      const deviceRef = this.db.collection(this.devicesCollection).doc(deviceMac);
      const userRef = this.db.collection(this.usersCollection).doc(normalizedEmail);

      await this.db.runTransaction(async (tx) => {
        const deviceDoc = await tx.get(deviceRef);
        if (!deviceDoc.exists) {
          throw new Error(`Device ${deviceMac} does not exist in Firestore`);
        }

        tx.set(
          deviceRef,
          {
            assignedUsers: FieldValue.arrayUnion(normalizedEmail),
            updatedAt: now
          },
          { merge: true }
        );

        tx.set(
          userRef,
          {
            email: normalizedEmail,
            assignedDevices: FieldValue.arrayUnion(deviceMac),
            updatedAt: now
          },
          { merge: true }
        );
      });
    }

    /**
     * Unassign an ESP32 deviceMac from a user email.
     */
    async unassignDeviceFromUser(deviceMacInput, email) {
      const deviceMac = normalizeMacHex(deviceMacInput);
      const normalizedEmail = String(email || '').trim().toLowerCase();
      const now = new Date().toISOString();

      const deviceRef = this.db.collection(this.devicesCollection).doc(deviceMac);
      const userRef = this.db.collection(this.usersCollection).doc(normalizedEmail);

      await this.db.runTransaction(async (tx) => {
        tx.set(
          deviceRef,
          {
            assignedUsers: FieldValue.arrayRemove(normalizedEmail),
            updatedAt: now
          },
          { merge: true }
        );

        tx.set(
          userRef,
          {
            assignedDevices: FieldValue.arrayRemove(deviceMac),
            updatedAt: now
          },
          { merge: true }
        );
      });
    }

  /**
   * Verify a Firebase / Google OAuth ID Token and return decoded user info.
   */
  async verifyIdToken(idToken) {
    return await this.auth.verifyIdToken(idToken);
  }
}

module.exports = FirebaseStore;
