import { generateKeyPairSync } from 'crypto';

import { AuxHomeRestClient } from '../../api/auxhome/AuxHomeRestClient';

interface RequestConfig {
  method: string;
  url: string;
  headers?: Record<string, string>;
  data?: unknown;
}

function makePublicKeyBase64(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
}

describe('AuxHomeRestClient', () => {
  it('authenticates, discovers valid devices, and filters normalized endpoint IDs', async () => {
    const requests: RequestConfig[] = [];
    const publicKeyBase64 = makePublicKeyBase64();
    const transport = {
      request: jest.fn(async (request: RequestConfig) => {
        requests.push(request);
        if (request.url === '/auth/getPubkey') {
          return { data: { code: 0, message: 'ok', data: { publicKey: publicKeyBase64 } } };
        }
        if (request.url === '/auth/login/pwd') {
          return {
            data: {
              code: 0,
              message: 'ok',
              data: { appUser: { uid: 'test-user' }, token: { token: 'test-session-credential' } },
            },
          };
        }
        return {
          data: {
            code: 0,
            message: 'ok',
            data: [
              {
                deviceId: 'test-legacy-id', did: 'test-device-one', alias: 'Test unit one',
                mac: '02:00:00:00:00:01', modelId: 'test-model', password: 'test-device-password',
                passCode: 'test-passcode', productKey: 'test-product-key', online: true,
                status: { pwr: 1 }, feature: { eco: true },
              },
              { deviceId: 'test-invalid-record', alias: 'Not a device' },
            ],
          },
        };
      }),
    };
    const client = new AuxHomeRestClient({ transport, now: () => 1710000000000 });

    await expect(client.login('synthetic.account@example.test', 'synthetic-password')).resolves.toEqual({
      uid: 'test-user', token: 'test-session-credential',
    });
    await expect(client.listDevices({ includeIds: new Set(['test-device-one']) })).resolves.toEqual([
      expect.objectContaining({
        endpointId: 'test-device-one', deviceId: 'test-legacy-id', did: 'test-device-one',
        password: 'test-device-password', passCode: 'test-passcode', online: true,
      }),
    ]);

    expect(requests.map(({ method, url }) => [method, url])).toEqual([
      ['GET', '/auth/getPubkey'],
      ['POST', '/auth/login/pwd'],
      ['GET', '/user_device?getStatus=true'],
    ]);
    expect(requests[1]).toMatchObject({
      data: expect.objectContaining({ publicKeyBase64, ts: 1710000000000 }),
      headers: expect.objectContaining({ aid: '1', appversion: '2.3.2', os: 'Android', osversion: '12' }),
    });
    expect((requests[1].data as Record<string, string>)['account']).not.toBe('synthetic.account@example.test');
    expect((requests[1].data as Record<string, string>)['password']).not.toBe('synthetic-password');
    expect(requests[2].headers?.['authorization']).toBe('bearer test-session-credential');
  });

  it('redacts authentication failures', async () => {
    const transport = {
      request: jest.fn(async (request: RequestConfig) => {
        if (request.url === '/auth/getPubkey') {
          return { data: { code: 0, message: 'ok', data: { publicKey: makePublicKeyBase64() } } };
        }
        return { data: { code: 401, message: 'unauthorized', data: null } };
      }),
    };
    const client = new AuxHomeRestClient({ transport });

    await expect(client.login('sensitive-account-value', 'sensitive-password-value'))
      .rejects.toThrow('AUX Home request failed (401): request rejected');
    await expect(client.listDevices()).rejects.toThrow('AUX Home session is not authenticated');
  });

  it('clears a successful in-memory session before another authenticated operation', async () => {
    const requests: RequestConfig[] = [];
    const publicKeyBase64 = makePublicKeyBase64();
    const transport = {
      request: jest.fn(async (request: RequestConfig) => {
        requests.push(request);
        if (request.url === '/auth/getPubkey') {
          return { data: { code: 0, message: 'ok', data: { publicKey: publicKeyBase64 } } };
        }
        if (request.url === '/auth/login/pwd') {
          return {
            data: {
              code: 0,
              message: 'ok',
              data: { appUser: { uid: 'test-user' }, token: { token: 'test-session-credential' } },
            },
          };
        }
        return { data: { code: 0, message: 'ok', data: [] } };
      }),
    };
    const client = new AuxHomeRestClient({ transport });

    await client.login('synthetic.account@example.test', 'synthetic-password');
    await expect(client.listDevices()).resolves.toEqual([]);
    expect(requests[2].headers?.['authorization']).toBe('bearer test-session-credential');

    client.invalidateSession();

    await expect(client.listDevices()).rejects.toThrow('AUX Home session is not authenticated');
    expect(requests).toHaveLength(3);
  });
});
