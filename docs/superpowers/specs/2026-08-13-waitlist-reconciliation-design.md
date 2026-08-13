# A dropped waitlist notification is never reconciled

**Issue:** 220 · **Date:** 2026-08-13 · **Status:** design agreed

When `handleSpotFreed` fails, every student queued on that class is silently not told
a seat opened. Nothing retries and nothing reconciles, so the loss is permanent. This
spec adds the sweep that makes it recoverable — and covers a second, pre-existing
half of the same loss that the issue does not describe.

---

## 1. The issue's premise, checked

**Every checkable claim in the issue held.** That is worth stating plainly, because it
has not been true of any issue worked so far.

| Claim | Verdict |
|---|---|
| `Notification.relatedClassId` makes the insert take `FOR KEY SHARE` on `Class` | **True, and already measured.** `schema.prisma:600` has the FK; `docs/lock-order.md:139-148` records an uncommitted `notification.create` making a third connection's `SELECT … FOR UPDATE NOWAIT` fail with `55P03` |
| Post-#212 the broadcast runs under a 2s bound | **True.** `waitlist.ts:703-704` → `db-locks.ts:76` |
| Both callers log and swallow | **True**, and there are exactly two: `promoteAfterCancel` (`api/registrations/[id]/route.ts:228`) and the erasure loop (`gdpr.ts:654`) |
| `deleteStudentAccount` holds class rows for up to 20s | **True.** `gdpr.ts:403` locks in a loop inside one transaction; `gdpr.ts:641` sizes the budget `Math.min(5_000 + waitingCount * 2_000, 20_000)` |
| `completeClass` cannot collide | **True.** `DEADLINE_HOURS` bottoms out at 6 (`waitlist.ts:103`) and the claim window is `[start − deadline − 1h, start − deadline)`, so the broadcast branch runs at least 6 h before start |
| The existing test asserts only the abort | **True.** `waitlist.test.ts:1640-1688` holds the row 3.5s against the 2s bound and asserts `55P03` plus "wrote nothing" |
| The 2026-07-18 audit line exists | **True**, verbatim, at `docs/audits/2026-07-18-review-round-2.md:75` |

### 1.1 The repricing claim, with the arithmetic

Re-derived from `calculateClassPricing` (`services/pricing.ts:89`) against the test
fixture's own config — `roomCost 35, minRate 15, targetRate 25, minStudents 1,
maxStudents 10`, all students tier 3 (ratio 1.00):

| Students | Effective teacher rate | Total cost | Per student |
|---|---|---|---|
| 8 | `15 + 10 × 7/9` = **22.78** | 57.78 | **€7.22** |
| 7 | `15 + 10 × 6/9` = **21.67** | 56.67 | **€8.10** |

Every remaining student pays **€0.87 more (+12.1%)** and the teacher earns **€1.11
less**. Both halves of the issue's claim confirmed.

**One boundary the issue states more strongly than it holds.** The direction is not a
theorem about the formula — it holds while the marginal teacher rate per student
(`(25 − 15) / (10 − 1)` = €1.11 here) sits below the current per-student average
(€7.22). Any realistic config clears that by a wide margin, so the claim is safe; it
is a property of the numbers, not of the algebra, and a steep-slope config inverts it.

### 1.2 What the issue misses: the `auto_promote` half

`handleSpotFreed` has two branches. The issue analyses the
`first_come_first_claimed` broadcast and says nothing about `auto_promote` — which
covers every moment of the waitlist's life *except* the final hour before the cancel
deadline.

`promoteNext` (`waitlist.ts:379`) runs in a bare `db.$transaction(...)` with no
options, so it carries Prisma's **default 5s** interactive-transaction timeout, while
its first statement is an unbounded inline `FOR UPDATE` (`waitlist.ts:385`). Measured
against a 7s hold on the class row, same fixture shape as the broadcast case:

```
window                  = auto_promote
elapsedMs               = 7014        <- waited out the FULL hold, then failed
error                   = P2028 Transaction already closed:
                          timeout was 5000 ms, however 7001 ms passed
