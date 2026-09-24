import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher, accountIdOfStudent } from './account-helpers';
import { hydrationSignal } from './page-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';
import { NOTIFICATION_PAGE_SIZE } from '@/lib/notification-paging';

/**
 * #663 end to end: `/inbox` and `/updates` show one page of a recipient's
 * notifications and reach the rest through "Show older messages".
 *
 * The rows come in groups of six that share an instant, so the boundary
 * between the first page and the second falls inside a group: a page read
 * without an id tie-breaker would repeat or drop a row there.
 */

const prisma = new PrismaClient();

const suffix = uniqueSuffix();
const TOTAL = NOTIFICATION_PAGE_SIZE + 5;
const GROUP = 6;
const ROW = '[id^="notification-row-"]';

// Derived at seed time, a minute back: recent enough to sit inside every
// retention window, and older than anything the app writes during the run.
const base = Date.now() - 60_000;

function seedRows(recipientType: 'teacher' | 'student', recipientId: string) {
  return Array.from({ length: TOTAL }, (_, i) => ({
    recipientType,
    recipientId,
    type: 'announcement' as const,
    title: `E2E notice ${i}`,
    body: `Body ${i}`,
    // Read and already emailed: nothing here is for the email sweep to pick up.
    isRead: true,
    emailSent: true,
    createdAt: new Date(base - Math.floor(i / GROUP) * 1000),
  }));
}

/** The numeric part of every rendered `E2E notice N` title, in page order. */
async function renderedTitleNumbers(page: Page): Promise<number[]> {
  const texts = await page.locator(ROW).allTextContents();
  return texts.map((t) => {
    const m = /^E2E notice (\d+)/.exec(t);
    if (!m) throw new Error(`row text does not start with a seeded title: ${t}`);
    return Number(m[1]);
  });
}

async function expectEveryTitleOnce(page: Page): Promise<void> {
  const numbers = await renderedTitleNumbers(page);
  expect(numbers).toHaveLength(TOTAL);
  expect(new Set(numbers).size).toBe(TOTAL);
  expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: TOTAL }, (_, i) => i));
}

async function showOlderThroughTheButton(page: Page, path: string): Promise<void> {
  const hydrated = hydrationSignal(page);
  await page.goto(path);
  await hydrated;

  await expect(page.locator(ROW)).toHaveCount(NOTIFICATION_PAGE_SIZE);
  await expect(page.getByText('Messages are kept for a year.')).toBeVisible();

  await page.getByRole('button', { name: 'Show older messages' }).click();

  await expect(page.locator(ROW)).toHaveCount(TOTAL);
  await expectEveryTitleOnce(page);
  await expect(page.getByRole('button', { name: 'Show older messages' })).toHaveCount(0);
  await expect(page.getByText('Messages are kept for a year.')).toBeVisible();
}

test.describe('Inbox — Show older messages (#663)', () => {
  test.describe.configure({ mode: 'serial' });

  const teacherEmail = `e2e-older-teacher-${suffix}@test.local`;
  const studentEmail = `e2e-older-student-${suffix}@test.local`;
  let teacherId: string;
  let studentId: string;
  let teacherAccountId: string;
  let studentAccountId: string;
  let teacherToken: string;
  let studentToken: string;

  test.beforeAll(async () => {
    await prisma.$connect();

    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Older',
        lastName: 'Teacher',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Fixture for the #663 e2e inbox paging',
        pageSlug: `e2e-older-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = await accountIdOfTeacher(prisma, teacherId);
    teacherToken = await seedSession(prisma, teacherAccountId);

    const student = await prisma.student.create({
      data: {
        firstName: 'Older',
        lastName: 'Student',
        email: studentEmail,
        account: { create: { email: studentEmail } },
        claimedAt: new Date(),
        incomeTier: 3,
      },
    });
    studentId = student.id;
    studentAccountId = await accountIdOfStudent(prisma, studentId);
    studentToken = await seedSession(prisma, studentAccountId);

    await prisma.notification.createMany({ data: seedRows('teacher', teacherId) });
    await prisma.notification.createMany({ data: seedRows('student', studentId) });
  });

  test.afterAll(async () => {
    await prisma.notification.deleteMany({
      where: {
        OR: [
          { recipientType: 'teacher', recipientId: teacherId },
          { recipientType: 'student', recipientId: studentId },
        ],
      },
    });
    await prisma.session.deleteMany({
      where: { accountId: { in: [teacherAccountId, studentAccountId] } },
    });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.account.deleteMany({ where: { id: { in: [teacherAccountId, studentAccountId] } } });
    await prisma.$disconnect();
  });

  test('the teacher reaches every notification from /inbox, each once', async ({ page, context }) => {
    await context.clearCookies();
    await context.addCookies([sessionCookie(teacherToken)]);
    await showOlderThroughTheButton(page, '/inbox');
  });

  test('the student reaches every notification from /updates, each once', async ({ page, context }) => {
    await context.clearCookies();
    await context.addCookies([sessionCookie(studentToken)]);
    await showOlderThroughTheButton(page, '/updates');
  });
});
