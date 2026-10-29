# Pool exhaustion reaches the operator (#939)

## Intent

Since #937 the whole process shares one Prisma pool (`DEFAULT_POOL_MAX`, 9 in
production): routes, pages and the scheduler. When it runs dry, a caller waits
`connectionTimeoutMs` (10 s), pg-pool throws its wait timeout, and the caller
answers whatever its own catch answers. Usually that is the 503 "The system
was busy…" copy, plus one `error` log line. Nothing tells the operator. The
first signal of a starved pool would be a teacher saying "it said busy".

Goal: **every pool wait that times out reaches the operator twice: within
minutes as a Better Stack alert, and as a counted, lasting record in the
degradation digest.** Both paths were the owner's choice (brainstorm,
2026-10-29), with option (b) of the issue taken explicitly.

## What was measured (and where the issue was wrong)

Measured on 2026-10-29 at `origin/main` (`0cd0ca51`).

1. **The issue names the wrong place.** It puts the `logDegraded` call "behind
   `withErrorHandler` / `respondError`, not each route". That covers only
   part of the surface:
   - 91 of 94 `src/app/api/**/route.ts` files are wrapped
     (`git ls-files 'src/app/api/**/route.ts' | wc -l` → 94;
     `git grep -l withErrorHandler -- 'src/app/api/**/route.ts' | wc -l` → 91).
   - In request code, 11 `transientDbFailure`/`isTransientDbError` call lines
     across 8 files classify a database failure themselves:
     `account/route.ts` (2), `registrations/[id]/route.ts`,
     `registrations/route.ts`, `waitlist/route.ts`,
     `class-template-lifecycle.ts`, `studio-class-template-lifecycle.ts`,
     `rule-lifecycle.ts` (3), `gdpr.ts`. Re-derive:
     `git grep -n "transientDbFailure(\|isTransientDbError(" -- src ':!*.test.*' ':!src/lib/api-errors.ts'`,
     then drop the sweep services (`notification-retention`,
     `waitlist-reconciliation`, `waitlist-retention`). Whether each one
     swallows or rethrows was not checked; with this design it no longer
     matters.
   - Server-rendered pages never pass through `withErrorHandler`, and
     `instrumentation.ts` has no `onRequestError`.

   A hook on the error wrapper would miss every page render, which is most of
   the traffic.
2. **"`/api/health` stays green" holds only for short exhaustion.** The probe's
   `SELECT 1` goes through the same pool. A probe that lands while the pool is
   dry waits 10 s and answers 503 `db: down`. What it misses is exhaustion
   that starts and ends between two monitor checks. That is the gap this
   closes.
3. **Option (a) alone would report a day late.** The digest runs in
   `daily-cleanup`, once every 24 h (`src/lib/scheduler.ts`).
4. **Adding a degradation code conflicts with the written rule.**
   `docs/degradation-sites.md` ("The rule") says an outage, or a failure the
   user sees as an error, is not a degradation. `MOLLIE_UNAVAILABLE` already
   bends it. This design amends the rule explicitly rather than bending it a
   second time unannounced.
5. **The issue's premises that hold.** `OPERATOR_EMAIL` is set in production
   (owner ran `grep -c ^OPERATOR_EMAIL= /opt/fairyoga/.env` → 1). Scheduler
   jobs already surface their own timeouts through `lastError` and job health.

## Design

### 1. Detect at the pool, once

`createPrismaClient` builds the `pg.Pool` itself and passes the instance to
`PrismaPg`, instead of passing a config object. The pool is a small subclass
whose `connect()` wraps both call forms. pg-pool's own `query()` calls
`this.connect(cb)`, and the adapter calls `pool.connect()` for transactions
and `pool.query()` for plain statements, so both forms are live. When the
error handed back is pg-pool's wait timeout, the subclass calls a new factory
option, `onPoolExhausted`, next to `onPoolError` and `onConnectionError`.

- **The error is untouched.** It reaches its caller exactly as today, so every
  route, page, service `busy` arm and sweep keeps its current answer. The
  classifier is not changed.
