import type { PaymentStatus } from '@prisma/client';

export function formatRoomLocation(roomName: string, venueName: string): string {
  return roomName ? `${roomName} at ${venueName}` : venueName;
}

export function formatStudentName(firstName: string, lastName: string, shareFullName = false): string {
  if (shareFullName) {
    return `${firstName}${lastName ? ` ${lastName}` : ''}`.trim();
  }
  const lastInitial = lastName.length > 0 ? lastName[0] : '';
  return `${firstName} ${lastInitial ? lastInitial.toLowerCase() + '.' : ''}`.trim();
}

/** Compact relative time for notification rows: "just now", "5m ago", "3h ago", "2d ago". */
export function timeAgo(date: Date): string {
  const diffMinutes = Math.floor((Date.now() - new Date(date).getTime()) / 60_000);
  if (diffMinutes < 1) return 'just now';
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

/**
 * Payment state as text, never a badge: "\u2713 Paid" teal, "\u25cb Unpaid"
 * brown, "! Overdue" danger. Returns label + the text-color class.
 *
 * Three surfaces render these, one of them student-facing, so the last branch
 * is deliberately quiet at runtime and loud at compile time \u2014 see below.
 */
export function paymentStateText(status: PaymentStatus): { label: string; className: string } {
  if (status === 'paid') return { label: '\u2713 Paid', className: 'text-teal' };
  if (status === 'overdue') return { label: '! Overdue', className: 'text-danger font-medium' };
  if (status === 'pending') return { label: '\u25cb Unpaid', className: '' };
  // Unreachable for any status the schema can produce, and the `never` is what
  // keeps it that way: adding a member to the enum fails the *build* here
  // instead of the member rendering silently as "Unpaid". That guard is the
  // whole point of this branch and stays.
  //
  // What it does at runtime is deliberately undramatic. This throwing was
  // strictly worse than the catch-all `return` it replaced: `bookings/page.tsx`
  // is an async server component with `force-dynamic` that calls this during
  // render, and the app's only error boundary (`app/error.tsx`, plus
  // `global-error.tsx`) logs nothing \u2014 so on enum/deploy drift a throw takes
  // down an entire student-facing page on every request, with no diagnostic
  // trail. Log it and mislabel one row instead; '\u25cb Unpaid' is the calmest
  // of the three states this design system has and never overclaims payment.
  //
  // `console.error`, not `lib/log.ts`: that module is pino and server-only, and
  // this file is imported by `'use client'` components.
  const unhandled: never = status;
  console.error('[payment-state-text] unhandled payment status', { status: String(unhandled) });
  return { label: '\u25cb Unpaid', className: '' };
}

/**
 * Shared by the three date formatters below, which want the same abbreviations —
 * `Jun`, not `June` and not a locale's idea of either. Module level rather than
 * a `const` inside each: it was declared twice, twenty lines apart, and rebuilt
 * on every call.
 *
 * Deliberately not `toLocaleString`: these formatters read their argument with
 * UTC accessors on purpose (see below), and a locale-aware month would have to
 * be told the same, at which point a fixed English array is the honest version
 * of what this already is.
 */
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * Full month names, for `formatMonthLabel`'s heading-over-a-set-of-months —
 * unlike `MONTHS` above, exported: `class-list.tsx` imports this for its own
 * week-heading label, which is why it stays public while `MONTHS` stays
 * private; nothing outside this file needs the abbreviated form.
 */
export const FULL_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * A class's day, as the schedule and bookings views render it: `Friday, 12 Jun`.
 *
 * Day-first (#96). The app previously rendered this three ways — `Jun 12`,
 * `12 June`, `June 12, 2026` — and a teacher saw two of them one tap apart.
 * Day-first is the international convention, which `CLAUDE.md`'s "international
 * from day one" implies and which will not need undoing when i18n arrives.
 *
 * UTC accessors throughout: `Class.date` is a `@db.Date` (midnight UTC) and the
 * time of day lives separately in `startTime`, so reading it in local time would
 * shift the date across the boundary for anyone west of UTC.
 */
export function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * A date where the year matters: `12 Jun 2026`.
 *
 * Detail pages and any record meant to survive indefinitely, where dropping the
 * year lets a date from last year read identically to one from last month.
 * Named for what it renders rather than when it was added — it was
 * `formatHistoricalDate` until #96 pointed the class and studio detail pages at
 * it, and those show upcoming classes too.
 *
 * That split is the intent, not a description of the callers. `formatDayHeader`
 * is not confined to upcoming dates, in at least two places:
 *
 * - `src/app/(student)/bookings/page.tsx` uses it for the "Past classes"
 *   section and embeds it in the bank-transfer remittance string for classes
 *   already taught.
 * - `src/app/(teacher)/schedule/past/page.tsx` queries `date: { lt: today }`
 *   with no lower bound and renders through `ClassList`, so a class from any
 *   past year prints without one.
 *
 * Both are dates with no expiry, printed without a year. Whether they are owed
 * one is an open question, not a settled one — do not audit callers on the
 * assumption that they already follow the rule above.
 *
 * Same UTC-accessors reasoning as `formatDayHeader`, and the same direction:
 * this expects a value already pinned to a calendar day at UTC midnight (e.g.
 * `startOfLocalDay`'s output), not a raw instant. For such a value a local read
 * shifts the calendar day back one day *west* of UTC, and moves nothing at or
 * east of it — see `vitest.config.ts` for why the test run is pinned west.
 */
export function formatDateWithYear(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/**
 * The compact form: `12 Jun`. No weekday, no year.
 *
 * For a date sitting inline in a row beside other text, where the surrounding
 * copy supplies the context a weekday would otherwise give. Same UTC-accessor
 * reasoning as the two above.
 */
export function formatDateShort(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/**
 * A heading over a set of months: `June 2026`.
 *
 * Takes year and zero-indexed month rather than a `Date`, because its only
 * caller has already split them out of a grouping key and has no `Date` to
 * hand. Zero-indexed to match `getUTCMonth`, so a caller that does hold a date
 * can pass its accessors straight through.
 *
 * The full month name, not the abbreviation the date formatters use: this
 * labels a period rather than a day, and there is no adjacent day number for it
 * to crowd.
 *
 * Out of range (`monthIndex` outside 0–11), `FULL_MONTHS[monthIndex]` is
 * `undefined` and the `?? ''` below renders e.g. `" 2026"` — a leading space,
 * no month name. Unreachable from the single caller. Unlike
 * `paymentStateText`'s enum in this same file, `monthIndex` is a plain
 * `number` with no closed set a `never` check could enforce at compile time,
 * and no type assertion is needed to call this out of range — so that
 * behaviour is pinned by a test (`format.test.ts`) rather than guarded here.
 */
export function formatMonthLabel(year: number, monthIndex: number): string {
  return `${FULL_MONTHS[monthIndex] ?? ''} ${year}`;
}
