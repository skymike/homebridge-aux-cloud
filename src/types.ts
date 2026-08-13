import type { API, Logger, PlatformConfig } from 'homebridge';

import type { AuxDevice } from './api/AuxCloudClient';
import type { AuxProviderKind } from './api/providers/AuxProvider';

export type FeatureSwitchKey =
  | 'screenDisplay'
  | 'mildewProof'
  | 'clean'
  | 'health'
  | 'eco'
  | 'sleep';

export const ALLOWED_FEATURE_SWITCHES: FeatureSwitchKey[] = [
  'screenDisplay',
  'mildewProof',
  'clean',
  'health',
  'eco',
  'sleep',
];

export interface AuxCloudPlatformConfig extends PlatformConfig {
  provider?: AuxProviderKind;
  username?: string;
  password?: string;
  region?: 'eu' | 'usa' | 'cn';
  temperatureUnit?: 'C' | 'F';
  temperatureStep?: number;
  featureSwitches?: string[];
  pollInterval?: number;
  includeDeviceIds?: string[];
  excludeDeviceIds?: string[];

  // Optimistic UI settings
  commandRetryCount?: number;
  commandTimeoutMs?: number;

  // Local (LAN) control settings
  controlStrategy?: 'local-first' | 'cloud-only';
  localControlEnabled?: boolean;

  // Exposure mode: 'hap' (default), 'matter', or 'both' (HAP + Matter simultaneously)
  expose?: 'hap' | 'matter' | 'both';
  // Legacy aliases kept for backward compatibility
  enableMatter?: boolean;
  enableHomeKit?: boolean;
  devices?: Array<{
    endpointId?: string;
    mac?: string;
    ip?: string;
    name?: string;
    controlStrategy?: 'local' | 'cloud';
    bridge?: 'HAP' | 'Matter';
  }>;
}

export interface IAuxCloudPlatform {
  readonly api: API;
  readonly log: Logger;
  readonly featureSwitches: Set<FeatureSwitchKey>;
  readonly temperatureStep: number;
  readonly commandTimeoutMs: number;
  readonly commandRetryCount: number;
  registerPendingCommand(endpointId: string): number | null;
  completePendingCommand(endpointId: string): void;
  isStaleState(endpointId: string): boolean;
  startDeviceCommand(device: AuxDevice, params: Record<string, number>, retryCount?: number): void;
  getDevice(endpointId: string): AuxDevice | undefined;
}
