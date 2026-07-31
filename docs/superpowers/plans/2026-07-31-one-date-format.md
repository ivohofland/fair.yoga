# One Date Format Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse eight date formats across ten sites into three shared formatters plus two grouping labels, all day-first (#96).

**Architecture:** `src/lib/format.ts` gains `formatDateShort` and `formatMonthLabel`, `formatHistoricalDate` is renamed `formatDateWithYear`, and `formatDayHeader` is reordered day-first. Every local copy is deleted and its call sites repointed. The rule lands in the design brief so a ninth format is not invented next month.

**Tech Stack:** TypeScript strict, Vitest `unit` (node) and `components` (jsdom), Playwright visual regression.

## Global Constraints

- **TypeScript `strict: true`, `noUncheckedIndexedAccess` on.** No `any`, **no type assertions to silence a type error**, no eslint suppressions.
- **Day-first, everywhere.** `12 Jun`, never `Jun 12`. The comma after a weekday stays: `Friday, 12 Jun`.
- **UTC accessors only.** These formatters take `@db.Date` calendar values (midnight UTC). Never `toLocaleDateString` without an explicit `timeZone` — that reads the host zone and renders the previous day west of UTC.
- **This change alters rendered copy on purpose.** That is the point, and it is why the visual baselines move. It must alter *nothing else* — no layout, no markup, no logic.
- **`p.paidAt` keeps its current (wrong) output.** It is an instant rendered as a UTC calendar date — filed as **#140**, deliberately not fixed here. `formatDateShort(p.paidAt)` is byte-identical to today's `formatDay(p.paidAt)`. Do not "fix" it in passing; #140 explains why it waits for #138.
- **Do not touch `vitest.config.ts`.** Its `TZ` pin is what keeps these assertions honest.
- **Never restart the dev server on `:3000`.**
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.

---

## File Structure

| File | Change | Task |
|---|---|---|
| `src/lib/format.ts` | Reorder `formatDayHeader`; rename `formatHistoricalDate` → `formatDateWithYear`; add `formatDateShort`, `formatMonthLabel` | 1 |
| `src/lib/format.test.ts` | Update the reordered suite; tests for the two new formatters | 1 |
| `src/components/settings/template-action-messages.test.ts` | The message copy changes with `formatDayHeader` | 1 |
| `docs/design-brief.md` | The dates rule | 1 |
| `src/app/(teacher)/page.tsx` | Delete `formatTodayLabel` → `formatDayHeader` | 2 |
| `src/app/(teacher)/settings/payments/page.tsx` | Delete `formatDay` → `formatDateShort` | 2 |
| `src/components/students/student-list.tsx` | Delete `formatDate` → `formatDateShort` | 2 |
| `src/app/(teacher)/studio-class/[id]/page.tsx` | Delete `formatDate` → `formatDateWithYear` | 2 |
| `src/components/class/class-info.tsx` | Delete `formatClassDate` → `formatDateWithYear` | 2 |
| `src/app/(teacher)/students/[id]/page.tsx` | Delete the inline `toLocaleDateString` → `formatDateShort` | 2 |
| `src/app/(teacher)/settings/reporting/page.tsx` | Delete local `MONTHS` → `formatMonthLabel` | 2 |
| `src/components/schedule/class-list.tsx` | Delete its `FULL_MONTHS`, import it; `weekLabel` stays local | 2 |
| `src/lib/format.test.ts` | Tests for `formatRoomLocation`, `formatStudentName`, `timeAgo` | 3 |
| `tests/e2e/*-snapshots/*.png` | Regenerate the moved baselines | 4 |

**Task 4 is isolated on purpose.** Regenerated PNGs are a diff nobody can read; keeping them in their own commit means a reviewer can confirm the picture changed on exactly the screens the code change predicts, and nowhere else.

**The visual specs will FAIL from Task 1 until Task 4.** That is expected — `formatDayHeader`'s output changes in Task 1 and the baselines are not updated until Task 4. **Do not run `npx playwright test` in Tasks 1–3, and do not regenerate baselines there.** Tasks 1–3 verify with `unit` and `components` only.

---

### Task 1: The three formatters, the rule, and the copy that changes with them

**Files:**
- Modify: `src/lib/format.ts:68-117`
- Modify: `src/lib/format.test.ts:12-64`
- Modify: `src/components/settings/template-action-messages.test.ts:118,147`
- Modify: `docs/design-brief.md`

