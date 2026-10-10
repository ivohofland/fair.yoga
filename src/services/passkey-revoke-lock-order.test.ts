/**
 * @serial-tier lock-contention — the case below holds one of the account's
 * session rows on a second connection until `revokePasskeyByLink`'s passkey
 * delete, whose `SET NULL` updates that session, gives up on it under the
 * shared `lock_timeout` (`LOCK_TIMEOUT_SQL`).
 * Its assertion is that failure's SQLSTATE, and the whole transaction must
 * reach that statement and wait out the bound inside Prisma's
 * interactive-transaction `timeout`: a tier-mate's lock noise that pushed it
 * past would answer `P2028` instead, which is not the failure this file
 * stages.
 *
 * A redemption that fails after consuming its token must leave the token
 * usable: the consume belongs to the redemption's own transaction, so it rolls
 * back with everything else.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { isLockTimeout } from '@/lib/api-errors';
import { mintPasskeyRevokeToken } from './passkey-revoke-token';
import { revokePasskeyByLink } from './passkey-revoke';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const accountIds: string[] = [];
const teacherIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

describe('revokePasskeyByLink, failing after the consume', () => {
  it('rolls the consume back with the rest, so the link still works afterwards', async () => {
    const s = uniqueSuffix();
    // A teacher account: the bound the wait is held to is set by the teacher
    // lock, which an account with no teacher profile never takes.
    const email = `revoke-lock-${s}@test.local`;
    const teacher = await prisma.teacher.create({
      data: { firstName: 'Revoke', lastName: 'Lock', email, bio: '', pageSlug: `revoke-lock-${s}`, account: { create: { email } } },
      select: { id: true, accountId: true },
    });
    teacherIds.push(teacher.id);
    const account = { id: teacher.accountId };
    accountIds.push(account.id);
    const credentialId = `revoke-lock-pk-${s}`;
    await prisma.passkeyCredential.create({
      data: { id: credentialId, accountId: account.id, publicKey: Buffer.from('k'), counter: 0, transports: [] },
    });
    const sessionId = crypto.randomBytes(16).toString('hex');
    await prisma.session.create({ data: { id: sessionId, accountId: account.id, expiresAt: new Date(Date.now() + DAY_MS) } });
    const raw = await mintPasskeyRevokeToken(prisma, { accountId: account.id, credentialId });

    const holder = new PrismaClient();
    const held = latch();
    const release = latch();
    const holding = holder.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
      held.open();
      await release.promise;
    }, { timeout: 30_000 });
    let failure: unknown = null;
    try {
      await held.promise;
      failure = await revokePasskeyByLink(prisma, raw).then(() => null, (err: unknown) => err);
    } finally {
      release.open();
      await holding;
      await holder.$disconnect();
    }

    expect(isLockTimeout(failure)).toBe(true);
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(1);

    const out = await revokePasskeyByLink(prisma, raw);
    expect(out.status).toBe('revoked');
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(0);
  }, 20_000);
});
