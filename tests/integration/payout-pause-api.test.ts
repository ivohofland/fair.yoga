import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

import { BASE_URL, uniqueSuffix, freshIp, cookie, seedSession, hashToken } from '../helpers';
import { expectApplied, expectRefusal } from '../api-assertions';
import { mintPayoutPauseToken } from '@/services/payout-pause-token';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];

interface Fixture {
  teacherId: string;
  accountId: string;
}

async function makeTeacher(tag: string): Promise<Fixture> {
  const s = uniqueSuffix();
  const email = `pause-api-${tag}-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: { firstName: 'Pause', lastName: 'Api', email, bio: '', pageSlug: `pause-api-${tag}-${s}`, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return { teacherId: t.id, accountId: t.accountId };
}

async function mint(teacherId: string): Promise<string> {
  const ev = await prisma.payoutChangeEvent.create({
    data: { teacherId, kind: 'payment_link_added', after: 'revolut.me/…evil' },
    select: { id: true },
  });
  return mintPayoutPauseToken(prisma, teacherId, ev.id);
}

const pause = (body: unknown, ip: Record<string, string> = freshIp()) =>
  fetch(`${BASE_URL}/api/payout-pause`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ip },
    body: JSON.stringify(body),
  });

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('POST /api/payout-pause', () => {
  it('pauses with no session, and a second use of the link is refused like any other', async () => {
    const me = await makeTeacher('ok');
    const token = await mint(me.teacherId);
    const session = await seedSession(prisma, me.accountId);

    expect(await expectApplied(await pause({ token }))).toEqual({ paused: true });

    const t = await prisma.teacher.findUniqueOrThrow({ where: { id: me.teacherId }, select: { paymentsPausedAt: true } });
    expect(t.paymentsPausedAt).not.toBeNull();
    const signedIn = await fetch(`${BASE_URL}/api/auth/session`, { headers: { ...cookie(session), ...freshIp() } });
    expect(signedIn.status).toBe(401);

    await expectRefusal(await pause({ token }), 'PAUSE_LINK_INVALID');
  });

  it('refuses an unknown link with the same code and body as a used one', async () => {
    const me = await makeTeacher('same');
    const token = await mint(me.teacherId);
    await pause({ token });

    const used = await pause({ token });
    const unknown = await pause({ token: crypto.randomBytes(32).toString('hex') });
    const usedBody: unknown = await used.clone().json();
    const unknownBody: unknown = await unknown.clone().json();
    await expectRefusal(used, 'PAUSE_LINK_INVALID');
    await expectRefusal(unknown, 'PAUSE_LINK_INVALID');
    expect(usedBody).toEqual(unknownBody);
  });

  it('refuses an expired link', async () => {
    const me = await makeTeacher('expired');
    const token = await mint(me.teacherId);
    await prisma.payoutPauseToken.update({ where: { tokenHash: hashToken(token) }, data: { expiresAt: new Date(Date.now() - 1000) } });

    await expectRefusal(await pause({ token }), 'PAUSE_LINK_INVALID');
  });

  it('refuses a body with no token', async () => {
    const res = await pause({});
    expect(res.status).toBe(400);
  });

  it('limits each address', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await pause({ token: crypto.randomBytes(32).toString('hex') }, ip)).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});

describe('GET /payout-pause', () => {
  it('renders for a signed-out visitor and pauses nothing', async () => {
    const me = await makeTeacher('page');
    const token = await mint(me.teacherId);

    const res = await fetch(`${BASE_URL}/payout-pause#t=${token}`, { redirect: 'manual', headers: freshIp() });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Pause payments');
    const t = await prisma.teacher.findUniqueOrThrow({ where: { id: me.teacherId }, select: { paymentsPausedAt: true } });
    expect(t.paymentsPausedAt).toBeNull();
    expect(await prisma.payoutPauseToken.count({ where: { tokenHash: hashToken(token) } })).toBe(1);
  });
});

describe('DELETE /api/auth/passkey/[id] while payments are paused', () => {
  const del = (id: string, token: string) =>
    fetch(`${BASE_URL}/api/auth/passkey/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { ...cookie(token), ...freshIp() },
    });

  async function withPasskey(tag: string, pausedAt: Date | null): Promise<{ id: string; token: string }> {
    const me = await makeTeacher(tag);
    if (pausedAt !== null) await prisma.teacher.update({ where: { id: me.teacherId }, data: { paymentsPausedAt: pausedAt } });
    const id = `pause-del-${tag}-${uniqueSuffix()}`;
    await prisma.passkeyCredential.create({
      data: { id, accountId: me.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [] },
    });
    return { id, token: await seedSession(prisma, me.accountId) };
  }

  it('is refused, and the passkey stays', async () => {
    const { id, token } = await withPasskey('paused', new Date());

    await expectRefusal(await del(id, token), 'PASSKEY_REMOVAL_PAUSED');
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(1);
  });

  it('still answers another account\'s passkey as missing', async () => {
    const { token } = await withPasskey('paused-foreign', new Date());
    const other = await withPasskey('foreign-owner', null);

    await expectRefusal(await del(other.id, token), 'NOT_FOUND');
    expect(await prisma.passkeyCredential.count({ where: { id: other.id } })).toBe(1);
  });

  it('removes as before when not paused', async () => {
    const { id, token } = await withPasskey('not-paused', null);

    await expectApplied(await del(id, token));
    expect(await prisma.passkeyCredential.count({ where: { id } })).toBe(0);
  });
});
