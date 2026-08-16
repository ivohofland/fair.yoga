# The erasure's transaction budget and its lock/write-set coupling

**Issues:** #240, #243 · **Date:** 2026-08-16 · **Branch:** `erasure-budget-and-lock-scope`

Both issues were split out of PR #239's review and both live inside
`deleteStudentAccount` (`src/services/gdpr.ts`). #240 is about a number
(`timeout: Math.min(5_000 + waitingCount * 2_000, 20_000)`); #243 is about a
coupling (the pre-lock's lock set has to cover the `waitlistEntry.deleteMany`'s
write set, and does so only because a comment says the fragment must stay
unscoped).

They are one branch because #240's rewrite lands on the same comment block
#243 edits, and because #240's fix removes the last reason that block had to
reason about the lock set's size at all.

---

## 1. What was measured, and where the issues are wrong

Every reference below was checked against this checkout with `sed -n '<n>p'`
on 2026-08-16, not trusted. **All seventeen held; none had drifted.** The plan
should re-check them anyway before leaning on any one of them — the previous
branch's spec caught an inherited reference off by one exactly this way, and a
list that has never been wrong is not the same as a list that cannot be.

### 1.1 Baseline

```
npx vitest run                        → 120 files, 1392 tests, green
npx vitest run --project unit         →  54 files,  775 tests
npx vitest run --project components   →  38 files,  207 tests
npx vitest run --project integration  →  28 files,  410 tests
```

Arithmetic: `54 + 38 + 28 = 120` and `775 + 207 + 410 = 1392`. The dev server
was up on `:3000` for the integration project.

### 1.2 #240 — every stated fact holds

| Claim | Verdict |
|---|---|
| `timeout` is `Math.min(5_000 + waitingCount * 2_000, 20_000)` | **True**, `gdpr.ts:736` |
| `waitingCount` counts `waiting` only | **True**, `gdpr.ts:318` |
| the pre-lock's join carries no status predicate | **True**, `gdpr.ts:405-408` |
| `lock_timeout` is armed per acquisition, not per statement | **True** — and already corrected in prose by `3615c10`, at `gdpr.ts:655-666` and `db-locks.ts:252-260`. The arithmetic at `:736` was not touched. |
| the reorder loop's own per-class cost is uncounted | **True** — `reorderWaitingEntries` (`waitlist.ts:976`) is a `findMany` plus up to M individual `UPDATE`s, each separately bounded by the same 2s |
| a student with 0 `waiting` and 30 closed entries gets 5_000ms against 30 lock requests | **True**, and it follows directly from the two rows above |

### 1.3 #240 — the argument standing against its fix is inverted

This is not in the issue, and it is the load-bearing finding.

`gdpr.ts:289-298` argues *against* sizing on the lock set, in terms strong
enough to stop a contributor:

> Counting every entry instead was a real defect, not a conservative choice
> […] an all-status count is monotone non-decreasing for the life of the
> account. Past the `Math.min` ceiling the erasure would fail, and the retry
> would re-read the same count and fail identically — an account that can
> never be erased, which is not a performance note but an Article 17 failure.

**That does not survive arithmetic.** `Math.min(5_000 + N·2_000, 20_000)` is
monotone non-decreasing in N and capped. For any account, with `A` = all-status
entry count and `W` = `waiting` count, `A ≥ W`, therefore

```
budget(A) = min(5_000 + A·2_000, 20_000)  ≥  min(5_000 + W·2_000, 20_000) = budget(W)
```

An all-status count can only ever grant **more** budget than a `waiting`-only
count for the same account. It cannot produce a failure the smaller count
avoids, so it cannot produce an un-erasable account.

What actually made accounts un-erasable is in `7298311`'s own message: the
`lockClassRow` **loop**, two round trips per class, *measured at 6.0s against
the single statement's 13ms for the same class set*. That commit removed the
loop and reverted the count in one change, and justified the revert with "the
lock cost stops scaling with N." #237's review has since measured that this is
true of **round trips** and false of **waiting** — the very correction `3615c10`
wrote into the comment two paragraphs further down, without noticing it had
removed the premise the paragraph above it stood on.

So the code currently contains both halves of a contradiction, three hundred
lines apart: `:289-298` says the count must be `waiting`-only because the lock
statement's cost no longer scales with N, and `:655-666` says the lock
statement's cost does scale with N.

