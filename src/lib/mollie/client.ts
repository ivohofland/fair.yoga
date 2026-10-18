import 'server-only';
import { z } from 'zod';

const API = 'https://api.mollie.com';
const AUTHORIZE = 'https://my.mollie.com/oauth2/authorize';
const DEFAULT_TIMEOUT_MS = 8_000;

/**
 * Mollie could not give an answer this call can act on: a network error, a
 * timeout, a 5xx, an unexpected shape, or a 401/403 on a `/v2` call (the token
 * service decides what that means). `status` is null when no response arrived.
 */
export class MollieUnavailable extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'MollieUnavailable';
  }
}

export type MollieAmount = { value: string; currency: string };
export type TokenGrant = { accessToken: string; refreshToken: string; expiresInSeconds: number; scopes: string[] };
export type TokenAnswer = { kind: 'granted'; grant: TokenGrant } | { kind: 'invalid_grant' };
export type MollieProfile = { id: string; name: string; mode: 'live' | 'test'; status: string };
export type MethodsAnswer = { kind: 'methods'; ids: string[] } | { kind: 'unsupported' };
export type MollieRefundView = { id: string; status: string; amount: MollieAmount };
export type MolliePaymentView = {
  id: string;
  status: string;
  method: string | null;
  amount: MollieAmount;
  checkoutUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
  amountChargedBack: MollieAmount | null;
  refunds: MollieRefundView[];
};
export type CreatePaymentInput = {
  amount: MollieAmount;
  description: string;
  method: string;
  redirectUrl: string;
  webhookUrl: string | null;
  profileId: string;
  metadata: { paymentId: string; attemptId: string };
  testmode: boolean;
};
export type RefundAnswer =
  | { kind: 'created'; refund: MollieRefundView }
  | { kind: 'refused'; detail: string; field: string | null };

export interface MollieClient {
  authorizeUrl(input: { redirectUri: string; state: string; scopes: readonly string[]; forcePrompt: boolean }): string;
  exchangeCode(code: string, redirectUri: string): Promise<TokenAnswer>;
  refresh(refreshToken: string): Promise<TokenAnswer>;
  revoke(refreshToken: string): Promise<void>;
  organization(accessToken: string): Promise<{ id: string; name: string }>;
  profiles(accessToken: string): Promise<MollieProfile[]>;
  listMethods(accessToken: string, q: { profileId: string; amount: MollieAmount; testmode: boolean }): Promise<MethodsAnswer>;
  createPayment(accessToken: string, input: CreatePaymentInput): Promise<MolliePaymentView>;
  getPayment(accessToken: string, id: string, q: { testmode: boolean }): Promise<MolliePaymentView | null>;
  createRefund(accessToken: string, paymentId: string, q: { amount: MollieAmount; testmode: boolean }): Promise<RefundAnswer>;
}

const amountSchema = z.object({ value: z.string(), currency: z.string() });
const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
  scope: z.string(),
});
const oauthErrorSchema = z.object({ error: z.string() });
const errorSchema = z.object({ detail: z.string().optional(), field: z.string().nullable().optional() });
const refundSchema = z.object({ id: z.string(), status: z.string(), amount: amountSchema });
const paymentSchema = z.object({
  id: z.string(),
  status: z.string(),
  method: z.string().nullish(),
  amount: amountSchema,
  expiresAt: z.string().nullish(),
  paidAt: z.string().nullish(),
  amountChargedBack: amountSchema.nullish(),
  _embedded: z.object({ refunds: z.array(refundSchema).nullish() }).nullish(),
  _links: z.object({ checkout: z.object({ href: z.string() }).nullish() }).nullish(),
});
const methodsSchema = z.object({ _embedded: z.object({ methods: z.array(z.object({ id: z.string() })) }) });
const orgSchema = z.object({ id: z.string(), name: z.string() });
const profilesSchema = z.object({
  _embedded: z.object({
    profiles: z.array(z.object({ id: z.string(), name: z.string(), mode: z.enum(['live', 'test']), status: z.string() })),
  }),
});

