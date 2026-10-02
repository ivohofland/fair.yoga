import type { VapidKeys } from './vapid';

// Not `NodeJS.ProcessEnv` itself: Next.js augments that with a required
// `NODE_ENV` this reader never looks at, which a plain env fixture in a test
// has no reason to carry. Same shape `process.env` already has.
type VapidEnvSource = Record<string, string | undefined>;

/**
 * The VAPID keys from the environment, or null when push is not configured.
 * Null disables push: the dispatch sweep retires rows without sending and the
 * settings section says push is unavailable.
 */
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
