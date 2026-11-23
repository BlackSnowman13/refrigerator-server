const WebSocket = require('ws');
const crypto = require('crypto');
const logger = require('../utils/logger');
const otaService = require('../utils/otaService');
const FirebaseStore = require('./store/firebaseStore');
const StateCache = require('./store/stateCache');
const ESP32HmacAuth = require('./auth/esp32Hmac');
const GoogleClientAuth = require('./auth/googleAuth');
const {
  CONNECTION_STATES,
  DEVICE_TYPES,
  AUTH_SERVERBOUND,
  AUTH_CODES,
  DATA_SERVERBOUND,
  readMacHex,
  readString,
  readRegister,
  readEntryArray,
  decodePacketHeader,
  encodeAuthChallenge,
  encodeAuthResponse,
  decodeAuthProtocolVersion,
  decodeAuthChallengeResponse,
  encodeUserInfoResponse,
  encodeSensorDumpRelay,
  encodeSensorDeltaRelay,
  encodeWriteRelay,
  encodeWriteResponseRelay,
  encodeOtaInfo,
  encodeOtaRelay,
  encodeAdminListUsersResponse,
  encodeAdminUserDetailsResponse,
  encodeAdminDeviceRegisteredResponse,
  encodeAdminListDevicesResponse,
  encodeAdminDeviceDetailsResponse
} = require('./protocol/binaryProtocol');

class V1Server {
  constructor(options = {}) {
    this.pingIntervalMs = parseInt(process.env.WS_PING_INTERVAL) || 30000;
    this.authTimeoutMs = parseInt(process.env.V1_AUTH_TIMEOUT_MS) || 10000;

    // Standalone noServer WebSocket instance routed via HTTP upgrade on '/v1'
    this.wss = new WebSocket.Server({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: 64 * 1024 // 64 KB max frame size
    });

    this.legacyEsp32Handler = options.legacyEsp32Handler || null;
    this.firebaseStore = options.firebaseStore || new FirebaseStore();
    this.stateCache = options.stateCache || new StateCache(this.firebaseStore);
    this.esp32Auth = new ESP32HmacAuth(this.stateCache, this.firebaseStore);
    this.googleAuth = new GoogleClientAuth(this.stateCache, this.firebaseStore);

    this.setupSocketHandlers();
    this.startPingInterval();
  }

  async initialize() {
    await this.firebaseStore.initialize();
    await this.stateCache.hydrateFromFirebase();
    logger.info('[v1] Pure Binary WebSocket server initialized (path: /v1)');
  }

