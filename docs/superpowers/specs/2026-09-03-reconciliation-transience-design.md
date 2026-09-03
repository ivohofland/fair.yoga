# Reconciliation transience, and the two ways one bit can lie

Issue 269. The waitlist reconciliation sweep swallows per-class failures by
design and rethrows when it invoked classes and every one failed. That rethrow
reaches `/api/health` as **degraded**, and on a single-teacher VPS — where one
candidate class per tick is the ordinary case, not an edge case — a single
benign lock race is enough to trigger it. The tick that follows repairs
everything.

`reconcileOne` already computes the fact that would separate a lost race from a
broken promotion path, uses it to pick a log level, and throws it away.

This branch carries that fact out to the escalation decision, adds the one piece
of state that stops the fix from silently becoming the opposite defect, and — the
issue's own comment, folded in — makes `handleSpotFreed`'s failures say which
loss actually occurred.

## 1. What the issue claims, and what is actually true

Measured against `adf01828`.

| Claim | Verdict | Evidence |
|---|---|---|
| `deleteStudentAccount` pre-locks every class the erased student was queued in via `lockClassRowsOrdered`, holding them for a transaction budgeted `{ timeout: 20_000 }` | **True** | `services/gdpr.ts`, the `timeout: 20_000` on the erasure transaction |
| `promoteNext` → `lockClassRow` aborts at 2 s with `55P03` | **True** | `LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'"` (`lib/db-locks.ts`), issued by `lockClassRow` before its `FOR UPDATE` |
| `reconcileOne` catches, logs `warn`, returns a bare `{ kind: 'failed' }` | **True** | The `catch` computes `const transient = isTransientDbError(err)`, uses it for the level and the message, and returns an outcome carrying neither |
| `scheduler.ts` records `lastError`; `/api/health` reports degraded | **True** | `makeTick`'s catch sets `lastError`; `health/route.ts` maps `healthy: j.lastError === null` and any unhealthy job to `status: 'degraded'` |
| "**`foldOutcomes`** throws `ReconciliationFailedError` … the `failed > 0 && reconciled === 0` branch" | **False** | `foldOutcomes` is a pure fold with no throw. That branch and the throw are in **`report()`**. The rest of the sentence is accurate; only the function name is wrong |
| Step 2: the erased student's not-yet-committed row still qualifies the class as a candidate | **True but not sufficient** | See below |

### The correction that matters

Qualifying as a *candidate* does not get a class as far as `handleSpotFreed`.
`reconcileOne` applies the `full` skip first, against a **committed**
registration count (`db.registration.groupBy`, outside any transaction). So the
erasure's own not-yet-committed registration cancellations do **not** make the
class read as having a free seat — the sweep skips it as `full` and never
contends for the lock at all.

