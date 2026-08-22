import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';

/**
 * The studio class family, end to end — the first browser coverage it has had
 * (issue 283). Two arcs over one teacher: a TEMPLATE through create → pause →
 * resume → archive → un-archive, and a ONE-OFF class through log → count →
 * cancel → remove.
 *
 * Why a browser rather than the two cheaper page-level techniques this repo
 * already has (a jsdom `src/app/**` test, an integration HTTP fetch): the two
 * controls on the template detail page are gated on SERVER-rendered props and
 * re-gated by `router.refresh()` after each PATCH. A mocked render can assert
 * either state and never the transition; a single fetch stops before it. Only
 * a browser sees the refresh actually change which control is drawn.
 */

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

// Three days out, so the template's weekday is never the run day. On the run
// day the counts turn time-of-day-dependent: the generator filters candidates
// on `classStartInstant(date, startTime, tz) > startDate`, so today's
// occurrence disappears once its start time has passed. `recurring.spec.ts`
// stays off the run day for the same reason.
const templateDate = new Date();
templateDate.setUTCDate(templateDate.getUTCDate() + 3);
const templateDayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
  templateDate.getUTCDay()
]!;

// Selected by LABEL, never by integer. Studio `dayOfWeek` is 0=Monday
// (`studio-template-form.tsx:53-61`) while `getUTCDay()` is 0=Sunday, and the
// label sidesteps the mismatch entirely.

let teacherId: string;
let teacherToken: string;
let templateId: string;

test.describe('Studio class templates', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Studio',
        lastName: 'Teacher',
        email: `e2e-studio-${suffix}@test.local`,
        account: { create: { email: `e2e-studio-${suffix}@test.local` } },
        bio: 'Studio e2e fixtures',
        pageSlug: `e2e-studio-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherToken = await seedSession(prisma, await accountIdOfTeacher(prisma, teacherId));
    // No Room and no TeacherRoom: StudioClass is disconnected from Room by
    // design (CLAUDE.md, Data Model), which is the one way this fixture is
    // simpler than `recurring.spec.ts`'s.
  });

  test.afterAll(async () => {
    // Classes before templates: `StudioClass.template` is a real FK.
    await prisma.studioClass.deleteMany({ where: { teacherId } });
    await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId: await accountIdOfTeacher(prisma, teacherId) } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(teacherToken)]);
  });

  test('creates a template through settings and fills the window', async ({ page }) => {
    await page.goto('/settings/studio-classes/new');

    await page.getByLabel('Class type').fill('Studio Flow');
    await page.getByLabel('Location').fill('Community Studio');
    await page.getByLabel('Day').selectOption(templateDayName);
    await page.getByLabel('Start time').fill('08:15');
    await page.getByLabel('Duration (minutes)').fill('60');
    await page.getByLabel('Hourly rate').fill('45');
    await page.getByRole('button', { name: 'Create', exact: true }).click();

    await page.waitForURL('**/settings/studio-classes', { timeout: 10_000 });
    await expect(page.getByText('Studio Flow')).toBeVisible();

    const template = await prisma.studioClassTemplate.findFirstOrThrow({
      where: { teacherId, classType: 'Studio Flow' },
    });
    templateId = template.id;
    expect(template.isActive).toBe(true);
    expect(template.isArchived).toBe(false);

    // Creation itself filled the window — no cron has fired.
    expect(await prisma.studioClass.count({ where: { templateId } })).toBe(4);
  });

  test('the four generated classes are on the schedule, and refuse removal', async ({ page }) => {
    await page.goto('/');

    // `StudioClassCard` renders "<classType> · <location> · Studio class"
    // (`class-list.tsx:140`). All four dates (+3, +10, +17, +24 days) sit
    // inside the schedule's 28-day window.
    const cards = page.getByRole('link', { name: /Studio Flow · Community Studio · Studio class/ });
    await expect(cards).toHaveCount(4);

    // A generated class dated today or later cannot be removed — the sweep
    // would recreate it within the hour, so the page draws no Remove control
    // (`studio-class-deletion.ts`, issue 279). Asserted HERE, before the
    // archive below deletes all four.
    const first = await prisma.studioClass.findFirstOrThrow({
      where: { templateId },
      orderBy: { date: 'asc' },
    });
    await page.goto(`/studio-class/${first.id}`);
    await expect(page.getByRole('button', { name: 'Cancel class' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove this class' })).toHaveCount(0);
  });
});
