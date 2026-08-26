/**
 * Timezone-aware class time computation.
 *
 * Class rows store a calendar date (UTC midnight) plus a wall-clock
 * `startTime` (`@db.Time`). That wall clock belongs to the teacher's timezone
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
 * The UTC-midnight Monday of the week containing `date`, as epoch-ms.
 *
 * Takes a CALENDAR DATE — a `@db.Date` value, or anything built with
 * `Date.UTC` — and takes no timezone, deliberately. Contrast
 * `startOfLocalWeek` directly above, which takes an INSTANT and resolves it
 * through `Intl` first. The two are not interchangeable and confusing them is
 * a live defect, not a style question: feeding a `@db.Date` (midnight UTC) to
 * `startOfLocalWeek` reads that instant in the target zone, and west of UTC
 * that is the previous calendar day — for a Monday class, the previous week.
 * Issue #194's own text told an implementer to do exactly that; see the spec's
 * §1.4.
 *
 * `class-list.tsx` is the worked example of the pair: it calls this on
 * `item.data.date` (a calendar date, no zone) and `startOfLocalWeek` on `now`
 * (an instant, with the teacher's zone), in the same function.
 *
 * Monday-first, matching the `dayOfWeek` schema convention (0 = Monday).
 * `getUTCDay()` is Sunday-first, so Sunday maps back six days rather than
 * forward one — which is what puts a Sunday and the following Monday in
 * different weeks.
 */
export function mondayOf(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.getTime();
}

/**
 * The UTC instant at which a class starts: the stored calendar date's
 * wall-clock startTime interpreted in the given IANA timezone.
 *
 * `startTime` is a `@db.Time` value (read the way `timeToHHmm` reads one, with
 * UTC accessors — a `time` column carries no zone of its own, so the hour and
 * minute it reports are exactly the wall-clock digits stored).
 *
 * Unknown timezones fall back to UTC interpretation rather than throwing —
 * a wrong-but-bounded answer beats a crashed cron run.
 */
export function classStartInstant(classDate: Date, startTime: Date, timeZone: string): Date {
  const d = new Date(classDate);
  const hours = startTime.getUTCHours();
  const minutes = startTime.getUTCMinutes();
  const wallUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hours, minutes, 0, 0);

  // THREE WAYS TO FAIL, THREE MESSAGES, and the checks are separate for that
  // reason alone — a single `Number.isNaN(wallUtc)` test would be shorter and
  // would name the wrong culprit half the time.
  //
  // All three are checked BEFORE the `try`, because otherwise they arrive as a
  // timezone fault: `Date.UTC` with a NaN component returns NaN, `new Date(NaN)`
  // handed to `Intl.DateTimeFormat.formatToParts` throws a RangeError, and the
  // catch below logs "invalid timezone" naming a zone that was never the
  // problem. That was the original defect.
  //
  // The date and the time are then checked apart from each other, because
  // `wallUtc` is NaN if EITHER is bad — `getUTCFullYear()` on an Invalid Date
  // is NaN just as an Invalid `startTime` gives a NaN hour. Testing only
  // the combination and blaming `startTime` relocated the misattribution
  // instead of removing it: measured, `classStartInstant(new Date('nonsense'),
  // …)` logged the date's own `startTime` value under "unparseable startTime".
  //
  // Returning early keeps the same Invalid Date this has always returned —
  // callers that compare it are unchanged — while making the cause greppable,
  // and letting `startsInPast` fail closed on these and not on a bad timezone.
  if (Number.isNaN(d.getTime())) {
    // `startTime` alongside it, showing it was fine — the point of splitting
    // these branches is that a reader can tell which half broke.
    // `isoOrNull` is hoisted; it is declared below only to keep it beside its
    // other callers.
    log.warn(
      { classDate: isoOrNull(d), startTime: isoOrNull(startTime) },
      'unreadable class date, cannot compute class start instant',
    );
    return new Date(NaN);
  }
  if (Number.isNaN(wallUtc)) {
    log.warn(
      { startTime: isoOrNull(startTime) },
      'unparseable startTime, cannot compute class start instant',
    );
    return new Date(NaN);
  }

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

