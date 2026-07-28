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
 * A class's day, as the schedule and bookings views render it: `Thursday, Jun 12`.
 *
 * UTC accessors throughout: `Class.date` is a `@db.Date` (midnight UTC) and the
 * time of day lives separately in `startTime`, so reading it in local time would
 * shift the date across the boundary for anyone west of UTC.
 */
export function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/**
 * A past, historical date, where the year matters: `12 Jun 2025`.
 *
 * `formatDayHeader` is for upcoming or in-progress dates — the schedule, a
 * class about to happen — and deliberately omits the year, since within the
 * next few months "Friday, Jun 12" is unambiguous. This is for records meant
 * to survive indefinitely, where dropping the year lets a date from last year
 * read identically to one from last month with nothing to tell them apart.
 *
 * Same UTC-accessors reasoning as `formatDayHeader`: this expects a value
 * already pinned to a calendar day at UTC midnight (e.g. `startOfLocalDay`'s
 * output), not a raw instant — reading a true instant in local time would
 * shift the calendar day for anyone whose zone disagrees with UTC.
 */
export function formatHistoricalDate(date: Date): string {
  const d = new Date(date);
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
