import type { API, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import type { AuxDevice } from '../api/AuxCloudClient';
import type { AuxProvider, AuxProviderStateListener } from '../api/providers/AuxProvider';
import { AuxCloudHAPPlatform } from '../Platform.HAP';
import { AuxCloudMatterPlatform } from '../Platform.Matter';
import { AuxCloudPlatformProxy } from '../Platform.Proxy';
import { AuxCloudPlatform } from '../platform';

const ENDPOINT_ID = 'synthetic-platform-device';
const SENSITIVE_ENDPOINT_ID = 'dev2app/topic-derived-device/state';
const SENSITIVE_UUID = `uuid-${SENSITIVE_ENDPOINT_ID}`;
const SENSITIVE_LAN_IP = '192.0.2.88';
const SENSITIVE_LAN_MAC = '02:00:00:00:00:88';

jest.mock('../api/broadlink/DeviceDiscovery', () => ({
  DeviceDiscovery: {
    discover: jest.fn().mockResolvedValue([{
      ip: SENSITIVE_LAN_IP,
      mac: SENSITIVE_LAN_MAC,
    }]),
  },
}));

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

  private readonly listeners = new Set<AuxProviderStateListener>();

  public onStateChange(listener: AuxProviderStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.unsubscribe();
      this.listeners.delete(listener);
    };
  }

  public emit(device: AuxDevice): void {
    for (const listener of this.listeners) listener(device);
  }

  public listenerCount(): number { return this.listeners.size; }
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
    platform.schedulePendingCommandCompletion(ENDPOINT_ID, 5_000);
    expect(jest.getTimerCount()).toBe(3);

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
    expect(JSON.stringify((base.platform.log.info as jest.Mock).mock.calls)).not.toContain(ENDPOINT_ID);

    base.provider.setDeviceParams.mockRejectedValue(new Error('synthetic transport failure'));
    await expect(hap.sendDeviceParamsWithRetry(makeDevice(), { pwr: 1 }, 0))
      .rejects.toThrow('Failed to control AUX Home device');
    expect(JSON.stringify((base.platform.log.error as jest.Mock).mock.calls)).not.toContain(ENDPOINT_ID);
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
    expect(JSON.stringify((base.platform.log.info as jest.Mock).mock.calls)).not.toContain(ENDPOINT_ID);
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

    const shutdownRegistration = (base.api.on as jest.Mock).mock.calls.find(([event]) => event === 'shutdown');
    expect(shutdownRegistration).toBeDefined();
    shutdownRegistration[1]();
    shutdownRegistration[1]();

    expect(hapUnload).toHaveBeenCalledTimes(1);
    expect(matterUnload).toHaveBeenCalledTimes(1);
  });

  test('expose=both shares one AUX Home provider and pushes state to both active views', async () => {
    const base = makePlatformHarness();
    base.provider.listDevices.mockResolvedValue([]);
    const providerFactory = jest.fn(() => base.provider);
    const api = {
      ...base.api,
      isMatterAvailable: jest.fn(() => true),
      isMatterEnabled: jest.fn(() => true),
      packageJSON: { version: '0.0.0-test' },
      matter: {
        uuid: { generate: (id: string) => `uuid-${id}` },
        deviceTypes: { Thermostat: 'Thermostat', Fan: 'Fan', OnOffSwitch: 'OnOffSwitch' },
        registerPlatformAccessories: jest.fn().mockResolvedValue(undefined),
        unregisterPlatformAccessories: jest.fn().mockResolvedValue(undefined),
        updateAccessoryState: jest.fn().mockResolvedValue(undefined),
      },
    } as unknown as API;
    const proxy = new AuxCloudPlatformProxy(base.platform.log, {
      platform: 'AUXCloud', name: 'Both test', username: 'synthetic', password: 'synthetic',
      provider: 'aux-home', expose: 'both',
    } as PlatformConfig, api, { providerFactory });
    const launch = (api.on as jest.Mock).mock.calls.filter(([event]) => event === 'didFinishLaunching').at(-1)[1];
    await launch();
    const internals = proxy as unknown as {
      inner: AuxCloudHAPPlatform;
      matterPlatform: AuxCloudMatterPlatform;
    };
    const initial = makeDevice();
    (internals.inner as unknown as { devicesById: Map<string, AuxDevice> }).devicesById.set(ENDPOINT_ID, initial);
    (internals.matterPlatform as unknown as { devicesById: Map<string, AuxDevice> }).devicesById.set(ENDPOINT_ID, initial);

    base.provider.emit(makeDevice({ params: { pwr: 1, temp: 255, ac_mode: 0 } }));

    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(base.provider.listenerCount()).toBe(2);
    expect(internals.inner.getDevice(ENDPOINT_ID)?.params).toMatchObject({ pwr: 1, temp: 255 });
    expect(internals.matterPlatform.getDevice(ENDPOINT_ID)?.params).toMatchObject({ pwr: 1, temp: 255 });
    proxy.onPlatformUnload();
    expect(base.provider.close).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['HAP', AuxCloudHAPPlatform],
    ['Matter', AuxCloudMatterPlatform],
  ] as const)('redacts AUX Home identifiers across the active Proxy→%s LAN path', async (_name, PlatformClass) => {
    const base = makePlatformHarness();
    base.provider.listDevices.mockResolvedValue([makeDevice({
      endpointId: SENSITIVE_ENDPOINT_ID,
      mac: SENSITIVE_LAN_MAC,
    })]);
    const api = {
      ...base.api,
      packageJSON: { version: '0.0.0-test' },
      matter: {
        uuid: { generate: (id: string) => `uuid-${id}` },
        deviceTypes: { Thermostat: 'Thermostat', Fan: 'Fan', OnOffSwitch: 'OnOffSwitch' },
        registerPlatformAccessories: jest.fn().mockResolvedValue(undefined),
        unregisterPlatformAccessories: jest.fn().mockResolvedValue(undefined),
        updateAccessoryState: jest.fn().mockResolvedValue(undefined),
      },
      platformAccessory: jest.fn(),
    } as unknown as API;
    const platform = new PlatformClass(base.platform.log, {
      platform: 'AUXCloud', name: 'Redaction test', username: 'synthetic', password: 'synthetic',
      localControlEnabled: true,
    } as PlatformConfig, api, { providerFactory: () => base.provider });
    const control = (platform as unknown as { deviceControl: { pollLocalState: jest.Mock } }).deviceControl;
    control.pollLocalState = jest.fn().mockRejectedValue(new Error(
      `${SENSITIVE_ENDPOINT_ID}/${SENSITIVE_UUID}/${SENSITIVE_LAN_IP}/${SENSITIVE_LAN_MAC}`,
    ));
    if (platform instanceof AuxCloudHAPPlatform) {
      const accessory = {
        UUID: SENSITIVE_UUID,
        displayName: 'Synthetic safe alias',
        context: { device: { endpointId: SENSITIVE_ENDPOINT_ID } },
      } as unknown as PlatformAccessory;
      platform.accessories.push(accessory);
      (platform as unknown as { handlers: Map<string, { updateAccessory: jest.Mock }> }).handlers
        .set(SENSITIVE_UUID, { updateAccessory: jest.fn() });
    }

    await platform.initialize();

    const logs = JSON.stringify([
      ...(base.platform.log.debug as jest.Mock).mock.calls,
      ...(base.platform.log.info as jest.Mock).mock.calls,
      ...(base.platform.log.warn as jest.Mock).mock.calls,
      ...(base.platform.log.error as jest.Mock).mock.calls,
    ]);
    for (const identifier of [SENSITIVE_ENDPOINT_ID, SENSITIVE_UUID, SENSITIVE_LAN_IP, SENSITIVE_LAN_MAC]) {
      expect(logs).not.toContain(identifier);
    }
    platform.onPlatformUnload();
  });

  test('preserves AC Freedom discovery identifiers in the active HAP path', async () => {
    const base = makePlatformHarness();
    const legacyProvider = new FakeProvider();
    Object.defineProperty(legacyProvider, 'kind', { value: 'ac-freedom' });
    legacyProvider.listDevices.mockResolvedValue([makeDevice({ endpointId: SENSITIVE_ENDPOINT_ID })]);
    const hap = new AuxCloudHAPPlatform(base.platform.log, {
      platform: 'AUXCloud', name: 'Legacy logging test', username: 'synthetic', password: 'synthetic',
    } as PlatformConfig, base.platform.api, { providerFactory: () => legacyProvider });
    const accessory = {
      UUID: SENSITIVE_UUID,
      displayName: 'Synthetic safe alias',
      context: { device: { endpointId: SENSITIVE_ENDPOINT_ID } },
    } as unknown as PlatformAccessory;
    hap.accessories.push(accessory);
    (hap as unknown as { handlers: Map<string, { updateAccessory: jest.Mock }> }).handlers
      .set(SENSITIVE_UUID, { updateAccessory: jest.fn() });

    await hap.initialize();

    expect(JSON.stringify((base.platform.log.info as jest.Mock).mock.calls)).toContain(SENSITIVE_ENDPOINT_ID);
    hap.onPlatformUnload();
  });
});
