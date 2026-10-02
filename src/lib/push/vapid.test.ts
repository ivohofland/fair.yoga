import { describe, it, expect } from 'vitest';
import { createPublicKey, verify } from 'node:crypto';
import { vapidAuthorization } from './vapid';
import { readVapidConfig } from './config';
import { generateVapidKeyPair, generateUnpaddedVapidKeyPair } from './test-support';

function verifiesAgainst(header: string, publicKey: string): boolean {
  const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
  if (k !== publicKey) return false;
  const [h, p, s] = jwt!.split('.');
  const pub = Buffer.from(publicKey, 'base64url');
  const key = createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') },
    format: 'jwk',
  });
  return verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
}

describe('vapidAuthorization (RFC 8292)', () => {
  const keys = { ...generateVapidKeyPair(), subject: 'mailto:ops@fair.yoga' };
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

describe('vapidAuthorization with a padded leading-zero private key', () => {
  it('signs a JWT that verifies against the public key, for keys read through `readVapidConfig`', () => {
    const unpadded = generateUnpaddedVapidKeyPair();
    expect(Buffer.from(unpadded.privateKey, 'base64url').length).toBeLessThan(32);
    const keys = readVapidConfig({
      VAPID_PUBLIC_KEY: unpadded.publicKey,
      VAPID_PRIVATE_KEY: unpadded.privateKey,
      VAPID_SUBJECT: 'mailto:ops@fair.yoga',
    });
    expect(keys).not.toBeNull();
    const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys!);
    expect(verifiesAgainst(header, unpadded.publicKey)).toBe(true);
  });
});
