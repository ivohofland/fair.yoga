import 'server-only';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** The first byte of every sealed token; a new key gets a new version. */
export const TOKEN_CIPHER_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export class TokenCipherError extends Error {}

/** AES-256-GCM, laid out `[version][iv][tag][ciphertext]`; the version byte is authenticated. */
export function sealToken(plaintext: string, key: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new TokenCipherError(`token key must be ${KEY_BYTES} bytes`);
  const version = Buffer.from([TOKEN_CIPHER_VERSION]);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(version);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([version, iv, cipher.getAuthTag(), ciphertext]);
}

export function openToken(sealed: Uint8Array, key: Buffer): string {
  const buf = Buffer.from(sealed);
  if (buf.length < 1 + IV_BYTES + TAG_BYTES) throw new TokenCipherError('sealed token is too short');
  const version = buf[0];
  if (version !== TOKEN_CIPHER_VERSION) throw new TokenCipherError(`unknown token cipher version ${String(version)}`);
  const iv = buf.subarray(1, 1 + IV_BYTES);
  const tag = buf.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(buf.subarray(0, 1));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new TokenCipherError('sealed token failed authentication', { cause: err });
  }
}
