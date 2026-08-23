import { test, expect } from '@playwright/test';
import { PrismaClient } from '@prisma/client';
import { accountIdOfTeacher } from './account-helpers';
import { hydrationSignal, patchOk, reloadHydrated, SERVER_RENDER_TIMEOUT } from './page-helpers';
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
 * controls on the template detail page are gated on SERVER-rendered props, so
 * which one is drawn is a function of what the previous step WROTE. A mocked
 * render asserts a state someone chose; a single fetch sees one state and
 * stops. This drives the whole arc through real clicks on the real controls
 * and re-reads the server after each one, so every step's props are the
 * previous step's writes.
 *
 * What it deliberately does NOT assert is that `router.refresh()` commits.
 * That was the original justification for this file and it did not survive
 * CI: the commit is dropped often enough on a loaded runner that asserting it
 * is a flake, not a test — `element(s) not found` at a full 10 s budget,
 * which is the same fault `teacher-journey.spec.ts` records under #40. Each
 * mutating click therefore waits for its PATCH and then RELOADS, and the
 * assertions that follow are about server truth. The refresh wiring itself is
 * held by the components' own tests.
 */

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

// Three days out, so the template's weekday is never the run day. On the run
// day the counts turn time-of-day-dependent: the generator filters candidates
// on `classStartInstant(date, startTime, tz) > startDate`
// (`studio-class-generator.ts`), so today's occurrence disappears once its
// start time has passed. `recurring.spec.ts` stays off the run day for the
// same reason.
const templateDate = new Date();
templateDate.setUTCDate(templateDate.getUTCDate() + 3);

// One table, in the schema's 0=Monday order (the same order
// `studio-template-form.tsx`'s DAY_OPTIONS uses). `getUTCDay()` is 0=Sunday,
// so shift by six to index this one — Sunday 0 -> 6, Monday 1 -> 0.
//
// Deliberately not two tables agreeing through `indexOf`: a typo in either
// returned -1, which `% 7` turned into a silent Monday rather than a failure.
const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const templateDayOfWeek = (templateDate.getUTCDay() + 6) % 7;
const templateDayName = DAY_LABELS[templateDayOfWeek]!;

// The day after, so the second fixture template — seeded through Prisma
// rather than the form, and so with no label to select — sits on a different
// (dayOfWeek, startTime) from the one the form creates.
const otherTemplateDayOfWeek = (templateDayOfWeek + 1) % 7;

let teacherId: string;
let teacherToken: string;
let templateId: string;
let otherTemplateId: string;

/**
 * `templateId` is assigned by the first test. Serial mode SKIPS the rest when
 * that one fails, so this is not for that case — it is for running one of them
 * alone (`playwright test -g`), where the id is `undefined`, the goto lands on
 * `/settings/studio-classes/undefined`, the page redirects, and the real cause
 * surfaces five seconds later as "element(s) not found".
 */
