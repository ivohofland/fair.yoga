import { describe, it, expect } from 'vitest';
import { Prisma } from '@prisma/client';
import { isCrossFamilySlotConflict } from './cross-family-conflict';

/**
 * Every message below is real — either copied from the probe run
 * `isCrossFamilySlotConflict`'s docblock records, or, where no probe was
 * captured for that specific trigger, the literal `RAISE EXCEPTION` text from
 * the migration that defines it. Never a hand-written approximation. That
 * matters here more than usual: this matcher reads a substring of a message
 * Prisma composes, so a fixture that merely looks plausible would pin the
 * matcher to a framing the database never emits.
 */

/** The shape a typed model call produces: no Prisma code of its own. */
function modelCallError(tail: string): Error {
  return new Error(
    'Invalid `prisma.studioClass.create()` invocation in\n' +
      '/app/src/app/api/studio-classes/route.ts:39:38\n\n' +
      'Error occurred during query execution:\n' +
      'ConnectorError(ConnectorError { user_facing_error: None, kind: ' +
      `QueryError(PostgresError { code: "YG001", message: "${tail}", ` +
      'severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
  );
}

describe('isCrossFamilySlotConflict', () => {
  it('matches the typed-model-call framing a route actually sees', () => {
    const err = modelCallError(
      'Teacher 00a3eaac-747f-4616-a0c7-656daf7aa136 already has a live class ' +
        '(405456f4-d277-43af-b016-79ea4d849ba8) at 2029-04-03 09:00',
    );
    expect(isCrossFamilySlotConflict(err)).toBe(true);
  });

  it('matches the raw-query framing, which spells the SQLSTATE differently', () => {
    // `P2010`, the shape `$executeRaw` produces. Measured, not assumed: the
    // precedent this matcher follows (`isTerminalStatusViolation`,
    // `api-errors.ts`) records an earlier revision that admitted only the
    // typed shape and argued the raw one was unreachable — a census nothing
    // could keep honest.
    const err = new Prisma.PrismaClientKnownRequestError(
      'Invalid `prisma.$executeRaw()` invocation:\n\n\n' +
        'Raw query failed. Code: `YG001`. Message: `ERROR: Teacher ' +
        '7ac5306e-249f-4f45-aead-f7aeeedb4599 already has a live class ' +
        '(c813abfd-15a6-4a98-9c5d-0f224febdadf) at 2029-06-06 09:00`',
      { code: 'P2010', clientVersion: 'test' },
    );
    expect(isCrossFamilySlotConflict(err)).toBe(true);
  });

  it('matches the Class-side message, worded differently from the StudioClass-side one above', () => {
    // The surviving triggers word their message from whichever side fired:
    // `studio_class_reject_cross_family_slot()` (above) says "a live class";
    // `class_reject_cross_family_slot()` — the one this case exercises —
    // says "a live studio class"
    // (`20260821120000_cross_family_slot_guard/migration.sql`). Nothing here
    // may depend on the tail — the SQLSTATE is the whole discriminator. The
    // roster of what still emits `YG001` is `docs/lock-order.md`'s to keep,
    // not a count in this comment.
    const err = modelCallError(
      'Teacher 00a3eaac-747f-4616-a0c7-656daf7aa136 already has a live studio ' +
        'class (17c40177-a4bd-4a63-8901-9cec56427bb6) at 2029-04-03 09:00',
    );
    expect(isCrossFamilySlotConflict(err)).toBe(true);
  });

  it('does NOT match 23514, which the terminal-status and date triggers own', () => {
    const err = new Error(
      'Invalid `prisma.class.update()` invocation\n' +
        'Error occurred during query execution:\n' +
        'ConnectorError(ConnectorError { user_facing_error: None, kind: ' +
        'QueryError(PostgresError { code: "23514", message: "Class abc is ' +
        'completed, which is terminal; cannot change its date from x to y", ' +
        'severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
    );
    expect(isCrossFamilySlotConflict(err)).toBe(false);
  });

  it('does not match an ordinary P2002 on the same slot columns', () => {
    // The within-family partial index. `isUniqueConflictOn` owns this one, and
    // a route consults both matchers in the same catch.
    const err = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['teacherId', 'date', 'startTime'] },
    });
    expect(isCrossFamilySlotConflict(err)).toBe(false);
  });

  it('does not match a bare YG001 outside its Postgres framing', () => {
    // The trap `isTransientDbError` documents: a bare substring match would
    // fire on any message that merely mentions the code.
    expect(isCrossFamilySlotConflict(new Error('YG001'))).toBe(false);
    expect(isCrossFamilySlotConflict(new Error('slot conflict YG001 raised'))).toBe(false);
  });

  it('does not match a non-error', () => {
    expect(isCrossFamilySlotConflict('YG001')).toBe(false);
    expect(isCrossFamilySlotConflict(null)).toBe(false);
    expect(isCrossFamilySlotConflict(undefined)).toBe(false);
  });
});
