import type { Logger } from 'homebridge';

import { AcFreedomProvider } from './AcFreedomProvider';
import { AuxHomeProvider } from './AuxHomeProvider';
import type { AuxProvider, AuxProviderKind } from './AuxProvider';
import type { AuxTrace } from '../trace/AuxTrace';

export interface CreateProviderOptions {
  provider?: AuxProviderKind;
  region?: 'eu' | 'usa' | 'cn';
  logger?: Logger;
  requestTimeoutMs?: number;
  commandTimeoutMs?: number;
  trace?: AuxTrace;
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
      commandTimeoutMs: options.commandTimeoutMs,
      trace: options.trace,
    });
  }

  return new AcFreedomProvider(options);
}
