import type { AuxHomeMqttMessage } from '../../api/auxhome/AuxHomeMqttSession';
import type { AuxHomeDeviceRecord, AuxHomeSession } from '../../api/auxhome/AuxHomeTypes';
import { AuxHomeProvider } from '../../api/providers/AuxHomeProvider';
import { createProvider } from '../../api/providers/createProvider';

const DEVICE_ID = 'synthetic-device-0001';
const STATE_QUERY = Buffer.from('bb0006800000020011012b7e', 'hex');
const POWER_ON_25C = Buffer.from('bb00070000010f000111880001a000200000200000000537ac', 'hex');
const POWER_OFF_24C = Buffer.from('bb00070000010f000111800001a00020000000000000053784', 'hex');

class FakeRestClient {
  public readonly login = jest.fn<Promise<AuxHomeSession>, [string, string]>();

  public readonly listDevices = jest.fn<Promise<AuxHomeDeviceRecord[]>, []>();

  public readonly invalidateSession = jest.fn<void, []>();
}

class FakeMqttSession {
  public connected = false;

  public readonly connect = jest.fn<void, [readonly { did: string }[]]>();

  public readonly publish = jest.fn<void, [string, Buffer | string]>();

  public readonly close = jest.fn<void, []>();

  private listener?: (message: AuxHomeMqttMessage) => void;

