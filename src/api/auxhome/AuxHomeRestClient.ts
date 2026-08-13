import axios from 'axios';

import { encryptAuxHomeAccount, encryptAuxHomePassword } from './AuxHomeCrypto';
import type { AuxHomeDeviceRecord, AuxHomeSession, MyResponse } from './AuxHomeTypes';

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
}

export interface AuxHomeDeviceQueryOptions {
  includeIds?: Set<string>;
  excludeIds?: Set<string>;
}

interface LoginPublicKey {
  publicKey?: string;
  publicKeyBase64?: string;
}

interface LoginResult {
  appUser?: { uid?: string };
  token?: { token?: string };
}

type DeviceResponse = AuxHomeDeviceRecord[] | {
  devices?: AuxHomeDeviceRecord[];
  deviceList?: AuxHomeDeviceRecord[];
  list?: AuxHomeDeviceRecord[];
};

export class AuxHomeRestClient {
  private readonly transport: AuxHomeTransport;

  private readonly now: () => number;

  private session?: AuxHomeSession;

  constructor(options: AuxHomeRestClientOptions = {}) {
    this.transport = options.transport ?? axios.create({ baseURL: AUX_HOME_EU_BASE_URL, timeout: 5000 });
    this.now = options.now ?? Date.now;
  }

  public async login(account: string, password: string): Promise<AuxHomeSession> {
    const publicKeyResponse = await this.request<LoginPublicKey>({ method: 'GET', url: '/auth/getPubkey' });
    const publicKeyBase64 = publicKeyResponse.publicKey ?? publicKeyResponse.publicKeyBase64;
    if (!publicKeyBase64) {
      throw new Error('AUX Home request failed (invalid-response): request rejected');
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
      throw new Error('AUX Home request failed (invalid-response): request rejected');
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
    const response = await this.transport.request({
      ...request,
      headers: { ...COMPATIBILITY_HEADERS, ...request.headers },
    });
    const payload = response.data as MyResponse<T>;
    if (payload.code !== 0) {
      throw new Error(`AUX Home request failed (${String(payload.code)}): request rejected`);
    }
    return payload.data;
  }

  private authorizedHeaders(): Record<string, string> {
    if (!this.session) {
      throw new Error('AUX Home session is not authenticated');
    }
    return { authorization: `bearer ${this.session.token}` };
  }

  private deviceRecords(response: DeviceResponse): AuxHomeDeviceRecord[] {
    if (Array.isArray(response)) {
      return response;
    }
    return response.devices ?? response.deviceList ?? response.list ?? [];
  }
}
