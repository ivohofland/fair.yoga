# Calendar Day Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every date boundary and date rendering on the teacher surface agree with the teacher's calendar day rather than UTC's (#101 + #115).

**Architecture:** One rule, applied in both directions. A `@db.Date` column is a calendar date and is read with UTC accessors; `new Date()` is an instant and goes through `startOfLocalDay` before being compared to a calendar date. Both helpers already exist and are tested; this adds one (`startOfLocalWeek`), deletes a hand-rolled duplicate of another, and threads the teacher's timezone into the one shared component that needs it.

**Tech Stack:** Next.js App Router server components, Prisma (`@db.Date` columns), Vitest `unit` (node) and `components` (jsdom) projects.

## Global Constraints

- **TypeScript `strict: true`, `noUncheckedIndexedAccess` on.** No `any`, **no type assertions to silence a type error**, no eslint suppressions.
- **The rule, which every change here follows.** A `@db.Date` value is a *calendar date* — read it with UTC accessors, never `toLocaleDateString` without an explicit `timeZone`. A `new Date()` is an *instant* — convert it with `startOfLocalDay(instant, timeZone)` before comparing it to a calendar date.
- **Do not change any rendered copy.** Every label, date format and string must come out byte-identical. The only intended change is *which* day those strings describe.
- **The test suite already runs west of UTC.** `vitest.config.ts:60` pins `env: { TZ: 'America/New_York' }` at the root and all three projects inherit it (verified). **Do not add timezone plumbing to any test** — it inherits a zone in which these bugs are visible. Do not touch that config line.
- **Do not modify `prisma/schema.prisma`**; no migration.
- **Never restart the dev server on `:3000`.** It is managed manually by the repo owner.
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.

---

## File Structure

