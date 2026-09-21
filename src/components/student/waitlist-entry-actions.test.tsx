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
    render(<WaitlistEntryActions entryId="entry-1" classId="class-1" canClaim={canClaim} />);
  }

  it('offers the claim only while a spot can be claimed', () => {
    renderActions(false);
    expect(screen.queryByRole('button', { name: 'Claim the spot' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Leave waitlist' })).toBeInTheDocument();
  });

  describe('claim', () => {
    it('claims the spot and refreshes', async () => {
      fetchMock.mockResolvedValue(reply(201, { data: { id: 'entry-1', status: 'promoted' } }));
      vi.stubGlobal('fetch', fetchMock);
      renderActions(true);

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot' }));

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

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('announces a lost spot in the server’s words', async () => {
      fetchMock.mockResolvedValue(
        reply(409, { error: { message: 'Someone else just took the spot.', code: 'SPOT_TAKEN' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(true);

      fireEvent.click(screen.getByRole('button', { name: 'Claim the spot' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Someone else just took the spot.');
      expect(routerRefresh).not.toHaveBeenCalled();
    });
  });

  describe('leave', () => {
    it('leaves and refreshes', async () => {
      fetchMock.mockResolvedValue(reply(200, { data: { message: 'Removed from waitlist' } }));
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(fetchMock).toHaveBeenCalledWith('/api/waitlist/entry-1', { method: 'DELETE' });
    });

    it('treats a queue already left as done', async () => {
      fetchMock.mockResolvedValue(
        reply(200, { data: { message: 'Removed from waitlist' }, outcome: 'unchanged' }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('treats a waitlist spot that no longer exists as done', async () => {
      fetchMock.mockResolvedValue(
        reply(404, { error: { message: 'This waitlist spot no longer exists.', code: 'NOT_FOUND' } }),
      );
      vi.stubGlobal('fetch', fetchMock);
      renderActions(false);

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist' }));

      await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('announces a spot that is no longer active, and stays put', async () => {
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

      fireEvent.click(screen.getByRole('button', { name: 'Leave waitlist' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('no longer active');
      expect(routerRefresh).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Leave waitlist' })).not.toBeDisabled();
    });
  });
});
