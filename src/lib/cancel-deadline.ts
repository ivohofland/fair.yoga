/**
 * Whether `now` is strictly after the cancel deadline — the deadline instant
 * itself is still in time.
 *
 * Pure and import-free, so a client component can import it directly.
 */
export function isPastCancelDeadline(deadline: Date, now: Date): boolean {
  return now > deadline;
}

/** How long an auto-promoted student may cancel for free after being promoted. */
export const FREE_CANCEL_GRACE_MINUTES = 15;

/**
 * Until when a booking can be cancelled free: the cancel deadline, or — for a
 * booking an auto-promotion made — the later of that and promotion + grace.
 * `promotedAt` is null for every other booking.
 */
export function freeCancelUntil(deadline: Date, promotedAt: Date | null): Date {
  if (promotedAt === null) return deadline;
  const graceEnd = new Date(promotedAt.getTime() + FREE_CANCEL_GRACE_MINUTES * 60 * 1000);
  return graceEnd > deadline ? graceEnd : deadline;
}