isTransientDbError      = true
waitlistEntry.status    = waiting
registration            = NONE
notifications           = 0
```

Identical outcome to the broadcast case: the student is silently not promoted,
reachable by the same `deleteStudentAccount` hold (up to 20s, comfortably past 5s).

**This half is pre-existing, not a #212 regression.**
`git diff 638c25c HEAD -- src/services/waitlist.ts` shows `promoteNext` byte-identical
across that branch; the only `$transaction` #212 added is `handleSpotFreed`'s own. It
is in scope anyway, because it is a live loss a user hits and the
"did this change make it worse" test does not apply to those.

The elapsed time carries a second finding: the hook waited out the **entire** hold and
failed afterwards. That independently confirms the note at `gdpr.ts:602` — Prisma's
transaction timeout cannot cancel a statement already blocked inside Postgres, only
refuse the next one.

### 1.3 Two corrections to the issue's option costing

1. **`P2028` is already classified transient** (`api-errors.ts:124`,
   `TRANSIENT_PRISMA_CODES` = `P2024`, `P2028`, `P2034`). The issue reasons only about
   `55P03` in `TRANSIENT_SQLSTATES`. Both call sites already branch on
   `isTransientDbError`, so both failure modes already reach the same split.
2. **A sweep is not new infrastructure.** `src/lib/scheduler.ts` already runs five jobs
   (1 / 5 / 60 / 60 / 1440 min) through `isolatedSweeps`, with per-job health surfaced
   by `/api/health`, an overlap guard (`scheduler.ts:138`) and a 15s post-boot first
   run (`scheduler.ts:156`). This is a sixth array entry plus one service function.

---

## 2. Why a retry is not the fix

The issue's option A (retry once on a transient error) is cheap and looks sufficient.
The measurement above shows it is weakest exactly where the issue's own documented
path lives:

| Branch | Fails at | Holder state when it fails | A retry would |
|---|---|---|---|
| broadcast (`55P03`) | 2s, on the `lock_timeout` | **still holding** (erasure budget up to 20s) | very likely lose again |
| auto-promote (`P2028`) | after the block clears (~7s) | **already released** | very likely win |

So A helps the half the issue does not describe and barely helps the half it does.

It also leaves every other cause of a lost notification untouched — a student who was
simply offline is in the same position, which is the never-filed observation at
`docs/audits/2026-07-18-review-round-2.md:75` ("no sweep re-checks waitlists vs free
seats") seen from the other side.

A sweep subsumes the retry: a class that loses its lock race is simply picked up on
the next tick. **Option A comes free as a consequence of this design rather than as
separate code.**

---

## 3. The measured surface

Everything the sweep depends on, verified rather than assumed.

**`cancelledAt` is written at every seat-freeing site.** Three, all setting
`new Date()` at the moment of the cancel:

| Site | Status written |
|---|---|
| `api/registrations/[id]/route.ts:178` | `late_cancel` |
| `api/registrations/[id]/route.ts:194` | `cancelled` |
| `gdpr.ts:413` | `cancelled` (erasure) |

No path deletes a `Registration` behind the sweep's back: the erasure *anonymises* the
student (`gdpr.ts:534`) rather than deleting the row, so the `onDelete: Cascade` from
`Student` never fires during erasure. The design below does not end up needing this
marker, but it was checked before that was known, and it bounds the alternative.

**The one unmarked way a seat could free — a teacher raising `maxStudents` — cannot
happen to a class this sweep looks at.** The chain closes:

| Step | Evidence |
|---|---|
| `maxStudents ≥ 1` on every write path | `schemas.ts:318, 347, 381, 409` — `.int().positive()` |
| A waitlist join requires the class to be **full** | `addToWaitlist` guard, `waitlist.ts:157` |
| So at least one active registration has existed | full means `activeCount ≥ maxStudents ≥ 1` |
| The first registration latches `settingsLocked`, one way | `api/registrations/route.ts:193-196`; `template-sync.ts:87` records that it never resets |
| Locked ⇒ `maxStudents` immutable, enforced at the database | `lib/class-fields.ts` `ECONOMIC_FIELDS`; CAS `where: { id, settingsLocked: false }` at `class-lifecycle.ts:564` |

The sweep's candidate set is *defined* as classes holding a `waiting` entry, so every
class it examines has `settingsLocked = true`. Cancelling back down to zero active
registrations does not reopen the window — the latch is one-way.

**And the design would not depend on this even if it broke.** §4.2's predicate is
state-based and never reads `cancelledAt`: it asks whether a seat is free *now*, not
what freed it. A seat opened by any means, `maxStudents` included, satisfies it. The
`cancelledAt` census above therefore bounds an alternative design rather than
supporting this one — it is recorded because it was checked, and because a future
detector keyed on events would need it.

**The one assumption worth naming:** `maxStudents ≥ 1` is a Zod invariant at four call
sites, not a database `CHECK`. A row written by raw SQL or a seed script bypasses it.
That weakens the first argument only, not the second.

**A seat is occupied by** `registered`, `attended`, `no_show`
(`lib/registration-status.ts:58`). `readSeatCount` (`capacity.ts:93`) is the single
answer to how many are left, and it requires the caller to already hold the `Class`
row lock.

**The broadcast is atomic per class.** `createBulkNotifications` is one `createMany`
with no `skipDuplicates` — "all-or-throw", as the comment at `waitlist.ts:732` states.
So a class's waiting students either all received a `spot_available` notification or
none did. There is no partial state. §4.3 rests on this.

**Stale queues drain themselves.** `promoteNext`'s head loop (`waitlist.ts:423-437`)
marks a stale candidate `removed` and continues, so an all-stale queue is emptied by a
single call and cannot hold the trigger condition open.

---

## 4. Design

### 4.1 `src/services/waitlist-reconciliation.ts` (new)

```ts
export interface ReconcileSummary {
  candidates: number;   // classes with a waiting queue, examined
  reconciled: number;   // classes where handleSpotFreed was invoked
  failed: number;       // classes whose invocation threw
}

