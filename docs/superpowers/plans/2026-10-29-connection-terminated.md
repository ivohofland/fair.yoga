# Connection terminated unexpectedly (#931) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** pg's bare `Error('Connection terminated unexpectedly')`, thrown when the socket to Postgres closes without an `ErrorResponse`, answers the `connection` 503 instead of a generic 500, proven against the real database through a TCP relay.

**Architecture:** One new exact-text matcher in `src/lib/pg-error.ts`, the third beside `isPgPoolTimeout` / `isPgConnectTimeout` and built the same way, consulted by `transientKindShallow` in `src/lib/api-errors.ts`. A new test file puts a `net` relay between a `createPrismaClient({ url })` client and the database and cuts it mid-statement, producing every shape. The shape table in `docs/technical-architecture.md` ("Database errors") records what it produces.

**Tech Stack:** TypeScript strict, Prisma 7.10.1 client engine + `@prisma/adapter-pg` 7.10.1, pg 8.23.1, vitest, Node `net`.

**Spec:** none (gated out: one matcher, one approach). The issue is #931, plus the issue's comment, which adds the reset cut and the connect-timeout depth check.

## What was measured before planning (2026-10-29, throwaway probe, `poolMax: 1`)

"end" = `socket.destroy()` on both relay sockets (FIN); "reset" = `socket.resetAndDestroy()` (RST). Cut 300 ms into a `pg_sleep(3)` or a blocked statement.

| Cut | `$queryRaw` | model call (blocked behind a `FOR UPDATE` the test holds on its own row) | statement in an interactive transaction | `COMMIT`, cut before it is written (synchronously, as the callback returns) | `COMMIT` in flight (a deferred constraint trigger sleeps 2 s at commit; cut at 400 ms) |
|---|---|---|---|---|---|
| end | plain `Error('Connection terminated unexpectedly')`; own `message`, `clientVersion` (enumerable: `clientVersion` only); no `code`, no `cause` → null | same | same | **bare** `DriverAdapterError`, `cause {kind: 'ConnectionClosed'}` → connection | plain `Error` as on the left → null; **the write landed** |
| reset | Known `P2010`, `meta.driverAdapterError.cause {kind: 'ConnectionClosed'}` → connection | Known `P1017`, same cause → connection | Known `P2010`, same → connection | plain `Error('write EPIPE')`, own `code: 'EPIPE'`, `errno: -32`, `syscall: 'write'` → null; write did not land (3 of 3) | Known, `ConnectionClosed` → connection; **the write landed** |

So: the bare text has no structured field on any path, so an exact text match is the only option, built the way `isPgConnectTimeout` is. `EPIPE` stays a 500 (decided at the brainstorming gate): a bare `EPIPE` is any socket's, not only the database's. And the docs' claim that no measured call throws a bare `DriverAdapterError` is wrong: an interactive transaction's `COMMIT` does.

## Global Constraints

- No `any`; strict TS. Services untouched: this is `src/lib` only.
- Never `kill -9` a backend and never restart `fairyoga-db-1`. Every disruption goes through the test's own relay and its own client.
- The only error text matched is pg's / pg-pool's exact messages, each pinned to the driver source by a test.
- *Comment Discipline* (CLAUDE.md): no counts or member rosters in comments. "pg-pool's two exact messages" style prose in `docs/` gets rewritten so that it does not count.
- Stage exact paths; never `git add -A`. Commit messages end with `(#931)` and the attribution line.

## Review Focus

1. **The connect timeout matches at two depths.** Its non-enumerable `cause` is the bare text, so the new matcher would match at depth 1 too. `transientDbFailure` must still answer exactly `{kind: 'connection', level: 'error'}`, from depth 0. Pinned in Task 2 with the `pgConnectTimeout()` fixture.
2. **`Connection terminated` (graceful, `this._ending`) must not match.** That is the client's own `$disconnect`, not a dropped server. Pinned in Task 2's rejects table.
3. **A non-pg error quoting the text** (a wrapper whose message *contains* it, a different case, a trailing period) must not match. Exact `===` only. Task 2's rejects table.
4. **The in-flight `COMMIT` landed.** The test asserts the row exists afterwards, so the `connection` copy's "may not have gone through" stays honest, and a future copy edit claiming nothing was saved has a measured fact against it. Task 1.
5. **Relay timing under load.** The cut must land while the statement is in flight. `pg_sleep(3)` with a 300 ms cut gives a 10× margin; the in-flight COMMIT relies on a 2 s trigger sleep against a 400 ms cut. Each case asserts its expected shape, so a mis-timed cut fails loudly rather than passing vacuously.

