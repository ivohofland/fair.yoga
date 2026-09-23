/**
 * Whether `now` has passed the cancel deadline.
 *
 * Pure and import-free, so a client component can import it directly.
 */
export function isPastCancelDeadline(deadline: Date, now: Date): boolean {
  return now > deadline;
}
