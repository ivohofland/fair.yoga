import { describe, it, expect } from 'vitest';
import { isExclusionConflictOn } from './exclusion-conflict';
import { driverAdapterError, knownWithAdapterCause, pgCause } from '../../tests/adapter-errors';

const violation = (constraint: string): string =>
  `conflicting key value violates exclusion constraint "${constraint}"`;

/** A typed model call: a DriverAdapterError carrying the adapter's cause. */
const raise = (constraint: string) => driverAdapterError(pgCause('23P01', violation(constraint)));

describe('isExclusionConflictOn', () => {
  it('matches the named constraint', () => {
    expect(isExclusionConflictOn(raise('ScheduleRule_teacher_slot_excl'), 'ScheduleRule_teacher_slot_excl')).toBe(true);
  });

  it('matches the raw-query shape, a P2010 carrying the same cause', () => {
    const err = knownWithAdapterCause('P2010', pgCause('23P01', violation('ScheduleRule_teacher_slot_excl')));
    expect(isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')).toBe(true);
  });

  it('does not match a different constraint', () => {
    expect(isExclusionConflictOn(raise('SomeOther_excl'), 'ScheduleRule_teacher_slot_excl')).toBe(false);
  });

  it('does not match the clause under another SQLSTATE', () => {
    const err = driverAdapterError(pgCause('23514', violation('ScheduleRule_teacher_slot_excl')));
    expect(isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')).toBe(false);
  });

  it('does not match a unique violation', () => {
    const p2002 = knownWithAdapterCause(
      'P2002',
      pgCause('23505', 'duplicate key value violates unique constraint "ScheduleRule_teacher_slot_excl"'),
    );
    expect(isExclusionConflictOn(p2002, 'ScheduleRule_teacher_slot_excl')).toBe(false);
  });

  it('does not match a plain string that happens to quote the constraint', () => {
    expect(isExclusionConflictOn(
      violation('ScheduleRule_teacher_slot_excl'),
      'ScheduleRule_teacher_slot_excl',
    )).toBe(false);
  });
});
