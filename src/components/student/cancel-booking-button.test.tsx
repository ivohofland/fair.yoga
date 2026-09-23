import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

// Far enough past every fixed system time this file sets that the
// request-flow tests (real clock, no fake timers) never cross it.
const FUTURE_DEADLINE = '2099-01-01T00:00:00.000Z';

describe('CancelBookingButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  /** Opens the confirmation, then confirms. */
  function confirmCancel(): void {
    render(
      <CancelBookingButton
        registrationId="reg-1"
        cancelDeadline="HOURS_24"
        cancelDeadlineAt={FUTURE_DEADLINE}
      />,
    );
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

/**
 * The deadline is decided once, at the first "Cancel booking" tap, and
 * stored — never recomputed from the clock at render. Scoped to this
 * describe block so the fetch-flow tests above keep the real clock.
 */
describe('CancelBookingButton deadline-aware copy', () => {
  const DEADLINE = '2026-06-01T12:00:00.000Z';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the before-deadline copy while the deadline is still ahead', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    render(
      <CancelBookingButton
        registrationId="reg-1"
        cancelDeadline="HOURS_24"
        cancelDeadlineAt={DEADLINE}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    expect(
      screen.getByText(
        'Cancel this booking? Free until 24 hours before class — after that the class is still charged.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the after-deadline copy once the deadline has passed', () => {
    vi.setSystemTime(new Date('2026-06-01T13:00:00.000Z'));
    render(
      <CancelBookingButton
        registrationId="reg-1"
        cancelDeadline="HOURS_24"
        cancelDeadlineAt={DEADLINE}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    expect(
      screen.getByText(
        "The cancellation deadline has passed, so you'll still pay your share of this class. Cancelling lets your teacher know you won't be there.",
      ),
    ).toBeInTheDocument();
  });

  it('shows the before-deadline copy exactly at the deadline, matching the server\'s `>`', () => {
    vi.setSystemTime(new Date(DEADLINE));
    render(
      <CancelBookingButton
        registrationId="reg-1"
        cancelDeadline="HOURS_24"
        cancelDeadlineAt={DEADLINE}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    expect(
      screen.getByText(
        'Cancel this booking? Free until 24 hours before class — after that the class is still charged.',
      ),
    ).toBeInTheDocument();
  });

  it('decides at tap time, not at render — a clock that crosses the deadline while the page sits open shows the after copy', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    render(
      <CancelBookingButton
        registrationId="reg-1"
        cancelDeadline="HOURS_24"
        cancelDeadlineAt={DEADLINE}
      />,
    );

    vi.setSystemTime(new Date('2026-06-01T13:00:00.000Z'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    expect(
      screen.getByText(
        "The cancellation deadline has passed, so you'll still pay your share of this class. Cancelling lets your teacher know you won't be there.",
      ),
    ).toBeInTheDocument();
  });

  it('holds the before copy across a re-render, even once the clock has since crossed the deadline', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    const { rerender } = render(
      <CancelBookingButton
        registrationId="reg-1"
        cancelDeadline="HOURS_24"
        cancelDeadlineAt={DEADLINE}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    vi.setSystemTime(new Date('2026-06-01T13:00:00.000Z'));
    rerender(
      <CancelBookingButton
        registrationId="reg-1"
        cancelDeadline="HOURS_24"
        cancelDeadlineAt={DEADLINE}
      />,
    );

    expect(
      screen.getByText(
        'Cancel this booking? Free until 24 hours before class — after that the class is still charged.',
      ),
    ).toBeInTheDocument();
  });
});
