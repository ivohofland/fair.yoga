import { describe, it, expect } from 'vitest';
import {
  TIER_RATIOS,
  calculateEffectiveTeacherRate,
  calculateClassPricing,
} from './pricing';

describe('TIER_RATIOS', () => {
  it('has 5 tiers with compressed 2x spread', () => {
    expect(Object.keys(TIER_RATIOS)).toHaveLength(5);
    expect(TIER_RATIOS[1]).toBe(0.65);
    expect(TIER_RATIOS[2]).toBe(0.8);
    expect(TIER_RATIOS[3]).toBe(1.0);
    expect(TIER_RATIOS[4]).toBe(1.2);
    expect(TIER_RATIOS[5]).toBe(1.35);
  });

  it('tier 3 is baseline 1.0', () => {
    expect(TIER_RATIOS[3]).toBe(1.0);
  });

  it('max spread is approximately 2.08x', () => {
    const tier1 = TIER_RATIOS[1]!;
    const tier5 = TIER_RATIOS[5]!;
    const spread = tier5 / tier1;
    expect(spread).toBeCloseTo(2.077, 2);
  });
});

describe('calculateEffectiveTeacherRate', () => {
  it('returns min_rate at min_students', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 4,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(15);
  });

  it('returns target_rate at max_students', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 12,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(25);
  });

  it('interpolates linearly between min and max', () => {
    // midpoint: 8 students with min=4, max=12, rate 15-25 → 20
    const rate = calculateEffectiveTeacherRate({
      studentCount: 8,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(20);
  });

  it('caps at target_rate when students exceed max (walk-ins)', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 15,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(25);
  });

  it('floors at min_rate when students below min', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 2,
      minStudents: 4,
      maxStudents: 12,
      minRate: 15,
      targetRate: 25,
    });
    expect(rate).toBe(15);
  });

  it('handles flat rate (min_rate equals target_rate)', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 7,
      minStudents: 4,
      maxStudents: 12,
      minRate: 20,
      targetRate: 20,
    });
    expect(rate).toBe(20);
  });

  it('handles negative min_rate (teacher subsidizes room cost)', () => {
    const rate = calculateEffectiveTeacherRate({
      studentCount: 4,
      minStudents: 4,
      maxStudents: 12,
      minRate: -10,
      targetRate: 25,
    });
    expect(rate).toBe(-10);
  });
});

describe('calculateClassPricing', () => {
  it('calculates seed data scenario correctly', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [1, 1, 2, 3, 3, 4, 4, 5, 5],
    });

    expect(result.studentCount).toBe(9);
    expect(result.effectiveTeacherRate).toBeCloseTo(21.25, 2);
    expect(result.totalCost).toBeCloseTo(226.25, 2);

    // Per-tier prices: T1=15.99, T2=19.67, T3=24.59, T4=29.51, T5=33.20
    expect(result.studentPrices[0]).toBeCloseTo(15.99, 2); // T1
    expect(result.studentPrices[1]).toBeCloseTo(15.99, 2); // T1
    expect(result.studentPrices[2]).toBeCloseTo(19.67, 2); // T2
    expect(result.studentPrices[3]).toBeCloseTo(24.59, 2); // T3
    expect(result.studentPrices[4]).toBeCloseTo(24.59, 2); // T3
    expect(result.studentPrices[5]).toBeCloseTo(29.51, 2); // T4
    expect(result.studentPrices[6]).toBeCloseTo(29.51, 2); // T4
    expect(result.studentPrices[7]).toBeCloseTo(33.20, 2); // T5
    expect(result.studentPrices[8]).toBeCloseTo(33.20, 2); // T5

    // Sum of prices should approximate totalCost
    const sum = result.studentPrices.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - result.totalCost)).toBeLessThan(0.1);
  });

  it('handles single student', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 1,
      maxStudents: 12,
      studentTiers: [3],
    });

    expect(result.studentCount).toBe(1);
    expect(result.effectiveTeacherRate).toBe(15);
    expect(result.totalCost).toBe(50);
    expect(result.studentPrices).toEqual([50]);
  });

  it('handles all same tier', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [3, 3, 3, 3, 3],
    });

    expect(result.studentCount).toBe(5);
    expect(result.effectiveTeacherRate).toBeCloseTo(16.25, 2);
    expect(result.totalCost).toBeCloseTo(116.25, 2);
    // Each pays 116.25 / 5 = 23.25
    for (const price of result.studentPrices) {
      expect(price).toBeCloseTo(23.25, 2);
    }
  });

  it('caps rate at targetRate when walk-ins exceed max', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [1, 1, 2, 2, 3, 3, 3, 4, 4, 5, 5, 5, 5, 5],
    });

    expect(result.studentCount).toBe(14);
    expect(result.effectiveTeacherRate).toBe(25);
  });

  it('handles negative min_rate', () => {
    const result = calculateClassPricing({
      roomCost: 50,
      minRate: -10,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [3, 3, 3, 3],
    });

    expect(result.studentCount).toBe(4);
    expect(result.effectiveTeacherRate).toBe(-10);
    expect(result.totalCost).toBe(10);
  });

  it('handles flat rate', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 20,
      targetRate: 20,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [1, 3, 5],
    });

    expect(result.effectiveTeacherRate).toBe(20);
  });

  it('returns tier ratios in same order as input', () => {
    const result = calculateClassPricing({
      roomCost: 35,
      minRate: 15,
      targetRate: 25,
      minStudents: 4,
      maxStudents: 12,
      studentTiers: [3, 1, 5, 2, 4],
    });

    expect(result.studentTierRatios).toEqual([1.0, 0.65, 1.35, 0.8, 1.2]);
  });

  it('validates pricing simulator scenario', () => {
    const result = calculateClassPricing({
      roomCost: 50,
      minRate: 30,
      targetRate: 55,
      minStudents: 6,
      maxStudents: 14,
      studentTiers: [1, 1, 2, 2, 3, 3, 3, 4, 4, 5],
    });

    expect(result.studentCount).toBe(10);
    expect(result.effectiveTeacherRate).toBeCloseTo(42.5, 2);
    expect(result.totalCost).toBeCloseTo(475, 2);

    // Sum of prices should approximate totalCost
    const sum = result.studentPrices.reduce((a, b) => a + b, 0);
    expect(Math.abs(sum - result.totalCost)).toBeLessThan(0.1);
  });
});
