/**
 * `WaitlistEntry_waiting_position_key`: a partial unique index on
 * `(classId, position) WHERE status = 'waiting'`. Hand-authored — Prisma cannot
 * express the predicate — so these tests are the only thing that notices it
 * missing. Why it is partial and immediate: `docs/data-model.md` (WaitlistEntry).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, type WaitlistStatus } from '@prisma/client';
import crypto from 'crypto';
import { hhmmToTime } from '@/lib/time-of-day';
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { createClassFixture } from '../../tests/class-fixtures';

const prisma = new PrismaClient();
const suffix = `wl-pos-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

let teacherId: string;
let accountId: string;
let roomId: string;
let classA: string;
let classB: string;
const studentIds: string[] = [];

beforeAll(async () => {
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Position',
      lastName: 'Teacher',
      email: `${suffix}@test.local`,
      account: { create: { email: `${suffix}@test.local` } },
      bio: 'Waiting-position index fixture',
      pageSlug: suffix,
    },
    select: { id: true, accountId: true },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;
  const room = await prisma.room.create({
    data: {
      venueName: 'Position Studio',
      address: `${suffix} St`,
      city: 'Amsterdam',
      postcode: '1234PS',
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
  const makeClass = async (date: string) =>
    (
      await createClassFixture(prisma, {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Position class',
        date: new Date(date),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 1,
        maxStudents: 1,
        status: 'open',
      })
    ).id;
  classA = await makeClass('2099-06-01');
  classB = await makeClass('2099-06-02');
  for (let i = 0; i < 6; i++) {
    const s = await prisma.student.create({
      data: { firstName: 'Position', lastName: `S${i}`, email: `${suffix}-s${i}@test.local`, incomeTier: 3 },
      select: { id: true },
    });
    studentIds.push(s.id);
  }
});

afterAll(async () => {
  await prisma.calendarEntry.deleteMany({ where: { teacherId } });
  await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

const entry = (classId: string, student: number, position: number, status: WaitlistStatus) =>
  prisma.waitlistEntry.create({
    data: { classId, studentId: studentIds[student]!, position, status },
  });

describe('WaitlistEntry_waiting_position_key', () => {
  it('refuses a second waiting row at a position its class already holds', async () => {
    await entry(classA, 0, 1, 'waiting');
    const err = await entry(classA, 1, 1, 'waiting').catch((e: unknown) => e);
    expect(isUniqueConflictOn(err, ['classId', 'position'])).toBe(true);
  });

  it('accepts a waiting row at a position a closed row still holds', async () => {
    await entry(classA, 2, 2, 'removed');
    await expect(entry(classA, 3, 2, 'waiting')).resolves.toBeTruthy();
  });

  it('accepts two closed rows at one position', async () => {
    await entry(classA, 4, 3, 'removed');
    await expect(entry(classA, 5, 3, 'expired')).resolves.toBeTruthy();
  });

  it('accepts one waiting position in two different classes', async () => {
    await expect(entry(classB, 0, 1, 'waiting')).resolves.toBeTruthy();
  });
});
