import type { Logger } from 'homebridge';

import { AcFreedomProvider } from './AcFreedomProvider';
import type { AuxProvider, AuxProviderKind } from './AuxProvider';

export interface CreateProviderOptions {
  provider?: AuxProviderKind;
  region?: 'eu' | 'usa' | 'cn';
  logger?: Logger;
  requestTimeoutMs?: number;
}

export function createProvider(options: CreateProviderOptions = {}): AuxProvider {
  if (options.provider === 'aux-home') {
    if (options.region && options.region !== 'eu') {
      throw new Error('AUX Home currently supports the EU region only');
    }

    throw new Error('AUX Home provider is not implemented yet');
  }

  return new AcFreedomProvider(options);
}