### 1.4 #243 — the mechanism holds, the "silent" claim does not

| Claim | Verdict |
|---|---|
| `lockClassRowsOrdered` returns its ids so a caller can scope the write | **True**, `db-locks.ts:301-315`, argued at `:286-291` |
| three of five callers discard the return | **True.** Discard: `gdpr.ts:405`, `gdpr.ts:992`, `class-template-lifecycle.ts:1254`. Capture: `template-sync.ts:114` (`lockedIds`), `waitlist.ts:950` (`classIds`). |
| `withdrawWaitingEntriesForTeacher` passes a near-identical fragment plus `AND w.status = 'waiting'` | **True**, `waitlist.ts:950-955` — and it *does* scope its write to the returned ids (`:962-965`). The asymmetry the issue describes is exact. |
| the narrowing's only symptom is an intermittent `40P01` | **False.** See below. |

`gdpr.test.ts:400` is an `it.each` over all five `WaitlistEntry` statuses which
holds the class row in a second transaction and asserts the erasure returned
*after* the holder released (`erasedAfterHolder`, a causal assertion, not a
wall-clock one). Adding `AND w.status = 'waiting'` to the pre-lock makes the
erasure never ask for that row, so four of the five cases — `promoted`,
`claimed`, `expired`, `removed` — fail deterministically, with no concurrency
required. That test was written for exactly this mutation; `7298311` records
it: *"scoping to `waiting` ∪ `expired` passed the entire unit suite […] now
`it.each` over all five statuses; that mutation fails three of them."*

**This changes what the fix is for.** It is not "catches an otherwise-silent
hole." It is "makes the invariant structural rather than test-enforced" — a
narrowing would then also change *what gets deleted*, which is a second and
independent reason for the same test to go red. Weaker than the issue claims,
and still worth doing: the existing detector is behavioural and needs the suite
run to fire, and `db-locks.ts:291` currently tells every caller that ignoring
the return is fine.

### 1.5 #243 — the fix has a cost the issue does not name

`addToWaitlist` (`waitlist.ts`) takes the `Class` row lock, requires
`cls.status === 'open'`, and creates or revives a `WaitlistEntry`. Nothing
stops it running for a student whose erasure is in flight: the erasure's
`session.deleteMany` is inside the same uncommitted transaction, so a request
that authenticated earlier is still live.

If such a join commits for a class **not** in the lock set, between the
pre-lock and the delete:

- **Today** (unscoped `deleteMany`): the entry is deleted — without holding
  that class's row lock. That is precisely the hole the whole discipline
  exists to close. `docs/lock-order.md:684-688` records that the window is
  live rather than theoretical, and `gdpr.test.ts:381-386` names the shape of
  the damage the last one did: `POST /api/registrations`'s walk-in resolver
  raising `P2025`, which `classifyApiError` has no branch for, so a bare 500
  with the whole registration rolled back.
