import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

import { BASE_URL, uniqueSuffix, freshIp, cookie, seedSession } from '../helpers';
import { expectApplied, expectRefusal } from '../api-assertions';
import { mintPasskeyRevokeToken } from '@/services/passkey-revoke-token';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];

interface Fixture {
  accountId: string;
  credentialId: string;
  session: string;
}

async function makeAccount(tag: string, opts: { paused?: boolean } = {}): Promise<Fixture> {
  const s = uniqueSuffix();
  const email = `revoke-api-${tag}-${s}@test.local`;
  const credentialId = `revoke-api-${tag}-${s}`;
  const account = await prisma.account.create({ data: { email }, select: { id: true } });
  accountIds.push(account.id);
  if (opts.paused === true) {
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Revoke', lastName: 'Api', email, bio: '', pageSlug: `revoke-api-${tag}-${s}`,
        accountId: account.id, paymentsPausedAt: new Date(),
      },
      select: { id: true },
    });
    teacherIds.push(t.id);
  }
  await prisma.passkeyCredential.create({
    data: { id: credentialId, accountId: account.id, publicKey: Buffer.from('k'), counter: 0, transports: [] },
  });
  return { accountId: account.id, credentialId, session: await seedSession(prisma, account.id) };
}

const revoke = (body: unknown, ip: Record<string, string> = freshIp()) =>
  fetch(`${BASE_URL}/api/passkey-revoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ip },
    body: JSON.stringify(body),
  });

afterAll(async () => {
  await prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('POST /api/passkey-revoke', () => {
  it('signs out and removes the passkey with no session, and a second use is refused', async () => {
    const me = await makeAccount('ok');
    const token = await mintPasskeyRevokeToken(prisma, { accountId: me.accountId, credentialId: me.credentialId });

    expect(await expectApplied(await revoke({ token }))).toEqual({ revoked: true });

    expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { id: me.credentialId } })).toBe(0);
    expect(await prisma.removedPasskey.count({ where: { accountId: me.accountId } })).toBe(1);
    const signedIn = await fetch(`${BASE_URL}/api/auth/session`, { headers: { ...cookie(me.session), ...freshIp() } });
    expect(signedIn.status).toBe(401);

    await expectRefusal(await revoke({ token }), 'REVOKE_LINK_INVALID');
  });

  it('refuses an unknown link', async () => {
    await expectRefusal(await revoke({ token: crypto.randomBytes(32).toString('hex') }), 'REVOKE_LINK_INVALID');
  });

  it('refuses an empty token and a body with no token as malformed', async () => {
    expect((await revoke({ token: '' })).status).toBe(400);
    expect((await revoke({})).status).toBe(400);
  });

  it('signs a paused account out and keeps its passkey', async () => {
    const me = await makeAccount('paused', { paused: true });
    const token = await mintPasskeyRevokeToken(prisma, { accountId: me.accountId, credentialId: me.credentialId });

    expect(await expectApplied(await revoke({ token }))).toEqual({ revoked: true });

    expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { id: me.credentialId } })).toBe(1);
  });

  it('limits each address', async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) {
      statuses.push((await revoke({ token: crypto.randomBytes(32).toString('hex') }, ip)).status);
    }
    expect(statuses.slice(0, 20).every((s) => s === 404)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
