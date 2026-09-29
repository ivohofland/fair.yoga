# A hung scheduled job reports unhealthy (#711)

## Problem

`/api/health` computes each job's `healthy` flag as `lastError === null`
(`src/app/api/health/route.ts`). It never asks whether the job is still making
progress. `makeTick` (`src/lib/scheduler.ts`) sets `job.running`, awaits the
run, and clears the flag in `finally`. A run that never settles leaves
`running` set, so every later tick returns at `if (job.running) return;` without
touching any health field. `lastError` keeps whatever the last *completed* run
left, usually `null`. The job reads `healthy: true` and `status: 'ok'` forever.

## Premise check (measured at `f3cef9c9`)

- **Holds:** the route computes `healthy: j.lastError === null`, and there is no
  other input to it.
- **Holds:** the guard returns before any write to `JobHealth`. The only fields
  are `lastRunAt`, `lastSuccessAt` and `lastError`
  (`JobHealth`, `scheduler.ts`).
- **Holds:** `grep -rn "statement_timeout\|idle_in_transaction_session_timeout"
  src prisma docker-compose*.yml DEPLOYMENT.md` returns nothing, so a statement
  can wait indefinitely.
- **Incomplete:** the issue frames the fix as "`/api/health` needs to know each
  job's interval". That is only true for a wall-clock check, and the chosen
  design does not need it (below).
- **Found in passing:** `buildJobs`' `daily-cleanup` comment quotes the
  route's expression `healthy: j.lastError === null` verbatim, from another file.
  This change falsifies it, so the comment is corrected here.

## Decision: option 1 (detect), not option 2 (bound statements)

This follows the issue's lean. Detection covers every cause of a hang, whatever
it is. Statement timeouts cover only database waits, and they risk cutting off
long legitimate statements (migrations, GDPR erasure, retention sweeps). Option
2 stays recorded in #711's body. This branch does not take it.

## Approaches considered

**A. Wall-clock staleness at read time.** The job is unhealthy when `lastRunAt`
is older than K × `intervalMs`.

- `JobHealth` would have to carry the interval, plus a registration time for the
  window before the first run.
- A single tolerated overrun makes the gap between run starts exactly 2 ×
  `intervalMs`. K = 2 therefore flaps on timer jitter, and K = 3 slows every
  report by a whole interval.
- There is no natural place to log. The route is polled, so logging there would
  repeat on every poll.

**B. Count the ticks the guard refuses (chosen).** Each tick that finds
`job.running` set is a direct observation that the current run has overrun
another interval.

- `JobHealth` gains `skippedTicks`: the consecutive ticks refused during the
  current run. The guard increments it, and `makeTick`'s `finally` resets it to
  0, so it describes only the run in flight.
- The job is unhealthy once `skippedTicks` reaches `STALLED_AFTER_SKIPPED_TICKS`
  (2).
- The units are the job's own ticks, the idiom already used by
  `MAX_CONSECUTIVE_CONTENDED_TICKS` and `MAX_CONSECUTIVE_CONTENDED_SWEEPS`.
- The health route does not need to know any interval.
- A single overrun (one skipped tick) stays healthy, and it has no boundary to
  flap on.
- The refused tick is where the hang is observed, so the log line belongs there.

B relies on ticks continuing to fire. They do: the run is awaiting I/O, not
blocking the event loop, and a blocked event loop could not answer `/api/health`
either.

## Design

In `src/lib/scheduler.ts`:

- `JobHealth.skippedTicks: number`. It is a required field, so every literal
  that builds a `JobHealth` is a compile error until it states the field.
- `export const STALLED_AFTER_SKIPPED_TICKS = 2`.
- `export function isJobHealthy(h: JobHealth): boolean` returns
  `h.lastError === null && h.skippedTicks < STALLED_AFTER_SKIPPED_TICKS`. This is
  the one verdict. The route calls it and computes no rule of its own.
- `makeTick`'s guard branch runs `jobHealth.skippedTicks += 1` before
  returning. Once the count reaches the threshold, it logs `log.error` with the
  job name, `skippedTicks` and `runningSince` (the run's `lastRunAt`) on every
  refused tick. That is one line per interval while the hang lasts, matching
  class-generation's escalation, which also logs on each run.
- `finally` sets `skippedTicks = 0` next to `running = false`. A hung run that
  eventually settles clears the stall straight away. The verdict then rests on
  that run's own outcome, `lastError`.

In `src/app/api/health/route.ts`, `healthy: isJobHealthy(j)`. The response
shape does not change and gains no field. An operator can tell a hang from an
error without one: a hang leaves `lastRunAt` at least one interval old, an error
leaves it fresh, and the server log names which.

### The bound

A run starting on a tick at time T is refused by the ticks at T + I and T + 2I,
so the job reports unhealthy at the second tick that comes due while the run is
in flight. That is at most two of its intervals after the run began. It is
slightly less for a hung first run, because the boot tick fires 15 s after
registration while the interval ticks fire on multiples of I.

For each job this is two of its `intervalMs` in `buildJobs`: minutes for the
one-minute jobs, two days for `daily-cleanup`. `DEPLOYMENT.md` §7 states the
rule and does not copy the table.

### Consequence for `waitlist-reconciliation`

Its comment in `buildJobs` already says a pass can overrun the interval and
that the guard drops the ticks it overruns. A pass that overruns *two* ticks
(longer than about two minutes) now reports the job unhealthy. That is the
intended reading: a correctness sweep that has not finished a pass in two
minutes is worth a page. The comment gains that sentence.

## Testing

- **`makeTick` unit test** (`src/lib/scheduler.test.ts`, driven through
  `makeTick`, as the issue's acceptance requires): a run that never resolves.
  - After the first skipped tick, `isJobHealthy` is still true.
  - After the second, it is false and `log.error` was called.
  - After the run is released and settles, `skippedTicks` is 0 and it is true
    again.
  - The test must fail without the change. Mutate the guard's increment and
    then the threshold comparison, and record the red output for each.
- **`isJobHealthy`**: an error alone makes it false, a stall alone makes it
  false, and neither makes it true. This stops the route's verdict from
  collapsing back to `lastError === null`.
- **Route unit test** (`src/app/api/health/route.test.ts`, new): mock `@/lib/db`
  and seed `globalThis.__fairYogaJobHealth` with a stalled entry. `GET`
  answers `jobs.<name>.healthy: false` and `status: 'degraded'`. The mutation is
  putting the route back to `lastError === null`.

## Out of scope

- Statement or idle-in-transaction timeouts (option 2), as decided above.
- Per-sweep health inside `isolatedSweeps` jobs. A hung sweep stalls its whole
  job, which is what this reports.
