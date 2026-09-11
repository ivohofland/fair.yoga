import { describe, it, expect } from 'vitest';
import { resolvePriceLine } from './price-line';

const BASE = {
  roomCost: 40,
  minRate: 20,
  targetRate: 120,
  minStudents: 4,
  maxStudents: 8,
};

describe('resolvePriceLine', () => {
  it('returns anonymous when the viewer is signed out', () => {
    const result = resolvePriceLine({
      ...BASE,
      registrations: [],
      viewer: null,
    });
    expect(result.kind).toBe('anonymous');
  });

  it('returns anonymous when the viewer has not chosen a tier yet', () => {
    const result = resolvePriceLine({
      ...BASE,
      registrations: [],
      viewer: { studentId: 's1', tier: 3, tierSelectedAt: null },
    });
    expect(result.kind).toBe('anonymous');
  });

  it('returns personal at the profile tier when the tier is known and the viewer has not booked', () => {
    const result = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'r1', studentId: 'other', tierAtBooking: 3 },
      ],
      viewer: { studentId: 's1', tier: 4, tierSelectedAt: new Date() },
    });
    expect(result.kind).toBe('personal');
  });

  it('returns personal at the STAMPED registration tier, not the current profile tier, once booked', () => {
    const bookedAtTier1 = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'own', studentId: 's1', tierAtBooking: 1 },
      ],
      // Profile tier has since changed to 5 — must not leak into the quote.
      viewer: { studentId: 's1', tier: 5, tierSelectedAt: new Date() },
    });
    const anonymousAtTier1 = resolvePriceLine({
      ...BASE,
      registrations: [],
      viewer: { studentId: 's1', tier: 1, tierSelectedAt: new Date() },
    });
    expect(bookedAtTier1.kind).toBe('personal');
    expect(anonymousAtTier1.kind).toBe('personal');
    if (bookedAtTier1.kind === 'personal' && anonymousAtTier1.kind === 'personal') {
      // Same viewer tier (1), same otherwise-empty pool -> same spread,
      // proving the own registration was excluded from the pool and its
      // stamped tier (not the profile's) was quoted.
      expect(bookedAtTier1.spread).toEqual(anonymousAtTier1.spread);
    }
  });

  it('falls back to anonymous when the own registration tier is corrupt (#158)', () => {
    const result = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'own', studentId: 's1', tierAtBooking: 99 },
      ],
      viewer: { studentId: 's1', tier: 3, tierSelectedAt: new Date() },
    });
    expect(result.kind).toBe('anonymous');
  });
});
