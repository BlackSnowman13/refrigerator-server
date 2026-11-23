/**
 * v1 Pure Binary Protocol Framing, Data Types & Packet Codec
 *
 * Every packet is a binary frame encoded in Big-Endian (Network Byte Order):
 * +--------------------+--------------------+-----------------------+
 * | Byte 0             | Bytes 1..2         | Bytes 3..(3 + N - 1)  |
 * +--------------------+--------------------+-----------------------+
 * | Protocol Code (1B) | Packet Length (2B) | Payload (N Bytes)     |
 * +--------------------+--------------------+-----------------------+
 */

const CONNECTION_STATES = {
  AUTH: 0,
  DATA: 1
};

const DEVICE_TYPES = {
  ESP32: 0x00,
  WEB:   0x01
};

const AUTH_CLIENTBOUND = {
  CHALLENGE:     0x00,
  AUTH_RESPONSE: 0x01
};

const AUTH_SERVERBOUND = {
  PROTOCOL_VERSION:   0x00,
  CHALLENGE_RESPONSE: 0x01
};

const AUTH_CODES = {
  SUCCESS:                    0x00,
  TIMEOUT:                    0x01,
  UNSUPPORTED_VERSION:        0x02,
  MALFORMED_PACKET:           0x03,
  UNREGISTERED_DEVICE:        0x04,
  INVALID_CHALLENGE_RESPONSE: 0x05,
  INVALID_TOKEN:              0x06,
  UNAUTHORIZED_USER:          0x07
};

const DATA_CLIENTBOUND = {
  USER_INFO_RESPONSE:       0x00, // Web only
  SUBSCRIBE_RELAY:          0x01, // ESP32 only
  UNSUBSCRIBE_RELAY:        0x02, // ESP32 only
  SENSOR_DUMP_RELAY:        0x03, // Web only
  SENSOR_DELTA_RELAY:       0x04, // Web only
  WRITE_RELAY:              0x05, // ESP32 only
  DEVICE_INFO_UPDATE:       0x06, // Web only
  WRITE_RESPONSE_RELAY:     0x07, // Web only
  OTA_INFO:                 0x08, // Web only
  OTA_RELAY:                0x09, // ESP32 only
  ADMIN_LIST_USERS_RESP:    0x0A, // Web Admin only
  ADMIN_USER_DETAILS_RESP:  0x0B, // Web Admin only
  ADMIN_DEVICE_REG_RESP:    0x0C, // Web Admin only
  ADMIN_LIST_DEVICES_RESP:  0x0D, // Web Admin only
  ADMIN_DEVICE_DETAILS_RESP:0x0E  // Web Admin only
};

const DATA_SERVERBOUND = {
  USER_INFO_REQUEST:        0x00, // Web only
  SUBSCRIBE_REQUEST:        0x01, // Web only
  UNSUBSCRIBE:              0x02, // Web only
  SENSOR_DUMP:              0x03, // ESP32 only
  SENSOR_DELTA:             0x04, // ESP32 only
  WRITE_REQUEST:            0x05, // Web only
  WRITE_RESPONSE:           0x06, // ESP32 only
  OTA_TRIGGER:              0x07, // Web only
  ADMIN_LIST_USERS_REQ:     0x08, // Web Admin only
  ADMIN_USER_DETAILS_REQ:   0x09, // Web Admin only
  ADMIN_ASSIGN_DEVICE:      0x0A, // Web Admin only
  ADMIN_UNASSIGN_DEVICE:    0x0B, // Web Admin only
  ADMIN_REGISTER_DEVICE:    0x0C, // Web Admin only
  ADMIN_UNREGISTER_DEVICE:  0x0D, // Web Admin only
  RENAME_DEVICE:            0x0E, // Web only
  ADMIN_LIST_DEVICES_REQ:   0x0F, // Web Admin only
  ADMIN_DEVICE_DETAILS_REQ: 0x10  // Web Admin only
};

/**
 * Convert an 8-byte Buffer (or slice) or BigInt or hex string into a canonical 16-character uppercase hex MAC string.
 * (e.g. "0000A4CF1289B304")
 */
