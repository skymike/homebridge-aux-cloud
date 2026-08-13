import type { API, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import type { AuxDevice } from '../api/AuxCloudClient';
import type { AuxProvider, AuxProviderStateListener } from '../api/providers/AuxProvider';
import { AuxCloudHAPPlatform } from '../Platform.HAP';
import { AuxCloudMatterPlatform } from '../Platform.Matter';
import { AuxCloudPlatformProxy } from '../Platform.Proxy';
import { AuxCloudPlatform } from '../platform';

const ENDPOINT_ID = 'synthetic-platform-device';

function makeDevice(overrides: Partial<AuxDevice> = {}): AuxDevice {
  return {
    endpointId: ENDPOINT_ID,
    friendlyName: 'Synthetic platform unit',
    productId: 'synthetic-product',
    devSession: '',
    devicetypeFlag: 0,
    cookie: '',
    params: { pwr: 0, temp: 240, ac_mode: 0 },
    state: 1,
    lastUpdated: '2026-08-13T10:00:00.000Z',
    ...overrides,
  };
}

class FakeProvider implements AuxProvider {
  public readonly kind = 'aux-home' as const;

  public readonly ensureLoggedIn = jest.fn().mockResolvedValue(undefined);

  public readonly listDevices = jest.fn().mockResolvedValue([makeDevice()]);

  public readonly setDeviceParams = jest.fn().mockResolvedValue(undefined);

  public readonly refreshDeviceParams = jest.fn().mockResolvedValue({});

  public readonly invalidateSession = jest.fn();

  public readonly close = jest.fn().mockResolvedValue(undefined);

  public readonly unsubscribe = jest.fn();

  private listener?: AuxProviderStateListener;

  public onStateChange(listener: AuxProviderStateListener): () => void {
    this.listener = listener;
    return this.unsubscribe;
  }

  public emit(device: AuxDevice): void {
    this.listener?.(device);
  }
}

function makePlatformHarness() {
  const provider = new FakeProvider();
  const handler = { updateAccessory: jest.fn() };
  const matterAccessory = { getDevice: () => makeDevice(), refresh: jest.fn().mockResolvedValue(undefined), toAccessory: jest.fn() };
  const accessory = {
    UUID: `uuid-${ENDPOINT_ID}`,
    displayName: 'Synthetic platform unit',
    context: { device: { endpointId: ENDPOINT_ID } },
  } as unknown as PlatformAccessory;
  const log = {
    debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn(), success: jest.fn(), log: jest.fn(),
    prefix: '',
  } as unknown as Logger;
  const api = {
    hap: {
      Service: {},
      Characteristic: {},
      uuid: { generate: (id: string) => `uuid-${id}` },
    },
    matter: {
      unregisterPlatformAccessories: jest.fn(),
    },
    on: jest.fn(),
    isMatterAvailable: jest.fn(() => false),
    isMatterEnabled: jest.fn(() => false),
    registerPlatformAccessories: jest.fn(),
    unregisterPlatformAccessories: jest.fn(),
  } as unknown as API;
  const config = {
    platform: 'AUXCloud',
    name: 'Synthetic test platform',
    provider: 'aux-home',
    username: 'synthetic-account@example.test',
    password: 'synthetic-password',
    enableHomeKit: true,
  } as PlatformConfig;
  const platform = new AuxCloudPlatform(log, config, api, {
    providerFactory: () => provider,
  });
  const internals = platform as unknown as {
    initialize(): Promise<void>;
    handlers: Map<string, typeof handler>;
    matterAccessories: Array<typeof matterAccessory>;
  };
  platform.accessories.push(accessory);
  internals.handlers.set(accessory.UUID, handler);
  internals.matterAccessories.push(matterAccessory);
  return { api, handler, internals, matterAccessory, platform, provider };
}

describe('AuxCloudPlatform AUX Home push integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('subscribes once and routes pushed state through the cache, HAP handler, and matching Matter refresh', async () => {
    const { handler, internals, matterAccessory, platform, provider } = makePlatformHarness();
    await internals.initialize();
    handler.updateAccessory.mockClear();
    matterAccessory.refresh.mockClear();

    provider.emit(makeDevice({
      params: { pwr: 1, temp: 255, ac_mode: 0, ignored: Number.NaN },
      lastUpdated: '2026-08-13T10:00:02.000Z',
    }));

    expect(provider.listDevices).toHaveBeenCalledTimes(1);
    expect(platform.getDevice(ENDPOINT_ID)).toMatchObject({
      params: { pwr: 1, temp: 255, ac_mode: 0 },
      lastUpdated: '2026-08-13T10:00:02.000Z',
    });
    expect(handler.updateAccessory).toHaveBeenCalledTimes(1);
    expect(handler.updateAccessory).toHaveBeenCalledWith(platform.getDevice(ENDPOINT_ID));
    expect(matterAccessory.refresh).toHaveBeenCalledTimes(1);
  });

  test('unload unsubscribes, clears polling and debounce timers, closes the provider, and retains Matter unregister', async () => {
    const { api, internals, platform, provider } = makePlatformHarness();
    await internals.initialize();
    platform.requestRefresh(500);
    expect(jest.getTimerCount()).toBe(2);

    platform.onPlatformUnload();

    expect(provider.unsubscribe).toHaveBeenCalledTimes(1);
    expect(provider.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
    expect(api.matter.unregisterPlatformAccessories).toHaveBeenCalledTimes(1);
  });
});

