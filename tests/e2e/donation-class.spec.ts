import { test, expect } from './fixtures';
import { createGuardedPrismaClient } from './prisma';
import { accountIdOfTeacher, accountIdOfStudent } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie, cookie } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

/**
 * A donation class end to end (#912): the student books, the teacher finishes
 * the class, the invitation in the student's inbox opens the give page, and
 * that page names no amount anywhere.
 */

const prisma = createGuardedPrismaClient();

const suffix = uniqueSuffix();
const IBAN = 'NL91ABNA0417164300';

test.describe('Donation class — invitation to a give page with no amount', () => {
  test.describe.configure({ mode: 'serial' });

  const teacherEmail = `e2e-donation-teacher-${suffix}@test.local`;
  const studentEmail = `e2e-donation-student-${suffix}@test.local`;
  const slug = `e2e-donation-${suffix}`;
  // Undefined until beforeAll has created them, so afterAll deletes only by ids that exist.
  let teacherId: string | undefined;
  let studentId: string | undefined;
  let roomId: string | undefined;
  let teacherAccountId: string | undefined;
  let studentAccountId: string | undefined;
  let classId = '';
  let entryId = '';
  let studentToken = '';
  let teacherToken = '';

  test.beforeAll(async ({ request }) => {
    await prisma.$connect();

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Donation',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Fixture for the donation class e2e',
        pageSlug: slug,
        defaultTimezone: 'UTC',
        bankAccounts: { create: { currency: 'EUR', holderName: 'D. Onation', iban: IBAN } },
      },
    });
    teacherId = teacher.id;
    teacherAccountId = await accountIdOfTeacher(prisma, teacher.id);
    teacherToken = await seedSession(prisma, teacherAccountId);

    const room = await prisma.room.create({
      data: {
        venueName: 'Donation Studio',
        address: `${suffix} Donation St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        maxCapacity: 10,
        createdById: teacher.id,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 10, rentalRate: 0 },
    });

    const weekAhead = new Date();
    weekAhead.setUTCDate(weekAhead.getUTCDate() + 7);
    weekAhead.setUTCHours(0, 0, 0, 0);
    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      classType: `Donation Flow ${suffix}`,
      date: weekAhead,
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 0,
      minRate: 0,
      targetRate: 0,
      minStudents: 1,
      maxStudents: 10,
      pricingMode: 'donation',
      status: 'open',
    });
    classId = cls.id;
    entryId = cls.calendarEntry.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Donation',
        lastName: 'Student',
        email: studentEmail,
        account: { create: { email: studentEmail } },
        claimedAt: new Date(),
        incomeTier: 3,
      },
    });
    studentId = student.id;
    studentAccountId = await accountIdOfStudent(prisma, student.id);
    studentToken = await seedSession(prisma, studentAccountId);

    // `next dev` compiles each route on first request; warm the ones this test crosses.
    for (const path of [`/${slug}/book/${classId}`, `/bookings/${classId}/give`, '/updates']) {
      await request
        .get(path, { headers: cookie(studentToken), maxRedirects: 0, timeout: 60_000 })
        .catch(() => undefined);
    }
  });

  test.afterAll(async () => {
    const accountIds = [teacherAccountId, studentAccountId].filter((id) => id !== undefined);
    if (classId !== '') {
      await prisma.notification.deleteMany({ where: { relatedClassId: { in: [classId] } } });
      await prisma.payment.deleteMany({ where: { registration: { classId: { in: [classId] } } } });
      await prisma.registration.deleteMany({ where: { classId: { in: [classId] } } });
    }
    if (teacherId !== undefined) {
      await prisma.teacherStudent.deleteMany({ where: { teacherId: { in: [teacherId] } } });
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: [teacherId] } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: [teacherId] } } });
    }
    if (roomId !== undefined) await prisma.room.deleteMany({ where: { id: { in: [roomId] } } });
    if (accountIds.length > 0) {
      await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    if (studentId !== undefined) await prisma.student.deleteMany({ where: { id: { in: [studentId] } } });
    if (teacherId !== undefined) await prisma.teacher.deleteMany({ where: { id: { in: [teacherId] } } });
    await prisma.account.deleteMany({ where: { email: { in: [teacherEmail, studentEmail] } } });
    await prisma.$disconnect();
  });

  test('a donation class: book, complete, follow the invitation, give without an amount (#912)', async ({
    page,
    context,
    request,
  }) => {
    await context.clearCookies();
    await context.addCookies([sessionCookie(studentToken)]);
    await page.goto(`/${slug}/book/${classId}`);
    await expect(
      page.getByText('This class is by donation. After class you can give what you like, if you like.'),
    ).toBeVisible();
    await page.getByRole('radio', { name: /Tier 3/ }).click();
    await page.getByRole('button', { name: 'Book', exact: true }).click();
    await expect(page.getByText('Your spot is confirmed.')).toBeVisible();

    // Move the class into its past so completion opens, then finish it as the teacher.
    await prisma.calendarEntry.update({
      where: { id: entryId },
      data: { date: new Date('2026-06-01T00:00:00Z') },
    });
    await prisma.class.update({ where: { id: classId }, data: { status: 'in_progress' } });
    const done = await request.post(`/api/classes/${classId}/complete`, {
      headers: cookie(teacherToken),
    });
    expect(done.ok()).toBe(true);

    await page.goto('/updates');
    await page.getByText('Thank you for coming', { exact: false }).first().click();
    await expect(page).toHaveURL(new RegExp(`/bookings/${classId}/give$`));
    await expect(page.getByRole('heading', { name: 'Thank you for coming.' })).toBeVisible();
    await page.getByText('Bank transfer').click();
    await expect(page.getByText('NL91', { exact: false })).toBeVisible();
    const body = await page.locator('body').innerText();
    expect(body).not.toMatch(/€\s?\d|EUR\s?\d|\d+[.,]\d{2}/);
  });
});
