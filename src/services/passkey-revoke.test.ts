import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { mintPasskeyRevokeToken } from './passkey-revoke-token';
import { revokePasskeyByLink } from './passkey-revoke';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const accountIds: string[] = [];
const teacherIds: string[] = [];
const DAY_MS = 24 * 60 * 60 * 1000;

interface Fixture { accountId: string; email: string }

async function makeAccount(opts: { teacher?: boolean; pausedAt?: Date } = {}): Promise<Fixture> {
  const s = uniqueSuffix();
  const email = `revoke-${s}@test.local`;
  if (opts.teacher === true) {
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Re', lastName: 'Voke', email, bio: '', pageSlug: `revoke-${s}`,
        account: { create: { email } }, paymentsPausedAt: opts.pausedAt ?? null,
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(t.id);
    accountIds.push(t.accountId);
    return { accountId: t.accountId, email };
  }
  const a = await prisma.account.create({ data: { email }, select: { id: true } });
  accountIds.push(a.id);
  return { accountId: a.id, email };
}

async function passkey(accountId: string, createdAt = new Date('2026-01-02T03:04:05Z')): Promise<string> {
  const id = `revoke-pk-${uniqueSuffix()}`;
  await prisma.passkeyCredential.create({
    data: { id, accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt },
  });
  return id;
}

async function session(accountId: string): Promise<string> {
  const id = crypto.randomBytes(16).toString('hex');
  await prisma.session.create({ data: { id, accountId, expiresAt: new Date(Date.now() + DAY_MS) } });
  return id;
}

async function signInLink(email: string): Promise<string> {
  const tokenHash = crypto.randomBytes(16).toString('hex');
  await prisma.magicLinkToken.create({ data: { tokenHash, email, expiresAt: new Date(Date.now() + DAY_MS) } });
  return tokenHash;
}

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.magicLinkToken.deleteMany({ where: { email: { startsWith: 'revoke-' } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

describe('revokePasskeyByLink', () => {
  it('signs out, deletes sign-in links, removes the passkey and records the removal', async () => {
    const { accountId, email } = await makeAccount({ teacher: true });
    const credentialId = await passkey(accountId);
    const sessionId = await session(accountId);
    const linkHash = await signInLink(email);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out.status).toBe('revoked');
    if (out.status !== 'revoked') return;
    expect(out.removal?.accountId).toBe(accountId);
    expect(await prisma.session.count({ where: { id: sessionId } })).toBe(0);
    expect(await prisma.magicLinkToken.count({ where: { tokenHash: linkHash } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(0);
    expect(await prisma.removedPasskey.count({ where: { accountId } })).toBe(1);
  });

  it('works for an account with no teacher profile', async () => {
    const { accountId } = await makeAccount();
    const credentialId = await passkey(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out.status).toBe('revoked');
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(0);
  });

  it('answers invalid for a second use, an expired token and an unknown one', async () => {
    const { accountId } = await makeAccount();
    const credentialId = await passkey(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });
    await revokePasskeyByLink(prisma, raw);

    expect(await revokePasskeyByLink(prisma, raw)).toEqual({ status: 'invalid' });
    expect(await revokePasskeyByLink(prisma, 'f'.repeat(64))).toEqual({ status: 'invalid' });

    const second = await makeAccount();
    const credential2 = await passkey(second.accountId);
    const expired = await mintPasskeyRevokeToken(prisma, { accountId: second.accountId, credentialId: credential2 });
    expect(await revokePasskeyByLink(prisma, expired, new Date(Date.now() + 15 * DAY_MS))).toEqual({ status: 'invalid' });
    expect(await prisma.passkeyCredential.count({ where: { id: credential2 } })).toBe(1);
  });

  it('still signs out when the passkey is already gone, and records nothing', async () => {
    const { accountId } = await makeAccount();
    const credentialId = await passkey(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });
    await prisma.passkeyCredential.deleteMany({ where: { id: credentialId } });
    const sessionId = await session(accountId);

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out).toEqual({ status: 'revoked', removal: null });
    expect(await prisma.session.count({ where: { id: sessionId } })).toBe(0);
    expect(await prisma.removedPasskey.count({ where: { accountId } })).toBe(0);
  });

  it('while payments are paused: signs out, keeps the passkey, records nothing', async () => {
    const { accountId } = await makeAccount({ teacher: true, pausedAt: new Date() });
    const credentialId = await passkey(accountId);
    const sessionId = await session(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out).toEqual({ status: 'revoked', removal: null });
    expect(await prisma.session.count({ where: { id: sessionId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(1);
    expect(await prisma.removedPasskey.count({ where: { accountId } })).toBe(0);
  });

  it('cannot remove a credential of another account, even from a forged token row', async () => {
    const mine = await makeAccount();
    const theirs = await makeAccount();
    const theirCredential = await passkey(theirs.accountId);
    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.passkeyRevokeToken.create({
      data: { tokenHash: hashToken(raw), accountId: mine.accountId, credentialId: theirCredential, expiresAt: new Date(Date.now() + DAY_MS) },
    });

    const holderSession = await session(mine.accountId);

    const out = await revokePasskeyByLink(prisma, raw);

    expect(out).toEqual({ status: 'revoked', removal: null });
    expect(await prisma.session.count({ where: { id: holderSession } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { id: theirCredential } })).toBe(1);
  });
});
