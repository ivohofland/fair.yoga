import { describe, it, expect } from 'vitest';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { vapidAuthorization } from './vapid';

function keypair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: ecdh.getPrivateKey().toString('base64url') };
}

describe('vapidAuthorization (RFC 8292)', () => {
  const keys = { ...keypair(), subject: 'mailto:ops@fair.yoga' };
  const now = new Date('2026-10-02T12:00:00Z');
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, now);
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];

  it('carries the public key', () => {
    expect(k).toBe(keys.publicKey);
  });

  it('claims the endpoint origin, a 12-hour expiry and the subject', () => {
    const claims = JSON.parse(Buffer.from(jwt!.split('.')[1]!, 'base64url').toString());
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Math.floor(now.getTime() / 1000) + 12 * 60 * 60,
      sub: 'mailto:ops@fair.yoga',
    });
  });

  it('is an ES256 signature that verifies against the public key', () => {
    const [h, p, s] = jwt!.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
    const pub = Buffer.from(keys.publicKey, 'base64url');
    const key = createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
      format: 'jwk',
    });
    expect(verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'))).toBe(true);
  });
});
