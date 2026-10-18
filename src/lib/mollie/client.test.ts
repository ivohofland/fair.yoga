import { describe, it, expect, vi } from 'vitest';
import { createMollieClient, MollieUnavailable } from './client';

function client(responses: Response[]) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const r of responses) fetchImpl.mockResolvedValueOnce(r);
  return { fetchImpl, mollie: createMollieClient({ clientId: 'app_id', clientSecret: 'secret' }, { fetchImpl, timeoutMs: 50 }) };
}
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/hal+json' } });

describe('exchangeCode', () => {
  it('posts the code with basic auth and answers the grant', async () => {
    const { fetchImpl, mollie } = client([json(200, {
      access_token: 'access_1', refresh_token: 'refresh_1', expires_in: 3600, token_type: 'bearer', scope: 'payments.read payments.write',
    })]);
    const answer = await mollie.exchangeCode('auth_code', 'https://fair.yoga/api/processor/mollie/callback');
    expect(answer).toEqual({ kind: 'granted', grant: { accessToken: 'access_1', refreshToken: 'refresh_1', expiresInSeconds: 3600, scopes: ['payments.read', 'payments.write'] } });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.mollie.com/oauth2/tokens');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Basic ${Buffer.from('app_id:secret').toString('base64')}`);
    expect(String(init?.body)).toContain('grant_type=authorization_code');
  });
  it('answers invalid_grant for a 400 invalid_grant', async () => {
    const { mollie } = client([json(400, { error: 'invalid_grant', error_description: 'expired' })]);
    expect(await mollie.exchangeCode('c', 'https://x')).toEqual({ kind: 'invalid_grant' });
  });
});

describe('refresh', () => {
  it('keeps the old refresh token when Mollie returns none', async () => {
    const { mollie } = client([json(200, { access_token: 'a2', expires_in: 3600, token_type: 'bearer', scope: 'payments.read' })]);
    const answer = await mollie.refresh('refresh_old');
    expect(answer.kind === 'granted' && answer.grant.refreshToken).toBe('refresh_old');
  });
  it('answers invalid_grant when access was revoked', async () => {
    const { mollie } = client([json(400, { error: 'invalid_grant' })]);
    expect(await mollie.refresh('r')).toEqual({ kind: 'invalid_grant' });
  });
  it('throws MollieUnavailable on a 503', async () => {
    const { mollie } = client([json(503, {})]);
    await expect(mollie.refresh('r')).rejects.toBeInstanceOf(MollieUnavailable);
  });
});

describe('listMethods', () => {
  it('asks for the profile, amount and test mode, and answers the ids', async () => {
    const { fetchImpl, mollie } = client([json(200, { _embedded: { methods: [{ id: 'ideal' }, { id: 'klarna' }] } })]);
    const answer = await mollie.listMethods('tok', { profileId: 'pfl_1', amount: { value: '12.50', currency: 'EUR' }, testmode: true });
    expect(answer).toEqual({ kind: 'methods', ids: ['ideal', 'klarna'] });
    const url = new URL(String(fetchImpl.mock.calls[0]![0]));
    expect(url.pathname).toBe('/v2/methods');
    expect(url.searchParams.get('profileId')).toBe('pfl_1');
    expect(url.searchParams.get('amount[value]')).toBe('12.50');
    expect(url.searchParams.get('amount[currency]')).toBe('EUR');
    expect(url.searchParams.get('testmode')).toBe('true');
    expect(new Headers(fetchImpl.mock.calls[0]![1]?.headers).get('Authorization')).toBe('Bearer tok');
  });
  it('answers unsupported for a 422', async () => {
    const { mollie } = client([json(422, { status: 422, title: 'Unprocessable Entity', detail: 'currency not supported', field: 'amount.currency' })]);
    expect(await mollie.listMethods('tok', { profileId: 'p', amount: { value: '1.00', currency: 'AED' }, testmode: false })).toEqual({ kind: 'unsupported' });
  });
  it('throws MollieUnavailable when fetch rejects (timeout, network)', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
    const mollie = createMollieClient({ clientId: 'a', clientSecret: 'b' }, { fetchImpl });
    await expect(mollie.listMethods('t', { profileId: 'p', amount: { value: '1.00', currency: 'EUR' }, testmode: false })).rejects.toBeInstanceOf(MollieUnavailable);
  });
});

