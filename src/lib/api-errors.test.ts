import { describe, it, expect } from 'vitest';
import { Prisma } from '@/lib/prisma-client';
import {
  classifyApiError,
  isLockTimeout,
  isRestrictViolationOn,
  isTransientDbError,
  transientDbFailure,
  TERMINAL_TRIGGER_TAILS,
  TRANSIENT_ADAPTER_KIND,
  type ApiFailure,
  type TransientKind,
} from './api-errors';
import {
  liveFunctions,
  migrationSqlFiles,
  type MigrationFunction,
} from '../../tests/migration-sql';
import { ADAPTER_KINDS, isPgConnectionTerminated } from './pg-error';
import { knownWithAdapterCause, pgCause, pgConnectionTerminated, pgConnectTimeout, pgPoolTimeout, socketCause, typedCallError } from '../../tests/adapter-errors';

/**
 * Matches the construction used in src/services/studio-class-generator.test.ts
 * — Prisma takes the code and clientVersion in an options object.
 */
function prismaError(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('constraint failed', {
    code,
    clientVersion: 'test',
    meta,
  });
}

const LOCK_TIMEOUT_MESSAGE = 'canceling statement due to lock timeout';

/** A Postgres error on a typed call's shape: a Known error whose code follows the adapter's kind. */
function typedPg(sqlState: string, message: string): Prisma.PrismaClientKnownRequestError {
  return typedCallError(pgCause(sqlState, message));
}

/** A Postgres error on a raw call's shape: a Known `P2010` with the adapter's cause in `meta`. */
function rawPg(sqlState: string, message: string): Prisma.PrismaClientKnownRequestError {
  return knownWithAdapterCause('P2010', pgCause(sqlState, message));
}


/**
 * The declaration that puts a trigger function under the contract below, in
 * either spelling PL/pgSQL accepts for SQLSTATE 23514: the code itself or its
 * condition name.
 */
const RAISES_23514 = /USING\s+ERRCODE\s*=\s*'(?:23514|check_violation)'/i;

function raises23514(fn: MigrationFunction): boolean {
  return RAISES_23514.test(fn.body);
}

/**
 * Functions that raise 23514 WITHOUT the terminality clause on purpose, so
 * `classifyApiError` answers them 500, each with its reason. The live sweep
 * skips these; the test after it fails on an entry no live function matches.
 */
const DELIBERATE_500_RAISERS: Readonly<Record<string, string>> = {
  class_reject_frozen_currency_change:
    'a currency write reaching this guard means a writer outside the switch’s own filter exists — a bug, not a refusal (#758)',
  studio_class_reject_frozen_currency_change:
    'a currency write reaching this guard means a writer outside the switch’s own filter exists — a bug, not a refusal (#758)',
};

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
 * observed for an actual trigger fire, not a hand-written approximation. A
 * typed write's shape: a Known `P2039` whose adapter cause carries the
 * SQLSTATE and the trigger's own wording.
 */
const terminalStatusErrorFixture = typedCallError(pgCause('23514', 'Class 824c3362-c21f-466e-a741-7301d469730f is cancelled, which is terminal; cannot change status to open'));

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
const terminalDateErrorFixture = typedCallError(pgCause('23514', 'CalendarEntry 6c218048-a8f5-4478-a846-5722ec90278d is completed, which is terminal; cannot change its date, start time or duration'));

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
const terminalLivenessErrorFixture = typedCallError(pgCause('23514', 'CalendarEntry dbdb2fe7-0571-44e3-9a68-89080663a0f8 is cancelled, which is terminal; cannot change its cancellation'));

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
const terminalCompletionErrorFixture = typedCallError(pgCause('23514', 'CalendarEntry 33d69dc9-6cf5-4fd1-bb72-4da83761b059 is completed, which is terminal; cannot change its completion'));

/**
 * The SIXTH, `entry_rule_kind_mismatch_guard` (#328,
 * `20260829120000_entry_rule_kind_guard`) — an entry referencing a rule of a
 * different kind.
 */
const terminalEntryRuleKindErrorFixture = typedCallError(pgCause('23514', 'CalendarEntry e3b0c442-98fc-1c14-9afb-4c8996fb9242 references ScheduleRule 12345678-1234-1234-1234-123456789abc of kind studio, which is terminal; cannot attach to mismatched rule kind'));

/**
 * The SEVENTH, `schedule_rule_kind_immutability_guard` (#328,
 * `20260829120000_entry_rule_kind_guard`) — an attempt to change a ScheduleRule's
 * kind after creation.
 */
const terminalRuleKindErrorFixture = typedCallError(pgCause('23514', 'ScheduleRule 12345678-1234-1234-1234-123456789abc is regular, which is terminal; cannot change its kind'));

