import { encryptPayload } from './encrypt';
import { vapidAuthorization, type VapidKeys } from './vapid';
import type { PushPayload } from '../push-policy';

export type PushOutcome = 'delivered' | 'gone' | 'failed';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface SendOptions {
  urgency: 'high' | 'normal';
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** How long the push service may hold this message for an offline device before giving up on delivery. */
export const PUSH_TTL_SECONDS = 600;
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * One push. Never throws for an HTTP status or a network failure: 404/410 mean
 * the subscription is dead (`gone`), anything else non-2xx or a timeout is
 * `failed`. A malformed stored key does throw — that is a row this app wrote
 * and must not be swallowed.
 */
export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
  keys: VapidKeys,
  { urgency, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: SendOptions,
): Promise<{ outcome: PushOutcome; status: number | null }> {
  const body = encryptPayload(Buffer.from(JSON.stringify(payload)), { p256dh: target.p256dh, auth: target.auth });
  let response: Response;
  try {
    response = await fetchImpl(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(target.endpoint, keys),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: urgency,
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { outcome: 'failed', status: null };
  }
  if (response.ok) return { outcome: 'delivered', status: response.status };
  if (response.status === 404 || response.status === 410) return { outcome: 'gone', status: response.status };
  return { outcome: 'failed', status: response.status };
}
