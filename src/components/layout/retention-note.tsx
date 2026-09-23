import { STANDARD_RETENTION_DAYS } from '@/lib/notification-retention';

/**
 * Keyed by the period, so changing `STANDARD_RETENTION_DAYS` fails to compile
 * here until the copy for the new period is written.
 */
const COPY = {
  365: 'Messages are kept for a year.',
} as const satisfies Record<typeof STANDARD_RETENTION_DAYS, string>;

/** The inbox's retention policy (#223). Spacing and alignment come from the caller. */
export function RetentionNote() {
  return <p className="type-caption">{COPY[STANDARD_RETENTION_DAYS]}</p>;
}
