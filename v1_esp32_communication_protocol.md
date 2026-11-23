# Refrigerator Server `v1` — ESP32 Firmware Communication Protocol

This document specifies the complete **`v1` Binary WebSocket Protocol** exclusively from the perspective of the **ESP32 Firmware**. It is designed as a self-contained reference for both human developers and AI coding agents working on the ESP32 C/C++ (Arduino / ESP-IDF) codebase.

---

## 1. Connection & Overview

- **WebSocket Endpoint**: `/v1` (`wss://<host>/v1` or `ws://<host>:<port>/v1`)
- **Frame Type**: All packets are **Binary WebSocket Frames** encoded in **Big-Endian (Network Byte Order)**.
- **Device Identity**: The ESP32 identifies itself using its factory eFuse MAC address from `ESP.getEfuseMac()` (`uint64_t`, 8 bytes) and authenticates using a unique 32-byte `ESP32_Secret_Key` flashed in firmware.
- **Connection States**:
  - **`0` — `auth`**: Initial state when the WebSocket connection opens. The ESP32 must complete the HMAC-SHA256 handshake within **10 seconds**. Only [Auth Protocols](#5-auth-protocols) are used.
  - **`1` — `data`**: Active session state entered after receiving `0x01 Auth Response` with `Code = 0x00 (Success)`. Only [Data Protocols](#6-data-protocols) are used.
- **Subscription-Driven Telemetry**:
  - The server does **not** store sensor history.
  - When a Web user views this ESP32, the server sends `0x01 Subscribe relay`. Upon receiving `0x01`, the ESP32 immediately sends `0x03 Sensor dump` (all registers) and begins a **1-minute timer** to send `0x04 Sensor delta` (only registers that changed since the last send).
  - When no Web user is viewing this ESP32, the server sends `0x02 Unsubscribe relay`, and the ESP32 stops sending 1-minute delta updates until subscribed again.

---

## 2. ESP32 Lifecycle & Flows

### 2.1 Authentication Flow
1. [Open WebSocket connection to `/v1`](#1-connection--overview) (starts in `auth (0)` state)
2. [ESP32 sends `0x00 Protocol version`](#521-0x00-protocol-version) (`Version = 0x00`, `Device Type = 0`, `MAC Address`, `Firmware Version`)
3. [Server sends `0x00 Challenge`](#511-0x00-challenge) (`16-byte Nonce`)
4. [ESP32 computes `HMAC_SHA256(ESP32_Secret_Key, Nonce)` and sends `0x01 Challenge Response`](#522-0x01-challenge-response) (`32-byte HMAC-SHA256`)
5. [Server sends `0x01 Auth Response`](#512-0x01-auth-response) (`Code = 0x00 Success` $\rightarrow$ transitions to `data (1)` state)

### 2.2 Sensor Data & Control Flow (in `data (1)` State)
1. **Wait for Subscription**: After entering `data (1)` state, the ESP32 stays idle on the WebSocket until a Web Client subscribes.
2. **On receiving [`0x01 Subscribe relay`](#611-0x01-subscribe-relay)**:
   - Immediately read all active controller & local registers and send [`0x03 Sensor dump`](#621-0x03-sensor-dump).
   - Enable the 1-minute delta reporting loop.
3. **Every 1 Minute (while subscribed)**:
   - Compare current register values with the last transmitted values.
   - If one or more registers changed, send [`0x04 Sensor delta`](#622-0x04-sensor-delta) containing **only** the changed registers.
4. **On receiving [`0x02 Unsubscribe relay`](#612-0x02-unsubscribe-relay)**:
   - Disable the 1-minute delta reporting loop.
5. **On receiving [`0x05 Write relay`](#613-0x05-write-relay)**:
   - Execute the requested Modbus / local register writes.
   - Reply with [`0x06 Write response`](#623-0x06-write-response) listing which register writes succeeded and which failed (with their actual current values).
6. **On receiving [`0x09 OTA relay`](#614-0x09-ota-relay)**:
   - Download the firmware binary over HTTPS from the provided pre-signed `Download URL`, flash the OTA partition, and reboot.

---

## 3. Packet Framing Style

Every packet starts with a **3-byte header**: **Protocol Code** (`1 byte`, `uint8`), followed by **Packet Length** (`2 bytes`, `uint16` Big-Endian), followed by **Payload** (`N bytes`):

```text
+--------------------+--------------------+-----------------------+
| Byte 0             | Bytes 1..2         | Bytes 3..(3 + N - 1)  |
+--------------------+--------------------+-----------------------+
| Protocol Code (1B) | Packet Length (2B) | Payload (N Bytes)     |
| uint8_t            | uint16_t BE        | Fields...             |
+--------------------+--------------------+-----------------------+
```

- **Protocol Code (`1 byte`, `uint8_t`)**: Identifies the packet type within the current connection state (`auth` or `data`).
- **Packet Length (`2 bytes`, `uint16_t` Big-Endian)**: Exact byte length ($N$) of the payload following Byte 2. If a packet has no payload, `Packet Length` is `0x0000` (total frame size = 3 bytes).
- **Payload (`N bytes`)**: Encoded fields in Big-Endian byte order.

---

## 4. Data Types (ESP32 C/C++ Mapping)

### 4.1 Byte
`1 byte` (`uint8_t`). Used for enums, codes, and boolean flags (`0x00` = false/0, `0x01` = true/1).

### 4.2 Long
`8 bytes` (`uint64_t` Big-Endian). Used for the ESP32 factory eFuse MAC address (`ESP.getEfuseMac()`).
- *Note*: `ESP.getEfuseMac()` on Arduino-ESP32 returns a 64-bit integer where the 6-byte MAC occupies the lower 48 bits. Encode the full `uint64_t` in **Big-Endian** order (8 bytes).

### 4.3 Challenge
`16 bytes` (`uint8_t[16]`). Raw 16-byte random challenge nonce sent by the server.

### 4.4 HMAC-SHA256
`32 bytes` (`uint8_t[32]`). Raw 32-byte HMAC-SHA256 digest (not hex-encoded).

### 4.5 String
Length-prefixed UTF-8 string:
- **Length** (`2 bytes`, `uint16_t` Big-Endian): Number of UTF-8 bytes ($L$).
- **Bytes** (`L bytes`, `char[L]`): Raw UTF-8 characters (no null terminator on the wire).

### 4.6 Entry Array
A length-prefixed array of structured entries:
- **Entry Count** (`1 byte`, `uint8_t`): Number of entries ($N$, `0..255`).
- **Entries** ($N$ consecutive entries): Each entry's sub-fields serialized back-to-back.

### 4.7 Register
Represents a single controller Modbus register/coil or local ESP32 control register (`4 bytes` for Digital Coil, `5 bytes` for Holding Register):

| Sub-Field | Size | C/C++ Type | Description |
| :--- | :--- | :--- | :--- |
| **Address** | `2 bytes` | `uint16_t` BE | Register or coil address (e.g. `0..218` for Modbus, `1001..1012` for Local Controls) |
| **Is Digital** | `1 byte` | `uint8_t` | `0x00` = Holding Register (`Integer` or `Analog`, Modbus FC `0x03`), `0x01` = Digital Coil (`Digital`, Modbus FC `0x01`) |
| **Value** | `1 byte` or `2 bytes` | `uint8_t` or `uint16_t` / `int16_t` BE | If **Is Digital == `0x01`**: `1 byte` (`0x00` or `0x01`).<br>If **Is Digital == `0x00`**: `2 bytes` Big-Endian raw 16-bit Modbus register word (`Analog` values are raw signed `int16_t` scaled by $10\times$, e.g. `-12.5°C` is `-125` = `0xFF83`). |

```text
Holding Register Entry (5 bytes):
+-------------------+-------------------+-------------------+
| Address (2B BE)   | Is Digital = 0x00 | Value (2B BE)     |
+-------------------+-------------------+-------------------+

Digital Coil Entry (4 bytes):
+-------------------+-------------------+-------------------+
| Address (2B BE)   | Is Digital = 0x01 | Value (1B: 0 / 1) |
+-------------------+-------------------+-------------------+
```

---

## 5. Auth Protocols (Connection State `0`)

### 5.1 Clientbound (Server $\rightarrow$ ESP32)

#### 5.1.1 0x00 Challenge
Sent by the server after verifying the ESP32's MAC address in `0x00 Protocol version`.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Nonce** | [Challenge](#43-challenge) (`16 bytes`) | Cryptographically random 16-byte one-time challenge nonce. |

#### 5.1.2 0x01 Auth Response
Sent by the server after verifying `0x01 Challenge Response` (or immediately on an error).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Code** | [Byte](#41-byte) (`1 byte`) | Authentication result code (`0x00` = Success; non-zero = Error). When `0x00`, connection transitions from `auth (0)` to `data (1)`. |

##### Auth Response Codes
| Code | Name | Description |
| :--- | :--- | :--- |
| `0x00` | **Success** | Authentication succeeded; connection state transitions to `data (1)`. |
| `0x01` | **Timeout** | Authentication handshake was not completed within 10 seconds. |
| `0x02` | **Unsupported Version** | Protocol version sent in `0x00 Protocol version` is not supported. |
| `0x03` | **Malformed Packet** | Packet payload length or field format is invalid. |
| `0x04` | **Unregistered Device** | ESP32 MAC address is not registered on the server. |
| `0x05` | **Invalid Challenge Response** | ESP32 HMAC-SHA256 signature did not match the challenge nonce. |

---

### 5.2 Serverbound (ESP32 $\rightarrow$ Server)

#### 5.2.1 0x00 Protocol version
Sent immediately by the ESP32 when the WebSocket connection opens.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Version** | [Byte](#41-byte) (`1 byte`) | Protocol version (`0x00` for `v1`) |
| | **Device Type** | [Byte](#41-byte) (`1 byte`) | Always `0x00` (`ESP32`) |
| | **MAC Address** | [Long](#42-long) (`8 bytes`) | Factory eFuse MAC address from `ESP.getEfuseMac()` (`uint64_t` Big-Endian) |
| | **Firmware Version** | [String](#45-string) (`2 + L bytes`) | Current ESP32 firmware version string (e.g. `"1.0.0"`) |

#### 5.2.2 0x01 Challenge Response
Sent by the ESP32 in response to `0x00 Challenge`.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Response** | [HMAC-SHA256](#44-hmac-sha256) (`32 bytes`) | 32-byte HMAC-SHA256 computed over the raw 16-byte `Nonce` using the ESP32's 32-byte `ESP32_Secret_Key`: `HMAC_SHA256(ESP32_Secret_Key, Nonce)`. |

---

## 6. Data Protocols (Connection State `1`)

> **Note**: Only packets sent or received by the **ESP32** are listed below. Web-only protocol codes (`Clientbound 0x00, 0x03, 0x04, 0x06, 0x07, 0x08, 0x0A..0x0E` and `Serverbound 0x00, 0x01, 0x02, 0x05, 0x07, 0x08..0x10`) never travel over the ESP32 WebSocket.

### 6.1 Clientbound (Server $\rightarrow$ ESP32)

#### 6.1.1 0x01 Subscribe relay
Sent by the server when a Web Client subscribes to this ESP32.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | *(No payload)* | `0 bytes` | Requests the ESP32 to immediately send a full `0x03 Sensor dump` and start 1-minute `0x04 Sensor delta` updates. |

#### 6.1.2 0x02 Unsubscribe relay
Sent by the server when the subscribed Web Client unsubscribes, disconnects, or logs off.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x02` | *(No payload)* | `0 bytes` | Requests the ESP32 to stop sending 1-minute delta updates to the server. |

#### 6.1.3 0x05 Write relay
Sent by the server when a Web Client requests one or more register writes.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x05` | **Registers** | [Entry Array](#46-entry-array) of [Register](#47-register) | Array of target register entries (`Address`, `Is Digital`, and desired `Value`) to write. |

#### 6.1.4 0x09 OTA relay
Sent by the server when a Web Client triggers an OTA firmware update on this ESP32.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x09` | **Version** | [String](#45-string) | Target firmware version string (e.g. `"1.1.0"`) |
| | **Download URL** | [String](#45-string) | Pre-signed HTTPS download URL for the `.bin` firmware image |

---

### 6.2 Serverbound (ESP32 $\rightarrow$ Server)

#### 6.2.1 0x03 Sensor dump
Sent by the ESP32 immediately upon receiving `0x01 Subscribe relay`. Contains all active registers.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x03` | **Registers** | [Entry Array](#46-entry-array) of [Register](#47-register) | Array of all register entries |

#### 6.2.2 0x04 Sensor delta
Sent by the ESP32 every 1 minute (while subscribed) containing **only** registers whose values have changed since the previous `0x03` or `0x04` transmission.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x04` | **Registers** | [Entry Array](#46-entry-array) of [Register](#47-register) | Array of changed register entries |

#### 6.2.3 0x06 Write response
Sent by the ESP32 after processing a `0x05 Write relay` command. Contains two sequential `Entry Array` fields:

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x06` | **Registers (Succeeded)** | [Entry Array](#46-entry-array) of [Register](#47-register) | Array of register entries that were successfully written, with their updated values |
| | **Registers (Failed)** | [Entry Array](#46-entry-array) of [Register](#47-register) | Array of register entries that failed to write, with their current/actual values |

---

## 7. ESP32 Secret Key & HMAC-SHA256 Reference

### 7.1 Secret Key Provisioning
- Each ESP32 is flashed with a unique 32-byte `ESP32_Secret_Key` (`uint8_t SECRET_KEY[32]`) generated by the server during Admin Registration (`ESP32_Secret_Key = HMAC_SHA256(MASTER_KEY, Device_MAC)`).
- The ESP32 never stores or knows the server's `MASTER_KEY`.

### 7.2 Computing `0x01 Challenge Response` on ESP32 (mbedTLS Example)
When `0x00 Challenge` arrives with the 16-byte `nonce`:
```cpp
#include "mbedtls/md.h"

void computeChallengeHmac(const uint8_t secretKey[32], const uint8_t nonce[16], uint8_t outHmac[32]) {
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 1);
  mbedtls_md_hmac_starts(&ctx, secretKey, 32);
  mbedtls_md_hmac_update(&ctx, nonce, 16);
  mbedtls_md_hmac_finish(&ctx, outHmac);
  mbedtls_md_free(&ctx);
}
```
The resulting 32-byte `outHmac` is sent as the payload of `0x01 Challenge Response` (`[0x01][0x00, 0x20][outHmac (32B)]`).