function normalizeMacHex(macInput) {
  if (Buffer.isBuffer(macInput)) {
    if (macInput.length !== 8) {
      throw new Error(`Invalid MAC Buffer length: expected 8 bytes, got ${macInput.length}`);
    }
    return macInput.toString('hex').toUpperCase();
  }
  if (typeof macInput === 'bigint' || typeof macInput === 'number') {
    const big = BigInt(macInput);
    if (big < 0n || big > 0xFFFFFFFFFFFFFFFFn) {
      throw new Error(`Invalid MAC integer value: ${macInput}`);
    }
    return big.toString(16).toUpperCase().padStart(16, '0');
  }
  const clean = String(macInput || '').trim().replace(/^0x/i, '').replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  if (clean.length === 0 || clean.length > 16) {
    throw new Error(`Invalid MAC hex string: "${macInput}"`);
  }
  return clean.padStart(16, '0');
}

/**
 * Convert a 16-char hex MAC string (or BigInt / Buffer) into an 8-byte Big-Endian Buffer (Long / uint64).
 */
function macToLongBuffer(macInput) {
  const hex = normalizeMacHex(macInput);
  return Buffer.from(hex, 'hex');
}

/**
 * Read an 8-byte Long (uint64 Big-Endian) from buf at offset and return canonical 16-char uppercase hex MAC string.
 */
function readMacHex(buf, offset = 0) {
  if (!Buffer.isBuffer(buf) || offset + 8 > buf.length) {
    throw new Error('Buffer underflow reading 8-byte Long MAC');
  }
  return buf.subarray(offset, offset + 8).toString('hex').toUpperCase();
}

/**
 * Encode a length-prefixed UTF-8 String ([2B uint16BE length][UTF-8 bytes]).
 */
function encodeString(str) {
  const strBytes = Buffer.from(String(str ?? ''), 'utf8');
  if (strBytes.length > 0xFFFF) {
    throw new Error(`String length ${strBytes.length} exceeds uint16 max (65535)`);
  }
  const out = Buffer.allocUnsafe(2 + strBytes.length);
  out.writeUInt16BE(strBytes.length, 0);
  strBytes.copy(out, 2);
  return out;
}

/**
 * Read a length-prefixed UTF-8 String ([2B uint16BE length][UTF-8 bytes]) at offset.
 * Returns { value: string, nextOffset: number }.
 */
function readString(buf, offset = 0) {
  if (!Buffer.isBuffer(buf) || offset + 2 > buf.length) {
    throw new Error('Buffer underflow reading String length');
  }
  const len = buf.readUInt16BE(offset);
  const start = offset + 2;
  const end = start + len;
  if (end > buf.length) {
    throw new Error(`Buffer underflow reading String payload (expected ${len} bytes, available ${buf.length - start})`);
  }
  return {
    value: buf.subarray(start, end).toString('utf8'),
    nextOffset: end
  };
}

/**
 * Encode a Device entry:
 * [8B Device MAC (Long)][1B Online (Byte: 0|1)][String Device Name]
 */
function encodeDevice(device) {
  const macBuf = macToLongBuffer(device.deviceMac || device.deviceId);
  const onlineByte = Buffer.from([device.online ? 0x01 : 0x00]);
  const nameBuf = encodeString(device.name ?? device.deviceName ?? (device.deviceMac || device.deviceId));
  return Buffer.concat([macBuf, onlineByte, nameBuf]);
}

/**
 * Read a Device entry at offset.
 * Returns { value: { deviceMac, online, name }, nextOffset }.
 */
function readDevice(buf, offset = 0) {
  const deviceMac = readMacHex(buf, offset);
  if (offset + 9 > buf.length) {
    throw new Error('Buffer underflow reading Device Online byte');
  }
  const online = buf[offset + 8] ? 1 : 0;
  const { value: name, nextOffset } = readString(buf, offset + 9);
  return {
    value: { deviceMac, online, name },
    nextOffset
  };
}

/**
 * Encode a Register entry:
 * - Address (2 bytes, uint16 BE)
 * - Is Digital (1 byte, uint8: 0 = Holding Register, 1 = Digital Coil)
 * - Value (1 byte if Is Digital == 1, else 2 bytes uint16/int16 BE)
 */
