import type { Logger } from 'homebridge';

import type { AuxDevice } from '../AuxCloudClient';
import {
  AuxHomeMqttSession,
  type AuxHomeMqttMessage,
} from '../auxhome/AuxHomeMqttSession';
import { AuxHomeRestClient, AuxHomeRestError } from '../auxhome/AuxHomeRestClient';
import type { AuxHomeDeviceRecord, AuxHomeSession } from '../auxhome/AuxHomeTypes';
import {
  auxLinkStateToParams,
  buildAuxLinkCommandPayload,
  parseAuxLinkStatePayload,
} from '../auxhome/AuxLinkProtocol';
import {
  AuxProviderCommandSupersededError,
  type AuxProvider,
  type AuxProviderStateListener,
  type DeviceQueryOptions,
} from './AuxProvider';

const AUX_LINK_STATE_QUERY = Buffer.from('bb0006800000020011012b7e', 'hex');

interface AuxHomeRestApi {
  login(account: string, password: string): Promise<AuxHomeSession>;
  listDevices(): Promise<AuxHomeDeviceRecord[]>;
  invalidateSession(): void;
}

interface AuxHomeMqttConnection {
  connect(devices: readonly { did: string }[]): void;
  publish(deviceId: string, payload: Buffer | string): void;
  onMessage(listener: (message: AuxHomeMqttMessage) => void): () => void;
  onAuthenticationFailure?(listener: (error: Error) => void): () => void;
  onConnected(listener: () => void): () => void;
  isConnected(): boolean;
  close(): void;
}

interface PendingCommand {
  expected: Record<string, number>;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AuxHomeProviderOptions {
  region?: 'eu';
  logger?: Logger;
  requestTimeoutMs?: number;
  commandTimeoutMs?: number;
  restClient?: AuxHomeRestApi;
  mqttSessionFactory?: (session: AuxHomeSession) => AuxHomeMqttConnection;
  now?: () => Date;
}

export class AuxHomeProvider implements AuxProvider {
  public readonly kind = 'aux-home' as const;

  private readonly restClient: AuxHomeRestApi;

  private readonly mqttSessionFactory: (session: AuxHomeSession) => AuxHomeMqttConnection;

  private readonly commandTimeoutMs: number;

  private readonly now: () => Date;

  private session?: AuxHomeSession;

  private mqtt?: AuxHomeMqttConnection;

  private unsubscribeMqtt?: () => void;
  private unsubscribeMqttAuth?: () => void;
  private unsubscribeMqttConnected?: () => void;
  private credentials?: { identifier: string; password: string };
  private recoveryUsed = false;
  private authenticationOperation?: Promise<void>;
  private recoveryConnectedResolve?: () => void;
  private recoveryConnectedReject?: (error: Error) => void;
  private closed = false;

  private readonly deviceRecords = new Map<string, AuxHomeDeviceRecord>();

  private readonly devices = new Map<string, AuxDevice>();

  private readonly pushedStates = new Map<string, Pick<AuxDevice, 'params' | 'lastUpdated'>>();

  private readonly listeners = new Set<AuxProviderStateListener>();

  private readonly pendingCommands = new Map<string, PendingCommand>();

  constructor(options: AuxHomeProviderOptions = {}) {
    this.restClient = options.restClient ?? new AuxHomeRestClient({ requestTimeoutMs: options.requestTimeoutMs });
    this.mqttSessionFactory = options.mqttSessionFactory ?? ((session) => new AuxHomeMqttSession(session));
    this.commandTimeoutMs = options.commandTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  public async ensureLoggedIn(identifier: string, password: string): Promise<void> {
    this.closed = false;
    if (this.authenticationOperation) {
      await this.authenticationOperation;
      return;
    }
    if (this.session) {
      return;
    }

    this.credentials = { identifier, password };
    await this.runAuthenticationOperation(async () => {
      await this.createAuthenticatedSession(identifier, password);
    });
  }

  public async listDevices(options: DeviceQueryOptions = {}): Promise<AuxDevice[]> {
    if (this.authenticationOperation) {
      await this.authenticationOperation;
    }
    if (!this.session || !this.mqtt) {
      throw new Error('AUX Home session is not authenticated');
    }

    let rawRecords: AuxHomeDeviceRecord[];
    try {
      rawRecords = await this.restClient.listDevices();
    } catch (error) {
      if (!(error instanceof AuxHomeRestError) || error.kind !== 'auth' || this.recoveryUsed) {
        throw error;
      }
      await this.recoverAuthentication();
      rawRecords = await this.restClient.listDevices();
    }
    const records = rawRecords.filter((record) => this.isIncluded(record.did, options));
    this.deviceRecords.clear();
    this.devices.clear();

    const devices = records.map((record) => {
      const device = this.normalizeDevice(record);
      const pushed = this.pushedStates.get(record.did);
      if (pushed) {
        device.params = { ...device.params, ...pushed.params };
        device.lastUpdated = pushed.lastUpdated;
      }
      this.deviceRecords.set(record.did, { ...record });
      this.devices.set(record.did, device);
      return { ...device, params: { ...device.params } };
    });

    const listedIds = new Set(records.map(({ did }) => did));
    for (const deviceId of this.pushedStates.keys()) {
      if (!listedIds.has(deviceId)) {
        this.pushedStates.delete(deviceId);
      }
    }

    this.mqtt.connect(records.map(({ did }) => ({ did })));
    return devices;
  }

  public async setDeviceParams(device: AuxDevice, values: Record<string, number>): Promise<void> {
    if (this.authenticationOperation) {
      await this.authenticationOperation;
    }
    const mqtt = this.mqtt;
    if (!this.session || !mqtt) {
      throw new Error('AUX Home session is not authenticated');
    }

    const confirmed = this.devices.get(device.endpointId)?.params ?? device.params ?? {};
    const changes = this.numericParams(values);
    const payload = buildAuxLinkCommandPayload({ ...confirmed, ...changes });

    this.rejectPending(device.endpointId, new AuxProviderCommandSupersededError());
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(device.endpointId);
        reject(new Error('AUX Home command confirmation timed out'));
      }, this.commandTimeoutMs);
      this.pendingCommands.set(device.endpointId, { expected: changes, resolve, reject, timer });

