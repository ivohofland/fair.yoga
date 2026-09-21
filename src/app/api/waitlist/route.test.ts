import { describe, it, expect, beforeAll, afterAll, vi, onTestFinished } from 'vitest';
import { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import * as dbLocks from '@/lib/db-locks';
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