/**
 * The EIGHTH shape, and the one that is not a trigger: a `23514` terminality
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
const terminalUnplaceableErrorFixture = typedCallError(pgCause('23514', 'CalendarEntry 4b0a1f3e-9c2d-4f51-8a7b-1d6e5c0f2a93 is completed, which is terminal; cannot change its room'));


/** A typed write's `23P01`: a Known `P2039` carrying Postgres's own message. */
const exclusionConflictErrorFixture = typedCallError(
  pgCause('23P01', 'conflicting key value violates exclusion constraint "ScheduleRule_teacher_slot_excl"'),
);

const calendarEntryExclusionConflictErrorFixture = typedCallError(
  pgCause('23P01', 'conflicting key value violates exclusion constraint "CalendarEntry_teacher_slot_excl"'),
);

describe('classifyApiError', () => {
  it('requires a registered 409 code on every 409 classification, at compile time', () => {
    const coded: ApiFailure = {
      status: 409,
      code: 'UNIQUE_CONFLICT',
      message: 'm',
      logMessage: 'l',
      level: 'warn',
    };
    expect(coded.code).toBe('UNIQUE_CONFLICT');

    // @ts-expect-error — a 409 classification without a code
    const uncoded: ApiFailure = { status: 409, message: 'm', logMessage: 'l', level: 'warn' };

    // @ts-expect-error — a 404 code on a 409 classification
    const misfiled: ApiFailure = { status: 409, code: 'NOT_FOUND', message: 'm', logMessage: 'l', level: 'warn' };

    void [uncoded, misfiled];
  });

  // The pins above do not exercise a server arm's `code`: a 409 literal never
  // matches an arm carrying another status, so widening one of those leaves
  // every one of them still passing. Each server status is its own arm too, so
  // the sibling misfilings below are the only thing asserting that separation.
  // Why one arm per status:
  // docs/superpowers/specs/2026-09-17-api-error-contract-design.md §4.3.
  it('keeps a code registered at another status off a 500 or 503 classification, at compile time', () => {
    const coded503: ApiFailure = {
      status: 503,
      code: 'TEMPLATE_BUSY',
      message: 'm',
      logMessage: 'l',
      level: 'error',
    };
    const coded500: ApiFailure = {
      status: 500,
      code: 'ERASURE_FAILED',
      message: 'm',
      logMessage: 'l',
      level: 'error',
    };
    expect([coded503.code, coded500.code]).toEqual(['TEMPLATE_BUSY', 'ERASURE_FAILED']);

    // @ts-expect-error — a 404 code on a 503 classification
    const misfiled404: ApiFailure = { status: 503, code: 'NOT_FOUND', message: 'm', logMessage: 'l', level: 'error' };
    // @ts-expect-error — a code registered at 500, on a 503 classification
    const misfiled500on503: ApiFailure = { status: 503, code: 'ERASURE_FAILED', message: 'm', logMessage: 'l', level: 'error' };
    // @ts-expect-error — a code registered at 503, on a 500 classification
    const misfiled503on500: ApiFailure = { status: 500, code: 'TEMPLATE_BUSY', message: 'm', logMessage: 'l', level: 'error' };

    void [misfiled404, misfiled500on503, misfiled503on500];
  });

  it('maps P2002 to a 409 logged at warn, naming the constraint that fired', () => {
    const failure = classifyApiError(knownWithAdapterCause('P2002', pgCause('23505', 'duplicate key value violates unique constraint "TeacherRoom_teacherId_roomId_key"')));

    expect(failure.status).toBe(409);
    expect(failure.code).toBe('UNIQUE_CONFLICT');
    expect(failure.level).toBe('warn');
    expect(failure.detail).toEqual({ constraint: 'TeacherRoom_teacherId_roomId_key' });
  });

  it('maps a P2002 carrying no Postgres error to the same 409, its constraint unnamed', () => {
    const failure = classifyApiError(prismaError('P2002', { target: ['teacherId', 'roomId'] }));

    expect(failure.status).toBe(409);
    expect(failure.code).toBe('UNIQUE_CONFLICT');
    expect(failure.detail).toEqual({ constraint: undefined });
  });

  /**
   * The whole point of splitting the two: "That already exists." is a
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
    expect(failure.code).toBe('RULE_SLOT_TAKEN');
    expect(failure.level).toBe('warn');
  });

  /**
   * The backstop issue 301 introduced: `CalendarEntry_teacher_slot_excl` is
   * the entry-level counterpart of `ScheduleRule_teacher_slot_excl`. An
   * uncaught entry slot exclusion (e.g. from an unlocked-read race during
   * template resume generation, or an unhandled entry write) maps to a 409
   * at warn rather than falling through to the generic 500 default.
   */
  it('maps a CalendarEntry slot exclusion to a 409 logged at warn, naming neither family', () => {
    const failure = classifyApiError(calendarEntryExclusionConflictErrorFixture);

    expect(failure.status).toBe(409);
    expect(failure.message).toBe(
      'You already have a class or studio class at an overlapping time on that date.',
    );
    expect(failure.code).toBe('ENTRY_SLOT_TAKEN');
    expect(failure.logMessage).toBe('calendar entry slot exclusion escaped a route to the 409 fallback');
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
    ['entry_rule_kind', terminalEntryRuleKindErrorFixture, 'error'],
    ['rule_kind', terminalRuleKindErrorFixture, 'error'],
    ['unknown', terminalUnplaceableErrorFixture, 'error'],
  ] as const)('maps the terminal-%s trigger to a 409 logged at %s', (column, fixture, level) => {
    const failure = classifyApiError(fixture);

    expect(failure.status).toBe(409);
    expect(failure.level).toBe(level);
    expect(failure.message).toBe('That class can no longer be changed');
    expect(failure.code).toBe('CLASS_FROZEN');
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
   * deleting the `23514` check from the terminality matcher
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
    const wrongSqlstate = typedCallError(pgCause('P0001', 'Class 4f2b1c90-6d1e-4a55-9f0b-2c7e8d3a1b64 is completed, which is terminal; cannot change its date from 2026-06-01 to 2020-01-01'));

    const failure = classifyApiError(wrongSqlstate);

    // 409 is the tempting wrong answer here; `toBe(500)` above already
    // excludes it, so no second assertion is added to say so.
    expect(failure.status).toBe(500);
    expect(failure.message).toBe('Internal server error');
  });

  /**
   * BOTH error shapes of the same violation reach the 409. Which arrives is
   * decided by how the statement was issued, not by what failed: a typed
   * `class.update` throws a `P2039`, and a `$executeRaw` throws a `P2010`
   * carrying the same cause. `class-terminal-date.test.ts` catches
   * both from the one trigger, against a real database.
   *
   * Still not transient: a terminal class is still terminal on the retry, so
   * this must not slip into the 503 branch on its way past the 409 one.
   */
  it('maps the raw-query shape of the same violation to a 409, like the typed shape', () => {
    const rawPath = knownWithAdapterCause(
      'P2010',
      pgCause('23514', 'Class 30cb2d25-dd22-4bd3-8baf-e99f4f9c8219 is completed, which is terminal; cannot change its date from 2026-06-01 to 2020-01-01'),
    );

    const failure = classifyApiError(rawPath);

    expect(failure.status).toBe(409);
    expect(failure.message).toBe('That class can no longer be changed');
    expect(isTransientDbError(rawPath)).toBe(false);
  });

  /**
   * A bare `message.includes('23514')` would relabel any error whose text
   * merely quotes those five digits — an id fragment, an amount, a postcode —
   * as a terminality violation. The SQLSTATE is read from a structured field,
   * and this is the fixture that tells the two apart: the digits appear, in a
   * class id, and the `which is terminal` clause appears too, under another
   * SQLSTATE.
   */
  it('does not treat the digits 23514 in the message as the SQLSTATE', () => {
    const digitsInAnId = typedCallError(pgCause('P0001', 'Class 23514fbc-1d0e-4a55-9f0b-2c7e8d3a1b64 is completed, which is terminal; cannot change its date from 2026-06-01 to 2020-01-01'));

    expect(classifyApiError(digitsInAnId).status).toBe(500);
  });

  /**
   * THE CONTRACT FOR THE NEXT TRIGGER, made mechanical.
   *
   * `terminalViolationOf` needs two things at once: SQLSTATE `23514`
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
    const raisers = [...liveFunctions(migrationSqlFiles()).values()].filter(
      (fn) => raises23514(fn) && !(fn.functionName in DELIBERATE_500_RAISERS),
    );

    // Not vacuous: the live terminality guards are what this covers, and a
    // parser change that stopped finding any of them would otherwise pass.
    expect(raisers.length).toBeGreaterThan(0);

    for (const offender of nonCompliantRaisers(raisers)) {
      expect(offender.reason, offender.message).toBe('compliant');
    }
  });

  /** An allowlist entry no live 23514 function answers to exempts nothing and hides a rename. */
  it('every DELIBERATE_500_RAISERS entry names a live function raising 23514', () => {
    const live = new Set(
      [...liveFunctions(migrationSqlFiles()).values()].filter(raises23514).map((fn) => fn.functionName),
    );
    for (const name of Object.keys(DELIBERATE_500_RAISERS)) {
      expect(live.has(name), `${name} is allowlisted but no live function of that name raises 23514`).toBe(true);
    }
  });

  /**
   * The two currency guards raise 23514 with no terminality clause, so they
   * reach the generic 500, never `CLASS_FROZEN`. Messages transcribed from the
   * guards' own `RAISE EXCEPTION` text in
   * `20261006130000_currency_frozen_guards`.
   */
  it.each([
    [
      'class_reject_frozen_currency_change',
      'Class 30cb2d25-dd22-4bd3-8baf-e99f4f9c8219 is booked or terminal and cannot change its currency',
    ],
    [
      'studio_class_reject_frozen_currency_change',
      'Studio class 4b0a1f3e-9c2d-4f51-8a7b-1d6e5c0f2a93 is a past income record and cannot change its currency',
    ],
  ] as const)('classifies %s as a 500, not CLASS_FROZEN', (_guard, message) => {
    const error = typedCallError(pgCause('23514', message));

    const failure = classifyApiError(error);

    expect(failure.status).toBe(500);
    expect(failure.code).not.toBe('CLASS_FROZEN');
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
    ]).values()].filter((fn) => raises23514(fn));

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
    ]).values()].filter((fn) => raises23514(fn));

    const reasons = nonCompliantRaisers(raisers).map((o) => o.reason).sort();
    expect(reasons).toEqual(['no_known_tail', 'no_terminal_clause']);
  });

  /**
   * `23514` (check_violation) is not unique to the terminality triggers —
   * every plain `CHECK` constraint in this schema defaults to the same
   * SQLSTATE with no `USING ERRCODE` override (`Student_income_tier_check`,
   * for one). A classifier that matched on the code alone would relabel any of
   * those as "that class can no longer be changed." This fixture has the same
   * SQLSTATE and the same error shape, and deliberately not the `which is
   * terminal` wording, so it pins that the message text — not just the
   * SQLSTATE — is what discriminates.
   *
   * Note what this does NOT say: that the wording belongs to one trigger. Two
   * migrations emit it since #247 and both are meant to land on the 409. The
   * boundary being drawn here is terminality-vs-everything-else, not one
   * trigger vs another.
   */
  it('does not classify an unrelated check_violation as a terminality trigger', () => {
    const otherCheckViolation = typedCallError(
      pgCause('23514', 'new row for relation "Student" violates check constraint "Student_income_tier_check"'),
    );

    const failure = classifyApiError(otherCheckViolation);

    expect(failure.status).toBe(500);
    expect(failure.message).toBe('Internal server error');
  });

  /**
   * The two shapes a transient SQLSTATE arrives in under the pg driver
   * adapter: a typed call's (`P2039`, or `P2034` for a deadlock) and a raw
   * call's `P2010`. The SQLSTATE, not the Prisma code, decides the kind.
   * `lockClassRow` emits both from the same helper (the raw `FOR UPDATE`,
   * then every model write after it in the transaction it bounded). Each is
   * produced against the real database in `db-transient-shapes.test.ts`; the
   * fabrications here are held to those by the fidelity cases there and in
   * `pg-error.test.ts`.
   */
  it.each<[string, Error, TransientKind, 'warn' | 'error']>([
    ['a model write (typed Known P2039, 55P03)', typedPg('55P03', LOCK_TIMEOUT_MESSAGE), 'lock_timeout', 'warn'],
    ['a raw FOR UPDATE (Known P2010, 55P03)', rawPg('55P03', LOCK_TIMEOUT_MESSAGE), 'lock_timeout', 'warn'],
    ['a deadlock victim (typed Known P2034, 40P01)', typedPg('40P01', 'deadlock detected'), 'deadlock', 'error'],
    ['a deadlock victim (Known P2010, 40P01)', rawPg('40P01', 'deadlock detected'), 'deadlock', 'error'],
  ])('maps %s to a 503 at its kind\'s level, telling the caller to try again', (_label, thrown, kind, level) => {
    expect(isTransientDbError(thrown)).toBe(true);

    const failure = classifyApiError(thrown);

    expect(failure.status).toBe(503);
    expect(failure.level).toBe(level);
    expect(failure.message).toMatch(/try again/i);
    expect(failure.detail).toEqual({ transientKind: kind });
  });

  /**
   * The slot-key deadlock `docs/lock-order.md` records ("The slot key is a
   * wait edge") comes from `updateClass`'s model write, so it arrives on the
   * typed shape. It is a 503 at `error`, not the generic 500.
   */
  it('maps a slot-key deadlock (a model write\'s typed 40P01) to a 503, not a 500', () => {
    const victim = typedPg('40P01', 'deadlock detected');

    expect(isTransientDbError(victim)).toBe(true);

    const failure = classifyApiError(victim);

    expect(failure.status).toBe(503);
    expect(failure.level).toBe('error');
    expect(failure.message).toMatch(/try again/i);
    expect(failure.detail).toEqual({ transientKind: 'deadlock' });
  });

  it.each<[string, string, TransientKind, 'warn' | 'error']>([
    ['P2028 (interactive transaction budget expired)', 'P2028', 'tx_budget', 'warn'],
    ['P2034 (serialization failure)', 'P2034', 'serialization', 'warn'],
  ])('maps %s to a 503 at its kind\'s level', (_label, code, kind, level) => {
    const failure = classifyApiError(
      code === 'P2034' ? knownWithAdapterCause('P2034', pgCause('40001', 'could not serialize access due to concurrent update')) : prismaError(code),
    );

    expect(failure.status).toBe(503);
    expect(failure.level).toBe(level);
    expect(failure.detail).toEqual({ transientKind: kind });
  });

  it('maps pg-pool\'s wait timeout (pool_exhausted) to a 503 at error', () => {
    const failure = classifyApiError(pgPoolTimeout());

    expect(failure.status).toBe(503);
    expect(failure.level).toBe('error');
    expect(failure.detail).toEqual({ transientKind: 'pool_exhausted' });
  });

  /**
   * The SQLSTATE is read from the adapter's structured field, never from an
   * error's text. `40001` is five digits that a perfectly ordinary error message
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
   * `room-deletion.test.ts` provokes these deletes against the real database
   * and asserts the constraint each reports; these fixtures are the
   * illustration. The model Prisma names DIFFERS across them — a bare
   * `room.delete` trips the constraint through `TeacherRoom_roomId_fkey`'s
   * CASCADE and reports `"Room"` — which is why the matcher keys on the
   * constraint name alone.
   */
  /** The adapter's cause for a refused delete: the name sits in `constraint.index`. */
  function restrictCause(constraint: string) {
    return pgCause(
      '23503',
      `update or delete on table "TeacherRoom" violates foreign key constraint "${constraint}" on table "X"`,
      { constraint: { index: constraint } },
    );
  }
  function restrictError(constraint: string, meta: Record<string, unknown> = { modelName: 'TeacherRoom' }) {
    return knownWithAdapterCause('P2003', restrictCause(constraint), meta);
  }

  const ROOM_FKS = [
    'ClassTemplate_teacherRoomId_roomArchived_fkey',
    'Class_teacherRoomId_roomArchived_fkey',
  ] as const;

  it('matches the template FK from either delete, despite the differing modelName', () => {
    for (const modelName of ['TeacherRoom', 'Room']) {
      const err = restrictError('ClassTemplate_teacherRoomId_roomArchived_fkey', { modelName });
      expect(isRestrictViolationOn(err, ROOM_FKS)).toBe(true);
    }
  });

  it('matches the class FK too — the Class guard has the same race and no other backstop', () => {
    expect(isRestrictViolationOn(restrictError('Class_teacherRoomId_roomArchived_fkey'), ROOM_FKS)).toBe(true);
  });

  it('matches the raw-query shape, a P2010 carrying the same cause', () => {
    const raw = knownWithAdapterCause('P2010', restrictCause('Class_teacherRoomId_roomArchived_fkey'));
    expect(isRestrictViolationOn(raw, ROOM_FKS)).toBe(true);
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
    const err = restrictError('Registration_classId_fkey', { modelName: 'Registration' });
    expect(isRestrictViolationOn(err, ROOM_FKS)).toBe(false);
  });

  it('does not match another SQLSTATE, a non-Prisma throwable, or a missing constraint', () => {
    expect(
      isRestrictViolationOn(
        knownWithAdapterCause(
          'P2002',
          pgCause('23505', 'duplicate key value violates unique constraint "ClassTemplate_teacherRoomId_roomArchived_fkey"'),
        ),
        ROOM_FKS,
      ),
    ).toBe(false);
    // An Error whose text merely quotes the constraint name is not a refusal.
    expect(isRestrictViolationOn(new Error('ClassTemplate_teacherRoomId_roomArchived_fkey'), ROOM_FKS)).toBe(
      false,
    );
    expect(isRestrictViolationOn(undefined, ROOM_FKS)).toBe(false);
    // The name is read from `constraint.index` only; a cause without one names nothing.
    const unnamed = knownWithAdapterCause(
      'P2003',
      pgCause('23503', 'update or delete on table "TeacherRoom" violates foreign key constraint "Class_teacherRoomId_roomArchived_fkey" on table "Class"'),
      { modelName: 'TeacherRoom' },
    );
    expect(isRestrictViolationOn(unnamed, ROOM_FKS)).toBe(false);
  });
});

