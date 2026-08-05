# The class-status invariant belongs in Postgres, not in seven call sites

Issue #174. Spun out of #166 / PR #169, which added a fourth participant to the
`Class` row lock and found three sites that never took it.

The issue is right about all three sites and wrong about the shape of the
problem. This is not three fixes. It is two invariants that are currently
conventions — enforced, where they are enforced at all, by each writer
remembering to — plus one lock-ordering inversion that no mechanism can enforce
and that therefore has to be written down.

## The problem, stated after measuring it

Two families, with genuinely different answers:

**Family 1 — illegal states.** `VALID_TRANSITIONS` (`src/services/class-lifecycle.ts:29-35`)
makes `completed` and `cancelled` terminal: both map to `[]`. Three separate
sites can nevertheless write past a terminal status, because each decides from a
read taken before it holds the row:

- `completeClass` writes `completed` over `cancelled`
- `transitionClass` writes `in_progress` over `cancelled`
- `deleteTeacherAccount` writes `cancelled` over `completed`

The queue has the same shape: `WaitlistEntry` has no unique on
`(classId, position)` (`prisma/schema.prisma:521-522` — `@@unique([classId, studentId])`
and a **non-unique** `@@index([classId, position])`), so two concurrent
renumberings leave duplicate or skewed positions with no error. `promoteNext`
picks its head by `orderBy: { position: 'asc' }` (`src/services/waitlist.ts:375-378`),
so a skewed queue silently promotes the wrong student.

**Family 2 — lock ordering.** Two transactions taking the same two rows in
opposite orders deadlock. Postgres aborts one with `40P01`, which reaches the
user as a 500 through `withErrorHandler`.

## What was measured

### Every `Class` write in the repository

`grep -rn "class\.update\|class\.upsert\|class\.updateMany" src/ tests/ prisma/`
returns **21** call sites. Of those, **11 write `status`** — 7 in production
code, 4 in test fixtures. The remaining 10 write `settingsLocked`, economic
fields, `date`/`startTime`, or `description`.

The 7 production status writes:

| Site | Writes | Source state | Safe today? |
|---|---|---|---|
| `src/app/api/classes/[id]/transition/route.ts:35` | `cancelled` | CAS `status in [draft, open]` | **yes** |
| `src/services/class-transitions.ts:113` | `cancelled` | CAS `status = 'open'` | **yes** (for status; see the count defect below) |
| `src/services/class-lifecycle.ts:107` | any target | unconditional, unlocked read at `:101` | no |
| `src/services/class-lifecycle.ts:159` | `in_progress` | unlocked read at `:149` | no |
| `src/services/class-lifecycle.ts:170` | `completed` | unlocked read at `:149` | no |
| `src/services/class-lifecycle.ts:188` | `completed` | unlocked read at `:149` | no |
| `src/services/gdpr.ts:434` | `cancelled` | unconditional, unlocked `findMany` at `:423` | no |

The 5 unsafe writes live in exactly 3 functions: `transitionClass`,
`completeClass`, `deleteTeacherAccount`.

### The four class-lock writers in `waitlist.ts` — the issue's count re-derives

`grep -n "FOR UPDATE" src/services/waitlist.ts` returns **9** lines, not 4.
Lines `149`, `319`, `656`, `694`, `697` are prose inside docblocks and comments;
lines `170`, `334`, `466`, `707` are the statements. So the issue's "four
writers" is a correct reading of a grep that does not itself report 4. Recorded
because a future reader re-running that grep will see 9.

### Every writer of `WaitlistEntry.position`

Every one goes through `reorderWaitingEntries` (`src/services/waitlist.ts:731-750`),
whose own deciding read (`:735`) is unlocked and un-predicated. Callers:

**With the class lock:** `promoteNext` (`:448`), `claimSpot` (`:552`),
`withdrawWaitingEntriesForTeacher` (`:723`), `POST /api/registrations` (`:187`).

**Without it:**
- `removeFromWaitlist` (`src/services/waitlist.ts:309`) — the issue's gap 1.
- `deleteStudentAccount` (`src/services/gdpr.ts:359-361`) — **not in the issue.**

