import { describe, it, expect, beforeAll, beforeEach, afterAll, onTestFinished, vi } from 'vitest';
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
 * This file's one caller below always takes the defaults (`waiting: true,
 * entryStatus: 'waiting'`) and passes only `registered: false`; the
 * `waiting: false` shape and the other `entryStatus` values are exercised by
 * this same helper's copy in `gdpr-lock-order.test.ts` (#459).
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

  beforeEach(async () => {
    // The first test in this block already runs `deleteTeacherAccount` to
    // completion on this same shared `teacherId` (`beforeAll`), which sets
    // `deletedAt`. A second erasure of an already-erased teacher is refused
    // by design (`AlreadyErasedError`, see this function's tail) — a
    // different, unrelated outcome from the one a later test in this block
    // exercises — so this restores the row to live before erasing it again.
    // Restoring `email` off its `@deleted.invalid` value is load-bearing
    // too, and for a different reason: the `teacherEmailWhenDiagnosticRan`
    // assertion in the CAS-skip test below only proves the read ran
    // post-commit because it starts from a non-`@deleted.invalid` address —
    // left at the first test's stale `deleted-<id>@deleted.invalid`, that
    // assertion would match trivially even if the diagnostic read ran
    // pre-commit, inside the transaction. Harmless before the first test
    // too: the teacher already starts live from `beforeAll`, so this resets
    // it to the same live state.
    await prisma.teacher.update({
      where: { id: teacherId },
      data: {
        email: `${suffix}@test.local`,
        firstName: 'Cas',
        lastName: 'Teacher',
        bio: 'CAS erasure fixture',
        pageSlug: suffix,
        deletedAt: null,
      },
    });
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

    // The COMPLETED shape of the disagreement, and only that shape: the
    // fixture is `completed`, so it is the CAS's status conjunct that
    // fails while its `cancelledAt: null` one still holds.
    //
    // Staged, not raced, and it could not be raced -- since #367 a
    // concurrent completion cannot produce this for real either, because
    // `completeClass` takes the same `Class` row lock and so queues behind
    // this transaction's hold. Mocking `lockClassRowsOrdered` to hand back
    // an id its real predicate would never match is the only way in.
    //
    // The CANCELLED shape -- a cancellable status with `cancelledAt`
    // already set -- fails the OTHER conjunct, is still reachable for real,
    // and has its own test in the describe below.
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
      expect.objectContaining({
        classId,
        observedStatus: 'completed',
        // Live and never cancelled — the `?? null` fallback for a
        // genuinely-uncancelled entry, untested until now (#407 item 3).
        observedCancelledAt: null,
        waitingEntriesLeft: 1,
      }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
  });

  it('reports row-deleted when the class row is gone by the time the diagnostic reads it', async () => {
    // Completed and ineligible, exactly like the sibling test above — the
    // only difference this test adds is deleting the row for real between
    // commit and the diagnostic read, so `observed` comes back `null`
    // rather than throwing. `row-deleted` is the `?? 'row-deleted'`
    // fallback's own branch, reachable since #242 moved this read after the
    // transaction's locks release (#407 item 1).
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'row-deleted class',
      date: new Date('2026-06-03'),
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
    const calendarEntryId = cls.calendarEntry.id;

    await prisma.waitlistEntry.create({
      data: { classId, studentId: waitingStudentId, position: 1, status: 'waiting' },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    const original = dbLocks.lockClassRowsOrdered;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await original(tx, source);
        return source.entries === true ? [...ids, classId] : ids;
      });
    onTestFinished(() => spy.mockRestore());

    // Deletes the row for real, inside the diagnostic's own `findUnique`
    // call, then lets the real query run — it returns a genuine `null`,
    // not a mocked one. `CalendarEntry` cascades to `Class` (and to its
    // `WaitlistEntry`), so the residual queue this row held is gone with
    // it — `waitingEntriesLeft` below is 0 for that reason, not because
    // the count read failed.
    const rowDeleting = prisma.$extends({
      query: {
        class: {
          async findUnique({ args, query }) {
            if ((args.where as { id?: string }).id !== classId) return query(args);
            await prisma.calendarEntry.delete({ where: { id: calendarEntryId } });
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(deleteTeacherAccount(rowDeleting, teacherId)).resolves.toBeUndefined();

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        classId,
        observedStatus: 'row-deleted',
        observedCancelledAt: null,
        waitingEntriesLeft: 0,
      }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
  });

  it('reports a CAS skip after commit, so a failing diagnostic cannot roll the erasure back', async () => {
    // `completed` directly, not raced there: since #367 the pre-lock takes
    // the `Class` row before this transaction reads it at all, so a
    // concurrent `completeClass` can no longer land between an unlocked read
    // and the CAS — it queues behind the hold instead (see the sibling
    // test's own comment above). Getting a CAS miss into this test therefore
    // needs the same injection the sibling uses: create the row already
    // ineligible and hand its id back from `lockClassRowsOrdered` anyway.
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'diagnostic class',
      date: new Date('2026-06-02'),
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

    await prisma.waitlistEntry.create({
      data: { classId, studentId: waitingStudentId, position: 1, status: 'waiting' },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    // Same mock the sibling test above uses, for the same reason: the real
    // predicate would never match an already-`completed` row, so the only
    // way to land it in `upcoming` is to hand its id back alongside the
    // genuinely-locked ones.
    const originalLock = dbLocks.lockClassRowsOrdered;
    const lockSpy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await originalLock(tx, source);
        return source.entries === true ? [...ids, classId] : ids;
      });
    onTestFinished(() => lockSpy.mockRestore());

    // What the diagnostic read saw of the teacher row when it ran. Read via
    // `prisma`, never `tx` — the erasure's own transaction handle — so a
    // plain SELECT under READ COMMITTED never blocks on the erasure's row
    // lock and never sees its uncommitted write. It returns the last
    // COMMITTED version. So
    // an anonymized email here means the diagnostic ran AFTER the commit,
    // which is the whole of what #242 changes. Inside the transaction it
    // would read the original address: the erasure's own
    // `teacher.updateMany` is the last statement in that transaction, well
    // after this loop.
    let teacherEmailWhenDiagnosticRan: string | null = null;

    const failing = prisma.$extends({
      query: {
        class: {
          async findUnique({ args, query }) {
            if ((args.where as { id?: string }).id !== classId) return query(args);
            const teacher = await prisma.teacher.findUniqueOrThrow({
              where: { id: teacherId },
              select: { email: true },
            });
            teacherEmailWhenDiagnosticRan = teacher.email;
            throw new Error('injected: diagnostic status read failed');
          },
        },
        waitlistEntry: {
          async count({ args, query }) {
            if ((args.where as { classId?: string } | undefined)?.classId !== classId) {
              return query(args);
            }
            throw new Error('injected: diagnostic waitlist count failed');
          },
        },
      },
    }) as unknown as PrismaClient;

    // Precondition for the assertion below: if `beforeEach`'s `email`
    // restore is ever trimmed as apparently-redundant cleanup, this is what
    // catches it — without it, `teacherEmailWhenDiagnosticRan` would match
    // `/@deleted\.invalid$/` vacuously against the SIBLING test's stale
    // address, even if this diagnostic read ran pre-commit.
    const before = await prisma.teacher.findUniqueOrThrow({
      where: { id: teacherId },
      select: { email: true },
    });
    expect(before.email).not.toMatch(/@deleted\.invalid$/);

    // Resolves. A diagnostic that can reject the erasure is the defect.
    await expect(deleteTeacherAccount(failing, teacherId)).resolves.toBeUndefined();

    // The erasure committed.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);

    // And it had ALREADY committed when the diagnostic ran — the property
    // `.catch()` alone cannot deliver, because a caught statement error still
    // leaves a Postgres transaction poisoned (docs/lock-order.md).
    expect(teacherEmailWhenDiagnosticRan).toMatch(/@deleted\.invalid$/);

    // Both sentinels fired, and "could not look" stays distinct from "it was
    // gone" (`row-deleted`) and from "not cancelled" (`null`).
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        classId,
        observedStatus: 'unknown',
        observedCancelledAt: 'unknown',
        waitingEntriesLeft: -1,
      }),
      expect.stringContaining('cancel CAS matched nothing'),
    );

    // The skip was real: the class kept the status it was created with, and
    // its queue was not closed.
    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('completed');
    const entry = await prisma.waitlistEntry.findUniqueOrThrow({
      where: { classId_studentId: { classId, studentId: waitingStudentId } },
    });
    expect(entry.status).toBe('waiting');
  });

  it('keeps a real waitlist count even when the status read fails on its own', async () => {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'mixed diagnostic class',
      date: new Date('2026-06-04'),
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

    await prisma.waitlistEntry.create({
      data: { classId, studentId: waitingStudentId, position: 1, status: 'waiting' },
    });

    const originalLock = dbLocks.lockClassRowsOrdered;
    const lockSpy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await originalLock(tx, source);
        return source.entries === true ? [...ids, classId] : ids;
      });
    onTestFinished(() => lockSpy.mockRestore());

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    // Only the STATUS read is injected to fail — the count read is real.
    // Proves the two reads' guards are independent: a
    // `Promise.all([...]).catch(...)` refactor of the post-commit loop
    // would blank BOTH values out whenever EITHER read fails, discarding a
    // genuine residual count exactly when an operator needs it most.
    const halfFailing = prisma.$extends({
      query: {
        class: {
          async findUnique({ args, query }) {
            if ((args.where as { id?: string }).id !== classId) return query(args);
            throw new Error('injected: status read failed');
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(deleteTeacherAccount(halfFailing, teacherId)).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        classId,
        observedStatus: 'unknown',
        observedCancelledAt: 'unknown',
        waitingEntriesLeft: 1,
      }),
      expect.stringContaining('cancel CAS matched nothing'),
    );
  });

  it('a diagnostic loop failure does not fail the already-committed erasure', async () => {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'diagnostic loop class',
      date: new Date('2026-06-05'),
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

    const originalLock = dbLocks.lockClassRowsOrdered;
    const lockSpy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        const ids = await originalLock(tx, source);
        return source.entries === true ? [...ids, classId] : ids;
      });
    onTestFinished(() => lockSpy.mockRestore());

    // `log.warn` is the one unguarded statement left in the post-commit
    // loop after item 4's fix — both reads guard themselves with their own
    // `.catch()`. This proves the loop's OWN try/catch is the backstop, not
    // the individual reads' guards, which never fire in this test.
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {
      throw new Error('injected: log.warn failed');
    });
    onTestFinished(() => warn.mockRestore());
    const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    onTestFinished(() => error.mockRestore());

    await expect(deleteTeacherAccount(prisma, teacherId)).resolves.toBeUndefined();

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);

    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ teacherId, classId }),
      expect.stringContaining('post-commit skip diagnostic failed'),
    );
  });
});

/**
 * The CAS's OTHER conjunct, which the describe above does not reach: a
 * cancellable status with `cancelledAt` already set, so it is
 * `cancelledAt: null` that refuses and the status check that passes.
 *
 * This is the one cause of a lock/CAS disagreement that is still reachable
 * for real. The pre-lock is `FOR UPDATE OF c` — the `Class` row only — while
 * its `e."cancelledAt" IS NULL` conjunct reads the JOINED, unlocked
 * `CalendarEntry`, and `EvalPlanQual` re-fetches locked rows only. A
 * canceller that takes `Class` first and then writes the entry (`POST
 * /api/classes/[id]/cancel`, the canonical order) can therefore commit while
 * the pre-lock is still WAITING on the class row, leaving the entry half of
 * the predicate evaluated against a pre-wait snapshot. `gdpr.ts` argues that
 * at the CAS itself; `docs/lock-order.md` records the same mechanism for
 * `transitionClass`.
 *
 * Staged rather than raced all the same: winning that wait on purpose means
 * stalling a statement mid-flight inside Postgres, which a test cannot do.
 * So the entry is cancelled up front and its id injected into the lock set,
 * the same mock the describe above uses. What that leaves worth asserting is
 * the CAS's handling — a warn that names `cancelledAt` as the cause, a skip,
 * and an entry still carrying the canceller's own timestamp.
 *
 * Its own fixtures, not the describe above's: `deleteTeacherAccount`
 * soft-deletes the teacher it erases, so a second erasure of the same one
 * throws `AlreadyErasedError`.
 */
describe('deleteTeacherAccount cancel CAS loses to a concurrent cancellation (#367)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-cas-cancelled-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'CasCancel',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'CAS cancellation fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'CAS Cancel Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234CE',
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

  it('warns and skips when the entry was cancelled by a concurrent writer', async () => {
    const cls = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'CAS cancelled class',
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
    const classId = cls.id;

    // What the concurrent canceller committed while the pre-lock waited.
    // A fixed instant, so the assertion below can tell "left alone" from
    // "re-cancelled with a fresh timestamp".
    const cancelledAt = new Date('2026-01-02T03:04:05.000Z');
    await prisma.calendarEntry.update({
      where: { id: cls.calendarEntry.id },
      data: { cancelledAt },
    });

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    // The real predicate excludes this id now (`e."cancelledAt" IS NULL`),
    // which is exactly the disagreement being staged: under the mechanism in
    // this describe's docblock the pre-lock would have returned it anyway,
    // off a snapshot taken before the canceller committed.
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
    // `open` is in `CANCELLABLE_STATUSES`, so the status conjunct passed and
    // only `cancelledAt: null` can have refused the CAS, which is what makes
    // this test the one that covers that conjunct.
    //
    // Measured, by deleting `cancelledAt: null` from the CAS's `where` and
    // re-running this: the write is not silently accepted and does not
    // become a duplicate notification, it becomes `23514` from
    // `entry_terminal_liveness_guard` — a cancelled REGULAR entry's
    // `cancelledAt` is frozen in the database — which aborts the whole
    // erasure transaction. So the conjunct is what turns a lost race into a
    // skip instead of a failed Article 17 request.
    expect(after.status).toBe('open');
    expect(after.calendarEntry.cancelledAt).toEqual(cancelledAt);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        classId,
        observedStatus: 'open',
        observedCancelledAt: cancelledAt,
      }),
      expect.stringContaining('cancel CAS matched nothing'),
    );

    // The erasure itself still finished — a CAS that declines one class does
    // not abandon the Article 17 work around it.
    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(teacher.email).toMatch(/@deleted\.invalid$/);
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
 * `CANCELLABLE_STATUSES` classifies `in_progress` cancellable, and
 * `gdpr.test.ts`'s "renders exactly the statuses classified cancellable"
 * (below) pins that the ordered pre-lock's rendered SQL says so — but the
 * rendered fragment is not proof that a real `in_progress` class is ever
 * cancelled by the CAS loop that reads it, which is a distinct claim (#245
 * review, Important 14).
 *
 * It cannot be proved by simply creating an `in_progress` class before
 * calling `deleteTeacherAccount`: this function's own top-of-function sweep
 * (`db.class.findMany({ where: { status: 'in_progress', ... } })`, above)
 * completes every `in_progress` class of this teacher's BEFORE the erasure
 * transaction even opens, so a class already `in_progress` at that point
 * never reaches the CAS loop as `in_progress` at all — it reaches it as
 * `completed`. The shape that DOES reach the loop as `in_progress` is the
 * same race "locks and reads the same snapshot (#367)" above proves for
 * `open`: a class becoming cancellable in the window between that sweep and
 * the class pre-lock's own predicate. Reusing that injection point with
 * `status: 'in_progress'` is therefore not a stand-in for a direct fixture —
 * it is the only way an `in_progress` class can legitimately reach this
 * loop at all.
 */
describe('deleteTeacherAccount cancels an in_progress class on the CAS loop, not just in the SQL text (#245)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-inprogress-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let completedClassId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'InProgress',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'in_progress cancellation fixture',
        pageSlug: suffix,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountId = teacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'InProgress Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234IP',
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

    // The negative control: never `in_progress` at any point, so it is
    // never seen by the top-of-function completion sweep either, and the
    // CAS loop's own status conjunct must be what keeps it uncancelled.
    const completed = await createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Completed control',
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
    completedClassId = completed.id;
  });

  afterAll(async () => {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  });

  it('cancels a class that is in_progress when the CAS loop reaches it, and leaves a completed one alone', async () => {
    // Same injection point as "locks and reads the same snapshot (#367)"
    // above: `source.entries === true` fires exactly once, at
    // deleteTeacherAccount's own Class+CalendarEntry pre-lock — AFTER the
    // top-of-function `completeClass` sweep over `in_progress` classes has
    // already run and found none. `status: 'in_progress'` here, where that
    // test used `'open'`.
    const original = dbLocks.lockClassRowsOrdered;
    let injectedClassId: string | undefined;
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        if (source.entries === true) {
          const created = await createClassFixture(prisma, {
            teacherId,
            teacherRoomId,
            classType: 'Injected in-progress class',
            date: new Date('2026-06-02'),
            startTime: hhmmToTime('09:00'),
            durationMinutes: 60,
            roomCost: 20,
            minRate: 15,
            targetRate: 25,
            minStudents: 1,
            maxStudents: 10,
            status: 'in_progress',
          });
          injectedClassId = created.id;
        }
        return original(tx, source);
      });
    onTestFinished(() => spy.mockRestore());

    await deleteTeacherAccount(prisma, teacherId);

    expect(injectedClassId).toBeDefined();
    const inProgressAfter = await prisma.class.findUniqueOrThrow({
      where: { id: injectedClassId! },
      include: { calendarEntry: true },
    });
    // Still `in_progress` — this erasure cancels via the entry's
    // `cancelledAt`, it does not flip `Class.status` (#327).
    expect(inProgressAfter.status).toBe('in_progress');
    expect(inProgressAfter.calendarEntry.cancelledAt).not.toBeNull();

    const completedAfter = await prisma.class.findUniqueOrThrow({
      where: { id: completedClassId },
      include: { calendarEntry: true },
    });
    expect(completedAfter.calendarEntry.cancelledAt).toBeNull();
  });
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
 * call finds the head already `promoted` and returns `none`). Both tests
 * below need that broadcast path live — one to catch a diagnostic failure
 * inside it, the other to name which branch it failed in — even though the
 * doubled-broadcast guard that first justified the window now lives in
 * `gdpr-lock-order.test.ts` (#459).
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

  it('a diagnostic-loop failure after a lost handleSpotFreed race does not fail the already-committed erasure', async () => {
    const fixture = await makeStudentWithFreedSpot();
    try {
      // Fails `handleSpotFreed`'s own FIRST statement (`waitlist.ts`:
      // `db.class.findUnique({ where: { id }, include: { calendarEntry:
      // { include: { teacher: ... } } } })`) without touching
      // `deleteStudentAccount`'s own reads of the same class, which use
      // `select`, never `include`, for `Class`. Matched on both `where.id`
      // and the presence of `include` so this can't accidentally catch a
      // read this erasure's own transaction needs to succeed.
      const failing = prisma.$extends({
        query: {
          class: {
            async findUnique({ args, query }) {
              const where = args.where as { id?: string } | undefined;
              if (where?.id !== fixture.classId || !('include' in args)) return query(args);
              throw new Error('injected: handleSpotFreed read failed (code: "55P03")');
            },
          },
        },
      }) as unknown as PrismaClient;

      // `log.warn` is the one unguarded statement left in the diagnostic
      // block after this fix — the waitlist-count read already guards
      // itself with `.catch()`. Shaping the injected error as transient
      // (above) routes the middle catch to `log.warn`, not `log.error` —
      // leaving `log.error` free for the backstop's own call to use for
      // real, rather than colliding with the injected failure.
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => {
        throw new Error('injected: log.warn failed');
      });
      onTestFinished(() => warn.mockRestore());
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
      onTestFinished(() => error.mockRestore());

      await expect(deleteStudentAccount(failing, fixture.studentId)).resolves.toBeUndefined();

      const student = await prisma.student.findUniqueOrThrow({ where: { id: fixture.studentId } });
      expect(student.deletedAt).not.toBeNull();
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ classId: fixture.classId }),
        expect.stringContaining('spot-freed hook diagnostic failed unexpectedly'),
      );
    } finally {
      await cleanup(fixture);
    }
  }, 15_000);

  /**
   * The branch reaches the log line.
   *
   * Before this the erasure's loop logged one message that was true whichever
   * branch threw — "the freed seat was neither promoted nor broadcast" — so an
   * operator reading it could not tell one student's lost seat from N students
   * never told about one. The window is resolved inside the hook; this asserts
   * it survives the throw.
   */
  it('names the broadcast branch when the spot-freed hook fails after erasure', async () => {
    const fixture = await makeStudentWithFreedSpot();
    try {
      const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
      onTestFinished(() => warn.mockRestore());

      // Inject INSIDE the broadcast transaction, past the point where the window
      // resolves — unlike the sibling test above, which fails the opening
      // `class.findUnique` and therefore gets the honest `null` branch.
      // `createBulkNotifications` (`services/notifications.ts`) issues exactly
      // one `notification.createMany`, and matching on the `spot_available` type
      // keeps this from touching any other notification write.
      const failing = prisma.$extends({
        query: {
          notification: {
            async createMany({ args, query }) {
              const rows = args.data as Array<{ type?: string }> | undefined;
              if (!Array.isArray(rows) || !rows.some((r) => r.type === 'spot_available')) {
                return query(args);
              }
              throw new Error('injected: broadcast write failed (code: "55P03")');
            },
          },
        },
      }) as unknown as PrismaClient;

      await expect(deleteStudentAccount(failing, fixture.studentId)).resolves.toBeUndefined();

      const logged = warn.mock.calls.find(
        (c) => (c[0] as { classId?: string } | undefined)?.classId === fixture.classId,
      );
      expect(logged?.[0]).toMatchObject({
        classId: fixture.classId,
        transient: true,
        branch: 'first_come_first_claimed',
      });
      expect(logged?.[1]).toContain('the waiting students were not told the seat is free');
    } finally {
      await cleanup(fixture);
    }
  }, 15_000);
});

