# The bare DriverAdapterError fixture, held to the produced one (#924)

**Goal:** `driverAdapterError()` in `tests/adapter-errors.ts` builds the shape the
adapter actually throws bare, and a real-database test fails if it drifts.

**Premise, measured on `2847bd44`:** every other item #924 lists has landed —
the typed-call fixtures (`typedCallError`, #922), the precedence pins
(`api-errors.test.ts`, #922), `22P02` produced (`pg-error.test.ts`, "the helper
fabricates a Known P2010 (raw 22P02) identical to a produced one"), and the
reachability question: #931 produces a bare `DriverAdapterError`
(`ConnectionClosed`) from an interactive transaction's `COMMIT` cut by a reset
in flight (`src/lib/db-connection-drop.test.ts`), so the `name ===
'DriverAdapterError'` branch of `adapterCauseOf` is live and stays.
`RestrictViolation` (`23001`) is not producible: Postgres raises `23503` for
RESTRICT and NO ACTION foreign keys.

What is left: no test compares the fixture with that produced error, and they
differ. A probe in `expectBareConnectionClosed` read the produced error's
`Object.keys` as `["name","cause"]` (own property names `stack`, `message`,
`name`, `cause`); the fixture's are `["name","cause","clientVersion"]`. The
adapter's class (`@prisma/driver-adapter-utils@7.10.1`, `DriverAdapterError`)
sets only `name` and `cause`, and the client runtime does not add
`clientVersion` when it lets the error through. No fixture call site reads
`clientVersion` (`grep -rn "driverAdapterError(" src tests`: 9 lines in
`pg-error.test.ts` and `log-serializers.test.ts`).

## Task 1 — pin, then fix the fixture

**Files:** `src/lib/db-connection-drop.test.ts`, `tests/adapter-errors.ts`.

1. In `expectBareConnectionClosed`, compare the produced error with
   `driverAdapterError(socketCause('ConnectionClosed'))`: same enumerable own
   keys, same `name`, same `message`, and an equal `cause`.
2. Run `pnpm exec vitest run src/lib/db-connection-drop.test.ts -t "bare
   DriverAdapterError"` → RED on the keys (`clientVersion` extra). Record the
   error text.
3. Drop `clientVersion` from `driverAdapterError`; its docblock says where the
   bare shape is thrown (a `COMMIT` cut by a reset) and that
   `db-connection-drop.test.ts` holds the fixture to it. → GREEN.
4. **Prove the pin bites the realistic regression:** re-add the
   `clientVersion` line → RED with the step-2 text; restore → GREEN. Second
   mutation: give the fixture a non-`ConnectionClosed`-faithful cause (e.g.
   add a field to `socketCause`'s `ConnectionClosed` case) → RED; restore.
5. `pnpm run verify`. No `pnpm run build`: the change touches tests only.

**Not in scope:** the macOS/Linux `COMMIT` race rows (#931 records them as
observed, not pinned); the fixture's use with `postgres` causes in
`pg-error.test.ts`, which exercises `adapterCauseOf`'s first path with a
SQLSTATE no bare error has been measured carrying — kept as a path test.

Docs: `docs/technical-architecture.md` already lists the bare row; no change.
