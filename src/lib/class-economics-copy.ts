import type { Currency, PricingMode } from '@/lib/prisma-client';
import type { EconomicsRule } from '@/lib/class-economics';
import { formatMoney } from '@/lib/format';

/** The tiered wording for each rule `economicsViolations` can report. */
const TIERED_COPY = {
  students_order: 'Min students cannot exceed max students',
  rate_order: 'Min rate cannot exceed target rate',
  room_subsidy: 'Min rate cannot subsidize more than the room cost — prices would go negative',
} as const satisfies Record<EconomicsRule, string>;

/** The room-subsidy wording for a class with no room (#911), which has none to subsidize from. */
export const ONLINE_SUBSIDY_COPY = 'Min rate cannot be negative for an online class — prices would go negative';

/** How every donation wording opens; `isEconomicsMessage` recognises it by this. */
const DONATION_LEAD = 'Your saved tiered rates';

/**
 * A donation class holds its tiered rates unseen, so a rule they break is named
 * as the saved rates', not as a field that is not on screen. Null for the
 * class-size rule, which stays on a field the teacher sees. An online class has
 * no room cost to name.
 */
function donationEconomicsMessage(
  rule: EconomicsRule,
  minRate: number,
  online: boolean,
  currency: Currency,
): string | null {
  switch (rule) {
    case 'students_order':
      return null;
    case 'rate_order':
      return `${DONATION_LEAD} are out of order. Switch to Tiered to change them.`;
    case 'room_subsidy':
      if (online) return `${DONATION_LEAD} have a negative min rate, which an online class cannot have. Switch to Tiered to change them.`;
      return `${DONATION_LEAD} need a room cost of at least ${formatMoney(-minRate, currency)}. Switch to Tiered to change them.`;
    default: {
      const unhandled: never = rule;
      return unhandled;
    }
  }
}

/** The wording for `rule` under the pricing mode and the format the form holds. */
export function economicsMessage(
  rule: EconomicsRule,
  e: { pricingMode: PricingMode; minRate: number; online: boolean },
  currency: Currency,
): string {
  if (e.pricingMode === 'donation') {
    const donation = donationEconomicsMessage(rule, e.minRate, e.online, currency);
    if (donation !== null) return donation;
  }
  return e.online && rule === 'room_subsidy' ? ONLINE_SUBSIDY_COPY : TIERED_COPY[rule];
}

const TIERED_MESSAGES: ReadonlySet<string> = new Set([...Object.values(TIERED_COPY), ONLINE_SUBSIDY_COPY]);

/** Whether `message` is one `economicsMessage` produced, whatever rates it was built from. */
export function isEconomicsMessage(message: string): boolean {
  return TIERED_MESSAGES.has(message) || message.startsWith(DONATION_LEAD);
}
