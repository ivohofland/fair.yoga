import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';

/**
 * The account-hybrid headline: a teacher attends another teacher's class
 * with their own email. Signed in as a teacher on a booking page, they set
 * up their student side in place and book like any student — no second
 * account, no dead-end sign-in form.
 */

const prisma = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const hostSlug = `e2e-hybrid-host-${uniqueSuffix}`;
const guestToken = crypto.randomBytes(32).toString('hex');

let hostTeacherId: string;
let guestAccountId: string;
let roomId: string;
let classId: string;

test.describe('Account hybrid: teacher joins a class', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();

    // Host: the teacher whose class is being booked.
    const host = await prisma.teacher.create({
      data: {
        firstName: 'Hybrid',
        lastName: 'Host',
        email: `e2e-hybrid-host-${uniqueSuffix}@test.local`,
        bio: 'Host fixtures',
        pageSlug: hostSlug,
        account: { create: { email: `e2e-hybrid-host-${uniqueSuffix}@test.local` } },
      },
    });
    hostTeacherId = host.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Hybrid Studio',
        address: `${uniqueSuffix} Hybrid St`,
        city: 'Amsterdam',
        postcode: '1234HY',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: hostTeacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: hostTeacherId, roomId, capacityOverride: 12, rentalRate: 25 },
    });

    const soon = new Date();
    soon.setUTCDate(soon.getUTCDate() + 7);
    const cls = await prisma.class.create({
      data: {
        teacherId: hostTeacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Hybrid Vinyasa',
        date: new Date(Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate())),
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      },
    });
    classId = cls.id;

    // Guest: a teacher-only account, signed in, who wants to attend.
    const guest = await prisma.teacher.create({
      data: {
        firstName: 'Guest',
        lastName: 'Teacher',
        email: `e2e-hybrid-guest-${uniqueSuffix}@test.local`,
        bio: 'Guest fixtures',
        pageSlug: `e2e-hybrid-guest-${uniqueSuffix}`,
        account: { create: { email: `e2e-hybrid-guest-${uniqueSuffix}@test.local` } },
      },
    });
    guestAccountId = guest.accountId;
    await prisma.session.create({
      data: {
        id: hashToken(guestToken),
        accountId: guestAccountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: hostTeacherId } });
    await prisma.session.deleteMany({ where: { accountId: guestAccountId } });
    await prisma.class.deleteMany({ where: { teacherId: hostTeacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId: hostTeacherId } });
    await prisma.room.deleteMany({ where: { address: { contains: uniqueSuffix } } });
    await prisma.student.deleteMany({ where: { email: { contains: uniqueSuffix } } });
    await prisma.teacher.deleteMany({ where: { email: { contains: uniqueSuffix } } });
    await prisma.account.deleteMany({ where: { email: { contains: uniqueSuffix } } });
    await prisma.$disconnect();
  });

  test('a signed-in teacher joins as a student and books, in place', async ({
    page,
    context,
  }) => {
    await context.addCookies([
      { name: 'fair_yoga_session', value: guestToken, url: 'http://localhost:3000' },
    ]);

    // Not a dead end anymore: the join panel replaces the sign-in form.
    await page.goto(`/${hostSlug}/book/${classId}`);
    await expect(page.getByText(/signed in as Guest/)).toBeVisible();
    await expect(page.getByText('First time here?')).toHaveCount(0);

    await page.getByRole('button', { name: 'Join as a student' }).click();

    // The normal booking flow takes over; pick a tier and book.
    await expect(page.getByText('Your tier')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('radio', { name: /Tier 2/ }).click();
    await page.getByRole('button', { name: /^Book — around/ }).click();
    await expect(page.getByText("You're in")).toBeVisible();

    // One human, one account, two profiles — and a real registration.
    const student = await prisma.student.findFirst({
      where: { accountId: guestAccountId },
    });
    expect(student).not.toBeNull();
    expect(student!.firstName).toBe('Guest');
    expect(student!.claimedAt).not.toBeNull();
    const registration = await prisma.registration.findFirst({
      where: { classId, studentId: student!.id },
    });
    expect(registration).not.toBeNull();
    expect(registration!.tierAtBooking).toBe(2);

    // The two sides now link to each other.
    await page.goto('/settings');
    await expect(page.getByText('Your bookings as a student')).toBeVisible();
    await page.goto('/account');
    await expect(page.getByText('Your teaching side')).toBeVisible();
  });
});