### Reachability, re-derived rather than assumed

The transitions sweep runs **every 60 seconds** (`src/lib/scheduler.ts:92`).
Its three passes run **sequentially** in-process (`isolatedSweeps`,
`src/lib/scheduler.ts:33-49` — a `for` loop with `await`) but **concurrently**
on the HTTP cron path (`src/app/api/cron/transition-classes/route.ts:15-19`,
a `Promise.all`). So whether auto-start races auto-cancel with no user involved
at all is deployment-dependent; whether it races a *teacher's* manual cancel is
not.

## Corrections to the issue's premise

**1. It is two fixes, not three.** Gaps 1 and 2 are one rule — hold the class
row lock before the read you decide from — applied at different sites. Gap 3
shares only the word "lock": different tables, different failure mode (a `40P01`
surfacing as a 500, not silent corruption), different remedy (ordering, not
locking).

**2. The lock-discipline half covers more sites than the issue names.** Beyond
`removeFromWaitlist` and `completeClass`:

- **`transitionClass`** (`src/services/class-lifecycle.ts:96-109`) has the
  identical shape to `completeClass` and is worse: it has **no `$transaction`
  at all**, so its read at `:101` and its write at `:107` are two separate
  autocommit statements. Reached from `POST /api/classes/[id]/transition:76`
  and from `autoTransitionToInProgress` (`src/services/class-transitions.ts:56`).
- **`deleteTeacherAccount`** (`src/services/gdpr.ts:423` → `:434`) is the
  mirror: an unlocked `findMany` filtered to `draft`/`open`/`in_progress`, then
  an *unconditional* `update` to `cancelled`. A class that reaches `completed`
  in between is force-cancelled after its `Payment` rows exist and its students
  have been told to pay.
- **`deleteStudentAccount`** (`src/services/gdpr.ts:359-361`) renumbers the
  queue with no class lock.

**3. The escape argument in `waitlist.ts:669-671` is true but does not reach
`deleteStudentAccount`.** That argument turns on `removeFromWaitlist` only
moving an entry *out* of `waiting`, never into it. `deleteStudentAccount`
deletes the erased student's entries (`src/services/gdpr.ts:276`) and then
renumbers rows belonging to **other students** (`:359-361`), concurrently with
the three locked writers that are also writing `position` on the same class.

**4. fe9c009's consequence has two independent routes, not one.** The commit
records that "the same sweep can flip a cancelled class back to completed and
create Payment rows against it" and attributes it to `completeClass`. The second
route is `transitionClass` writing `in_progress` over `cancelled`, after which
the next auto-complete tick *legitimately* completes the class and creates the
`Payment` rows. Fixing `completeClass` alone leaves that route open — and it is
the more reachable of the two, because it needs no GDPR erasure, only an
ordinary teacher cancelling a class within the 60-second sweep window.

**5. `autoCancelClasses` is not safe, for a reason unrelated to status.** Its
CAS at `src/services/class-transitions.ts:113` predicates on `status = 'open'`,
which is correct. But `activeCount` (`:107`) comes from `cls.registrations`,
read by the `findMany` at `:86` — **outside** the transaction. A registration
committing between `:86` and `:113` cancels a class that has just reached its
minimum, and notifies every student that it is off. Live, user-facing, and a
different invariant from the one this issue was filed about.

**6. The issue's gap-3 ordering is correct, and the direction resolves itself.**
Confirmed by reading both bodies:

- `acceptInvitation`: `Invitation` (`src/services/invitations.ts:526`) →
  `TeacherStudent` (`:535`)
- `unlinkTeacher`: `Class`/`WaitlistEntry` (`:648`) → `TeacherStudent` (`:653`)
  → `StudentPrivacy` (`:673`) → `Invitation` (`:696`) → `TeacherBlock` (`:702`)

Two further sites take `TeacherStudent` before `Invitation`:
`deleteStudentAccount` (`src/services/gdpr.ts:275` → `:297`) and
`deleteTeacherAccount` (`:455` → `:475`). So three sites already agree and
`acceptInvitation` is the lone outlier — the canonical order is not a coin flip.