describe('createPayment', () => {
  it('sends one method, no applicationFee, and reads the checkout link', async () => {
    const { fetchImpl, mollie } = client([json(201, {
      id: 'tr_1', status: 'open', method: 'ideal', amount: { value: '10.00', currency: 'EUR' },
      expiresAt: '2026-10-18T12:15:00+00:00', paidAt: null, _links: { checkout: { href: 'https://www.mollie.com/checkout/x' } },
    })]);
    const view = await mollie.createPayment('tok', {
      amount: { value: '10.00', currency: 'EUR' }, description: 'Hatha Sat 18 Oct', method: 'ideal',
      redirectUrl: 'https://fair.yoga/r', webhookUrl: 'https://fair.yoga/api/webhooks/mollie', profileId: 'pfl_1',
      metadata: { paymentId: 'pay_1', attemptId: 'att_1' }, testmode: false,
    });
    expect(view).toMatchObject({ id: 'tr_1', status: 'open', checkoutUrl: 'https://www.mollie.com/checkout/x', refunds: [] });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body.method).toBe('ideal');
    expect(body).not.toHaveProperty('applicationFee');
    expect(body).not.toHaveProperty('testmode');
  });
  it('omits webhookUrl when it is null', async () => {
    const { fetchImpl, mollie } = client([json(201, { id: 'tr_2', status: 'open', method: 'ideal', amount: { value: '1.00', currency: 'EUR' }, _links: { checkout: { href: 'https://c' } } })]);
    await mollie.createPayment('tok', { amount: { value: '1.00', currency: 'EUR' }, description: 'd', method: 'ideal', redirectUrl: 'http://localhost:3000/r', webhookUrl: null, profileId: 'p', metadata: { paymentId: 'a', attemptId: 'b' }, testmode: true });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('webhookUrl');
    expect(body.testmode).toBe(true);
  });
});

describe('getPayment', () => {
  it('embeds refunds', async () => {
    const { fetchImpl, mollie } = client([json(200, {
      id: 'tr_1', status: 'paid', method: 'ideal', amount: { value: '10.00', currency: 'EUR' }, paidAt: '2026-10-18T12:05:00+00:00',
      _embedded: { refunds: [{ id: 're_1', status: 'queued', amount: { value: '10.00', currency: 'EUR' } }] }, _links: {},
    })]);
    const view = await mollie.getPayment('tok', 'tr_1', { testmode: false });
    expect(view?.refunds).toEqual([{ id: 're_1', status: 'queued', amount: { value: '10.00', currency: 'EUR' } }]);
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get('embed')).toBe('refunds');
  });
  it('reads amountChargedBack, and null when Mollie omits it', async () => {
    const { mollie } = client([
      json(200, { id: 'tr_1', status: 'paid', method: 'ideal', amount: { value: '10.00', currency: 'EUR' }, amountChargedBack: { value: '4.00', currency: 'EUR' }, _links: {} }),
      json(200, { id: 'tr_2', status: 'paid', method: 'ideal', amount: { value: '10.00', currency: 'EUR' }, _links: {} }),
    ]);
    expect((await mollie.getPayment('tok', 'tr_1', { testmode: false }))?.amountChargedBack).toEqual({ value: '4.00', currency: 'EUR' });
    expect((await mollie.getPayment('tok', 'tr_2', { testmode: false }))?.amountChargedBack).toBeNull();
  });
  it('answers null for a 404', async () => {
    const { mollie } = client([json(404, { status: 404 })]);
    expect(await mollie.getPayment('tok', 'tr_x', { testmode: false })).toBeNull();
  });
});

describe('createRefund', () => {
  it('answers refused with Mollie\'s detail for a 422', async () => {
    const { mollie } = client([json(422, { status: 422, detail: 'Insufficient balance', field: null })]);
    expect(await mollie.createRefund('tok', 'tr_1', { amount: { value: '10.00', currency: 'EUR' }, testmode: false }))
      .toEqual({ kind: 'refused', detail: 'Insufficient balance', field: null });
  });
});

describe('authorizeUrl', () => {
  it('forces the consent prompt only on a reconnect', () => {
    const { mollie } = client([]);
    const input = { redirectUri: 'https://fair.yoga/api/processor/mollie/callback', state: 's1', scopes: ['payments.read', 'refunds.write'] };
    const first = new URL(mollie.authorizeUrl({ ...input, forcePrompt: false }));
    expect(first.origin + first.pathname).toBe('https://my.mollie.com/oauth2/authorize');
    expect(first.searchParams.get('scope')).toBe('payments.read refunds.write');
    expect(first.searchParams.get('response_type')).toBe('code');
    expect(first.searchParams.has('approval_prompt')).toBe(false);
    expect(new URL(mollie.authorizeUrl({ ...input, forcePrompt: true })).searchParams.get('approval_prompt')).toBe('force');
  });
});

describe('revoke and a 401', () => {
  it('revokes the refresh token', async () => {
    const { fetchImpl, mollie } = client([new Response(null, { status: 204 })]);
    await mollie.revoke('refresh_1');
    expect(String(fetchImpl.mock.calls[0]![1]?.body)).toContain('token_type_hint=refresh_token');
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('DELETE');
  });
  it('a 401 on a v2 call throws MollieUnavailable carrying the status', async () => {
    const { mollie } = client([json(401, { status: 401 })]);
    await expect(mollie.organization('tok')).rejects.toMatchObject({ status: 401 });
  });
});
