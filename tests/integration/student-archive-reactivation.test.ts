/**
 * Every act that makes a `(teacher, student)` pair live un-archives the
 * pair's `TeacherStudent` link. The rule, and which acts it covers, is
 * `docs/data-model.md` (TeacherStudent); this file drives the acts through
 * the API; acts it does not drive are covered at the service level,
 * beside their own fixtures (`src/services/waitlist.test.ts`).
 */
import { describe, it, expect, beforeAll, afterAll, onTestFinished } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { BASE_URL, cookie, freshIp, seedSession, teardownStudent, uniqueSuffix } from '../helpers';
import { createClassFixture, slotTime, wallSlotAt } from '../class-fixtures';
import { hhmmToTime } from '@/lib/time-of-day';
import { expectApplied, expectRefusal } from '../api-assertions';

const prisma = new PrismaClient();
/** Holds a transaction open while `prisma` observes and seeds. */
const holder = new PrismaClient();
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
      defaultTimezone: 'UTC',
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
  await holder.$disconnect();
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
    // Walk-ins are a class-time phenomenon: move the class's start ten minutes
    // ahead, inside `WALK_IN_WINDOW_MINUTES`. The teacher's zone is UTC, so the
    // wall slot names one instant on any night.
    const { date, startTime } = wallSlotAt(new Date(Date.now() + 10 * 60_000), 'UTC');
    const { calendarEntryId } = await prisma.class.findUniqueOrThrow({
      where: { id: classId },
      select: { calendarEntryId: true },
    });
    await prisma.calendarEntry.update({ where: { id: calendarEntryId }, data: { date, startTime } });

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

  // Refused by the pre-transaction check (`route.ts`'s `targetOf`). The
  // in-transaction `'missing'` branch is the next test's.
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
  // The unlink lands after `targetOf` read the committed link but before the
  // transaction locks it: an uncommitted `DELETE` of the link row, held on a
  // second client, parks the request's `FOR UPDATE` behind it. Committing
  // once the request is seen waiting leaves the lock returning no row. The
  // hold ends within `WAIT_MS` of the request parking, inside the 2s
  // `lock_timeout` the booking runs under (`lockClassRow`).
  it('a roster add whose student unlinks while it waits on the link refuses, no registration', async () => {
    const { studentId } = await makeArchivedStudent();
    const classId = await makeClass(5);
    const WAIT_MS = 1_500;

    let holderPid = 0;
    let parked!: () => void;
    const isParked = new Promise<void>((r) => { parked = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const holding = holder.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const [own] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        if (own === undefined) throw new Error('pg_backend_pid returned no row');
        holderPid = own.pid;
        await tx.$executeRaw`
          DELETE FROM "TeacherStudent"
           WHERE "teacherId" = ${teacherId} AND "studentId" = ${studentId}`;
        parked();
        await released;
      },
      { timeout: 10_000 },
    );
    await isParked;

    const adding = fetch(`${BASE_URL}/api/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken), ...freshIp() },
      body: JSON.stringify({ classId, studentId }),
    });
    let waited = false;
    try {
      const deadline = Date.now() + WAIT_MS;
      while (!waited && Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
        waited = (row?.n ?? 0) > 0;
        if (!waited) await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      release();
      await holding;
    }

    const res = await adding;
    // One assertion over all three, so a failure shows whether the request
    // ever parked alongside what it answered and wrote.
    expect({
      waited,
      status: res.status,
      registrations: await prisma.registration.count({ where: { classId, studentId } }),
    }).toEqual({ waited: true, status: 403, registrations: 0 });
  }, 30_000);

  // `linkTeacherStudent`'s own gap: the holder takes the link row's lock, so
  // the booking's `INSERT … ON CONFLICT DO NOTHING` passes the committed row
  // and the request parks on its `FOR UPDATE`. Deleting the row and
  // committing leaves that lock returning none. Same timing bound as the
  // roster-add case above.
  it('a self-booking whose link is deleted while it waits on the link answers CONCURRENT_MODIFICATION, no registration', async () => {
    const { studentId, token } = await makeArchivedStudent();
    const classId = await makeClass(5);
    const WAIT_MS = 1_500;

    let holderPid = 0;
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => { locked = r; });
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    const holding = holder.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const [own] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid()::int AS pid`;
        if (own === undefined) throw new Error('pg_backend_pid returned no row');
        holderPid = own.pid;
        await tx.$queryRaw`
          SELECT id FROM "TeacherStudent"
           WHERE "teacherId" = ${teacherId} AND "studentId" = ${studentId}
           FOR UPDATE`;
        locked();
        await released;
        await tx.$executeRaw`
          DELETE FROM "TeacherStudent"
           WHERE "teacherId" = ${teacherId} AND "studentId" = ${studentId}`;
      },
      { timeout: 10_000 },
    );
    await isLocked;

    const booking = fetch(`${BASE_URL}/api/registrations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token), ...freshIp() },
      body: JSON.stringify({ classId }),
    });
    let waited = false;
    try {
      const deadline = Date.now() + WAIT_MS;
      while (!waited && Date.now() < deadline) {
        const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE wait_event_type = 'Lock'
             AND ${holderPid} = ANY(pg_blocking_pids(pid))`;
        waited = (row?.n ?? 0) > 0;
        if (!waited) await new Promise((r) => setTimeout(r, 25));
      }
    } finally {
      release();
      await holding;
    }

    const res = await booking;
    expect(waited).toBe(true);
    await expectRefusal(res, 'CONCURRENT_MODIFICATION');
    expect(await prisma.registration.count({ where: { classId, studentId } })).toBe(0);
  }, 30_000);
});
