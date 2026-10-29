# Pool exhaustion reporting Implementation Plan (#939)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every pg-pool wait timeout reaches the operator: as a `DATABASE_POOL_EXHAUSTED` degradation event (the daily digest), and as `status: "degraded"` on `/api/health` for 15 minutes (the Better Stack keyword alert).

**Architecture:** `createPrismaClient` builds its own `pg.Pool` subclass, whose `connect()` reports pg-pool's wait timeout to a new `onPoolExhausted` option and passes the error on unchanged. `db.ts` wires that option to `recordPoolExhaustion` (new `src/lib/pool-exhaustion.ts`), which calls `logDegraded` and stamps a `globalThis` holder. `/api/health` reads only that holder.

**Tech Stack:** TypeScript strict, Prisma 7 + `@prisma/adapter-pg` 7.10.1, `pg` 8.23.1 / `pg-pool` 3.14.0, vitest (`unit` tier has a real test database).

**Spec:** `docs/superpowers/specs/2026-10-29-pool-exhaustion-reporting-design.md`

## Global Constraints

- Node 24: before any `pnpm`, `export PATH=~/.nvm/versions/node/v24.21.0/bin:$PATH`.
- Window: `POOL_EXHAUSTION_HEALTH_WINDOW_MS = 15 * 60_000`.
- Degradation code `DATABASE_POOL_EXHAUSTED`, `level: 'error'`, `contextKeys: ['waiting', 'total', 'idle', 'max']`.
- The pool's error reaches its caller unchanged; no classifier or 503 copy changes.
- The 503 copy is the literal `'The system was busy and could not finish that. Please try again.'`; `pool_exhausted` answers carry no `code`.
- `/api/health`'s public body stays exactly `{ status, db }`; HTTP status stays 200 when `db: up`.
- The health check never touches the database for the pool signal.
- Process-wide state uses `globalThis.__fairYoga… ??=` (CLAUDE.md; `src/lib/process-state-census.test.ts` enforces it).
- CLAUDE.md *Comment Discipline*: no counts or rosters in comments; cross-module facts go in `docs/` and the comment links there.
- Stage exact paths; never `git add -A`. Commit messages end with the `Co-Authored-By` trailer.

## Review Focus

1. **The hook firing on the callback path only.** `pool.query()` reaches `connect(cb)`, and a transaction start reaches `connect()` with a promise. A subclass that wraps only one form goes silent for the other half of the traffic. Task 1's tests cover both.
2. **A hook that throws, or a `recordPoolExhaustion` that throws.** That must never replace the pool timeout the caller sees, and must never become an unhandled rejection. Task 1 test "a throwing hook…" pins it.
3. **A non-timeout connect error** (`Cannot use a pool after calling end`, a connect timeout to a silent host). It must not fire the hook. Task 1 test "connect errors that are not the wait timeout…" pins it.
4. **`$disconnect` must still close the pool.** If `disposeExternalPool` is omitted, test processes hang or leak connections. Task 1 test "disconnect ends the pool it was handed" pins it.
5. **Health at the window edge, and a never-exhausted process.** `null` reads `ok`. Exactly 15 min old reads `ok`, because the window is strict. Task 3 pins both.

---

### Task 1: The pool reports its own wait timeout

**Files:**
- Create: `src/lib/pg-messages.ts`
- Modify: `src/lib/pg-error.ts` (the three `PG_*_MESSAGE` constants move out; `pg-error.ts` imports and re-exports them so `pg-error.test.ts` and `tests/adapter-errors.ts` keep importing from `@/lib/pg-error`)
- Modify: `src/lib/prisma-client.ts`
- Test: `src/lib/prisma-client.test.ts`

**Interfaces:**
- Produces, in `src/lib/prisma-client.ts`:
  - `export interface PoolCounters { readonly waiting: number; readonly total: number; readonly idle: number; readonly max: number }`
  - `PrismaClientFactoryOptions.onPoolExhausted?: (counters: PoolCounters) => void`. Its docblock says it is heard when a caller's wait for a pooled connection times out, that a throw from it is dropped, and that it does not survive `$disconnect` + reconnect, because the adapter rebuilds a plain pool (spec §1).