describe('active proxy platform AUX Home push integration', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('the active HAP platform consumes provider pushes without polling', async () => {
    const base = makePlatformHarness();
    const hap = new AuxCloudHAPPlatform(base.platform.log, {
      platform: 'AUXCloud', name: 'HAP test', username: 'synthetic', password: 'synthetic',
    } as PlatformConfig, base.platform.api, { providerFactory: () => base.provider });
    const accessory = {
      UUID: `uuid-${ENDPOINT_ID}`,
      displayName: 'Synthetic platform unit',
      context: { device: { endpointId: ENDPOINT_ID } },
    } as unknown as PlatformAccessory;
    const handler = { updateAccessory: jest.fn() };
    const internals = hap as unknown as { handlers: Map<string, typeof handler> };
    hap.accessories.push(accessory);
    internals.handlers.set(accessory.UUID, handler);

    await hap.initialize();
    handler.updateAccessory.mockClear();
    base.provider.emit(makeDevice({ params: { pwr: 1, temp: 255, ac_mode: 0 } }));

    expect(base.provider.listDevices).toHaveBeenCalledTimes(1);
    expect(hap.getDevice(ENDPOINT_ID)?.params).toMatchObject({ pwr: 1, temp: 255 });
    expect(handler.updateAccessory).toHaveBeenCalledTimes(1);
    hap.onPlatformUnload();
    expect(base.provider.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the active Matter platform refreshes only the matching accessory on a provider push', async () => {
    const base = makePlatformHarness();
    const updateAccessoryState = jest.fn().mockResolvedValue(undefined);
    const api = {
      ...base.api,
      packageJSON: { version: '0.0.0-test' },
      matter: {
        uuid: { generate: (id: string) => `matter-${id}` },
        deviceTypes: { Thermostat: 'Thermostat', Fan: 'Fan', OnOffSwitch: 'OnOffSwitch' },
        registerPlatformAccessories: jest.fn().mockResolvedValue(undefined),
        unregisterPlatformAccessories: jest.fn().mockResolvedValue(undefined),
        updateAccessoryState,
      },
    } as unknown as API;
    const matter = new AuxCloudMatterPlatform(base.platform.log, {
      platform: 'AUXCloud', name: 'Matter test', username: 'synthetic', password: 'synthetic',
    } as PlatformConfig, api, { providerFactory: () => base.provider });

    await matter.initialize();
    updateAccessoryState.mockClear();
    base.provider.emit(makeDevice({ params: { pwr: 1, temp: 255, ac_mode: 0 } }));
    await Promise.resolve();

    expect(base.provider.listDevices).toHaveBeenCalledTimes(1);
    expect(matter.getDevice(ENDPOINT_ID)?.params).toMatchObject({ pwr: 1, temp: 255 });
    expect(updateAccessoryState).toHaveBeenCalled();
    matter.onPlatformUnload();
    expect(base.provider.close).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('the registered proxy forwards unload to every active platform', () => {
    const base = makePlatformHarness();
    const proxy = new AuxCloudPlatformProxy(base.platform.log, {} as PlatformConfig, base.platform.api);
    const hapUnload = jest.fn();
    const matterUnload = jest.fn();
    Object.assign(proxy as unknown as Record<string, unknown>, {
      inner: { configureAccessory: jest.fn(), initialize: jest.fn(), onPlatformUnload: hapUnload },
      matterPlatform: { onPlatformUnload: matterUnload },
    });

    proxy.onPlatformUnload();

    expect(hapUnload).toHaveBeenCalledTimes(1);
    expect(matterUnload).toHaveBeenCalledTimes(1);
  });
});
