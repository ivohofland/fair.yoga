import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';
import { lockClassRowsOrdered } from './db-locks';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();

/**
 * Forces the `WaitlistEntry`-driven nested loop this test's join side needs,
 * by removing every plan shape that would drive the join from `Class`.
 *
 * All three settings are required, and `enable_hashjoin = off` alone is what
 * CI proved insufficient (#239 review). It removes a join ALGORITHM, not a
 * join DIRECTION: with hash joins gone the planner can still pick a nested
 * loop with `Class` as the outer relation and a `Materialize`d `WaitlistEntry`
 * scan inside, which returns `Class` heap order — the SAME order as the scan
 * caller, so the two agree and the reproduction cannot be built.
 *
 * Which side wins is a cost knife-edge on the selectivity estimate for
 * `w."studentId"`, and `WaitlistEntry` has no index leading with that column
 * (`@@unique([classId, studentId])` and `@@index([classId, position])` both
 * lead with `classId`), so there is no plan the planner naturally prefers.
 * Measured across background-row counts on 2026-08-16 it is NON-MONOTONIC —
 * 0 rows and 2 rows and 50 rows pick `Class`-outer, 10 rows picks
 * `WaitlistEntry`-outer — so no amount of seeding makes a cost-chosen plan
 * safe. Adding `enable_mergejoin` and `enable_seqscan` leaves an index-driven
 * nested loop as the only cheap shape, which takes its order from index
 * structure rather than from a cost comparison; verified stable at 0, 2, 10,
 * 50, 100, 200, 1_000, 5_000, 10_000 and 50_000 background rows.
 *
 * `enable_seqscan = off` discourages rather than forbids — Postgres still
 * seq-scans when no index path exists — so this cannot make a statement fail,
 * only bias the planner. `SET LOCAL` is transaction-scoped, so all three live
 * entirely inside the caller's transaction and reach neither the other caller
 * nor production.
 */
async function forceWaitlistDrivenPlan(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
  await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
  await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
}

/**
 * The guard `lockClassRowsOrdered`'s `ORDER BY c.id` exists to be, and the
 * one this project owed after #216/#182: with both sides of a pairing taking
 * every lock in a single ordered statement, the per-pairing reproductions in
 * `template-lock-order.test.ts` can no longer CONSTRUCT an AB-BA cycle, so
 * they no longer detect a missing `ORDER BY` on the erasure side (verified:
 * deleting it leaves all three green). Testing the shared primitive once
 * repays that for every call site at the same time.
 *
 * WHY TWO DIFFERENT PLANS, and not two calls with the same predicate. Two
 * identical statements produce one plan, visit one physical order, and
 * serialise whether or not the clause is there — such a test passes against
 * the bug and proves nothing. `ORDER BY c.id` is load-bearing only where two
 * sites reach the same rows by DIFFERENT plans: the join below is driven by
 * `WaitlistEntry` and returns classes in that table's physical order, while
 * the scan is driven by `Class` and returns them in its own. The fixture
 * inserts the two tables in OPPOSITE orders so the two natural orders
 * disagree, and both premises are asserted before the race rather than
 * assumed — a planner or storage change that makes them agree fails loudly
 * here instead of leaving the test green for an unrelated reason.
 *
 * WHY A THIRD TRANSACTION. Both callers take their locks inside one statement
 * each, so there is no application-level window to interleave — the same
 * property that made the per-pairing reproductions unconstructible. Holding
 * both rows from a third transaction and releasing them parks one caller on
 * each row first, so the collision is deterministic rather than a race this
 * test hopes to win. Same technique as `gdpr.test.ts`'s "a third transaction
 * takes the `Student` row `FOR UPDATE` before either".
 *
 * WHY THE JOIN SIDE FORCES ITS PLAN. The plan this construction models is the
 * production one — a `WaitlistEntry` join driven by that table. Left to the
 * planner it is not reliably that: see `forceWaitlistDrivenPlan` below, which
 * owns the three settings and the measurements behind them. The short version
 * is that the choice is a cost knife-edge on an unindexed column, it is
 * non-monotonic in table size, and this test shipped green on one setting for
 * exactly one CI run before the sibling premise in `gdpr.test.ts` failed on
 * the same commit.
 *
 * THIS TEST PASSED BY LUCK BEFORE #239's REVIEW, and the mechanism is worth
 * keeping written down. Its premise is character-identical to
 * `gdpr.test.ts`'s, and it survived only because it runs earlier in the file
 * order, against a quieter database. Inserting two `ANALYZE` statements after
 * the fixture — modelling an autoanalyze firing there — reproduced CI's exact
 * failure signature here. File order is not a guarantee, which is why the
 * plan is forced rather than hoped for.
 *
 * WHAT DESC DOES AND DOES NOT CATCH. Under `ORDER BY c.id DESC` both callers
 * request [HIGH, LOW], so they queue on the same row and serialise: the
 * DEADLOCK this test is built around cannot be constructed for DESC. The test
 * still FAILS on DESC — measured 3/3 — because the closing assertions pin the
 * returned ids to `[lowClassId, highClassId]`, and both callers hand back
 * [HIGH, LOW] instead. So the clause's direction is caught, just not by the
 * mechanism the rest of this docblock describes. An earlier version of this
 * paragraph said the test PASSES on DESC; that was wrong, and it was wrong in
 * the generous direction — it under-claimed its own coverage. The plan's Step
 * 4 predicted `40P01` under DESC, which did not hold either; the failure is an
 * assertion, not a deadlock. Step 4 is an observation, not a gate.
 *
 * The per-pairing reproduction in `gdpr.test.ts` ("does not deadlock when a
 * teacher erasure and a student erasure overlap on two classes") guards the
 * erasure pairing whichever clause the helper uses.
 */
