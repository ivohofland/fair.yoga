import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher, accountIdOfStudent } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie, cookie } from '../helpers';
import { hhmmToTime } from '@/lib/time-of-day';
import { createClassFixture } from '../class-fixtures';

/**
 * The pay page's method chooser in a real browser: the rows share a
 * `<details name>`, so the browser itself keeps at most one open. Nothing in
 * the server-rendered HTML can show that; only a click can.
 */

const prisma = new PrismaClient();

const suffix = uniqueSuffix();
const IBAN = 'NL91ABNA0417164300';
const HOLDER = 'E. Paychooser';
const OPEN_ROW = 'details[name="pay-method"][open]';

test.describe('Pay page — the method chooser keeps one row open', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 390, height: 844 } });

  const teacherEmail = `e2e-pay-teacher-${suffix}@test.local`;
  const studentEmail = `e2e-pay-student-${suffix}@test.local`;
  // Undefined until beforeAll has created them: Prisma reads an undefined
  // filter value as no filter, so afterAll deletes only by ids that exist.
  let teacherId: string | undefined;
  let studentId: string | undefined;
  let roomId: string | undefined;
  let teacherAccountId: string | undefined;
  let studentAccountId: string | undefined;
  let classId = '';
  let studentToken = '';

  test.beforeAll(async ({ request }) => {
    await prisma.$connect();

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Chooser',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Fixture for the pay page chooser e2e',
        pageSlug: `e2e-pay-${suffix}`,
        defaultTimezone: 'UTC',
        bankIban: IBAN,
        bankAccountName: HOLDER,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = await accountIdOfTeacher(prisma, teacher.id);

    const room = await prisma.room.create({
      data: {
        venueName: 'Chooser Studio',
        address: `${suffix} Chooser St`,
        city: 'Amsterdam',
        postcode: '1000AA',
        maxCapacity: 10,
        createdById: teacher.id,
      },
    });
    roomId = room.id;
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 10, rentalRate: 25 },
    });

    const cls = await createClassFixture(prisma, {
      teacherId: teacher.id,
      teacherRoomId: teacherRoom.id,
      classType: `Chooser Flow ${suffix}`,
      date: new Date('2026-06-01T00:00:00.000Z'),
      startTime: hhmmToTime('09:00'),
      durationMinutes: 60,
      roomCost: 20,
      minRate: 10,
      targetRate: 20,
      minStudents: 1,
      maxStudents: 10,
      status: 'completed',
      effectiveTeacherRate: 10,
      totalStudents: 4,
      totalRevenue: 30,
    });
    classId = cls.id;

    const student = await prisma.student.create({
      data: {
        firstName: 'Chooser',
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

    const registration = await prisma.registration.create({
      data: { classId: cls.id, studentId: student.id, status: 'attended', tierAtBooking: 3 },
    });
    await prisma.payment.create({
      data: { registrationId: registration.id, amount: 7.5, status: 'pending' },
    });

    // Warm the route: `next dev` compiles a page lazily on its first request,
    // which can outlast the test's first navigation. The answer is ignored.
    await request
      .get(`/bookings/${classId}/pay`, {
        headers: cookie(studentToken),
        maxRedirects: 0,
        timeout: 60_000,
      })
      .catch(() => undefined);
  });

  test.afterAll(async () => {
    // Every delete is by ids beforeAll got as far as creating, skipped when
    // there are none (the account delete, by this run's own addresses).
    const accountIds = [teacherAccountId, studentAccountId].filter((id) => id !== undefined);
    if (studentId !== undefined) {
      await prisma.payment.deleteMany({ where: { registration: { studentId: { in: [studentId] } } } });
      await prisma.registration.deleteMany({ where: { studentId: { in: [studentId] } } });
    }
    if (teacherId !== undefined) {
      await prisma.calendarEntry.deleteMany({ where: { teacherId: { in: [teacherId] } } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: { in: [teacherId] } } });
    }
    if (roomId !== undefined) await prisma.room.deleteMany({ where: { id: { in: [roomId] } } });
    if (accountIds.length > 0) {
      await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
    }
    if (studentId !== undefined) await prisma.student.deleteMany({ where: { id: { in: [studentId] } } });
    if (teacherId !== undefined) await prisma.teacher.deleteMany({ where: { id: { in: [teacherId] } } });
    // By address, which is defined from the start and unique to this run, so an
    // account created before beforeAll failed is still removed.
    await prisma.account.deleteMany({ where: { email: { in: [teacherEmail, studentEmail] } } });
    await prisma.$disconnect();
  });

  test('opens one method at a time', async ({ page, context }) => {
    await context.clearCookies();
    await context.addCookies([sessionCookie(studentToken)]);
    await page.goto(`/bookings/${classId}/pay`);

    const openRows = page.locator(OPEN_ROW);
    // Each row is found by its summary alone, so a row that lost the shared
    // name is still the row the assertions below talk about.
    const bankRow = page.locator('details', { has: page.locator('summary', { hasText: 'Bank transfer' }) });
    const qrRow = page.locator('details', { has: page.locator('summary', { hasText: 'QR code' }) });

    await expect(page.getByRole('heading', { name: 'How would you like to pay?' })).toBeVisible();
    await expect(openRows).toHaveCount(0);

    await bankRow.locator('summary').click();
    await expect(openRows).toHaveCount(1);
    await expect(bankRow).toHaveAttribute('open');
    await expect(openRows).toContainText(IBAN);

    await qrRow.locator('summary').click();
    await expect(openRows).toHaveCount(1);
    await expect(qrRow).toHaveAttribute('open');
    await expect(bankRow).not.toHaveAttribute('open');
  });
});
