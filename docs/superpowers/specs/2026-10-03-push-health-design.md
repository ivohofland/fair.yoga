# Push health: surface total send failure, and stop a slow push service reading as stalled (#743)

## Premise, as measured

Both halves of the issue hold. Re-derived from the code, not from the issue:

- `push-dispatch` is registered at `intervalMs: 10 * 1000` (`buildJobs`).
- A send's timeout is `DEFAULT_TIMEOUT_MS = 5_000` (`lib/push/send.ts`); the sweep's
  concurrency is `SEND_CONCURRENCY = 4` (`services/push-dispatch.ts`).
- `makeTick` sets `lastError = null` on **any** run that does not throw, so a tick
  whose every send returned `failed` is healthy. `dispatchPushes` throws only for
  a send *fault* (`PushSendFault`), never for a `failed` verdict.
- `isJobHealthy` is `lastError === null && skippedTicks < STALLED_AFTER_SKIPPED_TICKS (2)`.
  A tick landing at t = 10, 20, … while a run is in flight is refused and counted,
  so a run longer than 20 s reports stalled.

Corrections to the issue:

1. **S is not bounded by `PUSH_BATCH`.** `PUSH_BATCH = 50` counts *notifications*;
   each fans out to every subscription of its recipient, up to
   `MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT = 10` (`services/push-subscriptions.ts`). The
   issue's "burst at the batch cap (50 rows)" is 50 sends only for single-device
   recipients; 50 × 10 = 500 sends is reachable, and the tick's duration has no
   ceiling today.
2. **S = 16 is already on the edge**, not S = 17: `ceil(16/4) × 5 s = 20 s` plus DB
   time crosses the second tick.
3. **The issue's list of total-failure causes is incomplete.** A *misconfigured*
   `VAPID_*` (anything but "unset", `diagnoseVapidConfig`) makes `defaultSender()`
   return `null`; the sweep then claims and retires every row with no send at all, so
   `failed` stays 0 and health stays green. That is the issue's first complaint through
   another door, and arguably the likeliest real cause (a bad deploy).

No open PR touches `scheduler.ts` or `api/health/route.ts`.

## Why the obvious shapes are wrong

**Widening the stall threshold is the wrong fix for the slow tick.** It leaves the tick
unbounded (S has no ceiling) and makes a genuinely hung push tick take longer to
report. Bound the tick instead, and the existing threshold of 2 stays right.

**"N consecutive ticks with `sent === 0 && failed > 0`" must not count idle ticks.**
Most ticks send nothing; if an idle tick reset the streak, a low-traffic deployment in
a real outage would never reach N.

**But "red until the next delivery" is wrong too.** `makeTick` clears an error on the
next tick that does not throw; a standing alarm exists only because the job throws on
every tick while the condition holds. With few users, "until the next delivery" can be
many hours, and an alarm that outlives its evidence trains the operator to ignore it.
So the alarm *expires with its evidence*.

## Design

### (b) Claim just in time, and stop claiming at a deadline

Today the claim loop stamps all up-to-50 candidates as handled in a burst and *then*
queues their sends, so a claimed row cannot be given back and the tick runs as long as
the queue does. Change the order:

- A pool of `PUSH_WORKERS = 4` workers shares the candidate list. Each worker loops:
  stop if `now >= tickStart + PUSH_CLAIM_DEADLINE_MS`; take the next candidate; claim it
  (the existing compare-and-swap on `pushHandledAt`); resolve the recipient; send to that
  notification's devices **in parallel** (at most
  `MAX_PUSH_SUBSCRIPTIONS_PER_ACCOUNT` of them); record each outcome; repeat.
- A candidate nobody reached before the deadline keeps `pushHandledAt: null` and is read
  next tick. `PUSH_STALE_AFTER_MS` (15 minutes) still bounds how long one can wait, and
  a row is only ever deferred *unclaimed*: a claimed row is never retried, so the deadline
  never drops a claimed send. (A read that throws after the claim, such as the recipient
  or subscription lookup, still leaves the row stamped and unsent and rejects the tick;
  the claim has always come first.)
- `PUSH_CLAIM_DEADLINE_MS = 10 s` (one tick interval). A worker that claims at the last
  moment finishes within one send timeout, so the **worst tick is
  10 s + 5 s = 15 s plus DB time**, under the 20 s stall line with 5 s to spare. At
  most one tick interval is refused (`skippedTicks <= 1 < 2`), so on the steady 10 s
  grid a timeout burst of any size stays healthy, with `STALLED_AFTER_SKIPPED_TICKS`
  unchanged and hang detection still ~20 s. `scheduleJobs` registers no 15 s boot
  one-off for a job whose interval is no longer than that, so the push job has no
  off-cadence first tick either.
