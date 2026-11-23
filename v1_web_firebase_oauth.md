# Refrigerator Web Client — Firebase & Google OAuth Integration Guide

This document explains how the **Web Client (Frontend)** authenticates users with **Firebase Authentication (Google OAuth)** and uses the resulting **Firebase ID Token (JWT)** to authenticate over the `/v1` binary WebSocket protocol.

---

## 1. Architecture Overview

The system uses **Firebase Auth (Google Sign-In)** for identity verification, while the **Node.js Refrigerator Server** manages authorization, admin privileges, and ESP32 device assignments:

```text
+--------------+      1. Sign in with GooglePopup      +-----------------------+
|              | ------------------------------------> |                       |
|  Web Client  |                                       |  Firebase Auth        |
|  (Browser)   | <------------------------------------ |  (Google OAuth)       |
|              |      2. user.getIdToken() -> JWT      +-----------------------+
+--------------+
       |
       | 3. Open WebSocket: wss://<server>/v1
       | 4. Send Binary Packet 0x00 Protocol version:
       |    [0x00][Length][Version=0x00][DeviceType=0x01][Token Length][Token UTF-8]
       v
+--------------+      5. admin.auth().verifyIdToken()  +-----------------------+
| Refrigerator | ------------------------------------> |  Firebase Admin SDK   |
| Server (/v1) | <------------------------------------ |  & Firestore          |
+--------------+      6. Verified email & uid          +-----------------------+
       |
       | 7. Reply Binary Packet 0x01 Auth Response:
       |    [0x01][0x00, 0x01][Code=0x00 (Success)] -> Connection transitions to data (1)
       v
+--------------+
|  Web Client  | (Now sends 0x00 User info request to get isAdmin, email, and devices)
+--------------+
```

- **The Web Client does NOT read or write Firestore directly.** All device lists, sensor streams, register writes, and admin actions happen over the `/v1` binary WebSocket after authenticating with the Firebase ID token.
- **Firebase Project ID**: `refrigerator-server`

---

## 2. Firebase Console Setup (One-Time Configuration)

