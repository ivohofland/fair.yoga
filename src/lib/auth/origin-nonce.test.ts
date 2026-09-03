import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import {
  ORIGIN_NONCE_COOKIE,
  readOriginNonce,
  ensureOriginNonce,
  hashNonce,
} from './origin-nonce';

function requestWithCookie(value?: string): NextRequest {
  const headers = new Headers();
  if (value !== undefined) headers.set('cookie', `${ORIGIN_NONCE_COOKIE}=${value}`);
  return new NextRequest('http://localhost:3000/api/auth/magic-link/send', { headers });
}

describe('origin nonce', () => {
  it('reads nothing from a request with no cookie', () => {
    expect(readOriginNonce(requestWithCookie())).toBeNull();
  });

  it('reads back the nonce it was given', () => {
    expect(readOriginNonce(requestWithCookie('abc123'))).toBe('abc123');
  });

  it('mints a 64-hex nonce and sets a cookie when the browser has none', () => {
    const headers = new Headers();
    const nonce = ensureOriginNonce(requestWithCookie(), headers);

    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    const cookie = headers.get('Set-Cookie');
    expect(cookie).toContain(`${ORIGIN_NONCE_COOKIE}=${nonce}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
  });

  it('reuses an existing nonce and sets no cookie — the nonce is per-browser, not per-request', () => {
    const headers = new Headers();
    const nonce = ensureOriginNonce(requestWithCookie('existing-nonce'), headers);

    expect(nonce).toBe('existing-nonce');
    expect(headers.get('Set-Cookie')).toBeNull();
  });

  it('omits Secure outside production, so local http dev works', () => {
    const headers = new Headers();
    ensureOriginNonce(requestWithCookie(), headers);
    expect(headers.get('Set-Cookie')).not.toContain('Secure');
  });

  it('hashes to 64 lowercase hex, and never returns the raw value', () => {
    const hash = hashNonce('some-nonce');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toBe('some-nonce');
    expect(hashNonce('some-nonce')).toBe(hash);
    expect(hashNonce('other-nonce')).not.toBe(hash);
  });
});
