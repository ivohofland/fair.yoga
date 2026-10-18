import { pgErrorOf } from '@/lib/pg-error';

/**
 * True when `err` is a PostgreSQL `23P01` raised by the exclusion constraint
 * named `constraint`.
 *
 * A separate predicate from `isUniqueConflictOn` (`./unique-conflict`) because
 * an exclusion violation is not a unique violation: it has a SQLSTATE of its
 * own.
 *
 * A typed call and a raw one are both admitted, because both carry the
 * adapter's cause and they mean the same thing to a caller; a matcher built
 * for one would silently miss the other. Both the SQLSTATE and the name are
 * required, so another constraint's refusal never matches. Where they are
 * read from: `docs/technical-architecture.md`, "Database errors".
 */
export function isExclusionConflictOn(err: unknown, constraint: string): boolean {
  const pg = pgErrorOf(err);
  return pg !== null && pg.sqlState === '23P01' && pg.constraint === constraint;
}