/**
 * A transient SQLSTATE under exactly `layers` wrappers — `layers: 0` is the
 * transient error itself. One builder for every depth case below, so the three
 * of them cannot differ in anything but the number they pass.
 */
function buriedUnder(layers: number): Error {
  let wrapped: Error = typedPg('55P03', LOCK_TIMEOUT_MESSAGE);
  for (let i = 0; i < layers; i += 1) wrapped = new Error(`layer ${i}`, { cause: wrapped });
  return wrapped;
}

describe('isTransientDbError', () => {
  /**
   * The wrapping seam. `SpotFreedError` (`services/waitlist.ts`) carries the
   * real failure as `cause`, and the first branch of this matcher is an
   * `instanceof` check a wrapper cannot satisfy — so without the walk, a
   * connection-pool timeout reaching a `handleSpotFreed` call site would be
   * classified as a defect that never clears, log at `error`, and (in the
   * reconciliation sweep) redden `/api/health` immediately.
   */
  it('sees a pool timeout through one layer of cause wrapping', () => {
    expect(isTransientDbError(new Error('spot-freed hook failed', { cause: pgPoolTimeout() }))).toBe(true);
  });

  it('sees a transient Prisma code through one layer of cause wrapping', () => {
    expect(isTransientDbError(new Error('spot-freed hook failed', { cause: prismaError('P2028') }))).toBe(true);
  });

  it('sees a transient SQLSTATE through two layers of cause wrapping', () => {
    const lockTimeout = rawPg('55P03', LOCK_TIMEOUT_MESSAGE);
    const inner = new Error('spot-freed hook failed', { cause: lockTimeout });

    expect(isTransientDbError(new Error('sweep failed', { cause: inner }))).toBe(true);
  });

  /**
   * The bound, asserted rather than assumed. A chain is walked to a fixed depth
   * so a pathological or cyclic one cannot hang the classifier; a transient
   * error buried past that depth is reported non-transient, which is the safe
   * direction (it escalates rather than quieting).
   */
  it('stops walking past its depth bound', () => {
    expect(isTransientDbError(buriedUnder(8))).toBe(false);
  });

  /**
   * The two sides of the bound itself, which the pair above cannot pin between
   * them: "two layers is found" and "eight layers is not" hold for every bound
   * from two to seven, so `MAX_CAUSE_DEPTH` could be changed to any of those
   * and leave this file green. These two fix it at its actual value — the walk
   * follows `cause` that many times past the error it was handed, so a
   * transient error at exactly that depth is still found and one layer further
   * out is not. Lowering the constant reddens the first; raising it reddens the
   * second.
   *
   * The direction matters more than the number: a chain buried one layer too
   * deep is reported NON-transient, which escalates rather than quieting, so
   * the second test is also the one that keeps that safe direction honest.
   */
  it('finds a transient cause buried at exactly the depth bound', () => {
    expect(isTransientDbError(buriedUnder(4))).toBe(true);
  });

  it('misses a transient cause buried one layer past the depth bound', () => {
    expect(isTransientDbError(buriedUnder(5))).toBe(false);
  });

  it('terminates on a cyclic cause chain', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(isTransientDbError(a)).toBe(false);
  });

  /**
   * A non-Error cause ends the walk rather than throwing — `cause` is typed
   * `unknown` and nothing stops a caller putting a string or a plain object
   * there.
   */
  it('ends the walk at a non-Error cause', () => {
    expect(isTransientDbError(new Error('outer', { cause: pgCause('55P03', LOCK_TIMEOUT_MESSAGE) }))).toBe(false);
  });
});

