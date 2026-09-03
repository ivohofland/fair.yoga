import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BookingSignIn } from './booking-sign-in';

function fillAndSubmitNew() {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'anna@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: /Send me the link/i }));
}

describe('BookingSignIn', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('swaps itself for the "Check your inbox" panel, with the handoff code entry rendered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<BookingSignIn redirect="/book/class-1" />);

    fillAndSubmitNew();

    expect(await screen.findByText('Check your inbox')).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });

  it('has no name inputs, and posts exactly the email and redirect', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<BookingSignIn redirect="/book/class-1" />);

    expect(screen.queryByLabelText('First name')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Last name')).not.toBeInTheDocument();

    fillAndSubmitNew();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/student-signup');
    expect(JSON.parse(init.body as string)).toEqual({ email: 'anna@example.com', redirect: '/book/class-1' });
  });
});
