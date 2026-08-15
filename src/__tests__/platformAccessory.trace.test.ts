import type { Logger } from 'homebridge';

import type { AuxDevice } from '../api/AuxCloudClient';
import { AuxTrace, type AuxTraceContext } from '../api/trace/AuxTrace';
import { AuxCloudPlatformAccessory } from '../platformAccessory';

type AccessoryPrivate = {
  handleActiveSet: (value: number) => Promise<void>;
  handleTargetStateSet: (value: number) => Promise<void>;
  updateCharacteristicsFromDevice: () => void;
  traceGet: (characteristic: string, value: number | boolean) => number | boolean;
  setServiceDisplayName: (service: { displayName: string; updateCharacteristic: jest.Mock }, label: string) => void;
  getOrCreateNamedSwitch: (label: string, subtype: string, legacySubtypes: readonly string[]) => unknown;
};

function makeDevice(): AuxDevice {
  return {
    endpointId: 'bedroom-endpoint',
    friendlyName: 'Bedroom',
    productId: 'ac',
    devSession: '',
    devicetypeFlag: 1,
    cookie: '',
    params: { pwr: 0, mode: 1, temp: 240, envtemp: 250 },
    state: 0,
  };
}

function makeTrace() {
  const records: Array<Record<string, unknown>> = [];
  const logger = {
    debug: jest.fn(),
    info: (_format: string, record: string) => records.push(JSON.parse(record)),
  } as unknown as Logger;
  return { trace: new AuxTrace(logger, true), records };
}

