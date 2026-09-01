import { describe, it, expect, beforeAll, afterAll, onTestFinished, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { formatDayHeader } from '@/lib/format';
import crypto from 'crypto';
import {
  AlreadyErasedError,
  exportStudentData,
  deleteStudentAccount,
  deleteTeacherAccount,
} from './gdpr';
import * as dbLocks from '@/lib/db-locks';
import { log } from '@/lib/log';
import { claimTemplateForGeneration } from './class-generator';
import { claimStudioTemplateForGeneration } from './studio-class-generator';
import { hhmmToTime } from '@/lib/time-of-day';
import { startOfLocalDay } from '@/lib/timezone';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * Self-contained fixture: a fresh teacher, room, and open class with one
 * student holding a `waiting` `WaitlistEntry` on it. No helper in this file
 * produces a waiting entry, so this builds the whole chain from scratch
 * rather than reusing the shared `describe('GDPR (DB)', ...)` fixtures —
 * those students get erased by other tests in that block, and test order is
 * not something to depend on.
 *
 * `waiting: false` is the case the waitlist-shaped tests below cannot reach
 * and the one the `SET LOCAL` hoist is about: an erasure with an empty lock
 * set, where the lock loop never runs. `registered: true` gives that erasure
 * a `Registration` row of its own to contend over, since with no class lock
 * there is otherwise nothing for a counterparty to hold.
 */
async function makeStudentWaitingInClass(
  {
    waiting = true,
    registered = false,
    entryStatus = 'waiting',
  }: {
    waiting?: boolean;
    registered?: boolean;
    /**
     * The status of the entry `waiting: true` creates. Defaults to `waiting`
     * because that is what every caller wanted before `expired` had a writer.
     *
     * It matters that this is a knob rather than a constant: the erasure's
     * `waitlistEntry.deleteMany` is unscoped by status, so its `Class` lock set
     * has to cover entries of EVERY status, and a fixture that can only produce
     * `waiting` rows cannot tell a correct lock set from one that merely
     * happens to coincide with it.
     */
    entryStatus?: 'waiting' | 'promoted' | 'claimed' | 'expired' | 'removed';
  } = {},
) {
  const suffix = `gdpr-lock-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Lock',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Class-lock fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const room = await prisma.room.create({
    data: {
      venueName: 'Lock Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234LK',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacher.id,
    },
    select: { id: true },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
    select: { id: true },
  });
  const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      classType: 'Lock class',
      date: new Date('2099-06-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open',
    });
  const student = await prisma.student.create({
    data: {
      firstName: 'Lock',
      lastName: 'Student',
      email: `${suffix}-student@test.local`,
      incomeTier: 2,
    },
    select: { id: true },
  });
  if (waiting) {
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: student.id, position: 1, status: entryStatus },
    });
  }
  const registration = registered
    ? await prisma.registration.create({
        data: { classId: cls.id, studentId: student.id, status: 'registered', tierAtBooking: 2 },
        select: { id: true },
      })
    : null;
  return {
    studentId: student.id,
    classId: cls.id,
    teacherId: teacher.id,
    roomId: room.id,
    accountId: teacher.accountId,
    registrationId: registration?.id ?? null,
  };
}

/**
 * Tears down everything `makeStudentWaitingInClass` created. Called from a
 * `finally` in each test that uses the fixture (round 1 review, M5) — an
 * assertion failure between creating the fixture and this call must still
 * reap it, not leak the teacher/room/class/student/account rows into the
 * next run.
 */
async function cleanupStudentWaitingInClass(
  fixture: Awaited<ReturnType<typeof makeStudentWaitingInClass>>,
): Promise<void> {
  // `WaitlistEntry.class` is `onDelete: Cascade`, so any surviving entry
  // (e.g. the erasure never ran because an earlier assertion threw) goes
  // with the class below — no separate delete needed for it here.
  await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: fixture.classId } } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: fixture.teacherId } });
  await prisma.room.deleteMany({ where: { id: fixture.roomId } });
  await prisma.student.deleteMany({ where: { id: fixture.studentId } });
  await prisma.teacher.deleteMany({ where: { id: fixture.teacherId } });
  await prisma.account.deleteMany({ where: { id: fixture.accountId } });
}

/**
 * A student with a CLOSED waitlist entry in each of `classCount` classes, and
 * none `waiting`. The shape the old sized budget was worst at.
 *
 * `waitingCount` counted `waiting` entries only, so this student scored zero
 * and got the 5_000ms floor — against a pre-lock whose join carries no status
 * predicate and therefore asks for `classCount` row locks. That mismatch is
 * #240's first axis, and this fixture is the only thing in the suite that can
 * express it: `makeStudentWaitingInClass` builds exactly one class.
 *
 * `status: 'open'` on the classes and `'expired'` on the entries, matching
 * `makeStudentWaitingInClass({ entryStatus: 'expired' })` rather than being
 * more realistic than it. A closed entry in production sits on a class that
 * has started, but nothing in this erasure reads class status for the
 * pre-lock, and consistency with the fixture already in this file is worth
 * more than the realism.
 *
 * `classIds` comes back SORTED. The pre-lock is `ORDER BY c.id` and ids are
 * UUIDs, so creation order is not lock order — a caller staggering holders by
 * creation order would have the erasure block once on whichever row is
 * released last, and that single wait would blow the 2s `lock_timeout`.
 *
 * Distinct `startTime` per class so nothing trips a same-slot constraint.
 */
async function makeStudentWithClosedEntriesInClasses(classCount: number) {
  const suffix = `gdpr-budget-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Budget',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Budget fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  const room = await prisma.room.create({
    data: {
      venueName: 'Budget Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234BG',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacher.id,
    },
    select: { id: true },
  });
  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
    select: { id: true },
  });
  const student = await prisma.student.create({
    data: {
      firstName: 'Budget',
      lastName: 'Student',
      email: `${suffix}-student@test.local`,
      incomeTier: 2,
    },
    select: { id: true },
  });
  const classIds: string[] = [];
  for (let i = 0; i < classCount; i++) {
    const cls = await createClassFixture(prisma, {
        teacherId: teacher.id,
        teacherRoomId: teacherRoom.id,
        classType: `Budget class ${i}`,
        date: new Date('2099-06-01'),
        startTime: hhmmToTime(`${String(9 + i).padStart(2, '0')}:00`),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'open',
      });
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: student.id, position: 1, status: 'expired' },
    });
    classIds.push(cls.id);
  }
  return {
    studentId: student.id,
    classIds: [...classIds].sort(),
    teacherId: teacher.id,
    roomId: room.id,
    accountId: teacher.accountId,
  };
}

/**
 * Tears down everything `makeStudentWithClosedEntriesInClasses` created.
 * Called from a `finally`, for the reason `cleanupStudentWaitingInClass`
 * above gives: an assertion failure mid-test must still reap the rows.
 *
 * `WaitlistEntry.class` is `onDelete: Cascade`, so surviving entries go with
 * their classes.
 */
async function cleanupStudentWithClosedEntries(
  fixture: Awaited<ReturnType<typeof makeStudentWithClosedEntriesInClasses>>,
): Promise<void> {
  await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: fixture.classIds } } } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: fixture.teacherId } });
  await prisma.room.deleteMany({ where: { id: fixture.roomId } });
  await prisma.student.deleteMany({ where: { id: fixture.studentId } });
  await prisma.teacher.deleteMany({ where: { id: fixture.teacherId } });
  await prisma.account.deleteMany({ where: { id: fixture.accountId } });
}

