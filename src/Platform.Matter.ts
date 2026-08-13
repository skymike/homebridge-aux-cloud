import type {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
} from 'homebridge';

import { AuxApiError, type AuxDevice } from './api/AuxCloudClient';
import { AuxDeviceControl } from './api/AuxDeviceControl';
import { createProvider } from './api/providers/createProvider';
import type { AuxProvider } from './api/providers/AuxProvider';
import { MatterThermostatAccessory } from './MatterThermostatAccessory';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings';
import {
  ALLOWED_FEATURE_SWITCHES,
  type AuxCloudPlatformConfig,
  type AuxCloudPlatformDependencies,
  type FeatureSwitchKey,
  type IAuxCloudPlatform,
} from './types';

export class AuxCloudMatterPlatform implements DynamicPlatformPlugin, IAuxCloudPlatform {
  private readonly config: AuxCloudPlatformConfig;

  public readonly provider: AuxProvider;
  private readonly closeProviderOnUnload: boolean;

  public readonly deviceControl: AuxDeviceControl;

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

  // Matter accessory instances
  private readonly matterAccessories: MatterThermostatAccessory[] = [];

  // HAP accessories buffered for removal when Matter takes control
  private cachedHapAccessories: PlatformAccessory[] = [];

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

  configureAccessory(accessory: PlatformAccessory): void {
    // DIFFERENT from HAP: buffer for removal — Matter takes full control
    // Legacy HAP accessories from a previous boot will be unregistered once Matter registers
    this.cachedHapAccessories.push(accessory);
    this.log.debug('[Matter] Buffering legacy HAP accessory for removal: %s', accessory.displayName);
  }

  // ─────────────────────────────────────────────
  // Public entry point — called by the proxy
  // ─────────────────────────────────────────────

