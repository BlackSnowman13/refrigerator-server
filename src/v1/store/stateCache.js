const WebSocket = require('ws');
const logger = require('../../utils/logger');
const {
  normalizeMacHex,
  encodeDeviceInfoUpdate,
  encodeSubscribeRelay,
  encodeUnsubscribeRelay
} = require('../protocol/binaryProtocol');

/**
 * In-Memory State & Subscription Bus for v1 (Stateless Sensor Relay).
 *
 * Notice: Per protocol specification, the server does NOT store sensor register values in RAM.
 * Instead, it maintains:
 * 1. Registered ESP32 Devices (`this.devices`: Map<deviceMac, DeviceEntry>)
 * 2. Known User Emails (`this.users`: Set<email>)
 * 3. Active Web Client Sockets (`this.clients`: Map<socketId, ClientEntry>)
 *    - Each Web Client can subscribe to at most ONE ESP32 device at a time (`client.subscribedDeviceMac`).
 */
class StateCache {
  constructor(firebaseStore) {
    this.firebaseStore = firebaseStore;
    this.devices = new Map(); // Map<16-char uppercase hex MAC, DeviceEntry>
    this.users = new Set();   // Set<lowercase email>
    this.clients = new Map(); // Map<socketId, ClientEntry>
  }

  getAdminEmailSet() {
    const raw = process.env.ADMIN_EMAILS || process.env.ADMIN_EMAIL || '';
    const emails = raw
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);
    return new Set(emails);
  }

  isEmailAdmin(email) {
    if (!email) return false;
    return this.getAdminEmailSet().has(String(email).trim().toLowerCase());
  }

  /**
   * Warm the in-memory device & user registries from Firestore on server startup.
   */
  async hydrateFromFirebase() {
    for (const adminEmail of this.getAdminEmailSet()) {
      this.users.add(adminEmail);
    }

    const deviceRecords = await this.firebaseStore.loadAllDevices();
    for (const rec of deviceRecords) {
      this.upsertDeviceInMemory(rec.deviceMac, rec);
      if (Array.isArray(rec.assignedUsers)) {
        for (const email of rec.assignedUsers) {
          this.users.add(email.toLowerCase());
        }
      }
    }

    try {
      const userRecords = await this.firebaseStore.loadAllUsers();
      for (const u of userRecords) {
        if (u.email) {
          this.users.add(u.email.toLowerCase());
        }
        if (Array.isArray(u.assignedDevices)) {
          for (const mac of u.assignedDevices) {
            const dev = this.devices.get(mac);
            if (dev) {
              dev.assignedUsers.add(u.email.toLowerCase());
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[v1/StateCache] Failed to load users collection from Firestore: ${err.message}`);
    }

    logger.info(
      `[v1/StateCache] Hydrated ${this.devices.size} devices and ${this.users.size} users from Firestore`
    );
  }

  upsertDeviceInMemory(deviceMacInput, record = {}) {
    const deviceMac = normalizeMacHex(deviceMacInput);
    const existing = this.devices.get(deviceMac);

    const assignedList = Array.isArray(record.assignedUsers)
      ? record.assignedUsers.map((e) => String(e).trim().toLowerCase()).filter(Boolean)
      : existing
        ? Array.from(existing.assignedUsers)
        : [];

    for (const email of assignedList) {
      this.users.add(email);
    }

    const entry = {
      deviceMac,
      name: record.name !== undefined ? String(record.name).trim() || deviceMac : (existing?.name || deviceMac),
      assignedUsers: new Set(assignedList),
      firmwareVersion:
        record.firmwareVersion !== undefined
          ? String(record.firmwareVersion)
          : (existing?.firmwareVersion || ''),
      online: existing?.online || false,
      socket: existing?.socket || null,
      lastSeen: existing?.lastSeen || null,
      subscribers: existing?.subscribers || new Set() // Set<WebSocket>
    };

    this.devices.set(deviceMac, entry);
    return entry;
  }

  getDevice(deviceMacInput) {
    try {
      const deviceMac = normalizeMacHex(deviceMacInput);
      return this.devices.get(deviceMac) || null;
    } catch (_) {
      return null;
    }
  }

  getAllDevices() {
    const list = [];
    for (const entry of this.devices.values()) {
      list.push({
        deviceMac: entry.deviceMac,
        online: entry.online ? 1 : 0,
        name: entry.name
      });
    }
    return list;
  }

  getAllUserEmails() {
    for (const adminEmail of this.getAdminEmailSet()) {
      this.users.add(adminEmail);
    }
    return Array.from(this.users).sort();
  }

  registerUserEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (normalized) {
      this.users.add(normalized);
    }
    return normalized;
  }

  /**
   * Delete an ESP32 from memory, close its active socket if connected, and clear any web subscriptions to it.
   */
  removeDeviceInMemory(deviceMacInput) {
    const entry = this.getDevice(deviceMacInput);
    if (!entry) return null;

    // Clear subscriptions of any web clients watching this device
    for (const clientSocket of entry.subscribers) {
      const client = this.clients.get(clientSocket.id);
      if (client && client.subscribedDeviceMac === entry.deviceMac) {
        client.subscribedDeviceMac = null;
      }
    }
    entry.subscribers.clear();

    if (entry.socket && entry.socket.readyState === WebSocket.OPEN) {
      entry.socket.close(4004, 'Device unregistered by admin');
    }

    this.devices.delete(entry.deviceMac);
    return entry;
  }

  /**
   * Rename a device in memory and broadcast Clientbound 0x06 Device info update to all authorized connected Web Clients.
   */
  renameDeviceInMemory(deviceMacInput, newName) {
    const entry = this.getDevice(deviceMacInput);
    if (!entry) return null;

    entry.name = String(newName || '').trim() || entry.deviceMac;
    this.broadcastDeviceInfoUpdate(entry);
    return entry;
  }

  /**
   * Mark an authenticated ESP32 online, bind its live WebSocket, and notify authorized Web Clients.
   * If a Web Client is already subscribed to this ESP32, immediately send 0x01 Subscribe relay to the ESP32.
   */
  setDeviceOnline(deviceMacInput, socket, firmwareVersion = '') {
    const deviceMac = normalizeMacHex(deviceMacInput);
    const entry = this.devices.get(deviceMac);
    if (!entry) return null;

    if (entry.socket && entry.socket !== socket && entry.socket.readyState === WebSocket.OPEN) {
      logger.warn(`[v1/StateCache] Replacing existing socket for ESP32 ${deviceMac}`);
      entry.socket.close(4002, 'Duplicate connection replaced');
    }

    entry.online = true;
    entry.socket = socket;
    entry.lastSeen = Date.now();
    if (firmwareVersion) {
      entry.firmwareVersion = firmwareVersion;
    }

    this.broadcastDeviceInfoUpdate(entry);

    // If one or more Web Clients are already subscribed to this ESP32, tell it to send a dump
    if (entry.subscribers.size > 0 && socket.readyState === WebSocket.OPEN) {
      socket.send(encodeSubscribeRelay(), { binary: true });
    }

    return entry;
  }

  /**
   * Mark an ESP32 offline when its socket disconnects and notify authorized Web Clients.
   */
  setDeviceOffline(deviceMacInput, disconnectedSocket = null) {
    const entry = this.getDevice(deviceMacInput);
    if (!entry) return;

    if (disconnectedSocket && entry.socket && entry.socket !== disconnectedSocket) {
      return;
    }

    entry.online = false;
    entry.socket = null;
    entry.lastSeen = Date.now();

    this.broadcastDeviceInfoUpdate(entry);
  }

  /**
   * Send Clientbound 0x06 Device info update to all connected Web Clients who have access to this device.
   */
  broadcastDeviceInfoUpdate(deviceEntry) {
    const frame = encodeDeviceInfoUpdate([
      {
        deviceMac: deviceEntry.deviceMac,
        online: deviceEntry.online ? 1 : 0,
        name: deviceEntry.name
      }
    ]);

    for (const client of this.clients.values()) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (client.isAdmin || deviceEntry.assignedUsers.has(client.email)) {
        client.socket.send(frame, { binary: true });
      }
    }
  }

  canUserAccessDevice(email, isAdmin, deviceMacInput) {
    const entry = this.getDevice(deviceMacInput);
    if (!entry) return false;
    if (isAdmin) return true;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    return entry.assignedUsers.has(normalizedEmail);
  }

  /**
   * Get all devices visible to a given user (admins see all registered devices; normal users see assigned devices).
   */
  getDevicesForUser(email, isAdmin = false) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const list = [];

    for (const entry of this.devices.values()) {
      if (isAdmin || entry.assignedUsers.has(normalizedEmail)) {
        list.push({
          deviceMac: entry.deviceMac,
          online: entry.online ? 1 : 0,
          name: entry.name
        });
      }
    }

    return list;
  }

  /**
   * Get devices strictly assigned to a specific user (used in Admin 0x0B Admin user details response).
   */
  getAssignedDevicesForEmail(email) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const list = [];

    for (const entry of this.devices.values()) {
      if (entry.assignedUsers.has(normalizedEmail)) {
        list.push({
          deviceMac: entry.deviceMac,
          online: entry.online ? 1 : 0,
          name: entry.name
        });
      }
    }

    return list;
  }

  addClient(socket, email, isAdmin = false) {
    const normalizedEmail = this.registerUserEmail(email);
    this.clients.set(socket.id, {
      socket,
      email: normalizedEmail,
      isAdmin: Boolean(isAdmin),
      subscribedDeviceMac: null
    });
  }

  getClient(socket) {
    return this.clients.get(socket.id) || null;
  }

  /**
   * Remove a web client socket on disconnect and send 0x02 Unsubscribe relay to its subscribed ESP32 if it was the last subscriber.
   */
  removeClient(socket) {
    this.unsubscribeClient(socket);
    this.clients.delete(socket.id);
  }

  /**
   * Subscribe a Web Client to a single ESP32 device.
   * Automatically unsubscribes from any previously subscribed device.
   * Forwards Clientbound 0x01 Subscribe relay to the ESP32 if online.
   */
  subscribeClient(socket, deviceMacInput) {
    const client = this.clients.get(socket.id);
    const device = this.getDevice(deviceMacInput);
    if (!client || !device) return null;

    // Single-device subscription rule: unsubscribe from previous device if different
    if (client.subscribedDeviceMac && client.subscribedDeviceMac !== device.deviceMac) {
      this.unsubscribeClient(socket);
    }

    client.subscribedDeviceMac = device.deviceMac;
    device.subscribers.add(socket);

    // Always forward 0x01 Subscribe relay to the ESP32 so the new subscriber receives a fresh full dump
    if (device.online && device.socket && device.socket.readyState === WebSocket.OPEN) {
      device.socket.send(encodeSubscribeRelay(), { binary: true });
    }

    return device;
  }

  /**
   * Unsubscribe a Web Client from its currently subscribed ESP32 device.
   * If no Web Clients remain subscribed to that ESP32, send Clientbound 0x02 Unsubscribe relay to the ESP32.
   */
  unsubscribeClient(socket) {
    const client = this.clients.get(socket.id);
    if (!client || !client.subscribedDeviceMac) return null;

    const prevMac = client.subscribedDeviceMac;
    client.subscribedDeviceMac = null;

    const device = this.devices.get(prevMac);
    if (!device) return null;

    device.subscribers.delete(socket);

    if (device.subscribers.size === 0 && device.online && device.socket && device.socket.readyState === WebSocket.OPEN) {
      device.socket.send(encodeUnsubscribeRelay(), { binary: true });
    }

    return device;
  }

  /**
   * Broadcast a binary frame to all Web Clients currently subscribed to the specified ESP32.
   */
  broadcastBinaryToSubscribers(deviceMacInput, frameBuffer) {
    const device = this.getDevice(deviceMacInput);
    if (!device || device.subscribers.size === 0) return;

    for (const clientSocket of device.subscribers) {
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(frameBuffer, { binary: true });
      }
    }
  }
}

module.exports = StateCache;
