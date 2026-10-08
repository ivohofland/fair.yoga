import { NextRequest, NextResponse } from 'next/server';
import { buildPageCsp } from '@/lib/csp';

// Duplicated here intentionally to keep proxy startup lightweight
// without pulling in database or server-only session dependencies.
const SESSION_COOKIE_NAME = 'fair_yoga_session';

// The sections a signed-out visitor is sent to /login from. The matcher
// below is wider — every page needs a nonce — so "needs a CSP" and "needs a
// session" are separate questions.
const SIGNED_IN_SECTIONS = [
  '/schedule',
  '/studio-class',
  '/students',
  '/inbox',
  '/settings',
  '/class',
  '/bookings',
  '/account',
  '/updates',
] as const;

export function requiresSession(pathname: string): boolean {
  return SIGNED_IN_SECTIONS.some((s) => pathname === s || pathname.startsWith(`${s}/`));
}

/** 16 random bytes, base64: a 128-bit nonce. */
export function mintNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}

export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (requiresSession(pathname) && !request.cookies.get(SESSION_COOKIE_NAME)?.value) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', pathname + search);
    return NextResponse.redirect(loginUrl);
  }

  const csp = buildPageCsp(mintNonce(), process.env.NODE_ENV === 'development');

  // Layouts and guards can't see the pathname; stamp it with any query
  // parameters so downstream components can read the requested destination.
  const requestHeaders = new Headers(request.headers);
  // Belt and suspenders: set() replaces, but never let a client-supplied
  // value even transit.
  requestHeaders.delete('x-pathname');
  requestHeaders.set('x-pathname', pathname + search);
  // Next reads the nonce off the request's CSP to stamp its own scripts.
  requestHeaders.set('Content-Security-Policy', csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set('Content-Security-Policy', csp);
  return response;
}

export const config = {
  // Every page. Never /api/*: a matched path has its request body buffered
  // before the route runs, which would defeat the photo upload's refusal of
  // an oversized body before reading it.
  matcher: [
    '/((?!api/|_next/static|_next/image|favicon\\.ico|icon\\.svg|apple-icon\\.png|manifest\\.webmanifest|sw\\.js|icons/).*)',
  ],
};
