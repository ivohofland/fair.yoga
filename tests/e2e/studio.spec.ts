import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher } from './account-helpers';
import { uniqueSuffix, seedSession, sessionCookie } from '../helpers';

/**
 * The studio class family, end to end — the first browser coverage it has had
 * (issue 283). Two describes, each seeding its own teacher — Playwright runs
 * `beforeAll`/`afterAll` per describe, so sharing a teacher would tie the
 * second block's setup to the first block's teardown having already run: a
 * TEMPLATE through create → pause → resume → archive → un-archive, and a
 * ONE-OFF class through log → count → cancel → remove.
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

// The same 0=Monday mapping `studio-template-form.tsx`'s DAY_OPTIONS uses,
// needed here only because the second fixture template below is seeded
// through Prisma rather than the form and so has no label to select.
const STUDIO_DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const otherTemplateDayOfWeek = (STUDIO_DAY_LABELS.indexOf(templateDayName) + 1) % 7;

let teacherId: string;
let teacherToken: string;
let templateId: string;
let otherTemplateId: string;

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
    // design (CLAUDE.md, Data Model).

    // A second template, seeded directly rather than through the UI, so the
    // archived-list arc below has something to fail against: a page with no
    // `isArchived` filter at all would still pass a test that only checks the
    // one template it archives. `isActive: false` so it is never picked up by
    // any generator and never appears among the four counted classes in the
    // next test. A different `(dayOfWeek, startTime)` keeps this insert clear
    // of `StudioClassTemplate_teacher_slot_unique`, which both rows are
    // `isArchived: false` under. A `classType` that is not a substring of
    // "Studio Flow" and does not contain it keeps every `getByText`/`getByRole`
    // locator below single-match.
    otherTemplateId = (
      await prisma.studioClassTemplate.create({
        data: {
          teacherId,
          classType: 'Yin Retreat',
          location: 'Riverside Loft',
          dayOfWeek: otherTemplateDayOfWeek,
          startTime: '19:00',
          durationMinutes: 60,
          hourlyRate: 30,
          isActive: false,
          isArchived: false,
        },
      })
    ).id;
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

    // Confirmed, not assumed: the second fixture template is `isActive:
    // false` and generates nothing, so it never inflates the count above.
    expect(await prisma.studioClass.count({ where: { templateId: otherTemplateId } })).toBe(0);

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

  test('pausing says what stays scheduled, and reveals Archive', async ({ page }) => {
    await page.goto(`/settings/studio-classes/${templateId}`);

    // An ACTIVE template offers Pause and nothing else: Archive is gated on
    // `!isActive` (`settings/studio-classes/[id]/page.tsx:55`).
    await expect(page.getByRole('button', { name: 'Archive studio class' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Pause studio class' }).click();

    // `pauseMessage` names the last class still standing — pause deletes
    // nothing, so all four survive and the fourth is the one named.
    await expect(page.getByText(/No new classes will be added to your schedule\./)).toBeVisible();
    await expect(page.getByText(/The last one still scheduled is .* · 08:15\./)).toBeVisible();

    // `router.refresh()` re-rendered the server component with new props.
    await expect(page.getByRole('button', { name: 'Resume studio class' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive studio class' })).toBeVisible();

    expect(await prisma.studioClass.count({ where: { templateId } })).toBe(4);
  });

  test('the paused row keeps its name on the list', async ({ page }) => {
    // Issue 281: the paused section used to title itself with the location, so
    // pausing renamed the template on the page it returns you to.
    await page.goto('/settings/studio-classes');
    await expect(page.getByText('Studio Flow')).toBeVisible();
    await expect(page.getByText(/Community Studio · €45\.00\/hr/)).toBeVisible();
    // Scoped to this row: the second fixture template is paused throughout
    // this whole spec, so a bare `page.getByText('paused')` would match both.
    const row = page.getByRole('link', { name: /Studio Flow/ });
    await expect(row.getByText('paused')).toBeVisible();
  });

  test('resuming reports the window it already has', async ({ page }) => {
    await page.goto(`/settings/studio-classes/${templateId}`);
    await page.getByRole('button', { name: 'Resume studio class' }).click();

    // `added: 0, scheduled: 4` — pause deleted nothing, so the window was
    // already full and this resume adds none. That asymmetric pair is exactly
    // what `template-action-messages.ts` asks a test to drive, because equal
    // arguments cannot detect a transposition.
    await expect(page.getByText('4 classes on your schedule. Nothing needed adding.')).toBeVisible();

    // Active again, so Archive is gated off again.
    await expect(page.getByRole('button', { name: 'Pause studio class' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive studio class' })).toHaveCount(0);
  });

  test('archiving withdraws the window and says how much', async ({ page }) => {
    await page.goto(`/settings/studio-classes/${templateId}`);

    // Archiving needs a paused template — this second pause is the
    // composition, not a workaround.
    await page.getByRole('button', { name: 'Pause studio class' }).click();
    await expect(page.getByRole('button', { name: 'Archive studio class' })).toBeVisible();

    await page.getByRole('button', { name: 'Archive studio class' }).click();

    // `archiveStudioMessage(4, 0)`: four future uncancelled classes deleted,
    // none dated today to spare.
    await expect(
      page.getByText('Deleted 4 scheduled studio classes. Nothing from this template is scheduled any more.'),
    ).toBeVisible();

    expect(await prisma.studioClass.count({ where: { templateId } })).toBe(0);
    const t = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(t.isArchived).toBe(true);
    expect(t.withdrawnCount).toBe(4);
  });

  test('an archived template leaves the live list for the archived one', async ({ page }) => {
    await page.goto('/settings/studio-classes');
    await expect(page.getByText('Studio Flow')).toHaveCount(0);
    // The still-live second template stays on this list — the same filter
    // that dropped the archived one (`settings/studio-classes/page.tsx:11`)
    // leaves an unarchived one in place.
    await expect(page.getByText('Yin Retreat')).toBeVisible();

    await page.goto('/settings/studio-classes/archived');
    await expect(page.getByText('Studio Flow')).toBeVisible();
    // ...and the reverse: the second template, never archived, does not
    // appear here either.
    await expect(page.getByText('Yin Retreat')).toHaveCount(0);

    await page.getByRole('link', { name: /Studio Flow/ }).click();
    await page.waitForURL(`**/settings/studio-classes/${templateId}`);

    // Archived: Toggle is gated off by `!isArchived`, and Archive renders in
    // its un-archive direction. Exactly one control, and no dead end.
    await expect(page.getByRole('button', { name: 'Pause studio class' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume studio class' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unarchive studio class' })).toBeVisible();
  });

  test('un-archiving returns the template paused, not active', async ({ page }) => {
    await page.goto(`/settings/studio-classes/${templateId}`);
    await page.getByRole('button', { name: 'Unarchive studio class' }).click();

    await expect(
      page.getByText('Un-archived. This template is paused — resume it to put classes back on your schedule.'),
    ).toBeVisible();

    // The screen agreeing with the sentence: both controls, because
    // `isArchived` is false again and `isActive` was forced false in the same
    // write (`studio-class-template-lifecycle.ts:1226`).
    await expect(page.getByRole('button', { name: 'Resume studio class' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive studio class' })).toBeVisible();

    const t = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: templateId } });
    expect(t.isArchived).toBe(false);
    expect(t.isActive).toBe(false);
    expect(t.archivedAt).toBeNull();

    // Back on the live list, marked paused, still named. Scoped to this row
    // for the same reason as the earlier paused-list test: the second fixture
    // template is paused throughout and would double-match a bare
    // `page.getByText('paused')`.
    await page.goto('/settings/studio-classes');
    await expect(page.getByText('Studio Flow')).toBeVisible();
    const row = page.getByRole('link', { name: /Studio Flow/ });
    await expect(row.getByText('paused')).toBeVisible();
  });
});

test.describe('One-off studio classes', () => {
  test.describe.configure({ mode: 'serial' });

  let soloTeacherId: string;
  let soloToken: string;

  // Yesterday, so the class is manual AND past-dated — the two independent
  // grounds on which `studioClassDeletability` allows removal. `date` has no
  // lower bound in `createStudioClassSchema`, so the form accepts it.
  const past = new Date();
  past.setUTCDate(past.getUTCDate() - 1);
  const pastIso = past.toISOString().slice(0, 10);

  test.beforeAll(async () => {
    await prisma.$connect();
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Oneoff',
        lastName: 'Teacher',
        email: `e2e-studio-solo-${suffix}@test.local`,
        account: { create: { email: `e2e-studio-solo-${suffix}@test.local` } },
        bio: 'One-off studio e2e fixtures',
        pageSlug: `e2e-studio-solo-${suffix}`,
      },
    });
    soloTeacherId = teacher.id;
    soloToken = await seedSession(prisma, await accountIdOfTeacher(prisma, soloTeacherId));
  });

  test.afterAll(async () => {
    await prisma.studioClass.deleteMany({ where: { teacherId: soloTeacherId } });
    await prisma.session.deleteMany({
      where: { accountId: await accountIdOfTeacher(prisma, soloTeacherId) },
    });
    await prisma.teacher.delete({ where: { id: soloTeacherId } });
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(soloToken)]);
  });

  test('log, count, cancel, remove', async ({ page }) => {
    // LOG — from the schedule, the way a teacher reaches it.
    await page.goto('/');
    await page.getByRole('link', { name: 'Log a studio class' }).click();
    await page.waitForURL('**/studio-class/new');

    await page.getByLabel('Class type').fill('Cover Class');
    await page.getByLabel('Location').fill('Guest Studio');
    await page.getByLabel('Date').fill(pastIso);
    await page.getByLabel('Start time').fill('19:30');
    await page.getByLabel('Duration (minutes)').fill('75');
    await page.getByLabel('Hourly rate').fill('40');
    await page.getByRole('button', { name: 'Log class' }).click();

    // Wait on the destination, not the `Created` notice: asserting the
    // notice and clicking its button races the page's own navigation — see
    // `docs/superpowers/specs/2026-08-22-studio-family-e2e-design.md:182`.
    await page.waitForURL(/\/studio-class\/(?!new$)[\w-]+$/, { timeout: 10_000 });

    const created = await prisma.studioClass.findFirstOrThrow({
      where: { teacherId: soloTeacherId, classType: 'Cover Class' },
    });
    expect(page.url()).toBe(`http://localhost:3000/studio-class/${created.id}`);
    expect(created.templateId).toBeNull();

    // COUNT — before cancelling: the editor lives in the `cancelledAt === null`
    // branch and is gone from the cancelled page entirely.
    await page.getByLabel('Student count').fill('11');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText('Saved')).toBeVisible();
    await expect
      .poll(async () =>
        (await prisma.studioClass.findUniqueOrThrow({ where: { id: created.id } })).studentCount,
      )
      .toBe(11);

    // CANCEL — two clicks. The confirm button reads `Cancel`, which is a prefix
    // of `Cancel class`, so it needs `exact`.
    await page.getByRole('button', { name: 'Cancel class' }).click();
    await expect(page.getByText('Cancel this studio class?')).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(page.getByText('This class was cancelled.')).toBeVisible();
    await expect(page.getByLabel('Student count')).toHaveCount(0);

    // REMOVE — offered because the class is manual and past-dated. A cancelled
    // class is not an income record, so the confirm claims no cost.
    await page.getByRole('button', { name: 'Remove this class' }).click();
    await expect(page.getByText('Remove this class? This cannot be undone.')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();

    // A hard navigation, not a soft push — see the comment at
    // `delete-studio-class-button.tsx:76-90`.
    await page.waitForURL('http://localhost:3000/', { timeout: 10_000 });
    expect(await prisma.studioClass.count({ where: { id: created.id } })).toBe(0);
  });
});
