# The counts-both-attempts timeout is client-side, not Postgres (#512) — design

**Issue:** #512 — "`handoff.test.ts`'s 'counts both attempts' race times out at
5000ms, ~2.6% of isolated runs"
**Branch:** `fix/512-handoff-timeout-flake`, from `origin/main` at `68c21ea1`
**Date:** 2026-09-08
**Measured on:** darwin 25.6.0, 10 physical cores, node v22.22.2, vitest
4.1.10, Postgres 16 (`fairyoga-db-1`), database `ethical_yoga_test`

---

## 1. The issue's premise, checked

The issue's own measurements (batches A-D, ~2.6% across 78 isolated runs,
discrete stall rather than a slow path getting slower) are reproduced here
independently, and hold. This spec adds the measurement the issue names as
its own suggested first step — distinguishing "stuck in Postgres" from "stuck
before Postgres" — plus one negative control the issue did not have.

## 2. Reproduction, this session

150 consecutive invocations of

```
npx vitest run --project unit src/lib/auth/handoff.test.ts -t "counts both attempts"
```

(the file alone, one test selected) produced **1 timeout in 150** —
vitest reported `5007ms` and `Duration 6.38s` (vitest's own internal timers) —
consistent with the issue's ~2.6% within binomial noise. Per-iteration wall
time (external measurement including process-spawn overhead) was otherwise
tight: min 1.97s, median 2.19s, and the one failure at 7.14s — the same
bimodal shape (fast, or +5s, nothing between) the issue's batch D reported,
re-derived on a fresh sample.

## 3. Negative control: the same query pattern, outside vitest

A standalone script (`tsx`, not vitest — no worker-thread pool, no test
transform pipeline) replicated `claimWithCode`'s exact query sequence —
`findMany`, then `updateMany` incrementing the row, then `deleteMany`
re-checking the budget — fired four-way concurrent against the same
`ethical_yoga_test` database, once per iteration, for **400 iterations: 0
slow (>800ms), all four-call rounds completing in 4-25ms.**

This localizes the mechanism: the query pattern itself, run in a plain Node
process against real Postgres under real concurrency, is not what stalls.
Something specific to running it *through vitest* is.

## 4. The stall is client-side: pg_stat_activity is silent throughout it

During the 150-run loop, a second process polled

```sql
select pid, state, wait_event_type, wait_event, query, now() - query_start
from pg_stat_activity
where datname = 'ethical_yoga_test' and pid <> pg_backend_pid() and state <> 'idle'
```

every ~150ms over a separate `docker exec`, independent of the vitest
process's own connections. For the captured failure — the whole `npx vitest
run` process's measured lifetime, epoch 1788875840.36 to 1788875847.50, the
same ~7.14s external wall time §2 reports — **the sampler recorded zero
non-idle rows for the entire process lifetime**, not from this test's own
connections and not from any other session. The nearest bracketing samples
(taken every ~150ms) sit outside that window on both sides with nothing
in between; the sampler ran continuously and does not distinguish
process-startup time from the test's own 5007ms, so the claim covers the
whole process, not a carved-out sub-window inside it.

That rules out, by direct observation rather than elimination, every
Postgres-side candidate the issue still had open: a lock wait would show
`state=active, wait_event_type=Lock`; an IO stall shows as `wait_event_type=IO`;
neither appeared, and no query text belonging to this test appeared at all.
**The four `claimWithCode` calls never reached Postgres during the stall.**
This is exactly the "absent from `pg_stat_activity` for those five seconds"
outcome the issue named as closing most of its own "not ruled out" list in
one measurement.

## 5. What's left: event-loop/scheduling delay specific to the vitest worker

Combining §3 and §4: the delay is not in Postgres, and it is not inherent to
the query pattern under concurrency (the standalone control ran the identical
pattern 400 times without a single slow round). What differs is the
execution context — a vitest `forks` worker process, under whatever else is
scheduled on the same machine at that moment, versus a bare `tsx` process
with nothing else asked of it.

This session's own machine was independently observed to be running
significant concurrent Postgres load from other processes at the time: a
separate sample of `pg_stat_activity` taken minutes into this same
investigation showed **269 distinct backend PIDs** touching tables no test in
this file ever writes (`Class`, `Teacher`, `ScheduleRule`, `CalendarEntry`,
`WaitlistEntry`, `Account`, ...) inside a 40-second span, then falling silent
— i.e., other work (this machine runs several concurrent development
worktrees against the same Postgres container) was concurrently hammering
the *same* Postgres instance, and by extension contending for the same host
CPU/IO the vitest worker needs to run its own event loop. The captured
failure itself landed in a quiet stretch of that same log — consistent with
host-level scheduling contention (which needn't correlate second-for-second
with database query volume) rather than database-level lock contention,
and consistent with why a `pg_stat_activity`-only check would find nothing
even though the surrounding machine is demonstrably not idle.

**Named, not further decomposed:** *which* host-level resource (CPU
scheduling of the worker thread, or the delay in establishing new
connections through Docker's network path when three additional Postgres
connections are opened at once by this test's `Promise.all`) is the
proximate cause is not separated further here. Both are consistent with
every measurement above; neither is a defect in `claimWithCode`, in its
query design, or in this test's assertions — the same four-way concurrent
pattern is provably fast (§3) with nothing else competing for the host.
Splitting the two would need OS-level scheduler tracing this issue's
acceptance criteria does not ask for, on a stall this session could catch
only once.

## 6. The fix: this test's own timeout, not the harness default

A bare number as `it(name, fn, timeout)`'s third argument, overriding
vitest's 5000ms default for one test, is this codebase's existing idiom for
exactly this shape of problem. `gdpr.test.ts`, `class-transitions.test.ts`,
`waitlist-lock-order.test.ts`, `roster-link.test.ts`,
`template-room-race.test.ts`, and both
`rooms-api.test.ts`/`teacher-rooms-api.test.ts` in `tests/integration/`
already carry a per-test `15_000`-`30_000` override for the same reason —
`rooms-api.test.ts`'s own comment: "vitest's default testTimeout is 5000ms
and would otherwise win, replacing this assertion with a generic timeout
that reads as flake." `rule-lifecycle.ts` documents the same underlying
phenomenon from the other side, in prose rather than a per-test override —
its own service-code comment on a Prisma transaction warns a future reader
not to misread vitest's masking behavior as the real budget: "Under vitest
it looks like 5s instead, because vitest's own default `testTimeout` is
5000ms and fires first — a property of the harness, not of Prisma or of
this code." (`{ timeout: N }` as an *options object* also appears
throughout these files, but that shape is Prisma's own `$transaction(fn,
options)` timeout, a different API the same files also happen to use — not
this one.)

**What the new bound protects against:** the same class of delay measured in
§4-5 — a multi-second client-side scheduling stall on a busy development or
CI host, unrelated to whether `claimWithCode` completed correctly. **Why
5000ms was not enough:** it assumes the whole round-trip (four real Postgres
queries) completes in the tens of milliseconds it takes uncontended (§2's
median: 2.19s total process wall time, of which the test body itself is
single-digit milliseconds) — a margin the captured stall exceeded outright,
landing on the default's exact ceiling with room to have run longer had the
harness not cut it off.

**Chosen value: 20,000ms**, i.e. `it('counts both attempts...', async () =>
{ ... }, 20_000)`. This session captured exactly one occurrence, truncated at
the default's own boundary, so the true tail is unmeasured; a flat 4x margin
sits inside this codebase's own range for the same kind of headroom
(`15_000` in `gdpr.test.ts`/`class-transitions.test.ts` up to `60_000` in
`waitlist-reconciliation.test.ts`), without reaching for that file's high
end, which those tests justify by an intentionally held lock or an
intentional multi-second `setTimeout` this test has no equivalent of. This is
scoped to the two affected tests (§9) — not `vitest.config.ts`'s global
default — so a genuine hang elsewhere in the file still fails fast.

## 7. Verification

1. **The mutation still bites.** A real hang must still fail, at the new
   ceiling: temporarily make `claimWithCode`'s no-match branch `await new
   Promise(() => {})` (never resolves), confirm the test now fails at
   ~20,000ms rather than 5,000ms, then restore.
2. **The flake is re-measured, per the issue's own acceptance criterion.** 40
   consecutive `npx vitest run --project unit src/lib/auth/handoff.test.ts`
   with zero timeouts. Given the measured ~1/150-2/78 rate, this bounds the
   remaining risk of a stall exceeding even 20,000ms as very low, without
   claiming it is zero — the mechanism (host/event-loop contention, §5) is
   named with the measurement that establishes it, per the issue's
   acceptance criteria; this is not "a change that makes the symptom stop
   appearing" with no mechanism behind it.
3. `npm run typecheck`, `npm run lint`, and the unit and component tiers are
   green locally. Integration and e2e cannot run from a worktree (no `:3000`,
   no dev database) — CI is the signal for those tiers, cited in the PR body.

## 8. Out of scope

- **Reducing the stall's likelihood** (e.g., changing the query shape, or
  Prisma's connection pool sizing) — §5 found no code-side defect to fix;
  doing so without a pinned proximate cause would be tuning against a
  guess.
- **Splitting host-CPU-contention from connection-establishment-delay** as
  the proximate trigger (§5) — both are consistent with the measurements
  above and neither changes the fix.
- This branch does not touch `claimWithCode`, `verifyWithHandoff`, or any
  test's assertions — only two tests' timeouts (§9) change.

## 9. A second test hit the same mechanism, found during PR review

The `pr-review-toolkit` test-coverage review of this branch's PR pointed out
that `'the race: a correct claim concurrent with wrong guesses never
throws'` (same file, same `describe` block) does substantially MORE
concurrent-Postgres work per run than the test this spec fixes — an 8-loop
of up to 4 concurrent `claimWithCode` calls, plus three more staged
two-way races immediately after — and was never checked against the same
mechanism, despite being at least as plausible a candidate.

Measured the same way as §2: 100 consecutive isolated runs of that test
alone produced **1 timeout in 100** — `5007ms`, vitest's own `Duration
6.23s`, the identical signature (down to the millisecond) as the failure
captured in §2 — against a tight bimodal spread otherwise (min 2.03s,
median 2.20s, the one failure at 6.93s). This is the same client-side
stall (§3-5), not a new mechanism, so it gets the same fix: a `20_000`
per-test timeout override, added to this test alongside the one §6
originally targeted. No further investigation was needed — the mechanism,
the negative control, and the `pg_stat_activity` finding above apply
identically; only the reproduction needed repeating on the new target to
confirm it before applying the same fix blind.
