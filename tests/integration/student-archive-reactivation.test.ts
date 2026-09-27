/**
 * Every act that makes a `(teacher, student)` pair live un-archives the
 * pair's `TeacherStudent` link — the read side of the invariant
 * `docs/superpowers/specs/2026-09-27-student-archive-semantics-design.md`
 * states for #265. This file drives that through the API: the acts that
 * reach `linkTeacherStudent` (`services/roster-link.ts`) — a self-booking, a
 * walk-in of a person already on the roster, a waitlist join, and an
 * invitation accept — plus the teacher roster add, which un-archives via
 * `activateTeacherStudentLink` directly rather than through
 * `linkTeacherStudent` (a teacher may not create a link). `promoteNext` and
 * `claimSpot`, the other `linkTeacherStudent` callers, are covered at the
 * service level in `src/services/waitlist.test.ts`, alongside their own
 * fixtures.
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { BASE_URL, cookie, freshIp, seedSession, teardownStudent, uniqueSuffix } from '../helpers';
import { createClassFixture, slotTime } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { expectApplied } from '../api-assertions';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let teacherAccountId: string;
let ownerToken: string;
let roomId: string;
let teacherRoomId: string;
const classIds: string[] = [];
const fillerStudentIds: string[] = [];

let classCounter = 0;
/** A fresh, open, far-future class of the fixture teacher's — one per call, spaced so `CalendarEntry_teacher_slot_excl` never collides across tests. */
async function makeClass(maxStudents: number): Promise<string> {
  const startTime = slotTime(classCounter++);
  const cls = await createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Archive Reactivation',
    date: new Date('2099-06-01'),
    startTime: hhmmToTime(startTime),
    durationMinutes: 1,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 1,
    maxStudents,
    status: 'open',
  });
  classIds.push(cls.id);
  return cls.id;
}