describe('GDPR (DB)', () => {
  let teacherId: string;
  let roomId: string;
  let teacherRoomId: string;
  let studentId: string;
let studentAccountId: string;
  let completedClassId: string;
  let openClassId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gdpr',
        lastName: 'Teacher',
        email: `gdpr-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `gdpr-teacher-${uniqueSuffix}@test.local` } },
        bio: 'GDPR tests',
        pageSlug: `gdpr-teacher-${uniqueSuffix}`,
        bankIban: 'NL00TEST0123456789',
      },
    });
    teacherId = teacher.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'GDPR Studio',
        address: `${uniqueSuffix} GDPR St`,
        city: 'Amsterdam',
        postcode: '1234GD',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const tr = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
    });
    teacherRoomId = tr.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Gdpr',
        lastName: 'Student',
        email: `gdpr-student-${uniqueSuffix}@test.local`,
        incomeTier: 2,
        phone: '+31600000000',
        claimedAt: new Date(),
        account: { create: { email: `gdpr-student-${uniqueSuffix}@test.local` } },
      },
    });
    studentId = student.id;
    studentAccountId = student.accountId!;

    await prisma.teacherStudent.create({ data: { teacherId, studentId } });
    await prisma.studentPrivacy.create({
      data: { studentId, teacherId, shareFullName: true },
    });

    const mkClass = (status: 'completed' | 'open', date: string) =>
      createClassFixture(prisma, {
          teacherId,
          teacherRoomId,
          classType: `GDPR ${status}`,
          date: new Date(date),
          startTime: hhmmToTime('09:00'),
          durationMinutes: 60,
          roomCost: 20,
          minRate: 15,
          targetRate: 25,
          minStudents: 1,
          maxStudents: 10,
          status,
        });

    const completed = await mkClass('completed', '2026-06-01');
    completedClassId = completed.id;
    const open = await mkClass('open', '2099-06-01');
    openClassId = open.id;

    const completedReg = await prisma.registration.create({
      data: { classId: completedClassId, studentId, status: 'attended', tierAtBooking: 2, price: 11.5 },
    });
    await prisma.payment.create({
      data: { registrationId: completedReg.id, amount: 11.5, status: 'pending' },
    });
    await prisma.registration.create({
      data: { classId: openClassId, studentId, status: 'registered', tierAtBooking: 2 },
    });
    await prisma.notification.create({
      data: {
        recipientType: 'student',
        recipientId: studentId,
        type: 'booking_confirmed',
        title: 'Booking confirmed',
        body: 'test',
        relatedClassId: openClassId,
      },
    });
    // The teacher's copy carries the student's first name — must be scrubbed.
    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'New booking',
        body: 'Gdpr booked GDPR open.',
        relatedClassId: openClassId,
      },
    });
    await prisma.session.create({
      data: {
        id: crypto.randomBytes(32).toString('hex'),
        accountId: studentAccountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { relatedClassId: { in: [completedClassId, openClassId] } },
    });
    await prisma.payment.deleteMany({ where: { registration: { classId: completedClassId } } });
    await prisma.registration.deleteMany({ where: { classId: { in: [completedClassId, openClassId] } } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: [completedClassId, openClassId] } } } } });
    await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  it('export contains profile, bookings, and payment state', async () => {
    const data = await exportStudentData(prisma, studentId);
    expect(data.profile.email).toContain('gdpr-student');
    expect(data.profile.phone).toBe('+31600000000');
    expect(data.bookings.length).toBeGreaterThanOrEqual(2);
    const paidBooking = data.bookings.find((b) => b.payment);
    expect(paidBooking?.payment?.status).toBe('pending');
    expect(data.privacySettings).toHaveLength(1);
  });

  it('student deletion anonymizes, cancels upcoming, and keeps financial rows', async () => {
    await deleteStudentAccount(prisma, studentId);

    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    expect(student.firstName).toBe('Deleted');
    expect(student.email).toBe(`deleted-${studentId}@deleted.invalid`);
    expect(student.phone).toBeNull();
    expect(student.deletedAt).not.toBeNull();

    // Pure personal data gone
    expect(await prisma.studentPrivacy.count({ where: { studentId } })).toBe(0);
    expect(await prisma.teacherStudent.count({ where: { studentId } })).toBe(0);
    expect(
      await prisma.notification.count({ where: { recipientType: 'student', recipientId: studentId } }),
    ).toBe(0);
    expect(
      await prisma.session.count({ where: { accountId: studentAccountId } }),
    ).toBe(0);

    // Upcoming booking cancelled; charged history intact
    const upcoming = await prisma.registration.findFirst({
      where: { classId: openClassId, studentId },
    });
    expect(upcoming?.status).toBe('cancelled');

    const charged = await prisma.registration.findFirst({
      where: { classId: completedClassId, studentId },
      include: { payment: true },
    });
    expect(charged?.status).toBe('attended');
    expect(charged?.payment?.status).toBe('pending');
    expect(Number(charged?.payment?.amount)).toBe(11.5);

    // The teacher's "X booked" notification no longer names the student
    const teacherCopy = await prisma.notification.findFirst({
      where: { recipientType: 'teacher', recipientId: teacherId, relatedClassId: openClassId },
    });
    expect(teacherCopy?.body).not.toContain('Gdpr');
    expect(teacherCopy?.body).toContain('deleted');
  });

  it('waits for a class row another transaction holds before renumbering other students', async () => {
    const fixture = await makeStudentWaitingInClass();
    const { studentId: fixtureStudentId, classId: fixtureClassId } = fixture;
    try {
      let holderReleased = false;

      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${fixtureClassId} FOR UPDATE`;
          await new Promise((r) => setTimeout(r, 900));
          holderReleased = true;
        },
        { timeout: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 150));

      const erasing = deleteStudentAccount(prisma, fixtureStudentId).then(() => 'returned' as const);
      const outcome = await Promise.race([
        erasing,
        new Promise<'waiting'>((r) => setTimeout(() => r('waiting'), 400)),
      ]);

      expect(outcome).toBe('waiting');
      expect(holderReleased).toBe(false);

      await holder;
      expect(await erasing).toBe('returned');
    } finally {
      await cleanupStudentWaitingInClass(fixture);
    }
  }, 15_000);

  /**
   * The same lever as the test above, on a CLOSED entry — and it is the closed
   * case this erasure got wrong.
   *
   * `waitlistEntry.deleteMany({ where: { studentId } })` deletes every entry the
   * student holds, of every status. The `Class` lock set was built from a read
   * scoped to `status: 'waiting'`. Those two sets coincided only by accident:
   * before #216 nothing closed a queue when a class STARTED, so a student who
   * never got in stayed `waiting` for ever and their class stayed in the lock
   * set. `closeQueueOnStart` flips exactly those rows to `expired` — which is
   * the fix — and in doing so dropped their classes out of the lock set while
   * the delete went on deleting them.
   *
   * Unlocked is not theoretical here. `POST /api/registrations` resolves an
   * `expired` entry when a teacher walks a queued student in, holding the class
   * row while it does; an erasure landing in that window deleted the row out
   * from under it, and the walk-in's `update` by id then raised `P2025` — which
   * `classifyApiError` has no branch for, so a bare 500 with the whole
   * registration rolled back.
   *
   * Run over EVERY status, not just `expired`. The stated invariant is write
   * set equals lock set, and a fixture that only ever produces one status
   * cannot distinguish that from a lock set that merely happens to include it —
   * scoping the pre-lock to `waiting` ∪ `expired` would pass a single-status
   * version of this test while still deleting `promoted`, `claimed` and
   * `removed` rows outside the lock. (`waiting` passes either way and is kept
   * as the control.)
   *
   * Without the widened lock set this test does not merely assert something
   * weaker — it goes GREEN by returning immediately, because the erasure never
   * asks for the row the holder is sitting on.
   */
  it.each(['waiting', 'promoted', 'claimed', 'expired', 'removed'] as const)(
    'waits for a class row another transaction holds when the erased entry is %s',
    async (entryStatus) => {
    const fixture = await makeStudentWaitingInClass({ entryStatus });
    const { studentId: fixtureStudentId, classId: fixtureClassId } = fixture;
    try {
      let holderReleased = false;

      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${fixtureClassId} FOR UPDATE`;
          await new Promise((r) => setTimeout(r, 900));
          holderReleased = true;
        },
        { timeout: 10_000 },
      );
      await new Promise((r) => setTimeout(r, 150));

      // CAUSAL, not a wall-clock threshold. Resolving the erasure to the
      // holder's own flag asserts the ORDER of the two — the erasure finished
      // only after the holder let go — which is the property the lock provides.
      // A `Promise.race` against a fixed timer proves only "did not finish
      // within N ms", which a loaded runner can satisfy for reasons unrelated to
      // locking; and the `holderReleased` check that used to sit beside it was
      // sampled before the holder's own sleep elapsed, so it could not fail
      // either way and carried no information.
      const erasedAfterHolder = deleteStudentAccount(prisma, fixtureStudentId).then(
        () => holderReleased,
      );

      await holder;
      // False here would mean the erasure sailed past a held row lock, which is
      // exactly what a lock set scoped to `waiting` does: it never asks for this
      // class, so it finishes while the holder is still sleeping.
      expect(await erasedAfterHolder).toBe(true);

      // And the entry is still gone afterwards. The widened lock set changes
      // WHEN the delete happens, never whether it does — an erasure that locked
      // more but erased less would be a worse bug than the one being fixed.
      const remaining = await prisma.waitlistEntry.count({
        where: { studentId: fixtureStudentId },
      });
      expect(remaining).toBe(0);
    } finally {
      await cleanupStudentWaitingInClass(fixture);
    }
    },
    15_000,
  );

  /**
   * #174 four-specialist review, Important 5. The 2s bound used to arrive
   * only as a side effect of `lockClassRow`, which runs once per class the
   * erased student is `waiting` in — so a student waiting in ZERO classes,
   * the common case, got an unbounded wait on every statement in the erasure
   * transaction. Prisma's own `timeout` cannot rescue that: it refuses to
   * START a statement past the budget, it cannot cancel one already blocked
   * inside Postgres, so the erasure simply hung.
   *
   * Round 2 review measured exactly this and wrote the asymmetry down as
   * intended. It was not — nothing in the GDPR-clock reason for bounding an
   * erasure depends on the subject being on a waitlist.
   *
   * The contended row is the student's own `Registration`, unrelated to any
   * class lock, because with an empty lock set there is nothing else for a
   * counterparty to hold. Held for 4s, well past the 2s bound, so what this
   * observes is the timeout and not a wait.
   */
  it('bounds its wait even when the student is waiting in no classes at all', async () => {
    const fixture = await makeStudentWaitingInClass({ waiting: false, registered: true });
    const { studentId: fixtureStudentId, registrationId } = fixture;
    try {
      // The premise: an empty lock set. With a `waiting` entry here the lock
      // loop would run, `lockClassRow` would set the bound, and this test
      // would pass without the hoist it exists to pin.
      expect(
        await prisma.waitlistEntry.count({
          where: { studentId: fixtureStudentId, status: 'waiting' },
        }),
      ).toBe(0);

      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "Registration" WHERE id = ${registrationId} FOR UPDATE`;
          await new Promise((r) => setTimeout(r, 4_000));
        },
        { timeout: 20_000 },
      );
      await new Promise((r) => setTimeout(r, 150));

      const outcome = await deleteStudentAccount(prisma, fixtureStudentId)
        .then(() => 'returned' as const)
        .catch((err: unknown) => ({ error: String(err) }) as const);
      await holder;

      // Unbounded (pre-hoist) this is `'returned'`: the erasure waits out the
      // full 4s hold and succeeds.
      expect(outcome).not.toBe('returned');
      expect(typeof outcome === 'object' ? outcome.error : '').toMatch(/55P03|lock timeout/);

      // And the abort is atomic — nothing half-applied, which is what makes
      // the route's retry advice sound.
      const student = await prisma.student.findUniqueOrThrow({ where: { id: fixtureStudentId } });
      expect(student.deletedAt).toBeNull();
    } finally {
      await cleanupStudentWaitingInClass(fixture);
    }
  }, 30_000);

  /**
   * #240. The erasure's transaction budget used to be sized from a count of
   * `waiting` entries only, so a student with none scored zero and got the
   * 5_000ms floor — against a pre-lock that still asks for one row lock per
   * class the student holds an entry in, of any status.
   *
   * The construction is fiddly for reasons worth stating, because a simpler
   * version of it proves nothing:
   *
   * - Six holders releasing 1.5s apart, NOT all at once. Simultaneous
   *   releases produce one ~1.5s wait, not six; the statement then finishes
   *   inside 5s and the old budget passes.
   * - Staggered by SORTED class id, because the pre-lock is `ORDER BY c.id`.
   *   Stagger by creation order and the erasure blocks once on whatever is
   *   released last, that single wait exceeds the 2s `lock_timeout`, and the
   *   FIXED code fails with `55P03`.
   * - `pg_sleep` inside the holding transaction, on an ABSOLUTE schedule
   *   computed from `t0`, rather than a JS timer per holder. The two margins
   *   pull against each other — total elapsed must clear 5_000ms or the old
   *   budget survives, and no single wait may reach 2_000ms or the new one
   *   dies — and a JS timer firing late spends the second margin directly.
   *   1.5s steps leave 500ms of headroom under the bound and ≈3.7s over the
   *   old budget.
   * - A DEDICATED client with an explicit `connection_limit`. Prisma's
   *   default pool is `physical_cores * 2 + 1`; on a two-core CI runner that
   *   is five, and six holders plus the erasure would deadlock waiting for
   *   connections rather than for locks — a failure that looks nothing like
   *   what this test is about.
   *
   * What it proves, precisely: an erasure whose lock waits total more than
   * the old floor now completes. Restore
   * `Math.min(5_000 + waitingCount * 2_000, 20_000)` and it fails with
   * `P2028`, which is #240 reproduced.
   *
   * And it proves that by asserting it, not by finishing. Two assertions
   * carry the whole test — elapsed above the old floor, and the erasure
   * returning after the last hold ended — because the outcome assertions
   * (entries gone, `deletedAt` set) are equally true of an erasure that
   * contended for nothing. See their comments in the body for the two
   * realistic paths to that vacuous pass; the point of both assertions is
   * that this test fails loudly on the day it stops exercising #240 instead
   * of quietly continuing to pass.
   */
  it('completes when its lock waits total more than the old 5s budget', async () => {
    const CLASSES = 6;
    const HOLD_STEP_MS = 1_500;
    const fixture = await makeStudentWithClosedEntriesInClasses(CLASSES);
    const baseUrl = process.env.DATABASE_URL ?? '';
    const holderDb = new PrismaClient({
      datasources: {
        db: { url: `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}connection_limit=10` },
      },
    });
    try {
      let lastHolderReleased = false;
      const t0 = Date.now();
      const holders = fixture.classIds.map((classId, i) =>
        holderDb.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${classId} FOR UPDATE`;
            const seconds = Math.max(0, (t0 + (i + 1) * HOLD_STEP_MS - Date.now()) / 1000);
            // Computed, never input — `$queryRawUnsafe` because a bound
            // parameter into `pg_sleep` needs an explicit cast to resolve.
            // The trailing `::text` is load-bearing, not decorative:
            // `pg_sleep` returns `void`, which Prisma cannot deserialize.
            // Without the cast every holder's `$transaction` REJECTS with
            // P2010 right after its sleep completes — invisible today,
            // because the erasure throws P2028 first and `Promise.all`
            // below is never reached, but fatal once the budget is fixed:
            // the erasure would then succeed, execution would reach
            // `Promise.all(holders)`, and it would reject with P2010,
            // failing this test against the very fix it exists to confirm.
            await tx.$queryRawUnsafe(`SELECT pg_sleep(${seconds.toFixed(3)})::text`);
            // `fixture.classIds` is sorted and the pre-lock is `ORDER BY c.id`,
            // so the highest index is both the last row the erasure can reach
            // and the last hold to end — the one whose release the erasure's
            // return has to follow. Set inside the callback, i.e. just before
            // the COMMIT that actually drops the lock, exactly as the sibling
            // test's `holderReleased` is; that is conservative in the right
            // direction, because the flag turns true slightly BEFORE the lock
            // is free, so a false reading below cannot be an artefact of the
            // flag arriving late.
            if (i === CLASSES - 1) lastHolderReleased = true;
          },
          { timeout: 30_000, maxWait: 10_000 },
        ),
      );

      // Every holder must be sitting on its row before the erasure asks for
      // any of them, or the pre-lock sails through the ones not yet taken.
      await new Promise((r) => setTimeout(r, 300));

      // The two assertions after this call are the test. Everything else it
      // checks — entries gone, `deletedAt` set — is equally true of an erasure
      // that contended for NOTHING and returned in 40ms, so "it passed" is
      // worthless evidence here: such a run would also have passed against the
      // 5_000ms budget this test exists to bury, and would have reported
      // nothing about it. Two realistic paths lead there. `holderDb` is a
      // freshly constructed `PrismaClient`, so its first six queries pay
      // engine start plus connect; if that ever outruns the 300ms settle, the
      // pre-lock reaches rows nobody is holding yet. And `Math.max(0, …)`
      // above collapses a hold to zero whenever its `FOR UPDATE` came back
      // late, degrading the stagger from the front. Both fail green unless the
      // properties that distinguish a real run are asserted outright.
      const tStart = Date.now();
      const erasure = deleteStudentAccount(prisma, fixture.studentId).then(() => ({
        elapsedMs: Date.now() - tStart,
        afterLastHolder: lastHolderReleased,
      }));
      // Marks a rejection handled at the moment it can occur, nine seconds
      // before `await erasure` below gets to it. A regression of #240 makes
      // this call reject with `P2028`, and without this line that rejection
      // sits unhandled across the `Promise.all` and surfaces as an unhandled
      // rejection — attributable to any file — instead of as this test failing
      // on the await. The await still throws it; only the reporting changes.
      void erasure.catch(() => undefined);

      await Promise.all(holders);
      const { elapsedMs, afterLastHolder } = await erasure;

      // CAUSAL, mirroring the `erasedAfterHolder` resolution in "waits for a
      // class row another transaction holds when the erased entry is %s" —
      // named rather than counted, because a relative count rots the moment
      // anyone inserts a test between the two, which is exactly how this
      // branch's other cross-references died. The erasure returned only after
      // the last hold ended. That is ORDER, which is the property a lock
      // provides and which a duration on its own — a loaded runner can spend
      // 6s on anything — does not establish.
      expect(afterLastHolder).toBe(true);

      // ELAPSED, and this is the assertion that is specifically about #240,
      // because it is the literal claim "this run would have failed under the
      // old budget". The threshold is that old floor, 5_000ms, and the margin
      // is stated rather than hoped for: six holds 1.5s apart end at
      // t0 + 9_000ms while the erasure starts at t0 + ~300ms, so observed
      // elapsed has been 8666-8821ms across runs — 3.7-3.8s of headroom over
      // the threshold, matching the ≈3.7s the construction notes above
      // predict. The window measured here is a superset of the transaction's
      // own (it includes the pre-transaction `student.findUniqueOrThrow` and
      // the post-commit `handleSpotFreed` loop), which is milliseconds against
      // that margin and errs toward passing; the causal assertion above is
      // what rules out an elapsed figure earned by anything other than waiting
      // for locks. Mutation-checked rather than assumed: `HOLD_STEP_MS = 500`
      // makes the whole run finish in 2780ms and this line fails with
      // "expected 2780 to be greater than 5000" instead of passing green.
      expect(elapsedMs).toBeGreaterThan(5_000);

      expect(
        await prisma.waitlistEntry.count({ where: { studentId: fixture.studentId } }),
      ).toBe(0);
      const erased = await prisma.student.findUniqueOrThrow({
        where: { id: fixture.studentId },
        select: { deletedAt: true },
      });
      expect(erased.deletedAt).not.toBeNull();
    } finally {
      await holderDb.$disconnect();
      await cleanupStudentWithClosedEntries(fixture);
    }
  }, 40_000);

  it('does not deadlock against a transaction that locks the class first and then writes the erased student\'s waiting entry', async () => {
    // Round 1 review, C1: the previous version of this fix took the row
    // locks below BEFORE requesting the Class lock — the inverse of every
    // other writer (`promoteNext` dropping a stale head,
    // `withdrawWaitingEntriesForTeacher` clearing every entry both lock the
    // Class row FIRST, then write `WaitlistEntry`). That inversion is a
    // classic AB-BA deadlock: this transaction holding a `WaitlistEntry` row
    // lock while requesting the Class lock, opposite another transaction
    // holding the Class lock while requesting that same `WaitlistEntry`
    // row. `OTHER` below plays that other transaction's exact shape — Class
    // `FOR UPDATE` first, `WaitlistEntry` write second — reproduced against
    // the previous version of this fix as Postgres error `40P01 deadlock
    // detected`, and fails this test (via one of the two outcomes below not
    // matching) if the class lock ever moves back below this transaction's
    // own writes.
    const fixture = await makeStudentWaitingInClass();
    const { studentId: fixtureStudentId, classId: fixtureClassId } = fixture;
    try {
      // Canary. Everything this test asserts is an absence — neither side
      // rejected — so it passes trivially if `deleteStudentAccount` never
      // takes a `Class` lock at all, and it only takes one when its own
      // `waitlistEntry.findMany({ where: { studentId, status: 'waiting' } })`
      // returns something. Drift the fixture's status, or narrow that filter,
      // and the lock loop stops running while this test stays green with
      // nothing left to deadlock over. Its sibling above self-protects (a
      // missing lock means no wait, and the wait IS its assertion); this one
      // does not, so it says the premise out loud.
      expect(
        await prisma.waitlistEntry.count({
          where: { studentId: fixtureStudentId, status: 'waiting' },
        }),
      ).toBe(1);

      const other = prisma
        .$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${fixtureClassId} FOR UPDATE`;
            // Give the erasure time to reach — and, pre-fix, complete — its
            // own write to this same `WaitlistEntry` row before this
            // transaction tries to touch it too. Comfortably under the 1s
            // Postgres `deadlock_timeout` this test relies on to resolve the
            // cycle it is trying to provoke.
            await new Promise((r) => setTimeout(r, 300));
            await tx.waitlistEntry.updateMany({
              where: { classId: fixtureClassId, studentId: fixtureStudentId },
              data: { status: 'removed' },
            });
          },
          { timeout: 10_000 },
        )
        .then(() => 'other-ok' as const)
        .catch((err: unknown) => ({ error: String(err) }) as const);

      // Small settle so `other`'s `FOR UPDATE` is in place before the
      // erasure starts — mirrors the settle in the wait test above.
      await new Promise((r) => setTimeout(r, 50));

      const erasing = deleteStudentAccount(prisma, fixtureStudentId)
        .then(() => 'returned' as const)
        .catch((err: unknown) => ({ error: String(err) }) as const);

      const [otherOutcome, erasureOutcome] = await Promise.all([other, erasing]);

      expect(erasureOutcome).toBe('returned');
      expect(otherOutcome).toBe('other-ok');
    } finally {
      await cleanupStudentWaitingInClass(fixture);
    }
  }, 15_000);

  /**
   * #112. `waiting: true, registered: false` is the load-bearing shape: a
   * class whose ONLY audience is its queue. `gdpr.ts` already closes these
   * entries (`:748`) but built its recipient list from registrations alone,
   * and gated the whole build behind `if (registrations.length > 0)` — so
   * this exact fixture is the one that catches both halves. A fixture with a
   * registered student too would pass against the unfixed guard, because the
   * build would run for the registered student and the waiter would ride
   * along on the concatenation.
   */
  it('tells a queued student when the teacher erases their account, with nobody registered', async () => {
    const fixture = await makeStudentWaitingInClass({ waiting: true, registered: false });
    try {
      await deleteTeacherAccount(prisma, fixture.teacherId);

      const note = await prisma.notification.findFirstOrThrow({
        where: {
          recipientType: 'student',
          recipientId: fixture.studentId,
          relatedClassId: fixture.classId,
          type: 'class_cancelled',
        },
      });

      // The body names the class — type, day, time. Pinned here because it was
      // otherwise unpinned on this path: reverting the body to its pre-#112
      // text passed this whole file, and the widened `select` (`date`,
      // `startTime`) went unpinned with it. The other two paths assert their
      // own bodies; this one is the same rule and needs the same guard.
      //
      // `relatedClassId` survives here — the class stays as `cancelled` rather
      // than being deleted — but a cancelled class returns null from
      // `studentNotificationHref`, so the link is inert and the body is still
      // all the student has.
      expect(note.body).toContain('Lock class'); // the fixture's classType
      expect(note.body).toContain(formatDayHeader(new Date('2099-06-01')));
      expect(note.body).toContain('09:00');

      const entry = await prisma.waitlistEntry.findFirstOrThrow({
        where: { classId: fixture.classId, studentId: fixture.studentId },
      });
      expect(entry.status).toBe('removed');
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: fixture.studentId } });
      await cleanupStudentWaitingInClass(fixture);
    }
  });

  it('teacher deletion cancels upcoming classes, notifies, and anonymizes', async () => {
    // Fresh student registered on the teacher's open class (recreate an
    // open class since the previous one now has a cancelled registration).
    const other = await prisma.student.create({
      data: {
        firstName: 'Other',
        lastName: 'Student',
        email: `gdpr-other-${uniqueSuffix}@test.local`,
        incomeTier: 3,
      },
    });
    await prisma.registration.create({
      data: { classId: openClassId, studentId: other.id, status: 'registered', tierAtBooking: 3 },
    });

    await deleteTeacherAccount(prisma, teacherId);

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.firstName).toBe('Deleted');
    expect(teacher.bankIban).toBeNull();
    expect(teacher.pageSlug).toBe(`deleted-${teacherId}`);
    expect(teacher.deletedAt).not.toBeNull();

    // Cancellation is the ENTRY's column since #327 — the class keeps its
    // `open` status, which is asserted alongside so a regression that wrote
    // neither reads as what it is.
    const openClass = await prisma.class.findUniqueOrThrow({ where: { id: openClassId }, include: { calendarEntry: true } });
    expect(openClass.status).toBe('open');
    expect(openClass.calendarEntry.cancelledAt).not.toBeNull();

    // Registered student was told
    const note = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: other.id, type: 'class_cancelled' },
    });
    expect(note).not.toBeNull();

    // Completed class (the students' payment history) survives
    const completed = await prisma.class.findUniqueOrThrow({ where: { id: completedClassId }, include: { calendarEntry: true } });
    expect(completed.status).toBe('completed');

    await prisma.notification.deleteMany({ where: { recipientId: other.id } });
    await prisma.registration.deleteMany({ where: { studentId: other.id } });
    await prisma.student.delete({ where: { id: other.id } });
  });
});

describe('GDPR on dual-role accounts', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-dual-${Date.now()}`;
  let accountId: string;
  let teacherId: string;
  let studentId: string;
  let soloAccountId: string;
  let soloStudentId: string;
  let sessionId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Dual',
        lastName: 'Gdpr',
        email: `${suffix}@test.local`,
        bio: 'Dual erasure fixtures',
        pageSlug: suffix,
        account: { create: { email: `${suffix}@test.local` } },
      },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
    const student = await prisma.student.create({
      data: {
        firstName: 'Dual',
        lastName: 'Gdpr',
        email: `${suffix}-s@test.local`,
        claimedAt: new Date(),
        account: { connect: { id: accountId } },
      },
    });
    studentId = student.id;
    sessionId = crypto.randomBytes(32).toString('hex');
    await prisma.session.create({
      data: { id: sessionId, accountId, expiresAt: new Date(Date.now() + 86400000) },
    });

    const solo = await prisma.student.create({
      data: {
        firstName: 'Solo',
        lastName: 'Gdpr',
        email: `${suffix}-solo@test.local`,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-solo@test.local` } },
      },
    });
    soloStudentId = solo.id;
    soloAccountId = solo.accountId!;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId: { in: [accountId, soloAccountId] } } });
    await prisma.student.deleteMany({ where: { id: { in: [studentId, soloStudentId] } } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: [accountId, soloAccountId] } } });
    await prisma.$disconnect();
  });

  it('erasing the student half of a dual account keeps sessions and the account email', async () => {
    await deleteStudentAccount(prisma, studentId);

    // The living teacher profile still uses this account.
    expect(await prisma.session.count({ where: { accountId } })).toBe(1);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.email).toBe(`${suffix}@test.local`);
  });

  it('erasing the last profile scrubs the account email too', async () => {
    await deleteStudentAccount(prisma, soloStudentId);

    const account = await prisma.account.findUniqueOrThrow({ where: { id: soloAccountId } });
    expect(account.email).toBe(`deleted-${soloAccountId}@deleted.invalid`);
  });

  it('composed route order (student half, then teacher half) leaves nothing behind', async () => {
    // The student half was erased in the first test — now the teacher
    // half goes, completing exactly what DELETE /api/account does for a
    // dual account. Everything auth-related must be gone.
    await deleteTeacherAccount(prisma, teacherId);

    expect(await prisma.session.count({ where: { accountId } })).toBe(0);
    expect(await prisma.passkeyCredential.count({ where: { accountId } })).toBe(0);
    const account = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.email).toBe(`deleted-${accountId}@deleted.invalid`);
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.deletedAt).not.toBeNull();
    expect(teacher.firstName).toBe('Deleted');
  });
});

// #166 added two tables holding a person's email address plus the first and
// last name a TEACHER typed for them. Neither erasure nor the subject-access
// export knew they existed (re-review I2). The tests below are ordered:
// export first, then student erasure, then teacher erasure — each reads the
// state the previous one left.
describe('GDPR reaches Invitation and TeacherBlock (#166 review I2)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-inv-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  // Used to carry uppercase on purpose, to prove the invitation/block
  // lookups bridged `Student.email`'s typed casing to `Invitation.email` and
  // `TeacherBlock.email`'s lowercase-by-construction one. That row is
  // unrepresentable now: `Student_email_lowercase_check` and
  // `Account_email_lowercase_check` (#170 Task 2) reject it, and the
  // bridging itself is gone (#170 Task 3) — every email below is lowercase
  // by construction, matching what every column now enforces.
  const email = `Gdpr-Inv-${suffix}@Test.Local`.toLowerCase();
  let inviterId: string;
  let inviterAccountId: string;
  let blockerId: string;
  let blockerAccountId: string;
  let movedId: string;
  let movedAccountId: string;
  let studentId: string;
  let studentAccountId: string;
  let strangerInvitationId: string;
  let movedInvitationId: string;
  const movedAwayEmail = `${suffix}-moved-away@test.local`;

  const mkTeacher = async (label: string) => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Inv',
        lastName: label,
        email: `${suffix}-${label}@test.local`,
        bio: 'I2 fixtures',
        pageSlug: `${suffix}-${label}`,
        account: { create: { email: `${suffix}-${label}@test.local` } },
      },
      select: { id: true, accountId: true },
    });
    return teacher;
  };

  beforeAll(async () => {
    const inviter = await mkTeacher('inviter');
    inviterId = inviter.id;
    inviterAccountId = inviter.accountId;
    const blocker = await mkTeacher('blocker');
    blockerId = blocker.id;
    blockerAccountId = blocker.accountId;
    const moved = await mkTeacher('moved');
    movedId = moved.id;
    movedAccountId = moved.accountId;

    const student = await prisma.student.create({
      data: {
        firstName: 'Inv',
        lastName: 'Subject',
        email,
        claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    studentAccountId = student.accountId!;

    // Two teachers, so the anonymised address has to stay unique per teacher
    // (`@@unique([teacherId, email])`) rather than collapsing two rows onto
    // one value. Different statuses, so the `respondedAt`/`status` CHECK is
    // exercised from both sides of it.
    await prisma.invitation.create({
      data: {
        teacherId: inviterId, email, firstName: 'Sam', lastName: 'Typo',
        status: 'accepted', respondedAt: new Date('2026-02-03T04:05:06.000Z'),
        lastNotifiedAt: new Date('2026-02-03T04:05:06.000Z'), lastNotifiedEmail: email,
      },
    });
    await prisma.invitation.create({
      data: {
        teacherId: blockerId, email, firstName: 'Sammy', lastName: 'Typo',
        status: 'declined', respondedAt: new Date('2026-03-04T05:06:07.000Z'),
      },
    });
    await prisma.teacherBlock.create({ data: { teacherId: blockerId, email } });

    // A third teacher's row, shaped like the `inviterId` row above (accepted,
    // a marker set to the subject's real address) — then, immediately, the
    // exact edit `PUT /api/invitations/[id]` performs: the row's CURRENT
    // `email` moves off the subject's address entirely, while the marker
    // (`lastNotifiedEmail`) is left holding it. A fresh teacher is needed
    // for this: `@@unique([teacherId, email])` already has both `inviterId`
    // and `blockerId` holding a row keyed on (their id, the subject's
    // email), so a same-teacher second row at that address could not even
    // be created. This is the row the third, marker-keyed erasure statement
    // in `gdpr.ts` exists to reach — the first two statements match on the
    // row's CURRENT `email`, which is no longer the subject's here.
    const movedInvitation = await prisma.invitation.create({
      data: {
        teacherId: movedId, email, firstName: 'Mo', lastName: 'Typo',
        status: 'accepted', respondedAt: new Date('2026-04-05T06:07:08.000Z'),
        lastNotifiedAt: new Date('2026-04-05T06:07:08.000Z'), lastNotifiedEmail: email,
      },
      select: { id: true },
    });
    movedInvitationId = movedInvitation.id;
    await prisma.invitation.update({
      where: { id: movedInvitationId },
      data: { email: movedAwayEmail },
    });

    // Somebody else entirely, on the teacher who gets erased last: the point
    // of clearing a teacher's contacts is that they hold OTHER people's
    // addresses, and an anonymised row alone could not show that.
    const stranger = await prisma.invitation.create({
      data: {
        teacherId: blockerId, email: `${suffix}-stranger@test.local`,
        firstName: 'A', lastName: 'Stranger',
      },
      select: { id: true },
    });
    strangerInvitationId = stranger.id;
  });

  afterAll(async () => {
    // Invitation and TeacherBlock cascade off Teacher.
    await prisma.teacher.deleteMany({ where: { id: { in: [inviterId, blockerId, movedId] } } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.account.deleteMany({
      where: { id: { in: [inviterAccountId, blockerAccountId, movedAccountId, studentAccountId] } },
    });
    await prisma.$disconnect();
  });

  it('the subject-access export lists the invitations and blocks held about them', async () => {
    const data = await exportStudentData(prisma, studentId);

    // The name is the teacher's guess at who this person is, held about them
    // without their involvement — precisely the kind of record Art. 15 is
    // for, and it appears nowhere else in the export.
    expect(data.invitations).toHaveLength(2);
    const accepted = data.invitations.find((i) => i.status === 'accepted');
    expect(accepted?.teacher).toBe('Inv inviter');
    expect(accepted?.nameTheyUsed).toBe('Sam Typo');
    expect(data.invitations.find((i) => i.status === 'declined')?.teacher).toBe('Inv blocker');

    expect(data.blockedTeachers).toHaveLength(1);
    expect(data.blockedTeachers[0]?.teacher).toBe('Inv blocker');
  });

  it('erasing a student anonymises the invitations that name them', async () => {
    await deleteStudentAccount(prisma, studentId);

    const allRows = await prisma.invitation.findMany({
      where: { teacherId: { in: [inviterId, blockerId, movedId] }, firstName: { not: 'A' } },
      orderBy: { teacherId: 'asc' },
    });
    expect(allRows).toHaveLength(3);

    // The two rows whose CURRENT `email` was still the subject's real
    // address at erasure time.
    const rows = allRows.filter((r) => r.id !== movedInvitationId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.email).toBe(`deleted-${studentId}@deleted.invalid`);
      expect(row.firstName).toBe('Deleted');
      expect(row.lastName).toBe('Student');
      expect(
        row.lastNotifiedEmail === null || row.lastNotifiedEmail === `deleted-${studentId}@deleted.invalid`,
      ).toBe(true);
    }
    // The teacher's own filing state is theirs, not the subject's: the
    // decline still stands as a tombstone and the acceptance still records
    // when it happened. Scrubbing those would rewrite the teacher's history,
    // and the CHECK constraint binding `respondedAt` to `status` would
    // reject a half-done job anyway.
    expect(rows.map((r) => r.status).sort()).toEqual(['accepted', 'declined']);
    expect(rows.some((r) => r.lastNotifiedEmail === `deleted-${studentId}@deleted.invalid`)).toBe(true);
    expect(rows.every((r) => r.respondedAt !== null)).toBe(true);

    // The `movedId` fixture: its CURRENT `email` had already moved off the
    // subject's address before erasure ran (the beforeAll `update` above,
    // simulating a teacher's `PUT /api/invitations/[id]` typo correction),
    // so it was never the subject's address AT ERASURE TIME — the first two
    // erasure statements in `gdpr.ts` match on that CURRENT `email` and so
    // leave this row's identity columns untouched, which the next two
    // assertions pin. Only `lastNotifiedEmail`, which still held the
    // subject's real address, is reached — by the third, marker-keyed
    // statement `gdpr.ts` adds for exactly this gap.
    const moved = allRows.find((r) => r.id === movedInvitationId);
    expect(moved?.email).toBe(movedAwayEmail);
    expect(moved?.firstName).toBe('Mo');
    expect(moved?.lastNotifiedEmail).toBe(`deleted-${studentId}@deleted.invalid`);

    // Deliberately untouched — see the comment at the erasure site and
    // `docs/data-model.md`. Retention vs. scrubbing is a legal call nobody
    // on this branch is placed to make, and this asserts the current
    // behaviour so a change to it is a decision rather than a drift.
    const block = await prisma.teacherBlock.findFirst({ where: { teacherId: blockerId } });
    expect(block?.email).toBe(email);
  });

  it('erasing a teacher deletes the contacts they typed about other people', async () => {
    expect(await prisma.invitation.count({ where: { teacherId: blockerId } })).toBe(2);

    await deleteTeacherAccount(prisma, blockerId);

    expect(await prisma.invitation.count({ where: { teacherId: blockerId } })).toBe(0);
    expect(
      await prisma.invitation.findUnique({ where: { id: strangerInvitationId } }),
    ).toBeNull();
    // The other teacher's contacts are none of this erasure's business.
    expect(await prisma.invitation.count({ where: { teacherId: inviterId } })).toBe(1);
  });
});

// #174. `deleteTeacherAccount` cancels through a compare-and-swap — the
// `tx.calendarEntry.updateMany` in its loop, guarded by `cancelledAt: null`
// AND a `status` still in `CANCELLABLE_STATUSES` — and this block pins what
// happens when that guard does NOT match the class it is handed: a warn and
// a skip of the whole per-class body, never a silent cancel and never a
// half-applied one (the waitlist close and the notifications below the CAS
// must not run either).
//
// Constructed directly, not raced. Since #367 the pre-lock runs before the
// read and the read is scoped to the ids that lock returned, so the timing
// window the earlier version of this test reproduced is gone. The test below
// manufactures the disagreement instead: `lockClassRowsOrdered` is mocked to
// hand back the id of a `completed` class, which its real predicate would
// never have matched. Which disagreements can still arise for real is argued
// at the CAS itself in `gdpr.ts`, and summarised at the mock below.
describe('deleteTeacherAccount cancels by compare-and-swap (#174)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-cas-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let registeredStudentId: string;
  let waitingStudentId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Cas',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'CAS erasure fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'CAS Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234CD',
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
    teacherRoomId = teacherRoom.id;

    // Two students on the class this test skips: one registered, one
    // waiting. A skip that is real (the class row untouched) has to be told
    // apart from a skip that is only half-applied (the row untouched but
    // the waitlist/notification side effects below the CAS still ran) —
    // round 1 review, Important 2.
    const registered = await prisma.student.create({
      data: { firstName: 'Cas', lastName: 'Registered', email: `${suffix}-registered@test.local`, incomeTier: 2 },
      select: { id: true },
    });
    registeredStudentId = registered.id;
    const waiting = await prisma.student.create({
      data: { firstName: 'Cas', lastName: 'Waiting', email: `${suffix}-waiting@test.local`, incomeTier: 2 },
      select: { id: true },
    });
    waitingStudentId = waiting.id;
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [registeredStudentId, waitingStudentId] } },
    });
    await prisma.waitlistEntry.deleteMany({
      where: { studentId: { in: [registeredStudentId, waitingStudentId] } },
    });
    await prisma.registration.deleteMany({
      where: { studentId: { in: [registeredStudentId, waitingStudentId] } },
    });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: [registeredStudentId, waitingStudentId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('warns and skips when a locked id turns out not to be cancellable', async () => {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'CAS class',
      date: new Date('2026-06-01'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
    });
    const classId = cls.id;

    await prisma.registration.create({
      data: { classId, studentId: registeredStudentId, status: 'registered', tierAtBooking: 2 },
    });
    await prisma.waitlistEntry.create({
      data: { classId, studentId: waitingStudentId, position: 1, status: 'waiting' },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    // lockClassRowsOrdered's real predicate never returns a completed
    // class's id -- this simulates a lock/CAS disagreement directly.
    // A concurrent COMPLETION can no longer produce one for real since
    // #367: `completeClass` takes the same `Class` row lock, so it queues
    // behind this transaction's hold. A concurrent CANCELLATION still can,
    // for the reason the CAS's own comment in `gdpr.ts` gives -- the
    // pre-lock's `cancelledAt` conjunct reads the joined, unlocked entry.
    // So the branch stays live; this is just the deterministic way in.
    const original = dbLocks.lockClassRowsOrdered;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        return source.entries === true ? [...ids, classId] : ids;
      });
    onTestFinished(() => spy.mockRestore());

    await deleteTeacherAccount(prisma, teacherId);

    const after = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      include: { calendarEntry: true },
    });
    expect(after.status).toBe('completed');
    expect(after.calendarEntry.cancelledAt).toBeNull();

    const waitlistEntry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: waitingStudentId } },
    });
    expect(waitlistEntry.status).toBe('waiting');
    const cancelledNotice = await prisma.notification.findFirst({
      where: {
        recipientType: 'student',
        recipientId: registeredStudentId,
        type: 'class_cancelled',
        relatedClassId: classId,
      },
    });
    expect(cancelledNotice).toBeNull();

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ classId, observedStatus: 'completed' }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ waitingEntriesLeft: 1 }),
      expect.anything(),
    );
  });
});

describe('deleteTeacherAccount locks and reads the same snapshot (#367)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-lockread-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'LockRead',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Lock-then-read fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'LockRead Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234LR',
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
    teacherRoomId = teacherRoom.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('cancels a class that becomes cancellable immediately before the class lock runs', async () => {
    // Fires exactly once, at the moment deleteTeacherAccount's Class+
    // CalendarEntry pre-lock is about to run (source.entries === true is
    // unique to that call — the two template locks above it in gdpr.ts are
    // separate inline $queryRaw statements, not calls to this function).
    // Creating the class HERE, immediately before letting the real lock
    // statement run, is the latest a class can appear and still be caught:
    // after everything the erasure has done so far (the two template locks),
    // and before the class pre-lock's own predicate evaluates. It therefore
    // lands in `lockedIds`, and so in the `id: { in: lockedIds }` read the
    // cancel loop walks.
    const original = dbLocks.lockClassRowsOrdered;
    let injectedClassId: string | undefined;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        if (source.entries === true) {
          const created = await createClassFixture(prisma, {
            teacherId,
            teacherRoomId,
            classType: 'Injected class',
            date: new Date('2099-01-01'),
            startTime: hhmmToTime('09:00'),
            durationMinutes: 60,
            roomCost: 20,
            minRate: 15,
            targetRate: 25,
            minStudents: 1,
            maxStudents: 10,
            status: 'open',
          });
          injectedClassId = created.id;
        }
        return original(tx, source);
      });
    onTestFinished(() => spy.mockRestore());

    await deleteTeacherAccount(prisma, teacherId);

    expect(injectedClassId).toBeDefined();
    const after = await prisma.class.findUniqueOrThrow({
      where: { id: injectedClassId! },
      include: { calendarEntry: true },
    });
    // Lock set and read set are one set, so a class that appears this late
    // is cancelled like any other. Give the cancel loop a separately-timed
    // `findMany` to walk instead of `lockedIds` — the shape #367 replaced —
    // and this class is locked by the pre-lock's own fresh predicate but
    // never visited by the loop, surviving uncancelled under a teacher whose
    // account no longer exists. That is what this assertion catches.
    expect(after.calendarEntry.cancelledAt).not.toBeNull();
  });
});

/**
 * Whole-branch review of #174, Important, closed further by #367.
 * Originally: `deleteTeacherAccount` read its classes — and, eager-loaded
 * alongside them, the registrations it would notify — before taking any
 * lock, then cancelled under the CAS's lock and built the notifications
 * from that pre-lock snapshot. A student who registered in between had
 * their class cancelled and was never told. #174's whole-branch review
 * fixed the notification half by re-reading recipients under the lock
 * (`class-transitions.ts`'s `autoCancelClasses` got the identical fix at
 * the same time, for the same reason its own comment states — "a
 * cancelled class nobody was told about is worse than one that stays
 * open one more sweep").
 *
 * #367 closes the registration half of the same gap structurally: the
 * class lock now runs before the read of the classes it cancels, so a
 * registration can no longer land between that read and the lock at all
 * — it blocks behind the held row (Postgres's automatic `FOR KEY SHARE`
 * on the referencing `INSERT`) until the erasure transaction ends. The
 * test below proves that directly.
 */
describe('deleteTeacherAccount blocks concurrent registrations on classes it locks (#367)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-notify-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let classId: string;
  let earlyStudentId: string;
  let lateStudentId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Notify',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Notification recency fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Notify Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234NO',
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

    const cls = await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Notify class',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'open',
      });
    classId = cls.id;

    const early = await prisma.student.create({
      data: { firstName: 'Early', lastName: 'Booker', email: `${suffix}-early@test.local`, incomeTier: 2 },
      select: { id: true },
    });
    earlyStudentId = early.id;
    const late = await prisma.student.create({
      data: { firstName: 'Late', lastName: 'Booker', email: `${suffix}-late@test.local`, incomeTier: 3 },
      select: { id: true },
    });
    lateStudentId = late.id;

    await prisma.registration.create({
      data: { classId, studentId: earlyStudentId, status: 'registered', tierAtBooking: 2 },
    });
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [earlyStudentId, lateStudentId, teacherId] } },
    });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: [earlyStudentId, lateStudentId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('blocks a concurrent registration on a class it is about to cancel, until it commits', async () => {
    let reachedLock!: () => void;
    const atLock = new Promise<void>((resolve) => {
      reachedLock = resolve;
    });
    let releaseLock!: () => void;
    const heldOpen = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const original = dbLocks.lockClassRowsOrdered;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        if (source.entries === true) {
          reachedLock();
          await heldOpen;
        }
        return ids;
      });
    onTestFinished(() => spy.mockRestore());

    const erasing = deleteTeacherAccount(prisma, teacherId).then(() => 'erased' as const);
    await atLock;

    let registrationLanded = false;
    const registering = prisma.registration
      .create({ data: { classId, studentId: lateStudentId, status: 'registered', tierAtBooking: 3 } })
      .then(() => {
        registrationLanded = true;
      });

    try {
      await new Promise((r) => setTimeout(r, 400));
      // Still blocked: the erasure holds the Class row's FOR UPDATE lock,
      // and the registration INSERT's automatic FOR KEY SHARE lock on that
      // same row conflicts with it. This is what makes the old #174 race --
      // registering in the gap between an unlocked read and the class lock
      // -- structurally impossible now, not merely unlikely.
      expect(registrationLanded).toBe(false);
    } finally {
      releaseLock();
    }

    await Promise.all([erasing, registering]);
    expect(registrationLanded).toBe(true);

    // The registration that finally landed, after the class was already
    // cancelled, is still there -- this design does not lose it, it just
    // cannot land DURING the erasure any more.
    const reg = await prisma.registration.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: lateStudentId } },
    });
    expect(reg.status).toBe('registered');
  }, 15_000);
});

/**
 * #196 branch 2, Task 3. `deleteStudentAccount` ended its transaction with an
 * unscoped `student.update`, so two concurrent erasures of one student both
 * committed — and each then ran its own post-commit `handleSpotFreed` loop,
 * broadcasting a second `spot_available` set to every student waiting on
 * every class the erasure freed a seat in.
 *
 * The class sits in the final-hour `first_come_first_claimed` window on
 * purpose: that is the only window where `handleSpotFreed` broadcasts rather
 * than auto-promoting, and a doubled auto-promotion is invisible (the second
 * call finds the head already `promoted` and returns `none`). The doubled
 * broadcast is the observable cost, so it is what this asserts on.
 */
describe('student erasure is retry-safe against a concurrent duplicate (#196)', () => {
  const prisma = new PrismaClient();

  /**
   * A student holding the only seat in an open class, with one other student
   * waiting on it, and `now` half an hour inside the broadcast window.
   *
   * `target` = now + 48h30m against a HOURS_48 deadline puts `deadline` at
   * now + 30m and `cutoff` at now − 30m, so `now` falls inside
   * `first_come_first_claimed`. Computed from the clock rather than
   * hard-coded, because the window is relative to it. The teacher is `UTC` so
   * `date` + `startTime` map to the instant this arithmetic assumes — the
   * suite itself runs under `TZ=America/New_York` (vitest.config.ts).
   *
   * Its own teacher, room, class and students, per the file's convention: the
   * shared `describe('GDPR (DB)')` fixtures get erased by other tests there.
   */
  async function makeStudentWithFreedSpot() {
    const suffix = `gdpr-race-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Race',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Concurrent-erasure fixture',
        pageSlug: suffix,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    const room = await prisma.room.create({
      data: {
        venueName: 'Race Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234RC',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacher.id,
      },
      select: { id: true },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const target = new Date(Date.now() + 48 * 60 * 60 * 1000 + 30 * 60 * 1000);
    const cls = await createClassFixture(prisma, {
        teacherId: teacher.id,
        teacherRoomId: teacherRoom.id,
        classType: 'Race class',
        date: new Date(`${target.toISOString().slice(0, 10)}T00:00:00Z`),
        startTime: hhmmToTime(target.toISOString().slice(11, 16)),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 1,
        cancelDeadline: 'HOURS_48',
        autoCancelCheck: 'HOURS_2',
        status: 'open',
      });
    const student = await prisma.student.create({
      data: {
        firstName: 'Race',
        lastName: 'Student',
        email: `${suffix}-student@test.local`,
        incomeTier: 2,
      },
      select: { id: true },
    });
    await prisma.registration.create({
      data: { classId: cls.id, studentId: student.id, status: 'registered', tierAtBooking: 2 },
    });
    const waiter = await prisma.student.create({
      data: {
        firstName: 'Race',
        lastName: 'Waiter',
        email: `${suffix}-waiter@test.local`,
        incomeTier: 2,
      },
      select: { id: true },
    });
    await prisma.waitlistEntry.create({
      data: { classId: cls.id, studentId: waiter.id, position: 1, status: 'waiting' },
    });

    return {
      studentId: student.id,
      waiterId: waiter.id,
      classId: cls.id,
      teacherId: teacher.id,
      roomId: room.id,
      accountId: teacher.accountId,
    };
  }

  /** Reaps a fixture whether or not the erasures under test got that far. */
  async function cleanup(fixture: Awaited<ReturnType<typeof makeStudentWithFreedSpot>>) {
    await prisma.notification.deleteMany({
      where: { recipientId: { in: [fixture.studentId, fixture.waiterId, fixture.teacherId] } },
    });
    await prisma.registration.deleteMany({ where: { classId: fixture.classId } });
    await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: fixture.classId } } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: fixture.teacherId } });
    await prisma.room.deleteMany({ where: { id: fixture.roomId } });
    await prisma.student.deleteMany({ where: { id: { in: [fixture.studentId, fixture.waiterId] } } });
    await prisma.teacher.deleteMany({ where: { id: fixture.teacherId } });
    await prisma.account.deleteMany({ where: { id: fixture.accountId } });
  }

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('erases once when the same student erasure runs twice concurrently', async () => {
    const fixture = await makeStudentWithFreedSpot();
    // A second client, so the lock below is held by a transaction neither
    // erasure can be scheduled inside.
    const holder = new PrismaClient();
    try {
      // A bare `Promise.allSettled` of the two calls is not a race: they can
      // serialise, and a serialised second call reads its `upcoming` AFTER the
      // first cancelled those registrations, so it comes back empty — the
      // erasure then commits nothing to broadcast about, `handleSpotFreed`
      // never runs, and the notification assertion below passes EVEN WITH THE
      // ABORT REMOVED. The whole test would be green against the bug it names.
      //
      // The lever (the pattern in `registrations-api.test.ts`'s cancel race):
      // a third transaction takes the `Student` row `FOR UPDATE` before either
      // call starts. Both erasures then read the same non-empty `upcoming`
      // (uncommitted state is invisible under READ COMMITTED) and both park at
      // a write — one on this lock at the closing CAS, the other behind it on
      // the shared `Registration` row.
      let release!: () => void;
      let locked!: () => void;
      const released = new Promise<void>((r) => { release = r; });
      // The handshake: `$transaction` returns before its callback has run, and
      // a fresh client has to connect and start its engine first, so without
      // this the erasures can be finished before the lock is ever taken.
      const parked = new Promise<void>((r) => { locked = r; });
      const holding = holder.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Student" WHERE id = ${fixture.studentId} FOR UPDATE`;
        locked();
        await released;
      }, { timeout: 20_000 });
      await parked;

      const running = Promise.allSettled([
        deleteStudentAccount(prisma, fixture.studentId),
        deleteStudentAccount(prisma, fixture.studentId),
      ]);

      // 700ms: `deleteStudentAccount` opens with `setLockTimeout`, so a
      // statement parked past 2s is cancelled with `55P03` and the loser
      // rejects with a Postgres error instead of the sentinel. The loser waits
      // this hold plus the winner's remaining statements, so the margin is
      // smaller than the 2s suggests.
      let settled = false;
      void running.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 700));

      // The lever is asserted, not assumed. If both calls finished inside this
      // window they serialised, and everything below is measuring the
      // scheduler rather than the guard.
      expect(settled).toBe(false);
      release();
      await holding;
      const results = await running;

      // Asserted before the outcomes, deliberately: the doubled broadcast is
      // the defect — every waiting student told twice about one freed seat —
      // and this is the assertion whose failure message names it. With the
      // rejection count first, dropping the abort fails on "expected 1,
      // received 0", which says nothing about what it cost anyone.
      const notifications = await prisma.notification.findMany({
        where: {
          relatedClassId: fixture.classId,
          recipientId: fixture.waiterId,
          type: 'spot_available',
        },
      });
      expect(notifications).toHaveLength(1);

      // One erases; the other finds the row already erased and aborts whole.
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyErasedError);

      const student = await prisma.student.findUniqueOrThrow({ where: { id: fixture.studentId } });
      expect(student.deletedAt).not.toBeNull();
    } finally {
      await holder.$disconnect();
      await cleanup(fixture);
    }
  }, 30_000);
});