function encodeRegister(reg) {
  const isDigital = reg.isDigital ? 0x01 : 0x00;
  if (isDigital) {
    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt16BE(reg.address & 0xFFFF, 0);
    buf[2] = 0x01;
    buf[3] = reg.value ? 0x01 : 0x00;
    return buf;
  } else {
    const buf = Buffer.allocUnsafe(5);
    buf.writeUInt16BE(reg.address & 0xFFFF, 0);
    buf[2] = 0x00;
    buf.writeUInt16BE(reg.value & 0xFFFF, 3);
    return buf;
  }
}

/**
 * Read a Register entry at offset.
 * Returns { value: { address, isDigital, value, rawBytes }, nextOffset }.
 */
function readRegister(buf, offset = 0) {
  if (!Buffer.isBuffer(buf) || offset + 3 > buf.length) {
    throw new Error('Buffer underflow reading Register header');
  }
  const address = buf.readUInt16BE(offset);
  const isDigital = buf[offset + 2];
  if (isDigital !== 0x00 && isDigital !== 0x01) {
    throw new Error(`Invalid Register IsDigital flag: 0x${isDigital.toString(16)}`);
  }

  if (isDigital === 0x01) {
    if (offset + 4 > buf.length) {
      throw new Error('Buffer underflow reading Digital Register 1-byte value');
    }
    const value = buf[offset + 3] ? 1 : 0;
    return {
      value: {
        address,
        isDigital: 1,
        value,
        rawBytes: buf.subarray(offset, offset + 4)
      },
      nextOffset: offset + 4
    };
  } else {
    if (offset + 5 > buf.length) {
      throw new Error('Buffer underflow reading Holding Register 2-byte value');
    }
    const value = buf.readUInt16BE(offset + 3);
    return {
      value: {
        address,
        isDigital: 0,
        value,
        rawBytes: buf.subarray(offset, offset + 5)
      },
      nextOffset: offset + 5
    };
  }
}

/**
 * Encode an Entry Array: [1B Entry Count (N)][Entry 1]...[Entry N]
 */
function encodeEntryArray(items, encodeItemFn) {
  const list = Array.isArray(items) ? items : [];
  if (list.length > 255) {
    throw new Error(`Entry Array count ${list.length} exceeds uint8 max (255)`);
  }
  const buffers = [Buffer.from([list.length])];
  for (const item of list) {
    buffers.push(encodeItemFn(item));
  }
  return Buffer.concat(buffers);
}

/**
 * Read an Entry Array at offset using readItemFn(buf, offset).
 * Returns { value: Array, nextOffset: number, rawSlice: Buffer }.
 */
function readEntryArray(buf, offset, readItemFn) {
  if (!Buffer.isBuffer(buf) || offset + 1 > buf.length) {
    throw new Error('Buffer underflow reading Entry Array count');
  }
  const startOffset = offset;
  const count = buf[offset];
  let cursor = offset + 1;
  const items = [];
  for (let i = 0; i < count; i++) {
    const { value, nextOffset } = readItemFn(buf, cursor);
    items.push(value);
    cursor = nextOffset;
  }
  return {
    value: items,
    nextOffset: cursor,
    rawSlice: buf.subarray(startOffset, cursor)
  };
}

/**
 * Wrap a payload Buffer with the 3-byte v1 packet header:
 * [1B Protocol Code][2B Packet Length (uint16BE)][Payload (N bytes)]
 */
function encodePacket(protocolCode, payloadBuf = Buffer.alloc(0)) {
  const payload = Buffer.isBuffer(payloadBuf) ? payloadBuf : Buffer.from(payloadBuf || []);
  if (payload.length > 0xFFFF) {
    throw new Error(`Packet payload length ${payload.length} exceeds uint16 max (65535)`);
  }
  const frame = Buffer.allocUnsafe(3 + payload.length);
  frame[0] = protocolCode & 0xFF;
  frame.writeUInt16BE(payload.length, 1);
  if (payload.length > 0) {
    payload.copy(frame, 3);
  }
  return frame;
}

