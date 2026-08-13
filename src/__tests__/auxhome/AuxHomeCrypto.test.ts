import {
  constants,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
} from 'crypto';

import {
  AUX_HOME_ACCOUNT_ENCRYPTION_KEY,
  encryptAuxHomeAccount,
  encryptAuxHomePassword,
} from '../../api/auxhome/AuxHomeCrypto';

describe('AUX Home login crypto', () => {
  it('encrypts a UTF-8 account with the compatibility AES key', () => {
    const account = 'synthetic.account@example.test';
    const decipher = createDecipheriv('aes-128-ecb', AUX_HOME_ACCOUNT_ENCRYPTION_KEY, null);
    const encrypted = Buffer.from(encryptAuxHomeAccount(account), 'base64');

    expect(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')).toBe(account);
  });

  it('uses the verified AUX Home 2.3.2 compatibility key', () => {
    expect(encryptAuxHomeAccount('vector.account@example.test'))
      .toBe('d7dgAW3UReBN1/jKP1XvG/8ZFwTGtmsTpxsptxj4Rpc=');
  });

  it('encrypts long UTF-8 passwords as RSA PKCS#1 blocks', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
    const password = 'synthetic-password-'.repeat(12);
    const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const encrypted = Buffer.from(encryptAuxHomePassword(password, publicKeyBase64), 'base64');
    const decrypted = Buffer.concat(
      Array.from({ length: encrypted.length / 128 }, (_, index) => privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_PADDING },
        encrypted.subarray(index * 128, (index + 1) * 128),
      )),
    );

    expect(encrypted).toHaveLength(256);
    expect(decrypted).toEqual(Buffer.from(password, 'utf8'));
  });
});
