import type { ClassStatus } from '@prisma/client';
import { classStartInstant } from './timezone';

interface UpcomingLedgerClass {
  status: ClassStatus;
  calendarEntry: {
    date: Date;
    startTime: Date;
    cancelledAt: Date | null;
    teacher: { defaultTimezone: string };
  };
}

/**
 * Whether a registration's class belongs under Upcoming, not Past, on
 * `/bookings`.
 *
 * A cancelled class keeps whatever status it was cancelled from (#327) — an
 * `open` or `in_progress` class cancelled by any of the three cancel paths
 * never changes `Class.status` — so status alone can't decide a cancelled
 * class. Its start instant does, via `classStartInstant`, not
 * `calendarEntry.date`: that column is a stored UTC-midnight calendar date
 * and can sit hours away from the teacher's actual wall-clock start in
 * either direction (#101, #278).
 *
 * A live (non-cancelled) class stays decided by status first — `open` and
 * `in_progress` are upcoming regardless of date, matching the lifecycle in
 * CLAUDE.md; only a `draft` or `completed` class falls through to the date
 * check.
 */
export function isUpcomingRegistration(cls: UpcomingLedgerClass, now: Date): boolean {
  const { calendarEntry } = cls;
  if (calendarEntry.cancelledAt !== null) {
    return classStartInstant(calendarEntry, calendarEntry.teacher.defaultTimezone) >= now;
  }
  return cls.status === 'open' || cls.status === 'in_progress' || calendarEntry.date >= now;
}
