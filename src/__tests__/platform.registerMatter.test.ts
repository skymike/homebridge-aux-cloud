import { AuxCloudMatterPlatform } from '../Platform.Matter';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings';

function callRegisterMatterInternal(
  context: { log: unknown; api: unknown },
  accessories: unknown[],
  deviceName: string,
): Promise<void> {
  const method = (AuxCloudMatterPlatform.prototype as unknown as Record<string, (...args: unknown[]) => Promise<void>>)['registerMatterAccessoriesInternal'];
  return method.call(context, accessories, deviceName) as Promise<void>;
}

function makeContext(opts: {
  unregisterPlatformAccessories?: jest.Mock;
  registerPlatformAccessories?: jest.Mock;
} = {}) {
  return {
    log: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
    api: {
      matter: {
        unregisterPlatformAccessories: opts.unregisterPlatformAccessories ?? jest.fn().mockResolvedValue(undefined),
        registerPlatformAccessories: opts.registerPlatformAccessories ?? jest.fn().mockResolvedValue(undefined),
       },
     },
   };
}

describe('AuxCloudPlatform.registerMatterAccessoriesInternal', () => {
  test('unregisters then registers each accessory', async () => {
    const mockUnregister = jest.fn().mockResolvedValue(undefined);
    const mockRegister = jest.fn().mockResolvedValue(undefined);

    const ctx = makeContext({
      unregisterPlatformAccessories: mockUnregister,
      registerPlatformAccessories: mockRegister,
    });
    await callRegisterMatterInternal(ctx, [{ UUID: 'test-uuid', handlers: {}, parts: [] }], 'Aire Sala');

    expect(mockUnregister).toHaveBeenCalledTimes(1);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    expect(mockUnregister).toHaveBeenCalledWith(PLUGIN_NAME, PLATFORM_NAME, [{ UUID: 'test-uuid', handlers: {}, parts: [] }]);
  });

  test('unregister errors are silently ignored', async () => {
    const mockUnregister = jest.fn().mockRejectedValue(new Error('[identity-conflict] already defined'));
    const mockRegister = jest.fn().mockResolvedValue(undefined);

    const ctx = makeContext({
      unregisterPlatformAccessories: mockUnregister,
      registerPlatformAccessories: mockRegister,
    });

     // Should not throw — unregister errors are expected when accessory doesn't exist in Matter
    await expect(
      callRegisterMatterInternal(ctx, [{ UUID: 'test-uuid' }], 'Aire Sala'),
     ).resolves.not.toThrow();

    expect(mockRegister).toHaveBeenCalledTimes(1);
   });

  test('register errors propagate', async () => {
    const mockUnregister = jest.fn().mockResolvedValue(undefined);
    const mockRegister = jest.fn().mockRejectedValue(new Error('[enum-value-conformance] conformance error'));

    const ctx = makeContext({
      unregisterPlatformAccessories: mockUnregister,
      registerPlatformAccessories: mockRegister,
     });

    await expect(
      callRegisterMatterInternal(ctx, [{ UUID: 'test-uuid' }], 'Aire Sala'),
     ).rejects.toThrow('conformance error');
   });

  test('logs info on successful registration', async () => {
    const mockRegister = jest.fn().mockResolvedValue(undefined);
    const ctx = makeContext({ registerPlatformAccessories: mockRegister });

    await callRegisterMatterInternal(ctx, [{ UUID: 'test-uuid' }], 'Aire Sala');

    expect(ctx.log.info).toHaveBeenCalledWith('[Matter] "%s" registered fresh (UUID: %s)', 'Aire Sala', 'test-uuid');
   });

  test('processes multiple accessories independently', async () => {
    const mockUnregister = jest.fn().mockResolvedValue(undefined);
    const mockRegister = jest.fn().mockResolvedValue(undefined);

    const ctx = makeContext({
      unregisterPlatformAccessories: mockUnregister,
      registerPlatformAccessories: mockRegister,
     });

    await callRegisterMatterInternal(
      ctx,
       [{ UUID: 'uuid-1' }, { UUID: 'uuid-2' }],
       'Multi-Device',
     );

    expect(mockUnregister).toHaveBeenCalledTimes(2);
    expect(mockRegister).toHaveBeenCalledTimes(2);
    expect(mockUnregister).toHaveBeenNthCalledWith(1, PLUGIN_NAME, PLATFORM_NAME, [{ UUID: 'uuid-1' }]);
    expect(mockUnregister).toHaveBeenNthCalledWith(2, PLUGIN_NAME, PLATFORM_NAME, [{ UUID: 'uuid-2' }]);
   });
});
