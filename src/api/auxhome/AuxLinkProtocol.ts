import {
  appendCommandPayloadChecksum,
  broadlinkWireToAuxFanSpeed,
  broadlinkWireToAuxMode,
  buildCommandPayload,
} from '../broadlink/Protocol';

const STATE_SIGNATURE = Buffer.from('bb00070000010f000111', 'hex');

export interface AuxLinkState {
  power: number;
  temp: number;
  mode: number;
  fanspeed: number;
  verticalFixation: number;
  horizontalFixation: number;
  turbo: number;
  mute: number;
  sleep: number;
  health: number;
  clean: number;
  eco: number;
  display: number;
  mildew: number;
}

/**
 * Decode the direct, checksum-terminated AUXLink state frame.
 */
export function parseAuxLinkStatePayload(payload: Buffer): Partial<AuxLinkState> {
  if (payload.length !== 25 || !payload.subarray(0, STATE_SIGNATURE.length).equals(STATE_SIGNATURE)) {
    return {};
  }

  return {
    temp: 8 + (payload[10] >> 3) + ((payload[12] & 0x80) ? 0.5 : 0),
    verticalFixation: payload[10] & 0x07,
    horizontalFixation: payload[11] >> 5,
    fanspeed: payload[13] >> 5,
    turbo: (payload[14] >> 6) & 0x01,
    mute: (payload[14] >> 7) & 0x01,
    mode: payload[15] >> 5,
    sleep: (payload[15] >> 2) & 0x01,
    power: (payload[18] >> 5) & 0x01,
    eco: (payload[18] >> 4) & 0x01,
    health: (payload[18] >> 1) & 0x01,
    clean: (payload[18] >> 2) & 0x01,
    display: (payload[20] >> 4) & 0x01,
    mildew: (payload[20] >> 3) & 0x01,
  };
}

/**
 * Build the 25-byte direct AUXLink command frame from cloud-format parameters.
 */
export function buildAuxLinkCommandPayload(params: Record<string, number>): Buffer {
  const temp = params['temp'];
  const commandParams = {
    ...params,
    ...(temp !== undefined && temp > 100 ? { temp: temp / 10 } : {}),
    eco: params['eco'] ?? params['ecomode'] ?? 0,
  };
  const lanPayload = buildCommandPayload(commandParams);
  const body = lanPayload.subarray(2, 25);

  return appendCommandPayloadChecksum(body);
}

/**
 * Convert wire-level state values into the cloud parameter names used by accessories.
 */
export function auxLinkStateToParams(state: Partial<AuxLinkState>): Record<string, number> {
  const params: Record<string, number> = {};

  if (state.power !== undefined) params['pwr'] = state.power;
  if (state.temp !== undefined) params['temp'] = Math.round(state.temp * 10);
  if (state.mode !== undefined) params['ac_mode'] = broadlinkWireToAuxMode(state.mode);
  if (state.fanspeed !== undefined) params['ac_mark'] = broadlinkWireToAuxFanSpeed(state.fanspeed);
  if (state.mute) params['ac_mark'] = 5;
  if (state.verticalFixation !== undefined) params['ac_vdir'] = state.verticalFixation;
  if (state.horizontalFixation !== undefined) params['ac_hdir'] = state.horizontalFixation;
  if (state.turbo !== undefined) params['turbo'] = state.turbo;
  if (state.sleep !== undefined) params['ac_slp'] = state.sleep;
  if (state.health !== undefined) params['ac_health'] = state.health;
  if (state.clean !== undefined) params['ac_clean'] = state.clean;
  if (state.eco !== undefined) params['ecomode'] = state.eco;
  if (state.display !== undefined) params['scrdisp'] = state.display;
  if (state.mildew !== undefined) params['mldprf'] = state.mildew;

  return params;
}
