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

/** One estimated price per income tier 1..5 — always exactly five. */
export type TierPrices = [number, number, number, number, number];

/**
 * "What would I pay?" — for each tier 1..5, the price if the class ran with
 * today's sign-ups plus you. The real formula on real registrations, with
 * one honest assumption: a class below its minimum is padded with
 * median-tier students up to the minimum, because below that it simply
 * doesn't run — quoting the solo price of an empty class would be
 * technically true and practically wrong.
 */
export function estimateTierPrices(input: TierEstimateInput): TierPrices {
  // The schema caps minStudents, but this runs on a public page — never
  // trust a stored value enough to size an allocation loop with it.
  const paddedMin = Math.min(input.minStudents, MAX_CLASS_SIZE);
  const priceForTier = (tier: number): number => {
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
    return pricing.studentPrices[input.registeredTiers.length]!;
  };
  return [priceForTier(1), priceForTier(2), priceForTier(3), priceForTier(4), priceForTier(5)];
}

export interface AttendanceSpreadInput extends TierEstimateInput {
  /** The signed-in student's own (already chosen) tier. */
  viewerTier: number;
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
    const tiers = [...input.registeredTiers, input.viewerTier];
    while (tiers.length < attendance) {
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
    return pricing.studentPrices[input.registeredTiers.length]!;
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
