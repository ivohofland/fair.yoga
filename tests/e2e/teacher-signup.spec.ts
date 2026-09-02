import { test, expect } from './fixtures';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { uniqueSuffix, hashToken } from '../helpers';

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
 */
async function createSignupToken(email: string): Promise<string> {
  const rawToken = generateToken();
  const tokenHash = hashToken(rawToken);
  await prisma.magicLinkToken.create({
    data: { tokenHash, email, purpose: 'teacher_signup', expiresAt: new Date(Date.now() + 15 * 60 * 1000) },
  });
  return rawToken;
}

const suffix = uniqueSuffix();
const signupEmail = `e2e-signup-${suffix}@test.local`;
const pageSlug = `e2e-signup-${suffix}`;

test.describe('Teacher signup', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    await prisma.magicLinkToken.deleteMany({ where: { email: signupEmail } });
    const teacher = await prisma.teacher.findUnique({
      where: { pageSlug },
      select: { id: true, accountId: true },
    });
    if (teacher) {
      await prisma.session.deleteMany({ where: { accountId: teacher.accountId } });
      await prisma.teacher.deleteMany({ where: { id: teacher.id } });
      await prisma.account.deleteMany({ where: { id: teacher.accountId } });
    }
    await prisma.$disconnect();
  });

  test('an address with no account signs up, verifies, sets up a profile, and lands on the schedule', async ({ page }) => {
    // Step one: the email form on /signup, driven for real — this is the one
    // piece of the flow that was previously untested at every layer, and it
    // exercises the actual POST /api/auth/teacher-signup route end to end.
    await page.goto('/signup');
    await page.getByLabel('Email').fill(signupEmail);
    await page.getByRole('button', { name: /Send me the link/i }).click();
    await expect(page.getByText('Check your inbox')).toBeVisible();

    // Step two: "click the emailed link" (see createSignupToken's docblock
    // for why this mints its own token rather than the one step one made).
    const token = await createSignupToken(signupEmail);
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
  });
});