- **Scoped to `lockedIds`** (the issue's fix, taken alone): the entry survives
  the erasure — a live queue entry belonging to an anonymised student, who can
  still be promoted and notified. An erasure that does not erase.

Neither is acceptable on its own, which is why §2.2 adds a postcondition guard
rather than taking the issue's fix verbatim.

---

## 2. The design

### 2.1 #240 — the budget becomes flat, and the count goes away

`gdpr.ts:318`'s pre-transaction `waitlistEntry.count` is deleted along with the
comment block at `:279-317` that defends it. `:736` becomes:

```ts
timeout: 20_000,
```

**Why flat rather than the issue's "size it on the lock set".** The term's only
effect is to choose a number ≤ 20_000, and it has now been shown to price
neither of the two things that scale — it under-counts the lock set (axis 1)
and does not count the reorder loop at all (axis 2). A term that cannot be made
honest, and whose only possible effect is to grant *less* than the ceiling
already permits, is worse than the ceiling alone. Removing it also removes:

- a round trip before the transaction opens;
- the documented drift window at `:303-317` (the count is read outside any
  transaction and can go stale if a waitlist join lands in the gap), which
  exists solely to compute that term;
- roughly forty lines of comment defending a number that no longer needs
  defending.

`Math.min(…, 20_000)` was already "the only real bound" (`gdpr.ts:672-674`
says so). This makes that true by decision instead of by accident, which is
option two of #240 — arrived at by deleting the term rather than by writing
a paragraph about it.

**What the replacement comment must keep**, because it is measured and nothing
else records it:

- `lock_timeout` is armed per acquisition, not per statement — with the
  2026-08-16 measurement (two rows held by sessions releasing at 1.5s and 3.0s,
  one waiter at `lock_timeout='2s'` taking both in one statement, succeeded
  after 2.67s);
- `SET LOCAL lock_timeout` governs every remaining statement in the
  transaction, not only the `FOR UPDATE` — with the round-2 measurement
  (`registration.updateMany` failing at ~2086ms with `55P03`);
- why 20s and not more: the single 2GB VPS, and one Postgres connection pool;
- why P2028 is safe: the function is one transaction end to end, its only
  post-commit work swallows its own errors, so a throw means nothing landed —
  which is what `erasureFailure` relies on to say "Nothing was changed."

**What it must add:** §1.3's correction, stated as a correction. The paragraph
that argued the opposite is being deleted, and a future contributor who finds
`7298311` in `git log` will find the argument still standing there.

**What it must not claim:** that a flat budget bounds the transaction's real
cost. It bounds how long Prisma will let it *start new statements*; a statement
already blocked inside Postgres is bounded only by `lock_timeout`, per
acquisition. That asymmetry stays exactly as documented.

### 2.2 #243 — capture the ids, scope the write, assert the postcondition

```ts
const lockedIds = await lockClassRowsOrdered(tx, {
  join: Prisma.sql`JOIN "WaitlistEntry" w ON w."classId" = c.id`,
  where: Prisma.sql`w."studentId" = ${studentId}`,
});
…
await tx.waitlistEntry.deleteMany({ where: { studentId, classId: { in: lockedIds } } });
…
// last statement in the transaction
const stranded = await tx.waitlistEntry.count({ where: { studentId } });
if (stranded > 0) throw new ErasureLockSetRaceError(stranded);
```

Three decisions inside that, each of which could reasonably have gone the
other way:

**The guard asserts the postcondition, not a proxy.** "No entries remain for
this student" is what erasure promises. `deleted.count === lockedIds.length`
would be an arithmetic stand-in for it that happens to be equivalent today
only because `@@unique([classId, studentId])` gives one entry per class — a
coupling to a schema constraint, to check a coupling. State the promise.

**It goes last, immediately before `student.updateMany` (`gdpr.ts:613`), not
beside the delete.** Under READ COMMITTED the window between the check and
`COMMIT` cannot be closed, only shortened, so the check belongs as late as
possible. Beside the delete it would leave ten statements of window for no
reason. The comment must say the guard **narrows** the race rather than closing
it, and must not be written as though the invariant is now airtight.

**Why the residual window is acceptable rather than a reason to do something
bigger.** Closing it entirely means refusing student-facing writes against a
profile whose erasure is committing — a different change, in `addToWaitlist`
and everything like it, and one that cannot be done from inside this
transaction. Narrowing a race from ten statements to zero-and-a-commit, while
saying so plainly, is the honest increment.

### 2.3 The error path

`isTransientDbError` (`api-errors.ts:158-167`) classifies by
`PrismaClientKnownRequestError.code` and by SQLSTATE substrings in the message.
A service-level `Error` subclass is invisible to it, so without a change the
guard would land in `erasureFailure`'s non-transient branch and tell the
caller:

> Removing your account failed. Nothing was changed. **Pressing Delete again
> will not fix it — please contact support.**

which is the exact opposite of the truth: pressing Delete again is precisely
what fixes it, because the retry's pre-lock will include the new class.

So `erasureFailure` (`account/route.ts:64`) becomes:

```ts
const transient = isTransientDbError(err) || err instanceof ErasureLockSetRaceError;
```

`route.ts` already imports from `@/services/gdpr` (`AlreadyErasedError`,
`ErasureHalf`), so this adds no new dependency direction. It deliberately does
**not** go into `isTransientDbError`: that module imports nothing but
`@prisma/client`, and teaching it about a service's error types would invert
the dependency to keep one `instanceof` in a tidier place.

The comment at the branch must say why the DB-shaped predicate cannot see this
one, or the next reader will "harmonise" it into `api-errors.ts` — the same
class of tidying edit #243 is about.

The log level for this failure is `warn`, not `error`, matching
`route.ts:115-119`'s existing split: a lost race is not an outage and must not
page anyone.

**Naming.** `ErasureLockSetRaceError`, exported from `gdpr.ts` beside
`AlreadyErasedError`, carrying the residual count. The name says which
invariant was violated rather than what the user should do about it, because
the docblock is read by whoever is debugging the throw.

---

## 3. Tests, and the mutation that proves each

Per this project's rule: a guard that compiles but cannot fail certifies
nothing. Each row's mutation must be applied, the exact error text recorded in
the plan's ledger, and then reverted.

| # | Guard | Test | Mutation that must fail it |
|---|---|---|---|
| G1 | the flat budget | **New**, `gdpr.test.ts`: a student with **zero** `waiting` entries and three closed entries in three classes; three holders release at staggered times so each individual lock wait is < 2s but the statement's total is ≈5s; the erasure must complete | restore `Math.min(5_000 + waitingCount * 2_000, 20_000)` → `P2028` |
| G2 | the scoped delete | **Existing**, `gdpr.test.ts:400` (`it.each` over five statuses) | add `AND w.status = 'waiting'` to the fragment → four of five cases fail, now via *both* `erasedAfterHolder` and `remaining === 0` |
| G3 | the residual guard | **New**, `gdpr.test.ts`: block the pre-lock on class A, insert an entry for open class B during the block, release; B is invisible to the statement's snapshot, so the erasure must throw and roll back whole | (a) delete the guard → the erasure commits with B's entry standing; (b) revert the delete to unscoped → B is deleted outside the lock and nothing throws |
| G4 | the 503 mapping | **New**, `tests/integration/`: the G3 race driven through `DELETE /api/account` | drop the `instanceof` clause → 500 `ERASURE_FAILED` instead of 503 `ERASURE_BUSY` |

**G1's construction, spelled out**, because the obvious version does not
work. Three holders that all release at the same moment produce one ~1.8s wait,
not three. The releases must be staggered so that each *wait measured from when
the erasure asks* is under 2s: holder A releases at 1.8s, B at 3.4s, C at 5.0s,
all held from t=0. The erasure waits 1.8s for A, then 1.6s for B, then 1.6s for
C — total ≈5.0s, no single acquisition over the 2s bound. This is the same
experiment #240 quotes, extended by one row.

**G1 is the flakiest thing on this branch.** It asserts across a 5s window
against a 5s budget, on a runner that may be loaded. The plan must give it
margin on both sides — enough total elapsed that a fast runner still exceeds
5_000ms, enough headroom under 2s per acquisition that a slow one does not trip
`55P03` — and must state the measured margins rather than picking round
numbers. `4eb41a0` ("fix a Sunday-morning flake in the refill test") is the
recent precedent for what this costs when it is got wrong.

**G3 rests on one Postgres property, and the plan should verify it rather than
inherit it from here.** Under READ COMMITTED each statement takes its snapshot
at statement start. A `SELECT … FOR UPDATE` that blocks on a row re-checks
*that row* when the blocker commits (EvalPlanQual); it does **not** re-scan for
rows inserted since. So class B, created while the pre-lock is blocked on class
A, is absent from `lockedIds` — which is exactly the condition the guard exists
to catch, and the reason this race is constructible deterministically instead
of by luck. If that turns out to be wrong, G3 has no fixture and the guard has
no test, so it is worth ten minutes in `psql` before writing the test.

**G4 is the riskiest and is still required.** It races an in-flight HTTP
request against DB-level interleaving. It is also the only thing that can
prove the 503, and #243's guard is actively harmful without it: a guard that
rolls back a retryable failure and then tells the user to contact support is
worse than no guard.

**On G3 and G4 both needing the same interleaving:** they are not duplicates.
G3 pins the service's behaviour (throws, rolls back whole, nothing left
behind); G4 pins the route's classification of it. Neither implies the other,
and G4 alone would leave the service's rollback unasserted.

