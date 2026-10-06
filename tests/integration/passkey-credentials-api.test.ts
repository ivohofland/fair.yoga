import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

import { BASE_URL, uniqueSuffix, freshIp, cookie, seedSession, hashToken } from '../helpers';
import { expectApplied, expectRefusal } from '../api-assertions';
import { forgedNoneRegistration } from '../passkey-fixtures';
import { RECENT_AUTH_WINDOW_MS } from '@/lib/auth/recent-auth';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

interface Fixture {
  accountId: string;
  studentId: string;
}

const accountIds: string[] = [];
const studentIds: string[] = [];

async function makeAccount(tag: string): Promise<Fixture> {
  const email = `pk-cred-${tag}-${suffix}@test.local`;
  const account = await prisma.account.create({ data: { email } });
  accountIds.push(account.id);
  const student = await prisma.student.create({
    data: { accountId: account.id, firstName: 'Pass', lastName: 'Key', email, claimedAt: new Date() },
  });
  studentIds.push(student.id);
  return { accountId: account.id, studentId: student.id };
}

/** A session whose sign-in was `ageMs` ago. */
async function sessionAged(accountId: string, ageMs: number): Promise<string> {
  const token = await seedSession(prisma, accountId);
  await prisma.session.update({
    where: { id: hashToken(token) },
    data: { createdAt: new Date(Date.now() - ageMs) },
  });
  return token;
}

const STALE_MS = RECENT_AUTH_WINDOW_MS + 60_000;

