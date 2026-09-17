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
    it('redirects unauthenticated request on /schedule to login with redirect param', () => {
      const request = makeRequest('/schedule');
      const response = proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Fschedule');
    });

    it('redirects unauthenticated request on /studio-class/sc-1 to login with redirect param', () => {
      const request = makeRequest('/studio-class/sc-1');
      const response = proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Fstudio-class%2Fsc-1');
    });

    it('redirects unauthenticated request on /account/privacy to login with redirect param', () => {
      const request = makeRequest('/account/privacy');
      const response = proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Faccount%2Fprivacy');
    });

    it('redirects unauthenticated request on /updates to login with redirect param', () => {
      const request = makeRequest('/updates');
      const response = proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Fupdates');
    });

    it('preserves query parameters on newly protected routes', () => {
      const request = makeRequest('/account/privacy?tab=invitations');
      const response = proxy(request);

      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe('http://localhost:3000/login?redirect=%2Faccount%2Fprivacy%3Ftab%3Dinvitations');
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

    it('preserves query parameters in stamped x-pathname header', () => {
      const request = makeRequest('/account/privacy?tab=invitations', {
        cookies: { fair_yoga_session: 'valid-session-token' },
      });
      const response = proxy(request);

      expect(response.status).toBe(200);
      const stampedPathname = response.headers.get('x-middleware-request-x-pathname');
      expect(stampedPathname).toBe('/account/privacy?tab=invitations');
    });
  });

  describe('config matcher', () => {
    it('matches all protected route prefixes', () => {
      expect(config.matcher).toEqual([
        '/schedule/:path*',
        '/studio-class/:path*',
        '/students/:path*',
        '/inbox/:path*',
        '/settings/:path*',
        '/class/:path*',
        '/bookings/:path*',
        '/account/:path*',
        '/updates/:path*',
      ]);
    });
  });
});
