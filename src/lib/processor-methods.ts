/** One method fair.yoga offers at checkout. `recurring` is whether it can start a mandate. */
export type MollieMethodEntry = { label: string; expiresMinutes: number; recurring: boolean };

/**
 * The methods fair.yoga offers, in pay-page order. An allowlist: a method the
 * processor adds is offered only once a reviewed change adds it here. The rule
 * for what may be added is the spec's Decision 1 (no deferred payment).
 * BLIK's expiry is one minute because Mollie's BLIK page gives a 55-second
 * session timeout and the expiry table has no row for it.
 */
export const MOLLIE_METHODS = {
  ideal: { label: 'iDEAL', expiresMinutes: 15, recurring: false },
  wero: { label: 'Wero', expiresMinutes: 10, recurring: false },
  bancontact: { label: 'Bancontact', expiresMinutes: 60, recurring: false },
  creditcard: { label: 'Card', expiresMinutes: 30, recurring: false },
  applepay: { label: 'Apple Pay', expiresMinutes: 30, recurring: false },
  eps: { label: 'EPS', expiresMinutes: 60, recurring: false },
  blik: { label: 'BLIK', expiresMinutes: 1, recurring: false },
  przelewy24: { label: 'Przelewy24', expiresMinutes: 60, recurring: false },
  twint: { label: 'TWINT', expiresMinutes: 45, recurring: false },
} as const satisfies Record<string, MollieMethodEntry>;

export type AllowedMollieMethod = keyof typeof MOLLIE_METHODS;

const ORDER = Object.keys(MOLLIE_METHODS) as AllowedMollieMethod[];

export function isAllowedMollieMethod(id: string): id is AllowedMollieMethod {
  return Object.hasOwn(MOLLIE_METHODS, id);
}

/** The ids fair.yoga offers, in allowlist order, and the ones it does not. */
export function orderOffered(ids: readonly string[]): { offered: AllowedMollieMethod[]; excluded: string[] } {
  const unique = [...new Set(ids)];
  const present = new Set(unique);
  return {
    offered: ORDER.filter((m) => present.has(m)),
    excluded: unique.filter((id) => !isAllowedMollieMethod(id)),
  };
}

/**
 * Copy only — which sentence explains an excluded method to the teacher. It
 * gates nothing; the allowlist does.
 */
const PAY_LATER_IDS: ReadonlySet<string> = new Set(['klarna', 'klarnapaylater', 'klarnasliceit', 'klarnapaynow', 'in3', 'riverty', 'billie', 'billink', 'alma']);
export type ExclusionReason = 'pay_later' | 'not_offered';
export function exclusionReason(id: string): ExclusionReason {
  return PAY_LATER_IDS.has(id) ? 'pay_later' : 'not_offered';
}
export const EXCLUSION_COPY = {
  pay_later: "fair.yoga doesn't offer pay-later credit at checkout.",
  not_offered: 'fair.yoga doesn’t offer this method yet.',
} as const satisfies Record<ExclusionReason, string>;

export const LONGEST_METHOD_EXPIRY_MINUTES = Math.max(...ORDER.map((m) => MOLLIE_METHODS[m].expiresMinutes));