/**
 * Parse and validate the 3-byte v1 packet header:
 * Returns { protocolCode, packetLength, payload }.
 * Throws an Error if the frame is malformed or Packet Length does not match the payload size.
 */
function decodePacketHeader(frameBuf) {
  if (!Buffer.isBuffer(frameBuf) || frameBuf.length < 3) {
    throw new Error(`Frame too short: expected at least 3 bytes, got ${frameBuf ? frameBuf.length : 0}`);
  }
  const protocolCode = frameBuf[0];
  const packetLength = frameBuf.readUInt16BE(1);
  if (frameBuf.length !== 3 + packetLength) {
    throw new Error(`Packet length mismatch: header declares ${packetLength} payload bytes, got ${frameBuf.length - 3}`);
  }
  return {
    protocolCode,
    packetLength,
    payload: frameBuf.subarray(3, 3 + packetLength)
  };
}

// ============================================================================
// Auth Packet Encoders & Decoders
// ============================================================================

/**
 * Clientbound 0x00 Challenge: [16B Nonce]
 */
function encodeAuthChallenge(nonceBuf) {
  if (!Buffer.isBuffer(nonceBuf) || nonceBuf.length !== 16) {
    throw new Error('Challenge Nonce must be a 16-byte Buffer');
  }
  return encodePacket(AUTH_CLIENTBOUND.CHALLENGE, nonceBuf);
}

/**
 * Clientbound 0x01 Auth Response: [1B Code]
 */
function encodeAuthResponse(code) {
  return encodePacket(AUTH_CLIENTBOUND.AUTH_RESPONSE, Buffer.from([code & 0xFF]));
}

/**
 * Serverbound 0x00 Protocol version payload decoder:
 * - Version (1B, must be 0x00 for v1)
 * - Device Type (1B: 0 = ESP32, 1 = Web)
 * - If Device Type == 0 (ESP32):
 *     - MAC Address (8B Long)
 *     - Firmware Version (String)
 * - If Device Type == 1 (Web):
 *     - Token (String)
 */
function decodeAuthProtocolVersion(payload) {
  if (payload.length < 2) {
    throw new Error('0x00 Protocol version payload too short');
  }
  const version = payload[0];
  const deviceType = payload[1];

  if (deviceType === DEVICE_TYPES.ESP32) {
    if (payload.length < 2 + 8 + 2) {
      throw new Error('ESP32 0x00 Protocol version payload too short');
    }
    const deviceMac = readMacHex(payload, 2);
    const { value: firmwareVersion, nextOffset } = readString(payload, 10);
    if (nextOffset !== payload.length) {
      throw new Error('Unexpected trailing bytes in ESP32 0x00 Protocol version');
    }
    return {
      version,
      deviceType,
      deviceMac,
      deviceMacBuf: payload.subarray(2, 10),
      firmwareVersion
    };
  } else if (deviceType === DEVICE_TYPES.WEB) {
    const { value: token, nextOffset } = readString(payload, 2);
    if (nextOffset !== payload.length) {
      throw new Error('Unexpected trailing bytes in Web 0x00 Protocol version');
    }
    return {
      version,
      deviceType,
      token
    };
  } else {
    throw new Error(`Invalid Device Type: ${deviceType}`);
  }
}

/**
 * Serverbound 0x01 Challenge Response (ESP32 only) payload decoder:
 * - Response (32B HMAC-SHA256)
 */
function decodeAuthChallengeResponse(payload) {
  if (payload.length !== 32) {
    throw new Error(`Invalid 0x01 Challenge Response length: expected 32 bytes, got ${payload.length}`);
  }
  return {
    responseHmac: payload
  };
}

// ============================================================================
// Data Packet Encoders (Clientbound)
// ============================================================================

/**
 * Clientbound 0x00 User info response (Web only):
 * [1B Is Admin][String Email][Entry Array of Device]
 */
function encodeUserInfoResponse({ isAdmin, email, devices }) {
  const adminByte = Buffer.from([isAdmin ? 0x01 : 0x00]);
  const emailBuf = encodeString(email);
  const devicesBuf = encodeEntryArray(devices, encodeDevice);
  return encodePacket(DATA_CLIENTBOUND.USER_INFO_RESPONSE, Buffer.concat([adminByte, emailBuf, devicesBuf]));
}

