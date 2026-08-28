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

  // `''.includes('')` is true, so an empty name would erase the name half and
  // leave "is this a 23514" — which every case above exists to refuse. The
  // sibling `isRestrictViolationOn` is immune for free (`[].includes` is
  // false); a string matcher has to say it.
  it('does not match an empty constraint name, which would match every 23514', () => {
    expect(isCheckViolationOn(typedCall, '')).toBe(false);
    expect(isCheckViolationOn(rawQuery, '')).toBe(false);
  });

  // `err.message` carries more than Postgres's classification: Prisma quotes
  // the calling file's source lines around the failing statement, and
  // `Failing row contains (…)` carries `ClassTemplate.description`, which a
  // teacher types. Neither is Postgres saying which constraint refused the
  // row, so neither may decide the answer.
  it('does not match the name echoed by a source line or a failing-row dump', () => {
    const sourceEcho = new Prisma.PrismaClientUnknownRequestError(
      'Invalid `prisma.classTemplate.update()` invocation in\n/app/src/services/x.ts:12:9\n'
      + `  11   // guarded by ${NAME}\n`
      + '→ 12   await tx.classTemplate.update(\n'
      + 'PostgresError { code: "23514", message: "new row for relation \\"Student\\" violates '
      + 'check constraint \\"Student_income_tier_check\\"" }',
      { clientVersion: '6.19.3' },
    );
    expect(isCheckViolationOn(sourceEcho, NAME)).toBe(false);

    const teacherText = new Prisma.PrismaClientUnknownRequestError(
      'PostgresError { code: "23514", message: "new row for relation \\"Student\\" violates '
      + 'check constraint \\"Student_income_tier_check\\"", '
      + `detail: Some("Failing row contains (abc, ${NAME}, 30.00)") }`,
      { clientVersion: '6.19.3' },
    );
    expect(isCheckViolationOn(teacherText, NAME)).toBe(false);
  });
});