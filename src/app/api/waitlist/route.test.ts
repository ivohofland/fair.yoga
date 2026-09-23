import { describe, it, expect, beforeAll, afterAll, vi, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { Prisma, PrismaClient } from '@prisma/client';
import * as dbLocks from '@/lib/db-locks';
import { prisma as appPrisma } from '@/lib/db';
import { log } from '@/lib/log';
import { cookie, seedSession, uniqueSuffix } from '../../../../tests/helpers';
import { createClassFixture } from '../../../../tests/class-fixtures';
import { expectRefusal } from '../../../../tests/api-assertions';
import { POST } from './route';

/**
 * A student erased between the session check and the join's `Student` lock.
 * A live session never belongs to an erased profile, so the erasure is stood
 * in for at the lock; the service and the route that map it are real.
 */
const prisma = new PrismaClient();
const suffix = uniqueSuffix();

describe('POST /api/waitlist — a student erased under the join', () => {
  let teacherId: string;
  let roomId: string;
  let classId: string;
  let studentId: string;
  let token: string;
  const accountIds: string[] = [];

  beforeAll(async () => {
    const teacherEmail = `wl-erased-teacher-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Wl', lastName: 'Erased',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'waitlist-route erased-join fixture teacher',
        pageSlug: `wl-erased-${suffix}`,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Wl Erased Studio', address: `${suffix} Erased St`, city: 'Amsterdam',
        postcode: '1234WE', floor: '1', roomName: 'Main', maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 25 },
      select: { id: true },
    });

    const cls = await createClassFixture(prisma, {
      teacherId, teacherRoomId: teacherRoom.id,
      classType: 'Wl Erased Vinyasa',
      date: new Date('2099-08-10'),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
      roomCost: 25, minRate: 15, targetRate: 25,
      minStudents: 1, maxStudents: 1,
      status: 'open',
    });
    classId = cls.id;

    const studentEmail = `wl-erased-student-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Wl', lastName: 'Erased',
        email: studentEmail, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email: studentEmail } },
      },
      select: { id: true, accountId: true },
    });
    studentId = student.id;
    const studentAccountId = student.accountId;
    if (!studentAccountId) throw new Error('fixture: the claimed student has no account');
    accountIds.push(studentAccountId);
    token = await seedSession(prisma, studentAccountId);
  });

  afterAll(async () => {
    await prisma.waitlistEntry.deleteMany({ where: { classId } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.deleteMany({ where: { id: roomId } });
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.student.deleteMany({ where: { id: studentId } });
    await prisma.teacher.deleteMany({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    await prisma.$disconnect();
  });

  it('is refused with its code, and writes nothing', async () => {
    const gate = vi
      .spyOn(dbLocks, 'lockLiveStudent')
      .mockRejectedValueOnce(new dbLocks.StudentErasedError(studentId));
    onTestFinished(() => gate.mockRestore());

    const res = await POST(new NextRequest('http://localhost:3000/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify({ classId }),
    }));

    expect(gate).toHaveBeenCalledTimes(1);
    await expectRefusal(res, 'STUDENT_ERASED');
    expect(await prisma.waitlistEntry.count({ where: { studentId } })).toBe(0);
    expect(await prisma.teacherStudent.count({ where: { studentId } })).toBe(0);
  });
});

/**
 * The `tierSelectedAt` write after a successful join, per
 * `registrations/route.test.ts`'s identical fixture for the booking route —
 * two transient kinds, one message: `tx_budget` (`P2028`) logs at `warn` and
 * `pool_exhausted` (`P2024`) at `error`, per `TRANSIENT_KIND_LEVEL`
 * (`lib/api-errors.ts`).
 *
 * A separate `PrismaClient` and its own `describe`, not a case added to the
 * erased-join suite above: joining the waitlist requires the class to already
 * be FULL (`class_not_full` is one of `addToWaitlist`'s refusals), which that
 * suite's fixture — built for an early `lockLiveStudent` rejection — never
 * needs and does not provide.
 */
describe('POST /api/waitlist — a failed tier-marker write after the join committed', () => {
  const db = new PrismaClient();
  const suffix2 = uniqueSuffix();
  let teacherId: string;
  let roomId: string;
  let classId: string;
  const accountIds: string[] = [];
  const studentIds: string[] = [];

  beforeAll(async () => {
    const teacherEmail = `wl-marker-teacher-${suffix2}@test.local`;
    const teacher = await db.teacher.create({
      data: {
        firstName: 'Wl', lastName: 'Marker',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'waitlist-route marker-write fixture teacher',
        pageSlug: `wl-marker-${suffix2}`,
        defaultTimezone: 'UTC',
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    accountIds.push(teacher.accountId);

    const room = await db.room.create({
      data: {
        venueName: 'Wl Marker Studio', address: `${suffix2} Marker St`, city: 'Amsterdam',
        postcode: '1234WM', floor: '1', roomName: 'Main', maxCapacity: 20,
        createdById: teacherId,
      },
      select: { id: true },
    });
    roomId = room.id;
    const teacherRoom = await db.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 20, rentalRate: 25 },
      select: { id: true },
    });

    const cls = await createClassFixture(db, {
      teacherId, teacherRoomId: teacherRoom.id,
      classType: 'Wl Marker Vinyasa',
      date: new Date('2099-08-11'),
      startTime: new Date('1970-01-01T10:00:00Z'),
      durationMinutes: 60,
      roomCost: 25, minRate: 15, targetRate: 25,
      minStudents: 1, maxStudents: 1,
      status: 'open',
    });
    classId = cls.id;

    // Fills the one seat, so a later join is only ever eligible for the
    // waitlist — `addToWaitlist` refuses `class_not_full` otherwise.
    const fillerEmail = `wl-marker-filler-${suffix2}@test.local`;
    const filler = await db.student.create({
      data: {
        firstName: 'Wl', lastName: 'Filler',
        email: fillerEmail, incomeTier: 3,
      },
      select: { id: true },
    });
    studentIds.push(filler.id);
    await db.registration.create({
      data: { classId, studentId: filler.id, status: 'registered', tierAtBooking: 3 },
    });
  });

  afterAll(async () => {
    await db.waitlistEntry.deleteMany({ where: { classId } });
    await db.registration.deleteMany({ where: { classId } });
    await db.calendarEntry.deleteMany({ where: { teacherId } });
    await db.teacherStudent.deleteMany({ where: { teacherId } });
    await db.teacherRoom.deleteMany({ where: { teacherId } });
    await db.room.deleteMany({ where: { id: roomId } });
    await db.session.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.student.deleteMany({ where: { id: { in: studentIds } } });
    await db.teacher.deleteMany({ where: { id: teacherId } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
    await db.$disconnect();
  });

  it.each([
    { kind: 'tx_budget' as const, level: 'warn' as const, code: 'P2028' as const },
    { kind: 'pool_exhausted' as const, level: 'error' as const, code: 'P2024' as const },
  ])('answers 201 and logs a $kind failure at $level', async ({ kind, level, code }) => {
    const email = `wl-marker-${kind}-${suffix2}@test.local`;
    const student = await db.student.create({
      data: {
        firstName: 'Wl', lastName: kind,
        email, incomeTier: 3, claimedAt: new Date(),
        account: { create: { email } },
      },
      select: { id: true, accountId: true },
    });
    const accountId = student.accountId;
    if (!accountId) throw new Error('fixture: the claimed student has no account');
    studentIds.push(student.id);
    accountIds.push(accountId);
    const markerToken = await seedSession(db, accountId);

    const failure = new Prisma.PrismaClientKnownRequestError('transient', {
      code,
      clientVersion: Prisma.prismaVersion.client,
    });
    const markerWrite = vi.spyOn(appPrisma.student, 'updateMany').mockRejectedValueOnce(failure);
    onTestFinished(() => markerWrite.mockRestore());
    const spy = vi.spyOn(log, level).mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => spy.mockRestore());
    const otherLevel = level === 'warn' ? 'error' : 'warn';
    const other = vi.spyOn(log, otherLevel).mockImplementation(() => undefined as unknown as void);
    onTestFinished(() => other.mockRestore());

    const res = await POST(new NextRequest('http://localhost:3000/api/waitlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(markerToken) },
      body: JSON.stringify({ classId }),
    }));

    expect(markerWrite).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(201);
    const entry = await db.waitlistEntry.findFirst({
      where: { classId, studentId: student.id },
      select: { id: true, status: true },
    });
    expect(entry?.status).toBe('waiting');
    const message = 'waitlist join committed but its tierSelectedAt write failed';
    expect(spy).toHaveBeenCalledWith(
      {
        err: failure,
        studentId: student.id,
        classId,
        entryId: entry?.id,
        transient: true,
        transientKind: kind,
      },
      message,
    );
    expect(other).not.toHaveBeenCalledWith(expect.anything(), message);
  });
});
