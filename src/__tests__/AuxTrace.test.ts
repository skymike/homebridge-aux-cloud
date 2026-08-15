import type { Logger } from 'homebridge';

import type { AuxDevice } from '../api/AuxCloudClient';
import { AuxTrace } from '../api/trace/AuxTrace';

function makeDevice(endpointId: string): AuxDevice {
  return {
    endpointId,
    friendlyName: 'Bedroom',
    productId: 'product-secret',
    devSession: 'session-secret',
    devicetypeFlag: 1,
    cookie: 'cookie-secret',
    mac: 'aa:bb:cc:dd:ee:ff',
    params: {},
    state: 1,
  };
}

function makeLogger(): { logger: Logger; records: string[] } {
  const records: string[] = [];
  const logger = {
    debug: jest.fn(),
    info: (_format: string, record: string) => records.push(record),
  } as unknown as Logger;
  return { logger, records };
}

describe('AuxTrace', () => {
  test('emits nothing when command tracing is disabled', () => {
    const { logger, records } = makeLogger();
    const trace = new AuxTrace(logger, false);
    const context = trace.createContext('hap.set', makeDevice('endpoint-one'));

    trace.emit('command.start', context, { characteristic: 'Active' });

    expect(records).toEqual([]);
  });

  test('keeps correlation and aliases stable without exposing device credentials', () => {
    const { logger, records } = makeLogger();
    const trace = new AuxTrace(logger, true);
    const firstDevice = makeDevice('endpoint-one');
    const secondDevice = makeDevice('endpoint-two');
    const context = trace.createContext('hap.set', firstDevice, {
      service: 'HeaterCooler',
      characteristic: 'Active',
    });

    trace.emit('command.start', context, { values: { pwr: 1 } });
    trace.emit('command.dispatch', context, { route: 'cloud' });

    const parsed = records.map((record) => JSON.parse(record) as Record<string, unknown>);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      event: 'command.start',
      source: 'hap.set',
      correlationId: 'cmd-1',
      service: 'HeaterCooler',
      characteristic: 'Active',
      values: { pwr: 1 },
    });
    expect(parsed[1]).toMatchObject({
      event: 'command.dispatch',
      correlationId: 'cmd-1',
      device: parsed[0].device,
      route: 'cloud',
    });
    expect(parsed[0].device).toMatch(/^device-[a-f0-9]{10}$/);
    expect(trace.deviceAlias(firstDevice)).toBe(parsed[0].device);
    expect(trace.deviceAlias(secondDevice)).not.toBe(parsed[0].device);

    const output = records.join('\n');
    for (const forbidden of [
      'endpoint-one',
      'endpoint-two',
      'aa:bb:cc:dd:ee:ff',
      'product-secret',
      'session-secret',
      'cookie-secret',
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  test('drops fields whose names can contain reusable secrets', () => {
    const { logger, records } = makeLogger();
    const trace = new AuxTrace(logger, true);
    const context = trace.createContext('provider', makeDevice('endpoint-one'));

    trace.emit('mqtt.publish', context, {
      topic: 'thing/endpoint-one/control',
      password: 'password-secret',
      token: 'token-secret',
      account: 'account-secret',
      endpointId: 'endpoint-one',
      mac: 'aa:bb:cc:dd:ee:ff',
      ip: '192.0.2.15',
      route: 'mqtt',
    });

    expect(JSON.parse(records[0])).toMatchObject({ event: 'mqtt.publish', route: 'mqtt' });
    expect(records[0]).not.toMatch(/thing\/|password-secret|token-secret|account-secret|endpoint-one|aa:bb|192\.0\.2\.15/);
  });
});
