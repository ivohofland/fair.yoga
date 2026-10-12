# Late-publish notice Implementation Plan (#840)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A draft class page tells the teacher, before they publish, when publishing now means students can't cancel for free, and also when the class will go ahead however few book.

**Architecture:** A pure decision function (`src/lib/late-publish.ts`) takes the render's `now` and three instants the page already knows how to compute — the start (`classStartInstant`), the cancel deadline (`cancelDeadlineInstant`, `src/services/waitlist.ts`) and the check instant (`cancelCheckInstant`, `src/lib/auto-cancel-check.ts`) — and returns a three-member state plus the instants at which that state can change. A presentational server component renders the copy for a state. The class overview page wires both in for a non-cancelled draft, and renders `RefreshAt` for a draft too.

**Tech Stack:** Next.js 16 App Router (server component page), React, Vitest (`unit`, `components` projects), Playwright e2e.

**Spec:** none — single-subsystem UI change with one reasonable design (solve-issue's spec gate: not difficult). The decisions the issue left open are recorded below under *Premise and decisions*; the issue is #840.

## Premise and decisions (verified against `origin/main` e1a9a3ee)

- **The issue says the page "already re-renders at key instants (`RefreshAt`)". Not for a draft.** `RefreshAt` renders only when `classPageClock(...).live`, and `live` is `open || in_progress` (`src/lib/finish-window.ts`, `classPageClock`). A draft page today never refreshes on its own. Decision: a draft page renders `RefreshAt` with the late-publish instants, so a draft left open across a threshold picks up the notice.
- **"Just above the Publish button" is not literally possible.** `PublishClassButton` is the `PageHeader`'s `action` slot, beside the title in a `justify-between` row. A paragraph in that slot would squeeze the title. Decision: the notice is the first thing under the header, full width, above `ClassInfo`. That is the nearest place to the button with room for the copy.
- **Inside the check window always means inside the deadline.** `DEADLINE_HOURS` (`src/services/waitlist.ts`) is 48/24/12/6, so its minimum is 6. `CANCEL_CHECK_HOURS` (`src/lib/auto-cancel-check.ts`) is 4/2/1, so `MAX_CANCEL_CHECK_HOURS` is 4. Since 6 > 4, every check instant comes after every deadline instant for the same start. So three states are enough, and the past-check state can name both consequences. A unit test pins `min(DEADLINE_HOURS) > MAX_CANCEL_CHECK_HOURS`, so a new enum value that breaks the ordering fails the build and doesn't silently mislabel the state.
- **Boundaries are the existing predicates', not new ones.** The deadline is "past" strictly after its instant (`isPastCancelDeadline`, `src/lib/cancel-deadline.ts`, the predicate a student's cancel uses). The check is past at or after its instant (`isPastCancelCheck`, the predicate `stampIfPastCancelCheck` uses when publishing). The decision function calls both and spells neither instant itself.
- **A draft whose start has passed gets no notice.** `transitionClass` refuses that publish (`STARTS_IN_PAST_MESSAGE`, `src/services/class-lifecycle.ts`; `startsInPast` is `start < now`). Telling the teacher about consequences of a publish that can't happen would be wrong. The start is also a refresh instant, so a notice standing when the start passes is removed.
- **Out of scope (as the issue states):** the edit form ("Save changes" moving an unbooked open class into its window) and the template form / generator path. #836 is unaffected.

## Global Constraints

- TypeScript strict; no `any`.
- No new color or badge. Gold is the only accent: the notice uses `bg-gold-tint text-gold-deep rounded-card`, the treatment the offline banner already uses (`src/components/layout/offline-snapshot.tsx`). Type style `type-caption`; one of the six styles only.
- Not a blocking confirm. The Publish button's behavior is unchanged.
- Copy register: plain, calm, second person, like `cancelDeadlineHint`/`autoCancelHint` in `src/lib/class-options.ts`. Wording is provisional (UX copy phase).
- Comment discipline (CLAUDE.md): comments annotate the code they sit on; no prose counts or rosters; the enum-ordering fact is pinned by the test, not asserted in a comment elsewhere.

## Review Focus

