import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { BASE_URL, uniqueSuffix, freshIp } from '../helpers';

const prisma = new PrismaClient();

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

/**
 * #187. The route used to look up the posted address and return its credential
 * ids, so the response shape told an unauthenticated caller whether an address
 * had an account, whether it had a passkey, and how many. It now reads nothing
 * from the request body at all.
 */
describe('POST /api/auth/passkey/authenticate/options', () => {
  const suffix = uniqueSuffix();
  const withPasskey = `pk-has-${suffix}@test.local`;
  const withoutPasskey = `pk-none-${suffix}@test.local`;
  const noAccount = `pk-absent-${suffix}@test.local`;
  const credentialId = `cred-${suffix}`.replace(/[^A-Za-z0-9_-]/g, '-');
  let accountIds: string[] = [];

  beforeAll(async () => {
    const withCred = await prisma.account.create({ data: { email: withPasskey } });
    const without = await prisma.account.create({ data: { email: withoutPasskey } });
    accountIds = [withCred.id, without.id];

    await prisma.passkeyCredential.create({
      data: {
        id: credentialId,
        accountId: withCred.id,
        publicKey: Buffer.from([1, 2, 3]),
        counter: BigInt(0),
        transports: ['internal'],
      },
    });
  });

  afterAll(async () => {
    await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  async function optionsFor(email?: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${BASE_URL}/api/auth/passkey/authenticate/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify(email ? { email } : {}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    return body.data.options as Record<string, unknown>;
  }

  it('the with-passkey fixture really holds a credential', async () => {
    // Without this, the "has a passkey" arm below would pass vacuously against
    // an account that never had one — which is exactly why the #170 passkey
    // test it replaces was the weakest of its three.
    const count = await prisma.passkeyCredential.count({
      where: { accountId: accountIds[0] },
    });
    expect(count).toBe(1);
  });

  it('answers with the same key set for every address, and never sends allowCredentials', async () => {
    const hasPasskey = await optionsFor(withPasskey);
    const hasAccount = await optionsFor(withoutPasskey);
    const unknown = await optionsFor(noAccount);
    const omitted = await optionsFor();

    for (const options of [hasPasskey, hasAccount, unknown, omitted]) {
      expect('allowCredentials' in options).toBe(false);
    }

    // Not byte-identical — challenge and challengeId are random per request —
    // so the assertable property is the key set.
    const keys = Object.keys(hasPasskey).sort();
    expect(Object.keys(hasAccount).sort()).toEqual(keys);
    expect(Object.keys(unknown).sort()).toEqual(keys);
    expect(Object.keys(omitted).sort()).toEqual(keys);
  });
});
