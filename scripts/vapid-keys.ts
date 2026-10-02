import { createECDH } from 'node:crypto';

// Prints a fresh VAPID key pair for .env. Generate once per environment;
// rotating it invalidates every existing browser subscription.
const ecdh = createECDH('prime256v1');
ecdh.generateKeys();
console.log(`VAPID_PUBLIC_KEY=${ecdh.getPublicKey().toString('base64url')}`);
console.log(`VAPID_PRIVATE_KEY=${ecdh.getPrivateKey().toString('base64url')}`);
console.log('VAPID_SUBJECT=mailto:you@example.com');
