import { describe, it, expect } from 'vitest';
import { createECDH } from 'node:crypto';
import { readVapidConfig } from './config';

const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
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
});
