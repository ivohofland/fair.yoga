import { startOfLocalWeek } from '@/lib/timezone';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tuesday of the Monday-first week after the one `now` falls in for a teacher
 * in `timeZone` (`startOfLocalWeek`), as the calendar date `CalendarEntry.date`
 * stores (midnight UTC). Reading the week off the UTC clock names the wrong one
 * for the hours each week in which UTC and the zone disagree about the day.
 */
export function tuesdayOfNextLocalWeek(now: Date, timeZone: string): Date {
  return new Date(startOfLocalWeek(now, timeZone).getTime() + 8 * DAY_MS);
}
