import { describe, it, expect } from 'vitest';
import { formatDayHeader, formatHistoricalDate } from './format';

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
   * The fixture is a midnight-UTC value because that is the only shape this
   * function is ever handed, and `vitest.config.ts` pins the run to a zone west
   * of UTC so that shape discriminates: read locally, `2026-03-01T00:00Z`
   * renders as Saturday, Feb 28. Month, weekday and day-of-month all move, so a
   * local-time implementation cannot coincidentally agree here.
   *
   * The three cases above are midnight-UTC too and so bite the same way; this
   * one exists to say why, and to fail under a name that names the guarantee.
   */
  it('reads the date in UTC, not the local zone', () => {
    expect(formatDayHeader(new Date('2026-03-01T00:00:00.000Z'))).toBe('Sunday, Mar 1');
  });

  it('accepts a Date-like value without mutating the caller’s Date', () => {
    const original = new Date('2026-06-12T00:00:00.000Z');
    const snapshot = original.getTime();

    formatDayHeader(original);

    expect(original.getTime()).toBe(snapshot);
  });
});

/**
 * #97's archived-template record needed a date that survives indefinitely,
 * where `formatDayHeader`'s missing year would let a date from last year
 * read identically to one from last month. This is that formatter — day,
 * abbreviated month, year, no weekday — and it inherits `formatDayHeader`'s
 * UTC-accessors reasoning, so the same year-boundary and no-mutation cases
 * apply here too.
 */
describe('formatHistoricalDate', () => {
  it('renders day-of-month, abbreviated month, and year', () => {
    expect(formatHistoricalDate(new Date('2026-06-12T00:00:00.000Z'))).toBe('12 Jun 2026');
  });

  it('does not pad the day-of-month', () => {
    expect(formatHistoricalDate(new Date('2026-01-01T00:00:00.000Z'))).toBe('1 Jan 2026');
  });

  it('carries a year from before the current one, not just any year', () => {
    expect(formatHistoricalDate(new Date('2025-12-31T00:00:00.000Z'))).toBe('31 Dec 2025');
  });

  /**
   * Same reasoning as `formatDayHeader`'s equivalent case, and the same shape:
   * this function's one caller hands it `startOfLocalDay` output, which is
   * midnight UTC of the teacher's calendar day. `vitest.config.ts` pins the run
   * west of UTC, where a local read of a midnight-UTC value renders the
   * *previous* day — so reading this in local time (or with
   * `toLocaleDateString`, unqualified) would print 31 Dec 2024, rolling the
   * year as well as the day.
   */
  it('reads the date in UTC, not the local zone', () => {
    expect(formatHistoricalDate(new Date('2025-01-01T00:00:00.000Z'))).toBe('1 Jan 2025');
  });

  it('accepts a Date-like value without mutating the caller’s Date', () => {
    const original = new Date('2026-06-12T00:00:00.000Z');
    const snapshot = original.getTime();

    formatHistoricalDate(original);

    expect(original.getTime()).toBe(snapshot);
  });
});
