/**
 * @serial-tier lock-contention — holds an erasure's `FOR NO KEY UPDATE` on a
 * teacher while this route's save of that teacher's bank account waits on
 * the same row, and asserts that the save parked, via `pg_blocking_pids`.
 * Lock noise from a neighbour in the parallel tier would stretch that wait
 * past the window the assertion allows.
 *
 * `PUT` is invoked directly against the test database, the technique
 * `src/app/api/teachers/[id]/route-lock-order.test.ts` uses.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../../../../tests/helpers';
import { PUT } from './route';

const prisma = new PrismaClient();

const WAIT_MS = 1_500;

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

/**
 * Sends `request` while a second connection holds `hold`'s writes
 * uncommitted, and commits them only once `request` is parked behind them.
 */
async function raceBehindHolder(
  hold: (tx: Prisma.TransactionClient) => Promise<void>,
  request: () => Promise<Response>,
): Promise<{ res: Response; parked: boolean }> {
  const holder = new PrismaClient();
  const held = latch();
  const release = latch();
  let holderPid = 0;
  const holding = holder.$transaction(async (tx) => {
    holderPid = await ownPid(tx);
    await hold(tx);
    held.open();
    await release.promise;
  }, { timeout: 20_000 });
  try {
    await Promise.race([held.promise, holding]);
    let settled = false;
    const pending = request().finally(() => { settled = true; });
    void pending.catch(() => undefined);
    const parked = (await waiterOf(holderPid, () => settled)) !== null;
    release.open();
    await holding;
    return { res: await pending, parked };
  } finally {
    release.open();
    await holding.catch(() => undefined);
    await holder.$disconnect();
  }
}

/**
 * An erasure holds the teacher row `FOR NO KEY UPDATE` from its first
 * statement to its commit and deletes the teacher's bank accounts
 * (`docs/lock-order.md`, "The `Teacher` row is the first lock (#758)"). A
 * save arriving meanwhile must wait on that row and then find it erased;
 * a save that did not would insert its account after the erasure's delete.
 */
describe('PUT /api/teachers/[id]/bank-accounts/[currency] during an erasure writes nothing (#758)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers 404 and leaves the erased teacher with no account', async () => {
    const suffix = `bank-race-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const subject = await prisma.teacher.create({
      data: {
        firstName: 'Bank', lastName: 'Race', email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Bank race fixture', pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    try {
      const token = await seedSession(prisma, subject.accountId);
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Teacher" WHERE id = ${subject.id} FOR NO KEY UPDATE`;
          await tx.teacher.update({
            where: { id: subject.id },
            data: { bio: '', firstName: 'Deleted', deletedAt: new Date() },
          });
          await tx.teacherBankAccount.deleteMany({ where: { teacherId: subject.id } });
        },
        () => PUT(
          new NextRequest(`http://localhost:3000/api/teachers/${subject.id}/bank-accounts/EUR`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...cookie(token) },
            body: JSON.stringify({ holderName: 'A. Teacher', iban: 'NL91ABNA0417164300' }),
          }),
          { params: Promise.resolve({ id: subject.id, currency: 'EUR' }) },
        ),
      );

      expect(parked).toBe(true);
      expect(res.status).toBe(404);
      expect(await prisma.teacherBankAccount.count({ where: { teacherId: subject.id } })).toBe(0);
    } finally {
      await prisma.session.deleteMany({ where: { accountId: subject.accountId } });
      await prisma.teacher.deleteMany({ where: { id: subject.id } });
      await prisma.account.deleteMany({ where: { id: subject.accountId } });
    }
  }, 20_000);
});
