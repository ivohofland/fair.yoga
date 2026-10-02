import { createECDH } from 'node:crypto';
import type { VapidKeys } from './vapid';

// Wide enough that `process.env` is the default and a test can pass a plain
// object instead; it does not narrow to the keys read below.
type VapidEnvSource = Record<string, string | undefined>;

/** Why the VAPID environment cannot be used. */
export type VapidConfigProblem =
  /** No VAPID variable is set: a deployment without push. */
  | 'unset'
  /** Some are set and some are not. */
  | 'partial'
  /** The public key does not decode to an uncompressed P-256 point's size. */
  | 'public-length'
  /** The private key does not decode to a P-256 scalar's size. */
  | 'private-length'
  /** The subject is not a `mailto:` or `https://` URL. */
  | 'subject'
  /** The public key is not the one the private key derives. */
  | 'pair-mismatch'
  /** The private key is not a usable P-256 scalar. */
  | 'invalid-scalar';

export type VapidDiagnosis = { ok: true; keys: VapidKeys } | { ok: false; reason: VapidConfigProblem };

/**
 * The VAPID keys from the environment, or the reason they cannot be used.
 * A public key that is not the private key's own, whether off the curve or
 * from another pair, would fail every send, so it is refused here.
 */
export function diagnoseVapidConfig(env: VapidEnvSource = process.env): VapidDiagnosis {
  const publicKey = env.VAPID_PUBLIC_KEY;
  const privateKey = env.VAPID_PRIVATE_KEY;
  const subject = env.VAPID_SUBJECT;
  if (!publicKey && !privateKey && !subject) return { ok: false, reason: 'unset' };
  if (!publicKey || !privateKey || !subject) return { ok: false, reason: 'partial' };
  const publicBytes = Buffer.from(publicKey, 'base64url');
  const privateBytes = Buffer.from(privateKey, 'base64url');
  if (publicBytes.length !== 65) return { ok: false, reason: 'public-length' };
  if (privateBytes.length !== 32) return { ok: false, reason: 'private-length' };
  if (!/^(mailto:|https:\/\/)/.test(subject)) return { ok: false, reason: 'subject' };
  let derived: Buffer;
  try {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateBytes);
    derived = ecdh.getPublicKey();
  } catch (err) {
    // `setPrivateKey` refuses a 32-byte value outside the curve's scalar
    // range; anything else it throws is not a configuration problem.
    if (err instanceof Error && 'code' in err && err.code === 'ERR_CRYPTO_INVALID_KEYTYPE') {
      return { ok: false, reason: 'invalid-scalar' };
    }
    throw err;
  }
  if (!derived.equals(publicBytes)) return { ok: false, reason: 'pair-mismatch' };
  return { ok: true, keys: { publicKey, privateKey, subject } };
}

/** The VAPID keys from the environment, or null when `diagnoseVapidConfig` finds any problem. */
export function readVapidConfig(env: VapidEnvSource = process.env): VapidKeys | null {
  const diagnosis = diagnoseVapidConfig(env);
  return diagnosis.ok ? diagnosis.keys : null;
}
