import { describe, it, expect } from 'vitest';
import { cancelDeadlineHint, autoCancelHint } from './class-options';

const TAIL =
  ' Otherwise it goes ahead, even if someone cancels after that. Late cancellations count, because they still pay.';

describe('cancelDeadlineHint', () => {
  it('says students cancel free until the deadline and still pay their share after', () => {
    expect(cancelDeadlineHint('HOURS_24')).toBe(
      'Students can cancel for free until 24 hours before the class starts. After that, they still pay their share if the class goes ahead.',
    );
  });
});

describe('autoCancelHint', () => {
  it('names the check time and the minimum from step 2', () => {
    expect(autoCancelHint('HOURS_2', 4)).toBe(
      `2 hours before the class starts, we check the registrations once. If fewer than 4 students have registered, the class is cancelled and everyone is notified.${TAIL}`,
    );
  });

  it('uses the singular for a minimum of one', () => {
    expect(autoCancelHint('HOURS_1', 1)).toBe(
      `1 hour before the class starts, we check the registrations once. If nobody has registered, the class is cancelled and everyone is notified.${TAIL}`,
    );
  });

  it('falls back to the generic wording for an unusable minimum', () => {
    const expected = `4 hours before the class starts, we check the registrations once. If they are below the minimum number of students, the class is cancelled and everyone is notified.${TAIL}`;
    expect(autoCancelHint('HOURS_4', Number.NaN)).toBe(expected);
    expect(autoCancelHint('HOURS_4', 0)).toBe(expected);
  });
});
