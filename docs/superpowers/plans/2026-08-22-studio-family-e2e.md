# Studio Family End-to-End Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Drive the studio class family through a real browser for the first time — a template from creation through pause, resume, archive and un-archive, and a one-off class from logging through student count, cancellation and removal — and fix the list divergence that arc walks into.

**Architecture:** One new Playwright spec, `tests/e2e/studio.spec.ts`, with two serial `describe` blocks over a single Prisma-seeded teacher, modelled on `tests/e2e/recurring.spec.ts`. One seventh screen in `visual.spec.ts`. One source fix plus one component test in `src/components/settings/`, which is the only part of this branch that runs under `npm run verify`.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma, Playwright (two projects: `chromium`, `Mobile Chrome`), vitest (three projects: `unit`, `integration`, `components`), Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-22-studio-family-e2e-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. Playwright specs are type-checked by `npm run typecheck` like everything else.
- **Never start or restart the dev server on :3000.** The user runs it. `playwright.config.ts` has `reuseExistingServer: true` and will attach to it.
- **`playwright.config.ts` pins `workers: 1` and `failOnFlakyTests: true`.** A fail-then-pass is a failure. Do not add `test.describe.configure({ mode: 'parallel' })`.
- **Every spec wraps its tests in `test.describe.configure({ mode: 'serial' })`** and this one must too. Not redundant with `workers: 1` — see the comment at `playwright.config.ts:24-33`.
- **`vitest.config.ts` pins `TZ: 'America/New_York'` at the root**, west of UTC. Playwright inherits the shell's zone, not this pin; the app on :3000 has its own. Do not assume they agree.
- **In the `components` vitest project `fetch` is NOT mocked.** `studio-template-list.tsx` renders no fetch-calling control, so Task 1 needs no stub — but do not copy a stub in from a sibling test either.
- **Studio `dayOfWeek` is `0 = Monday … 6 = Sunday`** (`studio-template-form.tsx:53-61`, `class-generator.ts:51-54`), which is **not** JS `getUTCDay()`. Never write the integer; **select the day by its visible label**, as `recurring.spec.ts:112` does.
- **Never `git add -A` or `git add .`.** Stage exact paths, and **quote any path containing `(teacher)`.**
- **Currency is inline `€{n.toFixed(2)}`** — there is no formatter in `src/lib/format.ts`.
- **`npm run verify` is `typecheck && lint && vitest`** (`package.json:15`). Playwright is **not** in it. The e2e suite runs under `npx playwright test` and in CI only.
- **Warm a route before scoring a mutation.** `next dev` recompiles lazily; the first request after a source edit pays compilation and can blow a timeout that reads exactly like an assertion failure. Apply mutation → load the touched page once → then judge RED/GREEN.
- **Record every mutation** in `docs/superpowers/plans/2026-08-22-studio-family-e2e-mutations.md`, following the shape of `2026-08-21-studio-class-deletion-mutations.md`: the mutation, the verbatim failure text from a real run, and confirmation that restoring returned it to green.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/components/settings/studio-template-list.tsx` | modify | Three sections, **one** title expression and **one** caption expression |
| `src/components/settings/studio-template-list.test.tsx` | create | Renders one template in each of the three states, asserts the title and caption agree |
| `tests/e2e/studio.spec.ts` | create | The two arcs |
| `tests/e2e/visual.spec.ts` | modify | Seventh screen: the paused template detail page |
| `tests/e2e/visual.spec.ts-snapshots/` | create ×2 | `studio-template-chromium-darwin.png`, `studio-template-Mobile Chrome-darwin.png` |
| `docs/superpowers/plans/2026-08-22-studio-family-e2e-mutations.md` | create | The mutation ledger |

---

## Task Order — what is load-bearing

1. **Task 1 first.** Task 2's step-5 assertion is red until #281's fix lands. A branch whose new spec is red at its own first commit cannot tell a real failure from an expected one.
2. **Within Task 2, the generated-class removal assertion must precede the archive.** Archiving deletes all four generated classes; after it there is no generated class left to assert about.
3. **Within Task 3, set count → cancel → remove.** `StudentCountEditor` renders only in the `cancelledAt === null` branch (`studio-class/[id]/page.tsx:102` ternary, editor at `:120`).
4. **Task 4 last.** Baselines are generated artifacts; regenerating them before the fixtures settle wastes a round.

---

## Task 1: One title, one caption, and the test that compares the three sections

Closes #281 in full.

**Files:**
- Modify: `src/components/settings/studio-template-list.tsx` (titles `:30`, `:52`, `:76`; captions `:35`, `:57`, `:81`)
- Create: `src/components/settings/studio-template-list.test.tsx`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing importable. Task 2 depends on the *behaviour* — that a paused template's row still shows its `classType`.

**The defect.** Three sections rendered from one array, with two spellings:

| section | title | caption line 2 |
|---|---|---|
| active (`:30`, `:35`) | `{t.classType \|\| t.location}` | `{t.location} · €{rate}/hr` |
| paused (`:52`, `:57`) | `{t.location}` | `€{rate}/hr` |
| archived (`:76`, `:81`) | `{t.location}` | `€{rate}/hr` |

- [ ] **Step 1: Write the failing test**

Create `src/components/settings/studio-template-list.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { StudioClassTemplate } from '@prisma/client';
// The pure-JS Decimal, the same import `class-list.test.tsx:5` uses — a
// component test must not pull in the query engine.
import { Decimal } from '@prisma/client/runtime/library';
import { StudioTemplateList } from './studio-template-list';

