import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import fs from 'fs/promises';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import { accountIdOfStudent } from './account-helpers';

/**
 * GDPR through the UI: the data export downloads real JSON, and account
 * deletion anonymizes and signs out.
 */

const prisma = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const studentEmail = `e2e-account-${uniqueSuffix}@test.local`;
const sessionToken = crypto.randomBytes(32).toString('hex');

let studentId: string;
let teacherId: string;

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
        email: `e2e-account-teacher-${uniqueSuffix}@test.local`,
        account: { create: { email: `e2e-account-teacher-${uniqueSuffix}@test.local` } },
        bio: 'Privacy settings fixture',
        pageSlug: `e2e-account-teacher-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
    await prisma.teacherStudent.create({ data: { teacherId, studentId } });
    await prisma.session.create({
      data: {
        id: hashToken(sessionToken),
        accountId: await accountIdOfStudent(prisma, studentId),
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
  });

  test.afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfStudent(prisma, studentId) } });
    await prisma.magicLinkToken.deleteMany({ where: { email: { contains: uniqueSuffix } } });
    if (studentId) {
      await prisma.studentPrivacy.deleteMany({ where: { studentId } });
    }
    if (teacherId) {
      await prisma.teacherStudent.deleteMany({ where: { teacherId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
    }
    await prisma.student.delete({ where: { id: studentId } });
    await prisma.account.deleteMany({
      where: { email: `e2e-account-teacher-${uniqueSuffix}@test.local` },
    });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([
      { name: 'fair_yoga_session', value: sessionToken, url: 'http://localhost:3000' },
    ]);
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
