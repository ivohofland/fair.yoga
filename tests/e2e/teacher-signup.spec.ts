import type { BrowserContext } from '@playwright/test';
import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { uniqueSuffix, hashToken, freshIp, sessionCookie, teardownTeacher } from '../helpers';
import { SESSION_COOKIE_NAME } from '@/lib/auth/session';

const prisma = new PrismaClient();

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * A `teacher_signup`-purpose token, minted the same way `POST
 * /api/auth/teacher-signup` mints one — used to continue the flow past "the
 * teacher clicks the emailed link", which this suite cannot do for real: the
 * route hashes the raw token immediately and persists nothing else, so
 * there is no way to recover the one it minted for the earlier UI step.
 * Bound to `nonce`; pair with `asOriginBrowser` for a same-browser open.
 */
async function createSignupToken(email: string, nonce: string): Promise<string> {
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  await prisma.magicLinkToken.create({
    data: {
      tokenHash,
      email,
      purpose: 'teacher_signup',
      expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      originBrowserHash: hashToken(nonce),
    },
  });
  return rawToken;
}

/** Stamps `context` with the origin-nonce cookie a token bound to `nonce`
 *  needs to take the same-browser branch at `/verify`. */
async function asOriginBrowser(context: BrowserContext, nonce: string): Promise<void> {
  await context.addCookies([
    { name: 'fair_yoga_origin', value: nonce, domain: 'localhost', path: '/' },
  ]);
}

test.describe('Teacher signup', () => {
  test.describe.configure({ mode: 'serial' });

  let signupEmail: string;
  let pageSlug: string;
  let sessionToken: string;

  test.afterAll(async () => {
    if (signupEmail) {
      await prisma.magicLinkToken.deleteMany({ where: { email: signupEmail } });
    }
    if (pageSlug) {
      const teacher = await prisma.teacher.findUnique({
        where: { pageSlug },
        select: { id: true, accountId: true },
      });
      if (teacher) {
        await teardownTeacher(prisma, teacher.id, teacher.accountId);
      }
    }
    await prisma.$disconnect();
  });

  test('an address with no account signs up, verifies, sets up a profile, and lands on the schedule', async ({ page, context }) => {
    await context.setExtraHTTPHeaders(freshIp());
    const suffix = uniqueSuffix();
    signupEmail = `e2e-signup-${suffix}@test.local`;
    pageSlug = `e2e-signup-${suffix}`;

    // Step one: the email form on /signup, driven for real — this is the one
    // piece of the flow that was previously untested at every layer, and it
    // exercises the actual POST /api/auth/teacher-signup route end to end.
    await page.goto('/signup');
    await page.getByLabel('Email').fill(signupEmail);
    await page.getByRole('button', { name: /Send me the link/i }).click();
    await expect(page.getByText('Check your inbox')).toBeVisible();

    // Step two: "click the emailed link" (see createSignupToken's docblock
    // for why this mints its own token rather than the one step one made).
    const nonce = crypto.randomBytes(16).toString('hex');
    const token = await createSignupToken(signupEmail, nonce);
    await asOriginBrowser(page.context(), nonce);
    await page.goto(`/verify?token=${token}`);
    await page.waitForURL('**/signup/profile', { timeout: 10_000 });

    // Step three: the profile form. The signup ticket cookie /verify set is
    // what authorizes this — the earlier bug this test would have caught is
    // the verify page claiming "Welcome back — You're signed in" here, which
    // was false on both halves: this reader has never been here, and no
    // session exists yet.
    await expect(page.getByText(signupEmail)).toBeVisible();
    await page.getByLabel('First name').fill('Anna');
    await page.getByLabel('Last name').fill('de Vries');
    await page.getByLabel('Page address').fill(pageSlug);
    await page.getByRole('button', { name: 'Create my page' }).click();

    // A hard navigation (the response sets the session cookie), so this polls
    // window.location rather than waiting on the client router.
    await page.waitForURL('**/schedule', { timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Schedule' })).toBeVisible();

    // A brand-new teacher has nothing set up yet: the onboarding checklist
    // shows, with a Skip control on the two dismissable rows.
    await expect(page.getByText('Getting started')).toBeVisible();
    await expect(page.getByRole('button', { name: /skip complete your profile/i })).toBeVisible();

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { pageSlug } });
    expect(teacher.firstName).toBe('Anna');
    expect(teacher.email).toBe(signupEmail);

    // Handed to the next test so it signs out of the session this flow
    // actually created, rather than a fixture standing in for it.
    const cookies = await context.cookies();
    const cookie = cookies.find((c) => c.name === SESSION_COOKIE_NAME);
    if (!cookie) throw new Error('expected the profile-creation response to set a session cookie');
    sessionToken = cookie.value;
  });

  test('signing out from /signup restores the form and deletes the session (#443)', async ({ page, context }) => {
    await context.addCookies([sessionCookie(sessionToken)]);

    // A signed-in teacher who revisits /signup is met with
    // AlreadyTeachingPanel instead of a second signup form, with a way out
    // via sign-out (#431). This pins the observable outcome of that
    // sign-out: the plain form comes back on this same route, and no
    // session survives — not which of SignOutButton's own calls produces it.
    await page.goto('/signup');
    await expect(page.getByRole('heading', { name: 'You already have a page.' })).toBeVisible();
    await expect(page.getByText(signupEmail)).toBeVisible();
    await expect(page.getByRole('link', { name: 'Go to your schedule' })).toBeVisible();
    await expect(page.getByText('Setting up a page for a different address?')).toBeVisible();

    const signOutButton = page.getByRole('button', { name: 'Sign out' });
    await expect(signOutButton).toBeVisible();

    // /signup has no SSE stream for hydrationSignal to wait on (that helper
    // only fires on teacher pages), so a click straight after goto can race
    // hydration the same way a click after page.reload() does. Retrying is
    // safe: DELETE /api/auth/session is idempotent.
    await expect(async () => {
      if (await signOutButton.isVisible()) await signOutButton.click();
      await expect(page.getByRole('heading', { name: 'Start teaching on fair.yoga' })).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 15_000 });

    await expect(page.getByLabel('Email')).toBeVisible();
    await expect(page.getByRole('button', { name: /send me the link/i })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'You already have a page.' })).not.toBeVisible();

    const teacher = await prisma.teacher.findUniqueOrThrow({ where: { pageSlug } });
    const sessions = await prisma.session.findMany({ where: { accountId: teacher.accountId } });
    expect(sessions).toHaveLength(0);
  });
});
