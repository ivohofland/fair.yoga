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
import { lockClassRow, LOCK_TIMEOUT_SQL } from '@/lib/db-locks';
import { log } from '@/lib/log';

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
  const cls = await prisma.class.create({
    data: {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      classType: 'Lock class',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open',
    },
    select: { id: true },
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
  await prisma.class.deleteMany({ where: { id: fixture.classId } });
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
      prisma.class.create({
        data: {
          teacherId,
          teacherRoomId,
          classType: `GDPR ${status}`,
          date: new Date(date),
          startTime: '09:00',
          durationMinutes: 60,
          roomCost: 20,
          minRate: 15,
          targetRate: 25,
          minStudents: 1,
          maxStudents: 10,
          status,
        },
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
    await prisma.class.deleteMany({ where: { id: { in: [completedClassId, openClassId] } } });
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

    const openClass = await prisma.class.findUniqueOrThrow({ where: { id: openClassId } });
    expect(openClass.status).toBe('cancelled');

    // Registered student was told
    const note = await prisma.notification.findFirst({
      where: { recipientType: 'student', recipientId: other.id, type: 'class_cancelled' },
    });
    expect(note).not.toBeNull();

    // Completed class (the students' payment history) survives
    const completed = await prisma.class.findUniqueOrThrow({ where: { id: completedClassId } });
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
  let studentId: string;
  let studentAccountId: string;
  let strangerInvitationId: string;

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
      },
    });
    await prisma.invitation.create({
      data: {
        teacherId: blockerId, email, firstName: 'Sammy', lastName: 'Typo',
        status: 'declined', respondedAt: new Date('2026-03-04T05:06:07.000Z'),
      },
    });
    await prisma.teacherBlock.create({ data: { teacherId: blockerId, email } });

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
    await prisma.teacher.deleteMany({ where: { id: { in: [inviterId, blockerId] } } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.account.deleteMany({
      where: { id: { in: [inviterAccountId, blockerAccountId, studentAccountId] } },
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

    const rows = await prisma.invitation.findMany({
      where: { teacherId: { in: [inviterId, blockerId] }, firstName: { not: 'A' } },
      orderBy: { teacherId: 'asc' },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.email).toBe(`deleted-${studentId}@deleted.invalid`);
      expect(row.firstName).toBe('Deleted');
      expect(row.lastName).toBe('Student');
    }
    // The teacher's own filing state is theirs, not the subject's: the
    // decline still stands as a tombstone and the acceptance still records
    // when it happened. Scrubbing those would rewrite the teacher's history,
    // and the CHECK constraint binding `respondedAt` to `status` would
    // reject a half-done job anyway.
    expect(rows.map((r) => r.status).sort()).toEqual(['accepted', 'declined']);
    expect(rows.every((r) => r.respondedAt !== null)).toBe(true);

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

// #174 task 3. `deleteTeacherAccount`'s transaction reads classes filtered to
// `draft`/`open`/`in_progress` and then wrote `cancelled` unconditionally —
// so a class that reached `completed` in the window between that read and
// its own write got force-cancelled after its `Payment` rows already existed
// and its students had already been told to pay.
//
// A test that merely completes the class BEFORE calling `deleteTeacherAccount`
// proves nothing: the erasure's own `const upcoming = await tx.class.findMany`
// filters to `draft`/`open`/`in_progress`, so an already-`completed` class is never
// selected into `upcoming` and the loop never touches it — the assertion
// passes on the unfixed code for a reason that has nothing to do with the
// CAS. To pin the actual bug, the interleaving has to be reproduced: the
// class must still read as `in_progress` when the transaction's `findMany`
// runs, and only become `completed` afterward, before the loop's write for
// that specific row.
//
// `$extends` makes that deterministic instead of racing for it, following
// the precedent in `class-lifecycle.test.ts`'s
// "refuses to write over a status that changed after the caller decided"
// test; `class-template-lifecycle.test.ts`'s "maps a delete landing between
// the read and the write to not_found" and "...between the write and the
// sync to not_found"; `waitlist.test.ts`'s "a failure AFTER the link write
// rolls the link back too"; and `invitations.revive.test.ts`'s "answers
// CONTACT_CHANGED and leaves the fresh tombstone standing".
// `deleteTeacherAccount` calls
// `class.findMany` twice — once before the transaction (to find classes to
// `completeClass` directly) and once inside it (to find classes to cancel) —
// so the hook has to tell those two calls apart. It does that by args
// shape, not by call order (round 1 review, Important 1: keying on call
// order went silently vacuous when an unrelated extra `class.findMany`
// landed before the transaction's own read — the concurrent completion
// fired on the wrong call, the real read then saw an already-`completed`
// row and excluded it via its own `WHERE`, and the buggy unconditional
// update never got a row to clobber): the pre-transaction sweep filters
// `status: 'in_progress'` — a bare value — so it is filtered to exclude this
// fixture's class (standing in for a completion sweep that has not reached
// this row yet, so the class is still genuinely `in_progress` for the
// transaction's own read); the transaction's read is the one filtering
// `status: { in: [...] }`, and its real, unmodified rows are what the erasure
// transaction acts on. (This paragraph used to say the transaction's read
// "includes `registrations`" and was the discriminator; the whole-branch
// review of #174 deleted that eager-load — building the cancellation notices
// from a pre-lock snapshot was itself a defect — and re-keyed the hook onto
// `status`. The inline comment at the hook was updated in the same change and
// this one was not, which is the exact species of drift Task 9 exists to
// remove.) The side effect — a real,
// separately committed `updateMany` moving the row to `completed` — runs
// inside that same hook, after the real read resolves and before control
// returns to `deleteTeacherAccount`, so it is guaranteed to land before the
// loop's per-row write for this class — exactly the ordering the comment
// above that loop's `class.updateMany` CAS in `gdpr.ts` describes
// ("`completed` between it and here").
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
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: [registeredStudentId, waitingStudentId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('leaves a class that completed after the erasure read alone, and still erases', async () => {
    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        classType: 'CAS class',
        date: new Date('2026-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'in_progress',
      },
      select: { id: true },
    });
    const classId = cls.id;

    await prisma.registration.create({
      data: { classId, studentId: registeredStudentId, status: 'registered', tierAtBooking: 2 },
    });
    await prisma.waitlistEntry.create({
      data: { classId, studentId: waitingStudentId, position: 1, status: 'waiting' },
    });

    // Spied, not silenced-and-forgotten: the assertions at the tail of this
    // test are what turn the CAS skip from an unobservable `continue` into a
    // recorded one.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    // Registered before anything can throw, so a failing assertion below
    // still hands `log.warn` back to the describes that run after this one.
    onTestFinished(() => warn.mockRestore());

    let calls = 0;
    let completedConcurrently = false;
    const racing = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            calls += 1;
            const rows = await query(args);
            // Discriminated on the args shape, not on which call happens to
            // come first (round 1 review, Important 1: keying on call order
            // went silently vacuous when an unrelated extra `class.findMany`
            // landed before the transaction's own read — the concurrent
            // completion fired on the wrong call, the real read then saw an
            // already-`completed` row and excluded it via its own `WHERE`,
            // and the buggy unconditional update never got a row to
            // clobber). The pre-transaction sweep (`gdpr.ts`, before the
            // transaction opens) filters `status: 'in_progress'` — a bare
            // value; the transaction's read of "upcoming" classes filters
            // `status: { in: [...] }`, and that `in` object is the only
            // difference this hook keys on. It is not the ONLY structural
            // difference — the transaction's read also carries an `orderBy`
            // and selects `classType`, either of which could have served —
            // but it is the one chosen, because the `orderBy` is a lock-order
            // fix that a later change could legitimately move and the
            // `select` is presentation. (It used to be keyed on
            // the transaction read's `include: { registrations }`; the
            // whole-branch review of #174 deleted that eager-load, because
            // building the cancellation notices from a pre-lock snapshot was
            // itself the defect — the recipients are re-read under the CAS's
            // lock now. Keying on `status` survives that change and does not
            // depend on what either read selects.) An extra `class.findMany`
            // inserted anywhere else now reliably falls into the "not the
            // transaction's read" branch below instead of stealing this
            // hook's one shot at the side effect.
            const status = (args.where as { status?: unknown } | undefined)?.status;
            const isTransactionRead =
              typeof status === 'object' && status !== null && 'in' in status;
            if (!isTransactionRead) {
              // Standing in for a completion sweep that has not reached
              // this row yet — filtered so the class stays genuinely
              // `in_progress` for the transaction's own read.
              return rows.filter((r) => r.id !== classId);
            }
            // The erasure transaction's read of "upcoming" classes. The
            // real, unmodified rows are what it acts on — this class is
            // genuinely `in_progress` at this instant. The concurrent
            // completion is a real, separately committed write, made now
            // so it lands before the loop's write for this row runs.
            if (!completedConcurrently && rows.some((r) => r.id === classId)) {
              completedConcurrently = true;
              await prisma.class.updateMany({
                where: { id: classId },
                data: { status: 'completed' },
              });
            }
            return rows;
          },
        },
      },
      // `$extends` returns a client missing `$on`, so it is not assignable
      // to `deleteTeacherAccount`'s `PrismaClient`-typed `db` parameter even
      // though every method it calls here is the real one, running against
      // the real database — same cast as the precedent cited above.
    }) as unknown as PrismaClient;

    await deleteTeacherAccount(racing, teacherId);

    // Exactly the two `class.findMany` calls `deleteTeacherAccount` is known
    // to make today — no more, no fewer. A future structural change that
    // adds, removes, or reorders one now fails loudly here instead of the
    // shape-based routing above silently absorbing it and the test passing
    // for the wrong reason (round 1 review, Important 1).
    expect(calls).toBe(2);

    // Order matters for what a regression reports: checking the row first
    // means the unconditional-update bug shows as the actual overwrite
    // ("expected 'completed' to be 'cancelled'"), not just a wrong boolean.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('completed');

    // The skip has to be real, not just "the class row happens to look
    // right": a half-applied skip — the CAS predicate refuses the class
    // write but the waitlist/notification statements below it still run
    // unconditionally — would flip this waiting entry to `removed` and tell
    // the registered student their class was cancelled, while
    // `completeClass` had already told them to pay for it (round 1 review,
    // Important 2).
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

    // And the erasure itself still completed — the point is to skip the
    // class, not to abandon the request.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);

    // #174 four-specialist review, Critical 4. Everything asserted above is
    // an ABSENCE — the class unchanged, the entry unchanged, the notice not
    // sent — which is exactly what a skip that never happened at all looks
    // like too. The skip used to emit nothing and the function returns
    // `void`, so from outside there was no way to tell "erased 12 classes"
    // from "erased 12 classes and silently skipped one". This asserts the
    // positive record, and that it names WHICH of the four causes fired:
    // `completed` here, not `cancelled`, not a deleted row.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ classId, observedStatus: 'completed' }),
      expect.stringContaining('cancel CAS matched nothing'),
    );

    // The residual the skip leaves behind — a `waiting` entry on a completed
    // class of an erased teacher — is reported rather than left invisible.
    // The `waiting` assertion above pins that the entry survives; this pins
    // that an operator can find out.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ waitingEntriesLeft: 1 }),
      expect.anything(),
    );
  });
});

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
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };
    // HIGH inserted FIRST. An unordered `SELECT` over a table this small is a
    // sequential scan, which returns rows in physical order — insertion order
    // for rows this fresh — so the unordered read hands back [HIGH, LOW]
    // while both sorting sites hand back [LOW, HIGH]. The test asserts that
    // premise below rather than assuming it, so a planner or storage change
    // that invalidates it fails loudly instead of leaving this test green for
    // no reason.
    await prisma.class.create({ data: { ...base, id: HIGH_CLASS_ID, date: new Date('2099-06-01') } });
    await prisma.class.create({ data: { ...base, id: LOW_CLASS_ID, date: new Date('2099-06-02') } });

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
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: [accountId, studentAccountId] } } });
    await prisma.$disconnect();
  });

  it('does not deadlock when a teacher erasure and a student erasure overlap on two classes', async () => {
    // The premise, asserted rather than assumed: with no `orderBy`, this
    // read's natural order is the REVERSE of both sorting sites' order. If
    // this ever stops holding, the test below can no longer provoke the cycle
    // and would pass on broken code — so it fails here instead.
    const heapOrder = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "Class"
      WHERE "teacherId" = ${teacherId}
        AND status IN ('draft', 'open', 'in_progress')
    `;
    expect(heapOrder.map((r) => r.id)).toEqual([HIGH_CLASS_ID, LOW_CLASS_ID]);

    // The same premise on the OTHER side of the pairing, which the assertion
    // above does not cover. `deleteTeacherAccount` pre-locks via a `Class`
    // scan; `deleteStudentAccount` pre-locks via a `WaitlistEntry` join. The
    // classes are seeded HIGH-first and the entries LOW-first in `beforeAll`,
    // so the scan's natural order is [HIGH, LOW] and the join's (driven by
    // `WaitlistEntry`) is the REVERSE — the disagreement this test turns on.
    //
    // The join's order is asserted under the SAME forced plan the student side
    // gets below. Left to the planner this join is not reliably driven by
    // `WaitlistEntry`: the choice is a cost knife-edge on `w."studentId"`,
    // which no index leads with, and it is non-monotonic in table size. CI
    // proved it — this assertion is what failed on 2026-08-16 with [HIGH, LOW],
    // because `enable_hashjoin = off` alone removes a join ALGORITHM, not a
    // join DIRECTION. All three settings are needed; the reasoning and the
    // measurements live in `db-locks-lock-order.test.ts`'s
    // `forceWaitlistDrivenPlan`, which this mirrors deliberately rather than
    // importing — a test helper crossing suites would couple two files whose
    // fixtures are independent.
    //
    // Asserting the `Class` side proves nothing about the join's: different
    // tables, different physical layouts.
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
    //   the teacher's scan asks [HIGH, LOW], the student's join [LOW, HIGH],
    //   so the two park on DIFFERENT rows — the teacher on HIGH, the student
    //   on LOW. Release LOW first: the student takes it and re-queues on HIGH,
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
          // house rule (`template-sync.test.ts:308`). `teacherId` is the one
          // bind `deleteTeacherAccount`'s ordered pre-lock carries since
          // #237; its other `$queryRaw` calls bind class ids.
          if (args.values[0] === teacherId) {
            preLockReached();
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
    const statuses = await prisma.class.findMany({
      where: { teacherId },
      select: { status: true },
    });
    expect(statuses.map((c) => c.status)).toEqual(['cancelled', 'cancelled']);
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

/**
 * Whole-branch review of #174, Important. `deleteTeacherAccount` read its
 * classes — and, eager-loaded alongside them, the registrations it would
 * notify — before taking any lock, then cancelled under the CAS's lock and
 * built the notifications from that pre-lock snapshot. A student who
 * registered in between had their class cancelled and was never told.
 *
 * The identical defect was fixed at the sibling site by #174 task 6:
 * `autoCancelClasses` (`class-transitions.ts`) re-reads its recipients inside
 * the transaction, under the same reasoning its own comment states — "a
 * cancelled class nobody was told about is worse than one that stays open one
 * more sweep."
 */
describe('deleteTeacherAccount notifies whoever is registered when it cancels (#174)', () => {
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

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Notify class',
        date: new Date('2099-06-01'),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 10,
        status: 'open',
      },
      select: { id: true },
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
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.student.deleteMany({ where: { id: { in: [earlyStudentId, lateStudentId] } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('tells a student who registered after the class read but before the cancel', async () => {
    let hookCalls = 0;
    const racing = prisma.$extends({
      query: {
        class: {
          async findMany({ args, query }) {
            // Shape-keyed, per the house rule. `deleteTeacherAccount` makes
            // two `class.findMany` calls: the pre-transaction completion
            // sweep filters `status: 'in_progress'` (a bare value), and the
            // transaction's own read filters `status: { in: [...] }`. The
            // `in` object is what tells them apart.
            const status = (args.where as { status?: unknown } | undefined)?.status;
            const isTransactionRead =
              typeof status === 'object' && status !== null && 'in' in status;
            if (!isTransactionRead) return query(args);

            hookCalls += 1;
            const rows = await query(args);
            // Strictly between the read and the CAS. Routed through
            // `lockClassRow` — the same Class row lock every production
            // registration writer takes — rather than a bare `create`, so
            // this is the real shape of the writer being raced. It cannot
            // block here: the erasure has not reached its own CAS yet, so
            // nothing holds this row.
            await prisma.$transaction(async (tx) => {
              await lockClassRow(tx, classId);
              await tx.registration.create({
                data: { classId, studentId: lateStudentId, status: 'registered', tierAtBooking: 3 },
              });
            });
            return rows;
          },
        },
      },
    }) as unknown as PrismaClient;

    await deleteTeacherAccount(racing, teacherId);

    expect(hookCalls).toBe(1);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('cancelled');

    // The student who was already there is told — this half passes either
    // way, and is here so a regression reads as "the late one was missed"
    // rather than "notifications broke".
    expect(
      await prisma.notification.count({
        where: { recipientType: 'student', recipientId: earlyStudentId, type: 'class_cancelled', relatedClassId: classId },
      }),
    ).toBe(1);

    // The student who arrived inside the window. Pre-fix this is 0: their
    // registration exists, their class is cancelled, and nothing ever told
    // them.
    expect(
      await prisma.notification.count({
        where: { recipientType: 'student', recipientId: lateStudentId, type: 'class_cancelled', relatedClassId: classId },
      }),
    ).toBe(1);
  }, 20_000);
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
    const cls = await prisma.class.create({
      data: {
        teacherId: teacher.id,
        teacherRoomId: teacherRoom.id,
        classType: 'Race class',
        date: new Date(`${target.toISOString().slice(0, 10)}T00:00:00Z`),
        startTime: target.toISOString().slice(11, 16),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 1,
        cancelDeadline: 'HOURS_48',
        autoCancelCheck: 'HOURS_2',
        status: 'open',
      },
      select: { id: true },
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
    await prisma.class.deleteMany({ where: { id: fixture.classId } });
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