- **The hook cannot hurt the caller.** A throw from `onPoolExhausted` is
  caught inside the subclass and dropped. The subclass cannot log it,
  because `prisma-client.ts` imports no logger, so the consumer must not
  throw.
- **What the hook receives.** The pool's counters as the timeout is
  delivered: `waiting`, `total`, `idle` (pg-pool's `waitingCount`,
  `totalCount`, `idleCount`) and `max`. All numbers, nothing personal.
  pg-pool removes the timed-out waiter from its queue before calling back
  (`pg-pool/index.js`, the `setTimeout` in `connect`), so `waiting` counts
  the others still queued and never the one that timed out. The runbook says
  so.
- **Only the wait timeout.** A connect timeout to a silent host is the
  `connection` kind, and the health probe already sees it as `db: down`.
- **Pool ownership is unchanged.** `PrismaPg` ends a pool it was handed only
  with `disposeExternalPool: true`, so the factory passes it. Otherwise
  `$disconnect` would stop closing pools.
- **`instanceof` coupling.** The adapter tests `poolOrConfig instanceof
  pg.Pool` against its own `pg`. Measured: the repo's `pg` and the adapter's
  resolve to the same file (`pg@8.23.1`). If that ever splits, the adapter
  would treat the pool as a config object and build its own pool, and the
  hook would go silent. The end-to-end test below fails in that case, which
  is the guard.
- **Disconnect ends the hook (builder's call, accepted limit).** On
  `$disconnect` with `disposeExternalPool`, the adapter ends the pool and
  forgets it, and a later reconnect builds a plain `pg.Pool` from the stored
  config, without the hook. Production never disconnects the shared client
  (`db.ts`), so this is written down next to the factory option and not
  engineered around. Only test and provisioning clients disconnect.
- **Import funnel.** `prisma-client.ts` is pinned to an import allowlist
  (`prisma-client.test.ts`, "prisma funnel imports"), and `pg-error.ts`
  imports `prisma-client`. So the driver message constants
  (`PG_*_MESSAGE`) move to a new module that imports nothing. `pg-error.ts`
  and `prisma-client.ts` both read from it, and the allowlist grows by that
  module and `pg`. The matching rules stay `isPgPoolTimeout`'s: exact
  message, no own `code`, no Postgres fields.

### 2. Two consumers, wired in `db.ts`

`db.ts` passes `onPoolExhausted: recordPoolExhaustion` from a new
`src/lib/pool-exhaustion.ts`. That function does two things.

**a. The digest record.** It calls
`logDegraded('DATABASE_POOL_EXHAUSTED', counters, message)`. The new code is
`level: 'error'`, matching `TRANSIENT_KIND_LEVEL.pool_exhausted`. Its
`contextKeys` are the four counters above. The existing coalescer bounds the
writes to one per window.

The `DegradationEvent` write needs a connection from the same dry pool. If it
times out:

- the coalescer's `onWriteError` logs it, and nothing throws (`logDegraded`
  is `FireAndForget`);
- the caller's own log line, such as `withErrorHandler`'s, is written
  regardless, because it never depended on this path;
- the write's own timeout trips the hook once more, adding one to the next
  window's count. That is accepted: that write really did meet a dry pool.

**b. The health signal.** It sets `globalThis.__fairYogaPoolExhaustedAt` to
now. It has to live on `globalThis` because the writer is whichever layer
built the shared client (often instrumentation) and the reader is the health
route (the route layer); CLAUDE.md, "State the whole process must share lives
on `globalThis`". The census test enforces this.

### 3. `/api/health`

- `status` is `degraded` while a job is unhealthy, **or** while the last pool
  exhaustion is less than `POOL_EXHAUSTION_HEALTH_WINDOW_MS` = 15 minutes old.
  The owner set the window so it outlasts any monitor interval. The HTTP
  status is unchanged: 200 with `db: up`, as a degraded-by-jobs answer is
  today. That still alerts, because the production monitor is a Better
  Stack **keyword** check for `"status":"ok"` in the body, not a status-code
  check. `DEPLOYMENT.md`'s uptime-monitor step says a monitor must read the
  body's `status`; the plan checks that it does and adds it if not.
