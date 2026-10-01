import type { ReminderTiming } from '@prisma/client';
import { classStartInstant } from './timezone';
import { hhmmToTime } from './time-of-day';

/** No reminder is due later than this many minutes before the class starts. */
export const REMINDER_LATEST_LEAD_MINUTES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a class reminder is due, with wall-clock times read in
 * `timeZone`: 19:00 the day before, 07:00 on the day, or
 * `REMINDER_LATEST_LEAD_MINUTES` before start, and never later than that.
 * `null` when reminders are off.
 */
export function reminderMoment(
  entry: { date: Date; startTime: Date },
  timeZone: string,
  timing: ReminderTiming,
): Date | null {
  const start = classStartInstant(entry, timeZone);
  const latest = new Date(start.getTime() - REMINDER_LATEST_LEAD_MINUTES * 60_000);
  let nominal: Date;
  switch (timing) {
    case 'off':
      return null;
    case 'evening_before':
      nominal = classStartInstant(
        { date: new Date(entry.date.getTime() - DAY_MS), startTime: hhmmToTime('19:00') },
        timeZone,
      );
      break;
    case 'morning_of':
      nominal = classStartInstant({ date: entry.date, startTime: hhmmToTime('07:00') }, timeZone);
      break;
    case 'one_hour_before':
      nominal = latest;
      break;
    default: {
      const unreachable: never = timing;
      return unreachable;
    }
  }
  return nominal.getTime() < latest.getTime() ? nominal : latest;
}