The race therefore needs a class whose free seat was **already committed before
the erasure began**, and in which the erased student also happens to be queued
(which is what puts the class in `lockClassRowsOrdered`'s set). That is not an
exotic state — it is precisely the state this sweep exists for: a class whose
live spot-freed hook was dropped, still holding a free seat and a queue, waiting
for the next tick to repair it.

So the issue's conclusion stands and its mechanism is real. The path is one step
narrower than stated, and the narrowing is worth recording because a test written
from the issue's wording — erase a student, expect the sweep to contend — would
pass or fail for the wrong reason.

## 2. The constraint the issue does not state

The issue's suggested shape is "throw only when at least one failure was
non-transient — **or** when an all-transient tick repeats N consecutive times".
That second clause is not an optional refinement. Without it this fix becomes
[#354](https://github.com/ivohofland/fair.yoga/issues/354), one sweep family
over.

#354 is live today in `class-generator.ts` and `studio-class-generator.ts`: a
`55P03` skip never reaches `errors`, so a sweep in which *every* template was
skipped throws nothing, `makeTick` stamps `lastSuccessAt`, and `/api/health`
reports the hourly generation job as having just succeeded — every hour,
forever, while a leaked `idle in transaction` session holds one teacher's
template row and their recurring classes quietly stop being generated.

The same session holding `FOR UPDATE` on a `Class` row produces exactly that
shape here: `55P03` on every tick, classified transient, forever.

**A finding that redirects the hazard.** [#232](https://github.com/ivohofland/fair.yoga/issues/232)
observes that `isTransientDbError` classifies `P2024` — connection-pool
exhaustion, an operational fault no retry wins — as transient, which would make
a drained pool the obvious way to reach "all-transient forever". It is not, for
this sweep: `reconcileWaitlists` opens with an **unguarded**
`db.waitlistEntry.groupBy`. A pool with nothing to hand out fails there and
propagates, reddening health through a path no transience gate touches. Only a
*partially* drained pool — enough connections for the opening reads, not for the
per-class transactions — reaches the per-class catch.

So the mechanism the streak defends against is a **wedged row lock** first and a
partial pool shortage second. Both are real; neither is the pool-death scenario
one would assume from #232.

## 3. Scope

Two halves, both from issue 269 (the second from its comment, which asks for
them in one sitting on the grounds that both are about `handleSpotFreed`'s
failures reaching somewhere a human can act on, and both touch the same call
sites).

**A. Transience survives to the escalation decision** — `waitlist-reconciliation.ts`,
with a wiring change in `scheduler.ts`.

**B. A failure says which loss occurred** — `waitlist.ts`, `api-errors.ts`, and
the three `handleSpotFreed` call sites.

Re-derive the call sites:

```
grep -rn "handleSpotFreed(" --include="*.ts" src \
  | grep -v "\.test\.ts" | grep -v "export async function"
```

Three today: `api/registrations/[id]/route.ts` (`promoteAfterCancel`),
`services/gdpr.ts` (`deleteStudentAccount`'s post-commit loop), and
`services/waitlist-reconciliation.ts` (`reconcileOne`).

## 4. Design A — transience survives the fold

### 4.1 The outcome carries it

`ClassOutcome`'s failed arm becomes `{ kind: 'failed'; transient: boolean }`.

`ReconcileSummary` gains one field:

```ts
/**
 * The subset of `failedClassIds` whose failure `isTransientDbError` classified
 * as a lost contention race.
 */
readonly transientFailedClassIds: readonly string[];
```

A **subset**, mirroring the module's existing `repairedClassIds ⊂
reconciledClassIds` rather than inventing a second partition. No existing field
changes meaning, so no existing assertion changes.

### 4.2 Cross-tick memory, and where it lives

```ts
export interface ReconciliationStreaks {
  /** Consecutive ticks in which every invoked class failed, all transiently. */
  allTransientTicks: number;
  /** Consecutive failures per class, rebuilt each tick from that tick's failures. */
  failuresByClass: Map<string, number>;
}

export function createReconciliationStreaks(): ReconciliationStreaks;
```

Plain mutable data plus a factory — the shape this codebase reaches for, and the
one a test can construct and inspect without a seam.

`reconcileWaitlists(db, opts)` takes it as a **required** field of a **required**
`opts` — every caller states which memory it is using, and each test constructs
its own, so no test can poison the test after it. §4.3 explains why the
requiredness is load-bearing rather than pedantic.

`failuresByClass` is rebuilt each tick from that tick's failures, so a class that
did not fail drops out. Its size is bounded by the candidate set, not by uptime.

### 4.3 Production gets the memory, and the wiring cannot silently go missing

One new export in the same module, closing over a module-level tracker:

```ts
export function runWaitlistReconciliationTick(db: PrismaClient): Promise<ReconcileSummary>;
```

`startScheduler` injects **that** instead of `reconcileWaitlists`, and
`SchedulerSweeps` / `SWEEP_NAMES` rename the key to match.

**The rename alone is not the tether, and the difference matters.**
`SchedulerSweeps` types every sweep loosely as `(db: PrismaClient) =>
Promise<unknown>`, so `scheduler.test.ts`'s two `NoneOf` pins
(`_stubsCoverSweeps`, `_stubsHaveNoExtras`) catch a *missing key* while the
whole-map job assertion matches on *stub name*. Neither can see the wrong
function wired under the right key — and a `reconcileWaitlists` wired there
would type-check and run, silently without memory. That is precisely the guard
that cannot fail which CLAUDE.md's *Comment Discipline* and
`docs/solve-issue-lessons.md#3` exist to refuse.

The tether is §4.2's **required** `opts`. TypeScript permits assigning a function
to a signature taking *more* parameters, never fewer, so `(db, opts) =>
Promise<ReconcileSummary>` is not assignable to `(db) => Promise<unknown>`:

```
error TS2322: Type '(db: PrismaClient, opts: ReconcileOptions) => Promise<ReconcileSummary>'
is not assignable to type 'Sweep'.
  Target signature provides too few arguments. Expected 2 or more, but got 1.
```

Measured, not assumed: that elaboration is `tsc --noEmit --strict`'s verbatim
output on a reduction of exactly this shape, which also accepts the
one-parameter wrapper in the same slot. Only the wrapper that owns a tracker
fits. The rename then does the
remaining, smaller job: it makes the job table read as what it is.

`buildJobs` is deliberately untouched. `scheduler.ts` must not statically import
a service module — `startScheduler`'s dynamic imports exist so
`instrumentation.ts` stays loadable in the edge runtime — so the tracker is
created where the dynamic import already happens.

### 4.4 The escalation rules

One constant:

```ts
/** Ticks of unbroken contention before the sweep reports itself degraded. */
const MAX_CONSECUTIVE_CONTENDED_TICKS = 5;
```

Five ticks at the job table's pinned one-minute interval is roughly five minutes.
It is a threshold chosen for what it costs to be wrong in each direction: the
widest legitimate hold in the system is `deleteStudentAccount`'s 20-second
transaction budget, which cannot span two ticks, while a wedged row lock reddens
health inside five minutes.

A tick is **contended** exactly when it invoked at least one class, every
invoked class failed, and every one of those failures was transient — the
`failedClassIds.length > 0 && reconciledClassIds.length === 0 &&
transientFailedClassIds.length === failedClassIds.length` conjunction.

Per tick, in this order:

1. **`allTransientTicks` becomes `contended ? allTransientTicks + 1 : 0`.** The
   reset covers every non-contended tick — one that reconciled something, one
   where every candidate was skipped, one with no candidates at all, and one
   that failed everything with at least one *non*-transient failure. Justified
   rather than assumed for the no-candidate case: a wedged row lock keeps its
   class a candidate on every tick (the `waiting` entry and the free seat both
   persist), so a tick that finds nothing genuinely means nothing is stuck from
   this sweep's vantage point.
2. **All-failed with any non-transient failure → throw immediately**, whatever
   the streak now reads. Today's behaviour for that case, preserved exactly.
3. **Contended and `allTransientTicks >= MAX_CONSECUTIVE_CONTENDED_TICKS` →
   throw.** Below the limit: `log.warn` carrying the streak, normal return,
   health untouched.
4. **Throwing does not reset the streak.** It stays at or above the limit and
   throws again next tick, so health stays red while the condition stands rather
   than oscillating.

Structurally, the decision is split so neither half does two jobs:

```ts
type Escalation = 'none' | 'non_transient' | 'contended';

/** Pure. Step 1 has already run, so `allTransientTicks` is this tick's value. */
function decideEscalation(summary: ReconcileSummary, allTransientTicks: number): Escalation;

/** Logs, and throws for a non-`'none'` escalation. */
function report(summary: ReconcileSummary, allTransientTicks: number, escalation: Escalation): void;
```

`reconcileWaitlists` performs step 1 on `streaks` between the fold and
`decideEscalation`, so the mutation lives in the one function that owns the
tracker and neither helper hides a side effect. `report` keeps its existing four
log branches and gains the streak in its payload.

`ReconciliationFailedError` gains `readonly reason: 'non_transient' | 'contended'`
and varies its message accordingly, so `lastError` — which `/api/health`
deliberately does not expose, but which the server log carries — distinguishes
"this will not clear by retrying" from "five minutes of unbroken contention".

### 4.5 The persistently contended class

Today a class contended forever is invisible the moment any *other* class
reconciles: `report`'s escalation branch requires `reconciledClassIds.length ===
0`. The issue asks for that to be decided rather than inherited.

**Decision: it becomes an `error` log line naming the class and its streak, and
it does not redden the job.**

In `reconcileOne`'s catch, the class's consecutive-failure count is read from the
prior tick's map, incremented, written to this tick's map, and carried in the
existing per-class log payload. The level becomes `error` when the failure is
non-transient (as today) **or** when a transient failure's class streak has
reached `MAX_CONSECUTIVE_CONTENDED_TICKS` — and on every tick thereafter while
the class keeps failing, since the condition is standing rather than an event.
The map swap (`streaks.failuresByClass = thisTick`) happens once after the loop,
so a class that did not fail this tick leaves the map and starts from zero if it
fails again later.

Same constant for both, and the reuse is the point: one number with one meaning —
*this has stood for five minutes*.

Not a throw, because a permanently stuck single class holding an otherwise
working job at `degraded` indefinitely is the alert-fatigue shape this issue was
filed against.

The streak maps reach `reconcileOne` as a small per-tick context parameter rather
than by moving the logging into the fold. `reconcileOne`'s docblock argues the
extraction exists so a class's outcome is a **return value**; putting the error
into the outcome so the fold could log it would make the outcome a carrier for a
side effect the function already performed, and two places would then know how to
classify one failure.

## 5. Design B — which loss actually occurred

`handleSpotFreed` resolves the window internally and then throws it away on the
failure path, so all three call sites log one message that cannot say whether the
loss was *one specific student not promoted into a seat they should hold* or *N
waiting students never told a seat is free*. PR #268 corrected the messages to
"the freed seat was neither promoted nor broadcast" — true on either branch, and
deliberately less specific than the wording it replaced.

### 5.1 The typed error

```ts
export class SpotFreedError extends Error {
  constructor(
    readonly classId: string,
    /** `null` when the throw happened before the window resolved. */
    readonly window: Exclude<WaitlistWindow, 'frozen'> | null,
    override readonly cause: unknown,
  );
}
```

`handleSpotFreed` wraps everything that escapes it. The window is captured as it
resolves, so three honest values reach the caller:

| `window` | What was lost |
|---|---|
| `'auto_promote'` | The queue head was not promoted into the freed seat |
| `'first_come_first_claimed'` | The waiting students were not told the seat is free |
| `null` | Threw before the window resolved (the opening `class.findUnique`) — the freed seat was neither promoted nor broadcast |

`'frozen'` is excluded by the type because that window **returns** rather than
proceeding, so no throw can carry it. A compiler tether in place of a sentence
promising it.

`WaitlistPromotionError` is unaffected — `handleSpotFreed` catches it internally
and returns `{ action: 'none' }`.

### 5.2 One phrase roster, not three copies

The loss phrases live beside `SpotFreedError` in `waitlist.ts` as a single
exported mapping keyed by the window, consumed by all three call sites. Three
hand-maintained copies of a three-member roster is precisely the drift CLAUDE.md's
*Comment Discipline* names ("never write a count or a member list in prose"), and
here the roster is code, so it can be tethered instead of documented.

Each site keeps its own prefix (`waitlist spot-freed hook …`, `gdpr: spot-freed
hook …`, `waitlist reconciliation …`) and adds a `branch` field to its payload.

### 5.3 The classifier unwrap, and why it is safe today

All three sites classify with `isTransientDbError`, which tests `instanceof
Prisma.PrismaClientKnownRequestError` against `TRANSIENT_PRISMA_CODES` *first*,
then falls back to matching the SQLSTATE inside its Postgres framing in
`error.message`.

A `P2024` wrapped in `SpotFreedError` is **no longer that instance**, and its
message carries no SQLSTATE framing. So wrapping without unwrapping would
silently reclassify every `P2024`/`P2028`/`P2034` on these paths as
non-transient — turning routine pool contention into `error`-level noise, and,
worse, into an *immediate* `ReconciliationFailedError` under §4.4's rule 1. The
half of this branch that quiets a false alarm would be defeated by the half that
improves a log message.

Fix: `isTransientDbError` walks the `cause` chain, depth-capped, before giving
up.

Blast radius, measured rather than argued:

```
grep -rn "cause:" --include="*.ts" --include="*.tsx" src | grep -v "\.test\."
```

Zero hits. Nothing in `src/` sets `cause` today, so the walk reclassifies nothing
that exists — `SpotFreedError` would be its first producer.

## 6. Claims this branch falsifies

Per `docs/solve-issue-lessons.md#4`, each is corrected by **replacement**, not by
annotation; the before-and-after belongs in the PR body.

| Location | What goes stale |
|---|---|
| `waitlist-reconciliation.ts`, `ReconciliationFailedError`'s docblock | "Rethrowing here is what `isolatedSweeps` does for the same reason … and it costs nothing in the routine case" — the routine case is now explicitly tolerated, and the reason for the rethrow is narrower |
| `waitlist-reconciliation.ts`, `reconcileOne`'s catch comment | Describes `transient` as deciding "a log level and a message". It now decides escalation |
| `waitlist-reconciliation.ts`, header docblock | Describes the module as pure detection; it now holds cross-tick state |
| `scheduler.ts`, the `waitlist-reconciliation` job comment | States the throw condition as "it invoked classes and every one failed" |
| `scheduler.test.ts`, `makeTick`'s third test docblock | Cites `reconcileWaitlists` throwing on that same condition |
| `waitlist-reconciliation.test.ts`, `broadcasts once, then gates itself…` | Frames itself as the no-`opts` production call path; `opts` is required now and production calls the wrapper (§7) |
| `waitlist-retention.ts`, `RetentionFailedError`'s docblock | "Mirrors `ReconciliationFailedError` … and exists for the same reason" — they diverge here |
| `api/registrations/[id]/route.ts`, `promoteAfterCancel`'s docblock | Records that the handler "cannot see" which branch threw, and that `handleSpotFreed` knows |
| `gdpr.ts`, the post-commit loop comment | Same claim, cross-referenced to the above |
| `waitlist.ts`, `handleSpotFreed`'s docblock | Describes the throw contract the three callers see |
| `DEPLOYMENT.md` §7 | `jobs.<name>.healthy` "flips false when a job errors" stays true, but the operator now needs to know this one job tolerates contention for a bounded interval, and that a stuck class appears as an `error` log line without flipping it |

The threshold `5` is stated in `DEPLOYMENT.md` beside the constant's name, never
in a docblock: it is operator-facing, it is a number, and CLAUDE.md's *Comment
Discipline* puts numbers where they have an owner.

## 7. Testing, and the mutation for each guard

Every guard is broken, its exact error text recorded, then restored and
re-verified.

| # | Guard | Mutation that must fail |
|---|---|---|
| 1 | An all-transient tick below the limit does not throw | Restore the unconditional `failed > 0 && reconciled === 0` throw |
| 2 | The limit is reached and it throws | Raise `MAX_CONSECUTIVE_CONTENDED_TICKS`; the streak test must go red |
| 3 | A non-transient failure escalates immediately, without waiting for the streak | Route the non-transient case through the streak |
| 4 | The `cause` unwrap | Remove the walk; a `P2024` wrapped in `SpotFreedError` must flip from `warn` to `error` |
| 5 | The production wiring | Wire `reconcileWaitlists` into the sweep slot instead of the wrapper; record the TS2322 arity error from §4.3 |
| 6 | Per-class `error` escalation | Hold the level at `warn` for a transient failure at the limit |
| 7 | `window` is attached on both branches | Hard-code `null`; the branch-naming assertions must go red |

**The real-lock test the issue asks for by name.** `waitlist-reconciliation.test.ts`
already holds a `Class` row past `lockClassRow`'s 2 s bound in two tests
(`grep -c "FOR UPDATE" src/services/waitlist-reconciliation.test.ts` → 2), using a
second `PrismaClient` inside a 30 s-budgeted transaction. The new test follows
that shape with **one** candidate rather than two, so the tick is all-failed, and
asserts it returns rather than throwing.

The `$extends` fault injector already in the file covers the streak tests, which
need N ticks and must not each cost 3.5 s of wall clock.

**Mechanical churn from §4.2's required `opts`.** Every existing call gains an
explicit tracker — 19 lines in the test file
(`grep -c "reconcileWaitlists(" src/services/waitlist-reconciliation.test.ts`)
and the single production one (`scheduler.ts`'s `run: (db) =>
reconcileWaitlists(db)`), which becomes the §4.3 wrapper. The churn is noise in
the diff and signal in the tests: each one states the memory it is exercising.

**One test needs care rather than a search-and-replace.** `broadcasts once, then
gates itself, on the real clock with no injected now` is the file's only
no-`opts` call, and its docblock frames that as "the production call path …
exactly as `buildJobs`' `waitlist-reconciliation` entry invokes it". The property
it actually pins is the absent **clock** — thread `opts.now ?? new Date(0)`
through the module and every other test stays green. That property survives
unchanged: the test passes `{ streaks }` and still omits `now`. It does **not**
move to `runWaitlistReconciliationTick`, which would couple it to the
module-level tracker and hand a shared streak to whatever runs next; the wrapper
gets its own small delegation test instead. Only the docblock's "no `opts`"
framing is falsified, and it is replaced rather than annotated.

`gdpr.test.ts`'s "a diagnostic-loop failure after a lost handleSpotFreed race
does not fail the already-committed erasure" injects an error whose *message*
carries `code: "55P03"`. Under §5.1 that error becomes the `cause`, which makes
this an existing test that proves the §5.3 unwrap bites on a path this branch did
not write.

## 8. Acceptance

From the issue, plus what §2 adds:

1. A tick whose failures are all transient does not by itself set
   `JobHealth.lastError`.
2. A tick with any non-transient failure still does, immediately.
3. `MAX_CONSECUTIVE_CONTENDED_TICKS` consecutive all-transient ticks **do** set
   it, and it stays set while the condition holds.
4. A persistently contended class produces an `error` line naming the class and
   its streak even when another class reconciles, and does not redden the job.
5. A test holds a real `Class` row past 2 s and asserts the sweep does not report
   degraded; its twin injects a non-transient failure and asserts it does.
6. A `P2024` reaching a `handleSpotFreed` call site through `SpotFreedError` is
   still classified transient.
7. Each of the three call sites names the actual loss on both branches, and falls
   back to today's general wording when the window is unknown.

## 9. Non-goals, and what stays open

- **`waitlist-retention.ts` keeps its transience-blind all-failed throw.** Same
  shape, different risk: a daily cadence over batches of up to 500 terminal
  classes that essentially nothing contends for. An all-failed run there is a
  signal, not a false alarm. Named here so the divergence is a decision rather
  than an oversight.
- **#354 is unaffected** and stays open. This branch fixes the reconciliation
  sweep's false positive and installs the state that prevents its false
  negative; the generator sweeps' live false negative is that issue's work, and
  the streak pattern here is the obvious donor.
- **#232 is unaffected** and stays open. The `cause` walk changes how
  `isTransientDbError` finds an error, never which codes it calls transient, so
  `P2024`'s conflation with a lost lock race survives this branch untouched.
- **#122 is unaffected** — closed, different sweep, and its fix (skip the
  `errors.push`) is the narrower shape this issue explicitly rules out.
- No migration. No schema change. No user-visible behaviour change: every
  difference here is in a log line, a thrown error, and one field of
  `/api/health`.

## 10. Found in passing

`waitlist-retention.ts` cites `docs/DEPLOYMENT.md` in one docblock and
`DEPLOYMENT.md` in another. The file is at the repository root; the `docs/`-
prefixed path is wrong. Out of this branch's scope, recorded for the fold/file/
let-go pass.
