import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { BookingFlow } from './booking-flow';

/**
 * #158. An unreadable stored tier must not be named back to the student as
 * theirs, and must not reach the booking write: the registration route stamps
 * `tierAtBooking` from the profile column, which the CHECK constraint would
 * reject. Picking a tier PUTs it before the booking POST, which is what
 * repairs the row — hence the call-order assertion below.
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
        slug="teacher-slug"
        isFull={false}
        alreadyBooked={false}
        currentTier={3}
        studentId="student-1"
        tierPrices={tierPrices}
        isFirstBooking={false}
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
});
