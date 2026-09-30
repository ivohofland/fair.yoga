import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import fs from 'fs/promises';
import { accountIdOfStudent, accountIdOfTeacher } from './account-helpers';
import { hydrationSignal, reloadHydrated, SERVER_RENDER_TIMEOUT } from './page-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';

/**
 * GDPR through the UI: the data export downloads real JSON, and account
 * deletion anonymizes and signs out.
 */

const prisma = new PrismaClient();

const suffix = uniqueSuffix();
const studentEmail = `e2e-account-${suffix}@test.local`;

let studentId: string;
let teacherId: string;
let sessionToken: string;
let teacherSessionToken: string;

test.describe('Account — GDPR export and deletion', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const student = await prisma.student.create({
      data: {
        firstName: 'Account',
        lastName: 'Student',
        email: studentEmail,
        account: { create: { email: studentEmail } },
        incomeTier: 2,
        phone: '+31611111111',
        claimedAt: new Date(),
      },
    });
    studentId = student.id;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Privacy',
        lastName: 'Teacher',
        email: `e2e-account-teacher-${suffix}@test.local`,
        account: { create: { email: `e2e-account-teacher-${suffix}@test.local` } },
        bio: 'Privacy settings fixture',
        pageSlug: `e2e-account-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    await prisma.teacherStudent.create({ data: { teacherId, studentId } });
    sessionToken = await seedSession(prisma, await accountIdOfStudent(prisma, studentId));
    teacherSessionToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacherId));
  });

  test.afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfStudent(prisma, studentId) } });
    await prisma.magicLinkToken.deleteMany({ where: { email: { contains: suffix } } });
    if (studentId) {
      await prisma.studentPrivacy.deleteMany({ where: { studentId } });
    }
    if (teacherId) {
      await prisma.session.deleteMany({ where: { accountId: await accountIdOfTeacher(prisma, teacherId) } });
      await prisma.teacherStudent.deleteMany({ where: { teacherId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
    }
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.account.deleteMany({
      where: { email: `e2e-account-teacher-${suffix}@test.local` },
    });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(sessionToken)]);
  });

  test('the data export downloads as real JSON', async ({ page }) => {
    await page.goto('/account/data');

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download your data (JSON)' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/^fair-yoga-export-\d{4}-\d{2}-\d{2}\.json$/);
    const path = await download.path();
    const parsed = JSON.parse(await fs.readFile(path, 'utf8')) as {
      format: string;
      profile: { email: string; phone: string | null };
    };
    expect(parsed.format).toContain('student data export');
    expect(parsed.profile.email).toBe(studentEmail);
    expect(parsed.profile.phone).toBe('+31611111111');
  });

  test('a student typing /settings lands on their own settings', async ({ page }) => {
    await page.goto('/settings');
    await page.waitForURL('**/account');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  });

  test('the settings index walks to Privacy and a share persists', async ({ page }) => {
    await page.goto('/account');
    // The four rows exist and Privacy navigates.
    for (const row of ['Your tier', 'Notifications', 'Privacy', 'Data & deletion']) {
      await expect(page.getByRole('link', { name: row })).toBeVisible();
    }
    await page.getByRole('link', { name: 'Privacy' }).click();
    await expect(page.getByText('Privacy Teacher')).toBeVisible();

    await page.getByLabel('Full last name').check();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    const row = await prisma.studentPrivacy.findUniqueOrThrow({
      where: { studentId_teacherId: { studentId, teacherId } },
    });
    expect(row.shareFullName).toBe(true);
    expect(row.receiveComms).toBe(true); // untouched default
  });

  test('contact details are entered once and reach a teacher only as shared', async ({
    page,
    browser,
    baseURL,
  }) => {
    const hydrated = hydrationSignal(page);
    await page.goto('/account');
    await hydrated;

    await page.getByLabel('Phone').fill('+31 6 1234 5678');
    await page.getByLabel('Birthday').fill('1990-04-17');
    await page.getByLabel('Address').fill('Straat 1\n1011 AB Amsterdam');
    await page.getByRole('button', { name: 'Save contact details' }).click();
    await expect(page.getByText('Saved')).toBeVisible();

    await reloadHydrated(page);
    await expect(page.getByLabel('Phone')).toHaveValue('+31 6 1234 5678', SERVER_RENDER_TIMEOUT);
    await expect(page.getByLabel('Birthday')).toHaveValue('1990-04-17');
    await expect(page.getByLabel('Address')).toHaveValue('Straat 1\n1011 AB Amsterdam');

    // Share the phone number with this teacher, and nothing else.
    await page.getByRole('link', { name: 'Privacy' }).click();
    await expect(page.getByText('Privacy Teacher')).toBeVisible();
    const privacySaved = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/students/${studentId}/privacy`) &&
        r.request().method() === 'PUT' &&
        r.ok(),
    );
    await page.getByLabel('Phone number').check();
    await page.getByRole('button', { name: 'Save' }).click();
    await privacySaved;

    const teacherContext = await browser.newContext({ baseURL });
    try {
      await teacherContext.addCookies([sessionCookie(teacherSessionToken)]);
      const teacherPage = await teacherContext.newPage();
      const teacherHydrated = hydrationSignal(teacherPage);
      await teacherPage.goto(`/students/${studentId}`);
      await teacherHydrated;
      await expect(teacherPage.getByText('+31 6 1234 5678')).toBeVisible(SERVER_RENDER_TIMEOUT);
      await expect(teacherPage.getByText('17 Apr')).toHaveCount(0);
      await expect(teacherPage.getByText('Amsterdam')).toHaveCount(0);
      // By label element, never by substring: "Age" also sits inside "Page".
      await expect(teacherPage.locator('span.type-label', { hasText: /^Age$/ })).toHaveCount(0);
      await expect(teacherPage.locator('span.type-label', { hasText: /^Birthday$/ })).toHaveCount(0);
      await expect(teacherPage.locator('span.type-label', { hasText: /^Address$/ })).toHaveCount(0);

      // Clearing the phone leaves the teacher nothing to see.
      await page.goto('/account');
      await page.getByLabel('Phone').fill('');
      await page.getByRole('button', { name: 'Save contact details' }).click();
      await expect(page.getByText('Saved')).toBeVisible();
      await expect
        .poll(async () => (await prisma.student.findUniqueOrThrow({ where: { id: studentId } })).phone)
        .toBeNull();

      await teacherPage.reload();
      await expect(teacherPage.getByText('No contact information to show.')).toBeVisible(
        SERVER_RENDER_TIMEOUT,
      );
    } finally {
      await teacherContext.close();
    }
  });

  test('deleting the account anonymizes and signs out', async ({ page }) => {
    await page.goto('/account/data');

    await page.getByRole('button', { name: 'Delete account' }).click();
    await expect(page.getByText(/permanently removes your personal data/)).toBeVisible();
    await page.getByRole('button', { name: 'Delete my account' }).click();

    // The session is gone — the app treats us as signed out.
    await page.waitForURL(/\/login/, { timeout: 10_000 });

    const student = await prisma.student.findUniqueOrThrow({ where: { id: studentId } });
    expect(student.firstName).toBe('Deleted');
    expect(student.email).toBe(`deleted-${studentId}@deleted.invalid`);
    expect(student.phone).toBeNull();
    expect(student.deletedAt).not.toBeNull();
  });
});
