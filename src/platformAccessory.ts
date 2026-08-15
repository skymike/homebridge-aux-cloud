import type { Characteristic, CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import {
  AC_CLEAN,
  AC_CLEAN_OFF,
  AC_CLEAN_ON,
  AC_COMFORTABLE_WIND,
  AC_FAN_SPEED,
  AC_HEALTH,
  AC_HEALTH_OFF,
  AC_HEALTH_ON,
  AC_MILDEW_PROOF,
  AC_MILDEW_PROOF_OFF,
  AC_MILDEW_PROOF_ON,
  AC_POWER,
  AC_POWER_OFF,
  AC_POWER_ON,
  AC_SCREEN_DISPLAY,
  AC_SCREEN_DISPLAY_OFF,
  AC_SCREEN_DISPLAY_ON,
  AC_SLEEP,
  AC_SLEEP_OFF,
  AC_SLEEP_ON,
  AC_SWING_HORIZONTAL,
  AC_SWING_HORIZONTAL_OFF,
  AC_SWING_HORIZONTAL_ON,
  AC_SWING_VERTICAL,
  AC_SWING_VERTICAL_OFF,
  AC_SWING_VERTICAL_ON,
  AC_TEMPERATURE_AMBIENT,
  AC_TEMPERATURE_TARGET,
  AC_MODE_SPECIAL,
  AUX_ECOMODE,
  AUX_ECOMODE_OFF,
  AUX_ECOMODE_ON,
  AuxAcModeValue,
  AuxFanSpeed,
  AuxProducts,
  AUX_MODE,
} from './api/constants';
import type { AuxDevice } from './api/AuxCloudClient';
import type { AuxTraceContext } from './api/trace/AuxTrace';
import type { AuxCloudPlatform, FeatureSwitchKey } from './platform';

interface AuxCloudAccessoryContext {
  device?: {
    endpointId: string;
    productId?: string;
    friendlyName?: string;
  };
}

const MIN_TARGET_TEMPERATURE_C = 16;
const MAX_TARGET_TEMPERATURE_C = 30;
const DEFAULT_TEMPERATURE_C = 24;
const CURRENT_TEMPERATURE_MIN_C = -40;
const CURRENT_TEMPERATURE_MAX_C = 60;
const FAN_ROTATION_STEP = 20;

type FanSpeedLevelId = 'comfortable' | 'mute' | 'low' | 'medium' | 'high' | 'turbo';

interface FanSpeedLevel {
  readonly id: FanSpeedLevelId;
  readonly aux: AuxFanSpeed;
  readonly percent: number;
  readonly comfortableWind: boolean;
}

const FAN_SPEED_LEVELS: FanSpeedLevel[] = [
  { id: 'comfortable', aux: AuxFanSpeed.MUTE, percent: 0, comfortableWind: true },
  { id: 'mute', aux: AuxFanSpeed.MUTE, percent: 20, comfortableWind: false },
  { id: 'low', aux: AuxFanSpeed.LOW, percent: 40, comfortableWind: false },
  { id: 'medium', aux: AuxFanSpeed.MEDIUM, percent: 60, comfortableWind: false },
  { id: 'high', aux: AuxFanSpeed.HIGH, percent: 80, comfortableWind: false },
  { id: 'turbo', aux: AuxFanSpeed.TURBO, percent: 100, comfortableWind: false },
];
const DEFAULT_MANUAL_FAN_SPEED = AuxFanSpeed.MEDIUM;

const roundToOneDecimal = (value: number): number => Math.round(value * 10) / 10;
const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const MODE_RETRY_DELAY_MS = 1_200;

const celsiusToDisplay = (celsius: number, unit: 'C' | 'F'): number =>
  unit === 'F' ? roundToOneDecimal((celsius * 9) / 5 + 32) : roundToOneDecimal(celsius);

const displayToCelsius = (value: number, unit: 'C' | 'F'): number =>
  unit === 'F' ? ((value - 32) * 5) / 9 : value;

interface FeatureSwitchDefinition {
  readonly label: string;
  readonly param: string;
  readonly onPayload: Record<string, number>;
  readonly offPayload: Record<string, number>;
}

const FEATURE_SWITCH_CONFIG: Record<FeatureSwitchKey, FeatureSwitchDefinition> = {
  screenDisplay: {
    label: 'Screen Display',
    param: AC_SCREEN_DISPLAY,
    onPayload: AC_SCREEN_DISPLAY_ON,
    offPayload: AC_SCREEN_DISPLAY_OFF,
  },
  mildewProof: {
    label: 'Mildew Proof',
    param: AC_MILDEW_PROOF,
    onPayload: AC_MILDEW_PROOF_ON,
    offPayload: AC_MILDEW_PROOF_OFF,
  },
  clean: {
    label: 'Self Clean',
    param: AC_CLEAN,
    onPayload: AC_CLEAN_ON,
    offPayload: AC_CLEAN_OFF,
  },
  health: {
    label: 'Health Mode',
    param: AC_HEALTH,
    onPayload: AC_HEALTH_ON,
    offPayload: AC_HEALTH_OFF,
  },
  eco: {
    label: 'Eco Mode',
    param: AUX_ECOMODE,
    onPayload: AUX_ECOMODE_ON,
    offPayload: AUX_ECOMODE_OFF,
  },
  sleep: {
    label: 'Sleep Mode',
    param: AC_SLEEP,
    onPayload: AC_SLEEP_ON,
    offPayload: AC_SLEEP_OFF,
  },
};

export class AuxCloudPlatformAccessory {
  private readonly service: Service;

  private readonly temperatureUnit: 'C' | 'F';

  private readonly temperatureStep: number;

  private readonly featureSwitches: Set<FeatureSwitchKey>;

  private readonly featureSwitchServices = new Map<FeatureSwitchKey, Service>();

  private device?: AuxDevice;

  private supportsFanSpeed = false;

  private supportsSwingVertical = false;

  private supportsSwingHorizontal = false;

  private supportsComfortableWind = false;

  private hasFault = false;

  private fanAutoService?: Service;

  private readonly modeSwitchServices = new Map<'dry' | 'fan', Service>();

  private lastManualFanSpeed: AuxFanSpeed = DEFAULT_MANUAL_FAN_SPEED;

  private pendingModeTimeout?: NodeJS.Timeout;

  private pendingAuxMode?: AuxAcModeValue;

  private pendingTempTimeout?: NodeJS.Timeout;

  private pendingTempScaled?: number;

  private pendingPowerOnTimeout?: NodeJS.Timeout;

  private pendingPowerOnContext?: AuxTraceContext;

  constructor(
    private readonly platform: AuxCloudPlatform,
    private readonly accessory: PlatformAccessory,
  ) {
    this.temperatureUnit = platform.temperatureUnit;
    this.temperatureStep = platform.temperatureStep;
    this.featureSwitches = platform.featureSwitches;

    const infoService = this.accessory.getService(this.platform.Service.AccessoryInformation)
      ?? this.accessory.addService(this.platform.Service.AccessoryInformation);

    infoService
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'AUX')
      .setCharacteristic(this.platform.Characteristic.Model, 'AUX Cloud Device')
      .setCharacteristic(
        this.platform.Characteristic.SerialNumber,
        this.getContext().device?.endpointId ?? 'unknown',
      );

    this.service = this.accessory.getService(this.platform.Service.HeaterCooler)
      ?? this.accessory.addService(this.platform.Service.HeaterCooler);

    this.service.setCharacteristic(this.platform.Characteristic.Name, this.accessory.displayName);

    this.configureBaseCharacteristics();
  }

  updateAccessory(device: AuxDevice): void {
    this.device = device;
    this.platform.updateCachedDevice(device);

    const context = this.getContext();
    context.device = {
      endpointId: device.endpointId,
      productId: device.productId,
      friendlyName: device.friendlyName,
    };
    this.accessory.context = context;

    const accessoryInfo = this.accessory.getService(this.platform.Service.AccessoryInformation);
    accessoryInfo?.updateCharacteristic(
      this.platform.Characteristic.Model,
      AuxProducts.getDeviceName(device.productId),
    );
    accessoryInfo?.updateCharacteristic(
      this.platform.Characteristic.SerialNumber,
      device.endpointId,
    );

    this.service.updateCharacteristic(this.platform.Characteristic.Name, device.friendlyName);
    this.service.updateCharacteristic(
      this.platform.Characteristic.TemperatureDisplayUnits,
      this.temperatureUnit === 'F'
        ? this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT
        : this.platform.Characteristic.TemperatureDisplayUnits.CELSIUS,
    );

    this.supportsFanSpeed = typeof device.params[AC_FAN_SPEED] === 'number';
    this.supportsSwingVertical = typeof device.params[AC_SWING_VERTICAL] === 'number';
    this.supportsSwingHorizontal = typeof device.params[AC_SWING_HORIZONTAL] === 'number';
    this.supportsComfortableWind = typeof device.params[AC_COMFORTABLE_WIND] === 'number';
    const currentFan = device.params[AC_FAN_SPEED];
    if (typeof currentFan === 'number' && currentFan !== AuxFanSpeed.AUTO) {
      this.lastManualFanSpeed = currentFan as AuxFanSpeed;
    }

    this.configureFanCharacteristic();
    this.configureFanAutoSwitch();
    this.configureSwingCharacteristic();
    this.configureFeatureSwitches();
    this.configureModeSwitches();

    this.updateCharacteristicsFromDevice();
  }

  private configureBaseCharacteristics(): void {
    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onSet(this.handleActiveSet.bind(this))
      .onGet(() => this.traceGet('Active', this.handleActiveGet()));

    this.service.getCharacteristic(this.platform.Characteristic.TargetHeaterCoolerState)
      .setProps({
        validValues: [
          this.platform.Characteristic.TargetHeaterCoolerState.AUTO,
          this.platform.Characteristic.TargetHeaterCoolerState.COOL,
          this.platform.Characteristic.TargetHeaterCoolerState.HEAT,
        ],
      })
      .onSet(this.handleTargetStateSet.bind(this))
      .onGet(() => this.traceGet('TargetHeaterCoolerState', this.handleTargetStateGet()));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.traceGet('CurrentHeaterCoolerState', this.handleCurrentHeaterCoolerStateGet()));

    const currentTemperatureMin = celsiusToDisplay(CURRENT_TEMPERATURE_MIN_C, this.temperatureUnit);
    const currentTemperatureMax = celsiusToDisplay(CURRENT_TEMPERATURE_MAX_C, this.temperatureUnit);

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({
        minValue: Math.min(currentTemperatureMin, currentTemperatureMax),
        maxValue: Math.max(currentTemperatureMin, currentTemperatureMax),
        minStep: 0.1,
      })
      .onGet(() => this.traceGet('CurrentTemperature', this.handleCurrentTemperatureGet()));

    this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
      .setProps({
        minValue: this.getDisplayMinTarget(),
        maxValue: this.getDisplayMaxTarget(),
        minStep: this.temperatureStep,
      })
      .onSet(this.handleTargetTemperatureSet.bind(this))
      .onGet(() => this.traceGet('HeatingThresholdTemperature', this.handleTargetTemperatureGet()));

    this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
      .setProps({
        minValue: this.getDisplayMinTarget(),
        maxValue: this.getDisplayMaxTarget(),
        minStep: this.temperatureStep,
      })
      .onSet(this.handleTargetTemperatureSet.bind(this))
      .onGet(() => this.traceGet('CoolingThresholdTemperature', this.handleTargetTemperatureGet()));

    this.service.updateCharacteristic(
      this.platform.Characteristic.StatusFault,
      this.platform.Characteristic.StatusFault.NO_FAULT,
    );
  }

  private configureFanCharacteristic(): void {
    const existing = this.findCharacteristic(this.platform.Characteristic.RotationSpeed.UUID);

    if (this.supportsFanSpeed) {
      const characteristic = existing ?? this.service.addCharacteristic(this.platform.Characteristic.RotationSpeed);
      const levels = this.getFanLevels();
      const minValue = levels[0]?.percent ?? 0;
      characteristic.setProps({ minValue, maxValue: 100, minStep: FAN_ROTATION_STEP });
      characteristic.onSet(this.handleRotationSpeedSet.bind(this))
        .onGet(() => this.traceGet('RotationSpeed', this.handleRotationSpeedGet()));
    } else if (existing) {
      this.service.removeCharacteristic(existing);
    }
  }

  private configureFanAutoSwitch(): void {
    if (!this.supportsFanSpeed) {
      if (this.fanAutoService) {
        this.accessory.removeService(this.fanAutoService);
        this.fanAutoService = undefined;
      }
      return;
    }

    const service =
      this.fanAutoService
        ?? this.accessory.getServiceById(this.platform.Service.Switch, 'fanAuto')
        ?? this.accessory.addService(this.platform.Service.Switch, 'Auto Fan', 'fanAuto');

    this.setServiceDisplayName(service, 'Auto Fan');
    service.getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.handleFanAutoSet.bind(this))
      .onGet(() => this.traceGet('AutoFan.On', this.handleFanAutoGet()));

    this.fanAutoService = service;
  }

  private configureSwingCharacteristic(): void {
    const existing = this.findCharacteristic(this.platform.Characteristic.SwingMode.UUID);
    const shouldExpose = this.supportsSwingVertical || this.supportsSwingHorizontal;

    if (shouldExpose) {
      const characteristic = existing ?? this.service.addCharacteristic(this.platform.Characteristic.SwingMode);
      characteristic.onSet(this.handleSwingModeSet.bind(this))
        .onGet(() => this.traceGet('SwingMode', this.handleSwingModeGet()));
    } else if (existing) {
      this.service.removeCharacteristic(existing);
    }
  }

  private configureFeatureSwitches(): void {
    if (!this.device) {
      return;
    }

    (Object.keys(FEATURE_SWITCH_CONFIG) as FeatureSwitchKey[]).forEach((feature) => {
      const definition = FEATURE_SWITCH_CONFIG[feature];
      const supported = typeof this.device?.params[definition.param] === 'number';
      const shouldExpose = this.featureSwitches.has(feature) && supported;
      const existing = this.featureSwitchServices.get(feature);

      if (shouldExpose) {
        const service = existing
          ?? this.accessory.getServiceById(this.platform.Service.Switch, feature)
          ?? this.accessory.addService(this.platform.Service.Switch, definition.label, feature);

        this.setServiceDisplayName(service, definition.label);
        service.getCharacteristic(this.platform.Characteristic.On)
          .onSet(async (value) => {
            await this.handleFeatureSwitchSet(feature, Boolean(value));
          })
          .onGet(() => this.traceGet(`${definition.label}.On`, this.handleFeatureSwitchGet(feature)));

        this.featureSwitchServices.set(feature, service);
      } else if (existing) {
        this.accessory.removeService(existing);
        this.featureSwitchServices.delete(feature);
      }
    });
  }

  private configureModeSwitches(): void {
    const definitions: Array<{ key: 'dry' | 'fan'; label: string; auxMode: AuxAcModeValue }> = [
      { key: 'dry', label: 'Dry Mode', auxMode: AuxAcModeValue.DRY },
      { key: 'fan', label: 'Fan Mode', auxMode: AuxAcModeValue.FAN },
    ];

    for (const definition of definitions) {
      const existing =
        this.modeSwitchServices.get(definition.key)
          ?? this.accessory.getServiceById(this.platform.Service.Switch, definition.key)
          ?? this.accessory.addService(this.platform.Service.Switch, definition.label, definition.key);

      this.setServiceDisplayName(existing, definition.label);
      existing.getCharacteristic(this.platform.Characteristic.On)
        .onSet(async (value) => {
          await this.handleModeSwitchSet(definition.key, Boolean(value), definition.auxMode);
        })
        .onGet(() => this.traceGet(`${definition.label}.On`, this.getAuxMode() === definition.auxMode));

      this.modeSwitchServices.set(definition.key, existing);
    }
  }

  private async handleModeSwitchSet(
    mode: 'dry' | 'fan',
    enabled: boolean,
    auxMode: AuxAcModeValue,
  ): Promise<void> {
    if (!this.device) {
      return;
    }

    try {
      if (enabled) {
        await this.setAuxMode(auxMode);
      } else if (this.getAuxMode() === auxMode) {
        await this.setAuxMode(AuxAcModeValue.AUTO);
      }

      this.platform.updateCachedDevice(this.device);
      this.updateCharacteristicsFromDevice();
      this.setFaulted(false);
    } catch (error) {
      const action = enabled ? 'enable' : 'disable';
      this.handleCommandError(`${action} ${mode} mode`, error);
    }
  }

  // ------------------------------------------------------------------
  // Optimistic UI handlers
  // ------------------------------------------------------------------

  private async handleActiveSet(value: CharacteristicValue): Promise<void> {
    if (!this.device) {
      return;
    }

    const oldValue = this.isDevicePowered()
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    const isActive = Number(value) === this.platform.Characteristic.Active.ACTIVE;
    const payload = isActive ? AC_POWER_ON : AC_POWER_OFF;
    const traceContext: AuxTraceContext = this.platform.trace.createContext('hap.set', this.device, {
      service: 'HeaterCooler',
      characteristic: 'Active',
      oldValue,
      newValue: Number(value),
    });
    this.platform.trace.emit('hap.set', traceContext);

    // Aplicar estado optimista inmediatamente
    this.device.params = this.device.params ?? {};
    this.device.state = isActive ? 1 : 0;
    this.device.params[AC_POWER] = isActive ? 1 : 0;
    this.platform.updateCachedDevice(this.device);
    this.updateCharacteristicsFromDevice();
    this.setFaulted(false);

    // Registrar pending para proteger contra stale poll
    const seq = this.platform.registerPendingCommandWithState(
      this.device.endpointId,
      isActive ? 1 : 0,
    );

    // Defer power-on by one event-loop turn so a paired HomeKit mode SET can
    // merge both changes into one physical AUX transaction.
    if (isActive) {
      if (this.pendingPowerOnTimeout) {
        clearTimeout(this.pendingPowerOnTimeout);
      }
      const device = this.device;
      this.pendingPowerOnContext = traceContext;
      this.pendingPowerOnTimeout = setTimeout(() => {
        this.pendingPowerOnTimeout = undefined;
        const pendingContext = this.pendingPowerOnContext;
        this.pendingPowerOnContext = undefined;
        this.platform.startDeviceCommand(device, payload, undefined, pendingContext);
      }, 0);
    } else {
      this.consumePendingPowerOn();
      this.platform.startDeviceCommand(this.device, payload, undefined, traceContext);
    }

    // Liberar pending una vez el comando puede haber completado con retries
    if (seq !== null) {
      const endpointId = this.device.endpointId;
      const guardMs = this.platform.commandTimeoutMs * (this.platform.commandRetryCount + 1) + 3000;
      this.platform.schedulePendingCommandCompletion(endpointId, guardMs);
    }
  }

  private handleActiveGet(): CharacteristicValue {
    if (!this.device) {
      return this.platform.Characteristic.Active.INACTIVE;
    }

    const active = this.isDevicePowered();
    return active ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
  }

  private async handleTargetStateSet(value: CharacteristicValue): Promise<void> {
    if (!this.device) {
      return;
    }

    const pendingPowerOnContext = this.consumePendingPowerOn();
    const auxMode = this.mapTargetStateToAuxMode(Number(value));
    this.pendingAuxMode = auxMode;

    // Aplicar estado optimista inmediatamente
    this.device.params = this.device.params ?? {};
    this.device.params[AUX_MODE] = auxMode;
    this.platform.updateCachedDevice(this.device);
    this.updateCharacteristicsFromDevice();
    this.setFaulted(false);

    // Si el AC está apagado, encenderlo primero
    const shouldPowerOn = !this.isDevicePowered();
    if (shouldPowerOn) {
      // Aplicar estado de power optimista (el caller puede no haber llamado handleActiveSet)
      this.device.params[AC_POWER] = 1;
      this.device.state = 1;
      this.platform.updateCachedDevice(this.device);

      // Registrar pending guard para que el poll no sobreescriba el estado
      const seq = this.platform.registerPendingCommandWithState(this.device.endpointId, 1);
      if (seq !== null) {
        const endpointId = this.device.endpointId;
        const guardMs = this.platform.commandTimeoutMs * (this.platform.commandRetryCount + 1) + 3000;
        this.platform.schedulePendingCommandCompletion(endpointId, guardMs);
      }

      this.platform.startDeviceCommand(this.device, AC_POWER_ON);
      await delay(400);
    }

    const payload: Record<string, number> = { [AUX_MODE]: auxMode };
    const supportsSpecialModeParam =
      AuxProducts.getSpecialParamsList(this.device.productId)?.includes(AC_MODE_SPECIAL);
    const shouldSendSpecialModeParam =
      supportsSpecialModeParam || typeof this.device.params?.[AC_MODE_SPECIAL] === 'number';
    if (shouldSendSpecialModeParam) {
      payload[AC_MODE_SPECIAL] = auxMode;
    }
    if (pendingPowerOnContext) {
      payload[AC_POWER] = 1;
    }
    this.platform.startDeviceCommand(this.device, payload, undefined, pendingPowerOnContext);
    this.setPendingModeTimeout(auxMode, payload);
  }

  private handleTargetStateGet(): CharacteristicValue {
    if (!this.device) {
      return this.platform.Characteristic.TargetHeaterCoolerState.AUTO;
    }
    const pending = this.pendingAuxMode;
    if (typeof pending === 'number') {
      return this.mapAuxModeToTargetState(pending);
    }
    return this.mapAuxModeToTargetState(this.getAuxMode());
  }

  private handleCurrentHeaterCoolerStateGet(): CharacteristicValue {
    if (!this.device) {
      return this.platform.Characteristic.CurrentHeaterCoolerState.INACTIVE;
    }

    const { CurrentHeaterCoolerState } = this.platform.Characteristic;

    if (!this.isDevicePowered()) {
      return CurrentHeaterCoolerState.INACTIVE;
    }

    const auxMode = this.getAuxMode();
    switch (auxMode) {
      case AuxAcModeValue.HEATING:
        return CurrentHeaterCoolerState.HEATING;
      case AuxAcModeValue.COOLING:
        return CurrentHeaterCoolerState.COOLING;
      default:
        return CurrentHeaterCoolerState.IDLE;
    }
  }

  private handleCurrentTemperatureGet(): CharacteristicValue {
    const celsius = this.getCelsiusParam(AC_TEMPERATURE_AMBIENT);
    const valueC = celsius ?? DEFAULT_TEMPERATURE_C;

    if (this.temperatureUnit === 'F') {
      const fahrenheit = (valueC * 9) / 5 + 32;
      return Math.round(fahrenheit * 10) / 10;
    }

    return Math.round(valueC * 10) / 10;
  }

  private async handleTargetTemperatureSet(value: CharacteristicValue): Promise<void> {
    if (!this.device) {
      return;
    }

    const requestedDisplay = Number(value);
    const clampedDisplay = this.clampDisplayTemperature(requestedDisplay);
    const celsius = displayToCelsius(clampedDisplay, this.temperatureUnit);
    const scaled = Math.round(celsius * 10);

    // Aplicar estado optimista inmediatamente
    this.device.params = this.device.params ?? {};
    this.device.params[AC_TEMPERATURE_TARGET] = scaled;
    this.pendingTempScaled = scaled;
    this.platform.updateCachedDevice(this.device);
    this.updateCharacteristicsFromDevice();
    this.setFaulted(false);

    // Debounce: HomeKit fires both HeatingThresholdTemperature and CoolingThresholdTemperature
    // set handlers for the same change. Wait 300ms so only the last value is sent.
    if (this.pendingTempTimeout) {
      clearTimeout(this.pendingTempTimeout);
    }
    const device = this.device;
    this.pendingTempTimeout = setTimeout(() => {
      this.pendingTempTimeout = undefined;
      const finalScaled = this.pendingTempScaled;
      this.pendingTempScaled = undefined;
      if (typeof finalScaled === 'number') {
        this.platform.startDeviceCommand(device, { [AC_TEMPERATURE_TARGET]: finalScaled });
      }
    }, 300);
  }

  private handleTargetTemperatureGet(): CharacteristicValue {
    const celsius = this.getCelsiusParam(AC_TEMPERATURE_TARGET);
    const display = celsiusToDisplay(celsius ?? DEFAULT_TEMPERATURE_C, this.temperatureUnit);
    return this.clampDisplayTemperature(display);
  }

  private async handleRotationSpeedSet(value: CharacteristicValue): Promise<void> {
    if (!this.device || !this.supportsFanSpeed) {
      return;
    }

    const levels = this.getFanLevels();
    if (levels.length === 0) {
      return;
    }

    const minPercent = levels[0].percent;
    const percent = clamp(Number(value), minPercent, 100);
    const level = this.getFanLevelFromPercent(percent);

    // Aplicar estado optimista inmediatamente
    this.device.params = this.device.params ?? {};
    this.device.params[AC_FAN_SPEED] = level.aux;
    this.device.params[AC_COMFORTABLE_WIND] = level.comfortableWind ? 1 : 0;
    this.platform.updateCachedDevice(this.device);
    this.updateCharacteristicsFromDevice();
    if (this.fanAutoService) {
      this.fanAutoService.updateCharacteristic(this.platform.Characteristic.On, false);
    }
    this.setFaulted(false);

    if (!level.comfortableWind && level.aux !== AuxFanSpeed.AUTO) {
      this.lastManualFanSpeed = level.aux;
    }

    const payload: Record<string, number> = { [AC_FAN_SPEED]: level.aux };
    if (this.supportsComfortableWind) {
      payload[AC_COMFORTABLE_WIND] = level.comfortableWind ? 1 : 0;
    }
    this.setupPendingGuard();
    this.platform.startDeviceCommand(this.device, payload);
  }

  private handleRotationSpeedGet(): CharacteristicValue {
    if (!this.device || !this.supportsFanSpeed) {
      return 0;
    }

    if (this.supportsComfortableWind && this.device.params[AC_COMFORTABLE_WIND] === 1) {
      return 0;
    }

    const raw = this.device.params[AC_FAN_SPEED];
    const levels = this.getFanLevels();
    if (typeof raw !== 'number') {
      return levels[0]?.percent ?? 0;
    }

    // AUTO fan speed is managed via the dedicated Auto Fan switch; return the minimum
    // slider value so HomeKit does not misrepresent AUTO as a specific manual speed.
    if (raw === AuxFanSpeed.AUTO) {
      return levels[0]?.percent ?? 0;
    }

    const level = levels.find((candidate) => candidate.aux === raw);
    return level?.percent ?? levels[0]?.percent ?? 0;
  }

  private async handleFanAutoSet(value: CharacteristicValue): Promise<void> {
    if (!this.device || !this.supportsFanSpeed) {
      return;
    }

    const enable = Boolean(value);
    this.device.params = this.device.params ?? {};

    if (enable) {
      const previousSpeed = this.device.params?.[AC_FAN_SPEED];
      const wasComfortable =
        this.supportsComfortableWind && this.device.params[AC_COMFORTABLE_WIND] === 1;
      if (!wasComfortable && typeof previousSpeed === 'number' && previousSpeed !== AuxFanSpeed.AUTO) {
        this.lastManualFanSpeed = previousSpeed as AuxFanSpeed;
      }

      // Aplicar estado optimista
      this.device.params[AC_FAN_SPEED] = AuxFanSpeed.AUTO;
      if (this.supportsComfortableWind) {
        this.device.params[AC_COMFORTABLE_WIND] = 0;
      }
      this.platform.updateCachedDevice(this.device);
      this.updateCharacteristicsFromDevice();
      this.setFaulted(false);

      const payload: Record<string, number> = { [AC_FAN_SPEED]: AuxFanSpeed.AUTO };
      if (this.supportsComfortableWind) {
        payload[AC_COMFORTABLE_WIND] = 0;
      }
      this.setupPendingGuard();
      this.platform.startDeviceCommand(this.device, payload);
    } else {
      const target =
        this.getFanLevelForAuxSpeed(this.lastManualFanSpeed)
          ?? this.getFanLevels().find((level) => !level.comfortableWind)
          ?? this.getFanLevels()[0];

      if (!target) {
        return;
      }

      // Aplicar estado optimista
      this.device.params[AC_FAN_SPEED] = target.aux;
      this.device.params[AC_COMFORTABLE_WIND] = target.comfortableWind ? 1 : 0;
      this.platform.updateCachedDevice(this.device);
      this.updateCharacteristicsFromDevice();
      this.setFaulted(false);

      if (!target.comfortableWind && target.aux !== AuxFanSpeed.AUTO) {
        this.lastManualFanSpeed = target.aux;
      }

      const payload: Record<string, number> = { [AC_FAN_SPEED]: target.aux };
      if (this.supportsComfortableWind) {
        payload[AC_COMFORTABLE_WIND] = target.comfortableWind ? 1 : 0;
      }
      this.setupPendingGuard();
      this.platform.startDeviceCommand(this.device, payload);
    }
  }

  private setupPendingGuard(): void {
    if (!this.device) return;
    const seq = this.platform.registerPendingCommandWithState(
      this.device.endpointId,
      (this.device.state ?? 1) as 0 | 1,
    );
    if (seq !== null) {
      const endpointId = this.device.endpointId;
      const guardMs = this.platform.commandTimeoutMs * (this.platform.commandRetryCount + 1) + 3000;
      this.platform.schedulePendingCommandCompletion(endpointId, guardMs);
    }
  }

  private handleFanAutoGet(): CharacteristicValue {
    if (!this.device || !this.supportsFanSpeed) {
      return false;
    }

    return this.device.params[AC_FAN_SPEED] === AuxFanSpeed.AUTO;
  }

  private async handleSwingModeSet(value: CharacteristicValue): Promise<void> {
    if (!this.device || (!this.supportsSwingHorizontal && !this.supportsSwingVertical)) {
      return;
    }

    const enabled = Number(value) === this.platform.Characteristic.SwingMode.SWING_ENABLED;
    const payload: Record<string, number> = {};

    // Aplicar estado optimista inmediatamente
    this.device.params = this.device.params ?? {};
    if (this.supportsSwingVertical) {
      this.device.params[AC_SWING_VERTICAL] = enabled ? 0 : 1; // 0 = oscilar, 1 = fijo
      Object.assign(payload, enabled ? { ...AC_SWING_VERTICAL_ON } : { ...AC_SWING_VERTICAL_OFF });
    }
    if (this.supportsSwingHorizontal) {
      this.device.params[AC_SWING_HORIZONTAL] = enabled ? 0 : 1; // 0 = oscilar, 1 = fijo
      Object.assign(payload, enabled ? { ...AC_SWING_HORIZONTAL_ON } : { ...AC_SWING_HORIZONTAL_OFF });
    }
    this.platform.updateCachedDevice(this.device);
    this.updateCharacteristicsFromDevice();
    this.setFaulted(false);

    this.setupPendingGuard();
    this.platform.startDeviceCommand(this.device, payload);
  }

  private handleSwingModeGet(): CharacteristicValue {
    if (!this.device || (!this.supportsSwingHorizontal && !this.supportsSwingVertical)) {
      return this.platform.Characteristic.SwingMode.SWING_DISABLED;
    }

    const vertical = this.supportsSwingVertical ? this.device.params[AC_SWING_VERTICAL] === 0 : false;
    const horizontal = this.supportsSwingHorizontal ? this.device.params[AC_SWING_HORIZONTAL] === 0 : false;

    return (vertical || horizontal)
      ? this.platform.Characteristic.SwingMode.SWING_ENABLED
      : this.platform.Characteristic.SwingMode.SWING_DISABLED;
  }

  private async handleFeatureSwitchSet(feature: FeatureSwitchKey, enabled: boolean): Promise<void> {
    if (!this.device) {
      return;
    }

    const definition = FEATURE_SWITCH_CONFIG[feature];
    const payload = enabled ? definition.onPayload : definition.offPayload;

    // Aplicar estado optimista inmediatamente
    this.device.params = this.device.params ?? {};
    this.device.params[definition.param] = enabled ? 1 : 0;
    this.platform.updateCachedDevice(this.device);
    this.updateCharacteristicsFromDevice();
    this.setFaulted(false);

    this.platform.startDeviceCommand(this.device, payload);
  }

  private handleFeatureSwitchGet(feature: FeatureSwitchKey): CharacteristicValue {
    if (!this.device) {
      return false;
    }

    const definition = FEATURE_SWITCH_CONFIG[feature];
    return this.device.params[definition.param] === 1;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  private traceGet(characteristic: string, value: CharacteristicValue): CharacteristicValue {
    if (!this.device) {
      return value;
    }
    const context = this.platform.trace.createContext('hap.get', this.device, {
      service: 'HeaterCooler',
      characteristic,
      value,
    });
    this.platform.trace.emit('hap.get', context);
    return value;
  }

  private setServiceDisplayName(service: Service, label: string): void {
    // Cached HomeKit services retain Service.displayName independently from
    // their Name characteristic. Apple Home uses displayName for tile labels.
    service.displayName = label;
    service.updateCharacteristic(this.platform.Characteristic.Name, label);
  }

  private consumePendingPowerOn(): AuxTraceContext | undefined {
    if (!this.pendingPowerOnTimeout) {
      return undefined;
    }
    clearTimeout(this.pendingPowerOnTimeout);
    this.pendingPowerOnTimeout = undefined;
    const context = this.pendingPowerOnContext;
    this.pendingPowerOnContext = undefined;
    return context;
  }

  private getFanLevels(): FanSpeedLevel[] {
    return this.supportsComfortableWind
      ? FAN_SPEED_LEVELS
      : FAN_SPEED_LEVELS.filter((level) => !level.comfortableWind);
  }

  private getFanLevelFromPercent(percent: number): FanSpeedLevel {
    const levels = this.getFanLevels();
    let closest = levels[0] ?? FAN_SPEED_LEVELS[1]; // default to mute if empty
    let smallestDelta = Math.abs(percent - closest.percent);

    for (const level of levels) {
      const delta = Math.abs(percent - level.percent);
      if (delta < smallestDelta) {
        closest = level;
        smallestDelta = delta;
      }
    }

    return closest;
  }

  private getFanLevelForAuxSpeed(speed: AuxFanSpeed): FanSpeedLevel | undefined {
    const levels = this.getFanLevels();
    const manualMatch = levels.find((level) => level.aux === speed && !level.comfortableWind);
    if (manualMatch) {
      return manualMatch;
    }
    return levels.find((level) => level.aux === speed);
  }

  private setPendingModeTimeout(
    auxMode: AuxAcModeValue,
    payload: Record<string, number>,
  ): void {
    if (this.pendingModeTimeout) {
      clearTimeout(this.pendingModeTimeout);
    }
    this.pendingModeTimeout = setTimeout(async () => {
      this.pendingModeTimeout = undefined;

      if (!this.device) {
        return;
      }

      if (this.pendingAuxMode !== auxMode) {
        return;
      }

      const currentMode = this.device.params?.[AUX_MODE];
      if (typeof currentMode === 'number' && currentMode === auxMode) {
        this.pendingAuxMode = undefined;
        return;
      }

      // Reintentar comando de modo
      this.platform.startDeviceCommand(this.device, payload);
    }, MODE_RETRY_DELAY_MS);
  }

  private async setAuxMode(auxMode: AuxAcModeValue, ensurePowerOn = true): Promise<void> {
    if (!this.device) {
      return;
    }

    if (this.pendingModeTimeout) {
      clearTimeout(this.pendingModeTimeout);
      this.pendingModeTimeout = undefined;
    }

    const supportsSpecialModeParam =
      AuxProducts.getSpecialParamsList(this.device.productId)?.includes(AC_MODE_SPECIAL);
    const shouldSendSpecialModeParam =
      supportsSpecialModeParam || typeof this.device.params?.[AC_MODE_SPECIAL] === 'number';

    this.pendingAuxMode = auxMode;

    const shouldPowerOn = ensurePowerOn && !this.isDevicePowered();
    if (shouldPowerOn) {
      try {
        await this.platform.sendDeviceParamsWithRetry(this.device, AC_POWER_ON);

        this.device.params = this.device.params ?? {};
        this.device.params[AC_POWER] = 1;
        this.device.state = 1;

        await delay(400);
      } catch (error) {
        this.pendingAuxMode = undefined;
        throw error;
      }
    }

    const payload: Record<string, number> = {
      [AUX_MODE]: auxMode,
    };

    if (shouldSendSpecialModeParam) {
      payload[AC_MODE_SPECIAL] = auxMode;
    }
    try {
      await this.platform.sendDeviceParamsWithRetry(this.device, payload);
    } catch (error) {
      this.pendingAuxMode = undefined;
      throw error;
    }

    this.pendingModeTimeout = setTimeout(async () => {
      this.pendingModeTimeout = undefined;

      if (!this.device) {
        return;
      }

      if (this.pendingAuxMode !== auxMode) {
        return;
      }

      const currentMode = this.device.params?.[AUX_MODE];
      if (typeof currentMode === 'number' && currentMode === auxMode) {
        this.pendingAuxMode = undefined;
        return;
      }

      try {
        await this.platform.sendDeviceParamsWithRetry(this.device, payload);
      } catch (error) {
        this.handleCommandError('retry set mode', error);
      }
    }, MODE_RETRY_DELAY_MS);
  }

  private getAuxMode(): AuxAcModeValue | undefined {
    if (!this.device) {
      return undefined;
    }

    const raw = this.device.params?.[AUX_MODE];
    if (typeof raw === 'number') {
      return raw as AuxAcModeValue;
    }

    const special = this.device.params?.[AC_MODE_SPECIAL];
    if (typeof special === 'number') {
      return special as AuxAcModeValue;
    }

    return undefined;
  }

  private isDevicePowered(): boolean {
    if (!this.device) {
      return false;
    }

    const powerParam = this.device.params?.[AC_POWER];
    if (powerParam === 1) {
      return true;
    }
    if (powerParam === 0) {
      return false;
    }

    return this.device.state === 1;
  }

  private mapTargetStateToAuxMode(value: number): number {
    const { TargetHeaterCoolerState } = this.platform.Characteristic;
    switch (value) {
      case TargetHeaterCoolerState.COOL:
        return AuxAcModeValue.COOLING;
      case TargetHeaterCoolerState.HEAT:
        return AuxAcModeValue.HEATING;
      case TargetHeaterCoolerState.AUTO:
      default:
        return AuxAcModeValue.AUTO;
    }
  }

  private mapAuxModeToTargetState(auxMode?: number): number {
    const { TargetHeaterCoolerState } = this.platform.Characteristic;
    switch (auxMode) {
      case AuxAcModeValue.COOLING:
        return TargetHeaterCoolerState.COOL;
      case AuxAcModeValue.HEATING:
        return TargetHeaterCoolerState.HEAT;
      default:
        return TargetHeaterCoolerState.AUTO;
    }
  }

  private getDisplayMinTarget(): number {
    return this.roundToStep(celsiusToDisplay(MIN_TARGET_TEMPERATURE_C, this.temperatureUnit));
  }

  private getDisplayMaxTarget(): number {
    return this.roundToStep(celsiusToDisplay(MAX_TARGET_TEMPERATURE_C, this.temperatureUnit));
  }

  private getCelsiusParam(key: string): number | undefined {
    if (!this.device) {
      return undefined;
    }

    const raw = this.device.params[key];
    if (typeof raw !== 'number') {
      return undefined;
    }

    return raw / 10;
  }

  private clampDisplayTemperature(value: number): number {
    const clampedValue = clamp(value, this.getDisplayMinTarget(), this.getDisplayMaxTarget());
    return this.roundToStep(clampedValue);
  }

  private roundToStep(value: number): number {
    const precision = 1 / this.temperatureStep;
    return Math.round(value * precision) / precision;
  }

  private findCharacteristic(uuid: string): Characteristic | undefined {
    return this.service.characteristics.find((char) => char.UUID === uuid);
  }

  private getContext(): AuxCloudAccessoryContext {
    return this.accessory.context as AuxCloudAccessoryContext;
  }

  private setFaulted(faulted: boolean): void {
    if (this.hasFault === faulted) {
      return;
    }

    this.hasFault = faulted;
    const value = faulted
      ? this.platform.Characteristic.StatusFault.GENERAL_FAULT
      : this.platform.Characteristic.StatusFault.NO_FAULT;
    this.service.updateCharacteristic(this.platform.Characteristic.StatusFault, value);
  }


  private updateCharacteristicsFromDevice(): void {
    if (!this.device) {
      return;
    }

    const traceContext = this.platform.trace.createContext('state.sync', this.device, {
      service: 'HeaterCooler',
    });
    this.platform.trace.emit('hap.sync', traceContext);

    const auxMode = this.getAuxMode();

    this.service.updateCharacteristic(this.platform.Characteristic.Active, this.handleActiveGet());
    this.service.updateCharacteristic(
      this.platform.Characteristic.TargetHeaterCoolerState,
      this.handleTargetStateGet(),
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentHeaterCoolerState,
      this.handleCurrentHeaterCoolerStateGet(),
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.CurrentTemperature,
      this.handleCurrentTemperatureGet(),
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.HeatingThresholdTemperature,
      this.handleTargetTemperatureGet(),
    );
    this.service.updateCharacteristic(
      this.platform.Characteristic.CoolingThresholdTemperature,
      this.handleTargetTemperatureGet(),
    );

    if (this.supportsFanSpeed) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.RotationSpeed,
        this.handleRotationSpeedGet(),
      );
      if (this.fanAutoService) {
        this.fanAutoService.updateCharacteristic(
          this.platform.Characteristic.On,
          this.handleFanAutoGet(),
        );
      }
    }

    if (this.supportsSwingHorizontal || this.supportsSwingVertical) {
      this.service.updateCharacteristic(
        this.platform.Characteristic.SwingMode,
        this.handleSwingModeGet(),
      );
    }

    for (const [mode, service] of this.modeSwitchServices.entries()) {
      const shouldEnable =
        (mode === 'dry' && auxMode === AuxAcModeValue.DRY)
        || (mode === 'fan' && auxMode === AuxAcModeValue.FAN);
      service.updateCharacteristic(this.platform.Characteristic.On, shouldEnable);
    }

    for (const [feature, service] of this.featureSwitchServices.entries()) {
      service.updateCharacteristic(
        this.platform.Characteristic.On,
        this.handleFeatureSwitchGet(feature),
      );
    }

    this.setFaulted(false);
  }

  private handleCommandError(context: string, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    this.platform.log.warn(
      'Failed to %s for %s: %s',
      context,
      this.accessory.displayName,
      message,
    );
    this.setFaulted(true);

    const HapStatusError = this.platform.api.hap.HapStatusError;
    throw new HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