| File | Change | Task |
|---|---|---|
| `src/lib/timezone.ts` | Add `startOfLocalWeek`; extend the module docblock with the rule | 1 |
| `src/lib/timezone.test.ts` | Tests for `startOfLocalWeek` | 1 |
| `src/app/(teacher)/schedule/past/page.tsx` | Load `defaultTimezone`; boundary via `startOfLocalDay` | 2 |
| `src/app/(teacher)/page.tsx` | Load `defaultTimezone`; window via `startOfLocalWeek`; `formatTodayLabel` fed a local day | 2 |
| `src/components/schedule/class-list.tsx` | Required `timeZone` prop; `weekLabel` via `startOfLocalWeek`; delete `itemDateTime` for `classStartInstant` | 3 |
| `src/components/schedule/class-list.test.tsx` | Pass the new prop; two tests for the fixed behaviour | 3 |
| `src/app/(teacher)/students/[id]/page.tsx` | Three rendering sites (#115) | 4 |

**Task 1 first** because Tasks 2 and 3 both consume `startOfLocalWeek`. **Task 3 after Task 2** only because both touch `(teacher)/page.tsx` — Task 2 changes what it computes, Task 3 changes what it passes down. Task 4 is independent of all three and could run any time; it is last because it is the smallest.

---

### Task 1: `startOfLocalWeek`, and the rule written down

**Files:**
- Modify: `src/lib/timezone.ts` (module docblock at `:1-9`; new export)
- Modify: `src/lib/timezone.test.ts`

**Interfaces:**
- Consumes: `startOfLocalDay(instant: Date, timeZone: string): Date` — already exported from this module (`:57`).
- Produces: `export function startOfLocalWeek(instant: Date, timeZone: string): Date` — UTC-midnight Monday of the week containing that instant *in the given timezone*. Tasks 2 and 3 both import it.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/timezone.test.ts`. Extend the existing import on line 2 rather than adding a second one.

```ts
/**
 * #101. The teacher's week, not UTC's. Both the Schedule tab's query window and
 * the "This week" labels below it derived their Monday from `new Date()` read
 * with `getUTCDay`, so for a teacher west of UTC in their local evening — when
 * UTC has already rolled into the next day, and on Sundays into the next week —
 * the boundary landed a day or a week off.
 *
 * These fixtures use `America/Los_Angeles` (UTC-7 in June) and are all
 * instants where the UTC calendar day and the LA calendar day disagree.
 */
describe('startOfLocalWeek', () => {
  it('returns the Monday of the local week, not the UTC week', () => {
    // Sunday 20:00 LA = Monday 03:00 UTC. UTC has entered the next week; LA has not.
    const instant = new Date('2026-06-08T03:00:00.000Z');
    expect(startOfLocalWeek(instant, 'America/Los_Angeles').toISOString())
      .toBe('2026-06-01T00:00:00.000Z');
  });

  it('agrees with UTC when the two calendar days agree', () => {
    // Wednesday 12:00 UTC = Wednesday 05:00 LA — same calendar day, same week.
    const instant = new Date('2026-06-10T12:00:00.000Z');
    expect(startOfLocalWeek(instant, 'America/Los_Angeles').toISOString())
      .toBe('2026-06-08T00:00:00.000Z');
  });

  it('treats Monday as the first day of the week', () => {
    // Monday 09:00 LA — the week starts today, not six days ago.
    const instant = new Date('2026-06-08T16:00:00.000Z');
    expect(startOfLocalWeek(instant, 'America/Los_Angeles').toISOString())
      .toBe('2026-06-08T00:00:00.000Z');
  });

  it('rolls Sunday back to the Monday six days earlier', () => {
    // Sunday 09:00 LA. JS getUTCDay() is 0 for Sunday; the schema convention is
    // Monday-first, so this is the case a naive `1 - day` gets wrong by a week.
    const instant = new Date('2026-06-14T16:00:00.000Z');
    expect(startOfLocalWeek(instant, 'America/Los_Angeles').toISOString())
      .toBe('2026-06-08T00:00:00.000Z');
  });

  it('works east of UTC too', () => {
    // Monday 00:30 Amsterdam = Sunday 22:30 UTC. UTC is still last week.
    const instant = new Date('2026-06-07T22:30:00.000Z');
    expect(startOfLocalWeek(instant, 'Europe/Amsterdam').toISOString())
      .toBe('2026-06-08T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run --project unit src/lib/timezone.test.ts`

Expected: FAIL at import — `startOfLocalWeek` is not exported yet. Vitest reports this as a failed suite rather than failed assertions.

- [ ] **Step 3: Implement it**

In `src/lib/timezone.ts`, below `startOfLocalDay`:

```ts
/**
 * UTC-midnight Monday of the week containing `instant`, in `timeZone`.
 *
 * Built on `startOfLocalDay` rather than repeating its `Intl` work: the local
 * calendar day is the only timezone-sensitive part, and once you have it as a
 * midnight-UTC value the Monday is plain UTC arithmetic on a calendar date —
 * which is rule one, and correct.
 *
 * Monday-first, matching the `dayOfWeek` schema convention (0 = Monday).
 * `getUTCDay()` is Sunday-first, so Sunday maps back six days rather than
 * forward one.
 */
export function startOfLocalWeek(instant: Date, timeZone: string): Date {
  const day = startOfLocalDay(instant, timeZone);
  const jsDay = day.getUTCDay();
  day.setUTCDate(day.getUTCDate() + (jsDay === 0 ? -6 : 1 - jsDay));
  return day;
}
```

- [ ] **Step 4: Run the tests and watch them pass**

Run: `npx vitest run --project unit src/lib/timezone.test.ts`
Expected: PASS, five new tests plus the existing `startOfLocalDay` and `classStartInstant` suites unchanged.

- [ ] **Step 5: Write the rule into the module docblock**

The module docblock (`src/lib/timezone.ts:1-9`) explains why class times are timezone-aware. Extend it with the distinction this whole change turns on, appended before the closing `*/`:

```
 *
 * The rule this module exists to enforce, stated once because the codebase
 * relies on it everywhere and had never written it down:
 *
 *   - A `@db.Date` column is a *calendar date*, stored at midnight UTC. Read
 *     it with UTC accessors. Never hand it to `toLocaleDateString` without an
 *     explicit `timeZone` — that reads it in whatever zone the host is in.
 *   - A `new Date()` is an *instant*. Run it through `startOfLocalDay` (or
 *     `startOfLocalWeek`) before comparing it against a calendar date.
 *
 * Both failures look identical in a UTC host and are invisible in CI, which is
 * why the suite pins a west-of-UTC zone (`vitest.config.ts`). #101 broke the
 * second rule in five places; #115 broke the first in three.
```

Deliberately no count of call sites: this repo has twice had a number in a comment go stale (`tests/setup/components.ts`, `type-pins.ts`). The two issue numbers are historical facts and do not drift.

- [ ] **Step 6: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
git add src/lib/timezone.ts src/lib/timezone.test.ts
git commit -m "feat: add startOfLocalWeek, and write the calendar-date rule down (#101)"
```

---

### Task 2: The two page-level boundaries

**Files:**
- Modify: `src/app/(teacher)/schedule/past/page.tsx:7-27`
- Modify: `src/app/(teacher)/page.tsx:13-32`, `:66-69`

**Interfaces:**
- Consumes from Task 1: `startOfLocalWeek(instant: Date, timeZone: string): Date`, plus the existing `startOfLocalDay(instant: Date, timeZone: string): Date`.
- Produces for Task 3: both pages will hold a `timeZone` string in scope, ready to pass to `ClassList`. Task 3 adds that prop; do **not** add it here.

**No test in this task.** Both files are async server components that call `requireTeacherSession` and Prisma at module scope — there is no unit-test seam, and adding one would mean restructuring pages this change is not otherwise touching. The boundary logic they now call is fully tested in Task 1, and Task 3 covers the rendering. Say this plainly in your report rather than implying page-level coverage.

- [ ] **Step 1: Fix the past-classes boundary**

In `src/app/(teacher)/schedule/past/page.tsx`, add the import:

```ts
import { startOfLocalDay } from '@/lib/timezone';
```

Replace lines 8-9:

```ts
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
```

with a teacher lookup and a local boundary. The lookup is a **standalone `await` before** the `Promise.all`, not a third entry inside it: `today` appears in the `where` clause of both queries in that array, so it must already be resolved when they are constructed. That costs one serialised round trip and there is no way around it.

```ts
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: { defaultTimezone: true },
  });
  // #101. The teacher's calendar day, not UTC's. West of UTC in the local
  // evening, UTC has already rolled over, so a `setUTCHours(0,0,0,0)` boundary
  // is *tomorrow* by the teacher's calendar and lists a class they have not
  // taught yet as past.
  const today = startOfLocalDay(new Date(), teacher.defaultTimezone);
```

The `date: { lt: today }` filters on both queries are unchanged — the value they compare against is what was wrong, not the comparison.

- [ ] **Step 2: Fix the schedule window and the today caption**

In `src/app/(teacher)/page.tsx`, add the import:

```ts
import { startOfLocalWeek, startOfLocalDay } from '@/lib/timezone';
```

Replace `getScheduleWindow` (`:13-24`) with a timezone-aware version. Keep the existing docblock above it verbatim — it explains the four-week reach and is still true:

```ts
function getScheduleWindow(timeZone: string): { start: Date; end: Date } {
  const now = new Date();
  const start = startOfLocalWeek(now, timeZone);
  const end = startOfLocalDay(now, timeZone);
  end.setUTCDate(end.getUTCDate() + 28);
  end.setUTCHours(23, 59, 59, 999);
  return { start, end };
}
```

Then in the component body, the teacher row is already fetched for `bankIban` (`:66-69`) — but the window is computed at `:38`, before that `Promise.all` resolves. Move the timezone lookup ahead of it:

```ts
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: { bankIban: true, defaultTimezone: true },
  });
  const { start, end } = getScheduleWindow(teacher.defaultTimezone);
  const now = new Date();
```

and delete the `prisma.teacher.findUniqueOrThrow` entry from the `Promise.all`. Its destructuring at `:42` is currently

```ts
  const [classes, studioClasses, teacher, roomCount, classCount] = await Promise.all([
```

and becomes

```ts
  const [classes, studioClasses, roomCount, classCount] = await Promise.all([
```

with the three remaining queries in the same order. This costs one serialised round trip on this page — accepted, because the window it produces is an input to the two queries that follow and cannot be computed in parallel with them.

Finally, feed `formatTodayLabel` the teacher's day rather than the raw instant (`:85`):

```tsx
          <p className="type-caption mt-1">{formatTodayLabel(startOfLocalDay(now, teacher.defaultTimezone))}</p>
```

`formatTodayLabel` itself is unchanged: it reads its argument with UTC accessors, which is correct once the argument is a calendar date.

- [ ] **Step 3: Typecheck, lint, and run the suites**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project components
```

Expected: clean; unit up by five from Task 1; components unchanged. If `class-list.test.tsx` fails here, something in this task touched the component — it should not have.

- [ ] **Step 4: Verify the fix at 375px on the running dev server**

Neither change should move a pixel. Open the Schedule tab and the past-classes page and confirm the "today" caption and the week groupings read the same as before. Do not restart the dev server — it is already running. If you cannot check, say so in your report rather than assuming.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(teacher)/schedule/past/page.tsx" "src/app/(teacher)/page.tsx"
git commit -m "fix: key the teacher schedule boundaries on the teacher's calendar day (#101)"
```

---

### Task 3: `ClassList` takes the teacher's timezone

**Files:**
- Modify: `src/components/schedule/class-list.tsx:31-47`, `:169-173`, `:176-177`, `:207`, `:217`
- Modify: `src/components/schedule/class-list.test.tsx`
- Modify: `src/app/(teacher)/page.tsx` (pass the prop), `src/app/(teacher)/schedule/past/page.tsx` (pass the prop)

**Interfaces:**
- Consumes from Task 1: `startOfLocalWeek(instant, timeZone)`. Also `classStartInstant(classDate: Date, startTime: string, timeZone: string): Date` from `@/lib/timezone:87` — already exported and tested.
- Consumes from Task 2: both pages hold a `teacher.defaultTimezone` in scope.
- Produces: nothing later tasks use.

- [ ] **Step 1: Write the failing tests**

Add to `src/components/schedule/class-list.test.tsx`. The file already has a `classRow` helper and renders through `ClassList`; reuse them.

```tsx
/**
 * #101. Both of these were wrong by the UTC offset, and both are invisible from
 * a UTC host — the suite sees them only because `vitest.config.ts` pins a
 * west-of-UTC zone. `America/Los_Angeles` is used here rather than the pinned
 * zone so the assertion does not silently change meaning if that pin ever moves.
 */
describe('ClassList timezone handling', () => {
  it('does not dim a class that has not started in the teacher\'s zone', () => {
    // 19:00 in Los Angeles on 2026-06-01 is 2026-06-02T02:00Z. At 2026-06-01T20:00Z
    // — 13:00 local — the class is still hours away. The old `itemDateTime` read
    // the wall clock as UTC, making it "19:00Z", already past by then.
    vi.setSystemTime(new Date('2026-06-01T20:00:00.000Z'));
    render(
      <ClassList
        classes={[classRow('cls-1', 'open', [], {
          date: new Date('2026-06-01T00:00:00.000Z'),
          startTime: '19:00',
        })]}
        timeZone="America/Los_Angeles"
        dimPast
      />,
    );
    // The card is the `<Link href="/class/{id}">` (class-list.tsx:95-97); `past`
    // adds `opacity-70` to its className. Addressed by role+name because that is
    // how the rest of this file reaches rendered output — no test id exists and
    // none should be added for a test.
    expect(screen.getByRole('link', { name: /Vinyasa/ }).className).not.toContain('opacity-70');
  });

  it('labels a class as "This week" using the teacher\'s week, not UTC\'s', () => {
    // Sunday 20:00 LA = Monday 03:00 UTC. UTC has entered the next week; the
    // teacher has not, so a class dated that Saturday is still "This week".
    vi.setSystemTime(new Date('2026-06-08T03:00:00.000Z'));
    render(
      <ClassList
        classes={[classRow('cls-1', 'open', [], { date: new Date('2026-06-06T00:00:00.000Z') })]}
        timeZone="America/Los_Angeles"
      />,
    );
    expect(screen.getByText('This week')).toBeInTheDocument();
  });
});
```

Two things this needs that the file may not have yet:

1. `vi.setSystemTime` requires `vi.useFakeTimers()` in a `beforeEach` and `vi.useRealTimers()` in an `afterEach`, scoped to this `describe`. Add them, and import `vi`, `beforeEach`, `afterEach` from `vitest`.
2. `classRow` currently takes `(id, status, payments)` and hard-codes `date: new Date('2026-06-12T00:00:00.000Z')` and `startTime: '09:30'`. Add an optional fourth parameter `overrides?: { date?: Date; startTime?: string }`, applied over those two defaults so every existing call is unaffected. Do not change the existing three parameters.
3. **The `startTime: '19:00'` override in the dim test is required, not decoration.** With the default `09:30`, the class is at 16:30Z in Los Angeles, which is genuinely past the test's 20:00Z system time — so the test would fail against a *correct* implementation. 19:00 local is 02:00Z the next day, comfortably ahead of it. Do not simplify the fixture.
4. Do **not** add a `data-testid` to the component for the test; the `<Link>` is already addressable by role and name.

- [ ] **Step 2: Run and watch them fail**

Run: `npx vitest run --project components src/components/schedule/class-list.test.tsx`

Expected: FAIL — `timeZone` is not a prop yet, so `tsc` rejects it and the dim assertion fails against the current `itemDateTime`.

- [ ] **Step 3: Add the required prop and fix both computations**

In `src/components/schedule/class-list.tsx`, add the import:

```ts
import { classStartInstant, startOfLocalWeek } from '@/lib/timezone';
```

Add `timeZone: string;` to `ClassListProps` — **required, not optional**. An optional prop defaulting to UTC would let a caller silently keep the current behaviour, which is exactly how these sites drifted from the two `#93` fixed.

**Delete `itemDateTime` entirely** (`:169-173`) and call the shared helper at both map sites:

```tsx
    ...classes.map((c) => ({ type: 'class' as const, data: c, dateTime: classStartInstant(c.date, c.startTime, timeZone) })),
    ...studioClasses.map((sc) => ({ type: 'studio' as const, data: sc, dateTime: classStartInstant(sc.date, sc.startTime, timeZone) })),
```

`classStartInstant` is what `itemDateTime` was a hand-rolled copy of — same inputs, but it does the real offset maths and converges across DST. Removing the copy is the point: the duplicate is why `dimPast` was wrong while the archive rule, which used the shared helper, was right.

Change `weekLabel` to take the teacher's Monday rather than deriving one from an instant:

```tsx
/** "This week" / "Next week" / "Last week" / "Week of 4 August". */
function weekLabel(itemDate: Date, thisMonday: number): string {
  const itemMonday = mondayOf(itemDate);
  if (itemMonday === thisMonday) return 'This week';
  if (itemMonday === thisMonday + WEEK_MS) return 'Next week';
  if (itemMonday === thisMonday - WEEK_MS) return 'Last week';
  const d = new Date(itemMonday);
  return `Week of ${d.getUTCDate()} ${FULL_MONTHS[d.getUTCMonth()]}`;
}
```

`mondayOf` is **unchanged and correct** — it takes a calendar date, which is rule one. Only its `now` caller was wrong. In the component body:

```tsx
  const now = new Date();
  const thisMonday = startOfLocalWeek(now, timeZone).getTime();
```

and at the call site (`:207`): `weekLabel(item.data.date, thisMonday)`.

- [ ] **Step 4: Pass the prop from both pages**

`src/app/(teacher)/page.tsx` (`:100-105`) and `src/app/(teacher)/schedule/past/page.tsx` (`:34`) each gain `timeZone={teacher.defaultTimezone}`. Task 2 already put that value in scope in both files.

- [ ] **Step 5: Run and watch them pass**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components src/components/schedule/class-list.test.tsx
```

Expected: clean; the file's pre-existing tests still pass with the added prop, plus the two new ones.

- [ ] **Step 6: Mutation-verify both new tests bite**

One at a time, confirming with `git diff` that each edit landed before running, and reverting before the next. **A mutation you did not confirm landed proves nothing.**

1. Restore the old wall-clock-as-UTC behaviour by replacing the `classStartInstant(...)` calls with an inline `new Date(Date.UTC(c.date.getUTCFullYear(), c.date.getUTCMonth(), c.date.getUTCDate(), Number(c.startTime.slice(0,2)), Number(c.startTime.slice(3,5))))` → the dim test must FAIL.
2. Replace `startOfLocalWeek(now, timeZone).getTime()` with `mondayOf(now)` → the week-label test must FAIL.

Both are the pre-fix behaviour restored, so both must go red. If either stays green, the test is not pinning what it claims.

- [ ] **Step 7: Commit**

```bash
git add src/components/schedule/class-list.tsx src/components/schedule/class-list.test.tsx \
        "src/app/(teacher)/page.tsx" "src/app/(teacher)/schedule/past/page.tsx"
git commit -m "fix: give ClassList the teacher's timezone for dimming and week labels (#101)"
```

---

### Task 4: The three date renderings on the student detail page (#115)

**Files:**
- Modify: `src/app/(teacher)/students/[id]/page.tsx:97`, `:126`, `:150`

**Interfaces:**
- Consumes: `formatHistoricalDate(date: Date): string` from `@/lib/format:114` — already exported and tested (`format.test.ts:66`), renders `12 Jun 2026`.
- Produces: nothing.

- [ ] **Step 1: Fix the two class dates**

Add the import:

```ts
import { formatHistoricalDate } from '@/lib/format';
```

At `:126` and `:150`, replace

```tsx
new Date(reg.class.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
```

with

```tsx
formatHistoricalDate(reg.class.date)
```

`Class.date` is a `@db.Date` — a calendar date at midnight UTC. `toLocaleDateString` with no `timeZone` reads it in the host's zone, which west of UTC renders the previous day: a class on the 12th shows as the 11th. `formatHistoricalDate` reads it with UTC accessors and produces the identical `12 Jun 2026` shape.

- [ ] **Step 2: Fix the birthday, differently and deliberately**

At `:97`, add `timeZone: 'UTC'` to the existing call:

```tsx
                <p className="text-base text-ink">{new Date(student.birthday).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}</p>
```

`Student.birthday` is also `@db.Date` (`schema.prisma:162`) and has the same bug. It does **not** get `formatHistoricalDate`: that renders `3 Jun 2026`, appending a year this field deliberately omits — and a birth *year* is a different disclosure from a birth *date* on a page whose design is privacy-first. Adding the `timeZone` option leaves the output byte-identical at `3 June` and chooses no formatter, which is what keeps #96's consolidation decision open.

Add a brief comment saying exactly that, so the next reader does not "tidy" it into `formatHistoricalDate`.

- [ ] **Step 3: Typecheck, lint, run everything**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project components
npx playwright test
```

Expected: clean; unit and components unchanged from Task 3; e2e 118 passing.

Do NOT run `npx vitest run --project integration` — its `signup-api` tests are rate-limited per IP (3/hour and 5/hour) and routinely exhausted. If you run it by accident and see `expected 429 to be 201`, that is the limiter, not this change; report it and do not re-run to confirm.

- [ ] **Step 4: Record honestly what is untested here**

None of the three sites has a test. Both `students/[id]/page.tsx` and the two pages in Task 2 are async server components with no unit-test seam, and this change does not restructure them to create one. `formatHistoricalDate` is itself tested (`format.test.ts:66`), so the two class-date sites rest on a tested formatter plus inspection; the birthday's `timeZone: 'UTC'` rests on inspection alone.

State this in your report. Do not add a test that renders the formatter in isolation and calls it page coverage — that tests `format.ts`, which is already covered.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(teacher)/students/[id]/page.tsx"
git commit -m "fix: read student-page dates as calendar dates, not host-local instants (#115)"
```

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 427 + 5 = 432 passing
- [ ] `npx vitest run --project components` — 59 + 2 = 61 passing
- [ ] `npx vitest run --project integration` — 215 passing (429s are the rate limiter, not this change)
- [ ] `npx playwright test` — 118 passing
- [ ] `git status --short` — only `docs/backlog-roadmap.md` untracked; **`prisma/` unchanged**
- [ ] `vitest.config.ts` untouched — the `TZ` pin is what makes every test here non-vacuous
- [ ] No rendered copy changed — labels, date formats and strings byte-identical
- [ ] Both Task 3 mutations observed, each `git diff`-confirmed first
- [ ] `itemDateTime` is gone from `class-list.tsx`, not merely fixed
- [ ] `ClassList`'s `timeZone` prop is required, not optional
- [ ] The untested sites named in Task 4 Step 4 are stated in the report, not glossed
