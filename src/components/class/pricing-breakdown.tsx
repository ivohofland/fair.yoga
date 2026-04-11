import type { Class, Registration, Payment } from '@prisma/client';

type RegistrationWithStudentAndPayment = Registration & {
  student: { firstName: string; lastName: string };
  payment: Payment | null;
  displayName?: string;
};

type ClassWithRegistrations = Class & {
  registrations: RegistrationWithStudentAndPayment[];
};

interface PricingBreakdownProps {
  cls: ClassWithRegistrations;
}

export function PricingBreakdown({ cls }: PricingBreakdownProps) {
  const totalRevenue = cls.totalRevenue ? Number(cls.totalRevenue) : 0;
  const roomCost = Number(cls.roomCost);
  const teacherEarnings = totalRevenue - roomCost;
  const effectiveTeacherRate = cls.effectiveTeacherRate
    ? Number(cls.effectiveTeacherRate)
    : 0;
  const totalStudents = cls.totalStudents ?? 0;

  const activeRegistrations = cls.registrations.filter(
    (r) => r.status !== 'cancelled',
  );

  return (
    <div className="py-6">
      <h2 className="font-heading text-lg font-bold text-dark mb-4">
        Pricing Breakdown
      </h2>

      {/* Teacher earnings — most prominent element */}
      <div className="py-4 border-b border-border">
        <span className="text-sm text-brown">Your earnings</span>
        <p className="font-heading text-3xl font-bold text-teal mt-1">
          &euro;{teacherEarnings.toFixed(2)}
        </p>
      </div>

      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Room cost</span>
        <span className="text-dark">&euro;{roomCost.toFixed(2)}</span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Effective teacher rate</span>
        <span className="text-dark font-semibold">
          &euro;{effectiveTeacherRate.toFixed(2)}/student
        </span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Students charged</span>
        <span className="text-dark">{totalStudents}</span>
      </div>
      <div className="py-2 border-b border-border flex justify-between text-sm">
        <span className="text-brown">Total revenue</span>
        <span className="text-dark font-semibold">
          &euro;{totalRevenue.toFixed(2)}
        </span>
      </div>

      {/* Per-student breakdown */}
      {activeRegistrations.length > 0 && (
        <div className="mt-4">
          <h3 className="text-sm text-brown mb-2">Per-student breakdown</h3>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left text-brown py-2 font-normal">Student</th>
                <th className="text-left text-brown py-2 font-normal">Tier</th>
                <th className="text-left text-brown py-2 font-normal">Ratio</th>
                <th className="text-right text-brown py-2 font-normal">Price</th>
              </tr>
            </thead>
            <tbody>
              {activeRegistrations.map((r) => (
                <tr key={r.id} className="border-b border-border">
                  <td className="py-2 text-dark">
                    {r.displayName ?? `${r.student.firstName} ${r.student.lastName.charAt(0)}.`}
                  </td>
                  <td className="py-2 text-dark">{r.tierAtBooking}</td>
                  <td className="py-2 text-dark">
                    {r.tierRatio ? `${Number(r.tierRatio).toFixed(2)}\u00D7` : '\u2014'}
                  </td>
                  <td className="py-2 text-right font-semibold text-teal">
                    {r.price ? `\u20AC${Number(r.price).toFixed(2)}` : '\u2014'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
