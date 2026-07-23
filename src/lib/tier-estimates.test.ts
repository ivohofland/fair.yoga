import { describe, it, expect } from 'vitest';
import { estimateTierPrices, estimateAttendanceSpread, type TierEstimateInput } from './tier-estimates';
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

describe('estimateAttendanceSpread', () => {
  const base = {
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 2,
    maxStudents: 10,
  };

  it('spreads the canonical empty class exactly (viewer tier 3)', () => {
    const spread = estimateAttendanceSpread({ ...base, registeredTiers: [], viewerTier: 3 });
    // Floor: max(2, 0+1) = 2 → [3,3]: rate 15, total 35, tier-3 pays 17.50.
    // Ceiling: 10 → rate 25, total 45, tier-3 pays 4.50.
    expect(spread.high).toBeCloseTo(17.5, 2);
    expect(spread.low).toBeCloseTo(4.5, 2);
  });

  it('accounts for who is already registered', () => {
    const spread = estimateAttendanceSpread({
      ...base,
      registeredTiers: [1, 5],
      viewerTier: 3,
    });
    // Floor: max(2, 2+1) = 3 → [1,5,3]: rate 15+10*(3-2)/8 = 16.25,
    // total 36.25, sum ratios 3.0 → base share 12.0833; largest-remainder
    // flooring pays the viewer exactly 12.08 (the spare cent goes to the
    // tier-1 student, whose remainder is larger).
    expect(spread.high).toBeCloseTo(12.08, 2);
    expect(spread.low).toBeLessThan(spread.high);
  });

  it('quotes the viewer, not a padded attendee (viewer tier 1, exact)', () => {
    const spread = estimateAttendanceSpread({ ...base, registeredTiers: [], viewerTier: 1 });
    // Floor [1,3]: total 35, ratios 1.65 → tier 1 pays 13.79. Ceiling
    // [1, 3×9]: total 45, ratios 9.65 → 3.03. A viewer-indexing bug pays
    // them a padded tier-3 share instead (4.50–17.50) — the tier-3-viewer
    // tests above can't see that, their price equals the padding's.
    expect(spread.high).toBeCloseTo(13.79, 2);
    expect(spread.low).toBeCloseTo(3.03, 2);
  });

  it('clamps a pathological stored min/max to MAX_CLASS_SIZE', () => {
    // Same guard as estimateTierPrices: a corrupt row must not size the
    // padding loop on a public page.
    const spread = estimateAttendanceSpread({
      ...base,
      minStudents: 100_000,
      maxStudents: 100_000,
      registeredTiers: [],
      viewerTier: 3,
    });
    expect(Number.isFinite(spread.low)).toBe(true);
    expect(Number.isFinite(spread.high)).toBe(true);
    expect(spread.low).toBeLessThanOrEqual(spread.high);
  });

  it('collapses to a point when the class is already at capacity', () => {
    const spread = estimateAttendanceSpread({
      ...base,
      maxStudents: 2,
      registeredTiers: [3, 3],
      viewerTier: 3,
    });
    expect(spread.low).toBeCloseTo(spread.high, 5);
  });

  it('never inverts', () => {
    for (const viewerTier of [1, 3, 5]) {
      const spread = estimateAttendanceSpread({ ...base, registeredTiers: [2, 4], viewerTier });
      expect(spread.low).toBeLessThanOrEqual(spread.high);
    }
  });
});
