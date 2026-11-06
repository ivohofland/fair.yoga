/**
 * The schedule's "now" line, decided in the browser. Imports nothing that
 * logs: `timezone.ts` and `finish-window.ts` reach `server-only` code, so
 * the two zone readings below are local. An unreadable zone reads as UTC
 * without a log line — the server's render of the same schedule already
 * records it (`classStartInstant`).
 */

/** One schedule card as the "now" line sees it: instants in epoch ms. */
export interface TimelineItem {
  id: string;
  start: number;
  end: number;
  cancelled: boolean;
  /** Finished by the teacher, which may happen before `end`. */
  completed: boolean;
}

/**
 * Where the schedule's "now" line and labels go. The line follows the last
 * item that has ended (`lineAfterId`); when none has, it precedes the first
 * item (`lineBeforeId`). At most one of the two is set, and neither for an
 * empty list.
 */
export interface NowPlacement {
  lineBeforeId: string | null;
  lineAfterId: string | null;
  /** The live item whose window contains `now`. */
  runningId: string | null;
  /** The first live item that has not started yet. */
  nextId: string | null;
}

/** `items` must be in ascending start order, as the schedule lists them. */
export function placeNow(items: readonly TimelineItem[], now: number): NowPlacement {
  const ended = (i: TimelineItem): boolean => i.completed || i.end <= now;

  let lastEnded: TimelineItem | null = null;
  for (const i of items) if (ended(i)) lastEnded = i;

  const live = items.filter((i) => !i.cancelled && !ended(i));
  const running = live.find((i) => i.start <= now) ?? null;
  const next = live.find((i) => i.start > now) ?? null;

  return {
    lineBeforeId: lastEnded === null ? (items[0]?.id ?? null) : null,
    lineAfterId: lastEnded?.id ?? null,
    runningId: running?.id ?? null,
    nextId: next?.id ?? null,
  };
}

function inZone<T>(timeZone: string, read: (zone: string) => T): T {
  try {
    return read(timeZone);
  } catch {
    return read('UTC');
  }
}

/** `HH:MM` on a 24-hour clock in `timeZone`. */
export function clockInZone(instant: number, timeZone: string): string {
  return inZone(timeZone, (zone) =>
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: zone }).format(instant),
  );
}

/** The calendar date `instant` falls on in `timeZone`, as that date's UTC midnight. */
function localDay(instant: number, timeZone: string): Date {
  return inZone(timeZone, (zone) => {
    const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
    const dtf = new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: zone });
    for (const { type, value } of dtf.formatToParts(instant)) {
      if (type !== 'literal') parts[type] = Number(value);
    }
    return new Date(Date.UTC(parts.year ?? 1970, (parts.month ?? 1) - 1, parts.day ?? 1));
  });
}

// Read in UTC: `localDay` answers the local calendar date as a UTC midnight.
const WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' });
const SHORT_DATE = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When an upcoming class starts, in calendar words relative to `now` in the
 * teacher's zone: "today at 19:30", "tomorrow at 17:00", "Tuesday at 19:30"
 * within the coming six days, then "Fri 13 Nov at 19:30" — from seven days
 * out a bare weekday would read as this week's.
 */
export function describeNextStart(start: number, now: number, timeZone: string): string {
  const startDay = localDay(start, timeZone);
  const today = localDay(now, timeZone);
  // Both are UTC midnights of calendar dates, so the difference is whole days.
  const days = Math.round((startDay.getTime() - today.getTime()) / DAY_MS);
  const clock = clockInZone(start, timeZone);

  if (days <= 0) return `today at ${clock}`;
  if (days === 1) return `tomorrow at ${clock}`;
  if (days < 7) return `${WEEKDAY.format(startDay)} at ${clock}`;
  return `${SHORT_DATE.format(startDay)} at ${clock}`;
}
