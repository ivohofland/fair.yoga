import { describe, it, expect } from 'vitest';
import { BASE_URL, freshIp } from '../helpers';
import { expectRefusal } from '../api-assertions';

const URL_ = `${BASE_URL}/api/csp-report`;
const REPORT = JSON.stringify({
  'csp-report': {
    'document-uri': `${BASE_URL}/login?token=abc`,
    'effective-directive': 'script-src-elem',
    'blocked-uri': 'inline',
    disposition: 'enforce',
  },
});

function send(body: string, headers: Record<string, string> = {}, ip = freshIp()): Promise<Response> {
  return fetch(URL_, { method: 'POST', headers: { 'content-type': 'application/csp-report', ...ip, ...headers }, body });
}

describe('POST /api/csp-report', () => {
  it('accepts a CSP report with 204', async () => {
    const res = await send(REPORT);
    expect(res.status).toBe(204);
  });

  it('refuses any other content type with 415', async () => {
    await expectRefusal(await send(REPORT, { 'content-type': 'application/json' }), 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('refuses an oversized body with 400', async () => {
    const big = JSON.stringify({ 'csp-report': { 'effective-directive': 'img-src', pad: 'x'.repeat(9000) } });
    expect((await send(big)).status).toBe(400);
  });

  it('refuses a body sent without a Content-Length with 400', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(REPORT));
        controller.close();
      },
    });
    const res = await fetch(URL_, {
      method: 'POST',
      headers: { 'content-type': 'application/csp-report', ...freshIp() },
      body: stream,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(res.status).toBe(400);
  });

  it('refuses a body that is not a report with 400', async () => {
    expect((await send('not json')).status).toBe(400);
    expect((await send(JSON.stringify({ 'csp-report': {} }))).status).toBe(400);
  });

  it('refuses a cross-site report like any other write', async () => {
    await expectRefusal(await send(REPORT, { origin: 'https://evil.example' }), 'CROSS_ORIGIN');
  });

  it('rate-limits one address', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await send(REPORT, {}, ip)).status);
    expect(statuses.slice(0, 60).every((s) => s === 204)).toBe(true);
    expect(statuses[60]).toBe(429);
  });

  it('is where the page policy sends reports', async () => {
    const res = await fetch(`${BASE_URL}/login`, { headers: freshIp() });
    expect(res.headers.get('content-security-policy')).toContain('report-uri /api/csp-report');
  });
});
