import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { deleteStudentAccount, deleteTeacherAccount } from './gdpr';
import { LOCK_TIMEOUT_SQL } from '@/lib/db-locks';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

/**
 * ITS OWN FILE BECAUSE OF ITS TIER, not because of its subject — the docblock
 * below covers that. The case here asserts a staged race ends in NEITHER
 * `40P01` NOR `55P03`, which is the second kind `LOCK_CONTENTION_TESTS`
 * (`vitest.config.ts`) exists to hold: lock noise from a concurrent file is a
 * false failure it cannot tell from the defect it watches for. It sat in
 * `gdpr.test.ts` until the preventive sweep that list's own comment asks for.
 *
 * SPLIT RATHER THAN MOVING THE WHOLE FILE, and the measurement is the reason.
 * `gdpr.test.ts` runs in ~26s; exactly one of its tests reads lock timing.
 * Moving all of it takes the serial tier from 37.8s to 72.6s (+92%) to protect
 * one case; extracted, the same protection costs 2.5s. Same shape as
 * `class-lifecycle-tier-guard.test.ts`, which left `class-lifecycle.test.ts`
 * for the same kind of reason.
 *
 * The rest of `gdpr.test.ts` stays in the parallel tier: its other races assert
 * positive application outcomes rather than the absence of a SQLSTATE, so tier
 * noise cannot masquerade as the thing they watch for.
 */
/**
 * Whole-branch review of #174, Critical. Since #237 both erasures take their
 * `Class` locks through `lockClassRowsOrdered` — one ascending statement each.
 * Before #237 this branch gave `deleteStudentAccount` a `Class` row lock it
 * never used to take and sorted the ids before it, while `deleteTeacherAccount`
 * took one lock per iteration via its per-class cancel CAS, in the order a
 * `findMany` (no `orderBy`) returned. Two orders that disagree over the same
 * pair of classes is an AB-BA cycle, and Postgres answers it with `40P01`.
 *
 * The pre-lock closed the teacher side's read->CAS window (#237 Task 8), which
 * is why this test no longer hooks the CAS and instead races the two ordered
 * pre-lock statements directly. Both erasures are real here — no transaction
 * shaped "like" either one.
 */