export async function reconcileWaitlists(
  db: PrismaClient,
  opts: { now?: Date } = {},
): Promise<ReconcileSummary>
```

`opts.now` is threaded to **both** `getWaitlistWindow` and `handleSpotFreed`, matching
the clock-injection convention the rest of the services use. Without it T1, T2 and T5
cannot place a class in a chosen window, and the job wrapper simply omits it.

Its own file rather than an addition to `waitlist.ts`, which is already ~900 lines and
holds the queue's core operations. This module *observes* the queue; its only mutation
happens through `handleSpotFreed`.

**The division of labour is the design.** The sweep decides which classes to ask
about; `handleSpotFreed` decides what to do about them. No window resolution, no
capacity policy and no promote-vs-broadcast branch is reimplemented here. That is what
makes §1.2's `auto_promote` loss covered without a line of code addressing it
specifically, and it is why this file stays small.

The return value exists to be read — by the job wrapper for its log line and by the
tests. `handleSpotFreed`'s own return value is read by neither of its callers
(`waitlist.ts:743` says so), and that is what made a fired guard indistinguishable
from an unreached one.

### 4.2 Detection

Start from the narrow set. Most classes have no queue, so the waiting entries are a
far cheaper starting point than the class table:

```
waitlistEntry where status = 'waiting'    → distinct classId
  → load those classes + teacher.defaultTimezone
  → keep status === 'open'
  → getWaitlistWindow(...) !== 'frozen'
  → unlocked activeCount < maxStudents                 (pre-filter, §4.5)
  → if window === 'first_come_first_claimed': apply the §4.3 gate
  → handleSpotFreed(db, classId)
