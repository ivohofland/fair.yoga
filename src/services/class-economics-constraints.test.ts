import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { hhmmToTime } from '@/lib/time-of-day';
import type { ClassEconomics } from '@/lib/class-economics';
import { createClassFixture, slotDate, slotTime } from '../../tests/class-fixtures';

/**
 * Bite tests for the six `CHECK` constraints
 * `prisma/migrations/20260924190000_class_economics_checks` adds to `Class`
 * and `ClassTemplate` (#221). Each case writes straight through Prisma,
 * bypassing Zod and the update services' `economicsViolations` check, so a
 * passing suite here means the DATABASE refuses the row — not that any
 * TypeScript guard does.
 *
 * The `toThrow` assertions match the constraint's own name (this repo's
 * identifier, not a Prisma internal), so a masking failure elsewhere (a slot
 * collision, an FK violation) cannot satisfy them.
 */
const prisma = new PrismaClient();
const uniqueSuffix = `econ-check-${Date.now()}`;

let teacherId: string;
let roomId: string;
let teacherRoomId: string;

beforeAll(async () => {
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Econ',
      lastName: 'Check',
      email: `econ-check-${uniqueSuffix}@test.local`,
      account: { create: { email: `econ-check-${uniqueSuffix}@test.local` } },
      bio: 'Test teacher for class economics CHECK constraint tests',
      pageSlug: `econ-check-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;

  const room = await prisma.room.create({
    data: {
      venueName: 'Econ Check Studio',
      address: `${uniqueSuffix} Econ Check St`,
      city: 'Amsterdam',
      postcode: '1000AB',
      floor: '1',
      roomName: 'Main',
      maxCapacity: 20,
      createdById: teacherId,
    },
  });
  roomId = room.id;

  const teacherRoom = await prisma.teacherRoom.create({
    data: { teacherId, roomId, capacityOverride: 15, rentalRate: 20 },
  });
  teacherRoomId = teacherRoom.id;
});

afterAll(async () => {
  // Guarded: an undefined filter turns deleteMany into an unfiltered
  // delete-all across the table.
  if (teacherId) {
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  }
  if (roomId) await prisma.room.delete({ where: { id: roomId } });
  if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
  await prisma.$disconnect();
});

// A fresh slot per call, per table: `Class` rows are spaced across distinct
// `slotDate`s (any startTime), `ClassTemplate` rows across distinct
// `slotTime`s (one shared dayOfWeek) — see `class-fixtures.ts`.
let classCounter = 0;
let templateCounter = 0;

function insert(table: 'Class' | 'ClassTemplate', economics: ClassEconomics) {
  if (table === 'Class') {
    classCounter += 1;
    return createClassFixture(prisma, {
      teacherId,
      teacherRoomId,
      classType: 'Econ Check',
      date: slotDate('2027-01-04', classCounter),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      ...economics,
    });
  }
  templateCounter += 1;
  return prisma.classTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId,
          kind: 'regular',
          classType: 'Econ Check',
          dayOfWeek: 3,
          startTime: hhmmToTime(slotTime(templateCounter * 70)),
          durationMinutes: 60,
          isActive: true,
        },
      },
      teacherRoom: { connect: { id: teacherRoomId } },
      description: 'Econ check template',
      ...economics,
    },
  });
}

const validEconomics: ClassEconomics = { roomCost: 20, minRate: 10, targetRate: 30, minStudents: 2, maxStudents: 10 };

// Each case overrides only what it tests; every other constraint stays
// satisfied by `validEconomics`, so the thrown name identifies the one
// constraint that fired (`maxStudents: 0` pairs with `minStudents: 0` so
// `students_order_check` doesn't fire first).
const cases = [
  ['room_cost_check', { roomCost: -1 }],
  ['min_students_range_check', { minStudents: -1 }],
  ['max_students_range_check', { maxStudents: 0, minStudents: 0 }],
  ['max_students_range_check', { maxStudents: 201 }],
  ['students_order_check', { minStudents: 11 }],
  ['rate_order_check', { minRate: 31 }],
  ['room_subsidy_check', { minRate: -21 }],
] as const;

describe.each(['Class', 'ClassTemplate'] as const)('%s economic CHECKs (#221)', (table) => {
  it.each(cases)(`${table}_%s refuses %o`, async (suffix, override) => {
    await expect(insert(table, { ...validEconomics, ...override })).rejects.toThrow(`${table}_${suffix}`);
  });

  // min ≤ max ≤ 200 already implies min ≤ 200, so no row can break
  // `min_students_range_check`'s upper bound without also breaking
  // `students_order_check` — either name may fire.
  it(`${table}_min_students_range_check refuses { minStudents: 201, maxStudents: 200 } (or students_order_check)`, async () => {
    await expect(
      insert(table, { ...validEconomics, minStudents: 201, maxStudents: 200 }),
    ).rejects.toThrow(new RegExp(`${table}_(min_students_range_check|students_order_check)`));
  });

  it('accepts minStudents 0 — the database floor is 0, Zod keeps 1', async () => {
    await expect(insert(table, { ...validEconomics, minStudents: 0 })).resolves.toBeDefined();
  });

  it('accepts a minRate subsidising exactly the room cost', async () => {
    await expect(insert(table, { ...validEconomics, minRate: -20 })).resolves.toBeDefined();
  });
});
