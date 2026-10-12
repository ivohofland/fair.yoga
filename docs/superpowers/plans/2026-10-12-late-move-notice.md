# Late-move notice — implementation plan (#847)

**Spec:** `docs/superpowers/specs/2026-10-12-late-move-notice-design.md` — read it
first; it is the authority this plan argues from.

**Goal:** the class edit form warns above "Save changes" when moving an
unbooked open class to a start inside its cancellation deadline. The warning is
computed from the form's current values by the same implementation the overview
page uses.

**Task order is load-bearing:** Task 2 imports what Task 1 creates.

## Global Constraints

- TypeScript strict, no `any`. Test-first: write the failing test, see it fail, implement, see it pass.
- Comment discipline (CLAUDE.md, *Comment Discipline*): a comment annotates the
  code it sits on. No prose counts or member rosters, no "previously read X"
  history. Moved docblocks move with their code; reword only what the move made
  false.
- No re-exports to preserve old import paths: a moved name gets its importers
  updated, so each name has one import path.
- The modules the client imports (`src/lib/class-start.ts`,
  `src/lib/cancel-deadline.ts`, `src/lib/cancel-check.ts`,
  `src/lib/late-publish.ts`) must not import, at runtime and transitively,
  `@/lib/log`, `@/lib/degradation`, `@/lib/db`, `server-only` or anything under
  `src/services/`. `import type` is fine.
- Prove every new guard bites: break it, record the exact failure text in the
  report, restore, re-run.
- Fast loop: `pnpm exec vitest run --project unit <path>` /
  `--project components <path>`. Before reporting DONE, run
  `pnpm run typecheck` and `pnpm run lint`. (Check `package.json` for the exact
  script names.)
