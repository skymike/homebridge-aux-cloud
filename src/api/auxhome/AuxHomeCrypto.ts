import { constants, createCipheriv, publicEncrypt } from 'crypto';

/** Compatibility key used by the AUX Home 2.3.2 account field encryption. */
export const AUX_HOME_ACCOUNT_ENCRYPTION_KEY = Buffer.from('4083aux63e3444a2', 'utf8');

export function encryptAuxHomeAccount(account: string): string {
  const cipher = createCipheriv('aes-128-ecb', AUX_HOME_ACCOUNT_ENCRYPTION_KEY, null);
  return Buffer.concat([cipher.update(account, 'utf8'), cipher.final()]).toString('base64');
}

export function encryptAuxHomePassword(password: string, x509PublicKeyBase64: string): string {
  const der = Buffer.from(x509PublicKeyBase64, 'base64');
  const publicKey = `-----BEGIN PUBLIC KEY-----\n${der.toString('base64')}\n-----END PUBLIC KEY-----`;
  const plaintext = Buffer.from(password, 'utf8');
  const blocks: Buffer[] = [];

  for (let offset = 0; offset < plaintext.length; offset += 117) {
    blocks.push(publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      plaintext.subarray(offset, offset + 117),
    ));
  }

  return Buffer.concat(blocks).toString('base64');
}