describe('AuxCloudPlatformAccessory command tracing', () => {
  test('carries one correlation from a HomeKit Active SET into command start', async () => {
    jest.useFakeTimers();
    const { trace, records } = makeTrace();
    const device = makeDevice();
    const startDeviceCommand = jest.fn((
      _device: AuxDevice,
      _params: Record<string, number>,
      _retryCount: number | undefined,
      context: AuxTraceContext,
    ) => trace.emit('command.start', context));
    const instance = Object.assign(Object.create(AuxCloudPlatformAccessory.prototype), {
      device,
      platform: {
        trace,
        Characteristic: { Active: { ACTIVE: 1, INACTIVE: 0 } },
        commandTimeoutMs: 5000,
        commandRetryCount: 2,
        updateCachedDevice: jest.fn(),
        registerPendingCommandWithState: jest.fn(() => 1),
        schedulePendingCommandCompletion: jest.fn(),
        startDeviceCommand,
      },
      updateCharacteristicsFromDevice: jest.fn(),
      setFaulted: jest.fn(),
    });

    await (AuxCloudPlatformAccessory.prototype as unknown as AccessoryPrivate)
      .handleActiveSet.call(instance, 1);
    expect(records.map(({ event }) => event)).toEqual(['hap.set']);
    jest.runOnlyPendingTimers();

    expect(records.map(({ event }) => event)).toEqual(['hap.set', 'command.start']);
    expect(records[0]).toMatchObject({
      source: 'hap.set',
      service: 'HeaterCooler',
      characteristic: 'Active',
      oldValue: 0,
      newValue: 1,
    });
    expect(records[1].correlationId).toBe(records[0].correlationId);
    expect(records[1].device).toBe(records[0].device);
    expect(startDeviceCommand).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('labels cached state synchronization without dispatching a command', () => {
    const { trace, records } = makeTrace();
    const service = { updateCharacteristic: jest.fn() };
    const startDeviceCommand = jest.fn();
    const instance = Object.assign(Object.create(AuxCloudPlatformAccessory.prototype), {
      device: makeDevice(),
      platform: {
        trace,
        Characteristic: {
          Active: {}, TargetHeaterCoolerState: {}, CurrentHeaterCoolerState: {},
          CurrentTemperature: {}, HeatingThresholdTemperature: {}, CoolingThresholdTemperature: {},
          RotationSpeed: {}, On: {}, SwingMode: {}, StatusFault: { NO_FAULT: 0, GENERAL_FAULT: 1 },
        },
        startDeviceCommand,
      },
      service,
      supportsFanSpeed: false,
      supportsSwingHorizontal: false,
      supportsSwingVertical: false,
      modeSwitchServices: new Map(),
      featureSwitchServices: new Map(),
      getAuxMode: jest.fn(() => 1),
      handleActiveGet: jest.fn(() => 0),
      handleTargetStateGet: jest.fn(() => 0),
      handleCurrentHeaterCoolerStateGet: jest.fn(() => 0),
      handleCurrentTemperatureGet: jest.fn(() => 25),
      handleTargetTemperatureGet: jest.fn(() => 24),
      setFaulted: jest.fn(),
    });

    (AuxCloudPlatformAccessory.prototype as unknown as AccessoryPrivate)
      .updateCharacteristicsFromDevice.call(instance);

    expect(records.map(({ event }) => event)).toEqual(['hap.sync']);
    expect(startDeviceCommand).not.toHaveBeenCalled();
  });

  test('records a HomeKit GET and returns its value unchanged', () => {
    const { trace, records } = makeTrace();
    const instance = Object.assign(Object.create(AuxCloudPlatformAccessory.prototype), {
      device: makeDevice(),
      platform: { trace },
    });

    const value = (AuxCloudPlatformAccessory.prototype as unknown as AccessoryPrivate)
      .traceGet.call(instance, 'CurrentTemperature', 25);

    expect(value).toBe(25);
    expect(records).toEqual([expect.objectContaining({
      event: 'hap.get',
      source: 'hap.get',
      service: 'HeaterCooler',
      characteristic: 'CurrentTemperature',
      value: 25,
    })]);
  });

  test('updates the cached service display name as well as its Name characteristic', () => {
    const service = { displayName: 'Guest AC', updateCharacteristic: jest.fn() };
    const nameCharacteristic = {};
    const instance = Object.assign(Object.create(AuxCloudPlatformAccessory.prototype), {
      platform: { Characteristic: { Name: nameCharacteristic } },
    });

    (AuxCloudPlatformAccessory.prototype as unknown as AccessoryPrivate)
      .setServiceDisplayName.call(instance, service, 'Fan Mode');

    expect(service.displayName).toBe('Fan Mode');
    expect(service.updateCharacteristic).toHaveBeenCalledWith(nameCharacteristic, 'Fan Mode');
  });

  test('replaces a legacy switch identity so Apple Home imports the corrected label', () => {
    const legacy = { displayName: 'Guest AC' };
    const replacement = { displayName: 'Auto Fan', updateCharacteristic: jest.fn() };
    const getServiceById = jest.fn((_type, subtype: string) => subtype === 'fanAuto' ? legacy : undefined);
    const removeService = jest.fn();
    const addService = jest.fn(() => replacement);
    const accessory = { getServiceById, removeService, addService };
    const updatePlatformAccessories = jest.fn();
    const instance = Object.assign(Object.create(AuxCloudPlatformAccessory.prototype), {
      accessory,
      platform: {
        api: { updatePlatformAccessories },
        Service: { Switch: {} },
        Characteristic: { Name: {} },
      },
    });

    const service = (AuxCloudPlatformAccessory.prototype as unknown as AccessoryPrivate)
      .getOrCreateNamedSwitch.call(instance, 'Auto Fan', 'fanAuto-v2', ['fanAuto']);

    expect(removeService).toHaveBeenCalledWith(legacy);
    expect(addService).toHaveBeenCalledWith({}, 'Auto Fan', 'fanAuto-v2');
    expect(updatePlatformAccessories).toHaveBeenCalledWith([accessory]);
    expect(service).toBe(replacement);
  });

  test('combines HomeKit power-on and cooling callbacks into one device command', async () => {
    jest.useFakeTimers();
    const { trace } = makeTrace();
    const device = makeDevice();
    device.params = { pwr: 0, ac_mode: 4 };
    device.state = 0;
    const startDeviceCommand = jest.fn();
    const instance = Object.assign(Object.create(AuxCloudPlatformAccessory.prototype), {
      device,
      platform: {
        trace,
        Characteristic: {
          Active: { ACTIVE: 1, INACTIVE: 0 },
          TargetHeaterCoolerState: { AUTO: 0, COOL: 2, HEAT: 1 },
        },
        commandTimeoutMs: 5000,
        commandRetryCount: 2,
        updateCachedDevice: jest.fn(),
        registerPendingCommandWithState: jest.fn(() => 1),
        schedulePendingCommandCompletion: jest.fn(),
        startDeviceCommand,
      },
      updateCharacteristicsFromDevice: jest.fn(),
      setFaulted: jest.fn(),
    });

    await (AuxCloudPlatformAccessory.prototype as unknown as AccessoryPrivate)
      .handleActiveSet.call(instance, 1);
    await (AuxCloudPlatformAccessory.prototype as unknown as AccessoryPrivate)
      .handleTargetStateSet.call(instance, 2);

    expect(startDeviceCommand).toHaveBeenCalledTimes(1);
    expect(startDeviceCommand.mock.calls[0][1]).toEqual({ pwr: 1, ac_mode: 0 });
    jest.runAllTimers();
    jest.useRealTimers();
  });
});