- Stage exact paths, never `git add -A`. Quote paths containing parentheses.
  Commit messages end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` and reference `(#847)`.

## Task 1: Client-safe instants, one implementation behind the server wrappers

**Files:** create `src/lib/class-start.ts`, `src/lib/class-start.test.ts`,
`src/lib/cancel-check.ts`. Modify `src/lib/timezone.ts`,
`src/lib/cancel-deadline.ts`, `src/lib/auto-cancel-check.ts`,
`src/services/waitlist.ts`, `src/lib/late-publish.ts`,
`src/lib/late-publish.test.ts`, `src/app/(teacher)/class/[id]/(overview)/page.tsx`,
and every importer of a moved name (at the time of writing
`src/services/class-transitions.ts` and its test, `src/services/waitlist.test.ts`;
re-derive with `grep -rn "DEADLINE_HOURS\|CANCEL_CHECK_HOURS" src`).

1. **`readClassStart`** in `src/lib/class-start.ts`:
   `readClassStart(cls: { date: Date; startTime: Date }, timeZone: string): ClassStartReading`.
   `ClassStartReading` is a discriminated union: `{ fault: null; instant }`,
   `{ fault: 'date' | 'start-time'; instant /* Invalid Date */ }`, and
   `{ fault: 'timezone'; instant /* UTC-interpreted fallback */; error: unknown }`.
   It holds the arithmetic now inside `classStartInstant` (the wall-clock build,
   the two NaN checks, the two-pass offset correction). `timeZoneOffsetMs` moves
   here from `timezone.ts`. No logging.
2. **`classStartInstant`** in `timezone.ts` keeps its signature and docblock
   (trim only what moved) and becomes `readClassStart` plus one `logDegraded`
   call per fault. Code, `site`, message and `err` must match today's calls exactly.
   The existing `timezone.test.ts` / `iana-timezone.test.ts` must pass
   **unmodified**. That is the evidence that behaviour held.
3. **Deadline:** move `DEADLINE_HOURS` from `waitlist.ts` to
   `src/lib/cancel-deadline.ts` and add
   `cancelDeadlineFrom(start: Date, cancelDeadline: CancelDeadline): Date`
   (`import type` for the enum). `cancelDeadlineInstant` in `waitlist.ts`
   keeps its signature and becomes
   `cancelDeadlineFrom(classStartInstant(entry, timeZone), cancelDeadline)`.
4. **Check:** move `CANCEL_CHECK_HOURS`, `DEFAULT_CANCEL_CHECK_HOURS`,
   `MAX_CANCEL_CHECK_HOURS` into new `src/lib/cancel-check.ts` with
   `cancelCheckFrom(start: Date, autoCancelCheck: AutoCancelCheck): Date`.
   `cancelCheckInstant` and `isPastCancelCheck` stay in `auto-cancel-check.ts`
   with the same signatures; `cancelCheckInstant` becomes
   `cancelCheckFrom(classStartInstant(...), ...)`. Update importers of the
   constants (`class-transitions.ts` re-exports two of them; point that
   re-export, or its importers, at the new module, whichever leaves one path per name).
5. **`latePublishInstants`** in `late-publish.ts`:
   `latePublishInstants(args: { start: Date; cancelDeadline: CancelDeadline; autoCancelCheck: AutoCancelCheck }): { start: Date; deadline: Date; checkAt: Date }`,
   built from `cancelDeadlineFrom` and `cancelCheckFrom`. The overview page's
   `lateInstants` block uses it, passing the `start` it already computes with
   `classStartInstant`. Drop the page's now-unused imports.
6. **Tests**
   - `class-start.test.ts`: a readable entry in a DST zone gives `fault: null`
     and the same instant `classStartInstant` returns. An Invalid `date`
     gives `fault: 'date'` and an Invalid instant. An Invalid `startTime` gives
     `fault: 'start-time'`. An unknown zone gives `fault: 'timezone'` and the
     UTC-interpreted instant. None of them logs: spy on the log module and
     assert no calls.
   - `late-publish.test.ts`: `latePublishInstants` equals
     `{ start, cancelDeadlineInstant(...), cancelCheckInstant(...) }` for every
     `CancelDeadline` × `AutoCancelCheck` pair, so the client path and the server
     wrappers cannot diverge. Update its imports for the moved constants.
   - **Client-safety pin:** a unit test that walks the static import graph from
     the four client-imported modules (resolve `@/` to `src/`, skip
     `import type`) and asserts none of the forbidden modules in Global
     Constraints is reached. Check first whether the repo already has such a
     guard (`grep -rn "server-only" src --include=*.test.ts`) and extend it
     rather than writing a second one. Prove it bites: add
     `import { log } from '@/lib/log'` to `class-start.ts`, record the failure,
     restore.
7. Commit (one or two commits).

## Task 2: The notice on the edit form

**Files:** modify `src/components/class/late-publish-notice.tsx` and its test,
`src/components/class/class-edit-form.tsx` and its test,
`src/app/(teacher)/class/[id]/edit/page.tsx`,
`src/app/(teacher)/class/[id]/(overview)/page.tsx` (pass `action="publish"`).

1. **Notice copy.** `LatePublishNotice` gains a required
   `action: 'publish' | 'move'`. The `publish` strings stay byte-identical, and
   the existing tests still pass with `action="publish"` added. The `move` strings,
   verbatim:
   - `past_deadline`: `The new start is inside this class's cancellation deadline. Students who book after you save can't cancel for free.`
   - `past_check`: `The new start is inside this class's cancellation deadline and past its auto-cancel check. Students who book after you save can't cancel for free, and the class goes ahead however few book. If ${shortfall}, you cover what ${missing} would have paid.`
     Use the same `shortfall`/`missing` singular rule the publish copy uses,
     shared rather than duplicated.
   Update the docblock to cover both actions.
2. **Edit page** passes
   `moveWarning={cls.status === 'open' && !cls.settingsLocked ? { timeZone, cancelDeadline: cls.cancelDeadline, autoCancelCheck: cls.autoCancelCheck } : null}`.
   The timezone is the teacher's `defaultTimezone`, so add it to the query's
   `include`. Name the prop's type in the form module.
3. **Form.**
   - `moved = form.date !== initial.date || form.startTime !== initial.startTime`.
   - When `moveWarning` is non-null and `moved`, build the entry from the fields
     (`date`: `new Date(\`${form.date}T00:00:00Z\`)`; `startTime`: `hhmmToTime`).
     Read `readClassStart(entry, moveWarning.timeZone).instant`, get the
     instants from `latePublishInstants`, and the state from
     `latePublishState({ now, ...instants })`. An empty or half-typed field gives
     an Invalid instant and so `none`. Do not special-case it.
   - `now` is `useState` (epoch ms), set to `Date.now()` in `set()` on every
     field change. One `useEffect` arms a single `setTimeout` to the next
     instant from `latePublishRefreshInstants` after `now`, which sets `now`
     again. Skip delays ≤ 0 or > `2 ** 31 - 1` (the bound `RefreshAt`
     documents). Clean up on change and unmount.
   - Render `<LatePublishNotice action="move" state={…} minStudents={form.minStudents} />`
     directly above the "Save changes" row.
4. **Component tests** (`class-edit-form.test.tsx`, fake timers with a fixed
   system time and `moveWarning` in `Europe/Amsterdam`):
   - Unchanged schedule on an open class already inside its deadline: no notice.
   - Moving the start to inside the deadline but before the check: the
     `past_deadline` move copy, exactly.
   - Moving inside the check window: the `past_check` copy, plural and
     `minStudents === 1` singular.
   - Moving to a start further away than the deadline: no notice. Moving back
     out after showing it: the notice disappears.
   - `moveWarning={null}` (draft / locked) with the same move: no notice.
   - The clock crossing the deadline with the form open and no edit: advancing
     the fake timers past the deadline makes the notice appear.
   - The notice sits before the Save button in document order.
   Prove the timer and the `moved` gate bite: remove each, record the failure, restore.
5. **e2e:** if `e2e/` holds the #840 late-publish spec, add one case beside it.
   Edit an unbooked open class to a start inside its deadline, see the notice,
   restore the original time, see it go. Follow that spec's setup helpers. If
   no such spec exists, say so in the report and skip.
6. Commit.
