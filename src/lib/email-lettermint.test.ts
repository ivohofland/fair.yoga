import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { deliverViaLettermint, type LettermintPayload } from './email-lettermint';

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const base: LettermintPayload = {
  from: 'noreply@fair.yoga', to: 'a@test.local', subject: 'Hi', html: '<p>Hi</p>', text: 'Hi',
};
const accepted = () => new Response(JSON.stringify({ message_id: 'm1', status: 'pending' }), { status: 202 });
const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0]![1]!.body)) as Record<string, unknown>;
const sentHeaders = () => new Headers(fetchMock.mock.calls[0]![1]!.headers);

describe('deliverViaLettermint', () => {
  it('posts to the send endpoint with the token header and answers ok on 202', async () => {
    fetchMock.mockResolvedValue(accepted());
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: true });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.lettermint.co/v1/send');
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('POST');
    expect(sentHeaders().get('x-lettermint-token')).toBe('lm_tok');
    expect(sentHeaders().get('content-type')).toBe('application/json');
  });

  it('sends to as an array, text and html, and omits absent optional fields', async () => {
    fetchMock.mockResolvedValue(accepted());
    await deliverViaLettermint(base, 'lm_tok');
    expect(sentBody()).toEqual({ from: 'noreply@fair.yoga', to: ['a@test.local'], subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' });
  });

  it('sends reply_to as an array, route and headers as given', async () => {
    fetchMock.mockResolvedValue(accepted());
    await deliverViaLettermint(
      { ...base, replyTo: 'hello@fair.yoga', route: 'class-mail', headers: { 'List-Unsubscribe': '<https://x>' } },
      'lm_tok',
    );
    expect(sentBody()).toMatchObject({
      reply_to: ['hello@fair.yoga'], route: 'class-mail', headers: { 'List-Unsubscribe': '<https://x>' },
    });
  });

  it('answers ok on a 202 whose body is empty or not JSON', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 202 }));
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: true });
  });

  it.each([
    ['{ message }', { message: 'Unauthenticated.' }, 401, 'lettermint 401: Unauthenticated.'],
    ['{ error: { code, message } }', { error: { code: 'RATE_LIMITED', message: 'Slow down' } }, 429, 'lettermint 429: Slow down'],
    ['{ message, errors }', { message: 'The given data was invalid.', errors: { reply_to: ['bad'], subject: ['bad'] } }, 422,
      'lettermint 422: The given data was invalid. (reply_to, subject)'],
  ])('answers ok:false with the message from a %s error body', async (_shape, body, status, reason) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status }));
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: false, reason });
  });

  it('answers with the status text, never the body, for a non-JSON error', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad Gateway page</html>', { status: 502, statusText: 'Bad Gateway' }));
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: false, reason: 'lettermint 502: Bad Gateway' });
  });

  it('answers ok:false when fetch rejects', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: false, reason: 'lettermint request failed (TypeError)' });
  });

  it('never puts the rejection message, which can carry the token, into the reason', async () => {
    fetchMock.mockRejectedValue(new TypeError('Headers.append: "lm_ab\ncd" is an invalid header value.'));
    const result = await deliverViaLettermint(base, 'lm_ab\ncd');
    expect(result).toEqual({ ok: false, reason: 'lettermint request failed (TypeError)' });
    expect(JSON.stringify(result)).not.toContain('lm_ab');
  });

  it('names a non-Error rejection as unknown', async () => {
    fetchMock.mockRejectedValue('nope');
    expect(await deliverViaLettermint(base, 'lm_tok')).toEqual({ ok: false, reason: 'lettermint request failed (unknown)' });
  });

  it('aborts a request that never answers and answers ok:false', async () => {
    fetchMock.mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason));
    }));
    const result = await deliverViaLettermint(base, 'lm_tok', { timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/^lettermint request failed \(\w+\)$/);
  });

  describe('idempotency', () => {
    it('sends no Idempotency-Key without a key', async () => {
      fetchMock.mockResolvedValue(accepted());
      await deliverViaLettermint(base, 'lm_tok');
      expect(sentHeaders().has('idempotency-key')).toBe(false);
    });

    it('sends the key salted with a hash of the exact body sent', async () => {
      fetchMock.mockResolvedValue(accepted());
      await deliverViaLettermint({ ...base, idempotencyKey: 'notification-abc' }, 'lm_tok');
      const body = String(fetchMock.mock.calls[0]![1]!.body);
      const hash = createHash('sha256').update(body).digest('hex').slice(0, 16);
      expect(sentHeaders().get('idempotency-key')).toBe(`notification-abc-${hash}`);
      expect(JSON.parse(body)).not.toHaveProperty('idempotencyKey');
    });

    it('sends a different key when the body differs, the same key when it does not', async () => {
      fetchMock.mockImplementation(async () => accepted());
      await deliverViaLettermint({ ...base, idempotencyKey: 'k' }, 'lm_tok');
      await deliverViaLettermint({ ...base, idempotencyKey: 'k' }, 'lm_tok');
      await deliverViaLettermint({ ...base, html: '<p>Changed</p>', idempotencyKey: 'k' }, 'lm_tok');
      const keys = fetchMock.mock.calls.map(([, init]) => new Headers(init!.headers).get('idempotency-key'));
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });
  });
});
