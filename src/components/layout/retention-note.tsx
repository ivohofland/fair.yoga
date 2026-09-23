import { STANDARD_RETENTION_DAYS } from '@/lib/notification-retention';

/**
 * Keyed by the period, so changing `STANDARD_RETENTION_DAYS` fails to compile
 * here until the copy for the new period is written.
 */
const COPY = {
  365: 'Messages are kept for a year.',
} as const satisfies Record<typeof STANDARD_RETENTION_DAYS, string>;

interface RetentionNoteProps {
  /** `start` (default): left-aligned, with its own top padding, under a
   * non-empty list's rows. `center`: centred with no top padding of its
   * own, for placing directly under `EmptyState`, inside that component's
   * padded envelope rather than opening a second one below it. */
  align?: 'start' | 'center';
}

/** The inbox's retention policy, under the list (#223). */
export function RetentionNote({ align = 'start' }: RetentionNoteProps) {
  return (
    <p className={`type-caption ${align === 'center' ? 'text-center' : 'pt-4'}`}>
      {COPY[STANDARD_RETENTION_DAYS]}
    </p>
  );
}
