import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
} from 'homebridge';

import { AuxApiError, type AuxDevice } from './api/AuxCloudClient';
import { AuxDeviceControl } from './api/AuxDeviceControl';
import { createProvider } from './api/providers/createProvider';
import type { AuxProvider } from './api/providers/AuxProvider';
import { AuxCloudPlatformAccessory } from './platformAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import {
  type AuxCloudPlatformConfig,
  type AuxCloudPlatformDependencies,
  type FeatureSwitchKey,
  type IAuxCloudPlatform,
  ALLOWED_FEATURE_SWITCHES,
} from './types';
import type { AuxCloudPlatform } from './platform';

export class AuxCloudHAPPlatform implements DynamicPlatformPlugin, IAuxCloudPlatform {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

  private static hasValidContext(accessory: PlatformAccessory): boolean {
    const context = accessory.context as { device?: { endpointId?: string } };
    return Boolean(context.device?.endpointId);
  }

  private readonly config: AuxCloudPlatformConfig;

  private readonly provider: AuxProvider;
  private readonly closeProviderOnUnload: boolean;

  private readonly deviceControl: AuxDeviceControl;

  private readonly includeIds: Set<string>;

  private readonly excludeIds: Set<string>;

  private readonly credentialsConfigured: boolean;

  public readonly temperatureUnit: 'C' | 'F';

  public readonly temperatureStep: number;

  public readonly featureSwitches: Set<FeatureSwitchKey>;

  public readonly commandRetryCount: number;
  public readonly commandTimeoutMs: number;
  public readonly redactDeviceIdentifiers: boolean;
  public readonly enableHomeKit: boolean;

  private readonly handlers = new Map<string, AuxCloudPlatformAccessory>();

  private readonly devicesById = new Map<string, AuxDevice>();

  // Track pending commands per device to avoid stale refresh overwriting optimistic state
  private pendingCommands = new Map<
    string,
    { sequence: number; timestamp: number; expectedState: number }
  >();

  private readonly pendingCompletionTimers = new Map<string, NodeJS.Timeout>();

  private isSyncing = false;

  // Cache last known cloud devices for resilience when cloud is unreachable
  private lastKnownCloudDevices: AuxDevice[] = [];

  private refreshDebounce?: NodeJS.Timeout;

  private pollInterval?: NodeJS.Timeout;

  private unsubscribeProvider?: () => void;

  constructor(
    public readonly log: Logger,
    config: PlatformConfig,
    public readonly api: API,
    dependencies: AuxCloudPlatformDependencies = {},
  ) {
    this.config = (config ?? {}) as AuxCloudPlatformConfig;
    this.credentialsConfigured = Boolean(this.config.username && this.config.password);
    if (!this.credentialsConfigured) {
      this.log.info('AUX Cloud plugin is installed but not configured; skipping initialization until credentials are provided.');
    }

    this.includeIds = new Set(this.config.includeDeviceIds ?? []);
    this.excludeIds = new Set(this.config.excludeDeviceIds ?? []);

    this.temperatureUnit = this.config.temperatureUnit === 'F' ? 'F' : 'C';
    const configuredStep = this.config.temperatureStep === 1 ? 1 : 0.5;
    this.temperatureStep = this.temperatureUnit === 'F' ? 1 : configuredStep;
    if (this.temperatureUnit === 'F' && configuredStep !== 1) {
      this.log.debug('Using 1°F increments when displaying temperatures.');
    }

    const configuredFeatureSwitches = new Set(
      (this.config.featureSwitches ?? []).filter((value): value is FeatureSwitchKey =>
        ALLOWED_FEATURE_SWITCHES.includes(value as FeatureSwitchKey),
      ),
    );
    this.featureSwitches = configuredFeatureSwitches;

    // HomeKit registration toggle (default true — disabled Matter only mode)
    this.enableHomeKit = this.config.enableHomeKit !== false;

    // Retry / timeout config
    this.commandRetryCount =
      this.config.commandRetryCount !== undefined && this.config.commandRetryCount >= 0
        ? Math.min(this.config.commandRetryCount, 5)
        : 2;
    this.commandTimeoutMs =
      this.config.commandTimeoutMs !== undefined
        ? Math.max(1000, Math.min(15000, this.config.commandTimeoutMs))
        : 5000;

    // Create the client with custom timeout
    const providerFactory = dependencies.providerFactory ?? createProvider;
    this.closeProviderOnUnload = dependencies.closeProviderOnUnload !== false;
    this.provider = providerFactory({
      provider: this.config.provider,
      region: this.config.region ?? 'eu',
      logger: this.log,
      requestTimeoutMs: this.config.requestTimeoutMs ?? 5000,
      commandTimeoutMs: this.commandTimeoutMs,
    });
    this.redactDeviceIdentifiers = this.provider.kind === 'aux-home';

    // Device control with local/cloud selection — share the platform's logged-in client
    this.deviceControl = new AuxDeviceControl({
      region: this.config.region ?? 'eu',
      logger: this.log,
      commandTimeoutMs: this.commandTimeoutMs,
      commandRetryCount: this.commandRetryCount,
      localControlEnabled: this.config.localControlEnabled,
      devices: this.config.devices,
        cloudProvider: this.provider,
    });

    this.log.debug(
      'Finished initializing platform: %s (retryCount=%d, timeout=%dms)',
      this.config.name,
      this.commandRetryCount,
      this.commandTimeoutMs,
    );
  }

