import { startOfLocalWeek } from '@/lib/timezone';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Tuesday of the week after the teacher's current one, as the calendar date
 * `CalendarEntry.date` stores (midnight UTC).
 *
 * The week is the teacher's, found the way the schedule page finds it
 * (`startOfLocalWeek`): reading it off the UTC clock names the wrong week for
 * the hour or two each Monday in which the two zones disagree about the day.
 */
export function tuesdayOfNextLocalWeek(now: Date, timeZone: string): Date {
  return new Date(startOfLocalWeek(now, timeZone).getTime() + 8 * DAY_MS);
}
