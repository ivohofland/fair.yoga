# A booking takes the `Student` gate (#625)

`POST /api/registrations` takes `lockLiveStudent` for the booked student as the
first statement of its transaction, on the student's own booking and on the
teacher's roster add alike. A booking and an erasure of the same student then
serialise on the `Student` row, the way `addToWaitlist` and the erasure already
do since #183. This spec records what the premise sweep measured, what was
decided without a human in the loop (the session ran end to end at the user's
request), and what the change invalidates.

## Problem, as measured

The issue's reasoning holds, with three refinements.

**Held.** No statement in the booking transaction reads `Student.deletedAt`
(`src/app/api/registrations/route.ts`, read in full). The erasure
(`deleteStudentAccount`, `src/services/gdpr.ts`) cancels upcoming registrations
with one `registration.updateMany` keyed on `studentId`, after its class
pre-lock, and nothing in it re-reads `Registration` after that except the
notification scrub's `findMany`, which writes no registration. The teacher path
checks no liveness: its only student-side guard is the roster-link read outside
the transaction, and the erasure deletes that link.

**Refinement 1: the student path's session check is `requireSession`, not
`requireStudent`.** The route calls `requireSession`, whose `validateSession`
(`src/lib/auth/session.ts`) resolves `studentId` only from a live profile. So a
student-path booking made after an erasure committed answers 403 ("Student
access required") today. The gap is only the race: a request that validated
its session before the erasure committed.

**Refinement 2: a teacher-path booking reaches the transaction sequentially
too, whenever a roster link outlives the erasure.** #626 tracks three writers
that can leave a `TeacherStudent` row for an erased profile. With such a row in
place, the roster-link check passes, and today the booking commits a
`registered` row for "Deleted Student" with no race at all.

**Refinement 3: a rebooking takes no `FOR KEY SHARE` on the student.**
`activateRegistration` (`src/services/waitlist.ts`) reactivates an existing
row with an `UPDATE` that does not change `studentId`, so Postgres takes no
lock on the referenced `Student` row. The issue's first mechanism (the
erasure's closing `UPDATE` waits for the booking's `FOR KEY SHARE`) holds only
for a first booking of that class. A rebooking survives the erasure in more
interleavings, not fewer.

**The survivor has not been reproduced before this spec.** The plan's first
integration test stages it against the unchanged route (Task 1) and records the
failure, so the defect is measured rather than reasoned.

## Decisions

Each was a gate the user delegated. Options, the choice, and why.

1. **Where the gate lives: in the route (chosen).** Alternatives: move the
   booking transaction into a service first, then gate it there; or add a
   `deletedAt` check before the transaction as well. Moving the transaction
   would make unit-tier race tests possible, but it rewrites a 334-line,
   heavily commented route on a security-labelled fix, and this project has
   lost type pins and error branches in exactly that kind of move before. A
   pre-transaction check is stale by the time the transaction runs. It would
   also refuse the sequential cases before the gate sees them, so removing the
   gate would turn no sequential test red. No pre-check, then. The student
   read stays where it is, outside the transaction.
2. **The refusal: 409 on both paths, with each path's own words.** The student
   path answers `This account has been deleted`, the words `addToWaitlist`
   refuses a join with (`WaitlistJoinError`, reason `student_erased`). The
   teacher path answers `This student's account no longer exists`. Both come
   from the route's existing `catch` through `respondError(message, 409)`,
   matched on `instanceof StudentErasedError` only. A `55P03` from the gate's
   bounded wait therefore still reaches `withErrorHandler` and answers 503
   (`classifyApiError`'s transient branch). A busy database is never told the
   account was deleted.
3. **Tests over HTTP, with the erasure in-process.** The integration tier
   already imports `deleteStudentAccount` (`tests/integration/invitations-api.test.ts`)
   and shares its database with the app under test. The test process can stall
   the erasure with `vi.spyOn` on `@/lib/db-locks` and `@/services/waitlist`,
   the mechanism `src/services/gdpr-lock-order.test.ts` uses. It cannot stall
   the remote booking in JavaScript, so the one test that needs the booking to
   hold its gate stalls it in Postgres, behind a `Class` row the test holds.
   New file: `tests/integration/registrations-erasure-gate.test.ts`.
4. **The marker test changes its lock mode.** `registrations-api.test.ts`
   ("a first self-booking does not wait on a lock held on its student's row")
   holds `FOR NO KEY UPDATE`, the erasure's mode. The gated booking waits on
   that mode, so the test would fail for the gate rather than for the marker
   write. It moves to `FOR SHARE`: the gate's own mode, compatible with the
   booking's gate and conflicting with the marker's `UPDATE`. The test keeps
   its discriminator: with the marker write inside the transaction, the
   booking would wait on the holder before committing.

## The fix

### `POST /api/registrations`

- `lockLiveStudent(tx, studentId)` is the transaction's first statement, before
  `lockClassRow`, unconditionally. `studentId` is the booked student on either
  path (`rosterStudentId ?? session.studentId`).
- The `catch` maps `StudentErasedError` to 409 with the path's words (Decision
  2), placed with the route's other typed refusals.
