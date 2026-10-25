import { describe, it, expect } from 'vitest';
import { Prisma } from '@/lib/prisma-client';
import { buildReport, classEarningsCents, type ReportClass, type ReportStudioClass } from './reporting';

const d = (v: string) => new Prisma.Decimal(v);
const base = {
  currency: 'EUR',
  roomCost: d('20.00'),
  vatPercent: d('0'),
  totalStudents: 4,
  calendarEntry: { date: new Date('2026-06-03T00:00:00Z') },
} as const;
const tiered = { ...base, pricingMode: 'tiered', totalRevenue: d('60.00'), vatTotal: d('0'), donationTotal: null } as const;
const recorded = { ...base, pricingMode: 'donation', totalRevenue: null, vatTotal: null, donationTotal: d('50.00') } as const;
const recordedVat = { ...recorded, vatPercent: d('21'), donationTotal: d('60.50') } as const;
const unrecorded = { ...base, pricingMode: 'donation', totalRevenue: null, vatTotal: null, donationTotal: null } as const;

describe('classEarningsCents', () => {
  it('a tiered class earns its total less room and VAT (#912)', () => {
    expect(classEarningsCents(tiered)).toBe(4000);
  });
  it('a recorded donation class earns its total less room and the VAT contained in it (#912)', () => {
    expect(classEarningsCents(recorded)).toBe(3000);
    expect(classEarningsCents(recordedVat)).toBe(6050 - 2000 - 1050);
  });
  it('an unrecorded donation class earns null, never -roomCost (#912)', () => {
    expect(classEarningsCents(unrecorded)).toBeNull();
  });
});

describe('buildReport', () => {
  it('reports each line, counts the unrecorded and keeps them out of every earnings figure (#912)', () => {
    const r = buildReport([tiered, recorded, unrecorded], [], 'EUR');
    expect(r.tiered).toEqual([{ currency: 'EUR', cents: 4000 }]);
    expect(r.donation).toEqual([{ currency: 'EUR', cents: 3000 }]);
    expect(r.unrecordedDonationCount).toBe(1);
    expect(r.total).toEqual([{ currency: 'EUR', cents: 7000 }]);
    expect(r.roomCosts).toEqual([{ currency: 'EUR', cents: 6000 }]);
    expect(r.classCount).toBe(3);
    expect(r.months[0]).toMatchObject({ classes: 3, students: 12, earnings: [{ currency: 'EUR', cents: 7000 }] });
  });

  it('groups the donation line per currency (#912)', () => {
    const gbp: ReportClass = { ...recorded, currency: 'GBP', donationTotal: d('35.00') };
    const r = buildReport([recorded, gbp], [], 'EUR');
    expect(r.donation).toEqual([
      { currency: 'EUR', cents: 3000 },
      { currency: 'GBP', cents: 1500 },
    ]);
  });

  it('an only-unrecorded teacher has no donation figure, not a zero one (#912)', () => {
    const r = buildReport([unrecorded], [], 'EUR');
    expect(r.donation).toEqual([]);
    expect(r.unrecordedDonationCount).toBe(1);
    expect(r.classCount).toBe(1);
  });

  it('keeps tiered and studio numbers exactly as the page computed them (#912)', () => {
    const studio: ReportStudioClass = {
      currency: 'EUR',
      hourlyRate: d('45.00'),
      studentCount: 8,
      calendarEntry: { date: new Date('2026-06-15T00:00:00Z'), durationMinutes: 90 },
    };
    const july: ReportClass = {
      ...tiered,
      totalRevenue: d('119.90'),
      vatPercent: d('9'),
      vatTotal: d('9.90'),
      roomCost: d('30.00'),
      totalStudents: 2,
      calendarEntry: { date: new Date('2026-07-10T00:00:00Z') },
    };
    const r = buildReport([tiered, july], [studio], 'EUR');
    expect(r.tiered).toEqual([{ currency: 'EUR', cents: 4000 + 8000 }]);
    expect(r.studio).toEqual([{ currency: 'EUR', cents: 6750 }]);
    expect(r.total).toEqual([{ currency: 'EUR', cents: 4000 + 8000 + 6750 }]);
    expect(r.roomCosts).toEqual([{ currency: 'EUR', cents: 5000 }]);
    expect(r.classCount).toBe(3);
    expect(r.months.map((m) => [m.classes, m.students, m.earnings])).toEqual([
      [1, 2, [{ currency: 'EUR', cents: 8000 }]],
      [2, 12, [{ currency: 'EUR', cents: 10750 }]],
    ]);
  });

  it('an empty report reads zero in the fallback currency (#912)', () => {
    const r = buildReport([], [], 'GBP');
    expect(r.total).toEqual([{ currency: 'GBP', cents: 0 }]);
    expect(r.months).toEqual([]);
  });
});