      try {
        mqtt.publish(device.endpointId, payload);
      } catch (error) {
        this.rejectPending(
          device.endpointId,
          error instanceof Error ? error : new Error('AUX Home command publish failed'),
        );
      }
    });
  }

  public refreshDeviceParams(device: AuxDevice): Promise<Record<string, number>> {
    if (!this.session) {
      return Promise.reject(new Error('AUX Home session is not authenticated'));
    }
    if (this.mqtt?.isConnected()) {
      this.mqtt.publish(device.endpointId, AUX_LINK_STATE_QUERY);
    }
    const params = this.devices.get(device.endpointId)?.params ?? device.params ?? {};
    return Promise.resolve({ ...params });
  }

  public invalidateSession(): void {
    this.clearRuntimeState(new Error('AUX Home session was invalidated'), false);
  }

  public onStateChange(listener: AuxProviderStateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public close(): Promise<void> {
    if (this.closed) {
      return Promise.resolve();
    }
    this.closed = true;
    this.clearRuntimeState(new Error('AUX Home provider closed'), true);
    this.credentials = undefined;
    return Promise.resolve();
  }

  private async createAuthenticatedSession(identifier: string, password: string): Promise<AuxHomeMqttConnection> {
    const session = await this.restClient.login(identifier, password);
    if (this.closed) {
      this.restClient.invalidateSession();
      throw new Error('AUX Home provider closed');
    }
    this.session = { ...session };
    const mqtt = this.mqttSessionFactory(this.session);
    this.mqtt = mqtt;
    this.unsubscribeMqtt = mqtt.onMessage((message) => this.handleMessage(message));
    this.unsubscribeMqttAuth = mqtt.onAuthenticationFailure?.(() => this.handleAuthenticationFailure(mqtt));
    this.unsubscribeMqttConnected = mqtt.onConnected(() => this.handleConnected(mqtt));
    return mqtt;
  }

  private recoverAuthentication(): Promise<void> {
    if (this.authenticationOperation) {
      return this.authenticationOperation;
    }
    const credentials = this.credentials;
    if (!credentials) {
      return Promise.reject(new AuxHomeRestError('auth', 'AUX Home authentication recovery unavailable'));
    }
    this.recoveryUsed = true;
    return this.runAuthenticationOperation(async () => {
      this.unsubscribeMqtt?.();
      this.unsubscribeMqttAuth?.();
      this.unsubscribeMqttConnected?.();
      this.unsubscribeMqtt = undefined;
      this.unsubscribeMqttAuth = undefined;
      this.unsubscribeMqttConnected = undefined;
      this.mqtt?.close();
      this.mqtt = undefined;
      this.session = undefined;
      this.restClient.invalidateSession();
      const mqtt = await this.createAuthenticatedSession(credentials.identifier, credentials.password);
      const connected = new Promise<void>((resolve, reject) => {
        this.recoveryConnectedResolve = resolve;
        this.recoveryConnectedReject = reject;
      });
      mqtt.connect([...this.deviceRecords.keys()].map((did) => ({ did })));
      await connected;
    });
  }

  private runAuthenticationOperation(operation: () => Promise<void>): Promise<void> {
    const promise = operation().finally(() => {
      if (this.authenticationOperation === promise) {
        this.authenticationOperation = undefined;
      }
    });
    this.authenticationOperation = promise;
    return promise;
  }

  private handleConnected(mqtt: AuxHomeMqttConnection): void {
    if (this.mqtt !== mqtt) {
      return;
    }
    this.recoveryUsed = false;
    this.recoveryConnectedResolve?.();
    this.recoveryConnectedResolve = undefined;
    this.recoveryConnectedReject = undefined;
  }

  private handleAuthenticationFailure(mqtt: AuxHomeMqttConnection): void {
    if (this.mqtt !== mqtt) {
      return;
    }
    if (this.recoveryUsed) {
      this.markUnavailable(new AuxHomeRestError('auth', 'AUX Home authentication rejected'));
      return;
    }
    void this.recoverAuthentication().catch(() => undefined);
  }

  private markUnavailable(error: Error): void {
    this.recoveryConnectedReject?.(error);
    this.recoveryConnectedResolve = undefined;
    this.recoveryConnectedReject = undefined;
    for (const deviceId of [...this.pendingCommands.keys()]) {
      this.rejectPending(deviceId, error);
    }
    this.unsubscribeMqtt?.();
    this.unsubscribeMqttAuth?.();
    this.unsubscribeMqttConnected?.();
    this.unsubscribeMqtt = undefined;
    this.unsubscribeMqttAuth = undefined;
    this.unsubscribeMqttConnected = undefined;
    this.mqtt?.close();
    this.mqtt = undefined;
    this.session = undefined;
    this.restClient.invalidateSession();
  }

  private handleMessage(message: AuxHomeMqttMessage): void {
    const existing = this.devices.get(message.deviceId);
    if (!existing || !this.deviceRecords.has(message.deviceId)) {
      return;
    }

    const incoming = auxLinkStateToParams(parseAuxLinkStatePayload(message.payload));
    if (Object.keys(incoming).length === 0) {
      return;
    }

    const updated: AuxDevice = {
      ...existing,
      params: { ...existing.params, ...incoming },
      state: 1,
      lastUpdated: this.now().toISOString(),
    };
    this.devices.set(message.deviceId, updated);
    this.pushedStates.set(message.deviceId, {
      params: { ...updated.params },
      lastUpdated: updated.lastUpdated,
    });

    const pending = this.pendingCommands.get(message.deviceId);
    if (pending && this.matchesExpected(updated.params, pending.expected)) {
      clearTimeout(pending.timer);
      this.pendingCommands.delete(message.deviceId);
      pending.resolve();
    }

    for (const listener of this.listeners) {
      listener({ ...updated, params: { ...updated.params } });
    }
  }

  private normalizeDevice(record: AuxHomeDeviceRecord): AuxDevice {
    return {
      endpointId: record.did,
      friendlyName: record.alias || `AUX Home ${record.did.slice(-4)}`,
      productId: record.productKey || record.modelId || 'aux-home',
      devSession: '',
      devicetypeFlag: 0,
      cookie: '',
      mac: record.mac?.toLowerCase(),
      params: this.numericParams(record.status),
      state: record.online ? 1 : 0,
      lastUpdated: this.now().toISOString(),
    };
  }

  private numericParams(values: Record<string, unknown> | undefined): Record<string, number> {
    const params: Record<string, number> = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (typeof value === 'number' && !Number.isNaN(value)) {
        params[key] = value;
      }
    }
    return params;
  }

  private isIncluded(deviceId: string, options: DeviceQueryOptions): boolean {
    if (options.includeIds?.size && !options.includeIds.has(deviceId)) {
      return false;
    }
    return !options.excludeIds?.has(deviceId);
  }

  private matchesExpected(actual: Record<string, number>, expected: Record<string, number>): boolean {
    return Object.entries(expected).every(([key, value]) => actual[key] === value);
  }

  private rejectPending(deviceId: string, error: Error): void {
    const pending = this.pendingCommands.get(deviceId);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pendingCommands.delete(deviceId);
    pending.reject(error);
  }

  private clearRuntimeState(error: Error, clearListeners: boolean): void {
    const rejectRecoveryConnection = this.recoveryConnectedReject;
    this.recoveryConnectedResolve = undefined;
    this.recoveryConnectedReject = undefined;
    rejectRecoveryConnection?.(error);
    for (const deviceId of [...this.pendingCommands.keys()]) {
      this.rejectPending(deviceId, error);
    }
    this.unsubscribeMqtt?.();
    this.unsubscribeMqttAuth?.();
    this.unsubscribeMqttConnected?.();
    this.unsubscribeMqtt = undefined;
    this.unsubscribeMqttAuth = undefined;
    this.unsubscribeMqttConnected = undefined;
    this.mqtt?.close();
    this.mqtt = undefined;
    this.session = undefined;
    this.deviceRecords.clear();
    this.devices.clear();
    this.pushedStates.clear();
    if (clearListeners) {
      this.listeners.clear();
    }
    this.restClient.invalidateSession();
  }
}
