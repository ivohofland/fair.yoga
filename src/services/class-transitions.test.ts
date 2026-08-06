import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  autoTransitionToInProgress,
  autoCancelClasses,
  autoCompleteClasses,
} from './class-transitions';
import { lockClassRow } from '@/lib/db-locks';

// ===========================================================================
// Automated class transitions (DB) — timezone-aware lifecycle sweeps.
// The fixture teacher is in Europe/Amsterdam (UTC+2 in summer): a class
// stored as date 2026-07-20 / startTime "18:00" starts at 16:00Z.
// ===========================================================================

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-tz`;

describe('class transitions (DB, timezone-aware)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
  let secondStudentId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Tz',
        lastName: 'Teacher',
        email: `tz-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `tz-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Timezone transition tests',
        pageSlug: `tz-teacher-${uniqueSuffix}`,
        defaultTimezone: 'Europe/Amsterdam',
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Tz Studio',
        address: `${uniqueSuffix} Tz St`,
        city: 'Amsterdam',
        postcode: '1234TZ',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;

    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 35 },
    });
    teacherRoomId = teacherRoom.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Tz',
        lastName: 'Student',
        email: `tz-student-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    studentId = student.id;

    // A second student for the #174 task 6 interleaving tests below, which
    // need two distinct students to create two registrations on the same
    // class (`Registration` has `@@unique([classId, studentId])`). Hoisted
    // here — not created inline in each test — so the shared `afterAll`
    // below, which runs regardless of whether a test's assertions pass,
    // covers its cleanup too. A fixture created inside a test and cleaned
    // up only at that same test's own tail leaks on every failing run
    // (round 1 review, Important 4) — and this suite's own review protocol
    // guarantees repeated failing runs of exactly these tests.
    const secondStudent = await prisma.student.create({
      data: {
        firstName: 'Tz',
        lastName: 'Second',
        email: `tz-second-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    secondStudentId = secondStudent.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [teacherId, studentId, secondStudentId] } },
    });
    await prisma.payment.deleteMany({
      where: { registration: { studentId: { in: [studentId, secondStudentId] } } },
    });
    await prisma.registration.deleteMany({ where: { studentId: { in: [studentId, secondStudentId] } } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, secondStudentId] } } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  function makeClass(overrides: Record<string, unknown> = {}) {
    return prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-07-20'),
        startTime: '18:00',
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'open',
        ...overrides,
      },
    });
  }

  it('auto-transitions once the LOCAL start time has passed (16:00Z for 18:00 Amsterdam)', async () => {
    const cls = await makeClass();

    // 16:30Z is after the local 18:00 CEST start (16:00Z) but before a
    // naive-UTC 18:00Z reading — the old UTC code would have skipped this.
    await autoTransitionToInProgress(prisma, new Date('2026-07-20T16:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('in_progress');
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('does not transition before the local start time', async () => {
    const cls = await makeClass();

    await autoTransitionToInProgress(prisma, new Date('2026-07-20T15:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('open');
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('catches early-local-morning classes that start before their UTC calendar date', async () => {
    // 00:30 Amsterdam on July 20 = 22:30Z on July 19 — earlier than the
    // stored date (July 20 00:00Z). The sweep's date prefilter must not
    // exclude it.
    const cls = await makeClass({ startTime: '00:30' });

    await autoTransitionToInProgress(prisma, new Date('2026-07-19T23:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('in_progress');
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('auto-cancels below-minimum classes inside the local check window and notifies the teacher', async () => {
    // HOURS_2 check window before 16:00Z start = 14:00Z–16:00Z.
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2' });

    await autoCancelClasses(prisma, new Date('2026-07-20T15:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('cancelled');

    const teacherNote = await prisma.notification.findFirst({
      where: { recipientType: 'teacher', recipientId: teacherId, relatedClassId: cls.id },
    });
    expect(teacherNote).not.toBeNull();
    await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
    await prisma.class.delete({ where: { id: cls.id } });
  });

  it('does not auto-cancel before the local check window opens', async () => {
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2' });

    // 13:00Z is before the 14:00Z window opening.
    await autoCancelClasses(prisma, new Date('2026-07-20T13:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('open');
    await prisma.class.delete({ where: { id: cls.id } });
  });

  // #174 task 6. `autoCancelClasses`'s decision used to come from
  // `cls.registrations`, populated by the outer `findMany` at the top of the
  // function — a snapshot taken before the per-class transaction even opens.
  // A registration that commits between that read and the transaction's CAS
  // is invisible to the count, so a class that has just reached its minimum
  // gets cancelled and every student is told it is off.
  //
  // A test that registers the second student and only *then* calls
  // `autoCancelClasses` proves nothing: the sweep's own `findMany` runs
  // inside that call and would see both registrations from the start,
  // passing on fixed and unfixed code alike for the same reason. To pin the
  // actual bug, the interleaving has to be reproduced: the second
  // registration has to land strictly between the outer read and the
  // transaction's count, which `$extends` makes deterministic instead of
  // racing for it — same approach as the CAS interposition test in
  // `gdpr.test.ts` ("leaves a class that completed after the erasure read
  // alone, and still erases").
  //
  // The hook is keyed on `args` shape, not call order — a hook keyed on
  // order was a review finding on the `gdpr.test.ts` precedent: it silently
  // stops testing anything once an unrelated `findMany` is added or
  // reordered. `calls` is asserted so a structural change here fails
  // loudly instead of quietly no-op'ing.
  //
  // The actual shape check, below: `where.status === 'open'` and the
  // absence of a `date` key — what distinguishes this function's own read
  // from `autoTransitionToInProgress`'s (also `status: 'open'`, but bounded
  // by a `date` filter). Round 1 review, Important 3: an earlier version of
  // this paragraph instead described keying on a `where: { status: 'open' }`
  // + `include.registrations` combination — but the code never inspected
  // `include`, and this same change deletes `registrations` from
  // `autoCancelClasses`'s outer `include` entirely (`class-transitions.ts`,
  // now dead weight once the count and recipient list both move inside the
  // transaction), so that combination didn't exist even at the point this
  // hook runs. The inline comment at the hook itself, below, was and is the
  // accurate one; this paragraph now matches it.
  it('does not cancel a class a registration brought up to minimum after the sweep read it', async () => {
    // minStudents 2, one registration up front — below minimum at the
    // moment the sweep's outer read runs. Same HOURS_2 window as the tests
    // above: 14:00Z-16:00Z before the 16:00Z start.
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 2 });

    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
    });

    let calls = 0;
    const racing = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            // This is the only `class.findMany` this test's call to
            // `autoCancelClasses` makes, but shape — not order — is what
            // decides whether this hook fires, so an unrelated `findMany`
            // added elsewhere can't silently steal its one shot.
            // `autoCancelClasses`'s own read filters on `status: 'open'`
            // alone; `autoTransitionToInProgress`'s also filters `status:
            // 'open'` but adds a `date` bound, so checking for `date`'s
            // absence is what tells the two apart by shape.
            const where = args.where as { status?: unknown; date?: unknown } | undefined;
            const isSweepRead = where?.status === 'open' && !('date' in (where ?? {}));
            if (!isSweepRead) return query(args);

            calls += 1;
            const rows = await query(args);
            // Lands after the sweep's outer read has already resolved, so
            // the sweep's snapshot holds 1 registration while the database
            // holds 2 by the time the transaction's count runs.
            await prisma.registration.create({
              data: { classId: cls.id, studentId: secondStudentId, status: 'registered', tierAtBooking: 3 },
            });
            return rows;
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable
      // to `autoCancelClasses`'s `PrismaClient`-typed `db` parameter even
      // though every method it calls here is the real one, running against
      // the real database — same cast as the `gdpr.test.ts` precedent.
    }) as unknown as PrismaClient;

    await autoCancelClasses(racing, new Date('2026-07-20T15:00:00Z'));

    expect(calls).toBe(1);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('open');
    expect(
      await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'class_cancelled' } }),
    ).toBe(0);

    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.class.delete({ where: { id: cls.id } });
  });

  // #174 task 6, round 1 review, Important 1. Moving the count inside the
  // transaction (test above) narrows the race but does not close it: the
  // count still takes no lock, so the timeline is: cancel-tx counts 1 (min
  // 2) -> a registration tx takes the Class row `FOR UPDATE` uncontended,
  // inserts, commits -> cancel-tx's `UPDATE ... WHERE status = 'open'`
  // still matches, since it was never conditioned on the count -> the class
  // is cancelled while two registrations are actively attached to it, and
  // the teacher is told "only 1 of 2". `transitionClass`'s docblock states
  // the rule this decision now falls under: a transaction that reads more
  // state than a status under its decision takes `lockClassRow`, same as
  // `completeClass`.
  //
  // The registration write in this test is not a bare `prisma.registration
  // .create` the way the test above's is — it goes through `lockClassRow`
  // first, the same as every production registration writer (`POST
  // /api/registrations`; `waitlist.ts`'s `activateRegistration`). That is
  // deliberate: a writer that does not contend for the Class row lock at
  // all cannot be used to demonstrate that taking the lock closes anything,
  // since nothing it does could ever have been blocked by a lock on the
  // other side.
  //
  // The interposition point is `registration.count` rather than
  // `class.findMany`: that is the exact statement the timeline above pins
  // the race to. The hook awaits the competing write's *full* attempt
  // (lock, insert, commit) before returning control to `autoCancelClasses`,
  // rather than firing it and racing real scheduling — the same
  // determinism-over-racing rationale as the test above, extended to a
  // case where the outcome the hook is racing against is itself "did this
  // other transaction block", not just "did this row exist yet".
  //
  // Fixed (lock taken as the transaction's first statement): the competing
  // write's own `lockClassRow` finds the row already held and blocks behind
  // it for up to 2s (`lockClassRow`'s own `SET LOCAL lock_timeout`), then
  // fails with a lock-timeout error — it can only proceed, if at all, after
  // this transaction has already committed its decision and released the
  // lock. Its insert never lands, so the final registration count is still
  // 1, and the cancellation that does happen is the correct one (the class
  // genuinely was below minimum at every instant this transaction held the
  // lock).
  //
  // Unfixed (no lock, i.e. `autoCancelClasses`'s decision was made from a
  // read that no writer is serialized against): the competing write finds
  // the row uncontended, commits immediately, and the final registration
  // count is 2 — a cancelled class with two active registrations, the
  // inconsistency this test pins. Status alone cannot distinguish fixed
  // from unfixed here, unlike the test above: the class is correctly
  // `cancelled` in both cases (fixed, because the true count really was 1
  // when the lock was taken; unfixed, because the CAS's `WHERE` never
  // looked at the count at all) — the registration count left behind is
  // the only thing that differs.
  it(
    'does not leave a cancelled class with a registration that landed inside its own decision',
    async () => {
      const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 2 });

      await prisma.registration.create({
        data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
      });

      let hookCalls = 0;
      let competingWriteError: unknown = null;
      const racing = prisma.$extends({
        query: {
          registration: {
            async count({ args, query }) {
              // Keyed on args shape: `autoCancelClasses`'s own decision
              // count filters on this class's id plus the active-status
              // set. Nothing else in this test's call to `autoCancelClasses`
              // calls `registration.count` at all, but shape-keying (not
              // call-order-keying) is what round 1 review's Important 3
              // on the test above requires of every hook in this file, so
              // an unrelated `count` added later can't silently steal it.
              const where = args.where as
                | { classId?: unknown; status?: { in?: unknown } }
                | undefined;
              const isDecisionCount =
                where?.classId === cls.id && Array.isArray(where?.status?.in);
              if (!isDecisionCount) return query(args);

              hookCalls += 1;
              const result = await query(args);

              // A real, separately committed transaction, going through
              // the same `lockClassRow` every production registration
              // writer does — awaited to completion (success or the
              // lock-timeout failure) before this hook returns, so the
              // ordering is deterministic rather than racing real
              // scheduling.
              try {
                await prisma.$transaction(async (tx2) => {
                  await lockClassRow(tx2, cls.id);
                  await tx2.registration.create({
                    data: {
                      classId: cls.id,
                      studentId: secondStudentId,
                      status: 'registered',
                      tierAtBooking: 3,
                    },
                  });
                });
              } catch (err) {
                competingWriteError = err;
              }

              return result;
            },
          },
        },
        // Same cast rationale as the test above.
      }) as unknown as PrismaClient;

      await autoCancelClasses(racing, new Date('2026-07-20T15:00:00Z'));

      expect(hookCalls).toBe(1);

      const finalCount = await prisma.registration.count({
        where: { classId: cls.id, status: { in: ['registered', 'attended', 'no_show'] } },
      });
      // The decisive assertion: 1 only if the lock forced the competing
      // write to fail rather than land. On unfixed code this is 2 — the
      // competing write is uncontended and commits before this line runs.
      expect(finalCount).toBe(1);

      // Corroborates *why* the count stayed at 1 — the write was refused,
      // not merely slow — so a future change that made this pass for an
      // unrelated reason (e.g. the write silently no-op'ing) would still
      // be caught here.
      expect(competingWriteError).not.toBeNull();

      const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
      expect(updated.status).toBe('cancelled');

      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
      await prisma.registration.deleteMany({ where: { classId: cls.id } });
      await prisma.class.delete({ where: { id: cls.id } });
    },
    10_000,
  );

  it('auto-completes an in-progress class after its local end time', async () => {
    const cls = await makeClass({ status: 'in_progress', minStudents: 1 });
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 },
    });

    // Ends 17:00Z (16:00Z start + 60 min); 17:30Z is past that.
    await autoCompleteClasses(prisma, new Date('2026-07-20T17:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(updated.status).toBe('completed');
    expect(updated.totalRevenue).not.toBeNull();
  });
});
