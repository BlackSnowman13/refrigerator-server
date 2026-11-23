const crypto = require('crypto');
const logger = require('../../utils/logger');
const {
  AUTH_CODES,
  CONNECTION_STATES,
  macToLongBuffer,
  normalizeMacHex
} = require('../protocol/binaryProtocol');

class ESP32HmacAuth {
  constructor(stateCache, firebaseStore) {
    this.stateCache = stateCache;
    this.firebaseStore = firebaseStore;
  }

  /**
   * Read MASTER_KEY from .env (with fallback to MASTER_DEVICE_SECRET or default dev key if missing).
   */
  getMasterKeyBuffer() {
    const raw =
      process.env.MASTER_KEY ||
      process.env.MASTER_DEVICE_SECRET ||
      'refrigerator-v1-default-master-key';
    const str = String(raw).trim();
    if (/^[0-9a-fA-F]{64}$/.test(str)) {
      return Buffer.from(str, 'hex');
    }
    return Buffer.from(str, 'utf8');
  }

  /**
   * Deterministically derive a unique 32-byte ESP32_Secret_Key for a device from MASTER_KEY and its 8-byte Device MAC:
   * ESP32_Secret_Key = HMAC_SHA256(MASTER_KEY, Device_MAC_8_Bytes)
   */
  deriveDeviceSecretKey(deviceMacInput) {
    const macBuf = macToLongBuffer(deviceMacInput);
    const masterKeyBuf = this.getMasterKeyBuffer();
    return crypto
      .createHmac('sha256', masterKeyBuf)
      .update(macBuf)
      .digest(); // 32-byte Buffer
  }

  /**
   * Compute expected 32-byte raw HMAC-SHA256 challenge response:
   * Expected_Response = HMAC_SHA256(ESP32_Secret_Key, Nonce_16_Bytes)
   */
  computeExpectedChallengeResponse(deviceMacInput, nonceBuf) {
    const secretKeyBuf = this.deriveDeviceSecretKey(deviceMacInput);
    return crypto
      .createHmac('sha256', secretKeyBuf)
      .update(nonceBuf)
      .digest(); // 32-byte Buffer
  }

  /**
   * Step 1 of ESP32 Auth (Serverbound 0x00 Protocol version, Device Type = 0):
   * - Validate protocol version (0x00)
   * - Check that Device MAC is registered in StateCache
   * - Generate 16-byte random challenge Nonce and attach pending auth state to socket
   */
  handleEsp32ProtocolVersion(ws, parsed) {
    if (parsed.version !== 0x00) {
      return {
        success: false,
        authCode: AUTH_CODES.UNSUPPORTED_VERSION
      };
    }

    const deviceMac = normalizeMacHex(parsed.deviceMac);
    const device = this.stateCache.getDevice(deviceMac);
    if (!device) {
      logger.warn(`[v1/Auth] Unregistered ESP32 MAC attempted connection: ${deviceMac}`);
      return {
        success: false,
        authCode: AUTH_CODES.UNREGISTERED_DEVICE
      };
    }

    const nonce = crypto.randomBytes(16);
    ws.pendingEsp32 = {
      deviceMac,
      firmwareVersion: parsed.firmwareVersion || '',
      nonce
    };

    return {
      success: true,
      nonce
    };
  }

  /**
   * Step 2 of ESP32 Auth (Serverbound 0x01 Challenge Response):
   * - Verify 32-byte HMAC-SHA256 over the 16-byte challenge Nonce using derived ESP32_Secret_Key
   * - Transition socket to CONNECTION_STATES.DATA (1) and mark device online
   */
  async verifyChallengeResponse(ws, responseHmacBuf) {
    if (!ws.pendingEsp32 || !Buffer.isBuffer(ws.pendingEsp32.nonce)) {
      return {
        success: false,
        authCode: AUTH_CODES.MALFORMED_PACKET
      };
    }

    const { deviceMac, firmwareVersion, nonce } = ws.pendingEsp32;
    ws.pendingEsp32 = null; // Consume nonce (one-time use)

    if (!Buffer.isBuffer(responseHmacBuf) || responseHmacBuf.length !== 32) {
      return {
        success: false,
        authCode: AUTH_CODES.MALFORMED_PACKET
      };
    }

    const expectedHmac = this.computeExpectedChallengeResponse(deviceMac, nonce);
    const isValid = crypto.timingSafeEqual(expectedHmac, responseHmacBuf);

    if (!isValid) {
      logger.warn(`[v1/Auth] Invalid HMAC challenge response from ESP32 ${deviceMac}`);
      return {
        success: false,
        authCode: AUTH_CODES.INVALID_CHALLENGE_RESPONSE
      };
    }

    if (ws.authTimer) {
      clearTimeout(ws.authTimer);
      ws.authTimer = null;
    }

    ws.connectionState = CONNECTION_STATES.DATA;
    ws.isAuthenticated = true;
    ws.clientType = 'esp32';
    ws.deviceMac = deviceMac;
    ws.firmwareVersion = firmwareVersion;

    const device = this.stateCache.setDeviceOnline(deviceMac, ws, firmwareVersion);

    if (firmwareVersion) {
      this.firebaseStore.upsertDevice(deviceMac, { firmwareVersion }).catch((err) => {
        logger.warn(`[v1/Auth] Failed to persist firmwareVersion for ${deviceMac}: ${err.message}`);
      });
    }

    logger.info(
      `[v1/Auth] ESP32 authenticated: ${deviceMac} (name: "${device?.name || deviceMac}", fw: "${firmwareVersion}", socket: ${ws.id})`
    );

    return {
      success: true,
      authCode: AUTH_CODES.SUCCESS,
      deviceMac
    };
  }
}

module.exports = ESP32HmacAuth;
