import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerRefresh } from '../../../tests/setup/components';
import { PendingInvitationCard } from './pending-invitation-card';

/**
 * #166 Task 11. This is the student's only surface for answering an
 * invitation — the card the privacy page renders above the teacher list.
 * Accept and decline both POST the same route with a different literal
 * body, and both must call `router.refresh()` so the answered invitation's
 * teacher moves into (or off) the list below without a manual reload.
 * Decline goes through a two-step confirm, same idiom as
 * `RemoveStudentButton` — these tests pin that a click on the trigger alone
 * never fetches.
 */
describe('PendingInvitationCard', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  function stubFailure(status: number, body: unknown = {}) {
    fetchMock.mockResolvedValue({ ok: false, status, json: async () => body });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('names the teacher and states no contact details are shared until the student says so', () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    expect(screen.getByText('Jane Teacher')).toBeInTheDocument();
    expect(screen.getByText(/no contact details are shared until you say so/i)).toBeInTheDocument();
  });

  it('accept POSTs { response: "accept" } and refreshes on success', async () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/invitations/inv-1/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: 'accept' }),
      }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  // Review F7 found that `setSubmitting(false)` in a `finally` fired right
  // after the success branch called `router.refresh()`, before that refresh had
  // repainted the page and dropped this card. A second click in that window
  // reached the server for an invitation that was already answered, surfacing a
  // red "already answered" over an action that had, in fact, succeeded.
  //
  // F7's conclusion stands and is still pinned below: a second click must not
  // reach the server. #40 changed only its remedy. F7 left `submitting` true
  // forever, which froze all four controls when the refresh never committed —
  // a student could give neither answer. The card now settles instead, which
  // blocks the second POST *and* leaves the student somewhere they can act.
  it('settles after a successful accept, and cannot send a second POST', async () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }));

    expect(await screen.findByText(/^Accepted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^accept$/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // …and the fetch count alone cannot say whether Refresh does anything.
    // `routerRefresh` is a bare `vi.fn()` that renders nothing, so
    // `onAction={() => {}}` leaves the count at 1 exactly as the real wiring
    // does — measured: both suites stayed green under that mutation. An inert
    // way out is the one failure `SettledNotice` promises cannot happen.
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  it('settles to "Declined" after a successful decline', async () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));

    expect(await screen.findByText(/^Declined/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /decline invitation/i })).toBeNull();
  });

  // G6, second half — Mode 2. If the POST hangs rather than resolving, the
  // settled state never renders, and Cancel is the only way out.
  it('leaves Cancel operable while the decline is in flight', async () => {
    let release!: (value: { ok: boolean }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));

    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    await waitFor(() => expect(screen.getByRole('button', { name: /declining/i })).toBeDisabled());
    expect(cancel).toBeEnabled();

    fireEvent.click(cancel);
    release({ ok: true });

    // Review F7. This test used to end at `release`, asserting nothing about
    // what the resolved request renders. Cancel cannot recall an in-flight
    // POST, so a decline that lands after it must still settle — and that
    // holds only because `done` is checked above the whole return, ahead of
    // `confirmingDecline`. Otherwise the card reverts to Accept/Decline over
    // an invitation that has already been declined.
    expect(await screen.findByText(/^Declined/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^accept$/i })).toBeNull();
  });

  /**
   * PR #198 review P3. The test above proves Cancel is clickable in flight.
   * This proves it accomplishes something. Cancel only reset
   * `confirmingDecline`, so `submitting` came back out to the neutral view
   * still true — and Accept is `disabled={submitting}`. On a decline POST that
   * hangs rather than resolving, the student landed on a card where neither
   * answer could be given, with no error and no explanation: the exact frozen
   * control #40 exists to remove, one control over from where it was fixed.
   *
   * The promise is never released. Cancel's whole claim is that it works
   * without the request coming back, so releasing it to reach the assertion
   * would test the release instead.
   */
  it('leaves no in-flight state behind, so Accept survives a cancelled decline', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /declining/i })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.getByRole('button', { name: /^accept$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^decline$/i })).toBeEnabled();
  });

  /**
   * PR #198 review P4. Worse here than in its two siblings: `{error && …}`
   * renders at section scope, outside the confirm ternary, so a message earned
   * by a decline the student abandoned stays on screen underneath the neutral
   * Accept/Decline choice — with nothing left to explain what it refers to.
   */
  it('clears a failed decline when Cancel leaves the confirm', async () => {
    stubFailure(500);
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));
    await screen.findByText('Could not respond. Try again.');

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));

    expect(screen.queryByText('Could not respond. Try again.')).toBeNull();
  });

  /**
   * PR #198 review P4, the ordering nothing exercised anywhere: every
   * in-flight test on this branch released `{ ok: true }`, so a request
   * abandoned via the escape and *failing* afterwards was untested in all
   * three confirm components.
   *
   * Cancel is a state reset, not an abort, so that failure still runs its
   * branch. What must hold is that it lands on an operable card — both
   * answers available, nothing frozen — and that the failure is still
   * reported rather than swallowed. It is reported without context, which is
   * untidy; that is recorded here rather than fixed, because suppressing a
   * late failure needs an abandonment flag, and the same flag would have to
   * keep letting a late *success* through, which the settled-state test above
   * requires.
   */
  it('stays operable, and still reports, when a cancelled decline fails afterwards', async () => {
    let release!: (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /declining/i })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    release({ ok: false, status: 500, json: async () => ({}) });

    expect(await screen.findByText('Could not respond. Try again.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^accept$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /^decline$/i })).toBeEnabled();
  });

  it('renders no decline confirmation, and fetches nothing, until the trigger is clicked', () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    expect(screen.queryByText(/can't be undone/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.getByText(/can't be undone/i)).toBeInTheDocument();
  });

  it('decline confirmation POSTs { response: "decline" } and refreshes on success', async () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /decline invitation/i }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/invitations/inv-1/respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response: 'decline' }),
      }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  it('cancel returns to the unconfirmed state without fetching', () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^decline$/i }));
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(screen.queryByText(/can't be undone/i)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces the server error message on a failed accept, and does not refresh', async () => {
    stubFailure(409, {
      error: { message: 'This invitation has already been answered', code: 'ALREADY_ANSWERED' },
    });
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }));
    expect(
      await screen.findByText('This invitation has already been answered'),
    ).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('falls back to a generic message when the server sends none', async () => {
    stubFailure(500);
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    fireEvent.click(screen.getByRole('button', { name: /^accept$/i }));
    expect(await screen.findByText('Could not respond. Try again.')).toBeInTheDocument();
  });
});
