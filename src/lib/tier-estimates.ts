import { calculateClassPricing } from '@/services/pricing';
import { MAX_CLASS_SIZE } from '@/lib/schemas';
import { DEFAULT_INCOME_TIER, type IncomeTier } from '@/lib/tiers';
import type { ClassPricingInput, PricedStudent } from '@/services/pricing';

export interface TierEstimateInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** Tiers of everyone currently registered (charged statuses). */
  registeredTiers: IncomeTier[];
}

/** One estimated price per income tier 1..5 — always exactly five. */
export type TierPrices = [number, number, number, number, number];

/**
 * The tiers a class is priced on: the real ones, then `DEFAULT_INCOME_TIER`
 * seats until the class reaches its minimum. Both the booking page's quote and
 * `completeClass` price through this, so the bill below the minimum is the
 * quote's own arithmetic. The minimum is capped at `MAX_CLASS_SIZE` before it
 * sizes the loop, because the quote runs on a public page.
 */
export function padTiersToMinimum(tiers: readonly IncomeTier[], minStudents: number): IncomeTier[] {
  const target = Math.min(minStudents, MAX_CLASS_SIZE);
  const padded = [...tiers];
  while (padded.length < target) padded.push(DEFAULT_INCOME_TIER);
  return padded;
}

export interface Billing {
  /** One record per real student, in the order given. Padding seats are not here. */
  billed: PricedStudent[];
  billedCents: number;
  /** What the billed students pay, less the room, in whole cents. */
  earningsCents: number;
}

/**
 * What a class bills when it ends: the real students priced inside a pool
 * padded to the minimum, so nobody pays above the quote's share, and the
 * teacher absorbs the shortfall. `completeClass` writes these values and the
 * teacher's estimate shows them, so the two cannot disagree. Padding seats
 * follow every real student, so they only ever take the leftover cents the
 * real students' order would not.
 */
export function billAtLeastMinimum(
  input: Omit<ClassPricingInput, 'studentTiers'>,
  chargedTiers: readonly IncomeTier[],
): Billing {
  const pricing = calculateClassPricing({
    ...input,
    studentTiers: padTiersToMinimum(chargedTiers, input.minStudents),
  });
  const billed = pricing.students.slice(0, chargedTiers.length);
  const billedCents = billed.reduce((sum, s) => sum + Math.round(s.price * 100), 0);
  return { billed, billedCents, earningsCents: billedCents - Math.round(input.roomCost * 100) };
}

/**
 * "What would I pay?" — for each tier 1..5, the price if the class ran with
 * today's sign-ups plus you. The real formula on real registrations, with
 * one honest assumption: a class below its minimum is padded with
 * median-tier students up to the minimum, because below that it simply
 * doesn't run — quoting the solo price of an empty class would be
 * technically true and practically wrong.
 */
export function estimateTierPrices(input: TierEstimateInput): TierPrices {
  const priceForTier = (tier: IncomeTier): number => {
    const tiers = padTiersToMinimum([...input.registeredTiers, tier], input.minStudents);
    const pricing = calculateClassPricing({
      roomCost: input.roomCost,
      minRate: input.minRate,
      targetRate: input.targetRate,
      minStudents: input.minStudents,
      maxStudents: input.maxStudents,
      studentTiers: tiers,
    });
    // The joining student is at index registeredTiers.length. This assertion
    // survives the #39 restructure deliberately: no type can prove an index
    // is in range, and the alternatives (a generic payload through the engine,
    // or reordering the input so the viewer lands last) either complicate the
    // core signature or move which student gets the leftover cent. This site
    // reads only a price, never a paired ratio, so it carries no skew risk.
    return pricing.students[input.registeredTiers.length]!.price;
  };
  return [priceForTier(1), priceForTier(2), priceForTier(3), priceForTier(4), priceForTier(5)];
}

export interface AttendanceSpreadInput extends TierEstimateInput {
  /** The signed-in student's own (already chosen) tier. */
  viewerTier: IncomeTier;
}

export interface AttendanceSpread {
  low: number;
  high: number;
}

/**
 * "What will I actually pay?" — for a student whose tier is settled, the
 * remaining uncertainty is turnout. The viewer's own price at the
 * minimum-viable attendance (you're joining: max(minStudents,
 * registered + 1)) and at a full class; an already-overfull class
 * collapses to a single point, and both bounds clamp to MAX_CLASS_SIZE.
 * Unknown attendees are padded with the median tier 3, as
 * estimateTierPrices does below the class minimum — the ceiling extends
 * that same assumption up to a full room. `low` is not a hard floor:
 * walk-ins beyond capacity can still dilute the price below it.
 *
 * The viewer must NOT already be in `registeredTiers` — this function
 * appends them. A call site quoting an already-registered student
 * excludes their own row and passes that row's tier as `viewerTier`.
 */
export function estimateAttendanceSpread(input: AttendanceSpreadInput): AttendanceSpread {
  const priceAt = (attendance: number): number => {
    const tiers: IncomeTier[] = [...input.registeredTiers, input.viewerTier];
    while (tiers.length < attendance) {
      tiers.push(DEFAULT_INCOME_TIER);
    }
    const pricing = calculateClassPricing({
      roomCost: input.roomCost,
      minRate: input.minRate,
      targetRate: input.targetRate,
      minStudents: input.minStudents,
      maxStudents: input.maxStudents,
      studentTiers: tiers,
    });
    // Same non-null assertion, same reason: see estimateTierPrices above.
    return pricing.students[input.registeredTiers.length]!.price;
  };

  const floor = Math.min(
    Math.max(input.minStudents, input.registeredTiers.length + 1),
    MAX_CLASS_SIZE,
  );
  const ceiling = Math.min(Math.max(input.maxStudents, floor), MAX_CLASS_SIZE);
  const a = priceAt(floor);
  const b = priceAt(ceiling);
  return { low: Math.min(a, b), high: Math.max(a, b) };
}