1. Go to the [Firebase Console](https://console.firebase.google.com/) and select the **`refrigerator-server`** project.
2. **Enable Google Sign-In**:
   - Navigate to **Build $\rightarrow$ Authentication $\rightarrow$ Sign-in method**.
   - Click **Add new provider** $\rightarrow$ select **Google** $\rightarrow$ toggle **Enable** $\rightarrow$ select a project support email $\rightarrow$ click **Save**.
3. **Authorize Frontend Domains**:
   - Navigate to **Authentication $\rightarrow$ Settings $\rightarrow$ Authorized domains**.
   - Ensure `localhost` (for local development) and your production web domain (e.g., `app.yourdomain.com` or Vercel/Netlify domain) are listed.
4. **Register Web App & Copy Firebase Config**:
   - Go to **Project Settings (gear icon) $\rightarrow$ General $\rightarrow$ Your apps**.
   - Click the **Web (`</>`)** icon, register the app name, and copy the `firebaseConfig` object (`apiKey`, `authDomain`, `projectId`, `appId`).

---

## 3. Frontend Setup & Environment Variables

### 3.1 Install Firebase Web SDK
```bash
npm install firebase
```

### 3.2 Environment Variables (`.env` in Web Frontend)
```env
VITE_FIREBASE_API_KEY=AIzaSy...
VITE_FIREBASE_AUTH_DOMAIN=refrigerator-server.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=refrigerator-server
VITE_FIREBASE_APP_ID=1:108086039979255863509:web:...
VITE_WS_URL=ws://localhost:3001/v1
```
*(Adjust `VITE_` prefix to `NEXT_PUBLIC_` if using Next.js).*

---

## 4. Frontend Implementation (TypeScript)

### 4.1 Initialize Firebase Auth (`firebase.ts`)
```ts
import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  User
} from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

/**
 * Trigger Google OAuth Popup and return the signed-in Firebase User.
 */
export async function loginWithGoogle(): Promise<User> {
  const result = await signInWithPopup(auth, googleProvider);
  return result.user;
}

/**
 * Sign out from Firebase Auth (and close the WebSocket connection).
 */
export async function logoutGoogle(): Promise<void> {
  await signOut(auth);
}

/**
 * Fetch a fresh Firebase ID Token (JWT) for the current user.
 * Passing `forceRefresh = false` uses the cached token and automatically refreshes it if expired.
 */
export async function getFreshIdToken(forceRefresh = false): Promise<string> {
  const user = auth.currentUser;
  if (!user) {
    throw new Error('No authenticated Firebase user');
  }
  return await user.getIdToken(forceRefresh);
}

export { onAuthStateChanged, type User };
```

---

### 4.2 Encoding & Sending the `0x00 Protocol version` Auth Packet over `/v1`

When the WebSocket opens (`ws.onopen`), the Web Client immediately fetches the user's Firebase ID token (`user.getIdToken()`) and sends **Serverbound `0x00 Protocol version`** with `Device Type = 1 (Web)`:

```text
+-------------------+--------------------+----------------+-------------------+--------------------+----------------------+
| Byte 0            | Bytes 1..2         | Byte 3         | Byte 4            | Bytes 5..6         | Bytes 7..(6 + L)     |
+-------------------+--------------------+----------------+-------------------+--------------------+----------------------+
| Protocol Code: 0  | Packet Length: 4+L | Version = 0x00 | DeviceType = 0x01 | Token Length L     | Firebase ID Token    |
| (uint8)           | (uint16 BE)        | (uint8: v1)    | (uint8: Web)      | (uint16 BE)        | (UTF-8 String Bytes) |
+-------------------+--------------------+----------------+-------------------+--------------------+----------------------+
```

```ts
/**
 * Build the binary Serverbound `0x00 Protocol version` packet for Web authentication.
 */
export function buildWebAuthPacket(idToken: string): ArrayBuffer {
  const encoder = new TextEncoder();
  const tokenBytes = encoder.encode(idToken);

  // Payload = 1B Version (0x00) + 1B DeviceType (0x01) + 2B Token Length + L Token Bytes
  const payloadLength = 1 + 1 + 2 + tokenBytes.byteLength;
  const buffer = new ArrayBuffer(3 + payloadLength);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // 3-Byte Packet Header
  view.setUint8(0, 0x00);                    // Protocol Code = 0x00 (Protocol version)
  view.setUint16(1, payloadLength, false);   // Packet Length (uint16 Big-Endian)

  // Payload Fields
  view.setUint8(3, 0x00);                    // Version = 0x00 (v1)
  view.setUint8(4, 0x01);                    // Device Type = 0x01 (Web)
  view.setUint16(5, tokenBytes.byteLength, false); // String length (uint16 Big-Endian)
  bytes.set(tokenBytes, 7);                  // UTF-8 Firebase ID Token bytes

  return buffer;
}
```

---

### 4.3 Handling `0x01 Auth Response` & Requesting `0x00 User info`

After sending `0x00 Protocol version`, the very first packet the server sends back is **Clientbound `0x01 Auth Response`** (`4 bytes` total: `[0x01][0x00, 0x01][Code]`):

```ts
import { getFreshIdToken } from './firebase';
import { buildWebAuthPacket } from './protocol';

export async function connectV1WebSocket(wsUrl: string): Promise<WebSocket> {
  // Always get a valid (non-expired) ID token before opening the WebSocket
  const idToken = await getFreshIdToken();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    let isAuthenticated = false;

    ws.onopen = () => {
      // Immediately send 0x00 Protocol version with Firebase ID token
      ws.send(buildWebAuthPacket(idToken));
    };

    ws.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const view = new DataView(event.data);
      const protocolCode = view.getUint8(0);
      const packetLength = view.getUint16(1, false);

      if (!isAuthenticated) {
        // Expect Clientbound 0x01 Auth Response
        if (protocolCode === 0x01 && packetLength === 1) {
          const authCode = view.getUint8(3);
          if (authCode === 0x00) {
            isAuthenticated = true;

            // Connection is now in data (1) state!
            // Immediately request 0x00 User info request ([0x00, 0x00, 0x00])
            const userInfoReq = new Uint8Array([0x00, 0x00, 0x00]);
            ws.send(userInfoReq.buffer);

            resolve(ws);
          } else {
            reject(new Error(`WebSocket Auth Failed with code 0x${authCode.toString(16)}`));
            ws.close();
          }
        }
        return;
      }

      // Handle data (1) state packets (0x00 User info response, 0x03 Sensor dump, etc.)
    };

    ws.onerror = (err) => reject(err);
  });
}
```

---

## 5. Token Expiration & Reconnection Behaviour

1. **Firebase ID Token Lifespan**:
   - A Firebase ID Token (`idToken`) is a signed JWT valid for **1 hour (3600 seconds)**.
2. **During an Active WebSocket Session**:
   - The server verifies the Firebase ID Token **once** during the `auth (0)` handshake (`0x00 Protocol version`).
   - Once the connection transitions to `data (1)`, the WebSocket session remains authenticated for as long as the socket stays open—no periodic token re-sending is required over an open socket.
3. **On WebSocket Reconnect**:
   - Whenever the WebSocket disconnects and reconnects, **always call `await auth.currentUser.getIdToken()`** (do not reuse an old cached token string from an hour ago). The Firebase Web SDK automatically refreshes the token in the background if it is close to expiring or expired.
   - If the server ever responds with `0x01 Auth Response` code `0x06 (Invalid Token)`, call `await auth.currentUser.getIdToken(true)` (force refresh) before reconnecting.

---

## 6. Server-Side Verification & Admin Privileges Reference

When the server receives `0x00 Protocol version` (`Device Type = 1`):
1. **Token Verification**: Calls `admin.auth().verifyIdToken(idToken)` using `FIREBASE_SERVICE_ACCOUNT_JSON` in `.env`.
   - If invalid or expired $\rightarrow$ replies with `0x01 Auth Response` (`Code = 0x06 Invalid Token`) and closes the socket (`4003`).
   - If `email_verified === false` $\rightarrow$ replies with `0x01 Auth Response` (`Code = 0x07 Unauthorized User`) and closes the socket (`4003`).
2. **User Registration in Firestore**:
   - The server automatically records the user's lowercase email in the Firestore `users` collection (`users/{email}`) and in-memory `StateCache` so the user appears in the Admin Panel's user list (`0x0A Admin list users response`).
3. **Admin Role Check**:
   - The server checks if the user's email is listed in `ADMIN_EMAILS` in the server's `.env` (comma-separated, e.g. `ADMIN_EMAILS=admin@example.com`).
   - When the Web Client sends `0x00 User info request` in `data (1)` state, the server returns `Is Admin = 1` (if in `ADMIN_EMAILS`) or `Is Admin = 0` (normal user), along with the list of `Devices` the user is allowed to access.
