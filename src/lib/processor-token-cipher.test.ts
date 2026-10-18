import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
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
  it('refuses a truncated value', () => {
    expect(() => openToken(Buffer.from([TOKEN_CIPHER_VERSION, 1, 2]), key)).toThrow(TokenCipherError);
  });
});
