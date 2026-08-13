/**
 * Broadlink LAN protocol helpers based on homebridge-broadlink-heater-cooler
 * (makleso6). AES-128-CBC with fixed key/IV for older firmware AC devices.
 */

import { createCipheriv, createDecipheriv } from 'crypto';

// Default AES key and IV for Broadlink devices (older firmware)
const DEFAULT_KEY = Buffer.from([
  0x09, 0x76, 0x28, 0x34, 0x3f, 0xe9, 0x9e, 0x23,
  0x76, 0x5c, 0x15, 0x13, 0xac, 0xcf, 0x8b, 0x02,
]);

const DEFAULT_IV = Buffer.from([
  0x56, 0x2e, 0x17, 0x99, 0x6d, 0x09, 0x3d, 0x28,  // byte 3: 0x99 (not 0x09)
  0xdd, 0xb3, 0xba, 0x69, 0x5a, 0x2e, 0x6f, 0x58,
]);

export enum BroadlinkCommand {
  Auth = 0x65,
  Packet = 0x6a,
  // Responses
  ResponseFixation = 0xe9,
  ResponseState = 0xee,
}

export enum BroadlinkPower {
  Off = 0,
  On = 1,
}

/**
 * Broadlink wire protocol mode values (byte 15 in command, byte 17 in response).
 * These differ from AUX cloud API mode values (AuxAcModeValue in constants.ts).
 *
 * Reference: broadlink-aircon-api Mode enum.
 */
export enum BroadlinkMode {
  Auto = 0,
  Cooling = 1,
  Dry = 2,
  Heating = 4,
  Fan = 6,
}

/**
 * Broadlink wire protocol fan speed values (byte 13 in command, byte 15 in response).
 * These differ from AUX cloud API fan speed values (AuxFanSpeed in constants.ts).
 *
 * Reference: broadlink-aircon-api Fanspeed enum.
 */
export enum BroadlinkFanSpeed {
  High = 1,
  Medium = 2,
  Low = 3,
  Turbo = 4,
  Auto = 5,
}

/**
 * AUX cloud API mode values (used in device.params and HomeKit mapping).
 * Kept in sync with AuxAcModeValue in constants.ts — duplicated here to avoid
 * circular imports between Protocol.ts and constants.ts.
 */
const AUX_MODE_TO_BROADLINK: Record<number, BroadlinkMode> = {
  0: BroadlinkMode.Cooling,
  1: BroadlinkMode.Heating,
  2: BroadlinkMode.Dry,
  3: BroadlinkMode.Fan,
  4: BroadlinkMode.Auto,
};

const BROADLINK_MODE_TO_AUX: Record<number, number> = {
  [BroadlinkMode.Auto]:    4, // AuxAcModeValue.AUTO
  [BroadlinkMode.Cooling]: 0, // AuxAcModeValue.COOLING
  [BroadlinkMode.Dry]:     2, // AuxAcModeValue.DRY
  [BroadlinkMode.Heating]: 1, // AuxAcModeValue.HEATING
  [BroadlinkMode.Fan]:     3, // AuxAcModeValue.FAN
};

/**
 * AUX cloud fan speed values → Broadlink wire fan speed values.
 * Wire values: high=1, medium=2, low=3, turbo=4, auto=5.
 * Mute is handled via a separate bit (mute flag) not via fanspeed byte.
 */
const AUX_FANSPEED_TO_BROADLINK: Record<number, number> = {
  0: BroadlinkFanSpeed.Auto,   // AuxFanSpeed.AUTO
  1: BroadlinkFanSpeed.Low,    // AuxFanSpeed.LOW
  2: BroadlinkFanSpeed.Medium, // AuxFanSpeed.MEDIUM
  3: BroadlinkFanSpeed.High,   // AuxFanSpeed.HIGH
  4: BroadlinkFanSpeed.Turbo,  // AuxFanSpeed.TURBO
  5: BroadlinkFanSpeed.Auto,   // AuxFanSpeed.MUTE — mute bit handled separately
};

const BROADLINK_FANSPEED_TO_AUX: Record<number, number> = {
  [BroadlinkFanSpeed.High]:   3, // AuxFanSpeed.HIGH
  [BroadlinkFanSpeed.Medium]: 2, // AuxFanSpeed.MEDIUM
  [BroadlinkFanSpeed.Low]:    1, // AuxFanSpeed.LOW
  [BroadlinkFanSpeed.Turbo]:  4, // AuxFanSpeed.TURBO
  [BroadlinkFanSpeed.Auto]:   0, // AuxFanSpeed.AUTO
};

