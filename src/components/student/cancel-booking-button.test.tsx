import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CancelBookingButton } from './cancel-booking-button';
import { routerRefresh } from '../../../tests/setup/components';

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url: '/api/registrations/reg-1',
    json: async () => body,
  };
}

describe('CancelBookingButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  /** Opens the confirmation, then confirms. */
  function confirmCancel(): void {
    render(<CancelBookingButton registrationId="reg-1" cancelDeadline="HOURS_24" />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));
  }

  it('cancels the booking and refreshes the page', async () => {
    fetchMock.mockResolvedValue(reply(200, { data: { id: 'reg-1', status: 'cancelled' } }));
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/registrations/reg-1', { method: 'DELETE' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a booking the server finds already cancelled as done', async () => {
    fetchMock.mockResolvedValue(
      reply(200, { data: { id: 'reg-1', status: 'cancelled' }, outcome: 'unchanged' }),
    );
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats a booking that no longer exists as done', async () => {
    fetchMock.mockResolvedValue(
      reply(404, { error: { message: 'This booking no longer exists.', code: 'NOT_FOUND' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows any other refusal in the server’s words and stays put', async () => {
    fetchMock.mockResolvedValue(
      reply(409, {
        error: {
          message: "This class has finished, so the booking can't be cancelled.",
          code: 'CLASS_TERMINAL',
        },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "This class has finished, so the booking can't be cancelled.",
    );
    expect(routerRefresh).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Cancel booking' })).not.toBeDisabled();
  });

  it('says so when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    confirmCancel();

    expect(await screen.findByRole('alert')).toHaveTextContent('Network error. Try again.');
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
