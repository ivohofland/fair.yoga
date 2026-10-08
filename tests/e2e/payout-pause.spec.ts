import { test, expect } from './fixtures';
import { createGuardedPrismaClient } from './prisma';
import { mintPayoutPauseToken } from '@/services/payout-pause-token';
import { uniqueSuffix, seedSession, sessionCookie, cookie } from '../helpers';

/**
 * The two payout-pause flows in a real browser. The pause page reads its token
 * from the address's fragment after hydration, so its button is disabled in
 * the server's HTML and only a browser can show it enabling; the resume
 * screen's form and the schedule card it clears are the teacher's way back.
 */

const prisma = createGuardedPrismaClient();
const DAY_MS = 24 * 60 * 60 * 1000;

test.describe('Payout pause and resume', () => {
  test.describe.configure({ mode: 'serial' });
  test.use({ viewport: { width: 390, height: 844 } });

  // Filled as each test creates its fixture, so afterAll deletes only rows
  // this run made, by id lists that never hold an undefined.
  const teacherIds: string[] = [];
  const emails: string[] = [];

  async function makeTeacher(tag: string, paused: boolean): Promise<{ teacherId: string; accountId: string }> {
    const s = uniqueSuffix();
    const email = `e2e-payout-${tag}-${s}@test.local`;
    emails.push(email);
    const now = Date.now();
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Payout',
        lastName: 'Pause',
        email,
        account: { create: { email } },
        bio: 'Fixture for the payout pause e2e',
        pageSlug: `e2e-payout-${tag}-${s}`,
        defaultTimezone: 'UTC',
        bankAccounts: { create: { currency: 'EUR', holderName: 'P. Pause', iban: 'NL91ABNA0417164300' } },
        paymentsPausedAt: paused ? new Date(now - DAY_MS) : null,
        pauseWindowStart: paused ? new Date(now - 2 * DAY_MS) : null,
      },
      select: { id: true, accountId: true },
    });
    teacherIds.push(t.id);
    return { teacherId: t.id, accountId: t.accountId };
  }

  test.beforeAll(async ({ request }) => {
    await prisma.$connect();
    // Warm both routes: `next dev` compiles a page lazily on its first
    // request, which can outlast a test's first navigation.
    for (const path of ['/payout-pause', '/settings/resume-payments', '/schedule']) {
      await request.get(path, { maxRedirects: 0, timeout: 60_000 }).catch(() => undefined);
    }
  });

  test.afterAll(async () => {
    if (teacherIds.length > 0) {
      const accounts = await prisma.teacher.findMany({ where: { id: { in: teacherIds } }, select: { accountId: true } });
      const accountIds = accounts.map((a) => a.accountId);
      await prisma.payoutPauseToken.deleteMany({ where: { teacherId: { in: teacherIds } } });
      await prisma.payoutChangeEvent.deleteMany({ where: { teacherId: { in: teacherIds } } });
      if (accountIds.length > 0) await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
      await prisma.teacher.deleteMany({ where: { id: { in: teacherIds } } });
    }
    if (emails.length > 0) await prisma.account.deleteMany({ where: { email: { in: emails } } });
    await prisma.$disconnect();
  });

  test('the emailed link pauses on the button, and signs every device out', async ({ page }) => {
    const me = await makeTeacher('pause', false);
    const event = await prisma.payoutChangeEvent.create({
      data: { teacherId: me.teacherId, kind: 'payment_link_added', after: 'revolut.me/…evil' },
      select: { id: true },
    });
    const raw = await mintPayoutPauseToken(prisma, me.teacherId, event.id);
    await seedSession(prisma, me.accountId);

    await page.goto(`/payout-pause#t=${raw}`);

    const button = page.getByRole('button', { name: 'Pause payments' });
    await expect(button).toBeEnabled();
    await button.click();

    await expect(page.getByRole('status')).toContainText('Payments are paused');
    expect(new URL(page.url()).hash).toBe('');
    const state = await prisma.teacher.findUniqueOrThrow({ where: { id: me.teacherId }, select: { paymentsPausedAt: true } });
    expect(state.paymentsPausedAt).not.toBeNull();
    expect(await prisma.session.count({ where: { accountId: me.accountId } })).toBe(0);
  });

  test('a teacher with no passkey requirement resumes from the schedule card, and the card goes', async ({ page, context, request }) => {
    const me = await makeTeacher('resume', true);
    const token = await seedSession(prisma, me.accountId);
    await request.get('/schedule', { headers: cookie(token), maxRedirects: 0, timeout: 60_000 }).catch(() => undefined);
    await context.clearCookies();
    await context.addCookies([sessionCookie(token)]);

    await page.goto('/schedule');
    await expect(page.getByRole('heading', { name: 'Payments are paused' })).toBeVisible();
    await page.getByRole('link', { name: 'Check and resume' }).click();

    await expect(page).toHaveURL(/\/settings\/resume-payments$/);
    await page.getByRole('button', { name: 'Resume payments' }).click();
    // The form refreshes the page, which then states the resume itself.
    await expect(page.getByText(/Payments are running\. You resumed them on/)).toBeVisible();
    const state = await prisma.teacher.findUniqueOrThrow({ where: { id: me.teacherId }, select: { paymentsPausedAt: true } });
    expect(state.paymentsPausedAt).toBeNull();

    // The browser's Back reaches the schedule the card was on; the refresh
    // means it is not the copy cached from before the resume.
    await page.goBack();
    await expect(page).toHaveURL(/\/schedule$/);
    await expect(page.getByRole('heading', { name: 'Schedule' }).or(page.getByRole('link', { name: 'Schedule' })).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Payments are paused' })).toHaveCount(0);
  });
});
