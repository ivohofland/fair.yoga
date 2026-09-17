import { NextRequest, NextResponse } from 'next/server';

// Duplicated here intentionally to keep proxy startup lightweight
// without pulling in database or server-only session dependencies.
const SESSION_COOKIE_NAME = 'fair_yoga_session';

export function proxy(request: NextRequest) {
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionToken) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', request.nextUrl.pathname + request.nextUrl.search);
    return NextResponse.redirect(loginUrl);
  }

  // Layouts and guards can't see the pathname; stamp it with any query
  // parameters so downstream components can read the requested destination.
  const requestHeaders = new Headers(request.headers);
  // Belt and suspenders: set() replaces, but never let a client-supplied
  // value even transit.
  requestHeaders.delete('x-pathname');
  requestHeaders.set('x-pathname', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    '/schedule/:path*',
    '/studio-class/:path*',
    '/students/:path*',
    '/inbox/:path*',
    '/settings/:path*',
    '/class/:path*',
    '/bookings/:path*',
    '/account/:path*',
    '/updates/:path*',
  ],
};
