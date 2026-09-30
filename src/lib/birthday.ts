/**
 * The date rules for a student's birthday (parse, day and month, age), a
 * calendar date stored in a `@db.Date` column. Postgres keeps only the UTC calendar date of whatever
 * instant it is handed, so every `Date` here is UTC midnight and every read
 * uses UTC accessors.
 */

export const BIRTHDAY_MIN = '1900-01-01';

export type BirthdayParse = { ok: true; date: Date } | { ok: false; reason: 'format' | 'range' };

export interface BirthdayDayMonth {
  day: number;
  /** 1–12. */
  month: number;
}

// A date input can hold a year of more than four digits; that is out of
// range, not malformed.
const ISO_DATE = /^(\d{4,})-(\d{2})-(\d{2})$/;

function utcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * `YYYY-MM-DD` only: an offset instant is refused rather than truncated,
 * because truncation to the UTC date is what shifts a local midnight east of
 * UTC onto the previous day.
 */
export function parseBirthday(s: string, now: Date = new Date()): BirthdayParse {
  const m = ISO_DATE.exec(s);
  if (!m) return { ok: false, reason: 'format' };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // setUTCFullYear, because Date.UTC reads a year 0–99 as 1900–1999.
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  // Both roll 30 February into March; a round-trip mismatch is a non-date.
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return { ok: false, reason: 'format' };
  }
  if (date < new Date(`${BIRTHDAY_MIN}T00:00:00.000Z`) || date > utcMidnight(now)) {
    return { ok: false, reason: 'range' };
  }
  return { ok: true, date };
}

export function dayMonthOf(birthday: Date): BirthdayDayMonth {
  return { day: birthday.getUTCDate(), month: birthday.getUTCMonth() + 1 };
}

/** Whole years on `now`'s UTC calendar date. */
export function ageOn(birthday: Date, now: Date): number {
  const years = now.getUTCFullYear() - birthday.getUTCFullYear();
  const beforeBirthday =
    now.getUTCMonth() < birthday.getUTCMonth() ||
    (now.getUTCMonth() === birthday.getUTCMonth() && now.getUTCDate() < birthday.getUTCDate());
  return beforeBirthday ? years - 1 : years;
}
