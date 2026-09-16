# #183: the waiting queue's missing constraint, and an erasure that writes outside its locks

## Problem, as measured

Two halves, both re-checked against `main` at `e04f0dd1` rather than taken from the
issue, which was filed against #174's code and predates #216, #237, #240 and #327.

**Half 2 still holds, and is worse than the issue says.** `deleteStudentAccount`
(`src/services/gdpr.ts`) takes an ordered pre-lock over every class the student holds
a `WaitlistEntry` in (`lockClassRowsOrdered` joined through `CLASS_TO_WAITLIST_JOIN`),
then deletes with `waitlistEntry.deleteMany({ where: { studentId } })`. Under Read
Committed each statement takes a fresh snapshot, so the delete's write set is "every
entry committed by the time the DELETE starts" while the lock set is "every entry
committed by the time the pre-lock started". Only `addToWaitlist` ever creates an
entry or moves one back into `waiting` (census below), and it holds only the lock of
the class it joins. Three windows follow:

| Window | What the join does relative to the erasure | Outcome today |
|---|---|---|
| W1 | commits after the pre-lock, before `waitingClassIds` is read (`gdpr.ts:455`) | entry deleted **and its class renumbered**, both without the class lock |
| W1′ | commits after that read, before the `deleteMany` | entry deleted without the lock; class not renumbered (a gap) |
| W2 | still uncommitted when the `deleteMany` runs | entry **and its `TeacherStudent` link survive** the erasure |
| W3 | starts after the erasure commits, having passed `requireStudent` just before | entry and link created for an erased profile |

Corrections to the issue's text:

- "locks the classes in which the student holds a **`waiting`** entry" — stale. The
  pre-lock has carried no status predicate since #216/#182.
- "Measured impact today is display skew, not a wrong promotion" — wrong for W1. The
  erasure's `reorderWaitingEntries` on an unlocked class plans from one snapshot and
  writes by `id` while class-locked writers (`removeFromWaitlist`, `addToWaitlist`)
  change the queue underneath it. Worked example (reasoning, not a test run): queue
  `a:1 S:2 b:3 c:4 x:5 y:6`; the erasure plans `x→4, y→5`; two removals close `b`,`c`
  and renumber `x:3 y:4`, a join appends `f:5`; the erasure applies its plan: `x:4 y:5
  f:5`. A lasting duplicate, and `promoteNext` orders by `position` with no tiebreak.
- The design question listed three outcomes (delete, refuse, re-scan). W2/W3 are a
  fourth the question did not know about: **survival**. Nothing reaps a surviving
  entry (retention takes only unfulfilled entries on terminal classes past the
  window), and `promoteNext` — which checks no liveness — can later register the
  erased student.
- The two reproduced `40P01`s (against `unlinkTeacher` and `deleteTeacherAccount`) are
  still reachable in the current statement order (reasoning): both need the erasure to
  hold its `StudentPrivacy`/`TeacherStudent` row locks while waiting on the late
  entry's row lock, which the unscoped `deleteMany` takes.

**Half 1: the constraint needs to be partial, not deferred.** Measured on Postgres
16.12 (the `docker-compose` image):

- `EXCLUDE USING btree ("classId" WITH =, position WITH =) WHERE (status = 'waiting')
  DEFERRABLE INITIALLY DEFERRED` is **accepted** — the issue's "if at all" is answered.
- A partial unique index cannot be promoted to a constraint (`ERROR: "…" is a partial
  index — Cannot create a primary key or unique constraint using such an index`), so it
  can never be deferred.
- Deferral is not needed. Every class-locked writer only moves rows out of `waiting`
  or appends at `max + 1`, and `reorderWaitingEntries` renumbers ascending, one
  `UPDATE` per row: with distinct positive positions sorted ascending, the i-th
  position is ≥ i, so each target is ≤ its own row's position and < every
  not-yet-renumbered row's. No transient duplicate is possible. The only path that
  can produce one is the erasure's unlocked renumber in W1, which this design closes.
