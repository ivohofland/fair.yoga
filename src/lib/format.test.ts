import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  formatDayHeader,
  formatDateWithYear,
  formatDateShort,
  formatMonthLabel,
  paymentStateText,
  formatRoomLocation,
  formatStudentName,
  timeAgo,
} from './format';

/**
 * `formatDayHeader` had no tests while it was a private copy inside one
 * component. #86 promoted it to `src/lib/format.ts` and pointed several call
 * sites at it — the schedule list, the schedule home header, the student
 * bookings page, both public booking pages, and the settings confirmation copy
 * — so a change here moves text on the teacher's schedule, a student's
 * bookings, and a public booking page at once. That blast radius is what earns
 * it a test.
 *
 * No literal count here on purpose: #96 added the home header to that list and
 * left the count behind, which is how this sentence came to understate the very
 * blast radius it exists to justify.
 */
describe('formatDayHeader', () => {
  it('renders weekday, abbreviated month, and day-of-month', () => {
    expect(formatDayHeader(new Date('2026-06-12T00:00:00.000Z'))).toBe('Friday, 12 Jun');
  });

  it('does not pad the day-of-month', () => {
    // "Jan 1", not "Jan 01" — the schedule reads as prose, not a timestamp.
    expect(formatDayHeader(new Date('2026-01-01T00:00:00.000Z'))).toBe('Thursday, 1 Jan');
  });

  it('handles the year boundary', () => {
    expect(formatDayHeader(new Date('2026-12-31T00:00:00.000Z'))).toBe('Thursday, 31 Dec');
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
    expect(formatDayHeader(new Date('2026-03-01T00:00:00.000Z'))).toBe('Sunday, 1 Mar');
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
describe('formatDateWithYear', () => {
  it('renders day-of-month, abbreviated month, and year', () => {
    expect(formatDateWithYear(new Date('2026-06-12T00:00:00.000Z'))).toBe('12 Jun 2026');
  });

  it('does not pad the day-of-month', () => {
    expect(formatDateWithYear(new Date('2026-01-01T00:00:00.000Z'))).toBe('1 Jan 2026');
  });

  it('carries a year from before the current one, not just any year', () => {
    expect(formatDateWithYear(new Date('2025-12-31T00:00:00.000Z'))).toBe('31 Dec 2025');
  });

  /**
   * Same reasoning as `formatDayHeader`'s equivalent case, and the same shape:
   * `archived-record.tsx` hands this function `startOfLocalDay` output, which is
   * midnight UTC of the teacher's calendar day. Its other callers pass a
   * `@db.Date` column straight through, which is already midnight UTC — either
   * way the value reaching here is a calendar date, never a raw instant.
   * `vitest.config.ts` pins the run
   * west of UTC, where a local read of a midnight-UTC value renders the
   * *previous* day — so reading this in local time (or with
   * `toLocaleDateString`, unqualified) would print 31 Dec 2024, rolling the
   * year as well as the day.
   */
  it('reads the date in UTC, not the local zone', () => {
    expect(formatDateWithYear(new Date('2025-01-01T00:00:00.000Z'))).toBe('1 Jan 2025');
  });

  it('accepts a Date-like value without mutating the caller’s Date', () => {
    const original = new Date('2026-06-12T00:00:00.000Z');
    const snapshot = original.getTime();

    formatDateWithYear(original);

    expect(original.getTime()).toBe(snapshot);
  });
});

/**
 * #96. The compact form, for a date sitting inline in a row beside other text —
 * a payments caption, a student's last-seen. No weekday, no year: the row has
 * no space for them and its neighbours supply the context.
 */
describe('formatDateShort', () => {
  it('renders day then abbreviated month', () => {
    expect(formatDateShort(new Date('2026-06-12T00:00:00.000Z'))).toBe('12 Jun');
  });

  it('does not pad the day-of-month', () => {
    expect(formatDateShort(new Date('2026-01-01T00:00:00.000Z'))).toBe('1 Jan');
  });

  /**
   * Reads its argument with UTC accessors. `Class.date` is a `@db.Date` stored
   * at midnight UTC, so a local read renders the previous day west of UTC —
   * which the suite's `TZ` pin makes visible rather than theoretical. Unlike
   * the two cases above, this fixture crosses a month (and would cross a
   * weekday too, were one rendered): a local read west of UTC would give
   * '28 Feb', not just a different day number of the same month.
   */
  it('reads the calendar date, not the host-local one', () => {
    expect(formatDateShort(new Date('2026-03-01T00:00:00.000Z'))).toBe('1 Mar');
  });
});

/**
 * #96. A heading over a *set* of months in the reporting view, not a rendering
 * of any one class's date — which is why it takes numbers rather than a `Date`.
 * Its caller already holds year and month as separate values, having split them
 * out of a grouping key.
 */
describe('formatMonthLabel', () => {
  it('renders the full month name and year', () => {
    expect(formatMonthLabel(2026, 5)).toBe('June 2026');
  });

  it('treats the month as zero-indexed, matching getUTCMonth', () => {
    expect(formatMonthLabel(2026, 0)).toBe('January 2026');
    expect(formatMonthLabel(2026, 11)).toBe('December 2026');
  });

  /**
   * Unlike `paymentStateText`'s enum, `monthIndex` is a plain `number` —
   * there is no closed set a `never` check could enforce, and no type
   * assertion is needed to call this with an out-of-range value, so
   * (unlike that unreachable branch) this one can be pinned by a test
   * instead of guarded at runtime. `FULL_MONTHS[monthIndex]` is `undefined`
   * out of range, and the `?? ''` renders a leading space with no month name.
   */
  it('renders a leading space with no month name when the index is out of range', () => {
    expect(formatMonthLabel(2026, 12)).toBe(' 2026');
    expect(formatMonthLabel(2026, -1)).toBe(' 2026');
  });
});

/**
 * #58. These are `paymentStateText`'s first tests. It had none while its
 * parameter was `string` and its last branch was an unguarded catch-all
 * `return`, which is the combination this change removes: three surfaces render
 * these exact strings — the class payment checklist, a student's payment
 * history, and the student-facing bookings page — so the labels are the
 * contract, not an implementation detail.
 *
 * Asserted as whole objects so a className change cannot slip through a
 * label-only assertion.
 *
 * The last branch still returns — '○ Unpaid', after logging — but it is now
 * closed by `const unhandled: never`, so a new enum member breaks the build
 * rather than reaching it. There is deliberately no test for that branch: it is
 * unreachable for every value the type admits, and reaching it from a test
 * would take the type assertion this project forbids. The compiler is the test.
 */
describe('paymentStateText', () => {
  it('renders paid in teal with a check', () => {
    expect(paymentStateText('paid')).toEqual({ label: '✓ Paid', className: 'text-teal' });
  });

  it('renders overdue in danger, medium weight', () => {
    expect(paymentStateText('overdue')).toEqual({
      label: '! Overdue',
      className: 'text-danger font-medium',
    });
  });

  it('renders pending as unstyled unpaid', () => {
    // No colour class: unpaid is the resting state, not an alarm.
    expect(paymentStateText('pending')).toEqual({ label: '○ Unpaid', className: '' });
  });
});

describe('formatRoomLocation', () => {
  it('joins room and venue when both are present', () => {
    expect(formatRoomLocation('Main Studio', 'De Yogaschool')).toBe('Main Studio at De Yogaschool');
  });

  it('falls back to the venue alone when the room is unnamed', () => {
    // Rooms are optional-name: a one-room venue has nothing to disambiguate.
    expect(formatRoomLocation('', 'De Yogaschool')).toBe('De Yogaschool');
  });
});

/**
 * The privacy default. `StudentPrivacy` is per-teacher and defaults to maximum
 * privacy, so `shareFullName` is false unless a student has opted in with that
 * specific teacher — which makes the *default* branch the one that protects
 * someone, and the one worth pinning hardest.
 */
describe('formatStudentName', () => {
  it('abbreviates the surname by default', () => {
    expect(formatStudentName('Ana', 'de Vries')).toBe('Ana d.');
  });

  /**
   * A capitalised surname, because the case above cannot see this: `de Vries`
   * already starts lowercase, so it passes against an implementation with the
   * `.toLowerCase()` deleted. This one fails.
   */
  it('lower-cases the initial', () => {
    expect(formatStudentName('Ana', 'Vries')).toBe('Ana v.');
  });

  it('gives the full name only when sharing is on', () => {
    expect(formatStudentName('Ana', 'de Vries', true)).toBe('Ana de Vries');
  });

  it('handles a missing surname on both branches', () => {
    expect(formatStudentName('Ana', '')).toBe('Ana');
    expect(formatStudentName('Ana', '', true)).toBe('Ana');
  });
});

/**
 * `timeAgo` reads elapsed milliseconds, never a calendar field, so it is
 * correct in any timezone — unlike everything else in this file. The clock is
 * faked so the assertions are about the thresholds rather than about how long
 * the suite took to reach them.
 */
describe('timeAgo', () => {
  const NOW = new Date('2026-06-12T12:00:00.000Z');

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('says "just now" under a minute', () => {
    expect(timeAgo(new Date(NOW.getTime() - 30_000))).toBe('just now');
  });

  it('counts whole minutes, then whole hours, then whole days', () => {
    expect(timeAgo(new Date(NOW.getTime() - 5 * 60_000))).toBe('5m ago');
    expect(timeAgo(new Date(NOW.getTime() - 3 * 3_600_000))).toBe('3h ago');
    expect(timeAgo(new Date(NOW.getTime() - 2 * 86_400_000))).toBe('2d ago');
  });

  it('rounds down at each boundary', () => {
    // 59 minutes is still minutes; 60 becomes an hour.
    expect(timeAgo(new Date(NOW.getTime() - 59 * 60_000))).toBe('59m ago');
    expect(timeAgo(new Date(NOW.getTime() - 60 * 60_000))).toBe('1h ago');
    expect(timeAgo(new Date(NOW.getTime() - 23 * 3_600_000))).toBe('23h ago');
    expect(timeAgo(new Date(NOW.getTime() - 24 * 3_600_000))).toBe('1d ago');
  });
});