function requireTemplateId(): void {
  expect(templateId, 'templateId comes from the first test — run the whole describe').toBeTruthy();
}

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
    // Order doesn't matter here the way it does in recurring.spec.ts: this
    // fixture creates no Room, so #290's hazard (a regenerated class
    // stranding TeacherRoom under Restrict) cannot arise. StudioClass.templateId
    // is SetNull (`StudioClass_templateId_fkey`) and Teacher -> StudioClass is
    // Cascade, and this spec fires no cron and leaves both templates paused,
    // so nothing can regenerate a class behind this teardown either.
    //
    // Guarded because an unset `teacherId` is not a filter that matches
    // nothing — Prisma DROPS an `undefined` where-clause, making this
    // `DELETE FROM "StudioClass"`. Playwright runs afterAll even when
    // beforeAll threw, which is exactly when `teacherId` is unset.
    if (teacherId) {
      await prisma.studioClass.deleteMany({ where: { teacherId } });
      await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
      await prisma.session.deleteMany({ where: { accountId: await accountIdOfTeacher(prisma, teacherId) } });
      await prisma.teacher.delete({ where: { id: teacherId } });
    }
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(teacherToken)]);
  });

  test('creates a template through settings and fills the window', async ({ page }) => {
    const hydrated = hydrationSignal(page);
    await page.goto('/settings/studio-classes/new');
    await hydrated;

    await page.getByLabel('Class type').fill('Studio Flow');
    await page.getByLabel('Location').fill('Community Studio');
    // Selected by LABEL, never by integer — the label sidesteps the two
    // day-numbering conventions reconciled at the top of this file. What the
    // form then STORES is checked on the list, further down the arc.
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
    requireTemplateId();
    await page.goto('/');

    // `StudioClassCard` (`schedule/class-list.tsx`) renders
    // "<classType> · <location> · Studio class". All four dates
    // (+3, +10, +17, +24 days) sit inside the schedule's 28-day window.
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

    // Issue 304: the page this card opens must head with what the card led
    // with — the class type, not the venue. The arc created both values, so
    // this is the exact pairing a teacher taps through.
    await expect(page.getByRole('heading', { name: 'Studio Flow' })).toBeVisible();

    // The Template link is labelled with the same expression as the header of
    // the page it opens, so following it cannot land the teacher on a
    // differently-named screen. Not an edge case: `classType` is a non-null
    // column that every write path validates as `.min(1)`, so the location
    // fallback never fires for a template and the two must agree every time.
    const templateLink = page.getByRole('link', { name: /Studio Flow/ });
    await expect(templateLink).toHaveAttribute('href', `/settings/studio-classes/${templateId}`);
  });

  test('pausing says what stays scheduled, and reveals Archive', async ({ page }) => {
    requireTemplateId();
    // Read the two ends of the window BEFORE pausing, so the assertion below
    // can tell "last" from "first". Every one of the four shares 08:15, so
    // the date is the only field that distinguishes them.
    const scheduled = await prisma.studioClass.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
      select: { date: true },
    });
    expect(scheduled).toHaveLength(4);
    const lastDay = scheduled[3]!.date.getUTCDate();
    const firstDay = scheduled[0]!.date.getUTCDate();

    const hydrated = hydrationSignal(page);
    await page.goto(`/settings/studio-classes/${templateId}`);
    await hydrated;

    // An ACTIVE template offers Pause and nothing else: Archive is drawn
    // behind `{!template.isActive && …}` in `settings/studio-classes/[id]/page.tsx`.
    await expect(page.getByRole('button', { name: 'Pause studio class' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Archive studio class' })).toHaveCount(0);

    const paused = patchOk(page, `/api/studio-class-templates/${templateId}`);
    await page.getByRole('button', { name: 'Pause studio class' }).click();
    await paused;

    // `pauseMessage` names the last class still standing — pause deletes
    // nothing, so all four survive and the FOURTH is the one named. The day
    // number is matched rather than the whole rendered date so this does not
    // reimplement `formatDayHeader`; matching only its shape would let a
    // regression that names the first class through.
    //
    // Asserted BEFORE the reload below: this sentence is client state and the
    // reload discards it.
    await expect(page.getByText(/No new classes will be added to your schedule\./)).toBeVisible();
    await expect(
      page.getByText(new RegExp(`The last one still scheduled is \\w+, ${lastDay} \\w{3} · 08:15\\.`)),
    ).toBeVisible();
    expect(lastDay).not.toBe(firstDay);

    // Server truth, re-read rather than waited for — see the file docblock.
    await reloadHydrated(page);
    await expect(page.getByRole('button', { name: 'Resume studio class' })).toBeVisible(SERVER_RENDER_TIMEOUT);
    await expect(
      page.getByRole('button', { name: 'Archive studio class', exact: true }),
    ).toBeVisible(SERVER_RENDER_TIMEOUT);

    expect(await prisma.studioClass.count({ where: { templateId } })).toBe(4);
  });

  test('the paused row keeps its name on the list', async ({ page }) => {
    // Issue 281: the paused section used to title itself with the location, so
    // pausing renamed the template on the page it returns you to.
    await page.goto('/settings/studio-classes');
    await expect(page.getByText('Studio Flow')).toBeVisible();
    await expect(page.getByText(/Community Studio · €45\.00\/hr/)).toBeVisible();

    // The weekday the form stored, read back — the only place this arc pins
    // the 0=Monday convention. The form is driven by LABEL, so a re-indexed
    // DAY_OPTIONS would still select the right label and still generate four
    // classes inside the window; it would just store the wrong day, and a
    // rendered weekday is the only thing that shows it.
    await expect(page.getByText(`${templateDayName} 08:15 · 60 min`)).toBeVisible();
    // Scoped to this row: the second fixture template is paused throughout
    // this whole spec, so a bare `page.getByText('paused')` would match both.
    const row = page.getByRole('link', { name: /Studio Flow/ });
    await expect(row.getByText('paused')).toBeVisible();
  });

  test('resuming reports the window it already has', async ({ page }) => {
    requireTemplateId();
    const hydrated = hydrationSignal(page);
    await page.goto(`/settings/studio-classes/${templateId}`);
    await hydrated;
    const resumed = patchOk(page, `/api/studio-class-templates/${templateId}`);
    await page.getByRole('button', { name: 'Resume studio class' }).click();
    await resumed;

    // `added: 0, scheduled: 4` — pause deleted nothing, so the window was
    // already full and this resume adds none. That asymmetric pair is exactly
    // what `template-action-messages.ts` asks a test to drive, because equal
    // arguments cannot detect a transposition.
    await expect(page.getByText('4 classes on your schedule. Nothing needed adding.')).toBeVisible();

    // Active again, so Archive is gated off again. Left inexact deliberately:
    // for a `toHaveCount(0)`, substring matching is the STRICTER reading,
    // because it also fails on an "Unarchive studio class" button appearing.
    await reloadHydrated(page);
    await expect(page.getByRole('button', { name: 'Pause studio class' })).toBeVisible(SERVER_RENDER_TIMEOUT);
    await expect(page.getByRole('button', { name: 'Archive studio class' })).toHaveCount(0, SERVER_RENDER_TIMEOUT);
  });

  test('archiving withdraws the window and says how much', async ({ page }) => {
    requireTemplateId();
    const hydrated = hydrationSignal(page);
    await page.goto(`/settings/studio-classes/${templateId}`);
    await hydrated;

    // Archiving needs a paused template — this second pause is the
    // composition, not a workaround.
    const paused = patchOk(page, `/api/studio-class-templates/${templateId}`);
    await page.getByRole('button', { name: 'Pause studio class' }).click();
    await paused;
    await reloadHydrated(page);
    await expect(
      page.getByRole('button', { name: 'Archive studio class', exact: true }),
    ).toBeVisible(SERVER_RENDER_TIMEOUT);

    const archived = patchOk(page, `/api/studio-class-templates/${templateId}`);
    await page.getByRole('button', { name: 'Archive studio class', exact: true }).click();
    await archived;

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
    requireTemplateId();
    await page.goto('/settings/studio-classes');
    // The still-live second template stays on this list — the same filter
    // that dropped the archived one (its `isArchived: false` filter)
    // leaves an unarchived one in place. Asserted FIRST, so it anchors the
    // negative below: a session that had been bounced to /login would satisfy
    // a `toHaveCount(0)` on its own.
    await expect(page.getByText('Yin Retreat')).toBeVisible();
    await expect(page.getByText('Studio Flow')).toHaveCount(0);

    await page.goto('/settings/studio-classes/archived');
    await expect(page.getByText('Studio Flow')).toBeVisible();
    // ...and the reverse: the second template, never archived, does not
    // appear here either.
    await expect(page.getByText('Yin Retreat')).toHaveCount(0);

    await page.getByRole('link', { name: /Studio Flow/ }).click();
    await page.waitForURL(`**/settings/studio-classes/${templateId}`);

    // The header titles with the same expression the list does
    // (`{t.classType || t.location}`, in all three of
    // `studio-template-list.tsx`'s sections), so the two screens can't
    // disagree.
    await expect(page.getByRole('heading', { name: 'Studio Flow' })).toBeVisible();

    // Archived: Toggle is gated off by `!isArchived`, and Archive renders in
    // its un-archive direction. Exactly one control, and no dead end.
    await expect(page.getByRole('button', { name: 'Pause studio class' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Resume studio class' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Unarchive studio class' })).toBeVisible();
  });

  test('un-archiving returns the template paused, not active', async ({ page }) => {
    requireTemplateId();
    const hydrated = hydrationSignal(page);
    await page.goto(`/settings/studio-classes/${templateId}`);
    await hydrated;
    const unarchived = patchOk(page, `/api/studio-class-templates/${templateId}`);
    await page.getByRole('button', { name: 'Unarchive studio class' }).click();
    await unarchived;

    // Client state, so before the reload.
    await expect(
      page.getByText('Un-archived. This template is paused — resume it to put classes back on your schedule.'),
    ).toBeVisible();

    // The screen agreeing with the sentence: both controls, because
    // `isArchived` is false again and `isActive` was forced false in the same
    // write — the un-archive branch of `archiveOrUnarchiveStudioTemplate`.
    //
    // `exact` on the second one is load-bearing, not decoration: Playwright
    // matches an accessible name as a case-insensitive SUBSTRING, and
    // "Unarchive studio class" CONTAINS "Archive studio class". Without it
    // this assertion is satisfied by the button it is meant to prove was
    // replaced, and says nothing at all.
    await reloadHydrated(page);
    await expect(page.getByRole('button', { name: 'Resume studio class' })).toBeVisible(SERVER_RENDER_TIMEOUT);
    await expect(
      page.getByRole('button', { name: 'Archive studio class', exact: true }),
    ).toBeVisible(SERVER_RENDER_TIMEOUT);

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
    // Guarded for the same reason as the template block's teardown: an unset
    // id makes the where-clause vanish rather than match nothing.
    if (soloTeacherId) {
      await prisma.studioClass.deleteMany({ where: { teacherId: soloTeacherId } });
      await prisma.session.deleteMany({
        where: { accountId: await accountIdOfTeacher(prisma, soloTeacherId) },
      });
      await prisma.teacher.delete({ where: { id: soloTeacherId } });
    }
    await prisma.$disconnect();
  });

  test.beforeEach(async ({ context }) => {
    await context.addCookies([sessionCookie(soloToken)]);
  });

  test('log, count, cancel, remove', async ({ page }) => {
    // LOG — from the schedule, the way a teacher reaches it. Waiting for
    // hydration here covers the whole test: the link click is then a client
    // push within the same layout, so `/studio-class/new` arrives already
    // hydrated and its submit handler is attached before the click below.
    const hydrated = hydrationSignal(page);
    await page.goto('/');
    await hydrated;
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
    // the Task 3 walkthrough table in
    // `docs/superpowers/specs/2026-08-22-studio-family-e2e-design.md`, row 1.
    await page.waitForURL(/\/studio-class\/(?!new$)[\w-]+$/, { timeout: 10_000 });

    const created = await prisma.studioClass.findFirstOrThrow({
      where: { teacherId: soloTeacherId, classType: 'Cover Class' },
    });
    expect(page.url()).toBe(`http://localhost:3000/studio-class/${created.id}`);
    expect(created.templateId).toBeNull();

    // Issue 304, manual half: the page the log form lands on heads with the
    // class type just typed and keeps the venue on screen — both facts the
    // form itself collected.
    await expect(page.getByRole('heading', { name: 'Cover Class' })).toBeVisible();
    await expect(page.getByText('Guest Studio')).toBeVisible();

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

    // CANCEL — two clicks. `exact` pins the confirm button to its whole name:
    // it shares the block with `Keep`, and `Cancel class` is already unmounted
    // by the time it renders, so the two never coexist.
    await page.getByRole('button', { name: 'Cancel class' }).click();
    await expect(page.getByText('Cancel this studio class?')).toBeVisible();

    // Unlike the template buttons, this one sets no message — the confirm
    // prompt is client state from BEFORE the click, so nothing between the
    // click and the assertion proves the PUT resolved. Wait for it, then read
    // the server back, for the same reason as the template arcs above.
    const cancelled = page.waitForResponse(
      (r) =>
        r.url().includes(`/api/studio-classes/${created.id}`) &&
        r.request().method() === 'PUT' &&
        r.ok(),
    );
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await cancelled;

    await reloadHydrated(page);
    await expect(page.getByText('This class was cancelled.')).toBeVisible(SERVER_RENDER_TIMEOUT);
    await expect(page.getByLabel('Student count')).toHaveCount(0, SERVER_RENDER_TIMEOUT);

    // REMOVE — offered because the class is manual and past-dated. A cancelled
    // class is not an income record, so the confirm claims no cost.
    await page.getByRole('button', { name: 'Remove this class' }).click();
    await expect(page.getByText('Remove this class? This cannot be undone.')).toBeVisible();
    await page.getByRole('button', { name: 'Remove', exact: true }).click();

    // A hard navigation, not a soft push — see the comment at
    // the `window.location.assign` comment in
    // `delete-studio-class-button.tsx`.
    await page.waitForURL('http://localhost:3000/', { timeout: 10_000 });
    expect(await prisma.studioClass.count({ where: { id: created.id } })).toBe(0);
  });
});
