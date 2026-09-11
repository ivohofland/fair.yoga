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
        { id: 'r1', studentId: 'other', tierAtBooking: 3, status: 'registered' },
      ],
      viewer: { studentId: 's1', tier: 4, tierSelectedAt: new Date() },
    });
    expect(result.kind).toBe('personal');
  });

  it('returns personal at the STAMPED registration tier, not the current profile tier, once booked', () => {
    const bookedAtTier1 = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'own', studentId: 's1', tierAtBooking: 1, status: 'registered' },
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
        { id: 'own', studentId: 's1', tierAtBooking: 99, status: 'registered' },
      ],
      viewer: { studentId: 's1', tier: 3, tierSelectedAt: new Date() },
    });
    expect(result.kind).toBe('anonymous');
  });

  it('quotes the current profile tier, not the stale stamped one, when the own registration is late_cancel', () => {
    const lateCancelled = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'own', studentId: 's1', tierAtBooking: 1, status: 'late_cancel' },
      ],
      // Profile tier has since changed to 5 — a late-cancelled row is not a
      // billed booking, so it must not leak its stale tier into the quote.
      viewer: { studentId: 's1', tier: 5, tierSelectedAt: new Date() },
    });
    const neverBookedAtTier5 = resolvePriceLine({
      ...BASE,
      registrations: [],
      viewer: { studentId: 's1', tier: 5, tierSelectedAt: new Date() },
    });
    expect(lateCancelled.kind).toBe('personal');
    expect(neverBookedAtTier5.kind).toBe('personal');
    if (lateCancelled.kind === 'personal' && neverBookedAtTier5.kind === 'personal') {
      // Same viewer tier (5), same otherwise-empty pool -> same spread,
      // proving the late-cancelled row was excluded from the pool AND its
      // stale stamped tier (1) was not quoted — the profile tier (5) was.
      expect(lateCancelled.spread).toEqual(neverBookedAtTier5.spread);
    }
  });

  it('excludes a booked-but-tier-unknown viewer\'s own row from the anonymous pool', () => {
    // Booked (present in `registrations`) but `tierSelectedAt` is null — a
    // teacher-added roster entry the student hasn't picked a tier for yet.
    // `resolvePriceLine` must not count this viewer twice: once as their own
    // row already in `registrations`, again as the hypothetical joiner
    // `estimateTierPrices` appends internally.
    const bookedTierUnknown = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'other', studentId: 'other', tierAtBooking: 3, status: 'registered' },
        { id: 'own', studentId: 's1', tierAtBooking: 2, status: 'registered' },
      ],
      viewer: { studentId: 's1', tier: null, tierSelectedAt: null },
    });
    const unbookedSamePool = resolvePriceLine({
      ...BASE,
      registrations: [
        { id: 'other', studentId: 'other', tierAtBooking: 3, status: 'registered' },
      ],
      viewer: { studentId: 's2', tier: null, tierSelectedAt: null },
    });
    expect(bookedTierUnknown.kind).toBe('anonymous');
    expect(unbookedSamePool.kind).toBe('anonymous');
    if (bookedTierUnknown.kind === 'anonymous' && unbookedSamePool.kind === 'anonymous') {
      // Same other registrant, own row excluded either way -> same estimates,
      // proving the viewer's own row was not double-counted.
      expect(bookedTierUnknown.estimates).toEqual(unbookedSamePool.estimates);
    }
  });
});
