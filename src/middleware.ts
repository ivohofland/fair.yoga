import { NextRequest, NextResponse } from 'next/server';

// Duplicated here intentionally — middleware runs in Edge Runtime
// which may not support all Node.js imports. Keep it simple.
const SESSION_COOKIE_NAME = 'fair_yoga_session';

export function middleware(request: NextRequest) {
  const sessionToken = request.cookies.get(SESSION_COOKIE_NAME)?.value;

  if (!sessionToken) {
    const loginUrl = new URL('/login', request.url);
    loginUrl.searchParams.set('redirect', request.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Layouts can't see the pathname; stamp it so the (teacher) layout can
  // send a student-only session from /settings to their own settings.
  const requestHeaders = new Headers(request.headers);
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