describe('the two erasures take multiple Class rows in one order (#174)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-lockorder-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  // Explicit ids, low and high, so "ascending by id" is a known sequence
  // rather than whatever two `uuid()` calls happened to produce. The pair is
  // what makes the fixture's heap order (below) the reverse of its sorted
  // order, which is the whole premise of this test.
  const LOW_CLASS_ID = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  const HIGH_CLASS_ID = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  // Entry ids ANTI-correlated with the class ids they carry: the LOW class
  // gets the HIGH entry and vice versa. Both erasures run under a forced
  // plan, and under it the teacher's scan reaches `Class` through
  // `Class_calendarEntryId_key` — so it returns rows in `calendarEntryId`
  // order, which makes that order this fixture's to choose rather than the
  // heap's. Assigned rather than defaulted, because a `uuid()` default would
  // leave it to chance.
  const LOW_ENTRY_ID = `ffffffff-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  const HIGH_ENTRY_ID = `00000000-0000-4000-8000-${crypto.randomBytes(6).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let studentId: string;
  let studentAccountId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Order',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Lock-order fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Order Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234LO',
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
    // Insertion order is not load-bearing — the entry ids above are. Under an
    // unforced plan this would be a seq scan handing back heap order, and heap
    // order is not this file's to own: `Class` is one 8 KB page shared with
    // every other file in this tier, so a neighbour's `DELETE` plus autovacuum
    // frees a low line pointer for the next insert to take.
    await createClassFixture(prisma, {
      ...base,
      id: HIGH_CLASS_ID,
      calendarEntryId: HIGH_ENTRY_ID,
      date: new Date('2099-06-01'),
    });
    await createClassFixture(prisma, {
      ...base,
      id: LOW_CLASS_ID,
      calendarEntryId: LOW_ENTRY_ID,
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
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId!;

    // Waiting in BOTH classes: that is what makes `deleteStudentAccount`
    // lock two `Class` rows, which is the only way the orders can disagree.
    //
    // LOW first — the OPPOSITE order to the classes above, and since #237 that
    // opposition is what the test turns on. Both erasures take their locks
    // through `lockClassRowsOrdered`, so one `ORDER BY` orders both sides;
    // the only way its removal can still produce a cycle is if the two
    // callers' NATURAL orders differ, and they differ only because these two
    // tables are seeded in opposite orders. Insert these HIGH-first and the
    // mutation below stops reproducing anything.
    await prisma.waitlistEntry.create({
      data: { classId: LOW_CLASS_ID, studentId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: HIGH_CLASS_ID, studentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { recipientId: studentId } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: [accountId, studentAccountId] } } });
    await prisma.$disconnect();
  });

  it('does not deadlock when a teacher erasure and a student erasure overlap on two classes', async () => {
    // Premise 1: the teacher scan's natural order, under the SAME forced plan
    // `teacherRacing` gives `deleteTeacherAccount` below. Unforced this read
    // is a seq scan on `Class` and hands back heap order, which this file
    // cannot own — that is what failed on CI (2026-08-27, the sibling copy in
    // `db-locks.test.ts`). Forced, it is an index scan on
    // `Class_calendarEntryId_key`, so the order is the one `beforeAll`
    // ASSIGNED and the premise is a construction rather than an observation.
    //
    // WHY THIS IS ASSERTABLE AT ALL, since the caller is production code: the
    // test does not need to reach inside it. `deleteTeacherAccount` issues
    // `setLockTimeout`, and a Prisma `$extends` hook on `$executeRawUnsafe`
    // rides that one statement to set the plan for its whole transaction —
    // exactly what the student side has always done. Both erasures are
    // production functions and BOTH are forcible; treating the teacher's as
    // unreachable is what left this premise unasserted for one commit.
    //
    // WHAT IT COSTS TO DROP THIS, measured rather than argued, because the
    // question comes up whenever it flakes: with the heap inverted so the two
    // natural orders agree, both erasures park on the same row and serialise
    // — and with `ORDER BY c.id` deleted from the helper the test still passes
    // 3/3. Not "vacuity in some weaker sense": a green run on broken code.
    // That is what asserting the premise buys, and why it is asserted rather
    // than assumed.
    const scanOrder = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
      await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM "Class" c
        JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"
        WHERE e."teacherId" = ${teacherId}
          AND c.status IN ('draft', 'open', 'in_progress')
      `;
    });
    expect(scanOrder.map((r) => r.id)).toEqual([HIGH_CLASS_ID, LOW_CLASS_ID]);

    // Premise 2: the student side, which was always assertable and always
    // asserted. Asserting the scan proves nothing about it — different
    // tables, different plans.
    // `deleteStudentAccount` pre-locks via a `WaitlistEntry` join, and under
    // the forced plan below the order comes from
    // `WaitlistEntry_classId_position_idx` — so from `classId`, which
    // `beforeAll` assigns — rather than from a heap nobody owns.
    //
    // Left to the planner this join is not reliably driven by `WaitlistEntry`:
    // the choice is a cost knife-edge on `w."studentId"`, which no index leads
    // with, and it is non-monotonic in table size. CI proved it — this
    // assertion is what failed on 2026-08-16 with [HIGH, LOW], because
    // `enable_hashjoin = off` alone removes a join ALGORITHM, not a join
    // DIRECTION. All three settings are needed; the reasoning and the
    // measurements live in `db-locks-lock-order.test.ts`'s
    // `forceIndexOrderedPlan`, which this mirrors deliberately rather than
    // importing — a test helper crossing suites would couple two files whose
    // fixtures are independent.
    const joinOrder = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_hashjoin = off`;
      await tx.$executeRaw`SET LOCAL enable_mergejoin = off`;
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      return tx.$queryRaw<Array<{ id: string }>>`
        SELECT c.id FROM "Class" c
        JOIN "WaitlistEntry" w ON w."classId" = c.id
        WHERE w."studentId" = ${studentId}
      `;
    });
    expect(joinOrder.map((r) => r.id)).toEqual([LOW_CLASS_ID, HIGH_CLASS_ID]);

    // TWO third-party holder transactions, one per row — so each can be
    // released separately, which is what makes the collision deterministic.
    // Postgres grants a lock to queued waiters in FIFO order, so whichever
    // erasure queued on a row first is guaranteed to get it on release. The
    // choreography below exploits that to force the exact AB-BA state:
    //
    //   the teacher's scan asks [HIGH, LOW] — usually, see above; the
    //   student's join [LOW, HIGH], which is asserted — so the two park on
    //   DIFFERENT rows: the teacher on HIGH, the student on LOW.
    //   Release LOW first: the student takes it and re-queues on HIGH,
    //   BEHIND the teacher parked there. Release HIGH: the teacher takes it,
    //   reaches for LOW — held by the student — and the two form the cycle.
    //   With the shared `ORDER BY` both ask [LOW, HIGH], park on the same row,
    //   and serialise instead. Same technique as `db-locks-lock-order.test.ts`,
    //   made deterministic where that test accepts the release race because
    //   its callers hand their lock order back to assert on.
    let releaseHigh!: () => void;
    const highReleased = new Promise<void>((resolve) => {
      releaseHigh = resolve;
    });
    let releaseLow!: () => void;
    const lowReleased = new Promise<void>((resolve) => {
      releaseLow = resolve;
    });
    let holderHighReady!: () => void;
    const holderHighHasRows = new Promise<void>((resolve) => {
      holderHighReady = resolve;
    });
    let holderLowReady!: () => void;
    const holderLowHasRows = new Promise<void>((resolve) => {
      holderLowReady = resolve;
    });

    const holderHigh = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${HIGH_CLASS_ID} FOR UPDATE`;
        holderHighReady();
        await highReleased;
      },
      { timeout: 10_000 },
    );
    const holderLow = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${LOW_CLASS_ID} FOR UPDATE`;
        holderLowReady();
        await lowReleased;
      },
      { timeout: 10_000 },
    );

    await Promise.all([holderHighHasRows, holderLowHasRows]);

    let preLockReached!: () => void;
    const preLockReachedPromise = new Promise<void>((resolve) => {
      preLockReached = resolve;
    });

    const teacherRacing = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          // Keyed on the query's own bound value, not on call order — the
          // house rule, and `template-lock-order.test.ts`'s own hooked clients
          // are the live example of it (the citation here was
          // `template-sync.test.ts` until #194 deleted that file with its
          // function). `teacherId` is the one
          // bind `deleteTeacherAccount`'s ordered pre-lock carries since
          // #237; its other `$queryRaw` calls bind class ids.
          if (args.values[0] === teacherId) {
            preLockReached();
          }
          return query(args);
        },
        async $executeRawUnsafe({ args, query }) {
          // Force `deleteTeacherAccount`'s pre-lock scan onto an index-driven
          // plan, the mirror of the student hook below and for the same
          // reason. Unforced this is a seq scan on `Class`, which returns heap
          // order — and the heap belongs to whichever neighbour in this
          // parallel tier last churned the page, so the premise asserted below
          // would be an assertion on a non-guarantee. Forced, the scan reaches
          // `Class` through `Class_calendarEntryId_key` and returns the order
          // `beforeAll` ASSIGNED.
          //
          // Hookable at all because `deleteTeacherAccount` calls
          // `setLockTimeout` (`gdpr.ts`), which is one
          // `$executeRawUnsafe(LOCK_TIMEOUT_SQL)` — the same statement the
          // student hook keys on. Same `SET LOCAL` scope argument as that
          // hook: transaction-only, and `enable_seqscan = off` discourages
          // rather than forbids, so the erasure's remaining statements are
          // planned differently and cannot fail on it.
          if (args[0] === LOCK_TIMEOUT_SQL) {
            const first = await query(args);
            await query([`SET LOCAL enable_hashjoin = off`]);
            await query([`SET LOCAL enable_mergejoin = off`]);
            await query([`SET LOCAL enable_seqscan = off`]);
            return first;
          }
          return query(args);
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable to
      // `deleteTeacherAccount`'s `PrismaClient`-typed `db` parameter even
      // though every method it calls here is the real one, running against
      // the real database — same cast as the other hooks in this file.
    }) as unknown as PrismaClient;

    let studentPreLockReached!: () => void;
    const studentPreLockReachedPromise = new Promise<void>((resolve) => {
      studentPreLockReached = resolve;
    });

    const studentRacing = prisma.$extends({
      query: {
        async $queryRaw({ args, query }) {
          // Same key as the teacher's hook — `studentId` is the one bind
          // `deleteStudentAccount`'s pre-lock join carries since #237, and its
          // other `$queryRaw` call is `setLockTimeout`, an `$executeRawUnsafe`.
          if (args.values[0] === studentId) {
            studentPreLockReached();
          }
          return query(args);
        },
        async $executeRawUnsafe({ args, query }) {
          // Force `deleteStudentAccount`'s pre-lock join onto the
          // `WaitlistEntry`-driven plan, matching the premise above. Without
          // this the planner can drive the join from `Class` instead, which
          // agrees with the teacher side's scan and makes the mutation below
          // reproduce nothing. `setLockTimeout` is the statement the helper
          // runs immediately before the pre-lock; these `SET LOCAL`s land on
          // the SAME transaction session, so they are scoped to
          // `deleteStudentAccount`'s transaction only.
          //
          // Verified empirically during #237: `args` is an array of statements
          // (index 0), not a bare string, and separate calls on the session
          // work where one multi-statement string fails with `42601`.
          //
          // ALL THREE, not just `enable_hashjoin` — that was the #239 CI
          // failure. Transaction-wide scope is acceptable here because
          // `enable_seqscan = off` discourages rather than forbids: Postgres
          // still seq-scans where no index path exists, so the erasure's
          // remaining statements cannot fail on it, only be planned
          // differently. `deleteStudentAccount` calls `setLockTimeout` twice
          // (once itself, once inside the helper), so this fires twice; a
          // repeated `SET LOCAL` overwrites rather than stacks.
          if (args[0] === LOCK_TIMEOUT_SQL) {
            const first = await query(args);
            await query([`SET LOCAL enable_hashjoin = off`]);
            await query([`SET LOCAL enable_mergejoin = off`]);
            await query([`SET LOCAL enable_seqscan = off`]);
            return first;
          }
          return query(args);
        },
      },
    }) as unknown as PrismaClient;

    const teacherErasure = deleteTeacherAccount(teacherRacing, teacherId)
      .then(() => 'teacher-ok' as const)
      .catch((err: unknown) => ({ error: String(err) }) as const);

    // Start the student erasure once the teacher's pre-lock is in flight, so
    // both statements are running against the holders before either releases.
    await preLockReachedPromise;
    // Time for the teacher's pre-lock to reach and block on its first row.
    await new Promise((r) => setTimeout(r, 200));

    const studentErasure = deleteStudentAccount(studentRacing, studentId)
      .then(() => 'student-ok' as const)
      .catch((err: unknown) => ({ error: String(err) }) as const);

    // Both pre-locks are now in flight. Wait for the student's to be issued
    // too, then give it time to reach and block on its first row. Then:
    //
    // 1. Release LOW first. The student (parked there under the mutation)
    //    takes it and re-queues on HIGH, where the teacher is already parked.
    // 2. Release HIGH. The teacher takes it, reaches for LOW — held by the
    //    student — and Postgres answers the cycle with `40P01`.
    //
    // With the shared `ORDER BY` both erasures ask [LOW, HIGH], park on the
    // same row, and serialise. All waits sit comfortably inside the helper's
    // shared 2s `lock_timeout`.
    await studentPreLockReachedPromise;
    await new Promise((r) => setTimeout(r, 400));
    releaseLow();
    await holderLow;
    await new Promise((r) => setTimeout(r, 150));
    releaseHigh();
    await holderHigh;

    const [teacherOutcome, studentOutcome] = await Promise.all([teacherErasure, studentErasure]);

    // SQLSTATE first, THEN the outcome — the same order and the same reason as
    // `db-locks-lock-order.test.ts`: a bare `toBe('teacher-ok')` reports
    // "expected { error: … } to be 'teacher-ok'" and makes two different
    // failures look alike. A `40P01` is the lock-order regression this test
    // exists to catch. A `55P03` is this choreography outrunning the 2s bound
    // #237 brought to the teacher's transaction — the fixed sleeps below the
    // handshakes (200 + 400 + 150ms) plus `deleteStudentAccount`'s startup all
    // burn against it while the teacher's pre-lock sits blocked on a holder, so
    // a cold pool can spend it. One of those is a finding and the other is a
    // retune, and the failure output has to say which.
    for (const [label, outcome] of [
      ['teacher erasure', teacherOutcome],
      ['student erasure', studentOutcome],
    ] as const) {
      if (typeof outcome !== 'string') {
        expect(`${label}: ${outcome.error}`).not.toMatch(/40P01|deadlock detected/);
        expect(`${label}: ${outcome.error}`).not.toMatch(/55P03|lock timeout/);
        throw new Error(`${label} rejected unexpectedly: ${outcome.error}`);
      }
    }

    // Pre-fix one of these is `{ error: '... 40P01 ...' }` — Postgres picks
    // the victim, not this code, so both are asserted rather than one.
    expect(teacherOutcome).toBe('teacher-ok');
    expect(studentOutcome).toBe('student-ok');

    // Both classes were actually reached on both sides: the teacher cancelled
    // both, and the student's entries on both are gone. A fixture that never
    // contended satisfies the no-deadlock assertions above perfectly, so this
    // is what stops it doing that.
    const cancelled = await prisma.calendarEntry.count({
      where: { teacherId, cancelledAt: { not: null } },
    });
    expect(cancelled).toBe(2);
    const remainingEntries = await prisma.waitlistEntry.count({
      where: { studentId, classId: { in: [LOW_CLASS_ID, HIGH_CLASS_ID] } },
    });
    expect(remainingEntries).toBe(0);
  }, 30_000);

  // The two `Class` lock-order deadlock cycles once tracked here by `it.todo`
  // markers ("delete both when 180 lands") now have real tests, in
  // `src/services/template-lock-order.test.ts` — one per site, neither a bare
  // timeout.
  //
  // Stated precisely, because the two are pinned differently and "both
  // SQLSTATE-asserting" was the shorthand that replaced the markers: the sync
  // pairing is asserted by SQLSTATE negation on the erasure's rejection, while
  // the archive pairing cannot be, because `archiveOrUnarchiveTemplate`
  // RESOLVES `{ ok: false, reason: 'busy' }` on a `40P01` instead of
  // rejecting. That one is pinned by a positive `{ ok: true, deleted: 2 }`
  // plus the absence of its own lock-race log line. That file's docblock
  // records the transcript proving a rejection-based negation passes green
  // there with the deadlock intact.
  //
  // A line comment, not a `/** */` docblock: as a docblock immediately before
  // the closing `});` it documented no test, and tooling attached it to
  // nothing.
});

