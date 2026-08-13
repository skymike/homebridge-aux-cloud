import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { AcFreedomProvider } from '../../api/providers/AcFreedomProvider';
import { createProvider } from '../../api/providers/createProvider';

interface ConfigSchema {
  schema: {
    allOf?: Array<{
      if?: { properties?: Record<string, { const?: string }> };
      then?: {
        properties?: Record<string, { const?: string; description?: string }>;
        required?: string[];
      };
    }>;
    properties: Record<string, {
      default?: string;
      description?: string;
      enum?: string[];
    }>;
  };
}

const configSchema = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config.schema.json'), 'utf8'),
) as ConfigSchema;

describe('createProvider', () => {
  it('keeps AC Freedom as the default provider when provider is omitted', () => {
    expect(createProvider({ region: 'eu' })).toBeInstanceOf(AcFreedomProvider);
  });

  it('publishes the AUX Home opt-in schema and EU-only credential guidance', () => {
    const properties = configSchema.schema.properties;
    const auxHomeCondition = configSchema.schema.allOf?.find((condition) => (
      condition.if?.properties?.provider?.const === 'aux-home'
    ));

    expect(properties.provider.default).toBe('ac-freedom');
    expect(properties.provider.enum).toEqual(['ac-freedom', 'aux-home']);
    expect(properties.provider.description).toContain('experimental');
    expect(properties.provider.description).toContain('EU');
    expect(auxHomeCondition?.then?.properties?.region?.const).toBe('eu');
    expect(auxHomeCondition?.then?.required).toEqual(expect.arrayContaining(['username', 'password']));
  });

  it('rejects an unverified AUX Home region', () => {
    expect(() => createProvider({ provider: 'aux-home', region: 'usa' }))
      .toThrow('AUX Home currently supports the EU region only');
  });
});