---

## 4. Every artifact that asserts the removed claim

The sweep below is by *file and reason*, not by keyword, and this branch
already has its own worked example of why. The first sweep run here was
``grep -rn "sized \`timeout\`" src docs`` — it returned three hits and
**missed `account/route.ts:27-28`, where "sized" and "`timeout`" sit on
opposite sides of a line break.** Broadening to `grep -rn "sized" src
docs/lock-order.md` found seven, that file among them. Neither number is the
census; the table is.

| File | What is wrong after this branch |
|---|---|
| `src/services/gdpr.ts:283` | *"a fixed transaction budget can't be 'sized to the worst case' honestly"* — the premise for a term being deleted |
| `src/services/gdpr.ts:289-298` | the inverted argument in §1.3 |
| `src/services/gdpr.ts:303-317` | the drift window of a count that no longer exists |
| `src/services/gdpr.ts:387` | cross-reference to `waitingCount` |
| `src/services/gdpr.ts:631-736` | the whole `timeout` comment: the base-term arithmetic, `waitingCount * 2_000` in three places, and *"covers up to 7 fully-contended classes before the cap binds"* |
| `src/lib/db-locks.ts:161-165` | *"its call site sizes the erasure transaction's own `timeout` to the number of classes it is about to lock; the arithmetic lives there, not here"* |
| `src/lib/db-locks.ts:286-291` | *"Callers that do not need them may ignore the return value"* — still true of two callers, no longer of this one; the sentence should name what makes ignoring safe |
| `src/lib/api-errors.ts:122` | *"`deleteStudentAccount`'s sized `timeout`"* |
| `src/app/api/account/route.ts:27-28` | *"`P2028` from `deleteStudentAccount`'s sized `timeout`"* (wraps across the line break) |
| `src/app/api/class-templates/route.ts:121-122` | quotes the formula verbatim |
| `docs/lock-order.md:700-710` | *"The single statement makes the lock cost O(1) statements, so the budget is sized by the reorder loop's `waiting` count"* — the O(1) claim is what #240 falsified |
| `docs/lock-order.md:669-700` | the `deleteStudentAccount` entry: the write set is no longer a re-evaluated predicate |
| `docs/lock-order.md:910` | see below |
| `docs/lock-order.md:103-104` | *"`syncTemplateInstances` does not share it: its write set is `id: { in: lockedIds }`"* — after this branch it is not the only one |

