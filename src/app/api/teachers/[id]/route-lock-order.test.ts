/**
 * @serial-tier lock-contention — holds an uncommitted `pageSlug` change on
 * one teacher while this route's update of another teacher waits on the same
 * unique key, and asserts that the waiter parked, via `pg_blocking_pids`. Lock
 * noise from a neighbour in the parallel tier would stretch that wait past the
 * window the assertion allows.
 *
 * `PUT` is invoked directly against the test database, the technique
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts` uses. The
 * route's pre-check is a plain read, so it cannot see the holder's slug. What
 * answers is the update's own catch.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../../tests/helpers';
import { expectRefusal } from '../../../../../tests/api-assertions';
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

async function makeTeacher(tag: string) {
  const suffix = `slug-race-${tag}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Slug', lastName: 'Race', email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Slug race fixture', pageSlug: suffix,
    },
    select: { id: true, accountId: true, pageSlug: true },
  });
  return { ...teacher, suffix };
}

describe('PUT /api/teachers/[id] answers a slug claimed after its pre-check with SLUG_TAKEN (#197)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('refuses the update with SLUG_TAKEN and leaves both slugs as the holder left them', async () => {
    const caller = await makeTeacher('caller');
    const claimer = await makeTeacher('claimer');
    const wanted = `${caller.suffix}-wanted`;
    try {
      const token = await seedSession(prisma, caller.accountId);
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.teacher.update({ where: { id: claimer.id }, data: { pageSlug: wanted } });
        },
        () => PUT(
          new NextRequest(`http://localhost:3000/api/teachers/${caller.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', ...cookie(token) },
            body: JSON.stringify({ pageSlug: wanted }),
          }),
          { params: Promise.resolve({ id: caller.id }) },
        ),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'SLUG_TAKEN');
      const rows = await prisma.teacher.findMany({
        where: { id: { in: [caller.id, claimer.id] } },
        select: { id: true, pageSlug: true },
      });
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        { id: caller.id, pageSlug: caller.pageSlug },
        { id: claimer.id, pageSlug: wanted },
      ]));
    } finally {
      for (const t of [caller, claimer]) {
        await prisma.session.deleteMany({ where: { accountId: t.accountId } });
        await prisma.teacher.deleteMany({ where: { id: t.id } });
        await prisma.account.deleteMany({ where: { id: t.accountId } });
      }
    }
  }, 20_000);
});
