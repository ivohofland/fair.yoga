import type { ComponentProps } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { PaymentStatus } from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { ClassList } from './class-list';

/**
 * #58 review. `PaymentRollup` (class-list.tsx) had no coverage anywhere — unit,
 * component or e2e — while carrying the branching this branch is named after:
 * a priority order (overdue beats unpaid beats all-paid) and a
 * `payments.length === 0` guard. Tightening `{ status: string }` to
 * `PaymentStatus` protects the *type* flowing in; it cannot protect the order
 * of two `if`s. Swap them and a class with one overdue payment reports
 * "○ N unpaid"; drop the length guard and a completed class with no payments
 * yet reports "✓ all paid" — the exact false all-clear this branch exists to
 * remove — both with a green build.
 *
 * Rendered through `ClassList` rather than `PaymentRollup` directly, because
 * the rollup is not exported and should not become exported for a test (the
 * lesson of `payment-status.ts`). The whole-list route is also what pins the
 * two guards that live in the *caller's* data shape: `registrations` is
 * optional on `ClassWithDetails`, and only the completed lifecycle stage rolls
 * anything up at all.
 *
 * The fixture is a full Prisma `Class` because that is what the prop type is —
 * typed as `ClassList`'s own prop element (`ClassRow`) so no assertion is
 * needed and so a schema change breaks this file rather than silently drifting
 * from it. `Decimal` comes from `@prisma/client/runtime/library`, the pure-JS
 * decimal implementation, not from `@prisma/client` itself: no engine, no
 * database, nothing for jsdom to choke on.
 */
type ClassRow = ComponentProps<typeof ClassList>['classes'][number];

const AT = new Date('2026-06-01T00:00:00.000Z');

const room = {
  id: 'room-1',
  venueName: 'Studio Zen',
  address: 'Prinsengracht 1',
  city: 'Amsterdam',
  postcode: '1015 DK',
  floor: '',
  roomName: 'Big Room',
  maxCapacity: 20,
  equipment: [],
  notes: null,
  isPublic: true,
  createdById: 'teacher-1',
  createdAt: AT,
  updatedAt: AT,
};

const teacherRoom = {
  id: 'tr-1',
  teacherId: 'teacher-1',
  roomId: 'room-1',
  capacityOverride: 12,
  rentalRate: new Decimal(20),
  equipmentNotes: null,
  isArchived: false,
  createdAt: AT,
  updatedAt: AT,
  room,
};

/**
 * `payments` is the charged registrations' payment states, `null` for a
 * registration with no payment row — which is what the pages' `select` actually
 * returns (`(teacher)/page.tsx`, `schedule/past/page.tsx`). Pass `undefined` for
 * a caller that did not include registrations at all; the prop is optional.
 */
function classRow(
  id: string,
  status: ClassRow['status'],
  payments: (PaymentStatus | null)[] | undefined,
): ClassRow {
  return {
    id,
    teacherId: 'teacher-1',
    teacherRoomId: 'tr-1',
    templateId: null,
    classType: 'Vinyasa',
    description: null,
    date: new Date('2026-06-12T00:00:00.000Z'),
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: new Decimal(20),
    minRate: new Decimal(40),
    targetRate: new Decimal(80),
    minStudents: 4,
    maxStudents: 12,
    cancelDeadline: 'HOURS_24',
    autoCancelCheck: 'HOURS_2',
    status,
    settingsLocked: true,
    effectiveTeacherRate: null,
    totalStudents: null,
    totalRevenue: null,
    createdAt: AT,
    updatedAt: AT,
    _count: { registrations: payments?.length ?? 0 },
    teacherRoom,
    registrations: payments?.map((p) => ({ payment: p === null ? null : { status: p } })),
  };
}

function renderOne(status: ClassRow['status'], payments: (PaymentStatus | null)[] | undefined) {
  render(<ClassList classes={[classRow('cls-1', status, payments)]} />);
}

/** The three rollup markers, so a "renders nothing" test cannot pass vacuously. */
function expectNoRollup() {
  // The card itself is on screen — otherwise the three negatives below would
  // hold for an empty render just as well.
  expect(screen.getByText('Big Room at Studio Zen')).toBeInTheDocument();
  expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  expect(screen.queryByText(/unpaid/)).not.toBeInTheDocument();
  expect(screen.queryByText(/all paid/)).not.toBeInTheDocument();
}

describe('ClassList payment rollup', () => {
  /**
   * Priority, not arithmetic: this class has one of each, and only the overdue
   * count is shown. Swapping the two `if`s makes it report "○ 1 unpaid" and
   * kills this test alone.
   */
  it('reports overdue ahead of unpaid', () => {
    renderOne('completed', ['overdue', 'pending', 'paid']);

    expect(screen.getByText(/! 1 overdue/)).toBeInTheDocument();
    expect(screen.queryByText(/unpaid/)).not.toBeInTheDocument();
    expect(screen.queryByText(/all paid/)).not.toBeInTheDocument();
  });

  it('reports the unpaid count when nothing is overdue', () => {
    renderOne('completed', ['pending', 'pending', 'paid']);

    expect(screen.getByText(/○ 2 unpaid/)).toBeInTheDocument();
    expect(screen.queryByText(/all paid/)).not.toBeInTheDocument();
  });

  it('reports all paid only when every payment is paid', () => {
    renderOne('completed', ['paid', 'paid']);

    expect(screen.getByText(/✓ all paid/)).toBeInTheDocument();
    expect(screen.queryByText(/unpaid/)).not.toBeInTheDocument();
    expect(screen.queryByText(/overdue/)).not.toBeInTheDocument();
  });

  /**
   * The guard that gives this branch its name. A completed class whose
   * registrations carry no payment rows yet has *nothing* to report — and
   * reporting "✓ all paid" for it, which is what falling through does, is a
   * false all-clear on a teacher's money.
   */
  it('stays silent when a completed class has no payments yet', () => {
    renderOne('completed', [null, null]);

    expectNoRollup();
  });

  it('renders no rollup for a class that has not completed', () => {
    renderOne('in_progress', ['overdue', 'pending']);

    expectNoRollup();
  });

  /**
   * The other half of the same guard line, and not hypothetical: `registrations`
   * is optional on the prop type, so any future caller that renders `ClassList`
   * without including them hits this. Without the check the `.map` throws and
   * takes the whole schedule down.
   */
  it('stays silent when registrations were not loaded at all', () => {
    renderOne('completed', undefined);

    expectNoRollup();
  });
});
