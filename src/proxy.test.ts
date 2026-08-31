import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy, config } from './proxy';

function makeRequest(path: string, options?: { cookies?: Record<string, string>; headers?: Record<string, string> }): NextRequest {
  const url = `http://localhost:3000${path}`;
  const headers = new Headers(options?.headers);
  if (options?.cookies) {
    const cookieHeader = Object.entries(options.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    headers.set('cookie', cookieHeader);
  }
  return new NextRequest(url, { headers });
}

describe('proxy', () => {
  describe('unauthenticated requests', () => {
    it('redirects to /login with redirect query param for protected path', () => {
      const request = makeRequest('/settings/profile');
      const response = proxy(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toBe('http://localhost:3000/login?redirect=%2Fsettings%2Fprofile');
    });

    it('preserves query parameters in redirect URL', () => {
      const request = makeRequest('/students/stu-1?tab=notes&filter=active');
      const response = proxy(request);

      expect(response.status).toBe(307);
      const location = response.headers.get('location');
      expect(location).toBe('http://localhost:3000/login?redirect=%2Fstudents%2Fstu-1%3Ftab%3Dnotes%26filter%3Dactive');
    });
  });

  describe('authenticated requests', () => {
    it('passes through and stamps x-pathname header', () => {
      const request = makeRequest('/settings/rooms', {
        cookies: { fair_yoga_session: 'valid-session-token' },
      });
      const response = proxy(request);

      expect(response.status).toBe(200);
      const stampedPathname = response.headers.get('x-middleware-request-x-pathname');
      // Next.js NextResponse.next({ request: { headers } }) sets internal x-middleware-request-<header>
      expect(stampedPathname).toBe('/settings/rooms');
    });

    it('strips client-supplied x-pathname and overwrites with actual path', () => {
      const request = makeRequest('/settings/profile', {
        cookies: { fair_yoga_session: 'valid-session-token' },
        headers: { 'x-pathname': '/malicious-spoofed-path' },
      });
      const response = proxy(request);

      expect(response.status).toBe(200);
      const stampedPathname = response.headers.get('x-middleware-request-x-pathname');
      expect(stampedPathname).toBe('/settings/profile');
    });
  });

  describe('config matcher', () => {
    it('matches the 5 protected route prefixes', () => {
      expect(config.matcher).toEqual([
        '/students/:path*',
        '/inbox/:path*',
        '/settings/:path*',
        '/class/:path*',
        '/bookings/:path*',
      ]);
    });
  });
});
