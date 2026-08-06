import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import type { ClassStatus } from '@prisma/client';
import { uniqueSuffix } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
const classIds: string[] = [];

async function makeClass(opts: { status: ClassStatus }): Promise<{ classId: string }> {
  const cls = await prisma.class.create({
    data: {
      teacherId,
      teacherRoomId,
      classType: 'Terminal Status Test',
      date: new Date('2099-06-01'),
      startTime: '09:00',
      durationMinutes: 60,
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 8,
      status: opts.status,
    },
  });
  classIds.push(cls.id);
  return { classId: cls.id };
}

beforeAll(async () => {
  await prisma.$connect();

  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Terminal',
      lastName: 'Status',
      email: `terminal-status-${suffix}@test.local`,
      account: { create: { email: `terminal-status-${suffix}@test.local` } },
      bio: 'Terminal status trigger tests',
      pageSlug: `terminal-status-${suffix}`,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Terminal Status Studio',
      address: `${suffix} Trigger St`,
      city: 'Amsterdam',
      postcode: '1234RA',
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
  await prisma.class.deleteMany({ where: { id: { in: classIds } } });
  await prisma.teacherRoom.deleteMany({ where: { id: teacherRoomId } });
  await prisma.room.deleteMany({ where: { id: roomId } });
  await prisma.teacher.deleteMany({ where: { id: teacherId } });
  await prisma.account.deleteMany({ where: { id: accountId } });
  await prisma.$disconnect();
});

describe('class terminal status trigger', () => {
  it('refuses to change the status of a cancelled class, and says so with a matchable code', async () => {
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'cancelled' },
    });

    let caught: unknown;
    try {
      await prisma.class.update({ where: { id: classId }, data: { status: 'open' } });
    } catch (err) {
      caught = err;
    }

    // Observed directly (see api-errors.ts's isTerminalStatusViolation
    // docblock for the full transcript): the trigger's `RAISE EXCEPTION`
    // reaches Prisma as PrismaClientUnknownRequestError, not
    // PrismaClientKnownRequestError — there is no P-code for "a trigger
    // fired", so it carries no `.code`/`.meta`, only a message with the raw
    // driver text embedded, including `code: "23514"` and this trigger's own
    // wording. Asserting the class, not just a loose substring, is what
    // would have caught a regression to the wrong error shape.
    expect(caught).toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    expect(String(caught)).toMatch(/23514/);
    expect(String(caught)).toMatch(/which is terminal/);

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.status).toBe('cancelled');
  });

  it('leaves non-status updates to a completed class alone', async () => {
    const { classId } = await makeClass({ status: 'open' });
    await prisma.class.updateMany({
      where: { id: classId, status: 'open' },
      data: { status: 'in_progress' },
    });
    await prisma.class.updateMany({
      where: { id: classId, status: 'in_progress' },
      data: { status: 'completed' },
    });

    await prisma.class.update({ where: { id: classId }, data: { description: 'Edited after' } });

    const after = await prisma.class.findUniqueOrThrow({ where: { id: classId } });
    expect(after.description).toBe('Edited after');
    expect(after.status).toBe('completed');
  });
});
