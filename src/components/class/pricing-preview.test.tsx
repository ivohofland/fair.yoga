import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Prisma } from '@prisma/client';
import { PricingPreview } from './pricing-preview';

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
    // 0 registrations -> 0 students -> minRate (20) applies -> totalCost = 40 + 20 = 60. estimated = 60 - 40 = 20
    render(<PricingPreview cls={makePreviewClass()} />);
    expect(screen.getByText('€20.00')).toBeInTheDocument();
  });

  it('renders negative estimated earnings with minus sign before euro sign', () => {
    // minRate: -4, roomCost: 40 -> totalCost = 40 + (-4) = 36. estimated = 36 - 40 = -4.00 -> −€4.00
    render(
      <PricingPreview
        cls={makePreviewClass({
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
});
