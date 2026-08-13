import type { AuxDevice } from '../AuxCloudClient';

export type AuxProviderKind = 'ac-freedom' | 'aux-home';

export interface DeviceQueryOptions {
  includeIds?: Set<string>;
  excludeIds?: Set<string>;
}

export type AuxProviderStateListener = (device: AuxDevice) => void;

export interface AuxProvider {
  readonly kind: AuxProviderKind;
  ensureLoggedIn(identifier: string, password: string): Promise<void>;
  listDevices(options?: DeviceQueryOptions): Promise<AuxDevice[]>;
  setDeviceParams(device: AuxDevice, values: Record<string, number>): Promise<void>;
  refreshDeviceParams(device: AuxDevice): Promise<Record<string, number>>;
  invalidateSession(): void;
  onStateChange(listener: AuxProviderStateListener): () => void;
  close(): Promise<void>;
}
