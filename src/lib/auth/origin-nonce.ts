import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { hashToken } from './magic-link';

/** Names the browser that asked for a sign-in link. Sibling of
 *  `fair_yoga_session` and `fair_yoga_signup`; same flags. */
export const ORIGIN_NONCE_COOKIE = 'fair_yoga_origin';

/** A year: this identifies a browser across many sign-ins, not one ceremony.
 *  A short life would push returning users into the handoff branch for no
 *  security gain, since the nonce is worthless without a live token. */
const NONCE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** Same SHA-256 the token column uses. Only the hash is ever persisted, so a
 *  database read yields no usable nonce. */
export function hashNonce(nonce: string): string {
  return hashToken(nonce);
}

export function readOriginNonce(request: NextRequest): string | null {
  return request.cookies.get(ORIGIN_NONCE_COOKIE)?.value ?? null;
}

/**
 * Returns this browser's nonce, minting one and appending its `Set-Cookie` to
 * `headers` if it has none.
 *
 * Callers must invoke this for EVERY accepted request, before deciding whether
 * an account exists. The doors that use it answer a uniform 200 either way so
 * an anonymous caller cannot learn whether an address is registered; setting
 * the cookie only on the has-an-account branch would put that same fact back
 * into `Set-Cookie`.
 */
export function ensureOriginNonce(request: NextRequest, headers: Headers): string {
  const existing = readOriginNonce(request);
  if (existing) return existing;

  const nonce = crypto.randomBytes(32).toString('hex');
  let cookie = `${ORIGIN_NONCE_COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${NONCE_MAX_AGE_SECONDS}`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
  return nonce;
}

export function clearOriginNonceCookie(headers: Headers): void {
  let cookie = `${ORIGIN_NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
}
