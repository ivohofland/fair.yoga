/**
 * @serial-tier lock-contention — holds an uncommitted `DELETE` of a studio
 * class's calendar entry while this route's own delete of that row waits on
 * it, and asserts the route started waiting inside a fixed window. Lock noise
 * from a tier-mate can push the wait past that window and fail the case for a
 * reason that is not the route's.
 *
 * `DELETE` is invoked directly, as `src/app/api/classes/route.test.ts` invokes
 * its `POST`.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient, type Prisma } from '@prisma/client';
import { log } from '@/lib/log';
import { hhmmToTime } from '@/lib/time-of-day';
import { cookie, seedSession, uniqueSuffix } from '../../../../../tests/helpers';
import { createStudioClassFixture } from '../../../../../tests/class-fixtures';
import { expectRefusal } from '../../../../../tests/api-assertions';
import { DELETE } from './route';

const prisma = new PrismaClient();
const suffix = `studio-delete-lock-${uniqueSuffix()}`;

/** How long the holder may take to report that it is in place. */
const HANDSHAKE_MS = 2_000;

/** How long the route may take to start waiting on the holder. */
const WAIT_MS = 1_500;

type Tracked<T> = { racer: Promise<T>; settled: () => boolean };

function remove(token: string, studioClassId: string): Promise<Response> {
  return DELETE(
    new NextRequest(`http://localhost:3000/api/studio-classes/${studioClassId}`, {
      method: 'DELETE',
      headers: cookie(token),
    }),
    { params: Promise.resolve({ id: studioClassId }) },
  );
}

function track<T>(racer: Promise<T>): Tracked<T> {
  let done = false;
  void racer.then(
    () => { done = true; },
    () => { done = true; },
  );
  return { racer, settled: () => done };
}

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

async function handshake(signal: Promise<void>, label: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      signal,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} never happened within ${HANDSHAKE_MS}ms`)),
          HANDSHAKE_MS,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

describe('DELETE /api/studio-classes/[id] against a concurrent delete of the same class', () => {
  let teacherId: string;
  let accountId: string;
  let token: string;

  beforeAll(async () => {
    await prisma.$connect();
    const email = `${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Studio', lastName: 'Twin', email, bio: 'studio delete race fixture',
        pageSlug: suffix, account: { create: { email } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    token = await seedSession(prisma, accountId);
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('answers NOT_FOUND from its P2025 catch when the other delete commits first', async () => {
    // No `scheduleRuleId`, and dated well before today: a removal this route
    // is meant to allow, so the race below is the only thing left to decide
    // the answer.
    const sc = await createStudioClassFixture(prisma, {
      teacherId,
      classType: 'Twin Removal',
      date: new Date('2020-07-01T00:00:00.000Z'),
      startTime: hhmmToTime('07:00'),
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
    });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    onTestFinished(() => warn.mockRestore());

    const holderDeleted = latch();
    const release = latch();
    let holderPid = 0;
    const holding = prisma.$transaction(
      async (tx) => {
        holderPid = await ownPid(tx);
        await tx.$executeRaw`DELETE FROM "CalendarEntry" WHERE id = ${sc.calendarEntryId}`;
        holderDeleted.open();
        await release.promise;
      },
      { timeout: 10_000 },
    );

    let removing: Tracked<Response> | undefined;
    let waited = false;
    try {
      await handshake(holderDeleted.promise, 'the holder deleting the entry');
      removing = track(remove(token, sc.id));
      waited = (await waiterOf(holderPid, removing.settled)) !== null;
    } finally {
      release.open();
      await holding.catch(() => undefined);
      await removing?.racer.catch(() => undefined);
    }
    if (removing === undefined) throw new Error('the removal never started');

    await holding;
    expect(waited).toBe(true);
    await expectRefusal(await removing.racer, 'NOT_FOUND');
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ studioClassId: sc.id, teacherId }),
      'studio class vanished between the ownership read and the delete',
    );
    expect(await prisma.calendarEntry.count({ where: { id: sc.calendarEntryId } })).toBe(0);
  }, 15_000);
});
