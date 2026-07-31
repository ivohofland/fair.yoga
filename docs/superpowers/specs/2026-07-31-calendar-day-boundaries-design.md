# Calendar days, instants, and the boundary between them

**Date:** 2026-07-31
**Status:** Approved (issues #101 + #115; design agreed with Ivo in discussion —
fix all five #101 sites including the three the issue does not name, thread the
teacher's timezone into `ClassList`, and fold in #115 including its unfiled
third site)

## Problem

`#93` moved the archive rule and the public booking page onto the teacher's
calendar day via `startOfLocalDay`. Several sites did not move with it, and
they fail in two opposite directions that turn out to be the same mistake.

**The rule, which the codebase relies on but has never written down:**

- **A `@db.Date` column is a calendar date**, stored at UTC midnight. Read it
  with UTC accessors. Never pass it to `toLocaleDateString` without an explicit
  `timeZone` — that reads it in the host's zone.
- **`new Date()` is an instant.** Convert it to the teacher's calendar day with
  `startOfLocalDay` before comparing it against a calendar date.

**#101 breaks the second rule. #115 breaks the first.** Neither needs a new
helper: `startOfLocalDay` and `classStartInstant` (`src/lib/timezone.ts:57`,
`:87`) both exist and are unit-tested.

### The live bug, reproduced

A teacher in `America/Los_Angeles` at 18:00 on Monday 1 June. UTC is already
02:00 Tuesday, so `new Date()` with `setUTCHours(0,0,0,0)` yields Tuesday
00:00 UTC, and `date: { lt: today }` matches Monday's class:

```
now (UTC)         : 2026-06-02T01:00:00.000Z
teacher local     : Monday, June 1, 2026 at 6:00 PM
past filter uses  : date < 2026-06-02T00:00:00.000Z
Monday class date : 2026-06-01T00:00:00.000Z
=> shown in PAST  : true      <- the teacher has not taught it yet
```

The same class is simultaneously inside the Schedule tab's window, so it appears
in both places at once.

### The issue undercounts both halves

**#101 names two sites. There are five** — the three extra are all in files the
issue already points at, and one of them is the most visible symptom of the lot:

| Site | Defect |
|---|---|
| `schedule/past/page.tsx:9` | `date < utcToday` — the reproduction above. **Named.** |
| `(teacher)/page.tsx:15-22` | week window keyed on `getUTCDay`/`setUTCHours`. **Named.** |
| `(teacher)/page.tsx:32` | `formatTodayLabel(now)` reads `getUTCDay`/`getUTCDate`/`getUTCMonth` off an instant, so the "today" caption shows tomorrow's date west of UTC |
| `class-list.tsx:40-47` | `weekLabel` derives `mondayOf(now)` in UTC, so "This week" / "Next week" / "Last week" flip a day early |
| `class-list.tsx:169-173` | `itemDateTime` is a hand-rolled `classStartInstant` that treats the wall clock as UTC; `dimPast` (`:217`) compares it against a real instant |

That last one measured: a 19:00 class in Los Angeles is treated as `19:00Z`, so
it dims as past **seven hours early** — from noon local, on the teacher's home
screen, while the class is still that evening.

**#115 names two sites. There are three**, all in `students/[id]/page.tsx`; the
third is the student's birthday.

### What is *not* wrong

The sweep found many other UTC accessors — `class-info.tsx`, `student-list.tsx`,
`payments/page.tsx`, `studio-class/[id]`, `reporting`, `class-generator.ts`,
`template-sync.ts`, and `class-list.tsx`'s own `weekLabel` *formatting* half.
All correct: each reads a stored `@db.Date`, which is exactly what rule one
requires. The test that separates them is not "does it use UTC accessors" but
**"is this value an instant or a stored calendar date"**, and only the five
above take an instant.

## Design

### 1. `#101` — the three page-level sites

`schedule/past/page.tsx` and `(teacher)/page.tsx` load the teacher's
`defaultTimezone` and derive their boundaries from it:

```ts
const today = startOfLocalDay(new Date(), teacher.defaultTimezone);
```

`(teacher)/page.tsx` already fetches the teacher row for `bankIban`
(`:66-69`), so the field costs nothing there. `schedule/past/page.tsx` gains one
query, added to its existing `Promise.all` rather than serialised.

The week window derives from the same local day, and `formatTodayLabel` is fed
that value rather than the raw instant.

### 2. `#101` — `ClassList` gains a required `timeZone`