/**
 * Clientbound 0x01 Subscribe relay (ESP32 only): 0 bytes payload
 */
function encodeSubscribeRelay() {
  return encodePacket(DATA_CLIENTBOUND.SUBSCRIBE_RELAY);
}

/**
 * Clientbound 0x02 Unsubscribe relay (ESP32 only): 0 bytes payload
 */
function encodeUnsubscribeRelay() {
  return encodePacket(DATA_CLIENTBOUND.UNSUBSCRIBE_RELAY);
}

/**
 * Clientbound 0x03 Sensor dump relay (Web only):
 * [Entry Array of Register] (or pre-validated raw Entry Array buffer)
 */
function encodeSensorDumpRelay(registersOrRawBuf) {
  const payload = Buffer.isBuffer(registersOrRawBuf)
    ? registersOrRawBuf
    : encodeEntryArray(registersOrRawBuf, encodeRegister);
  return encodePacket(DATA_CLIENTBOUND.SENSOR_DUMP_RELAY, payload);
}

/**
 * Clientbound 0x04 Sensor delta relay (Web only):
 * [Entry Array of Register] (or pre-validated raw Entry Array buffer)
 */
function encodeSensorDeltaRelay(registersOrRawBuf) {
  const payload = Buffer.isBuffer(registersOrRawBuf)
    ? registersOrRawBuf
    : encodeEntryArray(registersOrRawBuf, encodeRegister);
  return encodePacket(DATA_CLIENTBOUND.SENSOR_DELTA_RELAY, payload);
}

/**
 * Clientbound 0x05 Write relay (ESP32 only):
 * [Entry Array of Register] (or pre-validated raw Entry Array buffer)
 */
function encodeWriteRelay(registersOrRawBuf) {
  const payload = Buffer.isBuffer(registersOrRawBuf)
    ? registersOrRawBuf
    : encodeEntryArray(registersOrRawBuf, encodeRegister);
  return encodePacket(DATA_CLIENTBOUND.WRITE_RELAY, payload);
}

/**
 * Clientbound 0x06 Device info update (Web only):
 * [Entry Array of Device]
 */
function encodeDeviceInfoUpdate(devices) {
  return encodePacket(DATA_CLIENTBOUND.DEVICE_INFO_UPDATE, encodeEntryArray(devices, encodeDevice));
}

/**
 * Clientbound 0x07 Write response relay (Web only):
 * [Entry Array of Register (Succeeded)][Entry Array of Register (Failed)]
 */
function encodeWriteResponseRelay(succeededOrRawBuf, failed) {
  if (Buffer.isBuffer(succeededOrRawBuf) && failed === undefined) {
    return encodePacket(DATA_CLIENTBOUND.WRITE_RESPONSE_RELAY, succeededOrRawBuf);
  }
  const succeededBuf = encodeEntryArray(succeededOrRawBuf, encodeRegister);
  const failedBuf = encodeEntryArray(failed, encodeRegister);
  return encodePacket(DATA_CLIENTBOUND.WRITE_RESPONSE_RELAY, Buffer.concat([succeededBuf, failedBuf]));
}

/**
 * Clientbound 0x08 OTA info (Web only):
 * [8B Device MAC][String Current Version][String Latest Version]
 */
function encodeOtaInfo({ deviceMac, currentVersion, latestVersion }) {
  const macBuf = macToLongBuffer(deviceMac);
  const curBuf = encodeString(currentVersion);
  const latBuf = encodeString(latestVersion);
  return encodePacket(DATA_CLIENTBOUND.OTA_INFO, Buffer.concat([macBuf, curBuf, latBuf]));
}

/**
 * Clientbound 0x09 OTA relay (ESP32 only):
 * [String Version][String Download URL]
 */
function encodeOtaRelay({ version, downloadUrl }) {
  const verBuf = encodeString(version);
  const urlBuf = encodeString(downloadUrl);
  return encodePacket(DATA_CLIENTBOUND.OTA_RELAY, Buffer.concat([verBuf, urlBuf]));
}

