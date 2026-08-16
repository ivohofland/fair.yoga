import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import crypto from 'crypto';
import { lockClassRowsOrdered } from './db-locks';

const prisma = new PrismaClient();

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
 * WHY `enable_hashjoin = off` ON THE JOIN SIDE. On this checkout the join
 * over a two-row fixture comes out as a Hash Join that probes `Class`, so its
 * natural order is the `Class` scan's — the two plans AGREE and the
 * reproduction cannot be built. That was measured, not guessed: EXPLAIN on
 * 2026-08-16 showed `Hash Join → Seq Scan on Class` returning [HIGH, LOW],
 * identical to the plain scan. The plan this construction is meant to model
 * is the production one — a `WaitlistEntry` join driven by that table, which
 * is what the planner picks when the filter is selective against a large
 * table. Turning hash joins off for the join side only forces that shape
 * deterministically: the nested loop driven by `WaitlistEntry` (two filtered
 * rows) probing `Class` is measurably cheaper than the reverse. `SET LOCAL`
 * is transaction-scoped, so the setting lives entirely inside this test's
 * transactions and reaches neither the other caller nor production. The
 * premise assertion still guards the shape: if a planner or storage change
 * ever makes the two orders agree, that assertion fails loudly before the
 * race rather than leaving it green for an unrelated reason.
 *
 * WHAT DESC DOES NOT CATCH. Under `ORDER BY c.id DESC` both callers request
 * [HIGH, LOW] — the join's sort and the scan's sort now agree — so they queue
 * on HIGH and serialise, and this test PASSES on DESC. This test pins ASC and
 * ASC only; a maintainer who flips the helper to DESC gets a green helper
 * test. That is accepted: the plans under the two clauses are not different
 * plans anymore, so the deadlock this test guards cannot be constructed for
 * DESC, and the per-pairing reproductions in `gdpr.test.ts:1344` still guard
 * the erasure pairings whichever clause the helper uses. The plan's Step 4
 * "expected 40P01 under DESC" was a prediction that did not hold; recorded
 * here and in the task report, and Step 4 is an observation, not a gate.
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
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };
    // Classes: HIGH first, so the `Class` scan's natural order is [HIGH, LOW].
    await prisma.class.create({ data: { ...base, id: highClassId, date: new Date('2099-06-01') } });
    await prisma.class.create({ data: { ...base, id: lowClassId, date: new Date('2099-06-02') } });

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
    await prisma.class.deleteMany({ where: { teacherId } });
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
      SELECT c.id FROM "Class" c WHERE c."teacherId" = ${teacherId}
    `;
    expect(scanOrder.map((r) => r.id)).toEqual([highClassId, lowClassId]);

    // Premise 2: the join's natural order — the REVERSE. Asserting premise 1
    // proves nothing about this: different tables, different physical layouts.
    // Runs under `enable_hashjoin = off` so the planner drives it from
    // `WaitlistEntry` — see the docblock for why the default hash join agrees
    // with the scan and cannot be used to build the reproduction.
    const joinOrder = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
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

    // Caller A: the JOIN plan. Unordered it wants LOW first. The hash-join
    // override makes it run under the same plan the premise above asserts —
    // the production shape, driven by `WaitlistEntry`.
    const a = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
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
          where: Prisma.sql`c."teacherId" = ${teacherId}`,
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
