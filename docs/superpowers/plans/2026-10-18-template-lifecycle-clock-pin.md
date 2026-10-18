# #902 — pin the clock in the template-lifecycle probe cases

**Goal:** the probe cases that read today's occurrence, in
`src/services/class-template-lifecycle.test.ts` and its studio twin
`src/services/studio-class-template-lifecycle.test.ts`, give the same answer
at every hour of the day.

## Premise, as measured (corrects the issue)

The issue blames a local-vs-UTC date disagreement. The fixture teacher is
`UTC` (`seedTeacher`'s default), so the teacher-local date and the UTC date
never disagree. The real cause is the #859 `past_cancel_check` decline:
`updateRule` (`rule-lifecycle.ts`) judges every candidate at
`at = now + CLASS_GENERATION_INTERVAL_MS` (1 h), and `classPastCancelCheck`
declines a candidate whose auto-cancel check (`autoCancelCheck`, default
`HOURS_2`) is not after `at`.

For the cancelled-holder case: start 23:58 − 2 h − 1 h = **20:58 UTC**. With
the clock pinned through `vi.setSystemTime` on 2026-10-17:

| now (UTC) | CEST  | result |
|-----------|-------|--------|
| 20:50     | 22:50 | pass   |
| 20:57     | 22:57 | pass   |
| 20:59     | 22:59 | **fail** `expected 1792368000000 to be 1791763200000` |
| 21:00     | 23:00 | **fail** (before local midnight, so the issue's mechanism cannot explain it) |
| 22:30     | 00:30 | **fail** (the issue's own measurement) |
| 23:30     | 01:30 | **fail** |

Consequences the issue missed:

- **CI is not immune.** The window is 20:58–24:00 UTC, so a CI run in those
  hours fails too.
- **The two sibling cases are vacuous in the window, not red.** `declines a
  date a live studio class holds` and `declines a date an OVERLAPPING
  same-family class holds` pass there, but only because the decline removes
  the blocked date before the holder can matter. What they're named for is not
  tested then.
- The fourth `todaySchemaDay` case (`drops an occurrence whose start has
  already passed`, 00:00 start) is correct at every hour, but it reads
  `new Date()` several times, so it has a sub-millisecond race at UTC midnight.
  It is pinned too. Its docblock sits above the wrong `it` (stacked on the
  cross-family case's docblock) and moves to its own test.
- The studio family's mirror (`declines a date a live class from the other
  family holds`, 23:59) is vacuous from 22:59 to 24:00 UTC: there the
  past-start filter drops today's candidate before the holder can matter. Its
  past-start case has the same midnight race. Both are pinned the same way.

## Task 1 — pin the clock (single task)

**Files:** `src/services/class-template-lifecycle.test.ts` and
`src/services/studio-class-template-lifecycle.test.ts`.

1. Inside `describe('updateClassTemplate (DB)')`, add a helper that fakes
   `Date` only (`vi.useFakeTimers({ toFake: ['Date'] })`, so the database
   client keeps its real timers), sets it to **today's UTC date at 12:00 UTC**,
   and restores real timers via `onTestFinished`. Follow the `clockAt` idiom in
   `src/app/api/registrations/route.test.ts`.
2. Call it first in each of the four cases, before `todaySchemaDay` and
   `occurrences` are derived. Each case and the service then read the same
   pinned instant. Set `autoCancelCheck: 'HOURS_2'` explicitly on the three
   probe fixtures, so the comments' arithmetic does not rest on the schema
   default.
3. Rewrite those cases' comments so they state what is true now: the pin, why
   noon (the probe judges at 13:00, while both a 23:5x start and its 21:5x
   auto-cancel check come later, so neither the past-start filter nor the
   `past_cancel_check` decline can drop today's occurrence). Delete the "on
   most runs" hedges. Refer to the pin by the helper's name, not by position
   ("as the cases above").
4. Move the orphaned past-start docblock onto `drops an occurrence whose start
   has already passed`.
5. In `studio-class-template-lifecycle.test.ts`, add the same helper (copied,
   per the per-file test-helper convention), call it in the live-holder and
   past-start cases, and rewrite their "on most runs" and "crossed midnight"
   wording.

**Proof the fix bites (record exact output):**

- **Acceptance.** Temporarily wrap the system clock at 2026-10-17T22:30:00Z
  (Sunday 00:30 Europe/Amsterdam) before the pin derives "today". All four
  cases pass. Without the pin, the cancelled case fails with the same error
  text as above. Restore.
- **Mutation, pin hour.** Change the pinned hour from 12 to 21. The cancelled
  case fails. Restore.
- **Mutation, the siblings bite under the pin.** Delete the holder fixture in
  the live-studio case, then in the overlap case. Each fails (`firstEffective`
  lands on `blocked`'s week). Restore.
- **Mutation, the studio mirror.** With the clock faked at 23:30Z, move the
  studio live-holder fixture out of the horizon. Unpinned, the case still
  passes, which is the vacuous window. Pinned, it fails. Restore.
- Run both files, then `pnpm run typecheck` and `pnpm run lint`.

## Not in scope

- The studio cancelled-holder case: it uses tomorrow's weekday at 23:59, which
  stays ahead of the probe's instant at every hour.
- `sameWeekDayPair()` in `tests/integration/class-templates-api.test.ts` and
  `studio-api.test.ts`: never today, HTTP-driven (the server's clock cannot be
  pinned), not reported failing.
