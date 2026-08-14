import axios from 'axios';

import { encryptAuxHomeAccount, encryptAuxHomePassword } from './AuxHomeCrypto';
import type { AuxHomeDeviceRecord, AuxHomeRawDeviceRecord, AuxHomeSession, MyResponse } from './AuxHomeTypes';

const AUX_HOME_EU_BASE_URL = 'https://eu-smthome-api.aux-global.com/app/';
const COMPATIBILITY_HEADERS = {
  aid: '1',
  appversion: '2.3.2',
  os: 'Android',
  osversion: '12',
};

interface AuxHomeRequestConfig {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
}

export interface AuxHomeTransport {
  request(config: AuxHomeRequestConfig): Promise<{ data: unknown }>;
}

export interface AuxHomeRestClientOptions {
  transport?: AuxHomeTransport;
  now?: () => number;
  requestTimeoutMs?: number;
}

export type AuxHomeRestErrorKind = 'auth' | 'network' | 'invalid-response' | 'request';

export class AuxHomeRestError extends Error {
  constructor(public readonly kind: AuxHomeRestErrorKind, message: string, public readonly code?: number) {
    super(message);
    this.name = 'AuxHomeRestError';
  }
}

export interface AuxHomeDeviceQueryOptions {
  includeIds?: Set<string>;
  excludeIds?: Set<string>;
}

interface LoginPublicKeyObject {
  publicKey?: string;
  publicKeyBase64?: string;
}

type LoginPublicKey = string | LoginPublicKeyObject;

interface LoginResult {
  appUser?: { uid?: string };
  token?: { token?: string };
}

type DeviceResponse = AuxHomeRawDeviceRecord[] | {
  devices?: AuxHomeRawDeviceRecord[];
  deviceList?: AuxHomeRawDeviceRecord[];
  list?: AuxHomeRawDeviceRecord[];
};

export class AuxHomeRestClient {
  private readonly transport: AuxHomeTransport;

  private readonly now: () => number;

  private session?: AuxHomeSession;

  constructor(options: AuxHomeRestClientOptions = {}) {
    this.transport = options.transport ?? axios.create({
      baseURL: AUX_HOME_EU_BASE_URL,
      timeout: options.requestTimeoutMs ?? 5000,
    });
    this.now = options.now ?? Date.now;
  }

  public async login(account: string, password: string): Promise<AuxHomeSession> {
    const publicKeyResponse = await this.request<LoginPublicKey>({ method: 'GET', url: '/auth/getPubkey' });
    const publicKeyBase64 = typeof publicKeyResponse === 'string'
      ? publicKeyResponse
      : publicKeyResponse.publicKey ?? publicKeyResponse.publicKeyBase64;
    if (!publicKeyBase64) {
      throw new AuxHomeRestError('invalid-response', 'AUX Home request failed (invalid-response): request rejected');
    }

    const result = await this.request<LoginResult>({
      method: 'POST',
      url: '/auth/login/pwd',
      data: {
        account: encryptAuxHomeAccount(account),
        password: encryptAuxHomePassword(password, publicKeyBase64),
        publicKeyBase64,
        ts: this.now(),
      },
    });
    const uid = result.appUser?.uid;
    const token = result.token?.token;
    if (!uid || !token) {
      throw new AuxHomeRestError('invalid-response', 'AUX Home request failed (invalid-response): request rejected');
    }

    this.session = { uid, token };
    return { uid, token };
  }

  public async listDevices(options: AuxHomeDeviceQueryOptions = {}): Promise<AuxHomeDeviceRecord[]> {
    if (!this.session) {
      throw new Error('AUX Home session is not authenticated');
    }

    const response = await this.request<DeviceResponse>({
      method: 'GET',
      url: '/user_device?getStatus=true',
      headers: this.authorizedHeaders(),
    });
    let devices = this.deviceRecords(response)
      .filter((device): device is AuxHomeDeviceRecord & { did: string } => (
        typeof device.did === 'string' && device.did.length > 0
      ))
      .map((device) => ({ ...device, endpointId: device.did }));

    if (options.includeIds?.size) {
      devices = devices.filter((device) => options.includeIds?.has(device.endpointId));
    }
    if (options.excludeIds?.size) {
      devices = devices.filter((device) => !options.excludeIds?.has(device.endpointId));
    }

    return devices;
  }

  public invalidateSession(): void {
    this.session = undefined;
  }

  private async request<T>(request: AuxHomeRequestConfig): Promise<T> {
    let response: { data: unknown };
    try {
      response = await this.transport.request({
        ...request,
        headers: { ...COMPATIBILITY_HEADERS, ...request.headers },
      });
    } catch (error) {
      const status = (error as { response?: { status?: number } }).response?.status;
      if (status === 401 || status === 403) {
        throw new AuxHomeRestError('auth', 'AUX Home authentication rejected', status);
      }
      throw new AuxHomeRestError('network', 'AUX Home network request failed');
    }
    const payload = response.data as MyResponse<T>;
    if (payload.code !== 0 && payload.code !== 200) {
      const kind = payload.code === 401 || payload.code === 403 ? 'auth' : 'request';
      throw new AuxHomeRestError(kind, `AUX Home request failed (${String(payload.code)}): request rejected`, payload.code);
    }
    return payload.data;
  }

  private authorizedHeaders(): Record<string, string> {
    if (!this.session) {
      throw new Error('AUX Home session is not authenticated');
    }
    return { authorization: `bearer ${this.session.token}` };
  }

  private deviceRecords(response: DeviceResponse): AuxHomeRawDeviceRecord[] {
    if (Array.isArray(response)) {
      return response;
    }
    return response.devices ?? response.deviceList ?? response.list ?? [];
  }
}
