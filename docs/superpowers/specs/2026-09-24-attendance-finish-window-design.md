# Attendance finish window — design (#234)

**Status:** approved in brainstorming 2026-09-24; this document is the written
record for review.

## 1. The problem, as measured

#234 says the teacher's only window to record attendance is while they are
teaching. Every claim in it holds at `615c6623`:

- `showCheckin` (`src/app/(teacher)/class/[id]/page.tsx:156-157`) is
  `!cancelled && (status === 'in_progress' || (status === 'open' && minutesToStart <= 15))`.
  A `completed` class renders `PricingBreakdown` + `PaymentChecklist` only —
  no attendance list, no walk-in, no finish button.
- `autoCompleteClasses` (`src/services/class-transitions.ts:716-725`) completes
  once `currentTime >= end`, and the `class-transitions` scheduler job runs every
  minute (`src/lib/scheduler.ts:238-246`). So the list disappears about a
  minute after the scheduled end.
- The PUT (`src/app/api/registrations/[id]/route.ts`) keeps `completed`
  writable, pinned by `tests/integration/registrations-api.test.ts`
  ("allows attendance corrections on a completed class"). Its schema accepts
  `attended | no_show | late_cancel`, all in `CHARGED_STATUSES`
  (`src/services/class-lifecycle.ts`), so a correction cannot change who is
  billed or by how much.
- `attendance-list.tsx` labels an untouched `registered` row "No-show".

What the issue did not say, measured in the premise sweep:

- **The payment request is worded from attendance at completion** (#661,
  `studentPaymentRequestBody`, `src/lib/payment-request-copy.ts`): `no_show`
  reads "We missed you at …", `registered`/`attended` the neutral wording. A
  correction made after completion does not resend (accepted in
  `docs/superpowers/plans/2026-09-23-no-show-payment-copy.md`). So completion
  is the moment attendance *reaches the student*, and completing a minute
  after the end means that moment arrives before the teacher has had a free
  minute.
- **The finish button can bill a class before it starts.** `CompleteClassButton`
  renders whenever `showCheckin` does — from 15 minutes before the start — with
  no confirm step. `POST /api/classes/[id]/complete` passes
  `{ finishedEarly: true }`, which skips every time check, and `completeClass`'s
  `open` branch moves the class to `in_progress`, prices it, writes `Payment`
  rows and sends every payment request. The API accepts an `open` class on any
  date. One mis-tap before class is irreversible (`in_progress → completed`
  only; `completed` has no exits).
- **Untick writes `no_show`, never `registered`.** The toggle
  (`attendance-list.tsx`) goes `attended ↔ no_show`; the schema cannot express
  `registered`. Returning a row to "not recorded" is impossible — acceptable,
  since a teacher who touched the row did record something.
- **Walk-ins close at completion** — `POST /api/registrations` admits a teacher
  only on `open`/`in_progress`. Out of scope here (§6), but it means the grace
  period below also extends the walk-in window.
- **Nothing else depends on completion landing at the end.** An unlimited
  `grep -rln "in_progress" src/` lists 42 files; piping it through
  `grep -c "\.test\.tsx\?$"` gives 24 tests, so 42 − 24 = 18 non-test. Every
  non-test consumer is keyed on the start instant, runs on a days scale, or is
  cosmetic: the "In progress"/"Below minimum" badge persists up to the grace
  length past the end, and payments/reporting/the student's price appear that
  much later.
- **There is no shared end-instant helper.** `start + durationMinutes` is
  computed inline in `autoCompleteClasses` and in `completeClass`.

## 2. Decisions

| # | Decision | Chosen |
|---|---|---|
| D1 | When does a class complete on its own? | At **end + 15 minutes**, not at end. |
| D2 | Can the teacher finish earlier? | Yes, from **end − 15 minutes** but never before the start, with a confirm step. |
| D3 | Is the finish window enforced below the UI? | Yes — under the class row lock in `completeClass`, for both the sweep and the teacher route. |
| D4 | Does editing close after completion? | **No.** Corrections stay possible, behind an "Edit attendance" affordance on the completed view. They do not resend the payment request. |
| D5 | Row labels | Untouched `registered` reads **"Not marked"**. One tap: Not marked → Present, then Present ↔ No-show. Late cancel keeps its own round trip. |
| D6 | Auto-flip `registered → no_show` | **No** — still rejected, per `2026-08-15-queue-close-and-sweep-locks-design.md` §2.4. |

