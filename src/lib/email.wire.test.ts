import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sendEmail } from './email';

// Nothing here mocks the adapter: the request that reaches `fetch` is the one
// Lettermint would receive.
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const content = { subject: 'S', html: '<p>H</p>', text: 'H' };
const fetchMock = vi.fn<typeof fetch>();

const ENV_NAMES = ['LETTERMINT_API_TOKEN', 'LETTERMINT_CLASS_ROUTE', 'EMAIL_REPLY_TO', 'EMAIL_FROM', 'EMAIL_DRY_RUN'] as const;
const saved: Partial<Record<(typeof ENV_NAMES)[number], string | undefined>> = {};

beforeEach(() => {
  for (const name of ENV_NAMES) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  process.env.LETTERMINT_API_TOKEN = 'lm_wire';
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    const value = saved[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.unstubAllGlobals();
});

function sentRequest(): { url: string; headers: Record<string, string>; body: Record<string, unknown> } {
  const call = fetchMock.mock.calls.at(-1);
  if (call === undefined) throw new Error('fetch not called');
  const [url, init] = call;
  const headers = init?.headers as Record<string, string>;
  return { url: String(url), headers, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
}

describe('sendEmail on the wire', () => {
  it('posts platform mail to Lettermint with the token and Reply-To', async () => {
    const result = await sendEmail({ to: 'a@test.local', audience: 'platform', content });

    expect(result).toEqual({ ok: true, delivery: 'sent' });
    const { url, headers, body } = sentRequest();
    expect(url).toBe('https://api.lettermint.co/v1/send');
    expect(headers['x-lettermint-token']).toBe('lm_wire');
    expect(body).toMatchObject({ to: ['a@test.local'], reply_to: ['hello@fair.yoga'], text: 'H' });
    expect(body).not.toHaveProperty('route');
  });

  it('posts class mail on the class route with no reply_to', async () => {
    process.env.LETTERMINT_CLASS_ROUTE = 'class-mail';

    await sendEmail({ to: 'a@test.local', audience: 'class', content });

    const { body } = sentRequest();
    expect(body.route).toBe('class-mail');
    expect(body).not.toHaveProperty('reply_to');
  });
});
