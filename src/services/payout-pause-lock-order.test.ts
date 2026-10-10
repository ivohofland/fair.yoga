/**
 * @serial-tier lock-contention — the case below holds the teacher's session
 * row on a second connection until `pausePayments`' session delete gives up on
 * it under the shared `lock_timeout` (`LOCK_TIMEOUT_SQL`). It asserts, via
 * `pg_blocking_pids` inside a bounded wait, that the pause queued on that
 * `Session` row, then that failure's SQLSTATE; the whole transaction must
 * reach that statement and wait out the bound inside Prisma's
 * interactive-transaction `timeout`: a
 * tier-mate's lock noise that pushed it past would answer `P2028` instead,
 * which is not the failure this file stages.
 *
 * A pause that fails after spending its token must leave the token usable:
 * the consume belongs to the pause's own transaction, so it rolls back with
 * everything else.
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { isLockTimeout } from '@/lib/api-errors';
import { pausePayments } from './payout-pause';
import { uniqueSuffix, seedSession } from '../../tests/helpers';

const prisma = new PrismaClient();
const teacherIds: string[] = [];
const accountIds: string[] = [];

const DAY_MS = 24 * 60 * 60 * 1000;

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
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

/**
 * The table of the row a connection blocked by `holderPid` is queued for,
 * read from a third client within a bounded wait; `null` when none parks.
 */
async function parkedTableBehind(holderPid: number, stop: () => boolean): Promise<string | null> {
  const deadline = Date.now() + 1_500;
  while (Date.now() < deadline && !stop()) {
    const [row] = await prisma.$queryRaw<Array<{ rel: string }>>`
      SELECT l.relation::regclass::text AS rel
        FROM pg_stat_activity a JOIN pg_locks l ON l.pid = a.pid AND l.locktype = 'tuple'
       WHERE a.wait_event_type = 'Lock' AND ${holderPid} = ANY(pg_blocking_pids(a.pid))
       LIMIT 1`;
    if (row !== undefined) return row.rel;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

describe('pausePayments, failing after the consume', () => {
  it('rolls the consume back with the rest, so the link still pauses afterwards', async () => {
    const s = uniqueSuffix();
    const email = `pause-lock-${s}@test.local`;
    const t = await prisma.teacher.create({
      data: { firstName: 'Pause', lastName: 'Lock', email, bio: '', pageSlug: `pause-lock-${s}`, account: { create: { email } } },
      select: { id: true, accountId: true },
    });
    teacherIds.push(t.id);
    accountIds.push(t.accountId);
    const now = new Date();
    const ev = await prisma.payoutChangeEvent.create({
      data: { teacherId: t.id, kind: 'bank_account_added', accountCurrency: 'EUR', after: '•••• 1234', createdAt: now },
      select: { id: true },
    });
    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.payoutPauseToken.create({
      data: { tokenHash: hashToken(raw), teacherId: t.id, eventId: ev.id, expiresAt: new Date(now.getTime() + DAY_MS) },
    });
    // Recent, so the pause deletes it before the sessions: it has gone when
    // the session delete waits, and the rollback must bring it back.
    const pk = `pause-lock-pk-${s}`;
    await prisma.passkeyCredential.create({
      data: { id: pk, accountId: t.accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt: now },
    });
    // Names no credential, so the passkey delete's `SET NULL` passes it by and
    // the wait falls on the session delete.
    const sessionId = hashToken(await seedSession(prisma, t.accountId));

    const holder = new PrismaClient();
    const held = latch();
    const release = latch();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx: Prisma.TransactionClient) => {
      const [own] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
      if (own === undefined) throw new Error('pg_backend_pid returned no row');
      holderPid = own.pid;
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionId} FOR UPDATE`;
      held.open();
      await release.promise;
    }, { timeout: 30_000 });
    let failure: unknown = null;
    let parkedOn: string | null = null;
    try {
      await held.promise;
      let settled = false;
      const pending = pausePayments(prisma, raw, now).then(() => null, (err: unknown) => err).finally(() => { settled = true; });
      // The pause must be queued on the held session, not stopped earlier,
      // for the survival assertions below to be about the session delete.
      parkedOn = await parkedTableBehind(holderPid, () => settled);
      failure = await pending;
    } finally {
      release.open();
      await holding;
      await holder.$disconnect();
    }

    expect(parkedOn).toBe('"Session"');
    expect(isLockTimeout(failure)).toBe(true);
    expect(await prisma.payoutPauseToken.count({ where: { tokenHash: hashToken(raw) } })).toBe(1);
    const state = await prisma.teacher.findUniqueOrThrow({ where: { id: t.id }, select: { paymentsPausedAt: true } });
    expect(state.paymentsPausedAt).toBeNull();
    expect(await prisma.session.count({ where: { accountId: t.accountId } })).toBe(1);
    expect(await prisma.passkeyCredential.count({ where: { id: pk } })).toBe(1);

    expect(await pausePayments(prisma, raw, now)).toEqual({ status: 'paused' });
  }, 20_000);
});
