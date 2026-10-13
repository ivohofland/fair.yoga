import { describe, it, expect } from 'vitest';
import { timeToHHmm, hhmmToTime, startTimeStep, START_TIME_STEP_SECONDS } from './time-of-day';

describe('hhmmToTime / timeToHHmm', () => {
  it('round-trips an ordinary time', () => {
    expect(timeToHHmm(hhmmToTime('09:30'))).toBe('09:30');
  });

  it('round-trips midnight', () => {
    expect(timeToHHmm(hhmmToTime('00:00'))).toBe('00:00');
  });

  it('round-trips the last minute of the day', () => {
    expect(timeToHHmm(hhmmToTime('23:59'))).toBe('23:59');
  });

  it('reads UTC accessors, not local ones — the pinned zone is America/New_York (vitest.config.ts)', () => {
    // `hhmmToTime('09:30')` parses as UTC (the trailing `Z`), so a local
    // accessor would shift it by the pinned zone's offset. `09:30` survives
    // only if `timeToHHmm` reads `getUTCHours`/`getUTCMinutes`.
    expect(timeToHHmm(hhmmToTime('09:30'))).toBe('09:30');
  });

  // `class-generator.test.ts`'s "names the template when an unreadable
  // startTime empties the window" test depends on this exact string: it
  // seeds a `ScheduleRule.startTime` of `new Date(NaN)` and asserts the
  // guard log line carries `startTime: 'NaN:NaN'`. A `@db.Time` column can
  // never hold NaN itself, but `generateInstancesForTemplate`'s guard reads
  // a template row through `timeToHHmm` before validating it, so this is a
  // live dependant, not a hypothetical one.
  it('renders an invalid Date as "NaN:NaN"', () => {
    expect(timeToHHmm(new Date(NaN))).toBe('NaN:NaN');
  });
});

describe('startTimeStep', () => {
  it('steps a new start time by five minutes', () => {
    expect(startTimeStep()).toBe(START_TIME_STEP_SECONDS);
    expect(START_TIME_STEP_SECONDS).toBe(300);
  });

  it('keeps the five-minute step for a saved time on the grid', () => {
    expect(startTimeStep('18:45')).toBe(START_TIME_STEP_SECONDS);
    expect(startTimeStep('00:00')).toBe(START_TIME_STEP_SECONDS);
  });

  it('falls back to one minute for a saved time off the grid, so it still saves unchanged', () => {
    expect(startTimeStep('18:37')).toBe(60);
    expect(startTimeStep('23:59')).toBe(60);
  });
});
