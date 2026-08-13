import type { Logger } from 'homebridge';

import type { AuxDevice } from '../api/AuxCloudClient';
import { AuxDeviceControl } from '../api/AuxDeviceControl';
import type { AuxProviderKind } from '../api/providers/AuxProvider';
import { AuxProviderCommandSupersededError } from '../api/providers/AuxProvider';

const ENDPOINT_ID = 'dev2app/topic-derived-device/state';
const LAN_IP = '192.0.2.77';
const LAN_MAC = '02:00:00:00:00:77';

function makeLogger(): Logger {
  return {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn(), log: jest.fn(),
    prefix: '',
  } as unknown as Logger;
}

function makeDevice(): AuxDevice {
  return {
    endpointId: ENDPOINT_ID,
    friendlyName: 'Synthetic safe alias',
    productId: 'synthetic-product',
    devSession: '',
    devicetypeFlag: 0,
    cookie: '',
    mac: LAN_MAC,
    params: { pwr: 1, temp: 240, ac_mode: 0, ac_mark: 0 },
    state: 1,
  };
}

function makeControl(
  kind: AuxProviderKind,
  logger: Logger,
  rejectsCloud = false,
  withLocalMapping = true,
): AuxDeviceControl {
  return new AuxDeviceControl({
    logger,
    localControlEnabled: true,
    devices: withLocalMapping
      ? [{ endpointId: ENDPOINT_ID, mac: LAN_MAC, ip: LAN_IP, controlStrategy: 'local' }]
      : [],
    cloudProvider: {
      kind,
      setDeviceParams: rejectsCloud
        ? jest.fn().mockRejectedValue(new Error(`broker rejected ${ENDPOINT_ID}`))
        : jest.fn().mockResolvedValue(undefined),
    },
  });
}

function allLogs(logger: Logger): string {
  return JSON.stringify([
    ...(logger.debug as jest.Mock).mock.calls,
    ...(logger.info as jest.Mock).mock.calls,
    ...(logger.warn as jest.Mock).mock.calls,
    ...(logger.error as jest.Mock).mock.calls,
  ]);
}

describe('AuxDeviceControl provider-specific identifier redaction', () => {
  test('suppresses AUX Home LAN IP/MAC logging and redacts local errors', async () => {
    const logger = makeLogger();
    const control = makeControl('aux-home', logger);
    const internals = control as unknown as {
      getOrCreateSession: jest.Mock;
      sendLocalCommand(ip: string, mac: string, params: Record<string, number>): Promise<void>;
    };
    internals.getOrCreateSession = jest.fn().mockResolvedValue({
      socket: { send: (...args: unknown[]) => (args[args.length - 1] as (error?: Error) => void)() },
      key: Buffer.alloc(16), id: Buffer.alloc(4), count: 1, authenticated: true,
    });

    await internals.sendLocalCommand(LAN_IP, LAN_MAC, { pwr: 1, temp: 240 });
    expect(allLogs(logger)).not.toContain(LAN_IP);
    expect(allLogs(logger)).not.toContain(LAN_MAC);

    internals.sendLocalCommand = jest.fn().mockRejectedValue(new Error(`LAN failed at ${LAN_IP}/${LAN_MAC}`));
    await expect(control.sendCommand(makeDevice(), { pwr: 0 }, { globalStrategy: 'local-first' }))
      .rejects.toThrow('LAN command failed for AUX Home device');
    expect(allLogs(logger)).not.toContain(ENDPOINT_ID);
  });

  test('redacts AUX Home cloud failures from propagated errors', async () => {
    const logger = makeLogger();
    const control = makeControl('aux-home', logger, true, false);

    await expect(control.sendCommand(makeDevice(), { pwr: 0 }, {
      globalStrategy: 'cloud-only', cloudRetryCount: 0,
    })).rejects.toThrow('Failed to control AUX Home device after 1 cloud attempts');
  });

  test('preserves AC Freedom LAN and cloud identifier diagnostics', async () => {
    const logger = makeLogger();
    const control = makeControl('ac-freedom', logger, true);
    const internals = control as unknown as {
      getOrCreateSession: jest.Mock;
      sendLocalCommand(ip: string, mac: string, params: Record<string, number>): Promise<void>;
    };
    internals.getOrCreateSession = jest.fn().mockResolvedValue({
      socket: { send: (...args: unknown[]) => (args[args.length - 1] as (error?: Error) => void)() },
      key: Buffer.alloc(16), id: Buffer.alloc(4), count: 1, authenticated: true,
    });

    await internals.sendLocalCommand(LAN_IP, LAN_MAC, { pwr: 1 });
    expect(allLogs(logger)).toContain(LAN_IP);
    const cloudControl = makeControl('ac-freedom', logger, true, false);
    await expect(cloudControl.sendCommand(makeDevice(), { pwr: 0 }, {
      globalStrategy: 'cloud-only', cloudRetryCount: 0,
    })).rejects.toThrow(`Failed to control ${ENDPOINT_ID} after 1 cloud attempts`);
  });

  test('does not retry a superseded AUX Home command after a newer desired state', async () => {
    jest.useFakeTimers();
    const published: Record<string, number>[] = [];
    const provider = {
      kind: 'aux-home' as const,
      setDeviceParams: jest.fn(async (_device: AuxDevice, params: Record<string, number>) => {
        published.push(params);
        if (params['ac_mode'] === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 600));
          throw new AuxProviderCommandSupersededError();
        }
      }),
    };
    const control = new AuxDeviceControl({ cloudProvider: provider });
    const first = control.sendCommand(makeDevice(), { pwr: 1 }, { cloudRetryCount: 2 });
    jest.advanceTimersByTime(400);
    const second = control.sendCommand(makeDevice(), { pwr: 1, ac_mode: 1 }, { cloudRetryCount: 2 });
    await second;
    jest.advanceTimersByTime(200);
    await expect(first).rejects.toBeInstanceOf(AuxProviderCommandSupersededError);
    expect(published).toEqual([{ pwr: 1 }, { pwr: 1, ac_mode: 1 }]);
    jest.useRealTimers();
  });
});