  public onMessage(listener: (message: AuxHomeMqttMessage) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public emit(payload: Buffer, deviceId = DEVICE_ID): void {
    this.listener?.({ deviceId, payload });
  }
}

function deviceRecord(overrides: Partial<AuxHomeDeviceRecord> = {}): AuxHomeDeviceRecord {
  return {
    endpointId: DEVICE_ID,
    did: DEVICE_ID,
    alias: 'Synthetic lounge unit',
    mac: 'AA:BB:CC:DD:EE:01',
    modelId: 'synthetic-model',
    password: 'never-normalize-device-password',
    passCode: 'never-normalize-device-passcode',
    productKey: 'synthetic-product',
    online: true,
    status: { pwr: 0, temp: 240, ac_mode: 1, ac_mark: 0 },
    ...overrides,
  };
}

function setup(commandTimeoutMs = 1_000) {
  const restClient = new FakeRestClient();
  const mqtt = new FakeMqttSession();
  restClient.login.mockResolvedValue({ uid: 'synthetic-user', token: 'synthetic-session' });
  restClient.listDevices.mockResolvedValue([deviceRecord()]);
  const provider = new AuxHomeProvider({
    restClient,
    mqttSessionFactory: () => mqtt,
    commandTimeoutMs,
    now: () => new Date('2026-08-13T10:00:00.000Z'),
  });
  return { mqtt, provider, restClient };
}

async function discover(provider: AuxHomeProvider, mqtt: FakeMqttSession) {
  await provider.ensureLoggedIn('synthetic-account@example.test', 'synthetic-account-password');
  const devices = await provider.listDevices();
  mqtt.connected = true;
  return devices;
}

describe('AuxHomeProvider', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('logs in once without retaining account credentials for later calls', async () => {
    const { provider, restClient } = setup();

    await provider.ensureLoggedIn('first-account@example.test', 'first-password');
    await provider.ensureLoggedIn('second-account@example.test', 'second-password');

    expect(restClient.login).toHaveBeenCalledTimes(1);
    expect(restClient.login).toHaveBeenCalledWith('first-account@example.test', 'first-password');
  });

  test('normalizes REST records without device passcodes, passwords, or opaque metadata', async () => {
    const { mqtt, provider } = setup();

    const [device] = await discover(provider, mqtt);

    expect(device).toEqual({
      endpointId: DEVICE_ID,
      friendlyName: 'Synthetic lounge unit',
      productId: 'synthetic-product',
      devSession: '',
      devicetypeFlag: 0,
      cookie: '',
      mac: 'aa:bb:cc:dd:ee:01',
      params: { pwr: 0, temp: 240, ac_mode: 1, ac_mark: 0 },
      state: 1,
      lastUpdated: '2026-08-13T10:00:00.000Z',
    });
    expect(JSON.stringify(device)).not.toContain('never-normalize');
  });

  test('filters discovered devices before connecting MQTT to the included device set', async () => {
    const { mqtt, provider, restClient } = setup();
    restClient.listDevices.mockResolvedValue([
      deviceRecord(),
      deviceRecord({ endpointId: 'synthetic-device-0002', did: 'synthetic-device-0002' }),
      deviceRecord({ endpointId: 'synthetic-device-0003', did: 'synthetic-device-0003' }),
    ]);
    await provider.ensureLoggedIn('synthetic-account@example.test', 'synthetic-password');

    const devices = await provider.listDevices({
      includeIds: new Set([DEVICE_ID, 'synthetic-device-0002']),
      excludeIds: new Set(['synthetic-device-0002']),
    });

    expect(devices.map((device) => device.endpointId)).toEqual([DEVICE_ID]);
    expect(mqtt.connect).toHaveBeenCalledWith([{ did: DEVICE_ID }]);
  });

  test('publishes a complete 25-byte command and resolves only after matching pushed state', async () => {
    const { mqtt, provider } = setup();
    const [device] = await discover(provider, mqtt);

    let settled = false;
    const command = provider.setDeviceParams(device, { pwr: 1, temp: 250 }).then(() => {
      settled = true;
    });
    expect(mqtt.publish).toHaveBeenCalledTimes(1);
    const [, payload] = mqtt.publish.mock.calls[0];
    expect(Buffer.isBuffer(payload)).toBe(true);
    expect((payload as Buffer)).toHaveLength(25);

    mqtt.emit(POWER_OFF_24C);
    await Promise.resolve();
    expect(settled).toBe(false);

    mqtt.emit(POWER_ON_25C);
    await expect(command).resolves.toBeUndefined();
    expect(await provider.refreshDeviceParams(device)).toMatchObject({ pwr: 1, temp: 250, ac_mode: 0 });
  });

  test('accepts a sequence-zero state frame and emits one normalized listener update', async () => {
    const { mqtt, provider } = setup();
    await discover(provider, mqtt);
    const listener = jest.fn();
    provider.onStateChange(listener);

    mqtt.emit(POWER_ON_25C);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: DEVICE_ID,
      params: expect.objectContaining({ pwr: 1, temp: 250 }),
    }));
  });

  test('rejects a timed-out command without applying its optimistic values', async () => {
    jest.useFakeTimers();
    const { mqtt, provider } = setup(500);
    const [device] = await discover(provider, mqtt);

    const command = provider.setDeviceParams(device, { pwr: 1, temp: 250 });
    const rejection = expect(command).rejects.toThrow('AUX Home command confirmation timed out');
    jest.advanceTimersByTime(500);

    await rejection;
    expect(await provider.refreshDeviceParams(device)).toMatchObject({ pwr: 0, temp: 240 });
  });

  test('refreshes from the latest push and publishes the verified state query only while connected', async () => {
    const { mqtt, provider } = setup();
    const [device] = await discover(provider, mqtt);
    mqtt.emit(POWER_ON_25C);
    mqtt.publish.mockClear();

    await expect(provider.refreshDeviceParams(device)).resolves.toMatchObject({ pwr: 1, temp: 250 });
    expect(mqtt.publish).toHaveBeenCalledWith(DEVICE_ID, STATE_QUERY);

    mqtt.connected = false;
    mqtt.publish.mockClear();
    await expect(provider.refreshDeviceParams(device)).resolves.toMatchObject({ pwr: 1, temp: 250 });
    expect(mqtt.publish).not.toHaveBeenCalled();
  });

  test('invalidateSession and close reject pending work, clear state, unsubscribe, and close MQTT', async () => {
    jest.useFakeTimers();
    const { mqtt, provider, restClient } = setup(5_000);
    const [device] = await discover(provider, mqtt);
    const listener = jest.fn();
    provider.onStateChange(listener);
    const pending = provider.setDeviceParams(device, { pwr: 1 });
    const invalidated = expect(pending).rejects.toThrow('AUX Home session was invalidated');

    provider.invalidateSession();

    await invalidated;
    expect(restClient.invalidateSession).toHaveBeenCalledTimes(1);
    expect(mqtt.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    mqtt.emit(POWER_ON_25C);
    expect(listener).not.toHaveBeenCalled();
    await expect(provider.listDevices()).rejects.toThrow('AUX Home session is not authenticated');

    await provider.ensureLoggedIn('synthetic-account@example.test', 'synthetic-password');
    await provider.listDevices();
    await provider.close();
    expect(restClient.invalidateSession).toHaveBeenCalledTimes(2);
    expect(mqtt.close).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('createProvider AUX Home selection', () => {
  test('constructs the AUX Home coordinator for the EU region', () => {
    expect(createProvider({ provider: 'aux-home', region: 'eu' })).toBeInstanceOf(AuxHomeProvider);
  });
});