- The gate carries a short comment on what it serialises and a pointer to
  `docs/lock-order.md`, "The `Student` row is the erasure's gate", for the
  modes and the order.
- The comment on the post-commit `tierSelectedAt` write states today's reason
  for its placement (below) instead of "must not come after this
  transaction's other row locks", which no longer covers the whole case: the
  transaction's first lock is now on that same row.

### Why the marker write stays outside, now

With the gate in place, the booking holds `FOR SHARE` on its student's row for
its whole transaction. An `UPDATE` of that row inside the transaction would
upgrade that lock. `FOR SHARE` is compatible with itself, so a second gated
writer of the same student, another self-booking or a waitlist join, can hold it
at the same time. Two holders that both upgrade wait on each other.

**Measured 2026-09-16** on the worktree's Postgres: two sessions each took
`FOR SHARE` on one `Student` row, 0.3s apart, then each ran
`UPDATE "Student" SET "tierSelectedAt" = "tierSelectedAt"` on it, at 1.0s and
1.5s. The first failed with `ERROR: deadlock detected` (`40P01`), "while
updating tuple (0,1) in relation "Student"", and the second then completed.

So the rule in `docs/lock-order.md` ("an `UPDATE` or `DELETE` of a `Student`
row must come before any other row lock in its transaction") still binds the
booking. The marker is written after commit, as a statement of its own.

### What the gate closes

- **The survivor.** A booking either takes the gate before the erasure takes its
  half, or waits and then reads the committed `deletedAt` and refuses. In the
  first case, the erasure's class pre-lock and its `upcoming` read run after the
  booking commits, in a statement snapshot that contains the registration. So
  the erasure cancels it, and `handleSpotFreed` runs for its class even when
  that class is outside the erasure's lock set. That is the issue's read-to-write
  gap, closed for this writer. In the second case the booking writes nothing.
- **The cycle.** For a booking to hold `FOR KEY SHARE` on the student while
  waiting on a row the erasure wrote, both must be past their half of the gate
  at once. The gate forbids that.
- **Order.** The booking takes `Student` before `Class`, like both existing
  gated sites. With the class taken first, a booking into a class in the
  erasure's lock set would hold that class while waiting on the `Student` row
  the erasure holds, and the erasure's pre-lock would wait on that class. The
  result is `40P01`. The student-path race test puts the class in the lock set
  so that this order is observable.

No new wait edge. The only transactional `Student` writers that conflict with
`FOR SHARE` are the erasure's own statements, and the erasure takes `Student`
first. Every other conflicting writer is an autocommit statement holding
nothing else (the census in `docs/lock-order.md`, re-run in the plan). The
`FOR KEY SHARE` that `promoteNext`, `claimSpot` and `completeClass` take by
inserting child rows is compatible with `FOR SHARE`.

## Documentation

`docs/lock-order.md`, "The `Student` row is the erasure's gate":

- The site table gains the booking route's row: `lockLiveStudent`, first
  statement of its transaction on both paths, `FOR SHARE`, refusing with the two
  409s.
- The order narrative ("the join first" / "the erasure first") is stated for a
  gated writer rather than for the join alone, and names the booking's
  observable case and its test.
- The marker paragraph ("`POST /api/registrations` writes
  `Student.tierSelectedAt` after its transaction commits because of this rule")
  keeps its history and adds today's reason: the upgrade deadlock, with the
  measurement.
- "What still escalates" drops the booking bullet. The two remaining writers
  are #626's, and "All three predate the gate" becomes a statement about two.
- "Who is not gated yet" drops the booking bullet.
- The gate call-site census is re-run and its result restated with today's
  date. The command must keep counting calls rather than import lines. The plan
  checks what the route's import line does to it.
- "Known conformance", `deleteStudentAccount`: the sentence "a booking racing
  the erasure is #625" is replaced by what is true now. The booking takes the
  other half of the gate, so its registrations are in the erasure's statement
  snapshot or refused. The paragraph's broader "Registration half stays open"
  status is untouched: the gate removes one counterparty, it does not prove the
  half safe.

`docs/data-model.md`: a short paragraph beside the existing #183 waitlist one,
in the `Registration` section, recording the booking decision (refuse, 409, both
paths), pointing to `docs/lock-order.md` for the mechanism.

## Tests

All in `tests/integration/registrations-erasure-gate.test.ts` unless named. Each
staged test follows #183's shape: an outer `try/finally` that reaps the fixture,
an inner `finally` that releases every stall and joins every racer, and racers
turned into values so a join never throws.

**Timing constraint.** Every wait inside the booking and the erasure is
bounded by the 2s `lock_timeout`. The remote booking's wait begins only after
its HTTP round trip, session validation and (on `next dev`) route compilation,
so "is the booking waiting yet" polls with a generous deadline. Once it is
waiting, the release has to follow promptly, because the booking's 2s is
running.

**Waits are recorded, not required.** Each "did X wait behind Y" poll returns a
boolean instead of throwing. The test asserts the end state first, then the
boolean. On the unchanged route several racers never wait (see the last
column), and a mutation should fail on the defect it lets through, not on
staging.

| # | Staging | Path | Green (with the gate) | On the unchanged route |
|---|---|---|---|---|
| F1 | Erasure paused right after `lockStudentForErasure`. The booked class is in its lock set (the student waits there). The booking waits, then the erasure is released. | student | erasure commits; booking 409 `This account has been deleted`; no `registered` row; no `TeacherStudent` row | booking commits first, and only its post-commit marker write waits on the erasure; the erasure then cancels the registration; the response is 201 |
| F2a | Erasure paused after its writes (at `reorderWaitingEntries`), before its closing `UPDATE`. The booked class is outside its lock set, and the student has no link to that class's teacher. | student | same as F1 | survivor: `registered` row and `TeacherStudent` row for the erased profile |
| F2b | As F2a, but the student holds a roster link to that teacher. | student | same as F1 | `40P01` on one side (the issue's cycle) |
| F2c | As F2a, but the teacher books, and holds the roster link the check needs. | teacher | erasure commits; booking 409 `This student's account no longer exists`; no `registered` row | survivor `registered` row |
| R | The test holds the booked class's row. The booking takes its gate and waits on the class. The erasure starts and waits on the booking. The class is released. The class has one seat and another student waiting, and is outside the erasure's lock set. | student | booking 201; erasure commits; the subject's registration `cancelled`; the waiter `registered` (`handleSpotFreed` ran); when the erasure's pre-lock started, a fresh read already saw the subject's `registered` row | the erasure never waits and commits first. The booking then lands on the erased profile, or times out on the class. Either way no registration ends `cancelled` and the waiter is not promoted |
| S | No race. The student is erased, and a `TeacherStudent` row to the teacher survives (#626's state, seeded directly). | teacher | 409 `This student's account no longer exists`; no registration | 201 |
| B | The test holds `FOR NO KEY UPDATE` on the student. It releases once the booking settles, or after a deadline well past the booking's 2s, whichever comes first. | student | 503 transient message; no registration | the booking commits, and its post-commit marker write waits on the holder until the deadline; then 201 |

`registrations-api.test.ts`: the marker test's holder becomes `FOR SHARE`
(Decision 4). Its assertions do not change.

### Mutations to record (break, record the exact failure, restore, re-run)

| Mutation | Must turn red |
|---|---|
| M1: gate only on the teacher path (`if (isTeacher)`) | F1, F2a, F2b, R |
| M2: gate only on the student path (`if (!isTeacher)`) | F2c, S |
| M3: gate after `lockClassRow` | F1 (a `40P01`, or a `55P03` if the lock timeout fires first) |
| M4: the route maps any error from the gate to `StudentErasedError` | B |
| M5: marker write moved inside the transaction, after the registration | the marker test in `registrations-api.test.ts` |

M1 and M2 together are the issue's "dropping the gate from each path".

## Acceptance

1. F1 passes. It is the issue's staged race: the erasure holds its lock, the
   booking waits and is refused, and no `registered` or `TeacherStudent` row is
   left.
2. R passes. It is the reverse race: the erasure waits, then cancels the
   registration and hands the freed seat on.
3. S and F2c pass: the teacher path is refused.
4. M1 to M5 are recorded with their failure text.
5. `docs/lock-order.md`'s `Student` section lists the booking route among the
   gated sites, and no longer lists it as ungated or as a cycle.
6. `pnpm run verify` is green, and so is CI.

## Not in scope

- #626's writers (`acceptInvitation`, `unlinkTeacher`,
  `PUT /api/students/[id]/privacy`).
- Moving the booking transaction into a service.
- Reading the student's tier under the gate. `tierAtBooking` still comes from
  the pre-transaction read. A tier change committed between that read and the
  gate is recorded stale, which predates this issue and is unrelated to erasure.
- The "Registration half" of `deleteStudentAccount`'s conformance entry, beyond
  removing the booking as a counterparty.
