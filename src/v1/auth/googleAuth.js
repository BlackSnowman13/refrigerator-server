const logger = require('../../utils/logger');
const { AUTH_CODES, CONNECTION_STATES } = require('../protocol/binaryProtocol');

class GoogleClientAuth {
  constructor(stateCache, firebaseStore) {
    this.stateCache = stateCache;
    this.firebaseStore = firebaseStore;
  }

  /**
   * Verify a Web Client's Serverbound 0x00 Protocol version packet (Device Type = 1):
   * - Validate Version (0x00)
   * - Verify Firebase ID token
   * - Transition socket to CONNECTION_STATES.DATA (1)
   */
  async verifyWebProtocolVersion(ws, parsed) {
    if (parsed.version !== 0x00) {
      return {
        success: false,
        authCode: AUTH_CODES.UNSUPPORTED_VERSION
      };
    }

    const idToken = String(parsed.token || '').trim();
    if (!idToken) {
      return {
        success: false,
        authCode: AUTH_CODES.INVALID_TOKEN
      };
    }

    let decodedToken;
    try {
      decodedToken = await this.firebaseStore.verifyIdToken(idToken);
    } catch (err) {
      logger.warn(`[v1/Auth] Firebase ID Token verification failed on socket ${ws.id}: ${err.message}`);
      return {
        success: false,
        authCode: AUTH_CODES.INVALID_TOKEN
      };
    }

    const email = (decodedToken.email || '').trim().toLowerCase();
    if (!email) {
      return {
        success: false,
        authCode: AUTH_CODES.INVALID_TOKEN
      };
    }

    if (decodedToken.email_verified === false) {
      return {
        success: false,
        authCode: AUTH_CODES.UNAUTHORIZED_USER
      };
    }

    const isAdmin = this.stateCache.isEmailAdmin(email);

    if (ws.authTimer) {
      clearTimeout(ws.authTimer);
      ws.authTimer = null;
    }

    ws.connectionState = CONNECTION_STATES.DATA;
    ws.isAuthenticated = true;
    ws.clientType = 'web';
    ws.isAdmin = isAdmin;
    ws.email = email;
    ws.uid = decodedToken.uid;

    this.stateCache.addClient(ws, email, isAdmin);
    this.firebaseStore.ensureUser(email).catch((err) => {
      logger.warn(`[v1/Auth] Failed to persist user email ${email} in Firestore: ${err.message}`);
    });

    logger.info(`[v1/Auth] Web client authenticated: ${email} (isAdmin: ${isAdmin}, socket: ${ws.id})`);

    return {
      success: true,
      authCode: AUTH_CODES.SUCCESS,
      email,
      isAdmin
    };
  }
}

module.exports = GoogleClientAuth;
