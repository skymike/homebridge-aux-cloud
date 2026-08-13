import type { API, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig } from 'homebridge';

import { AuxCloudHAPPlatform } from './Platform.HAP';
import { AuxCloudMatterPlatform } from './Platform.Matter';
import type { AuxCloudPlatformConfig } from './types';

interface InitializablePlatform extends DynamicPlatformPlugin {
  initialize(): Promise<void>;
  onPlatformUnload?(): void;
}

export class AuxCloudPlatformProxy implements DynamicPlatformPlugin {
  private inner?: InitializablePlatform;
  private matterPlatform?: AuxCloudMatterPlatform;
  private readonly bufferedAccessories: PlatformAccessory[] = [];

  constructor(
    private readonly log: Logger,
    private readonly config: PlatformConfig,
    private readonly api: API,
  ) {
    this.api.on('didFinishLaunching', () => { void this.onDidFinishLaunching(); });
  }

  private replayBufferedToInner(): void {
    if (!this.inner) return;
    for (const accessory of this.bufferedAccessories) {
      this.inner.configureAccessory(accessory);
    }
    this.bufferedAccessories.length = 0;
  }

  private async onDidFinishLaunching(): Promise<void> {
    const cfg = this.config as AuxCloudPlatformConfig;
    const matterAvailable = this.api.isMatterAvailable?.() ?? false;
    const matterEnabled = this.api.isMatterEnabled?.() ?? false;
    const matterReady = matterAvailable && matterEnabled;

    // `expose` takes precedence; fall back to legacy `enableMatter` boolean
    const expose = cfg.expose ?? (cfg.enableMatter ? 'matter' : 'hap');

    if (expose === 'both') {
      if (!matterReady) {
        this.log.warn('[Platform] expose=both requested but Matter is not available/enabled; falling back to HAP only');
        this.inner = new AuxCloudHAPPlatform(this.log, this.config, this.api);
        this.replayBufferedToInner();
        await this.inner.initialize();
        return;
      }

      this.log.info('[Platform] expose=both — starting HAP + Matter platforms simultaneously');
      // HAP is the primary inner: receives cached accessories and drives configureAccessory
      this.inner = new AuxCloudHAPPlatform(this.log, this.config, this.api);
      this.replayBufferedToInner();

      // Matter is secondary: does NOT receive cached HAP accessories (keepHap implicit — cachedHapAccessories stays empty)
      try {
        this.matterPlatform = new AuxCloudMatterPlatform(this.log, this.config, this.api);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.error('[Platform] Failed to create Matter platform (%s); HAP-only fallback', msg);
      }

      const initTasks: Promise<void>[] = [this.inner.initialize()];
      if (this.matterPlatform) {
        initTasks.push(
          this.matterPlatform.initialize().catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.log.error('[Platform] Matter initialization failed (%s); HAP remains active', msg);
          }),
        );
      }
      await Promise.all(initTasks);

    } else if (expose === 'matter') {
      if (!matterReady) {
        this.log.warn('[Platform] Matter not available or not enabled in Homebridge settings; falling back to HAP');
        this.inner = new AuxCloudHAPPlatform(this.log, this.config, this.api);
      } else {
        this.log.info('[Platform] Matter available — using Matter platform');
        this.inner = new AuxCloudMatterPlatform(this.log, this.config, this.api);
      }
      this.replayBufferedToInner();
      await this.inner.initialize();

    } else {
      this.log.info('[Platform] Initializing HAP platform');
      this.inner = new AuxCloudHAPPlatform(this.log, this.config, this.api);
      this.replayBufferedToInner();
      await this.inner.initialize();
    }
  }

  configureAccessory(accessory: PlatformAccessory): void {
    if (this.inner) {
      this.inner.configureAccessory(accessory);
    } else {
      this.bufferedAccessories.push(accessory);
    }
  }

  public onPlatformUnload(): void {
    this.inner?.onPlatformUnload?.();
    this.matterPlatform?.onPlatformUnload();
  }
}
