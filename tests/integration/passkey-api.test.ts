import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import { z } from 'zod';

import { BASE_URL, uniqueSuffix, freshIp, cookie, seedSession } from '../helpers';
import { expectApplied, expectRefusal } from '../api-assertions';
import {
  WRONG_CHALLENGE,
  forgedNoneRegistration,
  wrongChallengeClientDataJSON,
} from '../passkey-fixtures';
import { formatIssues } from '@/lib/validation-message';
import { passkeyRegisterVerifySchema, passkeyAuthVerifySchema } from '@/lib/schemas';

const prisma = new PrismaClient();

/**
 * A syntactically valid credential id — base64url characters only — for
 * cases that only need to clear the schema's `id` check, not name a real
 * stored credential.
 */
function makeCredentialId(seed: string): string {
  return Buffer.from(`cred-${seed}`).toString('base64url');
}

/**
 * A validation 400, as the spec defines it
 * (`docs/superpowers/specs/2026-10-01-passkey-verify-refusals-design.md`,
 * Tests): status 400, no `code`, and a message equal to `formatIssues` of
 * that schema's own `safeParse` issues for the body sent — never a literal
 * (`docs/technical-architecture.md`, Error responses).
 * `schema.safeParse(body).success` must itself be `false`, so a schema
 * mutation that stops rejecting fails this precondition rather than the
 * response assertions below it.
 */
async function expectValidation400(
  res: Response,
  schema: z.ZodType,
  body: unknown,
): Promise<void> {
  const parsed = schema.safeParse(body);
  expect(parsed.success).toBe(false);
  expect(res.status).toBe(400);
  const resBody = (await res.json()) as { error: { message: string; code?: string } };
  expect(resBody.error.code).toBeUndefined();
  if (!parsed.success) {
    expect(resBody.error.message).toBe(formatIssues(parsed.error.issues));
  }
}

/**
 * The verify route must reject an unsafe redirect at the request boundary
 * — before the challenge is consumed or any session is minted. Proves the
 * route is wired to the strict schema, which the schema unit tests alone
 * cannot show. A bogus challengeId also yields 400, so each assertion pins
 * *which* rejection fired: a validation 400 names the failing field first
 * (`parseBody`), and the challenge refusal carries `PASSKEY_CHALLENGE_MISSING`.
 * Each body carries a valid `response.id`, so a redirect case's only
 * validation issue is `redirect`, not also `id`.
 */
