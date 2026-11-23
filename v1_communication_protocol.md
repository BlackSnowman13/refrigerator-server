# Refrigerator Server `v1` Communication Protocol

## 1. Connection & Overview

- **WebSocket Endpoint**: `/v1` (`wss://<host>/v1` or `ws://<host>:<port>/v1`)
- **Connection States**: Every WebSocket connection operates in one of two sequential states:
  - **`0` — `auth`**: Initial quarantine state upon opening the WebSocket connection. Only [Auth protocols](#5-auth-protocols) are accepted.
  - **`1` — `data`**: Active session state entered after receiving `0x01 Auth Response` with code `0x00 (Success)`. Only [Data protocols](#6-data-protocols) are accepted.

---

## 2. Authentication Flows

### 2.1 ESP32 Authentication Flow
1. [Open WebSocket connection to /v1](#1-connection--overview)
2. [ESP32 sends 0x00 Protocol version](#521-0x00-protocol-version)
3. [Server sends 0x00 Challenge](#511-0x00-challenge)
4. [ESP32 sends 0x01 Challenge Response](#522-0x01-challenge-response-esp32-only)
5. [Server sends 0x01 Auth Response](#512-0x01-auth-response) (Code `0x00` $\rightarrow$ transitions to `data` state)

### 2.2 Web Authentication Flow
1. [Open WebSocket connection to /v1](#1-connection--overview)
2. [Web Client sends 0x00 Protocol version](#521-0x00-protocol-version)
3. [Server sends 0x01 Auth Response](#512-0x01-auth-response) (Code `0x00` $\rightarrow$ transitions to `data` state)

---

## 3. Packet Style

Every packet is a binary frame encoded in **Big-Endian (Network Byte Order)** starting with the **Protocol Code** (`1 byte`), followed by the **Packet Length** (`2 bytes`), followed by the **Payload Fields** (`N bytes`):

```text
+----------------+----------------+-------------+
| Byte 0         | Bytes 1..2     | Bytes 3..N  |
+----------------+----------------+-------------+
| Protocol Code  | Packet Length  | Payload     |
+----------------+----------------+-------------+
```

- **Protocol Code (`1 byte`)**
- **Packet Length (`2 bytes`)**: Length of the payload fields.
- **Payload (`N bytes`)**: Payload fields depending on the Protocol Code.

---

## 4. Data Types

### 4.1 Long
8 bytes (`uint64`)

### 4.2 Challenge
16 bytes

### 4.3 HMAC-SHA256
32 bytes

### 4.4 String
UTF-8 string prefixed with its length (`2 bytes`, `uint16` Big-Endian length followed by `N` UTF-8 bytes).

### 4.5 Entry Array
A length-prefixed array of structured entries: starts with an **Entry Count** (`1 byte`, `uint8`, $N$ entries), followed by $N$ consecutive entries where each entry contains its defined sub-fields in order.

### 4.6 Register
A register reading containing:
- **Address** (`2 bytes`, `uint16`): Register or coil address.
- **Is Digital** (`1 byte`, `uint8`): `0` = Holding Register (`Integer` / `Analog`), `1` = Digital Coil (`Digital`).
- **Value**: If **Is Digital** is `1` (`true`), `1 byte` (`0` or `1`); otherwise (`false`), `2 bytes` (`uint16` / `int16`).

### 4.7 Device

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the device |
| **Online** | Byte | `0` = Offline, `1` = Online |
| **Device Name** | [String](#44-string) | Human-readable name of the device |

---

## 5. Auth Protocols

### 5.1 Clientbound

#### 5.1.1 0x00 Challenge

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Nonce** | [Challenge](#42-challenge) | Cryptographically random 16-byte one-time challenge issued by the server (sent when **Device Type** is `0` / ESP32). |

#### 5.1.2 0x01 Auth Response

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Code** | Byte | Authentication result code (`0` = Auth successful; non-zero = Error code). When `0`, transitions the connection state from `auth (0)` to `data (1)`. |

##### Auth Response Codes
| Code | Name | Description |
| :--- | :--- | :--- |
| `0x00` | **Success** | Authentication succeeded; connection state transitions to `data (1)`. |
| `0x01` | **Timeout** | Authentication handshake was not completed within the time limit. |
| `0x02` | **Unsupported Version** | Protocol version sent in `0x00 Protocol version` is not supported. |
| `0x03` | **Malformed Packet** | Packet payload length or field format is invalid. |
| `0x04` | **Unregistered Device** | ESP32 MAC address is not registered on the server. |
| `0x05` | **Invalid Challenge Response** | ESP32 HMAC-SHA256 signature did not match the challenge nonce. |
| `0x06` | **Invalid Token** | Web Client Firebase ID token is invalid or expired. |
| `0x07` | **Unauthorized User** | Web Client user/email is not verified or not permitted. |

### 5.2 Serverbound

#### 5.2.1 0x00 Protocol version
| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Version** | Byte | Protocol version. `0x00` for v1 |
| | **Device Type** | Byte | `0` = ESP32, `1` = Web |
| | **MAC Address (ESP32)** | [Long](#41-long) | **If Device Type is `0` (ESP32)**: Factory eFuse MAC address from `ESP.getEfuseMac()` (`uint64_t`, 8 bytes). Omitted when Device Type is `1` (Web). |
| | **Firmware Version (ESP32)** | [String](#44-string) | **If Device Type is `0` (ESP32)**: ESP32's current firmware version (e.g. `"1.0.0"`). Omitted when Device Type is `1` (Web). |
| | **Token (Web)** | [String](#44-string) | **If Device Type is `1` (Web)**: Firebase ID token string (prefixed with length). Omitted when Device Type is `0` (ESP32). |

#### 5.2.2 0x01 Challenge Response (ESP32 only)
| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Response** | [HMAC-SHA256](#43-hmac-sha256) | ESP32's 32-byte HMAC-SHA256 response computed directly over the raw 16-byte `Nonce` from `0x00 Challenge` using the ESP32's 32-byte `Secret Key`: `HMAC_SHA256(secretKey, nonce)`. See [ESP32 Secret Key & Auth Verification Procedure](#7-esp32-secret-key--auth-verification-procedure). |

---

## 6. Data Protocols

### 6.1 Clientbound

#### 6.1.1 0x00 User info response (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Is Admin** | Byte | `0` = Normal user, `1` = Admin |
| | **Email** | [String](#44-string) | Authenticated user's email address |
| | **Devices** | [Entry Array](#45-entry-array) of [Device](#47-device) | Array of accessible ESP32 device entries |

#### 6.1.2 0x01 Subscribe relay (ESP32 only)
On receiving the subscribe request, the server will send the request to the ESP32.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | *(No payload)* | `0 bytes` | Requests the ESP32 to send a full sensor data dump |

#### 6.1.3 0x02 Unsubscribe relay (ESP32 only)
On receiving the unsubscribe request, the server will send the request to the ESP32. Server will also send this when the user gets disconnected or logs off.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x02` | *(No payload)* | `0 bytes` | Requests the ESP32 to stop sending updates to the server |

#### 6.1.4 0x03 Sensor dump relay (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x03` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries |

#### 6.1.5 0x04 Sensor delta relay (Web only)
Only sends registers that have changed since the last update.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x04` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries |

#### 6.1.6 0x05 Write relay (ESP32 only)
On receiving the write request, the server will send the request to the ESP32.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x05` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries |

#### 6.1.7 0x06 Device info update (Web only)
Sent to the web when a device state or name has changed.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x06` | **Devices** | [Entry Array](#45-entry-array) of [Device](#47-device) | Array of device info entries |

#### 6.1.8 0x07 Write response relay (Web only)
Forwards the ESP32's write response (`Serverbound 0x06`) to the Web Client.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x07` | **Registers (Succeeded)** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries successfully written with updated values |
| | **Registers (Failed)** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries failed to write with updated values |

#### 6.1.9 0x08 OTA info (Web only)
Sent automatically by the server to the Web Client when an OTA firmware update is available (or upon subscribing to a device).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x08` | **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the device |
| | **Current Version** | [String](#44-string) | ESP32's current firmware version (e.g. `"1.0.0"`) |
| | **Latest Version** | [String](#44-string) | Latest GitHub release version (e.g. `"1.1.0"`) |

#### 6.1.10 0x09 OTA relay (ESP32 only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x09` | **Version** | [String](#44-string) | Target firmware version string |
| | **Download URL** | [String](#44-string) | Pre-signed HTTPS download URL for the firmware binary |

#### 6.1.11 0x0A Admin list users response (Web Admin only)
Returns only the array of user emails.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0A` | **Emails** | [Entry Array](#45-entry-array) of [String](#44-string) | Array of user email strings |

#### 6.1.12 0x0B Admin user details response (Web Admin only)
Returns the clicked user's details and their linked ESP32 devices.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0B` | **Email** | [String](#44-string) | User's email address |
| | **Is Admin** | Byte | `0` = Normal user, `1` = Admin |
| | **Devices** | [Entry Array](#45-entry-array) of [Device](#47-device) | Array of ESP32 devices linked to this user |

#### 6.1.13 0x0C Admin device registered response (Web Admin only)
Sent after `0x0C Admin register device` succeeds so the admin gets the newly registered device info and its 32-byte HMAC secret key to flash to the ESP32. See [ESP32 Secret Key & Auth Verification Procedure](#7-esp32-secret-key--auth-verification-procedure).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0C` | **Device** | [Device](#47-device) | The newly registered ESP32 device entry (`Device MAC`, `Online`, `Device Name`) |
| | **Secret Key** | [HMAC-SHA256](#43-hmac-sha256) | `32 bytes` HMAC secret key for the ESP32 ([derived from `MASTER_KEY`](#7-esp32-secret-key--auth-verification-procedure)) |

#### 6.1.14 0x0D Admin list devices response (Web Admin only)
Returns a list of all registered ESP32 devices.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0D` | **Devices** | [Entry Array](#45-entry-array) of [Device](#47-device) | Array of all registered ESP32 devices |

#### 6.1.15 0x0E Admin device details response (Web Admin only)
Returns detailed information for a clicked ESP32 device, including its HMAC secret key, firmware version, and assigned user emails.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0E` | **Device** | [Device](#47-device) | ESP32 device entry (`Device MAC`, `Online`, `Device Name`) |
| | **Secret Key** | [HMAC-SHA256](#43-hmac-sha256) | `32 bytes` HMAC secret key for the ESP32 ([derived from `MASTER_KEY`](#7-esp32-secret-key--auth-verification-procedure)) |
| | **Firmware Version** | [String](#44-string) | Last reported firmware version of the ESP32 (e.g. `"1.0.0"`) |
| | **Assigned Emails** | [Entry Array](#45-entry-array) of [String](#44-string) | Array of user email strings assigned to this ESP32 |

### 6.2 Serverbound

#### 6.2.1 0x00 User info request (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | *(No payload)* | `0 bytes` | Requests the server to send the user's info |

#### 6.2.2 0x01 Subscribe request (Web only)
Subscribes the Web Client to a single ESP32 device. A Web Client can only be subscribed to **one ESP32 at a time** (subscribing to a new device automatically unsubscribes from any previously subscribed device).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the device |

#### 6.2.3 0x02 Unsubscribe (Web only)
Unsubscribes the Web Client from its currently subscribed ESP32 device.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x02` | *(No payload)* | `0 bytes` | Unsubscribes from the currently subscribed ESP32 |

#### 6.2.4 0x03 Sensor dump (ESP32 only)
Sends a dump of all registers.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x03` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries |

#### 6.2.5 0x04 Sensor delta (ESP32 only)
Only changed registers.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x04` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries |

#### 6.2.6 0x05 Write Request (Web only)
Requests the ESP32 to write a register value.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x05` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries |

#### 6.2.7 0x06 Write response (ESP32 only)
On receiving the write request, the ESP32 sends the write result to the server.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x06` | **Registers (Succeeded)** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries successfully written with updated values |
| | **Registers (Failed)** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries failed to write with updated values |

#### 6.2.8 0x07 OTA trigger (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x07` | *(No payload)* | `0 bytes` | Triggers an OTA firmware update on the subscribed ESP32 |

#### 6.2.9 0x08 Admin list users request (Web Admin only)
Requests the list of all user emails.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x08` | *(No payload)* | `0 bytes` | Requests an array of all registered user emails |

#### 6.2.10 0x09 Admin user details request (Web Admin only)
Sent when the admin clicks on a user email to view their profile and linked ESP32 devices.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x09` | **Email** | [String](#44-string) | Target user's email address |

#### 6.2.11 0x0A Admin assign device (Web Admin only)
Links an ESP32 device to a user's email.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0A` | **Email** | [String](#44-string) | Target user's email address |
| | **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the ESP32 to assign |

#### 6.2.12 0x0B Admin unassign device (Web Admin only)
Unlinks an ESP32 device from a user's email.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0B` | **Email** | [String](#44-string) | Target user's email address |
| | **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the ESP32 to unassign |

#### 6.2.13 0x0C Admin register device (Web Admin only)
Registers a new ESP32 device in the database and derives its unique 32-byte secret key (see [ESP32 Secret Key & Auth Verification Procedure](#7-esp32-secret-key--auth-verification-procedure)).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0C` | **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the new ESP32 |
| | **Device Name** | [String](#44-string) | Human-readable name for the ESP32 |

#### 6.2.14 0x0D Admin unregister device (Web Admin only)
Deletes/unregisters an ESP32 device from the server (and removes it from any assigned users).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0D` | **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the ESP32 to delete |

#### 6.2.15 0x0E Rename device (Web only)
Renames an ESP32 device.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0E` | **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the ESP32 |
| | **Device Name** | [String](#44-string) | New human-readable name for the ESP32 |

#### 6.2.16 0x0F Admin list devices request (Web Admin only)
Requests the list of all registered ESP32 devices.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0F` | *(No payload)* | `0 bytes` | Requests an array of all registered ESP32 devices |

#### 6.2.17 0x10 Admin device details request (Web Admin only)
Sent when the admin clicks on an ESP32 device to view its detailed info, secret key, and assigned users.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x10` | **Device MAC** | [Long](#41-long) | Factory eFuse MAC address of the target ESP32 |

---

## 7. ESP32 Secret Key & Auth Verification Procedure

The server stores a single `MASTER_KEY` in `.env` and uses it to deterministically derive a unique 32-byte `ESP32_Secret_Key` for each ESP32 from its 8-byte `Device MAC` (`ESP.getEfuseMac()`).

### 7.1 Deriving an ESP32's Unique Secret Key (During Registration)
When an Admin registers an ESP32 via [Serverbound `0x0C Admin register device`](#6213-0x0c-admin-register-device-web-admin-only) (or requests device details via [Serverbound `0x10 Admin device details request`](#6217-0x10-admin-device-details-request-web-admin-only)):
1. The server computes the device's unique 32-byte secret key using `MASTER_KEY` (from `.env`) and the 8-byte `Device MAC`:
   ```text
   ESP32_Secret_Key = HMAC_SHA256(MASTER_KEY, Device_MAC)
   ```
2. The server returns `ESP32_Secret_Key` in [Clientbound `0x0C Admin device registered response`](#6113-0x0c-admin-device-registered-response-web-admin-only) (and [Clientbound `0x0E Admin device details response`](#6115-0x0e-admin-device-details-response-web-admin-only)).
3. This 32-byte `ESP32_Secret_Key` is flashed onto the ESP32 firmware. The ESP32 never knows `MASTER_KEY`.

### 7.2 Authenticating an ESP32 (On WebSocket Connection)
Every new connection starts in the `auth (0)` state with a **10-second authentication timeout**:
1. **ESP32 $\rightarrow$ Server ([Serverbound `0x00 Protocol version`](#521-0x00-protocol-version))**:
   - ESP32 sends its 8-byte `MAC Address` (`Device_MAC`) and `Firmware Version`.
   - Server checks that `Device_MAC` is registered in the database (if not, sends [Clientbound `0x01 Auth Response`](#512-0x01-auth-response) with code `0x04 Unregistered Device`).
2. **Server $\rightarrow$ ESP32 ([Clientbound `0x00 Challenge`](#511-0x00-challenge))**:
   - Server generates a random 16-byte `Nonce` and sends it to the ESP32.
3. **ESP32 $\rightarrow$ Server ([Serverbound `0x01 Challenge Response`](#522-0x01-challenge-response-esp32-only))**:
   - ESP32 computes its 32-byte response using its flashed `ESP32_Secret_Key` and the 16-byte `Nonce`:
     ```text
     Response = HMAC_SHA256(ESP32_Secret_Key, Nonce)
     ```
   - ESP32 sends `Response` to the server.
4. **Server Verification ([Clientbound `0x01 Auth Response`](#512-0x01-auth-response))**:
   - Server derives that ESP32's secret key from `.env`:
     ```text
     ESP32_Secret_Key = HMAC_SHA256(MASTER_KEY, Device_MAC)
     ```
   - Server computes the expected response over the 16-byte `Nonce`:
     ```text
     Expected_Response = HMAC_SHA256(ESP32_Secret_Key, Nonce)
     ```
   - If `Response == Expected_Response`, the server replies with [Clientbound `0x01 Auth Response`](#512-0x01-auth-response) (`Code = 0x00 Success`) and transitions the connection to `data (1)`. Otherwise, it replies with `Code = 0x05 Invalid Challenge Response` and closes the socket.
