import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  classifyApiError,
  isRestrictViolationOn,
  isTransientDbError,
  TERMINAL_TRIGGER_TAILS,
} from './api-errors';
import {
  liveFunctions,
  migrationSqlFiles,
  type MigrationFunction,
} from '../../tests/migration-sql';

/**
 * Matches the construction used in src/services/studio-class-generator.test.ts
 * — Prisma 6 takes the code and clientVersion in an options object.
 */
function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('constraint failed', {
    code,
    clientVersion: 'test',
    meta,
  });
}


/** The declaration that puts a trigger function under the contract below. */
const RAISES_23514 = "USING ERRCODE = '23514'";

/** Why one function fails the contract. `compliant` never appears in a result. */
type ContractBreach = {
  reason: 'no_terminal_clause' | 'no_known_tail' | 'compliant';
  message: string;
};

/**
 * The contract, as a function over parsed bodies rather than as assertions
 * inside one test.
 *
 * A function so the three cases below can share it — one against the real
 * migration directory, two against synthetic migrations that make the rule
 * fail on demand. The predecessor sweep inlined its assertions and was
 * therefore never observed failing, which is how it stayed green against a
 * migration carrying the exact defect it claimed to cover.
 */
function nonCompliantRaisers(raisers: readonly MigrationFunction[]): ContractBreach[] {
  const tails = Object.values(TERMINAL_TRIGGER_TAILS);
  const breaches: ContractBreach[] = [];
  for (const fn of raisers) {
    if (!fn.body.includes('which is terminal')) {
      breaches.push({
        reason: 'no_terminal_clause',
        message:
          `${fn.migration}: ${fn.functionName} raises SQLSTATE 23514 but its message omits ` +
          '"which is terminal", so classifyApiError will answer 500 instead of 409. Add the ' +
          'clause, or give the trigger a SQLSTATE of its own and a branch to match.',
      });
      continue;
    }
    if (!tails.some((tail) => fn.body.includes(tail))) {
      breaches.push({
        reason: 'no_known_tail',
        message:
          `${fn.migration}: ${fn.functionName} raises SQLSTATE 23514 with the terminality ` +
          'clause but no tail TERMINAL_TRIGGER_TAILS (src/lib/api-errors.ts) knows, so every ' +
          "fire of it logs as detail.trigger 'unknown'. Add its tail to that roster.",
      });
    }
  }
  return breaches;
}

/** A body carrying the SQLSTATE and NOT the clause — the rewire's own defect. */
const OFFENDING_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION synthetic_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'CalendarEntry % is frozen; cannot change its date', OLD.id
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
`;

/** The same function, replaced by a compliant body. */
const COMPLIANT_FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION synthetic_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'CalendarEntry % is completed, which is terminal; cannot change its date', OLD.id
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
`;

/** Clause present, tail unplaceable — a 409 an operator cannot facet. */
const UNPLACEABLE_TAIL_SQL = `
CREATE OR REPLACE FUNCTION synthetic_other_guard()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'CalendarEntry % is completed, which is terminal; cannot change its room', OLD.id
    USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;
`;

/**
 * Built from the real message `src/services/class-terminal-status.test.ts`
 * observed for an actual trigger fire, not a hand-written approximation —
 * `PrismaClientUnknownRequestError` carries no `code`/`meta`, so the
 * SQLSTATE and the trigger's own wording only exist inside this string.
 */