describe('POST /api/auth/passkey/authenticate/verify', () => {
  const post = (body: unknown) =>
    fetch(`${BASE_URL}/api/auth/passkey/authenticate/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rejects an absolute redirect with a validation 400', async () => {
    const id = makeCredentialId('redirect-absolute');
    const body = { response: { id }, challengeId: 'x', redirect: 'https://evil.com' };
    const res = await post(body);
    await expectValidation400(res, passkeyAuthVerifySchema, body);
  });

  it('rejects a protocol-relative redirect with a validation 400', async () => {
    const id = makeCredentialId('redirect-protocol-relative');
    const body = { response: { id }, challengeId: 'x', redirect: '//evil.com' };
    const res = await post(body);
    await expectValidation400(res, passkeyAuthVerifySchema, body);
  });

  it('a safe redirect passes validation and fails only on the challenge', async () => {
    const id = makeCredentialId('redirect-safe');
    const res = await post({ response: { id }, challengeId: 'x', redirect: '/somewhere' });
    await expectRefusal(res, 'PASSKEY_CHALLENGE_MISSING');
  });
});

/**
 * The boundary validation on `response.id` (an empty object, a NUL byte) and
 * the coded refusal a wrong-challenge response against a real credential
 * answers. The wrong-challenge case needs a live `challengeId` from
 * `POST /api/auth/passkey/authenticate/options`; the validation cases send
 * one too, so the `response.id` check is the only thing between each body and
 * the challenge lookup. That route is IP-rate-limited — `freshIp()` keeps
 * each call in its own bucket.
 */
describe('POST /api/auth/passkey/authenticate/verify — id validation and the coded refusal', () => {
  const suffix = uniqueSuffix();
  const accountIds: string[] = [];
  const credentialIds: string[] = [];
  let seededCredentialId: string;

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: { email: `pk-auth-verify-${suffix}@test.local` },
    });
    accountIds.push(account.id);
    seededCredentialId = makeCredentialId(`seeded-${suffix}`);
    await prisma.passkeyCredential.create({
      data: {
        id: seededCredentialId,
        accountId: account.id,
        publicKey: Buffer.from([1, 2, 3]),
        counter: BigInt(0),
        transports: ['internal'],
      },
    });
    credentialIds.push(seededCredentialId);
  });

  afterAll(async () => {
    await prisma.passkeyCredential.deleteMany({ where: { id: { in: credentialIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  async function freshChallengeId(): Promise<string> {
    const res = await fetch(`${BASE_URL}/api/auth/passkey/authenticate/options`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { challengeId: string } };
    return body.data.challengeId;
  }

  const post = (body: unknown) =>
    fetch(`${BASE_URL}/api/auth/passkey/authenticate/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('rejects an empty response object with a validation 400', async () => {
    const challengeId = await freshChallengeId();
    const body = { challengeId, response: {} };
    const res = await post(body);
    await expectValidation400(res, passkeyAuthVerifySchema, body);
  });

  it('rejects a NUL-bearing id with a validation 400', async () => {
    const challengeId = await freshChallengeId();
    const body = { challengeId, response: { id: 'ab\u0000cd' } };
    const res = await post(body);
    await expectValidation400(res, passkeyAuthVerifySchema, body);
  });

  it('answers PASSKEY_NOT_VERIFIED for a wrong-challenge response against a seeded credential', async () => {
    const challengeId = await freshChallengeId();
    const res = await post({
      challengeId,
      response: {
        id: seededCredentialId,
        rawId: seededCredentialId,
        type: 'public-key',
        response: {
          clientDataJSON: wrongChallengeClientDataJSON('webauthn.get'),
          authenticatorData: '',
          signature: '',
        },
        clientExtensionResults: {},
      },
    });
    // The refusal's `reason` echoes the client's challenge; it goes to the
    // log, never the response.
    expect(await res.clone().text()).not.toContain(WRONG_CHALLENGE);
    await expectRefusal(res, 'PASSKEY_NOT_VERIFIED');
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
    await prisma.$disconnect();
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
    expect(hasPasskey.userVerification).toBe('required');

    // Not byte-identical — challenge and challengeId are random per request —
    // so the assertable property is the key set.
    const keys = Object.keys(hasPasskey).sort();
    expect(Object.keys(hasAccount).sort()).toEqual(keys);
    expect(Object.keys(unknown).sort()).toEqual(keys);
    expect(Object.keys(omitted).sort()).toEqual(keys);
  });

  /**
   * One address for all 101 requests, deliberately — that is the bucket under
   * test. The route has no second budget, so nothing else can produce the 429.
   */
  it('refuses the 101st request from one address within the hour', async () => {
    const ip = freshIp();
    const statuses: number[] = [];

    for (let i = 0; i < 101; i++) {
      const res = await fetch(`${BASE_URL}/api/auth/passkey/authenticate/options`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ip },
        body: JSON.stringify({}),
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 100)).toEqual(Array(100).fill(200));
    expect(statuses[100]).toBe(429);
  });
});

/**
 * The credential is named after the account's LIVE profile, teacher first
 * (#623) — never an erased one. Erasure anonymises a profile's name to
 * "Deleted Teacher" or "Deleted Student", and that name lands permanently in
 * the viewer's own credential manager, so this is not a cosmetic string.
 */
