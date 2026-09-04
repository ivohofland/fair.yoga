import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const push = vi.fn();

/** Reassignable so a case can drop the token — the one input that decides
 *  whether a verification is attempted at all. Restored in `afterEach`. */
const WITH_TOKEN = 'token=a-real-token';
let searchParams = new URLSearchParams(WITH_TOKEN);

/** One object for the life of the file, as Next's own `useRouter` returns.
 *  A fresh one per call would change identity on every render and re-run
 *  every effect that depends on the router — including the verification
 *  itself, which would then be sent more than once. */
const router = { push, refresh: vi.fn() };

vi.mock('next/navigation', () => ({
  useSearchParams: () => searchParams,
  useRouter: () => router,
}));

import VerifyPage from './page';

describe('VerifyPage', () => {
  afterEach(() => {
    // Before the rest: a test that fails partway through a fake-timer block
    // would otherwise leave them installed, and every test after it times out
    // waiting for a clock nothing advances.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    push.mockReset();
    searchParams = new URLSearchParams(WITH_TOKEN);
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
   * The ticket-minting branch answers with no `accountId`, and its two
   * displacements are not the sign-in the session branch's copy describes:
   * the reader did not sign in here, they started a signup that replaced
   * something. Same flags, different sentence.
   */
  it('says the OTHER signup was cancelled by this one, not by signing in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { redirectTo: '/signup/profile', signupCancelled: true },
        }),
      }),
    );
    render(<VerifyPage />);

    expect(
      await screen.findByText(/Your other pending signup was cancelled by this one/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/cancelled because you signed in/),
    ).not.toBeInTheDocument();
  });

  it('says so when starting this signup signed the reader out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { redirectTo: '/signup/profile', sessionEnded: true },
        }),
      }),
    );
    render(<VerifyPage />);

    expect(
      await screen.findByText(/signed you out of your other account/),
    ).toBeInTheDocument();
  });

  it('shows no sign-out notice when no session was ended', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { redirectTo: '/signup/profile' } }),
      }),
    );
    render(<VerifyPage />);

    expect(await screen.findByText("Let's set up your page.")).toBeInTheDocument();
    expect(
      screen.queryByText(/signed you out of your other account/),
    ).not.toBeInTheDocument();
  });

  it('gives the sign-out notice the same reading time as the cancellation one', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          data: { redirectTo: '/signup/profile', sessionEnded: true },
        }),
      }),
    );
    render(<VerifyPage />);

    await vi.advanceTimersByTimeAsync(900);
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3100);
    expect(push).toHaveBeenCalledWith('/signup/profile');
    vi.useRealTimers();
  });

  /**
   * The notice above only does its job if the auto-redirect gives it time
   * to be read. Verified by the exact delay scheduled, not by waiting out
   * the real interval — a regression collapsing this back to the ordinary
   * 900ms would leave the DOM assertions above passing while the notice is
   * gone before anyone could read it.
   */
  it('holds the redirect past 900ms while the cancellation notice is showing', async () => {
    vi.useFakeTimers();
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

    // The redirect itself, not the `setTimeout` call that schedules it: a
    // spy over every scheduled callback cannot say which one navigates, and
    // matching on the delay value asserts the number back to itself.
    await vi.advanceTimersByTimeAsync(900);
    expect(push).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3100);
    expect(push).toHaveBeenCalledWith('/schedule');
  });

  it('redirects on the ordinary beat when there is nothing to read', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { accountId: 'acct-1', redirectTo: '/schedule' } }),
      }),
    );
    render(<VerifyPage />);

    await vi.advanceTimersByTimeAsync(900);
    expect(push).toHaveBeenCalledWith('/schedule');
  });

  /**
   * The verifying rail's lifetime, which nothing used to bound (#435, #254).
   *
   * Two constants hold it away from zero, and both are load-bearing: the
   * threshold alone would move the flicker to the connections that settle
   * just past it rather than removing it. Each case below names which half
   * it is pinning.
   */
  describe('the verifying rail', () => {
    /**
     * Advance the fake clock inside `act`, then assert.
     *
     * These cases read the DOM at exact instants, so they use `getByText`
     * rather than the retrying `findByText` the rest of this file leans on —
     * and a `setState` made from a timer callback is outside React's act
     * scope, so without this its render has not reached the DOM by the next
     * line. It also flushes the promise chain in a window where no timer
     * fires, which `advanceTimersByTimeAsync` alone does not do.
     */
    async function advance(ms: number): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    /** A fetch this test resolves by hand, so the rail's window is ours to
     *  step through rather than something the mock races us to. */
    function deferredFetch(): { resolve: (value: unknown) => void } {
      let resolve!: (value: unknown) => void;
      const pending = new Promise((r) => {
        resolve = r;
      });
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(pending));
      return { resolve };
    }

    const signedIn = {
      ok: true,
      json: async () => ({ data: { accountId: 'acct-1', redirectTo: '/schedule' } }),
    };

    /** The threshold half. Nothing renders in the window a fast verification
     *  finishes inside — not even for the frame before the outcome lands. */
    it('never appears when verification settles inside the threshold', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(signedIn));
      render(<VerifyPage />);

      // The synchronous first render: the site that used to paint the rail
      // into the server HTML as well.
      expect(screen.queryByText('Checking your link')).not.toBeInTheDocument();

      await advance(10);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
      expect(screen.queryByText('Checking your link')).not.toBeInTheDocument();

      // Past the threshold, with the outcome long since on screen: the
      // appearance timer must not still be armed behind it.
      await advance(500);
      expect(screen.queryByText('Checking your link')).not.toBeInTheDocument();
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
    });

    /** The minimum-hold half, and the whole reason this change exists: an
     *  outcome landing a millisecond into the rail's window waits for it. */
    it('keeps the screen for its minimum when the outcome lands just behind it', async () => {
      vi.useFakeTimers();
      const { resolve } = deferredFetch();
      render(<VerifyPage />);

      await advance(299);
      expect(screen.queryByText('Checking your link')).not.toBeInTheDocument();

      await advance(1);
      expect(screen.getByText('Checking your link')).toBeInTheDocument();

      // t=301: verification answers one millisecond into the rail's window.
      resolve(signedIn);
      await advance(1);
      expect(screen.getByText('Checking your link')).toBeInTheDocument();
      expect(screen.queryByText("You're signed in.")).not.toBeInTheDocument();

      // t=900: the rail has had its 600ms, and only now yields the screen.
      await advance(599);
      expect(screen.queryByText('Checking your link')).not.toBeInTheDocument();
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
    });

    /**
     * The two timers compose, rather than one eating the other: the success
     * state's own reading beat is measured from when it TAKES the screen, not
     * from when the fetch settled. A regression starting the 900ms at the
     * fetch would leave the case above green while the success state got
     * 301ms of it.
     */
    it('starts the redirect beat when the outcome takes the screen', async () => {
      vi.useFakeTimers();
      const { resolve } = deferredFetch();
      render(<VerifyPage />);

      await advance(300);
      resolve(signedIn);
      await advance(600);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();

      await advance(899);
      expect(push).not.toHaveBeenCalled();
      await advance(1);
      expect(push).toHaveBeenCalledWith('/schedule');
    });

    /**
     * A dwelt-upon state must not inherit the threshold. The rail never
     * appeared, so there is nothing owed and nothing to wait out — the reader
     * sees the failure as promptly as they did before the gate existed.
     */
    it('does not delay an error that lands inside the threshold', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false })
          .mockResolvedValueOnce({ ok: false }),
      );
      render(<VerifyPage />);

      await advance(10);
      expect(screen.getByText('Verification failed')).toBeInTheDocument();
      expect(screen.queryByText('Checking your link')).not.toBeInTheDocument();
    });

    /** A URL with no token never starts a verification, so the gate must not
     *  stand between the reader and the failure it already knows about. */
    it('shows the no-token failure on the first render', async () => {
      vi.useFakeTimers();
      searchParams = new URLSearchParams('');
      vi.stubGlobal('fetch', vi.fn());
      render(<VerifyPage />);

      expect(screen.getByText('Verification failed')).toBeInTheDocument();
      expect(screen.queryByText('Checking your link')).not.toBeInTheDocument();
    });
  });
});