/**
 * Translate an AUX cloud API mode value to the Broadlink wire protocol mode value.
 */
export function auxModeToBroadlinkWire(auxMode: number): number {
  return AUX_MODE_TO_BROADLINK[auxMode] ?? BroadlinkMode.Auto;
}

/**
 * Translate a Broadlink wire protocol mode value to an AUX cloud API mode value.
 */
export function broadlinkWireToAuxMode(wireMode: number): number {
  return BROADLINK_MODE_TO_AUX[wireMode] ?? 4; // default AUTO
}

/**
 * Translate an AUX cloud API fan speed value to the Broadlink wire fan speed value.
 * Note: MUTE (AuxFanSpeed=5) maps to Auto wire value; the mute bit is set separately.
 */
export function auxFanSpeedToBroadlinkWire(auxFanSpeed: number): number {
  return AUX_FANSPEED_TO_BROADLINK[auxFanSpeed] ?? BroadlinkFanSpeed.Auto;
}

/**
 * Translate a Broadlink wire fan speed value to an AUX cloud API fan speed value.
 * Note: When mute bit is set, caller should override result with AuxFanSpeed.MUTE(5).
 */
export function broadlinkWireToAuxFanSpeed(wireFanSpeed: number): number {
  return BROADLINK_FANSPEED_TO_AUX[wireFanSpeed] ?? 0; // default AUTO
}

export interface BroadlinkAState {
  power: BroadlinkPower;
  temp: number;
  mode: BroadlinkMode;
  fanspeed: BroadlinkFanSpeed;
  verticalFixation: number;
  horizontalFixation: number;
  turbo: number;
  mute: number;
  health: number;
  clean: number;
  display: number;
  mildew: number;
  sleep: number;
  ambientTemp?: number;
}

// Packet header magic bytes
const HEADER_MAGIC = Buffer.from([
  0x5a, 0xa5, 0xaa, 0x55,
  0x5a, 0xa5, 0xaa, 0x55,
]);

/**
 * Calculate 16-bit checksum (byte sum starting from 0xbeaf, wrapped to 16 bits).
 * Used for Broadlink packet header checksums (inner at 0x34-0x35, outer at 0x20-0x21).
 */
export function calculateChecksum(data: Buffer): number {
  let sum = 0xbeaf;
  for (let i = 0; i < data.length; i++) {
    sum = (sum + data[i]) & 0xffff;
  }
  return sum;
}

/**
 * Internet checksum (16-bit ones complement sum) used for the AC command payload CRC.
 * Different from calculateChecksum — matches broadlink-aircon-api reference.
 */
function commandPayloadChecksum(data: Buffer): number {
  let sum = 0;
  for (let i = 0; i < data.length; i += 2) {
    sum += ((data[i] << 8) & 0xff00) + (data[i + 1] & 0xff);
  }
  while (sum >> 16) {
    sum = (sum & 0xffff) + (sum >> 16);
  }
  return 0xffff ^ sum;
}

/**
 * Append the two-byte AC command checksum to a 23-byte AC command body.
 */
export function appendCommandPayloadChecksum(body: Buffer): Buffer {
  const crc = commandPayloadChecksum(body);
  return Buffer.concat([body, Buffer.from([(crc >> 8) & 0xff, crc & 0xff])]);
}

/**
 * Encrypt payload with AES-128-CBC (zero padding, no auto padding).
 */
export function encryptPayload(payload: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-cbc', DEFAULT_KEY, DEFAULT_IV);
  cipher.setAutoPadding(false);
  const encrypted = cipher.update(payload);
  const final = cipher.final();
  return final.length > 0 ? Buffer.concat([encrypted, final]) : encrypted;
}

/**
 * Decrypt response from device.
 * Accepts optional device-specific key obtained from auth response.
 */
export function decryptPayload(response: Buffer, key: Buffer = DEFAULT_KEY): Buffer {
  const encPayload = response.subarray(0x38);
  if (encPayload.length === 0) return Buffer.alloc(0);
  const decipher = createDecipheriv('aes-128-cbc', key, DEFAULT_IV);
  decipher.setAutoPadding(false);
  const payload = decipher.update(encPayload);
  const final = decipher.final();
  return final.length > 0 ? Buffer.concat([payload, final]) : payload;
}

