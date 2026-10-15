import type { CancelDeadline, WaitlistStatus } from '@/lib/prisma-client';

/** Maps CancelDeadline enum to hours before class start. */
export const DEADLINE_HOURS: Record<CancelDeadline, number> = {
  HOURS_48: 48,
  HOURS_24: 24,
  HOURS_12: 12,
  HOURS_6: 6,
};

/**
 * The cancel-deadline instant for a class that starts at `start`: the start,
 * minus the deadline enum's hours, as a real elapsed-time subtraction (not a
 * wall-clock-preserved one — a class near a DST transition can have a
 * different UTC offset at its deadline instant than at its own start).
 * An Invalid `start` gives an Invalid Date.
 */
export function cancelDeadlineFrom(start: Date, cancelDeadline: CancelDeadline): Date {
  return new Date(start.getTime() - DEADLINE_HOURS[cancelDeadline] * 60 * 60 * 1000);
}

/**
 * Whether `now` is strictly after the cancel deadline — the deadline instant
 * itself is still in time.
 *
 * Pure and free of runtime imports, so a client component can import it
 * directly.
 */
export function isPastCancelDeadline(deadline: Date, now: Date): boolean {
  return now > deadline;
}

/** How long an auto-promoted student may cancel for free after being promoted. */
export const FREE_CANCEL_GRACE_MINUTES = 15;

/**
 * Until when a booking can be cancelled free: the cancel deadline, or — for a
 * booking an auto-promotion made — the later of that and promotion + grace.
 * Pass `null` for any booking an auto-promotion did not make
 * (`freeCancelUntilFor` does this).
 */
export function freeCancelUntil(deadline: Date, promotedAt: Date | null): Date {
  if (promotedAt === null) return deadline;
  const graceEnd = new Date(promotedAt.getTime() + FREE_CANCEL_GRACE_MINUTES * 60 * 1000);
  return graceEnd > deadline ? graceEnd : deadline;
}

/**
 * `freeCancelUntil` for a booking as a caller fetched it: its linked
 * `WaitlistEntry` projection, and `Registration.lateCancelledAt`. Only
 * `status === 'promoted'` carries the grace — every other member of
 * `WaitlistStatus`, and no linked entry at all, reads as `null`.
 *
 * A booking that was ever late-cancelled gets no grace either
 * (`keepsPromotionGrace`), even once a promotion has reactivated it: a
 * rejoin is a change of mind, not a way out of that charge.
 *
 * `WaitlistStatus` arrives via `import type` only, so this module still adds
 * no runtime import — the type is erased at compile time.
 */
export function freeCancelUntilFor(
  deadline: Date,
  booking: {
    lateCancelledAt: Date | null;
    waitlistEntry: { status: WaitlistStatus; promotedAt: Date | null } | null;
  },
): Date {
  const promotion = booking.waitlistEntry;
  const graceFrom =
    keepsPromotionGrace(booking) && promotion?.status === 'promoted' ? promotion.promotedAt : null;
  return freeCancelUntil(deadline, graceFrom);
}

/**
 * Whether a promotion onto this booking carries the free-cancel grace: not
 * once the booking has been late-cancelled, which already charged it.
 */
export function keepsPromotionGrace(booking: { lateCancelledAt: Date | null }): boolean {
  return booking.lateCancelledAt === null;
}
