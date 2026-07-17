import type { Class, Registration, Student } from '@prisma/client';
import { calculateClassPricing, TIER_RATIOS } from '@/services/pricing';

type RegistrationWithStudent = Registration & { student: Student };

type ClassWithRegistrations = Class & {
  registrations: RegistrationWithStudent[];
};

interface PricingPreviewProps {
  cls: ClassWithRegistrations;
}

export function PricingPreview({ cls }: PricingPreviewProps) {
  const activeRegistrations = cls.registrations.filter(
    (r) => r.status !== 'cancelled',
  );

  if (activeRegistrations.length === 0) {
    return (
      <div className="py-6">
        <h2 className="type-subtitle mb-3">Pricing preview</h2>
        <p className="type-body">
          Pricing preview will appear when students register.
        </p>
      </div>
    );
  }

  const studentTiers = activeRegistrations.map((r) => r.tierAtBooking);

  const pricing = calculateClassPricing({
    roomCost: Number(cls.roomCost),
    minRate: Number(cls.minRate),
    targetRate: Number(cls.targetRate),
    minStudents: cls.minStudents,
    maxStudents: cls.maxStudents,
    studentTiers,
  });

  // Build a summary by tier for preview display
  const tierSummary: { tier: number; ratio: number; price: number; count: number }[] = [];
  for (let tier = 1; tier <= 5; tier++) {
    const indices = studentTiers
      .map((t, i) => (t === tier ? i : -1))
      .filter((i) => i !== -1);

    if (indices.length > 0) {
      const firstIndex = indices[0]!;
      const ratio = TIER_RATIOS[tier];
      const price = pricing.studentPrices[firstIndex];
      if (ratio !== undefined && price !== undefined) {
        tierSummary.push({ tier, ratio, price, count: indices.length });
      }
    }
  }

  const estimatedEarnings = pricing.totalCost - Number(cls.roomCost);

  return (
    <div className="py-6">
      <h2 className="type-subtitle mb-1">Pricing estimate</h2>
      <p className="type-caption mb-4">
        Based on {activeRegistrations.length} registered student{activeRegistrations.length !== 1 ? 's' : ''}
      </p>

      {/* Estimated earnings — most prominent */}
      <div className="bg-teal-tint rounded-card p-5 text-center">
        <span className="type-label">Estimated earnings</span>
        <p className="type-number text-[28px] leading-[1.25] mt-1">
          &euro;{estimatedEarnings.toFixed(2)}
        </p>
      </div>

      <div className="mt-4">
        <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
          <span className="type-body">Room cost</span>
          <span className="tabular-nums text-brown">&euro;{Number(cls.roomCost).toFixed(2)}</span>
        </div>
        <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
          <span className="type-body">Students</span>
          <span className="tabular-nums text-ink">{cls.minStudents} min &middot; {cls.maxStudents} max</span>
        </div>
        <div className="min-h-12 py-2 border-b border-border flex justify-between items-center">
          <span className="type-body">Rate</span>
          <span className="tabular-nums text-ink">&euro;{Number(cls.minRate).toFixed(2)} &ndash; &euro;{Number(cls.targetRate).toFixed(2)}</span>
        </div>
      </div>

      {/* Per-tier prices */}
      <div className="mt-5">
        <h3 className="type-label mb-1">Price per tier</h3>
        {tierSummary.map((row) => (
          <div key={row.tier} className="flex justify-between items-center min-h-12 py-2 border-b border-border last:border-b-0">
            <span className="type-body">
              Tier {row.tier}
              <span className="type-caption ml-1.5">{row.count} {row.count === 1 ? 'student' : 'students'}</span>
            </span>
            <span className="type-number">&euro;{row.price.toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
