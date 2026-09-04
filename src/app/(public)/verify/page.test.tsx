import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const push = vi.fn();

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('token=a-real-token'),
  useRouter: () => ({ push, refresh: vi.fn() }),
}));

import VerifyPage from './page';

describe('VerifyPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    push.mockReset();
  });

  /**
   * De-risks the `aria-label="Your code is ${code}"` attribute that the
   * (unrunnable-here) e2e suite reads the displayed code through.
   */
  it('shows the handoff code, its heading, and the escape hatch to /login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { handoffCode: '123456' } }) }),
    );
    render(<VerifyPage />);

    expect(await screen.findByLabelText(/Your code is 123456/)).toBeInTheDocument();
    expect(screen.getByText('Enter this where you started')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Sign in here instead/i })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  /**
   * The signup-ticket branch of `verify/route.ts` (`magic-link/verify`)
   * serves both the teacher and student families, and both land here with
   * no `accountId` in the response. A booking destination must not show the
   * teacher-only "Let's set up your page." headline.
   */
  it('shows the booking headline, not the teacher one, for a student signup destination', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { redirectTo: '/some-teacher/book/some-class-id' } }),
      }),
    );
    render(<VerifyPage />);

    expect(await screen.findByText("Let's finish your booking.")).toBeInTheDocument();
    expect(screen.queryByText("Let's set up your page.")).not.toBeInTheDocument();
  });

  /**
   * The other half of `newSignupHeadline`'s branch — nothing previously
   * asserted the teacher copy positively, so a regression here shipped
   * silently until this test.
   */
  it('shows the teacher headline for a teacher signup destination', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { redirectTo: '/signup/profile' } }),
      }),
    );
    render(<VerifyPage />);

    expect(await screen.findByText("Let's set up your page.")).toBeInTheDocument();
    expect(screen.queryByText("Let's finish your booking.")).not.toBeInTheDocument();
  });

  /**
   * This component test is what pins that the page actually renders a
   * notice when its response carries a `signupCancelled` flag.
   */
  it('shows the cancelled-signup notice when the response carries the flag', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { accountId: 'acct-1', redirectTo: '/schedule', signupCancelled: true },
        }),
      }),
    );
    render(<VerifyPage />);

    expect(
      await screen.findByText(/Your pending signup was cancelled because you signed in/),
    ).toBeInTheDocument();
  });

  it('does not show the cancelled-signup notice when the flag is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { accountId: 'acct-1', redirectTo: '/schedule' } }),
      }),
    );
    render(<VerifyPage />);

    expect(await screen.findByText("You're signed in.")).toBeInTheDocument();
    expect(
      screen.queryByText(/Your pending signup was cancelled because you signed in/),
    ).not.toBeInTheDocument();
  });

  /**
   * The notice above only does its job if the auto-redirect gives it time
   * to be read. Verified by the exact delay scheduled, not by waiting out
   * the real interval — a regression collapsing this back to the ordinary
   * 900ms would leave the DOM assertions above passing while the notice is
   * gone before anyone could read it.
   */
  it('schedules the auto-redirect for 4000ms when the cancellation notice is showing', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { accountId: 'acct-1', redirectTo: '/schedule', signupCancelled: true },
        }),
      }),
    );
    render(<VerifyPage />);

    await screen.findByText(/Your pending signup was cancelled because you signed in/);

    const redirectCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 900 || delay === 4000);
    expect(redirectCall?.[1]).toBe(4000);
  });

  it('keeps the ordinary 900ms redirect when there is no cancellation to show', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { accountId: 'acct-1', redirectTo: '/schedule' } }),
      }),
    );
    render(<VerifyPage />);

    await screen.findByText("You're signed in.");

    const redirectCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === 900 || delay === 4000);
    expect(redirectCall?.[1]).toBe(900);
  });
});
