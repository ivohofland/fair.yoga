import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Prisma } from '@prisma/client';
import { PricingBreakdown } from './pricing-breakdown';

import type { Class } from '@prisma/client';

function makeClass(overrides: Partial<Class> = {}): Class {
  return {
    id: 'cls-1',
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
    status: 'completed',
    settingsLocked: false,
    effectiveTeacherRate: null,
    totalRevenue: new Prisma.Decimal('90.00'),
    totalStudents: 6,
    spotBroadcastAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('PricingBreakdown', () => {
  it('renders positive teacher earnings with euro sign', () => {
    // 90 revenue - 40 room = 50 earnings
    render(<PricingBreakdown cls={makeClass()} tierPrices={[]} />);
    expect(screen.getByText('€50.00')).toBeInTheDocument();
  });

  it('renders negative teacher earnings with minus sign before euro sign', () => {
    // 36 revenue - 40 room = -4 earnings -> −€4.00
    render(
      <PricingBreakdown
        cls={makeClass({ totalRevenue: new Prisma.Decimal('36.00'), roomCost: new Prisma.Decimal('40.00') })}
        tierPrices={[]}
      />,
    );
    expect(screen.getByText('−€4.00')).toBeInTheDocument();
  });

  it('renders negative minRate with minus sign before euro sign', () => {
    render(
      <PricingBreakdown
        cls={makeClass({ minRate: new Prisma.Decimal('-20.00'), targetRate: new Prisma.Decimal('60.00') })}
        tierPrices={[]}
      />,
    );
    expect(screen.getByText(/−€20\.00\s+–\s+€60\.00/)).toBeInTheDocument();
  });
});
