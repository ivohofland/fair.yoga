# Prisma 6 on the pg driver adapter and the client engine; matchers read structured fields (#885)

Part of the Prisma 6 → 7 upgrade (#889). Still on Prisma 6.19.3. After this
change every runtime (vitest, `tsx` scripts, `next dev`, the standalone server
in the runner image, the migrate image's deploy gate) reaches Postgres through
`@prisma/adapter-pg` and `pg`, with `engineType = "client"`, which is the shape
v7 forces. No database error is classified any more by reading the Rust
engine's debug text.

Evidence: the premise report and its scratch scripts, in the session
scratchpad at
`/private/tmp/claude-501/-Users-ivohofland-Projects-fair-yoga/8ca55306-135e-4f05-ad44-1a1c25b9147f/scratchpad/885/`
(called `S/` below; everything there re-runs from the worktree root, and the
report's "Re-run index" lists how). The merged captures are `S/shapes.json`.
The direction decisions D1–D10 were taken at the brainstorm gate
(`S/decisions.md`); this spec elaborates each of them and settles the
sub-questions they left open. Where a measurement contradicts a decision, the
section on that decision says so; the list is repeated at the end.

Abbreviations for engine configurations, as in the report: **L** is the library
engine without an adapter (today), **L+A** is the library engine plus the
adapter, **C+A** is the client engine plus the adapter (the target).

## 1. Problem

The DB-error layer finds SQLSTATEs and constraint names by string-matching what
the Rust query engine prints. A typed call that hits an unmapped Postgres error
throws `PrismaClientUnknownRequestError` with
`PostgresError { code: "23514", message: "…", … }` in its message. A raw call
throws `P2010` with ``Code: `23514` ``. On top of that, three matchers and the
log serializer read Prisma's `meta` fields (`meta.target`, `meta.constraint`,
`meta.code`, `meta.error`).

Under C+A none of that survives. The engine's framing is gone, typed calls
throw a class that is not a `PrismaClient*Error` at all (`DriverAdapterError`),
and every structured `meta` field the code reads moves under
`meta.driverAdapterError.cause`. Nothing errors: the 409 refusals
(`CLASS_FROZEN`, the slot exclusions, the unique-key 409s, the room-in-use
refusals) silently become 500s, every transient 503 except the two P-coded ones
becomes a 500, and the logs lose their SQLSTATEs.

## 2. Where the issue's premise was wrong or incomplete

Each item was measured, not read off the docs; the evidence is the named
section of the premise report and the files it cites. I re-checked the ones
the design leans on against `S/shapes-adapter-client.json` and the adapter's
source.

1. **"Turn the adapter on and the matcher failures surface the v7 break" is
   false on the library engine.** On L+A the Rust engine still formats the
   driver's error into its own `PostgresError { … }` / ``Code: `…` `` text, and
   every repo matcher gives the same verdict as on L (`S/verify-matchers.ts`,
   `S/matchers-adapter-library.json`), except item 4. Only
   `engineType = "client"` shows the v7 shapes, so step 2 of the issue has to
   run on C+A or it proves nothing. `engineType` is a generator setting, and
   the client engine refuses to start without an adapter
   (`PrismaClientInitializationError`, `errorCode: 'P2038'`), so it is one
   configuration for every runtime, tests and production alike.
2. **The break is wider than message parsing.** On C+A, `P2002` loses
   `meta.target`, `P2003` loses `meta.constraint`, `P2010` loses `meta.code`,
   and `P2028` loses `meta.error`. That breaks `isUniqueConflictOn`,
   `isRestrictViolationOn`, `payout-notice.ts`'s `isMintKeyRefusal`, the
   serializer's `liftSqlState` and `txErrorKind`, and `tests/stack-ceiling.ts`'s
   `isStackDepthError`. None of them is in the issue's table.
3. **Typed calls throw a non-Prisma class.** `DriverAdapterError` (it lives in
   the transitive `@prisma/driver-adapter-utils`) extends `Error`, has the
   Postgres primary message as its own `message`, and a plain object as its
   `cause`. Every `instanceof Prisma.PrismaClient*` gate misses it,
   `transientDbFailure`'s `cause` walk stops at the plain object, and the
   serializer does not withhold it. Worse than the report says: the
   serializer's cause walk treats that plain object as error-like (it has a
   string `message`) and logs it verbatim, so the Postgres primary message,
   which for a trigger carries a row id and for `22P02` quotes the offending
   input, reaches the log twice.
4. **The adapter breaks `isUniqueConflictOn` on expression indexes even on
   the library engine.** adapter-pg builds the field list with
   `error.detail?.match(/Key \(([^)]+)\)/)`, which stops at the first `)`:
   `Room_private_identity_unique` reports
   `['"createdById"', 'lower(TRIM(BOTH FROM address']`. The rooms routes'
   duplicate-room 409s become 500s.
5. **The pool classifications do not survive.** There is no `P2024` under the
   adapter: pool exhaustion is pg-pool's plain
   `Error('timeout exceeded when trying to connect')`, with no code, rethrown
   unmapped by the adapter. It classifies as a 500 today. `P2028` still arises,
   but its `meta` changes (below). `P2034` is what Prisma emits for a **typed
   serialization failure (`40001`)**, not for a deadlock: a typed deadlock is a
   `DriverAdapterError` with `40P01` (`S/shapes.json`, `t40001_typed`,
   `t40P01_typed`). The code files `P2034` under `deadlock`.
6. **The URL's pool parameters are ignored.** pg reads neither
   `connection_limit` nor `pool_timeout` (three concurrent 1 s sleeps finished
   in 1,015 ms on `?connection_limit=1`, against 3,034 ms on L). pg-pool's own
   defaults are `max: 10`, `connectionTimeoutMillis: 0` (wait forever) and
   `idleTimeoutMillis: 10000` (`node_modules/.pnpm/pg-pool@3.14.0_pg@8.23.1/node_modules/pg-pool/index.js:89,98-99,206`).
   The report found `tests/stack-ceiling.ts` and `scripts/measure-push-fanout.ts`
   relying on the URL parameters. **It missed four more:**
   `src/lib/auth/handoff.test.ts:1128` (a pool sized to the claim count so
   every claim reaches the lock), and `src/services/template-room-race.test.ts:52`,
   `src/services/transition-class-lock-order.test.ts:70` and
   `src/services/update-class-lock-order.test.ts:79`, whose single-connection
   clients identify their backend once with `pg_backend_pid()` and trust it
   for every later statement. Re-derive:
   `git grep -lE "connection_limit" -- src tests scripts ':!src/generated'`.
   Those single-connection clients also depend on the connection never being
   closed while idle, which pg's 10 s idle timeout would break and Prisma's
   300 s default (`max_idle_connection_lifetime`) did not.
7. **`$connect()` connects nothing.** pg's pool is lazy, so `$connect()`
   resolves at once even against an unreachable host
   (`connect_only_unreachable`, 5 ms). `scripts/check-reserved-slugs.ts:18`
   relies on it to surface P1001.
8. **`datasources` / `datasourceUrl` plus an adapter is a runtime refusal the
   types allow** (`PrismaClientInitializationError`: "Custom datasource
   configuration is not compatible with Prisma Driver Adapters"). The factory's
   `url` must become the adapter's connection string.
9. **CI breaks in two steps, not one.** Under `--network none` raw pg fails
   with `connect ENETUNREACH` in 3 ms (`S/netnone-pg.cjs`, run in
   `node:24-alpine`). `ENETUNREACH` is not in adapter-pg's `SOCKET_ERRORS`, so
   the adapter rethrows it unmapped, and Prisma wraps it into a
   `PrismaClientKnownRequestError` whose `code` is `'ENETUNREACH'` for raw and
   model calls (`S/probe3.ts`, `S/probe3-client.log`). The serializer keeps
   only `P\d{4}` codes and withholds the message, so the runner probe's logged
   line carries nothing it can match. The migrate image's reserved-slug step
   greps for `P1001`, which no longer appears. The issue names only the runner
   probe.
10. **An unreachable host hangs for the OS SYN timeout.** pg ignores the
    URL's `connect_timeout`; 75 s on macOS. On L+A it then fails with a 6.19.3
    deserialisation bug (`unknown variant SocketTimeout`); on C+A as `P1008` /
    `P2010` with `kind: 'SocketTimeout'`. With `connectionTimeoutMillis` set it
    is a plain `Error('Connection terminated due to connection timeout')`.
11. **`$queryRaw` refuses `name` and `char` columns** on the adapter
    (`P2010`, `kind: 'UnsupportedNativeDataType'`). The three
    `SELECT current_database()` guards in front of DB-wide deletes in
    `notification-retention.test.ts:68`, `push-subscription-retention.test.ts:47`
    and `waitlist-retention.test.ts:228` fail closed. A heuristic scan cannot
    see multi-line SQL, so only a full suite run on C+A settles the rest.
12. **"About 15 test files" is right for the framing grep, and 53 test files
    depend on the shapes.** That counts fabricated errors, `meta.*` / P-code
    assertions, `meta: { … }` fabrications, `PrismaClientUnknownRequestError`
    gates and SQLSTATE literals matched against `String(err)` (command in
    §11). The premise report's union found 39; its greps could not see the
    last three patterns, so it missed 14 files, listed with a verdict each in
    §7. Beyond those 53 come the test files that pass column lists to
    `isUniqueConflictOn` and the four URL-pool clients in item 6.
14. **The unpaged composite relation load no longer overflows the stack, and
    it now fails on the bind-parameter limit instead.** The query compiler
    loads `Class.calendarEntry` as three scalar `IN` lists
    (`"id" IN ($1…) AND "kind" IN (…) AND "live" IN (…)`), not the Rust
    engine's row-value `(id, kind, live) IN ((…), …)`. A scalar `IN` list is
    flat in Postgres, so the #674 stack overflow is gone: 1,000, 10,000 and
    21,844 parents all resolve under a 200 kB `max_stack_depth`. The load has
    3n + 1 bind parameters, and Postgres's wire protocol carries at most
    65,535. So 21,845 parents fail with `08P01`
    (`bind message supplies 0 parameters, but prepared statement "" requires 65536`,
    a `DriverAdapterError`). The query compiler does not split the
    statement. An `in:` list is different: Prisma caps a statement at
    32,766 bound parameters, splits a plain `findMany`'s `in:` filter and a
    single-key relation load into statements of at most 32,765 values, and
    refuses every other statement over the cap (`count`, `groupBy`,
    `updateMany`, `deleteMany`, a `findMany` with `orderBy` or `take`, a
    nested `in:`) before sending it, with `P2029`, also a 500 (Task 11's
    measurement, `docs/technical-architecture.md` "Relation loads over
    platform-wide sets"). The app's own raw row-value SQL still
    overflows: `rowValueIn(1000)` under 200 kB is `P2010` with
    `originalCode: '54001'`. Measured by `S/rev2/ceiling.ts` (seeds by
    `generate_series`, runs with sizes as arguments). The first observation
    is the spec review's, from `S/rev/relsql.ts`. Paging therefore stays, for
    a different reason, and the ceiling tests are re-based (D11).
13. Minor: `isExclusionConflictOn`'s typed branch matches a **bare** `'23P01'`
    substring, unlike its siblings, which match the SQLSTATE inside its framing.
    The rewrite removes the question.

What the issue gets right: driver adapters need no `previewFeatures` on 6.19.3
(it typechecks and runs with the generator block unchanged apart from
`engineType`), and the rule "SQLSTATE *and* constraint name, both required" is
kept by every rewritten matcher.

## 3. The shapes this design reads (C+A, measured)

Source: `S/shapes-adapter-client.json`, plus the adapter's own mapping in
`node_modules/.pnpm/@prisma+adapter-pg@6.19.3/node_modules/@prisma/adapter-pg/dist/index.js`
(`convertDriverError`, `mapDriverError`). For every pg `DatabaseError` the
adapter sets `originalCode = error.code` and `originalMessage = error.message`
before any per-code mapping, so those two fields exist for every
Postgres-originated error whatever `kind` it gets.

| What failed | Thrown | Where the adapter's error sits | `kind` | Fields present |
|---|---|---|---|---|
| Unmapped SQLSTATE on a typed call (`23514`, `23P01`, `55P03`, `40P01`, `54001`, `57014`…) | `DriverAdapterError` (not a Prisma class), `message` = Postgres primary message | `err.cause` | `postgres` | `originalCode`, `originalMessage`, `code`, `severity`, `message`, `detail?`, `column?`, `hint?` |
| Same SQLSTATE on a raw call | `PrismaClientKnownRequestError` `P2010` | `err.meta.driverAdapterError.cause` | `postgres` | as above |
| `23505` (typed `P2002`, raw `P2010`) | Known | `meta.driverAdapterError.cause` | `UniqueConstraintViolation` | `originalCode`, `originalMessage`, `constraint.fields` (truncated on expression keys); **no `message`** |
| `23503` (typed `P2003`, raw `P2010`) | Known | `meta.driverAdapterError.cause` | `ForeignKeyConstraintViolation` | `originalCode`, `originalMessage`, `constraint.index`; no `message` |
| `40001` (typed `P2034`, raw `P2010`) | Known | `meta.driverAdapterError.cause` | `TransactionWriteConflict` | `originalCode: '40001'`, `originalMessage`; **no `code`** |
| `P2025` | Known | none | — | `meta {modelName, operation}` |
| `P2028` budget expired | Known | none | — | `meta {modelName, operation, timeout, timeTaken}` |
| `P2028` `maxWait` exceeded | Known | none | — | `meta {}` |
| Pool wait exceeded `connectionTimeoutMillis` (`$queryRaw`, `$executeRaw`, a model call, a batch `$transaction([…])`, each behind a raw or an interactive-transaction holder) | plain `Error('timeout exceeded when trying to connect')`, own key `clientVersion` only | none | — | — |
| Bind-parameter count over 65,535 | `DriverAdapterError` | `err.cause` | `postgres` | `originalCode: '08P01'` |
| Connect exceeded `connectionTimeoutMillis` | plain `Error('Connection terminated due to connection timeout')` | none | — | — |
| `ENETUNREACH` / `EHOSTUNREACH` (raw, model) | Known, `code: 'ENETUNREACH'` | none | — | — |
| Same, inside an interactive transaction | the raw pg `Error`, `code: 'ENETUNREACH'` | — | — | — |
| `ECONNREFUSED` | raw: `P2010`; model / tx: `P1001` | `meta.driverAdapterError.cause` | `DatabaseNotReachable` | `host`, `port`; no `originalCode` |

Two consequences the decisions anticipated and the measurements settle:

- **A raw `40001` is recognised by `originalCode`.** It is present on both the
  typed (`P2034`) and the raw (`P2010`) shape; `code` is absent on both. So the
  SQLSTATE is always `originalCode`, and no `code` fallback exists anywhere.
- **Pool exhaustion arrives as one plain `Error` on every non-interactive
  path.** The spec review re-measured it with the holder's query forced to
  run (`S/rev/pool-raw.ts`, `max: 1`, `connectionTimeoutMillis: 500`). The
  premise report's `prisma_pool_exhaustion_model` "ok" row measured
  nothing: its holder was a lazy `PrismaPromise` that never ran.
- **The primary message is `originalMessage`, not `cause.message`.** D2 names
  `cause.message` as the carrier of Postgres's text. That field exists only on
  the `postgres` kind; on `UniqueConstraintViolation` and
  `ForeignKeyConstraintViolation` it is absent, and `originalMessage` holds the
  identical text on every kind. This is a correction of D2's wording, not its
  intent.

## 4. Design, decision by decision

### D1. `engineType = "client"` plus `@prisma/adapter-pg`, everywhere

- `prisma/schema.prisma` generator block gains `engineType = "client"`. The
  output then has no `libquery_engine-*.node`; the generated
  `internal/class.ts` imports `@prisma/client/runtime/client` and lazy-imports
  `@prisma/client/runtime/query_compiler_bg.postgresql.js` plus a 2,600,403-byte
  `query_compiler_bg.postgresql.wasm-base64.js`.
- Dependencies (already added on the branch): `@prisma/adapter-pg` `6.19.3`
  exact, `pg` `^8.23.1`, `@types/pg` (dev).
- Matchers target the C+A shapes only. No matcher keeps a branch for the
  engine framing or the old `meta` fields: nothing can produce them any more.
- Production stays on C+A after merge, conditional on the measurements in §6
  passing on the branch. Rollback is reverting the PR; there is no migration.

### D2. One extractor: `src/lib/pg-error.ts`

A new module, the one place that knows where the adapter puts Postgres's
fields. It imports only `@/lib/prisma-client` (for `instanceof
Prisma.PrismaClientKnownRequestError`) and identifies `DriverAdapterError` by
`name`, never by import.

```ts
/** A Postgres error as the pg driver adapter reports it: only fields Postgres wrote. */
export interface PgError {
  /** The SQLSTATE: the adapter's `originalCode`, which is pg's `DatabaseError.code`. */
  readonly sqlState: string;
  /** Postgres's primary message: the adapter's `originalMessage`. Never logged verbatim. */
  readonly message: string;
  /** The violated constraint's name, for the SQLSTATEs in `CONSTRAINT_SOURCE` only. */
  readonly constraint?: string;
}

export function pgErrorOf(err: unknown): PgError | null;
export function isPgPoolTimeout(err: unknown): boolean;
export function adapterKindOf(err: unknown): AdapterKind | undefined;
```

**`pgErrorOf` contract.** Shallow: it reads `err` itself and never follows
`Error.cause` (the one caller that walks a chain, `transientDbFailure`, keeps
its own bounded walk and calls `pgErrorOf` per link). It returns `null` unless
it finds a cause object, read from exactly one of these paths:

1. `err instanceof Error && err.name === 'DriverAdapterError'` and
   `typeof err.cause === 'object' && err.cause !== null` → `err.cause`.
2. `err instanceof Prisma.PrismaClientKnownRequestError` and
   `err.meta?.driverAdapterError` is an object whose `name` is
   `'DriverAdapterError'` and whose `cause` is an object →
   `err.meta.driverAdapterError.cause`.

From that cause it requires `originalCode` to be a string matching
`/^[0-9A-Z]{5}$/` and `originalMessage` to be a string, else `null`. So the
adapter kinds that carry no Postgres error (`SocketTimeout`,
`DatabaseNotReachable`, `UnsupportedNativeDataType`, `TlsConnectionError`)
answer `null`: they have no SQLSTATE.

**`constraint`** comes from a table keyed by SQLSTATE, typed
`satisfies Record<'23503' | '23505' | '23514' | '23P01', …>` so a SQLSTATE
cannot be added without saying where its name comes from:

| SQLSTATE | Source | Read |
|---|---|---|
| `23503` | structured | `cause.constraint.index` (a string). Absent → no `constraint` (the adapter writes `{fields: [column]}` instead only when pg sets `column`, which Postgres does not for a foreign-key violation) |
| `23505` | Postgres's primary message | `/^duplicate key value violates unique constraint "([^"]+)"$/` on `originalMessage` |
| `23514` | Postgres's primary message | `/ violates check constraint "([^"]+)"$/` on `originalMessage` (a terminality trigger's own text never matches, so a trigger raise has no `constraint`) |
| `23P01` | Postgres's primary message | `/^conflicting key value violates exclusion constraint "([^"]+)"$/` on `originalMessage` |

The 23505, 23514 and 23P01 names have no structured carrier: the adapter drops
pg's `DatabaseError.constraint` for every code but 23503
(`mapDriverError`, quoted in §3's source). The primary message is Postgres's
text, not Prisma's or the engine's framing, and the clauses are anchored, so a
message that merely quotes a name does not match. The acceptance line is
restated in the spec and the PR as: **no matcher reads Prisma's or the
engine's framing; the SQLSTATE always comes from a structured field.**

Refinements to D2, both deliberate:

- **No `detail` field.** D2's sketch lists `detail?`. No matcher and no log
  facet needs it, and it is the field that carries row values
  (`Failing row contains (…)`, `Key (…)=(…)`). An unread field that holds row
  data is only a way to leak it.
- **`constraint` is filled for all four SQLSTATEs, not only 23503.** D2 puts
  only the structured 23503 name on the type and leaves the parsing to the
  matchers. One extractor is simpler: every matcher reads
  `pgErrorOf(err)?.constraint`, and where the name came from is stated once,
  in the table above.

**`isPgPoolTimeout(err)`** is true when `err instanceof Error`,
`err.message === 'timeout exceeded when trying to connect'` (exact equality,
the literal pg-pool writes at `pg-pool/index.js:224`), `err` has no own `code`,
and `pgErrorOf(err) === null`. It is driver text, matched once, here, and
documented as such. A real-DB test produces it (§7), so a pg-pool rewording
reddens a test instead of silently turning 503s into 500s.

**`adapterKindOf(err)`** reads `cause.kind` from the same two paths, for the
log facet only (D6). It returns a member of a closed set and `undefined`
otherwise. The set is `@prisma/client/runtime/client.d.ts`'s `MappedError`
kinds minus the other databases' (`mysql`, `sqlite`, `mssql`). That type is
not exported, so the compiler cannot tether the set; a unit test does, by
reading the same block and comparing it with `ADAPTER_KINDS`. A kind outside
the set is simply not logged (fails closed), and
`docs/technical-architecture.md` carries the re-derivation:
`sed -n '/^declare type MappedError = {/,/^};/p' node_modules/@prisma/client/runtime/client.d.ts | grep -oE "kind: '[A-Za-z]+'"`.

Why the alternative "read `meta` and `cause` at each site" is rejected: it is
the shape that let `isMintKeyRefusal` and `isRestrictViolationOn` read
`meta.constraint` independently, and break independently.

### D2 and D3 applied: every matcher in the census

The census commands are in §11. Every row is a site the report's census lists,
including the ones the issue omits.

| Site | Today reads | After |
|---|---|---|
| `api-errors.ts` `isTerminalStatusViolation` | `'which is terminal'` + `code: "23514"` / ``Code: `23514` `` in `err.message` | Becomes `terminalViolationOf(err): PgError \| null` — `pgErrorOf(err)`, `sqlState === '23514'`, `message.includes('which is terminal')`. Admits typed and raw, because both carry the cause |
| `api-errors.ts` trigger facet in `classifyApiError` | `TERMINAL_TRIGGER_TAILS` against `err.message` | Against the returned `PgError.message` |
| `api-errors.ts` `transientKindShallow` | `TRANSIENT_PRISMA_CODE_KIND` on Known `code`, then SQLSTATE framing in `message` | (1) `pgErrorOf(err)?.sqlState` in `TRANSIENT_SQLSTATE_KIND`; (2) Known `code` in `TRANSIENT_PRISMA_CODE_KIND`, now `P2028 → tx_budget` and `P2034 → serialization` (`P2024` removed: it cannot arise); (3) `isPgPoolTimeout(err) → pool_exhausted`. The `MAX_CAUSE_DEPTH` walk is unchanged; a `DriverAdapterError` is read at its own link, so its plain-object `cause` is never needed |
| `api-errors.ts` `isRecordNotFound` | Known `code === 'P2025'` | Unchanged (`P2025` still arrives; only its `meta` changed, which nothing reads) |
| `api-errors.ts` `isRestrictViolationOn` | `P2003` `meta.constraint` | `pg.sqlState === '23503'` and `constraints.includes(pg.constraint)`. Also admits a raw (`P2010`) foreign-key refusal on a named constraint, which means the same thing |
| `api-errors.ts` `classifyApiError` P2002 fallback | `detail: { target: meta.target }` | Gate unchanged (`code === 'P2002'`); `detail: { constraint: pgErrorOf(error)?.constraint }`. The gate is not widened to raw `23505`: that would move an escaped raw unique violation from 500 to 409, a behaviour change nobody asked for |
| `api-errors.ts` exclusion fallbacks | via `isExclusionConflictOn` | Unchanged call sites |
| `check-violation.ts` `isCheckViolationOn` | framing + clause in both quotings | `constraint !== ''`, `pg.sqlState === '23514'`, `pg.constraint === constraint` |
| `exclusion-conflict.ts` `isExclusionConflictOn` | Unknown: bare `'23P01'` + clause; P2010: framing + clause | `pg.sqlState === '23P01'`, `pg.constraint === constraint` |
| `unique-conflict.ts` `isUniqueConflictOn` | `meta.target` column list, unwrapped by `extractColumnIdentifier` | `isUniqueConflictOn(err, names: readonly UniqueConstraintName[])`: `pg.sqlState === '23505'` and `names.includes(pg.constraint)`. `extractColumnIdentifier` is deleted. See D3 |
| `payout-notice.ts` `isMintKeyRefusal` | `P2003` `meta.constraint` | `pg.sqlState === '23503'` and `PAUSE_TOKEN_FOREIGN_KEYS.has(pg.constraint)`. Stays local: an insert's dangling key is not a "restrict", so `isRestrictViolationOn`'s name would lie |
| `log-serializers.ts` `liftSqlState`, `CONSTRAINT`, `PG_MESSAGE`, `CONNECTOR_KIND`, `txErrorKind`, the code rule, the withheld path | engine text and `meta` | D6 |
| `rawTarget: err.meta?.target` in `account/student-profile/route.ts:202`, `account/teacher-profile/route.ts:189`, `teacher-rooms/route.ts:135`, `services/invitations.ts:419` | `meta.target` (log only) | `constraint: pgErrorOf(err)?.constraint` |
| bare `code === 'P2002'` in `invitations/[id]/route.ts:261`, `lib/auth/account.ts:72`, `services/admin-grants.ts:48`; `'P2025'` in `services/waitlist.ts:1173` | `code` | Unchanged: the P-codes still arrive (`S/shapes.json`) |
| `tests/stack-ceiling.ts` `isStackDepthError` | P2010 `meta.code`; Unknown `PostgresError { code: "54001"` | `pgErrorOf(err)?.sqlState === '54001'`. Its only remaining producer is the app's raw row-value SQL (`P2010`, measured); a Prisma relation load no longer overflows (§2 item 14, D11) |
| `scripts/prisma-engine-probe.cjs` | P1001's message text, `could not locate the Query Engine` | D7 |
| `.github/workflows/ci.yml` reserved-slug step | `grep -q 'P1001'` | D7 |
| `.github/workflows/ci.yml` "App log (on failure)" greps (two jobs) | `…\|P2024\|P2028\|P2034` in `server.log` | `P2024` replaced by `pool_exhausted` (the `transientKind` value); the SQLSTATEs reappear through the serializer's `sqlState` (D6) |

The consumers that read no message themselves (`rule-lifecycle.ts`,
`room-deletion.ts`, `room-archive.ts`, `class-lifecycle.ts`, the routes) keep
their calls; only `isUniqueConflictOn`'s callers change their argument.

### D3. `isUniqueConflictOn` takes constraint names

The column-list argument becomes a list of index names, and the names are
compiler-checked against one registry:

```ts
// src/lib/unique-conflict.ts
export const UNIQUE_CONSTRAINTS = [ /* every name a caller passes */ ] as const;
export type UniqueConstraintName = (typeof UNIQUE_CONSTRAINTS)[number];
```

A typo at a call site is then a compile error. The registry itself is tethered
to the database by a real-DB test: for every member it asserts that
`pg_indexes` holds a unique index of that name. That query must cast,
`indexname::text`, because the adapter refuses `name` columns. Each caller's
own 409 is in turn produced against the real DB (§7), which is acceptance
anyway.

The call sites, re-derived with
`git grep -o "isUniqueConflictOn(err" -- src ':!*.test.ts' ':!src/lib/unique-conflict.ts'`
(18 calls on 17 lines; `student-profile/route.ts:168` holds two), and
the names each must pass, read from the migrated dev database
(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%'`):

| Call site | Columns today | Names after |
|---|---|---|
| `account/student-profile/route.ts:168` (session) | `['accountId']` / `['email']` | `Student_account_live_unique` / `Student_email_key` (plus `Account_email_key` if the plan finds the session path can create an `Account`) |
| `account/student-profile/route.ts:180` (ticket) | `['email']` | `Student_email_key`, `Account_email_key` (the ticket path creates the `Account` in the same write) |
| `account/teacher-profile/route.ts:79-81` (`isSessionCollision`) | `accountId` / `email` / `pageSlug` | `Teacher_account_live_unique` / `Teacher_email_key` / `Teacher_pageSlug_key` (the session path passes a scalar `accountId` and writes no `Account` row, so `Account_email_key` cannot arise) |
| `account/teacher-profile/route.ts:144,156` | `['pageSlug']` | `Teacher_pageSlug_key` |
| `account/teacher-profile/route.ts:168` | `['email']` | `Teacher_email_key`, `Account_email_key` |
| `registrations/route.ts:544` | `['classId', 'studentId']` | `Registration_classId_studentId_key` |
| `rooms/[id]/publish/route.ts:84` | `['address', 'floor', 'roomName']` | `Room_public_identity_unique` |
| `rooms/[id]/route.ts:214` | `['createdById', 'address', 'floor', 'roomName']` | `Room_private_identity_unique` |
| `rooms/route.ts:99-100` | both room sets | `Room_public_identity_unique`, `Room_private_identity_unique` |
| `teacher-rooms/route.ts:117` | `['teacherId', 'roomId']` | `TeacherRoom_teacherId_roomId_key` |
| `teachers/[id]/route.ts:99` | `['pageSlug']` | `Teacher_pageSlug_key` |
| `services/class-lifecycle.ts:1792` | `['scheduleRuleId', 'date']` | `CalendarEntry_scheduleRuleId_date_key` |
| `services/invitations.ts:402` | `['teacherId', 'email']` | `Invitation_teacherId_email_key` |

**This is narrower than the column match, on purpose, and a missed name is
a 500 at four sites.** Four column sets that callers pass name a unique key
on more than one table: `(classId, studentId)` (`Registration`,
`WaitlistEntry`), `(teacherId, email)` (`Invitation`, `TeacherBlock`),
`email` (`Teacher`, `Student`, `Account`) and `accountId`
(`Teacher_account_live_unique`, `Student_account_live_unique`,
`AdminGrant_account_active_unique`). A column match accepted a collision on
whichever table it happened on; a name match accepts only the named one. The
spec review measured that a nested `account: { create }` collision reports
`Account_email_key`, not the parent's key (`S/rev/nested.ts`,
`nested_account_email_dup`), so the parent model is no guide to the name.

What a missed name costs depends on the site. `registrations/route.ts:544`
and the rooms routes rethrow, so an unlisted name reaches `classifyApiError`'s
P2002 fallback and still answers 409. **Four sites have a local P2002 net
that logs at `error` and throws a plain `Error`, a 500:**

- `account/student-profile/route.ts:196-204` (`student profile create: unrecognised unique constraint`)
- `account/teacher-profile/route.ts:187-192`
- `services/invitations.ts:413-421`
- `teacher-rooms/route.ts:129-138`

The plan enumerates these four and requires a per-site verdict: every unique
collision each `try` block can raise (every table it writes, nested writes
included) is either named at that site's matcher or deliberately left to its
500. Each named collision gets a produced-error test that asserts the site's
409. That covers `Account_email_key` on both profile routes' ticket paths,
`Teacher_account_live_unique` and `Student_account_live_unique` on the
session paths, `Invitation_teacherId_email_key` and
`TeacherRoom_teacherId_roomId_key`. `registrations/route.ts:544` gets the same
read, so a `WaitlistEntry` key in its block is decided rather than
inherited.

Test call sites change the same way (`slot-constraints.test.ts`,
`waitlist-position-index.test.ts` → `WaitlistEntry_waiting_position_key`,
`live-profile-unique.test.ts`, `room-identity-index.test.ts`,
`unique-conflict.test.ts`), and the comment at
`tests/integration/erased-profile-restart.test.ts:167`, which describes
column matching, is rewritten. `docs/data-model.md`'s room-identity paragraph,
which describes the unwrapping, is rewritten.

### D4. Pool policy lives in the factory

`src/lib/prisma-client.ts`:

```ts
export interface PrismaClientFactoryOptions {
  /** Connection string. Omitted, `DATABASE_URL` is read when the client is built. */
  url?: string;
  /** pg's `max`. Omitted, `DEFAULT_POOL_MAX`. */
  poolMax?: number;
  /** pg's `connectionTimeoutMillis`: bounds both a pool wait and a new connection. */
  connectionTimeoutMs?: number;
  errorFormat?: Prisma.PrismaClientOptions['errorFormat'];
  /** Passed through; the ceiling tests count bound parameters from the query event (D11). */
  log?: Prisma.PrismaClientOptions['log'];
}
```

The factory builds
`new PrismaClient({ adapter: new PrismaPg(poolConfigFor(options)), errorFormat, log })`,
never `datasources`. `poolConfigFor` is exported so the defaults are
unit-testable without opening a connection.

Settled sub-questions:

- **Option names.** `poolMax`, and `connectionTimeoutMs` rather than D4's
  `poolTimeoutMs`: pg has one knob, and it bounds both waiting for a pooled
  client and establishing a new one (pg-pool passes its options to each
  `Client`). A name that says only "pool" would hide the second meaning, which
  is the one that keeps the health route from hanging.
- **`max` default: `os.availableParallelism() * 2 + 1`.** Prisma's formula is
  physical cores × 2 + 1, and Node exposes no physical-core count. Where there
  is no SMT, logical equals physical and the two formulas agree. On SMT
  hardware the stand-in gives a larger pool. Connections open lazily, but
  each one opened then stays up to the 300 s idle timeout. Dev machine
  measured: `availableParallelism() = 10`, `hw.physicalcpu = 10`, so 21 either
  way. CI's `ubuntu-latest` (4 vCPU, likely SMT) probably goes from 5 to 9.
  CI's pool size is not measured, by decision: it affects only test
  defaults.
- **Production value: 9, not 3.** D4 states "1 vCPU → 3", following
  `docs/technical-architecture.md`'s "VPS (2GB RAM, 1 vCPU)" and the `gdpr.ts`
  comment. The production host is a Hetzner CAX21: 4 Ampere Arm vCPUs, which
  have no SMT, so physical = logical = 4 and the pool is 4 × 2 + 1 = 9 under
  Prisma's formula today and under the stand-in after. `docker-compose.prod.yml`
  sets no CPU limit (`grep -n -i cpu docker-compose.prod.yml` prints nothing).
  The "three connections" arithmetic in `gdpr.ts` was therefore already wrong
  for the deployed box. The 9 is derived from the CAX21's published spec, not
  measured on the server: `docs/technical-architecture.md` says so, with the
  re-derivation command
  `docker compose -f docker-compose.prod.yml exec app node -e "console.log(require('os').availableParallelism())"`,
  which must print `4`. The number goes there, not in a comment.
- **`connectionTimeoutMillis` default: 10 000**, Prisma's `pool_timeout`
  default. Trade-off, recorded: Prisma bounded a new connection separately at
  `connect_timeout` 5 s. With one knob, an unreachable host now takes up to
  10 s to fail instead of 5 s. Bounded either way; today, with the adapter and
  no timeout, it would be the SYN timeout.
- **`idleTimeoutMillis`: 300 000, fixed, not an option.** It matches Prisma's
  `max_idle_connection_lifetime` default and keeps the single-connection test
  clients on one backend between statements (item 6 of §2). pg's 10 s default
  would reopen connections more often in production and could silently change
  a single-connection client's backend PID mid-test.
- **`allowExitOnIdle: true`, fixed.** pg-pool's idle sockets hold the event
  loop for the whole idle timeout. The library engine's connections never
  did. The spec review measured it (`S/rev/exit.ts` against
  `S/rev/exit-lib.ts`): one query and no `$disconnect()` exits after 9 s on C+A
  with an 8 s idle timeout, and after 1 s on the library engine. With 300 s,
  every `tsx` script, vitest worker or Playwright process that ends without
  `$disconnect()` would linger for up to five minutes. `src/lib/db.ts`'s
  singleton never disconnects, and neither do several test clients (re-derive:
  `for f in $(git grep -l "createPrismaClient(" -- src tests scripts prisma ':!src/lib/prisma-client.ts'); do grep -q '\$disconnect' $f || echo $f; done`).
  `allowExitOnIdle` only unrefs idle clients and closes nothing
  (`pg-pool/index.js:92,417-423`), so the single-connection guarantee above
  holds. The production server is held open by its HTTP listener anyway.
- **A missing URL throws at construction**
  (`createPrismaClient: no url given and DATABASE_URL is not set`). An empty
  string counts as missing. `vitest.config.ts:30` resolves the URL to `''`
  when neither the environment nor `.env` has it, and pg reads an empty
  `connectionString` as "use libpq defaults" (localhost:5432 as the OS user),
  where Prisma refused to start. Every
  runtime that constructs a client already sets the variable, because the
  current client resolves it at construction too: the Dockerfile build stage
  sets a dummy URL for that reason, and so does CI's build job
  (`ci.yml:154-156`). The plan measures that `next build` and every vitest
  project still construct without error. If one does not, that caller gets
  the variable; the factory does not grow a lazy path.
- **`poolMax` must be a positive integer**; anything else throws `RangeError`
  at construction.

Callers that relied on URL parameters move to the options:

| Caller | Today | After |
|---|---|---|
| `tests/stack-ceiling.ts` `lowStackClient` | `connection_limit=1` + session `SET max_stack_depth`, then a read-back | The URL carries `options=-c max_stack_depth=200kB`, set with `URLSearchParams.set('options', …)` so the space and `=` are encoded. Postgres applies it at startup to every connection the pool opens, so the session `SET` goes and the read-back stays. Measured with raw pg: three pooled connections each read `200kB` (`S/startup-options.cjs`), and PrismaPg hands the same config to `pg.Pool`. `max_stack_depth` is superuser-only, the same privilege the session `SET` needs today; the dev and CI roles are superusers. No pool-size dependence is left to break |
| `scripts/measure-push-fanout.ts` | `connection_limit` on both the `setup` client (`:43`, 5) and the per-run client (`:99`) | `poolMax: 5` and `poolMax: poolSize` |
| `src/lib/auth/handoff.test.ts:1128` | `connection_limit = nonces + 5` | `poolMax: nonces.length + 5` |
| `template-room-race.test.ts:52`, `transition-class-lock-order.test.ts:70`, `update-class-lock-order.test.ts:79` | `connection_limit=1` | `poolMax: 1` |

**Pool exhaustion: chosen classification and the rejected one.** Chosen: the
exact pg-pool literal on a non-Prisma `Error` with no `code`
(`isPgPoolTimeout`), classified `pool_exhausted` at `error`, tested by
producing it.

Rejected: passing our own `pg.Pool` subclass to `PrismaPg` and re-tagging the
timeout there. The literal match does not go away, it only moves into the
subclass. The subclass would have to override both of pg-pool's calling
conventions (`pool.query` uses the callback form of `connect`, a transaction
start uses the promise form). And it would rest on undocumented Prisma
behaviour that the measurements show differs by path: an unmapped error that
carries a `code` becomes a `PrismaClientKnownRequestError` with that code on
raw and model calls, but stays the raw error inside an interactive
transaction (`S/probe3-client.log`, the `ENETUNREACH` rows). More machinery,
the same driver string, and a new dependency on Prisma internals.

What `pool_exhausted` covers, as measured: any call whose wait for a pooled
connection outlives `connectionTimeoutMs`. That means raw and model calls, a
batch `$transaction([…])` (`S/rev/pool-raw.ts`), **and an interactive
transaction**. Prisma's `maxWait` is not a deadline that fires while an
interactive transaction waits at the pool; it is judged once the pool hands
over a connection. So an interactive transaction behind a drained pool ends
one of two ways: a wait that outlives the pool bound is pg-pool's timeout,
`pool_exhausted` at `error`, whatever `maxWait` says; a connection freed
within the pool bound but after `maxWait` is `P2028` with `meta {}`,
`tx_budget` at `warn` (Task 8's measurement, `db-transient-shapes.test.ts`).
With the defaults (`maxWait` 2 s, pool bound 10 s), a wait that ends between
2 s and 10 s is `tx_budget` and one that reaches 10 s is `pool_exhausted`.
Stated in `docs/technical-architecture.md`, not left to a reader's assumption.

Comments that assert the old pool arithmetic are rewritten to what is true,
without numbers that reach past their file (*Comment Discipline*): the
`gdpr.ts` block at `:1001-1019` keeps its reasoning (one erasure can hold a
connection for its whole 20 s budget; a request that cannot get one fails at
the pool's bound and is answered as transient) and links to
`docs/technical-architecture.md` for the pool size and the bound. The
daily-cleanup route's "one connection pool of three (one vCPU)" becomes "one
connection pool". The `P2024` mentions in `account/route.ts:37`,
`waitlist-reconciliation.ts:493`, `class-template-lifecycle.ts:1122` and
`studio-class-template-lifecycle.ts:753` name pool exhaustion by its
`TransientKind` instead.

### D5. `P2034` is `serialization`

`TRANSIENT_PRISMA_CODE_KIND` maps `P2034 → serialization`, because that is
what it was measured to be (`t40001_typed`: `P2034`, cause
`originalCode: '40001'`). The SQLSTATE map already says the same for the raw
shape, so both shapes of one event now get one kind. Consequence: a typed
`40001` logs at `warn` (`serialization`'s level), where it would have logged at
`error`. The `TransientKind` and `TRANSIENT_KIND_LEVEL` docblocks lose the
"Prisma documents P2034 as write conflict or deadlock, and a write conflict
needs RR or serializable, which this repo has none of" argument. That argument
was a census of other files in a comment, and the measurement falsifies its
conclusion anyway. The level rationale for `serialization` stays local; which
code paths can raise a `40001` belongs in `docs/lock-order.md`, not here. This
reverses the `P2034` call in
`docs/superpowers/specs/2026-09-23-transient-kind-design.md`, which followed
Prisma's documentation; the PR body says so.

### D6. The log serializer

`src/lib/log-serializers.ts`:

- **Withheld classes.** `prismaClass` becomes `withheldClass`: the
  `PrismaClient*Error` classes as today, plus `name === 'DriverAdapterError'`
  (by name, so a duplicate package instance fails closed too). Its message
  becomes `Driver adapter error (detail withheld from the log)`. Its stack
  keeps frames only, through the existing `isFrameShape` logic. Its `name` is
  kept (the name filter admits `DriverAdapterError`).
- **A withheld error's `cause` is not walked when it is not an `Error`.** That
  closes the leak in §2 item 3: `DriverAdapterError.cause` is a plain object
  with a string `message`, which `isErrorLike` accepts. What the log needs
  from it is lifted through `pgErrorOf` instead. A real `Error` cause under a
  withheld error is still walked, as today.
- **`sqlState`** is `pgErrorOf(err)?.sqlState` on every withheld error, Known
  or `DriverAdapterError`, replacing `PG_CODE` and the `meta.code` read.
  **`constraint`** is `pg.constraint` for the four constraint SQLSTATEs,
  replacing the `CONSTRAINT` regex over the whole message. **`trigger`** and
  **`rowIds`** are read from `pg.message` (the Postgres primary message) when
  `sqlState === '23514'` and there is no `constraint`, replacing `PG_MESSAGE`.
  The logic is unchanged; only the carrier moves.
- **`connectorKind` becomes `adapterKind`**, from `adapterKindOf(err)`, emitted
  when there is no `sqlState`: `DatabaseNotReachable`, `SocketTimeout`,
  `ConnectionClosed` and the rest of the closed set. `CONNECTOR_KIND` and
  `CONNECTOR_KINDS` go; the engine text they read no longer exists.
- **The `code` rule on the withheld path** keeps a string matching
  `/^P\d{4}$/` or Node's code shape `/^E[A-Z0-9_]{1,63}$/`. That one pattern
  admits the errno codes (`ENETUNREACH`, `EHOSTUNREACH`, `EAI_AGAIN`) and
  Node's `ERR_*` codes (`ERR_MODULE_NOT_FOUND`). Prisma wraps *any* unmapped
  error that carries a `code` into a `PrismaClientKnownRequestError` with that
  code. The spec review hit it: a client whose `@prisma/client` runtime did
  not resolve threw `code: "ERR_MODULE_NOT_FOUND"` from the generated
  `class.ts`'s lazy query-compiler import, on a `$queryRaw`. Under a
  `P`/errno-only rule that line would carry no code, and the message is
  withheld. These are fixed identifiers that carry no row data; the length
  bound keeps an arbitrary string out. A string code of any other shape is
  still dropped.
- **`txError`** for `P2028`: `'expired'` when `meta.timeout` and
  `meta.timeTaken` are both finite numbers, else `'other'`. `TxErrorKind`
  narrows to `'expired' | 'other'`. `start_timeout`, `not_found` and `closed`
  were read from `meta.error`'s text, which no longer exists, and no
  structured field tells them apart: a `maxWait` refusal measures as
  `meta {}`. Reading the P2028 message instead would be reading Prisma's
  framing.
- **`META_KEYS`**: `timeTaken` (number) added; `target` and `connection_limit`
  removed. On C+A, `P2002` has no `meta.target` and `P2024` does not exist,
  and D1 rules out keeping allowlist entries for a shape that cannot arrive.
- `degradation-digest.ts`'s `describeFailure` reads `code` and `sqlState` and
  needs no change: it gets the errno codes and the lifted SQLSTATEs for free.

**The #888 / #901 note**, re-evaluated: that note found the health route's
logged error carrying no `code` for a lazy-connect failure. On C+A that
initialization error no longer arises for an unreachable host. Each case
leaves something in the line: `--network none` logs
`code: 'ENETUNREACH'`; a refused port logs `code: 'P2010'` plus
`adapterKind: 'DatabaseNotReachable'`; a silent host logs a plain error after
`connectionTimeoutMs`, message
`Connection terminated due to connection timeout`, which is pg's text, carries
no row data, and is not withheld because it is not a Prisma class. The note is
answered by this change; the PR says so on #885.

### D7. CI

**Runner probe.** `scripts/prisma-engine-probe.cjs` is renamed
`scripts/prisma-client-probe.cjs` (the engine it named is gone). It still
boots `/app/server.js` under `--network none` with `DATABASE_URL` at
`203.0.113.1` (RFC 5737); the `?connect_timeout=3` goes, since pg ignores it.
It still waits for the `health check: database probe failed` log line. It
passes only when that line's `err.type` is `PrismaClientKnownRequestError` and
its `err.code` is `ENETUNREACH`. Together those say the bundle constructed a
client, the client handed the query to the adapter, and pg tried the network.
The `ENGINE_MISSING` branch is replaced by two named failures, both keyed on
Turbopack's `Failed to load external module` text in the server's unwithheld
output, because the error a missing module produces carries no `code` (§6
item 5's measurement). The check runs while the probe still awaits the first
HTTP response as well as while it reads the log. A missing query compiler
lets the server answer and logs a probe line whose error is a plain `Error`
with no `code`: the bundle is missing a module the client loads lazily. A
missing `pg` stops the server at instrumentation-hook load, before it answers
HTTP, so no probe line is written: a module failed at import. The success
check is unchanged: the logged `err.type` and `err.code`, never the message.
Success line: `client loaded; database unreachable with ENETUNREACH as expected`.
The step is renamed "Prisma client loads in the runner image", and its `grep`
and `::error::` text follow.

**Reserved-slug step.** `scripts/check-reserved-slugs.ts` drops its explicit
`$connect()`. That call connects nothing under the adapter, and the gate's own
query now fails with the errno in hand: the model call's error is a Known
error with `code: 'ENETUNREACH'`, which `console.error` prints. The step's
`grep -q 'P1001'` becomes `grep -q 'ENETUNREACH'`, and its comment and
`::error::` text follow. D7 offered a `SELECT 1` instead; it would prove
nothing the gate's query does not, and it adds a statement whose only job is a
CI string. `reserved-slug-holders.test.ts`'s refused-port case (`127.0.0.1:1`,
which surfaces as `P1001` on a model call) keeps asserting the exit status
and the refusal line, which do not depend on the code.

**Unchanged:** "Prisma schema engine loads in the migration image" (`prisma
migrate status` uses the CLI's schema engine and its own URL handling, not the
client).

**Must be measured on locally built images before any string is committed**
(§6): the runner probe's logged `type` and `code`, the reserved-slug output,
and the failure texts of the two broken-image mutations. `ENETUNREACH` so far
comes from raw pg in `node:24-alpine` and from a simulated pool error fed
through Prisma (`S/probe3.ts`), never from the real bundle in the real image.

### D8. `$queryRaw` of `name` / `char` columns

Cast `::text` at every site the full suite run on C+A surfaces. The three
known ones are the `SELECT current_database()` guards (§2 item 11), which
become `SELECT current_database()::text AS current_database`, keeping the
column name the guards read. Every further site the run finds is listed in
the PR with its fix. The registry test's `pg_indexes` query (D3) is written
with the cast from the start.

### D9. Bundling, packaging and the docs

- **No `serverExternalPackages`.** Next 16.4.0 already externalises `pg` and
  `@prisma/client` by default
  (`grep -nE '"(pg|@prisma/client)"' node_modules/next/dist/lib/server-external-packages.jsonc`
  prints lines 16 and 67). `@prisma/adapter-pg` is not on the list, so it is
  bundled, and its `require('pg')` resolves to the external. Adding the option
  would restate a default.
- **Build checks the plan runs** (§6 lists them with their expected output):
  `next build` succeeds and its output is read for any `pg-native` or
  `query_compiler` warning; the standalone tree carries `pg` and its
  dependencies plus `@prisma/client/runtime/client.js`,
  `query_compiler_bg.postgresql.js` and
  `query_compiler_bg.postgresql.wasm-base64.js`, and no `*.node`; the
  externals re-derivation prints `@prisma/client/runtime/client`; the
  standalone server answers `/api/health` `{"status":"ok","db":"up"}` against
  a real database and serves a page that runs model queries.
- **`pnpm-workspace.yaml` `allowBuilds`: unchanged.** `@prisma/engines` is
  still needed, because its postinstall fetches the schema engine that
  `migrate` uses. The `@prisma/client` entry's postinstall does not depend on
  `engineType`; #888's spec already scoped it out ("redundant, harmless, and
  gone with v7"), and nothing here changes that.
- **Lint.** The `no-restricted-imports` block that refuses `@prisma/client`
  outside the funnels also refuses `pg`, `pg/*` and `@prisma/adapter-pg`
  outside `src/lib/prisma-client.ts`, so no module builds a second pool.
- **Funnel pins.** `src/lib/prisma-client.test.ts`'s "imports only the
  generated client" becomes "imports only the generated client,
  `@prisma/adapter-pg` and `node:os`". New pins: the schema declares
  `engineType = "client"`, and the generated output contains no `*.node` file.
- **Version tether.** A unit test asserts that the installed
  `@prisma/adapter-pg`'s version equals `Prisma.prismaVersion.client`. The
  version is read from the `package.json` found by walking up from
  `require.resolve('@prisma/adapter-pg')`, the main entry. Resolving
  `@prisma/adapter-pg/package.json` directly throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, because the package exports only `"."`.
  Reading by path crosses no lint rule. A caret on `@prisma/client` could otherwise
  drift away from the exactly pinned adapter on a lockfile refresh.
- **Dockerfile.** The migrate stage's comment on `src/lib/prisma-client.ts`
  ("it imports only the client generated above") is rewritten; the stage is
  built `FROM deps`, so `pg` and the adapter are present. No COPY changes.

**Docs to rewrite** (each is a description the change makes false, not only a
name; §8's sweep is for the names):

- `docs/technical-architecture.md`, Database → "Where Prisma comes from": the
  client engine plus adapter, the factory options and pool defaults with the
  formula, the production value and its re-derivation, `$connect()`
  connecting nothing, and the `datasources` refusal. The `.node` trace
  paragraph (`:1375`) and the `runtime/library` external sentence (`:1432`) go.
  A new subsection, "Database errors", owns the `pgErrorOf` contract, §3's
  table, the clause patterns, the locale assumption (§9), and the
  `pool_exhausted` / `tx_budget` split. The matcher docblocks link to it.
  `:325-326` (`lowStackClient`) and `:1627` (the push fan-out paragraph's
  `pool_timeout` and pool arithmetic) are corrected. "Relation loads over
  platform-wide sets" (`:300-312`, the `:304` row-value-`IN` mechanism and its
  7,500-tuple stack threshold) is rewritten to D11's mechanism.
- `src/lib/read-in-pages.ts:3`: the `SWEEP_PAGE_SIZE` docblock's "one
  row-value `IN` list in the SQL Prisma sends, and the Postgres parser's stack
  grows with that list" becomes the bind-parameter reason (D11), still
  linking to the docs section rather than stating the threshold.
- `docs/supply-chain.md` "Prisma's engine in the images": what the runner
  carries now, what the renamed probe proves, the re-derivations, the measured
  image sizes.
- `docs/data-model.md:1105`: room identity matched by constraint name.
- `docs/lock-order.md:1230-1244`: the present-tense claim that `40P01`
  arrives as an Unknown error "the exact shape `isTransientDbError` matches".
  The dated measurement block near `:3128` stays, since it is dated.
- The docblocks of every rewritten matcher (`api-errors.ts`,
  `check-violation.ts`, `exclusion-conflict.ts`, `unique-conflict.ts`), whose
  measured-shape quotations describe L. They are rewritten to the C+A shapes
  by linking to the new docs subsection, not by quoting shapes inline. Also
  `rule-lifecycle.ts:143`, `rooms/[id]/route.ts:82`,
  `registrations/route.ts:542` and `payout-notice.ts:7`, which name
  `meta.constraint` / `meta.target`; the `check-reserved-slugs.ts` and probe
  headers; and the `ci.yml` step comments.

### D10. Tests

§7.

### D11. Paging stays; the ceiling tests are re-based on the bind-parameter limit

Decided on §2 item 14's measurement:

- **`readInPages` and `SWEEP_PAGE_SIZE` stay.** Without paging, a platform-wide
  sweep over more than 21,844 composite-key parents fails with `08P01`, a 500,
  every time it runs; an `in:` list past 32,766 parameters in a statement
  Prisma does not split fails with `P2029` (§2 item 14). The
  failure moves from about 7,500 parents (L, default stack) to 21,845 (C+A).
  The reason for paging changes, not the need. `SWEEP_PAGE_SIZE` at 500 keeps
  a composite load at 1,501 parameters.
- **The harness keeps one stack test**, for app-authored SQL:
  `rowValueIn(CEILING_ROWS)` under `lowStackClient` still overflows (`P2010`,
  `54001`, measured), so `isStackDepthError` keeps a real producer, and
  `rowValueIn(SWEEP_PAGE_SIZE)` resolves.
- **The relation-load tests assert on bound parameters, not on 54001.** A
  test client counts each statement's parameters from Prisma's query event.
  That needs the factory to pass `log` through, as it passes `errorFormat`.
  Each per-site test in `sweep-page-ceiling.test.ts` seeds `CEILING_ROWS`
  parents, as today, and asserts that no statement the paged read sends binds
  more than `3 * SWEEP_PAGE_SIZE + 1` parameters. Unpaged, the same read sends
  `3 * CEILING_ROWS + 1`, so un-paging a site reddens its test, on the number.
  The seed size and the run time do not grow.
- **One harness test proves the limit is real**, so the bound above is not an
  arbitrary number: an unpaged load over 21,845 composite parents, seeded in
  SQL by `generate_series` as `S/rev2/ceiling.ts` does, fails with `08P01`,
  and the 21,844 load resolves. It lives in the serial sweep tier, and the
  plan records its seed and run time. If they are too slow for the suite,
  the test becomes a documented re-derivation in
  `docs/technical-architecture.md` instead, with the measured numbers.
- `tests/stack-ceiling.ts` and its docblock (and the `#674` spec's
  rationale, by a dated note in the PR body, not an edit to the old spec) say
  what each test now proves.

## 5. Files

New: `src/lib/pg-error.ts`; `src/lib/pg-error.test.ts` (real DB, conflict
codes); `src/lib/db-transient-shapes.test.ts` (real DB, transient kinds; added
to `LOCK_CONTENTION_TESTS` in `vitest.tiers.ts`, because it asserts on lock
timing); `tests/adapter-errors.ts` (the fabrication helper); `scripts/prisma-client-probe.cjs`
(renamed).

Changed: `prisma/schema.prisma`, `src/lib/prisma-client.ts`,
`src/lib/api-errors.ts`, `src/lib/check-violation.ts`,
`src/lib/exclusion-conflict.ts`, `src/lib/unique-conflict.ts`,
`src/lib/log-serializers.ts`, `src/services/payout-notice.ts`, the 18
`isUniqueConflictOn` call lines and the four `rawTarget` logs,
`tests/stack-ceiling.ts`, `src/services/sweep-page-ceiling.test.ts` (D11),
`src/lib/read-in-pages.ts` (docblock), `scripts/measure-push-fanout.ts`,
`scripts/check-reserved-slugs.ts`, `eslint.config.mjs`, `Dockerfile`
(comment), `.github/workflows/ci.yml`, the comment sites in D4, and the docs
in D9. Tests: §7.

## 6. Measure first, then commit

None of these has been measured yet. Each result goes in the PR body, or in
the doc named, with its command.

1. **Full suite on C+A**, all tiers (unit, unit-sweeps, integration against
   the worktree's own dev server, e2e). Every failure gets a verdict; every
   `UnsupportedNativeDataType` gets a `::text` (D8).
2. **`next build`**: it succeeds; its log is read for `pg-native` and
   `query_compiler` warnings.
3. **Standalone tree**:
   `find .next-build/standalone -name '*.node'` prints nothing;
   `find .next-build/standalone/node_modules -path '*pg*' -maxdepth 4 -type d` shows
   `pg`, `pg-pool`, `pg-protocol`, `pg-types` and `pg-connection-string`;
   `find .next-build/standalone -name 'query_compiler_bg.postgresql*'` shows
   the `.js` and the `.wasm-base64.js`;
   `grep -rhoE '@prisma/client[^"]*' .next-build/server --include='*.js' | sed -E 's/-[0-9a-f]{16}//' | sort -u`
   is recorded in `supply-chain.md`.
4. **Does the health route's `$queryRaw` load the query compiler?** Build a
   scratch runner image with the `wasm-base64.js` removed and run the probe.
   If the probe still passes, a raw query does not exercise the compiler, and
   the probe proves less than it claims. The fix is then a probe that reads a
   route running a model query, or a health check that runs one. Decided on
   the measurement, not before.
5. **Runner image**: the probe's logged line under `--network none` (the
   `type` and `code` strings are committed only after this). Broken-image
   mutations: (a) remove `pg` from the bundle — the hashed external
   `.next-build/node_modules/pg-*` resolves to `node_modules/.pnpm/pg@8.23.1`,
   so that directory goes too, not only `node_modules/pg` — and (b) item 4's
   removal. Record each failure text in `supply-chain.md`.
6. **Migrate image**: `check-reserved-slugs.ts` under `--network none` prints
   `ENETUNREACH` and exits 1. Mutation: drop the
   `COPY src/services/reserved-slug-holders.ts` line, rebuild, and confirm the
   step fails without `ENETUNREACH` (a module-not-found).
7. **Image sizes** before and after (`docker image inspect -f '{{.Size}}'` for
   both targets), and **idle RSS** of `server.js` in the runner image before
   and after (`docker stats --no-stream` after the first `/api/health`).
8. **Production `availableParallelism()`**: not measured, by decision. The
   pool size is derived from the host's published spec (D4), and the docs
   carry D4's command to re-derive it.
9. **Every vitest project and `next build` construct clients with a
   non-empty `DATABASE_URL`** (D4's throwing factory): the suite run and the
   build above are the measurement.
10. **CI's pool size**: not measured, by decision (D4); it affects only test
    defaults.
11. **The SQL-generation claims** (§8's second sweep), each with a measured
    verdict on C+A.
12. **The bind-limit harness test's seed and run time** (D11), which decide
    whether it stays a test or becomes a documented re-derivation.

Already answered by the spec review: a raw `$queryRaw` does load the query
compiler. The `ERR_MODULE_NOT_FOUND` it observed came from the generated
client's lazy compiler import on a `$queryRaw`. Item 4's broken-image run is
still done, for the failure text the probe names.

## 7. Test strategy

**Produce, don't fabricate, wherever the shape matters.** Acceptance asks for
every transient kind and every conflict code produced against the real DB
under the adapter. Two new files hold that matrix, so the evidence is in one
place rather than scattered across the suite:

`src/lib/pg-error.test.ts` (parallel tier). For each case, typed and raw where
both are reachable, it asserts the `pgErrorOf` result (`sqlState`, and
`constraint` where the table in D2 says), the matcher's verdict,
`classifyApiError`'s status and code, and `serializeErr`'s facets with the
message withheld:

| Code | Cases |
|---|---|
| `23505` | `Teacher_pageSlug_key` (single), `TeacherRoom_teacherId_roomId_key` (composite), `Room_private_identity_unique` and `Room_public_identity_unique` (expression, partial), one raw |
| `23503` | restrict: `teacherRoom.delete` blocked by `Class_teacherRoomId_roomArchived_fkey`; dangling insert on `TeacherRoom_roomId_fkey`; one raw |
| `23514` CHECK | `Class_live_needs_open_room` via the `teacherRoom.update` cascade; raw |
| `23514` trigger | `class.update` status on a completed class; `calendarEntry.update` date on a frozen entry; raw. Asserts `isCheckViolationOn` is false and `CLASS_FROZEN` with the right `trigger` facet |
| `23P01` | `CalendarEntry_teacher_slot_excl` and `ScheduleRule_teacher_slot_excl`, typed and raw |
| registry | every `UNIQUE_CONSTRAINTS` member exists as a unique index (`indexname::text`) |
| local-net sites (D3) | per site, every collision the plan's verdict names, produced through the route or service: `Account_email_key` on both ticket paths, `Teacher_account_live_unique` and `Student_account_live_unique` on the session paths, `Invitation_teacherId_email_key`, `TeacherRoom_teacherId_roomId_key`; each asserts the site's 409, not a 500 |

`src/lib/db-transient-shapes.test.ts` (serial tier, `LOCK_CONTENTION_TESTS`):

| Kind | Produced by | Expected |
|---|---|---|
| `lock_timeout` | `SET LOCAL lock_timeout` behind a holder, typed and raw | `55P03`, 503, `warn` |
| `deadlock` | two transactions locking two rows in opposite order, typed and raw | `40P01`, 503, `error` |
| `serialization` | REPEATABLE READ snapshot, then a concurrent update, then a typed update (`P2034`) and a raw one (`P2010`) | `40001`, 503, `warn`, both shapes the same kind |
| `pool_exhausted` | `createPrismaClient({ poolMax: 1, connectionTimeoutMs: 200 })`, an interactive transaction holding the connection; behind it a typed model call, a raw `$queryRaw` and a batch `$transaction([…])`, each with the holder's query forced to run | `isPgPoolTimeout` true for all three, 503, `error` |
| `tx_budget` | `timeout: 100` plus a 0.5 s sleep (expired), and `maxWait: 300` behind a holder (start) | `P2028`, 503, `warn`; `txError` `expired` / `other` |
| not transient | `SET LOCAL statement_timeout` (`57014`) | 500 (unchanged) |

Factory behaviour (`prisma-client.test.ts`): `poolConfigFor({})` equals
`{ connectionString: DATABASE_URL, max: availableParallelism() * 2 + 1,
connectionTimeoutMillis: 10000, idleTimeoutMillis: 300000,
allowExitOnIdle: true }`; an empty `url` throws like a missing one; `poolMax: 1`
makes two concurrent `pg_sleep(0.3)` take at least 0.6 s and return one
`pg_backend_pid()`; `connectionTimeoutMs: 500` against `203.0.113.1` fails in
under 2 s with pg's connection-timeout error; the refused-port case asserts
`meta.driverAdapterError.cause.kind === 'DatabaseNotReachable'` instead of
Prisma's message; a missing URL throws; a non-positive `poolMax` throws.

Serializer against real errors (`tests/integration/log-redaction.test.ts`,
extended): a typed CHECK violation and a typed trigger raise, serialized.
Neither the row id, nor `Failing row contains`, nor the primary message
appears anywhere in the output (`cause` included), and `sqlState`,
`constraint` / `trigger` and `rowIds` are present.

**Fabrication stays for branch coverage only** (cause chains, depth bounds,
non-Error throwables, impostor objects, `ENETUNREACH`). It goes through one
helper, `tests/adapter-errors.ts`:

```ts
export function driverAdapterError(cause: AdapterCause): Error;          // typed shape
export function knownWithAdapterCause(code: string, cause: AdapterCause, meta?: Record<string, unknown>): Prisma.PrismaClientKnownRequestError;
export function pgCause(sqlState: string, message: string, extra?: Partial<AdapterCause>): AdapterCause;
export function pgPoolTimeout(): Error;                                   // pg-pool's wait timeout
```

A fidelity test in `pg-error.test.ts` produces one real error per path (typed
`DriverAdapterError`, Known `P2002`, Known `P2010`) and asserts that the
helper's fabrication of the same case gives an identical `pgErrorOf` result
and the same own-key set. Fabrication cannot then drift from the real shape
unseen. Every existing test that builds `PrismaClientUnknownRequestError`s,
engine-framed messages or `meta.target` / `meta.constraint` / `meta.code` /
`meta.error` is rewritten either to a produced error or to this helper.
That is the 53 files of §11, plus the `isUniqueConflictOn` column-list tests,
the four URL-pool clients and `prisma-client.test.ts`. The 14 files the
premise report's 39 missed, each with its verdict (re-derive with
`S/rev2/census-tests.sh`, then drop the 39 in `S/census-test-union.txt`):

| File | What it does | Verdict on C+A |
|---|---|---|
| `src/lib/entry-rule-kind-guard.test.ts:111-219` | `toBeInstanceOf(Prisma.PrismaClientUnknownRequestError)` plus `String(caught)` matching `/23514/` on typed writes | **Breaks** (4 cases): a `DriverAdapterError`, whose `String()` carries no SQLSTATE. Rewrite to `pgErrorOf(caught)` with `sqlState` `23514` and the message tail |
| `src/lib/db-locks.test.ts:612,660,967-974` | `String(err)` against `/55P03/` or `/55P03\|could not obtain lock/` | Passes on raw paths only through Prisma's ``Code: `55P03` `` framing. Rewrite to `pgErrorOf(err)?.sqlState === '55P03'` |
| `src/app/api/registrations/route-lock-order.test.ts:628` | a logged line against `/55P03/` | Passes only if the line carries the serializer's `sqlState` (D6). Rewrite to assert the parsed `err.sqlState` |
| `src/services/waitlist-lock-order.test.ts:237,344,460,653` | `/55P03/` alone, and `String(err.cause)` against `/55P03\|lock timeout/i` | `/55P03/` breaks on a typed `DriverAdapterError`; the alternation passes on Postgres's text by luck. Rewrite to `transientDbFailure(…)?.kind === 'lock_timeout'` |
| `src/services/currency-switch-lock-order.test.ts:369` | `String(err).includes('55P03')` decides `held` vs `error` | Breaks on a typed path (misreads a lock wait as an error). Rewrite as above |
| `src/services/class-lifecycle-lock-order.test.ts:313`, `class-template-lifecycle-lock-order.test.ts:528,762`, `class-transitions.test.ts:982`, `room-archive-lock-order.test.ts:150,213`, `room-switch-lock-order.test.ts:196`, `gdpr-lock-order.test.ts:1337,1427,2899,3447,3513` | `/55P03\|lock timeout/` or `/40P01\|deadlock/` against `String(err)` or `rejects.toThrow` | Pass on Postgres's own text, which the `DriverAdapterError` message is. Rewritten to the structured kind anyway, because acceptance asks tests to assert the structured field |
| `src/services/invitations-lock-order.test.ts:296,409,981,1422` | `String(reason)` against `/40P01\|deadlock/i` | As above |
| `src/lib/db-locks-lock-order.test.ts:525-526`, `gdpr-lock-order.test.ts:860-861,2673-2674`, `room-archive-lock-order.test.ts:405,435` | **negative** `not.toMatch(/40P01\|deadlock detected/)` and `/55P03\|lock timeout/` | Weakened silently, not broken: on a typed path the SQLSTATE half can no longer match. Rewrite to `transientDbFailure(err)?.kind` not being `deadlock` / `lock_timeout` |
| `src/services/generation-transaction.test.ts:222` | negative `!String(caught).includes('25P02')` | Weakened as above. Rewrite to `pgErrorOf(caught)?.sqlState !== '25P02'` |

`promote-after-cancel.test.ts` (which fabricates `P2024`) and
`vanished-room-double-race.test.ts` (which fabricates `P2003` with
`meta: { constraint }`) were already in the 39, so they are covered. The
review listed them as missed.

**Guard-bites mutations.** Each is performed, its failure text recorded in
the plan's ledger, then restored and re-run green:

| Guard | Break it by | Expected failure |
|---|---|---|
| `pgErrorOf` reads `originalCode` | read `cause.code` instead | raw and typed `40001`, every `23505` and `23503` case fail (those kinds have no `code`): `serialization` expected, `null` / 500 got |
| `pgErrorOf` path 1 (`DriverAdapterError`) | delete it | every typed `23514`, `23P01`, `55P03`, `40P01` case fails (500 where 409 / 503 expected) |
| `pgErrorOf` path 2 (Known `meta`) | delete it | every raw case, every `P2002` / `P2003` / `P2034` case fails |
| `23505` name from the message | take it from `cause.constraint.fields` | `Room_private_identity_unique` case fails (truncated fields) |
| `isCheckViolationOn` requires the name | drop the name check | the trigger-raise cases assert `isCheckViolationOn` false and fail |
| `isTerminalStatusViolation` requires `which is terminal` | drop the phrase check | the CHECK case classifies `CLASS_FROZEN` and fails |
| `isExclusionConflictOn` requires `23P01` | compare against `'23514'` | both exclusion cases fail |
| `isRestrictViolationOn` | read `meta.constraint` | restrict case fails (500, not the in-use refusal) |
| `isMintKeyRefusal` | read `meta.constraint` | `payout-notice.test.ts`'s mint-refusal case fails |
| `P2034 → serialization` | map it back to `deadlock` | typed `40001` case fails on `kind` and `level` |
| `isPgPoolTimeout` literal | change one character | `pool_exhausted` case fails (500 instead of 503) |
| `UNIQUE_CONSTRAINTS` registry | add `Room_bogus_unique` | registry test fails naming it |
| a narrowed `isUniqueConflictOn` caller (rethrowing site) | pass the wrong family's name at `rooms/[id]/route.ts` | that route's duplicate-room test fails on the code: the rethrow reaches `classifyApiError`'s fallback, 409 `UNIQUE_CONFLICT` instead of `DUPLICATE_ROOM` |
| a narrowed caller (local-net site) | drop `Account_email_key` from `account/student-profile/route.ts:180` | its ticket-path collision test fails with 500 (`unrecognised unique constraint`) |
| serializer withholds `DriverAdapterError` | remove the name from `withheldClass` | redaction test fails: the row id appears |
| serializer skips a non-Error cause under a withheld error | walk it again | redaction test fails: the primary message appears under `cause` |
| errno and `ERR_*` codes kept | revert to `P\d{4}` only, then to `/^E[A-Z]+$/` | the `ENETUNREACH` serializer case fails, then the `ERR_MODULE_NOT_FOUND` case fails (no `code`) |
| factory defaults | change `connectionTimeoutMillis` to 0; drop `allowExitOnIdle` | `poolConfigFor` pin fails on each |
| empty URL refused | test `=== undefined` instead of falsy | the empty-`url` case fails (a client is built) |
| `poolMax` reaches pg | drop it from `poolConfigFor` | the two-sleeps timing case fails (~0.3 s) |
| `lowStackClient` startup option | drop `options` from the URL | `lowStackClient`'s read-back throws |
| `isStackDepthError` | compare against `'54000'` | `sweep-page-ceiling.test.ts`'s `rowValueIn(CEILING_ROWS)` assertion fails |
| per-site paging (D11) | un-page one site's read (one `findMany` over the whole set) | that site's test fails: a statement binds `3 * CEILING_ROWS + 1` parameters, above `3 * SWEEP_PAGE_SIZE + 1` |
| bind-limit harness (D11) | seed 21,844 instead of 21,845 parents | the `08P01` assertion fails (the load resolves) |
| version tether | assert against `'0.0.0'` | the tether test fails |
| lint | `import pg from 'pg'` in `src/services/payments.ts` | `pnpm lint` fails with the new message |
| runner probe | §6 item 5 (a) and (b) | probe exits 1 with the recorded named failure |
| reserved-slug step | §6 item 6 | step fails without `ENETUNREACH` |

## 8. Sweeps after the build

For names this change removes (§4 of the solve-issue skill), each hit gets a
verdict:

```
git grep -nE "P2024|meta(\?)?\.(target|constraint|code|error)\b|PostgresError|Code: \`|connection_limit|pool_timeout|connect_timeout|query engine|Query Engine|libquery|runtime/library|connectorKind|CONNECTOR_KIND|start_timeout|extractColumnIdentifier|PrismaClientUnknownRequestError|prisma-engine-probe" -- ':!pnpm-lock.yaml' ':!src/generated'
```

Expected legitimate survivors: dated measurement blocks in `docs/` and older
specs and plans under `docs/superpowers/`. Descriptions are swept by reading
the whole docblock of every function this change touches.

**The SQL Prisma generates is a claim too.** The query compiler is a
different SQL generator from the Rust engine, and §2 item 14 shows one claim
already falsified. Every comment or doc line that says what SQL Prisma sends
gets a verdict measured on C+A: the statement captured from Prisma's query
event (as `S/rev/upsert.ts` and `S/rev2/ceiling.ts` do) and compared with the
claim. A passing suite is not enough, because several of these guard races
the suite only hits when the timing lands. The floor of the list (21 lines):

```
git grep -nEi "prisma (splits|issues|emits|runs|sends|reads|selects|wraps|implements|compiles|generates)|the engine (issues|emits|runs|sends|wraps|reads)" -- src docs/lock-order.md docs/technical-architecture.md docs/data-model.md ':!src/generated'
```

| Line | Claim | Status |
|---|---|---|
| `docs/technical-architecture.md:304`, `src/lib/read-in-pages.ts:3` | composite relation loads send a row-value `IN` list | **False on C+A** (§2 item 14); rewritten (D11) |
| `src/lib/degradation-store.ts:16` | upsert is one `INSERT … ON CONFLICT` | True; identical SQL on both engines (`S/rev/upsert.ts`) |
| `src/services/roster-link.ts:27,33` | an empty `update` compiles to a `SELECT`; the type Prisma emits for a compound key | True on C+A: an absent row is `SELECT` then `INSERT`; `skipDuplicates` sends a target-less `ON CONFLICT DO NOTHING` (Task 11) |
| `src/services/invitations.ts:1656` | how an upsert compiles | True on C+A: one `INSERT … ON CONFLICT ("studentId","teacherId") DO UPDATE` (Task 11) |
| `src/services/invitations-lock-order.test.ts:213,1308` | an empty `update` compiles to non-locking `SELECT`s | True on C+A: three plain `SELECT`s against an existing row (Task 11) |
| `src/services/rule-lifecycle.ts:559` | emitted as a single `UPDATE` | True on C+A: `UPDATE "ScheduleRule" … WHERE ("id" = $4 AND "isArchived" = $5)` (Task 11) |
| `src/services/class-lifecycle.ts:1847`, `class-lifecycle.test.ts:2126` | a real `UPDATE`, and no `UPDATE` for an all-unchanged data object | First half true. Second half false on C+A: an all-undefined `data` sends a `SELECT` of the matching ids and answers their count (1 for an existing row), not `{ count: 0 }`; comments rewritten, the guard stands (Task 11) |
| `src/services/waitlist-retention.ts:242` | a `some` filter compiles to a semi-join | True on C+A: `EXISTS(…)` whose inner side re-joins `Class` (Task 11) |
| `src/app/api/account/student-profile/route.ts:104`, `src/lib/auth/account.ts:61` | nested relation writes split into separate statements | False as the reason given: a nested `connect` or `create` on `Student` writes `claimedAt` and `accountId` in one `UPDATE`. Not load-bearing: both sites use the scalar `UPDATE`, one statement either way; comments rewritten (Task 11) |
| `src/services/gdpr.ts:1688`, `docs/lock-order.md:3116` | no per-statement `SAVEPOINT` | True on C+A: no `SAVEPOINT` is sent, and the read after a caught error fails `25P02` (Task 11) |
| `docs/lock-order.md:1899` | upserts issued as one statement | True on C+A: `INSERT … ON CONFLICT ("teacherId") DO UPDATE` (Task 11) |
| `src/services/class-lifecycle-lock-order.test.ts:224` | the transaction ends with Prisma issuing `COMMIT` | True on C+A: `COMMIT` follows the callback's last statement (Task 11) |
| `src/lib/student-visibility.ts:16` | which columns Prisma selects | Not a SQL claim: "Prisma selects" names the `select` objects it returns (Task 11) |
| `src/lib/check-violation.test.ts:16`, `src/lib/prisma-client.ts:13` | P2010 framing; Prisma reads `DATABASE_URL` | rewritten by this change (D2, D4) |

The grep is a floor, not the whole set. The plan also reads the
`docs/lock-order.md` passages on upserts, nested writes and `skipDuplicates`.

## 9. Risks

1. **The constraint names for `23505`, `23514` and `23P01` are parsed from
   Postgres's English primary message.** A server with a non-English
   `lc_messages` would localise it and every name match would miss: 409s
   would become 500s, loudly. The production image (`postgres:16-alpine`,
   default locale) and CI's are English. The real-DB tests run against the
   same image, so a locale change in test infrastructure reddens them.
   `docs/technical-architecture.md` states the assumption.
   **A Postgres major-version bump has the same exposure**: if
   `postgres:16-alpine` → 17 rewords one of the three primary messages,
   every name match on it misses in production. The real-DB matrix (§7) is
   the tether, and it works only if CI runs the image production runs. Today
   both pin the same digest (`docker-compose.prod.yml:12`, `ci.yml:172,259,364`,
   `docker-compose.yml:6`, `e2e-flake-repro.yml:87`). The service-image check
   (`src/lib/service-image-check.ts`, `docs/supply-chain.md` "The database
   image") enforces that pins of one tag agree on one digest. A major bump
   changes the tag, which that check groups by, so moving production and CI
   together is a rule the bump PR must follow. `docs/technical-architecture.md`'s
   "Database errors" section says so, and links the check.
2. **`meta.driverAdapterError` and the `DriverAdapterError` name are Prisma
   6.19.3 internals, not public API.** v7 may move them. The fidelity test and
   the real-DB matrix redden on the upgrade, which is what #889 needs from
   this issue. One sub-risk is retired: the runtime identifies an adapter
   error by name as well (`runtime/client.js`:
   `e.name==="DriverAdapterError"&&typeof e.cause=="object"`), so a bundled
   second copy of `@prisma/driver-adapter-utils` cannot break the `meta`
   wrapping.
3. **pg-pool's timeout literal may be reworded** in a pg upgrade. The real-DB
   `pool_exhausted` case reddens.
4. **Behaviour changes, each deliberate.** (a) The name-keyed matchers
   (`isUniqueConflictOn`, `isRestrictViolationOn`, `isMintKeyRefusal`) also
   match a raw query's refusal on the same named constraint. (b) A name match
   is narrower than a column match on the four shared column sets (D3); the
   plan gives each local-net site a verdict. (c) A typed `40001` logs at `warn` (D5). (d) An
   unreachable host takes up to 10 s to fail instead of 5 s (D4). (e) Idle
   connections live 300 s, as before. (f) The serializer drops `meta.target`,
   `connection_limit` and the three text-derived `txError` values, and
   renames `connectorKind` to `adapterKind`.
5. **Performance and memory of the wasm query compiler** on the production
   box: measured in §6 item 7 and by the e2e suite's duration before and
   after. A regression large enough to matter blocks the "stays on in
   production" verdict, not the matcher rewrite.
6. **`$connect()` no longer warms a connection.** Tests that call it to keep
   connection setup out of a timing window lose that. If a timing test flakes
   on the branch, its `$connect()` becomes a `SELECT 1`, as
   `handoff.test.ts` already does.
7. **Client-engine gaps on 6.19.3** beyond the `name` / `char` / `void` /
   range columns already found. The full suite is the net (§6 item 1).
8. **Unbounded `in` lists now fail where the Rust engine may have
   coped.** A composite relation load over more than 21,844 parents fails in
   Postgres with `08P01`; the query compiler does not split it. An `in:` list
   that takes a statement past 32,766 bound parameters is split only in a
   plain `findMany` or a single-key relation load; in every other statement
   Prisma refuses it with `P2029` before sending it (§2 item 14). Whether the
   Rust engine split such lists was not measured. The plan sweeps for `in:`
   arguments not bounded by a page
   (`git grep -nE "(^|[^A-Za-z_])in: [A-Za-z_.]+" -- src ':!src/generated' ':!*.test.ts'`, 45 lines today),
   and gives each a verdict on its largest realistic size.
9. **Architecture skew.** `ENETUNREACH` was measured on arm64. CI builds
   amd64, so the first CI run on the branch is the amd64 confirmation, and a
   different string there blocks the merge.

## 10. Out of scope

- The Prisma 7 upgrade itself (#889): `prisma.config.ts` taking the datasource
  URL, the v7 generator and import changes, removing the Rust schema engine
  from the migrate image.
- Classifying an unreachable database (connect timeout, `ECONNREFUSED`,
  `ENETUNREACH`) as transient. It is a 500 today and stays one; the health
  route answers it on its own terms.
- Widening `classifyApiError`'s P2002 fallback to raw `23505`.
- Removing the many harmless `$connect()` calls in tests.
- The `@prisma/client` `allowBuilds` entry.
- Correcting the "VPS (2GB RAM, 1 vCPU)" budget statements in `CLAUDE.md` and
  `docs/technical-architecture.md`'s deployment diagram. D4 records the real
  host's value where the pool is documented; whether the budget line describes
  a constraint or the box is the owner's call.
- `src/app/api/cron/daily-cleanup/route.ts:128` returning `err.message` in
  its response body. For a `DriverAdapterError` that is the Postgres primary
  message (a trigger's row id, a `22P02`'s quoted input). The engine text
  carried the same before, and the route sits behind the cron secret.
  Pre-existing; named here so it is not mistaken for new.
- `docs/degradation-sites.md`'s line-numbered tables, beyond regenerating them
  if their own re-derivation says the lines moved.

## 11. Counts, with their commands

Run from the worktree root. None uses `head` or `tail`.

| Count | Value | Command |
|---|---|---|
| `.message.*` call lines in non-test code (this grep sees no regex `.exec` readers such as the serializer's `PG_CODE`, nor the probe; those are in the D2/D3 table by hand) | 12 lines in 4 files | `git grep -nE "\.message\??\.(includes\|match\|startsWith\|endsWith\|search\|indexOf)\|\.test\([a-zA-Z_.]*message\|String\([a-z]+\)\.(includes\|match)" -- src scripts tests ':!src/generated' ':!*.test.ts' ':!*.test.tsx' ':!*.spec.ts'` |
| Test files with engine framings | 15 | `git grep -lE 'PostgresError\|Code: \`\|code: \\"[0-9A-Z]{5}\|code: "[0-9A-Z]{5}"' -- '*.test.ts' '*.test.tsx' '*.spec.ts' 'tests/**' \| wc -l` |
| Test files depending on the shapes (framing ∪ fabricated Prisma errors ∪ `meta.*` / P-code assertions ∪ non-comment SQLSTATE literals ∪ `meta: {` fabrications and `PrismaClientUnknownRequestError` mentions) | 53 = the report's 39 + 14 | `sh S/rev2/census-tests.sh \| wc -l` (the five greps, `sort -u`); the 39 are `S/census-test-union.txt` |
| `isUniqueConflictOn` calls in non-test code | 18 calls on 17 lines (student-profile 3 calls on 2 lines + teacher-profile 6 + registrations 1 + publish 1 + rooms/[id] 1 + rooms 2 + teacher-rooms 1 + teachers/[id] 1 + class-lifecycle 1 + invitations 1) | `git grep -o "isUniqueConflictOn(err" -- src ':!*.test.ts' ':!src/lib/unique-conflict.ts' \| wc -l` (calls); `-n` in place of `-o` (lines) |
| `isUniqueConflictOn` call lines in tests | 28 | `git grep -n "isUniqueConflictOn(" -- '*.test.ts' 'tests/**' \| wc -l` |
| Files using URL pool parameters | 9 files, 6 of them callers (`measure-push-fanout.ts`, `handoff.test.ts`, three single-connection tests, `stack-ceiling.ts`); the other 3 are `log-serializers.ts` and its test (`meta.connection_limit`) and `gdpr.ts`'s comment | `git grep -lE "connection_limit" -- src tests scripts ':!src/generated'` |
| `P2024` mentions to sweep | 54 lines | `git grep -n "P2024" -- src scripts tests ':!src/generated' \| wc -l` |
| `name`-column `$queryRaw` sites found by the heuristic | 3 | `python3 -I S/scan_name_cols.py $(git ls-files 'src/**/*.ts' 'tests/**/*.ts' 'scripts/**/*.ts' 'src/*.ts')` |
| Migrations in the dev database | 90 | `pnpm exec prisma migrate status` |
| SQL-generation claim lines (floor) | 21 | §8's second command, piped through `wc -l` |
| Bind-parameter ceiling for a composite relation load | 21,844 parents resolve, 21,845 fail (3n + 1 > 65,535) | `pnpm exec tsx S/rev2/ceiling.ts 21844 21845` |

## 12. Decisions this spec corrects

- **D2:** Postgres's primary message is `originalMessage`, not
  `cause.message`. The latter is absent on the `UniqueConstraintViolation` and
  `ForeignKeyConstraintViolation` kinds (§3). Also refined: no `detail` field,
  and `constraint` is filled for all four constraint SQLSTATEs by the
  extractor (§4, D2).
- **D4:** the production pool is 9, not 3. The host is a 4-vCPU CAX21, not
  the 1-vCPU box the docs describe, and that held under Prisma's formula
  already, derived from the host's published spec and not measured on the
  server (§6 item 8). The option is named
  `connectionTimeoutMs`, not `poolTimeoutMs`, because pg's knob bounds the
  connect as well. `idleTimeoutMillis` is fixed at 300 000, a sub-decision D4
  did not mention, forced by four single-connection test clients the report
  missed.
- **D4 (pool exhaustion scope):** `pool_exhausted` covers every call whose
  pool wait outlives `connectionTimeoutMs`, an interactive transaction
  included: `maxWait` is judged only once the pool hands over a connection.
  A pool-blocked interactive transaction is `P2028` (`tx_budget`) only when
  its connection is freed within the pool bound but after `maxWait`;
  measured on C+A (Task 8).
- **D4 (process exit):** `allowExitOnIdle: true` joins the fixed defaults,
  so the 300 s idle timeout cannot hold a finished process open; an empty
  URL counts as missing.
- **D6:** the withheld-path code rule admits Node's `ERR_*` codes as well
  as errno codes (`/^E[A-Z0-9_]{1,63}$/`), so a missing query compiler leaves
  a code in the log.
- **D10:** 53 test files depend on the shapes, not 39 (§7 lists the 14).
- **Paging (new, D11):** the #674 stack rationale is false on C+A. Paging
  stays for the bind-parameter limit, and the ceiling tests assert parameter
  counts instead of `54001`.
- **D7:** no `SELECT 1` in the reserved-slug gate; dropping `$connect()` is
  enough, because the gate's own query carries the errno.
