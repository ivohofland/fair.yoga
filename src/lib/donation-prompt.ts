import type { ClassStatus, PricingMode, RegistrationStatus } from '@/lib/prisma-client';
import { DONATION_INVITED_STATUSES } from '@/lib/registration-status';
import { NOTIFICATION_RETENTION_DAYS } from '@/lib/notification-retention';

export interface DonationBookingState {
  classStatus: ClassStatus;
  classCancelledAt: Date | null;
  pricingMode: PricingMode;
  registrationStatus: RegistrationStatus;
  donationInvitedAt: Date | null;
}

/** Who may open `/bookings/[classId]/give` (#912), read whole; anything else is a 404 naming nothing. */
export function canSeeGivePage(s: DonationBookingState): boolean {
  switch (s.pricingMode) {
    case 'tiered':
      return false;
    case 'donation':
      return (
        s.classStatus === 'completed' &&
        s.classCancelledAt === null &&
        DONATION_INVITED_STATUSES.includes(s.registrationStatus) &&
        s.donationInvitedAt !== null
      );
    default: {
      const unhandled: never = s.pricingMode;
      throw new Error(`canSeeGivePage: unhandled pricing mode ${String(unhandled)}`);
    }
  }
}

/** How long the prompt shows, counted from `donationInvitedAt`: the invitation's retention window. */
export const DONATION_PROMPT_DAYS = NOTIFICATION_RETENTION_DAYS.donation_invitation;

const DAY_MS = 86_400_000;

export function showsDonationPrompt(
  s: DonationBookingState & { donationPromptHiddenAt: Date | null },
  now: Date,
): boolean {
  if (!canSeeGivePage(s) || s.donationPromptHiddenAt !== null || s.donationInvitedAt === null) return false;
  return now.getTime() < s.donationInvitedAt.getTime() + DONATION_PROMPT_DAYS * DAY_MS;
}
