import { classStartInstant } from '@/lib/timezone';

/**
 * How long before its end a teacher may finish a class, and how long after its
 * end the sweep finishes it for them. One number for both edges: the window is
 * symmetric around the end. See
 * `docs/superpowers/specs/2026-09-24-attendance-finish-window-design.md`.
 */
export const FINISH_GRACE_MINUTES = 15;

const GRACE_MS = FINISH_GRACE_MINUTES * 60_000;

/** The instant a class ends: its start plus its duration, in real minutes. */
export function classEndInstant(
  entry: { date: Date; startTime: Date; durationMinutes: number },
  timeZone: string,
): Date {
  const start = classStartInstant(entry, timeZone);
  return new Date(start.getTime() + entry.durationMinutes * 60_000);
}

/**
 * The earliest instant a teacher may finish the class: `FINISH_GRACE_MINUTES`
 * before its end, but never before its start. A class no longer than the grace
 * would otherwise be finishable, and so billable, before it begins.
 */
export function finishOpensAt({ start, end }: { start: Date; end: Date }): Date {
  return new Date(Math.max(start.getTime(), end.getTime() - GRACE_MS));
}

/** The instant the sweep finishes the class if the teacher has not. */
export function autoFinishAt(end: Date): Date {
  return new Date(end.getTime() + GRACE_MS);
}

/** `HH:MM` in `timeZone`; an unreadable zone formats in UTC and says so. */
export function formatClockInZone(instant: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: zone,
    }).format(instant);
  try {
    return format(timeZone);
  } catch {
    return `${format('UTC')} (UTC)`;
  }
}
