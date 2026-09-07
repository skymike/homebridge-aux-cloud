jest.mock('../platformAccessory', () => ({
  AuxCloudPlatformAccessory: jest.fn(),
}));

import { AuxCloudHAPPlatform } from '../Platform.HAP';
import { AuxCloudPlatformAccessory } from '../platformAccessory';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';
import type { AuxDevice } from '../api/AuxCloudClient';

type PrivateHAPPlatform = {
  reconcileAccessories: (devices: AuxDevice[], cloudFetchSucceeded: boolean) => void;
  refreshDevices: () => Promise<void>;
};

function makeAccessory(endpointId: string, friendlyName = 'Device') {
  return {
    UUID: `uuid-${endpointId}`,
    context: { device: { endpointId, productId: 'ac', friendlyName } },
  };
}

function makeDevice(endpointId: string, overrides: Partial<AuxDevice> = {}): AuxDevice {
  return {
    endpointId,
    friendlyName: 'Device',
    productId: 'ac',
    devSession: '',
    devicetypeFlag: 0,
    cookie: '',
    params: {},
    state: 1,
    ...overrides,
  };
}

function makeContext(opts: {
  accessories?: unknown[];
  localControlEnabled?: boolean;
  lanOnlyMac?: string;
  enableHomeKit?: boolean;
  unregisterPlatformAccessories?: jest.Mock;
  listDevices?: jest.Mock;
  platformAccessory?: jest.Mock;
  registerPlatformAccessories?: jest.Mock;
} = {}) {
  const log = { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const unregisterPlatformAccessories = opts.unregisterPlatformAccessories ?? jest.fn();

  return Object.assign(Object.create(AuxCloudHAPPlatform.prototype), {
    log,
    config: {
      localControlEnabled: opts.localControlEnabled ?? false,
    },
    provider: {
      ensureLoggedIn: jest.fn().mockResolvedValue(undefined),
      listDevices: opts.listDevices ?? jest.fn().mockResolvedValue([]),
      invalidateSession: jest.fn(),
    },
    deviceControl: {
      getLanOnlyMappings: jest.fn(() =>
        opts.lanOnlyMac
          ? [{ mac: opts.lanOnlyMac, ip: '10.0.0.50', name: 'LAN Device' }]
          : [],
      ),
      getDeviceMapping: jest.fn(() => undefined),
      pollLocalState: jest.fn(),
      recordFailure: jest.fn(),
    },
    devicesById: new Map(),
    handlers: new Map(),
    pendingCommands: new Map(),
    accessories: opts.accessories ?? [],
    api: {
      hap: { uuid: { generate: (id: string) => `uuid-${id}` } },
      platformAccessory: opts.platformAccessory ?? jest.fn(),
      registerPlatformAccessories: opts.registerPlatformAccessories ?? jest.fn(),
      unregisterPlatformAccessories,
    },
    enableHomeKit: opts.enableHomeKit ?? true,
    isSyncing: false,
    lastKnownCloudDevices: [],
  });
}

function callReconcile(ctx: ReturnType<typeof makeContext>, devices: AuxDevice[], cloudFetchSucceeded: boolean) {
  const method = (AuxCloudHAPPlatform.prototype as unknown as PrivateHAPPlatform).reconcileAccessories;
  return method.call(ctx, devices, cloudFetchSucceeded);
}

function callRefreshDevices(ctx: ReturnType<typeof makeContext>) {
  const method = (AuxCloudHAPPlatform.prototype as unknown as PrivateHAPPlatform).refreshDevices;
  return method.call(ctx);
}

describe('AuxCloudHAPPlatform.reconcileAccessories — cold start / cloud fetch failure', () => {
  test('registers a new HomeKit accessory before its handler attaches services', () => {
    const lifecycle: string[] = [];
    const accessory = makeAccessory('cloud-1');
    const platformAccessory = jest.fn(() => accessory);
    const registerPlatformAccessories = jest.fn(() => lifecycle.push('registered'));
    const mockedHandler = AuxCloudPlatformAccessory as jest.MockedClass<typeof AuxCloudPlatformAccessory>;
    mockedHandler.mockImplementation(() => {
      lifecycle.push('services-attached');
      return { updateAccessory: jest.fn() } as unknown as AuxCloudPlatformAccessory;
    });
    const ctx = makeContext({ platformAccessory, registerPlatformAccessories });

    callReconcile(ctx, [makeDevice('cloud-1')], true);

    expect(lifecycle).toEqual(['registered', 'services-attached']);
  });

  test('cloud-only accessory is NOT unregistered when cloud fetch failed (cold start, no cache)', () => {
    const cloudAccessory = makeAccessory('cloud-1', 'Aire Dormitorio');
    const unregister = jest.fn();
    const ctx = makeContext({ accessories: [cloudAccessory], unregisterPlatformAccessories: unregister });

    // No devices seen this round (cloud fetch failed, no LAN devices) — simulates the
    // exact production scenario: cold start, first cloud fetch fails, no fallback cache.
    callReconcile(ctx, [], false);

    expect(unregister).not.toHaveBeenCalled();
    expect(ctx.accessories).toContain(cloudAccessory);
  });

  test('cloud-only accessory is NOT unregistered when cloud fetch fails after a prior success (warm cache)', () => {
    const cloudAccessory = makeAccessory('cloud-1', 'Aire Dormitorio');
    const unregister = jest.fn();
    const ctx = makeContext({ accessories: [cloudAccessory], unregisterPlatformAccessories: unregister });

    // Even if devices happens to be non-empty (e.g. stale cache reused), cloudFetchSucceeded=false
    // must still protect the accessory when it isn't present in `devices`.
    callReconcile(ctx, [], false);

    expect(unregister).not.toHaveBeenCalled();
  });

  test('cloud-only accessory IS unregistered when a successful fetch confirms it no longer exists', () => {
    const cloudAccessory = makeAccessory('cloud-1', 'Aire Dormitorio');
    const unregister = jest.fn();
    const ctx = makeContext({ accessories: [cloudAccessory], unregisterPlatformAccessories: unregister });

    // Successful fetch (cloudFetchSucceeded=true) that no longer includes this device.
    callReconcile(ctx, [], true);

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [cloudAccessory]);
    expect(ctx.accessories).not.toContain(cloudAccessory);
  });

  test('LAN-only accessory is unregistered when missing from config, regardless of cloud fetch result', () => {
    const lanAccessory = makeAccessory('lan-aabbccddeeff', 'Old LAN Device');
    const unregister = jest.fn();
    // No lanOnlyMac configured — the accessory's endpointId won't be in lanOnlyEndpointIds.
    const ctx = makeContext({ accessories: [lanAccessory], unregisterPlatformAccessories: unregister });

    callReconcile(ctx, [], false);

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [lanAccessory]);
  });

  test('device still present in devices is never treated as stale, cloud fetch failed or not', () => {
    const cloudAccessory = makeAccessory('cloud-1', 'Aire Dormitorio');
    const unregister = jest.fn();
    const ctx = makeContext({ accessories: [cloudAccessory], unregisterPlatformAccessories: unregister });
    ctx.handlers.set(cloudAccessory.UUID, { updateAccessory: jest.fn() });

    callReconcile(ctx, [makeDevice('cloud-1', { friendlyName: 'Aire Dormitorio' })], false);

    expect(unregister).not.toHaveBeenCalled();
    expect(ctx.accessories).toContain(cloudAccessory);
  });
});

