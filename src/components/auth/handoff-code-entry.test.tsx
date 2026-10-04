import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HandoffCodeEntry } from './handoff-code-entry';

const clearOfflinePages = vi.fn(async () => {});
vi.mock('@/lib/offline-client', () => ({
  clearOfflinePages: () => clearOfflinePages(),
}));

const recordPushDevice = vi.fn(async () => {});
vi.mock('@/lib/push-client', () => ({
  recordPushDeviceBeforeNavigation: () => recordPushDevice(),
}));

/**
 * The success path leaves via `window.location.assign` (a full navigation —
 * `/claim` just set the session cookie). jsdom's `location` is replaced
 * wholesale for each such test and restored in `afterEach`.
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
    vi.useRealTimers();
    clearOfflinePages.mockReset();
    clearOfflinePages.mockImplementation(async () => {});
    recordPushDevice.mockReset();
    recordPushDevice.mockImplementation(async () => {});
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

  // #745. The navigation is a full page load, which would abort a request
  // still in flight, so this path waits for the re-record where the others
  // fire and forget.
  it('re-records the push device before it navigates away', async () => {
    const order: string[] = [];
    recordPushDevice.mockImplementation(async () => {
      await Promise.resolve();
      order.push('recorded');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { accountId: 'acc-1', redirectTo: '/schedule' } }),
      }),
    );
    const assign = stubLocation();
    assign.mockImplementation(() => order.push('navigated'));
    render(<HandoffCodeEntry />);

    enterCode();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/schedule'));
    expect(order).toEqual(['recorded', 'navigated']);
  });

  it.each([
    ['a session', { accountId: 'acc-1', redirectTo: '/schedule' }],
    ['a signup ticket', { redirectTo: '/signup/teacher' }],
  ])('clears the stored pages for %s before it navigates away', async (_label, data) => {
    const order: string[] = [];
    clearOfflinePages.mockImplementation(async () => {
      await Promise.resolve();
      order.push('cleared');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data }) }),
    );
    const assign = stubLocation();
    assign.mockImplementation(() => order.push('navigated'));
    render(<HandoffCodeEntry />);

    enterCode();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(data.redirectTo));
    expect(order).toEqual(['cleared', 'navigated']);
  });

  it('does not re-record the push device for a signup ticket, which is not a session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ data: { redirectTo: '/signup/teacher' } }),
      }),
    );
    const assign = stubLocation();
    render(<HandoffCodeEntry />);

    enterCode();

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/signup/teacher'));
    expect(recordPushDevice).not.toHaveBeenCalled();
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