/**
 * A `Date` as an ISO string, or `null` if it is not a readable one.
 *
 * `toISOString()` THROWS a RangeError on an Invalid Date, and the places that
 * want to serialise one are the refusal paths — whose whole reason for
 * existing is that some input could not be read. Serialising unguarded there
 * turns the clean 409 a guard produces into a 500 raised by its own log line,
 * which is not a hypothetical: it shipped once, in the commit that fixed
 * `startsInPast`'s fail-open, and `updateClass` answered
 * `RangeError: Invalid time value` for a payload it had correctly decided to
 * refuse.
 *
 * A function rather than the check written out at each site, because it was
 * written out at each site and one of the four was missed — while a comment at
 * a fifth asserted that "the callers NaN-check their own instants". Three call
 * sites and a name is cheap; a claim that has to stay true by inspection is
 * not.
 */
export function isoOrNull(date: Date): string | null {
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Whether a class's start instant has already passed at `now` (#249).
 *
 * Thin on purpose. It exists so the rule has one name, one docblock and one
 * place to pin timezone behaviour, rather than two call sites that drift — and
 * so the wrong implementation has somewhere to be refused. That wrong
 * implementation is comparing `Class.date` (stored at UTC midnight) against
 * `now`: it agrees with this one at most hours of most days, which is precisely
 * why `timezone.test.ts` pins a case where the two disagree.
 *
 * `now` is required rather than defaulted. A caller that wants to shift the
 * clock has to say so — the same reasoning `CompletionTiming` gives in
 * `class-lifecycle.ts` for why skipping a timing check cannot be silent.
 *
 * Strictly `<`: a class starting this instant has not started in the past.
 *
 * FAILS CLOSED. Both callers use a `true` to refuse a write, so the only safe
 * answer to "I cannot read this class's start" is the refusing one. The naive
 * body — `classStartInstant(...) < now` — did the opposite without looking
 * like it: an unparseable `startTime` yields an Invalid Date, every relational
 * comparison against one is `false`, and the guard waved the write through
 * while appearing to have checked it. That is the same silent-`false` shape
 * `completeClass` guards `requireEndedBy` against with `Number.isNaN`.
 *
 * Unparseable is not reachable from validated input — `startTime` is `HH:mm`
 * by schema on every write, converted to the `@db.Time` `Date` this function
 * takes before it ever reaches Prisma — so this branch means the column has
 * been corrupted outside the app, and a loud refusal is the correct response
 * to that. Note the asymmetry with an unknown TIMEZONE one function up, which
 * falls back to UTC and proceeds: that yields a wrong-but-bounded answer for
 * a value the guard can still reason about, where this one has no start
 * instant at all.
 *
 * THE SCHEDULING TRIPLE IS STILL ONE OBJECT, not positional arguments:
 * restructuring this signature is outside what changing `startTime`'s type
 * needs to touch.
 */
export function startsInPast(
  cls: { date: Date; startTime: Date; timeZone: string },
  now: Date,
): boolean {
  const { date: classDate, startTime, timeZone } = cls;
  const start = classStartInstant(classDate, startTime, timeZone);
  if (Number.isNaN(start.getTime())) {
    log.warn(
      // Through `isoOrNull`, because this is the one branch reached by inputs
      // already known to be broken — a bare `toISOString()` here would raise
      // the 500 the refusal exists to avoid.
      { startTime: isoOrNull(startTime), timeZone, classDate: isoOrNull(classDate) },
      // NAMES THE START, NOT ONE OF ITS TWO HALVES. Either the date or the
      // `startTime` can be the unreadable one, and this frame cannot tell them
      // apart — `classStartInstant` already logged which, immediately above
      // this line in the same request. Naming `startTime` here, as an earlier
      // revision did, contradicted that line half the time.
      'refusing write: this class start is unreadable, so a past start cannot be ruled out',
    );
    return true;
  }
  return start < now;
}
