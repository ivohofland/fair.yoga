import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isExclusionConflictOn } from './exclusion-conflict';

// The measured shape of a 23P01 through Prisma Client: `code` and `meta` are
// both undefined, and the SQLSTATE and constraint name survive only in
// `message`. Captured from a real violation, not composed by hand.
const raise = (constraint: string) =>
  new Prisma.PrismaClientUnknownRequestError(
    'Invalid `db.scheduleRule.create()` invocation\n\nError occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError ' +
      `{ code: "23P01", message: "conflicting key value violates exclusion constraint \\"${constraint}\\"", ` +
      'severity: "ERROR", detail: Some("Key ..."), column: None, hint: None }), transient: false })',
    { clientVersion: 'test' },
  );

describe('isExclusionConflictOn', () => {
  it('matches the named constraint', () => {
    expect(isExclusionConflictOn(raise('ScheduleRule_teacher_slot_excl'), 'ScheduleRule_teacher_slot_excl')).toBe(true);
  });

  it('matches the raw-query shape, which spells the SQLSTATE differently', () => {
    // `P2010`, the shape `$executeRaw` produces. Nothing in `src/` writes
    // `ScheduleRule` raw today, so this shape is unreachable as the code
    // stands; matched anyway — see `exclusion-conflict.ts`'s own docblock on
    // why "unreachable" is not an argument for dropping a shape.
    const err = new Prisma.PrismaClientKnownRequestError(
      'Invalid `prisma.$executeRaw()` invocation:\n\n\n' +
        'Raw query failed. Code: `23P01`. Message: `ERROR: conflicting key value ' +
        'violates exclusion constraint "ScheduleRule_teacher_slot_excl"`',
      { code: 'P2010', clientVersion: 'test' },
    );
    expect(isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')).toBe(true);
  });

  it('does not match a different constraint', () => {
    expect(isExclusionConflictOn(raise('SomeOther_excl'), 'ScheduleRule_teacher_slot_excl')).toBe(false);
  });

  it('does not match a unique violation', () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002', clientVersion: 'test', meta: { target: ['teacherId', 'dayOfWeek'] },
    });
    expect(isExclusionConflictOn(p2002, 'ScheduleRule_teacher_slot_excl')).toBe(false);
  });

  it('does not match a plain string that happens to quote the constraint', () => {
    expect(isExclusionConflictOn(
      'conflicting key value violates exclusion constraint "ScheduleRule_teacher_slot_excl"',
      'ScheduleRule_teacher_slot_excl',
    )).toBe(false);
  });
});
