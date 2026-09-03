import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BookingSignIn } from './booking-sign-in';

function fillAndSubmitNew() {
  fireEvent.change(screen.getByLabelText('First name'), { target: { value: 'Anna' } });
  fireEvent.change(screen.getByLabelText('Last name'), { target: { value: 'Smith' } });
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
});