## Decisions taken

### The terminality invariant moves into Postgres

A `BEFORE UPDATE` trigger on `Class`, firing only when
`NEW.status IS DISTINCT FROM OLD.status`, rejecting any change whose `OLD.status`
is terminal.

**Terminality only — deliberately not a mirror of `VALID_TRANSITIONS`.** Two
reasons, one principled and one measured. Principled: mirroring the whole table
into SQL creates a second source of truth that drifts. Measured:
`src/services/class-template-lifecycle.test.ts:592-597` sets a freshly-created
class straight to `completed`, and `open → completed` is not in
`VALID_TRANSITIONS` — a full-table trigger would break that fixture. The narrow
claim is not only stabler in theory, it is the one that fits the code that
exists.

**Blast radius, measured:** of the 11 status writes, the 2 CAS writers only ever
move `draft`/`open` → `cancelled`, so `OLD.status` is never terminal and the
trigger never fires. All 4 test fixtures move from a non-terminal source too.
**Zero fixtures break.** `schema.prisma` types, every read path, every service
signature, both e2e specs and `prisma/seed.ts` are untouched.

**Precedent:** the repository has 9 hand-authored constraint migrations and 0
triggers. Constraints are established practice here; a trigger is a new kind of
object. `prisma/migrations/20260721061528_student_claim_link_check/` is the
model to follow for hand-authoring.

**The raise carries a deliberate SQLSTATE** so `withErrorHandler` can match it
structurally instead of pattern-matching a message string.

### Mechanism per site: CAS or `FOR UPDATE`

The rule, stated once so the split is not a judgement call at each site:

> **CAS** where the write depends on the status alone.
> **`FOR UPDATE`** where the transaction reads more state under the decision.

Both mechanisms already exist in this codebase and both are already correct
where used — the two safe status writers are CAS, the four waitlist writers are
`FOR UPDATE`. Each site adopts its nearest safe sibling rather than importing a
foreign pattern. This also keeps #104's `lock_timeout` list growing by 2 rather
than by 4.

| Site | Change | Why this mechanism |
|---|---|---|
| `class-lifecycle.ts:96` `transitionClass` | CAS on the legal source states; 409 not 500 | Status is its only decision input. Matches `transition/route.ts:35` and `class-transitions.ts:113`. |
| `class-lifecycle.ts:144` `completeClass` | `FOR UPDATE` before the read at `:149` | Reads `registrations`, runs the pricing engine, and writes `Payment` rows under the decision. |
| `gdpr.ts:434` cancel loop | CAS; skip on count 0 | Status is its only decision input. |
| `gdpr.ts:359` reorder loop | `FOR UPDATE` on each class | Multi-row renumber; matches the four locked callers. |
| `waitlist.ts:296` `removeFromWaitlist` | `FOR UPDATE` at the top of the transaction | Same renumber, same reason. Matches its four siblings. |
| `class-transitions.ts:107` `activeCount` | Move the read inside the transaction | Different invariant (count, not status). Live defect. |
| `invitations.ts:526` `acceptInvitation` | `TeacherStudent` before `Invitation` | Three sites already take that order. |

`transitionClass` deriving its legal source states: invert `VALID_TRANSITIONS`
rather than hand-declaring a list, so the CAS cannot drift from the state
machine. A `count === 0` result then needs one read to distinguish "no such
class" (404) from "illegal transition" (409) — that read is on the failure path
only and decides nothing that is written.

### The two new lock sites carry a `lock_timeout`; the existing four are left alone

`SET LOCAL lock_timeout = '2s'` already exists in this codebase, at the two
template-claim sites (`src/services/class-generator.ts:140` and `:210`, and the
studio twin at `src/services/studio-class-generator.ts:31` and `:97`). #104 is
open about the four sites that take a bare `FOR UPDATE` without it — the three
in `waitlist.ts` and `POST /api/registrations`.

