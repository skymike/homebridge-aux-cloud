import type { Logger } from 'homebridge';

import type { AuxDevice } from '../AuxCloudClient';
import {
  AuxHomeMqttSession,
  type AuxHomeMqttMessage,
} from '../auxhome/AuxHomeMqttSession';
import { AuxHomeRestClient } from '../auxhome/AuxHomeRestClient';
import type { AuxHomeDeviceRecord, AuxHomeSession } from '../auxhome/AuxHomeTypes';
import {
  auxLinkStateToParams,
  buildAuxLinkCommandPayload,
  parseAuxLinkStatePayload,
} from '../auxhome/AuxLinkProtocol';
import type { AuxProvider, AuxProviderStateListener, DeviceQueryOptions } from './AuxProvider';

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

  private readonly deviceRecords = new Map<string, AuxHomeDeviceRecord>();

  private readonly devices = new Map<string, AuxDevice>();

  private readonly pushedStates = new Map<string, Pick<AuxDevice, 'params' | 'lastUpdated'>>();

  private readonly listeners = new Set<AuxProviderStateListener>();

  private readonly pendingCommands = new Map<string, PendingCommand>();

  constructor(options: AuxHomeProviderOptions = {}) {
    this.restClient = options.restClient ?? new AuxHomeRestClient();
    this.mqttSessionFactory = options.mqttSessionFactory ?? ((session) => new AuxHomeMqttSession(session));
    this.commandTimeoutMs = options.commandTimeoutMs ?? options.requestTimeoutMs ?? 5_000;
    this.now = options.now ?? (() => new Date());
  }

  public async ensureLoggedIn(identifier: string, password: string): Promise<void> {
    if (this.session) {
      return;
    }

    const session = await this.restClient.login(identifier, password);
    this.session = { ...session };
    const mqtt = this.mqttSessionFactory(this.session);
    this.mqtt = mqtt;
    this.unsubscribeMqtt = mqtt.onMessage((message) => this.handleMessage(message));
  }

  public async listDevices(options: DeviceQueryOptions = {}): Promise<AuxDevice[]> {
    if (!this.session || !this.mqtt) {
      throw new Error('AUX Home session is not authenticated');
    }

    const records = (await this.restClient.listDevices()).filter((record) => this.isIncluded(record.did, options));
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

  public setDeviceParams(device: AuxDevice, values: Record<string, number>): Promise<void> {
    const mqtt = this.mqtt;
    if (!this.session || !mqtt) {
      return Promise.reject(new Error('AUX Home session is not authenticated'));
    }

    const confirmed = this.devices.get(device.endpointId)?.params ?? device.params ?? {};
    const changes = this.numericParams(values);
    const payload = buildAuxLinkCommandPayload({ ...confirmed, ...changes });

    this.rejectPending(device.endpointId, new Error('A newer AUX Home command replaced the pending command'));
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
    this.clearRuntimeState(new Error('AUX Home provider closed'), true);
    return Promise.resolve();
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
    for (const deviceId of [...this.pendingCommands.keys()]) {
      this.rejectPending(deviceId, error);
    }
    this.unsubscribeMqtt?.();
    this.unsubscribeMqtt = undefined;
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
