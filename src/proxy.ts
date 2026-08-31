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

  // Layouts can't see the pathname; stamp it so the (teacher) layout can
  // send a student-only session from /settings to their own settings.
  const requestHeaders = new Headers(request.headers);
  // Belt and suspenders: set() replaces, but never let a client-supplied
  // value even transit (unmatched teacher routes skip this proxy, so
  // the layout treats the header as advisory with hardcoded targets only).
  requestHeaders.delete('x-pathname');
  requestHeaders.set('x-pathname', request.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    '/students/:path*',
    '/inbox/:path*',
    '/settings/:path*',
    '/class/:path*',
    '/bookings/:path*',
  ],
};
