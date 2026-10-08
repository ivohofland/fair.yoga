import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ResumeReview } from '@/services/payout-resume';

const { requireTeacherSession, readResumeReview, count } = vi.hoisted(() => ({
  requireTeacherSession: vi.fn(),
  readResumeReview: vi.fn<(...args: unknown[]) => Promise<ResumeReview | null>>(),
  count: vi.fn<(args: unknown) => Promise<number>>(),
}));

vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('@/lib/db', () => ({ prisma: { passkeyCredential: { count } } }));
vi.mock('@/services/payout-resume', () => ({ readResumeReview }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/account/sign-out-button', () => ({
  SignOutButton: () => <span data-testid="sign-out" />,
}));

import ResumePaymentsPage from './page';

const SESSION = { sessionId: 's1', accountId: 'a1', teacherId: 't1', studentId: null, defaultTimezone: 'UTC' };

function review(overrides: Partial<ResumeReview> = {}): ResumeReview {
  return {
    pausedAt: new Date('2026-07-20T12:00:00Z'),
    windowStart: new Date('2026-07-18T12:00:00Z'),
    events: [],
    outstanding: [],
    settled: [],
    details: { paymentLink: null, bankAccounts: [] },
    fingerprint: 'fp',
    passkeyRequired: false,
    sessionSatisfiesPasskey: false,
    passkeyRemoved: false,
    fallbackOpensAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  requireTeacherSession.mockResolvedValue(SESSION);
  count.mockResolvedValue(1);
});

describe('the resume-payments page', () => {
  it('says a removed passkey leaves only the date the resume opens, with no way to sign in past it', async () => {
    readResumeReview.mockResolvedValue(review({
      passkeyRequired: true, passkeyRemoved: true, fallbackOpensAt: new Date('2026-08-03T12:00:00Z'),
    }));

    render(await ResumePaymentsPage());

    expect(screen.getByText('A passkey on this account was removed recently; resuming opens on 3 Aug 2026, 12:00.')).toBeInTheDocument();
    expect(screen.queryByText(/sign in again with\s+your passkey/)).toBeNull();
    expect(screen.queryByTestId('sign-out')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume payments' })).toBeNull();
  });

  it('sends a teacher who still has the passkey to sign in with it', async () => {
    readResumeReview.mockResolvedValue(review({
      passkeyRequired: true, passkeyRemoved: false, fallbackOpensAt: new Date('2026-08-03T12:00:00Z'),
    }));

    render(await ResumePaymentsPage());

    expect(screen.getByRole('heading', { name: 'Sign in with your passkey to resume' })).toBeInTheDocument();
    expect(screen.getByTestId('sign-out')).toBeInTheDocument();
    expect(screen.queryByText(/was removed recently/)).toBeNull();
  });
});