**Interfaces:**
- Produces, consumed by Task 2:
  - `formatDayHeader(date: Date): string` → `Friday, 12 Jun` (existing name, new order)
  - `formatDateWithYear(date: Date): string` → `12 Jun 2026` (renamed from `formatHistoricalDate`, output unchanged)
  - `formatDateShort(date: Date): string` → `12 Jun` (new)
  - `formatMonthLabel(year: number, monthIndex: number): string` → `June 2026` (new)
- Consumes: nothing.

- [ ] **Step 1: Update the existing tests to the new order, and add the new ones**

In `src/lib/format.test.ts`, extend the import on line 2 to
`formatDayHeader, formatDateWithYear, formatDateShort, formatMonthLabel, paymentStateText`.

Change the three `formatDayHeader` expectations from month-first to day-first:

```ts
    expect(formatDayHeader(new Date('2026-06-12T00:00:00.000Z'))).toBe('Friday, 12 Jun');
    expect(formatDayHeader(new Date('2026-01-01T00:00:00.000Z'))).toBe('Thursday, 1 Jan');
    expect(formatDayHeader(new Date('2026-12-31T00:00:00.000Z'))).toBe('Thursday, 31 Dec');
```

Rename the `formatHistoricalDate` describe block and its calls to `formatDateWithYear`. **Its expected strings do not change** — the output is identical, only the name moves. If any assertion needs editing beyond the identifier, the rename changed behaviour and that is a defect: stop and report.

Then add:

```ts
/**
 * #96. The compact form, for a date sitting inline in a row beside other text —
 * a payments caption, a student's last-seen. No weekday, no year: the row has
 * no space for them and its neighbours supply the context.
 */
describe('formatDateShort', () => {
  it('renders day then abbreviated month', () => {
    expect(formatDateShort(new Date('2026-06-12T00:00:00.000Z'))).toBe('12 Jun');
  });

  it('does not pad the day-of-month', () => {
    expect(formatDateShort(new Date('2026-01-01T00:00:00.000Z'))).toBe('1 Jan');
  });

  /**
   * Reads its argument with UTC accessors. `Class.date` is a `@db.Date` stored
   * at midnight UTC, so a local read renders the previous day west of UTC —
   * which the suite's `TZ` pin makes visible rather than theoretical.
   */
  it('reads the calendar date, not the host-local one', () => {
    expect(formatDateShort(new Date('2026-06-12T00:00:00.000Z'))).toBe('12 Jun');
  });
});

/**
 * #96. A heading over a *set* of months in the reporting view, not a rendering
 * of any one class's date — which is why it takes numbers rather than a `Date`.
 * Its caller already holds year and month as separate values, having split them
 * out of a grouping key.
 */
describe('formatMonthLabel', () => {
  it('renders the full month name and year', () => {
    expect(formatMonthLabel(2026, 5)).toBe('June 2026');
  });

  it('treats the month as zero-indexed, matching getUTCMonth', () => {
    expect(formatMonthLabel(2026, 0)).toBe('January 2026');
    expect(formatMonthLabel(2026, 11)).toBe('December 2026');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `npx vitest run --project unit src/lib/format.test.ts`

Expected: FAIL — three `formatDayHeader` assertions fail on the new order, and the file fails to import `formatDateWithYear`, `formatDateShort` and `formatMonthLabel`.

- [ ] **Step 3: Make the changes in `format.ts`**

Reorder `formatDayHeader` (`:80-84`) and update its docblock example:

```ts
/**
 * A class's day, as the schedule and bookings views render it: `Friday, 12 Jun`.
 *
 * Day-first (#96). The app previously rendered this three ways — `Jun 12`,
 * `12 June`, `June 12, 2026` — and a teacher saw two of them one tap apart.
 * Day-first is the international convention, which `CLAUDE.md`'s "international
 * from day one" implies and which will not need undoing when i18n arrives.
 *
 * UTC accessors throughout: `Class.date` is a `@db.Date` (midnight UTC) and the
 * time of day lives separately in `startTime`, so reading it in local time would
 * shift the date across the boundary for anyone west of UTC.
 */
