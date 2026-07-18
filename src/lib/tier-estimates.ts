import { calculateClassPricing } from '@/services/pricing';
import { MAX_CLASS_SIZE } from '@/lib/schemas';

export interface TierEstimateInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** Tiers of everyone currently registered (charged statuses). */
  registeredTiers: number[];
}

/**
 * "What would I pay?" — for each tier 1..5, the price if the class ran with
 * today's sign-ups plus you. The real formula on real registrations, with
 * one honest assumption: a class below its minimum is padded with
 * median-tier students up to the minimum, because below that it simply
 * doesn't run — quoting the solo price of an empty class would be
 * technically true and practically wrong.
 */
export function estimateTierPrices(input: TierEstimateInput): number[] {
  // The schema caps minStudents, but this runs on a public page — never
  // trust a stored value enough to size an allocation loop with it.
  const paddedMin = Math.min(input.minStudents, MAX_CLASS_SIZE);
  const prices: number[] = [];
  for (let tier = 1; tier <= 5; tier++) {
    const tiers = [...input.registeredTiers, tier];
    while (tiers.length < paddedMin) {
      tiers.push(3);
    }
    const pricing = calculateClassPricing({
      roomCost: input.roomCost,
      minRate: input.minRate,
      targetRate: input.targetRate,
      minStudents: input.minStudents,
      maxStudents: input.maxStudents,
      studentTiers: tiers,
    });
    // The joining student is at index registeredTiers.length.
    prices.push(pricing.studentPrices[input.registeredTiers.length]!);
  }
  return prices;
}