/**
 * The teacher half of the same guard (#196 branch 2, Task 3), which had no
 * test at all — `deleteStudentAccount`'s abort was pinned by
 * `gdpr-lock-order.test.ts`'s "erases once when the same student erasure runs
 * twice concurrently" (#459) and `deleteTeacherAccount`'s identical
 * `AlreadyErasedError` by nothing.
 *
 * Sequential, and that is not a weaker version of that race: the two
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

describe('the cancellable-status classification reaches the pre-lock (#245)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-cancellable-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let teacherId: string;
  let accountId: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Cancellable',
        lastName: 'Teacher',
        email: `${suffix}@test.local`,
        account: { create: { email: `${suffix}@test.local` } },
        bio: 'Status-partition fixture',
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

  // The compiler holds MEMBERSHIP — `satisfies Record<ClassStatus, boolean>`
  // makes a fifth `ClassStatus` an error until someone classifies it. This
  // holds the DERIVATION: that the classification reaches the SQL the
  // pre-lock actually issues, so flipping a `true` cannot stay a local edit
  // that no test can see. The two together are the pin; neither alone is.
  //
  // Read off the fragment rather than a fixture's outcome because the
  // rendered `IN (…)` list is the thing that would go stale — a per-status
  // class fixture would assert the same fact through four times the setup,
  // and would still pass if the list and the record disagreed about a status
  // no fixture happened to cover.
  it('renders exactly the statuses classified cancellable', async () => {
    const original = dbLocks.lockClassRowsOrdered;
    const predicates: string[] = [];
    const spy = vi
      .spyOn(dbLocks, 'lockClassRowsOrdered')
      .mockImplementation(async (tx, source) => {
        predicates.push(source.where.strings.join(' ? '));
        return original(tx, source);
      });
    onTestFinished(() => spy.mockRestore());

    await deleteTeacherAccount(prisma, teacherId);

    expect(predicates).toHaveLength(1);
    expect(predicates[0]).toContain("c.status IN ('draft', 'open', 'in_progress')");
  });
});

/**
 * ONE DECOY SERVES BOTH CONJUNCTS. `classD` belongs to a different teacher AND
 * carries a different student's waiting entry, so `e."teacherId" =
 * victimTeacher` excludes it and `w."studentId" = victimStudent` excludes it
 * too — and either conjunct's deletion pulls it into that pre-lock's set.
 *
 * What this adds over the sibling lock-order suite, and the measurement
 * behind it: `docs/superpowers/specs/2026-09-05-pre-lock-scope-decoys-design.md`
 * ("A. `gdpr.ts` — both erasures").
 */
