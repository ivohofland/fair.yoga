/**
 * @serial-tier lock-contention — each parking case holds an `Account` row
 * `FOR NO KEY UPDATE` on a second connection and asserts, via
 * `pg_blocking_pids` inside a bounded wait, that the writer under test parked
 * on that row before touching a session or a passkey. The timeout case holds
 * it past the shared `lock_timeout` (`LOCK_TIMEOUT_SQL`) and asserts that
 * failure. The reported-deadlock case holds a `Session` row instead, so the
 * real pause parks on it holding the account row, and asserts the real
 * sign-out then parks behind the pause on that row. Lock noise from a
 * neighbour in the parallel tier would stretch a wait past the window the
 * assertion allows, or the timeout case past Prisma's interactive-transaction
 * `timeout`.
 *
 * Every transaction that writes more than one of an account's sessions,
 * directly or through a passkey delete's `ON DELETE SET NULL`, takes the
 * account row first, so two of them queue on one row instead of deadlocking
 * across the sessions (`docs/lock-order.md`, "The `Account` row orders
 * multi-session sign-out writes").
 */
import { describe, it, expect, afterAll } from 'vitest';
import crypto from 'crypto';
import { PrismaClient, Prisma } from '@prisma/client';
import { hashToken } from '@/lib/auth/magic-link';
import { isLockTimeout } from '@/lib/api-errors';
import { signOutEverywhere } from './account-sign-out';
import { pausePayments } from './payout-pause';
import { revokePasskeyByLink } from './passkey-revoke';
import { mintPasskeyRevokeToken } from './passkey-revoke-token';
import { deletePasskey } from './passkey-credentials';
import { deleteStudentAccount, deleteTeacherAccount } from './gdpr';
import { uniqueSuffix } from '../../tests/helpers';

const prisma = new PrismaClient();
const WAIT_MS = 1_500;
const DAY_MS = 24 * 60 * 60 * 1000;
const accountIds: string[] = [];
const teacherIds: string[] = [];
const studentIds: string[] = [];

afterAll(async () => {
  await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyRevokeToken.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.removedPasskey.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.passkeyCredential.deleteMany({ where: { accountId: { in: accountIds } } });
  await prisma.payoutPauseToken.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.payoutChangeEvent.deleteMany({ where: { teacherId: { in: teacherIds } } });
  await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  await prisma.$disconnect();
});

function latch(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((r) => { open = r; });
  return { promise, open };
}

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

/** The table of the row the parked `pid` is queued for. */
async function waitedTable(pid: number): Promise<string | null> {
  const [row] = await prisma.$queryRaw<Array<{ rel: string }>>`
    SELECT relation::regclass::text AS rel FROM pg_locks
     WHERE pid = ${pid} AND locktype = 'tuple' LIMIT 1`;
  return row?.rel ?? null;
}

/**
 * How many of the account's `Session` and `PasskeyCredential` rows another
 * transaction holds a row lock on: a delete or a `SET NULL` locks the rows it
 * touches until commit, so a writer that parked before its first such write
 * holds none.
 */
async function lockedAccountRows(accountId: string): Promise<number> {
  const [row] = await prisma.$queryRaw<Array<{ locked: number }>>`
    SELECT (
      (SELECT count(*) FROM "Session" WHERE "accountId" = ${accountId})
      - (SELECT count(*) FROM (SELECT id FROM "Session" WHERE "accountId" = ${accountId} FOR UPDATE SKIP LOCKED) s)
      + (SELECT count(*) FROM "PasskeyCredential" WHERE "accountId" = ${accountId})
      - (SELECT count(*) FROM (SELECT id FROM "PasskeyCredential" WHERE "accountId" = ${accountId} FOR UPDATE SKIP LOCKED) p)
    )::int AS locked`;
  if (row === undefined) throw new Error('lockedAccountRows returned no row');
  return row.locked;
}

/**
 * Runs `writer` while a second connection holds the account row
 * `FOR NO KEY UPDATE`, and reports where it parked and what it had locked by
 * then. The hold is released once the parking is read, or once `holdMs`
 * passes when `holdMs` is given.
 */
