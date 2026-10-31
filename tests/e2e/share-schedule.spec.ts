import { test, expect } from './fixtures';
import { createGuardedPrismaClient } from './prisma';
import { accountIdOfTeacher } from './account-helpers';
import { BASE_URL, uniqueSuffix, seedSession, sessionCookie, teardownTeacher } from '../helpers';

/** Settings → Share your schedule (#916): on, copy, a saved setting, off. */

const prisma = createGuardedPrismaClient();
const suffix = uniqueSuffix();

test.describe('Share your schedule settings', () => {
  const email = `e2e-share-${suffix}@test.local`;
  let teacherId: string | undefined;

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Share', lastName: 'Teacher', bio: 'Fixture for the share e2e', email,
        pageSlug: `e2e-share-${suffix}`, defaultTimezone: 'UTC', account: { create: { email } },
      },
      select: { id: true },
    });
    teacherId = teacher.id;
  });

  test.afterAll(async () => {
    if (teacherId !== undefined) await teardownTeacher(prisma, teacherId);
    await prisma.$disconnect();
  });

  test('turn on, copy the code, keep a setting, turn off', async ({ page, context, request }) => {
    if (teacherId === undefined) throw new Error('fixture missing');
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE_URL });
    await context.addCookies([sessionCookie(await seedSession(prisma, await accountIdOfTeacher(prisma, teacherId)))]);

    await page.goto('/settings/share', { timeout: 60_000 });
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.getByRole('heading', { name: 'Your code' })).toBeVisible();

    const row = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId }, select: { scheduleShareKey: true } });
    const key = row.scheduleShareKey;
    if (key === null) throw new Error('sharing did not turn on');

    await page.getByRole('button', { name: 'Copy code' }).click();
    await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toContain(key);
    expect(clipboard).toContain('color-scheme="light"');

    const studio = page.getByRole('switch', { name: 'Show studio classes' });
    await expect(studio).toHaveAttribute('aria-checked', 'false');
    await studio.click();
    await expect(studio).toHaveAttribute('aria-checked', 'true');
    await page.reload();
    await expect(page.getByRole('switch', { name: 'Show studio classes' })).toHaveAttribute('aria-checked', 'true');

    expect((await request.get(`${BASE_URL}/feed/${key}.ics`)).status()).toBe(200);

    await page.getByRole('button', { name: 'Turn off sharing…' }).click();
    await expect(page.getByRole('button', { name: 'Keep sharing' })).toBeFocused();
    await page.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();

    expect((await request.get(`${BASE_URL}/feed/${key}.ics`)).status()).toBe(404);
  });
});
