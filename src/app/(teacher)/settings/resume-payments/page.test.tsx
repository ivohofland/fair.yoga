import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ResumeReview } from '@/services/payout-resume';
import { RECENT_AUTH_WINDOW_MS } from '@/lib/auth/recent-auth';

const { requireTeacherSession, readResumeReview, count, teacherFindUnique } = vi.hoisted(() => ({
  requireTeacherSession: vi.fn(),
  readResumeReview: vi.fn<(...args: unknown[]) => Promise<ResumeReview | null>>(),
  count: vi.fn<(args: unknown) => Promise<number>>(),
  teacherFindUnique: vi.fn<(args: unknown) => Promise<{ paymentsResumedAt: Date | null } | null>>(),
}));

vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('@/lib/db', () => ({
  prisma: {
    passkeyCredential: { count },
    account: { findUniqueOrThrow: async () => ({ email: 'anna@test.local' }) },
    teacher: { findUnique: teacherFindUnique },
  },
}));
vi.mock('@/services/payout-resume', () => ({ readResumeReview }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('@/components/account/sign-out-button', () => ({
  SignOutButton: ({ redirectTo }: { redirectTo?: string }) => <span data-testid="sign-out" data-redirect={redirectTo} />,
}));

import ResumePaymentsPage from './page';
import { RESUME_SIGN_IN_PATH } from '@/components/settings/resume-payments-form';

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
  // A resume refreshes this page, so the not-paused answer is what the
  // teacher reads straight after resuming.
  it('says when payments were resumed, and that students were told then', async () => {
    readResumeReview.mockResolvedValue(null);
    teacherFindUnique.mockResolvedValue({ paymentsResumedAt: new Date('2026-07-20T14:05:00Z') });

    render(await ResumePaymentsPage());

    expect(screen.getByText(/Payments are running\. You resumed them on 20 Jul 2026, 14:05/)).toBeInTheDocument();
    expect(document.body.textContent).toContain('were told then that they can pay');
    expect(screen.queryByRole('button', { name: 'Resume payments' })).toBeNull();
  });

  it('says payments are not paused for a teacher who never paused', async () => {
    readResumeReview.mockResolvedValue(null);
    teacherFindUnique.mockResolvedValue({ paymentsResumedAt: null });

    render(await ResumePaymentsPage());

    expect(document.body.textContent).toContain('Payments aren’t paused.');
    expect(document.body.textContent).not.toContain('resumed');
  });

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
    expect(screen.getByTestId('sign-out')).toHaveAttribute('data-redirect', RESUME_SIGN_IN_PATH);
    expect(screen.queryByRole('button', { name: 'Resume payments' })).toBeNull();
    expect(screen.queryByText(/was removed recently/)).toBeNull();
    expect(document.body.textContent).toContain(`then resume within ${RECENT_AUTH_WINDOW_MS / 60_000} minutes.`);
  });

  it('tells a passkey session how long it has to resume', async () => {
    readResumeReview.mockResolvedValue(review({
      passkeyRequired: true, sessionSatisfiesPasskey: true, fallbackOpensAt: new Date('2026-08-03T12:00:00Z'),
    }));

    render(await ResumePaymentsPage());

    expect(document.body.textContent).toContain(`Resume within ${RECENT_AUTH_WINDOW_MS / 60_000} minutes of signing in`);
  });
});

describe('the resume-payments change list', () => {
  const event = {
    id: 'e1', accountCurrency: 'EUR' as const, before: '•••• 4300', after: '•••• 4300',
    createdAt: new Date('2026-07-19T12:00:00Z'),
  };

  it('warns when changed bank details mask like the old ones', async () => {
    readResumeReview.mockResolvedValue(review({ events: [{ ...event, kind: 'bank_account_changed', identifierChanged: true }] }));

    render(await ResumePaymentsPage());

    expect(screen.getByText("The bank details changed, though the account number's last digits look the same. Check the full details in your settings.")).toBeInTheDocument();
    expect(screen.queryByText(/other than the account number/)).toBeNull();
  });

  it('says only a detail other than the number changed when the number did not', async () => {
    readResumeReview.mockResolvedValue(review({ events: [{ ...event, kind: 'bank_account_changed', identifierChanged: false }] }));

    render(await ResumePaymentsPage());

    expect(screen.getByText('Before and after look the same here because a detail other than the account number changed.')).toBeInTheDocument();
  });

  it('warns when a changed link masks like the old one', async () => {
    readResumeReview.mockResolvedValue(review({
      events: [{ ...event, kind: 'payment_link_changed', accountCurrency: null, before: 'revolut.me/…cher', after: 'revolut.me/…cher', identifierChanged: true }],
    }));

    render(await ResumePaymentsPage());

    expect(screen.getByText('The new link looks like the old one here, but it is a different link. Check it in full in your settings.')).toBeInTheDocument();
  });
});
