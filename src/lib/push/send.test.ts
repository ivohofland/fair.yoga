import { describe, it, expect, vi } from 'vitest';
import { createDecipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { sendPush, PUSH_TTL_SECONDS } from './send';
import { encryptPayload } from './encrypt';
import { REDACTED_BODY, buildPushPayload } from '../push-policy';

// The real encryption, wrapped so one test can make it throw something other
// than InvalidSubscriptionKeysError.
vi.mock('./encrypt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./encrypt')>();
  return { ...actual, encryptPayload: vi.fn(actual.encryptPayload) };
});

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

/**
 * The browser's side of RFC 8291: decrypts one `aes128gcm` record with the
 * user agent's private key and auth secret, and drops the padding delimiter.
 */
function decryptAsUserAgent(body: Uint8Array, ua: ECDH, authSecret: Buffer): string {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const idLength = buf.readUInt8(20);
  const asPublic = buf.subarray(21, 21 + idLength);
  const ciphertext = buf.subarray(21 + idLength);
  const info = (label: string) => Buffer.from(`${label}\0`, 'latin1');
  const ecdhSecret = ua.computeSecret(asPublic);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, Buffer.concat([info('WebPush: info'), ua.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, info('Content-Encoding: aes128gcm'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, info('Content-Encoding: nonce'), 12));
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const padded = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);
  expect(padded[padded.length - 1]).toBe(2);
  return padded.subarray(0, padded.length - 1).toString('utf8');
}

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

  it('signs for the endpoint origin and encrypts exactly the JSON payload to the browser key', async () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const authSecret = randomBytes(16);
    const pushTarget = {
      endpoint: 'https://fcm.googleapis.com/fcm/send/device-token',
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: authSecret.toString('base64url'),
    };
    const fetchImpl = fetchReturning(201);
    await sendPush(pushTarget, payload, keys(), { urgency: 'normal', fetchImpl });

    const init = fetchImpl.mock.calls[0]![1]!;
    const [, jwt] = /^vapid t=([^,]+), k=/.exec(new Headers(init.headers).get('Authorization') ?? '') ?? [];
    const claims = JSON.parse(Buffer.from(jwt!.split('.')[1]!, 'base64url').toString()) as { aud: string };
    expect(claims.aud).toBe('https://fcm.googleapis.com');
    expect(decryptAsUserAgent(init.body as Uint8Array, ua, authSecret)).toBe(JSON.stringify(payload));
  });

  it.each([404, 410])('reports %i as gone', async (status) => {
    expect((await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl: fetchReturning(status) })).outcome).toBe('gone');
  });

  it.each([400, 413, 429, 500, 503])('reports %i with an empty body as failed, never throwing', async (status) => {
    expect(await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl: fetchReturning(status) })).toEqual({ outcome: 'failed', status });
  });

  it('follows no redirect: a 307 is failed after exactly one request', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 307, headers: { Location: 'http://127.0.0.1:5432/' } }));
    const result = await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl });
    expect(result.outcome).toBe('failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]![1]?.redirect).toBe('manual');
  });

  it('reports a network error as failed, carrying its name and message as the cause', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl })).toEqual({
      outcome: 'failed',
      status: null,
      cause: 'TypeError: fetch failed',
    });
  });

  it('carries the start of a failed response body as the reason', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('x'.repeat(150) + 'y'.repeat(150), { status: 403 }));
    expect(await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl })).toEqual({
      outcome: 'failed',
      status: 403,
      reason: 'x'.repeat(150) + 'y'.repeat(50),
    });
  });

  it('reports a stored p256dh that is off the curve as invalid, without a request', async () => {
    const fetchImpl = fetchReturning(201);
    const offCurve = { ...target(), p256dh: Buffer.alloc(65, 4).toString('base64url') };
    expect(await sendPush(offCurve, payload, keys(), { urgency: 'normal', fetchImpl })).toEqual({ outcome: 'invalid', status: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports stored keys of the wrong length as invalid', async () => {
    const fetchImpl = fetchReturning(201);
    const short = { ...target(), auth: Buffer.alloc(15, 1).toString('base64url') };
    expect(await sendPush(short, payload, keys(), { urgency: 'normal', fetchImpl })).toEqual({ outcome: 'invalid', status: null });
  });

  it('lets an encryption fault that is not about the keys propagate', async () => {
    const fetchImpl = fetchReturning(201);
    const fault = new Error('cipher unavailable');
    vi.mocked(encryptPayload).mockImplementationOnce(() => {
      throw fault;
    });
    await expect(sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl })).rejects.toBe(fault);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('lets a signing fault propagate rather than reporting an outcome', async () => {
    const fetchImpl = fetchReturning(201);
    // A public key off the curve: the JWK import that signs the VAPID token throws.
    const broken = { ...keys(), publicKey: Buffer.alloc(65, 4).toString('base64url') };
    await expect(sendPush(target(), payload, broken, { urgency: 'normal', fetchImpl })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('gives up on a hanging push service after timeoutMs', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason))));
    const started = Date.now();
    const result = await sendPush(target(), payload, keys(), { urgency: 'normal', fetchImpl, timeoutMs: 50 });
    expect(result.outcome).toBe('failed');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps a payload dense in JSON-escaped characters under the 4096-byte push limit', async () => {
    const fetchImpl = fetchReturning(201);
    const dense = '\u0001'.repeat(1500);
    const big = buildPushPayload({ id: 'n1', recipientType: 'student', type: 'announcement', title: dense, body: dense });
    await sendPush(target(), big, keys(), { urgency: 'normal', fetchImpl });
    const body = fetchImpl.mock.calls[0]![1]!.body as Uint8Array;
    expect(body.byteLength).toBeLessThanOrEqual(4096);
  });

  it('keeps the largest possible payload under the 4096-byte push limit', async () => {
    const fetchImpl = fetchReturning(201);
    const big = buildPushPayload({ id: 'n1', recipientType: 'student', type: 'announcement', title: '€'.repeat(2000), body: '€'.repeat(2000) });
    await sendPush(target(), big, keys(), { urgency: 'normal', fetchImpl });
    const body = fetchImpl.mock.calls[0]![1]!.body as Uint8Array;
    expect(body.byteLength).toBeLessThanOrEqual(4096);
  });
});