---

### Task 1: Produce the shapes through a relay (red on the end cuts)

**Files:**
- Create: `src/lib/db-connection-drop.test.ts` (in the `unit` project by its path; it is not `@serial-tier`: every lock and connection it touches is its own)
- Delete: `src/lib/zz-probe-931.test.ts` (the untracked probe; read it for the relay and the trigger SQL, then remove it)

**Interfaces:**
- Consumes: `createPrismaClient({ url, poolMax })` (`@/lib/prisma-client`), `transientDbFailure`, `classifyApiError` (`./api-errors`), `adapterKindOf` (`./pg-error`).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the relay helper and the tests**

The relay is a `net.createServer` on `127.0.0.1:0` that pipes each accepted socket to the `DATABASE_URL` host/port and records both sockets. `cut('end' | 'reset')` destroys every recorded socket (`destroy()` or `resetAndDestroy()`). `close()` closes the server. Each test gets its own relay and its own `createPrismaClient({ url: <relay url>, poolMax: 1 })`, warmed with `SELECT 1` before arming the cut, then disconnected (rejection ignored) and the relay closed in `finally`. Rows are created with a `connection-drop-<uuid>@example.test` email and deleted through a separate direct client in `afterAll`/`finally`.

The header docblock says what the file produces and links to `docs/technical-architecture.md` "Database errors". It lists no shapes or counts.

Tests (one `describe` per cut, `it` per path), with these assertions:

- `end` × `$queryRaw`, model call, statement in an interactive transaction: the error is an `Error`, not a `Prisma.PrismaClientKnownRequestError`; `message === 'Connection terminated unexpectedly'`; `Object.keys(err)` sorted equals `['clientVersion']`; no own `code`; `err.cause === undefined`; `transientDbFailure(err)` equals `{ kind: 'connection', level: 'error' }`; `classifyApiError(err)` matches `{ status: 503, level: 'error', detail: { transientKind: 'connection' } }`.
- `end` × `COMMIT` before it is written: `err.name === 'DriverAdapterError'`, not Known, `adapterKindOf(err) === 'ConnectionClosed'`, classified `connection` 503; the row does not exist afterwards.
- `end` × `COMMIT` in flight (temp table `ON COMMIT DROP`, `pg_temp` plpgsql function doing `pg_sleep(2)`, `DEFERRABLE INITIALLY DEFERRED` constraint trigger, one insert, then the account create, then `setTimeout(cut, 400)` as the callback returns): the same bare-text shape and classification as the statement rows; **after waiting 2.5 s, the account row exists** (a direct client counts it).
- `reset` × `$queryRaw` and statement in transaction: Known `P2010`, `adapterKindOf(err) === 'ConnectionClosed'`, classified connection 503. `reset` × model call: Known `P1017`, same.
- `reset` × `COMMIT` before it is written: plain `Error`, own `code === 'EPIPE'`, `syscall === 'write'`, `typeof errno === 'number'`; `transientDbFailure(err)` is `null` and `classifyApiError(err).status === 500` (a documented 500: a bare `EPIPE` is any socket's); the row does not exist.
- `reset` × `COMMIT` in flight: Known, `ConnectionClosed`, connection 503; the row exists afterwards.

Per-test timeout 20 s. The model-call case blocks `db.account.update` on its own row, behind a direct-client transaction holding `FOR UPDATE`, released in `finally`.

- [ ] **Step 2: Run it and see the end cuts fail**

Run: `pnpm exec vitest run --project unit src/lib/db-connection-drop.test.ts`
Expected: the four `end` bare-text cases (`$queryRaw`, model, transaction statement, COMMIT in flight) FAIL on `transientDbFailure` (received `null`); every other case PASSES. Any other failure means a shape differs from the measurement above: stop and report it rather than adjusting the assertion.

- [ ] **Step 3: Delete the probe file, and leave this one uncommitted**

A red test is not committed on its own. It lands in Task 2's commit, which turns it green, so Task 2 runs immediately after this task (the order is load-bearing).

### Task 2: The matcher (green), pinned to pg's source, guard proven

**Files:**
- Modify: `src/lib/pg-error.ts` (beside `PG_CONNECT_TIMEOUT_MESSAGE` / `isPgConnectTimeout`)
- Modify: `src/lib/api-errors.ts` (`transientKindShallow`, and the `transientDbFailure` docblock sentence that names the matched texts)
- Modify: `src/lib/pg-error.test.ts`, `src/lib/api-errors.test.ts` (flip the pin at the `// Not classified yet … (see #931)` test)
- Modify: `tests/adapter-errors.ts` (add a `pgConnectionTerminated()` fixture beside `pgConnectTimeout()`, and build the connect-timeout fixture's `cause` from it)

**Interfaces:**
- Produces: `export const PG_CONNECTION_TERMINATED_MESSAGE = 'Connection terminated unexpectedly'` and `export function isPgConnectionTerminated(err: unknown): boolean` in `pg-error.ts`; `pgConnectionTerminated(): Error` in `tests/adapter-errors.ts`, which returns `Object.assign(new Error(PG_CONNECTION_TERMINATED_MESSAGE), { clientVersion: CLIENT_VERSION })`, the shape Task 1 measured.

- [ ] **Step 1: Write the failing unit tests**

In `pg-error.test.ts`, a `describe('isPgConnectionTerminated')` mirroring `isPgConnectTimeout`'s:
- source pin: read pg's `lib/client.js` (resolve `pg`, then `path.join(path.dirname(req.resolve('pg')), 'client.js')`) and `expect(source).toContain(\`new Error('${PG_CONNECTION_TERMINATED_MESSAGE}')\`)`; then `expect(isPgConnectionTerminated(pgConnectionTerminated())).toBe(true)`.
- rejects (`it.each`): `'Connection terminated'` (the graceful `$disconnect` text), `'Connection terminated unexpectedly.'`, `'connection terminated unexpectedly'`, a wrapper `new Error('query failed: Connection terminated unexpectedly')`, the fixture plus an own `code: 'ECONNRESET'`, a non-Error `{ message: PG_CONNECTION_TERMINATED_MESSAGE }`, and a Known error carrying the message with a Postgres adapter cause (built as the existing connect-timeout "on a Known error" case is).

In `api-errors.test.ts`, replace the `// Not classified yet` test with:
- `'answers a bare Connection terminated unexpectedly as connection, at error'`: `transientDbFailure(pgConnectionTerminated())` equals `{ kind: 'connection', level: 'error' }`, `classifyApiError(...)` is a 503 with `transientKind: 'connection'`.
- `'classifies the connect timeout once, as connection, though its cause is the bare termination'`: with `pgConnectTimeout()`, assert `isPgConnectionTerminated(err.cause) === true` (so the double match is real), then that `transientDbFailure(err)` equals `{ kind: 'connection', level: 'error' }`.

- [ ] **Step 2: Run them; they fail on the missing export**

Run: `pnpm exec vitest run --project unit src/lib/pg-error.test.ts src/lib/api-errors.test.ts`
Expected: FAIL, `isPgConnectionTerminated` / `PG_CONNECTION_TERMINATED_MESSAGE` / `pgConnectionTerminated` not exported.

- [ ] **Step 3: Implement**

`isPgConnectionTerminated`: the same four conditions as `isPgConnectTimeout` (an `Error`, exact `===` message, no own `code`, `pgErrorOf(err) === null`), with a one-line docblock in that one's style ("the same rules as `isPgPoolTimeout`, for `PG_CONNECTION_TERMINATED_MESSAGE`"). The constant's docblock says where pg raises it (the socket ending without the client ending it) and "driver text, matched only here". It uses no line number: the source pin is the tether.

`transientKindShallow`: after `isPgConnectTimeout`, `isPgConnectionTerminated(error)` → `'connection'`. Update the `transientDbFailure` docblock's sentence naming the matched texts, and its order sentence, to include it.

- [ ] **Step 4: Run unit tests and the relay file; all green**

Run: `pnpm exec vitest run --project unit src/lib/pg-error.test.ts src/lib/api-errors.test.ts src/lib/db-connection-drop.test.ts src/lib/prisma-client.test.ts`
Expected: PASS (`prisma-client.test.ts`'s connect-timeout case still asserts `connection`).

- [ ] **Step 5: Prove the guards bite (record each exact error text for the PR body)**

a. Reword the constant to `'Connection terminated unexpectedly!'`. Run the relay file and `pg-error.test.ts`. Expected: the four end-cut bare-text cases are red on `transientDbFailure` (received `null`), and the source pin is red on `toContain`. Restore.
b. Change the matcher's `===` to `.includes(…)`. Run `pg-error.test.ts`. Expected: the wrapper-message reject case is red. Restore.
c. Remove the `isPgConnectionTerminated` line from `transientKindShallow`. Expected: the relay file and the `api-errors.test.ts` case are red. Restore.
d. Re-run Step 4: green.

- [ ] **Step 6: Commit (Task 1's file with this task)**

```bash
git add src/lib/pg-error.ts src/lib/api-errors.ts src/lib/pg-error.test.ts src/lib/api-errors.test.ts tests/adapter-errors.ts src/lib/db-connection-drop.test.ts
git commit -m "fix: a connection dropped mid-query answers the connection 503, produced through a relay (#931)"
```

### Task 3: Docs say what was produced

**Files:**
- Modify: `docs/technical-architecture.md`, "Database errors" (around the `pgErrorOf` path list, the shape table and its intro paragraph, and the transient-kinds paragraph that currently says the bare text "is not classified yet: see #931")

- [ ] **Step 1: Edit**

- Path 1 of `pgErrorOf`'s two paths: replace "No typed call measured under 7.10.1 throws one bare; the path stays for a runtime that does" with what was measured: an interactive transaction's `COMMIT` on a socket that has already ended throws one bare (`kind: 'ConnectionClosed'`), produced in `src/lib/db-connection-drop.test.ts`.
- The table intro: add `src/lib/db-connection-drop.test.ts` as where the dropped-connection rows are produced, on 2026-10-29. `ECONNRESET` moves from "read from source" to produced on the raw, model and interactive-transaction paths (reached as `ConnectionClosed` through the relay's reset). `ETIMEDOUT` stays source-only.
- Table rows to add or replace: the server ending the socket mid-statement (all three paths: the bare text, own key `clientVersion`, no `code`/`cause` → `connection`); `COMMIT` after the socket ended (bare `DriverAdapterError`, `ConnectionClosed`); `COMMIT` in flight, both cuts (with **the write landed**); a reset mid-statement (model `P1017`, raw and transaction `P2010`, `ConnectionClosed`, replacing the source-only `ECONNRESET` half of the last row); a reset before `COMMIT` is written (plain `Error('write EPIPE')`, `code`/`errno`/`syscall`, **not classified: a 500 by design**, because a bare `EPIPE` can come from any socket).
- The transient-kinds paragraph: the matched texts become pg-pool's two and pg's one, described without a count ("pg-pool's and pg's exact messages, each pinned to the driver source"). Replace "is not classified yet: see #931" with the matcher and its order (after `isPgConnectTimeout`). Note that the connect timeout carries the bare text as its `cause` and matches at depth 0 first. Keep the `busy`-arm sentence, and add that an in-flight `COMMIT` cut was measured to land.

- [ ] **Step 2: Sweep for the claims this invalidated**

Run: `grep -rn "931\|not classified yet\|terminated unexpectedly\|throws one bare\|two exact messages\|ECONNRESET" docs src tests CLAUDE.md`
Expected: every hit gets a verdict. Survivors are legitimate: the 2026-10-29 #926 plan is a historical record and stays; the fixtures and tests are this branch's.

- [ ] **Step 3: Commit**

```bash
git add docs/technical-architecture.md
git commit -m "docs: the Database errors table records the dropped-connection shapes the relay produces (#931)"
```

### Finish (controller)

`pnpm run verify` (dev server on :3000 must be live; start it only if absent), then a push and a PR whose body carries the measured table, the guard-bite error texts, the docs correction, `EPIPE` as a deliberate 500, and "**#926 is unaffected**"-style wording only where needed. Then `/pr-review-toolkit:review-pr`. The plan has 3 tasks, but Task 1 and Task 2 land as one commit; the whole-branch review is still run once, because Task 3's docs restate Task 2's code.