- The check reads only process memory, never the database, because the
  database's pool is what is dry.
- The public body stays `{ status, db }`. The detailed body (cron secret)
  adds `pool: { lastExhaustedAt: <ISO string> | null }`.
- **Accepted limit:** a process restart clears the timestamp. The digest row
  still holds the event.

### 4. Docs

- `docs/technical-architecture.md`: "Database errors" and "Where Prisma
  comes from" each state how pool exhaustion reaches the operator (the pool
  hook, the digest, the 15-minute health window) and link to each other
  rather than repeating it. "Degradation events" names this as its one
  operational code.
- `DEPLOYMENT.md` §7 (Monitoring): the `/api/health` bullet says `status` is
  also `degraded` for 15 minutes after a pool exhaustion, and that a monitor
  must match on the body's `status` (a keyword or JSON check), because that
  degraded answer is a 200.
- `docs/degradation-sites.md`: "The rule" gains the amendment, an
  operational fault the operator must hear about even though the user saw an
  error, with this code as its member. The `DEGRADATION_CODES` docblock
  (`src/lib/degradation-codes.ts`), which defines a code as an
  intentional fallback for impossible data, is amended to match and points
  at the rule rather than restating it. A runbook section
  ``### `DATABASE_POOL_EXHAUSTED` `` (backticked, the form
  `degradation-codes.test.ts` requires) covers what the counters mean, what to check
  (long transactions, a sweep holding connections, `poolMax`), and when to
  file the scheduler-only pool #937 set aside.

## Tests (acceptance)

All in the `unit` tier against the test database, using a real
`createPrismaClient({ poolMax: 1, connectionTimeoutMs: <short> })` whose only
connection is held by an open `pg_sleep`.

1. **Hook fires end to end.** A second query on the starved client rejects
   with the pool timeout, and `onPoolExhausted` was called once with the
   counters (`waiting ≥ 0`, `total = 1`, `max = 1`). The same holds for an
   interactive transaction's start.
2. **The answer is unchanged.** A `withErrorHandler`-wrapped handler querying
   the starved client answers 503 with the "The system was busy and could
   not finish that. Please try again." copy (asserted as a literal;
   `TRANSIENT_KIND_MESSAGE` is module-private) and no `code`. `pool_exhausted` carries none; only `connection` does.
3. **One `DegradationEvent`.** Through the real store (the
   `degradation.record.test.ts` pattern), two exhaustions inside one window
   leave one `DATABASE_POOL_EXHAUSTED` row, whose count after the window's
   trailing write is 2.
4. **No throw when the record write is starved.** With `@/lib/db` pointed at
   a starved client, `recordPoolExhaustion` returns normally. The write
   failure reaches `log.error`. No unhandled rejection.
5. **A throwing hook does not reach the caller.** The query still rejects
   with the pool timeout, not with the hook's error.
6. **Health.** The route answers `degraded` with an exhaustion 1 minute old
   and `ok` with one 16 minutes old (fake clock). The public body has exactly
   `{ status, db }`. The detailed body carries `pool.lastExhaustedAt`.
7. **Wiring.** `db.ts` hands `recordPoolExhaustion` to the factory (asserted
   by mocking the factory and reading the options it received).

**Guards to break once each, with the failure text recorded in the PR**:
remove the `logDegraded` call (test 3 fails); remove the `onPoolExhausted`
call in the subclass (test 1); pass the config instead of the pool instance
(test 1); remove the health window check (test 6); drop the subclass's
try/catch (test 5).

## Non-goals

- A scheduler-only pool (#937, Decision 4). File it only if this reporting
  shows `pool_exhausted` in production.
- Changing any caller's 503 copy or classification.
- Telling request-side and scheduler-side exhaustion apart. The hook cannot
  see who waited, and both are worth hearing about.
- Paging on Postgres's `max_connections`.

## Left to the builder

The subclass's TypeScript overload shape for `connect`, the new message
module's name, and the exact log message strings.
