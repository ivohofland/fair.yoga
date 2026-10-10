import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { createGuardedPrismaClient } from './prisma';
import { accountIdOfTeacher } from './account-helpers';
import { hydrationSignal } from './page-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';

/**
 * The two text links under the schedule — "Log a studio class" and "View
 * past classes" — are the last things on the page, right above the fixed
 * tab bar. Each is a full 44px tap target, the two do not overlap, and the
 * lower one clears the bar with the iPhone home-indicator inset emulated.
 */

const prisma = createGuardedPrismaClient();
const suffix = uniqueSuffix();
const email = `e2e-footer-links-${suffix}@test.local`;
const IPHONE_INSET_PX = 34;

async function box(page: Page, name: string): Promise<{ top: number; bottom: number; height: number }> {
  const b = await page.getByRole('link', { name }).boundingBox();
  if (b === null) throw new Error(`"${name}" has no box`);
  return { top: b.y, bottom: b.y + b.height, height: b.height };
}

test.describe('Schedule footer links', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  let teacherId: string | undefined;
  let token: string;

  test.beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Footer',
        lastName: 'Links',
        email,
        account: { create: { email } },
        bio: 'Fixture for the schedule footer links e2e',
        pageSlug: `e2e-footer-links-${suffix}`,
      },
    });
    teacherId = teacher.id;
    token = await seedSession(prisma, await accountIdOfTeacher(prisma, teacher.id));
  });

  test.afterAll(async () => {
    if (teacherId !== undefined) await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.deleteMany({ where: { email } });
  });

  test('are 44px tap targets that do not overlap', async ({ page, context }) => {
    await context.addCookies([sessionCookie(token)]);
    const hydrated = hydrationSignal(page);
    await page.goto('/schedule');
    await hydrated;

    const upper = await box(page, 'Log a studio class');
    const lower = await box(page, 'View past classes');
    expect(upper.height).toBeGreaterThanOrEqual(44);
    expect(lower.height).toBeGreaterThanOrEqual(44);
    expect(lower.top).toBeGreaterThanOrEqual(upper.bottom);
  });

  test('clear the tab bar with the iPhone safe-area inset', async ({ page, context, browserName }) => {
    test.skip(browserName !== 'chromium', 'the inset is emulated through the Chrome DevTools Protocol');
    await context.addCookies([sessionCookie(token)]);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: IPHONE_INSET_PX } });
    const hydrated = hydrationSignal(page);
    await page.goto('/schedule');
    await hydrated;

    const nav = page.getByRole('navigation');
    await expect.poll(async () => (await nav.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(64 + IPHONE_INSET_PX);
    // Scrolled again on every poll: the page can still grow after hydration,
    // and a scroll taken before that stops short of the bottom.
    await expect
      .poll(async () => {
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        const navTop = (await nav.boundingBox())?.y ?? 0;
        return navTop - (await box(page, 'View past classes')).bottom;
      })
      .toBeGreaterThanOrEqual(0);
  });
});
