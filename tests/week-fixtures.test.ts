import { describe, it, expect } from 'vitest';
import { startOfLocalDay } from '@/lib/timezone';
import { tuesdayOfNextLocalWeek } from './week-fixtures';

const AMSTERDAM = 'Europe/Amsterdam';
const DAY_MS = 24 * 60 * 60 * 1000;

const isoDate = (d: Date) => d.toISOString().slice(0, 10);

describe('tuesdayOfNextLocalWeek (#920)', () => {
  // Monday 2026-10-26, after the clocks went back: CET is UTC+1, so 00:30
  // there is still Sunday 23:30 in UTC.
  it('names the same Tuesday at Monday 00:30 CET as at Monday midday', () => {
    const justAfterMidnight = new Date('2026-10-25T23:30:00Z');
    const midday = new Date('2026-10-26T11:00:00Z');
    expect(isoDate(tuesdayOfNextLocalWeek(justAfterMidnight, AMSTERDAM))).toBe('2026-11-03');
    expect(isoDate(tuesdayOfNextLocalWeek(midday, AMSTERDAM))).toBe('2026-11-03');
  });

  // Summer, CEST is UTC+2: Monday 00:30 is Sunday 22:30 in UTC.
  it('does the same across the two-hour summer gap', () => {
    const justAfterMidnight = new Date('2026-05-31T22:30:00Z');
    const midday = new Date('2026-06-01T10:00:00Z');
    expect(isoDate(tuesdayOfNextLocalWeek(justAfterMidnight, AMSTERDAM))).toBe('2026-06-09');
    expect(isoDate(tuesdayOfNextLocalWeek(midday, AMSTERDAM))).toBe('2026-06-09');
  });

  // The other side of the boundary: Sunday 23:30 CET is still last week
  // locally, so "next week" is the week starting the next day.
  it('keeps Sunday 23:30 local in the old week', () => {
    expect(isoDate(tuesdayOfNextLocalWeek(new Date('2026-10-25T22:30:00Z'), AMSTERDAM))).toBe('2026-10-27');
  });

  // Now before the clocks go back (Monday 12:00 CEST), the target Tuesday
  // after.
  it('crosses the autumn change: Monday 2026-10-19 names 2026-10-27', () => {
    expect(isoDate(tuesdayOfNextLocalWeek(new Date('2026-10-19T10:00:00Z'), AMSTERDAM))).toBe('2026-10-27');
  });

  // Now before the clocks go forward on 2026-03-29 (Monday 12:00 CET), the
  // target Tuesday after.
  it('crosses the spring change: Monday 2026-03-23 names 2026-03-31', () => {
    expect(isoDate(tuesdayOfNextLocalWeek(new Date('2026-03-23T11:00:00Z'), AMSTERDAM))).toBe('2026-03-31');
  });

  // In each zone below and at every half hour, the date is a Tuesday between
  // two and eight days after the teacher's own today. A Tuesday read off the
  // UTC clock falls outside that range for the hours the two zones disagree
  // about the day. The two windows hold the autumn and the spring change.
  it.each([AMSTERDAM, 'America/Los_Angeles', 'Pacific/Auckland'])(
    'is a Tuesday two to eight local days ahead, at every half hour in %s',
    (zone) => {
      for (const from of ['2026-10-22T00:00:00Z', '2026-03-25T00:00:00Z']) {
        const start = Date.parse(from);
        for (let t = start; t < start + 14 * DAY_MS; t += DAY_MS / 48) {
          const now = new Date(t);
          const result = tuesdayOfNextLocalWeek(now, zone);
          const daysAhead = (result.getTime() - startOfLocalDay(now, zone).getTime()) / DAY_MS;
          expect(result.getUTCDay(), `${now.toISOString()} in ${zone}`).toBe(2);
          expect(daysAhead, `${now.toISOString()} in ${zone}`).toBeGreaterThanOrEqual(2);
          expect(daysAhead, `${now.toISOString()} in ${zone}`).toBeLessThanOrEqual(8);
        }
      }
    },
  );
});
