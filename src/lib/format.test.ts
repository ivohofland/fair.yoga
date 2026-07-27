import { describe, it, expect } from 'vitest';
import { formatDayHeader } from './format';

/**
 * `formatDayHeader` had no tests while it was a private copy inside one
 * component. #86 promoted it to `src/lib/format.ts` and pointed five files
 * at it — the schedule list, the student bookings page, both public booking
 * pages, and the settings confirmation copy — so a change here now moves text
 * on the teacher's schedule, a student's bookings, and a public booking page
 * at once. That blast radius is what earns it a test.
 */
describe('formatDayHeader', () => {
  it('renders weekday, abbreviated month, and day-of-month', () => {
    expect(formatDayHeader(new Date('2026-06-12T00:00:00.000Z'))).toBe('Friday, Jun 12');
  });

  it('does not pad the day-of-month', () => {
    // "Jan 1", not "Jan 01" — the schedule reads as prose, not a timestamp.
    expect(formatDayHeader(new Date('2026-01-01T00:00:00.000Z'))).toBe('Thursday, Jan 1');
  });

  it('handles the year boundary', () => {
    expect(formatDayHeader(new Date('2026-12-31T00:00:00.000Z'))).toBe('Thursday, Dec 31');
  });

  /**
   * The reason every accessor in this function is `getUTC*`, and the case that
   * would break silently if someone "simplified" them to local-time accessors.
   *
   * `Class.date` is a `@db.Date` column, so Prisma hands back midnight UTC and
   * the time of day lives separately in `startTime`. Read in local time, a
   * midnight-UTC date renders as the *previous* day for anyone west of UTC —
   * a class on the 12th would show as the 11th on a student's bookings page.
   *
   * This test runs in whatever zone the machine is in (Europe/Amsterdam
   * locally, UTC in CI), so it cannot prove the west-of-UTC case on its own.
   * The late-evening instant below is the portable proxy: at 23:30 UTC the
   * local date has already rolled over east of UTC, so a local-time
   * implementation would disagree here.
   */
  it('reads the date in UTC, not the local zone', () => {
    expect(formatDayHeader(new Date('2026-06-12T23:30:00.000Z'))).toBe('Friday, Jun 12');
  });

  it('accepts a Date-like value without mutating the caller’s Date', () => {
    const original = new Date('2026-06-12T00:00:00.000Z');
    const snapshot = original.getTime();

    formatDayHeader(original);

    expect(original.getTime()).toBe(snapshot);
  });
});
