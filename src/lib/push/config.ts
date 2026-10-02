import type { VapidKeys } from './vapid';

// Only the keys this module reads; `process.env` assigns to it.
type VapidEnvSource = Record<string, string | undefined>;

/** The VAPID keys from the environment, or null when any is unset or malformed. */
export function readVapidConfig(env: VapidEnvSource = process.env): VapidKeys | null {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) return null;
  if (Buffer.from(publicKey, 'base64url').length !== 65) return null;
  if (Buffer.from(privateKey, 'base64url').length !== 32) return null;
  if (!/^(mailto:|https:\/\/)/.test(subject)) return null;
  return { publicKey, privateKey, subject };
}
