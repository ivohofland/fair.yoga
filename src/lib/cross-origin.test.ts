import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { crossOriginRefusal } from './cross-origin';

function req(method: string, headers: Record<string, string>): NextRequest {
  return new NextRequest('http://localhost:3000/api/classes/x/cancel', { method, headers });
}

describe('crossOriginRefusal', () => {
  it('refuses a write whose Origin names another host', () => {
    expect(crossOriginRefusal(req('POST', { host: 'localhost:3000', origin: 'https://evil.example' }))).toEqual({
      reason: 'host-mismatch',
      originHost: 'evil.example',
      host: 'localhost:3000',
    });
  });

  it('refuses an Origin on the same hostname but another port', () => {
    expect(crossOriginRefusal(req('POST', { host: 'localhost:3000', origin: 'http://localhost:3001' }))).toEqual({
      reason: 'host-mismatch',
      originHost: 'localhost:3001',
      host: 'localhost:3000',
    });
  });

  it('refuses Origin: null', () => {
    expect(crossOriginRefusal(req('POST', { host: 'localhost:3000', origin: 'null' }))).toEqual({
      reason: 'origin-null',
      originHost: null,
      host: 'localhost:3000',
    });
  });

  it('refuses a malformed Origin instead of throwing, and reports none of it', () => {
    expect(crossOriginRefusal(req('POST', { host: 'localhost:3000', origin: 'not a url' }))).toEqual({
      reason: 'origin-unparseable',
      originHost: null,
      host: 'localhost:3000',
    });
  });

  it('refuses an Origin when the request has no Host to compare it with', () => {
    // undici fills Host from the URL, so delete it after construction.
    const request = req('POST', { origin: 'http://localhost:3000' });
    request.headers.delete('host');
    expect(crossOriginRefusal(request)?.reason).toBe('host-missing');
  });

  it('refuses Sec-Fetch-Site: cross-site even without an Origin', () => {
    expect(crossOriginRefusal(req('DELETE', { host: 'localhost:3000', 'sec-fetch-site': 'cross-site' }))).toEqual({
      reason: 'sec-fetch-cross-site',
      originHost: null,
      host: 'localhost:3000',
    });
  });

  it('reports the Origin’s host and port beside a Sec-Fetch-Site refusal', () => {
    const refusal = crossOriginRefusal(
      req('POST', { host: 'localhost:3000', origin: 'https://evil.example:8443', 'sec-fetch-site': 'cross-site' }),
    );
    expect(refusal).toEqual({ reason: 'sec-fetch-cross-site', originHost: 'evil.example:8443', host: 'localhost:3000' });
  });

  it('passes the request’s own host, whatever the scheme', () => {
    // A TLS-terminating proxy: the app sees http while the browser says https.
    expect(crossOriginRefusal(req('POST', { host: 'fair.yoga', origin: 'https://fair.yoga' }))).toBeNull();
    expect(crossOriginRefusal(req('PUT', { host: 'localhost:3000', origin: 'http://localhost:3000' }))).toBeNull();
  });

  it('compares hosts case-insensitively', () => {
    expect(crossOriginRefusal(req('POST', { host: 'LOCALHOST:3000', origin: 'http://localhost:3000' }))).toBeNull();
  });

  it('passes a request with neither header (curl, server-to-server)', () => {
    expect(crossOriginRefusal(req('POST', { host: 'localhost:3000' }))).toBeNull();
  });

  it('never refuses a read, even cross-site (the magic-link email opens a GET)', () => {
    expect(
      crossOriginRefusal(req('GET', { host: 'localhost:3000', origin: 'https://mail.example', 'sec-fetch-site': 'cross-site' })),
    ).toBeNull();
  });

  it('checks every mutating method', () => {
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(crossOriginRefusal(req(m, { host: 'localhost:3000', origin: 'https://evil.example' }))?.reason).toBe('host-mismatch');
    }
  });

  it('refuses a same-site write from the admin host to the main host as host-mismatch', () => {
    expect(
      crossOriginRefusal(req('POST', { host: 'localhost:3000', origin: 'http://admin.localhost:3000', 'sec-fetch-site': 'same-site' })),
    ).toEqual({ reason: 'host-mismatch', originHost: 'admin.localhost:3000', host: 'localhost:3000' });
  });

  it('refuses a same-site write from the main host to the admin host as host-mismatch', () => {
    expect(
      crossOriginRefusal(req('POST', { host: 'admin.localhost:3000', origin: 'http://localhost:3000', 'sec-fetch-site': 'same-site' })),
    ).toEqual({ reason: 'host-mismatch', originHost: 'localhost:3000', host: 'admin.localhost:3000' });
  });
});
