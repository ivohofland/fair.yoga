import { readFileSync } from 'fs';

/**
 * The terminal status set a terminality trigger's SQL hard-codes, read out of
 * the applied migration itself.
 *
 * TWO CALL SITES, ONE PARSER — and the distinction matters, because the
 * duplication these drift pins DO need is not this. `class-terminal-
 * status.test.ts` and `class-terminal-date.test.ts` must each read their OWN
 * migration: the two triggers restate `('completed','cancelled')` in two
 * independent frozen texts that nothing forces to agree, so one pin reading
 * one file cannot notice the other drifting. That argument buys two pins. It
 * does not buy two copies of the regex, which was the fragile half and the
 * half most likely to be edited once and not twice.
 *
 * Regex over SQL is normally the wrong tool. Here it inverts: the target is an
 * APPLIED migration that `CLAUDE.md` forbids editing and Prisma checksums, so
 * the text is frozen by policy as well as by convention. The `if (!inList)`
 * throw turns a shape change into a named failure rather than a silent pass —
 * without it a non-matching regex yields `undefined`, and the comparison
 * downstream would report drift that isn't there.
 *
 * Lives under `tests/` rather than `src/` because nothing in the application
 * reads migration text at runtime; it is imported by unit tests in
 * `src/services/` by relative path (the `@` alias maps `src` only).
 *
 * Reads a file. Touches no database.
 */
export function enforcedTerminalStatuses(migrationDir: string): string[] {
  const sql = readFileSync(
    new URL(`../prisma/migrations/${migrationDir}/migration.sql`, import.meta.url),
    'utf8',
  );

  // `noUncheckedIndexedAccess` makes the capture group possibly-undefined, and
  // the narrowing is kept rather than cast away: a `!` here would turn a shape
  // change into a runtime `undefined` inside the caller's comparison, which is
  // the failure mode these pins exist to make loud.
  const inList = sql.match(/OLD\.status IN \(([^)]+)\)/)?.[1];
  if (!inList) {
    throw new Error(`${migrationDir}: trigger SQL no longer has the shape this pin reads`);
  }

  return [...inList.matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined)
    .sort();
}
