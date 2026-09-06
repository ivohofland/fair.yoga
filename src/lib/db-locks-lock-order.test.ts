/**
 * @serial-tier lock-contention — asserts a staged race ends in neither `40P01`
 * nor `55P03`, so a neighbour's lock noise is a false failure this file cannot
 * tell from the defect it watches for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';
import { lockClassRowsOrdered } from './db-locks';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();

/**
 * Forces both callers off every scan path that returns physical order, so each
 * one's row order comes from index structure rather than from `Class`'s heap.
 *
 * That is the property this whole file rests on, and it is why the same four
 * settings serve both sides. A heap-ordered scan of `Class` hands back
 * physical order, and physical order is not this test's to own: `Class` is one
 * 8 KB page shared with every other file in the parallel tier, so a
 * neighbour's `DELETE` plus autovacuum frees a low line pointer and the next
 * insert takes it — measured 2026-08-28, and the mechanism behind the CI
 * failure at `db-locks.test.ts:414` on 2026-08-27. Under these settings the
 * join side is ordered by `WaitlistEntry_classId_position_idx` (so by
 * `classId`) and the scan side by whichever btree its plan is driven from —
 * this file's fixture ASSIGNS every key those plans can order by, so no index
 * has to be named as the one. Btree specifically; see INDEX ORDER STILL MEANS
 * BTREE below.
 *
 * The join side additionally needs the nested loop driven from
 * `WaitlistEntry`, which is what the measurements below are about.
 *
 * All four settings are required, and `enable_hashjoin = off` alone is what
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
 * safe. Adding `enable_mergejoin` leaves a nested loop as the only cheap join
 * shape, but NOT one direction of it: both directions stay index-supported
 * (`Class_pkey` inner one way, `WaitlistEntry_classId_position_idx` inner the
 * other), so which side drives is still a cost decision. What carries this
 * paragraph is therefore an empirical result and not a mechanism: with the two
 * join settings and `enable_seqscan = off` in force — the configuration the
 * 2026-08-16 sweep ran under — the direction held at 0, 2, 10, 50, 100, 200,
 * 1_000, 5_000, 10_000 and 50_000 background rows.
 *
 * INDEX-DRIVEN IS NOT INDEX-ORDERED, and that gap is what the seq-scan setting
 * alone left open. Postgres has exactly two scan paths over a plain table that
 * return PHYSICAL heap order — a sequential scan and a bitmap heap scan — and
 * a bitmap heap scan is fed by a bitmap INDEX scan, so a nested loop built
 * from two of those is index-DRIVEN and still hands back heap order. Turning
 * both off is what this helper buys: the remaining paths are index and
 * index-only scans. Measured in
 * `docs/superpowers/specs/2026-09-06-scan-order-premise-pin-design.md` (#470),
 * including the adversarial case where every path carries `disable_cost` and
 * Postgres still declines to read the heap in physical order.
 *
 * INDEX ORDER STILL MEANS BTREE, and whether that holds is a property of the
 * two STATEMENTS below rather than of the settings above. A GiST `Index Scan`
 * returns tree-traversal order, not a key order any fixture can assign, and
 * every GiST index this schema has is PARTIAL — reachable only by a statement
 * carrying its predicate. Neither statement in this file carries one, which is
 * a property to preserve rather than a coincidence: adding such a qual to a
 * probe here would put it on an unordered index. Which indexes those are, and
 * the query that re-derives them, are in `docs/lock-order.md`; the same trap,
 * measured, is written up beside the teacher probe in
 * `gdpr-lock-order.test.ts`.
 *
 * `enable_seqscan = off` and `enable_bitmapscan = off` discourage rather than
 * forbid — Postgres still takes those paths when nothing else can answer the
 * statement — so these cannot make a statement fail, only bias the planner.
 * `SET LOCAL` is transaction-scoped, so all four live entirely inside the
 * caller's transaction and reach neither the other caller nor production.
 */
async function forceIndexOrderedPlan(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
  await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
  await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
  await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
}

