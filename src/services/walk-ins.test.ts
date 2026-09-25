/**
 * The walk-in consent state machine (#255), against the real test database.
 *
 * Every case gets its own teacher, so no two cases contend for the
 * `(teacherId, email)` key `Invitation` and `TeacherBlock` are unique on. The
 * class exists only for the notification's `relatedClassId` FK: the class-side
 * work (locks, capacity, the registration) is the route's, and its tests live
 * beside it.
 *
 * Refusals are asserted by `refusal`, never by message.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { createClassFixture } from '../../tests/class-fixtures';
import { erasedAddress } from '@/lib/erased-address';
import {
  resolveWalkInStudent,
  completeWalkIn,
  WalkInRefusedError,
  type WalkInRefusal,
  type WalkInSubject,
} from './walk-ins';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

const teacherIds: string[] = [];
const studentIds: string[] = [];
const accountIds: string[] = [];
const classIds: string[] = [];
const roomIds: string[] = [];

afterAll(async () => {
  if (teacherIds.length) {
    // A student a failing case created before it could record the id — the
    // service links every student it creates, so the link names it.
    const linked = await prisma.teacherStudent.findMany({
      where: { teacherId: { in: teacherIds } },
      select: { studentId: true },
    });
    for (const { studentId } of linked) {
      if (!studentIds.includes(studentId)) studentIds.push(studentId);
    }
  }
  if (classIds.length) {
    await prisma.notification.deleteMany({ where: { relatedClassId: { in: classIds } } });
  }
  if (studentIds.length) {
    await prisma.notification.deleteMany({
      where: { recipientType: 'student', recipientId: { in: studentIds } },
    });
  }
  if (teacherIds.length) {
    // Cascades to each entry's `Class`.
    await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.invitation.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.studentPrivacy.deleteMany({ where: { teacherId: { in: teacherIds } } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: teacherIds } } });
  }
  if (roomIds.length) {
    await prisma.room.deleteMany({ where: { id: { in: roomIds } } });
  }
  if (studentIds.length) {
    await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  }
  if (teacherIds.length) {
    await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
  }
  // Last, and after both profiles: `Student.accountId` and `Teacher.accountId`
  // are plain FKs with no cascade, so an account dropped first is refused.
  if (accountIds.length) {
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await prisma.$disconnect();
});

/** A fresh teacher with a room and an open class, one per case. */
async function seedTeacher(label: string): Promise<{ teacherId: string; classId: string }> {
  const teacherEmail = `walkin-${label}-teacher-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Tess', lastName: 'Teacher',
      email: teacherEmail,
      account: { create: { email: teacherEmail } },
      bio: '#255 walk-ins fixture teacher',
      pageSlug: `walkin-${label}-${suffix}`,
      defaultTimezone: 'UTC',
    },
    select: { id: true, accountId: true },
  });
  teacherIds.push(teacher.id);
  accountIds.push(teacher.accountId);

  const room = await prisma.room.create({
    data: {
      venueName: 'Walk-in Studio', address: `${label} ${suffix} Walk St`, city: 'Amsterdam',
      postcode: '1234WI', floor: '1', roomName: 'Main', maxCapacity: 20,
      createdById: teacher.id,
    },
    select: { id: true },
  });
  roomIds.push(room.id);

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 20, rentalRate: 25 },
    select: { id: true },
  });

  const cls = await createClassFixture(prisma, {
    teacherId: teacher.id, teacherRoomId: teacherRoom.id,
    classType: 'Vinyasa',
    date: new Date('2099-10-05'),
    startTime: new Date('1970-01-01T10:00:00Z'),
    durationMinutes: 60,
    roomCost: 25, minRate: 15, targetRate: 25,
    minStudents: 1, maxStudents: 8,
    status: 'open',
  });
  classIds.push(cls.id);

  return { teacherId: teacher.id, classId: cls.id };
}

/** A claimed student with its own account, as someone who signed up has. */
async function seedClaimedStudent(email: string): Promise<string> {
  const student = await prisma.student.create({
    data: {
      firstName: 'Known', lastName: 'Person',
      email, claimedAt: new Date(),
      account: { create: { email } },
    },
    select: { id: true, accountId: true },
  });
  studentIds.push(student.id);
  if (student.accountId) accountIds.push(student.accountId);
  return student.id;
}

const notice = { teacherName: 'Tess Teacher', classType: 'Vinyasa', dateLabel: 'Monday, 5 October' };

async function walkIn(teacherId: string, classId: string, subject: WalkInSubject) {
  return prisma.$transaction(async (tx) => {
    const resolved = await resolveWalkInStudent(tx, { teacherId, subject });
    await completeWalkIn(tx, { teacherId, classId, resolved, notice });
    return resolved;
  });
}

async function expectRefused(promise: Promise<unknown>, refusal: WalkInRefusal): Promise<void> {
  const error: unknown = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(WalkInRefusedError);
  expect(error).toMatchObject({ refusal });
}

describe('resolveWalkInStudent + completeWalkIn', () => {
  it('creates an unclaimed student for an unknown address, links it, accepts the invitation, seeds name+email sharing', async () => {
    const { teacherId, classId } = await seedTeacher('create');
    const email = `walkin-create-${suffix}@test.local`;
    const resolved = await walkIn(teacherId, classId, { kind: 'newContact', firstName: 'Anna', lastName: 'Bergsma', email });
    studentIds.push(resolved.studentId);

    expect(resolved.created).toBe(true);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: resolved.studentId } });
    expect(student).toMatchObject({ email, firstName: 'Anna', lastName: 'Bergsma', claimedAt: null, accountId: null, tierSelectedAt: null, incomeTier: 3 });
    expect(await prisma.teacherStudent.count({ where: { teacherId, studentId: resolved.studentId } })).toBe(1);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { teacherId_email: { teacherId, email } } }))
      .toMatchObject({ status: 'accepted', firstName: 'Anna', lastName: 'Bergsma' });
    expect(await prisma.studentPrivacy.findUniqueOrThrow({ where: { studentId_teacherId: { studentId: resolved.studentId, teacherId } } }))
      .toMatchObject({ shareFullName: true, shareEmail: true, sharePhone: false, shareBirthday: false, shareAddress: false });
    const n = await prisma.notification.findFirstOrThrow({ where: { recipientId: resolved.studentId, type: 'walk_in_added' } });
    expect(n).toMatchObject({ recipientType: 'student', relatedClassId: classId });
  });

  it('uses the existing student for a known address and seeds no privacy row', async () => {
    const { teacherId, classId } = await seedTeacher('match');
    const email = `walkin-match-${suffix}@test.local`;
    const studentId = await seedClaimedStudent(email);
    const inv = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Typed', lastName: 'Name', status: 'pending' },
    });

    const resolved = await walkIn(teacherId, classId, { kind: 'invitation', invitationId: inv.id });

    expect(resolved).toMatchObject({ studentId, created: false, email });
    expect(await prisma.student.count({ where: { email } })).toBe(1);
    expect(await prisma.studentPrivacy.count({ where: { teacherId, studentId } })).toBe(0);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } }))
      .toMatchObject({ status: 'accepted', firstName: 'Typed', lastName: 'Name' });
    expect(await prisma.teacherStudent.count({ where: { teacherId, studentId } })).toBe(1);
    expect(await prisma.notification.count({ where: { recipientId: studentId, type: 'walk_in_added', relatedClassId: classId } })).toBe(1);
  });

  it('registers a roster student typed as a new contact, with no invitation row until now', async () => {
    const { teacherId, classId } = await seedTeacher('roster');
    const email = `walkin-roster-${suffix}@test.local`;
    const studentId = await seedClaimedStudent(email);
    await prisma.teacherStudent.create({ data: { teacherId, studentId } });
    expect(await prisma.invitation.count({ where: { teacherId, email } })).toBe(0);

    const resolved = await walkIn(teacherId, classId, { kind: 'newContact', firstName: 'Roster', lastName: 'Typed', email });

    expect(resolved).toMatchObject({ studentId, created: false });
    expect(await prisma.teacherStudent.count({ where: { teacherId, studentId } })).toBe(1);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { teacherId_email: { teacherId, email } } }))
      .toMatchObject({ status: 'accepted', firstName: 'Roster', lastName: 'Typed' });
    expect(await prisma.studentPrivacy.count({ where: { teacherId, studentId } })).toBe(0);
  });

  it('attaches the new student to a teacher-only account holding the address', async () => {
    const { teacherId, classId } = await seedTeacher('attach');
    const email = `walkin-attach-${suffix}@test.local`;
    const account = await prisma.account.create({ data: { email }, select: { id: true } });
    accountIds.push(account.id);
    const otherTeacher = await prisma.teacher.create({
      data: {
        accountId: account.id,
        firstName: 'Only', lastName: 'Teacher', email,
        bio: '#255 teacher-only account', pageSlug: `walkin-attach-other-${suffix}`,
      },
      select: { id: true },
    });
    teacherIds.push(otherTeacher.id);

    const resolved = await walkIn(teacherId, classId, { kind: 'newContact', firstName: 'Also', lastName: 'Teaches', email });
    studentIds.push(resolved.studentId);

    expect(resolved.created).toBe(true);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: resolved.studentId } });
    expect(student.accountId).toBe(account.id);
    expect(student.claimedAt).not.toBeNull();
  });

  it('leaves an account that already holds a live student profile alone', async () => {
    const { teacherId, classId } = await seedTeacher('live-profile');
    const accountEmail = `walkin-live-account-${suffix}@test.local`;
    const profileEmail = `walkin-live-profile-${suffix}@test.local`;
    const account = await prisma.account.create({ data: { email: accountEmail }, select: { id: true } });
    accountIds.push(account.id);
    const profile = await prisma.student.create({
      data: { accountId: account.id, email: profileEmail, firstName: 'Live', lastName: 'Profile', claimedAt: new Date() },
      select: { id: true },
    });
    studentIds.push(profile.id);
    expect(await prisma.student.count({ where: { email: accountEmail } })).toBe(0);

    const resolved = await walkIn(teacherId, classId, { kind: 'newContact', firstName: 'Second', lastName: 'Address', email: accountEmail });
    studentIds.push(resolved.studentId);

    expect(resolved.created).toBe(true);
    expect(resolved.studentId).not.toBe(profile.id);
    const student = await prisma.student.findUniqueOrThrow({ where: { id: resolved.studentId } });
    expect(student.accountId).toBeNull();
    expect(student.claimedAt).toBeNull();
  });

  it('refuses an erased invitation before creating anything', async () => {
    const { teacherId, classId } = await seedTeacher('erased');
    const email = erasedAddress(crypto.randomUUID());
    const inv = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Deleted', lastName: 'Student', status: 'pending' },
    });

    await expectRefused(walkIn(teacherId, classId, { kind: 'invitation', invitationId: inv.id }), 'INVITATION_ERASED');

    expect(await prisma.student.count({ where: { email } })).toBe(0);
  });

  it('refuses a declined invitation', async () => {
    const { teacherId, classId } = await seedTeacher('declined');
    const email = `walkin-declined-${suffix}@test.local`;
    // No `TeacherBlock`: this pins the status read, not the block read.
    const inv = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Said', lastName: 'No', status: 'declined', respondedAt: new Date() },
    });

    await expectRefused(walkIn(teacherId, classId, { kind: 'invitation', invitationId: inv.id }), 'DECLINED');

    expect(await prisma.student.count({ where: { email } })).toBe(0);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('declined');
  });

  it('refuses a blocked address, and leaves the block standing', async () => {
    const { teacherId, classId } = await seedTeacher('blocked');
    const email = `walkin-blocked-${suffix}@test.local`;
    const inv = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Blocked', status: 'pending', delivered: false },
    });
    await prisma.teacherBlock.create({ data: { teacherId, email } });

    await expectRefused(walkIn(teacherId, classId, { kind: 'invitation', invitationId: inv.id }), 'WALK_IN_REFUSED');

    expect(await prisma.teacherBlock.count({ where: { teacherId, email } })).toBe(1);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
    expect(await prisma.student.count({ where: { email } })).toBe(0);
  });

  it("refuses another teacher's invitation as not found", async () => {
    const { teacherId, classId } = await seedTeacher('foreign-a');
    const { teacherId: teacherB } = await seedTeacher('foreign-b');
    const email = `walkin-foreign-${suffix}@test.local`;
    const inv = await prisma.invitation.create({
      data: { teacherId: teacherB, email, firstName: 'Someone', status: 'pending' },
    });

    await expectRefused(walkIn(teacherId, classId, { kind: 'invitation', invitationId: inv.id }), 'NOT_FOUND');

    expect(await prisma.student.count({ where: { email } })).toBe(0);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
  });

  it('refuses a block that commits after resolve, at the last statement of complete', async () => {
    const { teacherId, classId } = await seedTeacher('race');
    const email = `walkin-race-${suffix}@test.local`;
    const inv = await prisma.invitation.create({ data: { teacherId, email, firstName: 'Race', status: 'pending', delivered: false } });
    const other = new PrismaClient();
    try {
      await expectRefused(
        prisma.$transaction(async (tx) => {
          const resolved = await resolveWalkInStudent(tx, { teacherId, subject: { kind: 'invitation', invitationId: inv.id } });
          // An unlink of an undelivered row: block committed, status untouched (#502).
          await other.teacherBlock.create({ data: { teacherId, email } });
          await completeWalkIn(tx, { teacherId, classId, resolved, notice });
        }),
        'WALK_IN_REFUSED',
      );
    } finally {
      await other.$disconnect();
    }
    expect(await prisma.student.count({ where: { email } })).toBe(0);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
    expect(await prisma.teacherBlock.count({ where: { teacherId, email } })).toBe(1);
  });

  it('refuses a decline that commits after resolve, at the compare-and-set', async () => {
    const { teacherId, classId } = await seedTeacher('decline-race');
    const email = `walkin-decline-race-${suffix}@test.local`;
    const inv = await prisma.invitation.create({ data: { teacherId, email, firstName: 'Late', status: 'pending' } });
    const other = new PrismaClient();
    try {
      await expectRefused(
        prisma.$transaction(async (tx) => {
          const resolved = await resolveWalkInStudent(tx, { teacherId, subject: { kind: 'invitation', invitationId: inv.id } });
          // A decline with no block, so only the compare-and-set can see it.
          await other.invitation.update({
            where: { id: inv.id },
            data: { status: 'declined', respondedAt: new Date() },
          });
          await completeWalkIn(tx, { teacherId, classId, resolved, notice });
        }),
        'DECLINED',
      );
    } finally {
      await other.$disconnect();
    }
    expect(await prisma.student.count({ where: { email } })).toBe(0);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('declined');
    expect(await prisma.teacherStudent.count({ where: { teacherId } })).toBe(0);
  });

  it('continues as the match branch when a concurrent create took the address', async () => {
    const { teacherId, classId } = await seedTeacher('conflict');
    const email = `walkin-conflict-${suffix}@test.local`;
    const theirs = await prisma.student.create({ data: { email, firstName: 'First', lastName: 'Writer' }, select: { id: true } });
    studentIds.push(theirs.id);
    // Force the create branch against a row that already exists: the one
    // interleave where the insert, not the read, meets the other writer.
    const resolved = await prisma.$transaction(async (tx) => {
      const spy = vi.spyOn(tx.student, 'findUnique').mockResolvedValueOnce(null);
      try {
        const r = await resolveWalkInStudent(tx, { teacherId, subject: { kind: 'newContact', firstName: 'Anna', lastName: 'B', email } });
        expect(spy).toHaveBeenCalledTimes(1);
        await completeWalkIn(tx, { teacherId, classId, resolved: r, notice });
        return r;
      } finally {
        spy.mockRestore();
      }
    });
    expect(resolved).toMatchObject({ studentId: theirs.id, created: false });
    expect(await prisma.student.count({ where: { email } })).toBe(1);
    expect(await prisma.studentPrivacy.count({ where: { teacherId, studentId: theirs.id } })).toBe(0);
  });
});
