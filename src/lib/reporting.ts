import type { Currency, Prisma, PricingMode } from '@/lib/prisma-client';
import { formatMonthLabel } from '@/lib/format';
import { orZero, totalsByCurrency, type MoneyTotals } from '@/lib/money-totals';
import { teacherEarningsCents } from '@/lib/teacher-earnings';
import { includedVatCents, vatThousandths } from '@/lib/vat';

export interface ReportClass {
  currency: Currency;
  pricingMode: PricingMode;
  roomCost: Prisma.Decimal;
  vatPercent: Prisma.Decimal;
  totalRevenue: Prisma.Decimal | null;
  vatTotal: Prisma.Decimal | null;
  donationTotal: Prisma.Decimal | null;
  totalStudents: number | null;
  calendarEntry: { date: Date };
}

export interface ReportStudioClass {
  currency: Currency;
  hourlyRate: Prisma.Decimal;
  studentCount: number | null;
  calendarEntry: { date: Date; durationMinutes: number };
}

/**
 * `donation` and `unrecordedDonationCount` carry what is known: a donation
 * class without a recorded total is counted, and contributes to no earnings
 * list. `donation` is empty, not zero, when nothing was recorded.
 */
export interface Report {
  total: MoneyTotals;
  tiered: MoneyTotals;
  donation: MoneyTotals;
  unrecordedDonationCount: number;
  studio: MoneyTotals;
  roomCosts: MoneyTotals;
  classCount: number;
  months: { label: string; classes: number; students: number; earnings: MoneyTotals }[];
}

function monthKey(date: Date): string {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth()).padStart(2, '0')}`;
}

const toCents = (val: Prisma.Decimal | number | string | null | undefined): number =>
  Math.round(Number(val ?? 0) * 100);

/** What one class earned, or null when nothing is known (an unrecorded donation class). */
export function classEarningsCents(c: ReportClass): number | null {
  const roomCents = toCents(c.roomCost);
  switch (c.pricingMode) {
    case 'tiered':
      return teacherEarningsCents({
        totalCents: toCents(c.totalRevenue),
        roomCents,
        vatCents: toCents(c.vatTotal),
      });
    case 'donation': {
      if (c.donationTotal === null) return null;
      const totalCents = toCents(c.donationTotal);
      return teacherEarningsCents({
        totalCents,
        roomCents,
        vatCents: includedVatCents(totalCents, vatThousandths(Number(c.vatPercent))),
      });
    }
    default: {
      const unreachable: never = c.pricingMode;
      return unreachable;
    }
  }
}

const studioEarningsCents = (s: ReportStudioClass): number =>
  Math.round((toCents(s.hourlyRate) * s.calendarEntry.durationMinutes) / 60);

export function buildReport(
  classes: readonly ReportClass[],
  studio: readonly ReportStudioClass[],
  fallback: Currency,
): Report {
  // Every figure is a list of per-currency totals: an amount is never added
  // to one in another currency (`money-totals.ts`).
  const known = classes.flatMap((c) => {
    const cents = classEarningsCents(c);
    return cents === null ? [] : [{ c, currency: c.currency, amount: cents / 100 }];
  });
  const tieredEarnings = known.filter((k) => k.c.pricingMode === 'tiered');
  const donationEarnings = known.filter((k) => k.c.pricingMode === 'donation');
  const studioEarnings = studio.map((s) => ({ currency: s.currency, amount: studioEarningsCents(s) / 100 }));

  const byMonth = new Map<
    string,
    { classes: number; students: number; earnings: { currency: Currency; amount: number }[] }
  >();
  const month = (date: Date) => {
    const key = monthKey(date);
    const entry = byMonth.get(key) ?? { classes: 0, students: 0, earnings: [] };
    byMonth.set(key, entry);
    return entry;
  };
  for (const c of classes) {
    const entry = month(c.calendarEntry.date);
    entry.classes += 1;
    entry.students += c.totalStudents ?? 0;
    const cents = classEarningsCents(c);
    if (cents !== null) entry.earnings.push({ currency: c.currency, amount: cents / 100 });
  }
  for (const s of studio) {
    const entry = month(s.calendarEntry.date);
    entry.classes += 1;
    entry.students += s.studentCount ?? 0;
    entry.earnings.push({ currency: s.currency, amount: studioEarningsCents(s) / 100 });
  }

  return {
    total: orZero(totalsByCurrency([...known, ...studioEarnings], fallback), fallback),
    tiered: orZero(totalsByCurrency(tieredEarnings, fallback), fallback),
    donation: totalsByCurrency(donationEarnings, fallback),
    unrecordedDonationCount: classes.filter(
      (c) => c.pricingMode === 'donation' && c.donationTotal === null,
    ).length,
    studio: orZero(totalsByCurrency(studioEarnings, fallback), fallback),
    roomCosts: orZero(
      totalsByCurrency(
        classes.map((c) => ({ currency: c.currency, amount: toCents(c.roomCost) / 100 })),
        fallback,
      ),
      fallback,
    ),
    classCount: classes.length + studio.length,
    // Last six calendar months, newest first
    months: [...byMonth.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .slice(0, 6)
      .map(([key, v]) => {
        const [year, mon] = key.split('-');
        return {
          label: formatMonthLabel(Number(year), Number(mon)),
          classes: v.classes,
          students: v.students,
          earnings: orZero(totalsByCurrency(v.earnings, fallback), fallback),
        };
      }),
  };
}
