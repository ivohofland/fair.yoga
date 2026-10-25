import type { PricingMode, RegistrationStatus } from '@/lib/prisma-client';

/** Why a late-cancelled booking is still charged. */
export const LATE_CANCEL_CHARGE_NOTE = 'Cancelled after the deadline — this class is still charged.';

/** The late-cancel line a booking page shows, per pricing mode. */
const LATE_CANCEL_NOTES = {
  tiered: LATE_CANCEL_CHARGE_NOTE,
  donation: 'Cancelled after the deadline.',
} as const satisfies Record<PricingMode, string>;

/** Why a booking marked absent is still charged. */
export const NO_SHOW_CHARGE_NOTE = 'Marked absent — this class is still charged.';

/** A new status fails the build here until its note, or `null`, is decided. */
const CHARGE_NOTES = {
  late_cancel: LATE_CANCEL_CHARGE_NOTE,
  no_show: NO_SHOW_CHARGE_NOTE,
  registered: null,
  attended: null,
  cancelled: null,
} as const satisfies Record<RegistrationStatus, string | null>;

/**
 * The line explaining a charge the student may not expect from how their
 * booking ended, or `null` when the charge needs no explaining.
 */
export function chargeNoteFor(status: RegistrationStatus): string | null {
  return CHARGE_NOTES[status] ?? null;
}

/** The note under a late-cancelled booking, in the class's pricing mode. */
export function lateCancelNoteFor(mode: PricingMode): string {
  return LATE_CANCEL_NOTES[mode];
}
