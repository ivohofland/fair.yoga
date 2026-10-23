import { describe, it, expect } from 'vitest';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { sealToken, openToken, TokenCipherError, TOKEN_CIPHER_VERSION } from './processor-token-cipher';

const key = randomBytes(32);

describe('processor token cipher', () => {
  it('round-trips a token', () => {
    expect(openToken(sealToken('access_abc', key), key)).toBe('access_abc');
  });
  it('writes the version byte first and a fresh IV each time', () => {
    const a = sealToken('same', key);
    const b = sealToken('same', key);
    expect(a[0]).toBe(TOKEN_CIPHER_VERSION);
    expect(a.equals(b)).toBe(false);
  });
  it('refuses a tampered ciphertext', () => {
    const sealed = sealToken('access_abc', key);
    const last = sealed.length - 1;
    sealed[last] = (sealed[last] ?? 0) ^ 0x01;
    expect(() => openToken(sealed, key)).toThrow(TokenCipherError);
  });
  it('refuses a tampered auth tag', () => {
    const sealed = sealToken('access_abc', key);
    // version (1) + iv (12), so index 13 is the first tag byte
    sealed[13] = (sealed[13] ?? 0) ^ 0x01;
    expect(() => openToken(sealed, key)).toThrow(TokenCipherError);
  });
  it('refuses the wrong key', () => {
    expect(() => openToken(sealToken('access_abc', key), randomBytes(32))).toThrow(TokenCipherError);
  });
  it('refuses an unknown version', () => {
    const sealed = sealToken('access_abc', key);
    sealed[0] = 2;
    expect(() => openToken(sealed, key)).toThrow(/version 2/);
  });
  it('refuses a key that is not 32 bytes', () => {
    expect(() => sealToken('x', randomBytes(16))).toThrow(TokenCipherError);
  });
  it('refuses to open with a key that is not 32 bytes', () => {
    expect(() => openToken(sealToken('x', key), randomBytes(16))).toThrow(TokenCipherError);
  });
  it('refuses a truncated value', () => {
    expect(() => openToken(Buffer.from([TOKEN_CIPHER_VERSION, 1, 2]), key)).toThrow(TokenCipherError);
  });
  it('refuses a version-1 blob sealed without the version byte as AAD', () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update('access_abc', 'utf8'), cipher.final()]);
    const blob = Buffer.concat([Buffer.from([TOKEN_CIPHER_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
    expect(() => openToken(blob, key)).toThrow(TokenCipherError);
  });
  it('seals with the version byte as AAD, so a raw open that sets none fails', () => {
    const sealed = sealToken('access_abc', key);
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 13));
    decipher.setAuthTag(sealed.subarray(13, 29));
    decipher.update(sealed.subarray(29));
    expect(() => decipher.final()).toThrow();
  });
});
