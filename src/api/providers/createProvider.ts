import type { Logger } from 'homebridge';

import { AcFreedomProvider } from './AcFreedomProvider';
import { AuxHomeProvider } from './AuxHomeProvider';
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

    return new AuxHomeProvider({
      region: 'eu',
      logger: options.logger,
      requestTimeoutMs: options.requestTimeoutMs,
    });
  }

  return new AcFreedomProvider(options);
}
