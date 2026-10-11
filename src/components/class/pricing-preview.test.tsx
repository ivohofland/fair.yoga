import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Prisma } from '@prisma/client';
import { PricingPreview } from './pricing-preview';
import { calculateClassPricing } from '@/services/pricing';
import { formatMoney } from '@/lib/format';
import type { IncomeTier } from '@/lib/tiers';

type PricingPreviewCls = Parameters<typeof PricingPreview>[0]['cls'];

function makePreviewClass(overrides: Partial<PricingPreviewCls> = {}): PricingPreviewCls {
  return {
    id: 'cls-preview-1',
    calendarEntryId: 'entry-1',
    kind: 'regular',
    teacherRoomId: 'tr-1',
    entryLive: true,
    roomArchived: false,
    description: null,
    currency: 'EUR',
    roomCost: new Prisma.Decimal('40.00'),
    minRate: new Prisma.Decimal('20.00'),
    targetRate: new Prisma.Decimal('60.00'),
    minStudents: 5,
    maxStudents: 15,
    cancelDeadline: 'HOURS_24',
    autoCancelCheck: 'HOURS_2',
    status: 'open',
    settingsLocked: false,
    effectiveTeacherRate: null,
    totalRevenue: null,
    totalStudents: null,
    spotBroadcastAt: null,
    autoCancelDecidedAt: null,
    teacherReminderSentAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    registrations: [
      {
        id: 'reg-1',
        status: 'registered',
        tierAtBooking: 3,
      },
    ],
    ...overrides,
  };
}

describe('PricingPreview', () => {
  it('renders positive estimated earnings with euro sign', () => {
    // 1 student at a minimum of 1 -> minRate (20) applies -> totalCost = 40 + 20 = 60. estimated = 60 - 40 = 20
    render(<PricingPreview cls={makePreviewClass({ minStudents: 1 })} />);
    expect(screen.getByText('€20.00')).toBeInTheDocument();
  });

  it('renders negative estimated earnings with minus sign before euro sign', () => {
    // minRate: -4, roomCost: 40 -> totalCost = 40 + (-4) = 36. estimated = 36 - 40 = -4.00 -> −€4.00
    render(
      <PricingPreview
        cls={makePreviewClass({
          minStudents: 1,
          minRate: new Prisma.Decimal('-4.00'),
          roomCost: new Prisma.Decimal('40.00'),
        })}
      />,
    );
    expect(screen.getByText('−€4.00')).toBeInTheDocument();
  });

  it('renders negative minRate with minus sign before euro sign', () => {
    render(
      <PricingPreview
        cls={makePreviewClass({
          minRate: new Prisma.Decimal('-20.00'),
          targetRate: new Prisma.Decimal('60.00'),
        })}
      />,
    );
    expect(screen.getByText(/−€20\.00\s+–\s+€60\.00/)).toBeInTheDocument();
  });

  // What completeClass bills: the real students priced inside a pool padded
  // with tier-3 seats up to the minimum, the teacher absorbing the shortfall.
  function completionOf(tiers: IncomeTier[], cls: PricingPreviewCls) {
    const pool = [...tiers];
    while (pool.length < cls.minStudents) pool.push(3);
    const pricing = calculateClassPricing({
      roomCost: Number(cls.roomCost),
      minRate: Number(cls.minRate),
      targetRate: Number(cls.targetRate),
      minStudents: cls.minStudents,
      maxStudents: cls.maxStudents,
      studentTiers: pool,
    });
    const billed = pricing.students.slice(0, tiers.length);
    const cents = billed.reduce((sum, s) => sum + Math.round(s.price * 100), 0);
    return { billed, earnings: (cents - Math.round(Number(cls.roomCost) * 100)) / 100 };
  }

  it('below the minimum, estimates what completion would bill and pay', () => {
    const cls = makePreviewClass({
      roomCost: new Prisma.Decimal('60.00'),
      minRate: new Prisma.Decimal('40.00'),
      targetRate: new Prisma.Decimal('80.00'),
      minStudents: 4,
      maxStudents: 10,
      registrations: [
        { id: 'r1', status: 'registered', tierAtBooking: 2 },
        { id: 'r2', status: 'registered', tierAtBooking: 4 },
      ],
    });
    const { billed, earnings } = completionOf([2, 4], cls);
    expect(earnings).toBeLessThan(0);
    render(<PricingPreview cls={cls} />);
    expect(screen.getByText(formatMoney(earnings, 'EUR'))).toBeInTheDocument();
    expect(screen.getByText(formatMoney(billed[0]!.price, 'EUR'))).toBeInTheDocument();
    expect(screen.getByText(formatMoney(billed[1]!.price, 'EUR'))).toBeInTheDocument();
    // The padding seats are not students: no tier row counts them.
    expect(screen.queryByText('Tier 3')).toBeNull();
  });

  it('at the minimum, estimates the unpadded pool', () => {
    const cls = makePreviewClass({
      roomCost: new Prisma.Decimal('20.00'),
      minRate: new Prisma.Decimal('40.00'),
      targetRate: new Prisma.Decimal('80.00'),
      minStudents: 2,
      maxStudents: 10,
      registrations: [
        { id: 'r1', status: 'registered', tierAtBooking: 2 },
        { id: 'r2', status: 'registered', tierAtBooking: 4 },
      ],
    });
    const { billed, earnings } = completionOf([2, 4], cls);
    expect(earnings).toBe(40);
    render(<PricingPreview cls={cls} />);
    expect(screen.getByText('€40.00')).toBeInTheDocument();
    expect(screen.getByText(formatMoney(billed[0]!.price, 'EUR'))).toBeInTheDocument();
  });
});