describe('lockClassRowsOrdered takes multiple Class rows in one order', () => {
  const suffix = `dblocks-order-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let roomId: string;
  let studentId: string;
  let lowClassId: string;
  let highClassId: string;

  beforeAll(async () => {
    lowClassId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    highClassId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;

    // `bio` and `pageSlug` are both required and unique-constrained — copied
    // from the working fixture at `gdpr.test.ts:1251`, not invented.
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Order',
        lastName: 'Teacher',
        email: `${suffix}-teacher@test.local`,
        bio: 'Ordered-lock fixture',
        pageSlug: `${suffix}-teacher`,
        account: { create: { email: `${suffix}-teacher@test.local` } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Venue',
        address: 'Street 1',
        city: 'Town',
        postcode: '1234AB',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const base = {
      teacherId,
      teacherRoomId: teacherRoom.id,
      classType: 'Order class',
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };
    // Classes: HIGH first, so the `Class` scan's natural order is [HIGH, LOW].
    await createClassFixture(prisma, { ...base, id: highClassId, date: new Date('2099-06-01') });
    await createClassFixture(prisma, { ...base, id: lowClassId, date: new Date('2099-06-02') });

    const student = await prisma.student.create({
      data: {
        firstName: 'Order',
        lastName: 'Student',
        email: `${suffix}-student@test.local`,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-student@test.local` } },
      },
      select: { id: true },
    });
    studentId = student.id;

    // Entries: LOW first — the OPPOSITE order to the classes above, which is
    // the whole point. It makes the join's natural order [LOW, HIGH] against
    // the scan's [HIGH, LOW].
    await prisma.waitlistEntry.create({
      data: { classId: lowClassId, studentId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: highClassId, studentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { studentId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { email: { startsWith: suffix } } });
    await prisma.$disconnect();
  });

  it('serialises two callers whose natural orders disagree, instead of deadlocking', async () => {
    // Premise 1: the scan's natural order.
    const scanOrder = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM "Class" c
        JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
       WHERE e."teacherId" = ${teacherId}
    `;
    expect(scanOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

    // Premise 2: the join's natural order — the REVERSE. Asserting premise 1
    // proves nothing about this: different tables, different physical layouts.
    // Runs under the forced plan so the planner drives it from `WaitlistEntry`
    // — see `forceWaitlistDrivenPlan` for why a cost-chosen plan cannot be
    // relied on here, and why one setting was not enough.
    const joinOrder = await prisma.$transaction(async (tx) => {
      await forceWaitlistDrivenPlan(tx);
      return tx.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM "Class" c
        JOIN "WaitlistEntry" w ON w."classId" = c.id
        WHERE w."studentId" = ${studentId}
      `;
    });
    expect(joinOrder.map((r) => r.id)).toEqual([lowClassId, highClassId]);

    // The third transaction: holds BOTH rows so each caller below parks on
    // the first row ITS plan reaches, rather than racing for the same one.
    let releaseHolder!: () => void;
    const holderReleased = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let holderReady!: () => void;
    const holderHasRows = new Promise<void>((resolve) => {
      holderReady = resolve;
    });

    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT id FROM "Class" WHERE id IN (${lowClassId}, ${highClassId}) FOR UPDATE
        `;
        holderReady();
        await holderReleased;
      },
      { timeout: 10_000 },
    );

    await holderHasRows;

    // Caller A: the JOIN plan. Unordered it wants LOW first. The plan override
    // makes it run under the same plan the premise above asserts — the
    // production shape, driven by `WaitlistEntry`.
    const a = prisma.$transaction(
      async (tx) => {
        await forceWaitlistDrivenPlan(tx);
        const ids = await lockClassRowsOrdered(tx, {
          join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
          where: Prisma.sql`w."studentId" = ${studentId}`,
        });
        // Held briefly so the other caller genuinely queues behind these rows
        // rather than sailing through uncontended — without this the
        // no-deadlock result would also be satisfied by two transactions that
        // never overlapped at all. Well inside the 2s `lock_timeout` the
        // helper sets.
        await new Promise((r) => setTimeout(r, 250));
        return ids;
      },
      { timeout: 10_000 },
    );

    // Caller B: the SCAN plan. Unordered it wants HIGH first.
    const b = prisma.$transaction(
      async (tx) => {
        const ids = await lockClassRowsOrdered(tx, {
          join: Prisma.sql`JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"`,
          where: Prisma.sql`e."teacherId" = ${teacherId}`,
        });
        await new Promise((r) => setTimeout(r, 250));
        return ids;
      },
      { timeout: 10_000 },
    );

    // Both are now queued on rows the holder owns. Release it: each is
    // granted the row its own plan asked for first, and then reaches for the
    // other's.
    await new Promise((r) => setTimeout(r, 300));
    releaseHolder();
    await holder;

    const [aSettled, bSettled] = await Promise.allSettled([a, b]);

    // SQLSTATE first, THEN the value — and the order is the point. A bare
    // `expect(status).toBe('fulfilled')` reports "expected 'rejected' to be
    // 'fulfilled'" and names nothing: a `40P01`, a `55P03` and a broken
    // fixture look identical in that output.
    for (const [label, settled] of [
      ['join caller', aSettled],
      ['scan caller', bSettled],
    ] as const) {
      if (settled.status === 'rejected') {
        const message = String(settled.reason);
        expect(`${label}: ${message}`).not.toMatch(/40P01|deadlock detected/);
        expect(`${label}: ${message}`).not.toMatch(/55P03|lock timeout/);
        throw new Error(`${label} rejected unexpectedly: ${message}`);
      }
    }

    // Lock EXISTENCE, not just lock ORDER: two ids each proves both callers
    // actually matched and actually held both fixture rows. Without this a
    // predicate that matched nothing would satisfy the no-deadlock assertion
    // above perfectly.
    expect(aSettled.status === 'fulfilled' && aSettled.value).toEqual([lowClassId, highClassId]);
    expect(bSettled.status === 'fulfilled' && bSettled.value).toEqual([lowClassId, highClassId]);
  });
});
