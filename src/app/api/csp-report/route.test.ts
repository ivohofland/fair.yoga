import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: m.warn, error: vi.fn(), debug: vi.fn() },
}));

const { POST } = await import('./route');

const REPORT = {
  'csp-report': {
    'document-uri': 'https://fair.yoga/verify?token=secret-token',
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'https://evil.example/x.js?k=secret-key',
    disposition: 'enforce',
  },
};

function send(body: string, contentType: string, ip: string): Promise<Response> {
  return POST(
    new NextRequest('http://localhost/api/csp-report', {
      method: 'POST',
      headers: { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)), 'x-forwarded-for': ip },
      body,
    }),
  );
}

beforeEach(() => {
  m.warn.mockReset();
  vi.useFakeTimers();
  // Each test starts a fresh refusal-throttle window.
  vi.setSystemTime(Date.now() + 10 * 60_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('POST /api/csp-report logging', () => {
  it('logs one sanitised warn for a valid report', async () => {
    const res = await send(JSON.stringify(REPORT), 'application/csp-report', '203.0.113.1');
    expect(res.status).toBe(204);
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(m.warn).toHaveBeenCalledWith(
      { csp: { directive: 'script-src-elem', blockedUri: 'https://evil.example', documentPath: '/verify', disposition: 'enforce' } },
      'csp violation',
    );
    expect(JSON.stringify(m.warn.mock.calls)).not.toContain('secret');
  });

  it('logs the refusal, not a violation, for a wrong content type', async () => {
    const res = await send(JSON.stringify(REPORT), 'Application/JSON; charset=utf-8', '203.0.113.2');
    expect(res.status).toBe(415);
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(m.warn).toHaveBeenCalledWith(
      { csp: { reason: 'content-type', contentType: 'application/json', declaredLength: expect.any(String) } },
      'csp report refused',
    );
    expect(JSON.stringify(m.warn.mock.calls)).not.toContain('secret');
  });

  it('logs a refusal reason once per window', async () => {
    await send('nope', 'application/csp-report', '203.0.113.3');
    await send('nope', 'application/csp-report', '203.0.113.3');
    expect(m.warn).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 61_000);
    await send('nope', 'application/csp-report', '203.0.113.3');
    expect(m.warn).toHaveBeenCalledTimes(2);
    expect(m.warn.mock.calls[0]![0]).toEqual({ csp: { reason: 'not-json', contentType: 'application/csp-report', declaredLength: '4' } });
  });
});
