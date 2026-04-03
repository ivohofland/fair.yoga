/**
 * Pricing Engine — Pure calculation, no side effects.
 *
 * Income-based pricing with compressed tier spread and scaling teacher rate.
 * This is the economic heart of the platform.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Income tier ratios. Tier 3 is baseline (1.0). Max spread ~2.08×. */
export const TIER_RATIOS: Record<number, number> = {
  1: 0.65,
  2: 0.80,
  3: 1.00,
  4: 1.20,
  5: 1.35,
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeacherRateInput {
  studentCount: number;
  minStudents: number;
  maxStudents: number;
  minRate: number;
  targetRate: number;
}

export interface ClassPricingInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** Array of tier values (1-5), one per charged student. */
  studentTiers: number[];
}

export interface PricingResult {
  effectiveTeacherRate: number;
  totalCost: number;
  studentCount: number;
  /** Price per student, same order as input tiers. */
  studentPrices: number[];
  /** Ratio per student, same order as input tiers. */
  studentTierRatios: number[];
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Calculate the effective teacher rate based on student count.
 *
 * Linearly interpolates between minRate (at minStudents) and targetRate
 * (at maxStudents). Clamped: at or below minStudents -> minRate;
 * at or above maxStudents -> targetRate.
 */
export function calculateEffectiveTeacherRate(
  input: TeacherRateInput,
): number {
  const { studentCount, minStudents, maxStudents, minRate, targetRate } = input;

  if (studentCount <= minStudents) return minRate;
  if (studentCount >= maxStudents) return targetRate;

  // Linear interpolation
  const ratio = (studentCount - minStudents) / (maxStudents - minStudents);
  return minRate + (targetRate - minRate) * ratio;
}

/**
 * Calculate full class pricing — teacher rate, total cost, and per-student prices.
 *
 * Formulas:
 *   effective_teacher_rate = interpolated between min and target based on count
 *   total_class_cost = room_cost + (effective_teacher_rate × student_count)
 *   base_unit = total_class_cost / sum_of_all_tier_ratios
 *   student_price = base_unit × student_tier_ratio
 */
export function calculateClassPricing(
  input: ClassPricingInput,
): PricingResult {
  const {
    roomCost,
    minRate,
    targetRate,
    minStudents,
    maxStudents,
    studentTiers,
  } = input;

  if (studentTiers.length === 0) {
    return {
      effectiveTeacherRate: 0,
      totalCost: 0,
      studentCount: 0,
      studentPrices: [],
      studentTierRatios: [],
    };
  }

  const studentCount = studentTiers.length;

  // 1. Effective teacher rate
  const effectiveTeacherRate = calculateEffectiveTeacherRate({
    studentCount,
    minStudents,
    maxStudents,
    minRate,
    targetRate,
  });

  // 2. Total class cost
  const totalCost = roomCost + effectiveTeacherRate * studentCount;

  // 3. Look up tier ratios for each student
  const studentTierRatios = studentTiers.map((tier) => {
    const ratio = TIER_RATIOS[tier];
    if (ratio === undefined) {
      throw new Error(`Invalid tier: ${tier}. Must be 1-5.`);
    }
    return ratio;
  });

  // 4. Sum of all tier ratios
  const sumOfTierRatios = studentTierRatios.reduce((sum, r) => sum + r, 0);

  // 5. Base unit and per-student prices
  const baseUnit = totalCost / sumOfTierRatios;
  const studentPrices = studentTierRatios.map(
    (ratio) => Math.round(baseUnit * ratio * 100) / 100,
  );

  return {
    effectiveTeacherRate,
    totalCost,
    studentCount,
    studentPrices,
    studentTierRatios,
  };
}
