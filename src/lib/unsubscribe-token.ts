import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { log } from '@/lib/log';
import {
  parseUnsubscribePayload,
  UNSUBSCRIBE_TOKEN_VERSION,
  type UnsubscribeTarget,
} from '@/lib/unsubscribe-kind';

const MIN_SECRET_BYTES = 32;
const DEV_KEY = 'fair.yoga development unsubscribe key, never used in production';
const MAC_DOMAIN = 'unsubscribe:';

let warnedNoSecret = false;

/** The signing key; null in production without a usable secret, which disables unsubscribe links. */
function key(): string | null {
  const secret = process.env.UNSUBSCRIBE_SECRET?.trim() ?? '';
  if (Buffer.byteLength(secret) >= MIN_SECRET_BYTES) return secret;
  if (process.env.NODE_ENV !== 'production') return DEV_KEY;
  if (!warnedNoSecret) {
    warnedNoSecret = true;
    log.warn(
      {},
      'UNSUBSCRIBE_SECRET is unset or shorter than 32 bytes; mail is sent without unsubscribe links',
    );
  }
  return null;
}

function mac(k: string, payload: string): Buffer {
  return createHmac('sha256', k)
    .update(MAC_DOMAIN + payload)
    .digest();
}

export function signUnsubscribeToken(target: UnsubscribeTarget): string | null {
  const k = key();
  if (k === null) return null;
  const payload = Buffer.from(
    `${UNSUBSCRIBE_TOKEN_VERSION}.${target.kind}.${target.subjectId}`,
    'utf8',
  ).toString('base64url');
  return `${payload}.${mac(k, payload).toString('base64url')}`;
}

/** The target a token was signed for, or null. Never throws and never reads the database. */
export function verifyUnsubscribeToken(token: string): UnsubscribeTarget | null {
  const k = key();
  if (k === null) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, presented] = parts as [string, string];
  if (!/^[A-Za-z0-9_-]+$/.test(presented)) return null;
  const expected = mac(k, payload);
  const given = Buffer.from(presented, 'base64url');
  // The last character of a MAC carries padding bits the decoder discards; only the canonical spelling verifies.
  if (given.toString('base64url') !== presented) return null;
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  return parseUnsubscribePayload(payload);
}

/** The header URL (POST target) and the page URL (token in the fragment). */
export function unsubscribeLinks(
  target: UnsubscribeTarget,
): { oneClick: string; page: string } | null {
  const token = signUnsubscribeToken(target);
  if (token === null) return null;
  const base = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  return { oneClick: `${base}/api/unsubscribe?t=${token}`, page: `${base}/unsubscribe#t=${token}` };
}

/**
 * An invitation is addressed mail, and its address can be edited after the
 * email went out; the subject carries the address it was sent to so a link
 * at an old address cannot decline for a new one.
 */
export function addressTag(email: string): string {
  return createHash('sha256').update(email.toLowerCase()).digest('base64url').slice(0, 22);
}

export function invitationSubject(invitationId: string, email: string): string {
  return `${invitationId}~${addressTag(email)}`;
}

export function parseInvitationSubject(
  subjectId: string,
): { invitationId: string; tag: string } | null {
  const [invitationId, tag, ...rest] = subjectId.split('~');
  if (!invitationId || !tag || rest.length > 0) return null;
  return { invitationId, tag };
}
