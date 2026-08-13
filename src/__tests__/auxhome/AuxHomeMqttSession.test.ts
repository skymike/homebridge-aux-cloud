import {
  AuxHomeMqttSession,
  type AuxHomeMqttClient,
  type AuxHomeMqttConnectOptions,
  buildMqttCredentials,
  commandTopic,
  stateTopic,
} from '../../api/auxhome/AuxHomeMqttSession';

class FakeMqttClient implements AuxHomeMqttClient {
  public readonly subscriptions: string[] = [];

  public readonly publications: Array<{ topic: string; payload: Buffer | string }> = [];

  public ended = false;

  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  public on(event: 'connect' | 'close' | 'message', listener: (...args: unknown[]) => void): this {
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

  public emit(event: 'connect' | 'close' | 'message', ...args: unknown[]): void {
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
      clientId: '2$60b8eaa792aa4de1badf04fc20a8ba56$uid123',
      username: 'usruid123',
      password: 'token456',
    });
  });

  test('builds the state and command topics for a device', () => {
    expect(stateTopic('did123')).toBe('dev2app/did123/#');
    expect(commandTopic('did123')).toBe('app2dev/did123');
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
        clientId: '2$60b8eaa792aa4de1badf04fc20a8ba56$uid123',
        username: 'usruid123',
        password: 'token456',
        clean: true,
        rejectUnauthorized: true,
        reconnectPeriod: 0,
      },
    }]);
    clients[0].emit('connect');
    expect(clients[0].subscriptions).toEqual(['dev2app/did1/#', 'dev2app/did2/#']);
  });

  test('emits only binary messages received on an AUX Home device state topic', () => {
    const { clients, connector } = createConnector();
    const session = new AuxHomeMqttSession({ uid: 'uid123', token: 'token456', connector, jitter: () => 0 });
    const received: Array<{ deviceId: string; payload: Buffer }> = [];
    session.onMessage((message) => received.push(message));
    session.connect([{ did: 'did1' }]);
    clients[0].emit('connect');

    clients[0].emit('message', 'other/did1/state', Buffer.from('ignored'));
    clients[0].emit('message', 'dev2app/did1/state', 'not-a-buffer');
    const payload = Buffer.from([1, 2, 3]);
    clients[0].emit('message', 'dev2app/did1/state', payload);

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
    const payload = Buffer.from('command');
    session.publish('did1', payload);

    expect(clients[0].publications).toEqual([{ topic: 'app2dev/did1', payload }]);
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
});