const terminalStatusErrorFixture = new Prisma.PrismaClientUnknownRequestError(
  `Invalid \`prisma.class.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "Class 824c3362-c21f-466e-a741-7301d469730f is cancelled, which is terminal; cannot change status to open", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: 'test' },
);

/**
 * The SECOND trigger to reach the same branch (#247), which since #327 is
 * `entry_frozen_schedule_guard` on `CalendarEntry` rather than the `Class`
 * trigger it replaced. Transcribed from a real fire through
 * `prisma.calendarEntry.update`, not hand-written: same SQLSTATE, same
 * `which is terminal` clause, different tail.
 *
 * It exists because the 409 mapping is SHARED, and a shared mapping pinned by
 * only the fixture that happened to come first is pinned for one caller and
 * assumed for the others. Anyone narrowing the matcher back to status-only
 * wording — the obvious "fix" once `which is terminal` stops being unique to
 * one trigger — turns schedule violations into 500s, and this is the test that
 * refuses to let that happen quietly.
 */
const terminalDateErrorFixture = new Prisma.PrismaClientUnknownRequestError(
  `Invalid \`prisma.calendarEntry.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "CalendarEntry 6c218048-a8f5-4478-a846-5722ec90278d is completed, which is terminal; cannot change its date, start time or duration", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: 'test' },
);

/**
 * The THIRD, `entry_terminal_liveness_guard` (#327,
 * `20260826140000_entry_guard_restorations`) — a regular entry refusing to be
 * un-cancelled, or a completed one refusing to be cancelled. Also transcribed
 * from a real fire through `prisma.calendarEntry.update`.
 *
 * Its own fixture rather than a reuse of the one above, because it is what
 * gives `detail.trigger` a third value to be wrong about: the two `warn`
 * triggers write different rows on different tables, and a facet that called
 * both `status` could not tell an operator which CAS was losing races.
 */
const terminalLivenessErrorFixture = new Prisma.PrismaClientUnknownRequestError(
  `Invalid \`prisma.calendarEntry.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "CalendarEntry dbdb2fe7-0571-44e3-9a68-89080663a0f8 is cancelled, which is terminal; cannot change its cancellation", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: 'test' },
);

/**
 * The FOURTH, `entry_completion_marker_guard` (#327,
 * `20260826182710_entry_completion_marker_guard`) — a completed entry refusing
 * to have its completion marker cleared. Transcribed from a real fire through
 * `prisma.calendarEntry.update({ data: { classCompletedAt: null } })`, which
 * is a call the generated client accepts: the column is a plain nullable
 * `DateTime`, so this fire is reachable from TypeScript and not only from raw
 * SQL.
 *
 * The one fixture here whose level is `error` alongside the date one, and the
 * pairing is the point: clearing this marker is what unfreezes a `date`, so
 * the two guards defend one guarantee from its two ends and an operator must
 * read them the same way.
 */
const terminalCompletionErrorFixture = new Prisma.PrismaClientUnknownRequestError(
  `Invalid \`prisma.calendarEntry.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "CalendarEntry 33d69dc9-6cf5-4fd1-bb72-4da83761b059 is completed, which is terminal; cannot change its completion", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: 'test' },
);

/**
 * The FIFTH shape, and the one that is not a trigger: a `23514` terminality
 * fire whose tail `TERMINAL_TRIGGER_TAILS` does not carry.
 *
 * It answers `unknown` at `error`, and both halves are the correction #327's
 * review forced. The tail chain used to FALL BACK to `status` — a real facet
 * with a meaning of its own, at `warn` — so an unplaceable fire landed in the
 * bucket an operator queries for "which status CAS is losing races", at the
 * level that pages nobody. The `date` and `completion` facets are `error`
 * because they mean an unguarded writer of the column the retention sweep
 * reads has appeared; a guard nobody has classified at all reads the same way,
 * so it gets the same level.
 *
 * Hand-written rather than transcribed, and it has to be: no such trigger
 * exists, which is the point. The sweep further down is what keeps it that way
 * — every live `23514` function must own one of the four known tails.
 */
const terminalUnplaceableErrorFixture = new Prisma.PrismaClientUnknownRequestError(
  `Invalid \`prisma.calendarEntry.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "CalendarEntry 4b0a1f3e-9c2d-4f51-8a7b-1d6e5c0f2a93 is completed, which is terminal; cannot change its room", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: 'test' },
);


/**
 * The measured shape of a `23P01` through Prisma Client (`exclusion-
 * conflict.test.ts`'s own fixture): `code` and `meta` are both undefined, and
 * the SQLSTATE and constraint name survive only in `message`.
 */
const exclusionConflictErrorFixture = new Prisma.PrismaClientUnknownRequestError(
  'Invalid `db.scheduleRule.create()` invocation\n\nError occurred during query execution:\n' +
    'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError ' +
    '{ code: "23P01", message: "conflicting key value violates exclusion constraint \\"ScheduleRule_teacher_slot_excl\\"", ' +
    'severity: "ERROR", detail: Some("Key ..."), column: None, hint: None }), transient: false })',
  { clientVersion: 'test' },
);

describe('classifyApiError', () => {
  it('maps P2002 to a 409 logged at warn, naming the constraint that fired', () => {
    const failure = classifyApiError(prismaError('P2002', { target: ['teacherId', 'roomId'] }));

    expect(failure.status).toBe(409);
    expect(failure.message).toBe('Resource already exists');
    expect(failure.level).toBe('warn');
    expect(failure.detail).toEqual({ target: ['teacherId', 'roomId'] });
  });

  /**
   * The whole point of splitting the two: "Resource already exists" is a
   * reasonable thing to return to a client and a useless thing to find in a
   * log. Collapsing them back into one field is the regression this pins.
   */
  it('does not reuse the client-facing message as the log message', () => {
    const failure = classifyApiError(prismaError('P2002'));

    expect(failure.logMessage).not.toBe(failure.message);
    expect(failure.logMessage.length).toBeGreaterThan(0);
  });

  /**
   * The backstop issue 298 introduced: `ScheduleRule_teacher_slot_excl` is
   * the one constraint the four template routes' own `isExclusionConflictOn`
   * branches are meant to catch before it ever reaches here. This is what a
   * write that skips that branch — a future call site, or a probe-and-catch
   * that raced and lost — still gets: a 409, not a 500, and no family name,
   * because this classifier has neither a probe nor a teacher in scope.
   */
  it('maps a ScheduleRule slot exclusion to a 409 logged at warn, naming neither family', () => {
    const failure = classifyApiError(exclusionConflictErrorFixture);

    expect(failure.status).toBe(409);
    expect(failure.message).toBe(
      'You already have a recurring class or studio class at an overlapping time on that day.',
    );
    expect(failure.level).toBe('warn');
  });

  /**
   * One classification, two log levels, and the table carries both so the
   * split cannot be flattened back without a named failure.
   *
   * The CALLER sees the same thing every time — same 409, same message — and
   * that is deliberate; the triggers mean the same thing to a teacher. The
   * OPERATOR does not. A status or liveness fire is a lost CAS race, a shape
   * this project has expected since #174, so `warn`. A date fire cannot happen
   * at all while `updateClass` is the only writer that moves an existing
   * entry's `date` and its entry CAS re-asks what the guard asks — so if it
   * happens, an unguarded writer of the column `reapClosedWaitlistEntries`
   * reads before it DELETEs has appeared. A completion fire says the same
   * thing one column earlier: clearing the marker is what would unfreeze that
   * `date`. Both are `error`, and pinning them here
   * is what stops a future tidy-up from collapsing the levels back to one on
   * the grounds that the branch "returns the same thing anyway".
   */
  it.each([
    ['status', terminalStatusErrorFixture, 'warn'],
    ['date', terminalDateErrorFixture, 'error'],
    ['liveness', terminalLivenessErrorFixture, 'warn'],
    ['completion', terminalCompletionErrorFixture, 'error'],
    ['unknown', terminalUnplaceableErrorFixture, 'error'],
  ] as const)('maps the terminal-%s trigger to a 409 logged at %s', (column, fixture, level) => {
    const failure = classifyApiError(fixture);

    expect(failure.status).toBe(409);
    expect(failure.level).toBe(level);
    expect(failure.message).toBe('That class can no longer be changed');
    // The column is absent from the message on purpose and present in the log
    // detail on purpose: the caller must not be told a half-truth, and the
    // operator must be able to facet on which trigger fired without grepping
    // inside the driver string.
    expect(failure.detail).toEqual({ trigger: column });
  });

  /**
   * This test adds no detection power, and that is not the argument for it.
   * The `it.each` above already asserts the exact string for both fixtures, so
   * naming a column reddens twice there before this ever runs. Under strict
   * mutation testing its marginal value is zero.
   *
   * What it buys is that IT SURVIVES THE REPAIR. When an exact-string
   * assertion goes red, the obvious fix is to edit the expected string to
   * match the source — a one-token diff that reads as noise and waves through
   * review, and the caller quietly starts being told the wrong thing about
   * half the failures that reach this branch. This test cannot be repaired
   * that way. Making it green after naming a column requires DELETING it, and
   * a deletion of a named test with a docblock attached is a thing a reviewer
   * sees. Its value is temporal, not detection-theoretic: it is here for the
   * moment someone is fixing a different test in a hurry.
   *
   * Word-anchored on purpose. A bare `/date/i` also matches the "date" inside
   * "up-dated", so it would reject `'That class can no longer be updated'` —
   * a perfectly good generalisation, and one someone may well reach for —
   * while claiming only to forbid naming a column. "validated" and
   * "candidate" are the same trap. `\b` makes the test forbid what it says it
   * forbids.
   */
  it('does not name a single column in the message every terminality trigger shares', () => {
    const message = classifyApiError(terminalDateErrorFixture).message;

    expect(message).not.toMatch(/\bstatus\b/i);
    expect(message).not.toMatch(/\bdate\b/i);
    expect(classifyApiError(terminalStatusErrorFixture).message).toBe(message);
  });

  /**
   * The other half of the same boundary, and the conjunct nothing pinned:
   * deleting `error.message.includes('23514')` from `isTerminalStatusViolation`
   * left the whole suite green, because every fixture carrying `which is
   * terminal` also carried that SQLSTATE. The wording alone was doing all the
   * work and no test could tell.
   *
   * This is the shape that makes the code load-bearing. plpgsql's bare `RAISE
   * EXCEPTION` defaults to `P0001` (raise_exception); every terminality
   * migration overrides it with `USING ERRCODE = '23514'`, and one copied from
   * another — the likely way this arrives — would produce exactly
   * this if the override were dropped along the way.
   *
   * It classifies 500, and that is the recorded choice rather than an
   * accident. State the requirement as an INSTRUCTION, because the previous
   * wording here read as though declaring `23514` were sufficient and it is
   * not: a new terminality trigger joins the 409 only by doing BOTH —
   * `USING ERRCODE = '23514'` *and* the literal clause `which is terminal` in
   * its message. Either alone is a 500. A message is prose anyone can write
   * and the SQLSTATE is a declaration, so neither is safe on its own:
   * widening to the wording alone would hand the 409 to any future `RAISE
   * EXCEPTION` that reuses the sentence, and accepting the SQLSTATE alone
   * would hand it to every plain `CHECK` in the schema.
   *
   * The sweep below turns that instruction into a red test rather than a
   * paragraph someone has to have read.
   */
  it('does not classify the terminality wording as terminal without the SQLSTATE', () => {
    const wrongSqlstate = new Prisma.PrismaClientUnknownRequestError(
      `Invalid \`prisma.class.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "P0001", message: "Class 4f2b1c90-6d1e-4a55-9f0b-2c7e8d3a1b64 is completed, which is terminal; cannot change its date from 2026-06-01 to 2020-01-01", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
      { clientVersion: 'test' },
    );

    const failure = classifyApiError(wrongSqlstate);

    // 409 is the tempting wrong answer here; `toBe(500)` above already
    // excludes it, so no second assertion is added to say so.
    expect(failure.status).toBe(500);
    expect(failure.message).toBe('Internal server error');
  });

  /**
   * BOTH error shapes of the same violation reach the 409. The SQLSTATE is
   * one thing and the error CLASS is another: which arrives is decided by how
   * the statement was issued, not by what failed. A typed `class.update`
   * produces `PrismaClientUnknownRequestError` (no P-code exists for "a
   * trigger fired"), spelling the code `code: "23514"`; a `$executeRaw`
   * produces `PrismaClientKnownRequestError` P2010, "raw query failed",
   * spelling it ``Code: `23514` ``. `class-terminal-date.test.ts` catches
   * both from the one trigger, against a real database.
   *
   * This test used to assert 500 for this shape and call it a recorded
   * choice. The choice was defensible — no raw writer of `Class` exists in
   * `src/` — but it made the 409 depend on a whole-repo census of raw
   * writers, which is a claim no test can hold true and which had already
   * drifted in the prose that asserted it. `isTransientDbError` had answered
   * the identical question for `55P03` by matching both shapes, and the
   * matcher now does the same. What used to require noticing an asymmetry in
   * a production log is now simply correct.
   *
   * Still not transient: a terminal class is still terminal on the retry, so
   * this must not slip into the 503 branch on its way past the 409 one. That
   * assertion is the one part of this test that did not change.
   */
  it('maps the raw-query shape of the same violation to a 409, like the typed shape', () => {
    const rawPath = new Prisma.PrismaClientKnownRequestError(
      'Raw query failed. Code: `23514`. Message: `ERROR: Class 30cb2d25-dd22-4bd3-8baf-e99f4f9c8219 is completed, which is terminal; cannot change its date from 2026-06-01 to 2020-01-01`',
      { code: 'P2010', clientVersion: 'test' },
    );

    const failure = classifyApiError(rawPath);

    expect(failure.status).toBe(409);
    expect(failure.message).toBe('That class can no longer be changed');
    expect(isTransientDbError(rawPath)).toBe(false);
  });

  /**
   * A bare `message.includes('23514')` would relabel any error whose text
   * merely quotes those five digits — an id fragment, an amount, a postcode —
   * as a terminality violation, which is the trap `isTransientDbError`'s
   * docblock names and which this matcher used to be the standing example of.
   * It now matches the SQLSTATE inside its Postgres framing, and this is the
   * fixture that tells the two apart: the digits appear, in a class id, and
   * the `which is terminal` clause appears too — everything the old bare
   * match needed, and no SQLSTATE anywhere.
   */
  it('does not treat the digits 23514 outside their SQLSTATE framing as the code', () => {
    const digitsInAnId = new Prisma.PrismaClientUnknownRequestError(
      `Invalid \`prisma.class.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "P0001", message: "Class 23514fbc-1d0e-4a55-9f0b-2c7e8d3a1b64 is completed, which is terminal; cannot change its date from 2026-06-01 to 2020-01-01", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
      { clientVersion: 'test' },
    );

    expect(classifyApiError(digitsInAnId).status).toBe(500);
  });

  /**
   * THE CONTRACT FOR THE NEXT TRIGGER, made mechanical.
   *
   * `isTerminalStatusViolation` needs two things at once: SQLSTATE `23514`
   * AND the literal clause `which is terminal`. `classifyApiError` then needs a
   * third — a message tail it can place, or the fire is filed under `unknown`.
   * The sweep below re-derives which functions must satisfy all three rather
   * than naming them, so this docblock carries no roster to go stale. A NEW
   * guard that declares the SQLSTATE and phrases its message differently — the
   * overwhelmingly likely mistake, since the SQLSTATE is the part a copy-paste
   * carries and the sentence is the part an author rewrites — classifies 500
   * for a request that should be a 409.
   *
   * PER FUNCTION, NOT PER FILE, and that is the correction #327 forced. The
   * predecessor filtered migration FILES containing the SQLSTATE and then
   * asserted the clause over the whole file string. That is satisfiable by a
   * sibling function a hundred lines away — or by a comment mentioning the
   * words — and it is exactly how the rewire's own
   * `entry_reject_frozen_schedule_change` shipped raising `23514` with no
   * `which is terminal` clause at all, answering 500 where its predecessor
   * answered 409. Nothing reddened, because
   * `class_reject_terminal_status_change` sat above it in the same file
   * carrying the clause. This branch is also what made that shape ordinary:
   * before it, every migration declaring this SQLSTATE held a single function,
   * so a file sweep and a function sweep could not disagree. This branch's
   * migrations bundle guards, and the two came apart. No figure is kept here —
   * the sweep below is the tether, and this docblock opens by refusing to
   * carry a roster.
   *
   * LAST WRITE WINS (`liveFunctions`, `tests/migration-sql.ts`), which is the
   * other half and pulls the opposite way. Per-function alone would redden
   * against the rewire's superseded body — text no database is running, since
   * `20260826140000_entry_guard_restorations` replaced it with a compliant
   * one. A pin failing on dead text is no better than one passing on it. The
   * same rule drops `class_reject_terminal_date_change`, which the rewire
   * DROPPED outright along with `Class.date`.
   *
   * Measured, in both directions, before this replaced the file sweep:
   * per-function without supersession reports
   * `entry_reject_frozen_schedule_change in 20260826080100_calendar_entry_rewire`
   * — the defect the file sweep could not see — and with supersession reports
   * nothing, which is correct. The two cases after this one are the standing
   * verdict: they feed the same rule synthetic migrations and watch it accept
   * a superseded offender and reject a live one.
   *
   * Reads files; touches no database. The inverse direction (a migration
   * carrying the phrase without the SQLSTATE) is pinned by the P0001 fixture
   * above, at the matcher rather than at the migration.
   */
  it('every LIVE function declaring SQLSTATE 23514 carries the clause and a tail the classifier knows', () => {
    const raisers = [...liveFunctions(migrationSqlFiles()).values()].filter((fn) =>
      fn.body.includes(RAISES_23514),
    );

    // Not vacuous: the four live terminality guards are what this covers, and
    // a parser change that stopped finding any of them would otherwise pass.
    expect(raisers.length).toBeGreaterThan(0);

    for (const offender of nonCompliantRaisers(raisers)) {
      expect(offender.reason, offender.message).toBe('compliant');
    }
  });

  /**
   * The rule's own verdict, half one: a SUPERSEDED offender is not reported.
   *
   * Without this the supersession half is an assertion about the tree rather
   * than about the rule — the live tree has no superseded offender left to
   * demonstrate it on, because the one it had is the defect this sweep was
   * built to catch and it has been fixed.
   */
  it('does not report a 23514 function a later migration replaced', () => {
    const raisers = [...liveFunctions([
      { name: '20990101000000_first', sql: OFFENDING_FUNCTION_SQL },
      { name: '20990102000000_second', sql: COMPLIANT_FUNCTION_SQL },
    ]).values()].filter((fn) => fn.body.includes(RAISES_23514));

    expect(raisers.map((fn) => fn.migration)).toEqual(['20990102000000_second']);
    expect(nonCompliantRaisers(raisers)).toEqual([]);
  });

  /**
   * The rule's own verdict, half two: a LIVE offender IS reported, one entry
   * per way of being wrong.
   *
   * A guard that cannot be observed failing certifies nothing, and the file
   * sweep this replaced is the standing example — it was green against a
   * migration that shipped the exact defect it claimed to cover.
   */
  it('reports a live 23514 function missing the clause, and one missing a known tail', () => {
    const raisers = [...liveFunctions([
      { name: '20990101000000_no_clause', sql: OFFENDING_FUNCTION_SQL },
      { name: '20990102000000_no_tail', sql: UNPLACEABLE_TAIL_SQL },
    ]).values()].filter((fn) => fn.body.includes(RAISES_23514));

    const reasons = nonCompliantRaisers(raisers).map((o) => o.reason).sort();
    expect(reasons).toEqual(['no_known_tail', 'no_terminal_clause']);
  });

  /**
   * `23514` (check_violation) is not unique to the terminality triggers —
   * every plain `CHECK` constraint in this schema defaults to the same
   * SQLSTATE with no `USING ERRCODE` override (`Student_income_tier_check`,
   * for one). A classifier that matched on the code alone would relabel any of
   * those as "that class can no longer be changed." This fixture has the same
   * code and the same error class, and deliberately not the `which is
   * terminal` wording, so it pins that the message text — not just the
   * SQLSTATE — is what discriminates.
   *
   * Note what this does NOT say: that the wording belongs to one trigger. Two
   * migrations emit it since #247 and both are meant to land on the 409. The
   * boundary being drawn here is terminality-vs-everything-else, not one
   * trigger vs another.
   */
  it('does not classify an unrelated check_violation as a terminality trigger', () => {
    const otherCheckViolation = new Prisma.PrismaClientUnknownRequestError(
      `Invalid \`prisma.student.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "new row for relation \\"Student\\" violates check constraint \\"Student_income_tier_check\\"", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
      { clientVersion: 'test' },
    );

    const failure = classifyApiError(otherCheckViolation);

    expect(failure.status).toBe(500);
    expect(failure.message).toBe('Internal server error');
  });

  /**
   * The two shapes a `lock_timeout` actually arrives in, both transcribed
   * from real errors this project's own database produced (a model write and
   * a `$queryRaw ... FOR UPDATE` blocked past `SET LOCAL lock_timeout =
   * '300ms'`), not invented. They differ in error CLASS, in whether `.code`
   * is set, and in how the SQLSTATE is spelled — a matcher written against
   * either one alone misses the other, and `lockClassRow` emits both from the
   * same helper (the raw `FOR UPDATE`, then every model write after it in the
   * transaction it bounded).
   */
  it.each<[string, Error]>([
    [
      'a model write (PrismaClientUnknownRequestError, code: "55P03")',
      new Prisma.PrismaClientUnknownRequestError(
        `Invalid \`prisma.class.updateMany()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "55P03", message: "canceling statement due to lock timeout", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
        { clientVersion: 'test' },
      ),
    ],
    [
      'a raw FOR UPDATE (PrismaClientKnownRequestError P2010, Code: `55P03`)',
      new Prisma.PrismaClientKnownRequestError(
        'Invalid `prisma.$queryRaw()` invocation:\n\n\nRaw query failed. Code: `55P03`. Message: `ERROR: canceling statement due to lock timeout`',
        { code: 'P2010', clientVersion: 'test' },
      ),
    ],
    [
      'a deadlock victim (PrismaClientUnknownRequestError, code: "40P01")',
      new Prisma.PrismaClientUnknownRequestError(
        `Invalid \`prisma.class.updateMany()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR", detail: Some("Process 1 waits for ShareLock on transaction 2; blocked by process 3."), column: None, hint: Some("See server log for query details.") }), transient: false })`,
        { clientVersion: 'test' },
      ),
    ],
  ])('maps %s to a 503 at warn, telling the caller to try again', (_label, thrown) => {
    expect(isTransientDbError(thrown)).toBe(true);

    const failure = classifyApiError(thrown);

    expect(failure.status).toBe(503);
    expect(failure.level).toBe('warn');
    expect(failure.message).toMatch(/try again/i);
  });

  /**
   * Task 6c (#196) set out to add a 409 branch for the deadlock
   * `Class_teacher_slot_unique` measured against real `updateClass` writes
   * (`docs/lock-order.md`, "The slot key is a wait edge", which records both
   * the measurement and the move of that key onto
   * `CalendarEntry_teacher_slot_excl` in #327) — on the premise
   * that `classifyApiError` had no branch for `40P01` at all. Reproduced
   * directly rather than trusting that premise (two real concurrent
   * `updateClass(prisma, ...)` calls swapping slots, throwaway database,
   * hit on the 5th natural attempt out of a 150-attempt budget, no
   * synchronisation): the branch above already existed, landed by an
   * unrelated already-merged PR (#174), and this scenario already lands in
   * it. The verbatim shape measured — same error class, same code-embedded
   * message, same absence of a `.code` property — as the `it.each` fixture
   * two blocks up, differing only in the call site
   * (`db.class.updateMany()`, `updateClass`'s own alias for the client, vs.
   * that fixture's `prisma.class.updateMany()`) and in incidental detail
   * (file path, process ids) that the predicate never inspects. This pins
   * that #196's specific deadlock does NOT fall through to the generic 500
   * — the outcome Task 6c wanted — without re-deciding #174's already-shipped
   * 503-not-409 choice, which this task's own measurement found no basis to
   * revisit (see the Task 6c report for the reasoning).
   */
  it('maps the real Class_teacher_slot_unique deadlock (measured via a real updateClass race) to a 503, not a 500', () => {
    const measured = new Prisma.PrismaClientUnknownRequestError(
      `Invalid \`db.class.updateMany()\` invocation in\n/repo/src/services/class-lifecycle.ts:543:29\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "40P01", message: "deadlock detected", severity: "ERROR", detail: Some("Process 1 waits for ShareLock on transaction 2; blocked by process 3.\\nProcess 3 waits for ShareLock on transaction 1; blocked by process 1."), column: None, hint: Some("See server log for query details.") }), transient: false })`,
      { clientVersion: 'test' },
    );

    expect(isTransientDbError(measured)).toBe(true);

    const failure = classifyApiError(measured);

    expect(failure.status).toBe(503);
    expect(failure.status).not.toBe(500);
    expect(failure.level).toBe('warn');
    expect(failure.message).toMatch(/try again/i);
  });

  it.each<[string, string]>([
    ['P2028 (interactive transaction budget expired)', 'P2028'],
    ['P2024 (connection pool timeout)', 'P2024'],
    ['P2034 (write conflict or deadlock)', 'P2034'],
  ])('maps %s to a 503 at warn', (_label, code) => {
    const failure = classifyApiError(prismaError(code));

    expect(failure.status).toBe(503);
    expect(failure.level).toBe('warn');
  });

  /**
   * The SQLSTATE is matched inside its Postgres framing, never as a bare
   * substring. `40001` is five digits that a perfectly ordinary error message
   * can quote — a postcode, an amount, an id fragment — and relabelling one of
   * those as "the system was busy, try again" is worse than the generic 500 it
   * replaced, because it tells the caller to repeat a request that will fail
   * identically forever. Same trap `isTerminalStatusViolation` documents for
   * `23514`, on a different code.
   */
  it('does not treat a message that merely contains a transient SQLSTATE as transient', () => {
    const unrelated = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed: postcode "40001" already exists for 55P03 Lock Street',
      { code: 'P2002', clientVersion: 'test' },
    );

    expect(isTransientDbError(unrelated)).toBe(false);
    expect(classifyApiError(unrelated).status).toBe(409);
  });

  /**
   * The terminality trigger raises `23514`, which is NOT in the transient set
   * — a class that reached a terminal status will still be terminal on the
   * next attempt. Ordering the transient branch ahead of the 23514 one, or
   * widening it, would turn a permanent 409 into "please try again" forever.
   */
  it('does not treat the terminal-status trigger as transient', () => {
    expect(isTransientDbError(terminalStatusErrorFixture)).toBe(false);
    expect(classifyApiError(terminalStatusErrorFixture).status).toBe(409);
  });

  /** P2025 stands in for "some other Prisma error". */
  it('maps a non-P2002 Prisma error to a 500 logged at error', () => {
    const failure = classifyApiError(prismaError('P2025'));

    expect(failure.status).toBe(500);
    expect(failure.message).toBe('Internal server error');
    expect(failure.level).toBe('error');
    expect(failure.detail).toBeUndefined();
  });

  it('maps a plain Error to a 500 logged at error, adding nothing to the log', () => {
    const failure = classifyApiError(new Error('kaboom'));

    expect(failure.status).toBe(500);
    expect(failure.level).toBe('error');
    // pino serializes an Error under `err` with its type and stack; there is
    // nothing left for the classification to say about it.
    expect(failure.detail).toBeUndefined();
  });

  /**
   * `throw 'boom'` is legal JavaScript and reaches this function as-is. The
   * classifier must not assume it was handed an Error — and must still let
   * the operator see what *was* thrown, because pino drops an `err` key whose
   * value is `undefined`, leaving a log line that names no error at all.
   */
  it.each<[string, unknown, string]>([
    ['a string', 'boom', 'string'],
    ['null', null, 'object'],
    ['undefined', undefined, 'undefined'],
    ['a plain object', { code: 'P2002' }, 'object'],
  ])('maps %s to a 500 that records what was thrown', (_label, thrown, thrownType) => {
    const failure = classifyApiError(thrown);

    expect(failure.status).toBe(500);
    expect(failure.level).toBe('error');
    expect(failure.detail).toEqual({ thrownType });
  });
});