/**
 * Parse auth response (0xe9) to extract device-specific key and ID.
 * Returns null if response has no payload (some devices omit key exchange).
 */
export interface AuthResult {
  key: Buffer;
  id: Buffer;
}

export function parseAuthResponse(response: Buffer): AuthResult | null {
  const payload = decryptPayload(response, DEFAULT_KEY);
  if (payload.length < 0x14) return null;
  const key = Buffer.alloc(0x10, 0);
  payload.copy(key, 0, 0x04, 0x14);
  const id = Buffer.alloc(4, 0);
  payload.copy(id, 0, 0x00, 0x04);
  return { key, id };
}

/**
 * Build a Broadlink UDP packet wrapper.
 * Payload is encrypted with AES-128-CBC using the provided key (default key for auth).
 * Format matches broadlink-aircon-api reference implementation exactly.
 */
export function buildPacket(
  payload: Buffer,
  command: BroadlinkCommand,
  mac: Buffer,
  id: Buffer = Buffer.alloc(4, 0),
  count: number = 1,
  key: Buffer = DEFAULT_KEY,
): Buffer {
  const header = Buffer.alloc(0x38, 0);

  // Header magic
  HEADER_MAGIC.copy(header, 0);

  // Required fields (0x24-0x25) — present in reference implementation
  header[0x24] = 0x2a;
  header[0x25] = 0x27;

  // Command type
  header[0x26] = command;

  // Packet count
  header[0x28] = count & 0xff;
  header[0x29] = (count >> 8) & 0xff;

  // MAC address
  mac.copy(header, 0x2a, 0, 6);

  // Device ID
  id.copy(header, 0x30, 0, 4);

  // Inner checksum of plaintext payload (stored before encryption, at 0x34-0x35)
  const innerChk = calculateChecksum(payload);
  header[0x34] = innerChk & 0xff;
  header[0x35] = (innerChk >> 8) & 0xff;

  // Encrypt payload with AES-128-CBC (cipher.update only — avoids unwanted PKCS#7 padding block)
  const cipher = createCipheriv('aes-128-cbc', key, DEFAULT_IV);
  const encryptedPayload = cipher.update(payload);

  const packet = Buffer.concat([header, encryptedPayload]);

  // Outer checksum over the entire packet (byte sum from 0xbeaf, little-endian)
  const outerChk = calculateChecksum(packet);
  packet[0x20] = outerChk & 0xff;
  packet[0x21] = (outerChk >> 8) & 0xff;

  return packet;
}

/**
 * Build a command payload for AC control (power, temp, mode, fan, swing, etc).
 * Based on the updateModel method from broadlink-aircon-api.
 */