let studentCounter = 0;
/** A fresh student, already linked to the fixture teacher and archived — the state every act below must clear. */
async function makeArchivedStudent() {
  studentCounter += 1;
  const email = `archive-reactivate-${suffix}-${studentCounter}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Archive',
      lastName: `Student${studentCounter}`,
      email,
      claimedAt: new Date(),
      account: { create: { email } },
      incomeTier: 3,
    },
    select: { id: true, accountId: true, firstName: true, lastName: true, email: true },
  });
  await prisma.teacherStudent.create({
    data: { teacherId, studentId: student.id, isArchived: true },
  });
  const token = await seedSession(prisma, student.accountId as string);
  onTestFinished(async () => {
    await teardownStudent(prisma, student.id, student.accountId);
  });
  return {
    studentId: student.id,
    token,
    email: student.email,
    firstName: student.firstName,
    lastName: student.lastName,
  };
}

/** Reads the pair's link row and asserts the archive was cleared. */
async function expectReactivated(studentId: string): Promise<void> {
  const link = await prisma.teacherStudent.findUniqueOrThrow({
    where: { teacherId_studentId: { teacherId, studentId } },
  });
  expect(link.isArchived).toBe(false);
}

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Archive',
      lastName: 'Reactivation',
      email: `archive-reactivate-teacher-${suffix}@test.local`,
      account: { create: { email: `archive-reactivate-teacher-${suffix}@test.local` } },
      bio: '#265 student-archive-reactivation fixture teacher',
      pageSlug: `archive-reactivate-teacher-${suffix}`,
    },
  });
  teacherId = teacher.id;
  teacherAccountId = teacher.accountId;
  ownerToken = await seedSession(prisma, teacher.accountId);

  const room = await prisma.room.create({
    data: {
      venueName: 'Archive Reactivation Studio',
      address: `${suffix} Archive St`,
      city: 'Amsterdam',
      postcode: '1234AR',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacherId,
    },
  });
  roomId = room.id;

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 15, rentalRate: 30 },
  });
  teacherRoomId = teacherRoom.id;
});

afterAll(async () => {
  // Every filter below is guarded on its own id having been assigned: an
  // unguarded `deleteMany({ where: { teacherId } })` with `teacherId` still
  // `undefined` (a `beforeAll` that threw before reaching its assignment)
  // drops the filter entirely and wipes the whole table (#669).
  if (teacherId) {
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
  }
  await prisma.waitlistEntry.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.registration.deleteMany({ where: { classId: { in: classIds } } });
  await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
  if (fillerStudentIds.length) {
    await prisma.student.deleteMany({ where: { id: { in: fillerStudentIds } } });
  }
  if (teacherRoomId) {
    await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
  }
  if (roomId) {
    await prisma.room.deleteMany({ where: { id: roomId } });
  }
  if (teacherAccountId) {
    await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
  }
  if (teacherId) {
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
  }
  if (teacherAccountId) {
    await prisma.account.deleteMany({ where: { id: teacherAccountId } });
  }
  await prisma.$disconnect();
});

describe('every act that makes something live un-archives the roster link (#265)', () => {
  it('self-booking un-archives the link', async () => {
    const { studentId, token } = await makeArchivedStudent();
    const classId = await makeClass(5);

    const res = await fetch(`${BASE_URL}/api/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
      body: JSON.stringify({ classId }),
    });
    await expectApplied(res, 201);
    await expectReactivated(studentId);
  });

  it('a walk-in of an existing linked student un-archives the link', async () => {
    const { studentId, email, firstName, lastName } = await makeArchivedStudent();
    const classId = await makeClass(1);
    // Walk-ins are a class-time phenomenon (`api/registrations/route.ts`'s
    // `WALK_IN_WINDOW_MS`) — flip straight to `in_progress` rather than
    // waiting out the window, the same fixture shortcut
    // `registrations-api.test.ts`'s "walk-in" tests use.
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });

    const res = await fetch(`${BASE_URL}/api/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken), ...freshIp() },
      body: JSON.stringify({ classId, newContact: { firstName, lastName, email } }),
    });
    await expectApplied(res, 201);
    await expectReactivated(studentId);
  });

  it('joining a full class\'s waitlist un-archives the link', async () => {
    const { studentId, token } = await makeArchivedStudent();
    const classId = await makeClass(1);

    const filler = await prisma.student.create({
      data: {
        firstName: 'ArchiveFiller',
        lastName: `Test${studentCounter}`,
        email: `archive-reactivate-filler-${suffix}-${studentCounter}@test.local`,
        incomeTier: 3,
      },
      select: { id: true },
    });
    fillerStudentIds.push(filler.id);
    await prisma.registration.create({
      data: { classId, studentId: filler.id, status: 'registered', tierAtBooking: 3 },
    });

    const res = await fetch(`${BASE_URL}/api/waitlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
      body: JSON.stringify({ classId }),
    });
    await expectApplied(res, 201);
    await expectReactivated(studentId);
  });

  it('accepting an invitation un-archives the link', async () => {
    const { studentId, token, email, firstName, lastName } = await makeArchivedStudent();

    const inviteRes = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken), ...freshIp() },
      body: JSON.stringify({ firstName, lastName, email }),
    });
    const invited = (await expectApplied(inviteRes, 201)) as { id: string };

    const acceptRes = await fetch(`${BASE_URL}/api/invitations/${invited.id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
      body: JSON.stringify({ response: 'accept' }),
    });
    await expectApplied(acceptRes, 200);
    await expectReactivated(studentId);
  });

  it('a teacher roster add un-archives the link', async () => {
    const { studentId } = await makeArchivedStudent();
    const classId = await makeClass(5);

    const res = await fetch(`${BASE_URL}/api/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken), ...freshIp() },
      body: JSON.stringify({ classId, studentId }),
    });
    await expectApplied(res, 201);
    await expectReactivated(studentId);
  });

  // Today's pre-transaction check (`route.ts`'s `targetOf`) — stays green
  // throughout this plan; the in-transaction `'missing'` branch it guards
  // against is reachable only by an unlink landing between that check and
  // the lock, which an integration test cannot pause the server to force.
  it('a roster add for a student not on the roster refuses, no registration', async () => {
    const classId = await makeClass(5);
    studentCounter += 1;
    const student = await prisma.student.create({
      data: {
        firstName: 'Unlinked',
        lastName: `Student${studentCounter}`,
        email: `archive-reactivate-unlinked-${suffix}-${studentCounter}@test.local`,
        incomeTier: 3,
      },
      select: { id: true },
    });
    fillerStudentIds.push(student.id);

    const res = await fetch(`${BASE_URL}/api/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken), ...freshIp() },
      body: JSON.stringify({ classId, studentId: student.id }),
    });
    expect(res.status).toBe(403);
    expect(
      await prisma.registration.count({ where: { classId, studentId: student.id } }),
    ).toBe(0);
  });
});
