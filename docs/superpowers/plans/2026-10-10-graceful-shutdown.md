# Graceful shutdown — plan (#816)

Spec: `docs/superpowers/specs/2026-10-10-graceful-shutdown-design.md`.

Order matters: Task 1 creates the module Tasks 2 and 3 import. Tasks 2 and 3
are independent of each other. Task 4 describes what 1–3 built.

Every task is test-first: write the test, run it, see it fail for the stated
reason, implement, see it pass. Each "prove it bites" step: break the guard,
record the exact failure text in the commit body or the task report, restore,
re-run green.

Unit runs: `pnpm exec vitest run <path>`. Whole gate: `pnpm run verify`.

## Task 1 — `src/lib/shutdown.ts` and its wiring

Files: `src/lib/shutdown.ts` (new), `src/lib/shutdown.test.ts` (new),
`src/instrumentation.ts`.

Behaviour (spec, `src/lib/shutdown.ts`): state on
`globalThis.__fairYogaShutdown` (declare it with `declare global`, as
`__fairYogaSseCounts` is in the stream route); `isShuttingDown`, `onShutdown`
(returns unsubscribe; runs `fn` at once when already shutting down),
`beginShutdown` (idempotent; each subscriber once; a throwing subscriber is
logged through `@/lib/log` and the rest still run), `installShutdownSignal`
(takes an `EventEmitter`-shaped target defaulting to `process`; `once` on
`SIGTERM` and `SIGINT`; a second call installs nothing).

Tests, each resetting the global in `afterEach`:
- not shutting down by default; `beginShutdown` flips it
- subscribers run once each, even if `beginShutdown` is called twice
- an unsubscribed handler does not run
- a subscription after shutdown runs immediately
- one throwing subscriber: the others still run, the error is logged
- `installShutdownSignal` on a fresh `EventEmitter`: emitting `SIGTERM`
  begins shutdown; emitting `SIGINT` on another fresh one does too;
  installing twice leaves one listener per signal (`listenerCount`)

`instrumentation.ts`: call `installShutdownSignal()` in the nodejs branch,
before `startScheduler()`, via dynamic import like the scheduler (keeps the
edge runtime clean). Update its docblock to say it also installs the shutdown
signal (link the architecture section by name, no lists).

Prove it bites: remove the idempotency guard in `beginShutdown` → the
"once each" test fails; restore.

## Task 2 — the stream route ends on shutdown

Files: `src/app/api/notifications/stream/route.ts`,
`src/app/api/notifications/stream/route.test.ts`.

Behaviour (spec, "The stream route"): 503 when shutting down, checked after
`validateSession` and before the 429 check, subscribing nothing and not
counting; inside `start`, `onShutdown(cleanup)` as the last step, `cleanup`
calls the unsubscribe.

Tests (extend the existing file; reset `globalThis.__fairYogaShutdown` in
`afterEach`):
- two open streams; `beginShutdown()`; both bodies reach `done`, and
  `notificationBus.listenerCount('notification')` is back to its pre-open value
  and `__fairYogaSseCounts` has no entry for the account
- a request after `beginShutdown()` answers 503, adds no bus listener, and
  leaves the count map untouched
- cleanup runs exactly once per stream across paths: open streams A and B for
  the same account, spy on `notificationBus.offNotification`; abort A → count
  reads 1; `beginShutdown()` → B closes, count entry absent, and
  `offNotification` was called exactly twice in total (once per stream — A's
  cleanup did not run again on shutdown)
- the existing keepalive/invalid-session tests keep passing unchanged

Prove it bites: drop the `onShutdown(cleanup)` subscription → the first test
fails (body never done); restore. Move the 503 check before the `await` only
(remove the post-await one) and start shutdown while `validateSession` is
pending → a test asserting refusal fails; keep that test.

## Task 3 — the scheduler stops starting ticks

Files: `src/lib/scheduler.ts`, `src/lib/scheduler.test.ts`.

Behaviour (spec, "The scheduler — decision"): `makeTick`'s returned function
returns before running the job when `isShuttingDown()`, without changing
`skippedTicks`, `lastRunAt` or `running`. Update `makeTick`'s docblock and the
file header's design-decisions list with one line: a tick does not start once
shutdown begins, and one in flight is abandoned at exit (link the architecture
section).

Tests: after `beginShutdown()`, a tick does not call `job.run`, and the health
entry is unchanged; a tick before shutdown still runs (existing tests cover).

Prove it bites: remove the check → the new test fails; restore.

## Task 4 — docs and the compose comment

Files: `docs/technical-architecture.md`, `docker-compose.prod.yml`.

- New `### Shutdown` under `## Deployment` (after `### Production compose`):
  the sequence — signal → Next's `server.close()` begins, our listener begins
  shutdown → each stream runs its cleanup, new streams get 503, no new
  scheduler tick starts → `server.close()` completes once ordinary requests
  finish → `process.exit(143)`. Why `NEXT_MANUAL_SIG_HANDLE` stays unset, why
  an in-flight tick is abandoned rather than awaited (spec's reasoning, short),
  and that `stop_grace_period` is the backstop.
- `## Cron Jobs`: one sentence — no tick starts after shutdown begins; link
  the section.
- `## Real-Time Updates`: one sentence — a stream also ends when the server
  shuts down; link the section.
- `docker-compose.prod.yml`: the comment above `stop_grace_period` says the
  app ends its streams on SIGTERM and exits by itself, and that this value is
  the backstop for a request that does not finish.

## Task 5 — measure on a production build (controller, not a subagent)

`pnpm run build`; run the standalone server on a spare port against the
worktree's dev database; mint a session (verify skill); open a stream with
`curl -N`; `kill -TERM` the server; record elapsed time to exit and the exit
code. Repeat on `origin/main`'s build for the before figure if time allows,
otherwise cite the issue's measurement. Result goes in the PR body.
