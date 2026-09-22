/**
 * @serial-tier lock-contention — holds an uncommitted delete of an
 * `Invitation` row while this route's `update` of the same row waits on its
 * lock, and asserts that the waiter parked, via `pg_blocking_pids`. Lock
 * noise from a neighbour in the parallel tier would stretch that wait past
 * the window the assertion allows.
 *
 * `PATCH` is invoked directly against the test database, the technique
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts` uses. PATCH
 * reads the row before it writes, so only this interleaving reaches its
 * write with the row gone.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../../tests/helpers';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { PATCH } from './route';

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

describe('PATCH /api/invitations/[id] answers NOT_FOUND for a row deleted mid-request (#197)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers NOT_FOUND, not a 500, when the archive write finds the row gone', async () => {
    const suffix = `patch-race-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Patch', lastName: 'Race', email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Archive race fixture', pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    const invitation = await prisma.invitation.create({
      data: {
        teacherId: teacher.id, email: `${suffix}-contact@test.local`,
        firstName: 'Gone', lastName: 'Contact',
      },
      select: { id: true },
    });
    try {
      const token = await seedSession(prisma, teacher.accountId);
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.invitation.delete({ where: { id: invitation.id } });
        },
        () => PATCH(
          new NextRequest(`http://localhost:3000/api/invitations/${invitation.id}?state=archived`, {
            method: 'PATCH',
            headers: cookie(token),
          }),
          { params: Promise.resolve({ id: invitation.id }) },
        ),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'NOT_FOUND');
      expect(await prisma.invitation.findUnique({ where: { id: invitation.id } })).toBeNull();
    } finally {
      await prisma.invitation.deleteMany({ where: { teacherId: teacher.id } });
      await prisma.session.deleteMany({ where: { accountId: teacher.accountId } });
      await prisma.teacher.deleteMany({ where: { id: teacher.id } });
      await prisma.account.deleteMany({ where: { id: teacher.accountId } });
    }
  }, 20_000);
});
