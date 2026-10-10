/**
 * @serial-tier lock-contention — the first case holds one of the account's
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
 *
 * The second case holds the account's `Teacher` row on a second connection and
 * asserts, via `pg_blocking_pids` inside a bounded wait, that the redemption
 * parks on it; a pause committed meanwhile is then seen, because the paused
 * read and the consume come after the lock.
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

const WAIT_MS = 1_500;

async function ownPid(tx: Prisma.TransactionClient): Promise<number> {
  const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
  if (row === undefined) throw new Error('pg_backend_pid returned no row');
  return row.pid;
}

async function waiterOf(holderPid: number, stop: () => boolean): Promise<number | null> {
  const deadline = Date.now() + WAIT_MS;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ pid: number }>>`
      SELECT pid FROM pg_stat_activity
       WHERE wait_event_type = 'Lock'
         AND ${holderPid} = ANY(pg_blocking_pids(pid))
       LIMIT 1`;
    if (row !== undefined) return row.pid;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
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
    await prisma.session.create({
      data: { id: sessionId, accountId: account.id, expiresAt: new Date(Date.now() + DAY_MS), passkeyCredentialId: credentialId },
    });
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

describe('revokePasskeyByLink behind a pause in flight', () => {
  it('parks on the teacher row, then reads the pause the holder committed and keeps the passkey', async () => {
    const s = uniqueSuffix();
    const email = `revoke-park-${s}@test.local`;
    const teacher = await prisma.teacher.create({
      data: { firstName: 'Revoke', lastName: 'Park', email, bio: '', pageSlug: `revoke-park-${s}`, account: { create: { email } } },
      select: { id: true, accountId: true },
    });
    teacherIds.push(teacher.id);
    accountIds.push(teacher.accountId);
    const credentialId = `revoke-park-pk-${s}`;
    await prisma.passkeyCredential.create({
      data: { id: credentialId, accountId: teacher.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [] },
    });
    const raw = await mintPasskeyRevokeToken(prisma, { accountId: teacher.accountId, credentialId });

    const holder = new PrismaClient();
    const held = latch();
    const release = latch();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx: Prisma.TransactionClient) => {
      holderPid = await ownPid(tx);
      await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${teacher.id} FOR UPDATE`;
      held.open();
      await release.promise;
      await tx.teacher.update({ where: { id: teacher.id }, data: { paymentsPausedAt: new Date() } });
    }, { timeout: 20_000 });

    let outcome: Awaited<ReturnType<typeof revokePasskeyByLink>> | null = null;
    let parked = false;
    try {
      await held.promise;
      let settled = false;
      const pending = revokePasskeyByLink(prisma, raw).finally(() => { settled = true; });
      void pending.catch(() => undefined);
      parked = (await waiterOf(holderPid, () => settled)) !== null;
      release.open();
      await holding;
      outcome = await pending;
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await holder.$disconnect();
    }

    expect(parked).toBe(true);
    expect(outcome).toEqual({ status: 'revoked', removal: null });
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(1);
    expect(await prisma.removedPasskey.count({ where: { accountId: teacher.accountId } })).toBe(0);
    expect(await revokePasskeyByLink(prisma, raw)).toEqual({ status: 'invalid' });
  }, 20_000);
});
