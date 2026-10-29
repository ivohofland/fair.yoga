# Connection-class database failures answer a retryable 503 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Failures of the database connection itself (unreachable server, closed or timed-out socket, too many connections, a Postgres shutting down or starting up, pg-pool's connect timeout) classify as a new transient kind `connection` (503, logged at `error`), not as the generic 500. This is issue #926.

**Architecture:** `transientDbFailure` (`src/lib/api-errors.ts`) gains one `TransientKind` member, matched from structured fields first: the SQLSTATE `pgErrorOf` reads, then the adapter's `cause.kind` that `adapterKindOf` reads, then two exact driver-text matches (pg-pool's wait timeout, which already exists, and its connect timeout, which is new). `classifyApiError` picks the 503 message per kind from a record tethered to `TransientKind`. One sweep that ignored the kind's level (`notification-retention.ts`) now follows it.

**Tech Stack:** TypeScript strict, Prisma 7.10.1 client engine + `@prisma/adapter-pg` 7.10.1, pg 8.23.1 / pg-pool 3.14.0, Vitest.

**Spec:** none. This is a small change, and the design was agreed in the session that wrote this plan. It is recorded in full below as *Agreed design*, and the plan argues from it.

## Agreed design

What was measured before designing (sources: `node_modules/@prisma/adapter-pg/dist/index.js` `convertDriverError` / `mapDriverError` / `mapSocketError`, the client runtime's kind→code switch, `pg-pool/index.js:276`, and the shape table in `docs/technical-architecture.md` "Database errors"):

- **The issue's premise mostly holds, but Prisma codes are the wrong key.** `ECONNREFUSED` arrives as `P1001` on a model call or an interactive transaction, and as `P2010` on a raw call. Both carry `meta.driverAdapterError.cause.kind === 'DatabaseNotReachable'`. The same holds for `ConnectionClosed` (`P1017`, from `ECONNRESET`), `SocketTimeout` (`P1008`, from `ETIMEDOUT`) and `TooManyConnections` (`P2037`, from `53300`). **So match the adapter `kind`, not the code.** A code-keyed map would miss every raw call.
- `53300` also carries `originalCode: '53300'`, because `mapDriverError` spreads it onto every Postgres error. So it matches by SQLSTATE as well, and that is harmless because both routes give the same kind.
- pg-pool's connect timeout is `new Error('Connection terminated due to connection timeout', { cause: err })`, at `pg-pool/index.js:276`. It is a plain `Error` that the adapter rethrows unchanged. It is matched by exact text, exactly the way `isPgPoolTimeout` matches the wait timeout.
- **Added beyond the issue:** the Postgres shutdown and startup SQLSTATEs `57P01` (admin_shutdown), `57P02` (crash_shutdown) and `57P03` (cannot_connect_now). These are what a request meets while the `db` container restarts, which `deploy/deploy.sh`'s `up -d` does only when that service's definition changes (an image bump), and also on a host reboot or a crash. They arrive as adapter kind `postgres` with `originalCode` set, the already-measured path.
- **Out of scope, filed as #931:** pg's plain `Connection terminated unexpectedly` (`pg/lib/client.js:204`). No one has measured how it reaches application code per call path, so it stays a 500 until #931 measures it.

Decisions:

1. A new `TransientKind` member, `connection`, at level `error`. It is a separate kind from `pool_exhausted` because a drained pool and an unreachable or refusing server call for different operational responses, and `transientKind` is the log field that tells them apart.
2. What it matches:
   - SQLSTATEs `53300`, `57P01`, `57P02` and `57P03`
   - adapter kinds `DatabaseNotReachable`, `ConnectionClosed`, `SocketTimeout` and `TooManyConnections`
   - pg-pool's connect-timeout text.
3. The 503 message for `connection` is exactly: **`Something on our side was briefly unavailable, so that may not have gone through. Please try again in a moment.`** It must not claim nothing was saved, because a connection lost during `COMMIT` has an unknown outcome. Every other kind keeps `The system was busy and could not finish that. Please try again.`
4. Service `busy` arms keep their copy ("The system was busy…"). A database outage reaching one says "busy", which is still the right advice. Rewording the route files is not this issue.
5. Sweeps: `connection` becomes transient, so `waitlist-reconciliation`'s all-transient tolerance applies to it. That is accepted, because each class's line logs at the kind's `error` level, so an outage still pages.
6. `notification-retention.ts` logs a failed period at the kind's own level (`TRANSIENT_KIND_LEVEL` via `transientDbFailure`), not at a flat `warn`. Its text drops "on contention" in favour of "hit a transient database failure; the next run retries it". It also carries `transientKind` in the log context, as the other sweeps do.

## Global Constraints

- TypeScript `strict`, no `any`.
- *Comment Discipline* (CLAUDE.md): no counts or member rosters in comments. Name the type, or tether to the compiler with `satisfies Record<TransientKind, …>`. A comment states what is true now, and the before-and-after goes in the PR body.
- No error text is read, except the two exact pg-pool messages, each pinned by a test that reads pg-pool's source.
- The 503 copy is exactly the string in decision 3.
- `connection` level is `'error'`.
- Never edit an applied migration. This plan adds none.
- The unit tests that touch the database run against the shared `fairyoga-db-1` container. Never `kill -9` a backend there and never restart it (see #931 for why). Every disruption in a test targets a connection or role the test itself owns.

## Review Focus

1. **A raw call must not be missed.** `ECONNREFUSED` on `$queryRaw` is `P2010` + kind `DatabaseNotReachable`, with no `originalCode`. Expected: `connection`, 503. (Task 1 unit row, Task 2 produced test.)
2. **The lookalike rejections still hold.** A plain `Error` whose message merely contains `Connection terminated due to connection timeout` with a suffix, or that carries an own `code`, must not match. Neither must a non-Error object with that `message`. Expected: 500. (Task 1.)
3. **No other kind changes.** `P2034` with no cause stays `deadlock`, and a `57014` (statement_timeout) stays a 500. Expected: unchanged. (Task 1 keeps the existing rows, and Task 2's existing `57014` test still passes.)
4. **A connection failure buried under a wrapper** (`SpotFreedError`-style, `new Error('x', { cause })`) is still found. Expected: `connection`. (Task 1 cause-walk row.)
5. **Retention still runs the other period and rejects after a transient failure.** The level change must not swallow the summary `error`. (Task 3.)

---

### Task 1: The `connection` kind in the classifier

**Files:**
- Modify: `src/lib/pg-error.ts`: add `PG_CONNECT_TIMEOUT_MESSAGE` and `isPgConnectTimeout` beside `PG_POOL_TIMEOUT_MESSAGE` / `isPgPoolTimeout`.
- Modify: `src/lib/api-errors.ts`: `TransientKind`, its docblock, `TRANSIENT_KIND_LEVEL` and its docblock, `TRANSIENT_SQLSTATE_KIND`, a new adapter-kind map, `transientKindShallow`, `transientDbFailure`'s docblock (it names the matching order), the new message record, and `classifyApiError`'s transient branch.
- Modify: `tests/adapter-errors.ts`: add `pgConnectTimeout()` and `socketCause(kind)`.
- Test: `src/lib/pg-error.test.ts`, `src/lib/api-errors.test.ts`.

**Interfaces:**
- Produces:
  - `export const PG_CONNECT_TIMEOUT_MESSAGE = 'Connection terminated due to connection timeout'` in `pg-error.ts`
  - `export function isPgConnectTimeout(err: unknown): boolean`, with the same rules as `isPgPoolTimeout`: an `Error`, exact message, no own `code`, `pgErrorOf(err) === null`
  - `TransientKind` gains `'connection'`
  - `TRANSIENT_KIND_LEVEL.connection === 'error'`
  - `const TRANSIENT_KIND_MESSAGE = {...} as const satisfies Record<TransientKind, string>` in `api-errors.ts`, used for the 503 `message`
  - in `tests/adapter-errors.ts`: `export function pgConnectTimeout(): Error`, built like `pgPoolTimeout()` (own key `clientVersion` only; Task 2 confirms the own keys against a produced one), and `export function socketCause(kind: 'DatabaseNotReachable' | 'ConnectionClosed' | 'SocketTimeout'): AdapterCause`, giving `{ kind, host: '127.0.0.1', port: 1 }` for `DatabaseNotReachable` and `{ kind }` for the others (no `originalCode`, matching `mapSocketError`). `TooManyConnections` is built with `pgCause('53300', …)`, which needs a `case '53300'` returning `{ ...original, kind: 'TooManyConnections', cause: message }`. That case needs a `TooManyConnections: 'P2037'` entry in `TYPED_CODE`, and the `satisfies PgCauseKind` tag already forces it.

- [ ] **Step 1: Write the failing tests**

In `src/lib/pg-error.test.ts`, add `describe('isPgConnectTimeout')` mirroring `describe('isPgPoolTimeout')`:
- `matches pg-pool's plain connect-timeout error`: read pg-pool's source the same way and `expect(poolSource).toContain(\`new Error('${PG_CONNECT_TIMEOUT_MESSAGE}', { cause: err })\`)`; `expect(isPgConnectTimeout(pgConnectTimeout())).toBe(true)`
- `it.each` rejects: a trailing `.` on the message, an own `code: 'ETIMEDOUT'`, a non-Error `{ message: PG_CONNECT_TIMEOUT_MESSAGE }`, and `pgPoolTimeout()`, the sibling message, which must not cross-match.

In `src/lib/api-errors.test.ts` `describe('transientDbFailure')`, add rows to the `it.each`, each `kind: 'connection'`, `level: 'error'`:
- `'53300 typed (Known P2037)'`: `typedCallError(pgCause('53300', 'sorry, too many clients already'))`
- `'53300 raw (P2010)'`: `rawPg('53300', 'sorry, too many clients already')`
- `'57P01 typed (Known P2039)'`: `typedPg('57P01', 'terminating connection due to administrator command')`
- `'57P01 raw (P2010)'`: `rawPg('57P01', 'terminating connection due to administrator command')`
- `'57P02 raw (P2010)'`: `rawPg('57P02', 'terminating connection because of crash of another server process')`
- `'57P03 raw (P2010)'`: `rawPg('57P03', 'the database system is starting up')`
- `'ECONNREFUSED typed (Known P1001)'`: `knownWithAdapterCause('P1001', socketCause('DatabaseNotReachable'), { modelName: 'Class' })`
- `'ECONNREFUSED raw (P2010)'`: `knownWithAdapterCause('P2010', socketCause('DatabaseNotReachable'))`
- `'ECONNRESET (Known P1017)'`: `knownWithAdapterCause('P1017', socketCause('ConnectionClosed'))`
- `'ETIMEDOUT (Known P1008)'`: `knownWithAdapterCause('P1008', socketCause('SocketTimeout'))`
- `'pg-pool connect timeout'`: `pgConnectTimeout()`

Then add these:
- `it('finds a connection failure one cause deep')`: `transientDbFailure(new Error('wrapped', { cause: pgConnectTimeout() }))?.kind` is `'connection'`.
- `it('answers a connection failure with the connection 503 copy at error')`: `classifyApiError(knownWithAdapterCause('P2010', socketCause('DatabaseNotReachable')))` `toEqual` `{ status: 503, message: 'Something on our side was briefly unavailable, so that may not have gone through. Please try again in a moment.', logMessage: 'transient database failure surfaced to a client', level: 'error', detail: { transientKind: 'connection' } }`.
- `it('keeps the busy copy for every other kind')`: `classifyApiError(typedPg('55P03', LOCK_TIMEOUT_MESSAGE)).message` is `'The system was busy and could not finish that. Please try again.'`.
- `it('does not treat an adapter kind outside the connection set as transient')`: `knownWithAdapterCause('P1010', { kind: 'DatabaseAccessDenied', db: 'x' })` classifies `status: 500`. An access-denied database is a configuration fault, which a retry cannot win.

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm exec vitest run --project unit src/lib/pg-error.test.ts src/lib/api-errors.test.ts`
Expected: FAIL. `isPgConnectTimeout` / `pgConnectTimeout` / `socketCause` are not exported, and the `connection` rows give `null`.

- [ ] **Step 3: Implement**

- `pg-error.ts`: the constant and the matcher, as specified in Interfaces.
- `api-errors.ts`:
  - `TRANSIENT_SQLSTATE_KIND` gains `53300`, `57P01`, `57P02` and `57P03` → `'connection'`.
  - A new `TRANSIENT_ADAPTER_KIND: ReadonlyMap<AdapterKind, TransientKind>` holds the four adapter kinds → `'connection'`.
  - `transientKindShallow` checks the SQLSTATE, then the Prisma code, then `adapterKindOf(error)` through the new map, then `isPgPoolTimeout` → `pool_exhausted`, then `isPgConnectTimeout` → `connection`.
  - In `classifyApiError`, the transient branch's `message` becomes `TRANSIENT_KIND_MESSAGE[transient.kind]`.
- Docblocks: `TransientKind` and `TRANSIENT_KIND_LEVEL` each gain one `connection` bullet in their existing style. The level bullet gives the reason, an operational fault where a retry wins only once the server is back. `transientDbFailure`'s order sentence gains the adapter-kind step and the connect timeout. `TRANSIENT_KIND_MESSAGE` gets a docblock saying why `connection` has its own copy (the ambiguous `COMMIT`). Any comment that says "nothing here reads an error's text" must name the second pg-pool message as an exception, alongside the first.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --project unit src/lib/pg-error.test.ts src/lib/api-errors.test.ts src/lib/log-serializers.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove each guard bites (record the exact failure text in the task report)**

1. Delete the adapter-kind step from `transientKindShallow`. The `ECONNREFUSED raw (P2010)` row fails with `null`, which shows the raw path depends on the adapter kind. Restore.
2. Delete `'57P01'` from `TRANSIENT_SQLSTATE_KIND`. The 57P01 rows fail. Restore.
3. Change `PG_CONNECT_TIMEOUT_MESSAGE` to end in `timeout.`. The pg-pool source pin fails. Restore.
4. Add a `TransientKind` member `'probe'` without a `TRANSIENT_KIND_MESSAGE` entry. `pnpm exec tsc --noEmit` errors on the `satisfies`. Restore.

Re-run Step 4: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pg-error.ts src/lib/api-errors.ts tests/adapter-errors.ts src/lib/pg-error.test.ts src/lib/api-errors.test.ts
git commit -m "fix: connection-class database failures answer a retryable 503 as transient kind connection (#926)"
```

### Task 2: Produce each shape against the real database, and document it

Depends on Task 1. Its assertions use `connection`.

**Files:**
- Test: `src/lib/prisma-client.test.ts` (the existing `UNREACHABLE` and `203.0.113.1` tests)
- Test: `src/lib/db-transient-shapes.test.ts` (new `describe('connection')`)
- Modify: `docs/technical-architecture.md`, "Database errors": the shape table, the "where each row is produced" paragraph above it, and the **Transient kinds** paragraph.

**Interfaces:**
- Consumes: `transientDbFailure`, `classifyApiError`, `TransientKind` including `'connection'`; `expectKind(err, kind, level)` already in `db-transient-shapes.test.ts`; `pgConnectTimeout()` from Task 1.

- [ ] **Step 1: Write the produced-shape tests**

In `prisma-client.test.ts`:
- The existing `reports a refused port as the adapter's DatabaseNotReachable` (raw) gains `expect(transientDbFailure(err)).toEqual({ kind: 'connection', level: 'error' })`.
- New: `a refused port on a model call and inside an interactive transaction is P1001, kind connection`. Use `client.teacher.findFirst()` and `client.$transaction(async (tx) => tx.teacher.findFirst())` against `UNREACHABLE`. For each, assert `PrismaClientKnownRequestError`, `code === 'P1001'`, `meta.driverAdapterError.cause.kind === 'DatabaseNotReachable'`, and `transientDbFailure` is `{ kind: 'connection', level: 'error' }`. If a path turns out to throw a different shape, record it in the task report and in the docs table, and assert what was measured.
- The existing `connectionTimeoutMs bounds a connect to a silent host` gains `expect(Object.keys(err as object).sort()).toEqual(Object.keys(pgConnectTimeout()).sort())` (the fixture matches the produced own keys) and `expect(transientDbFailure(err)).toEqual({ kind: 'connection', level: 'error' })`.

In `db-transient-shapes.test.ts`, add `describe('connection')`:
- `57P01: a backend ended by pg_terminate_backend mid-statement`. Use a separate `createPrismaClient({ poolMax: 1 })` (the victim) that starts `` $queryRaw`SELECT pg_backend_pid() AS pid` `` to learn its pid, then `` $queryRaw`SELECT pg_sleep(5)` ``. Once the sleep is running, the suite's `db` runs `` $queryRaw`SELECT pg_terminate_backend(${pid})` ``. Capture the victim's rejection with `rejectionOf`, assert `pgErrorOf(err)?.sqlState === '57P01'`, and call `expectKind(err, 'connection', 'error')`. Disconnect the victim in `finally`. This disturbs only the victim's own backend; the postmaster stays up.
- `53300: a role whose connection limit is zero`. In `beforeAll`, the suite's `db` runs `CREATE ROLE "conn_limit_<tag>" LOGIN PASSWORD '<random>' CONNECTION LIMIT 0`. Connect a `createPrismaClient({ url })` built from `DATABASE_URL` with that role's user and password, run `` $queryRaw`SELECT 1` ``, assert `pgErrorOf(err)?.sqlState === '53300'` and `adapterKindOf(err) === 'TooManyConnections'`, and call `expectKind(err, 'connection', 'error')`. `afterAll` runs `DROP ROLE IF EXISTS`. If the role cannot be created (privilege) or the connect fails with a different SQLSTATE, stop and report, and do not weaken the assertion.
- `57P02` and `57P03` are not produced: a crash restart and a starting-up server both disturb the shared container. Their rows in Task 1 ride the same `postgres`-kind path that 57P01 proves here. Say so in the docs paragraph (next step).

- [ ] **Step 2: Run the tests and confirm they pass**

Run: `pnpm exec vitest run --project unit src/lib/prisma-client.test.ts src/lib/db-transient-shapes.test.ts`
Expected: PASS. A shape that differs from the table in *Agreed design* is a finding to report, not something to code around.

- [ ] **Step 3: Prove the produced tests bite**

Temporarily map `57P01` and `53300` to `'lock_timeout'` in `TRANSIENT_SQLSTATE_KIND` and delete the adapter-kind step. The 57P01, 53300 and ECONNREFUSED produced tests fail on `kind`. Record the text and restore. Re-run Step 2.

- [ ] **Step 4: Update `docs/technical-architecture.md`, "Database errors"**

- Shape table:
  - `ECONNREFUSED`: keep the row, now produced on all three paths.
  - New rows: `53300` (Known `P2037` typed / `P2010` raw, kind `TooManyConnections`, `originalCode`, `originalMessage`, `cause`), `57P01` (kind `postgres`, typed `P2039` / raw `P2010`), and `ECONNRESET` / `ETIMEDOUT` (kinds `ConnectionClosed` → `P1017`, `SocketTimeout` → `P1008`), the last read from the adapter source and marked as not produced.
  - Fill each cell from what Task 2 measured.
- The "where each row is produced" paragraph names the new producers, and states which rows are read from source only (`57P02`, `57P03`, `ECONNRESET`, `ETIMEDOUT`).
- The **Transient kinds** paragraph adds `53300`/`57P01`/`57P02`/`57P03` → `connection` to the SQLSTATE step, a new step for the adapter kinds (naming them, because `docs/` owns this list), and `isPgConnectTimeout` → `connection` after `isPgPoolTimeout`. Correct "No error text is read" so it names the two pg-pool messages. "Every kind is produced against the real database" stays true only with the 57P02/57P03 caveat, so state it.
- Add one line: pg's `Connection terminated unexpectedly` is not classified yet, see #931.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prisma-client.test.ts src/lib/db-transient-shapes.test.ts docs/technical-architecture.md
git commit -m "test: produce the connection-class shapes against the real database, and document them (#926)"
```

### Task 3: Notification retention logs a transient failure at its kind's level

Independent of Task 2. It needs Task 1 only for `transientDbFailure` (which already exists).

**Files:**
- Modify: `src/services/notification-retention.ts:101-108`
- Test: `src/services/notification-retention.test.ts:201-222`

**Interfaces:**
- Consumes: `transientDbFailure(err): TransientDbFailure | null` from `@/lib/api-errors`.

- [ ] **Step 1: Write the failing test**

Replace `logs a transient period failure at warn, and the summary still at error` with two tests:
- `logs a lock timeout period failure at warn, carrying its kind`. The failure is `typedCallError(pgCause('55P03', 'canceling statement due to lock timeout'))`. Assert `warn` is called with `{ err, days: 365, transientKind: 'lock_timeout' }` and a message matching `/transient database failure/`, and that `error` is called exactly once (the summary), with the same summary matcher as today.
- `logs a deadlock period failure at error, as its kind's level says`. The failure is `typedCallError(pgCause('40P01', 'deadlock detected'))`. Assert `warn` is not called, and that `error` is called twice: once with `{ err, days: 365, transientKind: 'deadlock' }`, once with the summary.

Both keep `rejects.toThrow(/365/)` and the row cleanup.

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm exec vitest run --project unit src/services/notification-retention.test.ts`
Expected: FAIL. `transientKind` is missing, and the deadlock is logged at `warn`.

- [ ] **Step 3: Implement**

The `catch` computes `const failure = transientDbFailure(err)` and calls `log[failure?.level ?? 'error']({ err, days, transientKind: failure?.kind ?? null }, …)`. The message is `'notification retention period hit a transient database failure; the next run retries it'` when `failure` is set, and `'notification retention period failed'` otherwise. Replace the `isTransientDbError` import if it becomes unused.

- [ ] **Step 4: Run it and confirm it passes**

Same command. Expected: PASS.

- [ ] **Step 5: Prove it bites**

Hard-code `'warn'` back in for the transient case. The deadlock test fails on the `error` call count. Restore, re-run, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/notification-retention.ts src/services/notification-retention.test.ts
git commit -m "fix: notification retention logs a transient period failure at its kind's level, not a flat warn (#926)"
```

---

## After the tasks

- Whole-branch review (three tasks). Its cross-task question: does every comment and doc paragraph naming the matching order, or the "no error text is read" rule, agree with the code after Task 1?
- `pnpm run verify` needs the app on :3000, which is not running at plan time. Start it per the `verify` skill only if it is genuinely absent, then run `pnpm run build` before pushing (CI also builds).
- Sweep for stale descriptions: `grep -rn "No error text\|nothing here reads\|isPgPoolTimeout\|pool_exhausted" src docs` and read each hit's whole paragraph.