- Both figures come from exported constants (`PUSH_CLAIM_DEADLINE_MS`, the send timeout
  newly exported from `lib/push/send.ts`, the job's `intervalMs`); a test asserts
  `deadline + timeout < STALLED_AFTER_SKIPPED_TICKS × intervalMs`, so retuning one of
  them cannot silently recreate the false stall.
- **The cost, stated:** during a total outage a tick works through at most
  `4 workers × ceil(10 s / 5 s) = 8` notifications (every send timing out), deferring
  the rest; the rest are then served, or retired as stale after 15 minutes. That is the
  outage case only. Healthy sends take milliseconds and the deadline never binds.
- Send concurrency changes from "4 sends at once" to "4 notifications at once, each
  fanning out to at most 10 devices": at most 40 requests in flight, to push services
  that serve millions. `createConcurrencyLimit` is no longer used by this sweep.

### (a) Total send failure: a streak that expires with its evidence

State (module-level, one production instance, the way `waitlist-reconciliation` holds
its streaks): `{ failedTicks: number; lastFailedAt: number | null }`.

- `PushDispatchResult` gains `unsendable`: the rows a tick claimed while the sender was
  `null` for a misconfiguration (`reason !== 'unset'`). A deployment with no `VAPID_*`
  has chosen not to offer push and stays neutral, as today.
- `observePushTick(state, result, nowMs)` — pure:
  - `result.sent > 0` → `failedTicks = 0` (some device works: not a total failure).
  - else `result.failed > 0 || result.unsendable > 0` → `failedTicks += 1`,
    `lastFailedAt = nowMs`.
  - else (idle, or only `gone` / `invalid`) → unchanged. `gone` and `invalid` are
    verdicts on one subscription; the push service answered, so they are not evidence
    of a broken service.
- `pushAlarm(state, nowMs)` — pure: `failedTicks >= PUSH_MAX_FAILED_TICKS (3)` **and**
  `nowMs − lastFailedAt < PUSH_ALARM_QUIET_MS`.
- `PUSH_ALARM_QUIET_MS = PUSH_STALE_AFTER_MS` (15 minutes): the same figure already
  means "after this a push describes a moment that has passed".
- `runPushDispatchTick(db)` (the job's `run`): `dispatchPushes` → `observePushTick` →
  if `pushAlarm`, throw `PushDispatchDegradedError`. It runs on **every** tick, idle
  ones included, which is what makes the alarm clear on its own: 15 minutes after the
  last failed send the next idle tick returns normally and `makeTick` nulls the error.
  The count restarts at one once its last failed tick is a quiet window old, so one
  failed send an hour later starts a new streak instead of re-raising the alarm. A
  delivery resets the count, even from a tick that also failed elsewhere: the alarm says
  push delivers nothing. A tick whose dispatch throws counts as a failed tick and
  rethrows its own fault. A restart resets everything (in-memory, like the
  reconciliation streaks).

**The bound, stated:**

| Traffic | `/api/health` degraded after |
|---|---|
| continuous, sends fail fast (401/403, misconfiguration) | the 3rd failed tick ≈ 20 s after the first begins |
| continuous, every send times out | the 3rd failed tick: a 15 s tick refuses the next 10 s tick, so ticks start 20 s apart and the 3rd ends ≤ 2 × 20 s + 15 s = 55 s after the first begins |
| sparse | the 3rd failed tick, each within a quiet window of the last: with no traffic nothing can be observed, and the only alternative is an active probe, which this issue does not build |

and it clears 15 minutes after the last failed send, or at the next delivery.

**Accepted:** while the alarm stands the job throws on each 10 s tick, so `makeTick`
logs one `error` per tick, which in the 15-minute tail after the last failed send is up
to 90 lines. During the outage itself each failed send already logs a `warn`, which is
far more. Reconciliation behaves the same; quieter means changing `makeTick`, which
this issue does not do.

## Tests (each guard mutated, per the project rule)

- `observePushTick` / `pushAlarm`: table over `sent`, `failed`, `gone`, `invalid`,
  `unsendable` combinations; the N−1 → N edge; the exact quiet-window edge
  (`< PUSH_ALARM_QUIET_MS` vs `<=`); idle neutral; a delivery resets; the count restarts
  at one after expiry; a thrown dispatch counts as a failed tick.
- `dispatchPushes`: with a stub sender that never settles within the deadline (fake
  clock) and 20 notifications × 10 devices, a tick claims only what the workers reached
  and leaves the rest `pushHandledAt: null`; the next tick picks them up; no claimed row
  is left without an outcome. A misconfigured sender (not `unset`) yields
  `unsendable === claimed`; an `unset` one yields 0.
- Scheduler: the push job is still stalled at `STALLED_AFTER_SKIPPED_TICKS`, unchanged,
  and the derivation test above pins `deadline + timeout` under it.
- `runPushDispatchTick`: throws on the third failed tick, keeps throwing on idle ticks
  inside the window, stops at the window edge, re-throws on the next failure.

## Docs

`docs/technical-architecture.md`, Cron Jobs → the Push dispatch row: the claim deadline
and the worst-tick arithmetic, the bound table above, the expiry rule, and that a
misconfigured `VAPID_*` now counts.

## What this does not do

- **Per-send `warn` and the per-tick `info` line are unchanged** (spec §3.2).
- **No active probe**, so sparse traffic is a tick count, not a duration.
- **#727 is unaffected.**