/**
 * The teacher half of the same guard (#196 branch 2, Task 3), which had no
 * test at all — `deleteStudentAccount`'s abort was pinned by the race above
 * and `deleteTeacherAccount`'s identical `AlreadyErasedError` by nothing.
 *
 * Sequential, and that is not a weaker version of the race above: the two
 * aborts protect different things. The student one exists to stop a
 * post-commit `handleSpotFreed` loop running twice, which only a concurrent
 * duplicate can cause. This one guards the write itself — an unscoped
 * `teacher.update` re-runs the whole anonymisation over an already-erased
 * profile and re-stamps `deletedAt`, moving the erasure's own timestamp
 * forward. That is a GDPR record of when the Article 17 request was
 * satisfied, and it does not need a race to be wrong.
 *
 * `DELETE /api/account` cannot reach this sequentially (`validateSession`
 * resolves only live profiles, so a retry arrives with `teacherId` null) —
 * which is exactly why the service is where it has to be tested.
 */
describe('teacher erasure refuses to erase an already-erased profile (#196)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-twice-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Twice',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Second-erasure fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;
  });

  afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('throws AlreadyErasedError and leaves the first erasure untouched', async () => {
    await deleteTeacherAccount(prisma, teacherId);
    const first = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });

    const err = await deleteTeacherAccount(prisma, teacherId).catch((e: unknown) => e);

    // The erasure timestamp is what a second, unguarded pass would rewrite,
    // so it is asserted before the error's type: dropping the guard fails on
    // "the record of when this account was erased moved", not on "something
    // did not throw".
    const after = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(after.deletedAt).toEqual(first.deletedAt);

    expect(err).toBeInstanceOf(AlreadyErasedError);
    // The half, not just the class: `api/account/route.ts` logs it, and a
    // teacher-half abort mislabelled `student` would send an operator reading
    // that line to the wrong transaction.
    expect((err as AlreadyErasedError).half).toBe('teacher');
  }, 20_000);
});

