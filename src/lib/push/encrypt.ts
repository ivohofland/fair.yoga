import { createCipheriv, createECDH, hkdfSync, randomBytes, ECDH } from 'node:crypto';

/** The browser's keys, base64url, as `PushSubscription.toJSON().keys` gives them. */
export interface UserAgentKeys {
  p256dh: string;
  auth: string;
}

const RECORD_SIZE = 4096;

function info(label: string): Buffer {
  return Buffer.from(`${label}\0`, 'latin1');
}

/**
 * RFC 8291 message encryption, `aes128gcm` content coding (RFC 8188), one
 * record. `seed` exists only to reproduce the RFC's worked example; real
 * sends leave it out and get a fresh server key and salt per message.
 */
export function encryptPayload(
  plaintext: Buffer,
  keys: UserAgentKeys,
  seed?: { serverPrivateKey: Buffer; salt: Buffer },
): Buffer {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  if (uaPublic.length !== 65 || authSecret.length !== 16) {
    throw new Error('push subscription keys are malformed');
  }

  const ecdh = createECDH('prime256v1');
  if (seed) ecdh.setPrivateKey(seed.serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const salt = seed?.salt ?? randomBytes(16);

  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(
    hkdfSync('sha256', ecdhSecret, authSecret, Buffer.concat([info('WebPush: info'), uaPublic, asPublic]), 32),
  );
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, info('Content-Encoding: aes128gcm'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, info('Content-Encoding: nonce'), 12));

  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // 0x02: the padding delimiter of the last (here: only) record.
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(RECORD_SIZE);
  return Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic, ciphertext]);
}

/**
 * True when `p256dh` (base64url) decodes to a point actually on the P-256
 * curve. A 65-byte buffer can still fail this — `encryptPayload`'s ECDH
 * computation throws on an off-curve point, so a subscription that passes
 * only the length check could never receive a push.
 */
export function isP256PublicKey(p256dh: string): boolean {
  try {
    ECDH.convertKey(Buffer.from(p256dh, 'base64url'), 'prime256v1', undefined, undefined, 'uncompressed');
    return true;
  } catch {
    return false;
  }
}
