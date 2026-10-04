import type { RegistrationStatus } from '@prisma/client';

/** Why a late-cancelled booking is still charged. */
export const LATE_CANCEL_CHARGE_NOTE = 'Cancelled after the deadline — this class is still charged.';

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