/**
 * Task 3c (#315), Step 6. `deleteTeacherAccount`'s bulk archive writes
 * `ScheduleRule` — `isActive`/`isArchived` moved off `ClassTemplate` in issue
 * 298 — and, before this fixed it, took no lock on `ClassTemplate` at all
 * first. `ACTIVE_TEMPLATE_WHERE` (`lib/template-selection.ts`), which the
 * hourly sweep's own candidate `findMany` selects with, carries no
 * `teacher.deletedAt` filter, so a sweep already mid-claim for this teacher's
 * template when an erasure opens is a real interleaving, not a theoretical
 * one — measured by this test, which holds the claim's own `FOR UPDATE OF ct`
 * and proves the erasure queues behind it exactly like the shared archive's
 * child row lock does (`archiveOrUnarchiveRule`, `rule-lifecycle.ts`). Not its
 * CAS: that writes `ScheduleRule`, which no sweep touches.
 */
describe('deleteTeacherAccount serialises against a claim in progress (#315)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-claim-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let templateId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Claim',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Erasure-vs-claim fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Claim Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234CD',
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
    teacherRoomId = teacherRoom.id;

    const template = await prisma.classTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'regular',
            classType: 'Claim vs Erasure',
            dayOfWeek: 2,
            startTime: hhmmToTime('07:00'),
            durationMinutes: 60,
          },
        },
        teacherRoom: { connect: { id: teacherRoomId } },
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
      select: { id: true },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
    await prisma.classTemplate.deleteMany({ where: { id: templateId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('waits for a concurrent claim to release the child row before archiving the teacher templates', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const claiming = prisma.$transaction(
      async (tx) => {
        expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull();
        await held;
      },
      { timeout: 15_000 },
    );

    // Let the claim acquire the lock before the erasure contends for it.
    await new Promise((r) => setTimeout(r, 100));

    let erasureSettled = false;
    const erasing = deleteTeacherAccount(prisma, teacherId).then(() => {
      erasureSettled = true;
    });

    await new Promise((r) => setTimeout(r, 300));
    // Without the ordered child-row pre-lock this fixed, the erasure's
    // `ScheduleRule` write is unobstructed and this is true.
    expect(erasureSettled).toBe(false);

    release();
    await claiming;
    await erasing;

    const rule = await prisma.scheduleRule.findUniqueOrThrow({
      where: { id: (await prisma.classTemplate.findUniqueOrThrow({ where: { id: templateId } })).scheduleRuleId },
    });
    expect(rule.isArchived).toBe(true);
    expect(rule.isActive).toBe(false);
  }, 20_000);
});

