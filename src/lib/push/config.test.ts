import { describe, it, expect } from 'vitest';
import { createECDH } from 'node:crypto';
import { readVapidConfig } from './config';

function generatedPair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return ecdh;
}

const ecdh = generatedPair();
const good = {
  VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'),
  VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString('base64url'),
  VAPID_SUBJECT: 'mailto:ops@fair.yoga',
};

describe('readVapidConfig', () => {
  it('returns the keys when all three are set and well-formed', () => {
    expect(readVapidConfig(good)).toEqual({ publicKey: good.VAPID_PUBLIC_KEY, privateKey: good.VAPID_PRIVATE_KEY, subject: good.VAPID_SUBJECT });
  });

  it.each(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const)('is null without %s', (name) => {
    expect(readVapidConfig({ ...good, [name]: undefined })).toBeNull();
  });

  it('is null for a public key of the wrong length or a subject that is not mailto:/https:', () => {
    expect(readVapidConfig({ ...good, VAPID_PUBLIC_KEY: 'AAAA' })).toBeNull();
    expect(readVapidConfig({ ...good, VAPID_SUBJECT: 'ops@fair.yoga' })).toBeNull();
  });

  it('returns the keys for a public key derived from the private key', () => {
    const pair = generatedPair();
    const env = {
      ...good,
      VAPID_PUBLIC_KEY: pair.getPublicKey().toString('base64url'),
      VAPID_PRIVATE_KEY: pair.getPrivateKey().toString('base64url'),
    };
    expect(readVapidConfig(env)).toEqual({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: good.VAPID_SUBJECT });
  });

  it('is null for a valid public key that belongs to a different private key', () => {
    const other = generatedPair();
    expect(readVapidConfig({ ...good, VAPID_PUBLIC_KEY: other.getPublicKey().toString('base64url') })).toBeNull();
  });

  it('is null for a 65-byte public key that is not a point on the curve', () => {
    expect(readVapidConfig({ ...good, VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url') })).toBeNull();
  });

  it('is null for a 32-byte private key that is not a valid scalar', () => {
    expect(readVapidConfig({ ...good, VAPID_PRIVATE_KEY: Buffer.alloc(32, 0).toString('base64url') })).toBeNull();
  });
});
