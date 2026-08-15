import { createHash } from 'crypto';
import type { Logger } from 'homebridge';

import type { AuxDevice } from '../AuxCloudClient';

export interface AuxTraceContext {
  readonly correlationId: string;
  readonly source: string;
  readonly device: string;
  readonly details: Record<string, unknown>;
}

export type AuxTraceEvent =
  | 'hap.get'
  | 'hap.set'
  | 'hap.sync'
  | 'command.start'
  | 'command.dispatch'
  | 'command.retry.scheduled'
  | 'command.retry.fired'
  | 'control.route'
  | 'control.attempt'
  | 'mqtt.publish'
  | 'mqtt.confirmed'
  | 'mqtt.superseded'
  | 'mqtt.timeout'
  | 'state.push';

const SENSITIVE_FIELD = /(?:password|token|account|credential|secret|session|cookie|topic|endpoint|deviceid|mac|ip)/i;

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sanitize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SENSITIVE_FIELD.test(key))
        .map(([key, entry]) => [key, sanitize(entry)]),
    );
  }
  return value;
}

export class AuxTrace {
  private sequence = 0;

  constructor(
    private readonly logger: Pick<Logger, 'info'>,
    private readonly enabled: boolean,
  ) {}

  public createContext(
    source: string,
    device: Pick<AuxDevice, 'endpointId'>,
    details: Record<string, unknown> = {},
  ): AuxTraceContext {
    this.sequence += 1;
    return {
      correlationId: `cmd-${this.sequence}`,
      source,
      device: this.deviceAlias(device),
      details: sanitize(details) as Record<string, unknown>,
    };
  }

  public deviceAlias(device: Pick<AuxDevice, 'endpointId'>): string {
    const digest = createHash('sha256').update(device.endpointId).digest('hex').slice(0, 10);
    return `device-${digest}`;
  }

  public emit(
    event: AuxTraceEvent,
    context: AuxTraceContext,
    details: Record<string, unknown> = {},
  ): void {
    if (!this.enabled) {
      return;
    }
    const record = sanitize({
      event,
      source: context.source,
      correlationId: context.correlationId,
      device: context.device,
      ...context.details,
      ...details,
    });
    this.logger.info('[AUX TRACE] %s', JSON.stringify(record));
  }
}
