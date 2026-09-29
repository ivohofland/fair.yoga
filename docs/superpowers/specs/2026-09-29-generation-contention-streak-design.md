# Generation sweeps: bound the lock-contention skip (#354)

## Problem, as measured

`generateClassInstances` (`src/services/class-generator.ts`) and
`generateStudioClassInstances` (`src/services/studio-class-generator.ts`) skip a
template whose claim times out on a lock (`55P03`), log it at `warn`, and never
push it into `errors`. #122 introduced that skip on purpose: a teacher's edit that
holds the template row at the moment of the sweep is not a generation failure.

The skip has no bound. A row locked **indefinitely** — an idle-in-transaction
session holding `FOR UPDATE` on one `ClassTemplate` — is skipped every hour, the
sweep throws nothing, and `makeTick` (`src/lib/scheduler.ts`) records
`lastSuccessAt` and sets `lastError = null`. `/api/health` reports
`class-generation` healthy while that teacher's rolling window drains.

The issue's premise holds. Only the two sweeps above catch `isLockTimeout`
(`grep -rln "isLockTimeout(" src`: `api-errors.ts`, its test, the two
generators, and `student-archive-lock-order.test.ts`). The only production
callers of either sweep are `lib/scheduler.ts` (`class-generation` job) and
`api/cron/generate-classes/route.ts` (manual run).

## Where the issue's suggested shape is wrong

**"`skipped > 0 && totalCreated === 0` → escalate" would bring back #122's
false alarm.** A sweep creates a class only when a new candidate date enters the
rolling 4-week window. That happens about once a day per template, so for a
single-template teacher about 23 of 24 hourly sweeps create **zero** classes
even when everything works. In those hours one benign skip — a teacher saving an
edit at the moment of the sweep — would satisfy the predicate and turn the job red.

**It is also blind to the issue's own harm scenario.** The scenario is ONE
teacher's row wedged while every other teacher's templates generate normally.
Those other templates can make `totalCreated > 0`, so the predicate never fires
for the wedged one, which is exactly the teacher who is losing classes.

**"Every template skipped" (acceptance bullet 1) has the same two problems at
the extremes.** On a one-template deployment, every benign skip is an
all-skipped sweep, so bullet 1 as written contradicts bullet 2. On a
many-teacher deployment, an all-skipped sweep essentially never happens, and
the wedged template goes unreported.

What separates a wedged row from a busy one is **repetition of the same
template**, which the issue names as its second option. A benign edit holds
the row for one transaction. A wedged row stays locked on every sweep. The two
look identical inside one sweep, and only a caller that remembers earlier sweeps
can tell them apart. That is the argument `waitlist-reconciliation.ts` already
makes for its `ReconciliationStreaks`, and this design takes the same shape.

## Design

### A per-template contention streak, shared by both families

A new service module, `src/services/generation-contention.ts`:

- `MAX_CONSECUTIVE_CONTENDED_SWEEPS = 3`: the number of consecutive sweeps a
  template may be skipped for contention before the job reports itself
  unhealthy. On the hourly `class-generation` job that means an unbroken hold of
  roughly two to three hours. A benign writer holds the row for one
  transaction under a 2s `lock_timeout`, so for it to reach 3 it would have to
  be holding that same row at three separate sweep instants an hour apart. The
  4-week window drains a week at a time, so a few hours of patience cost no
  student a bookable class. Like `MAX_CONSECUTIVE_CONTENDED_TICKS`, it means
  "this has stood for a while", and the job's interval is what turns it into a
  duration.
- `ContentionStreaks`: a readonly view of `Map<templateId, consecutiveSkips>`.
  A mutable internal view is used only inside this module, the same device
  `ReconciliationStreaks` uses.
- `createContentionStreaks()`.
- `recordSweepContention(streaks, skipped, logNoun)` is called once, after the
  loop, with that sweep's skipped `{ templateId, teacherId }` list. It
  **rebuilds** the map from this sweep's skips: a template that was not skipped
  this sweep drops out, so its streak resets, and the map's size is bounded by
  the candidate set, not by uptime. For every template whose streak reaches the
  threshold it logs one `error` line (with `templateId`, `teacherId`, `streak`).
  It returns a `GenerationContendedError` naming those templates, or `null`.
- `GenerationContendedError extends Error`: `templateIds`, and a message naming
  the family noun and the threshold.

### The sweeps

Each family's loop collects the contended templates, then, after the loop:

```ts
const contended = recordSweepContention(opts.streaks, skipped, FAMILY.logNoun);
if (errors.length > 0) throw errors[0];
if (contended) throw contended;
return totalCreated;
```

