import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { hashToken } from './magic-link';

declare const browserNonceBrand: unique symbol;

/** A browser's origin nonce, obtained only from `ensureOriginNonce` or
 *  `readOriginNonce`. Exists so a plain string cannot stand in for a real
 *  browser's nonce at any call site that requires one. */
export type BrowserNonce = string & { readonly [browserNonceBrand]: true };

/** Names the browser that asked for a sign-in link. */
export const ORIGIN_NONCE_COOKIE = 'fair_yoga_origin';

/** A year: covers the gap between requesting a link and finally opening it —
 *  a forgotten tab, a slow inbox check, days later. `clearOriginNonceCookie`
 *  rotates it on every successful consume, so this long lifetime does NOT
 *  mean the cookie survives across completed sign-ins — only across
 *  abandoned or not-yet-opened ones. A short life would push returning
 *  users into the handoff branch for no security gain in that gap, since
 *  the nonce is worthless without a live token. */
const NONCE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/** SHA-256 of the nonce. Only the hash is ever persisted, so a database read
 *  yields no usable nonce. */
export function hashNonce(nonce: string): string {
  return hashToken(nonce);
}

export function readOriginNonce(request: NextRequest): BrowserNonce | null {
  return (request.cookies.get(ORIGIN_NONCE_COOKIE)?.value as BrowserNonce | undefined) ?? null;
}

/**
 * Returns this browser's nonce, minting one and appending its `Set-Cookie` to
 * `headers` if it has none.
 *
 * Must be called unconditionally for every accepted request, before any
 * lookup that might not find an account — see the design spec §5 for why.
 */
export function ensureOriginNonce(request: NextRequest, headers: Headers): BrowserNonce {
  const existing = readOriginNonce(request);
  if (existing) return existing;

  const nonce = crypto.randomBytes(32).toString('hex') as BrowserNonce;
  let cookie = `${ORIGIN_NONCE_COOKIE}=${nonce}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${NONCE_MAX_AGE_SECONDS}`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
  return nonce;
}

/** Rotates the browser's nonce after a successful consume (verify or claim),
 *  so it does not persist across completed sign-ins — see
 *  `NONCE_MAX_AGE_SECONDS` above for what its long, un-rotated lifetime is
 *  actually for. */
export function clearOriginNonceCookie(headers: Headers): void {
  let cookie = `${ORIGIN_NONCE_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  if (process.env.NODE_ENV === 'production') cookie += '; Secure';
  headers.append('Set-Cookie', cookie);
}