- Produces `src/lib/pg-messages.ts`: `PG_POOL_TIMEOUT_MESSAGE`, `PG_CONNECT_TIMEOUT_MESSAGE`, `PG_CONNECTION_TERMINATED_MESSAGE`, with their existing values and docblocks. The module imports nothing.

- [ ] **Step 1: Write the failing tests** in `prisma-client.test.ts`, in a new `describe('createPrismaClient onPoolExhausted', …)`. Each test builds `createPrismaClient({ poolMax: 1, connectionTimeoutMs: 300, onPoolExhausted })` and holds the one connection with an un-awaited `$queryRaw\`SELECT pg_sleep(1.5)\``. Each awaits the sleep and `$disconnect`s in `finally`.
  - `'hears a plain query that times out waiting for the pool, with the pool counters'`: the second `$queryRaw\`SELECT 1\`` rejects. Walking the error's `cause` chain finds an `Error` whose message is `PG_POOL_TIMEOUT_MESSAGE`, or `transientDbFailure(err)?.kind === 'pool_exhausted'` (import from `@/lib/api-errors`). The hook was called once with `{ waiting: expect.any(Number), total: 1, idle: 0, max: 1 }`.
  - `'hears an interactive transaction whose start times out'`: `client.$transaction(async (tx) => tx.$queryRaw\`SELECT 1\`)` rejects, and the hook was called once.
  - `'a throwing hook does not replace the error the caller sees'`: the hook is `() => { throw new Error('hook boom') }`. The query rejects with the pool timeout (classified `pool_exhausted`), never with `'hook boom'`, and the test registers no `unhandledRejection` (listen on `process` for the test's duration).
  - `'connect errors that are not the wait timeout do not fire the hook'`: `createPrismaClient({ url: 'postgresql://u:p@203.0.113.1:5432/none', connectionTimeoutMs: 300, onPoolExhausted })`. The query rejects and the hook was not called.
  - `'disconnect ends the pool it was handed'`: after `$disconnect()`, `SELECT count(*) FROM pg_stat_activity WHERE application_name = <a unique name>` from a second client reads 0. Set the name with `?application_name=` on the test client's url, built from `process.env.DATABASE_URL`.
  - `'answers a withErrorHandler route 503 with the busy copy and no code'`: `withErrorHandler(async () => { await starved.$queryRaw\`SELECT 1\`; return NextResponse.json({}) })` (from `@/lib/api-utils`), called with `new NextRequest('http://localhost:3000/api/x')` (a GET, so no cross-origin refusal). The response is 503 with body `{ error: 'The system was busy and could not finish that. Please try again.' }` and no `code` key. First check `sendError`'s body shape in `src/lib/api-utils.ts` and match it.
  - Update the funnel test: the name becomes `'prisma-client.ts imports only the generated client, @prisma/adapter-pg, pg, ./pg-messages and node:os'`, and `ALLOWED` gains `'pg'` and `'./pg-messages'`.

- [ ] **Step 2: Run, see them fail.** Run `pnpm exec vitest run --project unit src/lib/prisma-client.test.ts`. Expected: the hook tests fail with the hook called 0 times (the option is ignored), and the funnel test passes until Step 3.

- [ ] **Step 3: Implement.**
  - Move the constants to `pg-messages.ts`.
  - In `prisma-client.ts`, add a non-exported `class ExhaustionReportingPool extends pg.Pool`, constructed with the `PgPoolConfig` and the hook. It overrides `connect` for both overloads: with a callback it calls `super.connect` with a wrapping callback, and without one it returns `super.connect().catch(…)` that rethrows. On an error that is `instanceof Error`, whose `message === PG_POOL_TIMEOUT_MESSAGE` and has no own `code`, it calls the hook inside `try {} catch {}` with `{ waiting: this.waitingCount, total: this.totalCount, idle: this.idleCount, max: config.max }`. A one-line comment says the error here is pg-pool's own and unwrapped, which is why the message check suffices, and points to `isPgPoolTimeout` (`pg-error.ts`) for the full rules.
  - `createPrismaClient` passes `new PrismaPg(new ExhaustionReportingPool(pool, options.onPoolExhausted), { …existing hooks, disposeExternalPool: true })`.
  - Keep `poolConfigFor`'s return value and `transactionOptionsFor(pool)` as they are.
  - The overload typing is the builder's call. No `any`; an `as` only where pg's overload set leaves no alternative, with a one-line reason.

- [ ] **Step 4: Run, see them pass.** Run `pnpm exec vitest run --project unit src/lib/prisma-client.test.ts src/lib/pg-error.test.ts`, then `pnpm exec tsc --noEmit`. Expected: all pass, no type errors.

- [ ] **Step 5: Prove the guards bite.** Do each mutation once, record the failing test name and its exact assertion text in the task report, then restore:
  - (a) remove the hook call;
  - (b) pass `pool` (the config object) to `PrismaPg` instead of the instance;
  - (c) remove the `try/catch` around the hook;
  - (d) drop `disposeExternalPool: true`;
  - (e) wrap only the callback form.

  Re-run green after restoring.

- [ ] **Step 6: Commit.** Stage `src/lib/pg-messages.ts src/lib/pg-error.ts src/lib/prisma-client.ts src/lib/prisma-client.test.ts` and commit with the message `feat: the Prisma pool reports its own wait timeout to onPoolExhausted (#939)`.

---

### Task 2: Pool exhaustion becomes a degradation event, wired into the shared client

**Files:**
- Create: `src/lib/pool-exhaustion.ts`
- Create: `src/lib/pool-exhaustion.test.ts`
- Modify: `src/lib/degradation-codes.ts` (new code and amended header docblock)
- Modify: `src/lib/db.ts`
- Modify: `docs/degradation-sites.md`

**Interfaces:**
- Consumes: `PoolCounters` and `onPoolExhausted` from Task 1.
- Produces, in `src/lib/pool-exhaustion.ts` (which imports `server-only` through `@/lib/degradation`):
  - `export const POOL_EXHAUSTION_HEALTH_WINDOW_MS = 15 * 60_000`
  - `export function recordPoolExhaustion(counters: PoolCounters): void`. It stamps `lastAt = new Date()` on the holder, then calls `logDegraded('DATABASE_POOL_EXHAUSTED', counters, 'a database query timed out waiting for a pooled connection')`.
  - `export function lastPoolExhaustionAt(): Date | null`
  - `export function poolExhaustedWithin(now: Date): boolean`. It is true iff `lastAt !== null && now.getTime() - lastAt.getTime() < POOL_EXHAUSTION_HEALTH_WINDOW_MS`.
  - The holder: `declare global { var __fairYogaPoolExhaustion: { lastAt: Date | null } | undefined }` and `const state = (globalThis.__fairYogaPoolExhaustion ??= { lastAt: null })`. Its comment says the writer is whichever bundle layer built the shared client and the reader is the health route (CLAUDE.md, process-wide state).

- [ ] **Step 1: Write the failing tests** in `pool-exhaustion.test.ts`. Use the `degradation.record.test.ts` pattern: `vi.resetModules()`, `vi.doMock('@/lib/degradation-store', () => vi.importActual(...))`, and spy on `log.error`/`log.warn`. Delete `DATABASE_POOL_EXHAUSTED` rows before and after.
  - `'a request starved of a connection answers the busy 503 and leaves one DegradationEvent row'`. This is the issue's acceptance test.
    - Build a starved client (Task 1's recipe) with `onPoolExhausted: recordPoolExhaustion`, and drive a `withErrorHandler`-wrapped handler on it. Assert the 503 copy.
    - `vi.waitFor` a single `DATABASE_POOL_EXHAUSTED` row with `occurrences === 1` and sample keys exactly `['idle', 'max', 'total', 'waiting']`.
    - Assert `lastPoolExhaustionAt()` is non-null.
  - `'a second exhaustion inside the window reaches the row after the window'`. Drive a second starved request within 60 s, then advance past `COALESCE_WINDOW_MS`. Use `vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })` set **after** both requests have settled, then `vi.advanceTimersByTime(COALESCE_WINDOW_MS)`, then restore real timers before polling. Assert `occurrences === 2`. This is the "one event after the coalesce window" criterion: still one row, and the count carries both.
  - `'does not throw when the event write itself cannot get a connection'`. `vi.doMock('@/lib/db', () => ({ prisma: starved }))`, where `starved` has its one connection held. Calling `recordPoolExhaustion({ waiting: 1, total: 1, idle: 0, max: 1 })` returns `undefined` without throwing. `log.error` is then (via `vi.waitFor`) called with a message `'could not record a degradation event; the log line is all there is'` and `code: 'DATABASE_POOL_EXHAUSTED'`. The `error`-level log line from `logDegraded` itself was written first. No `unhandledRejection`.
  - `'poolExhaustedWithin is false before any exhaustion, true inside 15 minutes, false at 15 minutes'`. Set `globalThis.__fairYogaPoolExhaustion = { lastAt: … }` directly, and reset it in `afterEach`.
  - `'db.ts hands recordPoolExhaustion to the factory'`. `vi.doMock('@/lib/prisma-client', …)` captures the options `createPrismaClient` received, with `globalThis.__fairYogaPrisma = undefined` before importing `@/lib/db`. Assert `options.onPoolExhausted === recordPoolExhaustion`, taken from the same fresh module graph. Restore the global after.

- [ ] **Step 2: Run, see them fail.** Run `pnpm exec vitest run --project unit src/lib/pool-exhaustion.test.ts`. Expected: it fails to import `./pool-exhaustion`, or `DATABASE_POOL_EXHAUSTED` is not a registered code.

- [ ] **Step 3: Implement.**
  - Add the code to `DEGRADATION_CODES`. Its description says that a query waited the pool's full timeout for a connection and failed, that the user saw the busy 503 or an error page, that a sweep may have failed the same way, and that `waiting` excludes the waiter that timed out.
  - Amend the header docblock: a code names an intentional fallback **or** one of the operational faults `docs/degradation-sites.md` ("The rule") admits. Link the rule; do not restate it.
  - Create `pool-exhaustion.ts`.
  - In `db.ts`, add `onPoolExhausted: recordPoolExhaustion`.

- [ ] **Step 4: Update `docs/degradation-sites.md`.**
  - "The rule": add a third reading. An operational fault that users meet as an error, and that nothing else reports in time, may be recorded so the operator is told. It is admitted per code. `DATABASE_POOL_EXHAUSTED` is admitted because the request-side failure has no other channel.
  - Add a runbook section with the heading ``### `DATABASE_POOL_EXHAUSTED` ``. It covers:
    - what `waiting`, `total`, `idle` and `max` mean, and that `waiting` excludes the one that timed out;
    - that `/api/health` reads `degraded` for 15 minutes after the last exhaustion;
    - what to check: `pg_stat_activity` for long or idle-in-transaction sessions, a sweep holding connections, and `poolMax` (`docs/technical-architecture.md`, "Where Prisma comes from");
    - that a recurring code is the trigger for the scheduler-only pool #937's spec set aside (Decision 4).
  - Add a *Degradations* table row for the new call in `src/lib/pool-exhaustion.ts` (`recordPoolExhaustion`).
  - Re-run every command under "Re-deriving this list" and update the measured table from the output. Do not edit counts by hand arithmetic.

- [ ] **Step 5: Run.** Run `pnpm exec vitest run --project unit src/lib/pool-exhaustion.test.ts src/lib/degradation-codes.test.ts src/lib/process-state-census.test.ts src/lib/degradation.test.ts`, then `pnpm exec tsc --noEmit`. Expected: all pass.

- [ ] **Step 6: Prove the guards bite.** Do each mutation once, record the exact failure text, restore, then re-run green:
  - (a) remove the `logDegraded` call from `recordPoolExhaustion`. The acceptance test fails. **This failure text goes in the PR body (issue acceptance criterion).**
  - (b) remove `onPoolExhausted` from `db.ts`. The wiring test fails.
  - (c) replace the `globalThis` holder with a module-level `let`. The census test fails.

- [ ] **Step 7: Commit.** Stage `src/lib/pool-exhaustion.ts src/lib/pool-exhaustion.test.ts src/lib/degradation-codes.ts src/lib/db.ts docs/degradation-sites.md` and commit with the message `feat: pool exhaustion is recorded as the DATABASE_POOL_EXHAUSTED degradation (#939)`.

---

### Task 3: `/api/health` reads degraded for 15 minutes after an exhaustion, and the docs say how it reaches the operator

**Files:**
- Modify: `src/app/api/health/route.ts`
- Test: `src/app/api/health/route.test.ts`
- Modify: `DEPLOYMENT.md` (§7 Monitoring, the `/api/health` bullet)
- Modify: `docs/technical-architecture.md` ("Database errors", "Where Prisma comes from", "Degradation events")

**Interfaces:**
- Consumes: `poolExhaustedWithin(now: Date): boolean` and `lastPoolExhaustionAt(): Date | null` from Task 2.

- [ ] **Step 1: Write the failing tests** in `route.test.ts`. Set `globalThis.__fairYogaPoolExhaustion` directly with fake timers, and reset it in the existing `afterEach`.
  - `'reads degraded, at 200, for a pool exhaustion 1 minute old'`. The public body (no authorization) is exactly `{ status: 'degraded', db: 'up' }` with HTTP 200.
  - `'reads ok once the exhaustion is 15 minutes old'`. The body is `{ status: 'ok', db: 'up' }`.
  - `'reads ok in a process that never exhausted its pool'`. Leave the holder `undefined`.
  - `'the detailed body carries pool.lastExhaustedAt'`. With the secret, `body.pool` is `{ lastExhaustedAt: '<ISO>' }` when stamped and `{ lastExhaustedAt: null }` when not.
  - `'the pool signal never queries the database'`. With a stamped exhaustion and no secret, `queryRaw` is called once (the existing `SELECT 1`) and `count` is not called.

- [ ] **Step 2: Run, see them fail.** Run `pnpm exec vitest run --project unit src/app/api/health/route.test.ts`. Expected: the degraded case reads `ok`.

- [ ] **Step 3: Implement.**
  - Compute `const poolExhausted = poolExhaustedWithin(new Date())` and set `status` to `jobsUnhealthy || poolExhausted ? 'degraded' : 'ok'`.
  - Add `pool: { lastExhaustedAt: lastPoolExhaustionAt()?.toISOString() ?? null }` to both detailed bodies on the `db: up` path, the one with `degradations` and the one without.
  - The `db: down` body is unchanged.
  - Update the route's docblock: `status` also rolls up a pool exhaustion in the last `POOL_EXHAUSTION_HEALTH_WINDOW_MS`, read from process memory because the pool is what is dry. Link `docs/technical-architecture.md` "Database errors" for the mechanism.

- [ ] **Step 4: Docs.**
  - `DEPLOYMENT.md` §7: `status` is also `degraded` for 15 minutes after a pool exhaustion, at HTTP 200. So an uptime monitor must match the body's `status` (a keyword check for `"status":"ok"`, as production's Better Stack monitor does), not only the HTTP status. The code's runbook is in `docs/degradation-sites.md`.
  - `technical-architecture.md` "Database errors": add a short paragraph on how a `pool_exhausted` reaches the operator: the pool subclass's hook (`prisma-client.ts`), the degradation code, and the health window. This section owns the mechanism.
  - "Where Prisma comes from": one sentence that the factory builds the pool itself so it can hear the wait timeout, with `disposeExternalPool` and the reconnect limit, linking "Database errors".
  - "Degradation events": a "Health" bullet saying `DATABASE_POOL_EXHAUSTED` also flips public `status`, which no other code does, and why.

- [ ] **Step 5: Run.** Run `pnpm exec vitest run --project unit src/app/api/health/route.test.ts` and `pnpm exec tsc --noEmit`. Expected: pass. Then `grep -n "status.*degraded" DEPLOYMENT.md docs/technical-architecture.md` and read each hit; every statement of when `status` is `degraded` must now name the pool window.

- [ ] **Step 6: Prove the guard bites.** Replace `|| poolExhausted` with nothing, record the failing test text, restore, and re-run green.

- [ ] **Step 7: Commit.** Stage `src/app/api/health/route.ts src/app/api/health/route.test.ts DEPLOYMENT.md docs/technical-architecture.md` and commit with the message `feat: /api/health reads degraded for 15 minutes after a pool exhaustion (#939)`.

---

## After the tasks

- Whole-branch review (3 tasks), then `pnpm run verify` with the app live on :3000. Also run `pnpm run build`, because `pool-exhaustion.ts` reaches `server-only` and `db.ts` is imported by pages.
- The PR body records the three premise corrections from the spec, the break-and-restore texts (Task 2 Step 6a is required), and the arithmetic of the green `verify` run.
