import { describe, it, expect } from 'vitest';
import { cancelDeadlineHint, autoCancelHint } from './class-options';

describe('cancelDeadlineHint', () => {
  it('says students cancel free until the deadline and are charged after', () => {
    const hint = cancelDeadlineHint('HOURS_24');
    expect(hint).toContain('24 hours before');
    expect(hint).toMatch(/free/i);
    expect(hint).toMatch(/charged/i);
  });
});

describe('autoCancelHint', () => {
  it('names the check time and the minimum from step 2', () => {
    const hint = autoCancelHint('HOURS_2', 4);
    expect(hint).toContain('2 hours before');
    expect(hint).toContain('fewer than 4 students');
    expect(hint).toMatch(/cancelled/i);
  });

  it('says late cancellations count, because they still pay', () => {
    expect(autoCancelHint('HOURS_2', 4)).toMatch(
      / Late cancellations count, because they still pay\.$/,
    );
  });

  it('uses the singular for a minimum of one', () => {
    expect(autoCancelHint('HOURS_1', 1)).toContain('nobody has registered');
  });

  it('falls back to the generic wording for an unusable minimum', () => {
    expect(autoCancelHint('HOURS_4', Number.NaN)).toContain('minimum number of students');
    expect(autoCancelHint('HOURS_4', 0)).toContain('minimum number of students');
  });
});