```

**Query shape, because N+1 on a 2GB VPS is the obvious way to get this wrong.** The
seat pre-filter is **batched** — one `registration.groupBy({ by: ['classId'], where: {
classId: { in: candidateIds }, status: { in: [...ACTIVE_REGISTRATION_STATUSES] } } })`
for the whole candidate set, joined against each class's `maxStudents` in code. The
§4.3 gate stays **per-class**, because by then the set has been narrowed to classes
inside a 60-minute claim window, which is a handful at most, and each needs its own
`claimWindowStart`.

**A class absent from the `groupBy` result has zero active registrations, not zero
free seats.** `groupBy` emits no row for a class with no matching registrations, so
looking each class up in the result and skipping the misses inverts the filter for
exactly the emptiest classes — the ones most obviously in need of reconciling. The
lookup defaults to `0`. This is the one place a plausible implementation is silently
backwards, and it fails T1 only if the fixture's class has **no** other active
registration, so the fixture must include that case.

**The pre-filter deliberately does not call `readSeatCount`.** That helper takes
`TransactionClientOnly` and documents the class row lock as a precondition
(`capacity.ts:68`); calling it here would mean opening a transaction and taking a lock
purely to decide whether to ask a question. The brand makes the mistake a compile
error rather than a review note, which is the intended outcome — but an implementer
should not work around it by wrapping the call in a pointless transaction. The
authoritative count remains the one `handleSpotFreed` takes under the lock.

**The trigger is self-resolving in every branch**, so the sweep cannot spin:

| State | What the hook does | Why the trigger clears |
|---|---|---|
| `auto_promote`, live head | promotes | the seat fills |
| `auto_promote`, all-stale queue | marks each `removed` (§3) | no `waiting` rows left |
| `first_come_first_claimed`, not yet broadcast | broadcasts | the §4.3 gate closes |
| `first_come_first_claimed`, already broadcast | not invoked | gated; costs one indexed read per tick, for at most the 60-minute window |

### 4.3 The broadcast gate

In the `first_come_first_claimed` window only:

```ts
notification.findFirst({
  where: { relatedClassId: classId, type: 'spot_available',
           createdAt: { gte: claimWindowStart } },
})
```

`claimWindowStart` is `classStart − deadlineHours − 1h`, derived from the class the
sweep has already loaded — not stored.

**This gate is exact, not approximate**, and that is a consequence of the atomicity
established in §3: because the broadcast is all-or-nothing per class, "did any student
get told?" and "did every student get told?" are the same question. A class-level
check is normally the cheap approximation of a per-recipient one; here it is simply
correct. No new column and no migration.

**The one race it does not close.** The gate is read outside the class row lock, so:
sweep reads the gate → the live hook broadcasts → sweep invokes the hook → a second
broadcast. The sweep cannot race *itself* (`scheduler.ts:138`), only the live path.
The cost is one duplicate notification, against a current cost of no notification at
all. Accepted deliberately, and stated in the PR body rather than closed by
restructuring the hook.

**What the gate gives up.** If a second seat frees inside the same 60-minute window
*and* the live hook fails again, the sweep stays quiet, because a notification from
the first seat already exists. Two failures inside one hour; documented, not built
for.

### 4.4 Error handling and registration

Per-class `try`/`catch` inside the loop, mirroring the erasure loop at `gdpr.ts:654`.
`isolatedSweeps` isolates sweeps from each other, **not items within one sweep**, so
without this a single contended class abandons every class behind it. A failure
increments `failed`, logs, and continues; the class is retried on the next tick.

Registered as a sixth job:

```ts
{ name: 'waitlist-reconciliation', intervalMs: 1 * MINUTE,
  run: (db) => reconcileWaitlists(db) }