/**
 * The guard `lockClassRowsOrdered`'s `ORDER BY c.id` exists to be, and the
 * one this project owed after #216/#182: with both sides of a pairing taking
 * every lock in a single ordered statement, the per-pairing reproductions in
 * `template-lock-order.test.ts` can no longer CONSTRUCT an AB-BA cycle, so
 * they no longer detect a missing `ORDER BY` on the erasure side (verified:
 * deleting it leaves them green). Testing the shared primitive once
 * repays that for every call site at the same time.
 *
 * WHY TWO DIFFERENT PLANS, and not two calls with the same predicate. Two
 * identical statements produce one plan, visit one physical order, and
 * serialise whether or not the clause is there — such a test passes against
 * the bug and proves nothing. `ORDER BY c.id` is load-bearing only where two
 * sites reach the same rows by DIFFERENT plans: the join below is driven by
 * `WaitlistEntry` and returns classes in `classId` order, while the scan is
 * driven from an index over this teacher's entries and returns them in that
 * index's key order — `Class.calendarEntryId`, `CalendarEntry.date` or
 * `CalendarEntry.id`, depending on which index its plan takes. The fixture
 * ASSIGNS `classId` and every one of those three, so the two
 * natural orders are opposite by construction, and both premises are asserted
 * before the race rather than assumed — an index or plan change that makes
 * them agree fails loudly here instead of leaving the test green for an
 * unrelated reason.
 *
 * NEITHER ORDER IS THE HEAP'S, which is the reason both keys are assigned
 * rather than left to insertion order. `Class` is one 8 KB page shared with
 * every other file in the parallel tier: a neighbour's `DELETE` plus
 * autovacuum frees a low line pointer, the next insert takes it, and
 * insertion order and physical order come apart. Both premises here held
 * 24/24 under `forceIndexOrderedPlan`, including 12 runs against a heap
 * deliberately inverted to [LOW, HIGH].
 *
 * WHY A THIRD TRANSACTION. Both callers take their locks inside one statement
 * each, so there is no application-level window to interleave — the same
 * property that made the per-pairing reproductions unconstructible. Holding
 * both rows from a third transaction and releasing them parks BOTH callers
 * before either can start, which is what a bare `Promise.all` cannot
 * guarantee. It does not decide what happens next — see the catch rates
 * below — but without it the two callers can miss each other entirely. Same
 * technique as `gdpr-lock-order.test.ts`'s "a third transaction takes the
 * `Student` row `FOR UPDATE` before either".
 *
 * WHY BOTH SIDES FORCE THEIR PLAN. The plans this construction models are
 * production ones — a `WaitlistEntry` join driven by that table, and a
 * `Class` scan reached through an index. Left to the planner neither is
 * reliably that: see `forceIndexOrderedPlan` below, which owns the planner
 * settings and the measurements behind them. The short version is that the
 * join side is a cost knife-edge on an unindexed column and non-monotonic in
 * table size, and that an unforced scan side falls back to the heap, which
 * belongs to whichever neighbour last churned it.
 *
 * WHAT ACTUALLY CATCHES A MISSING `ORDER BY`, measured with the clause
 * deleted from `lockClassRowsOrdered`: the closing id assertions, 3/3. The
 * deadlock fires 1/3 — once both callers are parked, whether each is granted
 * its own first row (a cycle) or one caller takes both (no cycle) is a race
 * this test does not control. So the no-deadlock checks state the invariant
 * the clause exists for, and the id assertions are what make the guard
 * deterministic. Both belong here; neither alone is the whole test.
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
 * The per-pairing reproduction in `gdpr-lock-order.test.ts` ("does not deadlock when a
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
  let lowEntryId: string;
  let highEntryId: string;

  beforeAll(async () => {
    lowClassId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    highClassId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    // Entry ids ANTI-correlated with the class ids they carry: the LOW class
    // gets the HIGH entry and vice versa. That inversion is what gives the
    // scan side a natural order of [HIGH, LOW] under the forced plan, whose
    // driving index keys on `Class.calendarEntryId` or on `CalendarEntry.id`
    // — the same pair of values either way, so which one wins does not change
    // the order these ids produce. Assigned rather than defaulted, because a
    // `uuid()` default would leave that order to chance — measured 20/20
    // tracking the random entry id, 12 of 20 in the direction this test needs.
    lowEntryId = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
    highEntryId = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;

    // `bio` and `pageSlug` are both required and unique-constrained — copied
    // from the working fixture at `gdpr-lock-order.test.ts:67`, not invented.
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
    // Insertion order is no longer load-bearing — the entry ids above are.
    await createClassFixture(prisma, {
      ...base,
      id: highClassId,
      calendarEntryId: highEntryId,
      date: new Date('2099-06-01'),
    });
    await createClassFixture(prisma, {
      ...base,
      id: lowClassId,
      calendarEntryId: lowEntryId,
      date: new Date('2099-06-02'),
    });

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
    // Premise 1: the scan's natural order, under the SAME forced plan the
    // scan caller gets below. Unforced this read can reach `Class` by a
    // heap-ordered path — a sequential or a bitmap heap scan — and hand back
    // physical order, which this test cannot own; see `forceIndexOrderedPlan`.
    // Forced, every remaining path returns btree index order and this fixture
    // assigns every key those plans order by, so the order is the one
    // `beforeAll` ASSIGNED: verified 24/24, including 12 runs against a heap
    // deliberately inverted to [LOW, HIGH].
    const scanOrder = await prisma.$transaction(async (tx) => {
      await forceIndexOrderedPlan(tx);
      return tx.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM "Class" c
          JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
         WHERE e."teacherId" = ${teacherId}
      `;
    });
    expect(scanOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

    // Premise 2: the join's natural order — the REVERSE. Asserting premise 1
    // proves nothing about this: different tables, different physical layouts.
    // Runs under the forced plan so the planner drives it from `WaitlistEntry`
    // — see `forceIndexOrderedPlan` for why a cost-chosen plan cannot be
    // relied on here, and why one setting was not enough.
    const joinOrder = await prisma.$transaction(async (tx) => {
      await forceIndexOrderedPlan(tx);
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
        await forceIndexOrderedPlan(tx);
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

    // Caller B: the SCAN plan. Unordered it wants HIGH first — and forcing
    // the plan is what makes that "wants" a construction rather than a hope,
    // exactly as it is for caller A.
    const b = prisma.$transaction(
      async (tx) => {
        await forceIndexOrderedPlan(tx);
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
