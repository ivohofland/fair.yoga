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

  it('maps the terminal-status trigger to a 409, not a 500', () => {
    const failure = classifyApiError(terminalStatusErrorFixture);

    expect(failure.status).toBe(409);
    expect(failure.level).toBe('warn');
    expect(failure.message).toBe('That class can no longer change status');
  });

  /**
   * `23514` (check_violation) is not unique to the trigger — every plain
   * `CHECK` constraint in this schema defaults to the same SQLSTATE with no
   * `USING ERRCODE` override (`Student_income_tier_check`, for one). A
   * classifier that matched on the code alone would relabel any of those as
   * "that class can no longer change status." This fixture has the same
   * code and the same error class, and deliberately not the trigger's own
   * wording, so it pins that the message text — not just the SQLSTATE — is
   * what discriminates.
   */
  it('does not classify an unrelated check_violation as the terminal-status trigger', () => {
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
