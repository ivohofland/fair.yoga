import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { classifyApiError } from './api-errors';

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
 * Built from the real message `tests/integration/class-terminal-status.test.ts`
 * observed for an actual trigger fire, not a hand-written approximation —
 * `PrismaClientUnknownRequestError` carries no `code`/`meta`, so the
 * SQLSTATE and the trigger's own wording only exist inside this string.
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
