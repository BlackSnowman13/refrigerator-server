# Refrigerator Server `v1` — Web Client Communication Protocol

This document specifies the complete **`v1` Binary WebSocket Protocol** exclusively from the perspective of the **Web Client (Browser / TypeScript Frontend)**. It is designed as a self-contained reference for both human developers and AI coding agents building or updating the website.

---

## 1. Connection & Overview

- **WebSocket Endpoint**: `/v1` (`wss://<host>/v1` or `ws://<host>:<port>/v1`)
- **WebSocket Binary Mode**: Set `ws.binaryType = 'arraybuffer'`. Every message is a **Binary WebSocket Frame** encoded in **Big-Endian (Network Byte Order)**.
- **Connection States**:
  - **`0` — `auth`**: Initial state when the WebSocket connection opens. The Web Client authenticates in a single step by sending `0x00 Protocol version` with its Firebase ID token. Only [Auth Protocols](#5-auth-protocols) are used.
  - **`1` — `data`**: Active session state entered after receiving `0x01 Auth Response` with `Code = 0x00 (Success)`. Only [Data Protocols](#6-data-protocols) are used.
- **Single-Device Subscription Model**:
  - A Web Client can subscribe to **one ESP32 device at a time** via `0x01 Subscribe request`.
  - Subscribing to a new `Device MAC` automatically unsubscribes from any previously subscribed device.
  - When subscribed, the server relays `0x03 Sensor dump relay` (initial full register dump) followed by `0x04 Sensor delta relay` (changed registers every 1 minute), and automatically pushes `0x08 OTA info` if a firmware update is available.

---

## 2. Web Client Lifecycle & Flows

### 2.1 Web Authentication Flow
1. [Open WebSocket connection to `/v1`](#1-connection--overview) (starts in `auth (0)` state)
2. [Web Client sends `0x00 Protocol version`](#521-0x00-protocol-version) (`Version = 0x00`, `Device Type = 1`, Firebase `Token`)
3. [Server sends `0x01 Auth Response`](#511-0x01-auth-response) (`Code = 0x00 Success` $\rightarrow$ transitions to `data (1)` state)

### 2.2 Dashboard & Device Telemetry Flow (in `data (1)` State)
1. **Load User Profile & Devices**:
   - Send [`0x00 User info request`](#621-0x00-user-info-request) $\rightarrow$ receive [`0x00 User info response`](#611-0x00-user-info-response) (`Is Admin`, `Email`, and list of accessible `Devices`).
2. **Subscribe to an ESP32 Device**:
   - Send [`0x01 Subscribe request`](#622-0x01-subscribe-request) with the target `Device MAC`.
   - Receive [`0x03 Sensor dump relay`](#612-0x03-sensor-dump-relay) containing all current register values.
   - Receive [`0x08 OTA info`](#616-0x08-ota-info) automatically from the server with the device's `Current Version` and `Latest Version`.
   - Every 1 minute (when values change on the ESP32), receive [`0x04 Sensor delta relay`](#613-0x04-sensor-delta-relay) and merge the updated register entries into UI state.
3. **Write Register(s)**:
   - Send [`0x05 Write Request`](#624-0x05-write-request) with the `Entry Array` of `Register` values to modify.
   - Receive [`0x07 Write response relay`](#615-0x07-write-response-relay) containing `Registers (Succeeded)` and `Registers (Failed)` with their actual updated values.
4. **Trigger OTA Firmware Update**:
   - Send [`0x07 OTA trigger`](#625-0x07-ota-trigger) (`0 bytes`) to instruct the server to push the pre-signed GitHub firmware URL to the currently subscribed ESP32.
5. **Unsubscribe**:
   - When leaving the device view, send [`0x02 Unsubscribe`](#623-0x02-unsubscribe) (`0 bytes`).

### 2.3 Admin Panel Flow (`Is Admin == 1`)
- **Manage Users**:
  - Send [`0x08 Admin list users request`](#626-0x08-admin-list-users-request) $\rightarrow$ receive [`0x0A Admin list users response`](#617-0x0a-admin-list-users-response) (array of email strings).
  - Click a user email: send [`0x09 Admin user details request`](#627-0x09-admin-user-details-request) $\rightarrow$ receive [`0x0B Admin user details response`](#618-0x0b-admin-user-details-response) (`Email`, `Is Admin`, and linked `Devices`).
  - Assign / unassign an ESP32: send [`0x0A Admin assign device`](#628-0x0a-admin-assign-device) or [`0x0B Admin unassign device`](#629-0x0b-admin-unassign-device).
- **Manage ESP32 Fleet**:
  - Send [`0x0F Admin list devices request`](#6213-0x0f-admin-list-devices-request) $\rightarrow$ receive [`0x0D Admin list devices response`](#6110-0x0d-admin-list-devices-response) (all registered ESP32 devices).
  - Click an ESP32 device: send [`0x10 Admin device details request`](#6214-0x10-admin-device-details-request) $\rightarrow$ receive [`0x0E Admin device details response`](#6111-0x0e-admin-device-details-response) (`Device`, 32-byte `Secret Key`, `Firmware Version`, and `Assigned Emails`).
  - Register a new ESP32: send [`0x0C Admin register device`](#6210-0x0c-admin-register-device) $\rightarrow$ receive [`0x0C Admin device registered response`](#619-0x0c-admin-device-registered-response) with the derived 32-byte `Secret Key` to flash onto the ESP32.
  - Delete an ESP32: send [`0x0D Admin unregister device`](#6211-0x0d-admin-unregister-device).

---

## 3. Packet Framing Style

Every packet is a binary frame encoded in **Big-Endian (Network Byte Order)** starting with a **3-byte header**: **Protocol Code** (`1 byte`, `uint8`), followed by **Packet Length** (`2 bytes`, `uint16` Big-Endian), followed by **Payload** (`N bytes`):

```text
+--------------------+--------------------+-----------------------+
| Byte 0             | Bytes 1..2         | Bytes 3..(3 + N - 1)  |
+--------------------+--------------------+-----------------------+
| Protocol Code (1B) | Packet Length (2B) | Payload (N Bytes)     |
| uint8              | uint16 BE          | Fields...             |
+--------------------+--------------------+-----------------------+
```

- **Protocol Code (`1 byte`, `DataView.getUint8(0)`)**: Identifies the packet type within the current connection state (`auth` or `data`).
- **Packet Length (`2 bytes`, `DataView.getUint16(1, false)`)**: Exact byte length ($N$) of the payload fields following Byte 2. If a packet has no payload, `Packet Length` is `0` (total frame length = 3 bytes).
- **Payload (`N bytes`)**: Payload fields encoded in Big-Endian order.

---

## 4. Data Types (TypeScript / Browser `DataView` Mapping)

### 4.1 Byte
`1 byte` (`uint8` via `view.getUint8(offset)`). Used for enums, status codes, and booleans (`0` = false, `1` = true).

### 4.2 Long
`8 bytes` (`uint64` Big-Endian via `view.getBigUint64(offset, false)`). Used for the 64-bit ESP32 factory eFuse MAC address.
- In TypeScript, represent as `bigint` or format as a 16-character uppercase hex string: `macBigInt.toString(16).toUpperCase().padStart(16, '0')`.

### 4.3 HMAC-SHA256 (Secret Key)
`32 bytes` (`Uint8Array(32)`). Used in Admin responses (`0x0C` and `0x0E`) to display the ESP32's 32-byte HMAC secret key (can be formatted as a 64-character hex string or C byte array for flashing).

### 4.4 String
UTF-8 string prefixed with its byte length:
- **Length** (`2 bytes`, `uint16` Big-Endian via `view.getUint16(offset, false)`): Number of UTF-8 bytes ($L$).
- **Bytes** (`L bytes`): UTF-8 encoded string (`new TextDecoder().decode(bytes.subarray(offset + 2, offset + 2 + L))`).

### 4.5 Entry Array
A length-prefixed array of structured entries:
- **Entry Count** (`1 byte`, `uint8` via `view.getUint8(offset)`): Number of entries ($N$, `0..255`).
- **Entries** ($N$ consecutive entries): Each entry contains its defined sub-fields in order.

### 4.6 Register
A register reading or write command entry (`4 bytes` when Digital, `5 bytes` when Holding Register):

| Sub-Field | Size | TypeScript Decoding (`registers.ts` mapping) |
| :--- | :--- | :--- |
| **Address** | `2 bytes` | `view.getUint16(offset, false)` — matches `RegisterInfo.register` in `registers.ts` (`0..218` or `1001..1012`). |
| **Is Digital** | `1 byte` | `view.getUint8(offset + 2)` — `0` = Holding Register (`type: 'Integer' \| 'Analog'`), `1` = Digital Coil (`type: 'Digital'`). |
| **Value** | `1 byte` or `2 bytes` | - **If `Is Digital === 1` (`Digital`)**: `1 byte` (`view.getUint8(offset + 3)` $\rightarrow$ `0` or `1`).<br>- **If `Is Digital === 0` and `type === 'Analog'`**: `2 bytes` signed two's complement divided by `10` (`view.getInt16(offset + 3, false) / 10`). When encoding a write, multiply by `10` and write with `view.setInt16(offset + 3, Math.round(val * 10), false)`.<br>- **If `Is Digital === 0` and `type === 'Integer'`**: `2 bytes` (`view.getInt16(offset + 3, false)` or `view.getUint16(offset + 3, false)`). |

### 4.7 Device
A structured entry representing an ESP32 device:

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| **Device MAC** | [Long](#42-long) (`8 bytes`) | Factory eFuse MAC address of the device |
| **Online** | [Byte](#41-byte) (`1 byte`) | `0` = Offline, `1` = Online |
| **Device Name** | [String](#44-string) (`2 + L bytes`) | Human-readable name of the device |

---

## 5. Auth Protocols (Connection State `0`)

> **Note**: In `auth (0)` state, the Web Client does **not** receive `0x00 Challenge` or send `0x01 Challenge Response` (those are for ESP32 HMAC authentication only). The Web Client sends its Firebase ID token directly inside `0x00 Protocol version`.

### 5.1 Clientbound (Server $\rightarrow$ Web)

#### 5.1.1 0x01 Auth Response
Sent by the server after verifying the Firebase ID token from `0x00 Protocol version`.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Code** | [Byte](#41-byte) | Authentication result code (`0x00` = Auth successful; non-zero = Error code). When `0x00`, transitions connection state from `auth (0)` to `data (1)`. |

##### Auth Response Codes
| Code | Name | Description |
| :--- | :--- | :--- |
| `0x00` | **Success** | Authentication succeeded; connection state transitions to `data (1)`. |
| `0x01` | **Timeout** | Authentication handshake was not completed within 10 seconds. |
| `0x02` | **Unsupported Version** | Protocol version sent in `0x00 Protocol version` is not supported. |
| `0x03` | **Malformed Packet** | Packet payload length or field format is invalid. |
| `0x06` | **Invalid Token** | Web Client Firebase ID token is invalid or expired. |
| `0x07` | **Unauthorized User** | Web Client user/email is not verified or not permitted. |

---

### 5.2 Serverbound (Web $\rightarrow$ Server)

#### 5.2.1 0x00 Protocol version
Sent immediately by the Web Client upon opening the WebSocket connection.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Version** | [Byte](#41-byte) | Protocol version (`0x00` for `v1`) |
| | **Device Type** | [Byte](#41-byte) | Always `0x01` (`Web`) |
| | **Token** | [String](#44-string) | Firebase Google Auth ID Token JWT string (prefixed with 2-byte `uint16` length) |

---

## 6. Data Protocols (Connection State `1`)

> **Note**: Only packets sent or received by the **Web Client** are listed below. ESP32-only packets (`Clientbound 0x01, 0x02, 0x05, 0x09` and `Serverbound 0x03, 0x04, 0x06`) are handled between the Server and ESP32.

### 6.1 Clientbound (Server $\rightarrow$ Web)

#### 6.1.1 0x00 User info response
Sent in response to `Serverbound 0x00 User info request`.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Is Admin** | [Byte](#41-byte) | `0` = Normal user, `1` = Admin |
| | **Email** | [String](#44-string) | Authenticated user's email address |
| | **Devices** | [Entry Array](#45-entry-array) of [Device](#47-device) | Array of accessible ESP32 device entries |

#### 6.1.2 0x03 Sensor dump relay
Relayed by the server when the subscribed ESP32 sends its full register dump.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x03` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of all register entries |

#### 6.1.3 0x04 Sensor delta relay
Relayed by the server every 1 minute (when registers change on the subscribed ESP32).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x04` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of changed register entries |

#### 6.1.4 0x06 Device info update
Sent by the server whenever an accessible device's online/offline status or name changes.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x06` | **Devices** | [Entry Array](#45-entry-array) of [Device](#47-device) | Array of updated device info entries |

#### 6.1.5 0x07 Write response relay
Relayed by the server after the subscribed ESP32 processes a `0x05 Write Request`.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x07` | **Registers (Succeeded)** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries successfully written with updated values |
| | **Registers (Failed)** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries that failed to write with actual values |

#### 6.1.6 0x08 OTA info
Sent automatically by the server when an OTA firmware update is available (or upon subscribing to a device).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x08` | **Device MAC** | [Long](#42-long) | Factory eFuse MAC address of the device |
| | **Current Version** | [String](#44-string) | ESP32's current firmware version (e.g. `"1.0.0"`) |
| | **Latest Version** | [String](#44-string) | Latest GitHub release version (e.g. `"1.1.0"`) |

#### 6.1.7 0x0A Admin list users response (Web Admin only)
Returns the list of all registered user emails.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0A` | **Emails** | [Entry Array](#45-entry-array) of [String](#44-string) | Array of user email strings |

#### 6.1.8 0x0B Admin user details response (Web Admin only)
Returns detailed user info and linked ESP32 devices for a clicked user email.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0B` | **Email** | [String](#44-string) | User's email address |
| | **Is Admin** | [Byte](#41-byte) | `0` = Normal user, `1` = Admin |
| | **Devices** | [Entry Array](#45-entry-array) of [Device](#47-device) | Array of ESP32 devices linked to this user |

#### 6.1.9 0x0C Admin device registered response (Web Admin only)
Sent after `Serverbound 0x0C Admin register device` succeeds, providing the derived 32-byte HMAC secret key to flash to the ESP32.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0C` | **Device** | [Device](#47-device) | The newly registered ESP32 device entry (`Device MAC`, `Online`, `Device Name`) |
| | **Secret Key** | [HMAC-SHA256](#43-hmac-sha256-secret-key) | `32 bytes` HMAC secret key for the ESP32 |

#### 6.1.10 0x0D Admin list devices response (Web Admin only)
Returns a list of all registered ESP32 devices in the fleet.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0D` | **Devices** | [Entry Array](#45-entry-array) of [Device](#47-device) | Array of all registered ESP32 devices |

#### 6.1.11 0x0E Admin device details response (Web Admin only)
Returns detailed information for a clicked ESP32 device, including its 32-byte HMAC secret key, firmware version, and assigned user emails.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0E` | **Device** | [Device](#47-device) | ESP32 device entry (`Device MAC`, `Online`, `Device Name`) |
| | **Secret Key** | [HMAC-SHA256](#43-hmac-sha256-secret-key) | `32 bytes` HMAC secret key for the ESP32 |
| | **Firmware Version** | [String](#44-string) | Last reported firmware version of the ESP32 (e.g. `"1.0.0"`) |
| | **Assigned Emails** | [Entry Array](#45-entry-array) of [String](#44-string) | Array of user email strings assigned to this ESP32 |

---

### 6.2 Serverbound (Web $\rightarrow$ Server)

#### 6.2.1 0x00 User info request

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | *(No payload)* | `0 bytes` | Requests the server to send `0x00 User info response` |

#### 6.2.2 0x01 Subscribe request
Subscribes the Web Client to a single ESP32 device (automatically unsubscribing from any previous device).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Device MAC** | [Long](#42-long) | Factory eFuse MAC address of the device |

#### 6.2.3 0x02 Unsubscribe
Unsubscribes the Web Client from its currently subscribed ESP32 device.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x02` | *(No payload)* | `0 bytes` | Unsubscribes from the currently subscribed ESP32 |

#### 6.2.4 0x05 Write Request
Requests the currently subscribed ESP32 to write one or more register values.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x05` | **Registers** | [Entry Array](#45-entry-array) of [Register](#46-register) | Array of register entries to write |

#### 6.2.5 0x07 OTA trigger
Triggers an OTA firmware update on the currently subscribed ESP32.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x07` | *(No payload)* | `0 bytes` | Triggers an OTA firmware update on the subscribed ESP32 |

#### 6.2.6 0x08 Admin list users request (Web Admin only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x08` | *(No payload)* | `0 bytes` | Requests `0x0A Admin list users response` (array of all user emails) |

#### 6.2.7 0x09 Admin user details request (Web Admin only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x09` | **Email** | [String](#44-string) | Target user's email address |

#### 6.2.8 0x0A Admin assign device (Web Admin only)
Links an ESP32 device to a user's email.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0A` | **Email** | [String](#44-string) | Target user's email address |
| | **Device MAC** | [Long](#42-long) | Factory eFuse MAC address of the ESP32 to assign |

#### 6.2.9 0x0B Admin unassign device (Web Admin only)
Unlinks an ESP32 device from a user's email.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0B` | **Email** | [String](#44-string) | Target user's email address |
| | **Device MAC** | [Long](#42-long) | Factory eFuse MAC address of the ESP32 to unassign |

#### 6.2.10 0x0C Admin register device (Web Admin only)
Registers a new ESP32 device in the database and returns its derived secret key in `Clientbound 0x0C`.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0C` | **Device MAC** | [Long](#42-long) | Factory eFuse MAC address of the new ESP32 |
| | **Device Name** | [String](#44-string) | Human-readable name for the ESP32 |

#### 6.2.11 0x0D Admin unregister device (Web Admin only)
Deletes/unregisters an ESP32 device from the server (and removes it from any assigned users).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0D` | **Device MAC** | [Long](#42-long) | Factory eFuse MAC address of the ESP32 to delete |

#### 6.2.12 0x0E Rename device
Renames an ESP32 device.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0E` | **Device MAC** | [Long](#42-long) | Factory eFuse MAC address of the ESP32 |
| | **Device Name** | [String](#44-string) | New human-readable name for the ESP32 |

#### 6.2.13 0x0F Admin list devices request (Web Admin only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0F` | *(No payload)* | `0 bytes` | Requests `0x0D Admin list devices response` (all registered ESP32 devices) |

#### 6.2.14 0x10 Admin device details request (Web Admin only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x10` | **Device MAC** | [Long](#42-long) | Factory eFuse MAC address of the target ESP32 |