  /**
   * Called by the proxy after 'didFinishLaunching'. Performs LAN discovery
   * (if enabled) and starts the polling loop.
   */
  public async initialize(): Promise<void> {
    if (!this.credentialsConfigured) {
      return;
    }

    this.subscribeToProvider();
    await this.startPolling();
  }

  private async startPolling(): Promise<void> {
    if (this.config.localControlEnabled) {
      const { DeviceDiscovery } = await import('./api/broadlink/DeviceDiscovery');
      const devicesWithStaticIp = (this.config.devices ?? []).filter((d) => d.ip && d.mac);
      try {
        const discovered = await DeviceDiscovery.discover(3000);
        if (discovered.length === 0 && devicesWithStaticIp.length === 0) {
          throw new Error('LAN discovery found no Broadlink devices and no static IP/MAC configured. Check your network or disable localControlEnabled.');
        }
        for (const dev of discovered) {
          this.deviceControl.registerDiscoveredDevice(dev);
          if (this.redactDeviceIdentifiers) {
            this.log.info('Discovered Broadlink device for AUX Home local control');
          } else {
            this.log.info('Discovered Broadlink device: %s (MAC: %s)', dev.ip, dev.mac);
          }
        }
        if (discovered.length === 0) {
          this.log.warn('[Aux Cloud] LAN discovery found no devices via broadcast. Using static IP/MAC from config.');
        }
      } catch (error) {
        if ((this.config.devices ?? []).filter((d) => d.ip && d.mac).length === 0) {
          throw this.redactDeviceIdentifiers ? new Error('AUX Home LAN discovery failed') : error;
        }
        if (this.redactDeviceIdentifiers) {
          this.log.warn('[Aux Cloud] LAN discovery broadcast failed. Using configured local device');
        } else {
          this.log.warn('[Aux Cloud] LAN discovery broadcast failed (%s). Using static IP/MAC from config.', error);
        }
      }
    }

    await this.refreshDevices();

    const intervalSeconds = this.validatePollInterval(this.config.pollInterval);
    this.pollInterval = setInterval(() => {
      void this.refreshDevices();
    }, intervalSeconds * 1000);
  }

  private subscribeToProvider(): void {
    if (!this.unsubscribeProvider) {
      this.unsubscribeProvider = this.provider.onStateChange((device) => this.applyProviderState(device));
    }
  }

  private applyProviderState(device: AuxDevice): void {
    const existing = this.devicesById.get(device.endpointId);
    if (!existing) {
      return;
    }
    const mergedDevice: AuxDevice = {
      ...existing,
      ...device,
      params: this.mergeParams(existing.params, device.params),
      state: device.state ?? existing.state,
      lastUpdated: device.lastUpdated ?? existing.lastUpdated,
    };
    this.devicesById.set(device.endpointId, mergedDevice);
    this.completePendingCommand(device.endpointId);
    const uuid = this.api.hap.uuid.generate(device.endpointId);
    this.handlers.get(uuid)?.updateAccessory(mergedDevice);
  }

  configureAccessory(accessory: PlatformAccessory): void {
    if (!AuxCloudHAPPlatform.hasValidContext(accessory)) {
      this.log.warn('Removing legacy AUX accessory without endpoint id: %s', accessory.displayName);
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      return;
    }

    this.log.info('Loading accessory from cache: %s', accessory.displayName);
    if (this.enableHomeKit) {
      this.accessories.push(accessory);
    }

    if (!this.handlers.has(accessory.UUID)) {
      const handler = new AuxCloudPlatformAccessory(this as unknown as AuxCloudPlatform, accessory);
      this.handlers.set(accessory.UUID, handler);
    }
  }