  handleUpgrade(request, socket, head) {
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  setupSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      ws.id = crypto.randomBytes(8).toString('hex');
      ws.isAlive = true;
      ws.connectionState = CONNECTION_STATES.AUTH;
      ws.isAuthenticated = false;
      ws.clientType = null; // 'esp32' | 'web'
      ws.isAdmin = false;

      logger.info(`[v1] Socket connected: ${ws.id} from ${req.socket.remoteAddress}`);

      // 10-second authentication timeout in auth (0) state
      ws.authTimer = setTimeout(() => {
        if (ws.connectionState === CONNECTION_STATES.AUTH) {
          logger.warn(`[v1] Socket ${ws.id} timed out in auth (0) state`);
          this.sendBinary(ws, encodeAuthResponse(AUTH_CODES.TIMEOUT));
          ws.close(4001, 'Authentication timeout');
        }
      }, this.authTimeoutMs);

      ws.on('pong', () => {
        ws.isAlive = true;
      });

      ws.on('message', (rawMessage, isBinary) => {
        ws.isAlive = true;
        this.handleFrame(ws, rawMessage, isBinary);
      });

      ws.on('close', () => {
        if (ws.authTimer) {
          clearTimeout(ws.authTimer);
          ws.authTimer = null;
        }
        if (ws.clientType === 'esp32' && ws.deviceMac) {
          this.stateCache.setDeviceOffline(ws.deviceMac, ws);
        } else if (ws.clientType === 'web') {
          this.stateCache.removeClient(ws);
        }
        logger.info(`[v1] Socket closed: ${ws.id}`);
      });

      ws.on('error', (err) => {
        logger.error(`[v1] Socket error on ${ws.id}:`, err);
      });
    });
  }

  async handleFrame(ws, rawMessage, isBinary) {
    if (!isBinary || !Buffer.isBuffer(rawMessage)) {
      if (ws.connectionState === CONNECTION_STATES.AUTH) {
        this.sendBinary(ws, encodeAuthResponse(AUTH_CODES.MALFORMED_PACKET));
        ws.close(4003, 'Malformed packet');
      }
      return;
    }

    let packet;
    try {
      packet = decodePacketHeader(rawMessage);
    } catch (err) {
      logger.warn(`[v1] Malformed packet header on socket ${ws.id}: ${err.message}`);
      if (ws.connectionState === CONNECTION_STATES.AUTH) {
        this.sendBinary(ws, encodeAuthResponse(AUTH_CODES.MALFORMED_PACKET));
        ws.close(4003, 'Malformed packet');
      }
      return;
    }

    try {
      if (ws.connectionState === CONNECTION_STATES.AUTH) {
        await this.handleAuthPacket(ws, packet);
      } else if (ws.connectionState === CONNECTION_STATES.DATA) {
        await this.handleDataPacket(ws, packet);
      }
    } catch (err) {
      logger.error(
        `[v1] Error handling packet 0x${packet.protocolCode.toString(16)} in state ${ws.connectionState} on socket ${ws.id}:`,
        err
      );
      if (ws.connectionState === CONNECTION_STATES.AUTH) {
        this.sendBinary(ws, encodeAuthResponse(AUTH_CODES.MALFORMED_PACKET));
        ws.close(4003, 'Authentication error');
      }
    }
  }

  // ============================================================================
  // Connection State 0: AUTH Protocols
  // ============================================================================

  async handleAuthPacket(ws, { protocolCode, payload }) {
    switch (protocolCode) {
      case AUTH_SERVERBOUND.PROTOCOL_VERSION: {
        let parsed;
        try {
          parsed = decodeAuthProtocolVersion(payload);
        } catch (err) {
          logger.warn(`[v1/Auth] Malformed 0x00 Protocol version on ${ws.id}: ${err.message}`);
          this.sendBinary(ws, encodeAuthResponse(AUTH_CODES.MALFORMED_PACKET));
          ws.close(4003, 'Malformed Protocol version packet');
          return;
        }

        if (parsed.deviceType === DEVICE_TYPES.ESP32) {
          const res = this.esp32Auth.handleEsp32ProtocolVersion(ws, parsed);
          if (!res.success) {
            this.sendBinary(ws, encodeAuthResponse(res.authCode));
            ws.close(4003, 'ESP32 authentication rejected');
            return;
          }
          // Send Clientbound 0x00 Challenge (16B Nonce)
          this.sendBinary(ws, encodeAuthChallenge(res.nonce));
        } else if (parsed.deviceType === DEVICE_TYPES.WEB) {
          const res = await this.googleAuth.verifyWebProtocolVersion(ws, parsed);
          this.sendBinary(ws, encodeAuthResponse(res.authCode));
          if (!res.success) {
            ws.close(4003, 'Web authentication rejected');
          }
        }
        break;
      }

      case AUTH_SERVERBOUND.CHALLENGE_RESPONSE: {
        let parsed;
        try {
          parsed = decodeAuthChallengeResponse(payload);
        } catch (err) {
          logger.warn(`[v1/Auth] Malformed 0x01 Challenge Response on ${ws.id}: ${err.message}`);
          this.sendBinary(ws, encodeAuthResponse(AUTH_CODES.MALFORMED_PACKET));
          ws.close(4003, 'Malformed Challenge Response');
          return;
        }

        const res = await this.esp32Auth.verifyChallengeResponse(ws, parsed.responseHmac);
        this.sendBinary(ws, encodeAuthResponse(res.authCode));
        if (!res.success) {
          ws.close(4003, 'ESP32 HMAC challenge verification failed');
        }
        break;
      }

      default: {
        logger.warn(`[v1/Auth] Unexpected protocol code 0x${protocolCode.toString(16)} in auth state on ${ws.id}`);
        this.sendBinary(ws, encodeAuthResponse(AUTH_CODES.MALFORMED_PACKET));
        ws.close(4003, 'Invalid auth protocol code');
        break;
      }
    }
  }

  // ============================================================================
  // Connection State 1: DATA Protocols
  // ============================================================================

  async handleDataPacket(ws, { protocolCode, payload }) {
    if (ws.clientType === 'esp32') {
      await this.handleEsp32DataPacket(ws, protocolCode, payload);
    } else if (ws.clientType === 'web') {
      await this.handleWebDataPacket(ws, protocolCode, payload);
    }
  }

  /**
   * Handle Data State Serverbound packets from an authenticated ESP32 (`0x03`, `0x04`, `0x06`).
   */
  async handleEsp32DataPacket(ws, protocolCode, payload) {
    const deviceMac = ws.deviceMac;
    if (!deviceMac) return;

    switch (protocolCode) {
      // 0x03 Sensor dump (ESP32 only) -> Relay as Clientbound 0x03 Sensor dump relay to subscribed Web Clients
      case DATA_SERVERBOUND.SENSOR_DUMP: {
        const { nextOffset, rawSlice } = readEntryArray(payload, 0, readRegister);
        if (nextOffset !== payload.length) {
          logger.warn(`[v1/Data] Trailing bytes in 0x03 Sensor dump from ESP32 ${deviceMac}`);
          return;
        }
        const relayFrame = encodeSensorDumpRelay(rawSlice);
        this.stateCache.broadcastBinaryToSubscribers(deviceMac, relayFrame);
        break;
      }

      // 0x04 Sensor delta (ESP32 only) -> Relay as Clientbound 0x04 Sensor delta relay to subscribed Web Clients
      case DATA_SERVERBOUND.SENSOR_DELTA: {
        const { nextOffset, rawSlice } = readEntryArray(payload, 0, readRegister);
        if (nextOffset !== payload.length) {
          logger.warn(`[v1/Data] Trailing bytes in 0x04 Sensor delta from ESP32 ${deviceMac}`);
          return;
        }
        const relayFrame = encodeSensorDeltaRelay(rawSlice);
        this.stateCache.broadcastBinaryToSubscribers(deviceMac, relayFrame);
        break;
      }

      // 0x06 Write response (ESP32 only) -> Relay as Clientbound 0x07 Write response relay to subscribed Web Clients
      case DATA_SERVERBOUND.WRITE_RESPONSE: {
        const succeededArr = readEntryArray(payload, 0, readRegister);
        const failedArr = readEntryArray(payload, succeededArr.nextOffset, readRegister);
        if (failedArr.nextOffset !== payload.length) {
          logger.warn(`[v1/Data] Trailing bytes in 0x06 Write response from ESP32 ${deviceMac}`);
          return;
        }
        const relayFrame = encodeWriteResponseRelay(payload);
        this.stateCache.broadcastBinaryToSubscribers(deviceMac, relayFrame);
        break;
      }

      default:
        logger.warn(`[v1/Data] Unknown ESP32 data protocol code 0x${protocolCode.toString(16)} from ${deviceMac}`);
        break;
    }
  }

  /**
   * Handle Data State Serverbound packets from an authenticated Web Client (`0x00`..`0x02`, `0x05`, `0x07`..`0x10`).
   */
  async handleWebDataPacket(ws, protocolCode, payload) {
    switch (protocolCode) {
      // 0x00 User info request (Web only)
      case DATA_SERVERBOUND.USER_INFO_REQUEST: {
        const devices = this.stateCache.getDevicesForUser(ws.email, ws.isAdmin);
        this.sendBinary(
          ws,
          encodeUserInfoResponse({
            isAdmin: ws.isAdmin,
            email: ws.email,
            devices
          })
        );
        break;
      }

      // 0x01 Subscribe request (Web only)
      case DATA_SERVERBOUND.SUBSCRIBE_REQUEST: {
        if (payload.length !== 8) {
          logger.warn(`[v1/Data] Invalid 0x01 Subscribe request length (${payload.length}) from ${ws.email}`);
          return;
        }
        const deviceMac = readMacHex(payload, 0);
        if (!this.stateCache.canUserAccessDevice(ws.email, ws.isAdmin, deviceMac)) {
          logger.warn(`[v1/Data] Unauthorized subscribe request from ${ws.email} for device ${deviceMac}`);
          return;
        }

        const device = this.stateCache.subscribeClient(ws, deviceMac);
        if (device) {
          // Automatically push Clientbound 0x08 OTA info to the Web Client
          this.pushOtaInfoToWebClient(ws, device).catch((err) => {
            logger.debug(`[v1/OTA] Skipping automatic OTA info for ${deviceMac}: ${err.message}`);
          });
        }
        break;
      }

      // 0x02 Unsubscribe (Web only, 0 bytes payload)
      case DATA_SERVERBOUND.UNSUBSCRIBE: {
        this.stateCache.unsubscribeClient(ws);
        break;
      }

      // 0x05 Write Request (Web only) -> Relay as Clientbound 0x05 Write relay to subscribed ESP32
      case DATA_SERVERBOUND.WRITE_REQUEST: {
        const client = this.stateCache.getClient(ws);
        const deviceMac = client?.subscribedDeviceMac;
        if (!deviceMac) {
          logger.warn(`[v1/Data] 0x05 Write Request from ${ws.email} without an active subscription`);
          return;
        }

        const { nextOffset, rawSlice } = readEntryArray(payload, 0, readRegister);
        if (nextOffset !== payload.length) {
          logger.warn(`[v1/Data] Malformed 0x05 Write Request from ${ws.email}`);
          return;
        }

        const device = this.stateCache.getDevice(deviceMac);
        if (device && device.online && device.socket && device.socket.readyState === WebSocket.OPEN) {
          this.sendBinary(device.socket, encodeWriteRelay(rawSlice));
        }
        break;
      }

      // 0x07 OTA trigger (Web only, 0 bytes payload) -> Relay as Clientbound 0x09 OTA relay to subscribed ESP32
      case DATA_SERVERBOUND.OTA_TRIGGER: {
        const client = this.stateCache.getClient(ws);
        const deviceMac = client?.subscribedDeviceMac;
        if (!deviceMac) {
          logger.warn(`[v1/OTA] 0x07 OTA trigger from ${ws.email} without an active subscription`);
          return;
        }

        const device = this.stateCache.getDevice(deviceMac);
        if (!device || !device.online || !device.socket || device.socket.readyState !== WebSocket.OPEN) {
          logger.warn(`[v1/OTA] Cannot trigger OTA: ESP32 ${deviceMac} is offline`);
          return;
        }

        const { version, downloadUrl } = await otaService.resolvePreSignedDownloadUrl(true);
        this.sendBinary(device.socket, encodeOtaRelay({ version, downloadUrl }));
        logger.info(`[v1/OTA] Triggered OTA update (${version}) on ESP32 ${deviceMac} requested by ${ws.email}`);
        break;
      }

      // 0x0E Rename device (Web only)
      case DATA_SERVERBOUND.RENAME_DEVICE: {
        if (payload.length < 10) return;
        const deviceMac = readMacHex(payload, 0);
        const { value: newName, nextOffset } = readString(payload, 8);
        if (nextOffset !== payload.length) return;

        if (!this.stateCache.canUserAccessDevice(ws.email, ws.isAdmin, deviceMac)) {
          logger.warn(`[v1/Data] Unauthorized rename attempt by ${ws.email} on ${deviceMac}`);
          return;
        }

        const cleanName = await this.firebaseStore.renameDevice(deviceMac, newName);
        this.stateCache.renameDeviceInMemory(deviceMac, cleanName);
        logger.info(`[v1/Data] Device ${deviceMac} renamed to "${cleanName}" by ${ws.email}`);
        break;
      }

      // ========================================================================
      // Admin-Only Serverbound Protocols (0x08..0x0D, 0x0F..0x10)
      // ========================================================================

      case DATA_SERVERBOUND.ADMIN_LIST_USERS_REQ: {
        if (!ws.isAdmin) return;
        const emails = this.stateCache.getAllUserEmails();
        this.sendBinary(ws, encodeAdminListUsersResponse(emails));
        break;
      }

      case DATA_SERVERBOUND.ADMIN_USER_DETAILS_REQ: {
        if (!ws.isAdmin) return;
        const { value: targetEmail, nextOffset } = readString(payload, 0);
        if (nextOffset !== payload.length) return;

        const cleanEmail = targetEmail.trim().toLowerCase();
        const isTargetAdmin = this.stateCache.isEmailAdmin(cleanEmail);
        const devices = this.stateCache.getAssignedDevicesForEmail(cleanEmail);

        this.sendBinary(
          ws,
          encodeAdminUserDetailsResponse({
            email: cleanEmail,
            isAdmin: isTargetAdmin,
            devices
          })
        );
        break;
      }

      case DATA_SERVERBOUND.ADMIN_ASSIGN_DEVICE: {
        if (!ws.isAdmin) return;
        const { value: targetEmail, nextOffset } = readString(payload, 0);
        if (nextOffset + 8 !== payload.length) return;
        const deviceMac = readMacHex(payload, nextOffset);
        const cleanEmail = targetEmail.trim().toLowerCase();

        const device = this.stateCache.getDevice(deviceMac);
        if (!device) {
          logger.warn(`[v1/Admin] Cannot assign unregistered device ${deviceMac}`);
          return;
        }

        await this.firebaseStore.assignDeviceToUser(deviceMac, cleanEmail);
        device.assignedUsers.add(cleanEmail);
        this.stateCache.registerUserEmail(cleanEmail);

        // Notify the admin with updated user details and notify any online sessions of that user
        this.sendBinary(
          ws,
          encodeAdminUserDetailsResponse({
            email: cleanEmail,
            isAdmin: this.stateCache.isEmailAdmin(cleanEmail),
            devices: this.stateCache.getAssignedDevicesForEmail(cleanEmail)
          })
        );
        this.stateCache.broadcastDeviceInfoUpdate(device);
        logger.info(`[v1/Admin] Assigned ESP32 ${deviceMac} to ${cleanEmail} (by ${ws.email})`);
        break;
      }

      case DATA_SERVERBOUND.ADMIN_UNASSIGN_DEVICE: {
        if (!ws.isAdmin) return;
        const { value: targetEmail, nextOffset } = readString(payload, 0);
        if (nextOffset + 8 !== payload.length) return;
        const deviceMac = readMacHex(payload, nextOffset);
        const cleanEmail = targetEmail.trim().toLowerCase();

        await this.firebaseStore.unassignDeviceFromUser(deviceMac, cleanEmail);
        const device = this.stateCache.getDevice(deviceMac);
        if (device) {
          device.assignedUsers.delete(cleanEmail);
        }

        // If the unassigned user currently has an active subscription to this device, unsubscribe them
        for (const client of this.stateCache.clients.values()) {
          if (client.email === cleanEmail && !client.isAdmin && client.subscribedDeviceMac === deviceMac) {
            this.stateCache.unsubscribeClient(client.socket);
          }
        }

        this.sendBinary(
          ws,
          encodeAdminUserDetailsResponse({
            email: cleanEmail,
            isAdmin: this.stateCache.isEmailAdmin(cleanEmail),
            devices: this.stateCache.getAssignedDevicesForEmail(cleanEmail)
          })
        );
        logger.info(`[v1/Admin] Unassigned ESP32 ${deviceMac} from ${cleanEmail} (by ${ws.email})`);
        break;
      }

      case DATA_SERVERBOUND.ADMIN_REGISTER_DEVICE: {
        if (!ws.isAdmin) return;
        if (payload.length < 10) return;
        const deviceMac = readMacHex(payload, 0);
        const { value: deviceName, nextOffset } = readString(payload, 8);
        if (nextOffset !== payload.length) return;

        const cleanName = deviceName.trim() || deviceMac;
        const secretKeyBuf = this.esp32Auth.deriveDeviceSecretKey(deviceMac);

        await this.firebaseStore.upsertDevice(deviceMac, {
          name: cleanName,
          assignedUsers: [],
          createdAt: new Date().toISOString()
        });

        const entry = this.stateCache.upsertDeviceInMemory(deviceMac, {
          name: cleanName
        });

        this.sendBinary(
          ws,
          encodeAdminDeviceRegisteredResponse({
            device: {
              deviceMac: entry.deviceMac,
              online: entry.online ? 1 : 0,
              name: entry.name
            },
            secretKeyBuf
          })
        );
        logger.info(`[v1/Admin] Registered ESP32 ${deviceMac} ("${cleanName}") by ${ws.email}`);
        break;
      }

      case DATA_SERVERBOUND.ADMIN_UNREGISTER_DEVICE: {
        if (!ws.isAdmin) return;
        if (payload.length !== 8) return;
        const deviceMac = readMacHex(payload, 0);

        const existing = this.stateCache.getDevice(deviceMac);
        const assignedEmails = existing ? Array.from(existing.assignedUsers) : [];

        this.stateCache.removeDeviceInMemory(deviceMac);
        await this.firebaseStore.deleteDevice(deviceMac, assignedEmails);

        // Send updated list of all devices back to the Admin
        this.sendBinary(ws, encodeAdminListDevicesResponse(this.stateCache.getAllDevices()));
        logger.info(`[v1/Admin] Unregistered/deleted ESP32 ${deviceMac} by ${ws.email}`);
        break;
      }

      case DATA_SERVERBOUND.ADMIN_LIST_DEVICES_REQ: {
        if (!ws.isAdmin) return;
        const devices = this.stateCache.getAllDevices();
        this.sendBinary(ws, encodeAdminListDevicesResponse(devices));
        break;
      }

      case DATA_SERVERBOUND.ADMIN_DEVICE_DETAILS_REQ: {
        if (!ws.isAdmin) return;
        if (payload.length !== 8) return;
        const deviceMac = readMacHex(payload, 0);

        const entry = this.stateCache.getDevice(deviceMac);
        if (!entry) return;

        const secretKeyBuf = this.esp32Auth.deriveDeviceSecretKey(deviceMac);
        this.sendBinary(
          ws,
          encodeAdminDeviceDetailsResponse({
            device: {
              deviceMac: entry.deviceMac,
              online: entry.online ? 1 : 0,
              name: entry.name
            },
            secretKeyBuf,
            firmwareVersion: entry.firmwareVersion || '',
            assignedEmails: Array.from(entry.assignedUsers).sort()
          })
        );
        break;
      }

      default:
        logger.warn(`[v1/Data] Unknown Web data protocol code 0x${protocolCode.toString(16)} from ${ws.email}`);
        break;
    }
  }

  /**
   * Automatically check latest GitHub firmware release and send Clientbound 0x08 OTA info to Web Client.
   */
  async pushOtaInfoToWebClient(ws, device) {
    const currentVersion = device.firmwareVersion || '';
    const status = await otaService.checkUpdateForVersion(currentVersion, false);
    if (status && status.latestVersion) {
      this.sendBinary(
        ws,
        encodeOtaInfo({
          deviceMac: device.deviceMac,
          currentVersion: currentVersion || 'unknown',
          latestVersion: status.latestVersion
        })
      );
    }
  }

  sendBinary(ws, buffer) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(buffer, { binary: true });
    }
  }

  startPingInterval() {
    this.pingTimer = setInterval(() => {
      this.wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
          logger.warn(`[v1] Socket ${ws.id} did not respond to ping; terminating`);
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, this.pingIntervalMs);
  }

  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.wss.close();
  }

  getStats() {
    let esp32Count = 0;
    let clientCount = 0;
    let unauthenticatedCount = 0;

    this.wss.clients.forEach((ws) => {
      if (ws.connectionState === CONNECTION_STATES.AUTH) {
        unauthenticatedCount++;
      } else if (ws.clientType === 'esp32') {
        esp32Count++;
      } else if (ws.clientType === 'web') {
        clientCount++;
      }
    });

    return {
      totalConnections: this.wss.clients.size,
      esp32Count,
      clientCount,
      unauthenticatedCount
    };
  }
}

module.exports = V1Server;
