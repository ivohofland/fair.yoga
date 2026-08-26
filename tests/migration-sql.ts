import { readFileSync } from 'fs';

/**
 * The terminal status set one trigger function's SQL hard-codes, read out of
 * the applied migration itself.
 *
 * TWO CALL SITES, ONE PARSER — and the distinction matters, because the
 * duplication these drift pins DO need is not this. `class-terminal-
 * status.test.ts` and `class-terminal-date.test.ts` must each read their OWN
 * function: two triggers restate the terminal set in two independent frozen
 * texts that nothing forces to agree, so one pin reading one text cannot
 * notice the other drifting. That argument buys two pins. It does not buy two
 * copies of the regex, which was the fragile half and the half most likely to
 * be edited once and not twice.
 *
 * THE FUNCTION NAME IS A PARAMETER, not the directory alone. Both texts now
 * live in one migration file (`20260826080100_calendar_entry_rewire`, #327), so
 * a directory no longer identifies a text — and the `IN (...)` match is
 * non-global, so a pin handed only the directory would read whichever text
 * appears first and both pins would follow the same one. Slicing to the named
 * function is what keeps them independent.
 *
 * `OLD` or `NEW`: the guard reads `OLD.status` (a terminal class cannot leave
 * its status), the sync trigger reads `NEW.status` (a class REACHING a
 * terminal status stamps the entry's marker). Same set, opposite tense.
 *
 * Regex over SQL is normally the wrong tool. Here it inverts: the target is an
 * APPLIED migration that `CLAUDE.md` forbids editing and Prisma checksums, so
 * the text is frozen by policy as well as by convention. The three throws below
 * turn a shape change into a named failure rather than a silent pass — without
 * them a non-matching regex yields `undefined`, and the comparison downstream
 * would report drift that isn't there.
 *
 * Lives under `tests/` rather than `src/` because nothing in the application
 * reads migration text at runtime; it is imported by unit tests in
 * `src/services/` by relative path (the `@` alias maps `src` only).
 *
 * Reads a file. Touches no database.
 */
export function enforcedTerminalStatuses(
  migrationDir: string,
  functionName: string,
): string[] {
  const sql = readFileSync(
    new URL(`../prisma/migrations/${migrationDir}/migration.sql`, import.meta.url),
    'utf8',
  );

  const declaration = `CREATE OR REPLACE FUNCTION ${functionName}`;
  const start = sql.indexOf(declaration);
  if (start === -1) {
    throw new Error(`${migrationDir}: no \`${declaration}\` in this migration`);
  }
  // `$$ LANGUAGE` is the terminator every function in these migrations ends
  // with, and the slice stops there so a later function in the same file
  // cannot answer for this one.
  const end = sql.indexOf('$$ LANGUAGE', start);
  if (end === -1) {
    throw new Error(`${migrationDir}: ${functionName} has no \`$$ LANGUAGE\` terminator`);
  }

  // `noUncheckedIndexedAccess` makes the capture group possibly-undefined, and
  // the narrowing is kept rather than cast away: a `!` here would turn a shape
  // change into a runtime `undefined` inside the caller's comparison, which is
  // the failure mode these pins exist to make loud.
  const inList = sql.slice(start, end).match(/(?:OLD|NEW)\.status IN \(([^)]+)\)/)?.[1];
  if (!inList) {
    throw new Error(
      `${migrationDir}: ${functionName}'s SQL no longer has the shape this pin reads`,
    );
  }

  return [...inList.matchAll(/'([a-z_]+)'/g)]
    .map((m) => m[1])
    .filter((s): s is string => s !== undefined)
    .sort();
}