  public getDevice(endpointId: string): AuxDevice | undefined {
    return this.devicesById.get(endpointId);
  }

  public updateCachedDevice(device: AuxDevice): void {
    this.devicesById.set(device.endpointId, device);
  }

  /**
   * @deprecated Mantener por compatibilidad con setAuxMode legacy.
   * Usar startDeviceCommand() para nuevos handlers.
   */
  public async sendDeviceParams(
    device: AuxDevice,
    params: Record<string, number>,
  ): Promise<void> {
    await this.sendDeviceParamsWithRetry(device, params);
  }

  /**
   * Envía params al dispositivo con local/cloud selection y retry.
   * Delega a AuxDeviceControl para selección automática.
   */
  public async sendDeviceParamsWithRetry(
    device: AuxDevice,
    params: Record<string, number>,
    retryCount: number = this.commandRetryCount,
  ): Promise<void> {
    // Ensure cloud session is valid before sending command
    if (this.credentialsConfigured) {
          await this.provider.ensureLoggedIn(this.config.username!, this.config.password!);
    }
    try {
      await this.deviceControl.sendCommand(device, params, {
        globalStrategy: this.config.controlStrategy,
        localRetryCount: retryCount,
        cloudRetryCount: retryCount,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.redactDeviceIdentifiers) {
        this.log.error('Failed to control AUX Home device');
        throw new AuxApiError('Failed to control AUX Home device');
      }
      this.log.error('Failed to control %s: %s. Params: %o', device.endpointId, message, params);
      throw new AuxApiError(message);
    }
  }

  /**
   * Dispara el comando en background. El caller ya aplicó el estado optimista.
   */
  public startDeviceCommand(
    device: AuxDevice,
    params: Record<string, number>,
    retryCount: number = this.commandRetryCount,
  ): void {
    void (async () => {
      try {
        await this.sendDeviceParamsWithRetry(device, params, retryCount);
      } catch {
        // Command failed — schedule quick refresh to sync HomeKit state
        this.requestRefresh(500);
      }
    })();
  }

  /**
   * Registra un comando pendiente. Previene que el poll sobreescriba
   * el estado optimista antes de que la cloud confirme.
   * Retorna el número de secuencia, o null si ya existe uno más nuevo.
   */
  public registerPendingCommandWithState(
    endpointId: string,
    expectedState: 0 | 1,
  ): number | null {
    const existing = this.pendingCommands.get(endpointId);
    const seq = (existing?.sequence ?? 0) + 1;

    if (existing && existing.sequence >= seq) {
      return null;
    }

    this.pendingCommands.set(endpointId, {
      sequence: seq,
      timestamp: Date.now(),
      expectedState,
    });
    return seq;
  }

  public registerPendingCommand(endpointId: string): number | null {
    return this.registerPendingCommandWithState(endpointId, 1);
  }

  /**
   * Marca el comando pendiente como completado.
   * A partir de aquí el poll puede actualizar el estado normalmente.
   */
  public completePendingCommand(endpointId: string): void {
    this.pendingCommands.delete(endpointId);
    const timer = this.pendingCompletionTimers.get(endpointId);
    if (timer) {
      clearTimeout(timer);
      this.pendingCompletionTimers.delete(endpointId);
    }
  }

  public schedulePendingCommandCompletion(endpointId: string, delayMs: number): void {
    const existing = this.pendingCompletionTimers.get(endpointId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.pendingCompletionTimers.delete(endpointId);
      this.completePendingCommand(endpointId);
    }, delayMs);
    this.pendingCompletionTimers.set(endpointId, timer);
  }

  /**
   * Retorna true si hay un comando pendiente activo (< 4s desde el registro).
   * Usado en reconcileAccessories para saltar actualizaciones stale.
   */
  public isStaleState(endpointId: string): boolean {
    return this.pendingCommands.has(endpointId);
  }