  public async initialize(): Promise<void> {
    if (!this.credentialsConfigured) return;

    this.subscribeToProvider();

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
        if (devicesWithStaticIp.length === 0) {
          throw this.redactDeviceIdentifiers ? new Error('AUX Home LAN discovery failed') : error;
        }
        if (this.redactDeviceIdentifiers) {
          this.log.warn('[Aux Cloud] LAN discovery broadcast failed. Using configured local device');
        } else {
          this.log.warn('[Aux Cloud] LAN discovery broadcast failed (%s). Using static IP/MAC from config.', error);
        }
      }
    }

    await this.discoverAndRegisterDevices();

    const intervalSeconds = this.validatePollInterval(this.config.pollInterval);
    this.pollInterval = setInterval(() => {
      void this.refreshPoll();
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
    const matterAccessory = this.matterAccessories.find((candidate) => (
      candidate.getDevice()?.endpointId === device.endpointId
    ));
    if (matterAccessory) {
      void matterAccessory.refresh();
    }
  }

  // ─────────────────────────────────────────────
  // Device discovery + Matter registration
  // ─────────────────────────────────────────────

  private async discoverAndRegisterDevices(): Promise<void> {
    // Load devices into devicesById (same as refreshDevices but without reconcileAccessories)
    let cloudDevices: AuxDevice[] = [];

    try {
          await this.provider.ensureLoggedIn(this.config.username!, this.config.password!);
  cloudDevices = await this.provider.listDevices({
        includeIds: this.includeIds,
        excludeIds: this.excludeIds,
      });
      this.lastKnownCloudDevices = cloudDevices;
      this.log.debug('Fetched %d AUX Cloud devices', cloudDevices.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (this.redactDeviceIdentifiers) {
        this.log.warn('Failed to fetch AUX Home devices');
      } else {
        this.log.warn('Failed to fetch AUX Cloud devices: %s', message);
      }
      cloudDevices = this.lastKnownCloudDevices.length > 0
        ? this.lastKnownCloudDevices
        : cloudDevices;
  this.provider.invalidateSession();
    }

    const lanOnlyDevices = this.getLanOnlyDevices();
    const allDevices = [...cloudDevices, ...lanOnlyDevices];

    if (this.config.localControlEnabled) {
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

    // Populate devicesById
    for (const device of allDevices) {
      const existing = this.devicesById.get(device.endpointId);
      const merged = existing
        ? {
          ...existing,
          ...device,
          params: this.mergeParams(existing.params, device.params),
          state: device.state ?? existing.state,
          lastUpdated: device.lastUpdated ?? existing.lastUpdated,
        }
        : {
          ...device,
          params: device.params ?? {},
        };
      this.devicesById.set(device.endpointId, merged);
    }

    // Register Matter accessories for each device
    const allKnownDevices = [...this.devicesById.values()];
    for (const device of allKnownDevices) {
      const deviceConfig = this.config.devices?.find((d) => d.mac === device.mac);
      if (deviceConfig?.bridge === 'HAP') continue;
      try {
        const matterAccessory = new MatterThermostatAccessory(this, device);
        const thermostat = matterAccessory.toAccessory();
        const fan = matterAccessory.toFanAccessory();
        const switches = matterAccessory.getMatterSwitchAccessories();

        // Register thermostat as a standalone accessory — no OnOffSwitch/Fan parts.
        // Nesting other device types as parts causes Apple Home to misclassify the
        // composite as a switch/Other instead of Climate/HVAC.
        await this.registerMatterAccessoriesInternal([thermostat], device.friendlyName);

        // Register fan as a separate Fan (§ 9.2) device so Apple Home shows a
        // dedicated fan speed tile with percentage slider and mode selector.
        await this.registerMatterAccessoriesInternal([fan], `${device.friendlyName} Fan`);

        // Register each feature switch as an independent Matter accessory.
        for (const sw of switches) {
          const swName = (sw as { displayName: string }).displayName;
          await this.registerMatterAccessoriesInternal([sw], `${device.friendlyName} - ${swName}`);
        }

        // Only add to poll list after successful registration
        this.matterAccessories.push(matterAccessory);
        this.log.info('[Matter] Registered "%s" + fan + %d switches', device.friendlyName, switches.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.redactDeviceIdentifiers) {
          this.log.error('[Matter] Failed to register AUX Home accessory for "%s"', device.friendlyName);
        } else {
          this.log.error('[Matter] Failed to register accessory for "%s": %s', device.friendlyName, message);
        }
      }
    }

    // Unregister legacy HAP accessories now that Matter has taken control
    if (this.cachedHapAccessories.length > 0) {
      try {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, this.cachedHapAccessories);
        this.log.info('[Matter] Unregistered %d legacy HAP accessories', this.cachedHapAccessories.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.redactDeviceIdentifiers) {
          this.log.warn('[Matter] Failed to unregister legacy AUX Home accessories');
        } else {
          this.log.warn('[Matter] Failed to unregister legacy HAP accessories: %s', message);
        }
      }
      this.cachedHapAccessories = [];
    }
  }

  // ─────────────────────────────────────────────
  // Poll loop — Matter variant (no reconcileAccessories)
  // ─────────────────────────────────────────────

  private async refreshPoll(): Promise<void> {
    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      let cloudDevices: AuxDevice[] = [];

      try {
        await this.provider.ensureLoggedIn(this.config.username!, this.config.password!);
        cloudDevices = await this.provider.listDevices({
          includeIds: this.includeIds,
          excludeIds: this.excludeIds,
        });
        this.lastKnownCloudDevices = cloudDevices;
        this.log.debug('Fetched %d AUX Cloud devices', cloudDevices.length);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.redactDeviceIdentifiers) {
          this.log.warn('Failed to fetch AUX Home devices');
        } else {
          this.log.warn('Failed to fetch AUX Cloud devices: %s', message);
        }
        cloudDevices = this.lastKnownCloudDevices.length > 0
          ? this.lastKnownCloudDevices
          : cloudDevices;
        this.provider.invalidateSession();
      }

      const lanOnlyDevices = this.getLanOnlyDevices();
      const allDevices = [...cloudDevices, ...lanOnlyDevices];

      if (this.config.localControlEnabled) {
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
        // Update devicesById — same merge logic as reconcileAccessories but without HAP
        for (const device of allDevices) {
          const existing = this.devicesById.get(device.endpointId);
          const merged = existing
            ? {
              ...existing,
              ...device,
              params: this.mergeParams(existing.params, device.params),
              state: device.state ?? existing.state,
              lastUpdated: device.lastUpdated ?? existing.lastUpdated,
            }
            : {
              ...device,
              params: device.params ?? {},
            };

          if (this.isStaleState(device.endpointId) && existing) {
            merged.params = { ...existing.params };
            merged.state = existing.state ?? merged.state;
          }

          this.devicesById.set(device.endpointId, merged);
        }

        // Update Matter accessory states
        this.refreshMatterState();
      }
    } finally {
      this.isSyncing = false;
    }
  }

  // ─────────────────────────────────────────────
  // Matter accessory registration
  // ─────────────────────────────────────────────

  public async registerMatterAccessoriesInternal(
    accessories: unknown[],
    deviceName: string,
  ): Promise<void> {
    // Always unregister first to clear stale Matter-side state.
    // This prevents the "already defined" identity-conflict that occurs when
    // Matter has a persisted entry but the endpoint is broken (from a previous
    // transaction rollback). The promise resolves even on error, so we can't
    // detect the conflict — we must prevent it entirely.
    for (const acc of accessories) {
      try {
        await this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      } catch {
        /* ignore — accessory may not exist in Matter */
      }
    }

    // Register all accessories fresh
    for (const acc of accessories) {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
      if (this.redactDeviceIdentifiers) {
        this.log.info('[Matter] "%s" registered fresh', deviceName);
      } else {
        const uuid = (acc as { UUID: string }).UUID;
        this.log.info('[Matter] "%s" registered fresh (UUID: %s)', deviceName, uuid);
      }
    }
  }

  // ─────────────────────────────────────────────
  // Matter state refresh — called on each poll
  // ─────────────────────────────────────────────

  private refreshMatterState(): void {
    for (const matterAccessory of this.matterAccessories) {
      // Skip Matter state refresh if there's a pending command — prevents
      // overwriting optimistic state before the cloud confirms.
      const dev = matterAccessory.getDevice();
      if (dev && this.isStaleState(dev.endpointId)) {
        continue;
      }
      void matterAccessory.refresh();
    }
  }

  // ─────────────────────────────────────────────
  // IAuxCloudPlatform implementation
  // ─────────────────────────────────────────────

  public getDevice(endpointId: string): AuxDevice | undefined {
    return this.devicesById.get(endpointId);
  }

  public updateCachedDevice(device: AuxDevice): void {
    this.devicesById.set(device.endpointId, device);
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
        // Command failed — schedule quick refresh to sync state
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
   * Retorna true si hay un comando pendiente activo.
   * Usado en el poll para saltar actualizaciones stale.
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
      void this.refreshPoll();
    }, delayMs);
  }

  // ─────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────

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

  private validatePollInterval(interval?: number): number {
    if (!interval || Number.isNaN(interval) || interval < 15) {
      return 30;
    }
    if (interval > 600) {
      return 600;
    }
    return interval;
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

    const accessories = this.matterAccessories.flatMap((accessory) => [
      accessory.toAccessory(),
      accessory.toFanAccessory(),
      ...accessory.getMatterSwitchAccessories(),
    ]);
    if (accessories.length > 0) {
      void this.api.matter.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, accessories);
      this.matterAccessories.length = 0;
    }
  }
}
