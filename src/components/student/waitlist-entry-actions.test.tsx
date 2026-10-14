import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WaitlistEntryActions } from './waitlist-entry-actions';
import { routerRefresh } from '../../../tests/setup/components';

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, url: '/api/waitlist', json: async () => body };
}

describe('WaitlistEntryActions', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function renderActions(canClaim: boolean): void {
    render(
      <WaitlistEntryActions entryId="entry-1" classId="class-1" classLabel="Yin, Friday 18:00" canClaim={canClaim} />,
    );
  }

  it('offers the claim only while a spot can be claimed', () => {
    renderActions(false);
    expect(screen.queryByRole('button', { name: 'Claim the spot for Yin, Friday 18:00' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave waitlist for Yin, Friday 18:00' })).toBeInTheDocument();
    expect(
      screen.queryByText('Claiming books you in, and you\'ll pay your share even if you can\'t make it.'),
    ).not.toBeInTheDocument();
  });

  it('warns that claiming books and charges before offering the claim button (#236)', () => {
    renderActions(true);
    expect(
      screen.getByText('Claiming books you in, and you\'ll pay your share even if you can\'t make it.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim the spot for Yin, Friday 18:00' })).toBeInTheDocument();
  });

  describe('claim', () => {
    it('claims the spot and refreshes', async () => {
      fetchMock.mockResolvedValue(reply(201, { data: { id: 'entry-1', status: 'promoted' } }));
      vi.stubGlobal('fetch', fetchMock);
      renderActions(true);

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot for Yin, Friday 18:00' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/waitlist/claim',
        expect.objectContaining({ method: 'POST', body: JSON.stringify({ classId: 'class-1' }) }),
      );
    });

    it('treats a spot the student already holds as claimed', async () => {
      fetchMock.mockResolvedValue(reply(200, { data: { classId: 'class-1' }, outcome: 'unchanged' }));
      vi.stubGlobal('fetch', fetchMock);
      renderActions(true);

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot for Yin, Friday 18:00' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('announces a lost spot in the server’s words', async () => {
      fetchMock.mockResolvedValue(
        reply(409, { error: { message: 'Someone else just took the spot.', code: 'SPOT_TAKEN' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(true);

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot for Yin, Friday 18:00' }));

      // The message stays, and the page is read again so the row stops
      // offering a seat that is gone.
      expect(await screen.findByRole('alert')).toHaveTextContent('Someone else just took the spot.');
      expect(routerRefresh).toHaveBeenCalled();
    });
  });

  it('does not read the page again after a network error — the server said nothing', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);
    renderActions(true);

    fireEvent.click(screen.getByRole('button', { name: 'Claim the spot for Yin, Friday 18:00' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Try again.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('keeps the page as it is after a server error — it says nothing about the class', async () => {
    fetchMock.mockResolvedValue(
      reply(503, { error: { message: 'Busy right now. Please try again.', code: 'SERVICE_UNAVAILABLE' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderActions(true);

    fireEvent.click(screen.getByRole('button', { name: 'Claim the spot for Yin, Friday 18:00' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Busy right now. Please try again.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  describe('leave', () => {
    /** The trigger, then the confirmation's own Leave button. */
    function leave(): void {
      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist for Yin, Friday 18:00' }));
      fireEvent.click(screen.getByRole('button', { name: 'Leave the waitlist for Yin, Friday 18:00' }));
    }

    it('asks before leaving, says the place is lost, and sends nothing on the first tap', () => {
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist for Yin, Friday 18:00' }));

      expect(screen.getByText("Leave the waitlist? You'll lose your place in the queue.")).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Leave the waitlist for Yin, Friday 18:00' })).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the place when the student changes their mind', () => {
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist for Yin, Friday 18:00' }));
      fireEvent.click(screen.getByRole('button', { name: 'Stay on the waitlist' }));

      expect(screen.queryByRole('button', { name: 'Leave the waitlist for Yin, Friday 18:00' })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Leave waitlist for Yin, Friday 18:00' })).toHaveFocus();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('leaves and refreshes', async () => {
      fetchMock.mockResolvedValue(reply(200, { data: { message: 'Removed from waitlist' } }));
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      leave();

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith('/api/waitlist/entry-1', { method: 'DELETE' });
    });

    it('treats a queue already left as done', async () => {
      fetchMock.mockResolvedValue(
        reply(200, { data: { message: 'Removed from waitlist' }, outcome: 'unchanged' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      leave();

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('treats a waitlist spot that no longer exists as done', async () => {
      fetchMock.mockResolvedValue(
        reply(404, { error: { message: 'This waitlist spot no longer exists.', code: 'NOT_FOUND' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      leave();

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('announces a spot that is no longer active, and reads the page again', async () => {
      fetchMock.mockResolvedValue(
        reply(409, {
          error: {
            message: 'That waitlist spot is no longer active — refresh to see the latest.',
            code: 'WAITLIST_ENTRY_INACTIVE',
          },
        }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      leave();

      expect(await screen.findByRole('alert')).toHaveTextContent('no longer active');
      expect(routerRefresh).toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Leave the waitlist for Yin, Friday 18:00' })).not.toBeDisabled();
    });
  });
});