The two sites this branch adds take the timeout. Not to pre-empt #104, but
because one of them is `deleteStudentAccount`'s reorder loop
(`src/services/gdpr.ts:359-361`), which runs **inside the erasure transaction**
— a transaction that by then holds locks on `StudentPrivacy`, `TeacherStudent`,
`WaitlistEntry`, `Invitation`, `Notification` and possibly `Account`. Adding an
untimed block there, on a row the 60-second transitions sweep can be holding,
makes a legally time-bound operation hang indefinitely. That is a worse failure
than the skewed queue being fixed, and it would be this branch's doing rather
than an inherited gap.

The existing four are **not** changed here — that is #104's work, and widening
into it would blur what this branch is accountable for. The result is 4 sites
with a timeout and 4 without, which #104 gets told about rather than discovering.

### The ordering constraint that is not negotiable

**`gdpr.ts:434`'s CAS ships in the same commit as the trigger, or earlier.**
`deleteTeacherAccount` calls `completeClass` at `src/services/gdpr.ts:411` with
no `try`, and writes at `:434` inside its transaction. With the trigger present
and the CAS absent, a lost race raises, the transaction aborts, and a **GDPR
erasure request fails outright** — a worse failure than the one being fixed.
`autoCompleteClasses` needs no such care: it already wraps each class in
`try`/`catch` (`src/services/class-transitions.ts:175-189`), logs, and continues.

### The lock order gets written down

Nothing can enforce it, so it is stated once and the sites point at it:

```
Class → WaitlistEntry → Registration → TeacherStudent → Invitation → TeacherBlock
```

`withdrawWaitingEntriesForTeacher`'s docblock
(`src/services/waitlist.ts:676-680`) already establishes the first half of this
as a correctness requirement rather than a style note, and that constraint is
preserved: it must still run before `unlinkTeacher`'s other writes.

## Design

### The migration

Hand-authored, following `prisma/migrations/20260721061528_student_claim_link_check/`.
A trigger function plus the trigger. Never edited once applied.

### Guards, and proving each one bites

**The trigger changes what the lock tests must assert, and this is the trap the
branch has to avoid.** With the trigger in place, deleting `completeClass`'s
`FOR UPDATE` no longer produces corruption — it produces a Postgres raise. A
test asserting only "the class is still `cancelled` and there are no `Payment`
rows" stays **green** with the lock removed, because the trigger alone satisfies
it. That is exactly the #167 shape: a guard that exists and cannot fail.

So every lock test asserts **how it refused, not merely that the bad state did
not happen** — a clean `{ ok: false }` carrying a validation error, never an
exception. The trigger and the lock then have separate, non-overlapping
falsification conditions.

Per guard: break it, record the exact error text, restore, re-verify. As an
explicit step in the plan, one per guard.

| Guard | Mutation that must turn it red |
|---|---|
| Terminality trigger | Drop the trigger inside a test transaction — the assertion must go green without it. Precedent: `src/services/class-lifecycle.test.ts:567-585` already drops a constraint to exercise degradation. |
| `completeClass` lock | Remove the `FOR UPDATE`. Must fail on the *shape* of the refusal (clean `{ok:false}` vs. raise), not on the absence of `Payment` rows. |
| `removeFromWaitlist` lock | Remove the `FOR UPDATE`; interleaved with `promoteNext`, positions must stop being `1..n` with no duplicates. |
| `gdpr.ts:434` CAS | Revert to the plain `update` — the trigger raises and erasure throws. Self-proving. |
| `transitionClass` CAS | Revert to the unconditional `update`. |
| `autoCancelClasses` count | Move the read back outside the transaction. |
| Accept/unlink ordering | Revert the order — the deadlock returns. |

**The deadlock is reproduced before it is fixed**, per #174's own acceptance
criterion 3. If it will not reproduce, that goes in the issue as a finding
rather than reordering on faith. `tests/integration/invitations-api.test.ts:2763`
already holds a `FOR UPDATE` open inside a test transaction and is the template
for the controlled block points the interleaving tests need.

### Comments that currently say something untrue

- `src/services/waitlist.ts:663-671` — says the `removeFromWaitlist` gap "is
  filed as #174". It was not filed when written; it is now. Rewritten once the
  gap is closed, and it must stop implying the convention is universal when it
  will be.
