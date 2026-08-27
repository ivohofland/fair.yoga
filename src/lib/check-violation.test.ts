import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isCheckViolationOn } from './check-violation';

const NAME = 'ClassTemplate_live_needs_open_room';

/** Shape 1: a typed model call. The SQLSTATE survives only in `message`. */
const typedCall = new Prisma.PrismaClientUnknownRequestError(
  'Invalid `prisma.teacherRoom.update()` invocation:\n\n\nError occurred during query execution:\n'
  + 'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { '
  + 'code: "23514", message: "new row for relation \\"ClassTemplate\\" violates check constraint '
  + `\\"${NAME}\\"", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
  { clientVersion: '6.19.3' },
);

/** Shape 2: a raw query. Prisma wraps it as P2010 and spells the code differently. */
const rawQuery = new Prisma.PrismaClientKnownRequestError(
  'Raw query failed. Code: `23514`. Message: `ERROR: new row for relation "ClassTemplate" '
  + `violates check constraint "${NAME}"\``,
  { code: 'P2010', clientVersion: '6.19.3' },
);

describe('isCheckViolationOn', () => {
  it('matches a typed model call', () => {
    expect(isCheckViolationOn(typedCall, NAME)).toBe(true);
  });

  it('matches a raw query', () => {
    expect(isCheckViolationOn(rawQuery, NAME)).toBe(true);
  });

  it('does not match a different constraint carrying the same SQLSTATE', () => {
    expect(isCheckViolationOn(typedCall, 'Student_claim_link_check')).toBe(false);
  });

  it('does not match a terminality trigger, which also raises 23514', () => {
    const terminal = new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "23514", message: "Class abc is completed, which is terminal; '
      + 'cannot change status to open" }',
      { clientVersion: '6.19.3' },
    );
    expect(isCheckViolationOn(terminal, NAME)).toBe(false);
  });

  it('does not match a message that merely quotes the name without the SQLSTATE', () => {
    const noCode = new Error(`something mentioning ${NAME} but no sqlstate`);
    expect(isCheckViolationOn(noCode, NAME)).toBe(false);
  });

  it('does not match a non-error', () => {
    expect(isCheckViolationOn('a string', NAME)).toBe(false);
    expect(isCheckViolationOn(null, NAME)).toBe(false);
  });
});