describe('POST /api/auth/passkey/register/options', () => {
  const suffix = uniqueSuffix();
  const accountIds: string[] = [];
  let token: string;

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: { email: `pk-live-name-${suffix}@test.local` },
    });
    accountIds.push(account.id);
    // The account holds an erased teacher and both an erased and a live
    // student, so an unfiltered read on either side would surface a
    // tombstone instead of the live student — both filters are load-bearing
    // for the assertion below.
    await prisma.teacher.create({
      data: {
        accountId: account.id,
        firstName: 'Deleted', lastName: 'Teacher',
        email: `pk-erased-teacher-${suffix}@deleted.invalid`,
        bio: '', pageSlug: `pk-erased-teacher-${suffix}`,
        deletedAt: new Date(),
      },
    });
    await prisma.student.create({
      data: {
        accountId: account.id,
        firstName: 'Deleted', lastName: 'Student',
        email: `pk-erased-student-${suffix}@deleted.invalid`,
        claimedAt: new Date(), deletedAt: new Date(),
      },
    });
    await prisma.student.create({
      data: {
        accountId: account.id,
        firstName: 'Live', lastName: 'Student',
        email: `pk-live-name-${suffix}@test.local`,
        claimedAt: new Date(),
      },
    });
    token = await seedSession(prisma, account.id);
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.teacher.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  it('names the credential after the live profile, not an erased one (#623)', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/passkey/register/options`, {
      method: 'POST',
      headers: { ...cookie(token), ...freshIp() },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { user: { displayName: string }; authenticatorSelection: { userVerification: string } };
    };
    expect(body.data.user.displayName).toBe('Live Student');
    expect(body.data.authenticatorSelection.userVerification).toBe('required');
  });
});

/**
 * `requireSession` answers 401 for a session whose account has no live
 * profile, so this fixture's account carries a live student profile
 * throughout.
 */
describe('POST /api/auth/passkey/register/verify', () => {
  const suffix = uniqueSuffix();
  const accountIds: string[] = [];
  const studentIds: string[] = [];
  let token: string;

  beforeAll(async () => {
    const account = await prisma.account.create({
      data: { email: `pk-register-verify-${suffix}@test.local` },
    });
    accountIds.push(account.id);
    const student = await prisma.student.create({
      data: {
        accountId: account.id,
        firstName: 'Passkey', lastName: 'Student',
        email: `pk-register-verify-${suffix}@test.local`,
        claimedAt: new Date(),
      },
    });
    studentIds.push(student.id);
    token = await seedSession(prisma, account.id);
  });

  afterAll(async () => {
    await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  });

  function post(body: unknown, { withCookie = true }: { withCookie?: boolean } = {}) {
    return fetch(`${BASE_URL}/api/auth/passkey/register/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(withCookie ? cookie(token) : {}),
      },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  }

  /** Issues a registration challenge for this fixture's account and returns it. */
  async function requestRegisterOptions(): Promise<string> {
    const res = await fetch(`${BASE_URL}/api/auth/passkey/register/options`, {
      method: 'POST',
      headers: cookie(token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { challenge: string } };
    return body.data.challenge;
  }

  function wrongChallengeBody(id: string) {
    return {
      response: {
        id,
        rawId: id,
        type: 'public-key',
        response: {
          clientDataJSON: wrongChallengeClientDataJSON('webauthn.create'),
          attestationObject: '',
        },
        clientExtensionResults: {},
      },
    };
  }

  /**
   * A forged `fmt: 'none'` registration for the challenge just issued, built
   * for origin `BASE_URL` and RP ID `localhost` — what the app under test
   * must be configured to expect. The success case below is the control
   * that fails if it is not.
   */
  async function forgedRegistrationBody(
    authDataCredentialId: Uint8Array,
    responseId: string,
    transports: unknown,
  ) {
    const challenge = await requestRegisterOptions();
    const forged = forgedNoneRegistration({
      challenge,
      origin: BASE_URL,
      rpId: 'localhost',
      authDataCredentialId,
      responseId,
    });
    return { response: { ...forged, response: { ...forged.response, transports } } };
  }

  it('refuses a request with no session cookie', async () => {
    const body = { response: { id: makeCredentialId(`noauth-${suffix}`) } };
    const res = await post(body, { withCookie: false });
    expect(res.status).toBe(401);
  });

  it('answers an uncoded 400 for a body that is not JSON', async () => {
    const res = await post('{not valid json');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code?: string } };
    expect(body.error.code).toBeUndefined();
  });

  it('rejects a non-object response with a validation 400', async () => {
    const body = { response: 'x' };
    const res = await post(body);
    await expectValidation400(res, passkeyRegisterVerifySchema, body);
  });

  it('rejects a base64url id one character past the credential id bound with a validation 400', async () => {
    const body = { response: { id: 'A'.repeat(1365) } };
    const res = await post(body);
    await expectValidation400(res, passkeyRegisterVerifySchema, body);
  });

  it('answers PASSKEY_CHALLENGE_MISSING with no prior register/options call', async () => {
    const body = { response: { id: makeCredentialId(`nochallenge-${suffix}`) } };
    const res = await post(body);
    await expectRefusal(res, 'PASSKEY_CHALLENGE_MISSING');
  });

  it('after register/options, an empty response object is a validation 400 that leaves the challenge pending', async () => {
    await requestRegisterOptions();

    const body = { response: {} };
    const res = await post(body);
    await expectValidation400(res, passkeyRegisterVerifySchema, body);

    // `PASSKEY_NOT_VERIFIED`, not `PASSKEY_CHALLENGE_MISSING`: the challenge
    // outlived the validation 400.
    const nextRes = await post(wrongChallengeBody(makeCredentialId(`afterinvalid-${suffix}`)));
    await expectRefusal(nextRes, 'PASSKEY_NOT_VERIFIED');
  });

  it('a wrong-challenge response answers PASSKEY_NOT_VERIFIED, and burns the challenge', async () => {
    await requestRegisterOptions();

    const body = wrongChallengeBody(makeCredentialId(`wrongchallenge-${suffix}`));

    const firstRes = await post(body);
    // The refusal's `reason` echoes the client's challenge; it goes to the
    // log, never the response.
    expect(await firstRes.clone().text()).not.toContain(WRONG_CHALLENGE);
    await expectRefusal(firstRes, 'PASSKEY_NOT_VERIFIED');

    const secondRes = await post(body);
    await expectRefusal(secondRes, 'PASSKEY_CHALLENGE_MISSING');
  });

  it('stores a verified registration under response.id, for the session account, with known transports only', async () => {
    const credentialId = new Uint8Array(randomBytes(16));
    const responseId = isoBase64URL.fromBuffer(credentialId);
    const body = await forgedRegistrationBody(credentialId, responseId, ['usb', 'carrier-pigeon']);

    const res = await post(body);

    expect(await expectApplied(res)).toEqual({ credentialId: responseId });
    const row = await prisma.passkeyCredential.findUnique({ where: { id: responseId } });
    expect(row && { accountId: row.accountId, transports: row.transports }).toEqual({
      accountId: accountIds[0],
      transports: ['usb'],
    });
  });

  it('answers PASSKEY_NOT_VERIFIED, storing nothing, when the authenticator data id differs from response.id', async () => {
    const authDataCredentialId = new Uint8Array(randomBytes(16));
    const responseId = isoBase64URL.fromBuffer(new Uint8Array(randomBytes(16)));
    const body = await forgedRegistrationBody(authDataCredentialId, responseId, ['usb']);

    const res = await post(body);

    await expectRefusal(res, 'PASSKEY_NOT_VERIFIED');
    const stored = await prisma.passkeyCredential.count({
      where: { id: { in: [responseId, isoBase64URL.fromBuffer(authDataCredentialId)] } },
    });
    expect(stored).toBe(0);
  });

  it('stores no transports for a transports value that is not an array', async () => {
    const credentialId = new Uint8Array(randomBytes(16));
    const responseId = isoBase64URL.fromBuffer(credentialId);
    const body = await forgedRegistrationBody(credentialId, responseId, 'usb');

    const res = await post(body);

    expect(await expectApplied(res)).toEqual({ credentialId: responseId });
    const row = await prisma.passkeyCredential.findUnique({ where: { id: responseId } });
    expect(row?.transports).toEqual([]);
  });
});
