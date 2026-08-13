import {
  AuxHomeMqttSession,
  type AuxHomeMqttClient,
  type AuxHomeMqttConnectOptions,
  buildMqttCredentials,
  commandTopic,
  isAcceptedAuxHomeBrokerCertificate,
  stateTopic,
} from '../../api/auxhome/AuxHomeMqttSession';

class FakeMqttClient implements AuxHomeMqttClient {
  public readonly subscriptions: string[] = [];

  public readonly publications: Array<{ topic: string; payload: Buffer | string }> = [];

  public ended = false;

  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  public on(event: 'connect' | 'close' | 'message' | 'error', listener: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), listener]);
    return this;
  }

  public subscribe(topic: string): void {
    this.subscriptions.push(topic);
  }

  public publish(topic: string, payload: Buffer | string): void {
    this.publications.push({ topic, payload });
  }

  public end(): void {
    this.ended = true;
  }

  public emit(event: 'connect' | 'close' | 'message' | 'error', ...args: unknown[]): void {
    for (const listener of this.handlers.get(event) ?? []) {
      listener(...args);
    }
  }
}

function createConnector(): {
  clients: FakeMqttClient[];
  calls: Array<{ url: string; options: AuxHomeMqttConnectOptions }>;
  connector: (url: string, options: AuxHomeMqttConnectOptions) => AuxHomeMqttClient;
} {
  const clients: FakeMqttClient[] = [];
  const calls: Array<{ url: string; options: AuxHomeMqttConnectOptions }> = [];
  return {
    clients,
    calls,
    connector: (url, options) => {
      const client = new FakeMqttClient();
      clients.push(client);
      calls.push({ url, options });
      return client;
    },
  };
}

describe('AUX Home MQTT identity and topics', () => {
  test('builds the application MQTT credentials', () => {
    expect(buildMqttCredentials('uid123', 'token456')).toEqual({
      clientId: 'usruid123',
      username: '2$60b8eaa792aa4de1badf04fc20a8ba56$uid123',
      password: 'token456',
    });
  });

  test('accepts only the pinned AUX Home broker certificate', () => {
    expect(isAcceptedAuxHomeBrokerCertificate(
      'C5:30:CF:7E:53:C8:F5:71:AF:AD:95:C5:DA:40:16:D9:C3:8F:CF:12:D1:85:0B:EF:49:4E:52:D0:CB:84:D9:B2',
    )).toBe(true);
    expect(isAcceptedAuxHomeBrokerCertificate('00:11:22')).toBe(false);
    expect(isAcceptedAuxHomeBrokerCertificate(undefined)).toBe(false);
  });

  test('builds the state and command topics for a device', () => {
    expect(stateTopic('did123')).toBe('dev2app/did123/#');
    expect(commandTopic('did123')).toBe('app2dev/did123/#');
  });
});

