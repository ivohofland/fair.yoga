# Class-time gates (#766) — plan

Spec: `docs/superpowers/specs/2026-10-07-class-time-gates-design.md`. Test-first throughout:
write the failing test, see it fail for the stated reason, implement, see it pass.
Tasks are independent except Task 2 creates the shared constant Task 3 does not need;
order 1 → 2 → 3 is only for review ergonomics. Run with the worktree's own app
(`pnpm run worktree:up`); fast loop `pnpm exec vitest run --project integration <path>`.
Node 24 must be first on PATH.

## Task 1 — attendance writes (`src/app/api/registrations/[id]/route.ts`, PUT)

Files: that route; `src/lib/finish-window.ts` (export `checkinOpensAt(start: Date): Date`
= start − `CHECKIN_OPENS_MINUTES`, and have `classPageClock` use it); tests in
`src/app/api/registrations/[id]/route.test.ts`, `src/lib/finish-window.test.ts`.

Behaviour:
- The pre-`parseBody` read also selects the entry's `date`, `startTime` and the teacher's
  `defaultTimezone`. After the body parses, `now < checkinOpensAt(classStartInstant(...))`
  → 409 `CLASS_NOT_STARTED`, message "Attendance can be recorded from 15 minutes before
  the class starts." Nothing is written. The ordering relative to the existing refusals:
  cancelled class and "already holds the requested status" answers keep priority only
  where they are decided from the WHERE re-read; the clock gate is checked first because
  a write before the window is refused whatever the row holds.
- When the target is `late_cancel`, the `updateMany` WHERE also requires
  `cancelledAt: { not: null }`. In the `count === 0` branch, a re-read showing
  `cancelledAt === null` with target `late_cancel` answers 409 `ILLEGAL_TRANSITION`,
  "A booking can only return to a late cancellation if the student cancelled late."
  Place it after the cancelled-class and unchanged answers, before the status switch.
- Update the docblock paragraph that says "No guard on class TIME either" so it states
  what is true now; the old text is history (git/PR body), not a comment.

Tests (all in the PUT describe, using existing fixtures):
- early (`start − 16 min` and a class days ahead) `attended`, `no_show`, `late_cancel` →
  409 `CLASS_NOT_STARTED`, row unchanged; exactly `start − 15 min` → 200.
- `registered → late_cancel` in window → 409 `ILLEGAL_TRANSITION`; the two-step
  `registered → attended → late_cancel` → second step 409.
- a booking cancelled late via DELETE → `attended` → `late_cancel` → 200 (the UI toggle).
- fixtures use a UTC teacher (`wallSlotAt(…, "UTC")`); beware existing tests that write
  attendance on far-future classes — they must move their class into the window, not
  weaken the gate.
- Mutation-prove each guard: remove the clock gate; remove `cancelledAt: { not: null }`;
  record the exact failing assertion text for each in the report.

## Task 2 — manual start (`src/services/class-lifecycle.ts`)

Files: `class-lifecycle.ts`, `src/lib/finish-window.ts` (add
`WALK_IN_WINDOW_MINUTES = 15` and `walkInOpensAt(start)`), the registrations route
(import them; delete its local `WALK_IN_WINDOW_MS`), `src/lib/api-error-codes.ts` is
unchanged, `transition/route.ts` (`TRANSITION_REFUSAL` gains `TOO_EARLY` →
`CLASS_NOT_STARTED`; the `satisfies Record<…>` forces it), `TransitionFailureReason`
and its docblock, and `docs/data-model.md` (walk-in window sentence names the new home
of the constant and that a manual start respects it).

Behaviour: `transitionClass(…, 'in_progress')` for a live class whose source status the
CAS would accept and `now < walkInOpensAt(start)` → `{ ok:false, reason:'TOO_EARLY' }`.
Same read-before-transaction shape and fall-through precedence as `STARTS_IN_PAST`
(missing row, or a status that would be illegal anyway, falls through). A cancelled
class keeps answering `CANCELLED` (check order: existing refusals first).
Message: "This class can be started from 15 minutes before its start time."
Log at info like the sibling refusal.

Tests: service (`class-lifecycle.test.ts`) and route (`transition/route.test.ts`):
early → refused, status unchanged; exactly at the edge → ok; draft/illegal pairs still
answer their own reasons; fixtures that start a future class must be moved to the edge.
Mutation-prove the guard.

## Task 3 — self-booking after start (`src/app/api/registrations/route.ts`)

`bookable` for a non-teacher also requires `Date.now() < classStart`. It stays where the
`!bookable` refusal is — after the already-registered answer — so a student's retry of
their own booking after start still answers `unchanged`. Refusal code
`CLASS_NOT_BOOKABLE`. A teacher roster add after start is unaffected.

Tests in `src/app/api/registrations/route.test.ts`: self-book at `start − 1 s` → 200;
at `start` → 409 `CLASS_NOT_BOOKABLE` with no registration row written; a student
already booked retrying after start → 200 unchanged; teacher roster add after start
(open class) still 200. Mutation-prove.

## Finish

`pnpm run verify` green (state the arithmetic of projects); sweep every doc/comment that
mentions the three behaviours (`grep -rn "within 15 minutes\|WALK_IN_WINDOW_MS\|No guard on class TIME"`)
and fix each hit, including `docs/`.