1. **Exactly at the deadline instant**: still free to cancel (`isPastCancelDeadline` is strict). Expect state `none`. Pinned in Task 1.
2. **Exactly at the check instant**: publishing stamps the decision (`isPastCancelCheck` is inclusive). Expect state `past_check`. Pinned in Task 1.
3. **Start already passed**: expect `none` and no notice. Pinned in Task 1, and the page renders nothing for `none` (Task 2).
4. **A cancelled draft**: no notice (the page renders no Publish button for it). Pinned by the page condition in Task 2; the e2e covers only the live draft.
5. **`minStudents` of 1**: copy reads "nobody books", not "fewer than 1 students book". Pinned in Task 2.

---

### Task 1: Decision function `latePublishState` + notice component

**Files:**
- Create: `src/lib/late-publish.ts`
- Create: `src/lib/late-publish.test.ts` (unit project)
- Create: `src/components/class/late-publish-notice.tsx`
- Create: `src/components/class/late-publish-notice.test.tsx` (components project)

**Interfaces:**
- Produces:
  ```ts
  // src/lib/late-publish.ts
  export type LatePublishState = 'none' | 'past_deadline' | 'past_check';
  export function latePublishState(args: {
    now: Date; start: Date; deadline: Date; checkAt: Date;
  }): LatePublishState;
  /** The instants at which `latePublishState` can change. An unreadable (Invalid Date) instant is dropped. */
  export function latePublishRefreshInstants(args: {
    start: Date; deadline: Date; checkAt: Date;
  }): Date[];

  // src/components/class/late-publish-notice.tsx
  export function LatePublishNotice(props: { state: LatePublishState; minStudents: number }): JSX.Element | null;
  ```

