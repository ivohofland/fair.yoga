# Class-time gates on the server (#766)

Three writes trust a class's *status* where they should also ask its *start time*.
Each is re-verified below against the code at `origin/main`; two of the issue's
proposed fixes are corrected.

## Premise check

| Issue claim | Measured | Verdict |
|---|---|---|
| `PUT /api/registrations/{id}` accepts `late_cancel`/`attended`/`no_show` on an `open` class at any distance from its start | `updateRegistrationSchema` takes all three; the `updateMany` WHERE reads class *status* and liveness only; its docblock says "No guard on class TIME either: check-in renders on an `open` class within 15 minutes of its start" — the comment states the design, nothing enforces it | **Holds** |
| "Refuse `late_cancel` from this route" | `attendance-list.tsx` `toggleAttendance` sends `late_cancel` as the **reverse** of a toggle: a student who late-cancelled and was marked `attended` returns to `late_cancel` on the next tap. Refusing the value outright breaks that | **Fix corrected** |
| Manual `open → in_progress` has no time check | `transitionClass` guards only the `open` target. No UI control calls it (no `in_progress` transition caller under `src/components`); only the API route does | **Holds**, API-only |
| `isWalkIn` is true whenever `status === 'in_progress'` | `registrations/route.ts` `isWalkIn = isTeacher && (status === 'in_progress' || now >= start − WALK_IN_WINDOW_MS)` | **Holds** |
| Self-booking accepts a started class until the sweep flips it | `allowedStatuses = isTeacher ? ['open','in_progress'] : ['open']`, no clock | **Holds** |

## Design

### 1. Attendance writes (`PUT /api/registrations/[id]`)

- **Clock gate.** Every attendance write (`attended`, `no_show`, `late_cancel`) is
  refused with 409 `CLASS_NOT_STARTED` before `start − CHECKIN_OPENS_MINUTES`
  (`finish-window.ts`, the same instant `classPageClock` opens check-in from, so the
  server refuses exactly what the page hides). `CLASS_NOT_STARTED` is reused: the
  registry already carries it for "attendance once the class has started".
  The start is read in the route's existing pre-`parseBody` `findUnique`. Time only
  moves forward, so a stale read can only be *too early* by an `updateClass` schedule
  edit made in the gap — the same millisecond-scale staleness `transitionClass`'s
  `STARTS_IN_PAST` read accepts.
- **Origin gate on `late_cancel`.** `late_cancel` is a *restoration*, not an action a
  teacher may take on a live booking: the write's WHERE additionally requires
  `cancelledAt: { not: null }` when the target is `late_cancel`. `DELETE` writes
  `cancelledAt` with `late_cancel` (`[id]/route.ts`), `PUT` never clears it, and
  re-booking clears it (`activateRegistration`), so the column says "this booking
  was once late-cancelled" without a schema change. A `registered → late_cancel`
  write — and the two-step `registered → attended → late_cancel` bypass — match
  nothing. The refusal is 409 `ILLEGAL_TRANSITION` (already registered), chosen in
  the `updated.count === 0` branch when the target is `late_cancel` and the
  re-read shows `cancelledAt === null`: "A booking can only return to a late
  cancellation if the student cancelled late."
- The `late_cancel`-while-class-open race guard (#182) is unchanged.

### 2. Manual start (`transitionClass`)

Target `in_progress` is refused with `TOO_EARLY` → 409 `CLASS_NOT_STARTED` when
`now < start − WALK_IN_WINDOW_MINUTES`. The constant moves from the registrations
route into `finish-window.ts` (a service cannot import a route) beside
`CHECKIN_OPENS_MINUTES`; the route imports it from there. Same read-before-
transaction shape as `STARTS_IN_PAST`, and the same precedence: it falls through
for a missing row or a source status the CAS would reject anyway.

### 3. Self-booking after start (`POST /api/registrations`)

`bookable` gains `isTeacher || now < classStart` for the `open` status. It sits
where `!bookable` already sits, *after* the already-registered answer, so a
student's own retry still answers `unchanged`. Refusal reuses `CLASS_NOT_BOOKABLE`.
A teacher adding a roster student after the start is a walk-in and unchanged.

## Not changed

Attendance after `completed` (billing unaffected, pinned product requirement);
the `class-transitions` sweep (its own CAS, not `transitionClass`); waitlist
claim (already frozen at start); `#765` and sibling issues are unaffected.

## Tests (each guard mutation-proved)

Integration: early `attended`/`no_show`/`late_cancel` → 409 with the code and the
row unmoved; at `start − 15 min` → 200; `registered → late_cancel` in-window → 409;
the UI's `late_cancel → attended → late_cancel` round trip → 200. Service: early
`in_progress` → `TOO_EARLY`, at the edge → ok. Registrations: self-booking at/after
start → 409 `CLASS_NOT_BOOKABLE`; existing booking after start → `unchanged`;
teacher roster add after start still works.
