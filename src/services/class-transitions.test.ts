import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  autoTransitionToInProgress,
  autoCancelClasses,
  autoCompleteClasses,
} from './class-transitions';
import { lockClassRow } from '@/lib/db-locks';
import { getWaitlistWindow } from './waitlist';
import { formatDayHeader } from '@/lib/format';
import { hhmmToTime } from '@/lib/time-of-day';
import { log } from '@/lib/log';
import { createClassFixture } from '../../tests/class-fixtures';

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
  let waiterStudentId: string;

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

    // #112. A third student, never registered, only ever queued — the whole
    // point is that a waiting entry is a person the recipient list cannot see
    // by reading registrations. Hoisted for the same reason the second one is.
    const waiter = await prisma.student.create({
      data: {
        firstName: 'Tz',
        lastName: 'Waiter',
        email: `tz-waiter-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    waiterStudentId = waiter.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [teacherId, studentId, secondStudentId, waiterStudentId] } },
    });
    await prisma.payment.deleteMany({
      where: { registration: { studentId: { in: [studentId, secondStudentId, waiterStudentId] } } },
    });
    await prisma.registration.deleteMany({
      where: { studentId: { in: [studentId, secondStudentId, waiterStudentId] } },
    });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.student.deleteMany({
      where: { id: { in: [studentId, secondStudentId, waiterStudentId] } },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  function makeClass(overrides: Record<string, unknown> = {}) {
    return createClassFixture(prisma, {
        teacherId,
        teacherRoomId,
        classType: 'Hatha',
        date: new Date('2026-07-20'),
        startTime: hhmmToTime('18:00'),
        durationMinutes: 60,
        roomCost: 35,
        minRate: 15,
        targetRate: 25,
        minStudents: 4,
        maxStudents: 12,
        status: 'open',
        ...overrides,
      });
  }

  it('auto-transitions once the LOCAL start time has passed (16:00Z for 18:00 Amsterdam)', async () => {
    const cls = await makeClass();

    // 16:30Z is after the local 18:00 CEST start (16:00Z) but before a
    // naive-UTC 18:00Z reading — the old UTC code would have skipped this.
    await autoTransitionToInProgress(prisma, new Date('2026-07-20T16:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.status).toBe('in_progress');
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  });

  it('does not transition before the local start time', async () => {
    const cls = await makeClass();

    await autoTransitionToInProgress(prisma, new Date('2026-07-20T15:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.status).toBe('open');
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  });

  it('catches early-local-morning classes that start before their UTC calendar date', async () => {
    // 00:30 Amsterdam on July 20 = 22:30Z on July 19 — earlier than the
    // stored date (July 20 00:00Z). The sweep's date prefilter must not
    // exclude it.
    const cls = await makeClass({ startTime: hhmmToTime('00:30') });

    await autoTransitionToInProgress(prisma, new Date('2026-07-19T23:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.status).toBe('in_progress');
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  });

  it('does not start a class rescheduled after the sweep read it', async () => {
    const cls = await makeClass({});

    let hookCalls = 0;
    const racing = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            // Shape-keyed, per this file's house rule. THIS sweep's read carries
            // a `date` filter; `autoCancelClasses`' carries a bare `status`.
            // The `date` bound moved onto `calendarEntry` in #327, so the
            // shape that tells the two sweeps apart is a nested `date` rather
            // than a top-level one.
            const where = args.where as
              | { status?: unknown; calendarEntry?: { date?: unknown } }
              | undefined;
            if (where?.status !== 'open' || where.calendarEntry?.date === undefined) {
              return query(args);
            }

            hookCalls += 1;
            const rows = await query(args);
            // A WEEK later, not minutes: 16:00Z on July 20 is nowhere near the
            // new start on July 27, so no rounding or timezone offset can make
            // the stale decision accidentally correct.
            await prisma.calendarEntry.update({
      where: { id: (await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, select: { calendarEntryId: true } })).calendarEntryId },
      data: { date: new Date('2026-07-27') },
    });
            return rows;
          },
        },
      },
    }) as unknown as PrismaClient;

    // The guard firing must be VISIBLE. Four outcomes return a bare `false`
    // from inside that transaction, and in production the scheduler discards
    // the sweep's return value entirely — so without a log line, forty skipped
    // classes and a healthy sweep are indistinguishable in the only place an
    // operator looks. `warn` matches what `autoCompleteClasses` does with the
    // identical race; the two must not disagree about the same event.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const error = vi.spyOn(log, 'error').mockImplementation(() => log);
    try {
      const transitioned = await autoTransitionToInProgress(
        racing,
        new Date('2026-07-20T16:00:00Z'),
      );

      expect(hookCalls).toBe(1);
      expect(transitioned).toBe(0);

      const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
      expect(updated.status).toBe('open');

      // Filtered to THIS class. `autoTransitionToInProgress` sweeps every open
      // class in the shared unit database, so a bare call count asserts
      // something about the whole database rather than about this fixture — one
      // leaked class from a sibling would fail this for an unrelated reason.
      expect(
        warn.mock.calls.filter((c) => (c[0] as { classId?: string })?.classId === cls.id),
      ).toHaveLength(1);
      // `error` is reserved for the CAS losing under a held lock, which cannot
      // happen on this path — and the sweep's per-class `catch` also logs at
      // `error`, so its silence is what separates "the guard fired cleanly" from
      // "the transaction threw and was swallowed". Both of those yield
      // `transitioned === 0` and status `open`, so nothing else here can tell
      // them apart.
      expect(
        error.mock.calls.filter((c) => (c[0] as { classId?: string })?.classId === cls.id),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
    }
  });

  /**
   * The LOCK, not the re-read. The sibling test above proves the sweep decides
   * from a fresh row rather than the `findMany` snapshot; deleting
   * `lockClassRow` entirely still passed it, and passed all 68 unit tests —
   * which is what this branch is named after.
   *
   * The two are genuinely different guards. The re-read closes the window
   * between the snapshot and the transaction. The lock closes the window
   * between the re-read and the CAS, and only the lock can: without it the
   * `findUnique` runs unblocked against whatever is committed at that moment,
   * the CAS then blocks on the contended row anyway, and by the time it is
   * granted its own predicate (`status: 'open'`) is still satisfied — so the
   * class starts against a time it no longer has. Under the lock the re-read
   * cannot run until the writer is done, so it sees the reschedule.
   *
   * That is why the assertion is on the class's final status and not only on
   * `settled`: a sweep with no `lockClassRow` parks too, at the CAS. Parking
   * proves the path was contended, not that the guard exists.
   */
  it('re-reads under the lock, so a reschedule landing while it waits is seen', async () => {
    const cls = await makeClass({});
    try {
      let holderCommitted = false;

      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${cls.id} FOR UPDATE`;
          await new Promise((r) => setTimeout(r, 700));
          // A WEEK later, the same margin the sibling test uses: no rounding or
          // timezone offset can make the stale decision accidentally correct.
          await tx.calendarEntry.update({
      where: { id: (await tx.class.findUniqueOrThrow({ where: { id: cls.id }, select: { calendarEntryId: true } })).calendarEntryId },
      data: { date: new Date('2026-07-27') },
    });
          holderCommitted = true;
        },
        { timeout: 10_000 },
      );
      // Long enough for the holder's `FOR UPDATE` to be in place before the
      // sweep asks for the same row — otherwise this tests nothing.
      await new Promise((r) => setTimeout(r, 150));

      const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
      try {
        const sweeping = autoTransitionToInProgress(prisma, new Date('2026-07-20T16:00:00Z'));
        const settled = await Promise.race([
          sweeping.then(() => true),
          new Promise<false>((r) => setTimeout(() => r(false), 300)),
        ]);

        // Asserted rather than assumed: without this the test cannot tell a
        // sweep that waited from one that ran before the holder ever locked.
        expect(settled).toBe(false);
        expect(holderCommitted).toBe(false);

        await holder;
        expect(await sweeping).toBe(0);

        const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
        expect(updated.status).toBe('open');

        // POSITIVE evidence that the locked re-read is what refused, and the
        // only assertion here that cannot be satisfied by accident.
        //
        // Everything above is also satisfied by a second path: if the sweep's
        // own `findMany` happens to land AFTER the holder commits — which a
        // starved connection pool produces — the outer pre-filter sees the new
        // date, `continue`s, and returns 0 with the class still `open`, exactly
        // as a correct run does. `settled` is still false, because the sweep
        // itself was slow. Reproduced against a lockless mutant with a 600ms
        // delay injected on that read: every other assertion passed. The test
        // degrades to a tautology rather than flaking, which is worse — CI stays
        // green while the guard is gone.
        //
        // This line only fires if execution reached the re-read inside the
        // transaction, which is behind the lock.
        const ours = warn.mock.calls.filter(
          (c) => (c[0] as { classId?: string })?.classId === cls.id,
        );
        expect(ours).toHaveLength(1);
        expect(ours[0]?.[1]).toBe('start sweep: class rescheduled after the snapshot, deferring');
      } finally {
        warn.mockRestore();
      }
    } finally {
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
    }
  }, 15_000);

  it('closes the waitlist when it starts a class', async () => {
    const cls = await makeClass({});
    try {
      const entry = await prisma.waitlistEntry.create({
        data: { classId: cls.id, studentId: waiterStudentId, position: 1, status: 'waiting' },
      });

      const transitioned = await autoTransitionToInProgress(
        prisma,
        new Date('2026-07-20T16:00:00Z'),
      );
      expect(transitioned).toBeGreaterThanOrEqual(1);

      const after = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(after.status).toBe('expired');
    } finally {
      // `finally`, not inline after the assertions — the convention this file
      // already records at its `#174` fixture. A failing assertion skipping its
      // own cleanup leaves a class behind, and the next test in this file then
      // fails for a reason that has nothing to do with what it asserts. That
      // matters more here than usual: this project's review protocol is
      // mutation testing, whose whole signal is WHICH test failed.
      await prisma.waitlistEntry.deleteMany({ where: { classId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
    }
  });

  it('auto-cancels below-minimum classes inside the local check window and notifies the teacher', async () => {
    // HOURS_2 check window before 16:00Z start = 14:00Z–16:00Z.
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2' });

    // `finally`, the convention this file records at its own `#174` fixture
    // and cites from `gdpr.test.ts`'s `cleanupStudentWaitingInClass` docblock.
    // #200 added four assertions ahead of the cleanup, so there are now five
    // ways to skip it — and this project's
    // protocol guarantees repeated deliberately-failing runs of exactly this
    // test. The leak is inert (the class is already `cancelled`, so no sweep
    // matches it, and `afterAll` reaps both rows), but inert-by-luck is not
    // the reason to leave it out.
    try {
      await autoCancelClasses(prisma, new Date('2026-07-20T15:00:00Z'));

      const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
      expect(updated.calendarEntry.cancelledAt).not.toBeNull();

      // `findFirstOrThrow`, not `findFirst` + a null check: the body
      // assertions below must be reported when they fail, not skipped past by
      // a conditional that TypeScript needed for narrowing.
      const teacherNote = await prisma.notification.findFirstOrThrow({
        where: { recipientType: 'teacher', recipientId: teacherId, relatedClassId: cls.id },
      });

      // #200. The teacher's row is the one that can never link: the inbox page
      // (`app/(teacher)/inbox/page.tsx`) selects no `relatedClass`, so
      // `NotificationList`'s `hrefById` arrives undefined and every teacher row
      // renders inert (filed as #201). The body is not the best channel here —
      // it is the only one. A teacher running two weekly Hatha classes cannot
      // otherwise tell which one was cancelled.
      //
      // Three separate `toContain`s rather than one whole-string equality: the
      // realistic regression is a field being dropped in an edit, and a single
      // equality assertion goes red on any rewording, which teaches the next
      // person to loosen it.
      expect(teacherNote.body).toContain('Hatha');
      expect(teacherNote.body).toContain(formatDayHeader(cls.calendarEntry.date));
      expect(teacherNote.body).toContain('18:00');
      // The clause that makes this body worth keeping distinct from the
      // student's — it says WHY, and only this path knows.
      expect(teacherNote.body).toContain('only 0 of 4 minimum students registered');
    } finally {
      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
    }
  });

  it('does not auto-cancel before the local check window opens', async () => {
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2' });

    // 13:00Z is before the 14:00Z window opening.
    await autoCancelClasses(prisma, new Date('2026-07-20T13:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.status).toBe('open');
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  });

  /**
   * #112. The fixture's timing is the test, not scenery.
   *
   * A waitlist only forms at `maxStudents`, and `handleSpotFreed` refills the
   * seat it just lost — so a class carrying a queue normally has its count
   * PINNED at max, and the queue drains to empty before the count can fall far
   * enough to auto-cancel. The one thing that suspends that drain is the
   * freeze, and auto-cancel can only ever run inside it: `DEADLINE_HOURS`
   * (`waitlist.ts`) bottoms out at 6 and `CANCEL_CHECK_HOURS`
   * (`class-transitions.ts`) tops out at 4, so across all 12 configurations the sweep runs
   * strictly after the freeze, with two hours to spare.
   *
   * Constructing a below-minimum class with a waiting entry at some arbitrary
   * `now` would therefore pin a state production cannot reach, and would pass
   * without exercising the mechanism at all. Hence the explicit window
   * assertion below — it fails loudly if a later edit moves the clock out of
   * the frozen window and quietly turns this into that weaker test.
   *
   * What makes the count fall is the status asymmetry: `late_cancel` is in
   * `CHARGED_STATUSES` (`class-lifecycle.ts`) but not in
   * `ACTIVE_REGISTRATION_STATUSES` (`@/lib/registration-status`), which is what
   * the sweep counts by. The seat is released; the registration stays billable.
   */
  it('tells the waitlist when it auto-cancels, and closes the queue', async () => {
    const cls = await makeClass({
      minStudents: 2,
      maxStudents: 2,
      autoCancelCheck: 'HOURS_2',
      cancelDeadline: 'HOURS_24',
    });
    // `finally`, not a trailing statement — the convention
    // `gdpr.test.ts`'s `cleanupStudentWaitingInClass` docblock records after
    // round 1's M5. An assertion failing below must still reap
    // the class, or the next run of this file starts with a stray cancelled
    // class on the shared fixture teacher.
    try {
      // Full at 2/2 when the queue formed; one seat later released by a
      // late-cancel, which nothing promoted into because the window is frozen.
      await prisma.registration.create({
        data: { classId: cls.id, studentId, tierAtBooking: 3, status: 'registered' },
      });
      await prisma.registration.create({
        data: {
          classId: cls.id,
          studentId: secondStudentId,
          tierAtBooking: 3,
          status: 'late_cancel',
          cancelledAt: new Date('2026-07-20T10:00:00Z'),
        },
      });
      const entry = await prisma.waitlistEntry.create({
        data: { classId: cls.id, studentId: waiterStudentId, position: 1, status: 'waiting' },
      });
      // Someone who left this queue before the class was cancelled. Only the
      // `status: 'waiting'` filter keeps them out of the recipient list.
      const leftQueue = await prisma.waitlistEntry.create({
        data: { classId: cls.id, studentId: secondStudentId, position: 2, status: 'removed' },
      });

      // 15:00Z is inside the HOURS_2 check window (14:00Z–16:00Z) AND past the
      // HOURS_24 deadline (2026-07-19T16:00Z). Assert the second half rather
      // than trusting the arithmetic.
      //
      // The zone comes from the teacher row, not a literal: production derives
      // the window from `teacher.defaultTimezone`, so a literal here would keep
      // asserting about a zone the code had stopped using.
      const at = new Date('2026-07-20T15:00:00Z');
      const { defaultTimezone } = await prisma.teacher.findUniqueOrThrow({
        where: { id: teacherId },
        select: { defaultTimezone: true },
      });
      expect(
        getWaitlistWindow(cls.calendarEntry.date, cls.calendarEntry.startTime, cls.cancelDeadline, defaultTimezone, at),
      ).toBe('frozen');

      await autoCancelClasses(prisma, at);

      const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
      expect(updated.calendarEntry.cancelledAt).not.toBeNull();

      // `findFirstOrThrow`, not `findFirst` + `if` — the conditional silently
      // skipped the body assertions on failure instead of reporting them.
      const waiterNote = await prisma.notification.findFirstOrThrow({
        where: {
          recipientType: 'student',
          recipientId: waiterStudentId,
          relatedClassId: cls.id,
          type: 'class_cancelled',
        },
      });

      // A waitlist-only student can place the class by nothing but this body:
      // the entry just closed to `removed` (dropped from /bookings) and a
      // cancelled class links nowhere in the inbox. Type, day AND time.
      expect(waiterNote.body).toContain('Hatha');
      expect(waiterNote.body).toContain(formatDayHeader(cls.calendarEntry.date));
      expect(waiterNote.body).toContain('18:00');

      // The REGISTERED audience is still told. Asserted here because nothing
      // else in this file does: the other two `class_cancelled` assertions
      // both expect zero, which a dropped audience satisfies. So
      // `[...registrations, ...waiting]` → `[...waiting]` passed the whole
      // file before this line existed — a mutation that would stop telling
      // every registered student their class was cancelled.
      const registeredNote = await prisma.notification.findFirst({
        where: {
          recipientType: 'student',
          recipientId: studentId,
          relatedClassId: cls.id,
          type: 'class_cancelled',
        },
      });
      expect(registeredNote).not.toBeNull();

      // And the student who had already left the queue is NOT told. The
      // `status: 'waiting'` filter is otherwise unpinned — every other fixture
      // row in this file is `waiting`, so dropping it changes nothing else —
      // and `class_cancelled` is essential, so it would email someone about a
      // queue they left months ago, bypassing their preference.
      expect(
        await prisma.notification.count({
          where: { recipientId: secondStudentId, relatedClassId: cls.id, type: 'class_cancelled' },
        }),
      ).toBe(0);

      // The entry must not be left pointing at a cancelled class.
      const afterEntry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: entry.id } });
      expect(afterEntry.status).toBe('removed');
      // …while the already-`removed` one is untouched, not re-closed.
      const leftEntry = await prisma.waitlistEntry.findUniqueOrThrow({ where: { id: leftQueue.id } });
      expect(leftEntry.status).toBe('removed');
    } finally {
      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
      await prisma.waitlistEntry.deleteMany({ where: { classId: cls.id } });
      await prisma.registration.deleteMany({ where: { classId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
    }
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
  // racing for it.
  //
  // The hook is keyed on `args` shape, not call order: a hook keyed on order
  // silently stops testing anything once an unrelated `findMany` is added or
  // reordered — it fires on the wrong call, the interleaving it exists to
  // construct never happens, and the test then passes on fixed and unfixed
  // code alike. `calls` is asserted so a structural change here fails
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
            // absence is what tells the two apart by shape. Since #327 that
            // bound sits under `calendarEntry`, alongside the `cancelledAt`
            // conjunct BOTH sweeps carry — so the nested `date` is what
            // discriminates, not the presence of `calendarEntry`.
            const where = args.where as
              | { status?: unknown; calendarEntry?: { date?: unknown } }
              | undefined;
            const isSweepRead =
              where?.status === 'open' && where.calendarEntry?.date === undefined;
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
      // the real database — the same cast every `$extends` hook in this file
      // takes.
    }) as unknown as PrismaClient;

    await autoCancelClasses(racing, new Date('2026-07-20T15:00:00Z'));

    expect(calls).toBe(1);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.status).toBe('open');
    expect(
      await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'class_cancelled' } }),
    ).toBe(0);

    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
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
  // first, so it takes the same Class row lock every production writer that
  // CREATES a registration takes (`POST /api/registrations`; `waitlist.ts`'s
  // `activateRegistration`, reached through `promoteNext` and `claimSpot`).
  // Since #104 both reach the lock through `lockClassRow` — the route
  // directly, `activateRegistration` via whichever of those two called it —
  // so what is shared here is the code path, not merely the lock, which
  // strengthens
  // this argument rather than qualifying it. (It used to say the two took it
  // with their own inline `SELECT … FOR UPDATE` and that `db-locks.ts`
  // recorded them as deliberately not adopting the helper. Both halves are
  // false now; `class-transitions.ts`'s own docblock was corrected and this
  // was not.) Sharing the path is deliberate: a writer that does not
  // contend for the Class row lock at all cannot be used to demonstrate that
  // taking the lock closes anything, since nothing it does could ever have
  // been blocked by a lock on the other side.
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

              // A real, separately committed transaction, taking the same
              // Class row lock every production registration-creating writer
              // takes — and since #104 through the same helper, `lockClassRow`,
              // rather than merely the same row — awaited to completion
              // (success or the lock-timeout failure) before this hook
              // returns, so the ordering is deterministic rather than racing
              // real scheduling.
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
      //
      // The SQLSTATE, not `not.toBeNull()`. That weaker assertion accepted
      // any throw at all: a `P2028` from an unrelated transaction budget, a
      // `P2024` from an exhausted pool, a unique-constraint violation from a
      // fixture collision would each have satisfied it while proving nothing
      // about the lock — the exact "green for the wrong cause" failure this
      // branch cites elsewhere as its reason for shape-keying every hook.
      // `55P03` is what a `SET LOCAL lock_timeout` expiry actually is;
      // `invitations-lock-order.test.ts` already asserts `40P01` this way for
      // the same reason.
      expect(String(competingWriteError)).toMatch(/55P03|lock timeout/);

      const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
      expect(updated.calendarEntry.cancelledAt).not.toBeNull();

      await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
      await prisma.registration.deleteMany({ where: { classId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
    },
    10_000,
  );

  /**
   * #174 four-specialist review, Important 3. Round 1 of task 6 moved the
   * registration COUNT under the lock and stopped there, which left the
   * WINDOW itself decided from the pre-lock snapshot: `date`, `startTime`,
   * `autoCancelCheck` and `minStudents` all still came from the sweep's outer
   * `findMany`.
   *
   * `date` and `startTime` are not economic fields, so `settingsLocked` does
   * not freeze them — a teacher can reschedule an `open` class that already
   * has registrations, at any moment, including while this sweep is in
   * flight. The consequence is not cosmetic: the class is cancelled against a
   * window it is no longer in, every registered student is emailed that it is
   * off, and `cancelled` is terminal in Postgres since this branch, so the
   * teacher cannot put it back from inside the app.
   *
   * Reproduced the same way the two tests above reproduce their races — the
   * reschedule lands strictly between the outer read and the transaction, not
   * before the call, because a reschedule before the call is seen by the
   * sweep's own `findMany` and would pass on fixed and unfixed code alike.
   */
  it('does not cancel a class rescheduled out of its window after the sweep read it', async () => {
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 2 });
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
    });

    let hookCalls = 0;
    const racing = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            // Shape-keyed, per the house rule for every hook in this file:
            // `autoCancelClasses`'s own sweep read is the one filtering on a
            // bare `status: 'open'`.
            const where = args.where as { status?: unknown } | undefined;
            if (where?.status !== 'open') return query(args);

            hookCalls += 1;
            const rows = await query(args);
            // A week later, so 15:00Z on July 20 is nowhere near the new
            // 14:00Z–16:00Z window on July 27. Committed before the sweep's
            // per-class transaction opens, so the snapshot it is walking is
            // stale by exactly one reschedule.
            await prisma.calendarEntry.update({
      where: { id: (await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, select: { calendarEntryId: true } })).calendarEntryId },
      data: { date: new Date('2026-07-27') },
    });
            return rows;
          },
        },
      },
      // Same cast rationale as the tests above.
    }) as unknown as PrismaClient;

    const cancelledCount = await autoCancelClasses(racing, new Date('2026-07-20T15:00:00Z'));

    expect(hookCalls).toBe(1);
    expect(cancelledCount).toBe(0);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.status).toBe('open');

    // Nobody was told a class was cancelled that wasn't. Pre-fix this is 2 —
    // one for the student, one for the teacher.
    expect(
      await prisma.notification.count({ where: { relatedClassId: cls.id, type: 'class_cancelled' } }),
    ).toBe(0);

    await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  });

  /**
   * #174 four-specialist review, Important 4. The pre-gate this sweep used to
   * have (`activeCount < minStudents`, from the eager-loaded registrations)
   * was deleted along with the eager-load when the count moved under the
   * lock. Without it the sweep opens a transaction, issues a `SET LOCAL` and
   * takes a `FOR UPDATE` on every in-window open class every 60 seconds —
   * the healthy majority included — and every concurrent registration on one
   * of those classes queues behind a lock taken to confirm nothing needed
   * doing.
   *
   * `registration.count` is the observable: it is the first statement the
   * transaction issues after the lock, and this class is `open` and inside
   * its window, so if the transaction had opened at all that count would have
   * run. Zero calls therefore means the transaction never opened — no
   * transaction, no `SET LOCAL`, no `FOR UPDATE`.
   *
   * Correctness is unaffected either way, which is why this is an
   * optimisation and not a fix: the authoritative check is still inside the
   * lock, so a pre-filter reading a stale snapshot can only delay a
   * cancellation to the next tick, never cause a wrong one.
   */
  it('does not open a transaction for a class that already meets its minimum', async () => {
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 1 });
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
    });

    let decisionCounts = 0;
    const watched = prisma.$extends({
      query: {
        registration: {
          async count({ args, query }) {
            // Same shape key as the interleaving test above: a single class
            // id plus the active-status set is `autoCancelClasses`'s own
            // decision count and nothing else.
            const where = args.where as
              | { classId?: unknown; status?: { in?: unknown } }
              | undefined;
            if (where?.classId === cls.id && Array.isArray(where?.status?.in)) {
              decisionCounts += 1;
            }
            return query(args);
          },
        },
      },
      // Same cast rationale as the tests above.
    }) as unknown as PrismaClient;

    // 15:00Z is inside the 14:00Z–16:00Z window, so the window is not what
    // skips this class — the pre-filter is.
    await autoCancelClasses(watched, new Date('2026-07-20T15:00:00Z'));

    expect(decisionCounts).toBe(0);

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.status).toBe('open');

    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  });

  /**
   * The pre-filter's `_count` is FILTERED, and the filter is the difference
   * between an optimisation and a bug. An unfiltered `_count` counts
   * cancelled and late-cancelled registrations too, so a class everybody
   * dropped out of would count above its minimum forever and never be swept
   * again — it would sit `open` until it started, with nobody in it and
   * nobody told.
   *
   * Two inactive registrations (one `cancelled`, one `late_cancel`) against
   * `minStudents: 1`: unfiltered that is
   * 2 >= 1 and the class survives; filtered it is 0 < 1 and the class is
   * cancelled, which is correct.
   */
  it('still cancels a class whose only registrations are cancelled', async () => {
    const cls = await makeClass({ autoCancelCheck: 'HOURS_2', minStudents: 1 });
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'cancelled', tierAtBooking: 3 },
    });
    await prisma.registration.create({
      data: { classId: cls.id, studentId: secondStudentId, status: 'late_cancel', tierAtBooking: 3 },
    });

    await autoCancelClasses(prisma, new Date('2026-07-20T15:00:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.calendarEntry.cancelledAt).not.toBeNull();

    await prisma.notification.deleteMany({ where: { relatedClassId: cls.id } });
    await prisma.registration.deleteMany({ where: { classId: cls.id } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
  });

  // Ordered before 'auto-completes an in-progress class after its local end
  // time' below on purpose: that test reuses the default `makeClass` slot
  // (`teacherId`+`2026-07-20`+`18:00`, `CalendarEntry_teacher_slot_excl`) and,
  // being the block's original last test, relies on this block's `afterAll`
  // (teacherId sweep) rather than an inline delete — so it must run AFTER
  // this test's own inline cleanup frees that slot, not before.
  it('does not complete a class rescheduled after the sweep read it', async () => {
    const cls = await makeClass({ status: 'in_progress' });
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3 },
    });

    let hookCalls = 0;
    const racing = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            // Shape-keyed: `autoCompleteClasses` is the only sweep reading
            // `status: 'in_progress'`.
            const where = args.where as { status?: unknown } | undefined;
            if (where?.status !== 'in_progress') return query(args);

            hookCalls += 1;
            const rows = await query(args);
            await prisma.calendarEntry.update({
      where: { id: (await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, select: { calendarEntryId: true } })).calendarEntryId },
      data: { date: new Date('2026-07-27') },
    });
            return rows;
          },
        },
      },
    }) as unknown as PrismaClient;

    // The consumer side of the refusal reason, which nothing tested before.
    // `completeClass`'s own test pins that it RETURNS `NOT_ENDED_YET`; these
    // spies pin that this sweep does something different with it. Between the
    // two, the discriminator that used to be a substring match on free text is
    // covered from both ends.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    const error = vi.spyOn(log, 'error').mockImplementation(() => log);
    try {
      const completed = await autoCompleteClasses(racing, new Date('2026-07-20T17:30:00Z'));

      expect(hookCalls).toBe(1);
      expect(completed).toBe(0);

      const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
      expect(updated.status).toBe('in_progress');
      // No payments for a class that has not happened. This is the assertion
      // that makes the defect concrete: completion creates Payment rows.
      expect(await prisma.payment.count({ where: { registration: { classId: cls.id } } })).toBe(0);

      // A reschedule is expected and self-resolving — the next tick re-evaluates
      // the class's new end time — so it must not page anyone. Every OTHER
      // refusal reason still goes to `error`, which is why both are asserted:
      // downgrading the whole branch would pass a `warn`-only check.
      expect(
        warn.mock.calls.filter((c) => (c[0] as { classId?: string })?.classId === cls.id),
      ).toHaveLength(1);
      expect(
        error.mock.calls.filter((c) => (c[0] as { classId?: string })?.classId === cls.id),
      ).toHaveLength(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
      await prisma.registration.deleteMany({ where: { classId: cls.id } });
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: cls.id } } } });
    }
  });

  it('auto-completes an in-progress class after its local end time', async () => {
    const cls = await makeClass({ status: 'in_progress', minStudents: 1 });
    await prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'attended', tierAtBooking: 3 },
    });

    // Ends 17:00Z (16:00Z start + 60 min); 17:30Z is past that.
    await autoCompleteClasses(prisma, new Date('2026-07-20T17:30:00Z'));

    const updated = await prisma.class.findUniqueOrThrow({ where: { id: cls.id }, include: { calendarEntry: true } });
    expect(updated.status).toBe('completed');
    expect(updated.totalRevenue).not.toBeNull();
  });
});
