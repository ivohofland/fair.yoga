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
        <h2 className="font-heading text-lg font-bold text-dark mb-3">
          Pricing Preview
        </h2>
        <p className="text-brown text-sm">
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
      <h2 className="font-heading text-lg font-bold text-dark mb-3">
        Pricing Estimate
      </h2>
      <p className="text-brown text-xs mb-4">
        Based on {activeRegistrations.length} registered student{activeRegistrations.length !== 1 ? 's' : ''}
      </p>

      {/* Estimated earnings — most prominent */}
      <div className="py-4 border-b border-border">
        <span className="text-sm text-brown">Estimated earnings</span>
        <p className="font-heading text-3xl font-bold text-teal mt-1">
          &euro;{estimatedEarnings.toFixed(2)}
        </p>
      </div>

      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Room cost</span>
        <span className="text-dark">&euro;{Number(cls.roomCost).toFixed(2)}</span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Students</span>
        <span className="text-dark">{cls.minStudents} min &middot; {cls.maxStudents} max</span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Rate</span>
        <span className="text-dark">&euro;{Number(cls.minRate).toFixed(2)} &ndash; &euro;{Number(cls.targetRate).toFixed(2)}</span>
      </div>

      {/* Per-tier prices */}
      <div className="mt-4">
        <h3 className="text-sm text-brown mb-2">Price per tier</h3>
        {tierSummary.map((row) => (
          <div key={row.tier} className="flex justify-between py-2 border-b border-border text-sm">
            <span className="text-dark">
              Tier {row.tier}
              <span className="text-brown text-xs ml-1">({row.count})</span>
            </span>
            <span className="font-semibold text-teal">
              &euro;{row.price.toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
