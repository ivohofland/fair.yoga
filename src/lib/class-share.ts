import type { ClassStatus } from '@/lib/prisma-client';

/** The page a student books one class from. */
export function bookingPath(pageSlug: string, classId: string): string {
  return `/${pageSlug}/book/${classId}`;
}

export type ClassShareState = 'share' | 'publish_first' | 'none';

/**
 * What the class page offers for sharing its link. The start instant ends
 * it, not the status: an open class stays `open` until the sweep moves it on.
 */
export function classShareState(
  cls: { status: ClassStatus; cancelled: boolean; start: Date },
  now: Date,
): ClassShareState {
  if (cls.cancelled) return 'none';
  if (cls.status === 'open' && now.getTime() < cls.start.getTime()) return 'share';
  if (cls.status === 'draft') return 'publish_first';
  return 'none';
}
