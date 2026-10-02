import { describe, it, expect, vi } from 'vitest';
import { createECDH, randomBytes } from 'node:crypto';
import { sendPush, PUSH_TTL_SECONDS } from './send';
import { REDACTED_BODY, buildPushPayload } from '../push-policy';

function keys() {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { publicKey: e.getPublicKey().toString('base64url'), privateKey: e.getPrivateKey().toString('base64url'), subject: 'mailto:ops@fair.yoga' };
}
function target() {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  return { endpoint: 'https://push.example.net/abc', p256dh: ua.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') };
}
const payload = { id: 'n1', title: 'A spot opened up', body: REDACTED_BODY, url: '/updates?n=n1' };

function fetchReturning(status: number) {
  return vi.fn<typeof fetch>(async () => new Response(null, { status }));
}

describe('sendPush', () => {
  it('POSTs an aes128gcm body with VAPID auth, TTL and urgency', async () => {
    const fetchImpl = fetchReturning(201);
    const result = await sendPush(target(), payload, keys(), { urgency: 'high', fetchImpl });
    expect(result).toEqual({ outcome: 'delivered', status: 201 });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://push.example.net/abc');
    expect(init?.method).toBe('POST');
    const h = new Headers(init?.headers);
    expect(h.get('Content-Encoding')).toBe('aes128gcm');
    expect(h.get('TTL')).toBe(String(PUSH_TTL_SECONDS));
    expect(h.get('Urgency')).toBe('high');
    expect(h.get('Authorization')).toMatch(/^vapid t=.+, k=.+$/);
  });

  it.each([404, 410])('reports %i as gone', async (status) => {
    expect((await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl: fetchReturning(status) })).outcome).toBe('gone');
  });

  it.each([400, 413, 429, 500, 503])('reports %i as failed, never throwing', async (status) => {
    expect(await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl: fetchReturning(status) })).toEqual({ outcome: 'failed', status });
  });

  it('reports a network error as failed', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl })).toEqual({ outcome: 'failed', status: null });
  });

  it('gives up on a hanging push service after timeoutMs', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const started = Date.now();
    const result = await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl, timeoutMs: 50 });
    expect(result.outcome).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps the largest possible payload under the 4096-byte push limit', async () => {
    const fetchImpl = fetchReturning(201);
    const big = buildPushPayload({ id: 'n1', recipientType: 'student', type: 'announcement', title: '€'.repeat(2000), body: '€'.repeat(2000) });
    await sendPush(target(), big, keys(), { urgency: 'normal', fetchImpl });
    const body = fetchImpl.mock.calls[0]![1]!.body as Uint8Array;
    expect(body.byteLength).toBeLessThanOrEqual(4096);
  });
});
