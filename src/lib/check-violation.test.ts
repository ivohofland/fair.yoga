import { describe, it, expect } from 'vitest';
import { isCheckViolationOn } from './check-violation';
import { driverAdapterError, knownWithAdapterCause, pgCause } from '../../tests/adapter-errors';

const NAME = 'ClassTemplate_live_needs_open_room';
const violation = (name: string): string =>
  `new row for relation "ClassTemplate" violates check constraint "${name}"`;

/** A typed model call: a DriverAdapterError carrying the adapter's cause. */
const typedCall = driverAdapterError(pgCause('23514', violation(NAME)));

/** A raw query: Prisma's `P2010`, with the same cause under `meta.driverAdapterError`. */
const rawQuery = knownWithAdapterCause('P2010', pgCause('23514', violation(NAME)));

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
    const terminal = driverAdapterError(
      pgCause('23514', 'Class abc is completed, which is terminal; cannot change status to open'),
    );
    expect(isCheckViolationOn(terminal, NAME)).toBe(false);
  });

  it('does not match the clause under another SQLSTATE', () => {
    expect(isCheckViolationOn(driverAdapterError(pgCause('23505', violation(NAME))), NAME)).toBe(false);
  });

  it('does not match a message that merely quotes the name without the SQLSTATE', () => {
    const noCode = new Error(`something mentioning ${violation(NAME)} but no sqlstate`);
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

  // The cause carries more than Postgres's primary message: `detail` holds
  // `Failing row contains (…)`, and for this table that includes
  // `ClassTemplate.description`, which a teacher types. Only the primary
  // message says which constraint refused the row.
  it('does not match the name echoed by the failing-row detail', () => {
    const teacherText = driverAdapterError(
      pgCause('23514', violation('Student_income_tier_check'), {
        detail: `Failing row contains (abc, ${violation(NAME)}, 30.00).`,
      }),
    );
    expect(isCheckViolationOn(teacherText, NAME)).toBe(false);
  });
});
