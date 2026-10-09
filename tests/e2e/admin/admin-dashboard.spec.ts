import { test, expect } from '../fixtures';
import { createGuardedPrismaClient } from '../prisma';
import { BASE_URL, seedSession, uniqueSuffix } from '../../helpers';
import { createAdminFixture, seedPasskeySession, cleanupAdminFixtures } from '../../admin-fixtures';

/**
 * The passkey ceremony cannot run on admin.localhost: Chrome refuses it there
 * (the RP ID "localhost" is invalid for that domain). So the grantee's session
 * is seeded as the ceremony would leave it, a session bound to the grantee's
 * passkey credential, and the sign-in button is only looked at, never clicked.
 * The ceremony's acceptance of the admin origin is pinned by the passkey unit
 * test.
 */
const prisma = createGuardedPrismaClient();
const accountIds: string[] = [];
const SESSION_COOKIE = 'fair_yoga_session';
const ADMIN_URL = new URL(BASE_URL);
ADMIN_URL.hostname = `admin.${ADMIN_URL.hostname}`;

async function plainStudentAccount(): Promise<string> {
  const email = `e2e-admin-plain-${uniqueSuffix()}@test.local`;
  const s = await prisma.student.create({
    data: { firstName: 'Plain', lastName: 'Student', email, account: { create: { email } }, claimedAt: new Date(), incomeTier: 3 },
    select: { accountId: true },
  });
  accountIds.push(s.accountId!);
  return s.accountId!;
}

test.describe('Admin dashboard', () => {
  test.describe.configure({ mode: 'serial' });

  test.afterAll(async () => {
    // cleanupAdminFixtures returns early on an empty list: an `undefined` or
    // empty `in` filter in a deleteMany must never match everything.
    await cleanupAdminFixtures(prisma, accountIds);
    await prisma.$disconnect();
  });

  test('a grantee with a fresh passkey session sees the platform counts', async ({ page, context }) => {
    const grantee = await createAdminFixture(prisma, 'e2e-ok');
    accountIds.push(grantee.accountId);
    const token = await seedPasskeySession(prisma, grantee);
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: ADMIN_URL.origin }]);

    await page.goto('/admin');
    await expect(page.getByRole('heading', { name: 'Platform' })).toBeVisible();
    for (const name of ['Teachers', 'Students', 'Rooms']) {
      await expect(page.getByRole('region', { name })).toBeVisible();
    }
  });

  test('the main host has no admin surface, even for a grantee', async ({ page, context }) => {
    const grantee = await createAdminFixture(prisma, 'e2e-main');
    accountIds.push(grantee.accountId);
    const token = await seedPasskeySession(prisma, grantee);
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: BASE_URL }]);

    const res = await page.goto(`${BASE_URL}/admin`);
    expect(res?.status()).toBe(404);
  });

  test('a cookieless visitor is sent to passkey sign-in', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/');
    await page.waitForURL('**/admin/sign-in?redirect=%2Fadmin');
    await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toBeVisible();
    await expect(page.getByRole('textbox')).toHaveCount(0);
  });

  test('an account without a grant gets the same 404 as a missing page', async ({ page, context }) => {
    const token = await seedSession(prisma, await plainStudentAccount());
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: ADMIN_URL.origin }]);

    const res = await page.goto('/admin');
    expect(res?.status()).toBe(404);
  });

  test('a grantee whose passkey session is older than five minutes must sign in again', async ({ page, context }) => {
    const grantee = await createAdminFixture(prisma, 'e2e-stale');
    accountIds.push(grantee.accountId);
    const token = await seedPasskeySession(prisma, grantee, 6 * 60 * 1000);
    await context.addCookies([{ name: SESSION_COOKIE, value: token, url: ADMIN_URL.origin }]);

    await page.goto('/admin');
    await page.waitForURL((url) => url.pathname === '/admin/sign-in');
    expect(new URL(page.url()).pathname).toBe('/admin/sign-in');
  });
});
