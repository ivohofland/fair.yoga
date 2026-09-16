# A booking takes the `Student` gate (#625)

`POST /api/registrations` takes `lockLiveStudent` for the booked student as the
first statement of its transaction, on the student's own booking and on the
teacher's roster add alike. A booking and an erasure of the same student then
serialise on the `Student` row, the way `addToWaitlist` and the erasure already
do since #183.

This spec records three things: what the premise sweep measured, what was
decided without a human in the loop (the session ran end to end at the user's
request, and an independent review stood in for the spec gate), and what the
change invalidates.

## Problem, as measured

The issue's reasoning holds, with three refinements.

**Held.** No statement in the booking transaction reads `Student.deletedAt`
(`src/app/api/registrations/route.ts`, read in full). The erasure
(`deleteStudentAccount`, `src/services/gdpr.ts`) cancels upcoming registrations
with one `registration.updateMany` keyed on `studentId`, after its class
pre-lock. After that, the only `Registration` read is the notification scrub's
`findMany`, and that scrub writes no registration. The teacher path checks no
liveness: its only student-side guard is the roster-link read outside the
transaction, and the erasure deletes that link.

**Refinement 1: sequentially, the student path is already refused before the
route's own code.** The route calls `requireSession`, whose `validateSession`
(`src/lib/auth/session.ts`) resolves `studentId` only from a live profile. A
self-booking made after an erasure committed answers 401 (`Session expired`),
because the erasure deletes the account's sessions and `validateSession` drops
a session with no live profile. On a dual-role account whose teacher profile is
live, it answers 403 (`Student access required`). The student path's gap is
only the race: a request that validated its session before the erasure
committed.

**Refinement 2: a teacher-path booking reaches the transaction sequentially
too, whenever a roster link outlives the erasure.** Two sources can leave such
a link:

- #626's `acceptInvitation`, which is ungated and can leave a `TeacherStudent`
  row for an erased profile.
- A self-booking that survived an erasure before this fix. That is the F2a
  shape below, which writes the link as well as the registration.

With such a row in place, the roster-link check passes, and today the booking
commits a `registered` row for "Deleted Student" without any race.

**Refinement 3: a reactivated registration takes no `FOR KEY SHARE` on the
student.** `activateRegistration` (`src/services/waitlist.ts`) reactivates an
existing row with an `UPDATE` that does not change `studentId`, so that
statement takes no lock on the referenced `Student` row. The issue's first
mechanism is that the erasure's closing `UPDATE` waits for the booking's
`FOR KEY SHARE`. That wait therefore happens only for a first booking of the
class, or for a self-booking whose roster-link insert actually inserts.
Otherwise the survivor forms in more interleavings, not fewer.

**The survivor had not been reproduced before this spec.** The plan's first
test run stages it against the unchanged route and records the failure, so the
defect is measured rather than reasoned. The independent review already
reproduced F2b's cycle in two rolled-back psql sessions:
`ERROR: deadlock detected … while inserting index tuple (0,1) in relation
"TeacherStudent"`, with the booking as the victim.

## Decisions

Each was a gate the user delegated. Options, the choice, and why.

1. **Where the gate lives: in the route (chosen).** Two alternatives were
   rejected:
   - **Move the booking transaction into a service first, then gate it there.**
     That rewrites a 334-line, heavily commented route on a security-labelled
     fix, and this project has lost type pins and error branches in exactly
     that kind of move before.
   - **Add a `deletedAt` check before the transaction as well.** A
     pre-transaction check is stale by the time the transaction runs. It would
     also refuse the sequential teacher case before the gate sees it, so
     dropping the gate would turn no sequential test red.

   So no pre-check. The student read stays where it is, outside the
   transaction.