```

**1 minute, and the cadence is load-bearing**: the claim window is only 60 minutes
wide, so this bounds a dropped broadcast's cost to roughly 1 of the student's 60 claim
minutes. At `email-fallback`'s 5 minutes it would be 8% of the window.

Its own job name rather than a fourth sweep inside `class-transitions`, so
`getJobHealth()` and `/api/health` can distinguish a failing reconciliation from a
failing class transition.

**Log levels.** `log.info` when `reconciled > 0` — a reconciliation firing means the
live path failed, which belongs in the record without paging anyone, per the rule
`api-errors.ts:223` states (`error` is the level that pages someone). `log.debug` for
a tick that found nothing.

### 4.5 Why the unlocked pre-filter is not #212's mistake

A reviewer will flag the unlocked `activeCount < maxStudents` in §4.2, because #212
existed to remove exactly that read. The distinction is real and belongs in the code
as a comment, not only here.

#212's finding was that an unlocked count is meaningless **as a guard** — it moves the
race rather than closing it. Here it is not a guard. It decides only whether to
*ask*, and `handleSpotFreed` re-counts through `readSeatCount` under `lockClassRow`
before acting. A stale pre-filter costs a wasted call; it cannot produce a wrong
outcome, in either direction:

- reads full, actually free → the seat waits for the next tick (≤1 min)
- reads free, actually full → the hook's locked count suppresses it, as designed

**It is therefore an equivalent mutant and gets no mutation test** (§5). Said out loud
for the reason `waitlist.ts:715` says it about the `waiting.length === 0` line: so the
next reader does not mutation-test it, find nothing, and conclude the suite is weak.

---

## 5. Tests, each with its mutation

| # | Test | Mutation that must fail it |
|---|---|---|
| T1 | **Acceptance, broadcast window.** Hold the class row past the 2s bound so the live hook aborts with `55P03`; run the sweep; assert every waiting student now holds a `spot_available` notification. | Remove the sweep call → 0 notifications. **Baseline already measured** (§1.2 probe), so this is a proven-failing starting state rather than an assumed one. |
| T2 | **Acceptance, auto_promote window.** Hold the row past Prisma's 5s transaction budget so the live hook fails with `P2028`; run the sweep; assert the head of the queue is promoted and holds a `Registration`. | Remove the sweep call → entry stays `waiting`, registration `NONE`. Measured today. |
| T3 | **The gate suppresses a second broadcast.** Broadcast succeeds normally, then the sweep runs in the same claim window. | Make the gate always pass → a second `spot_available` per student in one window. |
| T4 | **Per-class isolation.** Two candidate classes, the first contended past its bound. | Remove the inner `try`/`catch` → the second class is never reached. |
| T5 | **Frozen classes are not reconciled.** A class past its cancel deadline with a free seat and a waiting queue. | Drop the `!== 'frozen'` filter → a promotion after the deadline, which the waitlist model forbids. |
| — | Unlocked pre-filter (§4.5) | **No mutation test.** Equivalent mutant by construction. |

T1 and T2 must hold the row with a **separate `PrismaClient`**, as `gdpr.test.ts:1676`
does, and must assert the holder had not released before the hook returned — otherwise
a slow machine, not the lock, produced the verdict. That is the trap
`waitlist.test.ts:1622-1628` records, where a wall-clock assertion passed 4 runs in 5
with the lock deleted.

The two acceptance tests are the ones #218 could not write. The existing
`takes the class row lock before it counts` re-fills the class first, so the hook
short-circuits on capacity and writes nothing — which is precisely what makes it
unable to assert what the waiting students end up knowing. Running the same shape
against a genuinely free seat is what produced §1.2's numbers.

Mutations are recorded with their exact error text, per the project rule: break,
record, restore, re-verify.

---

## 6. Documentation

- `docs/lock-order.md` — the sweep becomes a sixth `lockClassRow` caller (through
  `handleSpotFreed`). Its "the fourth path" completeness argument enumerates callers,
  so grep 3 (`lockClassRow(`) must be re-run and the count restated.
- `src/services/capacity.ts:71-73` names the current callers of `readSeatCount`
  ("four via their own inline `SELECT … FOR UPDATE`, the waitlist broadcast via
  `lockClassRow`"). The sweep reaches it through the broadcast, so that sentence stays
  true — checked, not assumed.
- `docs/audits/2026-07-18-review-round-2.md:75` — the "no sweep re-checks waitlists vs
  free seats" line is answered by this work and should say so.
- A comment at the unlocked pre-filter carrying §4.5's reasoning.

---

## 7. Out of scope

- **#104 is unaffected.** The five unbounded inline `FOR UPDATE` waits stay as they
  are; this design adds no inline lock of its own.
- **#219 is unaffected.** The sweep reaches `readSeatCount` only through
  `handleSpotFreed`, which already satisfies the lock precondition, so it neither
  helps nor worsens that decision.
- `handleSpotFreed` is **not modified**. No signature change, no recipient filtering,
  no new parameter.
- No migration and no new column.
- ~~A seat freed by raising `maxStudents`~~ — **withdrawn.** An earlier draft excluded
  this as "the one seat-freeing path with no marker". It was wrong twice: the scenario
  is unreachable for any class this sweep examines (§3), and the detection predicate is
  state-based rather than event-based, so it would reconcile such a seat regardless.
  The exclusion was a leftover from a `cancelledAt`-keyed draft that §4.3 replaced.
- The double-failure-in-one-claim-window case stays quiet (§4.3).
- The `warn` lines both callers already emit are left alone; they remain the record of
  the live path failing, and the sweep's `info` is the record of it being repaired.

---

## 8. Acceptance

1. A class whose live broadcast was dropped by a lock timeout has its waiting students
   notified within one minute, proved by T1 against a measured-failing baseline.
2. A class whose live auto-promotion was dropped by the Prisma transaction budget has
   its queue head promoted within one minute, proved by T2 — closing a loss that
   predates #212 and that the issue does not describe.
3. Re-running the sweep against a class already broadcast to in the same window sends
   nothing (T3).
4. One contended class does not prevent any other class from being reconciled (T4).
5. `npm run verify` green, and the new job visible in `/api/health` under its own name.
6. Every mutation in §5 recorded with its exact error text, except the one declared
   equivalent in §4.5.
