import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { classifyApiError, isTransientDbError } from './api-errors';

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

/**
 * Built from the real message `src/services/class-terminal-status.test.ts`
 * observed for an actual trigger fire, not a hand-written approximation —
 * `PrismaClientUnknownRequestError` carries no `code`/`meta`, so the
 * SQLSTATE and the trigger's own wording only exist inside this string.
 * (That file lived under `tests/integration/` when this comment was first
 * written; #174 moved it into the `unit` project, which is the one forced
 * onto the isolated test database.)
 */
const terminalStatusErrorFixture = new Prisma.PrismaClientUnknownRequestError(
  `Invalid \`prisma.class.update()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "Class 824c3362-c21f-466e-a741-7301d469730f is cancelled, which is terminal; cannot change status to open", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: 'test' },
);

/**
 * The SECOND trigger to reach the same branch (#247,
 * `20260817120000_class_terminal_date_trigger`). Transcribed from a real fire
 * observed through `db.class.updateMany` in `src/services/class-lifecycle.ts`,
 * not hand-written: same SQLSTATE, same `which is terminal` clause, different
 * tail.
 *
 * It exists because the 409 mapping is now SHARED, and a shared mapping pinned
 * by only the fixture that happened to come first is pinned for one caller and
 * assumed for the other. Anyone narrowing the matcher back to status-only
 * wording — the obvious "fix" once `which is terminal` stops being unique to
 * one migration — turns date violations into 500s, and this is the test that
 * refuses to let that happen quietly.
 */
const terminalDateErrorFixture = new Prisma.PrismaClientUnknownRequestError(
  `Invalid \`prisma.class.updateMany()\` invocation:\n\n\nError occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23514", message: "Class 30cb2d25-dd22-4bd3-8baf-e99f4f9c8219 is completed, which is terminal; cannot change its date from 2026-06-01 to 2020-01-01", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
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

  it.each([
    ['status', terminalStatusErrorFixture],
    ['date', terminalDateErrorFixture],
  ] as const)('maps the terminal-%s trigger to a 409, not a 500', (_column, fixture) => {
    const failure = classifyApiError(fixture);

    expect(failure.status).toBe(409);
    expect(failure.level).toBe('warn');
    expect(failure.message).toBe('That class can no longer be changed');
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
  it('does not name a single column in the message shared by both terminality triggers', () => {
    const message = classifyApiError(terminalDateErrorFixture).message;

    expect(message).not.toMatch(/\bstatus\b/i);
    expect(message).not.toMatch(/\bdate\b/i);
    expect(classifyApiError(terminalStatusErrorFixture).message).toBe(message);
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
   * `Class_teacher_slot_unique` measures against real `updateClass` writes
   * (`docs/lock-order.md`, "The slot key is a wait edge") — on the premise
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