function toView(p: z.infer<typeof paymentSchema>): MolliePaymentView {
  return {
    id: p.id,
    status: p.status,
    method: p.method ?? null,
    amount: p.amount,
    checkoutUrl: p._links?.checkout?.href ?? null,
    expiresAt: p.expiresAt ?? null,
    paidAt: p.paidAt ?? null,
    amountChargedBack: p.amountChargedBack ?? null,
    refunds: p._embedded?.refunds ?? [],
  };
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function createMollieClient(
  credentials: { clientId: string; clientSecret: string },
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): MollieClient {
  const { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const basic = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`;

  async function send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      throw new MollieUnavailable('Mollie did not answer', null, { cause });
    }
  }

  function unavailable(res: Response): MollieUnavailable {
    return new MollieUnavailable(`Mollie answered ${res.status}`, res.status);
  }

  async function parse<S extends z.ZodType>(schema: S, res: Response): Promise<z.infer<S>> {
    const parsed = schema.safeParse(await readJson(res));
    if (!parsed.success) throw new MollieUnavailable('unexpected response shape', res.status);
    return parsed.data;
  }

  async function token(form: URLSearchParams, method: 'POST' | 'DELETE'): Promise<Response> {
    return send(`${API}/oauth2/tokens`, {
      method,
      headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  }

  async function answerGrant(res: Response, fallbackRefreshToken: string | null): Promise<TokenAnswer> {
    if (res.ok) {
      const body = await parse(tokenSchema, res);
      const refreshToken = body.refresh_token ?? fallbackRefreshToken;
      if (refreshToken === null) throw new MollieUnavailable('unexpected response shape', res.status);
      return {
        kind: 'granted',
        grant: {
          accessToken: body.access_token,
          refreshToken,
          expiresInSeconds: body.expires_in,
          scopes: body.scope.split(' ').filter((s) => s !== ''),
        },
      };
    }
    if (res.status === 400) {
      const parsed = oauthErrorSchema.safeParse(await readJson(res));
      if (parsed.success && parsed.data.error === 'invalid_grant') return { kind: 'invalid_grant' };
    }
    throw unavailable(res);
  }

  async function v2(accessToken: string, path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${accessToken}`);
    const res = await send(`${API}${path}`, { ...init, headers });
    if (res.status >= 500 || res.status === 401 || res.status === 403) throw unavailable(res);
    return res;
  }

  const jsonHeaders = { 'Content-Type': 'application/json' };

  return {
    authorizeUrl({ redirectUri, state, scopes, forcePrompt }) {
      const url = new URL(AUTHORIZE);
      url.searchParams.set('client_id', credentials.clientId);
      url.searchParams.set('redirect_uri', redirectUri);
      url.searchParams.set('state', state);
      url.searchParams.set('scope', scopes.join(' '));
      url.searchParams.set('response_type', 'code');
      if (forcePrompt) url.searchParams.set('approval_prompt', 'force');
      return url.toString();
    },

    async exchangeCode(code, redirectUri) {
      const res = await token(
        new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
        'POST',
      );
      return answerGrant(res, null);
    },

    async refresh(refreshToken) {
      const res = await token(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }), 'POST');
      return answerGrant(res, refreshToken);
    },

    async revoke(refreshToken) {
      const res = await token(new URLSearchParams({ token_type_hint: 'refresh_token', token: refreshToken }), 'DELETE');
      if (!res.ok) throw unavailable(res);
    },

    async organization(accessToken) {
      const res = await v2(accessToken, '/v2/organizations/me');
      if (!res.ok) throw unavailable(res);
      return parse(orgSchema, res);
    },

    async profiles(accessToken) {
      const res = await v2(accessToken, '/v2/profiles?limit=250');
      if (!res.ok) throw unavailable(res);
      return (await parse(profilesSchema, res))._embedded.profiles;
    },

    async listMethods(accessToken, q) {
      const params = new URLSearchParams({
        profileId: q.profileId,
        'amount[value]': q.amount.value,
        'amount[currency]': q.amount.currency,
      });
      if (q.testmode) params.set('testmode', 'true');
      const res = await v2(accessToken, `/v2/methods?${params.toString()}`);
      if (res.status === 422) return { kind: 'unsupported' };
      if (!res.ok) throw unavailable(res);
      return { kind: 'methods', ids: (await parse(methodsSchema, res))._embedded.methods.map((m) => m.id) };
    },

    async createPayment(accessToken, input) {
      const body: Record<string, unknown> = {
        amount: input.amount,
        description: input.description,
        method: input.method,
        redirectUrl: input.redirectUrl,
        profileId: input.profileId,
        metadata: input.metadata,
      };
      if (input.webhookUrl !== null) body.webhookUrl = input.webhookUrl;
      if (input.testmode) body.testmode = true;
      const res = await v2(accessToken, '/v2/payments', {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      if (!res.ok) throw unavailable(res);
      return toView(await parse(paymentSchema, res));
    },

    async getPayment(accessToken, id, q) {
      const params = new URLSearchParams({ embed: 'refunds' });
      if (q.testmode) params.set('testmode', 'true');
      const res = await v2(accessToken, `/v2/payments/${encodeURIComponent(id)}?${params.toString()}`);
      if (res.status === 404) return null;
      if (!res.ok) throw unavailable(res);
      return toView(await parse(paymentSchema, res));
    },

    async createRefund(accessToken, paymentId, q) {
      const body: Record<string, unknown> = { amount: q.amount };
      if (q.testmode) body.testmode = true;
      const res = await v2(accessToken, `/v2/payments/${encodeURIComponent(paymentId)}/refunds`, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify(body),
      });
      if (res.status === 422) {
        const parsed = errorSchema.safeParse(await readJson(res));
        const err = parsed.success ? parsed.data : {};
        return { kind: 'refused', detail: err.detail ?? 'Mollie refused the refund.', field: err.field ?? null };
      }
      if (!res.ok) throw unavailable(res);
      return { kind: 'created', refund: await parse(refundSchema, res) };
    },
  };
}
