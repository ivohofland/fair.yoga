import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import LoginPage from './page';

function submit(email = 'anna@example.com') {
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: /Send me the link/i }));
}

describe('LoginPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('swaps itself for the sent-message panel, with the handoff code entry rendered', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<LoginPage />);

    submit();

    expect(await screen.findByText('Check your inbox for the link.')).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toBeInTheDocument();
  });
});