/**
 * The studio twin of the suite above. `deleteTeacherAccount`'s bulk archive
 * takes an ordered pre-lock on `StudioClassTemplate` (`FOR UPDATE OF sct`)
 * separately from the `ClassTemplate` one (`FOR UPDATE OF ct`) proved there —
 * two statements, two tables, and the review round that added this test found
 * that the suite above's own mutation (removing both together) had proved
 * only the pair, not either lock individually. `claimStudioTemplateForGeneration`
 * (`studio-class-generator.ts`) takes its row lock on `StudioClassTemplate`,
 * not on `ClassTemplate`, so this is not redundant with the class-family case
 * above — it is what makes the `sct` lock's necessity a measurement rather
 * than an inference from the `ct` one.
 */
describe('deleteTeacherAccount serialises against a studio claim in progress (#315)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-studio-claim-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let templateId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Studio Claim',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Erasure-vs-studio-claim fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const template = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Studio Claim vs Erasure',
            dayOfWeek: 3,
            startTime: hhmmToTime('08:00'),
            durationMinutes: 60,
          },
        },
        location: 'Studio Claim Test',
        hourlyRate: 40,
      },
      select: { id: true },
    });
    templateId = template.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({
      where: { scheduleRule: { classTemplates: { some: { id: templateId } } } },
    });
    await prisma.studioClassTemplate.deleteMany({ where: { id: templateId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('waits for a concurrent studio claim to release the child row before archiving the teacher templates', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });

    const claiming = prisma.$transaction(
      async (tx) => {
        expect(await claimStudioTemplateForGeneration(tx, templateId)).not.toBeNull();
        await held;
      },
      { timeout: 15_000 },
    );

    // Let the claim acquire the lock before the erasure contends for it.
    await new Promise((r) => setTimeout(r, 100));

    let erasureSettled = false;
    const erasing = deleteTeacherAccount(prisma, teacherId).then(() => {
      erasureSettled = true;
    });

    await new Promise((r) => setTimeout(r, 300));
    // Without the ordered child-row pre-lock this fixed, the erasure's
    // `ScheduleRule` write is unobstructed and this is true.
    expect(erasureSettled).toBe(false);

    release();
    await claiming;
    await erasing;

    const rule = await prisma.scheduleRule.findUniqueOrThrow({
      where: {
        id: (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } })).scheduleRuleId,
      },
    });
    expect(rule.isArchived).toBe(true);
    expect(rule.isActive).toBe(false);
  }, 20_000);
});

