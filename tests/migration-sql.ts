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


// Block comments first, then line comments — see `stripSqlComments`.
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /--[^\n]*/g;

/**
 * `sql` with its comments removed, blocks before lines.
 *
 * THE ORDER IS THE WHOLE POINT, and it is not a style choice. A block comment
 * may contain a `--`; strip line comments first and that `--` swallows the
 * block's closing delimiter along with the rest of its line, leaving the
 * opening delimiter dangling and — for a detector reading the result — erasing
 * whatever statement followed it. The tether is a fixture rather than a live
 * migration: `src/lib/migration-remediation-trace.test.ts` strips a block
 * comment holding a `--` in front of an `UPDATE` and asserts the `UPDATE`
 * survives, so swapping the two `.replace` calls below fails a test rather than
 * passing quietly.
 *
 * A comment stripper, NOT a SQL parser. A `--` inside a string literal or a
 * dollar-quoted body is treated as opening a comment, and everything after it
 * on that line is lost. Building the parser that would tell them apart is a
 * much larger thing than the pins reading this need, so the limitation is
 * stated rather than removed. Whether this tree contains such a `--` is
 * re-derivable rather than asserted here:
 *
 *   grep -rnE -- '--' prisma/migrations/ | grep -vE ':[0-9]+:[[:space:]]*--'
 *
 * Anything that prints is a `--` somewhere other than the start of its own
 * line, which is where an embedded one would have to be. Read each hit before
 * trusting this helper on it.
 *
 * A block becomes a single space rather than nothing, so that a comment
 * sitting between two tokens cannot fuse them into a third that no pattern
 * matches. Line comments keep their newline, for the same reason.
 *
 * Pure: takes the SQL text, so a caller can hand it a synthetic migration and
 * watch a sweep built on this go red.
 */
export function stripSqlComments(sql: string): string {
  return sql.replace(BLOCK_COMMENT, ' ').replace(LINE_COMMENT, '');
}

// `UPDATE` / `DELETE FROM` immediately followed by a quoted identifier. The
// quote is what keeps `ON UPDATE CASCADE`, `FOR UPDATE OF c` and
// `FOR UPDATE OF "Class"` out: in each of those a word stands between the verb
// and any quoted name, whichever case it is written in.
//
// CASE-INSENSITIVE ON BOTH, because lowercase keywords are legal SQL and a
// case-sensitive pattern reads `update "X" set …` as no write at all — silence
// on a real data change, which is the expensive direction.
const DATA_CHANGE = /\bUPDATE\s+"|\bDELETE\s+FROM\s+"/i;
const RAISE_NOTICE = /\bRAISE\s+NOTICE\b/i;
// A colon, then something that is not whitespace, on the same line — a bare
// marker with an empty reason exempts nothing. Case-sensitive, unlike the two
// above: the marker is this rule's own spelling, not SQL's.
const NO_NOTICE_MARKER = /--[ \t]*DML WITHOUT NOTICE:[ \t]*\S/;

/**
 * The migrations sorting strictly after `cutoff` that rewrite existing rows
 * and leave no trace of having done so.
 *
 * A migration under this rule must carry either a real `RAISE NOTICE` or the
 * marker comment
 *
 *   -- DML WITHOUT NOTICE: <reason>
 *
 * whose reason may not be empty. FAILING TOWARD THE MARKER IS DELIBERATE: no
 * regex separates a backfill from a remediation, so this does not try. An
 * over-trigger costs the author one comment line stating why their statement
 * needs no announcement; an under-trigger costs a data change nobody can
 * discover afterwards, which is the whole reason the rule exists.
 *
 * THE EXEMPTION IS PER FILE, NOT PER STATEMENT, and that bounds the guarantee.
 * One real `RAISE NOTICE` anywhere in a migration exempts every data change in
 * it, so a silent remediation added beside an announced one passes this rule.
 * Pairing each write with its own notice needs a plpgsql-aware statement
 * splitter — a much larger thing than this — and is deliberately not built.
 * The recognised shapes bound it too: `UPDATE "…"` and `DELETE FROM "…"`, so a
 * schema-qualified, `TRUNCATE`, `MERGE` or `ON CONFLICT DO UPDATE` write is not
 * seen.
 *
 * WHICH TEXT EACH OF THE THREE READS IS THE SUBTLE PART:
 *
 *   - the data change and the `RAISE NOTICE`, STRIPPED, because a migration
 *     that merely discusses either in a comment has done neither. Both shapes
 *     are live: `20260826080100_calendar_entry_rewire` writes
 *     `UPDATE "Class" SET status='completed'` inside a comment, and
 *     `20260825065109_schedule_rule_backfill` names `RAISE NOTICE` in one
 *     while raising nothing of the sort.
 *   - the marker, RAW, because it *is* a comment and stripping erases it.
 *
 * `UPDATE` and `DELETE`, not `INSERT`: these are the statements that rewrite
 * rows a teacher already has. Anywhere in the text rather than
 * statement-initial, so a write buried in a `DO` block or a function body
 * counts the same as a top-level one.
 *
 * `cutoff` is a migration DIRECTORY NAME and the comparison is lexicographic,
 * which is chronological because Prisma prefixes every name with a timestamp.
 * Strictly after, so the named migration is itself outside the rule. Pass `''`
 * to run the rule unbounded, which is how a caller demonstrates that it reports
 * anything at all.
 *
 * Pure, for the reason `stripSqlComments` is. Returns names in the order they
 * arrived.
 */
export function untracedDataChanges(
  migrations: ReadonlyArray<{ name: string; sql: string }>,
  cutoff: string,
): string[] {
  return migrations
    .filter(({ name, sql }) => {
      if (name <= cutoff) return false;
      const stripped = stripSqlComments(sql);
      if (!DATA_CHANGE.test(stripped)) return false;
      if (RAISE_NOTICE.test(stripped)) return false;
      return !NO_NOTICE_MARKER.test(sql);
    })
    .map(({ name }) => name);
}