describe('the erasure pre-locks are scoped to their own owner (#453)', () => {
  const prisma = new PrismaClient();
  const suffix = `gdpr-scope-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let victimTeacherId: string;
  let victimTeacherAccountId: string;
  let decoyTeacherId: string;
  let decoyTeacherAccountId: string;
  let roomId: string;
  let victimStudentId: string;
  let victimStudentAccountId: string;
  let decoyStudentId: string;
  let classAId: string;
  let classDId: string;
  let classDEntryId: string;

  beforeAll(async () => {
    const victimTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Scope',
        lastName: 'Victim',
        email: `${suffix}-victim@test.local`,
        account: { create: { email: `${suffix}-victim@test.local` } },
        bio: 'Scope fixture',
        pageSlug: `${suffix}-victim`,
      },
      select: { id: true, accountId: true },
    });
    victimTeacherId = victimTeacher.id;
    victimTeacherAccountId = victimTeacher.accountId;

    const decoyTeacher = await prisma.teacher.create({
      data: {
        firstName: 'Scope',
        lastName: 'Bystander',
        email: `${suffix}-decoy@test.local`,
        account: { create: { email: `${suffix}-decoy@test.local` } },
        bio: 'Scope decoy',
        pageSlug: `${suffix}-decoy`,
      },
      select: { id: true, accountId: true },
    });
    decoyTeacherId = decoyTeacher.id;
    decoyTeacherAccountId = decoyTeacher.accountId;

    const room = await prisma.room.create({
      data: {
        venueName: 'Scope Studio',
        address: `${suffix} St`,
        city: 'Amsterdam',
        postcode: '1234SC',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: victimTeacherId,
      },
      select: { id: true },
    });
    roomId = room.id;

    // A `TeacherRoom` per teacher on the one shared `Room`: the rate is
    // per-teacher and never shared, so the decoy needs its own row.
    const victimRoom = await prisma.teacherRoom.create({
      data: { teacherId: victimTeacherId, roomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });
    const decoyRoom = await prisma.teacherRoom.create({
      data: { teacherId: decoyTeacherId, roomId, capacityOverride: 15, rentalRate: 30 },
      select: { id: true },
    });

    const base = {
      classType: 'Scope class',
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 10,
      status: 'open' as const,
    };

    const classA = await createClassFixture(prisma, {
      ...base,
      teacherId: victimTeacherId,
      teacherRoomId: victimRoom.id,
      date: new Date('2099-06-01'),
    });
    classAId = classA.id;

    const classD = await createClassFixture(prisma, {
      ...base,
      teacherId: decoyTeacherId,
      teacherRoomId: decoyRoom.id,
      date: new Date('2099-06-01'),
    });
    classDId = classD.id;
    classDEntryId = classD.calendarEntry.id;

    // WITH an account: `deleteStudentAccount` deletes its sessions and
    // passkeys and anonymises the account's email, but only when no other
    // live teacher profile shares that account — a student created with no
    // account at all skips that branch entirely.
    const victimStudent = await prisma.student.create({
      data: {
        firstName: 'Scope',
        lastName: 'Student',
        email: `${suffix}-student@test.local`,
        incomeTier: 2,
        claimedAt: new Date(),
        account: { create: { email: `${suffix}-student@test.local` } },
      },
      select: { id: true, accountId: true },
    });
    victimStudentId = victimStudent.id;
    victimStudentAccountId = victimStudent.accountId!;

    // No account: nothing erases this one.
    const decoyStudent = await prisma.student.create({
      data: {
        firstName: 'Scope',
        lastName: 'Waiter',
        email: `${suffix}-waiter@test.local`,
        incomeTier: 2,
      },
      select: { id: true },
    });
    decoyStudentId = decoyStudent.id;

    await prisma.waitlistEntry.create({
      data: { classId: classAId, studentId: victimStudentId, position: 1, status: 'waiting' },
    });
    await prisma.waitlistEntry.create({
      data: { classId: classDId, studentId: decoyStudentId, position: 1, status: 'waiting' },
    });
  });

  afterAll(async () => {
    const studentIds = [victimStudentId, decoyStudentId];
    const teacherIds = [victimTeacherId, decoyTeacherId];
    await prisma.notification.deleteMany({ where: { recipientId: { in: [...studentIds, ...teacherIds] } } });
    await prisma.waitlistEntry.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    await prisma.account.deleteMany({
      where: { id: { in: [victimTeacherAccountId, decoyTeacherAccountId, victimStudentAccountId] } },
    });
    await prisma.$disconnect();
  });

  /**
   * The ids the pre-lock ACTUALLY held, read off the helper rather than
   * re-derived from a fixture. Calls through, so the erasure runs for real —
   * the same shape as the fragment-reading spy in the describe above, which
   * reads `source.where` where this reads the return value.
   *
   * A text pin on `source.where` could not replace this: `.strings` is the
   * tagged template's STATIC text, so the owner id renders as `?` and a
   * predicate scoped to the WRONG owner reads identically to the right one.
   */
  const captureLockSets = (): string[][] => {
    const original = dbLocks.lockClassRowsOrdered;
    const lockSets: string[][] = [];
    const spy = vi.spyOn(dbLocks, 'lockClassRowsOrdered').mockImplementation(async (tx, source) => {
      const ids = await original(tx, source);
      lockSets.push(ids);
      return ids;
    });
    onTestFinished(() => spy.mockRestore());
    return lockSets;
  };

  // These two tests share one fixture, and each erasure is one-shot — an
  // erased account cannot be erased again — so neither test can be re-run
  // against this fixture on its own, and an `it.only` on either one still
  // needs the whole `beforeAll`.
  it('locks only classes the erased student actually waits in', async () => {
    const lockSets = captureLockSets();

    await deleteStudentAccount(prisma, victimStudentId);

    expect(lockSets).toHaveLength(1);
    // `classD` carries a waiting entry too — just not this student's. Drop
    // `w."studentId"` from the pre-lock and it appears here.
    expect(lockSets[0]).toEqual([classAId]);

    // The decoy's entry is untouched. HONEST ABOUT WHAT THIS CATCHES: it
    // cannot fail on a widened pre-lock, because the `waitlistEntry.deleteMany`
    // re-scopes on `studentId` independently. It guards that `deleteMany`'s own
    // scope, which is a different regression.
    const decoyEntry = await prisma.waitlistEntry.findFirstOrThrow({
      where: { classId: classDId, studentId: decoyStudentId },
    });
    expect(decoyEntry.status).toBe('waiting');
  });

  it('locks only the erased teacher’s own classes, and cancels no one else’s', async () => {
    const lockSets = captureLockSets();

    await deleteTeacherAccount(prisma, victimTeacherId);

    expect(lockSets).toHaveLength(1);
    expect(lockSets[0]).toEqual([classAId]);

    // NOT witnessed by either mutation run against this file: mutation 1
    // (`e."teacherId"` dropped) fails the `lockSets` assertion just above,
    // before the run ever reaches here, and mutation 2 only touches the
    // sibling test above. Its job is different: the CAS cancel loop below the
    // pre-lock (`gdpr.ts`) writes `calendarEntry.updateMany` keyed on the
    // locked id and the class's own status, with no second `teacherId` check
    // of its own — so the pre-lock's `WHERE` is the only thing standing
    // between this erasure and a bystander's schedule, and this assertion is
    // what fails if that ever stops being true.
    const decoyEntry = await prisma.calendarEntry.findUniqueOrThrow({ where: { id: classDEntryId } });
    expect(decoyEntry.cancelledAt).toBeNull();
  });
});
