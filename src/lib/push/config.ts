import { createECDH } from 'node:crypto';
import type { VapidKeys } from './vapid';

// Wide enough that `process.env` is the default and a test can pass a plain
// object instead; it does not narrow to the keys read below.
type VapidEnvSource = Record<string, string | undefined>;

/**
 * The VAPID keys from the environment, or null when any is unset or malformed.
 * The public key must be the one the private key derives: one that is not,
 * whether off the curve or from another pair, fails every send, so it reads
 * as push not being configured at all.
 */
export function readVapidConfig(env: VapidEnvSource = process.env): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  const publicBytes = Buffer.from(publicKey, 'base64url');
  const privateBytes = Buffer.from(privateKey, 'base64url');
  if (publicBytes.length !== 65) return null;
  if (privateBytes.length !== 32) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  let derived: Buffer;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    derived = ecdh.getPublicKey();
  } catch {
    return null; // a 32-byte value that is not a valid P-256 scalar
  }
  if (!derived.equals(publicBytes)) return null;
  return { publicKey, privateKey, subject };
}