- Suite evidence: with an **immediate** partial unique index applied by hand to both
  worktree databases, `vitest --project unit --project unit-sweeps` passed
  148 files / 2095 tests and `--project integration` passed 45 files / 711 tests —
  2095 + 711 = 2806 database-backed tests, zero violations. The index bites: mutating
  `addToWaitlist` to `nextPosition = 1` failed 5 tests with
  ``Unique constraint failed on the fields: (`classId`,`position`)``. Both spike
  indexes were dropped afterwards.

### Census (from the premise sweep)

- `WaitlistEntry` writers: `grep -rnE 'waitlistEntry\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b' src`
  → 105 lines; 87 in `*.test.ts`, 3 in comments; 105 − 87 − 3 = **15 production
  call sites**. No raw-SQL writer, no trigger. Every one holds `lockClassRow` or
  `lockClassRowsOrdered` on the class it writes **except** `deleteStudentAccount`'s
  `deleteMany` and its reorder loop.
- Inserts into the four tables with an FK to `Student` (`StudentPrivacy`,
  `TeacherStudent`, `Registration`, `WaitlistEntry`): five statement sites
  (`privacy/route.ts:112`, `invitations.ts:1310`, `roster-link.ts:58`,
  `waitlist.ts:112`, `waitlist.ts:329`). **None reads `Student.deletedAt` inside its
  transaction**; student-initiated ones rely on `validateSession` at request start.
- Explicit locks on `"Student"` in production code or migrations: **none**. The
  implicit ones: `FOR KEY SHARE` from every child insert, and `FOR UPDATE` from the
  erasure's closing `student.updateMany` (it changes `email`, and `Student_email_key`
  is a plain unique index). `docs/lock-order.md` does not name `Student` as a node.

## Decisions

1. **A waitlist join that races its own student's erasure is refused.** The erasure
   wins; whichever of the two takes the `Student` row first finishes, and a join that
   finds the profile erased writes nothing.
2. **This PR gates `addToWaitlist` only.** The other student-row inserters are filed
   as follow-ups (see *Follow-ups*).
3. **Half 1 is an immediate partial unique index**, not a deferred exclusion
   constraint.

## The fix

### 1. A `Student` lock node — `src/lib/db-locks.ts`

Two helpers, each calling `setLockTimeout(tx)` itself first (the `lockClassRow`
shape — a lock wait outside the 2s bound is the defect #174 spent a task removing):

- `lockStudentForErasure(tx, studentId)` —
  `SELECT id FROM "Student" WHERE id = $1 FOR NO KEY UPDATE`.
- `lockLiveStudent(tx, studentId)` —
  `SELECT "deletedAt" FROM "Student" WHERE id = $1 FOR SHARE`; throws
  `StudentErasedError` when `deletedAt` is non-null **or** no row comes back (a
  soft-deleted profile is the only production way a student stops being live; nothing
  in `src/` hard-deletes a `Student`, and refusing is the safe direction either way).

**Why these two modes, and not `FOR UPDATE` / `FOR KEY SHARE`.** Postgres's
conflict table:

| held ↓ / requested → | KEY SHARE | SHARE | NO KEY UPDATE | UPDATE |
|---|---|---|---|---|
| KEY SHARE (child-insert FK check) | – | – | – | **conflict** |
| SHARE (join gate) | – | – | **conflict** | **conflict** |
| NO KEY UPDATE (erasure gate) | – | **conflict** | **conflict** | **conflict** |

- The gate needs the join's mode and the erasure's mode to conflict: `SHARE` vs
  `NO KEY UPDATE` does.
- The erasure's mode must **not** conflict with `KEY SHARE`. `promoteNext` holds a
  class, then inserts a `Registration` for the student it promotes (implicit
  `KEY SHARE`). If the erasure held `FOR UPDATE` on that student and waited on that
  class, the two would deadlock. `NO KEY UPDATE` lets the insert through.
- Child inserters that are not gated keep taking only `KEY SHARE`, which conflicts
  with neither gate mode — so gating one site at a time cannot create a new cycle,
  **provided an `UPDATE` (or delete) of a `Student` row is treated as a lock on the
  `Student` node.** An `UPDATE` takes `FOR NO KEY UPDATE`, which conflicts with both
  gate modes. So outside the erasure it must come before any other row lock in its
  transaction, which in practice means running as a statement of its own. A
  transaction that takes any row lock the erasure or a gated join later requests (a
  `Class` row, a `KEY SHARE` on the student, an `Invitation` row, …) and then updates
  the student closes a cycle. That proviso did not hold when this spec was first
  written. Task 3's review caught it in its `Class`/`KEY SHARE` form (see *Correction*
  below), and Task 4's review generalised it.
