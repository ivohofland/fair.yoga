import { estimateTierPrices, estimateAttendanceSpread, type TierPrices, type AttendanceSpread } from '@/lib/tier-estimates';
import { readIncomeTier, toIncomeTier } from '@/lib/tiers.server';
import type { IncomeTier } from '@/lib/tiers';
import type { RegistrationStatus } from '@prisma/client';

export type PriceLineResult =
  | { kind: 'personal'; spread: AttendanceSpread }
  | { kind: 'anonymous'; estimates: TierPrices };

export interface PriceLineRegistration {
  id: string;
  studentId: string;
  tierAtBooking: number;
  status: RegistrationStatus;
}

export interface PriceLineViewer {
  studentId: string;
  tier: IncomeTier | null;
  tierSelectedAt: Date | null;
}

export interface ResolvePriceLineInput {
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  /** Charged-status registrations for this class — see CHARGED_STATUSES (services/class-lifecycle.ts). */
  registrations: PriceLineRegistration[];
  /** null when signed out, or signed in without a student profile. */
  viewer: PriceLineViewer | null;
}

/**
 * One price-line rule for every surface that shows a class card: personal
 * range once the viewer's tier is settled, anonymous range otherwise —
 * never keyed on whether they've booked. See
 * docs/superpowers/specs/2026-09-11-price-line-unification-design.md.
 */
export function resolvePriceLine(input: ResolvePriceLineInput): PriceLineResult {
  const { roomCost, minRate, targetRate, minStudents, maxStudents, registrations, viewer } = input;

  const ownRegistration = viewer
    ? (registrations.find((r) => r.studentId === viewer.studentId) ?? null)
    : null;

  // A claim about THIS person's price must not be built on a silently
  // substituted tier (#158) — readIncomeTier, not toIncomeTier. A late-cancelled
  // own registration is excluded from the pool below like any other own row,
  // but it does not count as billed: rebooking would stamp a fresh tier, so a
  // stale late-cancelled one must not leak into the quote — the viewer's
  // current profile tier is quoted instead, same as someone who never booked.
  const quotedTier =
    ownRegistration && ownRegistration.status !== 'late_cancel'
      ? readIncomeTier(ownRegistration.tierAtBooking, { registrationId: ownRegistration.id })
      : (viewer?.tier ?? null);

  if (viewer?.tierSelectedAt && quotedTier !== null) {
    const spread = estimateAttendanceSpread({
      roomCost,
      minRate,
      targetRate,
      minStudents,
      maxStudents,
      registeredTiers: registrations
        .filter((r) => r !== ownRegistration)
        .map((r) => toIncomeTier(r.tierAtBooking, { registrationId: r.id })),
      viewerTier: quotedTier,
    });
    return { kind: 'personal', spread };
  }

  // Same pool rule as the personal branch above: the viewer's own
  // registration, if any, is already a person in the room and must not
  // also be the +1 estimateTierPrices appends internally for a
  // hypothetical joiner.
  const estimates = estimateTierPrices({
    roomCost,
    minRate,
    targetRate,
    minStudents,
    maxStudents,
    registeredTiers: registrations
      .filter((r) => r !== ownRegistration)
      .map((r) => toIncomeTier(r.tierAtBooking, { registrationId: r.id })),
  });
  return { kind: 'anonymous', estimates };
}
