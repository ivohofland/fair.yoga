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
 */
export function paymentStateText(status: string): { label: string; className: string } {
  if (status === 'paid') return { label: '\u2713 Paid', className: 'text-teal' };
  if (status === 'overdue') return { label: '! Overdue', className: 'text-danger font-medium' };
  return { label: '\u25cb Unpaid', className: '' };
}

/**
 * Shared by both date formatters below, which want the same abbreviations —
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
 * A class's day, as the schedule and bookings views render it: `Thursday, Jun 12`.
 *
 * UTC accessors throughout: `Class.date` is a `@db.Date` (midnight UTC) and the
 * time of day lives separately in `startTime`, so reading it in local time would
 * shift the date across the boundary for anyone west of UTC.
 */
export function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return `${days[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * A past, historical date, where the year matters: `12 Jun 2025`.
 *
 * Use this for records meant to survive indefinitely, where dropping the year
 * lets a date from last year read identically to one from last month with
 * nothing to tell them apart. `formatDayHeader` omits the year, which is safe
 * while a date is near enough that "Friday, Jun 12" can only mean one day.
 *
 * That split is the intent, not a description of the callers. `formatDayHeader`
 * is not confined to upcoming dates: `src/app/(student)/bookings/page.tsx` uses
 * it for the "Past classes" section and embeds it in the bank-transfer
 * remittance string for classes already taught — dates with no expiry, printed
 * without a year. Whether that is the one place still owed a year is an open
 * question, not a settled one; do not audit callers on the assumption that it
 * already follows the rule above.
 *
 * Same UTC-accessors reasoning as `formatDayHeader`, and the same direction:
 * this expects a value already pinned to a calendar day at UTC midnight (e.g.
 * `startOfLocalDay`'s output), not a raw instant. For such a value a local read
 * shifts the calendar day back one day *west* of UTC, and moves nothing at or
 * east of it — see `vitest.config.ts` for why the test run is pinned west.
 */
export function formatHistoricalDate(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
