import type { NotificationType } from '@prisma/client';

/**
 * How long a `Notification` row is kept, by type (#223). Why deleting is
 * safe, and why there is no index for it: `docs/data-model.md`
 * (`### Notification (inbox item)`).
 *
 * Keep this module free of server-only imports, so client code can import it.
 */
export const SHORT_RETENTION_DAYS = 30;
export const STANDARD_RETENTION_DAYS = 365;

type RetentionDays = typeof SHORT_RETENTION_DAYS | typeof STANDARD_RETENTION_DAYS;

/**
 * `satisfies` makes a new `NotificationType` member a compile error here
 * until it is given a period.
 */
export const NOTIFICATION_RETENTION_DAYS = {
  booking_confirmed: STANDARD_RETENTION_DAYS,
  booking_cancelled: STANDARD_RETENTION_DAYS,
  booking_removed: STANDARD_RETENTION_DAYS,
  class_cancelled: STANDARD_RETENTION_DAYS,
  payment_received: STANDARD_RETENTION_DAYS,
  payment_request: STANDARD_RETENTION_DAYS,
  // A booking confirmation for an auto-promoted student, not a transient
  // alert.
  waitlist_promoted: STANDARD_RETENTION_DAYS,
  // Worthless once its claim window has closed.
  spot_available: SHORT_RETENTION_DAYS,
  // Same lifespan as the broadcast it answers, for the same reason.
  spot_taken: SHORT_RETENTION_DAYS,
  reminder: STANDARD_RETENTION_DAYS,
  announcement: STANDARD_RETENTION_DAYS,
  teacher_invitation: STANDARD_RETENTION_DAYS,
} as const satisfies Record<NotificationType, RetentionDays>;
