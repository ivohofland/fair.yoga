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

  it('names the teacher and states nothing is shared until the student says so', () => {
    stubFetch();
    render(<PendingInvitationCard invitationId="inv-1" teacherName="Jane Teacher" />);
    expect(screen.getByText('Jane Teacher')).toBeInTheDocument();
    expect(screen.getByText(/nothing is shared until you say so/i)).toBeInTheDocument();
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
