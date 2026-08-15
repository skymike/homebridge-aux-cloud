import type { AuxDevice } from '../AuxCloudClient';
import type { AuxTraceContext } from '../trace/AuxTrace';

export type AuxProviderKind = 'ac-freedom' | 'aux-home';

export interface DeviceQueryOptions {
  includeIds?: Set<string>;
  excludeIds?: Set<string>;
}

export type AuxProviderStateListener = (device: AuxDevice) => void;

export class AuxProviderCommandSupersededError extends Error {
  constructor() {
    super('A newer AUX Home command replaced the pending command');
    this.name = 'AuxProviderCommandSupersededError';
  }
}

export interface AuxProvider {
  readonly kind: AuxProviderKind;
  ensureLoggedIn(identifier: string, password: string): Promise<void>;
  listDevices(options?: DeviceQueryOptions): Promise<AuxDevice[]>;
  setDeviceParams(device: AuxDevice, values: Record<string, number>, traceContext?: AuxTraceContext): Promise<void>;
  refreshDeviceParams(device: AuxDevice): Promise<Record<string, number>>;
  invalidateSession(): void;
  onStateChange(listener: AuxProviderStateListener): () => void;
  close(): Promise<void>;
}
