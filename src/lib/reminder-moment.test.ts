import { describe, it, expect } from 'vitest';
import { reminderMoment } from './reminder-moment';
import { hhmmToTime } from './time-of-day';

const AMS = 'Europe/Amsterdam';
const entry = (date: string, hhmm: string) => ({ date: new Date(`${date}T00:00:00Z`), startTime: hhmmToTime(hhmm) });

describe('reminderMoment', () => {
  it('evening before is 19:00 local on the previous day', () => {
    // 2026-06-10 is CEST (UTC+2): 19:00 local on the 9th = 17:00Z.
    expect(reminderMoment(entry('2026-06-10', '18:00'), AMS, 'evening_before')?.toISOString()).toBe('2026-06-09T17:00:00.000Z');
  });
  it('morning of is 07:00 local on the class day', () => {
    expect(reminderMoment(entry('2026-06-10', '18:00'), AMS, 'morning_of')?.toISOString()).toBe('2026-06-10T05:00:00.000Z');
  });
  it('one hour before is start - 60 minutes', () => {
    expect(reminderMoment(entry('2026-06-10', '18:00'), AMS, 'one_hour_before')?.toISOString()).toBe('2026-06-10T15:00:00.000Z');
  });
  it('caps an early class\'s morning reminder at start - 60 minutes', () => {
    // 06:30 local start → 05:30 local = 03:30Z, not 07:00 local.
    expect(reminderMoment(entry('2026-06-10', '06:30'), AMS, 'morning_of')?.toISOString()).toBe('2026-06-10T03:30:00.000Z');
  });
  it('returns null when reminders are off', () => {
    expect(reminderMoment(entry('2026-06-10', '18:00'), AMS, 'off')).toBeNull();
  });
  it('keeps 19:00 and 07:00 local on the spring-forward day (2026-03-29)', () => {
    // The 28th is CET (UTC+1); the 29th from 03:00 is CEST (UTC+2).
    expect(reminderMoment(entry('2026-03-29', '18:00'), AMS, 'evening_before')?.toISOString()).toBe('2026-03-28T18:00:00.000Z');
    expect(reminderMoment(entry('2026-03-29', '18:00'), AMS, 'morning_of')?.toISOString()).toBe('2026-03-29T05:00:00.000Z');
  });
  it('keeps 19:00 and 07:00 local on the fall-back day (2026-10-25)', () => {
    // The 24th is CEST (UTC+2); the 25th from 03:00 is CET (UTC+1).
    expect(reminderMoment(entry('2026-10-25', '18:00'), AMS, 'evening_before')?.toISOString()).toBe('2026-10-24T17:00:00.000Z');
    expect(reminderMoment(entry('2026-10-25', '18:00'), AMS, 'morning_of')?.toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });
});