- The erasure's closing `UPDATE` still escalates to `FOR UPDATE` (it changes `email`);
  by then it holds every class in its lock set, so no class-locked promotion of this
  student can be in flight. The one cycle that escalation can still close — against an
  ungated booking's roster-link insert — exists today and belongs to follow-up 1.

**Correction (found in Task 3's review, reproduced on a scratch schema).**
`POST /api/registrations` wrote `Student.tierSelectedAt` inside its class-locked
transaction, after inserting the `Registration`. With the erasure holding
`FOR NO KEY UPDATE` from its second statement, that closes two new cycles:
- **A, any class.** The booking holds `KEY SHARE` and waits for `NO KEY UPDATE`, while
  the erasure's closing `FOR UPDATE` waits on that `KEY SHARE`.
- **B, a class in the erasure's lock set.** The booking holds the `Class` row and
  waits on `Student`, while the erasure holds `Student` and waits on the `Class` row.

A grep of production `student.update*` calls found that write to be the only `Student`
update made inside a class-locked transaction. The others (`api/account/student-profile`,
`api/students/[id]`, `api/waitlist`, the sign-in claim) hold no class lock. **Fix,
in this PR:** the booking's `tierSelectedAt` write moves to after its transaction
commits, as `POST /api/waitlist` already does. The route change is outside the "gate
only the join" scope, and deliberately so: the cycle is this PR's own, and the change
gates nothing. It also removes the `SHARE → NO KEY UPDATE` upgrade deadlock that
follow-up 1's gate would otherwise create between two concurrent first bookings by the
same student.

### 2. `deleteStudentAccount` — new opening, scoped delete

Statement order inside the transaction becomes:

1. `setLockTimeout(tx)` — unchanged, still first.
2. **`lockStudentForErasure(tx, studentId)`** — new.
3. The ordered class pre-lock — unchanged, but its returned ids are kept
   (`lockedClassIds`).
4. **The `upcoming` registration read, moved here** from above the pre-lock
   (lock-then-read, the #367 shape). A promotion of this student that commits while the
   erasure waits on that class is otherwise cancelled by the `registration.updateMany`
   below without ever reaching `handleSpotFreed`. Registrations in classes outside
   the lock set keep the read-to-write gap; only an ungated booking can open it, which
   is follow-up 1.
5. `waitingClassIds` read — as today, and additionally restricted to
   `lockedClassIds`.
6. Writes as today, except `waitlistEntry.deleteMany` becomes
   `{ studentId, classId: { in: lockedClassIds } }`, followed by
   `waitlistEntry.count({ where: { studentId } })`. A non-zero count throws
   `ErasureLockSetError` and the transaction rolls back.

With the gate, no entry can exist outside `lockedClassIds`, so the count is always
zero. The check exists so that a future writer that creates entries without the gate
fails loudly and safely, instead of being deleted outside the lock set. The scoped
delete also means the erasure never takes a row lock on an entry whose class it does
not hold, which removes the wait edge both reproduced `40P01` cycles needed.

`DELETE /api/account`'s `erasureFailure` answers `ErasureLockSetError` with the
**busy** message (503, `ERASURE_BUSY`): a retry's pre-lock covers the class that
appeared, so "press Delete again" is true and "will not fix it" would not be. The
change is one disjunct in `erasureFailure`'s own `transient`. The handler's log line
computes its level from `isTransientDbError` alone, which is false for this error, so
it is logged at `error`, not `warn` — reaching it means an ungated creator exists.

`AlreadyErasedError` and the closing CAS are unchanged in code. A second concurrent
erasure now waits at step 2 instead of at the closing `UPDATE`, reads `upcoming` only
after the first has committed — so it finds nothing to free — then reaches the CAS
and throws as before. That changes what the throw is FOR: the `Student` lock, not the
abort, is now what prevents a doubled `spot_available` broadcast, and the abort is
what keeps a redundant second pass from committing (and what the route maps to 200).
`AlreadyErasedError`'s docblock says the abort prevents the doubled broadcast and
cites a test for it; both are rewritten to the new division of labour.

### 3. `addToWaitlist` — the gate

First statement of the transaction, before `lockClassRow`: `lockLiveStudent(tx,
studentId)`. `StudentErasedError` is translated to `WaitlistJoinError` with a new
reason, `'student_erased'` (message: "This account has been deleted"), which
`POST /api/waitlist` already answers with 409. The later plain
`student.findUniqueOrThrow` for the email stays; the lock is already held.

Resulting behaviour:

- **Erasure locks first:** the join waits (≤ 2s), then reads `deletedAt` set and is
  refused. No entry, no link. If the erasure outlasts 2s the join fails `55P03`,
  which `classifyApiError` already answers as transient; the retry meets a deleted
  session.
- **Join locks first:** the erasure waits at step 2 (≤ 2s) until the join commits;
  its pre-lock then returns the new class, and it locks, deletes and renumbers it.
- **Join after the erasure committed:** refused.

W1, W1′, W2 and W3 are all closed by this, for the one creator of entries.

### 3b. `POST /api/registrations` — the marker write leaves the transaction

The student's own booking sets `Student.tierSelectedAt` (null-guarded) after its
transaction commits instead of inside it. This is the correction under §1, and it
follows `POST /api/waitlist`'s shape. Pinned by a new integration test: a holder takes
`Student FOR NO KEY UPDATE`, and a first self-booking's `Registration` must commit
while it is held. `tests/integration/tier-selected-at.test.ts` keeps pinning the
marker's semantics.

### 4. The constraint — migration `…_waitlist_waiting_position_unique`

Hand-authored, two statements:

1. A `DO $$` block that renumbers each class's `waiting` rows to `1..n`, ordered by
   `(position, "createdAt", id)`, updating only rows whose position changes, and
   `RAISE NOTICE`s the affected count when it is non-zero. A no-op on clean data;
   repairs a duplicate or gap so step 2 cannot fail on deploy. The index does not
   exist yet, so the single `UPDATE` cannot trip it. The notice is not optional:
   `src/lib/migration-remediation-trace.test.ts` refuses a post-cutoff migration
   whose `UPDATE "…"` carries neither a live `RAISE NOTICE` nor a
   `-- DML WITHOUT NOTICE:` line, and a remediation that may touch production rows is
   exactly what should announce itself (the `20260905120000_class_room_archive_invariant`
   precedent).
2. `CREATE UNIQUE INDEX "WaitlistEntry_waiting_position_key" ON "WaitlistEntry"
   ("classId", "position") WHERE status = 'waiting';`

The only `--` lines are a short header pointing at `docs/data-model.md`, each on its
own line (the same test refuses a trailing `--`). Prose about a migration goes in
`docs/` (CLAUDE.md, *Comment Discipline*).

`prisma/schema.prisma` gets a `///` docblock on `WaitlistEntry` naming the index, in
the `Room` precedent's shape (`schema.prisma:291`). CI's drift check (`ci.yml`,
`prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --exit-code`)
does not see partial indexes under Prisma 6.19.3: re-run against a database carrying an
equivalent index, it printed "No difference detected" and exited 0. The existing
non-unique `@@index([classId, position])` stays.

What the index does **not** enforce, deliberately: gap-freedom (a cross-row property
no constraint expresses, and a gap preserves promotion order), and anything about
closed rows (they keep stale positions by design). A violation rolls the offending
transaction back and reaches a client through `classifyApiError`'s existing `P2002`
fallback (409, `warn`, `meta.target` logged). That branch is unchanged.

## Documentation

- `docs/lock-order.md`
  - Canonical line becomes `Student → Class → WaitlistEntry → …`, with a sentence
    scoping `Student` to sites that lock it explicitly.
  - New section *The `Student` row is the erasure's gate (#183)*: the mode table
    above, the `promoteNext` cycle `FOR UPDATE` would close, why a partial rollout
    is safe, the escalation note.
  - *Known conformance*, `deleteStudentAccount` entry (currently "It is the outlier
    on `WaitlistEntry`…" through "All three left open"): the "outside the gate — a
    live cycle" window is closed and says by what; the `Registration` half stays
    open and points at follow-up 1.
  - *`Class` is the real gate* (the paragraph citing `deleteStudentAccount` as the
    case where the lock set is smaller than the write set): rewritten to what is true
    after this change.
  - *Every site that bounds a lock wait*: the two new helpers.
- `docs/data-model.md`, `WaitlistEntry`: the partial index, why partial and why
  immediate, the spike numbers, and the refusal policy.

## Claims this fix invalidates, and where

Sweep keys (grep, then read each hit): `#183`, `deleteMany({ where: { studentId } })`,
`write set`, `lock set`, `no window`, `outlier`. Known hits:

- `gdpr.ts:386-447` — the pre-lock's comment block ("the lock set has to cover the
  write set", "no window between choosing them and holding them"); the latter is true
  only for the rows the statement returns.
- `gdpr.ts:449-459` — "closed rows keep stale positions by design (#183)".
- `gdpr.ts:461-521` — references the unscoped `deleteMany` as the lock-order hazard.
- `class-transitions.ts:392-394` — "issue #183 is open precisely because…".
- `class-transitions.ts:514-516` — "every writer of `WaitlistEntry` takes this class's
  row lock first": true after this change; re-check, do not assume.
- `waitlist.ts:1166`, `lib/waitlist-status.ts:41` — "(#183)" as the owner of the
  stale-position decision; the index now encodes it.
- `waitlist.ts:189-205` (`addToWaitlist` docblock) — gains the gate; `:274-278` names
  the lock order and must add `Student`.
- `removeFromWaitlist`'s docblock (`waitlist.ts:352-370`) describes a concurrent
  erasure race; re-read for accuracy.

A grep finds stale names, not stale descriptions: every docblock in
`deleteStudentAccount` and `addToWaitlist` is read in full after the change.

## Tests

In `src/services/gdpr-lock-order.test.ts`, reusing its harness (spy-stall on a
`db-locks` helper, handshake promises, causal release flags, `joinOrThrow`). Each row's
mutation is applied, its exact failure text recorded, then restored and re-verified.

| # | Scenario | Asserts | Mutation that must turn it red |
|---|---|---|---|
| R1 | erasure holds the `Student` lock; a **rejoin** (the student holds a closed entry in that class, so it is in the erasure's lock set) | join blocked while held; then `WaitlistJoinError('student_erased')`; no entry, no `TeacherStudent` | drop the join's gate; weaken it to `FOR KEY SHARE`; move it below `lockClassRow` (`40P01` — the rejoin is what makes the gate-before-class order observable) |
| R2 | join holds its `Student` lock; erasure starts | erasure blocked while held; then the new entry is gone and the class's remaining `waiting` positions are `1..n` | drop the erasure's `Student` lock (the erasure is no longer blocked while held; it runs its pre-lock before the entry exists, then waits at its closing `UPDATE` instead, and the entry survives) |
| R3 + R6 | one staging: `promoteNext` holds the class, promoting the student, while the erasure takes its `Student` lock and waits on that class; a second waiter queues behind the student | both complete with no `40P01` (R3); after the erasure, the second waiter holds a `registered` row — `handleSpotFreed` ran for the class (R6) | erasure takes `FOR UPDATE` → `40P01`; `upcoming` read moved back above the pre-lock → second waiter not promoted |
| R4 | an entry inserted directly (bypassing the gate) after the pre-lock | erasure throws `ErasureLockSetError`; student not erased, entry intact | remove the count check; revert to the unscoped `deleteMany` |
| R5 | `addToWaitlist` for an erased student | `WaitlistJoinError('student_erased')`, no entry (unit, `waitlist.test.ts`) | drop the join's gate |
| L1–L3 | the helpers' modes, in `db-locks-lock-order.test.ts`: `lockLiveStudent` waits behind `lockStudentForErasure` (L1); a real child insert (`TeacherStudent`) does NOT wait behind it (L2); `lockStudentForErasure` waits behind `lockLiveStudent` (L3) | causal release flags | `lockLiveStudent` → `FOR KEY SHARE` (L1 red); `lockStudentForErasure` → `FOR UPDATE` (L2 red) |
| C1 | two `waiting` rows, one class, one position | `P2002` on `['classId','position']` | drop the index |
| C2 | `waiting` + `removed` at one position; two closed rows at one position; one position in two classes | all accepted | make the index non-partial (C2 must fail) |
| M1 | the migration file itself: inside one transaction, drop the index, seed a class with a duplicate and a gap, execute the migration's two statements as written, assert `1..n` in `(position, createdAt, id)` order and that the index exists again, then roll back | as stated | break the renumber's ordering (M1 red); remove the renumber (the `CREATE UNIQUE INDEX` fails on the seeded duplicate) |

M1 takes `ACCESS EXCLUSIVE` on `WaitlistEntry` for its transaction, so it lives in its
own `@serial-tier lock-contention` file, the `class-lifecycle-tier-guard.test.ts`
precedent; C1/C2 stay in the parallel tier.

Also over HTTP, in `tests/integration/account-api.test.ts` beside its existing
`ERASURE_BUSY` / `ERASURE_FAILED` cases: `DELETE /api/account` answers
`ErasureLockSetError` with 503 `ERASURE_BUSY`. Staged the way those cases are — hold a
row the erasure writes after its pre-lock (for instance one of the student's
`Registration` rows) for less than the 2s bound, insert an entry for the student
directly while the erasure waits, release. Mutation: drop the route's
`ErasureLockSetError` branch (the response becomes 500 `ERASURE_FAILED`).

Existing tests whose comments go stale because the erasure now blocks at its second
statement instead of its last (assertions still hold, by reasoning; confirmed by the
run):

- `gdpr-lock-order.test.ts`, "erases once when the same student erasure runs twice
  concurrently" (`:1877` holder): its lever paragraph says both erasures read the
  same non-empty `upcoming` and park at the closing CAS. Both now park at
  `lockStudentForErasure`, and the loser reads an empty `upcoming`. Its notification
  assertion now stays green if EITHER the abort or the `Student` lock is removed
  alone; the rejection-count assertion is what pins the abort. The comment is
  rewritten to say so, and both single mutations are recorded.
- `gdpr-lock-order.test.ts:760-762`: "`setLockTimeout` twice … fires twice" is now
  three times.
- `tests/integration/account-api.test.ts:654-662` and the `:759` test's comments:
  "park at the write" is now "park at the erasure's `Student` lock".

## Follow-ups (to be filed with this PR's number)

1. **A booking that races its student's erasure survives it.** `POST
   /api/registrations`, student path and teacher path (the latter checks no liveness
   at all): a `registered` row for "Deleted Student" counts toward the class's
   post-completion pricing, so other students' prices are wrong. Carries the existing
   cycle between the erasure's closing `UPDATE` and the booking's roster-link insert,
   and the registration read-to-write gap for classes outside the erasure's lock set.
   Fix shape: `lockLiveStudent` at the top of the transaction.
2. **Link-only survivors.** `acceptInvitation`, `PUT /api/students/[id]/privacy` and
   `unlinkTeacher` can leave a `TeacherStudent` or `StudentPrivacy` row for an erased
   profile. Same fix shape; lower stakes.

## Not in scope

- The non-unique `(classId, position)` index.
- Gap-freedom as an enforced property.
- `deleteTeacherAccount` and the teacher-side lock set.
- The renumbering discipline itself (#174), beyond the erasure's unlocked instance of
  it.

## Acceptance

1. The mid-erasure decision is recorded (here, and in `docs/data-model.md`): refuse.
2. `deleteStudentAccount`'s `WaitlistEntry` writes are scoped to its lock set, and no
   join can create an entry outside that set (R1, R2, R4, R5).
3. The partial unique index lands with a migration and a test that fails without it
   (C1), and the spike's result — Postgres can express the deferred form, and deferral
   is not needed — is recorded.
4. `docs/lock-order.md` names the `Student` node and no longer records the #183 cycle
   as open.
5. Follow-ups 1 and 2 are filed.