"Finish" is the existing `in_progress → completed` transition. No new
`ClassStatus`, no migration.

## 3. The finish window — one module

`src/lib/finish-window.ts`, pure, no framework imports:

```ts
export const FINISH_GRACE_MINUTES = 15;

export function classEndInstant(entry, timeZone): Date      // start + durationMinutes
export function finishOpensAt({ start, end }): Date         // max(start, end − grace)
export function autoFinishAt(end: Date): Date               // end + grace
export function formatClockInZone(instant, timeZone): string // HH:MM for the caption
export const CHECKIN_OPENS_MINUTES = 15;
export function classPageClock({ now, start, end, status, cancelled })
  // → { live, showCheckin, canFinish, autoFinishing, autoAt, refreshInstants }
```

`formatClockInZone` falls back to UTC on an unreadable zone and says so, and
answers the placeholder `formatInstantInZone` uses for an unreadable instant
rather than throwing; both log at `error`. `CHECKIN_OPENS_MINUTES` is the
check-in rule's own lead time, not the grace. `classPageClock` is the class
page's whole clock logic (§5.1), pure and unit-tested; an unreadable edge is
left out of its `refreshInstants`.

One constant sets both edges. Both edges are the same length from the end
because a teacher who can finish 15 minutes early and gets 15 minutes
afterwards has one symmetric window around the end.

**The teacher's edge is clamped to the start.** A class no longer than the
grace (schemas accept any positive duration) would otherwise open its finish
window at or before it begins, which is the pre-start billing hole §1 names.
`finishOpensAt` therefore takes the start as well as the end, as named fields
so the two cannot be swapped, and returns the later of the start and
end − grace. The sweep's edge needs no clamp: end + grace is always after the
start. Callers never do this arithmetic themselves:

- `autoCompleteClasses`'s pre-filter compares `now` against `autoFinishAt`.
- `completeClass`'s locked check does the same (§4).
- The class page shows the finish button and the auto-finish caption from the
  same functions (§5).

`classEndInstant` replaces the two inline `start + duration` computations.

## 4. `completeClass` states who is finishing

`CompletionTiming` today is `{ requireEndedBy: Date } | { finishedEarly: true }`.
It becomes:

```ts
export type CompletionTiming =
  | { sweepAt: Date }        // autoCompleteClasses: refused before autoFinishAt
  | { teacherAt: Date }      // POST /complete: refused before finishOpensAt (≥ start)
  | { finishedEarly: true }; // deleteTeacherAccount only: no clock
```

Each variant also declares the other two keys as `?: never`, so a literal
naming two callers (`{ sweepAt, teacherAt }`) does not compile. A plain union
accepts it, because an object literal's excess-property check runs against the
union as a whole. An `@ts-expect-error` fixture pins this.

It stays a required union, for the reason its docblock gives (#182: the
dangerous mode must not be the silent default). Under the row lock, after
the cancellation check, the function computes the start and end from the row it
just read and refuses `NOT_ENDED_YET` when the caller's instant is before that
caller's edge — `autoFinishAt(end)` for `sweepAt`, `finishOpensAt({ start, end })`
for `teacherAt`, both from that row. The variant-to-edge mapping is an
exhaustive helper whose `never` default stops a new variant compiling until it
names its edge. The `Invalid Date` → `TypeError` guard applies to both clock
variants. An unreadable schedule makes the edge itself an Invalid Date, which
`at < edge` would pass for every `at`. The function fails closed: it logs at
`error` with the class id and refuses `NOT_ENDED_YET` before any write.

**The status is checked before the clock, and nothing is written before
either passes.** Today the clock comes first, which was harmless while the
teacher route skipped it. Under `teacherAt`, a double-tap on a class that is
already `completed` but dated after "now" would answer `NOT_ENDED_YET`, a red
error for a goal that already holds. CLAUDE.md's rule is that "already done"
answers 200 once past any refusal that makes the goal moot, and a clock refusal
does not. A future-dated `draft` would likewise answer `NOT_ENDED_YET`
instead of `ILLEGAL_TRANSITION`. The order under the lock is therefore:

1. cancelled
2. status validation (no writes)
3. clock
4. writes

- **Sweep.** `autoCompleteClasses` passes `{ sweepAt: currentTime }`. Its
  `warn`-level handling of `NOT_ENDED_YET` is unchanged: a reschedule that
  moved `autoFinishAt` later between the snapshot and the lock just defers to
  the next tick.
- **Teacher.** `POST /api/classes/[id]/complete` passes
  `{ teacherAt: new Date() }`. `NOT_ENDED_YET` is already mapped there, to the
  registered `CLASS_NOT_ENDED_YET` (409), which has been unreachable until now.
  Its copy changes from "This class hasn't finished yet." to one that tells
  the teacher when they can finish ("You can finish this class from 15 minutes
  before it ends, once it has started."), built from `FINISH_GRACE_MINUTES`.
  The "once it has started" clause is the clamp, and is what makes the copy
  true for a class no longer than the grace. This is the only user
  of that refusal.
- **Erasure.** `deleteTeacherAccount` keeps `finishedEarly`. Its docblock
  loses the teacher-route mention.
- **The `open` branch** (open → in_progress → completed in one transaction)
  stays. Under `teacherAt`, an `open` class at or past `finishOpensAt` is one
  whose start sweep has not run. Finishing it is still correct, and the branch
  still closes its queue.

## 5. UI

### 5.1 Class page (`src/app/(teacher)/class/[id]/page.tsx`)

- The page's clock logic is `classPageClock` (§3). The page passes its render
  time and uses what comes back.
- Check-in visibility is unchanged: `in_progress`, or `open` within
  `CHECKIN_OPENS_MINUTES` of the start. The only difference is that
  `in_progress` now lasts until `autoFinishAt`.
- **The finish button** replaces the `showCheckin` header action with its own
  condition: not cancelled, `in_progress` or `open`, and `now ≥ finishOpensAt`.
  Before that, check-in shows no header action.
- **The auto-finish caption** appears while the button is visible: "Payment
  requests go out automatically at {time}", in the teacher's timezone, where
  {time} is `autoFinishAt`. When no one is charged it reads "This class
  finishes automatically at {time}" instead, matching the confirm's n = 0 copy.
  At or past `autoFinishAt` (the sweep is late, or down) it names no time and
  reads "This class is finishing automatically."
- **The page re-renders itself at the edges.** Both conditions above are read
  from the clock at render, so while the class is live the page mounts a small
  client component (`refresh-at.tsx`) that calls `router.refresh()` when the
  check-in edge (an `open` class only), `finishOpensAt` and `autoFinishAt`
  arrive. A render that finds the class still live past `autoFinishAt` (the
  sweep has not landed yet) asks again a minute later. The page passes ISO
  strings and its own render time (`serverNow`); each wait is
  `instant − serverNow`, so a client clock ahead of the server cannot refresh
  before the server-side edge, and every render re-arms the timers. The client
  component does not import `@/lib/finish-window`.
- **Completed view**: an Attendance section above `PricingBreakdown`, read-only
  by default (§5.3).

### 5.2 Finish confirm (`complete-class-button.tsx`)

- Label: "Finish class".
- The first tap opens an inline confirm in place. This is not a browser
  `confirm()`, which the project avoids. It reads: "Finish class? Payment
  requests go to {n} students now." with **Finish** and **Keep open**.
- {n} is the charged-registration count the page already has. The copy for
  n = 0 needs its own wording ("No one is charged for this class.").
- Error handling is unchanged (`readErrorMessage`, `router.refresh()` on
  success).
- **Keep open** is disabled while the POST is in flight: it cannot be recalled.

### 5.3 Attendance list (`attendance-list.tsx`)

- **Labels.** `attended` → "Present", `no_show` → "No-show", `late_cancel` →
  "Late cancel", `registered` → "Not marked". This retires the conflation the
  issue names.
- **Toggle.** Unchanged in writes. Not marked → `attended`, then
  `attended ↔ no_show`, and late cancel keeps its `attended ↔ late_cancel`
  round trip. The aria-labels follow the new labels.
- **Edit mode.** A new prop selects `editable` (check-in) or `locked`
  (completed). `locked` renders the same rows with the toggles hidden, and an
  "Edit attendance" link switches the component to editable in place. Editable
  on a completed class carries the caption: "Corrections update the record —
  the payment request already sent stays as it is."
- The stale `classIsOpen` comment in the row renderer goes with this change.

## 6. Out of scope

- **Walk-ins after finishing.** They would need re-pricing and a new payment
  request, which is a different feature. The grace period already gives
  walk-ins 15 more minutes.
- **Re-sending or amending the payment request after a correction.** #661
  accepted this.
- **An "Ended" badge state during the grace period.** The badge reads "In
  progress" for up to 15 minutes past the scheduled end, while the class is
  still genuinely open for attendance. Accepted.
- **A per-teacher grace setting.** YAGNI.

## 7. Testing

Each boundary gets a mutation step in the plan: break it, record the failure,
restore.

- `finish-window` unit tests: the edges, and a timezone case (DST day,
  Europe/Amsterdam).
- `completeClass`:
  - **Sweep.** Refused at `autoFinishAt − 1ms`, completes at exactly
    `autoFinishAt`. This replaces "completes a class at exactly its end
    instant". The reschedule-earlier and `Invalid Date` tests move to
    `sweepAt`.
  - **Teacher.** Refused at `finishOpensAt − 1ms`, completes at exactly
    `finishOpensAt`. Also: a teacher finish on an `open` class inside the
    window, and one refused outside it (the pre-start billing hole), and a
    class no longer than the grace refused a millisecond before its start.
- `autoCompleteClasses`: a class at end + 5 minutes stays `in_progress`, and at
  end + 15 minutes it completes.
- The complete route: 409 `CLASS_NOT_ENDED_YET` (asserting the code, not the
  message) before the window, 200 inside it.
- Components:
  - AttendanceList: labels per status, locked vs editable, and the "Edit
    attendance" switch.
  - CompleteClassButton: first tap confirms and the second posts; "Keep open"
    posts nothing, and is disabled while the POST is in flight; the n = 0 copy.
  - RefreshAt: refreshes at each future instant and not before, ignores a
    past one and one beyond `setTimeout`'s limit, and not after unmount. It
    counts from `serverNow` with the client clock skewed ahead, and re-arms on
    new instants and on a new `serverNow` alone.
- `classPageClock`: the check-in edge, `finishOpensAt` and its clamp to the
  start, the retry a minute after a render past `autoFinishAt`, and nothing
  live on a completed, cancelled or draft class.
- `completeClass` on an unreadable schedule, through a stub (no row can hold
  one): refused `NOT_ENDED_YET` under both clock variants, no writes.
- e2e `teacher-journey.spec.ts`. `checkinSlot(durationMinutes)` places the
  class so it ends in ten minutes, inside both the check-in window and the
  teacher's finish window. "Finish class" opens the inline confirm and
  "Finish" completes it.

## 8. Docs and comments this changes

Each of these states completion timing or the completed view's contents, and
is corrected in the same branch (replaced, not annotated):

- `page.tsx`, the comment above `showCheckin` ("within 60 seconds of its
  scheduled end")
- `class-transitions.ts`: the header item 3, `autoCompleteClasses`'s docblock,
  and the pre-filter comment
- `class-lifecycle.ts`: `CompletionTiming`'s docblock and the #182 timing block
- `registrations/[id]/route.ts`: the "#234 is the UI work that makes it
  reachable" paragraph
- `complete/route.ts`: the `finishedEarly` comment and `COMPLETE_REFUSAL`'s
  "cannot reach this route" note
- `docs/technical-architecture.md`, the lifecycle lines
- `docs/information-architecture.md`, the Completed row and the transition
  note
- `docs/design-brief.md`, the completed view contents
- `docs/teacher-screens.md` 6.1 / 7.1
- `docs/lock-order.md`, the `requireEndedBy` passage
- CLAUDE.md: "Prices are calculated after class ends" still holds. The Class
  Lifecycle section gains the grace in one line.

Applied migrations and the 2026-08-15 spec are records, and are not edited.