describe('transientDbFailure', () => {
  it.each<[string, unknown, TransientKind, 'warn' | 'error']>([
    ['55P03 typed (Known P2039)', typedPg('55P03', LOCK_TIMEOUT_MESSAGE), 'lock_timeout', 'warn'],
    ['55P03 raw (P2010)', rawPg('55P03', LOCK_TIMEOUT_MESSAGE), 'lock_timeout', 'warn'],
    ['40P01 typed (Known P2034)', typedPg('40P01', 'deadlock detected'), 'deadlock', 'error'],
    ['40P01 raw (P2010)', rawPg('40P01', 'deadlock detected'), 'deadlock', 'error'],
    ['40001 raw (P2010)', rawPg('40001', 'could not serialize access due to concurrent update'), 'serialization', 'warn'],
    ['P2028', prismaError('P2028'), 'tx_budget', 'warn'],
    ['40001 typed (Known P2034)', typedPg('40001', 'could not serialize access due to concurrent update'), 'serialization', 'warn'],
    // P2034 is a write conflict or a deadlock; with no SQLSTATE to tell them apart, the louder kind.
    ['P2034 with no adapter cause', prismaError('P2034'), 'deadlock', 'error'],
    ['53300 typed (Known P2037)', typedCallError(pgCause('53300', 'sorry, too many clients already')), 'connection', 'error'],
    ['53300 raw (P2010)', rawPg('53300', 'sorry, too many clients already'), 'connection', 'error'],
    // The two rows below isolate the two routes a `53300` can take: its SQLSTATE
    // under a kind no map holds, and its adapter kind with no SQLSTATE.
    ['53300 SQLSTATE only', knownWithAdapterCause('P2010', pgCause('53300', 'sorry, too many clients already', { kind: 'postgres' })), 'connection', 'error'],
    ['TooManyConnections kind only', knownWithAdapterCause('P2037', { kind: 'TooManyConnections', cause: 'x' }), 'connection', 'error'],
    ['57P01 typed (Known P2039)', typedPg('57P01', 'terminating connection due to administrator command'), 'connection', 'error'],
    ['57P01 raw (P2010)', rawPg('57P01', 'terminating connection due to administrator command'), 'connection', 'error'],
    ['57P02 raw (P2010)', rawPg('57P02', 'terminating connection because of crash of another server process'), 'connection', 'error'],
    ['57P03 raw (P2010)', rawPg('57P03', 'the database system is starting up'), 'connection', 'error'],
    ['ECONNREFUSED typed (Known P1001)', knownWithAdapterCause('P1001', socketCause('DatabaseNotReachable'), { modelName: 'Class' }), 'connection', 'error'],
    ['ECONNREFUSED raw (P2010)', knownWithAdapterCause('P2010', socketCause('DatabaseNotReachable')), 'connection', 'error'],
    ['ECONNRESET (Known P1017)', knownWithAdapterCause('P1017', socketCause('ConnectionClosed')), 'connection', 'error'],
    ['ETIMEDOUT (Known P1008)', knownWithAdapterCause('P1008', socketCause('SocketTimeout')), 'connection', 'error'],
    ['pg-pool connect timeout', pgConnectTimeout(), 'connection', 'error'],
  ])('classifies %s', (_label, error, kind, level) => {
    expect(transientDbFailure(error)).toEqual({ kind, level });
    expect(isTransientDbError(error)).toBe(true);
    // Only a lost connection leaves the outcome unknown, so only it is coded for a client to tell apart.
    expect(classifyApiError(error).code).toBe(kind === 'connection' ? 'DATABASE_CONNECTION_FAILED' : undefined);
  });

  it('classifies pg-pool\'s wait timeout as pool_exhausted at error', () => {
    expect(transientDbFailure(pgPoolTimeout())).toEqual({ kind: 'pool_exhausted', level: 'error' });
    expect(classifyApiError(pgPoolTimeout())).toMatchObject({ status: 503, detail: { transientKind: 'pool_exhausted' } });
  });

  it('finds a pool timeout one cause deep', () => {
    expect(transientDbFailure(new Error('wrapped', { cause: pgPoolTimeout() }))?.kind).toBe('pool_exhausted');
  });

  it('finds a connection failure one cause deep', () => {
    expect(transientDbFailure(new Error('wrapped', { cause: pgConnectTimeout() }))?.kind).toBe('connection');
  });

  it('answers a connection failure with the connection 503 copy at error', () => {
    expect(classifyApiError(knownWithAdapterCause('P2010', socketCause('DatabaseNotReachable')))).toEqual({
      status: 503,
      message: 'Something on our side was briefly unavailable, so that may not have gone through. Please try again in a moment.',
      logMessage: 'transient database failure surfaced to a client',
      level: 'error',
      detail: { transientKind: 'connection' },
      code: 'DATABASE_CONNECTION_FAILED',
    });
  });

  /** One fixture per kind but `connection`; a new `TransientKind` member is a compile error here until it has one. */
  const NON_CONNECTION_FIXTURES = {
    lock_timeout: typedPg('55P03', LOCK_TIMEOUT_MESSAGE),
    deadlock: typedPg('40P01', 'deadlock detected'),
    serialization: rawPg('40001', 'could not serialize access due to concurrent update'),
    pool_exhausted: pgPoolTimeout(),
    tx_budget: prismaError('P2028'),
  } satisfies Record<Exclude<TransientKind, 'connection'>, unknown>;

  it.each(Object.entries(NON_CONNECTION_FIXTURES))('keeps the busy copy for %s', (kind, error) => {
    expect(transientDbFailure(error)?.kind).toBe(kind);
    expect(classifyApiError(error).message).toBe('The system was busy and could not finish that. Please try again.');
  });

  /**
   * Every adapter kind outside `TRANSIENT_ADAPTER_KIND`, carrying no SQLSTATE,
   * is not transient: no adapter kind reaches `connection` except through that
   * map. `TransactionWriteConflict` is left out because its transient reading
   * comes from the SQLSTATE it always carries in practice, not its kind.
   */
  it.each(ADAPTER_KINDS.filter((kind) => !TRANSIENT_ADAPTER_KIND.has(kind) && kind !== 'TransactionWriteConflict'))(
    'does not classify the adapter kind %s with no SQLSTATE as transient',
    (kind) => {
      const error = knownWithAdapterCause('P2010', { kind });
      expect(transientDbFailure(error)).toBeNull();
      expect(classifyApiError(error).status).toBe(500);
    },
  );

  it('pins TRANSIENT_ADAPTER_KIND to exactly these adapter kinds', () => {
    expect([...TRANSIENT_ADAPTER_KIND.keys()].sort()).toEqual([
      'ConnectionClosed',
      'DatabaseNotReachable',
      'SocketTimeout',
      'TooManyConnections',
    ]);
  });

  it('answers a bare Connection terminated unexpectedly as connection, at error', () => {
    const error = pgConnectionTerminated();
    expect(transientDbFailure(error)).toEqual({ kind: 'connection', level: 'error' });
    expect(classifyApiError(error)).toMatchObject({ status: 503, level: 'error', detail: { transientKind: 'connection' } });
  });

  it('classifies the connect timeout once, as connection, though its cause is the bare termination', () => {
    const error = pgConnectTimeout();
    expect(isPgConnectionTerminated(error.cause)).toBe(true);
    expect(transientDbFailure(error)).toEqual({ kind: 'connection', level: 'error' });
  });

  it('does not treat an adapter kind outside the connection set as transient', () => {
    // An access-denied database is a configuration fault, which a retry cannot win.
    expect(classifyApiError(knownWithAdapterCause('P1010', { kind: 'DatabaseAccessDenied', db: 'x' })).status).toBe(500);
  });

  it('finds the kind through a cause chain', () => {
    const wrapped = new Error('spot-freed hook failed', { cause: typedPg('40P01', 'deadlock detected') });
    expect(transientDbFailure(wrapped)).toEqual({ kind: 'deadlock', level: 'error' });
  });

  it.each<[string, unknown]>([
    ['a bare digit string', new Error('postcode 40P01 and 55P03 Lock Street')],
    ['an engine-framed SQLSTATE in a message', new Error('ConnectorError { kind: QueryError(PostgresError { code: "55P03" }) }')],
    ['a non-transient SQLSTATE (57014)', typedPg('57014', 'canceling statement due to statement timeout')],
    ['a non-transient Prisma code', prismaError('P2002')],
    ['a P2024, which the adapter never raises', prismaError('P2024')],
    ['a non-error', pgCause('55P03', LOCK_TIMEOUT_MESSAGE)],
  ])('returns null for %s', (_label, error) => {
    expect(transientDbFailure(error)).toBeNull();
    expect(isTransientDbError(error)).toBe(false);
  });
});

