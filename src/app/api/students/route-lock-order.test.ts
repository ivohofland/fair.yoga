/**
 * @serial-tier lock-contention — holds an uncommitted `Invitation` insert
 * while this route's own create waits on the same `(teacherId, email)` key,
 * and asserts that the waiter parked, via `pg_blocking_pids`. Lock noise from
 * a neighbour in the parallel tier would stretch that wait past the window
 * the assertion allows.
 *
 * `POST` is invoked directly against the test database, the technique
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts` uses. A twin
 * with different names is pinned over HTTP by
 * `tests/integration/students-api.test.ts`; this file pins the twin that
 * carries the same ones.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../tests/helpers';
import { expectUnchanged } from '../../../../tests/api-assertions';
import { POST } from './route';

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

async function makeTeacher() {
  const suffix = `invite-race-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Race', lastName: 'Inviter', email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Invite race fixture', pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  return {
    suffix,
    teacherId: teacher.id,
    accountId: teacher.accountId,
    token: await seedSession(prisma, teacher.accountId),
  };
}

describe('POST /api/students answers a lost create by re-reading the winner (#197)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers unchanged, naming the winner, when the twin that won carries the same names, and stamps nothing', async () => {
    const fx = await makeTeacher();
    const email = `${fx.suffix}-invitee@test.local`;
    try {
      let winnerId = '';
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          const row = await tx.invitation.create({
            data: { teacherId: fx.teacherId, email, firstName: 'Same', lastName: 'Names' },
            select: { id: true },
          });
          winnerId = row.id;
        },
        () => POST(new NextRequest('http://localhost:3000/api/students', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...cookie(fx.token) },
          body: JSON.stringify({ firstName: 'Same', lastName: 'Names', email }),
        })),
      );

      expect(parked).toBe(true);
      expect(await expectUnchanged(res)).toEqual({ id: winnerId });
      // The holder wrote no marker, and this request must not have either.
      expect(
        await prisma.invitation.findMany({
          where: { teacherId: fx.teacherId, email },
          select: { id: true, lastNotifiedAt: true },
        }),
      ).toEqual([{ id: winnerId, lastNotifiedAt: null }]);
    } finally {
      await prisma.invitation.deleteMany({ where: { teacherId: fx.teacherId } });
      await prisma.session.deleteMany({ where: { accountId: fx.accountId } });
      await prisma.teacher.deleteMany({ where: { id: fx.teacherId } });
      await prisma.account.deleteMany({ where: { id: fx.accountId } });
    }
  }, 20_000);
});
