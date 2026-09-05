import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const push = vi.fn();

/** Reassignable so a case can drop the token — the one input that decides
 *  whether a verification is attempted at all. Restored in `afterEach`. */
const WITH_TOKEN = 'token=a-real-token';
let searchParams = new URLSearchParams(WITH_TOKEN);

/** One object for the life of the file. A fresh one per call would change
 *  identity on every render and re-run every effect that depends on the
 *  router — including the verification itself, which would then be sent more
 *  than once with a single-use token. */
const router = { push, refresh: vi.fn() };

/** Makes `useSearchParams` suspend, so the page's `<Suspense>` boundary
 *  renders its fallback. Nothing else in this file reaches that branch: a mock
 *  that answers synchronously never suspends. Reset in `afterEach`. */
let suspendSearchParams = false;

vi.mock('next/navigation', () => ({
  useSearchParams: () => {
    // A promise that never settles: React keeps the boundary suspended for as
    // long as the render lasts, which is all this needs.
    if (suspendSearchParams) throw new Promise<void>(() => {});
    return searchParams;
  },
  useRouter: () => router,
}));

import VerifyPage, {
  RAIL_APPEARS_AFTER_MS,
  RAIL_STAYS_FOR_MS,
  RAIL_HEADING,
  VERIFY_CEILING_MS,
} from './page';

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
    suspendSearchParams = false;
  });

  /**
   * De-risks the `aria-label="Your code is ${code}"` attribute that the
   * (unrunnable-here) e2e suite reads the displayed code through.
   */
  /**
   * `home` decides both where the continue link goes and which family's
   * wording it carries, and nothing at this tier held it: every mutation of
   * that one prop left this file green. An empty `home` renders `href=""`,
   * which sends a reader who IS signed in back to `/verify?token=…` — the
   * spent link they just came from.
   *
   * The student half of `AlreadySignedInState`'s ternary had no test at any
   * tier before this one.
   */
  it.each([
    {
      who: 'a teacher',
      session: { teacherId: 't-1', studentId: null },
      label: 'Continue to your schedule',
      href: '/schedule',
    },
    {
      who: 'a student',
      session: { teacherId: null, studentId: 's-1' },
      label: 'Continue to your bookings',
      href: '/bookings',
    },
  ])('points $who re-clicking a spent link at their own landing page', async ({
    session,
    label,
    href,
  }) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        // The verify POST: the link is spent, which is what sends the page to
        // the session probe below.
        .mockResolvedValueOnce({ ok: false, status: 400 })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ data: session }) }),
    );
    render(<VerifyPage />);

    expect(await screen.findByRole('link', { name: label })).toHaveAttribute('href', href);
  });

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
     * line.
     */
    async function advance(ms: number): Promise<void> {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    }

    /**
     * A fetch this test resolves by hand, so the rail's window is ours to step
     * through rather than something the mock races us to.
     *
     * `body` is a spy: a case asserting the outcome is NOT yet on screen has
     * to tell "held by the rail" apart from "the response has not been read
     * yet", and the two look identical in the DOM.
     */
    function deferredFetch(body: () => unknown): {
      resolve: () => void;
      read: ReturnType<typeof vi.fn>;
      calls: () => number;
    } {
      const read = vi.fn(async () => body());
      let resolve!: (value: unknown) => void;
      const pending = new Promise((r) => {
        resolve = r;
      });
      const fetchMock = vi.fn().mockReturnValue(pending);
      vi.stubGlobal('fetch', fetchMock);
      return {
        resolve: () => resolve({ ok: true, json: read }),
        read,
        calls: () => fetchMock.mock.calls.length,
      };
    }

    const signedInBody = () => ({ data: { accountId: 'acct-1', redirectTo: '/schedule' } });
    const signedIn = { ok: true, json: async () => signedInBody() };

    /**
     * Walks a case to the instant the rail is up and the outcome has been
     * read but not yet shown — the state every hold assertion is about.
     * Returns at t = RAIL_APPEARS_AFTER_MS + 1.
     */
    async function railUpWithOutcomeHeld(
      deferred: ReturnType<typeof deferredFetch>,
    ): Promise<void> {
      await advance(RAIL_APPEARS_AFTER_MS);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();
      deferred.resolve();
      await advance(1);
      // The chain reached `settle` while the rail was up: whatever is still
      // absent below is absent because it is HELD, not because it is unread.
      expect(deferred.read).toHaveBeenCalled();
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();
    }

    /** The threshold half. Nothing renders in the window a fast verification
     *  finishes inside — not even for the frame before the outcome lands. */
    it('never appears when verification settles inside the threshold', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(signedIn));
      render(<VerifyPage />);

      // Before any timer has fired: the fall-through must render nothing
      // while `status` is still `verifying`.
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();

      await advance(10);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
    });

    /** The minimum-hold half, and the whole reason this change exists: an
     *  outcome landing a millisecond into the rail's window waits for it. */
    it('keeps the screen for its minimum when the outcome lands just behind it', async () => {
      vi.useFakeTimers();
      const deferred = deferredFetch(signedInBody);
      render(<VerifyPage />);

      await advance(RAIL_APPEARS_AFTER_MS - 1);
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();

      await railUpWithOutcomeHeld(deferred);
      expect(screen.queryByText("You're signed in.")).not.toBeInTheDocument();

      // The rail re-rendered the page mid-flight when it appeared. If `settle`
      // ever loses its stable identity the verification effect re-runs here
      // and re-posts a single-use token, which nothing else in this file would
      // notice.
      expect(deferred.calls()).toBe(1);

      await advance(RAIL_STAYS_FOR_MS - 1);
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
    });

    /**
     * The two timers compose, rather than one eating the other: the success
     * state's own reading beat is measured from when it TAKES the screen, not
     * from when the fetch settled. A regression starting the 900ms at the
     * fetch would leave the case above green while the success state got only
     * the remainder of its beat.
     */
    it('starts the redirect beat when the outcome takes the screen', async () => {
      vi.useFakeTimers();
      const deferred = deferredFetch(signedInBody);
      render(<VerifyPage />);

      await railUpWithOutcomeHeld(deferred);
      await advance(RAIL_STAYS_FOR_MS - 1);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();

      // The beat runs from here, where the state took the screen — not from
      // the outcome's arrival 599ms ago.
      await advance(899);
      expect(push).not.toHaveBeenCalled();
      await advance(1);
      expect(push).toHaveBeenCalledWith('/schedule');
    });

    /**
     * The exits reached straight off the verify POST, held the same way.
     *
     * The hook's contract is that EVERY exit from `verifying` goes through
     * `settle`, and the compiler cannot enforce it — so each exit needs a case
     * that fails when it stops. Without these, dropping `settle` from an exit
     * is invisible: the fast-path cases reach it with the rail down, where it
     * is a pass-through and contributes nothing observable.
     *
     * The exits behind a FAILED verification are held by the `it.each` below
     * instead, because they need the fetch mock to answer a second time.
     */
    const heldExits = [
      {
        name: 'the handoff code',
        body: () => ({ data: { handoffCode: '123456' } }),
        shown: 'Enter this where you started',
      },
    ] as const;

    it.each(heldExits)('holds the rail before showing $name', async ({ body, shown }) => {
      vi.useFakeTimers();
      const deferred = deferredFetch(body);
      render(<VerifyPage />);

      await railUpWithOutcomeHeld(deferred);
      expect(screen.queryByText(shown)).not.toBeInTheDocument();

      await advance(RAIL_STAYS_FOR_MS - 1);
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
      expect(screen.getByText(shown)).toBeInTheDocument();
    });

    /**
     * The two exits behind a failed verification. Both are reached through the
     * `.catch`, which probes `/api/auth/session` before deciding which of them
     * applies — so the fetch mock has to answer twice.
     */
    it.each([
      {
        name: 'the already-signed-in state',
        probe: { ok: true, json: async () => ({ data: { teacherId: 't-1', studentId: null } }) },
        shown: 'Already signed in',
      },
      {
        name: 'the failure state',
        probe: { ok: false, status: 401 },
        shown: 'Verification failed',
      },
    ])('holds the rail before showing $name', async ({ probe, shown }) => {
      vi.useFakeTimers();
      let rejectVerify!: (value: unknown) => void;
      const pending = new Promise((r) => {
        rejectVerify = r;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValueOnce(pending).mockResolvedValue(probe),
      );
      render(<VerifyPage />);

      await advance(RAIL_APPEARS_AFTER_MS);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();

      // A non-ok verify response: the page throws, catches, and probes the
      // session — all inside the rail's window.
      rejectVerify({ ok: false, status: 400 });
      await advance(1);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();
      expect(screen.queryByText(shown)).not.toBeInTheDocument();

      await advance(RAIL_STAYS_FOR_MS - 1);
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
      expect(screen.getByText(shown)).toBeInTheDocument();
    });

    /**
     * A dwelt-upon state must not inherit the threshold. The rail never
     * appeared, so there is nothing owed and nothing to wait out.
     */
    it('does not delay an error that lands inside the threshold', async () => {
      vi.useFakeTimers();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 400 })
          .mockResolvedValueOnce({ ok: false, status: 401 }),
      );
      render(<VerifyPage />);

      await advance(10);
      expect(screen.getByText('Verification failed')).toBeInTheDocument();
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
    });

    /**
     * Leaving mid-hold takes the outcome with it. Without the cleanup the stay
     * timer still fires on an unmounted page, applies the success state and
     * schedules its redirect — so a reader who pressed Back during the hold is
     * yanked forward onto the destination a second later.
     */
    it('drops a held outcome when the page is left before it lands', async () => {
      vi.useFakeTimers();
      const deferred = deferredFetch(signedInBody);
      const { unmount } = render(<VerifyPage />);

      await railUpWithOutcomeHeld(deferred);
      unmount();

      await advance(RAIL_STAYS_FOR_MS + 900);
      expect(push).not.toHaveBeenCalled();
    });

    /** A URL with no token never starts a verification, so the gate must not
     *  stand between the reader and the failure it already knows about. */
    it.each([
      { name: 'no token parameter', query: '' },
      { name: 'an empty token parameter', query: 'token=' },
    ])('shows the failure on the first render given $name', async ({ query }) => {
      vi.useFakeTimers();
      searchParams = new URLSearchParams(query);
      vi.stubGlobal('fetch', vi.fn());
      render(<VerifyPage />);

      expect(screen.getByText('Verification failed')).toBeInTheDocument();
      expect(fetch).not.toHaveBeenCalled();

      // Past all three constants: no timer of any kind may be armed for a
      // verification that was never sent, and the ceiling would otherwise
      // turn a reader's own bad link into a connection problem.
      await advance(RAIL_APPEARS_AFTER_MS + RAIL_STAYS_FOR_MS + VERIFY_CEILING_MS);
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();
      expect(screen.getByText('Verification failed')).toBeInTheDocument();
    });

    /**
     * The `<Suspense>` fallback, pinned where the serving mode cannot change
     * the answer.
     *
     * That boundary exists because `useSearchParams` suspends, and it is the
     * first paint wherever this route is prerendered. The integration file
     * fetches real HTML, but WHICH render site produced it depends on how the
     * app under test is being served — so this is the only assertion about the
     * fallback that means the same thing everywhere.
     */
    it('paints nothing while the search params are still suspended', () => {
      suspendSearchParams = true;
      vi.stubGlobal('fetch', vi.fn());
      const { container } = render(<VerifyPage />);

      expect(container).toBeEmptyDOMElement();
      expect(fetch).not.toHaveBeenCalled();
    });

    /**
     * The far end of the same lifetime the two cases above bound the near end
     * of. Grouped here because they share the ceiling's clock, not because
     * they share a mechanism with the flash cases.
     *
     * `console.error` is silenced rather than allowed through: the ceiling
     * logs on every case here, and an unstubbed spy would print that line
     * once per test. `vi.restoreAllMocks()` in `afterEach` puts it back.
     */
    function silenceErrors(): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(console, 'error').mockImplementation(() => {});
    }

    /**
     * The relationship the ceiling's correctness rests on, made executable.
     *
     * A held outcome runs from the stay timer, not from `settle`, so a ceiling
     * inside the rail's own window could fire with an outcome already parked
     * behind it — and nothing in the givenUp guard covers that path,
     * because it does not go through `settle`. A prose version of this
     * relationship would not survive someone shortening the ceiling without
     * anyone noticing; this assertion does.
     */
    it('is armed beyond the rail\'s own window', () => {
      expect(VERIFY_CEILING_MS).toBeGreaterThan(
        RAIL_APPEARS_AFTER_MS + RAIL_STAYS_FOR_MS,
      );
    });

    /**
     * #446's acceptance criterion: a slow-but-working sign-in still completes.
     * The response lands well past the rail's window — the reader has been
     * watching the interstitial for seconds — but inside the ceiling, and the
     * ordinary success path runs untouched.
     */
    it('signs in a verification that answers slowly but inside the ceiling', async () => {
      vi.useFakeTimers();
      const deferred = deferredFetch(signedInBody);
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS - 1);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();

      deferred.resolve();
      await advance(1);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();
    });

    /**
     * The ceiling's own case, and the half that makes it worth building: the
     * screen it reaches must be distinguishable from a spent link.
     *
     * The absence assertion cannot rot silently — 'Verification failed' is
     * asserted PRESENT by other cases in this file already, so a rename
     * breaks them loudly rather than quietly passing here.
     */
    it('gives up on a verification that never answers, without blaming the link', async () => {
      vi.useFakeTimers();
      silenceErrors();
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS - 1);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();

      await advance(1);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();
      expect(screen.queryByText('Verification failed')).not.toBeInTheDocument();
      expect(screen.queryByText(RAIL_HEADING)).not.toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Send a new link' })).toHaveAttribute(
        'href',
        '/login',
      );
    });

    /** A verification that answered must not be given up on afterwards. The
     *  ceiling is cancelled by `settle`, not merely ignored by it. */
    it('does not give up on a verification that already answered', async () => {
      vi.useFakeTimers();
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(signedIn));
      render(<VerifyPage />);

      await advance(10);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();
    });

    /** The same rule as above, but for an outcome that arrived HELD — while
     *  the rail was up and still owed its minimum, so the outcome sat in
     *  `waiting.current` rather than running immediately from `settle`. The
     *  ceiling must be cancelled the moment `settle` accepts the outcome,
     *  not only once the stay timer later releases it. */
    it('does not give up on a verification that answered while the rail held it', async () => {
      vi.useFakeTimers();
      const deferred = deferredFetch(signedInBody);
      render(<VerifyPage />);

      await railUpWithOutcomeHeld(deferred);
      await advance(RAIL_STAYS_FOR_MS);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText("You're signed in.")).toBeInTheDocument();
      expect(screen.queryByText('Connection problem')).not.toBeInTheDocument();
    });

    /**
     * #446's fourth question, pinned: the session probe is covered by the same
     * ceiling, because what is bounded is the STATE, not the verify request.
     *
     * The verify POST fails immediately; the probe behind it never answers.
     * A ceiling armed inside the fetch's `.then`, or scoped to the first
     * request, leaves this reader stranded exactly as before.
     */
    it('gives up when the session probe is the request that never answers', async () => {
      vi.useFakeTimers();
      const errors = silenceErrors();
      const fetchMock = vi.fn();
      fetchMock.mockResolvedValueOnce({ ok: false, status: 400 });
      // The probe: rejects on abort rather than hanging forever unreactive,
      // so the ceiling's abort of THIS request is something the test can
      // actually exercise — the same shape the abandoned-verification case
      // above uses for the same reason.
      fetchMock.mockImplementation(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      render(<VerifyPage />);

      await advance(RAIL_APPEARS_AFTER_MS + 1);
      expect(screen.getByText(RAIL_HEADING)).toBeInTheDocument();

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();

      // The give-up fires as expected...
      expect(errors).toHaveBeenCalledWith(
        '[verify] no answer within the ceiling; giving up',
      );
      // ...but the probe's own abort must not ALSO be logged as a probe
      // failure: the ceiling caused it, and the give-up screen already says
      // so. Checked with a second argument matcher, not the bare string —
      // the real call carries the caught error as a second argument, so a
      // single-argument match would pass whether or not the guard exists.
      expect(errors).not.toHaveBeenCalledWith(
        '[verify] the session probe failed after a failed verification',
        expect.anything(),
      );
    });

    /**
     * Leaving before the ceiling fires takes the ceiling with it — the same
     * rule the held-outcome case above applies to the stay timer.
     *
     * Without the clear it fires on an unmounted page: a give-up logged for a
     * reader who is no longer there, and an abort of a request belonging to a
     * page that no longer exists.
     */
    it('drops the ceiling when the page is left before it fires', async () => {
      vi.useFakeTimers();
      const errors = silenceErrors();
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      const { unmount } = render(<VerifyPage />);

      await advance(RAIL_APPEARS_AFTER_MS + 1);
      unmount();

      // Named rather than `not.toHaveBeenCalled()`: this spy catches every
      // console.error in the process, so a bare assertion would also fail on
      // an unrelated React warning and report it as this defect.
      await advance(VERIFY_CEILING_MS);
      expect(errors).not.toHaveBeenCalledWith(
        '[verify] no answer within the ceiling; giving up',
      );
    });

    /** Nothing about this is diagnosable after the fact otherwise (#446). */
    it('logs the give-up with the prefix the rest of the file uses', async () => {
      vi.useFakeTimers();
      const errors = silenceErrors();
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS);
      expect(errors).toHaveBeenCalledWith(
        '[verify] no answer within the ceiling; giving up',
      );
    });

    /**
     * The one-way exit, on the branch where getting it wrong is worst.
     *
     * A success landing after the ceiling would apply the success state AND
     * schedule its redirect — and that redirect's timer is not cleared on
     * unmount, so it fires wherever the reader has got to by then. Before this
     * page had a button on the give-up screen there was nowhere for them to
     * have got to, which is why the hazard arrives with the fix.
     */
    it('refuses an outcome that arrives after it has given up', async () => {
      vi.useFakeTimers();
      silenceErrors();
      const deferred = deferredFetch(signedInBody);
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();

      deferred.resolve();
      await advance(RAIL_STAYS_FOR_MS + 900);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();
      expect(screen.queryByText("You're signed in.")).not.toBeInTheDocument();
      expect(push).not.toHaveBeenCalled();
    });

    /**
     * A different guard than the success case above, and worth naming as
     * such: by the time a late verify-POST rejection reaches the outer
     * `.catch`, the ceiling has already aborted the shared controller, so
     * `if (controller.signal.aborted) return;` exits before `settle` is
     * ever called — `givenUp` never even gets asked. The outcome (no
     * "Verification failed" screen appears) is the same as the success
     * case, but the mechanism protecting it is the abort guard, not the
     * one-way exit.
     */
    it('a late rejection after the ceiling is aborted before it can blame the link', async () => {
      vi.useFakeTimers();
      silenceErrors();
      let rejectVerify!: (value: unknown) => void;
      const pending = new Promise((r) => {
        rejectVerify = r;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ ok: false, status: 401 }),
      );
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();

      rejectVerify({ ok: false, status: 400 });
      await advance(RAIL_STAYS_FOR_MS);
      expect(screen.getByText('Connection problem')).toBeInTheDocument();
      expect(screen.queryByText('Verification failed')).not.toBeInTheDocument();
    });

    /**
     * Hygiene rather than correctness — the refusals above are what keep a
     * late answer off the screen. But a page saying it could not reach the
     * server while still holding an open request to that server is asserting
     * something it has not acted on, and the aborted signal is a positive
     * observable where the cases above can only assert absence.
     */
    it('abandons the request it has stopped waiting for', async () => {
      vi.useFakeTimers();
      silenceErrors();
      const fetchMock = vi.fn().mockReturnValue(new Promise(() => {}));
      vi.stubGlobal('fetch', fetchMock);
      render(<VerifyPage />);

      const { signal } = fetchMock.mock.calls[0]![1]! as { signal: AbortSignal };
      expect(signal.aborted).toBe(false);

      await advance(VERIFY_CEILING_MS);
      expect(signal.aborted).toBe(true);
    });

    /** An abandoned verification must not go on to probe the session: the
     *  answer is one nothing may act on, and its failure would log a fault
     *  that did not happen. */
    it('does not probe the session for a verification it abandoned', async () => {
      vi.useFakeTimers();
      const errors = silenceErrors();
      const fetchMock = vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'));
            });
          }),
      );
      vi.stubGlobal('fetch', fetchMock);
      render(<VerifyPage />);

      await advance(VERIFY_CEILING_MS);
      await advance(RAIL_STAYS_FOR_MS);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The abort guard runs BEFORE the classification, and that ordering is
      // the whole of what keeps our own abort from being reported as a fault.
      // Move the classification above it and this reader gets a fault line for
      // a request the page abandoned on purpose, one entry behind the give-up
      // line that already explained it. The probe's guard is pinned the same
      // way by `gives up when the session probe is the request that never
      // answers`, above.
      expect(errors).not.toHaveBeenCalledWith(
        '[verify] the verification request failed',
        expect.anything(),
      );
    });
  });

  /**
   * #452. The outer `.catch` used to treat every rejection as a spent link:
   * a 5xx, an unreadable body, a mis-shaped one and a network failure all
   * arrived indistinguishable from an expired link, and none of them put a
   * line of their own on the console. Where they landed on screen varied —
   * the error screen usually, but "Already signed in" when the session probe
   * behind them answered ok, which is the last case below.
   *
   * The 400 is the one silent case, and it is the commonest event on this
   * page — a link clicked twice. Everything else is a fault, and the last
   * case here is the one that most needed a line: the reader is shown a
   * perfectly ordinary screen while something genuine is broken.
   */
  describe('classifying a failed verification', () => {
    const FAULT_LINE = '[verify] the verification request failed';
    /** The probe's own status line. Distinct from the probe's THROW line
     *  (`'…the session probe failed after a failed verification'`, asserted at
     *  the bottom of this block) because the two are distinguishable causes: a
     *  probe that answered badly and one that never answered. */
    const PROBE_STATUS_LINE = '[verify] the session probe answered unexpectedly';

    /** Silenced rather than allowed through: these cases log by design, and
     *  an unstubbed spy prints each line once per test. Restored by
     *  `vi.restoreAllMocks()` in `afterEach`. */
    function watchErrors(): ReturnType<typeof vi.spyOn> {
      return vi.spyOn(console, 'error').mockImplementation(() => {});
    }

    /** The probe behind a failed verification, answering "no session". Sends
     *  every case below to the error screen except where stated.
     *
     *  The 401 is not decoration: it is what `/api/auth/session` answers a
     *  request carrying no usable session, and the probe's classification
     *  treats it as the ordinary case. Drop it and `res.status` is
     *  `undefined` here, which the classification reads as a fault — so every
     *  case below that uses this fixture AND asserts a call count fails,
     *  rather than quietly passing on a mock that lies. */
    const noSession = { ok: false, status: 401 };

    it('logs a server fault rather than blaming the link', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 500 }).mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      // Two assertions rather than one: `objectContaining` alone is duck-typed
      // and would accept a bare `{ status: 500 }` where the real error belongs,
      // and the message pins the docblock's rule that this string never reuses
      // the on-screen copy. Both range over the spy's whole call list, so they
      // do not by themselves prove one call satisfied both — what they catch is
      // a substituted payload, which is the realistic edit.
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(Error));
      expect(errors).toHaveBeenCalledWith(
        FAULT_LINE,
        expect.objectContaining({ status: 500, message: 'verify POST answered 500' }),
      );
      expect(errors).toHaveBeenCalledTimes(1);
    });

    /**
     * The boundary this design narrows on purpose. #452's wording says to
     * silence "the expected 4xx"; this file silences 400 alone. Nothing else
     * in this block can tell those two rules apart — an implementation
     * silencing all of 4xx passes every other case here.
     */
    it('logs a 4xx that is not the expected 400', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 404 }).mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.objectContaining({ status: 404 }));
    });

    /**
     * The deliberate silence, and the reason this fix is a classification
     * rather than an unconditional log: a spent link is the commonest
     * ordinary event on this page, and logging it would bury the cases above
     * and below in noise.
     *
     * This assertion cannot fail against an implementation that logs nothing
     * at all, which is what this file did before #452. Its evidence is the
     * mutation described under "Prove the guard bites — mutate, record,
     * restore" in
     * docs/superpowers/plans/2026-09-05-verify-catch-classification.md, not
     * this run.
     *
     * The bare `not.toHaveBeenCalled()` is deliberate where the ceiling's
     * cases use the argument-matching form: those assert that one specific
     * line is absent among others that legitimately fire, while this case
     * claims something stronger — that a spent link produces no console
     * output at all.
     */
    it('stays silent for the spent link that is the ordinary case', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValueOnce({ ok: false, status: 400 }).mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).not.toHaveBeenCalled();
    });

    /** A 2xx the body of which will not parse. Reaches the `.catch` from
     *  `res.json()`, which the throw above it means can only ever run on an
     *  ok response — so no status needs carrying for this one. */
    it('logs a success whose body cannot be read', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected token <');
            },
          })
          .mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(SyntaxError));
    });

    /** No response at all. The rejection carries no status because none
     *  exists, so it cannot be the silent case however the guard is written. */
    it('logs a verification that never reached the server', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockRejectedValueOnce(new TypeError('Failed to fetch'))
          .mockResolvedValueOnce(noSession),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(TypeError));
    });

    /**
     * The case with no symptom, which is why it is the one worth having.
     *
     * A 2xx whose body is mis-shaped throws on `json.data`, and by then the
     * server has already set a session cookie — so the probe in the `.catch`
     * answers ok and the reader is shown "Already signed in". Nothing is
     * wrong on screen and something is genuinely broken. Both halves are
     * asserted: the screen is unchanged (#452 is not a UX change) and the
     * fault now has a line.
     */
    it('logs the fault behind a mis-shaped success the probe then masks', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
          .mockResolvedValueOnce({
            ok: true,
            json: async () => ({ data: { teacherId: 't-1', studentId: null } }),
          }),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Already signed in')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.any(TypeError));
      // Holds WHERE the probe's classification sits, which nothing else here
      // does. This is the only case in the file with an ok probe and a watched
      // console: move the classification above the `if (res.ok)` block and this
      // ok response is classified too, making it two lines instead of one.
      // No other case in this block reaches the guard with an ok response —
      // they answer the probe not-ok, or reject it — so all of them stay green
      // under that move.
      expect(errors).toHaveBeenCalledTimes(1);
    });

    /**
     * #456. The probe's own half of the partition, and the case it exists for.
     *
     * A non-ok probe does not throw, so the `catch (probeErr)` below it never
     * runs: before this, a 503 and a 401 were indistinguishable, both falling
     * past `if (res.ok)` to the error screen with no line of any kind. The
     * reader is then told their link failed — possibly while signed in, and
     * on the strength of an answer nothing read.
     *
     * Both cases pair the probe with a 400 verification, the one silent case
     * above, so `toHaveBeenCalledTimes(1)` names the probe's line specifically
     * rather than counting two classifications together.
     *
     * 404 is here for the reason `logs a 4xx that is not the expected 400`
     * exists for the verification's own classification: it is the only case
     * that can tell this rule apart from `status >= 500`, which the 503 alone
     * would pass.
     */
    it.each([
      { status: 503, why: 'a backend fault' },
      { status: 404, why: 'a 4xx that is not the silent 401' },
    ])('logs a probe answering $status — $why', async ({ status }) => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 400 })
          .mockResolvedValueOnce({ ok: false, status }),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(PROBE_STATUS_LINE, { status });
      expect(errors).toHaveBeenCalledTimes(1);
    });

    /**
     * The silent branch.
     *
     * Three deliberate choices separate it from `stays silent for the spent
     * link that is the ordinary case`, which pins a different rule that today
     * shares a fixture with this one:
     *
     * - The 401 is written inline rather than taken from `noSession`. The
     *   shared helper carries it too, which is why `logs a server fault` and
     *   the spent-link case above both go red if the probe's 401 is ever
     *   classified as a fault — but both hold it by a call count, and a call
     *   count is what someone loosens when an unrelated line is added to this
     *   page. This case survives that, and survives an edit to the helper.
     * - The verification beside it is 500, not 400 — loud on purpose. The
     *   fault line is asserted PRESENT before the probe line is asserted
     *   absent, so this cannot pass by observing nothing at all: the spy is
     *   live and the `.catch` demonstrably ran. That is the vacuity the
     *   spent-link case has to disclaim in its own docblock, and this case
     *   does not inherit it.
     * - The absence is argument-matched. Per the rule set out under `stays
     *   silent for the spent link`, the bare form claims no console output at
     *   all while the argument-matched form names one line among others that
     *   legitimately fire. A legitimate line fires here, so this is the
     *   correct form rather than merely the safer one.
     *
     * It remains vacuous with respect to the guard's EXISTENCE — delete the
     * classification entirely and this still passes. Only the `401` → `418`
     * mutation recorded in
     * docs/superpowers/plans/2026-09-05-verify-probe-classification.md turns it
     * red, which is why that mutation is not optional.
     */
    it('stays silent for the 401 that is the probe being told "no session"', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 500 })
          .mockResolvedValueOnce({ ok: false, status: 401 }),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.objectContaining({ status: 500 }));
      expect(errors).not.toHaveBeenCalledWith(PROBE_STATUS_LINE, expect.anything());
    });

    /**
     * Both log sites, in the one scenario that reaches them together: the
     * backend is unreachable, so the verification fails and the probe sent to
     * recover from it throws too. Every other case in this block answers the
     * probe with `noSession` — not ok, but it does not throw, so the probe's
     * own `catch` never runs and the two lines are otherwise only ever
     * exercised apart.
     *
     * This is what holds the classification's position from BELOW. The
     * ordering assertion in the ceiling block holds it from above; move the
     * classification down into the `try` and it stops running for exactly
     * this case, while every other case here stays green.
     */
    it('logs the verification and the probe separately when both fail', async () => {
      const errors = watchErrors();
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValueOnce({ ok: false, status: 503 })
          .mockRejectedValueOnce(new TypeError('Failed to fetch')),
      );
      render(<VerifyPage />);

      expect(await screen.findByText('Verification failed')).toBeInTheDocument();
      // Distinct payloads on purpose: an edit that logs the wrong error in
      // either place fails here rather than passing on a coincidence.
      expect(errors).toHaveBeenCalledWith(FAULT_LINE, expect.objectContaining({ status: 503 }));
      expect(errors).toHaveBeenCalledWith(
        '[verify] the session probe failed after a failed verification',
        expect.any(TypeError),
      );
      expect(errors).toHaveBeenCalledTimes(2);
    });
  });
});
