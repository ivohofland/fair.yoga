import type { ClassStatus } from '@/lib/prisma-client';

/** The page a student books one class from. */
export function bookingPath(pageSlug: string, classId: string): string {
  return `/${pageSlug}/book/${classId}`;
}

export type ClassShareState = 'share' | 'publish_first' | 'none';

/**
 * Whether a class's booking link is offered for sharing. The start instant
 * ends it, whatever the status still reads.
 */
export function classShareState(
  cls: { status: ClassStatus; cancelled: boolean; start: Date },
  now: Date,
): ClassShareState {
  if (cls.cancelled) return 'none';
  if (now.getTime() >= cls.start.getTime()) return 'none';
  if (cls.status === 'open') return 'share';
  if (cls.status === 'draft') return 'publish_first';
  return 'none';
}