afterAll(async () => {
  await prisma.pushSubscription.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('passkey registration needs a recent sign-in (#765)', () => {
  let fixture: Fixture;
  let staleToken: string;
  let freshToken: string;

  beforeAll(async () => {
    fixture = await makeAccount('recent');
    staleToken = await sessionAged(fixture.accountId, STALE_MS);
    freshToken = await seedSession(prisma, fixture.accountId);
  });

  const post = (path: string, token: string, body?: unknown) =>
    fetch(`${BASE_URL}/api/auth/passkey/register/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('register/options refuses an old session with RECENT_AUTH_REQUIRED', async () => {
    await expectRefusal(await post('options', staleToken), 'RECENT_AUTH_REQUIRED');
  });

  it('register/options answers a fresh session', async () => {
    const res = await post('options', freshToken);
    expect(res.status).toBe(200);
  });

  it('register/verify refuses an old session before it consumes the challenge', async () => {
    // A challenge issued while the session was still fresh.
    const options = await post('options', freshToken);
    const { data } = (await options.json()) as { data: { challenge: string } };
    const body = {
      response: forgedNoneRegistration({
        challenge: data.challenge,
        origin: BASE_URL,
        rpId: 'localhost',
        authDataCredentialId: new Uint8Array(Buffer.from(`stale-${suffix}`)),
        responseId: Buffer.from(`stale-${suffix}`).toString('base64url'),
      }),
    };

    // The same account, with the session now past the window.
    await expectRefusal(await post('verify', staleToken, body), 'RECENT_AUTH_REQUIRED');

    // The refusal left the challenge in place, so a recent session can still finish.
    const retry = await post('verify', freshToken, body);
    expect(retry.status).toBe(200);
  });
});

describe('GET /api/auth/passkey', () => {
  it('lists only the caller\'s credentials, newest first, without key material', async () => {
    const mine = await makeAccount('list-mine');
    const theirs = await makeAccount('list-theirs');
    const base = Date.now();
    const make = (accountId: string, id: string, createdAt: Date, transports: string[]) =>
      prisma.passkeyCredential.create({
        data: { id, accountId, publicKey: Buffer.from('secret-key'), counter: 7, transports, createdAt },
      });
    await make(mine.accountId, `old-${suffix}`, new Date(base - 2000), ['internal']);
    await make(mine.accountId, `new-${suffix}`, new Date(base - 1000), ['usb', 'nfc']);
    await make(theirs.accountId, `other-${suffix}`, new Date(base), []);

    const token = await seedSession(prisma, mine.accountId);
    const res = await fetch(`${BASE_URL}/api/auth/passkey`, { headers: { ...cookie(token), ...freshIp() } });
    const data = (await expectApplied(res)) as Array<Record<string, unknown>>;

    expect(data.map((c) => c.id)).toEqual([`new-${suffix}`, `old-${suffix}`]);
    expect(data.map((c) => Object.keys(c).sort())).toEqual([
      ['createdAt', 'id', 'transports'],
      ['createdAt', 'id', 'transports'],
    ]);
    expect(data[0]?.transports).toEqual(['usb', 'nfc']);
    expect(JSON.stringify(data)).not.toContain('secret-key');
  });

  it('refuses a request with no session', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/passkey`, { headers: freshIp() });
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/auth/passkey/[id]', () => {
  const del = (id: string, token: string) =>
    fetch(`${BASE_URL}/api/auth/passkey/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { ...cookie(token), ...freshIp() },
    });

  it('deletes the caller\'s credential, even on an old session', async () => {
    const me = await makeAccount('del-mine');
    await prisma.passkeyCredential.create({
      data: { id: `mine-${suffix}`, accountId: me.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [] },
    });
    const token = await sessionAged(me.accountId, STALE_MS);

    await expectApplied(await del(`mine-${suffix}`, token));

    expect(await prisma.passkeyCredential.count({ where: { id: `mine-${suffix}` } })).toBe(0);
  });

  it('answers another account\'s credential exactly as a missing one, and leaves it standing', async () => {
    const me = await makeAccount('del-attacker');
    const owner = await makeAccount('del-owner');
    await prisma.passkeyCredential.create({
      data: { id: `owned-${suffix}`, accountId: owner.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [] },
    });
    const token = await seedSession(prisma, me.accountId);

    const notYours = await del(`owned-${suffix}`, token);
    const missing = await del(`missing-${suffix}`, token);

    const notYoursBody: unknown = await notYours.clone().json();
    const missingBody: unknown = await missing.clone().json();
    await expectRefusal(notYours, 'NOT_FOUND');
    await expectRefusal(missing, 'NOT_FOUND');
    expect(notYoursBody).toEqual(missingBody);
    expect(await prisma.passkeyCredential.count({ where: { id: `owned-${suffix}` } })).toBe(1);
  });
});

describe('DELETE /api/auth/session/all', () => {
  const revokeAll = (token: string) =>
    fetch(`${BASE_URL}/api/auth/session/all`, {
      method: 'DELETE',
      headers: { ...cookie(token), ...freshIp() },
    });

  it('ends every session of the account including the caller\'s, clears the cookie, and spares other accounts', async () => {
    const me = await makeAccount('all-mine');
    const other = await makeAccount('all-other');
    const mine1 = await seedSession(prisma, me.accountId);
    await seedSession(prisma, me.accountId);
    const otherToken = await seedSession(prisma, other.accountId);

    const res = await revokeAll(mine1);
    await expectApplied(res);

    expect(res.headers.get('set-cookie')).toMatch(/fair_yoga_session=;.*Max-Age=0/);
    expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(0);
    expect(await prisma.session.count({ where: { accountId: other.accountId } })).toBe(1);
    const stillIn = await fetch(`${BASE_URL}/api/auth/session`, { headers: { ...cookie(otherToken), ...freshIp() } });
    expect(stillIn.status).toBe(200);
  });

  it('also removes the account\'s push subscriptions, and only that account\'s', async () => {
    const me = await makeAccount('all-push-mine');
    const other = await makeAccount('all-push-other');
    const token = await seedSession(prisma, me.accountId);
    const sub = (accountId: string, tag: string) => ({
      accountId,
      endpoint: `https://push.test/${tag}-${suffix}`,
      p256dh: 'p',
      auth: 'a',
    });
    await prisma.pushSubscription.createMany({
      data: [sub(me.accountId, 'mine-1'), sub(me.accountId, 'mine-2'), sub(other.accountId, 'other-1')],
    });

    await expectApplied(await revokeAll(token));

    expect(await prisma.pushSubscription.count({ where: { accountId: me.accountId } })).toBe(0);
    expect(await prisma.pushSubscription.count({ where: { accountId: other.accountId } })).toBe(1);
  });

  it('is idempotent: a second call with the dead cookie is a plain 401, not a fault', async () => {
    const me = await makeAccount('all-twice');
    const token = await seedSession(prisma, me.accountId);
    await revokeAll(token);

    const again = await revokeAll(token);

    expect(again.status).toBe(401);
  });

  it('refuses a request with no session', async () => {
    const res = await fetch(`${BASE_URL}/api/auth/session/all`, { method: 'DELETE', headers: freshIp() });
    expect(res.status).toBe(401);
  });
});
