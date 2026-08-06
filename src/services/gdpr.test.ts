import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import {
  exportStudentData,
  deleteStudentAccount,
  deleteTeacherAccount,
} from './gdpr';

const prisma = new PrismaClient();
const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * Self-contained fixture: a fresh teacher, room, and open class with one
 * student holding a `waiting` `WaitlistEntry` on it. No helper in this file
 * produces a waiting entry, so this builds the whole chain from scratch
 * rather than reusing the shared `describe('GDPR (DB)', ...)` fixtures —
 * those students get erased by other tests in that block, and test order is
 * not something to depend on.
 */
async function makeStudentWaitingInClass() {
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
  await prisma.waitlistEntry.create({
    data: { classId: cls.id, studentId: student.id, position: 1, status: 'waiting' },
  });
  return {
    studentId: student.id,
    classId: cls.id,
    teacherId: teacher.id,
    roomId: room.id,
    accountId: teacher.accountId,
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
  // Mixed case on purpose. `Student.email` is stored exactly as typed;
  // `Invitation.email` and `TeacherBlock.email` are lowercase by DB
  // constraint. Every one of these lookups has to bridge that, and a fixture
  // whose student address is already lowercase cannot tell a bridged lookup
  // from an unbridged one.
  const typedEmail = `Gdpr-Inv-${suffix}@Test.Local`;
  const storedEmail = typedEmail.toLowerCase();
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
        email: typedEmail,
        claimedAt: new Date(),
        account: { create: { email: typedEmail } },
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
        teacherId: inviterId, email: storedEmail, firstName: 'Sam', lastName: 'Typo',
        status: 'accepted', respondedAt: new Date('2026-02-03T04:05:06.000Z'),
      },
    });
    await prisma.invitation.create({
      data: {
        teacherId: blockerId, email: storedEmail, firstName: 'Sammy', lastName: 'Typo',
        status: 'declined', respondedAt: new Date('2026-03-04T05:06:07.000Z'),
      },
    });
    await prisma.teacherBlock.create({ data: { teacherId: blockerId, email: storedEmail } });

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
    expect(block?.email).toBe(storedEmail);
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
// proves nothing: the erasure `findMany` at `gdpr.ts:593` filters to
// `draft`/`open`/`in_progress`, so an already-`completed` class is never
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
// update never got a row to clobber): the pre-transaction sweep selects
// only `id` on `status: 'in_progress'` with no `include`, so it is filtered
// to exclude this fixture's class (standing in for a completion sweep that
// has not reached this row yet, so the class is still genuinely
// `in_progress` for the transaction's own read); the transaction's read is
// the one that includes `registrations`, and its real, unmodified rows are
// what the erasure transaction acts on. The side effect — a real,
// separately committed `updateMany` moving the row to `completed` — runs
// inside that same hook, after the real read resolves and before control
// returns to `deleteTeacherAccount`, so it is guaranteed to land before the
// loop's per-row write for this class, exactly the ordering
// `gdpr.ts:604-614` describes.
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
            // transaction opens) selects only `id` on `status: 'in_progress'`
            // and never includes `registrations`; the transaction's read of
            // "upcoming" classes is the only one of the two that does. An
            // extra `class.findMany` inserted anywhere else now reliably
            // falls into the "not the transaction's read" branch below
            // instead of stealing this hook's one shot at the side effect.
            const isTransactionRead = Boolean(args.include && 'registrations' in args.include);
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
  });
});
