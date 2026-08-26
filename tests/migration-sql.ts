import { readdirSync, existsSync, readFileSync } from 'fs';

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
 * `migrationDir` MUST NAME THE MIGRATION HOLDING THE LIVE DEFINITION, which is
 * not always the one that declared the function. A later migration may
 * `CREATE OR REPLACE` it, and this helper would then read a superseded body and
 * compare a constant against SQL no database is running — a pin that passes on
 * dead text. It has already happened on the object next door:
 * `entry_reject_frozen_schedule_change` was declared in the rewire and replaced
 * in `20260826140000_entry_guard_restorations`. No caller is wrong today; the
 * only defence is that a caller picks its directory deliberately. To check one:
 *
 *   grep -rln 'CREATE OR REPLACE FUNCTION <name>' prisma/migrations/
 *
 * More than one hit means the LAST of them is the live body.
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


/**
 * One `CREATE OR REPLACE FUNCTION` body, with the migration that carries it.
 */
export type MigrationFunction = {
  /** The migration directory the body was read out of. */
  migration: string;
  /** The bare function name, without the parameter list. */
  functionName: string;
  /** From `CREATE OR REPLACE FUNCTION` through the closing `$$ LANGUAGE`. */
  body: string;
};

const DECLARATION = /CREATE OR REPLACE FUNCTION\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const DROP = /DROP FUNCTION\s+(?:IF EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
const TERMINATOR = '$$ LANGUAGE';

/** A declaration or a drop, with where in the file it sits. */
type FunctionEvent =
  | { at: number; type: 'create'; fn: MigrationFunction }
  | { at: number; type: 'drop'; functionName: string };

/**
 * Every function a migration declares or drops, IN FILE ORDER.
 *
 * File order rather than "drops first, then creates", and the difference is
 * live: `20260826080100_calendar_entry_rewire` drops three functions at its top
 * and declares three more two hundred lines down. A file that dropped and then
 * re-declared the same name would be read backwards by any cheaper rule.
 *
 * `$$ LANGUAGE` is the terminator every function in these migrations ends with,
 * and each slice stops there so a later function in the same file cannot answer
 * for this one — the same boundary `enforcedTerminalStatuses` above slices on,
 * and for the same reason.
 *
 * Pure: takes the SQL text, so a caller can hand it a synthetic migration and
 * watch a sweep built on this go red. That is not decoration — the sweep this
 * feeds (`src/lib/api-errors.test.ts`) replaced one that was satisfied by any
 * text anywhere in the file, which is how a 500-classifying message shipped
 * unnoticed. A guard whose own failure cannot be observed certifies nothing.
 */
export function functionEvents(migration: string, sql: string): FunctionEvent[] {
  const events: FunctionEvent[] = [];

  for (const match of sql.matchAll(DECLARATION)) {
    const functionName = match[1];
    // `noUncheckedIndexedAccess`: the group is possibly-undefined to the
    // compiler even though the pattern cannot match without it. Narrowed
    // rather than asserted, so a pattern edit that drops the group becomes a
    // skipped body rather than an `undefined` key downstream.
    if (functionName === undefined) continue;
    const start = match.index;
    const end = sql.indexOf(TERMINATOR, start);
    if (end === -1) {
      throw new Error(`${migration}: ${functionName} has no \`${TERMINATOR}\` terminator`);
    }
    events.push({
      at: start,
      type: 'create',
      fn: { migration, functionName, body: sql.slice(start, end + TERMINATOR.length) },
    });
  }

  for (const match of sql.matchAll(DROP)) {
    const functionName = match[1];
    if (functionName === undefined) continue;
    events.push({ at: match.index, type: 'drop', functionName });
  }

  return events.sort((a, b) => a.at - b.at);
}

/**
 * The body of each function the DATABASE IS ACTUALLY RUNNING, keyed by name.
 *
 * LAST WRITE WINS, and that rule is the whole difference between this and a
 * directory scan. Two ways a scan gets it wrong, both live in this repo:
 *
 *   - A later migration may `CREATE OR REPLACE` a function an earlier one
 *     declared. `entry_reject_frozen_schedule_change` was declared in
 *     `20260826080100_calendar_entry_rewire` and replaced in
 *     `20260826140000_entry_guard_restorations`, and the rewire's body is the
 *     one that lacked `which is terminal`.
 *   - A later migration may DROP one outright.
 *     `class_reject_terminal_date_change` went that way in the rewire, with
 *     `Class.date` itself.
 *
 * Either way a scan reports a body no database is running — a pin failing, or
 * passing, on dead text.
 *
 * `migrations` must arrive in APPLIED order. `migrationSqlFiles` below supplies
 * that by sorting the directory, which is chronological because Prisma prefixes
 * every name with a timestamp.
 *
 * Pure, for the reason `functionEvents` is.
 */
export function liveFunctions(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
): Map<string, MigrationFunction> {
  const live = new Map<string, MigrationFunction>();
  for (const { name, sql } of migrations) {
    for (const event of functionEvents(name, sql)) {
      if (event.type === 'create') live.set(event.fn.functionName, event.fn);
      else live.delete(event.functionName);
    }
  }
  return live;
}

/**
 * Every migration's SQL, in applied order.
 *
 * Sweeps the directory rather than naming the known files, so it covers
 * migrations that do not exist yet — which is the entire point of the pins
 * built on it.
 *
 * Reads files. Touches no database.
 */
export function migrationSqlFiles(): Array<{ name: string; sql: string }> {
  const migrations = new URL('../prisma/migrations/', import.meta.url);
  return readdirSync(migrations)
    .sort()
    .map((name) => ({ name, sqlPath: new URL(`${name}/migration.sql`, migrations) }))
    .filter(({ sqlPath }) => existsSync(sqlPath))
    .map(({ name, sqlPath }) => ({ name, sql: readFileSync(sqlPath, 'utf8') }));
}
