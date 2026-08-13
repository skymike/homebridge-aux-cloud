import {
  auxLinkStateToParams,
  buildAuxLinkCommandPayload,
  parseAuxLinkStatePayload,
} from '../../api/auxhome/AuxLinkProtocol';
import { buildCommandPayload } from '../../api/broadlink/Protocol';

describe('AUXLink protocol', () => {
  it('decodes a signed direct state frame', () => {
    const frame = Buffer.from('bb00070000010f000111880081a0002000002000000005372c', 'hex');

    expect(parseAuxLinkStatePayload(frame)).toMatchObject({
      temp: 25.5,
      power: 1,
      mode: 1,
      fanspeed: 5,
      verticalFixation: 0,
      horizontalFixation: 0,
      eco: 0,
    });
  });

  it('decodes every supported state feature bit', () => {
    const frame = Buffer.from('bb00070000010f0001118d208fe0c0c4000036001800000000', 'hex');

    expect(parseAuxLinkStatePayload(frame)).toEqual({
      temp: 25.5,
      power: 1,
      mode: 6,
      fanspeed: 7,
      verticalFixation: 5,
      horizontalFixation: 1,
      turbo: 1,
      mute: 1,
      sleep: 1,
      health: 1,
      clean: 1,
      eco: 1,
      display: 1,
      mildew: 1,
    });
  });

  it.each([
    ['truncated', Buffer.from('bb0007', 'hex')],
    ['wrong-sized', Buffer.alloc(25)],
  ])('rejects a %s state frame', (_name, payload) => {
    expect(parseAuxLinkStatePayload(payload)).toEqual({});
  });

  it('builds a complete-state direct command', () => {
    const params = {
      pwr: 1, temp: 255, ac_mode: 0, ac_mark: 0,
      ac_vdir: 3, ac_hdir: 1, scrdisp: 1,
      eco: 1, ac_slp: 1, ac_health: 1,
    };

    const direct = buildAuxLinkCommandPayload(params);

    expect(direct).toHaveLength(25);
    expect(direct.subarray(0, 10).toString('hex')).toBe('bb00068000000f000101');
    expect(direct[10] & 0x07).toBe(3);
    expect(direct[11] >> 5).toBe(1);
    expect(direct[12] & 0x80).toBe(0x80);
  });

  it('preserves the legacy LAN frame when direct-only ECO is supplied', () => {
    expect(buildCommandPayload({ eco: 1 }).toString('hex'))
      .toBe('1900bb00068000000f00010180000fa00000000000000000009edd0000000000');
  });

  it.each([
    [0, 1],
    [1, 4],
    [2, 2],
    [3, 6],
    [4, 0],
  ])('encodes AUX mode %i as wire mode %i', (acMode, wireMode) => {
    expect(buildAuxLinkCommandPayload({ ac_mode: acMode })[15] >> 5).toBe(wireMode);
  });

  it.each([
    [0, 5, 0],
    [1, 3, 0],
    [2, 2, 0],
    [3, 1, 0],
    [4, 4, 0],
    [5, 5, 1],
  ])('encodes AUX fan %i as wire fan %i and mute %i', (acMark, wireFan, mute) => {
    const direct = buildAuxLinkCommandPayload({ ac_mark: acMark });

    expect(direct[13] >> 5).toBe(wireFan);
    expect((direct[14] >> 7) & 0x01).toBe(mute);
  });

  it.each([0, 1, 2, 3, 4, 5])('encodes vertical position %i', (verticalFixation) => {
    expect(buildAuxLinkCommandPayload({ ac_vdir: verticalFixation })[10] & 0x07).toBe(verticalFixation);
  });

  it.each([0, 1])('encodes horizontal position %i', (horizontalFixation) => {
    expect(buildAuxLinkCommandPayload({ ac_hdir: horizontalFixation })[11] >> 5).toBe(horizontalFixation);
  });

  it.each([
    [25, 0x88, 0],
    [25.5, 0x88, 0x80],
  ])('encodes %s C target temperature', (temp, expectedByte, halfDegreeBit) => {
    const direct = buildAuxLinkCommandPayload({ temp });

    expect(direct[10] & 0xf8).toBe(expectedByte);
    expect(direct[12] & 0x80).toBe(halfDegreeBit);
  });

  it.each([
    ['turbo', 'turbo', 14, 0x40],
    ['sleep', 'ac_slp', 15, 0x04],
    ['health', 'ac_health', 18, 0x02],
    ['clean', 'ac_clean', 18, 0x04],
    ['eco', 'eco', 18, 0x10],
    ['cloud ECO', 'ecomode', 18, 0x10],
    ['display', 'scrdisp', 20, 0x10],
    ['mildew', 'mldprf', 20, 0x08],
  ])('encodes %s feature bit', (_name, parameter, byte, bit) => {
    expect(buildAuxLinkCommandPayload({ [parameter]: 1 })[byte] & bit).toBe(bit);
  });

  it('maps decoded wire state to existing cloud parameter names', () => {
    expect(auxLinkStateToParams({
      power: 1,
      temp: 25.5,
      mode: 1,
      fanspeed: 3,
      verticalFixation: 4,
      horizontalFixation: 1,
      turbo: 1,
      mute: 1,
      sleep: 1,
      health: 1,
      clean: 1,
      eco: 1,
      display: 1,
      mildew: 1,
    })).toEqual({
      pwr: 1,
      temp: 255,
      ac_mode: 0,
      ac_mark: 5,
      ac_vdir: 4,
      ac_hdir: 1,
      turbo: 1,
      ac_slp: 1,
      ac_health: 1,
      ac_clean: 1,
      ecomode: 1,
      scrdisp: 1,
      mldprf: 1,
    });
  });
});
