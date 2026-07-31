# One date format

**Date:** 2026-07-31
**Status:** Approved (issue #96; design agreed with Ivo in discussion — day-first
ordering, three date formatters plus two grouping labels, the rule recorded in
the design brief)

## Problem

Issue #96 reports four renderings via three mechanisms. Re-measured after PR #93
(#86), PR #133 (#111) and PR #137 (#101 + #115), it is **eight distinct formats
across ten sites**:

| Renders | Where | Mechanism |
|---|---|---|
| `Friday, Jun 12` | `formatDayHeader` — schedule list, bookings, both public pages, settings messages | `format.ts`, UTC accessors |
| `12 Jun 2026` | `formatHistoricalDate` — student history | `format.ts`, UTC accessors |
| `Friday, 12 June` | `(teacher)/page.tsx` today caption | local copy |
| `Jun 12` | `settings/payments/page.tsx` | local copy |
| `Jun 12` | `components/students/student-list.tsx` | local copy — **identical output, separate code** |
| `Friday, June 12, 2026` | `studio-class/[id]/page.tsx` | local copy |
| `Friday, June 12, 2026` | `components/class/class-info.tsx` | local copy — **identical output, separate code** |
| `Week of 12 June` | `class-list.tsx` week headings | local copy |
| `12 June` | `students/[id]` birthday | inline `toLocaleDateString` |
| `June 2026` | `settings/reporting/page.tsx` month rows | local copy |

Two pairs are pure duplication — same output, two hand-rolled implementations.

**The sharper problem is ordering.** Three of these disagree about where the day
goes: `Jun 12`, `12 June`, `June 12, 2026`. A teacher sees `Friday, Jun 12` on
the schedule and `Friday, June 12, 2026` one tap later on the same class.

**Why this grew.** `docs/design-brief.md` is 114 lines, prescribes six type
styles and "calm consistency", and mentions dates **zero times**. Every one of
these was a reasonable local decision in the absence of a rule.

Two of #96's own claims are now stale and are not carried forward: it predicted
`students/[id]` was "likely already wrong for a west-of-UTC viewer" — true when
filed, fixed by #115 — and it lists `paymentStateText` as untested, which #58
covered.

## Design

### 1. Day-first, everywhere

`12 Jun`, not `Jun 12`. It is the international convention, and `CLAUDE.md`
commits to "English first: international from day one". The app currently uses
both orderings, so consistency requires picking one regardless; this is the one
that does not have to be undone when i18n arrives.

This is the expensive direction, and that is accepted rather than overlooked —
see §4.

### 2. Three date formatters, two grouping labels

All in `src/lib/format.ts` beside the existing pair:

```
formatDayHeader(date)      Friday, 12 Jun    lists and headers where the weekday matters
formatDateWithYear(date)   12 Jun 2026       detail pages and history spanning years
formatDateShort(date)      12 Jun            compact, inline in a row
```

`formatDayHeader` keeps its name and its consumers; only its output order
changes. `formatHistoricalDate` is renamed `formatDateWithYear` — its output is
already `12 Jun 2026` and does not change, but "historical" describes when #111
happened to need it rather than what it renders, and it is about to be used on
detail pages for upcoming classes too.

The comma stays: `Friday, 12 Jun`. Standard punctuation, and it preserves the
existing shape of the most-used formatter.

**Two grouping labels are not date renderings and stay separate.** `June 2026`
in `settings/reporting/page.tsx` labels a *set* of months; `Week of 12 Jun` in
`class-list.tsx` labels a *set* of days. `formatMonthLabel` moves to `format.ts`
because a month name and year is a plausibly shared shape; the week label stays
local to `class-list.tsx`, because nothing else groups by week and moving a
single-caller function to a shared module is how `format.ts` accumulates
functions nobody else uses.

### 3. Every local copy is deleted, including the last `toLocaleDateString`

Site by site:

| Site | Becomes |
|---|---|
| `(teacher)/page.tsx` today caption | `formatDayHeader` |
| `settings/payments/page.tsx` | `formatDateShort` |
| `components/students/student-list.tsx` | `formatDateShort` |
| `studio-class/[id]/page.tsx` | `formatDateWithYear` |
| `components/class/class-info.tsx` | `formatDateWithYear` |
| `students/[id]` birthday | `formatDateShort` |
| `settings/reporting/page.tsx` | `formatMonthLabel` |
| `class-list.tsx` week heading | stays local, reordered to `Week of 12 Jun` |

The birthday changes from `12 June` to `12 Jun`. That is a deliberate loss: a
full month name reads slightly warmer on a personal field. It goes because a
fourth shape existing solely for one field is exactly how this issue happened,
and because it is the last `toLocaleDateString` in the codebase — removing it
closes the loophole `src/lib/timezone.ts`'s rule warns about, where a missing
`timeZone` option silently renders the previous day west of UTC.

### 4. The blast radius, stated before it is discovered

`formatDayHeader`'s output changes, and it reaches further than a formatter
usually does:

- **7 production sites** — `(student)/bookings`, both `(public)/[slug]` pages,
  `settings/archived-record.tsx`, `class-list.tsx`,
  `settings/template-action-messages.ts`, `services/class-template-lifecycle.ts`
  (the last as a docblock reference, not a call).
- **A user-facing message string.** `template-action-messages.ts:19` builds
  *"The last one still scheduled is Friday, Jun 12 · 09:30."* Two tests assert
  that sentence verbatim (`template-action-messages.test.ts:118,147`). This is
  not a formatter test incidentally containing a date — it is a copy test whose
  copy is about to change.
- **Visual baselines.** `schedule.png`, `public-page.png` and
  `class-detail-open.png`, each in `chromium` and `Mobile Chrome` — **6 PNGs**
  minimum, and `settings.png` and `inbox.png` should be checked rather than
  assumed clean.

Regenerating baselines is unreviewable by eye. They are therefore regenerated in
their **own commit**, separate from the code change, with the commit message
naming which screens moved and why — so a reviewer can see the diff is exactly
the screens the change predicts, and nothing else.

### 5. The rule goes in the design brief

`docs/design-brief.md` gains a short dates section: day-first, the three
formatters and what each is for, and that `toLocaleDateString` without an
explicit `timeZone` is forbidden on `@db.Date` values. Without it, the next
screen invents a ninth format for the same good reasons the first eight did.

## Testing

- **The three formatters get unit tests** in `format.test.ts`, alongside the
  existing `formatDayHeader` suite, which is updated to the new order. Each
  asserts a whole string, so an ordering regression fails rather than passing on
  a substring.
- **The renamed `formatDateWithYear` keeps its existing assertions** — the
  output is unchanged, only the name is. If any assertion needs editing beyond
  the identifier, the rename changed behaviour and that is a defect.
- **The message test is updated deliberately, not mechanically.** Its new
  expected string is the copy decision; whoever changes it should read the
  sentence aloud and confirm `"…still scheduled is Friday, 12 Jun · 09:30."`
  still reads correctly, rather than pattern-replacing the date.
- **The three uncovered `format.ts` exports get tests while the file is open** —
  `formatRoomLocation`, `formatStudentName`, `timeAgo`. `formatStudentName`
  gates on a privacy flag and is the one that matters; `paymentStateText` is
  already covered by #58 and needs nothing.
- **The suite already runs west of UTC** (`vitest.config.ts` pins
  `America/New_York`), so a formatter that regressed to local accessors would
  fail. No test needs timezone plumbing.

## Out of scope

- **Locale-aware formatting.** `CLAUDE.md` defers i18n routing. Day-first is the
  international default, so this moves toward that rather than away — but no
  `Intl` locale plumbing is introduced here.
- **Time-of-day rendering.** `startTime` is a stored `'HH:MM'` string rendered
  as-is. Untouched.
- **`timeAgo`'s output shape.** It gains tests, not a redesign.

## Risks

- **The copy change is the real risk, not the code.** Eight sites move to a new
  ordering at once, and the only reviewer who can judge whether `Friday, 12 Jun`
  reads right on a teacher's schedule is a human looking at it. The visual
  baselines make the change *visible*; they do not make it *correct*.
- **Regenerated PNGs hide regressions.** A baseline update is a diff nobody
  reads closely. Anything that changes a screen for an unrelated reason in the
  same commit ships unnoticed — which is why §4 isolates them.
- **`formatHistoricalDate`'s rename touches files this change otherwise would
  not.** It is worth it — the name describes an accident of when it was added —
  but a rename with no behaviour change is exactly the kind of diff that gets
  skimmed, and a mistake in it will not fail a test that asserts on output.