describe('AuxCloudHAPPlatform.refreshDevices — threads cloudFetchSucceeded through to reconcileAccessories', () => {
  test('cold start with failing first cloud fetch does not unregister the cloud-only accessory', async () => {
    const cloudAccessory = makeAccessory('cloud-1', 'Aire Dormitorio');
    const unregister = jest.fn();
    const listDevices = jest.fn().mockRejectedValue(new Error('getaddrinfo EAI_AGAIN app-service-usa.smarthomecs.com'));
    const ctx = makeContext({
      accessories: [cloudAccessory],
      unregisterPlatformAccessories: unregister,
      localControlEnabled: true,
      lanOnlyMac: 'aa:bb:cc:dd:ee:ff',
      listDevices,
    });
    const lanAccessory = makeAccessory('lan-aabbccddeeff', 'LAN Device');
    ctx.accessories.push(lanAccessory);
    ctx.handlers.set(lanAccessory.UUID, { updateAccessory: jest.fn() });

    await callRefreshDevices(ctx);

    expect(listDevices).toHaveBeenCalledTimes(1);
    expect(unregister).not.toHaveBeenCalled();
    expect(ctx.accessories).toContain(cloudAccessory);
  });

  test('successful cloud fetch still removes a cloud accessory absent from the response', async () => {
    const cloudAccessory = makeAccessory('cloud-1', 'Aire Dormitorio');
    const unregister = jest.fn();
    const listDevices = jest.fn().mockResolvedValue([]);
    const ctx = makeContext({
      accessories: [cloudAccessory],
      unregisterPlatformAccessories: unregister,
      localControlEnabled: true,
      lanOnlyMac: 'aa:bb:cc:dd:ee:ff',
      listDevices,
    });
    const lanAccessory = makeAccessory('lan-aabbccddeeff', 'LAN Device');
    ctx.accessories.push(lanAccessory);
    ctx.handlers.set(lanAccessory.UUID, { updateAccessory: jest.fn() });

    await callRefreshDevices(ctx);

    expect(unregister).toHaveBeenCalledTimes(1);
    expect(unregister).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [cloudAccessory]);
  });
});
