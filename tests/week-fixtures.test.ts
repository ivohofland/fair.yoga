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

  // Whatever the zone and the half-hour, the date is a Tuesday and falls
  // between two and eight days after the teacher's own today — a Tuesday
  // read off the UTC clock lands one day out for the hours the two disagree.
  it.each([AMSTERDAM, 'America/Los_Angeles', 'Pacific/Auckland'])(
    'is a Tuesday two to eight local days ahead, at every half hour in %s',
    (zone) => {
      const start = Date.parse('2026-10-22T00:00:00Z');
      for (let t = start; t < start + 14 * DAY_MS; t += DAY_MS / 48) {
        const now = new Date(t);
        const result = tuesdayOfNextLocalWeek(now, zone);
        const daysAhead = (result.getTime() - startOfLocalDay(now, zone).getTime()) / DAY_MS;
        expect(result.getUTCDay(), `${now.toISOString()} in ${zone}`).toBe(2);
        expect(daysAhead, `${now.toISOString()} in ${zone}`).toBeGreaterThanOrEqual(2);
        expect(daysAhead, `${now.toISOString()} in ${zone}`).toBeLessThanOrEqual(8);
      }
    },
  );
});
