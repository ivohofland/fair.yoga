import { describe, it, expect } from 'vitest';
import { diagnoseVapidConfig, readVapidConfig, padPrivateKeyScalar } from './config';
import { generateVapidKeyPair, generateUnpaddedVapidKeyPair } from './test-support';

const pair = generateVapidKeyPair();
const good = {
  VAPID_PUBLIC_KEY: pair.publicKey,
  VAPID_PRIVATE_KEY: pair.privateKey,
  VAPID_SUBJECT: 'mailto:ops@fair.yoga',
};

describe('readVapidConfig', () => {
  it('returns the keys when every `VAPID_*` value is set and well-formed', () => {
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
    const other = generateVapidKeyPair();
    const env = {
      ...good,
      VAPID_PUBLIC_KEY: other.publicKey,
      VAPID_PRIVATE_KEY: other.privateKey,
    };
    expect(readVapidConfig(env)).toEqual({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: good.VAPID_SUBJECT });
  });

  it('is null for a valid public key that belongs to a different private key', () => {
    const other = generateVapidKeyPair();
    expect(readVapidConfig({ ...good, VAPID_PUBLIC_KEY: other.publicKey })).toBeNull();
  });

  it('is null for a 65-byte public key that is not a point on the curve', () => {
    expect(readVapidConfig({ ...good, VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url') })).toBeNull();
  });

  it('is null for a 32-byte private key that is not a valid scalar', () => {
    expect(readVapidConfig({ ...good, VAPID_PRIVATE_KEY: Buffer.alloc(32, 0).toString('base64url') })).toBeNull();
  });
});

describe('diagnoseVapidConfig', () => {
  it('is ok with the keys when every `VAPID_*` value is set and well-formed', () => {
    expect(diagnoseVapidConfig(good)).toEqual({
      ok: true,
      keys: { publicKey: good.VAPID_PUBLIC_KEY, privateKey: good.VAPID_PRIVATE_KEY, subject: good.VAPID_SUBJECT },
    });
  });

  it('names an environment with no VAPID variable unset', () => {
    expect(diagnoseVapidConfig({})).toEqual({ ok: false, reason: 'unset' });
    expect(diagnoseVapidConfig({ VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '' })).toEqual({ ok: false, reason: 'unset' });
  });

  it.each(['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'] as const)('names a missing %s alone partial', (name) => {
    expect(diagnoseVapidConfig({ ...good, [name]: undefined })).toEqual({ ok: false, reason: 'partial' });
  });

  it('names a public key of the wrong length public-length', () => {
    expect(diagnoseVapidConfig({ ...good, VAPID_PUBLIC_KEY: 'AAAA' })).toEqual({ ok: false, reason: 'public-length' });
  });

  it('names a private key of the wrong length private-length', () => {
    expect(diagnoseVapidConfig({ ...good, VAPID_PRIVATE_KEY: Buffer.alloc(33, 1).toString('base64url') })).toEqual({ ok: false, reason: 'private-length' });
    // A non-empty, truthy string that decodes to zero bytes (Node's base64url
    // decoding ignores characters outside its alphabet) — the "empty" case
    // `private-length` names, distinct from an unset/falsy value ('partial').
    expect(diagnoseVapidConfig({ ...good, VAPID_PRIVATE_KEY: '!!!' })).toEqual({ ok: false, reason: 'private-length' });
  });

  it('pads a private key shorter than 32 bytes — the leading-zero case `getPrivateKey()` can return', () => {
    const unpadded = generateUnpaddedVapidKeyPair();
    const raw = Buffer.from(unpadded.privateKey, 'base64url');
    expect(raw.length).toBeLessThan(32);
    const padded = padPrivateKeyScalar(raw);
    expect(padded).toHaveLength(32);
    const env = { ...good, VAPID_PUBLIC_KEY: unpadded.publicKey, VAPID_PRIVATE_KEY: unpadded.privateKey };
    const diagnosis = diagnoseVapidConfig(env);
    expect(diagnosis.ok).toBe(true);
    if (!diagnosis.ok) throw new Error('unreachable');
    expect(Buffer.from(diagnosis.keys.privateKey, 'base64url')).toEqual(padded);
  });

  it('names a subject that is neither mailto: nor https:// subject', () => {
    expect(diagnoseVapidConfig({ ...good, VAPID_SUBJECT: 'ops@fair.yoga' })).toEqual({ ok: false, reason: 'subject' });
    expect(diagnoseVapidConfig({ ...good, VAPID_SUBJECT: 'http://fair.yoga' })).toEqual({ ok: false, reason: 'subject' });
  });

  it('names a 32-byte private key outside the scalar range invalid-scalar', () => {
    expect(diagnoseVapidConfig({ ...good, VAPID_PRIVATE_KEY: Buffer.alloc(32, 0).toString('base64url') })).toEqual({ ok: false, reason: 'invalid-scalar' });
    expect(diagnoseVapidConfig({ ...good, VAPID_PRIVATE_KEY: Buffer.alloc(32, 0xff).toString('base64url') })).toEqual({ ok: false, reason: 'invalid-scalar' });
  });

  it('names a public key from another pair, or off the curve, pair-mismatch', () => {
    const other = generateVapidKeyPair();
    expect(diagnoseVapidConfig({ ...good, VAPID_PUBLIC_KEY: other.publicKey })).toEqual({ ok: false, reason: 'pair-mismatch' });
    expect(diagnoseVapidConfig({ ...good, VAPID_PUBLIC_KEY: Buffer.alloc(65, 4).toString('base64url') })).toEqual({ ok: false, reason: 'pair-mismatch' });
  });
});
