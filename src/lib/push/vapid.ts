import { createPrivateKey, sign } from 'node:crypto';

/** Base64url keys: `publicKey` the 65-byte uncompressed point, `privateKey` the 32-byte scalar. */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const EXPIRY_SECONDS = 12 * 60 * 60;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** RFC 8292 `Authorization` header value for one push to `endpoint`. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now: Date = new Date()): string {
  const pub = Buffer.from(keys.publicKey, 'base64url');
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33).toString('base64url'),
    },
    format: 'jwk',
  });
  const signingInput = `${b64url({ typ: 'JWT', alg: 'ES256' })}.${b64url({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now.getTime() / 1000) + EXPIRY_SECONDS,
    sub: keys.subject,
  })}`;
  const signature = sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${signingInput}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}
