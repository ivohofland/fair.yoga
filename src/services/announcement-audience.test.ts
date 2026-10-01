import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { listAnnouncementAudience } from './announcements';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const suffix = `audience-svc-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('listAnnouncementAudience', () => {
  let teacherId: string;
  let otherTeacherId: string;
  let roomId: string;
  let classIds: string[] = [];
  let liveId: string;
  let cancelledOnlyId: string;
  let archivedId: string;
  let foreignId: string;

  async function makeStudent(name: string): Promise<string> {
    const s = await prisma.student.create({
      data: {
        firstName: name,
        lastName: 'Audience',
        email: `${name.toLowerCase()}-${suffix}@test.local`,
        incomeTier: 3,
      },
    });
    return s.id;
  }

  beforeAll(async () => {
    const makeTeacher = async (name: string) =>
      (
        await prisma.teacher.create({
          data: {
            firstName: name,
            lastName: 'Teacher',
            email: `${name.toLowerCase()}-${suffix}@test.local`,
            account: { create: { email: `${name.toLowerCase()}-${suffix}@test.local` } },
            bio: 'Audience fixtures',
            pageSlug: `${name.toLowerCase()}-${suffix}`,
          },
        })
      ).id;
    teacherId = await makeTeacher('AudienceA');
    otherTeacherId = await makeTeacher('AudienceB');

    const room = await prisma.room.create({
      data: {
        venueName: 'Audience Studio',
        address: `${suffix} Street`,
        city: 'Amsterdam',
        postcode: '1000AA',
        maxCapacity: 10,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const makeClass = async (owner: string, daysAhead: number) => {
      const teacherRoom = await prisma.teacherRoom.upsert({
        where: { teacherId_roomId: { teacherId: owner, roomId } },
        create: { teacherId: owner, roomId, capacityOverride: 10, rentalRate: 30 },
        update: {},
      });
      const date = new Date();
      date.setDate(date.getDate() + daysAhead);
      date.setUTCHours(0, 0, 0, 0);
      const cls = await createClassFixture(prisma, {
        teacherId: owner,
        teacherRoomId: teacherRoom.id,
        classType: 'Vinyasa',
        date,
        startTime: hhmmToTime('10:00'),
        durationMinutes: 60,
        roomCost: 30,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      });
      classIds.push(cls.id);
      return cls.id;
    };
    const classA1 = await makeClass(teacherId, 7);
    const classA2 = await makeClass(teacherId, 14);
    const classB = await makeClass(otherTeacherId, 7);

    liveId = await makeStudent('Live');
    cancelledOnlyId = await makeStudent('Cancelled');
    archivedId = await makeStudent('Archived');
    foreignId = await makeStudent('Foreign');

    const register = (classId: string, studentId: string, status: 'registered' | 'cancelled') =>
      prisma.registration.create({ data: { classId, studentId, status, tierAtBooking: 3 } });
    await register(classA1, liveId, 'registered');
    await register(classA2, liveId, 'registered');
    await register(classA1, cancelledOnlyId, 'cancelled');
    await register(classA1, archivedId, 'registered');
    await register(classB, foreignId, 'registered');
    await prisma.teacherStudent.create({
      data: { teacherId, studentId: archivedId, isArchived: true },
    });
  });

  afterAll(async () => {
    const studentIds = [liveId, cancelledOnlyId, archivedId, foreignId].filter(Boolean);
    if (classIds.length) {
      await prisma.calendarEntry.deleteMany({ where: { classes: { some: { id: { in: classIds } } } } });
    }
    if (roomId) {
      await prisma.teacherRoom.deleteMany({ where: { roomId } });
      await prisma.room.delete({ where: { id: roomId } });
    }
    if (studentIds.length) await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
    if (otherTeacherId) await prisma.teacher.delete({ where: { id: otherTeacherId } });
    await prisma.account.deleteMany({ where: { email: { contains: `-${suffix}@test.local` } } });
    await prisma.$disconnect();
  });

  it('lists a student with live registrations once, however many they hold', async () => {
    const ids = await listAnnouncementAudience(prisma, teacherId);
    expect(ids.filter((id) => id === liveId)).toHaveLength(1);
  });

  it('excludes a student whose only registration is cancelled', async () => {
    expect(await listAnnouncementAudience(prisma, teacherId)).not.toContain(cancelledOnlyId);
  });

  it('excludes a student this teacher has archived', async () => {
    expect(await listAnnouncementAudience(prisma, teacherId)).not.toContain(archivedId);
  });

  it("does not include another teacher's students", async () => {
    const ids = await listAnnouncementAudience(prisma, teacherId);
    expect(ids).not.toContain(foreignId);
    expect(ids).toEqual([liveId]);
  });
});
