/**
 * Whether `now` has passed the cancel deadline.
 *
 * Pure and import-free beyond types, so a client component can import it
 * directly. `cancelDeadlineInstant` (`@/services/waitlist`) computes
 * `deadline`; it stays server-side because it goes through
 * `classStartInstant`, which logs through pino.
 */
export function isPastCancelDeadline(deadline: Date, now: Date): boolean {
  return now > deadline;
}
