import { AcFreedomProvider } from '../../api/providers/AcFreedomProvider';
import { createProvider } from '../../api/providers/createProvider';

describe('createProvider', () => {
  it('keeps AC Freedom as the default provider', () => {
    expect(createProvider({ region: 'eu' })).toBeInstanceOf(AcFreedomProvider);
  });

  it('rejects an unverified AUX Home region', () => {
    expect(() => createProvider({ provider: 'aux-home', region: 'usa' }))
      .toThrow('AUX Home currently supports the EU region only');
  });
});
