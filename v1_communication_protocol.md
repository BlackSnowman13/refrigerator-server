use /v1 for connecting to websocket

two connection states
- auth (0)
- data (1)

# Packet style

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

# Data types
## Long
8 bytes (`uint64`)

## Challenge
16 bytes

## HMAC-SHA256
32 bytes

## String
UTF-8 string prefixed with its length (`2 bytes`, `uint16` Big-Endian length followed by `N` UTF-8 bytes).

## Entry Array
A length-prefixed array of structured entries: starts with an **Entry Count** (`1 byte`, `uint8`, $N$ entries), followed by $N$ consecutive entries where each entry contains its defined sub-fields in order.

## Register
A register reading containing:
- **Address** (`2 bytes`, `uint16`): Register or coil address.
- **Is Digital** (`1 byte`, `uint8`): `0` = Holding Register (`Integer` / `Analog`), `1` = Digital Coil (`Digital`).
- **Value**: If **Is Digital** is `1` (`true`), `1 byte` (`0` or `1`); otherwise (`false`), `2 bytes` (`uint16` / `int16`).

## Device

| Field Name | Data Type | Description |
| :--- | :--- | :--- |
| **Device MAC** | [Long](#long) | Factory eFuse MAC address of the device |
| **Online** | Byte | `0` = Offline, `1` = Online |
| **Device Name** | [String](#string) | Human-readable name of the device |


# Auth protocols
## Clientbound
### 0x00 Challenge

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Nonce** | [Challenge](#challenge) | Cryptographically random 16-byte one-time challenge issued by the server (sent when **Device Type** is `0` / ESP32). |

### 0x01 Auth Response

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Code** | Byte | Authentication result code (`0` = Auth successful; non-zero = Error code). When `0`, transitions the connection state from `auth (0)` to `data (1)`. |

#### Auth Response Codes
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


## Serverbound
### 0x00 Protocol version
| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Version** | Byte | Protocol version. `0x00` for v1 |
| | **Device Type** | Byte | `0` = ESP32, `1` = Web |
| | **MAC Address** | [Long](#long) | Factory eFuse MAC address from `ESP.getEfuseMac()` (`uint64_t`, 8 bytes). **Only sent/accepted when Device Type is `0` (ESP32)**; omitted when Device Type is `1` (Web). |
| | **Firmware Version** | [String](#string) | ESP32's current firmware version (e.g. `"1.0.0"`). **Only sent/accepted when Device Type is `0` (ESP32)**; omitted when Device Type is `1` (Web). |

### 0x01 Challenge Response
| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Response (ESP32)** | [HMAC-SHA256](#hmac-sha256) | **If Device Type is `0` (ESP32)**: Client's HMAC-SHA256 response to the server's challenge nonce. |
| | **Token (Web)** | [String](#string) | **If Device Type is `1` (Web)**: Firebase ID token string (prefixed with length). |

# Data protocols
## Clientbound
### 0x00 User info response (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | **Is Admin** | Byte | `0` = Normal user, `1` = Admin |
| | **Email** | [String](#string) | Authenticated user's email address |
| | **Devices** | [Entry Array](#entry-array) of [Device](#device) | Array of accessible ESP32 device entries |

### 0x01 Subscribe relay (ESP32 only)
On recieving the subscribe request, the server will send the request to the esp32

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | *(No payload)* | `0 bytes` | Requests the ESP32 to send a full sensor data dump |

### 0x02 Unsubscribe relay (ESP32 only)
On recieving the unsubscribe request, the server will send the request to the esp32. Server will also send this when the user get disconnected or logs off.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x02` | *(No payload)* | `0 bytes` | Requests the ESP32 to stop sending updates to the server |

### 0x03 Sensor dump relay (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x03` | **Registers** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries |

### 0x04 Sensor delta relay (Web only)
Only sends registers that have changed since the last update.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x04` | **Registers** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries |

### 0x05 Write relay (ESP32 only)
On receiving the write request, the server will send the request to the esp32

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x05` | **Registers** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries |

### 0x06 Device info update (Web only)
Sent to the web when a device state or name has changed.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x06` | **Devices** | [Entry Array](#entry-array) of [Device](#device) | Array of device info entries |

### 0x07 Write response relay (Web only)
Forwards the ESP32's write response (`Serverbound 0x06`) to the Web Client.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x07` | **Registers (Succeeded)** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries successfully written with updated values |
| | **Registers (Failed)** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries failed to write with updated values |

### 0x08 OTA info (Web only)
Sent automatically by the server to the Web Client when an OTA firmware update is available (or upon subscribing to a device).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x08` | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the device |
| | **Current Version** | [String](#string) | ESP32's current firmware version (e.g. `"1.0.0"`) |
| | **Latest Version** | [String](#string) | Latest GitHub release version (e.g. `"1.1.0"`) |

### 0x09 OTA relay (ESP32 only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x09` | **Version** | [String](#string) | Target firmware version string |
| | **Download URL** | [String](#string) | Pre-signed HTTPS download URL for the firmware binary |

### 0x0A Admin list users response (Web Admin only)
Returns only the array of user emails.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0A` | **Emails** | [Entry Array](#entry-array) of [String](#string) | Array of user email strings |

### 0x0B Admin user details response (Web Admin only)
Returns the clicked user's details and their linked ESP32 devices.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0B` | **Email** | [String](#string) | User's email address |
| | **Is Admin** | Byte | `0` = Normal user, `1` = Admin |
| | **Devices** | [Entry Array](#entry-array) of [Device](#device) | Array of ESP32 devices linked to this user |

### 0x0C Admin device registered response (Web Admin only)
Sent after `0x0C Admin register device` succeeds so the admin gets the newly registered device info and its 32-byte HMAC secret key to flash to the ESP32.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0C` | **Device** | [Device](#device) | The newly registered ESP32 device entry (`Device MAC`, `Online`, `Device Name`) |
| | **Secret Key** | [HMAC-SHA256](#hmac-sha256) | `32 bytes` HMAC secret key for the ESP32 |

### 0x0D Admin list devices response (Web Admin only)
Returns a list of all registered ESP32 devices.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0D` | **Devices** | [Entry Array](#entry-array) of [Device](#device) | Array of all registered ESP32 devices |

### 0x0E Admin device details response (Web Admin only)
Returns detailed information for a clicked ESP32 device, including its HMAC secret key, firmware version, and assigned user emails.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0E` | **Device** | [Device](#device) | ESP32 device entry (`Device MAC`, `Online`, `Device Name`) |
| | **Secret Key** | [HMAC-SHA256](#hmac-sha256) | `32 bytes` HMAC secret key for the ESP32 |
| | **Firmware Version** | [String](#string) | Last reported firmware version of the ESP32 (e.g. `"1.0.0"`) |
| | **Assigned Emails** | [Entry Array](#entry-array) of [String](#string) | Array of user email strings assigned to this ESP32 |


## Serverbound
### 0x00 User info request (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x00` | *(No payload)* | `0 bytes` | Requests the server to send the user's info |

### 0x01 Subscribe request (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x01` | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the device |

### 0x02 Unsubscribe (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x02` | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the device |

### 0x03 Sensor dump (ESP32 only)
Sends a dump of all registers

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x03` | **Registers** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries |

### 0x04 Sensor delta (ESP32 only)
Only changed registers.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x04` | **Registers** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries |

### 0x05 Write Request (Web only)
Requests the ESP32 to write a register value.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x05` | **Registers** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries |

### 0x06 Write response (ESP32 only)
On receiving the write request, the server will send the response to the esp32

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x06` | **Registers** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries successfully written with updated values |
| | **Registers** | [Entry Array](#entry-array) of [Register](#register) | Array of register entries failed to write with updated values |

### 0x07 OTA trigger (Web only)

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x07` | *(No payload)* | `0 bytes` | Triggers an OTA firmware update on the subscribed ESP32 |

### 0x08 Admin list users request (Web Admin only)
Requests the list of all user emails.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x08` | *(No payload)* | `0 bytes` | Requests an array of all registered user emails |

### 0x09 Admin user details request (Web Admin only)
Sent when the admin clicks on a user email to view their profile and linked ESP32 devices.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x09` | **Email** | [String](#string) | Target user's email address |

### 0x0A Admin assign device (Web Admin only)
Links an ESP32 device to a user's email.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0A` | **Email** | [String](#string) | Target user's email address |
| | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the ESP32 to assign |

### 0x0B Admin unassign device (Web Admin only)
Unlinks an ESP32 device from a user's email.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0B` | **Email** | [String](#string) | Target user's email address |
| | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the ESP32 to unassign |

### 0x0C Admin register device (Web Admin only)
Registers a new ESP32 device in the database.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0C` | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the new ESP32 |
| | **Device Name** | [String](#string) | Human-readable name for the ESP32 |

### 0x0D Admin unregister device (Web Admin only)
Deletes/unregisters an ESP32 device from the server (and removes it from any assigned users).

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0D` | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the ESP32 to delete |

### 0x0E Rename device (Web only)
Renames an ESP32 device.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0E` | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the ESP32 |
| | **Device Name** | [String](#string) | New human-readable name for the ESP32 |

### 0x0F Admin list devices request (Web Admin only)
Requests the list of all registered ESP32 devices.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x0F` | *(No payload)* | `0 bytes` | Requests an array of all registered ESP32 devices |

### 0x10 Admin device details request (Web Admin only)
Sent when the admin clicks on an ESP32 device to view its detailed info, secret key, and assigned users.

| Protocol Code | Field Name | Data Type | Description |
| :--- | :--- | :--- | :--- |
| `0x10` | **Device MAC** | [Long](#long) | Factory eFuse MAC address of the target ESP32 |