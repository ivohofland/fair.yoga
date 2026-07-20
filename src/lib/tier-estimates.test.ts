import { describe, it, expect } from 'vitest';
import { estimateTierPrices, type TierEstimateInput } from './tier-estimates';
import { calculateClassPricing } from '@/services/pricing';

// The layer between the pricing engine and the public price quote: the
// engine itself is covered in services/pricing.test.ts, so these tests pin
// the glue — padding, the joining-student index, and the public-page
// allocation clamp.

const base: TierEstimateInput = {
  roomCost: 20,
  minRate: 15,
  targetRate: 25,
  minStudents: 2,
  maxStudents: 10,
  registeredTiers: [],
};

describe('estimateTierPrices', () => {
  it('returns five prices, strictly increasing with tier', () => {
    const prices = estimateTierPrices(base);

    expect(prices).toHaveLength(5);
    for (let i = 1; i < prices.length; i++) {
      expect(prices[i]!).toBeGreaterThan(prices[i - 1]!);
    }
  });

  it('pads an empty class up to the minimum with median-tier students', () => {
    const prices = estimateTierPrices(base);

    // With no sign-ups the quoted roster must be [you, 3] — the engine run
    // on that roster, priced at your index — never the solo price.
    for (let tier = 1; tier <= 5; tier++) {
      const expected = calculateClassPricing({
        roomCost: 20,
        minRate: 15,
        targetRate: 25,
        minStudents: 2,
        maxStudents: 10,
        studentTiers: [tier, 3],
      }).studentPrices[0]!;
      expect(prices[tier - 1]!).toBe(expected);
    }
  });

  it('does not pad once the roster reaches the minimum', () => {
    const prices = estimateTierPrices({ ...base, registeredTiers: [2, 4] });

    // Roster is [2, 4, you] — three students, no median padding.
    const expected = calculateClassPricing({
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 2,
      maxStudents: 10,
      studentTiers: [2, 4, 1],
    }).studentPrices[2]!;
    expect(prices[0]!).toBe(expected);
  });

  it('quotes the joining student, not a registered one', () => {
    // Registered [5, 1], you join at tier 3: your price is index 2. An
    // off-by-one would quote the tier-5 or tier-1 student instead, and
    // those prices all differ.
    const prices = estimateTierPrices({ ...base, registeredTiers: [5, 1] });

    const engine = calculateClassPricing({
      roomCost: 20,
      minRate: 15,
      targetRate: 25,
      minStudents: 2,
      maxStudents: 10,
      studentTiers: [5, 1, 3],
    }).studentPrices;
    expect(prices[2]!).toBe(engine[2]!);
    expect(prices[2]!).not.toBe(engine[0]!);
    expect(prices[2]!).not.toBe(engine[1]!);
  });

  it('clamps a pathological stored minimum to MAX_CLASS_SIZE', () => {
    // This runs on a public page: a corrupt minStudents must not size the
    // padding loop. The clamp caps the roster and the call still returns
    // five finite prices.
    const prices = estimateTierPrices({ ...base, minStudents: 100_000, maxStudents: 100_000 });

    expect(prices).toHaveLength(5);
    for (const price of prices) {
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThan(0);
    }
  });
});
