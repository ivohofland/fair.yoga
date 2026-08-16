# Waitlist retention — reaping closed, unfulfilled `WaitlistEntry` rows

**Issue:** #238 · **Date:** 2026-08-16

Nothing ever removes a `WaitlistEntry` that never became a booking. This spec
adds a daily retention sweep that deletes entries which are unfulfilled, on a
class that can never change again, and older than a year.

---

## 1. The issue's premise, verified

Every clause below was measured against the tree at `1c8c76d`, not read off the
issue. Where the issue is wrong, the correction is stated rather than quietly
applied.

### 1.1 What holds

**Nothing reaps a `WaitlistEntry`, and the census is sharper than the issue's
prose.** The complete set of production removers:

    grep -rnE 'waitlistEntry\.(delete|deleteMany)' src prisma --include='*.ts' | grep -v '\.test\.ts'

At the base commit `1c8c76d` this returned three lines — `gdpr.ts:395` (a
comment), `gdpr.ts:471` (`deleteStudentAccount`, `deleteMany({ studentId })`)
and `prisma/seed.ts:52` (not production) — so exactly one production remover.
Run at HEAD it returns four, the fourth being this branch's own
`waitlist-retention.ts` sweep. §1.2 received an explicit correction for this
same class of staleness and §1.1 did not; it does now. **Line numbers and
counts throughout §1 are as of `1c8c76d`** — see the note at the top of this
section.

