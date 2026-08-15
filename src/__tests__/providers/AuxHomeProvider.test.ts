import type { AuxHomeMqttMessage } from '../../api/auxhome/AuxHomeMqttSession';
import type { AuxHomeDeviceRecord, AuxHomeSession } from '../../api/auxhome/AuxHomeTypes';
import { AuxHomeRestError } from '../../api/auxhome/AuxHomeRestClient';
import { AuxHomeProvider } from '../../api/providers/AuxHomeProvider';
import { createProvider } from '../../api/providers/createProvider';
import type { Logger } from 'homebridge';
import { AuxTrace } from '../../api/trace/AuxTrace';

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
  private authListener?: (error: Error) => void;
  private connectedListener?: () => void;

  public onMessage(listener: (message: AuxHomeMqttMessage) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = undefined;
    };
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public onAuthenticationFailure(listener: (error: Error) => void): () => void {
    this.authListener = listener;
    return () => { this.authListener = undefined; };
  }

  public onConnected(listener: () => void): () => void {
    this.connectedListener = listener;
    return () => { this.connectedListener = undefined; };
  }

  public emitAuthenticationFailure(): void {
    this.authListener?.(new Error('AUX Home MQTT authentication rejected'));
  }

  public emitConnected(): void {
    this.connected = true;
    this.connectedListener?.();
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

function setup(commandTimeoutMs = 1_000, trace?: AuxTrace) {
  const restClient = new FakeRestClient();
  const mqtt = new FakeMqttSession();
  restClient.login.mockResolvedValue({ uid: 'synthetic-user', token: 'synthetic-session' });
  restClient.listDevices.mockResolvedValue([deviceRecord()]);
  const provider = new AuxHomeProvider({
    restClient,
    mqttSessionFactory: () => mqtt,
    commandTimeoutMs,
    now: () => new Date('2026-08-13T10:00:00.000Z'),
    trace,
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

  test('reuses an established session without logging in again', async () => {
    const { provider, restClient } = setup();

    await provider.ensureLoggedIn('first-account@example.test', 'first-password');
    await provider.ensureLoggedIn('second-account@example.test', 'second-password');

    expect(restClient.login).toHaveBeenCalledTimes(1);
    expect(restClient.login).toHaveBeenCalledWith('first-account@example.test', 'first-password');
  });

  test('coalesces concurrent view login into one REST session and one MQTT session', async () => {
    const restClient = new FakeRestClient();
    const mqtt = new FakeMqttSession();
    let resolveLogin!: (session: AuxHomeSession) => void;
    restClient.login.mockImplementation(() => new Promise((resolve) => { resolveLogin = resolve; }));
    const mqttSessionFactory = jest.fn(() => mqtt);
    const provider = new AuxHomeProvider({ restClient, mqttSessionFactory });

    const hapLogin = provider.ensureLoggedIn('synthetic-account', 'synthetic-password');
    const matterLogin = provider.ensureLoggedIn('synthetic-account', 'synthetic-password');
    resolveLogin({ uid: 'synthetic-user', token: 'synthetic-token' });
    await Promise.all([hapLogin, matterLogin]);

    expect(restClient.login).toHaveBeenCalledTimes(1);
    expect(mqttSessionFactory).toHaveBeenCalledTimes(1);
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
      state: 0,
      lastUpdated: '2026-08-13T10:00:00.000Z',
    });
    expect(JSON.stringify(device)).not.toContain('never-normalize');
  });

  test('does not treat an online REST record as powered on and queries real state after MQTT connects', async () => {
    const { mqtt, provider, restClient } = setup();
    restClient.listDevices.mockResolvedValue([deviceRecord({ status: {} })]);

    await provider.ensureLoggedIn('synthetic-account@example.test', 'synthetic-password');
    const [device] = await provider.listDevices();

    expect(device.state).toBe(0);
    expect(device.params).not.toHaveProperty('pwr');
    expect(mqtt.publish).not.toHaveBeenCalled();

    mqtt.emitConnected();

    expect(mqtt.publish).toHaveBeenCalledTimes(1);
    expect(mqtt.publish).toHaveBeenCalledWith(DEVICE_ID, STATE_QUERY);
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

  test('traces MQTT publication and confirmation with the originating correlation', async () => {
    const records: Array<Record<string, unknown>> = [];
    const logger = {
      debug: jest.fn(),
      info: (_format: string, record: string) => records.push(JSON.parse(record)),
    } as unknown as Logger;
    const trace = new AuxTrace(logger, true);
    const { mqtt, provider } = setup(1_000, trace);
    const [device] = await discover(provider, mqtt);
    const context = trace.createContext('hap.set', device);

    const command = provider.setDeviceParams(device, { pwr: 1, temp: 250 }, context);
    mqtt.emit(POWER_ON_25C);
    await command;

    expect(records.map(({ event }) => event)).toEqual(['mqtt.publish', 'mqtt.confirmed', 'state.push']);
    expect(records[0].correlationId).toBe(context.correlationId);
    expect(records[1].correlationId).toBe(context.correlationId);
    expect(records[2]).toMatchObject({ event: 'state.push', source: 'provider.push' });
    expect(records[2].correlationId).not.toBe(context.correlationId);
    expect(JSON.stringify(records)).not.toContain(DEVICE_ID);
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

  test('preserves the latest pushed params across repeated REST device listings', async () => {
    const { mqtt, provider, restClient } = setup();
    const [device] = await discover(provider, mqtt);
    mqtt.emit(POWER_ON_25C);
    restClient.listDevices.mockResolvedValue([deviceRecord({
      status: { pwr: 0, temp: 240, ac_mode: 1, ac_mark: 0 },
    })]);

    await provider.listDevices();

    await expect(provider.refreshDeviceParams(device)).resolves.toMatchObject({
      pwr: 1,
      temp: 250,
      ac_mode: 0,
    });

    mqtt.publish.mockClear();
    const partialCommand = provider.setDeviceParams(device, { scrdisp: 1 });
    expect(mqtt.publish).toHaveBeenCalledWith(
      DEVICE_ID,
      Buffer.from('bb00068000000f00010188000fa000200000200010000066bd', 'hex'),
    );
    const displayOn = Buffer.from(POWER_ON_25C);
    displayOn[20] |= 0x10;
    mqtt.emit(displayOn);
    await expect(partialCommand).resolves.toBeUndefined();
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

  test('performs exactly one relogin and MQTT recreation after REST authentication rejection', async () => {
    const restClient = new FakeRestClient();
    const mqttOne = new FakeMqttSession();
    const mqttTwo = new FakeMqttSession();
    const mqttSessions = [mqttOne, mqttTwo];
    let resolveMqttTwoConnecting!: () => void;
    const mqttTwoConnecting = new Promise<void>((resolve) => { resolveMqttTwoConnecting = resolve; });
    mqttTwo.connect.mockImplementation(() => resolveMqttTwoConnecting());
    restClient.login
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-one' })
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-two' });
    restClient.listDevices
      .mockRejectedValueOnce(new AuxHomeRestError('auth', 'request rejected'))
      .mockResolvedValueOnce([deviceRecord()]);
    const provider = new AuxHomeProvider({
      restClient,
      mqttSessionFactory: () => {
        const mqtt = mqttSessions.shift()!;
        return mqtt;
      },
    });

    await provider.ensureLoggedIn('synthetic-account@example.test', 'synthetic-password');
    const listed = provider.listDevices();
    await mqttTwoConnecting;
    mqttTwo.emitConnected();
    await expect(listed).resolves.toHaveLength(1);
    expect(restClient.login).toHaveBeenCalledTimes(2);
    expect(restClient.listDevices).toHaveBeenCalledTimes(2);
    expect(mqttOne.close).toHaveBeenCalledTimes(1);
  });

  test('keeps healthy MQTT and does not relogin after transient REST failure', async () => {
    const { mqtt, provider, restClient } = setup();
    await provider.ensureLoggedIn('synthetic-account@example.test', 'synthetic-password');
    restClient.listDevices.mockRejectedValue(new AuxHomeRestError('network', 'request failed'));

    await expect(provider.listDevices()).rejects.toThrow('request failed');
    expect(restClient.login).toHaveBeenCalledTimes(1);
    expect(mqtt.close).not.toHaveBeenCalled();
  });

  test('attempts MQTT authentication recovery only once without a stale-credential loop', async () => {
    const restClient = new FakeRestClient();
    const mqttOne = new FakeMqttSession();
    const mqttTwo = new FakeMqttSession();
    const sessions = [mqttOne, mqttTwo];
    restClient.login
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-one' })
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-two' });
    restClient.listDevices.mockResolvedValue([deviceRecord()]);
    const provider = new AuxHomeProvider({ restClient, mqttSessionFactory: () => sessions.shift()! });
    await provider.ensureLoggedIn('sensitive-account', 'sensitive-password');
    await provider.listDevices();

    mqttOne.emitAuthenticationFailure();
    await Promise.resolve();
    await Promise.resolve();
    mqttTwo.emitAuthenticationFailure();
    await Promise.resolve();

    expect(restClient.login).toHaveBeenCalledTimes(2);
    expect(mqttOne.close).toHaveBeenCalledTimes(1);
    expect(mqttTwo.connect).toHaveBeenCalledWith([{ did: DEVICE_ID }]);
    expect(JSON.stringify(restClient.login.mock.results)).not.toContain('sensitive-password');
  });

  test('coalesces ensure and command work into the in-flight authentication recovery', async () => {
    const restClient = new FakeRestClient();
    const mqttOne = new FakeMqttSession();
    const mqttTwo = new FakeMqttSession();
    let resolveRecovery!: (session: AuxHomeSession) => void;
    let resolveMqttTwoConnecting!: () => void;
    const mqttTwoConnecting = new Promise<void>((resolve) => { resolveMqttTwoConnecting = resolve; });
    mqttTwo.connect.mockImplementation(() => resolveMqttTwoConnecting());
    restClient.login
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-one' })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRecovery = resolve; }));
    restClient.listDevices.mockResolvedValue([deviceRecord()]);
    const mqttSessionFactory = jest.fn()
      .mockReturnValueOnce(mqttOne)
      .mockReturnValueOnce(mqttTwo);
    const provider = new AuxHomeProvider({ restClient, mqttSessionFactory, commandTimeoutMs: 1_000 });
    await provider.ensureLoggedIn('private-account', 'private-password');
    const [device] = await provider.listDevices();
    mqttOne.emitAuthenticationFailure();

    const ensured = provider.ensureLoggedIn('private-account', 'private-password');
    const command = provider.setDeviceParams(device, { pwr: 1 });
    const commandResult = command.then(() => undefined, (error: unknown) => error);
    expect(restClient.login).toHaveBeenCalledTimes(2);
    expect(mqttSessionFactory).toHaveBeenCalledTimes(1);
    expect(mqttOne.publish).not.toHaveBeenCalled();
    resolveRecovery({ uid: 'synthetic-user', token: 'session-two' });
    await mqttTwoConnecting;
    mqttTwo.emitConnected();
    await ensured;
    await Promise.resolve();
    mqttTwo.emit(POWER_ON_25C);

    expect(await commandResult).toBeUndefined();
    expect(restClient.login).toHaveBeenCalledTimes(2);
    expect(mqttSessionFactory).toHaveBeenCalledTimes(2);
    expect(mqttTwo.publish).toHaveBeenCalledTimes(2);
    expect(mqttTwo.publish).toHaveBeenNthCalledWith(1, DEVICE_ID, STATE_QUERY);
  });

  test('allows one later recovery only after the replacement connects and resumes pushes', async () => {
    const restClient = new FakeRestClient();
    const mqttOne = new FakeMqttSession();
    const mqttTwo = new FakeMqttSession();
    const mqttThree = new FakeMqttSession();
    let resolveMqttTwoConnecting!: () => void;
    let resolveMqttThreeConnecting!: () => void;
    const mqttTwoConnecting = new Promise<void>((resolve) => { resolveMqttTwoConnecting = resolve; });
    const mqttThreeConnecting = new Promise<void>((resolve) => { resolveMqttThreeConnecting = resolve; });
    mqttTwo.connect.mockImplementation(() => resolveMqttTwoConnecting());
    mqttThree.connect.mockImplementation(() => resolveMqttThreeConnecting());
    restClient.login
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-one' })
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-two' })
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-three' });
    restClient.listDevices.mockResolvedValue([deviceRecord()]);
    const provider = new AuxHomeProvider({
      restClient,
      mqttSessionFactory: jest.fn()
        .mockReturnValueOnce(mqttOne)
        .mockReturnValueOnce(mqttTwo)
        .mockReturnValueOnce(mqttThree),
    });
    await provider.ensureLoggedIn('private-account', 'private-password');
    await provider.listDevices();
    const listener = jest.fn();
    provider.onStateChange(listener);

    mqttOne.emitAuthenticationFailure();
    await mqttTwoConnecting;
    mqttTwo.emitConnected();
    await provider.ensureLoggedIn('private-account', 'private-password');
    mqttTwo.emit(POWER_ON_25C);
    mqttTwo.emitAuthenticationFailure();
    await mqttThreeConnecting;
    mqttThree.emitAuthenticationFailure();
    await Promise.resolve();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      endpointId: DEVICE_ID, params: expect.objectContaining({ pwr: 1 }),
    }));
    expect(restClient.login).toHaveBeenCalledTimes(3);
    expect(mqttThree.close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(listener.mock.calls)).not.toContain('private-');
  });

  test('close rejects every waiter while replacement MQTT is awaiting connection', async () => {
    const restClient = new FakeRestClient();
    const mqttOne = new FakeMqttSession();
    const mqttTwo = new FakeMqttSession();
    let replacementConnectingResolve!: () => void;
    const replacementConnecting = new Promise<void>((resolve) => { replacementConnectingResolve = resolve; });
    mqttTwo.connect.mockImplementation(() => replacementConnectingResolve());
    restClient.login
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-one' })
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-two' });
    restClient.listDevices.mockResolvedValue([deviceRecord()]);
    const provider = new AuxHomeProvider({
      restClient,
      mqttSessionFactory: jest.fn().mockReturnValueOnce(mqttOne).mockReturnValueOnce(mqttTwo),
    });
    await provider.ensureLoggedIn('private-account', 'private-password');
    const [device] = await provider.listDevices();
    mqttOne.emitAuthenticationFailure();
    await replacementConnecting;

    const results = [
      provider.ensureLoggedIn('private-account', 'private-password'),
      provider.listDevices(),
      provider.setDeviceParams(device, { pwr: 1 }),
    ].map((promise) => promise.then(() => 'resolved', (error: Error) => error.message));
    await provider.close();

    await expect(Promise.all(results)).resolves.toEqual([
      'AUX Home provider closed',
      'AUX Home provider closed',
      'AUX Home provider closed',
    ]);
    mqttTwo.emitConnected();
    await expect(provider.listDevices()).rejects.toThrow('AUX Home session is not authenticated');
    expect(mqttTwo.close).toHaveBeenCalledTimes(1);
    expect(restClient.login).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(await Promise.all(results))).not.toContain('private-');
  });

  test('invalidate rejects recovery waiters and permits one explicit fresh login', async () => {
    const restClient = new FakeRestClient();
    const mqttOne = new FakeMqttSession();
    const mqttTwo = new FakeMqttSession();
    const mqttThree = new FakeMqttSession();
    let replacementConnectingResolve!: () => void;
    const replacementConnecting = new Promise<void>((resolve) => { replacementConnectingResolve = resolve; });
    mqttTwo.connect.mockImplementation(() => replacementConnectingResolve());
    restClient.login
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-one' })
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-two' })
      .mockResolvedValueOnce({ uid: 'synthetic-user', token: 'session-three' });
    restClient.listDevices.mockResolvedValue([deviceRecord()]);
    const provider = new AuxHomeProvider({
      restClient,
      mqttSessionFactory: jest.fn()
        .mockReturnValueOnce(mqttOne)
        .mockReturnValueOnce(mqttTwo)
        .mockReturnValueOnce(mqttThree),
    });
    await provider.ensureLoggedIn('private-account', 'private-password');
    await provider.listDevices();
    mqttOne.emitAuthenticationFailure();
    await replacementConnecting;
    const waiting = provider.ensureLoggedIn('private-account', 'private-password')
      .then(() => 'resolved', (error: Error) => error.message);

    provider.invalidateSession();
    const freshLogin = provider.ensureLoggedIn('private-account', 'private-password');

    await expect(waiting).resolves.toBe('AUX Home session was invalidated');
    mqttTwo.emitConnected();
    await expect(freshLogin).resolves.toBeUndefined();
    expect(restClient.login).toHaveBeenCalledTimes(3);
    expect(mqttTwo.close).toHaveBeenCalledTimes(1);
    expect(mqttThree.close).not.toHaveBeenCalled();
  });
});

describe('createProvider AUX Home selection', () => {
  test('constructs the AUX Home coordinator for the EU region', () => {
    expect(createProvider({ provider: 'aux-home', region: 'eu' })).toBeInstanceOf(AuxHomeProvider);
  });
});