export function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
```

Rename `formatHistoricalDate` to `formatDateWithYear` (`:114`), leaving the body byte-identical. Update its docblock's opening line to:

```
 * A date where the year matters: `12 Jun 2026`.
 *
 * Detail pages and any record meant to survive indefinitely, where dropping the
 * year lets a date from last year read identically to one from last month.
 * Named for what it renders rather than when it was added — it was
 * `formatHistoricalDate` until #96 pointed the class and studio detail pages at
 * it, and those show upcoming classes too.
```

Keep the rest of that docblock — the UTC-accessors paragraph is still exactly right.

Add the two new functions below it:

```ts
/**
 * The compact form: `12 Jun`. No weekday, no year.
 *
 * For a date sitting inline in a row beside other text, where the surrounding
 * copy supplies the context a weekday would otherwise give. Same UTC-accessor
 * reasoning as the two above.
 */
export function formatDateShort(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * A heading over a set of months: `June 2026`.
 *
 * Takes year and zero-indexed month rather than a `Date`, because its only
 * caller has already split them out of a grouping key and has no `Date` to
 * hand. Zero-indexed to match `getUTCMonth`, so a caller that does hold a date
 * can pass its accessors straight through.
 *
 * The full month name, not the abbreviation the date formatters use: this
 * labels a period rather than a day, and there is no adjacent day number for it
 * to crowd.
 */
export function formatMonthLabel(year: number, monthIndex: number): string {
  return `${FULL_MONTHS[monthIndex] ?? ''} ${year}`;
}
```

`FULL_MONTHS` is **exported**, not module-private like `MONTHS` above it, and
declared beside it:

```ts
export const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
```

`class-list.tsx:28` declares a byte-identical array today. Exporting this one
lets Task 2 delete that copy while leaving `weekLabel` itself local — the spec
keeps the single-caller *function* out of `format.ts`, which is not a reason to
keep a second copy of a twelve-string constant. `MONTHS` stays private: nothing
outside this file needs it.

- [ ] **Step 4: Fix the message copy that changed with `formatDayHeader`**

`src/components/settings/template-action-messages.ts:19` builds a user-facing sentence containing a formatted date, and two tests assert it verbatim. In `template-action-messages.test.ts`, lines 118 and 147, the expected string becomes:

```
'No new classes will be added to your schedule. The last one still scheduled is Friday, 12 Jun · 09:30.'
```

**Read that sentence before accepting it.** This is a copy change, not a mechanical substitution — the test exists to pin what a teacher reads. Confirm it still scans; if it does not, the format is wrong, not the test.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
npx vitest run --project unit src/lib/format.test.ts
npx vitest run --project unit src/components/settings/template-action-messages.test.ts
npx tsc --noEmit && npm run lint
```

Expected: both suites green; `tsc` fails only if something still imports `formatHistoricalDate` — Task 2 repoints the rest, but any remaining importer must be fixed now, since the branch should compile at every commit. Search with `grep -rn formatHistoricalDate src/` and fix what it finds.

- [ ] **Step 6: Write the rule into the design brief**

`docs/design-brief.md` is 114 lines, prescribes six type styles and "calm consistency", and mentions dates **zero times** — which is how eight formats grew without anyone doing anything wrong. Add a short section (place it near the typography rules, matching the file's existing heading style):

```markdown
## Dates

Day-first, always: `12 Jun`, never `Jun 12`. Three formats, all in
`src/lib/format.ts`:

- `formatDayHeader` — `Friday, 12 Jun`. Lists and headers where the weekday
  earns its space: the schedule, bookings, the public pages.
- `formatDateWithYear` — `12 Jun 2026`. Detail pages, and any record that
  outlives the current month.
- `formatDateShort` — `12 Jun`. Inline in a row, where neighbouring copy
  already supplies the context.

Never `toLocaleDateString` without an explicit `timeZone`. Class dates are
`@db.Date` columns stored at midnight UTC; a host-local read renders the
previous day west of UTC. See `src/lib/timezone.ts` for the rule in full.
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts \
        src/components/settings/template-action-messages.test.ts \
        docs/design-brief.md
git commit -m "feat: day-first dates, three formatters, and the rule in the brief (#96)"
```

---

### Task 2: Delete every local copy

**Files:**
- Modify: `src/app/(teacher)/page.tsx:23-30,82`
- Modify: `src/app/(teacher)/settings/payments/page.tsx:11-15,96,127,128`
- Modify: `src/components/students/student-list.tsx:19-27,44`
- Modify: `src/app/(teacher)/studio-class/[id]/page.tsx:9-17,43`
- Modify: `src/components/class/class-info.tsx:16-28`
- Modify: `src/app/(teacher)/students/[id]/page.tsx:106`
- Modify: `src/app/(teacher)/settings/reporting/page.tsx:9,87`
- Modify: `src/components/schedule/class-list.tsx:48`

**Interfaces:**
- Consumes from Task 1: `formatDayHeader`, `formatDateWithYear`, `formatDateShort`, `formatMonthLabel`, all from `@/lib/format`.
- Produces: nothing.

- [ ] **Step 1: Repoint the four that take a `Date`**

Each of these deletes a local function and imports a shared one. The rendered output changes in every case except the last — that is the point of #96.

| File | Delete | Call becomes | Was | Now |
|---|---|---|---|---|
| `(teacher)/page.tsx` | `formatTodayLabel` (`:23-30`) | `formatDayHeader(startOfLocalDay(now, teacher.defaultTimezone))` | `Friday, 12 June` | `Friday, 12 Jun` |
| `studio-class/[id]/page.tsx` | `formatDate` (`:9-17`) | `formatDateWithYear(studioClass.date)` | `Friday, June 12, 2026` | `12 Jun 2026` |
| `components/class/class-info.tsx` | `formatClassDate` (`:16-28`) | `formatDateWithYear(cls.date)` at `:42` | `Friday, June 12, 2026` | `12 Jun 2026` |
| `components/students/student-list.tsx` | `formatDate` (`:19-27`) | `formatDateShort(latestReg.class.date)` | `Jun 12` | `12 Jun` |

The two detail pages lose their weekday. That is the design decision from the spec: the year earns its place on a page you reach for one specific class, and a fourth format existing to keep the weekday there is what #96 exists to stop.

- [ ] **Step 2: Repoint the payments page, and leave its known bug alone**

`settings/payments/page.tsx`: delete `formatDay` (`:11-15`) and import `formatDateShort`. Three call sites — `:96`, `:127`, `:128`.

`:96` and `:127` take `p.registration.class.date`, a `@db.Date`. Correct.

**`:128` takes `p.paidAt`, which is a `DateTime` — an instant, not a calendar date.** Rendering it with UTC accessors shows the UTC day rather than the teacher's, so a payment marked paid at 18:00 Pacific on the 12th displays the 13th. That is **#140**, filed and deliberately out of scope here: `formatDateShort(p.paidAt)` is byte-identical to today's `formatDay(p.paidAt)`, so this change preserves the behaviour exactly rather than half-fixing it inside a refactor.

Add a brief comment at `:128` naming #140, so the next reader does not think it was missed:

```tsx
{/* #140: `paidAt` is an instant, not a calendar date — this renders the UTC
    day, not the teacher's. Left exactly as it was; the fix needs the teacher's
    timezone, which #138 puts on the session. */}
```

- [ ] **Step 3: Repoint the birthday and the reporting label**

`students/[id]/page.tsx:106` — replace the inline call:

```tsx
                <p className="text-base text-ink">{formatDateShort(new Date(student.birthday))}</p>
```

This changes `12 June` to `12 Jun`, and removes the **last `toLocaleDateString` call in the codebase** — the loophole `src/lib/timezone.ts`'s rule warns about, where a missing `timeZone` silently renders the previous day west of UTC. Confirm with `grep -rn "\.toLocaleDateString(" src/`, which should then return nothing. Grep for the *call*, not the bare name: `timezone.ts` and `format.test.ts` both mention `toLocaleDateString` in prose that must stay.

`settings/reporting/page.tsx` — delete the local `MONTHS` (`:9`) and change `:87`:

```tsx
      return { label: formatMonthLabel(Number(year), Number(month)), ...v };
```

`monthKey` (`:11-13`) builds its key from `getUTCMonth()`, which is zero-indexed, and `formatMonthLabel` takes a zero-indexed month — so this round-trips exactly as the local array did. Leave `monthKey` alone.

- [ ] **Step 4: The week label keeps its function and loses its constant**

`components/schedule/class-list.tsx:48`:

```tsx
  return `Week of ${d.getUTCDate()} ${FULL_MONTHS[d.getUTCMonth()]}`;
```

is **already day-first** — it renders `Week of 4 August`. Verify that rather than assuming; the string needs no change.

`weekLabel` stays local: it groups a *set* of days rather than rendering one, nothing else groups by week, and moving a single-caller function into `format.ts` is how that file accumulates things nobody else uses.

Its `FULL_MONTHS` (`:28-31`) does **not** stay. Delete the local array and import it from `@/lib/format`, where Task 1 exported the identical one. Keeping both would leave this change with two copies of the same twelve strings — the exact shape of duplication #96 exists to remove.

- [ ] **Step 5: Verify, without touching the visual baselines**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project components
grep -rn "\.toLocaleDateString(" src/       # expect: no matches
grep -rn "formatHistoricalDate" src/        # expect: no matches
```

Expected: clean and green. **Do not run `npx playwright test`** — the visual baselines are stale from Task 1 and Task 4 regenerates them. Running it here produces failures that are expected and tempting to "fix".

- [ ] **Step 6: Commit**

```bash
git add "src/app/(teacher)/page.tsx" "src/app/(teacher)/settings/payments/page.tsx" \
        src/components/students/student-list.tsx "src/app/(teacher)/studio-class/[id]/page.tsx" \
        src/components/class/class-info.tsx "src/app/(teacher)/students/[id]/page.tsx" \
        "src/app/(teacher)/settings/reporting/page.tsx" src/components/schedule/class-list.tsx
git commit -m "fix: point every date at a shared formatter, delete the local copies (#96)"
```

---

### Task 3: Cover the three untested `format.ts` exports

**Files:**
- Modify: `src/lib/format.test.ts`

**Interfaces:**
- Consumes: `formatRoomLocation`, `formatStudentName`, `timeAgo` — all already exported from `@/lib/format`.
- Produces: nothing.

#96 asks for this while the file is open. `paymentStateText` was covered by #58 and needs nothing.

- [ ] **Step 1: Write the tests**

Extend the import on line 2 with the three names, and append:

```ts
describe('formatRoomLocation', () => {
  it('joins room and venue when both are present', () => {
    expect(formatRoomLocation('Main Studio', 'De Yogaschool')).toBe('Main Studio at De Yogaschool');
  });

  it('falls back to the venue alone when the room is unnamed', () => {
    // Rooms are optional-name: a one-room venue has nothing to disambiguate.
    expect(formatRoomLocation('', 'De Yogaschool')).toBe('De Yogaschool');
  });
});

/**
 * The privacy default. `StudentPrivacy` is per-teacher and defaults to maximum
 * privacy, so `shareFullName` is false unless a student has opted in with that
 * specific teacher — which makes the *default* branch the one that protects
 * someone, and the one worth pinning hardest.
 */
describe('formatStudentName', () => {
  it('abbreviates the surname by default', () => {
    expect(formatStudentName('Ana', 'de Vries')).toBe('Ana d.');
  });

  it('gives the full name only when sharing is on', () => {
    expect(formatStudentName('Ana', 'de Vries', true)).toBe('Ana de Vries');
  });

  it('handles a missing surname on both branches', () => {
    expect(formatStudentName('Ana', '')).toBe('Ana');
    expect(formatStudentName('Ana', '', true)).toBe('Ana');
  });
});

/**
 * `timeAgo` reads elapsed milliseconds, never a calendar field, so it is
 * correct in any timezone — unlike everything else in this file. The clock is
 * faked so the assertions are about the thresholds rather than about how long
 * the suite took to reach them.
 */
describe('timeAgo', () => {
  const NOW = new Date('2026-06-12T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "just now" under a minute', () => {
    expect(timeAgo(new Date(NOW.getTime() - 30_000))).toBe('just now');
  });

  it('counts whole minutes, then whole hours, then whole days', () => {
    expect(timeAgo(new Date(NOW.getTime() - 5 * 60_000))).toBe('5m ago');
    expect(timeAgo(new Date(NOW.getTime() - 3 * 3_600_000))).toBe('3h ago');
    expect(timeAgo(new Date(NOW.getTime() - 2 * 86_400_000))).toBe('2d ago');
  });

  it('rounds down at each boundary', () => {
    // 59 minutes is still minutes; 60 becomes an hour.
    expect(timeAgo(new Date(NOW.getTime() - 59 * 60_000))).toBe('59m ago');
    expect(timeAgo(new Date(NOW.getTime() - 60 * 60_000))).toBe('1h ago');
    expect(timeAgo(new Date(NOW.getTime() - 23 * 3_600_000))).toBe('23h ago');
    expect(timeAgo(new Date(NOW.getTime() - 24 * 3_600_000))).toBe('1d ago');
  });
});
```

`vi`, `beforeEach` and `afterEach` need adding to the `vitest` import on line 1.

- [ ] **Step 2: Run them**

Run: `npx vitest run --project unit src/lib/format.test.ts`

Expected: PASS. These are characterization tests over unchanged code, so they pass immediately — that is correct and worth not dressing up. Their value is that `formatStudentName`'s privacy branch and `timeAgo`'s thresholds are now pinned; if any assertion here fails, the behaviour is not what the code appears to do and you should report it rather than adjust the expectation.

- [ ] **Step 3: Commit**

```bash
git add src/lib/format.test.ts
git commit -m "test: cover format.ts's three remaining exports (#96)"
```

---

### Task 4: Regenerate the visual baselines

**Files:**
- Modify: `tests/e2e/visual.spec.ts-snapshots/*.png`

**Interfaces:**
- Consumes: the rendered output from Tasks 1–2.
- Produces: nothing.

**This task exists as its own commit because a regenerated PNG is a diff nobody can read.** Isolating it means a reviewer can confirm the screens that moved are exactly the ones the code change predicts, and that nothing else came along.

- [ ] **Step 1: See which baselines actually fail**

```bash
npx playwright test tests/e2e/visual.spec.ts
```

Expected: failures on the screens that render a date through a changed formatter. Predicted: `schedule`, `public-page`, `class-detail-open` — each in `chromium` and `Mobile Chrome`.

**Record the actual list before regenerating.** `login`, `inbox` and `settings` are predicted *not* to move. If one of them fails, something changed that this plan did not intend — stop and report rather than regenerating it away. That check is the entire reason this task is separate.

- [ ] **Step 2: Regenerate**

```bash
npx playwright test tests/e2e/visual.spec.ts --update-snapshots
```

- [ ] **Step 3: Confirm the diff is only what was predicted**

```bash
git status --short tests/e2e/
```

Expected: exactly the PNGs from Step 1's failure list. If a baseline changed that did not fail in Step 1, that is a regeneration side effect and must be understood before committing.

- [ ] **Step 4: Look at one of them**

Open the regenerated `schedule` baseline and confirm the date reads `Friday, 12 Jun` in the day headers and the caption. This is the only step in the plan where a human eye verifies the actual product of #96 — the tests can prove the string changed, not that it reads well.

- [ ] **Step 5: Run everything**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project components
npx playwright test
```

Expected: all green, e2e 118 passing.

Do NOT run `npx vitest run --project integration` — its `signup-api` tests are rate-limited per IP (3/hour and 5/hour) and routinely exhausted. If you run it by accident and see `expected 429 to be 201`, that is the limiter, not this change; report it and do not re-run to confirm.

- [ ] **Step 6: Commit, naming the screens**

```bash
git add tests/e2e/visual.spec.ts-snapshots
git commit -m "test: regenerate the visual baselines #96 moved

Only the screens rendering a date through a changed formatter: <list them>.
login, inbox and settings are unchanged, which is the check that the copy
change stayed inside its blast radius."
```

Replace `<list them>` with the actual list from Step 1 — the commit message is the only readable record of what a PNG diff contains.

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 432 + 14 = 446 passing (5 from Task 1, 9 from Task 3)
- [ ] `npx vitest run --project components` — 61 passing, unchanged
- [ ] `npx playwright test` — 118 passing
- [ ] `npx vitest run --project integration` — 215 passing (429s are the rate limiter, not this change)
- [ ] `grep -rn "\.toLocaleDateString(" src/` — **no matches**
- [ ] `grep -rn "formatHistoricalDate" src/` — **no matches**
- [ ] `grep -rn "FULL_MONTHS" src/` — declared **once**, in `format.ts`
- [ ] `git status --short` — only `docs/backlog-roadmap.md` untracked
- [ ] `vitest.config.ts` untouched
- [ ] `p.paidAt` renders exactly as before, with the #140 comment beside it
- [ ] `class-list.tsx`'s `weekLabel` still local, its string unchanged
- [ ] The design brief's dates section reads as a rule, not a changelog
- [ ] Task 4's commit message names the screens that moved
