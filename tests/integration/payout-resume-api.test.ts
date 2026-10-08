import { describe, it, expect, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateMagicLinkToken, hashNonce } from '@/lib/auth';
import { payoutFingerprint } from '@/lib/payout-fingerprint';
import { bankAccountDataSelect } from '@/lib/payment-methods';
import { mintPayoutPauseToken } from '@/services/payout-pause-token';
import { BASE_URL, uniqueSuffix, freshIp, cookie, seedSession, hashToken } from '../helpers';
import { expectApplied, expectRefusal, expectUnchanged } from '../api-assertions';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];
const emails: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await prisma.magicLinkToken.deleteMany({ where: { email: { in: emails } } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

interface Fixture {
  teacherId: string;
  accountId: string;
  email: string;
}

/** A teacher paused a day ago, with `cutoff` frozen as the passkey cutoff. */
async function pausedTeacher(tag: string, cutoff: Date | null = null, paused = true): Promise<Fixture> {
  const s = uniqueSuffix();
  const email = `resume-api-${tag}-${s}@test.local`;
  const now = Date.now();
  const t = await prisma.teacher.create({
    data: {
      firstName: 'Resume', lastName: 'Api', email, bio: '', pageSlug: `resume-api-${tag}-${s}`,
      account: { create: { email } },
      paymentsPausedAt: paused ? new Date(now - DAY_MS) : null,
      pauseWindowStart: paused ? new Date(now - 2 * DAY_MS) : null,
      pausePasskeyCutoff: paused ? cutoff : null,
      bankAccounts: { create: { currency: 'EUR', holderName: 'Anna de Vries', iban: 'NL91ABNA0417164300' } },
    },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  emails.push(email);
  return { teacherId: t.id, accountId: t.accountId, email };
}

async function fingerprintOf(teacherId: string): Promise<string> {
  const t = await prisma.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { paymentLink: true, bankAccounts: { select: bankAccountDataSelect } },
  });
  return payoutFingerprint(t);
}

const resume = (teacherId: string, token: string, fingerprint: string) =>
  fetch(`${BASE_URL}/api/teachers/${teacherId}/payments-resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
    body: JSON.stringify({ fingerprint }),
  });

async function pausedAt(teacherId: string): Promise<Date | null> {
  const t = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { paymentsPausedAt: true } });
  return t.paymentsPausedAt;
}

async function passkeySession(accountId: string, createdAt: Date): Promise<string> {
  const id = `resume-api-pk-${uniqueSuffix()}`;
  await prisma.passkeyCredential.create({
    data: { id, accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt },
  });
  const token = await seedSession(prisma, accountId);
  await prisma.session.update({ where: { id: hashToken(token) }, data: { passkeyCredentialId: id } });
  return token;
}

describe('POST /api/teachers/[id]/payments-resume', () => {
  it('refuses another teacher\'s id', async () => {
    const me = await pausedTeacher('owner');
    const other = await pausedTeacher('other');
    const res = await resume(other.teacherId, await seedSession(prisma, me.accountId), await fingerprintOf(other.teacherId));

    expect(res.status).toBe(403);
    expect(await pausedAt(other.teacherId)).not.toBeNull();
  });

  it('refuses a session not signed in recently', async () => {
    const me = await pausedTeacher('stale');
    const token = await seedSession(prisma, me.accountId);
    await prisma.session.update({ where: { id: hashToken(token) }, data: { createdAt: new Date(Date.now() - 60 * 60 * 1000) } });

    await expectRefusal(await resume(me.teacherId, token, await fingerprintOf(me.teacherId)), 'RECENT_AUTH_REQUIRED');
    expect(await pausedAt(me.teacherId)).not.toBeNull();
  });

  it('answers a teacher who is not paused unchanged', async () => {
    const me = await pausedTeacher('not-paused', null, false);

    await expectUnchanged(await resume(me.teacherId, await seedSession(prisma, me.accountId), await fingerprintOf(me.teacherId)));
  });

  it('resumes, deletes the pause links, and answers a second submit unchanged', async () => {
    const me = await pausedTeacher('ok');
    const ev = await prisma.payoutChangeEvent.create({
      data: { teacherId: me.teacherId, kind: 'payment_link_added', after: 'revolut.me/…evil' },
      select: { id: true },
    });
    const link = await mintPayoutPauseToken(prisma, me.teacherId, ev.id);
    const token = await seedSession(prisma, me.accountId);
    const fingerprint = await fingerprintOf(me.teacherId);

    expect(await expectApplied(await resume(me.teacherId, token, fingerprint))).toEqual({ resumed: true });
    expect(await pausedAt(me.teacherId)).toBeNull();
    await expectUnchanged(await resume(me.teacherId, token, fingerprint));

    const old = await fetch(`${BASE_URL}/api/payout-pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...freshIp() },
      body: JSON.stringify({ token: link }),
    });
    await expectRefusal(old, 'PAUSE_LINK_INVALID');
    expect(await pausedAt(me.teacherId)).toBeNull();
  });

  it('refuses a magic-link session while the pause froze a passkey cutoff', async () => {
    const cutoff = new Date(Date.now() - 10 * DAY_MS);
    const me = await pausedTeacher('magic', cutoff);
    await prisma.passkeyCredential.create({
      data: { id: `resume-api-old-${uniqueSuffix()}`, accountId: me.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt: new Date(cutoff.getTime() - DAY_MS) },
    });
    const nonce = `resume-api-nonce-${uniqueSuffix()}`;
    const raw = await generateMagicLinkToken(prisma, me.email, { purpose: 'sign_in', originBrowserHash: hashNonce(nonce) });
    const signIn = await fetch(`${BASE_URL}/api/auth/magic-link/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `fair_yoga_origin=${nonce}`, ...freshIp() },
      body: JSON.stringify({ token: raw }),
    });
    expect(signIn.status).toBe(200);
    const sessionToken = /fair_yoga_session=([0-9a-f]{64})/.exec(signIn.headers.get('set-cookie') ?? '')?.[1];
    if (sessionToken === undefined) throw new Error('the sign-in set no session cookie');
    const row = await prisma.session.findUniqueOrThrow({ where: { id: hashToken(sessionToken) } });
    expect(row.passkeyCredentialId).toBeNull();

    await expectRefusal(await resume(me.teacherId, sessionToken, await fingerprintOf(me.teacherId)), 'PASSKEY_REQUIRED');
    expect(await pausedAt(me.teacherId)).not.toBeNull();
  });

  it('refuses a session signed in with a passkey created after the cutoff', async () => {
    const cutoff = new Date(Date.now() - 10 * DAY_MS);
    const me = await pausedTeacher('late-pk', cutoff);
    const token = await passkeySession(me.accountId, new Date(cutoff.getTime() + 1000));

    await expectRefusal(await resume(me.teacherId, token, await fingerprintOf(me.teacherId)), 'PASSKEY_REQUIRED');
  });

  it('resumes for a session signed in with a passkey created before the cutoff', async () => {
    const cutoff = new Date(Date.now() - 10 * DAY_MS);
    const me = await pausedTeacher('old-pk', cutoff);
    const token = await passkeySession(me.accountId, new Date(cutoff.getTime() - DAY_MS));

    await expectApplied(await resume(me.teacherId, token, await fingerprintOf(me.teacherId)));
    expect(await pausedAt(me.teacherId)).toBeNull();
  });

  it('refuses details another currency\'s account changed after the screen was read', async () => {
    const me = await pausedTeacher('changed');
    const token = await seedSession(prisma, me.accountId);
    const shown = await fingerprintOf(me.teacherId);
    await prisma.teacherBankAccount.create({
      data: { teacherId: me.teacherId, currency: 'GBP', holderName: 'Someone', sortCode: '200000', accountNumber: '55779911' },
    });

    await expectRefusal(await resume(me.teacherId, token, shown), 'PAYOUT_DETAILS_CHANGED');
    expect(await pausedAt(me.teacherId)).not.toBeNull();
  });
});

describe('the resume screen and the schedule card', () => {
  it('shows the full details and the card only while paused', async () => {
    const me = await pausedTeacher('page');
    await prisma.teacherBankAccount.create({
      data: { teacherId: me.teacherId, currency: 'GBP', holderName: 'Anna de Vries', sortCode: '200000', accountNumber: '55779911' },
    });
    const token = await seedSession(prisma, me.accountId);
    const get = (path: string) => fetch(`${BASE_URL}${path}`, { headers: { ...cookie(token), ...freshIp() }, redirect: 'manual' });

    const page = await get('/settings/resume-payments');
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('NL91ABNA0417164300');
    expect(html).toContain('55779911');
    expect(await (await get('/schedule')).text()).toContain('Payments are paused');

    await prisma.teacher.update({ where: { id: me.teacherId }, data: { paymentsPausedAt: null, pauseWindowStart: null } });
    expect(await (await get('/schedule')).text()).not.toContain('Payments are paused');
  });

  // The page decides whether this session satisfies the frozen passkey from
  // the session it reads; a passkey sign-in sees the resume button.
  it.each([
    ['a passkey created before the cutoff', true],
    ['an emailed link', false],
  ] as const)('offers the resume to a session signed in with %s only when it satisfies the cutoff', async (_how, satisfies) => {
    const cutoff = new Date(Date.now() - 10 * DAY_MS);
    const me = await pausedTeacher(satisfies ? 'page-pk' : 'page-link', cutoff);
    const token = satisfies
      ? await passkeySession(me.accountId, new Date(cutoff.getTime() - DAY_MS))
      : await seedSession(prisma, me.accountId);
    if (!satisfies) {
      await prisma.passkeyCredential.create({
        data: { id: `resume-api-pk-${uniqueSuffix()}`, accountId: me.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt: new Date(cutoff.getTime() - DAY_MS) },
      });
    }

    const res = await fetch(`${BASE_URL}/settings/resume-payments`, { headers: { ...cookie(token), ...freshIp() }, redirect: 'manual' });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.includes('You signed in with your passkey.')).toBe(satisfies);
    expect(html.includes('Sign in with your passkey to resume')).toBe(!satisfies);
  });
});