2. **The refusal: 409 on both paths, in each path's own words.**
   - The student path answers `This account has been deleted`, the words
     `addToWaitlist` refuses a join with (`WaitlistJoinError`, reason
     `student_erased`).
   - The teacher path answers `This student's account no longer exists`.

   Both go through the route's existing `catch`, as
   `respondError(message, 409)`, matched on `instanceof StudentErasedError`
   only. A `55P03` from the gate's bounded wait therefore still reaches
   `withErrorHandler` and answers 503 (`classifyApiError`'s transient branch).
   A busy database is never told the account was deleted.
3. **The race tests call the handler in-process, in the serial unit tier.**
   New file: `src/app/api/registrations/route-lock-order.test.ts`, carrying
   the `@serial-tier lock-contention` marker and listed in
   `LOCK_CONTENTION_TESTS` (`vitest.tiers.ts`).
   - `src/app/api/registrations/route.test.ts` already invokes the real `POST`
     against the test database with no server.
   - `src/app/api/classes/route.test.ts` stages a lock race that way from the
     same tier.
   - `vi.spyOn` on `@/lib/db-locks` intercepts the route's named imports, just
     as `src/services/gdpr-lock-order.test.ts` intercepts `gdpr.ts`'s and
     `waitlist.ts`'s. So both racers can be paused in JavaScript at an exact
     statement.

   *Correction:* the first draft of this decision put the races in the
   integration tier, over HTTP. It rested on the premise that nothing could
   pause the booking in JavaScript, which is false. The premise sweep's
   search for in-process route tests missed `route.test.ts` in two ways: a
   zsh glob swallowed the pattern, and the retried pattern could not match a
   relative `./route` import. The independent review caught it. The HTTP
   version also had real costs: HTTP and `next dev` compile timing inside 2s
   lock budgets, and CI's `--file-parallelism` on that tier.
4. **The marker test changes its lock mode and its docblock.**
   `tests/integration/registrations-api.test.ts` ("a first self-booking does
   not wait on a lock held on its student's row") holds `FOR NO KEY UPDATE`,
   the erasure's mode. The gated booking waits on that mode, so the test would
   fail because of the gate, not because of a marker write inside the
   transaction.
   - It moves to `FOR SHARE`, the gate's own mode. The booking's gate shares
     it, and the marker's `UPDATE` conflicts with it. The test keeps its
     discriminator: with the marker write inside the transaction, the booking
     would wait on the holder before committing.
   - Its docblock, which describes the holder as taking "the erasure's lock
     mode" and argues from the pre-gate cycle, is rewritten to state what the
     test now pins and why.

## The fix

### `POST /api/registrations`

- **The gate.** `lockLiveStudent(tx, studentId)` is the transaction's first
  statement, before `lockClassRow`, unconditionally. `studentId` is the booked
  student on either path (`rosterStudentId ?? session.studentId`).
- **The refusal.** The `catch` maps `StudentErasedError` to a 409 with the
  path's words (Decision 2), next to the route's other typed refusals.
- **The gate's comment.** Short: it says what the gate serialises and points
  to `docs/lock-order.md`, "The `Student` row is the erasure's gate", for the
  modes and the order.
- **The marker's comment.** The comment on the post-commit `tierSelectedAt`
  write states today's reason for its placement (below). It currently says
  "must not come after this transaction's other row locks", which no longer
  covers the case: the transaction's first lock is now on that same row.

### Why the marker write stays outside, now

With the gate in place, the booking holds `FOR SHARE` on its student's row for
its whole transaction, so an `UPDATE` of that row inside the transaction would
upgrade that lock. `FOR SHARE` is compatible with itself, so a second gated
writer of the same student can hold it at the same time: another self-booking,
or a waitlist join. Two holders that both upgrade wait on each other.

**Measured 2026-09-16** on the worktree's Postgres:

1. Two sessions each took `FOR SHARE` on one `Student` row, 0.3s apart.
2. Each then ran `UPDATE "Student" SET "tierSelectedAt" = "tierSelectedAt"`
   on that row, at 1.0s and 1.5s.
3. The first failed with `ERROR: deadlock detected` (`40P01`), "while updating
   tuple (0,1) in relation "Student"". The second then completed.

So the rule in `docs/lock-order.md` still binds the booking: an `UPDATE` or
`DELETE` of a `Student` row must come before any other row lock in its
transaction. The measurement is that rule's corollary for a gated writer: its
own `FOR SHARE` counts as such a row lock. The marker is written after commit,
as a statement of its own.

### What the gate closes

- **The survivor.** A booking either takes the gate before the erasure takes
  its half, or waits for the erasure and then refuses.
  - *The booking first.* The erasure's class pre-lock and its `upcoming` read
    run after the booking commits, in statement snapshots that contain the
    registration. For an `open` class, the erasure therefore cancels it and
    runs `handleSpotFreed` for its class, even when that class is outside the
    erasure's lock set. That closes the issue's read-to-write gap for this
    writer. A teacher's walk-in into an `in_progress` class is kept, as the
    erasure keeps every in-progress registration.
  - *The erasure first.* The booking reads the committed `deletedAt`, refuses,
    and writes nothing.
- **The cycle.** For a booking to hold `FOR KEY SHARE` on the student while
  waiting on a row the erasure wrote, both would have to be past their half of
  the gate at once. The gate forbids that.
- **Order.** The booking takes `Student` before `Class`, like both existing
  gated sites. Suppose it took the class first, in a class that is in the
  erasure's lock set. It would hold that class while waiting on the `Student`
  row the erasure holds, and the erasure's pre-lock would wait on that class:
  `40P01`. The student-path race test puts the class in the lock set to make
  this order observable.

**No new cycle. There are new bounded waits.** `FOR SHARE` conflicts with the
`FOR NO KEY UPDATE` that every non-key `Student` update takes.

- *The new waits.* The self-edit (`PUT /api/students/[id]`), the profile
  route, and both post-commit marker writes now wait for an in-flight booking
  of that student. A booking can wait up to 2s behind one of them, then answer
  503.
- *Why no cycle.* Each of those writers is an autocommit statement holding
  nothing else. The only transactional `Student` writer is the erasure, and it
  takes `Student` first. The census is in `docs/lock-order.md`, re-run in the
  plan.
- *The compatible locks.* The `FOR KEY SHARE` that `promoteNext`, `claimSpot`,
  `acceptInvitation`, `unlinkTeacher` and the privacy route take by inserting
  child rows is compatible with `FOR SHARE`.

## Documentation

### `docs/lock-order.md`, "The `Student` row is the erasure's gate"

- **The site table** gains the booking route's row: `lockLiveStudent`, first
  statement of its transaction on both paths, `FOR SHARE`, refusing with the
  two 409s.
- **The order narrative** ("the join first", "the erasure first") is restated
  for a gated writer rather than for the join alone. It names the booking's
  observable case and its tests.
- **The rule** ("an `UPDATE` or `DELETE` of a `Student` row … must come before
  any other row lock") gains its corollary for gated writers: their own
  `FOR SHARE` counts, as measured.
- **The marker paragraph** ("`POST /api/registrations` writes
  `Student.tierSelectedAt` after its transaction commits because of this
  rule") keeps its history, adds today's reason, and describes the pinning
  test's new holder mode.
- **"What still escalates"** drops the booking bullet. Its summary sentence
  covers the two remaining writers, both #626's, and records that the
  booking's cycle was reproduced against the ungated route.
- **"Who is not gated yet"** drops the booking bullet, and its lead-in adds
  the route to the exclusions.
- **The gate call-site census** is re-run.
  - The route's natural import,
    `import { lockClassRow, lockLiveStudent, StudentErasedError } from '@/lib/db-locks';`,
    fits on one line, and none of the census's filters drops a single-line
    import. It would count six lines, not five.
  - So the command gains `| grep -vE ':[0-9]+:import '`, the filter the
    lock-timeout census already uses. Its result is restated with today's
    date.

### `docs/lock-order.md`, "Known conformance"

- **The `POST /api/registrations` entry** currently reads "`Class`, then
  `Registration`, …". It becomes "`Student` (`lockLiveStudent`, #625), then
  `Class`, …", worded like `addToWaitlist`'s entry.
- **The `deleteStudentAccount` entry.** Its sentence "a booking racing the
  erasure is #625" is replaced by what is true now: the booking takes the
  other half of the gate, so its registrations are either in the erasure's
  statement snapshots or refused. The paragraph's broader "Registration half
  stays open" status is untouched: the gate removes one counterparty, it does
  not prove the half safe.

### `docs/data-model.md`

A paragraph in the `Registration` section, after its table, records the
booking decision: refuse, 409, both paths. It mirrors the #183 paragraph's
caveat under `WaitlistEntry`. When the booking takes the gate first, the
erasure cancels the registration but does not undo what
`resolveInvitationOnLink` did (a cleared `TeacherBlock`, an accepted
`Invitation`). It points to `docs/lock-order.md` for the mechanism.

## Tests

### Where they live

- The staged races, and the sequential teacher case, go in
  `src/app/api/registrations/route-lock-order.test.ts` (Decision 3).
  - The erasure is `deleteStudentAccount`, called in the same process.
  - The booking is the route's `POST`, called with a `NextRequest` carrying a
    seeded session cookie, as `route.test.ts` does.
  - Each staged test follows #183's shape: an outer `try/finally` reaps the
    fixture, and an inner `finally` releases every pause and every held row,
    **before** it joins the racers. The racers are turned into values, so a
    join never throws.
- The marker test stays in `tests/integration/registrations-api.test.ts`
  (Decision 4).

### Clocks

- **Every wait inside a transaction is bounded by the 2s `lock_timeout`.**
  The marker write is not: it is an autocommit statement, and the database
  default `lock_timeout` is `0` (measured). On the unchanged route, the
  booking's response therefore cannot arrive until whatever holds the student
  row is released. That is why the inner `finally` releases before joining.
- **Each paused transaction runs under a Prisma budget.**
  - The erasure: 20s.
  - The booking: Prisma's default 5s, since the route passes none.
  - The test's own holders: 30s, stated explicitly.

  Expiring one of these aborts the holder, and the outcome then reads as a
  missing guard. Every poll deadline is therefore short (1.5s), well inside
  them.
- **Fixtures use fresh sessions** (`seedSession`). An old session would make
  `validateSession` write its expiry, and that write waits without a bound on
  the erasure's uncommitted session delete.

### Waits are recorded, not required

Each "did X wait behind Y" poll returns a value instead of throwing. The test
asserts the end state first, then the value. On the unchanged route several
racers never wait (see the last column below). A mutation should fail on the
defect it lets through, not on staging.

### Fixture constraints (each changes what the unchanged route does)

- **The subject's `waiting` entry is seeded directly, not joined through
  `addToWaitlist`.** A join writes a roster link, and a link to the booked
  class's teacher would turn F2a into F2b.
- **No `Invitation` exists for the teacher and the subject's address.** The
  erasure anonymises such rows before its pause. The booking's
  `resolveInvitationOnLink` would then wait on the uncommitted row, which is
  the F2b cycle through a different table.
- **`tierSelectedAt` is null.** Otherwise the unchanged route's marker write
  matches nothing, never waits, and the "booking waited" observation is lost.

### The staged cases

| # | Staging | Path | Green (with the gate) | On the unchanged route |
|---|---|---|---|---|
| F1 | Erasure paused right after `lockStudentForErasure`. The booked class is in its lock set (the student waits there). The booking waits on the erasure, then the erasure is released. | student | erasure commits; booking 409 `This account has been deleted`; no `registered` row; no `TeacherStudent` row | the booking commits first, and only its post-commit marker write waits on the erasure. The erasure then cancels the registration. The response is 201 |
| F2a | Erasure paused after its writes (at `reorderWaitingEntries`), before its closing `UPDATE`. The booked class is outside the erasure's lock set, and the student has no link to that class's teacher. | student | same as F1 | survivor: a `registered` row and a `TeacherStudent` row for the erased profile |
| F2b | As F2a, but the student holds a roster link to that teacher. | student | same as F1 | `40P01` on one side (the issue's cycle; measured by the review) |
| F2c | As F2a, but the teacher books, holding the roster link the check needs. | teacher | erasure commits; booking 409 `This student's account no longer exists`; no `registered` row | survivor: a `registered` row |
| R | Booking paused just before its `lockClassRow`, so with the gate it holds only the gate. The erasure starts and waits on the booking, then the booking is released. The booked class has one seat and another student waiting, and is outside the erasure's lock set. | student | booking 201; erasure commits; the subject's registration `cancelled`; the waiter `registered` (`handleSpotFreed` ran); when the erasure's pre-lock started, a fresh read already saw the subject's `registered` row | the paused booking holds nothing, so the erasure runs through and commits. The released booking then lands on the erased profile: the registration stays `registered`, and the waiter is not promoted |
| S | No race. The student is erased, then a `TeacherStudent` row to the teacher is seeded (Refinement 2's state). | teacher | 409 `This student's account no longer exists`; no registration | 201 |
| B | The test holds `FOR NO KEY UPDATE` on the student. It releases once the booking settles, or after a deadline well past the booking's 2s, whichever comes first. | student | 503; the message is not the deleted one; no registration | the booking commits, and its marker write waits on the holder until the deadline; then 201 |

### The marker test

`registrations-api.test.ts`: the marker test's holder becomes `FOR SHARE`, and
its docblock is rewritten (Decision 4). Its assertions do not change.

### Mutations to record (break, record the exact failure, restore, re-run)

| Mutation | Must turn red |
|---|---|
| M1: gate only on the teacher path (`if (isTeacher)`) | F1, F2a, F2b, R, B |
| M2: gate only on the student path (`if (!isTeacher)`) | F2c, S |
| M3: gate after `lockClassRow` | F1 (the booking holds the class while waiting on the gate), R (the paused booking holds nothing) |
| M4: the route maps any error from the gate to `StudentErasedError` | B |
| M5: marker write moved inside the transaction | the marker test in `registrations-api.test.ts` |

- M1 and M2 together are the issue's "dropping the gate from each path".
- Both `40P01` and `55P03` answer 503 with the same body, so F1's failure
  under M3 reads as a status mismatch. Its SQLSTATE is recorded from the
  error the route's `withErrorHandler` logs, which the in-process test run
  prints.

## Acceptance

1. F1 passes. It is the issue's staged race: the erasure holds its lock, the
   booking waits and is refused, and no `registered` or `TeacherStudent` row
   is left.
2. R passes. It is the reverse race: the erasure waits, then cancels the
   registration and hands the freed seat on.
3. S and F2c pass: the teacher path is refused.
4. M1–M5 are recorded with their failure text.
5. `docs/lock-order.md`'s `Student` section lists the booking route among the
   gated sites, and no longer lists it as ungated or as a cycle. Its "Known
   conformance" entry for the route starts at `Student`.
6. `pnpm run verify` is green, and so is CI.

## Not in scope

- #626's writers (`acceptInvitation`, `unlinkTeacher`,
  `PUT /api/students/[id]/privacy`).
- Moving the booking transaction into a service.
- Reading the student's tier under the gate. `tierAtBooking` still comes from
  the pre-transaction read. A tier change that commits between that read and
  the gate is recorded stale. That predates this issue and is unrelated to
  erasure.
- The "Registration half" of `deleteStudentAccount`'s conformance entry,
  beyond removing the booking as a counterparty.
- Cleaning up survivors that pre-fix races may already have left in
  production data.
