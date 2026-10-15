import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate, slotTime } from '../../tests/class-fixtures';
import { createPrismaClient } from '@/lib/prisma-client';

/**
 * Bite tests for the VAT `CHECK` constraints
 * `prisma/migrations/*_class_vat` adds (#819). Each case writes straight
 * through Prisma, so a passing suite means the DATABASE refuses the row. The
 * `toThrow` assertions match the constraint's own name, so a masking failure
 * elsewhere cannot satisfy them.
 */
const prisma = createPrismaClient();
const uniqueSuffix = `vat-check-${Date.now()}`;

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
let studentId: string;

beforeAll(async () => {
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Vat',
      lastName: 'Check',
      email: `${uniqueSuffix}@test.local`,
      account: { create: { email: `${uniqueSuffix}@test.local` } },
      bio: 'Test teacher for VAT CHECK constraint tests',
      pageSlug: uniqueSuffix,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Vat Check Studio',
      address: `${uniqueSuffix} Vat Check St`,
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

  const student = await prisma.student.create({
    data: {
      firstName: 'Vat',
      lastName: 'Student',
      email: `${uniqueSuffix}-student@test.local`,
      incomeTier: 3,
    },
  });
  studentId = student.id;
});

afterAll(async () => {
  // Guarded: an undefined filter turns deleteMany into an unfiltered
  // delete-all across the table.
  if (teacherId) {
    await prisma.payment.deleteMany({ where: { registration: { class: { calendarEntry: { teacherId } } } } });
    await prisma.registration.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  }
  if (studentId) await prisma.student.deleteMany({ where: { id: studentId } });
  if (roomId) await prisma.room.delete({ where: { id: roomId } });
  if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
  if (accountId) await prisma.account.delete({ where: { id: accountId } });
  await prisma.$disconnect();
});

let classCounter = 0;
let templateCounter = 0;

const economics = { roomCost: 20, minRate: 10, targetRate: 30, minStudents: 2, maxStudents: 10 };

function insertClass(extra: Record<string, unknown> = {}) {
  classCounter += 1;
  return createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Vat Check',
    date: slotDate('2027-03-01', classCounter),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    ...economics,
    ...extra,
  });
}

function insertTemplate(vatPercent: number) {
  templateCounter += 1;
  return prisma.classTemplate.create({
    data: {
      scheduleRule: {
        create: {
          teacherId,
          kind: 'regular',
          classType: 'Vat Check',
          dayOfWeek: 3,
          startTime: hhmmToTime(slotTime(templateCounter * 70)),
          durationMinutes: 60,
          isActive: true,
        },
      },
      teacherRoom: { connect: { id: teacherRoomId } },
      description: 'Vat check template',
      ...economics,
      vatPercent,
    },
  });
}

describe('VAT percent range (#819)', () => {
  it('Class_vat_percent_range_check refuses 100.001', async () => {
    await expect(insertClass({ vatPercent: 100.001 })).rejects.toThrow('Class_vat_percent_range_check');
  });

  it('ClassTemplate_vat_percent_range_check refuses 100.001', async () => {
    await expect(insertTemplate(100.001)).rejects.toThrow('ClassTemplate_vat_percent_range_check');
  });

  it('accepts 100 on a class', async () => {
    await expect(insertClass({ vatPercent: 100 })).resolves.toBeDefined();
  });

  it('keeps three decimals: 14.975 reads back as 14.975', async () => {
    const cls = await insertClass({ vatPercent: 14.975 });
    const read = await prisma.class.findUniqueOrThrow({ where: { id: cls.id } });
    expect(read.vatPercent.toString()).toBe('14.975');
  });
});

describe('Class VAT snapshot (#819)', () => {
  it('Class_vat_total_snapshot_check refuses totalRevenue without vatTotal', async () => {
    const cls = await insertClass();
    await expect(
      prisma.class.update({ where: { id: cls.id }, data: { totalRevenue: 10 } }),
    ).rejects.toThrow('Class_vat_total_snapshot_check');
  });

  it('Class_vat_total_nonnegative_check refuses a negative vatTotal', async () => {
    const cls = await insertClass();
    await expect(
      prisma.class.update({ where: { id: cls.id }, data: { totalRevenue: 10, vatTotal: -1 } }),
    ).rejects.toThrow('Class_vat_total_nonnegative_check');
  });

  it('accepts totalRevenue and vatTotal written together', async () => {
    const cls = await insertClass();
    await expect(
      prisma.class.update({ where: { id: cls.id }, data: { totalRevenue: 10, vatTotal: 0 } }),
    ).resolves.toBeDefined();
  });
});

describe('Payment VAT amount (#819)', () => {
  async function registration() {
    const cls = await insertClass();
    return prisma.registration.create({
      data: { classId: cls.id, studentId, status: 'registered', tierAtBooking: 3, price: 5 },
    });
  }

  it('Payment_vat_amount_range_check refuses a vatAmount above the amount', async () => {
    const reg = await registration();
    await expect(
      prisma.payment.create({ data: { registrationId: reg.id, amount: 5, vatAmount: 5.01 } }),
    ).rejects.toThrow('Payment_vat_amount_range_check');
  });

  it('accepts a vatAmount equal to the amount', async () => {
    const reg = await registration();
    await expect(
      prisma.payment.create({ data: { registrationId: reg.id, amount: 5, vatAmount: 5 } }),
    ).resolves.toBeDefined();
  });
});