- [ ] **Step 1: Write the failing unit tests** in `src/lib/late-publish.test.ts`:
  - Fixed `start = 2030-01-10T18:00:00Z`, `deadline = start − 12h`, `checkAt = start − 2h`.
  - `now = deadline − 1 min` → `none`; `now = deadline` exactly → `none`; `now = deadline + 1 ms` → `past_deadline`; `now = checkAt − 1 ms` → `past_deadline`; `now = checkAt` exactly → `past_check`; `now = start − 1 ms` → `past_check`; `now = start` → `past_check` (`startsInPast` is `start < now`, so publishing is still allowed at the start instant itself); `now = start + 1 ms` → `none`.
  - `latePublishRefreshInstants` returns `[deadline, checkAt, start]`. Assert the exact ISO strings.
  - Ordering pin: `Math.min(...Object.values(DEADLINE_HOURS)) > MAX_CANCEL_CHECK_HOURS`, importing `DEADLINE_HOURS` from `@/services/waitlist` and `MAX_CANCEL_CHECK_HOURS` from `@/lib/auto-cancel-check`. The test name says why: past the check implies past the deadline, so `past_check` may name both consequences.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit src/lib/late-publish.test.ts`. Expect FAIL: module not found.
- [ ] **Step 3: Implement** `src/lib/late-publish.ts`. It uses `isPastCancelDeadline(deadline, now)` and `now >= checkAt`. The latter is `isPastCancelCheck`'s comparison, written out because `isPastCancelCheck` takes the entry rather than the instant. Both are tied to the predicates by the agreement tests in `late-publish.test.ts`, and no new spelling of an instant (start − hours) is written here. `latePublishRefreshInstants` drops an unreadable (Invalid Date) instant. Start-passed check: `now > start` → `none`. No runtime imports except `@/lib/cancel-deadline`.
- [ ] **Step 4: Run** the unit tests. Expect PASS.
- [ ] **Step 5: Prove the ordering pin bites.** Temporarily change `HOURS_6: 6` to `HOURS_6: 3` in `DEADLINE_HOURS` and run the test. Record the exact failure line. Restore and re-run green.
- [ ] **Step 6: Write the failing component tests** in `late-publish-notice.test.tsx`:
  - `state="none"` renders nothing (`container.firstChild` is null).
  - `state="past_deadline"` renders text containing "can't cancel for free" and not "goes ahead".
  - `state="past_check"`, `minStudents=4` renders both "can't cancel for free" and "fewer than 4 students book", plus "you cover what the missing students would have paid".
  - `state="past_check"`, `minStudents=1` renders "nobody books" and not "fewer than 1", plus "you cover what that student would have paid".
  - The notice carries `bg-gold-tint` and `text-gold-deep` and no `text-danger`.
- [ ] **Step 7: Implement** `LatePublishNotice`, a server-compatible component with no `'use client'`. It is a `<p>` with `type-caption text-gold-deep bg-gold-tint rounded-card px-4 py-3 mb-4`, built from an exhaustive `switch` on `state` with a `never` default. Copy (provisional):
  - `past_deadline`: "This class starts inside its cancellation deadline. Students who book after you publish can't cancel for free."
  - `past_check`: "This class starts inside its cancellation deadline and its auto-cancel check has passed. Students who book after you publish can't cancel for free, and the class goes ahead however few book. If {shortfall}, you cover what {missing} would have paid." Here `shortfall` is `nobody books` and `missing` is `that student` when `minStudents === 1`; otherwise `shortfall` is `fewer than {minStudents} students book` and `missing` is `the missing students`.
- [ ] **Step 8: Run** `pnpm exec vitest run --project components src/components/class/late-publish-notice.test.tsx`. Expect PASS. Then `pnpm exec tsc --noEmit` and `pnpm exec eslint` on the four files.
- [ ] **Step 9: Commit** the four files with message `feat: latePublishState and the notice it renders (#840)`.

### Task 2: Wire the notice and the draft refresh into the class page; e2e

**Files:**
- Modify: `src/app/(teacher)/class/[id]/(overview)/page.tsx`
- Test: an e2e spec. Extend `tests/e2e/class-edit.spec.ts` (it already seeds a draft with Prisma) or add `tests/e2e/late-publish.spec.ts`, whichever reads more cleanly.

**Interfaces:**
- Consumes: `latePublishState`, `latePublishRefreshInstants`, `LatePublishState` from `@/lib/late-publish`; `LatePublishNotice` from `@/components/class/late-publish-notice`; `cancelDeadlineInstant` from `@/services/waitlist`; `cancelCheckInstant` from `@/lib/auto-cancel-check`.

- [ ] **Step 1: Write the failing e2e test.** Seed a teacher-owned draft whose start is 3h from now in the teacher's timezone. Use `wallSlotAt(instant, tz)` from `tests/class-fixtures.ts` to get its `date`/`startTime`. Give it `cancelDeadline: 'HOURS_12'` and `autoCancelCheck: 'HOURS_2'`, so it is past the deadline but not the check. Seed a second draft whose start is 1h from now, which is past both. Visit each `/class/<id>` and assert the notice text: the first has "can't cancel for free" and not "goes ahead"; the second has both. Pick slot times that don't collide with the spec's other seeded classes (the teacher-slot `EXCLUDE` constraint refuses overlapping live entries). Clean them up in the spec's existing teardown. The existing far-future draft (`2099-07-01`) shows no notice. Assert that too, so the "more than the deadline away" criterion is covered end to end. Two further cases: an **open** class 5h out with the same settings shows no notice (the page gates on draft status), and a draft seeded in-test with its deadline 15–75 s ahead shows no notice on load, then shows "can't cancel for free" without a reload once the deadline passes (the page's `RefreshAt` armed with `latePublishRefreshInstants`).
- [ ] **Step 2: Run it** against the worktree app (`pnpm run worktree:up`, then `pnpm exec playwright test <spec>`). Expect FAIL: notice text not found.
- [ ] **Step 3: Implement in the page.**
  - For `!cancelled && cls.status === 'draft'`, compute `start` (already `classStartInstant(cls.calendarEntry, tz)`; hoist it to a const so it is computed once), `deadline = cancelDeadlineInstant(cls.calendarEntry, cls.cancelDeadline, tz)` and `checkAt = cancelCheckInstant(cls.calendarEntry, cls.autoCancelCheck, tz)`.
  - Render `<LatePublishNotice state={...} minStudents={cls.minStudents} />` directly after `<PageHeader … />` (before `RefreshAt`/`ClassInfo`), only for that draft.
  - Render `RefreshAt` when `live` (unchanged instants) **or** for that draft, with `latePublishRefreshInstants(...)`. Keep it a single `RefreshAt` element. Its timer filter already ignores instants in the past.
  - Confirm `tz` is defined before its new first use. Today it is declared just above `classPageClock`.
- [ ] **Step 4: Run** the e2e test. Expect PASS. Run `pnpm exec tsc --noEmit` and lint.
- [ ] **Step 5: Prove the e2e bites.** Temporarily make the page pass `state="none"` always and run the spec. Record the failure. Restore and re-run green.
- [ ] **Step 6: Check the visual baselines.** Run `grep -n "draft" tests/e2e/visual.spec.ts`. If any visual snapshot renders a draft page whose start could be inside its deadline, report it. Don't update baselines.
- [ ] **Step 7: Commit** the page and spec with message `feat: the draft page warns when publishing now is late (#840)`.
