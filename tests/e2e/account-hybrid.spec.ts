import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

/**
 * The account-hybrid headline: a teacher attends another teacher's class
 * with their own email. Signed in as a teacher on a booking page, they set
 * up their student side in place and book like any student — no second
 * account, no dead-end sign-in form.
 */

const prisma = new PrismaClient();

const suffix = uniqueSuffix();
const hostSlug = `e2e-hybrid-host-${suffix}`;

let hostTeacherId: string;
let guestAccountId: string;
let guestToken: string;
let onlookerToken: string;
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
        email: `e2e-hybrid-host-${suffix}@test.local`,
        bio: 'Host fixtures',
        pageSlug: hostSlug,
        account: { create: { email: `e2e-hybrid-host-${suffix}@test.local` } },
      },
    });
    hostTeacherId = host.id;

    const room = await prisma.room.create({
      data: {
        venueName: 'Hybrid Studio',
        address: `${suffix} Hybrid St`,
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
    const cls = await createClassFixture(prisma, {
        teacherId: hostTeacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'Hybrid Vinyasa',
        date: new Date(Date.UTC(soon.getUTCFullYear(), soon.getUTCMonth(), soon.getUTCDate())),
        startTime: hhmmToTime('09:00'),
        durationMinutes: 60,
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        status: 'open',
      });
    classId = cls.id;

    // Guest: a teacher-only account, signed in, who wants to attend.
    const guest = await prisma.teacher.create({
      data: {
        firstName: 'Guest',
        lastName: 'Teacher',
        email: `e2e-hybrid-guest-${suffix}@test.local`,
        bio: 'Guest fixtures',
        pageSlug: `e2e-hybrid-guest-${suffix}`,
        account: { create: { email: `e2e-hybrid-guest-${suffix}@test.local` } },
      },
    });
    guestAccountId = guest.accountId;
    guestToken = await seedSession(prisma, guestAccountId);

    // A student-only account, for the mirror redirect assertion.
    const onlooker = await prisma.student.create({
      data: {
        firstName: 'Onlooker',
        lastName: 'Student',
        email: `e2e-hybrid-onlooker-${suffix}@test.local`,
        claimedAt: new Date(),
        account: { create: { email: `e2e-hybrid-onlooker-${suffix}@test.local` } },
      },
    });
    onlookerToken = await seedSession(prisma, onlooker.accountId!);
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId: hostTeacherId } });
    await prisma.session.deleteMany({ where: { accountId: guestAccountId } });
    // Guarded, because the delete widened at #327. `class.deleteMany({ where:
    // { teacherId } })` used to sit here; the calendar identity moved, so it is
    // the ENTRY that carries `teacherId` and the entry that has to go (the
    // classes ride its cascade). Prisma DROPS an `undefined` where-clause
    // rather than matching nothing, and Playwright runs `afterAll` even when
    // `beforeAll` threw before this id was assigned — so the unguarded form
    // used to empty `Class` and would now empty BOTH families' calendars for
    // every teacher in the database.
    if (hostTeacherId) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: hostTeacherId } });
    }
    await prisma.teacherRoom.deleteMany({ where: { teacherId: hostTeacherId } });
    await prisma.room.deleteMany({ where: { address: { contains: suffix } } });
    await prisma.student.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.teacher.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.account.deleteMany({ where: { email: { contains: suffix } } });
    await prisma.$disconnect();
  });

  test('wrong-profile navigation lands on the other home, not a sign-in form', async ({
    page,
    context,
  }) => {
    // Teacher-only session on a student surface → teacher home.
    await context.addCookies([sessionCookie(guestToken)]);
    await page.goto('/bookings');
    await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });

    // Student-only session on a teacher surface → their bookings.
    await context.clearCookies();
    await context.addCookies([sessionCookie(onlookerToken)]);
    await page.goto('/inbox');
    await page.waitForURL('**/bookings', { timeout: 10_000 });

    // /settings is the courteous exception: it maps to their own settings.
    await page.goto('/settings');
    await page.waitForURL('**/account', { timeout: 10_000 });
  });

  test('a signed-in teacher joins as a student and books, in place', async ({
    page,
    context,
  }) => {
    await context.addCookies([sessionCookie(guestToken)]);

    // Not a dead end anymore: the join panel replaces the sign-in form.
    await page.goto(`/${hostSlug}/book/${classId}`);
    await expect(page.getByText(/signed in as Guest/)).toBeVisible();
    await expect(page.getByText('First time here?')).toHaveCount(0);

    await page.getByRole('button', { name: 'Join as a student' }).click();

    // The normal booking flow takes over; pick a tier and book.
    await expect(page.getByText('Your tier')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('radio', { name: /Tier 2/ }).click();
    await page.getByRole('button', { name: /^Book — around/ }).click();
    await expect(page.getByText("You're in", { exact: true })).toBeVisible();

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