/**
 * Clientbound 0x0A Admin list users response (Web Admin only):
 * [Entry Array of String (Emails)]
 */
function encodeAdminListUsersResponse(emails) {
  return encodePacket(DATA_CLIENTBOUND.ADMIN_LIST_USERS_RESP, encodeEntryArray(emails, encodeString));
}

/**
 * Clientbound 0x0B Admin user details response (Web Admin only):
 * [String Email][1B Is Admin][Entry Array of Device]
 */
function encodeAdminUserDetailsResponse({ email, isAdmin, devices }) {
  const emailBuf = encodeString(email);
  const adminByte = Buffer.from([isAdmin ? 0x01 : 0x00]);
  const devicesBuf = encodeEntryArray(devices, encodeDevice);
  return encodePacket(DATA_CLIENTBOUND.ADMIN_USER_DETAILS_RESP, Buffer.concat([emailBuf, adminByte, devicesBuf]));
}

/**
 * Clientbound 0x0C Admin device registered response (Web Admin only):
 * [Device][32B Secret Key]
 */
function encodeAdminDeviceRegisteredResponse({ device, secretKeyBuf }) {
  if (!Buffer.isBuffer(secretKeyBuf) || secretKeyBuf.length !== 32) {
    throw new Error('Secret Key must be a 32-byte Buffer');
  }
  const devBuf = encodeDevice(device);
  return encodePacket(DATA_CLIENTBOUND.ADMIN_DEVICE_REG_RESP, Buffer.concat([devBuf, secretKeyBuf]));
}

/**
 * Clientbound 0x0D Admin list devices response (Web Admin only):
 * [Entry Array of Device]
 */
function encodeAdminListDevicesResponse(devices) {
  return encodePacket(DATA_CLIENTBOUND.ADMIN_LIST_DEVICES_RESP, encodeEntryArray(devices, encodeDevice));
}

/**
 * Clientbound 0x0E Admin device details response (Web Admin only):
 * [Device][32B Secret Key][String Firmware Version][Entry Array of String (Assigned Emails)]
 */
function encodeAdminDeviceDetailsResponse({ device, secretKeyBuf, firmwareVersion, assignedEmails }) {
  if (!Buffer.isBuffer(secretKeyBuf) || secretKeyBuf.length !== 32) {
    throw new Error('Secret Key must be a 32-byte Buffer');
  }
  const devBuf = encodeDevice(device);
  const fwBuf = encodeString(firmwareVersion || '');
  const emailsBuf = encodeEntryArray(assignedEmails || [], encodeString);
  return encodePacket(
    DATA_CLIENTBOUND.ADMIN_DEVICE_DETAILS_RESP,
    Buffer.concat([devBuf, secretKeyBuf, fwBuf, emailsBuf])
  );
}

module.exports = {
  CONNECTION_STATES,
  DEVICE_TYPES,
  AUTH_CLIENTBOUND,
  AUTH_SERVERBOUND,
  AUTH_CODES,
  DATA_CLIENTBOUND,
  DATA_SERVERBOUND,
  normalizeMacHex,
  macToLongBuffer,
  readMacHex,
  encodeString,
  readString,
  encodeDevice,
  readDevice,
  encodeRegister,
  readRegister,
  encodeEntryArray,
  readEntryArray,
  encodePacket,
  decodePacketHeader,
  encodeAuthChallenge,
  encodeAuthResponse,
  decodeAuthProtocolVersion,
  decodeAuthChallengeResponse,
  encodeUserInfoResponse,
  encodeSubscribeRelay,
  encodeUnsubscribeRelay,
  encodeSensorDumpRelay,
  encodeSensorDeltaRelay,
  encodeWriteRelay,
  encodeDeviceInfoUpdate,
  encodeWriteResponseRelay,
  encodeOtaInfo,
  encodeOtaRelay,
  encodeAdminListUsersResponse,
  encodeAdminUserDetailsResponse,
  encodeAdminDeviceRegisteredResponse,
  encodeAdminListDevicesResponse,
  encodeAdminDeviceDetailsResponse
};
