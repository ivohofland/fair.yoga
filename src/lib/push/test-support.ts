import { createECDH, randomBytes } from 'node:crypto';
import { padPrivateKeyScalar } from './config';

/**
 * A fresh VAPID-shaped P-256 key pair, base64url. Test-only — never import
 * this outside a *.test.ts file.
 *
 * `createECDH('prime256v1').getPrivateKey()` strips a scalar's leading zero
 * bytes, so calling it directly makes a test flake at ~1 in 256 runs. This
 * pads through `padPrivateKeyScalar`, the same function `diagnoseVapidConfig`
 * uses, so every key this returns is the canonical 32 bytes.
 */
export function generateVapidKeyPair(): { publicKey: string; privateKey: string } {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: padPrivateKeyScalar(ecdh.getPrivateKey()).toString('base64url'),
  };
}

/**
 * A VAPID-shaped P-256 key pair whose private key is deliberately left
 * UNPADDED — a scalar with a leading zero byte, the ~1-in-256 case
 * `createECDH('prime256v1').getPrivateKey()` returns under 32 bytes. For
 * tests that exercise the padding itself (`padPrivateKeyScalar`,
 * `diagnoseVapidConfig`'s acceptance of a short key); every other test
 * wants `generateVapidKeyPair` above instead.
 */
export function generateUnpaddedVapidKeyPair(): { publicKey: string; privateKey: string } {
  for (;;) {
    const ecdh = createECDH('prime256v1');
    let raw: Buffer;
    try {
      ecdh.setPrivateKey(Buffer.concat([Buffer.from([0]), randomBytes(31)]));
      raw = ecdh.getPrivateKey();
    } catch {
      continue;
    }
    return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: raw.toString('base64url') };
  }
}
