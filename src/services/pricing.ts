/**
 * Pricing Engine — Pure calculation, no side effects.
 *
 * Income-based pricing with compressed tier spread and scaling teacher rate.
 * This is the economic heart of the platform.
 */

import { TIER_RATIOS, type IncomeTier } from '@/lib/tiers';

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
  /** One tier per charged student. */
  studentTiers: IncomeTier[];
}

export interface PricedStudent {
  /** The tier this student was charged at. */
  tier: IncomeTier;
  /** The tier ratio applied — TIER_RATIOS[tier]. */
  ratio: number;
  /** This student's price, in whole cents after largest-remainder allocation. */
  price: number;
}

export interface PricingResult {
  effectiveTeacherRate: number;
  totalCost: number;
  studentCount: number;
  /**
   * One record per charged student, in the same order as the input tiers.
   *
   * One array of records rather than parallel `studentPrices` /
   * `studentTierRatios`: those were held in correspondence by a shared index,
   * and a skew between them in the billing loop would charge a student
   * another student's price.
   */
  students: ReadonlyArray<PricedStudent>;
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
 *   effective_teacher_rate = interpolated between min and target based on count (per-class total, not per-student)
 *   total_class_cost = room_cost + effective_teacher_rate
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
      students: [],
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

  // 2. Total class cost (teacher rate is per-class, not per-student)
  const totalCost = roomCost + effectiveTeacherRate;

  // 3. Look up tier ratios for each student. Total by construction —
  // TIER_RATIOS is keyed by IncomeTier, so there is no undefined branch and
  // no runtime check. The `Invalid tier` throw that used to live here is
  // gone, not moved: the type makes it unreachable and the database's
  // income_tier_range_check makes the type honest.
  const studentTierRatios = studentTiers.map((tier) => TIER_RATIOS[tier]);

  // 4. Sum of all tier ratios
  const sumOfTierRatios = studentTierRatios.reduce((sum, r) => sum + r, 0);

  // 5. Base unit and per-student prices.
  // Largest-remainder allocation: naive per-student rounding lets the sum
  // of prices drift a few cents from totalCost, so the teacher's books
  // never reconcile with the sum of payments. Instead, floor every price
  // to whole cents and hand the leftover cents to the students whose
  // exact shares lost the most in flooring (ties broken by queue order).
  const baseUnit = totalCost / sumOfTierRatios;
  const allocations = studentTiers.map((tier, i) => {
    const ratio = TIER_RATIOS[tier];
    const exact = baseUnit * ratio * 100;
    const floored = Math.floor(exact + 1e-9);
    return { i, tier, ratio, remainder: exact - floored, cents: floored };
  });

  let leftover =
    Math.round(totalCost * 100) - allocations.reduce((sum, a) => sum + a.cents, 0);
  for (const a of [...allocations].sort(
    (x, y) => y.remainder - x.remainder || x.i - y.i,
  )) {
    if (leftover <= 0) break;
    a.cents++; // through the shared object reference — no index, no assertion
    leftover--;
  }

  const students: PricedStudent[] = allocations.map((a) => ({
    tier: a.tier,
    ratio: a.ratio,
    price: a.cents / 100,
  }));

  return {
    effectiveTeacherRate,
    totalCost,
    studentCount,
    students,
  };
}
