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
  it('asks for the profile, amount and test mode, and answers the ids with Mollie’s descriptions', async () => {
    const { fetchImpl, mollie } = client([
      json(200, { _embedded: { methods: [{ id: 'ideal', description: 'iDEAL' }, { id: 'banktransfer', description: 'Bank transfer' }, { id: 'klarna' }] } }),
    ]);
    const answer = await mollie.listMethods('tok', { profileId: 'pfl_1', amount: { value: '12.50', currency: 'EUR' }, testmode: true });
    expect(answer).toEqual({
      kind: 'methods',
      methods: [
        { id: 'ideal', description: 'iDEAL' },
        { id: 'banktransfer', description: 'Bank transfer' },
        { id: 'klarna', description: null },
      ],
    });
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

describe('the checkout link', () => {
  it.each(['javascript:alert(1)', 'http://www.mollie.com/checkout/x', 'not a url'])('reads %s as no checkout link', async (href) => {
    const { mollie } = client([json(201, { id: 'tr_3', status: 'open', method: 'ideal', amount: { value: '1.00', currency: 'EUR' }, _links: { checkout: { href } } })]);
    const view = await mollie.createPayment('tok', { amount: { value: '1.00', currency: 'EUR' }, description: 'd', method: 'ideal', redirectUrl: 'https://fair.yoga/r', webhookUrl: null, profileId: 'p', metadata: { paymentId: 'a', attemptId: 'b' }, testmode: false });
    expect(view.checkoutUrl).toBeNull();
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
  // A refund Mollie may have made is never answered as refused: the service then reconciles it.
  it('throws MollieUnavailable with the status for a 5xx', async () => {
    const { mollie } = client([json(503, { status: 503, title: 'Service Unavailable' })]);
    const thrown = await mollie.createRefund('tok', 'tr_1', { amount: { value: '10.00', currency: 'EUR' }, testmode: false })
      .then(() => null, (err: unknown) => err);
    expect(thrown).toBeInstanceOf(MollieUnavailable);
    expect((thrown as MollieUnavailable).status).toBe(503);
  });
  it.each([
    ['a body that is not JSON', new Response('<html>ok</html>', { status: 201 })],
    ['a body without a refund id', json(201, { status: 'queued', amount: { value: '10.00', currency: 'EUR' } })],
  ])('throws MollieUnavailable for a 201 with %s', async (_label, response) => {
    const { mollie } = client([response]);
    await expect(mollie.createRefund('tok', 'tr_1', { amount: { value: '10.00', currency: 'EUR' }, testmode: false }))
      .rejects.toBeInstanceOf(MollieUnavailable);
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
    expect(await mollie.revoke('refresh_1')).toBe('revoked');
    expect(String(fetchImpl.mock.calls[0]![1]?.body)).toContain('token_type_hint=refresh_token');
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe('DELETE');
  });
  it('answers invalid_token for a revoke Mollie answers 400', async () => {
    const { mollie } = client([json(400, { error: 'invalid_grant' })]);
    expect(await mollie.revoke('refresh_gone')).toBe('invalid_token');
  });
  it.each([401, 403, 503])('throws MollieUnavailable carrying the status for a revoke answered %i', async (status) => {
    const { mollie } = client([json(status, { error: 'invalid_client' })]);
    await expect(mollie.revoke('refresh_1')).rejects.toMatchObject({ name: 'MollieUnavailable', status });
  });
  it('a 401 on a v2 call throws MollieUnavailable carrying the status', async () => {
    const { mollie } = client([json(401, { status: 401 })]);
    await expect(mollie.organization('tok')).rejects.toMatchObject({ status: 401 });
  });
});

const basicHeader = `Basic ${Buffer.from('app_id:secret').toString('base64')}`;
const amount = { value: '10.00', currency: 'EUR' };
const form = 'application/x-www-form-urlencoded';
const payment = { id: 'tr_1', status: 'open', method: 'ideal', amount, _links: { checkout: { href: 'https://c' } } };

describe('getPayment nullable fields', () => {
  it('reads every optional field given as an explicit null', async () => {
    const { mollie } = client([json(200, {
      id: 'tr_1', status: 'open', method: null, amount, expiresAt: null, paidAt: null,
      amountChargedBack: null, _embedded: null, _links: null,
    })]);
    expect(await mollie.getPayment('tok', 'tr_1', { testmode: false })).toEqual({
      id: 'tr_1', status: 'open', method: null, amount, checkoutUrl: null, expiresAt: null, paidAt: null,
      amountChargedBack: null, refunds: [],
    });
  });
  it('reads null refunds and a null checkout link', async () => {
    const { mollie } = client([json(200, { id: 'tr_1', status: 'open', amount, _embedded: { refunds: null }, _links: { checkout: null } })]);
    const view = await mollie.getPayment('tok', 'tr_1', { testmode: false });
    expect(view?.refunds).toEqual([]);
    expect(view?.checkoutUrl).toBeNull();
  });
  it('asks for test mode only when it is set', async () => {
    const { fetchImpl, mollie } = client([json(200, payment), json(200, payment)]);
    await mollie.getPayment('tok', 'tr_1', { testmode: true });
    await mollie.getPayment('tok', 'tr_1', { testmode: false });
    expect(new URL(String(fetchImpl.mock.calls[0]![0])).searchParams.get('testmode')).toBe('true');
    expect(new URL(String(fetchImpl.mock.calls[1]![0])).searchParams.has('testmode')).toBe(false);
  });
});

describe('outgoing token requests', () => {
  it('refresh posts the refresh token with basic auth as a form', async () => {
    const { fetchImpl, mollie } = client([json(200, { access_token: 'a', refresh_token: 'r2', expires_in: 1, scope: 's' })]);
    await mollie.refresh('refresh_old');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.mollie.com/oauth2/tokens');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(basicHeader);
    expect(headers.get('Content-Type')).toBe(form);
    const body = new URLSearchParams(String(init?.body));
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('refresh_old');
  });
  it('revoke uses basic auth, a form, and the token endpoint', async () => {
    const { fetchImpl, mollie } = client([new Response(null, { status: 204 })]);
    await mollie.revoke('refresh_1');
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.mollie.com/oauth2/tokens');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe(basicHeader);
    expect(headers.get('Content-Type')).toBe(form);
    expect(new URLSearchParams(String(init?.body)).get('token')).toBe('refresh_1');
  });
  it('exchangeCode sends the code and redirect uri', async () => {
    const { fetchImpl, mollie } = client([json(200, { access_token: 'a', refresh_token: 'r', expires_in: 1, scope: 's' })]);
    await mollie.exchangeCode('auth_code', 'https://fair.yoga/cb');
    const body = new URLSearchParams(String(fetchImpl.mock.calls[0]![1]?.body));
    expect(body.get('code')).toBe('auth_code');
    expect(body.get('redirect_uri')).toBe('https://fair.yoga/cb');
  });
  it('exchangeCode throws when a grant carries no refresh token', async () => {
    const { mollie } = client([json(200, { access_token: 'a', expires_in: 1, scope: 's' })]);
    await expect(mollie.exchangeCode('c', 'https://x')).rejects.toBeInstanceOf(MollieUnavailable);
  });
});

describe('outgoing v2 requests', () => {
  it('createPayment posts the full body with a bearer token', async () => {
    const { fetchImpl, mollie } = client([json(201, payment)]);
    await mollie.createPayment('tok', {
      amount, description: 'Hatha', method: 'ideal', redirectUrl: 'https://fair.yoga/r',
      webhookUrl: 'https://fair.yoga/hook', profileId: 'pfl_1', metadata: { paymentId: 'pay_1', attemptId: 'att_1' }, testmode: true,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.mollie.com/v2/payments');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('Authorization')).toBe('Bearer tok');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(init?.body))).toEqual({
      amount, description: 'Hatha', method: 'ideal', redirectUrl: 'https://fair.yoga/r',
      webhookUrl: 'https://fair.yoga/hook', profileId: 'pfl_1', metadata: { paymentId: 'pay_1', attemptId: 'att_1' }, testmode: true,
    });
  });
  it('createRefund answers created for a 201 and posts amount and test mode', async () => {
    const refund = { id: 're_1', status: 'queued', amount };
    const { fetchImpl, mollie } = client([json(201, refund)]);
    expect(await mollie.createRefund('tok', 'tr_1', { amount, testmode: true })).toEqual({ kind: 'created', refund });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.mollie.com/v2/payments/tr_1/refunds');
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
    expect(JSON.parse(String(init?.body))).toEqual({ amount, testmode: true });
  });
  it('createRefund omits testmode when it is false', async () => {
    const { fetchImpl, mollie } = client([json(201, { id: 're_1', status: 'queued', amount })]);
    await mollie.createRefund('tok', 'tr_1', { amount, testmode: false });
    expect(JSON.parse(String(fetchImpl.mock.calls[0]![1]?.body))).toEqual({ amount });
  });
  it('organization reads /v2/organizations/me with a bearer token', async () => {
    const { fetchImpl, mollie } = client([json(200, { id: 'org_1', name: 'Yoga BV' })]);
    expect(await mollie.organization('tok')).toEqual({ id: 'org_1', name: 'Yoga BV' });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.mollie.com/v2/organizations/me');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
  });
  it('profiles reads /v2/profiles with a bearer token', async () => {
    const profile = { id: 'pfl_1', name: 'Shop', mode: 'live', status: 'verified' };
    const { fetchImpl, mollie } = client([json(200, { _embedded: { profiles: [profile] } })]);
    expect(await mollie.profiles('tok')).toEqual([{ ...profile, website: null }]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe('https://api.mollie.com/v2/profiles?limit=250');
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer tok');
  });
  it('profiles carries the website Mollie lists, and null when it lists none', async () => {
    const withSite = { id: 'pfl_1', name: 'Shop', mode: 'live', status: 'verified', website: 'https://zwem.men' };
    const without = { id: 'pfl_2', name: 'Other', mode: 'live', status: 'unverified' };
    const { mollie } = client([json(200, { _embedded: { profiles: [withSite, without] } })]);
    const profiles = await mollie.profiles('tok');
    expect(profiles.map((p) => p.website)).toEqual(['https://zwem.men', null]);
  });
  it('profiles reads an empty, blank, non-string or null website as null and still parses the list', async () => {
    const base = { id: 'pfl_1', name: 'Shop', mode: 'live', status: 'verified' };
    const { mollie } = client([json(200, { _embedded: { profiles: [
      { ...base, website: '' }, { ...base, id: 'pfl_2', website: '  ' }, { ...base, id: 'pfl_3', website: 123 }, { ...base, id: 'pfl_4', website: null }, { ...base, id: 'pfl_5', website: 'https://a.example' },
    ] } })]);
    const profiles = await mollie.profiles('tok');
    expect(profiles.map((p) => [p.id, p.website])).toEqual([['pfl_1', null], ['pfl_2', null], ['pfl_3', null], ['pfl_4', null], ['pfl_5', 'https://a.example']]);
  });
  it.each([403, 503])('a %i on a v2 call throws MollieUnavailable carrying that status', async (status) => {
    const { mollie } = client([json(status, {})]);
    await expect(mollie.organization('tok')).rejects.toMatchObject({ name: 'MollieUnavailable', status });
  });
});

describe('timeout', () => {
  it('passes an abort signal to fetch', async () => {
    const { fetchImpl, mollie } = client([json(200, { id: 'org_1', name: 'n' })]);
    await mollie.organization('tok');
    expect(fetchImpl.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
  });
  it('rejects with MollieUnavailable when a fetch honouring the signal never answers', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    const mollie = createMollieClient({ clientId: 'a', clientSecret: 'b' }, { fetchImpl, timeoutMs: 50 });
    await expect(mollie.organization('tok')).rejects.toMatchObject({ name: 'MollieUnavailable', status: null });
  });
});