describe('isLockTimeout', () => {
  it('matches a model write\'s typed 55P03 (Known P2039)', () => {
    expect(isLockTimeout(typedPg('55P03', LOCK_TIMEOUT_MESSAGE))).toBe(true);
  });

  it('matches a raw FOR UPDATE\'s 55P03 (Known P2010)', () => {
    expect(isLockTimeout(rawPg('55P03', LOCK_TIMEOUT_MESSAGE))).toBe(true);
  });

  it.each<[string, Error]>([
    ['a deadlock (40P01)', typedPg('40P01', 'deadlock detected')],
    ['a serialization failure (40001)', rawPg('40001', 'could not serialize access due to concurrent update')],
    ['transaction budget expired (P2028)', prismaError('P2028')],
    ['connection pool timeout', pgPoolTimeout()],
    ['serialization failure (P2034)', knownWithAdapterCause('P2034', pgCause('40001', 'could not serialize access due to concurrent update'))],
    ['record not found (P2025)', prismaError('P2025')],
    ['generic Error', new Error(LOCK_TIMEOUT_MESSAGE)],
  ])('does not match %s', (_label, err) => {
    expect(isLockTimeout(err)).toBe(false);
  });

  it('does not match an unrelated error that merely contains 55P03 as a substring', () => {
    const substringError = new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed: postcode "55P03" already exists',
      { code: 'P2002', clientVersion: 'test' },
    );
    expect(isLockTimeout(substringError)).toBe(false);
  });

  it('matches a lock timeout carried as the cause of a wrapper error', () => {
    expect(isLockTimeout(new Error('wrapped', { cause: typedPg('55P03', LOCK_TIMEOUT_MESSAGE) }))).toBe(true);
  });

  it('reads no message: a P2028 quoting a 55P03 framing is tx_budget, as transientDbFailure says', () => {
    // One matcher means one answer, and neither reads an error's text.
    const budget = new Prisma.PrismaClientKnownRequestError(
      'Transaction already closed: ... PostgresError { code: "55P03" }',
      { code: 'P2028', clientVersion: 'test' },
    );
    expect(transientDbFailure(budget)?.kind).toBe('tx_budget');
    expect(isLockTimeout(budget)).toBe(false);
  });

  it.each<[string, unknown]>([
    ['undefined', undefined],
    ['null', null],
    ['a string', '55P03'],
    ['a plain object', { name: 'DriverAdapterError', cause: pgCause('55P03', LOCK_TIMEOUT_MESSAGE) }],
  ])('returns false for non-Error value %s', (_label, val) => {
    expect(isLockTimeout(val)).toBe(false);
  });
});

