import { describe, it, expect } from 'vitest';
import { isUpcomingRegistration } from './booking-ledger';
import { hhmmToTime } from './time-of-day';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('isUpcomingRegistration', () => {
  it('is upcoming while open, regardless of date', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'open',
          calendarEntry: {
            date: day('2020-01-01'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: null,
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('is upcoming while in_progress, regardless of date', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'in_progress',
          calendarEntry: {
            date: day('2020-01-01'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: null,
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  it('falls through to the date for a completed class', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'completed',
          calendarEntry: {
            date: day('2020-01-01'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: null,
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(false);
  });

  /**
   * THE BUG (#598). Before this predicate existed, `status === 'open'` alone
   * put a cancelled class under Upcoming forever, because cancellation never
   * changes `Class.status` (#327).
   */
  it('an open class cancelled in the past is no longer upcoming', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'open',
          calendarEntry: {
            date: day('2020-01-01'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: new Date('2020-01-01T08:00:00.000Z'),
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('a cancelled class still ahead stays upcoming', () => {
    expect(
      isUpcomingRegistration(
        {
          status: 'open',
          calendarEntry: {
            date: day('2099-08-02'),
            startTime: hhmmToTime('09:00'),
            cancelledAt: new Date('2026-06-01T00:00:00.000Z'),
            teacher: { defaultTimezone: 'Europe/Amsterdam' },
          },
        },
        new Date('2026-06-15T12:00:00.000Z'),
      ),
    ).toBe(true);
  });

  /**
   * THE CASE THAT KILLS "compare `calendarEntry.date` directly" for a
   * cancelled class — same fixture `timezone.test.ts`'s `startsInPast`
   * west-of-UTC case proves `classStartInstant` against, borrowed rather
   * than re-derived: 02:00 on 15 June in Los Angeles (PDT, UTC-7) is
   * `2026-06-15T09:00Z`, while the stored `date` column reads UTC midnight,
   * `2026-06-15T00:00Z` — nine hours earlier. `now` sits between the two:
   * after the stored column (a naive comparison reads "past") and before the
   * true start (correct answer: still upcoming).
   */
  it('reads the wall clock in the teacher zone for a cancelled class, not the stored UTC date', () => {
    const cancelledLaClass = {
      status: 'open' as const,
      calendarEntry: {
        date: day('2026-06-15'),
        startTime: hhmmToTime('02:00'),
        cancelledAt: new Date('2026-06-01T00:00:00.000Z'),
        teacher: { defaultTimezone: 'America/Los_Angeles' },
      },
    };

    expect(isUpcomingRegistration(cancelledLaClass, new Date('2026-06-15T05:00:00.000Z'))).toBe(
      true,
    );

    // One hour past the true start: now Past. Proves the case can't pass by
    // always answering `true`.
    expect(isUpcomingRegistration(cancelledLaClass, new Date('2026-06-15T10:00:00.000Z'))).toBe(
      false,
    );
  });
});
