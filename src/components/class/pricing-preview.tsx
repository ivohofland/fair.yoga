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

  return (
    <div className="py-6">
      <h2 className="font-heading text-lg font-bold text-dark mb-3">
        Pricing Preview
      </h2>
      <p className="text-brown text-xs mb-4">
        Based on {activeRegistrations.length} registered student{activeRegistrations.length !== 1 ? 's' : ''}
      </p>

      <table className="w-full text-sm mb-4">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left text-brown py-2 font-normal">Tier</th>
            <th className="text-left text-brown py-2 font-normal">Ratio</th>
            <th className="text-right text-brown py-2 font-normal">Price</th>
          </tr>
        </thead>
        <tbody>
          {tierSummary.map((row) => (
            <tr key={row.tier} className="border-b border-border">
              <td className="py-2 text-dark">
                Tier {row.tier}
                {row.count > 1 && (
                  <span className="text-brown text-xs ml-1">({row.count})</span>
                )}
              </td>
              <td className="py-2 text-dark">{row.ratio.toFixed(2)}&times;</td>
              <td className="py-2 text-right font-semibold text-teal">
                &euro;{row.price.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Effective teacher rate</span>
        <span className="text-dark font-semibold">
          &euro;{pricing.effectiveTeacherRate.toFixed(2)}/student
        </span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Room cost</span>
        <span className="text-dark">&euro;{Number(cls.roomCost).toFixed(2)}</span>
      </div>
      <div className="py-2 flex justify-between text-sm">
        <span className="text-brown">Total class cost</span>
        <span className="text-dark font-semibold">&euro;{pricing.totalCost.toFixed(2)}</span>
      </div>
    </div>
  );
}
