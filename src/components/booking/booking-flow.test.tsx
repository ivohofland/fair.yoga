import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BookingFlow } from './booking-flow';

/**
 * #158. BookingFlow asks for a tier instead of naming one when the stored
 * value is unreadable. Picking a tier PUTs it before the registration POST,
 * repairing the row in flight — the call-order assertion below pins this
 * sequence. See docs/superpowers/specs/2026-09-01-degraded-tier-downstream-design.md
 * § 3 for why the booking route needs a valid profile tier.
 */
describe('BookingFlow', () => {
  const fetchMock = vi.fn();
  const tierPrices = [10, 11, 12, 13, 14];

  type FlowProps = Parameters<typeof BookingFlow>[0];

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
  }

  function renderFlow(overrides: Partial<FlowProps> = {}) {
    render(
      <BookingFlow
        classId="class-1"
        isFull={false}
        alreadyBooked={false}
        currentTier={3}
        studentId="student-1"
        tierPrices={tierPrices}
        isFirstBooking={false}
        openPaymentsCount={0}
        {...overrides}
      />,
    );
  }

  it('asks for a tier instead of naming one when the stored tier is unreadable', () => {
    stubFetch();
    renderFlow({ currentTier: null, isFirstBooking: false });
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    for (const radio of screen.getAllByRole('radio')) {
      expect(radio).toHaveAttribute('aria-checked', 'false');
    }
    expect(screen.queryByText(/You're in Tier/)).not.toBeInTheDocument();
  });

  it('keeps the spread explanation with the picker it explains', () => {
    stubFetch();
    renderFlow({ currentTier: null, isFirstBooking: false });
    expect(
      screen.getByText(/highest tier pays about twice the lowest/i),
    ).toBeInTheDocument();
  });

  it('toggles the pricing explanation in-place without navigating away or losing the chosen tier', () => {
    stubFetch();
    renderFlow({ currentTier: null, isFirstBooking: false });

    // The explanation is not visible initially
    expect(
      screen.queryByText(/Prices are income-based: everyone in the room pays/i),
    ).not.toBeInTheDocument();

    // A tier chosen before opening the explainer is the state this whole
    // toggle exists to protect (#432 replaced a navigating <Link> with it).
    const tierRadio = screen.getByRole('radio', { name: /Tier 2 · Managing/ });
    fireEvent.click(tierRadio);
    expect(tierRadio).toHaveAttribute('aria-checked', 'true');

    const toggleButton = screen.getByRole('button', { name: 'Learn more' });
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    // It is an in-place button, not a navigation link (#432)
    expect(screen.queryByRole('link', { name: 'Learn more' })).not.toBeInTheDocument();

    // Click "Learn more" to reveal explanation
    fireEvent.click(toggleButton);
    expect(
      screen.getByText(/Prices are income-based: everyone in the room pays what fits their situation/i),
    ).toBeInTheDocument();
    expect(toggleButton).toHaveAttribute('aria-expanded', 'true');
    expect(toggleButton).toHaveTextContent('Hide explanation');
    expect(toggleButton).toHaveAttribute('aria-controls', 'pricing-explainer-panel');
    expect(tierRadio).toHaveAttribute('aria-checked', 'true');

    // Click "Hide explanation" to collapse — tier selection still intact
    fireEvent.click(toggleButton);
    expect(
      screen.queryByText(/Prices are income-based: everyone in the room pays/i),
    ).not.toBeInTheDocument();
    expect(toggleButton).toHaveAttribute('aria-expanded', 'false');
    expect(toggleButton).toHaveTextContent('Learn more');
    expect(tierRadio).toHaveAttribute('aria-checked', 'true');
  });

  it('refuses to book until an unreadable tier has been replaced', () => {
    stubFetch();
    renderFlow({ currentTier: null });
    const book = screen.getByRole('button', { name: /^Book$/ });
    expect(book).toBeDisabled();
    fireEvent.click(book);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses the waitlist too — promotion stamps the same column', () => {
    stubFetch();
    renderFlow({ currentTier: null, isFull: true });
    expect(screen.getByRole('button', { name: /join the waitlist/i })).toBeDisabled();
  });

  it('saves the chosen tier before it books, so the write sees a valid one', async () => {
    stubFetch();
    renderFlow({ currentTier: null });
    fireEvent.click(screen.getByRole('radio', { name: /Tier 2 · Managing/ }));
    fireEvent.click(screen.getByRole('button', { name: /Book — around/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [firstUrl, firstOpts] = fetchMock.mock.calls[0] ?? [];
    expect(firstUrl).toBe('/api/students/student-1');
    const put = firstOpts as { method: string; body: string };
    expect(put.method).toBe('PUT');
    expect(JSON.parse(put.body)).toEqual({ incomeTier: 2 });

    expect((fetchMock.mock.calls[1] ?? [])[0]).toBe('/api/registrations');
  });

  it('does not touch the profile when a readable tier is left unchanged', async () => {
    stubFetch();
    renderFlow({ currentTier: 3, isFirstBooking: true });
    fireEvent.click(screen.getByRole('button', { name: /Book — around/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect((fetchMock.mock.calls[0] ?? [])[0]).toBe('/api/registrations');
  });

  // #389. product-concept.md's booking-flow nudge — friendly, never blocking.
  describe('open payments nudge', () => {
    it('shows no reminder when there are no open payments', () => {
      stubFetch();
      renderFlow({ openPaymentsCount: 0 });
      expect(screen.queryByText(/open payment/)).not.toBeInTheDocument();
    });

    it('names one open payment in the singular', () => {
      stubFetch();
      renderFlow({ openPaymentsCount: 1 });
      expect(screen.getByText('You have 1 open payment with this teacher.')).toBeInTheDocument();
    });

    it('names multiple open payments in the plural', () => {
      stubFetch();
      renderFlow({ openPaymentsCount: 3 });
      expect(screen.getByText('You have 3 open payments with this teacher.')).toBeInTheDocument();
    });

    it('links the reminder to the student bookings page', () => {
      stubFetch();
      renderFlow({ openPaymentsCount: 2 });
      expect(screen.getByRole('link', { name: /view your bookings/i })).toHaveAttribute(
        'href',
        '/bookings',
      );
    });

    it('does not show the reminder on the already-booked screen', () => {
      stubFetch();
      renderFlow({ alreadyBooked: true, openPaymentsCount: 2 });
      expect(screen.queryByText(/open payment/)).not.toBeInTheDocument();
    });

    it('still shows the reminder above a full class waitlist button', () => {
      stubFetch();
      renderFlow({ isFull: true, openPaymentsCount: 1 });
      expect(screen.getByText('You have 1 open payment with this teacher.')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /join the waitlist/i })).toBeInTheDocument();
    });
  });
});