function buildAcCommandBody(params: Record<string, number>): Buffer {
  const power = params['pwr'] ?? 0;
  const temp = params['temp'] ?? 24;
  // Translate AUX cloud mode → Broadlink wire mode
  const mode = auxModeToBroadlinkWire(params['ac_mode'] ?? 4); // default AUTO
  // Translate AUX cloud fan speed → Broadlink wire fan speed
  const auxFan = params['ac_mark'] ?? 0;
  const isMute = auxFan === 5; // AuxFanSpeed.MUTE
  const fanspeed = auxFanSpeedToBroadlinkWire(auxFan);
  const verticalFixation = params['ac_vdir'] ?? 0;
  const horizontalFixation = params['ac_hdir'] ?? 0;
  const turbo = params['turbo'] ?? 0;
  // isMute: either ac_mark=MUTE (5) or explicit mute param
  const mute = (isMute || (params['mute'] ?? 0)) ? 1 : 0;
  const health = params['ac_health'] ?? 0;
  const clean = params['ac_clean'] ?? 0;
  const display = params['scrdisp'] ?? 0;
  const mildew = params['mldprf'] ?? 0;

  // Temperature encoding: actual temp - 8, stored in bits 3-7
  let temperature = temp - 8;
  if (temperature < 0) temperature = 0;
  const hasHalfDegree = !Number.isInteger(temp);

  const payload = Buffer.alloc(23, 0);
  payload[0] = 0xbb;
  payload[1] = 0x00;
  payload[2] = 0x06; // Command: 0x06 = set, 0x07 = get info
  payload[3] = 0x80;
  payload[4] = 0x00;
  payload[5] = 0x00;
  payload[6] = 0x0f; // Set status
  payload[7] = 0x00;
  payload[8] = 0x01;
  payload[9] = 0x01;
  // Byte 10: temperature (bits 3-7) | verticalFixation (bits 0-2)
  payload[10] = (temperature << 3) | (verticalFixation & 0x07);
  // Byte 11: horizontalFixation (bits 5-7)
  payload[11] = (horizontalFixation & 0x07) << 5;
  // Byte 12: required marker 0x0F (bits 0-3) | half-degree flag (bit 7)
  // Reference: payload[12] = 0b00001111 | temperature_05 << 7
  // Without 0x0F the device silently discards the command.
  payload[12] = 0x0f | (hasHalfDegree ? 0x80 : 0x00);
  // Byte 13: fanspeed (bits 5-7)
  payload[13] = (fanspeed & 0x07) << 5;
  // Byte 14: turbo (bit 6) | mute (bit 7)
  payload[14] = (turbo & 0x01) << 6 | (mute & 0x01) << 7;
  // Byte 15: mode (bits 5-8) | sleep (bits 2-3)
  payload[15] = (mode & 0x0f) << 5 | (params['ac_slp'] ?? 0) << 2;
  payload[16] = 0x00;
  payload[17] = 0x00;
  // Byte 18: power (bit 5) | health (bit 1) | clean (bit 2)
  payload[18] = (power & 0x01) << 5 | (health & 0x01) << 1 | (clean & 0x01) << 2;
  payload[19] = 0x00;
  // Byte 20: display (bit 4) | mildew (bits 3-4)
  payload[20] = (display & 0x01) << 4 | (mildew & 0x01) << 3;
  payload[21] = 0x00;
  payload[22] = 0x00;

  return payload;
}

/**
 * Build a command payload for AC control (power, temp, mode, fan, swing, etc).
 * Based on the updateModel method from broadlink-aircon-api.
 */
export function buildCommandPayload(
  params: Record<string, number>,
): Buffer {
  const payload = buildAcCommandBody(params);
  const length = payload.length;
  const requestPayload = Buffer.alloc(32, 0);
  requestPayload[0] = length + 2;
  payload.copy(requestPayload, 2);

  appendCommandPayloadChecksum(payload).copy(requestPayload, length + 2, length, length + 2);

  return requestPayload;
}

/**
 * Build a getState request (magic bytes for querying device state).
 */
export function buildGetStatePacket(mac: Buffer): Buffer {
  const magic = Buffer.from('0C00BB0006800000020011012B7E0000', 'hex');
  return buildPacket(magic, BroadlinkCommand.Packet, mac);
}

/**
 * Build a getInfo request (queries ambient temperature, etc).
 */
export function buildGetInfoPacket(mac: Buffer): Buffer {
  const magic = Buffer.from('0C00BB0006800000020021011B7E0000', 'hex');
  return buildPacket(magic, BroadlinkCommand.Packet, mac);
}

/**
 * Parse a response payload to extract AC state.
 * Based on updateStatus and updateInfo from broadlink-aircon-api.
 */
export function parseStatePayload(payload: Buffer): Partial<BroadlinkAState> {
  const state: Partial<BroadlinkAState> = {};

  if (payload.length === 32) {
    // updateStatus
    state.temp = 8 + (payload[12] >> 3);
    state.power = (payload[20] >> 5) & 0x01;
    state.verticalFixation = payload[12] & 0x07;
    state.mode = (payload[17] >> 5) & 0x0f;
    state.sleep = (payload[17] >> 2) & 0x01;
    state.display = (payload[22] >> 4) & 0x01;
    state.mildew = (payload[22] >> 3) & 0x01;
    state.health = (payload[20] >> 1) & 0x01;
    state.horizontalFixation = (payload[12] & 0x07) << 0;
    state.fanspeed = (payload[15] >> 5) & 0x07;
    state.mute = (payload[16] >> 7) & 0x01;
    state.turbo = (payload[16] >> 6) & 0x01;
    state.clean = (payload[20] >> 2) & 0x01;
  }

  if (payload.length === 48) {
    // updateInfo — ambient temperature
    const amb_05 = payload[33] / 10;
    let amb = payload[17] & 0x1f;
    if (payload[17] > 63) {
      amb += 32;
    }
    state.ambientTemp = amb_05 + amb;
  }

  return state;
}