  public requestRefresh(delayMs = 1_500): void {
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
    }

    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = undefined;
      void this.refreshDevices();
    }, delayMs);
  }

  private getLanOnlyDevices(): AuxDevice[] {
    if (!this.config.localControlEnabled) return [];
    return this.deviceControl.getLanOnlyMappings().map((mapping) => {
      const normalizedMac = mapping.mac.toLowerCase();
      const endpointId = `lan-${normalizedMac.replace(/:/g, '')}`;
      return (
        this.devicesById.get(endpointId) ?? {
          endpointId,
          friendlyName: mapping.name,
          productId: 'broadlink',
          devSession: '',
          devicetypeFlag: 0,
          cookie: '',
          mac: normalizedMac,
          // Default params so fan/switch accessories appear before first LAN poll
          params: {
            pwr: 0,
            temp: 240,    // 24°C ×10
            ac_mode: 4,   // AUTO
            ac_mark: 0,   // AUTO fan speed
            ac_vdir: 0,
            ac_hdir: 0,
            ac_slp: 0,
            scrdisp: 0,
            mldprf: 0,
            ac_health: 0,
            ac_clean: 0,
            mute: 0,
            turbo: 0,
          },
          state: 1,
          // LAN-only: siempre considerado online; poll actualiza params, no conectividad
        }
      );
    });
  }

  private validatePollInterval(interval?: number): number {
    if (!interval || Number.isNaN(interval) || interval < 15) {
      return 30;
    }
    if (interval > 600) {
      return 600;
    }
    return interval;
  }

  public async refreshDevices(): Promise<void> {
    if (this.isSyncing) {
      return;
    }
    this.isSyncing = true;

    try {
      let cloudDevices: AuxDevice[] = [];
      let cloudFetchSucceeded = false;

      try {
        await this.provider.ensureLoggedIn(this.config.username!, this.config.password!);
        cloudDevices = await this.provider.listDevices({
          includeIds: this.includeIds,
          excludeIds: this.excludeIds,
        });
        this.lastKnownCloudDevices = cloudDevices; // update cache
        cloudFetchSucceeded = true;
        this.log.debug('Fetched %d AUX Cloud devices', cloudDevices.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.redactDeviceIdentifiers) {
          this.log.warn('Failed to fetch AUX Home devices');
        } else {
          this.log.warn('Failed to fetch AUX Cloud devices: %s', message);
        }
        // If cloud fails, use cached devices so cloud devices don't disappear as stale
        cloudDevices = this.lastKnownCloudDevices.length > 0
          ? this.lastKnownCloudDevices
          : cloudDevices; // empty (first run with no cloud)
        this.provider.invalidateSession();
      }

      const lanOnlyDevices = this.getLanOnlyDevices();
      const allDevices = [...cloudDevices, ...lanOnlyDevices];

      if (this.config.localControlEnabled) {
        // Poll all devices in parallel — eliminates serial wait on auth timeouts
        await Promise.all(allDevices.map(async (device) => {
          const mac = device.mac;
          if (!mac) return;
          const mapping = this.deviceControl.getDeviceMapping(mac);
          if (!mapping) return;
          try {
            const localParams = await this.deviceControl.pollLocalState(mapping.ip, mapping.mac);
            if (localParams != null) {
              device.params = { ...device.params, ...localParams };
              device.state = 1;
              if (this.redactDeviceIdentifiers) {
                this.log.info('[LAN] AUX Home poll succeeded');
              } else {
                this.log.info('[LAN] Poll OK for %s', device.endpointId);
              }
            }
          } catch {
            this.deviceControl.recordFailure(device.endpointId);
            if (this.redactDeviceIdentifiers) {
              this.log.warn('[LAN] AUX Home poll failed');
            } else {
              this.log.warn('[LAN] Poll failed for %s', device.endpointId);
            }
          }
        }));
      }

      if (allDevices.length > 0) {
        this.reconcileAccessories(allDevices, cloudFetchSucceeded);
      }
    } finally {
      this.isSyncing = false;
    }
  }

  private reconcileAccessories(devices: AuxDevice[], cloudFetchSucceeded: boolean): void {
    const seen = new Set<string>();

    for (const device of devices) {
      const existingDevice = this.devicesById.get(device.endpointId);
      const mergedDevice = existingDevice
        ? {
          ...existingDevice,
          ...device,
          params: this.mergeParams(existingDevice.params, device.params),
          state: device.state ?? existingDevice.state,
          lastUpdated: device.lastUpdated ?? existingDevice.lastUpdated,
        }
        : {
          ...device,
          params: device.params ?? {},
        };

      // Si hay comando pendiente activo (< 4s), conservar los params optimistas locales
      if (this.isStaleState(device.endpointId) && existingDevice) {
        mergedDevice.params = { ...existingDevice.params };
        mergedDevice.state = existingDevice.state ?? mergedDevice.state;
      }

      const isKnownDevice = Boolean(existingDevice);
      this.devicesById.set(device.endpointId, mergedDevice);
      const uuid = this.api.hap.uuid.generate(device.endpointId);
      seen.add(uuid);

      if (!isKnownDevice) {
        if (this.redactDeviceIdentifiers) {
          this.log.info('Discovered AUX device "%s"', device.friendlyName);
          this.log.debug('Use includeDeviceIds/excludeDeviceIds in the plugin configuration to control exposure');
        } else {
          this.log.info(
            'Discovered AUX device "%s" (endpointId: %s, productId: %s)',
            device.friendlyName,
            device.endpointId,
            device.productId,
          );
          this.log.debug(
            'Use includeDeviceIds/excludeDeviceIds in the plugin configuration to control exposure (%s)',
            device.endpointId,
          );
        }
      }

      const existingAccessory = this.accessories.find((accessory) => accessory.UUID === uuid);

      if (existingAccessory) {
        existingAccessory.context.device = {
          endpointId: mergedDevice.endpointId,
          productId: mergedDevice.productId,
          friendlyName: mergedDevice.friendlyName,
        };

        const handler = this.handlers.get(existingAccessory.UUID) ?? new AuxCloudPlatformAccessory(this as unknown as AuxCloudPlatform, existingAccessory);
        handler.updateAccessory(mergedDevice);
        this.handlers.set(existingAccessory.UUID, handler);
      } else {
        this.log.info('Adding new accessory: %s', mergedDevice.friendlyName);
        const accessory = new this.api.platformAccessory(mergedDevice.friendlyName, uuid);
        accessory.context.device = {
          endpointId: mergedDevice.endpointId,
          productId: mergedDevice.productId,
          friendlyName: mergedDevice.friendlyName,
        };

        const handler = new AuxCloudPlatformAccessory(this as unknown as AuxCloudPlatform, accessory);
        handler.updateAccessory(mergedDevice);

        const deviceConfig = this.config.devices?.find((d) => d.mac === mergedDevice.mac);
        const hapEnabled = this.enableHomeKit && (deviceConfig?.bridge !== 'Matter');
        if (hapEnabled) {
          this.accessories.push(accessory);
          this.handlers.set(accessory.UUID, handler);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        }
      }
    }

    if (this.enableHomeKit) {
      const staleAccessories = this.accessories.filter((accessory) => {
        if (seen.has(accessory.UUID)) return false;
        if (cloudFetchSucceeded) return true;
        // Cloud fetch failed this round: only LAN-only accessories (identified by the
        // deterministic "lan-<mac>" endpointId, independent of the current config) are
        // stale candidates. Cloud-backed accessories are protected until a successful
        // fetch confirms they no longer exist in the account.
        const context = accessory.context as { device?: { endpointId?: string } };
        const endpointId = context.device?.endpointId;
        return endpointId !== undefined && endpointId.startsWith('lan-');
      });
      if (staleAccessories.length > 0) {
        this.log.info('Removing %d stale AUX Cloud accessories', staleAccessories.length);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, staleAccessories);

        for (const accessory of staleAccessories) {
          this.handlers.delete(accessory.UUID);
          const index = this.accessories.indexOf(accessory);
          if (index >= 0) {
            this.accessories.splice(index, 1);
          }
        }
      }
    }
  }

  private mergeParams(
    existing: Record<string, number> | undefined,
    incoming: Record<string, number> | undefined,
  ): Record<string, number> {
    const merged: Record<string, number> = { ...(existing ?? {}) };

    if (incoming) {
      for (const [key, value] of Object.entries(incoming)) {
        if (typeof value === 'number' && !Number.isNaN(value)) {
          merged[key] = value;
        }
      }
    }

    return merged;
  }

  public onPlatformUnload(): void {
    this.unsubscribeProvider?.();
    this.unsubscribeProvider = undefined;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = undefined;
    }
    if (this.refreshDebounce) {
      clearTimeout(this.refreshDebounce);
      this.refreshDebounce = undefined;
    }
    this.pendingCommands.clear();
    for (const timer of this.pendingCompletionTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingCompletionTimers.clear();
    if (this.closeProviderOnUnload) {
      void this.provider.close().catch(() => this.log.warn('Failed to close AUX cloud provider cleanly'));
    }
  }
}