/**
 * #280: deleteTeacherAccount cancels future studio classes on teacher erasure,
 * while sparing past and today's studio classes as income records.
 */
describe('deleteTeacherAccount cancels future studio classes (#280)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-studio-cancel-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let templateId: string;
  let pastClassId: string;
  let todayClassId: string;
  let futureClassId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Studio Cancel',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Erasure studio cancel fixture',
        pageSlug: suffix,
        defaultTimezone: 'America/New_York',
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const template = await prisma.studioClassTemplate.create({
      data: {
        scheduleRule: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Studio Cancel vs Erasure',
            dayOfWeek: 3,
            startTime: hhmmToTime('08:00'),
            durationMinutes: 60,
          },
        },
        location: 'Studio Cancel Test',
        hourlyRate: 50,
      },
      select: { id: true },
    });
    templateId = template.id;

    const localToday = startOfLocalDay(new Date(), 'America/New_York');
    const localPast = new Date(localToday);
    localPast.setUTCDate(localPast.getUTCDate() - 7);
    const localFuture = new Date(localToday);
    localFuture.setUTCDate(localFuture.getUTCDate() + 7);

    const pastClass = await prisma.studioClass.create({
      data: {
        location: 'Studio Cancel Test',
        hourlyRate: 50,
        calendarEntry: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Studio Cancel vs Erasure',
            date: localPast,
            startTime: hhmmToTime('08:00'),
            durationMinutes: 60,
          },
        },
      },
      select: { id: true, calendarEntryId: true },
    });
    pastClassId = pastClass.calendarEntryId;

    const todayClass = await prisma.studioClass.create({
      data: {
        location: 'Studio Cancel Test',
        hourlyRate: 50,
        calendarEntry: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Studio Cancel vs Erasure',
            date: localToday,
            startTime: hhmmToTime('08:00'),
            durationMinutes: 60,
          },
        },
      },
      select: { id: true, calendarEntryId: true },
    });
    todayClassId = todayClass.calendarEntryId;

    const futureClass = await prisma.studioClass.create({
      data: {
        location: 'Studio Cancel Test',
        hourlyRate: 50,
        calendarEntry: {
          create: {
            teacherId,
            kind: 'studio',
            classType: 'Studio Cancel vs Erasure',
            date: localFuture,
            startTime: hhmmToTime('08:00'),
            durationMinutes: 60,
          },
        },
      },
      select: { id: true, calendarEntryId: true },
    });
    futureClassId = futureClass.calendarEntryId;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({
      where: { teacherId },
    });
    await prisma.studioClassTemplate.deleteMany({ where: { id: templateId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('cancels future studio classes while sparing past and today studio classes', async () => {
    await deleteTeacherAccount(prisma, teacherId);

    // Future studio class must be cancelled
    const futureEntry = await prisma.calendarEntry.findUniqueOrThrow({
      where: { id: futureClassId },
    });
    expect(futureEntry.cancelledAt).not.toBeNull();

    // Past studio class must NOT be cancelled (income record)
    const pastEntry = await prisma.calendarEntry.findUniqueOrThrow({
      where: { id: pastClassId },
    });
    expect(pastEntry.cancelledAt).toBeNull();

    // Today's studio class must NOT be cancelled (income record)
    const todayEntry = await prisma.calendarEntry.findUniqueOrThrow({
      where: { id: todayClassId },
    });
    expect(todayEntry.cancelledAt).toBeNull();

    // Template's schedule rule must be archived
    const rule = await prisma.scheduleRule.findUniqueOrThrow({
      where: {
        id: (await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } })).scheduleRuleId,
      },
    });
    expect(rule.isArchived).toBe(true);
    expect(rule.isActive).toBe(false);
  });
});
