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

// Ahead of the real clock, so the request-flow tests (no fake timers) open
// the before-deadline confirm. The label is never read by those tests — only
// the fetch flow is under test there.
const FUTURE_INSTANT = '2099-01-01T00:00:00.000Z';
const FUTURE_LABEL = 'Fri 1 Jan 00:00';

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
        freeCancelUntilAt={FUTURE_INSTANT}
        freeCancelUntilLabel={FUTURE_LABEL}
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
 * Whether the free-cancel instant has passed is decided once, at the first
 * "Cancel booking" tap, and held — never recomputed from the clock at
 * render. Scoped to this describe block so the fetch-flow tests above keep
 * the real clock.
 */
describe('CancelBookingButton free-cancel-aware copy', () => {
  const FREE_UNTIL_AT = '2026-06-01T12:00:00.000Z';
  const FREE_UNTIL_LABEL = 'Mon 1 Jun 12:00';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the free-until label verbatim while the instant is still ahead', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    render(
      <CancelBookingButton
        registrationId="reg-1"
        freeCancelUntilAt={FREE_UNTIL_AT}
        freeCancelUntilLabel={FREE_UNTIL_LABEL}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    expect(
      screen.getByText(
        'Cancel this booking? Free until Mon 1 Jun 12:00 — after that the class is still charged.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the after-instant copy once the free-cancel instant has passed', () => {
    vi.setSystemTime(new Date('2026-06-01T13:00:00.000Z'));
    render(
      <CancelBookingButton
        registrationId="reg-1"
        freeCancelUntilAt={FREE_UNTIL_AT}
        freeCancelUntilLabel={FREE_UNTIL_LABEL}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    expect(
      screen.getByText(
        "The cancellation deadline has passed, so you'll still pay your share of this class. Cancelling lets your teacher know you won't be there.",
      ),
    ).toBeInTheDocument();
  });

  it('shows the before-instant copy exactly at the free-until instant, matching the server\'s `>`', () => {
    vi.setSystemTime(new Date(FREE_UNTIL_AT));
    render(
      <CancelBookingButton
        registrationId="reg-1"
        freeCancelUntilAt={FREE_UNTIL_AT}
        freeCancelUntilLabel={FREE_UNTIL_LABEL}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    expect(
      screen.getByText(
        'Cancel this booking? Free until Mon 1 Jun 12:00 — after that the class is still charged.',
      ),
    ).toBeInTheDocument();
  });

  it('decides at tap time, not at render — a clock that crosses the instant while the page sits open shows the after copy', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    render(
      <CancelBookingButton
        registrationId="reg-1"
        freeCancelUntilAt={FREE_UNTIL_AT}
        freeCancelUntilLabel={FREE_UNTIL_LABEL}
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

  it('holds the before copy across a re-render, even once the clock has since crossed the instant (#664)', () => {
    vi.setSystemTime(new Date('2026-06-01T10:00:00.000Z'));
    const { rerender } = render(
      <CancelBookingButton
        registrationId="reg-1"
        freeCancelUntilAt={FREE_UNTIL_AT}
        freeCancelUntilLabel={FREE_UNTIL_LABEL}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel booking' }));

    vi.setSystemTime(new Date('2026-06-01T13:00:00.000Z'));
    rerender(
      <CancelBookingButton
        registrationId="reg-1"
        freeCancelUntilAt={FREE_UNTIL_AT}
        freeCancelUntilLabel={FREE_UNTIL_LABEL}
      />,
    );

    expect(
      screen.getByText(
        'Cancel this booking? Free until Mon 1 Jun 12:00 — after that the class is still charged.',
      ),
    ).toBeInTheDocument();
  });
});

/**
 * Step 4's server-render check. `renderToStaticMarkup` only ever sees the
 * component's initial (unconfirmed) render — the confirm copy is behind
 * `useState`, set from an `onClick` handler, and static rendering runs no
 * event and commits no state update. So there is no way to reach the label
 * text through `renderToStaticMarkup`; what it CAN show is that the initial
 * markup carries no formatted time of its own (no weekday/hour digits) for
 * this component to have derived — the label passed in never appears before
 * a tap, because nothing is formatted until a tap asks for it via the prop.
 * The prop-to-copy flow itself (the label appearing verbatim once tapped) is
 * already covered by the fake-timer tests above; this test's job is only to
 * back up that the component does no formatting of its own before that.
 */
describe('CancelBookingButton server-render', () => {
  it('renders only the trigger button server-side, with no time formatting of its own', async () => {
    const { renderToStaticMarkup } = await import('react-dom/server');
    const html = renderToStaticMarkup(
      <CancelBookingButton
        registrationId="reg-1"
        freeCancelUntilAt={FUTURE_INSTANT}
        freeCancelUntilLabel={FUTURE_LABEL}
      />,
    );
    expect(html).toContain('Cancel booking');
    expect(html).not.toContain(FUTURE_LABEL);
  });
});
