import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { isCrossOrigin } from './cross-origin';

function req(method: string, headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/classes/x/cancel', { method, headers });
}

describe('isCrossOrigin', () => {
  it('refuses a write whose Origin names another host', () => {
    expect(isCrossOrigin(req('POST', { host: 'localhost:3000', origin: 'https://evil.example' }))).toBe(true);
  });

  it('refuses Origin: null', () => {
    expect(isCrossOrigin(req('POST', { host: 'localhost:3000', origin: 'null' }))).toBe(true);
  });

  it('refuses a malformed Origin instead of throwing', () => {
    expect(isCrossOrigin(req('POST', { host: 'localhost:3000', origin: 'not a url' }))).toBe(true);
  });

  it('refuses Sec-Fetch-Site: cross-site even without an Origin', () => {
    expect(isCrossOrigin(req('DELETE', { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }))).toBe(true);
  });

  it('passes the request’s own host, whatever the scheme', () => {
    // nginx terminates TLS: the app sees http while the browser says https.
    expect(isCrossOrigin(req('POST', { host: 'fair.yoga', origin: 'https://fair.yoga' }))).toBe(false);
    expect(isCrossOrigin(req('PUT', { host: 'localhost:3000', origin: 'http://localhost:3000' }))).toBe(false);
  });

  it('compares hosts case-insensitively', () => {
    expect(isCrossOrigin(req('POST', { host: 'LOCALHOST:3000', origin: 'http://localhost:3000' }))).toBe(false);
  });

  it('passes a request with neither header (curl, server-to-server)', () => {
    expect(isCrossOrigin(req('POST', { host: 'localhost:3000' }))).toBe(false);
  });

  it('never refuses a read, even cross-site (the magic-link email opens a GET)', () => {
    expect(isCrossOrigin(req('GET', { host: 'localhost:3000', origin: 'https://mail.example', 'sec-fetch-site': 'cross-site' }))).toBe(false);
  });

  it('checks every mutating method', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(isCrossOrigin(req(m, { host: 'localhost:3000', origin: 'https://evil.example' }))).toBe(true);
    }
  });
});
