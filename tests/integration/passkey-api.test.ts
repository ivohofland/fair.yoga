import { describe, it, expect } from 'vitest';

const BASE_URL = 'http://localhost:3000';

/**
 * The verify route must reject an unsafe redirect at the request boundary
 * — before the challenge is consumed or any session is minted. Proves the
 * route is wired to the strict schema, which the schema unit tests alone
 * cannot show. A bogus challengeId also yields 400, so each assertion
 * checks the error text to pin *which* rejection fired.
 */
describe('POST /api/auth/passkey/authenticate/verify', () => {
  const post = (body: unknown) =>
    fetch(`${BASE_URL}/api/auth/passkey/authenticate/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rejects an absolute redirect with a validation 400', async () => {
    const res = await post({ response: {}, challengeId: 'x', redirect: 'https://evil.com' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('relative path');
  });

  it('rejects a protocol-relative redirect with a validation 400', async () => {
    const res = await post({ response: {}, challengeId: 'x', redirect: '//evil.com' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('relative path');
  });

  it('a safe redirect passes validation and fails only on the challenge', async () => {
    const res = await post({ response: {}, challengeId: 'x', redirect: '/somewhere' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('challenge');
  });
});
