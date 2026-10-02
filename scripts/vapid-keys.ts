import { createECDH } from 'node:crypto';
import { padPrivateKeyScalar } from '../src/lib/push/config';

// Prints a fresh VAPID key pair for .env. Generate once per environment;
// rotating it invalidates every existing browser subscription.
//
// `getPrivateKey()` strips a scalar's leading zero bytes, so it can come
// back shorter than 32 bytes; `padPrivateKeyScalar` restores the canonical
// length before printing, so every key this prints is exactly 32 bytes.
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
console.log(`VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${padPrivateKeyScalar(ecdh.getPrivateKey()).toString('base64url')}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
