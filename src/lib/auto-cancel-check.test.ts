import { describe, it, expect } from 'vitest';
import { hhmmToTime } from '@/lib/time-of-day';
import { cancelCheckInstant, isPastCancelCheck } from './auto-cancel-check';

const entry = { date: new Date('2026-07-20T00:00:00Z'), startTime: hhmmToTime('18:00') };

describe('cancelCheckInstant', () => {
  it('counts back from the start in the teacher\'s timezone', () => {
    // 18:00 Amsterdam (CEST, UTC+2) is 16:00Z; HOURS_2 puts the check at 14:00Z.
    expect(cancelCheckInstant(entry, 'HOURS_2', 'Europe/Amsterdam').toISOString())
      .toBe('2026-07-20T14:00:00.000Z');
  });
});

describe('isPastCancelCheck', () => {
  it('is false a minute before the check time', () => {
    expect(isPastCancelCheck(entry, 'HOURS_2', 'Europe/Amsterdam', new Date('2026-07-20T13:59:00Z'))).toBe(false);
  });
  it('is true at the check time', () => {
    expect(isPastCancelCheck(entry, 'HOURS_2', 'Europe/Amsterdam', new Date('2026-07-20T14:00:00Z'))).toBe(true);
  });
  it('stays true after the start', () => {
    expect(isPastCancelCheck(entry, 'HOURS_2', 'Europe/Amsterdam', new Date('2026-07-20T17:00:00Z'))).toBe(true);
  });
});