`weekLabel` and `dimPast` are inside the shared component, so it needs the
teacher's zone. The prop is **required, not optional-defaulting-to-UTC**: a
default would let a caller silently keep the current bug, which is precisely how
these five sites drifted apart from the two `#93` fixed.

Three call sites: `(teacher)/page.tsx`, `schedule/past/page.tsx`, and
`class-list.test.tsx` (added by #58's PR).

`itemDateTime` is **deleted**, not fixed. `classStartInstant(date, startTime,
timeZone)` already does the job, handles the DST double-pass, and is tested.
Replacing the local copy removes a duplicate rather than adding code — and the
duplicate is the reason `dimPast` was wrong while the archive rule was right.

### 3. `#115` — the three rendering sites

`students/[id]/page.tsx:126` and `:150` become `formatHistoricalDate`
(`src/lib/format.ts:114`), which renders `12 Jun 2026` — the same shape the
`en-GB` call produces today, minus the bug.

**`:97` is different and must not use it.** It renders a student's birthday as
`3 June`, day and month only. `formatHistoricalDate` would make that
`3 Jun 2026`, appending a year the UI deliberately omits — and a birth *year* is
a different disclosure from a birth *date* on a page whose whole design is
privacy-first. The fix there is `timeZone: 'UTC'` added to the existing
`toLocaleDateString` call: output byte-identical, bug gone, and no formatter
chosen.

### 4. Where the rule gets written down

`src/lib/timezone.ts` is the natural home — it already owns both helpers. A
short module docblock stating the calendar-date/instant distinction and which
helper each side calls for. Not a count of call sites: this repo has twice
learned that a number in a comment goes stale (`tests/setup/components.ts`,
`type-pins.ts`).

## Testing

The whole defect class is invisible from a UTC host, and CI runs in UTC. Every
test here must therefore pin a **non-UTC** timezone explicitly, or it proves
nothing.

- **The two page boundaries — unit.** `startOfLocalDay` is already tested; what
  is untested is that the pages call it. The extractable part is the boundary
  computation (today's local start; the local week window), so those become
  small pure functions with tests at `America/Los_Angeles` asserting the exact
  reproduction above: at 2026-06-02T01:00Z, "today" is 2026-06-01, not 06-02.
- **`ClassList` — component.** Two tests at a west-of-UTC zone: a class later
  today is **not** dimmed (the 7-hour bug), and `weekLabel` says "This week" for
  a class in the teacher's current week when UTC has already rolled into the
  next one. `class-list.test.tsx` exists and gains the required prop.
- **`#115` — component or unit.** Assert `12 Jun 2026` for a class dated the
  12th, and `3 June` for a birthday, with the host timezone forced west of UTC
  so the pre-fix code would render the 11th and `2 June`. If forcing the host
  zone inside Vitest proves unreliable, test the formatter call rather than the
  page and say so plainly rather than shipping a test that passes either way.
- **Mutation-verify each.** Revert each fix in turn and confirm the matching
  test fails. A timezone test that passes against the buggy code is the default
  outcome here, not an unlikely one — CI's UTC host hides every one of these.

## Out of scope

- **#96 — "the same class date renders four ways via three mechanisms."** This
  change picks no new formatter and consolidates nothing. `:97` keeps its inline
  `toLocaleDateString` specifically so that #96's decision stays open.
- **`requireTeacherSession` carrying the timezone.** It would remove the extra
  query on `past/page.tsx` and help future pages, but it changes a value every
  authenticated page depends on. Worth doing deliberately, not as a side effect
  of a date fix.
- **The public and student surfaces.** `(public)/[slug]` was fixed by #93;
  `(student)/bookings` renders its own dates and belongs to whoever owns the
  student timezone question, which this app has not answered.

## Risks

- **CI cannot catch a regression here.** Every one of these bugs is invisible at
  `TZ=UTC`, which is what CI runs. The tests must set a zone explicitly, and the
  mutation step is what proves they did — otherwise this whole change is
  unguarded against being undone.
- **A required prop on `ClassList` is a breaking change to a shared component.**
  That is the intent — an optional one would let a caller keep the bug — but it
  means any branch in flight that renders `ClassList` will conflict. Only three
  call sites exist today.
- **`classStartInstant` does real timezone maths where `itemDateTime` did
  arithmetic.** It is already used and tested elsewhere, but this puts it on the
  render path of the busiest page, called once per class. The Schedule tab shows
  at most five weeks of classes, so the cost is bounded and small — worth
  noting, not worth pre-optimising.
