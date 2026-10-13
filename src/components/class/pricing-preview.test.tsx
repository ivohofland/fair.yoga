import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Prisma } from '@prisma/client';
import { PricingPreview } from './pricing-preview';
import { billAtLeastMinimum } from '@/lib/tier-estimates';
import { formatMoney } from '@/lib/format';

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
    vatTotal: null,
    vatPercent: new Prisma.Decimal(0),
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

  it('below the minimum, shows what completion bills and pays (the live S5 numbers)', () => {
    const cls = makePreviewClass({
      roomCost: new Prisma.Decimal('30.00'),
      minRate: new Prisma.Decimal('10.00'),
      targetRate: new Prisma.Decimal('40.00'),
      minStudents: 4,
      maxStudents: 10,
      registrations: [
        { id: 'r1', status: 'registered', tierAtBooking: 1 },
        { id: 'r2', status: 'registered', tierAtBooking: 3 },
      ],
    });
    render(<PricingPreview cls={cls} />);
    expect(screen.getByText('−€11.92')).toBeInTheDocument();
    expect(screen.getByText('€7.12')).toBeInTheDocument();
    expect(screen.getByText('€10.96')).toBeInTheDocument();
    // The padding seats are not students: only the two real tiers get a row.
    expect(screen.getAllByText(/^Tier \d/)).toHaveLength(2);
  });

  it('prices only the charged statuses, as completion does', () => {
    const cls = makePreviewClass({
      minStudents: 1,
      registrations: [
        { id: 'r1', status: 'registered', tierAtBooking: 3 },
        { id: 'r2', status: 'cancelled', tierAtBooking: 1 },
        { id: 'r3', status: 'late_cancel', tierAtBooking: 2 },
      ],
    });
    render(<PricingPreview cls={cls} />);
    expect(screen.getByText(/Based on 2 registered students$/)).toBeInTheDocument();
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
    const { billed } = billAtLeastMinimum(
      { roomCost: 20, minRate: 40, targetRate: 80, minStudents: 2, maxStudents: 10 },
      [2, 4],
    );
    render(<PricingPreview cls={cls} />);
    expect(screen.getByText('€40.00')).toBeInTheDocument();
    expect(screen.getByText(formatMoney(billed[0]!.price, 'EUR'))).toBeInTheDocument();
  });
});
