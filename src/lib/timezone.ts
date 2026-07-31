/**
 * Timezone-aware class time computation.
 *
 * Class rows store a calendar date (UTC midnight) plus an HH:mm wall-clock
 * startTime. That wall clock belongs to the teacher's timezone
 * (Teacher.defaultTimezone) — computing deadlines and lifecycle transitions
 * in raw UTC would shift every decision by the UTC offset and drift across
 * DST transitions.
 *
 * The rule this module exists to enforce, stated once because the codebase
 * relies on it everywhere and had never written it down:
 *
 *   - A `@db.Date` column is a *calendar date*, stored at midnight UTC. Read
 *     it with UTC accessors. Never hand it to `toLocaleDateString` without an
 *     explicit `timeZone` — that reads it in whatever zone the host is in.
 *   - A `new Date()` is an *instant*. Run it through `startOfLocalDay` (or
 *     `startOfLocalWeek`) before comparing it against a calendar date.
 *
 * The two failures do not hide in the same way, and it is worth not conflating
 * them — an earlier draft of this comment did.
 *
 *   - Breaking rule one is *host*-dependent: `toLocaleDateString` with no
 *     `timeZone` reads whatever zone the process runs in, so west of UTC it
 *     renders the previous day and at UTC it looks perfect. Measured: the same
 *     `@db.Date` value renders `11 Jun 2026` under `America/New_York` and
 *     `12 Jun 2026` under both `UTC` and `Asia/Kolkata`.
 *   - Breaking rule two is *not*. `new Date()` read with `setUTCHours` or
 *     `getUTCDay` gives the same answer on every host; it is wrong because it
 *     uses UTC as the *teacher's* day, which is wrong for every teacher who is
 *     not in UTC no matter where the server sits.
 *
 * #101 broke the second rule; #115 broke the first.
 */

import { log } from '@/lib/log';

/** Milliseconds the zone's wall clock is ahead of UTC at the given instant. */
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
  for (const { type, value } of dtf.formatToParts(instant)) {
    if (type !== 'literal') parts[type] = Number(value);
  }

  const wallAsUtc = Date.UTC(
    parts.year!,
    parts.month! - 1,
    parts.day!,
    parts.hour!,
    parts.minute!,
    parts.second!,
  );
  return wallAsUtc - instant.getTime();
}

/**
 * The teacher's current calendar date, expressed the way `Class.date` and
 * `StudioClass.date` store one: midnight UTC of the local day.
 *
 * Those columns are `@db.Date` — they hold a *calendar date*, not an instant.
 * The only sound comparison against them is another calendar date. Comparing
 * one to `new Date()` silently treats the teacher's calendar as UTC's, which
 * is true only at offset 0: east of UTC the teacher's today still reads as
 * `> now` for the first hours of their day, and west of UTC their tomorrow
 * already reads as `< now` through the evening. Both directions matter to
 * #86's archive boundary, where one spares a class and the other deletes it.
 *
 * Unknown timezones fall back to the UTC calendar date rather than throwing,
 * matching `classStartInstant`.
 */
export function startOfLocalDay(instant: Date, timeZone: string): Date {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });

    const parts: Partial<Record<Intl.DateTimeFormatPartTypes, number>> = {};
    for (const { type, value } of dtf.formatToParts(instant)) {
      if (type !== 'literal') parts[type] = Number(value);
    }

    return new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day!));
  } catch {
    log.warn({ timeZone }, 'invalid timezone, falling back to UTC calendar date');
    const utc = new Date(instant);
    utc.setUTCHours(0, 0, 0, 0);
    return utc;
  }
}

/**
 * UTC-midnight Monday of the week containing `instant`, in `timeZone`.
 *
 * Built on `startOfLocalDay` rather than repeating its `Intl` work: the local
 * calendar day is the only timezone-sensitive part, and once you have it as a
 * midnight-UTC value the Monday is plain UTC arithmetic on a calendar date —
 * which is rule one, and correct.
 *
 * Monday-first, matching the `dayOfWeek` schema convention (0 = Monday).
 * `getUTCDay()` is Sunday-first, so Sunday maps back six days rather than
 * forward one.
 */
export function startOfLocalWeek(instant: Date, timeZone: string): Date {
  const day = startOfLocalDay(instant, timeZone);
  const jsDay = day.getUTCDay();
  day.setUTCDate(day.getUTCDate() + (jsDay === 0 ? -6 : 1 - jsDay));
  return day;
}

/**
 * The UTC instant at which a class starts: the stored calendar date's
 * wall-clock startTime interpreted in the given IANA timezone.
 *
 * Unknown timezones fall back to UTC interpretation rather than throwing —
 * a wrong-but-bounded answer beats a crashed cron run.
 */
export function classStartInstant(classDate: Date, startTime: string, timeZone: string): Date {
  const d = new Date(classDate);
  const [hours, minutes] = startTime.split(':').map(Number) as [number, number];
  const wallUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hours, minutes, 0, 0);

  try {
    // Guess, then correct once — two passes converge across DST boundaries.
    let ts = wallUtc - timeZoneOffsetMs(new Date(wallUtc), timeZone);
    ts = wallUtc - timeZoneOffsetMs(new Date(ts), timeZone);
    return new Date(ts);
  } catch {
    log.warn({ timeZone }, 'invalid timezone, falling back to UTC interpretation');
    return new Date(wallUtc);
  }
}