describe('AuxHomeMqttSession', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('connects with TLS verification and subscribes to every device state topic', () => {
    const { clients, calls, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });

    session.connect([{ did: 'did1' }, { did: 'did2' }]);

    expect(clients).toHaveLength(1);
    expect(calls).toEqual([{
      url: 'mqtts://eu-smthome-m2m.aux-global.com:8883',
      options: {
        clientId: 'usruid123',
        username: '2$60b8eaa792aa4de1badf04fc20a8ba56$uid123',
        password: 'token456',
        clean: true,
        keepalive: 120,
        protocolId: 'MQIsdp',
        protocolVersion: 3,
        rejectUnauthorized: false,
        reconnectPeriod: 0,
      },
    }]);
    clients[0].emit('connect');
    expect(clients[0].subscriptions).toEqual(['dev2app/did1/#', 'dev2app/did2/#']);
  });

  test('emits only valid unwrapped messages received on an AUX Home device state topic', () => {
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });
    const received: Array<{ deviceId: string; payload: Buffer }> = [];
    session.onMessage((message) => received.push(message));
    session.connect([{ did: 'did1' }]);
    clients[0].emit('connect');

    clients[0].emit('message', 'other/did1/state', Buffer.from('ignored'));
    clients[0].emit('message', 'dev2app/did1/state', 'not-a-buffer');
    const payload = Buffer.from('bb00070000010f000111880081a0002000002000000005372c', 'hex');
    const envelope = Buffer.from(
      'a5a523000b007856bb00070000010f000111880081a0002000002000000005372cd140',
      'hex',
    );
    const invalidEnvelope = Buffer.from(envelope);
    invalidEnvelope[invalidEnvelope.length - 1] ^= 0x01;
    clients[0].emit('message', 'dev2app/did1/state', invalidEnvelope);
    clients[0].emit('message', 'dev2app/did1/state', envelope);

    expect(received).toEqual([{ deviceId: 'did1', payload }]);
  });

  test('reconnects once after a disconnect and resubscribes after connecting', () => {
    jest.useFakeTimers();
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });
    session.connect([{ did: 'did1' }]);
    clients[0].emit('connect');

    clients[0].emit('close');
    clients[0].emit('close');
    jest.advanceTimersByTime(999);
    expect(clients).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(clients).toHaveLength(2);
    clients[1].emit('connect');

    expect(clients[1].subscriptions).toEqual(['dev2app/did1/#']);
  });

  test('uses the full capped reconnect schedule and resets after a successful connection', () => {
    jest.useFakeTimers();
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });
    session.connect([{ did: 'did1' }]);
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      clients[clients.length - 1].emit('close');
      const count = clients.length;
      jest.advanceTimersByTime(delay - 1);
      expect(clients).toHaveLength(count);
      jest.advanceTimersByTime(1);
      expect(clients).toHaveLength(count + 1);
    }
    clients[clients.length - 1].emit('connect');
    clients[clients.length - 1].emit('close');
    const count = clients.length;
    jest.advanceTimersByTime(999);
    expect(clients).toHaveLength(count);
    jest.advanceTimersByTime(1);
    expect(clients).toHaveLength(count + 1);
  });

  test('ignores messages from a stale client after reconnecting', () => {
    jest.useFakeTimers();
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });
    const received: Array<{ deviceId: string; payload: Buffer }> = [];
    session.onMessage((message) => received.push(message));
    session.connect([{ did: 'did1' }]);
    clients[0].emit('connect');
    clients[0].emit('close');
    jest.advanceTimersByTime(1_000);
    clients[1].emit('connect');

    clients[0].emit('message', 'dev2app/did1/state', Buffer.from('stale'));

    expect(received).toEqual([]);
  });

  test('does not emit messages from the former client after close', () => {
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });
    const received: Array<{ deviceId: string; payload: Buffer }> = [];
    session.onMessage((message) => received.push(message));
    session.connect([{ did: 'did1' }]);
    clients[0].emit('connect');

    session.close();
    clients[0].emit('message', 'dev2app/did1/state', Buffer.from('closed'));

    expect(received).toEqual([]);
  });

  test('publishes on a device command topic only while connected', () => {
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });

    expect(() => session.publish('did1', Buffer.from('command'))).toThrow('AUX Home MQTT is disconnected');
    session.connect([{ did: 'did1' }]);
    clients[0].emit('connect');
    const payload = Buffer.from('bb0006800000020011012b7e', 'hex');
    session.publish('did1', payload);

    expect(clients[0].publications).toEqual([{
      topic: 'app2dev/did1/#',
      payload: Buffer.from('a5a516000b000100bb0006800000020011012b7e0816', 'hex'),
    }]);
  });

  test('subscribes a newly discovered device without waiting for reconnect', () => {
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });
    session.connect([{ did: 'did1' }]);
    clients[0].emit('connect');

    session.connect([{ did: 'did1' }, { did: 'did2' }]);

    expect(clients).toHaveLength(1);
    expect(clients[0].subscriptions).toEqual(['dev2app/did1/#', 'dev2app/did2/#']);
  });

  test('close cancels a pending reconnect and prevents future reconnects', () => {
    jest.useFakeTimers();
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });
    session.connect([{ did: 'did1' }]);
    clients[0].emit('connect');
    clients[0].emit('close');

    session.close();
    jest.advanceTimersByTime(30_000);

    expect(clients).toHaveLength(1);
  });

  test('reports authentication rejection without exposing broker details and ignores transient errors', () => {
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'sensitive-uid', token: 'sensitive-token', connector });
    const failures: Error[] = [];
    session.onAuthenticationFailure((error) => failures.push(error));
    session.connect([{ did: 'sensitive-device' }]);

    clients[0].emit('error', Object.assign(new Error('socket reset sensitive-token'), { code: 'ECONNRESET' }));
    clients[0].emit('error', Object.assign(new Error('Not authorized sensitive-token'), { reasonCode: 135 }));

    expect(failures).toHaveLength(1);
    expect(failures[0].message).toBe('AUX Home MQTT authentication rejected');
    expect(failures[0].message).not.toContain('sensitive');
  });

  test('stops terminally after authentication rejection and never reconnects after broker close', () => {
    jest.useFakeTimers();
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({
      uid: 'private-user-fragment', token: 'private-session-token', connector, jitter: () => 0,
    });
    const failures: Error[] = [];
    session.onAuthenticationFailure((error) => failures.push(error));
    session.connect([{ did: 'private-device-fragment' }]);

    clients[0].emit('error', Object.assign(new Error('Not authorized private-session-token'), { reasonCode: 135 }));
    clients[0].emit('error', Object.assign(new Error('Not authorized again'), { reasonCode: 135 }));
    clients[0].emit('close');
    jest.advanceTimersByTime(60_000);

    expect(failures.map(({ message }) => message)).toEqual(['AUX Home MQTT authentication rejected']);
    expect(clients[0].ended).toBe(true);
    expect(clients).toHaveLength(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(JSON.stringify(failures)).not.toContain('private-');
  });
});