describe('isRestrictViolationOn', () => {
  /**
   * The three shapes were MEASURED on 2026-08-19 by provoking each delete
   * against a TeacherRoom carrying one archived ClassTemplate and zero Class
   * rows, not hand-written:
   *
   *   teacherRoom.delete:     {"modelName":"TeacherRoom","constraint":"ClassTemplate_teacherRoomId_fkey"}
   *   teacherRoom.deleteMany: {"modelName":"TeacherRoom","constraint":"ClassTemplate_teacherRoomId_fkey"}
   *   room.delete:            {"modelName":"Room","constraint":"ClassTemplate_teacherRoomId_fkey"}
   *
   * `modelName` DIFFERS across them — a bare `room.delete` trips the
   * constraint through TeacherRoom_roomId_fkey's CASCADE — which is why the
   * matcher keys on `constraint` alone.
   *
   * NOTE, corrected in PR review: `DELETE /api/rooms/[id]` does not currently
   * emit the `"Room"` shape. It issues `teacherRoom.deleteMany` first, so a
   * blocker aborts there reporting `"TeacherRoom"`. The `"Room"` row above is
   * the shape that route WILL emit once the redundant `deleteMany` is removed,
   * which its own handler comment invites. Keeping the matcher blind to
   * `modelName` is what makes that removal safe.
   */
  const ROOM_FKS = ['ClassTemplate_teacherRoomId_fkey', 'Class_teacherRoomId_fkey'] as const;

  it('matches the template FK from either delete, despite the differing modelName', () => {
    for (const modelName of ['TeacherRoom', 'Room']) {
      const err = prismaError('P2003', {
        modelName,
        constraint: 'ClassTemplate_teacherRoomId_fkey',
      });
      expect(isRestrictViolationOn(err, ROOM_FKS)).toBe(true);
    }
  });

  it('matches the class FK too — the Class guard has the same race and no other backstop', () => {
    const err = prismaError('P2003', {
      modelName: 'TeacherRoom',
      constraint: 'Class_teacherRoomId_fkey',
    });
    expect(isRestrictViolationOn(err, ROOM_FKS)).toBe(true);
  });

  /**
   * The mutation guard, and the only case that fails when the matcher is
   * widened to "any P2003" — which is the tempting simplification, because
   * every case above passes under it.
   *
   * `Registration_classId_fkey` is a REAL constraint
   * (`20260403092044_init/migration.sql:354`), deliberately not an invented
   * name: an assertion against a string nothing in the schema produces cannot
   * distinguish a working matcher from one that matches nothing at all.
   */
  it('does not match a P2003 from an unrelated foreign key', () => {
    const err = prismaError('P2003', {
      modelName: 'Registration',
      constraint: 'Registration_classId_fkey',
    });
    expect(isRestrictViolationOn(err, ROOM_FKS)).toBe(false);
  });

  it('does not match a non-P2003, a non-Prisma throwable, or a missing constraint', () => {
    expect(
      isRestrictViolationOn(
        prismaError('P2002', { constraint: 'ClassTemplate_teacherRoomId_fkey' }),
        ROOM_FKS,
      ),
    ).toBe(false);
    // The bare-substring trap `isTransientDbError` documents at :208 — an
    // Error whose text merely quotes the constraint name is not a P2003.
    expect(isRestrictViolationOn(new Error('ClassTemplate_teacherRoomId_fkey'), ROOM_FKS)).toBe(
      false,
    );
    expect(isRestrictViolationOn(undefined, ROOM_FKS)).toBe(false);
    expect(isRestrictViolationOn(prismaError('P2003', { modelName: 'TeacherRoom' }), ROOM_FKS)).toBe(
      false,
    );
  });
});
