import { formatDayHeader } from '@/lib/format';

// The give page's own words, shared with the marketing illustration of it
// (`GivePagePhone`) so the two cannot drift apart.
export const GIVE_PAGE_HEADING = 'Thank you for coming.';
export const GIVE_PAGE_BACK = 'Your bookings';

export function giveCaption(
  entry: { classType: string; date: Date },
  teacher: { firstName: string; lastName: string },
): string {
  return `${entry.classType} · ${formatDayHeader(entry.date)} · with ${teacher.firstName} ${teacher.lastName}`;
}