- `src/services/email-fallback.ts:69-80` — its guarantee (1) names `completeClass`
  as the exception that reads without `FOR UPDATE`. Once the lock lands that
  sentence becomes structurally true and the hedge in (2) can go.

## Acceptance

1. A `BEFORE UPDATE` trigger on `Class` rejects any status change out of
   `completed` or `cancelled`, with a matchable SQLSTATE. Proven by dropping it
   and watching the assertion pass without it.
2. All 5 unsafe status writes decide under the row they write: `transitionClass`
   and `gdpr.ts:434` by CAS, `completeClass` by `FOR UPDATE`. Each mutation-proven.
3. Both unlocked `position` writers (`removeFromWaitlist`, `deleteStudentAccount`)
   take the class lock. A test interleaving one with `promoteNext` asserts
   positions stay `1..n` with no duplicates, and fails when the lock is removed.
4. `autoCancelClasses` reads its registration count inside its transaction.
5. `acceptInvitation` takes `TeacherStudent` before `Invitation`. The deadlock is
   reproduced first, or its non-reproduction is recorded with the reason.
   `withdrawWaitingEntriesForTeacher` still runs before `unlinkTeacher`'s other
   writes.
6. `waitlist.ts:663-671` and `email-fallback.ts:69-80` say what is true after the
   change.
7. A GDPR teacher erasure racing a concurrent completion succeeds and skips the
   class, rather than aborting.

## What this does not do

- **The queue uniqueness constraint.** `reorderWaitingEntries` renumbers only
  `waiting` rows, so `removed`/`claimed` rows keep stale positions and a plain
  `UNIQUE (classId, position)` would be wrong. It needs to be partial *and*
  deferred to commit (the renumber passes through transient duplicates), and
  Postgres gives both only via an exclusion constraint, if at all. Filed as a
  spike, not promised here.
- **The `{Class, ClassTemplate}` order inversion.** `deleteTeacherAccount` takes
  `Class` (`gdpr.ts:434`) then `ClassTemplate` (`:452`); the generator
  (`class-generator.ts:216` → `:102`) and three template paths take them in the
  opposite order, and that counterparty is a sweep running continuously. Picking
  a canonical order touches the whole template family, so it is filed as a
  decision with options rather than as work.
- **`template-sync.ts:52` → `:68`.** Decides from a stale `settingsLocked`/
  `status` read and then *deletes*, cascading away registrations and waitlist
  entries (`prisma/schema.prisma:517`). Live data loss, different invariant,
  filed.
- **`class-template-lifecycle.ts:446`** takes only `FOR NO KEY UPDATE` where the
  studio family closed the identical gap in #94. Checked against #103/#116/#117
  first — extended into one of those in preference to opening a fourth issue in
  that family.
- **The `{TeacherBlock, Invitation}` pair.** Its mitigation turns on whether
  Prisma emits a row lock for `upsert({ update: {} })`. One `DEBUG=prisma:query`
  run answers it; resolved in the plan, then folded if it is a reorder and filed
  if it is more.
- **`autoCancelClasses` leaving entries `waiting` on a cancelled class.** Inert
  today — `promoteNext` requires `status === 'open'` (`waitlist.ts:341`) — so the
  impact is a stale queue display, not a wrong promotion. A comment beside the
  code rather than a tracker entry.
- **#104's `lock_timeout` on the existing four sites.** This branch adds two
  `FOR UPDATE` sites and gives *those two* a timeout (see the decision above),
  but leaves the four `waitlist.ts`/`registrations` sites #104 enumerates
  untouched. An Update comment on #104 recording the new count — 4 with, 4
  without — not a new issue.

## Ratio

One issue in, three or four out, on a round the roadmap explicitly said should
*drain, not open*. The reason, stated rather than left to pass as normal: this is
the first time anyone has swept the whole class-lock family rather than one site
in it, and the family is larger than any single issue had mapped. #174 itself
needs amending — it names three gaps where there are seven sites, and its causal
story for the headline defect is incomplete.
