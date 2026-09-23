/**
 * Whether `now` is strictly after the cancel deadline — the deadline instant
 * itself is still in time.
 *
 * Pure and import-free, so a client component can import it directly.
 */
export function isPastCancelDeadline(deadline: Date, now: Date): boolean {
  return now > deadline;
}