async function underHeldAccount<T>(
  accountId: string,
  writer: () => Promise<T>,
  holdMs?: number,
): Promise<{ parkedOn: string | null; lockedWhileParked: number | null; result: PromiseSettledResult<T> }> {
  const holder = new PrismaClient();
  const held = latch();
  const release = latch();
  let holderPid = 0;
  const holding = holder.$transaction(async (tx) => {
    holderPid = await ownPid(tx);
    await tx.$queryRaw`SELECT id FROM "Account" WHERE id = ${accountId} FOR NO KEY UPDATE`;
    held.open();
    await release.promise;
  }, { timeout: 20_000 });

  let parkedOn: string | null = null;
  let lockedWhileParked: number | null = null;
  let result: PromiseSettledResult<T>;
  try {
    await held.promise;
    let settled = false;
    const pending = writer().finally(() => { settled = true; });
    void pending.catch(() => undefined);
    const waiter = await waiterOf(holderPid, () => settled);
    if (waiter !== null) {
      parkedOn = await waitedTable(waiter);
      lockedWhileParked = await lockedAccountRows(accountId);
    }
    if (holdMs !== undefined) await Promise.race([pending.catch(() => undefined), new Promise((r) => setTimeout(r, holdMs))]);
    release.open();
    await holding;
    [result] = await Promise.allSettled([pending]);
  } finally {
    release.open();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
  return { parkedOn, lockedWhileParked, result };
}

function fulfilled<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

async function seedSessions(accountId: string, passkeyCredentialId: string | null): Promise<void> {
  const expiresAt = new Date(Date.now() + DAY_MS);
  await prisma.session.create({ data: { id: hashToken(crypto.randomBytes(32).toString('hex')), accountId, expiresAt } });
  await prisma.session.create({
    data: { id: hashToken(crypto.randomBytes(32).toString('hex')), accountId, expiresAt, passkeyCredentialId },
  });
}

async function seedPasskey(accountId: string, id: string, createdAt: Date = new Date()): Promise<void> {
  await prisma.passkeyCredential.create({
    data: { id, accountId, publicKey: Buffer.from('k'), counter: 0, transports: [], createdAt },
  });
}

async function seedAccount(prefix: string): Promise<string> {
  const s = uniqueSuffix();
  const account = await prisma.account.create({ data: { email: `${prefix}-${s}@test.local` }, select: { id: true } });
  accountIds.push(account.id);
  return account.id;
}

async function seedTeacher(prefix: string): Promise<{ id: string; accountId: string }> {
  const s = uniqueSuffix();
  const email = `${prefix}-${s}@test.local`;
  const t = await prisma.teacher.create({
    data: { firstName: 'Acct', lastName: 'Lock', email, bio: '', pageSlug: `${prefix}-${s}`, account: { create: { email } } },
    select: { id: true, accountId: true },
  });
  teacherIds.push(t.id);
  accountIds.push(t.accountId);
  return t;
}

describe('every multi-session sign-out writer parks on the Account row', () => {
  it('signOutEverywhere', async () => {
    const accountId = await seedAccount('acct-soe');
    await seedSessions(accountId, null);

    const { parkedOn, lockedWhileParked, result } = await underHeldAccount(accountId, () =>
      signOutEverywhere(prisma, accountId),
    );

    expect(parkedOn).toBe('"Account"');
    expect(lockedWhileParked).toBe(0);
    expect(fulfilled(result)).toEqual({ sessions: 2, pushSubscriptions: 0 });
  }, 20_000);

  it('pausePayments', async () => {
    const t = await seedTeacher('acct-pause');
    const now = new Date();
    const ev = await prisma.payoutChangeEvent.create({
      data: { teacherId: t.id, kind: 'bank_account_added', accountCurrency: 'EUR', after: '•••• 1234', createdAt: now },
      select: { id: true },
    });
    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.payoutPauseToken.create({
      data: { tokenHash: hashToken(raw), teacherId: t.id, eventId: ev.id, expiresAt: new Date(now.getTime() + DAY_MS) },
    });
    // Created now, so it is past the cutoff and the pause deletes it; one
    // session signed in with it, one by magic link.
    const credentialId = `acct-pause-pk-${uniqueSuffix()}`;
    await seedPasskey(t.accountId, credentialId, now);
    await seedSessions(t.accountId, credentialId);

    const { parkedOn, lockedWhileParked, result } = await underHeldAccount(t.accountId, () =>
      pausePayments(prisma, raw, now),
    );

    expect(parkedOn).toBe('"Account"');
    expect(lockedWhileParked).toBe(0);
    expect(fulfilled(result)).toEqual({ status: 'paused' });
    expect(await prisma.session.count({ where: { accountId: t.accountId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { accountId: t.accountId } })).toBe(0);
  }, 20_000);

  it('revokePasskeyByLink, on a student-only account', async () => {
    const accountId = await seedAccount('acct-revoke');
    const credentialId = `acct-revoke-pk-${uniqueSuffix()}`;
    await seedPasskey(accountId, credentialId);
    await seedSessions(accountId, credentialId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId });

    const { parkedOn, lockedWhileParked, result } = await underHeldAccount(accountId, () =>
      revokePasskeyByLink(prisma, raw),
    );

    expect(parkedOn).toBe('"Account"');
    expect(lockedWhileParked).toBe(0);
    expect(fulfilled(result).status).toBe('revoked');
    expect(await prisma.session.count({ where: { accountId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { accountId } })).toBe(0);
  }, 20_000);

  it('deletePasskey, on a student-only account', async () => {
    const accountId = await seedAccount('acct-delpk');
    const credentialId = `acct-delpk-pk-${uniqueSuffix()}`;
    await seedPasskey(accountId, credentialId);
    await seedSessions(accountId, credentialId);

    const { parkedOn, lockedWhileParked, result } = await underHeldAccount(accountId, () =>
      deletePasskey(prisma, { accountId, credentialId }),
    );

    expect(parkedOn).toBe('"Account"');
    expect(lockedWhileParked).toBe(0);
    expect(fulfilled(result)).toEqual({ status: 'deleted', removedAt: expect.any(Date) });
    expect(await prisma.passkeyCredential.count({ where: { id: credentialId } })).toBe(0);
  }, 20_000);

  it('deleteStudentAccount, for a student whose account has no teacher', async () => {
    const s = uniqueSuffix();
    const email = `acct-erase-st-${s}@test.local`;
    const student = await prisma.student.create({
      data: { firstName: 'Acct', lastName: 'Erase', email, claimedAt: new Date(), account: { create: { email } } },
      select: { id: true, accountId: true },
    });
    studentIds.push(student.id);
    if (student.accountId === null) throw new Error('student fixture has no account');
    const accountId = student.accountId;
    accountIds.push(accountId);
    const credentialId = `acct-erase-st-pk-${s}`;
    await seedPasskey(accountId, credentialId);
    await seedSessions(accountId, credentialId);

    const { parkedOn, lockedWhileParked, result } = await underHeldAccount(accountId, () =>
      deleteStudentAccount(prisma, student.id),
    );

    expect(parkedOn).toBe('"Account"');
    expect(lockedWhileParked).toBe(0);
    expect(fulfilled(result)).toEqual({ erased: true });
    expect(await prisma.session.count({ where: { accountId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { accountId } })).toBe(0);
  }, 20_000);

  it('deleteTeacherAccount, for a teacher whose account has no student', async () => {
    const t = await seedTeacher('acct-erase-t');
    const credentialId = `acct-erase-t-pk-${uniqueSuffix()}`;
    await seedPasskey(t.accountId, credentialId);
    await seedSessions(t.accountId, credentialId);

    const { parkedOn, lockedWhileParked, result } = await underHeldAccount(t.accountId, () =>
      deleteTeacherAccount(prisma, t.id),
    );

    expect(parkedOn).toBe('"Account"');
    expect(lockedWhileParked).toBe(0);
    expect(fulfilled(result)).toEqual({ erased: true });
    expect(await prisma.session.count({ where: { accountId: t.accountId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { accountId: t.accountId } })).toBe(0);
  }, 20_000);
});

describe('the reported deadlock: a pause and sign-out-everywhere on one account', () => {
  it('queues the sign-out behind the pause on the Account row, and both commit', async () => {
    const t = await seedTeacher('acct-pause-soe');
    const now = new Date();
    const ev = await prisma.payoutChangeEvent.create({
      data: { teacherId: t.id, kind: 'bank_account_added', accountCurrency: 'EUR', after: '•••• 1234', createdAt: now },
      select: { id: true },
    });
    const raw = crypto.randomBytes(32).toString('hex');
    await prisma.payoutPauseToken.create({
      data: { tokenHash: hashToken(raw), teacherId: t.id, eventId: ev.id, expiresAt: new Date(now.getTime() + DAY_MS) },
    });
    // P is recent, so the pause deletes it, and its `SET NULL` locks S_b
    // before the pause reaches its session delete.
    const credentialId = `acct-pause-soe-pk-${uniqueSuffix()}`;
    await seedPasskey(t.accountId, credentialId, now);
    const expiresAt = new Date(Date.now() + DAY_MS);
    const sessionA = hashToken(crypto.randomBytes(32).toString('hex'));
    await prisma.session.create({ data: { id: sessionA, accountId: t.accountId, expiresAt } });
    await prisma.session.create({
      data: { id: hashToken(crypto.randomBytes(32).toString('hex')), accountId: t.accountId, expiresAt, passkeyCredentialId: credentialId },
    });

    // Holds S_a, so the pause stops at its session delete with P gone and
    // S_b locked: the moment the review's sign-out arrived.
    const holder = new PrismaClient();
    const held = latch();
    const release = latch();
    let holderPid = 0;
    const holding = holder.$transaction(async (tx) => {
      holderPid = await ownPid(tx);
      await tx.$queryRaw`SELECT id FROM "Session" WHERE id = ${sessionA} FOR UPDATE`;
      held.open();
      await release.promise;
    }, { timeout: 20_000 });

    let pauseParkedOn: string | null = null;
    let signOutParkedOn: string | null = null;
    let outcomes: [PromiseSettledResult<unknown>, PromiseSettledResult<unknown>];
    try {
      await held.promise;
      let pauseSettled = false;
      const pause = pausePayments(prisma, raw, now).finally(() => { pauseSettled = true; });
      void pause.catch(() => undefined);
      const pausePid = await waiterOf(holderPid, () => pauseSettled);
      if (pausePid !== null) pauseParkedOn = await waitedTable(pausePid);

      let signOutSettled = false;
      const signOut = signOutEverywhere(prisma, t.accountId).finally(() => { signOutSettled = true; });
      void signOut.catch(() => undefined);
      if (pausePid !== null) {
        const signOutPid = await waiterOf(pausePid, () => signOutSettled);
        if (signOutPid !== null) signOutParkedOn = await waitedTable(signOutPid);
      }

      release.open();
      await holding;
      outcomes = await Promise.allSettled([pause, signOut]);
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await holder.$disconnect();
    }

    expect(pauseParkedOn).toBe('"Session"');
    expect(signOutParkedOn).toBe('"Account"');
    expect(fulfilled(outcomes[0])).toEqual({ status: 'paused' });
    expect(fulfilled(outcomes[1])).toEqual({ sessions: 0, pushSubscriptions: 0 });
    expect(await prisma.session.count({ where: { accountId: t.accountId } })).toBe(0);
  }, 20_000);
});

describe('two sign-outs and a held account row', () => {
  it('two concurrent signOutEverywhere calls on one account both resolve and leave no session', async () => {
    const accountId = await seedAccount('acct-soe-twice');
    const credentialId = `acct-soe-twice-pk-${uniqueSuffix()}`;
    await seedPasskey(accountId, credentialId);
    await seedSessions(accountId, credentialId);

    const outcomes = await Promise.all([signOutEverywhere(prisma, accountId), signOutEverywhere(prisma, accountId)]);

    expect(outcomes.map((o) => o.sessions).sort()).toEqual([0, 2]);
    expect(await prisma.session.count({ where: { accountId } })).toBe(0);
  }, 20_000);

  it('signOutEverywhere held past lock_timeout fails with a lock timeout and deletes nothing', async () => {
    const accountId = await seedAccount('acct-soe-timeout');
    await seedSessions(accountId, null);

    const { parkedOn, result } = await underHeldAccount(accountId, () => signOutEverywhere(prisma, accountId), 5_000);

    expect(parkedOn).toBe('"Account"');
    expect(result.status).toBe('rejected');
    expect(result.status === 'rejected' && isLockTimeout(result.reason)).toBe(true);
    expect(await prisma.session.count({ where: { accountId } })).toBe(2);
  }, 20_000);
});

describe('a revoke link whose account row is gone', () => {
  it('answers invalid and consumes nothing', async () => {
    const accountId = crypto.randomUUID();
    accountIds.push(accountId);
    const raw = await mintPasskeyRevokeToken(prisma, { accountId, credentialId: `acct-gone-pk-${uniqueSuffix()}` });

    expect(await revokePasskeyByLink(prisma, raw)).toEqual({ status: 'invalid' });
    expect(await prisma.passkeyRevokeToken.count({ where: { accountId } })).toBe(1);
  });
});