/**
 * #281. Three sections are rendered from one array, and they drifted: the
 * active row titled itself with the class type and kept the location in its
 * caption, while the paused and archived rows did neither — so pausing a
 * template visibly renamed it, on the same page, in the section directly below
 * the one it had just left.
 *
 * Every case here renders ONE template so the query is unambiguous, and every
 * case asserts the same two things, because the risk is divergence between the
 * sections rather than any single section being wrong.
 */
const base = {
  id: 't1',
  teacherId: 'teacher-1',
  classType: 'Vinyasa',
  dayOfWeek: 1,
  startTime: '09:00',
  durationMinutes: 60,
  location: 'Yoga Studio Centrum',
  hourlyRate: new Decimal(45),
  isActive: true,
  isArchived: false,
  archivedAt: null,
  withdrawnCount: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
} satisfies StudioClassTemplate;

const STATES = [
  { name: 'active', template: { ...base, isActive: true, isArchived: false } },
  { name: 'paused', template: { ...base, isActive: false, isArchived: false } },
  { name: 'archived', template: { ...base, isActive: false, isArchived: true } },
];

describe('StudioTemplateList — the three sections agree', () => {
  for (const { name, template } of STATES) {
    it(`titles a ${name} template with its class type`, () => {
      render(<StudioTemplateList templates={[template]} />);
      expect(screen.getByText('Vinyasa')).toBeDefined();
    });

    it(`keeps the location in a ${name} template's caption`, () => {
      render(<StudioTemplateList templates={[template]} />);
      expect(screen.getByText(/Yoga Studio Centrum · €45\.00\/hr/)).toBeDefined();
    });
  }

  it('still falls back to the location when there is no class type', () => {
    render(<StudioTemplateList templates={[{ ...base, classType: '' }]} />);
    // Title and caption both carry it, so two nodes match — `getAllByText`,
    // not `getByText`, which throws on more than one.
    expect(screen.getAllByText(/Yoga Studio Centrum/).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails on four of the seven cases**

```bash
npx vitest run --project components src/components/settings/studio-template-list.test.tsx
```

Expected: **FAIL**. The two active cases and the fallback case pass; the paused
and archived title cases fail on `Unable to find an element with the text:
Vinyasa`, and the paused and archived caption cases fail on the caption regex.
Record the verbatim output — it is M1 in the mutation ledger, inverted: the
guard is being proved by the defect it was written against.

- [ ] **Step 3: Make the three sections agree**

In `src/components/settings/studio-template-list.tsx`, change the paused and
archived **titles** from `{t.location}` to `{t.classType || t.location}`, and
their **captions** from

```tsx
<span className="type-caption">
  &euro;{Number(t.hourlyRate).toFixed(2)}/hr
</span>
```

to

```tsx
<span className="type-caption">
  {t.location} &middot; &euro;{Number(t.hourlyRate).toFixed(2)}/hr
</span>
```

so all three read exactly as the active section at `:35` does. Do not
restructure the three blocks into one — that is a larger change than #281 asks
for, and the test is what holds them together from now on.

- [ ] **Step 4: Run it and confirm all seven pass**

```bash
npx vitest run --project components src/components/settings/studio-template-list.test.tsx
```

Expected: **PASS**, 7 tests.

- [ ] **Step 5: Mutation M2 — re-diverge one section only**

Revert the **archived** title to `{t.location}`, leaving paused fixed. Run the
file again.

Expected: **FAIL**, exactly one test — `titles an archived template with its
class type`. This proves the test discriminates per-section rather than passing
on the strength of the active case. Restore, re-run, confirm 7 pass. Record as
M2.

- [ ] **Step 6: Full verify**

```bash
npm run verify
```

Expected: green. Record the `components` project's file and test counts before
and after this task — they go in the PR body.

- [ ] **Step 7: Commit**

```bash
git add src/components/settings/studio-template-list.tsx src/components/settings/studio-template-list.test.tsx
git commit -m "fix: three sections of one list, two spellings (issue 281)"
```

---

## Task 2: The template arc

**Files:**
- Create: `tests/e2e/studio.spec.ts`

**Interfaces:**
- Consumes: `uniqueSuffix`, `seedSession`, `sessionCookie` from `tests/helpers.ts`; `accountIdOfTeacher` from `tests/e2e/account-helpers.ts`.
- Produces: the fixture (`teacherId`, `teacherToken`, `templateId`, `templateDayName`) that Task 3's second `describe` reuses from the same module scope.

**Facts this task depends on, all verified against `f9c9e69` — re-check any that look stale and report the drift:**

- Creation fills the window itself: `POST /api/studio-class-templates` calls `generateStudioInstancesForTemplate` (`src/app/api/studio-class-templates/route.ts:111`). No cron needed.
- `DEFAULT_WEEKS = 4` (`studio-class-generator.ts:15`); candidates are `getNextOccurrences(dayOfWeek, startDate, 5)` filtered on `classStartInstant(...) > startDate` then `.slice(0, 4)` (`:138-143`). With the template three days out, the four dates fall at +3, +10, +17 and +24 days.
- The schedule window is the current local week's start through **28 days ahead** (`(teacher)/page.tsx:15-22`), so all four are on `/`.
- On a clean window the create form navigates: `router.push(STUDIO_CLASSES_PATH)` (`studio-template-form.tsx:195`). A *short* window stays on the page and speaks instead — a fresh teacher's window is clean, so expect the navigation.
- `ArchiveStudioTemplateButton` renders only when `!isActive` (`settings/studio-classes/[id]/page.tsx:55`); `ToggleStudioTemplateButton` only when `!isArchived` (`:52`).
- Both archive directions force `isActive: false` (`studio-class-template-lifecycle.ts:1226`).

**The four confirmation sentences, as the resolvers produce them.** Assert on
distinctive substrings, not whole strings — and **measure the real text on the
first run** rather than trusting these; a wrong predicted output in a plan is
this project's most common plan defect.

| action | resolver arm | expected text |
|---|---|---|
| pause | `pauseMessage(last)` `:26` | `No new classes will be added to your schedule. The last one still scheduled is <day header> · 08:15.` |
| resume | `buildResumeSentence(0, 4, zeros)` `:294-300` | `4 classes on your schedule. Nothing needed adding.` |
| archive | `archiveStudioMessage(4, 0)` `:97` | `Deleted 4 scheduled studio classes. Nothing from this template is scheduled any more.` |
| un-archive | `UNARCHIVE_STUDIO_MESSAGE` `:320` | `Un-archived. This template is paused — resume it to put classes back on your schedule.` |

- [ ] **Step 1: Write the fixture and the first test**

Create `tests/e2e/studio.spec.ts`:

```ts
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
});
```

- [ ] **Step 2: Run it**

```bash
npx playwright test studio --project=chromium
```

Expected: **PASS**, 1 test. If the `Create` click does not navigate, read the
page — a short window keeps the form and prints a resume sentence, which would
mean the fixture teacher is not as clean as assumed. Report that rather than
weakening the assertion.

- [ ] **Step 3: Commit**

```bash
git add tests/e2e/studio.spec.ts
git commit -m "test: a studio template created through the browser (issue 283)"
```

- [ ] **Step 4: The four generated classes reach the schedule, and refuse removal**

Append inside the same `describe`:

```ts
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
```

- [ ] **Step 5: Run it**

```bash
npx playwright test studio --project=chromium
```

Expected: **PASS**, 2 tests.

- [ ] **Step 6: Mutation M3 — prove the removal assertion can fail**

In `src/services/studio-class-deletion.ts`, make the predicate return
`{ deletable: true }` unconditionally as its first statement. Load
`/studio-class/<id>` once in a browser or with `curl` to force the recompile,
then re-run the spec.

Expected: **FAIL** on `expected count 0, received 1` for the Remove control.
Restore, re-run, confirm 2 pass. Record as M3.

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/studio.spec.ts
git commit -m "test: the generated window on the schedule, and the door it keeps shut (issue 283)"
```

- [ ] **Step 8: Pause — the confirmation, and the control that appears**

```ts
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
    await expect(page.getByText('paused')).toBeVisible();
  });
```

- [ ] **Step 9: Run, then mutate**

```bash
npx playwright test studio --project=chromium
```

Expected: **PASS**, 4 tests.

**Mutation M4** — in `settings/studio-classes/[id]/page.tsx`, change the Archive
gate from `{!template.isActive && (` to `{false && (`. Warm the page, re-run.
Expected: **FAIL** on `Archive studio class` not becoming visible after the
pause. Restore, re-run, confirm 4 pass.

**Mutation M5** — revert the paused title in `studio-template-list.tsx` to
`{t.location}`. Warm `/settings/studio-classes`, re-run. Expected: **FAIL** on
`Studio Flow` not visible. This is the assertion that made Task 1 part of this
branch; it proves the e2e spec, not only the component test, holds the fix.
Restore, re-run, confirm 4 pass. Record M4 and M5.

- [ ] **Step 10: Commit**

```bash
git add tests/e2e/studio.spec.ts
git commit -m "test: pause, its sentence, and the control it reveals (issue 283)"
```

- [ ] **Step 11: Resume, then pause again, then archive**

```ts
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
```

- [ ] **Step 12: Run**

```bash
npx playwright test studio --project=chromium
```

Expected: **PASS**, 6 tests. If the resume sentence differs from the predicted
text, **use the real one** and note the correction in the mutation ledger and
the PR body.

- [ ] **Step 13: Commit**

```bash
git add tests/e2e/studio.spec.ts
git commit -m "test: resume with a full window, and the pause archiving requires (issue 283)"
```

- [ ] **Step 14: The archived list is the only door back, and un-archive returns it paused**

```ts
  test('an archived template leaves the live list for the archived one', async ({ page }) => {
    await page.goto('/settings/studio-classes');
    await expect(page.getByText('Studio Flow')).toHaveCount(0);

    // `/settings/studio-classes` queries `isArchived: false`, so this page is
    // the only route back to an archived template's detail page.
    await page.goto('/settings/studio-classes/archived');
    await expect(page.getByText('Studio Flow')).toBeVisible();

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

    // Back on the live list, marked paused, still named.
    await page.goto('/settings/studio-classes');
    await expect(page.getByText('Studio Flow')).toBeVisible();
    await expect(page.getByText('paused')).toBeVisible();
  });
```

- [ ] **Step 15: Run, then mutate**

```bash
npx playwright test studio --project=chromium
```

Expected: **PASS**, 8 tests.

**Mutation M6** — in `studio-class-template-lifecycle.ts:1226`, change
`isActive: false` to `isActive: true` in the archive CAS. Warm the page, re-run.
Expected: **FAIL** in `un-archiving returns the template paused` on
`expect(t.isActive).toBe(false)` **and** on the missing `Resume studio class`
control. Two failures from one mutation is the point: the sentence and the
screen are pinned together. Restore, re-run, confirm 8 pass. Record as M6.

- [ ] **Step 16: Commit**

```bash
git add tests/e2e/studio.spec.ts
git commit -m "test: the archived list as the only door, and what un-archive returns (issue 283)"
```

---

## Task 3: The one-off class arc

**Files:**
- Modify: `tests/e2e/studio.spec.ts` (append a second `describe`)

**Interfaces:**
- Consumes: `prisma`, `suffix`, and the module-scope `let` bindings from Task 2. **This describe seeds its own teacher** — the first one's `afterAll` deletes it, and Playwright runs `beforeAll`/`afterAll` per describe, so sharing the row across both would make the second block depend on the first's teardown not having run yet. Use a second suffix-derived teacher.
- Produces: nothing.

**Facts this task depends on:**

- `createStudioClassSchema.date` is `isoDate` with **no lower bound** (`schemas.ts:467-474`), so a past-dated one-off is creatable through the form.
- `/studio-class/new` does **not** redirect on success: it shows a `SettledNotice` labelled `Created` with an action button `Go to the studio class` (`studio-class/new/page.tsx:168-174`).
- `StudentCountEditor` renders only when `cancelledAt === null` (`studio-class/[id]/page.tsx:102` ternary, editor at `:120`). **Set the count before cancelling.**
- Both destructive controls are two-click: `Cancel class` → `Cancel this studio class?` → `Cancel`; `Remove this class` → `Remove this class? …` → `Remove` (`cancel-studio-class-button.tsx:44-68`, `delete-studio-class-button.tsx:97-121`). The confirm button reads `Cancel`, which is a **prefix of** `Cancel class` — use `{ exact: true }`.
- Removal ends in `window.location.assign('/')` — a hard navigation, not `router.push` (`delete-studio-class-button.tsx:90`). Wait for the URL, not for a soft transition.

- [ ] **Step 1: Write the whole arc as one test**

Append to `tests/e2e/studio.spec.ts`:

```ts
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

    // No redirect: a `SettledNotice` with an action button.
    await expect(page.getByText('Created')).toBeVisible();
    await page.getByRole('button', { name: 'Go to the studio class' }).click();

    const created = await prisma.studioClass.findFirstOrThrow({
      where: { teacherId: soloTeacherId, classType: 'Cover Class' },
    });
    await page.waitForURL(`**/studio-class/${created.id}`);
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
```

- [ ] **Step 2: Run the whole spec**

```bash
npx playwright test studio --project=chromium
```

Expected: **PASS**, 9 tests.

- [ ] **Step 3: Mutation M7 — prove the ordering constraint is real**

Move the `COUNT` block to after the `CANCEL` block. Re-run. Expected: **FAIL**
on `Student count` not being found — the editor is not on a cancelled page. This
records why the order is load-bearing rather than stylistic. Restore, re-run,
confirm 9 pass.

- [ ] **Step 4: Mutation M8 — prove the removal assertion bites**

In `src/app/api/studio-classes/[id]/route.ts`, make the `DELETE` handler return
its success response without deleting the row. Warm the route, re-run. Expected:
**FAIL** on `expect(count).toBe(0)` receiving `1`. This distinguishes "the UI
navigated" from "the row is gone". Restore, re-run, confirm 9 pass. Record M7
and M8.

- [ ] **Step 5: Run both browser projects**

```bash
npx playwright test studio
```

Expected: **PASS**, 18 tests (9 × two projects).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/studio.spec.ts
git commit -m "test: a one-off studio class logged, counted, cancelled and removed (issue 283)"
```

---

## Task 4: A seventh visual screen

**Files:**
- Modify: `tests/e2e/visual.spec.ts`
- Create: `tests/e2e/visual.spec.ts-snapshots/studio-template-chromium-darwin.png`
- Create: `tests/e2e/visual.spec.ts-snapshots/studio-template-Mobile Chrome-darwin.png`

**Interfaces:**
- Consumes: the existing `visual.spec.ts` fixture (`teacherId`, `teacherToken`, `signIn`, `hideDevOverlay`).
- Produces: nothing.

**Why a paused template.** It is the only state showing both controls at once,
and it is the first settings *detail* page in the baseline set. Paused means the
sweep generates nothing, so **no `StudioClass` row appears and `schedule.png` is
unaffected** — do not let this task regenerate an existing baseline.

- [ ] **Step 1: Add the fixture**

In `visual.spec.ts`'s `beforeAll`, after the notification create, add:

```ts
    // Paused, deliberately: `!isActive` is what draws BOTH controls, and a
    // paused template generates nothing, so `schedule.png` is untouched.
    // Wednesday 18:00 — a different (dayOfWeek, startTime) from the fixture
    // class at Tuesday 09:00, so nothing can brush #296's slot guards.
    const studioTemplate = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Visual Studio Flow',
        dayOfWeek: 2, // 0 = Monday in this schema, so 2 is Wednesday
        startTime: '18:00',
        durationMinutes: 75,
        location: 'Visual Community Studio',
        hourlyRate: 42,
        isActive: false,
      },
    });
    studioTemplateId = studioTemplate.id;
```

Declare `let studioTemplateId: string;` beside the other module-scope bindings.

- [ ] **Step 2: Add the teardown**

In `afterAll`, **before** the teacher delete:

```ts
    await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
```

- [ ] **Step 3: Add the test, after `settings index`**

```ts
  test('studio template detail (paused)', async ({ page, context }) => {
    await signIn(context);
    await page.goto(`/settings/studio-classes/${studioTemplateId}`);
    await freezeDates(page);
    await expect(page).toHaveScreenshot('studio-template.png', {
      fullPage: true,
      stylePath: hideDevOverlay,
    });
  });
```

All six existing tests call `freezeDates(page)` in exactly this position
(`visual.spec.ts:263,270,284,298,312,326`), so keep it. `settings index`
(`:320-327`) passes only `fullPage` and `stylePath` with no mask, and this page
renders no timestamps either — match it. If the render turns out to carry
dynamic text after all, mask it with `dynamicText(page)` as the other tests do
rather than deleting the assertion.

- [ ] **Step 4: Generate the baselines**

```bash
npx playwright test visual --grep "studio template" --update-snapshots
```

Expected: two new PNGs written. **Open both and look at them.** A baseline is
only worth having if it shows the screen you intended — confirm both controls
(`Resume studio class`, `Archive studio class`) are on the page.

- [ ] **Step 5: Confirm no existing baseline moved**

```bash
git status --short tests/e2e/visual.spec.ts-snapshots/
```

Expected: exactly two new files, **no modified ones**. A modified `schedule.png`
means the fixture leaked a `StudioClass` onto the schedule — investigate rather
than accepting it.

- [ ] **Step 6: Run the whole visual suite**

```bash
npx playwright test visual
```

Expected: **PASS**, 14 tests (7 × two projects).

- [ ] **Step 7: Commit**

```bash
git add tests/e2e/visual.spec.ts 'tests/e2e/visual.spec.ts-snapshots/studio-template-chromium-darwin.png' 'tests/e2e/visual.spec.ts-snapshots/studio-template-Mobile Chrome-darwin.png'
git commit -m "test: a seventh visual screen, the paused studio template (issue 283)"
```

---

## Task 5: Whole-branch verification and the PR

**Files:**
- Create: `docs/superpowers/plans/2026-08-22-studio-family-e2e-mutations.md`

- [ ] **Step 1: Write the mutation ledger**

Collect M1–M8 into `docs/superpowers/plans/2026-08-22-studio-family-e2e-mutations.md`,
following `2026-08-21-studio-class-deletion-mutations.md`: for each, the exact
mutation, the verbatim failure output from a real run, and the restore
confirmation. **A mutation that came back GREEN is the most valuable line in the
file** — record it as GREEN and say what that means about the guard.

- [ ] **Step 2: Full static and unit verification**

```bash
npm run verify
```

Expected: green. Record the per-project file and test counts. Arithmetic must
reconcile: `unit + components + integration = total`.

- [ ] **Step 3: Full Playwright run, both projects**

```bash
npx playwright test
```

Expected: green, with no test classified flaky (`failOnFlakyTests: true` makes
a fail-then-pass a failure).

- [ ] **Step 4: Commit the ledger**

```bash
git add docs/superpowers/plans/2026-08-22-studio-family-e2e-mutations.md
git commit -m "docs: the eight mutations, and what each proved (issue 283)"
```

- [ ] **Step 5: Push and open the PR**

The PR body must carry:

- The two premise corrections from spec §1, with the commits that falsified
  them (`8f7f8f9`/#136 and `bccfb1d`/#279).
- Before and after test counts with reconciling arithmetic, measured not
  predicted. Before: 174 studio tests across 12 files (`79 + 39 + 56 = 174`).
- Which suites ran: `npm run verify` (all three vitest projects) **and**
  `npx playwright test` (both browser projects) — naming
  `tests/e2e/studio.spec.ts` and `tests/e2e/visual.spec.ts` by path.
- The eight mutations and their verdicts, with any GREEN called out.
- Any predicted confirmation sentence in this plan that turned out wrong, and
  what the real text was.
- **Scope, phrased safely.** Write "**#284 is unaffected**", "**leaves #275
  open**". **Never** write the word `close`/`fix`/`resolve` immediately before a
  `#`-number — GitHub's parser ignores a negation in front of it and has closed
  an issue in this repo twice that way, once from a commit written to warn about
  the trap. `#281` is genuinely finished by this branch, so it may carry a real
  closing keyword; every other number must not.

---

## Self-Review Notes

**Spec coverage.** §4.1 steps 1-9 → Task 2 (steps 1, 4, 8, 11, 14) and Task 3.
§4.2 → Task 4. §4.3 → Task 1. §6's three orderings → the Task Order section and
mutations M5 and M7, which prove two of them rather than asserting them. §7's
acceptance → Task 5.

**One deliberate deviation from the spec.** §4.1 describes one `describe` with
nine numbered steps; this plan realises them as **eight** Playwright `test`s,
because spec steps 2 and 3 — the four cards on the schedule, and a generated
class refusing removal — share a test. The assertions are the same set; a
`test` is the unit that gets a name in the report, and a serial `describe`
carries state between them either way.

**Test counts this plan commits to**, which the executor should reconcile
against rather than re-derive:

| | tests | ×projects | reported |
|---|---|---|---|
| Task 1 `studio-template-list.test.tsx` | 7 | 1 (components) | 7 |
| Task 2 `describe('Studio class templates')` | 8 | 2 | 16 |
| Task 3 `describe('One-off studio classes')` | 1 | 2 | 2 |
| `tests/e2e/studio.spec.ts` total | **9** | 2 | **18** |
| Task 4 `visual.spec.ts` | 7 (6 existing + 1) | 2 | 14 |

Task 2's step-by-step expectations run 1 → 2 → 4 → 6 → 8 as its four commits
land.

**One thing the spec did not settle, resolved here.** Task 3 seeds its **own**
teacher rather than reusing Task 2's. Playwright runs `beforeAll`/`afterAll` per
`describe`, so the first block's teardown deletes its teacher before the second
block runs; sharing would have made the second arc depend on teardown ordering.
