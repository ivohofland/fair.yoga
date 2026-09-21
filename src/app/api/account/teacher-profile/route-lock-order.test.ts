/**
 * @serial-tier lock-contention — holds an uncommitted `Teacher` insert while
 * this route's own create waits on the same unique keys, and asserts that the
 * waiter parked, via `pg_blocking_pids`. Lock noise from a neighbour in the
 * parallel tier would stretch that wait past the window the assertion allows.
 *
 * `POST` is invoked directly against the test database, the technique
 * `src/app/api/students/[id]/privacy/route-lock-order.test.ts` uses. What is
 * under test is the route's catch. A create that loses to a twin re-reads the
 * caller's own account and answers as the pre-check would.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { cookie, seedSession } from '../../../../../tests/helpers';
import { expectRefusal, expectUnchanged } from '../../../../../tests/api-assertions';
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

/** A signed-in account with a live student side and no teacher side. */
async function makeStudentAccount(tag: string) {
  const suffix = `tp-race-${tag}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const email = `${suffix}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Race', lastName: 'Student', email, claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { accountId: true },
  });
  if (student.accountId === null) throw new Error('fixture student has no account');
  return {
    suffix,
    email,
    accountId: student.accountId,
    token: await seedSession(prisma, student.accountId),
  };
}

type Fixture = Awaited<ReturnType<typeof makeStudentAccount>>;

async function cleanup(fx: Fixture, otherEmail?: string): Promise<void> {
  await prisma.session.deleteMany({ where: { accountId: fx.accountId } });
  await prisma.teacher.deleteMany({ where: { accountId: fx.accountId } });
  await prisma.student.deleteMany({ where: { accountId: fx.accountId } });
  await prisma.account.deleteMany({ where: { id: fx.accountId } });
  if (otherEmail) {
    await prisma.teacher.deleteMany({ where: { email: otherEmail } });
    await prisma.account.deleteMany({ where: { email: otherEmail } });
  }
}

function postProfile(token: string, body: Record<string, string>): Promise<Response> {
  return POST(
    new NextRequest('http://localhost:3000/api/account/teacher-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST /api/account/teacher-profile answers a lost create by re-reading the account (#197)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('answers unchanged, naming the twin, when the twin that won holds the same values', async () => {
    const fx = await makeStudentAccount('same');
    try {
      let twinId = '';
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          const twin = await tx.teacher.create({
            data: {
              accountId: fx.accountId, email: fx.email, firstName: 'Race', lastName: 'Twin',
              bio: 'Same bio', pageSlug: fx.suffix, defaultTimezone: 'Europe/Amsterdam',
            },
            select: { id: true },
          });
          twinId = twin.id;
        },
        () => postProfile(fx.token, {
          firstName: 'Race', lastName: 'Twin', bio: 'Same bio', pageSlug: fx.suffix,
        }),
      );

      expect(parked).toBe(true);
      expect(await expectUnchanged(res)).toEqual({ teacherId: twinId });
      expect(await prisma.teacher.count({ where: { accountId: fx.accountId } })).toBe(1);
    } finally {
      await cleanup(fx);
    }
  }, 20_000);

  it('answers ALREADY_TEACHER when the twin that won holds a different bio', async () => {
    const fx = await makeStudentAccount('differs');
    try {
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.teacher.create({
            data: {
              accountId: fx.accountId, email: fx.email, firstName: 'Race', lastName: 'Twin',
              bio: 'Holder bio', pageSlug: fx.suffix,
            },
          });
        },
        () => postProfile(fx.token, {
          firstName: 'Race', lastName: 'Twin', bio: 'Request bio', pageSlug: fx.suffix,
        }),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'ALREADY_TEACHER');
      const rows = await prisma.teacher.findMany({
        where: { accountId: fx.accountId },
        select: { bio: true },
      });
      expect(rows).toEqual([{ bio: 'Holder bio' }]);
    } finally {
      await cleanup(fx);
    }
  }, 20_000);

  it('answers SLUG_TAKEN when another account took the slug, even with identical values', async () => {
    const fx = await makeStudentAccount('slug');
    const otherEmail = `${fx.suffix}-other@test.local`;
    try {
      const { res, parked } = await raceBehindHolder(
        async (tx) => {
          await tx.teacher.create({
            data: {
              email: otherEmail, firstName: 'Race', lastName: 'Twin',
              bio: 'Same bio', pageSlug: fx.suffix,
              account: { create: { email: otherEmail } },
            },
          });
        },
        () => postProfile(fx.token, {
          firstName: 'Race', lastName: 'Twin', bio: 'Same bio', pageSlug: fx.suffix,
        }),
      );

      expect(parked).toBe(true);
      await expectRefusal(res, 'SLUG_TAKEN');
      expect(await prisma.teacher.count({ where: { accountId: fx.accountId } })).toBe(0);
    } finally {
      await cleanup(fx, otherEmail);
    }
  }, 20_000);
});
