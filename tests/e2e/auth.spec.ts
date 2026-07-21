import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { sha256 } from '@oslojs/crypto/sha2';
import { encodeHexLowerCase } from '@oslojs/encoding';
import { accountIdOfTeacher } from './account-helpers';

const prisma = new PrismaClient();

function hashToken(token: string): string {
  const bytes = sha256(new TextEncoder().encode(token));
  return encodeHexLowerCase(bytes);
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

async function createMagicLinkToken(email: string): Promise<string> {
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  await prisma.magicLinkToken.create({
    data: {
      tokenHash,
      email,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    },
  });
  return rawToken;
}

const uniqueSuffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
const teacherEmail = `e2e-auth-${uniqueSuffix}@test.local`;

let teacherId: string;

test.describe('Magic link authentication', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'E2E',
        lastName: 'Auth',
        email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Teacher for e2e auth tests',
        pageSlug: `e2e-auth-${uniqueSuffix}`,
      },
    });
    teacherId = teacher.id;
  });

  test.afterAll(async () => {
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfTeacher(prisma, teacherId) } });
    await prisma.magicLinkToken.deleteMany({ where: { email: teacherEmail } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test('login page shows email form', async ({ page }) => {
    await page.goto('/login');

    await expect(page.getByRole('heading', { name: 'Sign in with a link sent to your inbox' })).toBeVisible();
    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Send me the link' })
    ).toBeVisible();
  });

  test('submitting email shows confirmation message', async ({ page }) => {
    await page.goto('/login');

    await page.getByLabel('Email').fill(teacherEmail);
    await page.getByRole('button', { name: 'Send me the link' }).click();

    await expect(
      page.getByText('Check your inbox for the link.')
    ).toBeVisible();
  });

  test('valid magic link logs in teacher and redirects to home', async ({
    page,
  }) => {
    const rawToken = await createMagicLinkToken(teacherEmail);

    await page.goto(`/verify?token=${rawToken}`);

    // Teacher home page should load (requireTeacherSession passes)
    await page.waitForURL('/', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  });

  test('invalid token shows error on verify page', async ({ page }) => {
    await page.goto('/verify?token=invalid-token-abc123');

    await expect(page.getByText('Verification failed')).toBeVisible();
    await expect(
      page.getByText(/This link can/)
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Send a new link' })).toBeVisible();
  });

  test('missing token shows error on verify page', async ({ page }) => {
    await page.goto('/verify');

    await expect(page.getByText('Verification failed')).toBeVisible();
    await expect(
      page.getByText(/This link can/)
    ).toBeVisible();
  });

  test('used token cannot be reused', async ({ page }) => {
    const rawToken = await createMagicLinkToken(teacherEmail);

    // First use succeeds
    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL('/', { timeout: 10_000 });

    // Clear cookies so we hit the verify page fresh
    await page.context().clearCookies();

    // Second use fails — token was consumed
    await page.goto(`/verify?token=${rawToken}`);
    await expect(page.getByText('Verification failed')).toBeVisible();
  });

  test('re-clicking a used link while signed in offers to continue, not a failure', async ({
    page,
  }) => {
    const rawToken = await createMagicLinkToken(teacherEmail);

    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL('/', { timeout: 10_000 });

    // Back to the inbox, click the same link again — session still active.
    await page.goto(`/verify?token=${rawToken}`);
    await expect(page.getByText('Already signed in')).toBeVisible();
    await expect(page.getByText('Verification failed')).not.toBeVisible();

    await page.getByRole('link', { name: 'Continue to your schedule' }).click();
    await page.waitForURL('/', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  });

  test('session persists across page reloads', async ({ page }) => {
    const rawToken = await createMagicLinkToken(teacherEmail);

    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL('/', { timeout: 10_000 });

    // Reload — session cookie should keep us logged in
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  });

  test('authenticated user can access protected routes', async ({ page }) => {
    const rawToken = await createMagicLinkToken(teacherEmail);

    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL('/', { timeout: 10_000 });

    // Navigate to a protected route (middleware-protected)
    await page.goto('/settings');
    // Should not be redirected to login
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('unauthenticated user is redirected to login from protected route', async ({
    page,
  }) => {
    await page.goto('/settings');

    await expect(page).toHaveURL(/\/login\?redirect=/);
  });
});


test.describe('Verify page — already signed in', () => {
  test('a spent link tells you so and continues to your home', async ({ page, context }) => {
    const suffix = `${Date.now()}-resign`;
    const token = crypto.randomBytes(32).toString('hex');
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Resign',
        lastName: 'Teacher',
        email: `e2e-resign-${suffix}@test.local`,
        bio: 'Already-signed-in fixtures',
        pageSlug: `e2e-resign-${suffix}`,
        account: { create: { email: `e2e-resign-${suffix}@test.local` } },
      },
    });
    await prisma.session.create({
      data: {
        id: hashToken(token),
        accountId: teacher.accountId,
        expiresAt: new Date(Date.now() + 86400000),
      },
    });
    await context.addCookies([
      { name: 'fair_yoga_session', value: token, url: 'http://localhost:3000' },
    ]);

    try {
      // A bogus/spent token while holding a valid session: the page must
      // say the session is fine and route by the account's real profile.
      await page.goto('/verify?token=deadbeef');
      await expect(page.getByText(/That link is spent/)).toBeVisible({ timeout: 10_000 });
      await page.getByRole('link', { name: 'Continue to your schedule' }).click();
      await page.waitForURL((url) => url.pathname === '/', { timeout: 10_000 });
    } finally {
      await prisma.session.deleteMany({ where: { accountId: teacher.accountId } });
      await prisma.teacher.delete({ where: { id: teacher.id } });
      await prisma.account.delete({ where: { id: teacher.accountId } });
    }
  });
});
