import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';

const { findUnique, waitlistCount, requireTeacherSession, redirect, completeClassButton } = vi.hoisted(() => ({
  findUnique: vi.fn(),
  waitlistCount: vi.fn(),
  requireTeacherSession: vi.fn(),
  redirect: vi.fn(),
  completeClassButton: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  prisma: { class: { findUnique }, waitlistEntry: { count: waitlistCount } },
}));
vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/components/class/complete-class-button', () => ({
  CompleteClassButton: (props: Record<string, unknown>) => {
    completeClassButton(props);
    return <div data-testid="complete-class-button" />;
  },
}));
// The rest of the page draws a marker or nothing: this file is about the props
// the page hands its children and which of them sit in an `OfflineFieldset`,
// not what they draw.
vi.mock('@/components/class/class-info', () => ({ ClassInfo: () => null }));
vi.mock('@/components/class/pricing-preview', () => ({ PricingPreview: () => null }));
vi.mock('@/components/class/pricing-breakdown', () => ({
  PricingBreakdown: () => <div data-testid="pricing-breakdown" />,
}));
vi.mock('@/components/class/payment-checklist', () => ({ PaymentChecklist: () => null }));
vi.mock('@/components/class/attendance-list', () => ({
  AttendanceList: ({ locked = false }: { locked?: boolean }) => (
    <div data-testid="attendance-list" data-locked={String(locked)} />
  ),
}));
vi.mock('@/components/class/add-walk-in', () => ({ AddWalkIn: () => <div data-testid="add-walk-in" /> }));
vi.mock('@/components/class/send-announcement', () => ({ SendAnnouncement: () => null }));
vi.mock('@/components/class/share-booking-link', () => ({ ShareBookingLink: () => null }));
vi.mock('@/components/class/cancel-class-button', () => ({ CancelClassButton: () => null }));
vi.mock('@/components/class/refresh-at', () => ({ RefreshAt: () => null }));
vi.mock('@/components/class/checkin-switch', () => ({
  CheckinSwitch: ({ initial, before, checkin }: { initial: 'before' | 'checkin'; before: ReactNode; checkin: ReactNode }) => (
    <>{initial === 'checkin' ? checkin : before}</>
  ),
}));
vi.mock('@/components/layout/offline-snapshot', () => ({
  OfflineSnapshot: ({ children }: { children: ReactNode }) => <>{children}</>,
  OfflineFieldset: ({ children }: { children: ReactNode }) => <div data-testid="offline-fieldset">{children}</div>,
}));

import ClassDetailPage from './page';

const MINUTE = 60_000;

/** An `in_progress` class that started 50 minutes ago and runs an hour: inside its finish window. */
function classInItsFinishWindow() {
  const start = new Date(Math.floor(Date.now() / MINUTE) * MINUTE - 50 * MINUTE);
  return {
    id: 'class-1',
    status: 'in_progress',
    calendarEntry: {
      teacherId: 'teacher-1',
      classType: 'Hatha',
      cancelledAt: null,
      date: new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate())),
      startTime: new Date(Date.UTC(1970, 0, 1, start.getUTCHours(), start.getUTCMinutes())),
      durationMinutes: 60,
      teacher: { defaultTimezone: 'UTC', pageSlug: 'teacher' },
    },
    registrations: [],
    _count: { waitlistEntries: 0 },
  };
}

describe('ClassDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireTeacherSession.mockResolvedValue({ accountId: 'acc-1', teacherId: 'teacher-1', defaultTimezone: 'UTC' });
    waitlistCount.mockResolvedValue(0);
  });

  // Finish class syncs this account's queued attendance before it posts.
  it("hands Finish class the session account's attendance queue", async () => {
    findUnique.mockResolvedValue(classInItsFinishWindow());

    render(await ClassDetailPage({ params: Promise.resolve({ id: 'class-1' }) }));

    expect(completeClassButton).toHaveBeenCalledWith(
      expect.objectContaining({ classId: 'class-1', outboxOwner: 'acc-1' }),
    );
  });

  /** Whether `testId`'s element sits inside an `OfflineFieldset`, which disables it offline. */
  function inFieldset(testId: string): boolean {
    return screen.getByTestId(testId).closest('[data-testid="offline-fieldset"]') !== null;
  }

  // Offline, a fieldset disables every control inside it: the attendance list
  // must sit outside them so its taps can queue, and everything else inside one.
  it('leaves the check-in attendance list outside every fieldset, and the rest inside one', async () => {
    findUnique.mockResolvedValue(classInItsFinishWindow());

    render(await ClassDetailPage({ params: Promise.resolve({ id: 'class-1' }) }));

    expect(screen.getByTestId('attendance-list')).toHaveAttribute('data-locked', 'false');
    expect(inFieldset('attendance-list')).toBe(false);
    expect(inFieldset('add-walk-in')).toBe(true);
    expect(inFieldset('complete-class-button')).toBe(true);
  });

  it("leaves a completed class's attendance list outside every fieldset, and the rest inside one", async () => {
    findUnique.mockResolvedValue({ ...classInItsFinishWindow(), status: 'completed' });

    render(await ClassDetailPage({ params: Promise.resolve({ id: 'class-1' }) }));

    expect(screen.getByTestId('attendance-list')).toHaveAttribute('data-locked', 'true');
    expect(inFieldset('attendance-list')).toBe(false);
    expect(inFieldset('pricing-breakdown')).toBe(true);
  });
});
