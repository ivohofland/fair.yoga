import { test, expect, type BrowserContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher, accountIdOfStudent } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';

/**
 * Accessibility sweep: axe-core over the key screens, failing on any
 * serious/critical violation — color-contrast included: the palette's
 * text tokens (brown-light, gold-deep, danger) were darkened to clear
 * WCAG AA on every surface they sit on, so contrast is CI-enforced.
 */

const prisma = new PrismaClient();

const suffix = uniqueSuffix();
const slug = `e2e-a11y-${suffix}`;

let teacherId: string;
let roomId: string;
let classId: string;
let studentId: string;
let teacherToken: string;
let studentToken: string;

async function signIn(context: BrowserContext, token: string): Promise<void> {
  await context.addCookies([sessionCookie(token)]);
}

async function expectNoSeriousViolations(page: import('@playwright/test').Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const serious = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical',
  );
  expect(
    serious.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.length })),
  ).toEqual([]);
}

test.describe('Accessibility sweep', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Axe',
        lastName: 'Teacher',
        email: `e2e-a11y-teacher-${suffix}@test.local`,
        account: { create: { email: `e2e-a11y-teacher-${suffix}@test.local` } },
        bio: 'Accessibility sweep fixtures',
        pageSlug: slug,
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacherId));

    const room = await prisma.room.create({
      data: {
        venueName: 'Axe Studio',
        address: `${suffix} Axe St`,
        city: 'Amsterdam',
        postcode: '1234AX',
        floor: '1',
        roomName: 'Main',
        maxCapacity: 20,
        createdById: teacherId,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId, roomId, capacityOverride: 12, rentalRate: 30 },
    });

    const cls = await prisma.class.create({
      data: {
        teacherId,
        teacherRoomId: teacherRoom.id,
        classType: 'A11y Vinyasa',
        date: new Date('2099-06-01'),
        startTime: hhmmToTime('09:00'),
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

    const student = await prisma.student.create({
      data: {
        firstName: 'Axe',
        lastName: 'Student',
        email: `e2e-a11y-student-${suffix}@test.local`,
        account: { create: { email: `e2e-a11y-student-${suffix}@test.local` } },
        incomeTier: 3,
        claimedAt: new Date(),
      },
    });
    studentId = student.id;
    studentToken = await seedSession(prisma, await accountIdOfStudent(prisma, studentId));
    await prisma.registration.create({
      data: { classId, studentId, status: 'registered', tierAtBooking: 3 },
    });

    await prisma.notification.create({
      data: {
        recipientType: 'teacher',
        recipientId: teacherId,
        type: 'booking_confirmed',
        title: 'New booking',
        body: 'Axe booked A11y Vinyasa.',
        relatedClassId: classId,
      },
    });
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({ where: { relatedClassId: classId } });
    await prisma.registration.deleteMany({ where: { classId } });
    await prisma.teacherStudent.deleteMany({ where: { teacherId } });
    await prisma.class.deleteMany({ where: { teacherId } });
    await prisma.teacherRoom.deleteMany({ where: { teacherId } });
    await prisma.room.delete({ where: { id: roomId } });
    await prisma.session.deleteMany({
      where: { accountId: await accountIdOfTeacher(prisma, teacherId) },
    });
    await prisma.session.deleteMany({
      where: { accountId: await accountIdOfStudent(prisma, studentId) },
    });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test('login page', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByLabel('Email')).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('public teacher page', async ({ page }) => {
    await page.goto(`/${slug}`);
    await expect(page.getByText('A11y Vinyasa')).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('booking page (signed-in student)', async ({ page, context }) => {
    await signIn(context, studentToken);
    await page.goto(`/${slug}/book/${classId}`);
    await expect(page.getByText('A11y Vinyasa').first()).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('student bookings', async ({ page, context }) => {
    await signIn(context, studentToken);
    await page.goto('/bookings');
    await expect(page.getByRole('heading', { name: 'Your bookings' })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('teacher schedule', async ({ page, context }) => {
    await signIn(context, teacherToken);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('class detail', async ({ page, context }) => {
    await signIn(context, teacherToken);
    await page.goto(`/class/${classId}`);
    await expect(page.getByRole('heading', { name: 'A11y Vinyasa' })).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('inbox with unread notification', async ({ page, context }) => {
    await signIn(context, teacherToken);
    await page.goto('/inbox');
    await expect(page.getByText('New booking')).toBeVisible();
    await expectNoSeriousViolations(page);
  });

  test('settings index', async ({ page, context }) => {
    await signIn(context, teacherToken);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await expectNoSeriousViolations(page);
  });
});