plus `onDelete: Cascade` from `Class` (`schema.prisma:575`). That cascade has
exactly two triggers, and **both are scoped to future classes**:
`template-sync.ts:183` (wrong-day instances) and
`class-template-lifecycle.ts:1309` (the archive path's `date > today`). Neither
can reach a `completed` or `cancelled` class.

So the precise statement — stronger than "nothing ever removes one" — is: **an
entry on a terminal class is removed by nothing except the subject's own
erasure.**

- **`onDelete: Cascade` from `Student` never fires.** `deleteStudentAccount`
  anonymises; the `Student` row survives. `gdpr.ts`'s header states the strategy
  and the reason (Art. 17(3)(b)).
- **The erasure's lock set is every class the student holds an entry in, of any
  status.** `gdpr.ts:371-374`, whose `lockClassRowsOrdered` call carries no
  status predicate, deliberately — the comment above it explains that the lock
  set must cover the unscoped write set.
- **The Article 15 export publishes every entry verbatim** — `gdpr.ts:132-137`
  maps classType, date, status and position for all of them.
- **`registrationId: null` is a precise discriminator.** All three fulfilment
  sites write `registrationId` in the *same statement* as the status:
  `waitlist.ts:527` (`promoteNext`), `waitlist.ts:634` (`claimSpot`),
  `app/api/registrations/route.ts:195` (the walk-in resolver). It is not pinned
  anywhere, which §2.1 addresses.
- **`WaitlistEntry` carries only `@@index([classId, position])`**, plus
  `@@unique([classId, studentId])` and the unique on `registrationId`
  (`schema.prisma:564-581`).
- **`scheduler.ts` has a 24-hour slot** — `auth-cleanup`, `scheduler.ts:222-226`.
- **"#238 is the root fix for the erasure's lock set growing with account age"**
  is an inherited claim, and checking it is what this section is for: it holds
  only in the weaker form. **#238 SHRINKS the axis; it does not bound it.** The
  erasure's pre-lock joins `WaitlistEntry` with no status predicate, while this
  sweep reaps only UNFULFILLED entries — nothing reaps a fulfilled one, ever —
  so a student who queues and is promoted week after week still accumulates
  `Class` rows in that lock set for the life of the account. `gdpr.ts` states
  the corrected version at its own budget rationale. #240's spec
  (`2026-08-16-erasure-budget-design.md:202` and `:301`) asserts the unbounded
  reading; it is a dated spec and is left as written (see §4), but a reader
  arriving from there should take this paragraph as the correction.

### 1.2 The safety argument is understated, and the real one is DB-enforced

The issue argues terminal-status safety from `VALID_TRANSITIONS`
(`class-lifecycle.ts:34-40`), a TypeScript table. The actual guarantee is a
Postgres trigger. `prisma/migrations/20260805120000_class_terminal_status_trigger/`
installs `class_terminal_status_guard`, a `BEFORE UPDATE OF status` trigger that
raises `23514` whenever `OLD.status IN ('completed','cancelled')`. A terminal
class's status cannot change from *any* client, including raw SQL.

The second half of the argument is the writer census — the CLASSIFICATION below,
not a headcount. Every `WaitlistEntry` write site, sorted by whether it can touch
a row on an already-terminal class:

    grep -rnE 'waitlistEntry\.(create|createMany|update|updateMany|upsert|delete|deleteMany)' \
      src --include='*.ts' --include='*.tsx' | grep -v '\.test\.ts'

| Site | Reaches a terminal class? |
|---|---|
| `waitlist.ts:291`, `:302` (`addToWaitlist` revive/create) | No — guards `cls.status !== 'open'` |
| `waitlist.ts:484`, `:527` (`promoteNext`) | No — guards `open` |
| `waitlist.ts:634` (`claimSpot`) | No — guards `open` |
| `registrations/route.ts:195` (walk-in resolver) | No — `allowedStatuses` is `open`/`in_progress` |
| `waitlist.ts:1043` (`closeQueueOnStart`) | No — runs inside the `open → in_progress` CAS |
| `transition/route.ts:76`, `class-transitions.ts:446`, `deleteTeacherAccount`'s per-class cancel CAS (`gdpr.ts`, `:1077` at the base commit, `:1089` at HEAD) (three cancel paths) | No — each runs inside the CAS that *makes* the class terminal |
| `waitlist.ts:390` (`removeFromWaitlist`) | Only a `waiting` row |
| `waitlist.ts:968` (`withdrawWaitingEntriesForTeacher`) | Only a `waiting` row |
| `waitlist.ts:995` (`reorderWaitingEntries`) | Only a `waiting` row |
| `gdpr.ts:471` (`deleteStudentAccount`) | **Yes — unscoped by class status** |

Three buckets, and that is the whole argument: sites guarded by class status
cannot reach a terminal class at all; sites scoped to `status: 'waiting'` can,
but only for a row that — since `closeQueueOnStart` (#216) — exists on a terminal
class solely as **pre-#216 legacy**, which is the population reaping removes; and
the erasure, a DELETE, which §2.3 is about.

**Deliberately no arithmetic.** An earlier revision of this section carried a
four-number partition ("Ten of fourteen … The fourteenth"), which summed wrong
against its own table on first writing and then went stale again the moment this
spec's own sweep became the fifteenth site. The grep recipe is self-updating and
the bucket names explain why each bucket is safe; a count does neither. Re-run
the grep and classify what it returns.

So: **the reap set is provably writer-free, and its sole exception is exactly
the legacy population reaping removes.** That is the argument, and it is
stronger than the one the issue makes.

### 1.3 What the issue gets wrong

**(a) `reconcileWaitlists`' join is already belt-and-braces. #216 did that, one
round before this issue was filed.**

The issue writes that the sweep's `class: { status: 'open' }` join "exists as a
cost bound" and that its comment "explains at length that without it the
candidate list *would grow monotonically for the life of the deployment*",
then lists "the join drops from load-bearing to belt-and-braces" under *what it
buys back*. The comment is explicitly past-tense
(`waitlist-reconciliation.ts:163-165`):

> `class: { status: 'open' }` … **USED TO be** what BOUNDS this set. Since #216
> it is a cost bound rather than a correctness guard: removing it fails no test
> by design (#222).

`closeQueueOnStart` closes every queue at class start, so the `status: 'waiting'`
filter alone already bounds the candidate set. What reaping actually buys here
is narrower and real: it removes the residual **pre-#216 legacy `waiting` rows
on terminal classes**, which are the only rows that can still make the join do
work. That is a fixed, one-off set — not monotonic growth. The spec claims that
and no more.

**(b) The "weakened deadlock test" bullet is unsubstantiated, and its sibling
issue is closed.** The issue's fourth motivation reads "A deadlock test had to
be weakened — see the sibling issue on extracting an ordered multi-row lock
helper." That sibling is #237, **closed 2026-08-16T14:12Z by PR #239**. A search
of `gdpr.test.ts`, `db-locks.test.ts`, `db-locks-lock-order.test.ts`,
`template-lock-order.test.ts` and `docs/backlog-roadmap.md` for a weakened
deadlock test found none; both deadlock tests in `gdpr.test.ts` (`:785`,
`:1626`) assert their own premises outright, and `gdpr.ts:446-450` states the
two-erasure one still fails with `40P01` if the ordering clause is removed. This
motivation does not carry into the design.

**(c) The reap predicate uses the wrong age axis, and the defect is not
cosmetic.** The issue specifies:

    createdAt < now() - <retention>

`WaitlistEntry.createdAt` is when the student *joined the queue* — before the
class, sometimes long before. An entry created 2026-01-01 for a class scheduled
2027-01-01 is already 367 days old the day after that class completes, so under
this predicate it is reaped **the day after the class ran**. That is the
opposite of a retention policy. §2.2 uses `Class.date` instead.

**(d) "This carries a migration" is probably false, and the project's own rule
says measure before adding.** See §2.5.

### 1.4 Is anything currently broken?

No, and the spec says so plainly rather than borrowing urgency. There is no
production deployment (`DEPLOYMENT.md` documents placeholder domains only), so
there is no accumulated backlog and no pre-#216 legacy rows outside dev and test
databases. This ships the policy before there is data to regret, which is the
cheapest moment to ship it. The roadmap's "Growth costs, nothing broken yet"
family (#223, #224, #205) is where this belongs by cost; what distinguishes it
is the storage-limitation argument under GDPR Art. 5(1)(e), which is a reason to
act at design time rather than at scale time.

---

## 2. The design

**Line-number citations below are as of `1c8c76d`, the same base §1 pins itself
to.** This branch edits several of the files cited here, so a citation that was
exact when written can be off by the size of an intervening insertion. Where a
symbol name resolves the reference unambiguously it is used instead of a line
number, which is the form that does not rot.

### 2.1 The predicate

Four clauses, each load-bearing:

```
c.status ∈ TERMINAL_CLASS_STATUSES        -- derived, not hand-written (§2.2)
AND c.date < <cutoff>                     -- UTC midnight of today − 365 days (§2.4)
AND w."registrationId" IS NULL            -- no link to a financial record
AND w.status ∉ FULFILLED_WAITLIST_STATUSES -- belt-and-braces (below)
```

**`registrationId IS NULL` is the primary discriminator, chosen over a status
test on purpose.** An entry that became a registration is joined to a
`Registration` and through it to a `Payment`; a status is a label, a foreign key
is a link to bookkeeping. The FK is the thing that actually matters.

**The fourth clause is deliberately redundant today.** No current writer can
produce a `promoted` or `claimed` row with a null `registrationId` — all three
fulfilment sites write both in one statement (§1.1). It is included because
deleting is irreversible and the two discriminators are derived independently,
so their *intersection* is the conservative one: if they ever disagree, the row
survives.

This project's rule is that a guard which cannot fail certifies nothing, so the
clause gets a test that **can** fail: a fixture writes the impossible row
directly (`status: 'promoted'`, `registrationId: null`) and asserts it survives
a sweep. Remove the clause and that test goes red. The state is unreachable from
production code and reachable from a fixture, which is exactly enough.

`FULFILLED_WAITLIST_STATUSES` derives from the existing `QUEUE_ROLE` table in
`lib/waitlist-status.ts` — the statuses whose role is `'fulfilled'` — so it
cannot drift from the role table, in the same way `CLAIMABLE_WAITLIST_STATUSES`
already does not. Adding a sixth `WaitlistStatus` remains a compile error at the
one place the decision belongs.

### 2.2 The terminal set is pinned to the trigger that enforces it

`TERMINAL_CLASS_STATUSES` is exported from `class-lifecycle.ts`, derived from
`VALID_TRANSITIONS`:

```ts
export const TERMINAL_CLASS_STATUSES: readonly ClassStatus[] = Object.freeze(
  (Object.keys(VALID_TRANSITIONS) as ClassStatus[]).filter(
    (status) => VALID_TRANSITIONS[status].length === 0,
  ),
);
```

Annotated and frozen rather than `as const satisfies`, for the reason
`waitlist-status.ts` and `registration-status.ts` both give at length: `as const`
narrows `includes`' parameter and forces call sites to widen it back with a cast
that accepts any string.

**Derivation alone would be a hazard, so it is pinned.** The reaper's safety
rests on the *trigger*, which hard-codes `('completed','cancelled')` and cannot
be edited (an applied migration). If someone adds a terminal status to
`VALID_TRANSITIONS`, the derived set silently widens while the trigger does not,
and the reaper would delete rows on a class whose immutability nothing enforces.

`class-terminal-status.test.ts` therefore gains a case that **iterates the
derived set** and asserts each member is DB-enforced terminal — an update out of
it raises `23514`. That file already owns this invariant and already documents
the manual mutation recipe for the trigger. The two definitions now fail
together instead of drifting apart.

### 2.3 One class per transaction — the finding the issue does not carry

`deleteStudentAccount` deletes waitlist entries with an **unscoped**
`deleteMany({ where: { studentId } })` (`gdpr.ts:471`) — every status, every
class status, terminal ones included. So the erasure and the reaper have
overlapping `WaitlistEntry` write sets, and both would be multi-row deletes.

Two multi-row deletes taking row locks in different plan orders is an AB-BA
cycle: the reaper locks (X, C1) then (X, C2) while the erasure locks (X, C2)
then (X, C1). Postgres kills one side with `40P01` and picks the victim itself
— and **the victim can be the erasure**, a student's Art. 17 request failing
because a background sweep raced it. The issue does not mention this.

**The fix is structural rather than ordered — but NOT on the multiplicity
axis.** `docs/lock-order.md` does classify lock sites by multiplicity (a
transaction that can hold two `Class` row locks carries an ordering obligation,
one that holds a single row lock carries none) and then withdraws that in the
very next sentence: since #196 a single-row write can be half of a slot-key
deadlock while holding exactly one `Class` row lock, `updateClass` being the
case. So "the reaper holds one row lock" is not on its own a safety argument,
and this spec does not rest on it. The shape is still worth copying —
`autoCancelClasses` is the precedent, "it opens a separate `db.$transaction`
per class, so it holds one row lock at a time" — for the cost reason in the
docblock quoted below, not for a multiplicity exemption.

So the reaper takes that shape: **one class per transaction** — `db.$transaction`
at `class-transitions.ts:263`, `lockClassRow` at `:360`, argued for in that
function's docblock at `:188-201`, which contrasts it with
`deleteStudentAccount` precisely on the axis that matters here ("a slow lock
wait on one class costs only that class's own transaction, not the ones before
or after it in this loop"):

1. Read candidate class ids, unlocked, ordered by id, capped (§2.6).
2. Per class, in its own transaction: `lockClassRow(tx, classId)` — which arms
   the shared 2 s `lock_timeout` — then `deleteMany` scoped to that `classId`
   plus the full §2.1 predicate.
3. A class whose transaction throws is logged by id and skipped; the rest of the
   sweep continues.

Why this closes the cycle rather than ordering around it — and the mechanism is
the `Class` row lock, not the batch size. Every `WaitlistEntry` row the reaper
touches sits under that row's own `Class` lock, and the erasure takes every
`Class` lock it needs *before* its first write. So neither transaction can reach
a `WaitlistEntry` row without first holding the `Class` row above it, the two
can never contend on the same entry row at all, and that is true **however many
classes the reaper batches**. Whichever reaches a shared class first, the other
blocks on the `Class` row while holding nothing the first one wants. One class
per transaction buys the "five sites" count in `lock-order.md` staying true and
a bound on lock-holding against live traffic — not the absence of the cycle.

Three consequences worth stating because they are what makes this the cheap
option:

- The reaper uses `lockClassRow`, not `lockClassRowsOrdered`, so
  `docs/lock-order.md:59`'s "**five** sites lock more than one `Class` row"
  stays true and needs no renumbering, and `gdpr.ts:418`'s "All five such sites"
  likewise.
- The `FOR UPDATE OF` grep that `docs/lock-order.md:64-74` names as "the whole
  of the enforcement" still returns exactly one line.
- The candidate read being stale is harmless: a terminal class's status cannot
  change (§1.2), and the `deleteMany` re-applies the whole predicate anyway.

The candidate read uses `groupBy({ by: ['classId'] })` rather than
`findMany({ distinct })`, for the reason `waitlist-reconciliation.ts`'s own
candidate read already records: Prisma does not compile `distinct` into SQL, so it would fetch
one row per matching *entry* to produce one id per *class*.

### 2.4 The retention period, and the axis

**365 days**, on `Class.date`.

`Class.date` is `DateTime @db.Date` (`schema.prisma:391`) — day-granular, which
is the right resolution for a retention policy. It means "the class this queue
was for ran N days ago", which is when the record's purpose ended.

**`date` is NOT protected the way `status` is, and an earlier version of this
section said it was "immutable in practice".** That is false, and it is the one
half of this design's predicate that nothing enforces:

- `class_terminal_status_guard` guards **`status` only** — its own SQL says
  "updates to other columns of a completed class … are unaffected".
- `updateClass` (`class-lifecycle.ts`) carries no class-status guard at all.
  Its only lock is `settingsLocked`, which covers the ECONOMIC fields, and
  `date` is not one of them — `date` is explicitly teacher-editable.
- `PUT /api/classes/[id]` checks no status either (`grep -n "status"` over that
  route returns nothing).
- The only thing stopping the edit is a page-level redirect in
  `src/app/(teacher)/class/[id]/edit/page.tsx`, which is UI, not an API guard.

So a teacher can set any date on their own `completed` class through the API,
and the next daily sweep then permanently deletes that class's queue. Before
this feature a wrong date on a finished class was inert; it is not any more.
**This is a known residual, tracked as #247** — deciding which fields
freeze at which lifecycle stage is a product call this spec does not make — and
it is the one way a row this sweep should keep can be made to look reapable.

It is conservative in the safe direction: a class **cancelled** well before its
scheduled date retains its entries until that *scheduled* date plus the window,
so the clock over-retains rather than under-retains. Accepted, and recorded as a
property rather than argued away — it needs no new column and errs toward
keeping data.

`WaitlistEntry.updatedAt` was considered and rejected: for a cancellation it is
the most precise anchor available, but it is not monotonic. Any later write
resets it, and `reorderWaitingEntries` churns it on `waiting` rows, so retention
would become a function of unrelated activity.

**The boundary is crisp and timezone-independent.** The cutoff is the **UTC
midnight** of `today − 365 days`, and the comparison is `date < cutoff`. So a
class dated exactly 365 days ago has `date == cutoff` and is **retained**; one
dated 366 days ago is reaped. Both sides get a test. Computing the cutoff at UTC
midnight rather than "now minus 365 days" avoids the `@db.Date` timezone window
`prisma/seed.ts` carries a standing warning about, where a check run at the
wrong UTC hour passes for the wrong reason.

`WAITLIST_RETENTION_DAYS = 365` lives in the retention service, exported, with
the policy rationale in its docblock — in code where it is reviewable, not in an
environment variable where it is invisible. It can be tightened later by one
line; data deleted early cannot be recovered, which is the asymmetry that
decided the number.

### 2.5 No index, and that is a measurement

The issue asserts the reaper "carries a **migration**". This spec ships none,
for three reasons and one measurement:

1. The sweep runs **daily**, not on a 60-second tick. A sequential scan once a
   day is the weakest case for an index there is — which is the opposite of
   #224's shape, where the same tables are scanned every sixty seconds.
2. The roadmap's standing rule for this whole family (#223, #224, #205) is that
   an index is **measured before anything is added**, and #222 is the argument
   for it: it justified an index at length and dropped it three commits later
   when the query it served went away.
3. #224 already owns the question of indexing `WaitlistEntry.status` and
   `Class.status`. Adding an index here would pre-empt its measurement with a
   guess.

The plan runs one `EXPLAIN ANALYZE` of the candidate `groupBy` against a seeded
volume and records the plan and timing in the PR body, so "no index" is a
measured claim rather than an assumption. If the measurement contradicts the
expectation, the finding goes to #224 rather than growing this branch.

### 2.6 Placement, and the rename

New service `src/services/waitlist-retention.ts`:

```ts
export async function reapClosedWaitlistEntries(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<{ deleted: number; classes: number; failed: number; cappedOut: boolean }>
```

Registered as a **second sweep in the existing daily job**, through
`isolatedSweeps` — which already gives per-sweep isolation, logs the failing
sweep by name, and rethrows the first error so `/api/health` still sees the
failure.

That makes the job's name wrong, so it is renamed:

| | before | after |
|---|---|---|
| scheduler job | `auth-cleanup` | `daily-cleanup` |
| cron route | `/api/cron/auth-cleanup` | `/api/cron/daily-cleanup` |

One route per **job**, not per sweep — the existing precedent, since
`/api/cron/transition-classes` already runs three sweeps in one route. The route
returns both sweeps' results. `scheduler.test.ts:118` (the name/interval table)
and `:155` (the job → sweep-names map) follow; `DEPLOYMENT.md:73` follows. Free
to do now, and #223 will want the same slot later, at which point
`auth-cleanup` would have been badly wrong.

**The cap.** `MAX_CLASSES_PER_RUN = 500`. At steady state the daily volume is
"classes that turned 366 days old today" — a handful — so the cap is unreachable
in normal operation and exists to stop a first run against accumulated history
from wedging the daily job, whose `running` guard would drop every subsequent
tick. When it is hit, the sweep **logs that it was hit** and returns
`cappedOut: true`; a silently truncated count reads as "covered everything" when
it did not. The backlog self-heals at 500 classes/day.

---

## 3. Tests, and the mutation that proves each one

Every guard gets a mutation that makes it fail, with the exact error text
recorded in the plan. A guard that compiles but cannot fail certifies nothing.

**Retention service** (`src/services/waitlist-retention.test.ts`, unit project —
a DB-invariant suite with no HTTP surface, so it belongs beside `gdpr.test.ts`
rather than in `tests/integration/`):

| # | Assertion | Mutation that must break it |
|---|---|---|
| T1 | An entry with a `registrationId`, on a terminal class past the window, survives | drop `registrationId: null` — **but only in the mixed-population fixture review added later**. On the single-entry fixture this row described, the entry is double-protected (`claimed` status *and* a non-null `registrationId`), so either clause alone keeps it and the mutation survives. |
| T2 | A `promoted` entry with a **null** `registrationId` survives (the fixture-only state) | drop the `status ∉ FULFILLED` clause |
| T3 | An entry on an `open` class survives, however old | drop the status clause |
| T4 | An entry on an `in_progress` class survives | as T3 |
| T5 | An entry on a `draft` class survives | as T3 |
| T6 | `expired`, `removed` and legacy `waiting` entries on a terminal class past the window are all deleted | narrow the delete to one status |
| T7 | `date` exactly 365 days before today's UTC midnight survives | change `lt` to `lte` |
| T8 | `date` 366 days before is deleted | change `lt` to `lt` on a shifted cutoff — **not** "change the constant", which cannot break this: `daysBeforeCutoff` is computed from `retentionCutoff(NOW)`, so the fixture moves with `WAITLIST_RETENTION_DAYS`. The constant is pinned by its own named test and by the hard-coded `'2025-08-16T00:00:00.000Z'` in the UTC-normalisation test, not here. |
| T9 | A class whose transaction throws is skipped and the sweep continues, returning `failed: 1` | remove the per-class `catch` |
| T10 | Hitting `MAX_CLASSES_PER_RUN` returns `cappedOut: true` and logs | remove the cap's log line |

**Terminal-set pin** (`src/services/class-terminal-status.test.ts`, extended):

| # | Assertion | Mutation |
|---|---|---|
| T11 | Every member of the derived `TERMINAL_CLASS_STATUSES` is DB-enforced terminal — an update out of it raises `23514` | add a non-terminal status to `VALID_TRANSITIONS` with `[]` successors; the case must go red |

**Scheduler wiring** (`src/lib/scheduler.test.ts`, extended):

| # | Assertion | Mutation |
|---|---|---|
| T12 | The job table names `daily-cleanup` at 24 h | rename it back |
| T13 | `daily-cleanup` routes to `['cleanupExpiredAuth', 'reapClosedWaitlistEntries']`, in that order | drop the second sweep |

T13 is the one that matters most and is the easiest to get wrong: the existing
map already caught "a job could carry the right name and interval while running
the wrong sweep", and a sweep added *beside* a covered one inherits none of its
coverage. That is this project's most recently learned lesson (PR #235's round-2
finding) and it applies verbatim here.

**T13 pins the sweep order, and that order is not load-bearing.** The existing
map asserts order within a job because `isolatedSweeps` order is meaningful for
`class-transitions` — a class must transition to in-progress before it can be
completed. Nothing couples auth cleanup to waitlist retention. The order is
pinned because the assertion is a whole-map equality, not because a dependency
exists, and the test must say so; otherwise a later reader infers one.

**Lock discipline.** No new deadlock reproduction, and the reason is the
mechanism in §2.3, not multiplicity: the reaper takes exactly one `Class` row
lock and then only deletes CHILD rows, so it acquires no second `Class` edge to
order against anything. There is no order to reproduce. Recorded in
`docs/lock-order.md` rather than tested, and stated explicitly here so a
reviewer knows the omission is a decision, not a gap.

---

## 4. Artifacts that carry a claim this falsifies

A claim fixed in one place while its twin stands is this project's recurring
failure, so the list is enumerated and each entry gets its own verdict:

| Artifact | Claim | Action |
|---|---|---|
| `src/services/gdpr.ts`, `deleteStudentAccount`'s budget rationale | "it is a handful that only grows, because **nothing reaps** a closed, unfulfilled `WaitlistEntry`. #238 is the root fix for that" | Rewrite. The axis is **shrunk, not bounded**: this sweep reaps only unfulfilled entries, so a repeatedly-promoted student still grows the set. The ceiling's rationale survives; its premise is weakened rather than removed. |
| `src/services/waitlist-reconciliation.ts:180-190` | every closure "writes a terminal status … or deletes the row outright (`deleteStudentAccount` … is a hard delete)" — with a grep recipe to re-derive the roster | Add the reaper as the second hard deleter. The grep recipe stays; it will now return two. |
| `docs/lock-order.md`, "Known conformance" | lists every site that takes a `Class` row lock | Add the reaper as a single-row-lock site, alongside `autoCancelClasses`. |
| `docs/data-model.md`, `### WaitlistEntry (overflow)` | no retention statement | Add one. It is a live reference doc listed in `CLAUDE.md`. |
| `CLAUDE.md`, **Waitlist (Hybrid Promotion)** | no retention statement | Add one line. |
| `DEPLOYMENT.md:73` | lists `/api/cron/auth-cleanup` | Rename to `/api/cron/daily-cleanup`. |
| `docs/superpowers/specs/2026-08-16-erasure-budget-design.md:202,301` | "#238 remains the root fix" | **Left as written.** A dated spec is a historical record of what was true at its date, not a live reference doc. Recorded here so a later reader knows the omission was decided rather than missed. |
| `docs/superpowers/specs/2026-08-11-retry-safe-endpoints-design.md:120,182` | tabulates `/api/cron/auth-cleanup` | **Left as written**, same reason. |

---

## 5. Out of scope

- **`exportStudentData` is not changed.** The export shrinks by itself as rows
  are reaped. The separate defect that `waitlist-status.ts` documents — the
  export publishing `removed` for a student whose class was *cancelled* under
  them, a false statement of fact about a data subject — is a real problem and
  is **not** this branch's. It is a display/semantics question about live rows,
  where reaping only bounds how long the false statement persists.
- **No index and no migration** (§2.5). #224 keeps the indexing question.
- **No notification** to students or teachers about reaped entries. Retention
  expiry is not an event anyone needs told, and `CLAUDE.md` rules out
  notification patterns that exist to create engagement.
- **No dry-run and no backfill report.** There is no production deployment
  (§1.4), so there is no accumulated backlog for a first run to surprise anyone
  with.
- **#223, #224, #205 are unaffected.** So are #226 and #219.
- No change to `reconcileWaitlists`, whose join stays exactly as it is (§1.3a).

---

## 6. Risks

1. **The derived terminal set is the branch's one new coupling.** It is pinned
   to the trigger by T11, and T11 is the test whose absence would matter most.
   If T11 cannot be made to fail under its stated mutation, the derivation
   should be replaced by a hand-written pair with a comment naming the
   migration — a worse design that is honestly enforceable beats a better one
   that is not.
2. **T2 tests a state production cannot reach.** That is deliberate (§2.1), and
   it is the kind of guard this project has shipped un-failable before. The plan
   must record the mutation's exact error text, not merely assert the test
   exists.
3. **The rename touches an operator-visible name.** `/api/health`'s job key
   changes from `auth-cleanup` to `daily-cleanup`, and any external cron
   configured against the old route path 404s. Free today, because there is no
   deployment; recorded because it will not be free later.
4. **`Class.date` over-retains for classes cancelled well before their
   scheduled date** (§2.4). Accepted, in the safe direction.
5. **The cap can hide work.** Mitigated by logging and by `cappedOut` in the
   return value, but a caller that ignores both learns nothing. `isolatedSweeps`
   discards sweep return values, so the log line is the only channel — which is
   why T10 pins it rather than pinning the flag alone.
