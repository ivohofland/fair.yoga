/**
 * A class's start instant, read without any side effect, so a client
 * component can import it: a fault is named, not logged.
 */

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
 * What `readClassStart` found. `fault` names the half that could not be read:
 * `date` and `start-time` come with an Invalid Date, `timezone` with the
 * wall clock read as UTC and the error `Intl` raised.
 */
export type ClassStartReading =
  | { fault: null; instant: Date }
  | { fault: 'date' | 'start-time'; instant: Date }
  | { fault: 'timezone'; instant: Date; error: unknown };

/**
 * The UTC instant at which a class starts: the stored calendar date's
 * wall-clock `startTime` interpreted in the given IANA timezone, with the
 * fault, if any, named rather than logged.
 *
 * The date and the time are checked apart from each other, because the
 * combined wall-clock value is NaN if EITHER is bad — `getUTCFullYear()` on an
 * Invalid Date is NaN just as an Invalid `startTime` gives a NaN hour. Both
 * are checked before the timezone, because `Intl.DateTimeFormat.formatToParts`
 * throws a RangeError on an Invalid Date, which would otherwise arrive as a
 * timezone fault naming a zone that was never the problem.
 */
export function readClassStart(
  cls: { date: Date; startTime: Date },
  timeZone: string,
): ClassStartReading {
  const { date: classDate, startTime } = cls;
  const d = new Date(classDate);
  const hours = startTime.getUTCHours();
  const minutes = startTime.getUTCMinutes();
  const wallUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hours, minutes, 0, 0);

  if (Number.isNaN(d.getTime())) return { fault: 'date', instant: new Date(NaN) };
  if (Number.isNaN(wallUtc)) return { fault: 'start-time', instant: new Date(NaN) };

  try {
    // Guess, then correct once — two passes converge across DST boundaries.
    let ts = wallUtc - timeZoneOffsetMs(new Date(wallUtc), timeZone);
    ts = wallUtc - timeZoneOffsetMs(new Date(ts), timeZone);
    return { fault: null, instant: new Date(ts) };
  } catch (error) {
    return { fault: 'timezone', instant: new Date(wallUtc), error };
  }
}
