import { encryptPayload, InvalidSubscriptionKeysError } from './encrypt';
import { vapidAuthorization, type VapidKeys } from './vapid';
import type { PushPayload, PushUrgency } from '../push-policy';
import type { UserAgentKeys } from './encrypt';

/**
 * `delivered`: the push service accepted it. `gone`: 404/410, the subscription
 * is dead. `invalid`: the stored keys cannot be encrypted against, so it never
 * will. `failed`: anything else — a non-2xx status, a redirect, a network
 * error or a timeout.
 */
export type PushOutcome = 'delivered' | 'gone' | 'invalid' | 'failed';

export type PushTarget = UserAgentKeys & { endpoint: string };

export interface PushSendResult {
  outcome: PushOutcome;
  status: number | null;
  /** On a `failed` network error: the error's `name: message`. */
  cause?: string;
  /** On a `failed` status: the start of the push service's response body. */
  reason?: string;
}

export interface SendOptions {
  urgency: PushUrgency;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** How long the push service may hold this message for an offline device before giving up on delivery. */
export const PUSH_TTL_SECONDS = 600;
const DEFAULT_TIMEOUT_MS = 5_000;
const REASON_MAX_CHARS = 200;

/**
 * One push. Never throws for an HTTP status or a network failure, and reports
 * keys it cannot encrypt against as `invalid`. Any other throw — from signing
 * or encrypting — is a fault in this code or its runtime and propagates.
 */
export async function sendPush(
  target: PushTarget,
  payload: PushPayload,
  keys: VapidKeys,
  { urgency, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS }: SendOptions,
): Promise<PushSendResult> {
  const authorization = vapidAuthorization(target.endpoint, keys);
  let body: Buffer;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(payload)), { p256dh: target.p256dh, auth: target.auth });
  } catch (err) {
    if (err instanceof InvalidSubscriptionKeysError) return { outcome: 'invalid', status: null };
    throw err;
  }

  let response: Response;
  try {
    response = await fetchImpl(target.endpoint, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_SECONDS),
        Urgency: urgency,
      },
      body: new Uint8Array(body),
      // A redirect is never followed: the endpoint was checked against the
      // push-service allowlist, and its redirect target was not.
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const cause = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { outcome: 'failed', status: null, cause };
  }
  if (response.ok) return { outcome: 'delivered', status: response.status };
  if (response.status === 404 || response.status === 410) return { outcome: 'gone', status: response.status };
  const reason = await readReason(response);
  return reason === undefined
    ? { outcome: 'failed', status: response.status }
    : { outcome: 'failed', status: response.status, reason };
}

/** At most `REASON_MAX_CHARS` of the body, read no further than that; undefined when empty or unreadable. */
async function readReason(response: Response): Promise<string | undefined> {
  try {
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < REASON_MAX_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    const reason = text.slice(0, REASON_MAX_CHARS);
    return reason === '' ? undefined : reason;
  } catch {
    // The status already says the push failed; a body that cannot be read
    // only means there is no reason to add to it.
    return undefined;
  }
}
