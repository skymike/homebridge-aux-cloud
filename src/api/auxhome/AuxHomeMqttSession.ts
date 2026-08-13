import mqtt from 'mqtt';

const AUX_HOME_APP_ID = '60b8eaa792aa4de1badf04fc20a8ba56';
const AUX_HOME_MQTT_URL = 'mqtts://eu-smthome-m2m.aux-global.com:8883';
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export interface AuxHomeMqttCredentials {
  clientId: string;
  username: string;
  password: string;
}

export interface AuxHomeMqttConnectOptions extends AuxHomeMqttCredentials {
  clean: boolean;
  rejectUnauthorized: boolean;
  reconnectPeriod: number;
}

export interface AuxHomeMqttClient {
  on(event: 'connect' | 'close' | 'message', listener: (...args: unknown[]) => void): this;
  subscribe(topic: string): void;
  publish(topic: string, payload: Buffer | string): void;
  end(): void;
}

export interface AuxHomeMqttDevice {
  did: string;
}

export interface AuxHomeMqttMessage {
  deviceId: string;
  payload: Buffer;
}

export interface AuxHomeMqttSessionOptions {
  uid: string;
  token: string;
  connector?: (url: string, options: AuxHomeMqttConnectOptions) => AuxHomeMqttClient;
  jitter?: () => number;
}

export function buildMqttCredentials(uid: string, token: string): AuxHomeMqttCredentials {
  return {
    clientId: `2$${AUX_HOME_APP_ID}$${uid}`,
    username: `usr${uid}`,
    password: token,
  };
}

export function stateTopic(deviceId: string): string {
  return `dev2app/${deviceId}/#`;
}

export function commandTopic(deviceId: string): string {
  return `app2dev/${deviceId}`;
}

export class AuxHomeMqttSession {
  private readonly credentials: AuxHomeMqttCredentials;

  private readonly connector: (url: string, options: AuxHomeMqttConnectOptions) => AuxHomeMqttClient;

  private readonly jitter: () => number;

  private readonly listeners = new Set<(message: AuxHomeMqttMessage) => void>();

  private client?: AuxHomeMqttClient;

  private devices: string[] = [];

  private connected = false;

  private closed = false;

  private reconnectAttempts = 0;

  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(options: AuxHomeMqttSessionOptions) {
    this.credentials = buildMqttCredentials(options.uid, options.token);
    this.connector = options.connector ?? ((url, connectOptions) => (
      mqtt.connect(url, connectOptions) as unknown as AuxHomeMqttClient
    ));
    this.jitter = options.jitter ?? (() => Math.random() * 0.2);
  }

  public connect(devices: readonly AuxHomeMqttDevice[]): void {
    this.devices = [...new Set(devices.map((device) => device.did).filter((deviceId) => deviceId.length > 0))];
    this.closed = false;
    if (this.client || this.reconnectTimer) {
      return;
    }
    this.beginConnection();
  }

  public publish(deviceId: string, payload: Buffer | string): void {
    if (!this.connected || !this.client) {
      throw new Error('AUX Home MQTT is disconnected');
    }
    this.client.publish(commandTopic(deviceId), payload);
  }

  public onMessage(listener: (message: AuxHomeMqttMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): void {
    this.closed = true;
    this.connected = false;
    this.clearReconnectTimer();
    const client = this.client;
    this.client = undefined;
    client?.end();
  }

  private beginConnection(): void {
    if (this.closed) {
      return;
    }

    let client: AuxHomeMqttClient;
    try {
      client = this.connector(AUX_HOME_MQTT_URL, {
        ...this.credentials,
        clean: true,
        rejectUnauthorized: true,
        reconnectPeriod: 0,
      });
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.client = client;
    client.on('connect', () => this.handleConnect(client));
    client.on('close', () => this.handleClose(client));
    client.on('message', (topic, payload) => this.handleMessage(client, topic, payload));
  }

  private handleConnect(client: AuxHomeMqttClient): void {
    if (this.closed || this.client !== client) {
      return;
    }
    this.connected = true;
    this.reconnectAttempts = 0;
    for (const deviceId of this.devices) {
      client.subscribe(stateTopic(deviceId));
    }
  }

  private handleClose(client: AuxHomeMqttClient): void {
    if (this.client !== client) {
      return;
    }
    this.connected = false;
    this.client = undefined;
    this.scheduleReconnect();
  }

  private handleMessage(client: AuxHomeMqttClient, topic: unknown, payload: unknown): void {
    if (this.closed || !this.connected || this.client !== client || typeof topic !== 'string' || !Buffer.isBuffer(payload)) {
      return;
    }
    const topicSegments = topic.split('/');
    const deviceId = topicSegments[1];
    if (topicSegments[0] !== 'dev2app' || !deviceId) {
      return;
    }
    const message = { deviceId, payload };
    for (const listener of this.listeners) {
      listener(message);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) {
      return;
    }
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempts += 1;
    const jitter = Math.max(0, this.jitter());
    const reconnectDelay = Math.min(30_000, Math.round(delay * (1 + jitter)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.beginConnection();
    }, reconnectDelay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }
}
