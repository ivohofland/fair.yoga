import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture, slotDate } from '../../tests/class-fixtures';
import { createPrismaClient } from '@/lib/prisma-client';

/**
 * Bite tests for the CHECKs `prisma/migrations/<ts>_donation_checks` adds
 * (#912). Each write bypasses every service, so a pass means the DATABASE
 * refuses the row. Assertions match the constraint's own name, so an
 * unrelated failure (a slot collision, an FK) cannot satisfy them.
 */
const prisma = createPrismaClient();
const uniqueSuffix = `donation-check-${Date.now()}`;

let teacherId: string;
let accountId: string;
let roomId: string;
let teacherRoomId: string;
let studentId: string;
let studentAccountId: string;

beforeAll(async () => {
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Donation',
      lastName: 'Check',
      email: `donation-check-${uniqueSuffix}@test.local`,
      account: { create: { email: `donation-check-${uniqueSuffix}@test.local` } },
      bio: 'Test teacher for donation CHECK constraint tests',
      pageSlug: `donation-check-${uniqueSuffix}`,
    },
  });
  teacherId = teacher.id;
  accountId = teacher.accountId;

  const room = await prisma.room.create({
    data: {
      venueName: 'Donation Check Studio',
      address: `${uniqueSuffix} Donation Check St`,
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
      firstName: 'Donation',
      lastName: 'Student',
      claimedAt: new Date(),
      email: `donation-student-${uniqueSuffix}@test.local`,
      account: { create: { email: `donation-student-${uniqueSuffix}@test.local` } },
    },
  });
  studentId = student.id;
  studentAccountId = student.accountId ?? '';
});

afterAll(async () => {
  // Guarded: an undefined filter turns deleteMany into an unfiltered
  // delete-all across the table.
  if (teacherId) {
    await prisma.registration.deleteMany({ where: { class: { calendarEntry: { teacherId } } } });
    await prisma.calendarEntry.deleteMany({ where: { teacherId } });
    await prisma.scheduleRule.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
  }
  if (roomId) await prisma.room.delete({ where: { id: roomId } });
  if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
  if (accountId) await prisma.account.delete({ where: { id: accountId } });
  if (studentId) await prisma.student.delete({ where: { id: studentId } });
  if (studentAccountId) await prisma.account.delete({ where: { id: studentAccountId } });
  await prisma.$disconnect();
});

let counter = 0;
const makeClass = (data: { pricingMode: 'tiered' | 'donation'; donationTotal?: number | null }) => {
  counter += 1;
  return createClassFixture(prisma, {
    teacherId,
    teacherRoomId,
    classType: 'Donation Check',
    date: slotDate('2027-02-01', counter),
    startTime: hhmmToTime('09:00'),
    durationMinutes: 60,
    roomCost: 20,
    minRate: 0,
    targetRate: 0,
    minStudents: 1,
    maxStudents: 10,
    status: 'completed',
    ...data,
  });
};

describe('Class donation CHECKs (#912)', () => {
  it('Class_donation_total_nonnegative_check refuses a negative total (#912)', async () => {
    await expect(makeClass({ pricingMode: 'donation', donationTotal: -0.01 })).rejects.toThrow(
      'Class_donation_total_nonnegative_check',
    );
  });
  it('Class_donation_total_mode_check refuses a total on a tiered class (#912)', async () => {
    await expect(makeClass({ pricingMode: 'tiered', donationTotal: 10 })).rejects.toThrow(
      'Class_donation_total_mode_check',
    );
  });
  it('accepts a zero total on a donation class, and a null one on either mode (#912)', async () => {
    await expect(makeClass({ pricingMode: 'donation', donationTotal: 0 })).resolves.toBeDefined();
    await expect(makeClass({ pricingMode: 'donation', donationTotal: null })).resolves.toBeDefined();
    await expect(makeClass({ pricingMode: 'tiered', donationTotal: null })).resolves.toBeDefined();
  });
  it('accepts minRate = targetRate = 0 under every economics CHECK (#912)', async () => {
    await expect(makeClass({ pricingMode: 'donation' })).resolves.toBeDefined();
  });
});

describe('Registration donation CHECK (#912)', () => {
  it('Registration_donation_hidden_requires_invited_check refuses a hide without an invitation (#912)', async () => {
    const cls = await makeClass({ pricingMode: 'donation' });
    await expect(
      prisma.registration.create({
        data: { classId: cls.id, studentId, tierAtBooking: 3, donationPromptHiddenAt: new Date() },
      }),
    ).rejects.toThrow('Registration_donation_hidden_requires_invited_check');
  });
  it('accepts a hide after an invitation (#912)', async () => {
    const cls = await makeClass({ pricingMode: 'donation' });
    await expect(
      prisma.registration.create({
        data: {
          classId: cls.id,
          studentId,
          tierAtBooking: 3,
          donationInvitedAt: new Date(),
          donationPromptHiddenAt: new Date(),
        },
      }),
    ).resolves.toBeDefined();
  });
});
