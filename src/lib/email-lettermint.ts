import { createHash } from 'node:crypto';

/**
 * The one call to Lettermint's sending API. Every outcome comes back as a
 * value: a non-2xx answer, a network failure and a timeout are all
 * `ok: false`, so the seam above (`sendEmail`, lib/email.ts) never has to know
 * how this provider reports failure.
 */

const SEND_URL = 'https://api.lettermint.co/v1/send';
const DEFAULT_TIMEOUT_MS = 10_000;
/** Lettermint caps the header at 255; the salt adds a dash and 16 hex characters. */
const MAX_CALLER_KEY_LENGTH = 255 - 17;

export interface LettermintPayload {
  from: string;
  to: string;
  replyTo?: string;
  route?: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  /**
   * A caller-stable id for a send that may be retried. Sent salted with a
   * hash of the body: Lettermint returns the original response for the same
   * key and body within 24 hours, and answers 409 for the same key with a
   * different body — the salt turns a changed body into a new send instead.
   */
  idempotencyKey?: string;
}

export type LettermintResult = { ok: true } | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The message from any of the error bodies Lettermint documents; the status text when the body is not JSON. */
async function errorMessage(res: Response): Promise<string> {
  let body: unknown;
  try {
    body = JSON.parse(await res.text());
  } catch {
    return res.statusText || 'error without a body';
  }
  if (!isRecord(body)) return res.statusText || 'error without a message';
  if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
  if (typeof body.message === 'string') {
    return isRecord(body.errors) ? `${body.message} (${Object.keys(body.errors).join(', ')})` : body.message;
  }
  return res.statusText || 'error without a message';
}

export async function deliverViaLettermint(
  payload: LettermintPayload,
  token: string,
  options: { timeoutMs?: number } = {},
): Promise<LettermintResult> {
  const body = JSON.stringify({
    from: payload.from,
    to: [payload.to],
    ...(payload.replyTo !== undefined && { reply_to: [payload.replyTo] }),
    ...(payload.route !== undefined && { route: payload.route }),
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
    ...(payload.headers !== undefined && { headers: payload.headers }),
  });
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-lettermint-token': token,
  };
  if (payload.idempotencyKey !== undefined) {
    const salt = createHash('sha256').update(body).digest('hex').slice(0, 16);
    headers['idempotency-key'] = `${payload.idempotencyKey.slice(0, MAX_CALLER_KEY_LENGTH)}-${salt}`;
  }

  let res: Response;
  try {
    res = await fetch(SEND_URL, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (err) {
    // The name only: a rejection's message can quote the token (an invalid
    // header character makes fetch echo the header value).
    return { ok: false, reason: `lettermint request failed (${err instanceof Error ? err.name : 'unknown'})` };
  }
  if (res.ok) return { ok: true };
  return { ok: false, reason: `lettermint ${res.status}: ${await errorMessage(res)}` };
}