**`docs/lock-order.md:910` needs more than a wording fix.** It argues part of
#229's open decision on the grounds that `deleteStudentAccount` has a *tuned*
budget where `deleteTeacherAccount` has a flat `10_000`, and that *"the tuned
budget is the one that would absorb a re-ordering and the flat one is not."*
After this branch both are flat, so that half of the argument dissolves. It is
corrected here and the effect on #229 is stated in the PR body rather than
being left for whoever picks #229 up to discover.

Historical specs and plans under `docs/superpowers/` that quote the old formula
are records of what was believed at the time and are **not** edited. Live
reference docs are.

---

## 5. Out of scope

- **`registration.updateMany` (`gdpr.ts:486`)** is likewise not scoped to
  `lockedIds`. It is not gated by this lock set — the lock set is built from
  `WaitlistEntry` — and scoping it would be a different argument about a
  different write set. Unchanged.
- **`addToWaitlist` accepting a write against an erasing profile** is the
  fully-closing fix for §2.2's residual window. Not attempted here.
- **#243's "minimum alternative"** (a general statement in `db-locks.ts` about
  when discarding the return is safe, naming which caller relies on what) is
  deliberately not taken, because it is #245's subject. `db-locks.ts:286-291`
  is corrected only where this branch makes it factually wrong.
- **#241, #242, #244 are unaffected**, and #238 remains the root fix for the
  lock set growing with account age.
- **`deleteTeacherAccount`'s discarded return (`gdpr.ts:992`)** stays
  discarded. #243 states why it is safe — its write set is `upcoming`, and the
  statuses are one-way, enforced by `class_terminal_status_guard` — and this
  branch does not re-litigate it.

---

## 6. Risks

1. **G1 is a timing test against a 5s boundary.** Highest flake risk on the
   branch. Mitigation is measured margins, stated in the plan.
2. **G4 races HTTP against DB interleaving.** If it cannot be made reliable,
   the fallback is *not* to drop it silently — it is to say so in the PR body
   and leave the 503 mapping unpinned, which is a finding, not a shrug.
3. **The flat 20_000 lets a failing erasure hold a pool connection for 20s
   where it previously gave up at 5s.** Accepted at the gate: erasures are
   rare, one per account, and failing four times faster at something the user
   must then retry is not a win for a legally time-bound operation.
4. **The comment rewrite is large and mostly deletion.** The measured facts
   listed in §2.1 must survive it. The plan should treat "these specific
   measurements are still present" as a checklist item, not an intention.
