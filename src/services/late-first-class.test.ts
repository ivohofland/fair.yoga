import { describe, it, expect } from 'vitest';
import { classStartInstant } from '@/lib/timezone';
import { hhmmToTime } from '@/lib/time-of-day';
import { lateFirstClass } from './late-first-class';

const HOUR = 60 * 60 * 1000;
const timeZone = 'Europe/Amsterdam';
const entry = { date: new Date('2026-11-10T00:00:00Z'), startTime: hhmmToTime('18:00') };
const start = classStartInstant(entry, timeZone);
const template = { cancelDeadline: 'HOURS_24', autoCancelCheck: 'HOURS_2', minStudents: 3 } as const;
const at = (offsetMs: number) =>
  lateFirstClass({ template, entry, timeZone, at: new Date(start.getTime() + offsetMs) });

describe('lateFirstClass', () => {
  it('is null at exactly the deadline', () => {
    expect(at(-24 * HOUR)).toBeNull();
  });

  it('reads past_deadline 1 ms past the deadline', () => {
    expect(at(-24 * HOUR + 1)).toEqual({ date: '2026-11-10', state: 'past_deadline', minStudents: 3 });
  });

  it('reads past_deadline until the check, past_check from it', () => {
    expect(at(-2 * HOUR - 1)?.state).toBe('past_deadline');
    expect(at(-2 * HOUR)?.state).toBe('past_check');
  });

  it('reads past_check at the start and null once it has started', () => {
    expect(at(0)?.state).toBe('past_check');
    expect(at(1)).toBeNull();
  });

  it('is null well before the deadline', () => {
    expect(at(-30 * 24 * HOUR)).toBeNull();
  });
});
