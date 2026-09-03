import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HandoffCodeEntry } from './handoff-code-entry';

/**
 * The success path leaves via `window.location.assign` (a full navigation —
 * `/claim` just set the session cookie), matching the pattern in
 * `delete-studio-class-button.test.tsx`.
 */
const realLocation = window.location;
const stubLocation = () => {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  return assign;
};

function enterCode(code = '482913') {
  fireEvent.change(screen.getByLabelText('Code'), { target: { value: code } });
  fireEvent.click(screen.getByRole('button', { name: /Continue/i }));
}

describe('HandoffCodeEntry', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'location', { value: realLocation, writable: true });
  });

  it('renders the explanatory line and a 6-digit input', () => {
    vi.stubGlobal('fetch', vi.fn());
    render(<HandoffCodeEntry />);

    expect(
      screen.getByText(
        'Opened it somewhere else? Wherever you opened it will show you a code — enter it here.',
      ),
    ).toBeInTheDocument();

    const input = screen.getByLabelText('Code');
    expect(input).toHaveAttribute('inputMode', 'numeric');
    expect(input).toHaveAttribute('autoComplete', 'one-time-code');
    expect(input).toHaveAttribute('maxLength', '6');
    expect(input).toHaveAttribute('pattern', '\\d{6}');
  });

  it('posts the typed code to /api/auth/magic-link/claim', async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { accountId: 'acc-1', redirectTo: '/schedule' } }),
    });
    vi.stubGlobal('fetch', mock);
    stubLocation();
    render(<HandoffCodeEntry />);

    enterCode('482913');

    await waitFor(() => expect(mock).toHaveBeenCalled());
    const [url, init] = mock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/auth/magic-link/claim');
    expect(JSON.parse(init.body as string)).toEqual({ code: '482913' });
  });

  it('navigates to the returned redirectTo on success', async () => {
    const mock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { accountId: 'acc-1', redirectTo: '/bookings' } }),
    });
    vi.stubGlobal('fetch', mock);
    const assign = stubLocation();
    render(<HandoffCodeEntry />);

    enterCode('482913');

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/bookings'));
  });

  it('shows the server message on a 400 without clearing the typed code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        json: async () => ({ error: { message: 'That code did not work. Ask for a new link.' } }),
      }),
    );
    render(<HandoffCodeEntry />);

    enterCode('000000');

    expect(
      await screen.findByText('That code did not work. Ask for a new link.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Code')).toHaveValue('000000');
  });
});