A genuine failure still wins the rethrow, since it is the more specific signal.
The contended templates were already logged at `error` either way. While the
template stays wedged, every sweep past the threshold throws again, so
`lastError` stays set. That also closes the issue's secondary point, that a
skip-only hour wiped the previous hour's `lastError`.

A single skip, or two in a row, behaves exactly as it does today: a `warn`
line and a successful sweep (#122 preserved).

### Wiring: the streak is a required option

The signatures become

```ts
generateClassInstances(db, opts: { streaks: ContentionStreaks; from?: Date; teacherId?: string })
generateStudioClassInstances(db, opts: { streaks: ContentionStreaks; from?: Date })
```

`opts` has **no default**, and that is load-bearing, for the reason
`ReconcileOptions` states. `SchedulerSweeps` types each sweep as
`(db) => Promise<unknown>`. A two-parameter function with a required second
parameter is not assignable to that type, so the scheduler cannot be wired to a
memoryless sweep by accident; it compiles only against a tick wrapper.

Each generator module exports a tick wrapper over a module-level tracker,
`runClassGenerationTick(db)` / `runStudioClassGenerationTick(db)`. `SchedulerSweeps`
renames its two fields to match, and `buildJobs` wires the wrappers.

The manual cron route (`POST /api/cron/generate-classes`) passes a **fresh**
tracker on every call, so a manual run never escalates contention. It is an
operator's one-off and not a tick in the hourly series. It also cannot share
the scheduler's tracker reliably, because a route bundle and `instrumentation.ts`
may hold different module instances (the reason `scheduler.ts` keeps job health
on `globalThis`).

### The adjacent classifier finding

The issue's claim was that `P2034` "write conflict" takes the `else` branch and
makes the job look flaky. That is outdated. `api-errors.ts` now classifies
`P2034` as `deadlock` at `error` level on purpose (its level table explains
why: no serializable or repeatable-read transaction exists here, so `P2034` can
only be a deadlock). A deadlock inside the sweep reddening the job is intended.

What does still differ is that `isLockTimeout` matches only the error's own
message, while `transientDbFailure` walks the `cause` chain. The two are
reconciled by redefining

```ts
isLockTimeout(error) === (transientDbFailure(error)?.kind === 'lock_timeout')
```

so there is one matcher, not two parallel ones. For every error the old
function matched this is the same answer (the `55P03` framings are the same
two strings, and no Prisma code maps to `lock_timeout`). It additionally
matches a lock timeout carried as `cause`.

The skip stays narrow (lock timeout only). `tx_budget` (`P2028`) is also a
`warn`-level kind, but the transaction's 10s budget is set well above the
claim's 2s lock timeout specifically so it does not fire from contention. If it
does fire, the job should go red.

### Operator documentation

`DEPLOYMENT.md` §7 gets a `class-generation` bullet next to the
`waitlist-reconciliation` one, covering what flips it, the three-sweep
tolerance, and the `error` log line naming the stuck template.

## Not in scope

- Releasing the lock. The sweep cannot tell a leaked session from a slow one,
  and killing backends is an operator decision.
- A skip count in the cron route's response body.
- Alert delivery. Logs go to stdout with no transport (#157 is unaffected).

## Tests (each must be shown to fail without its code)

1. `generation-contention.test.ts` (unit): the streak increments per
   consecutive skip, resets when a template is absent from a sweep, returns
   `null` at `MAX − 1` and an error at `MAX`, names only the stuck templates,
   and logs one `error` per stuck template carrying its streak.
2. Both generator test files (stub `PrismaClient`, the existing
   per-template-isolation pattern): with a shared tracker, the same template
   contended for `MAX` sweeps rejects with `GenerationContendedError` even
   while a sibling template generates in the same sweeps (the issue's
   scenario). A fresh tracker per call never rejects. A genuine error in the
   escalating sweep is the one rethrown.
3. `class-generator-lock-order.test.ts` (real database): a second connection
   holds `FOR UPDATE` on the template's `ClassTemplate` row (the row
   `claimRuleForGeneration` locks) for the whole test. With one tracker, sweeps
   `1 … MAX−1` resolve and sweep `MAX` rejects with `GenerationContendedError`.
   This proves the real `55P03` shape feeds the streak. The holder's
   transaction budget must exceed `MAX` × the 2s lock timeout, or `P2028` on
   the holder releases the lock mid-test and a later sweep claims the row.
4. `scheduler.test.ts`: `class-generation` is wired to the two tick wrappers.
5. `api-errors.test.ts`: `isLockTimeout` matches a lock timeout carried as `cause`.
