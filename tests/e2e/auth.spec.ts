import type { BrowserContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { accountIdOfTeacher } from './account-helpers';
import { uniqueSuffix, hashToken } from '../helpers';

const prisma = new PrismaClient();

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Mints a token AND the browser that "requested" it, so a test can choose
 * which branch it is exercising: pass the same nonce to `asOriginBrowser`
 * for a same-browser open, or open the token from a context that never got
 * `asOriginBrowser` to land in the handoff branch instead.
 */
async function createMagicLinkToken(
  email: string,
  nonce: string,
  redirectTo?: string,
): Promise<string> {
  const rawToken = generateToken();
  await prisma.magicLinkToken.create({
    data: {
      tokenHash: hashToken(rawToken),
      email,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      originBrowserHash: hashToken(nonce),
      ...(redirectTo ? { redirectTo } : {}),
    },
  });
  return rawToken;
}

/** Stamps `context` with the origin-nonce cookie a token minted by
 *  `createMagicLinkToken(email, nonce)` was bound to, so opening that token
 *  in this context takes the same-browser branch. */
async function asOriginBrowser(context: BrowserContext, nonce: string): Promise<void> {
  await context.addCookies([
    { name: 'fair_yoga_origin', value: nonce, domain: 'localhost', path: '/' },
  ]);
}

const suffix = uniqueSuffix();
const teacherEmail = `e2e-auth-${suffix}@test.local`;

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
        pageSlug: `e2e-auth-${suffix}`,
      },
    });
    teacherId = teacher.id;
  });

  test.afterAll(async () => {
    if (teacherId) {
      const tAcct = await accountIdOfTeacher(prisma, teacherId);
      if (tAcct) {
        await prisma.session.deleteMany({ where: { accountId: tAcct } });
      }
      await prisma.teacher.deleteMany({ where: { id: teacherId } });
    }
    await prisma.magicLinkToken.deleteMany({ where: { email: teacherEmail } });
    // Issue 177: Account must be deleted after Teacher due to FK reference
    await prisma.account.deleteMany({ where: { email: teacherEmail } });
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
    const nonce = crypto.randomBytes(16).toString('hex');
    const rawToken = await createMagicLinkToken(teacherEmail, nonce);
    await asOriginBrowser(page.context(), nonce);

    await page.goto(`/verify?token=${rawToken}`);

    // Teacher home page should load (requireTeacherSession passes)
    await page.waitForURL('/schedule', { timeout: 10_000 });
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
    const nonce = crypto.randomBytes(16).toString('hex');
    const rawToken = await createMagicLinkToken(teacherEmail, nonce);
    await asOriginBrowser(page.context(), nonce);

    // First use succeeds
    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL('/schedule', { timeout: 10_000 });

    // Clear cookies so we hit the verify page fresh
    await page.context().clearCookies();

    // Second use fails — token was consumed
    await page.goto(`/verify?token=${rawToken}`);
    await expect(page.getByText('Verification failed')).toBeVisible();
  });

  test('re-clicking a used link while signed in offers to continue, not a failure', async ({
    page,
  }) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const rawToken = await createMagicLinkToken(teacherEmail, nonce);
    await asOriginBrowser(page.context(), nonce);

    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL('/schedule', { timeout: 10_000 });

    // Back to the inbox, click the same link again — session still active.
    await page.goto(`/verify?token=${rawToken}`);
    await expect(page.getByText('Already signed in')).toBeVisible();
    // The spent-link education lives here — the state people dwell on —
    // not on the sub-second success flash.
    await expect(page.getByText(/That link is spent/)).toBeVisible();
    await expect(page.getByText('Verification failed')).not.toBeVisible();

    await page.getByRole('link', { name: 'Continue to your schedule' }).click();
    await page.waitForURL('/schedule', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  });

  test('session persists across page reloads', async ({ page }) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const rawToken = await createMagicLinkToken(teacherEmail, nonce);
    await asOriginBrowser(page.context(), nonce);

    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL('/schedule', { timeout: 10_000 });

    // Reload — session cookie should keep us logged in
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();
  });

  test('authenticated user can access protected routes', async ({ page }) => {
    const nonce = crypto.randomBytes(16).toString('hex');
    const rawToken = await createMagicLinkToken(teacherEmail, nonce);
    await asOriginBrowser(page.context(), nonce);

    await page.goto(`/verify?token=${rawToken}`);
    await page.waitForURL('/schedule', { timeout: 10_000 });

    // Navigate to a protected route (proxy-protected)
    await page.goto('/settings');
    // Should not be redirected to login
    await expect(page).not.toHaveURL(/\/login/);
  });

  test('unauthenticated user is redirected to login from protected routes', async ({
    page,
  }) => {
    const protectedRoutes = [
      '/settings',
      '/students',
      '/inbox',
      '/bookings',
      '/class/new',
      '/schedule',
      '/studio-class/sc-1',
      '/account/privacy',
      '/updates',
    ];
    for (const route of protectedRoutes) {
      await page.goto(route);
      await expect(page).toHaveURL(new RegExp(`/login\\?redirect=${encodeURIComponent(route)}`));
    }
  });

  test('unauthenticated user visiting protected route with redirect preserves destination through sign-in', async ({
    page,
  }) => {
    await page.goto('/settings/rooms');
    await expect(page).toHaveURL(/\/login\?redirect=%2Fsettings%2Frooms/);

    await page.getByLabel('Email').fill(teacherEmail);
    await page.getByRole('button', { name: 'Send me the link' }).click();

    await expect(
      page.getByText('Check your inbox for the link.')
    ).toBeVisible();

    const tokenRecord = await prisma.magicLinkToken.findFirst({
      where: { email: teacherEmail },
      orderBy: { createdAt: 'desc' },
    });
    expect(tokenRecord?.redirectTo).toBe('/settings/rooms');

    const cookies = await page.context().cookies();
    const originCookie = cookies.find((c) => c.name === 'fair_yoga_origin');
    const nonce = originCookie?.value ?? '';
    const rawToken = await createMagicLinkToken(teacherEmail, nonce, tokenRecord?.redirectTo ?? undefined);

    await page.goto(`/verify?token=${rawToken}`);

    await page.waitForURL('/settings/rooms', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Rooms' })).toBeVisible();
    await expect(page).not.toHaveURL(/\/schedule/);
  });

  test('unauthenticated user can access public routes without proxy redirect', async ({
    page,
  }) => {
    await page.goto('/login');
    await expect(page).toHaveURL('/login');
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible();
  });
});
