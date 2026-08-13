import type { Logger } from 'homebridge';

import { AuxCloudClient, type AuxDevice } from '../AuxCloudClient';
import type { AuxProvider, AuxProviderStateListener, DeviceQueryOptions } from './AuxProvider';

export interface AcFreedomProviderOptions {
  region?: 'eu' | 'usa' | 'cn';
  logger?: Logger;
  requestTimeoutMs?: number;
}

export class AcFreedomProvider implements AuxProvider {
  public readonly kind = 'ac-freedom' as const;

  private readonly client: AuxCloudClient;

  constructor(options: AcFreedomProviderOptions = {}) {
    this.client = new AuxCloudClient(options);
  }

  public ensureLoggedIn(identifier: string, password: string): Promise<void> {
    return this.client.ensureLoggedIn(identifier, password);
  }

  public listDevices(options?: DeviceQueryOptions): Promise<AuxDevice[]> {
    return this.client.listDevices(options);
  }

  public setDeviceParams(device: AuxDevice, values: Record<string, number>): Promise<void> {
    return this.client.setDeviceParams(device, values);
  }

  public refreshDeviceParams(device: AuxDevice): Promise<Record<string, number>> {
    return this.client.refreshDeviceParams(device);
  }

  public invalidateSession(): void {
    this.client.invalidateSession();
  }

  public onStateChange(_listener: AuxProviderStateListener): () => void {
    return () => {};
  }

  public close(): Promise<void> {
    return Promise.resolve();
  }
}
