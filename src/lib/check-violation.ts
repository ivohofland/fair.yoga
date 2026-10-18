import { pgErrorOf } from '@/lib/pg-error';

/**
 * True when `err` is a PostgreSQL `23514` raised by the CHECK constraint named
 * `constraint`.
 *
 * BOTH the SQLSTATE and the name are required, and requiring the name is the
 * whole design. `23514` is Postgres's default for every plain CHECK in this
 * schema, and it is additionally what this repo's terminality triggers raise
 * with an explicit `USING ERRCODE` — so a matcher keyed on the code alone would
 * relabel unrelated refusals. `terminalViolationOf` (`./api-errors`)
 * discriminates by message wording for the same reason; this one discriminates
 * by constraint name, which a CHECK violation carries and a trigger raise does
 * not.
 *
 * Where the SQLSTATE and the name are read from, for a typed and a raw call
 * alike: `docs/technical-architecture.md`, "Database errors".
 */
export function isCheckViolationOn(err: unknown, constraint: string): boolean {
  // An empty name would make the name half vacuous and collapse this to "is
  // this a 23514", which is the one match the docblock above exists to
  // prevent. `isRestrictViolationOn` needs no such line because
  // `[].includes(x)` is false; a string needs it.
  if (constraint === '') return false;
  const pg = pgErrorOf(err);
  return pg !== null && pg.sqlState === '23514' && pg.constraint === constraint;
}
