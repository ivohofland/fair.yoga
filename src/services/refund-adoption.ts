import { Prisma, type Currency } from '@/lib/prisma-client';
import type { MollieAmount } from '@/lib/mollie/client';

/**
 * How old a refund intent with no Mollie id must be before a refund Mollie
 * lists may be adopted into it: well past the client's request timeout and
 * the transaction that stores Mollie's answer, so the call that made the
 * intent has either stored the id or is gone.
 */
export const ADOPT_AFTER_MS = 2 * 60_000;

/** Whether a refund Mollie lists is for `amount` in `currency`. */
export function refundMatches(refund: { amount: MollieAmount }, amount: Prisma.Decimal, currency: Currency): boolean {
  return refund.amount.currency === currency && new Prisma.Decimal(refund.amount.value).equals(amount);
}

/** An intent row that has no Mollie refund id yet. */
export type AwaitingRow = { id: string; amount: Prisma.Decimal; requestedAt: Date };

/**
 * What a sync does with a refund Mollie lists that no row holds, given the
 * attempt's rows still awaiting a Mollie id. `ignore`: there is no such row,
 * or none old enough matches the amount, so the refund was made in Mollie's
 * own dashboard. `defer`: every awaiting row is younger than
 * `ADOPT_AFTER_MS`, so its call may still store the id. `adopt`: the oldest
 * old-enough row whose amount and currency match.
 */
export type Adoption<T extends AwaitingRow> = { kind: 'adopt'; row: T } | { kind: 'defer' } | { kind: 'ignore' };

export function adoptionFor<T extends AwaitingRow>(
  awaiting: readonly T[],
  refund: { amount: MollieAmount },
  currency: Currency,
  now: Date,
): Adoption<T> {
  if (awaiting.length === 0) return { kind: 'ignore' };
  const old = awaiting.filter((row) => now.getTime() - row.requestedAt.getTime() >= ADOPT_AFTER_MS);
  if (old.length === 0) return { kind: 'defer' };
  const match = old
    .filter((row) => refundMatches(refund, row.amount, currency))
    .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime())[0];
  return match === undefined ? { kind: 'ignore' } : { kind: 'adopt', row: match };
}
