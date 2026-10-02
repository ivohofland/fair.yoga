import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerPush, routerRefresh } from '../../../tests/setup/components';

const disablePushMock = vi.fn<() => Promise<'off' | 'failed'>>();
vi.mock('@/lib/push-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/push-client')>();
  return {
    ...actual,
    disablePush: (...args: Parameters<typeof actual.disablePush>) => disablePushMock(...args),
  };
});

import { SignOutButton } from './sign-out-button';

/**
 * #40. This was the only component in the codebase that reset its pending flag
 * on no path at all — not even failure. The session cookie is already cleared
 * server-side by the time the push runs, so a dropped commit left the user
 * looking at a stale authenticated shell with no working control to leave it.
 *
 * A plain reset is correct here rather than a settled state: DELETE
 * /api/auth/session is idempotent, so a second tap is harmless, and "success"
 * means being on another page — there is nothing to settle to.
 */
describe('SignOutButton', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    disablePushMock.mockResolvedValue('off');
  });

  afterEach(() => {
    fetchMock.mockReset();
    disablePushMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('DELETEs the session, then pushes and refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' }),
    );
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  // G3
  it('re-enables when the push and refresh commit nothing', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    expect(screen.getByRole('button')).toHaveTextContent('Sign out');
  });

  it('still leaves for the login page when the DELETE itself fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offline = new Error('offline');
    fetchMock.mockRejectedValue(offline);
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    expect(consoleError).toHaveBeenCalledWith('[sign-out-button] request failed', {
      err: offline,
    });
    consoleError.mockRestore();
  });

  // #724. A device left subscribed after sign-out would keep receiving the
  // signed-out account's pushes once someone else signs in on it.
  it('unsubscribes this device before clearing the session', async () => {
    const order: string[] = [];
    disablePushMock.mockImplementation(async () => {
      order.push('disablePush');
      return 'off';
    });
    fetchMock.mockImplementation(async () => {
      order.push('fetch');
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(order).toEqual(['disablePush', 'fetch']);
  });

  it('proceeds within 3s when disablePush never resolves', async () => {
    vi.useFakeTimers();
    disablePushMock.mockReturnValue(new Promise<'off' | 'failed'>(() => {}));
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<SignOutButton />);

      fireEvent.click(screen.getByRole('button'));
      await vi.advanceTimersByTimeAsync(2_999);
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' });
      expect(routerPush).toHaveBeenCalledWith('/login');
      expect(consoleError).toHaveBeenCalledWith(
        '[sign-out-button] request failed',
        expect.objectContaining({ step: 'push-timeout' }),
      );
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it('logs no timeout when disablePush settles first', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<SignOutButton />);

      fireEvent.click(screen.getByRole('button'));
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' });
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(consoleError).not.toHaveBeenCalledWith(
        '[sign-out-button] request failed',
        expect.objectContaining({ step: 'push-timeout' }),
      );
    } finally {
      vi.useRealTimers();
      consoleError.mockRestore();
    }
  });

  it('proceeds when disablePush rejects, and logs the rejection', async () => {
    const failure = new Error('unsubscribe failed');
    disablePushMock.mockRejectedValue(failure);
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<SignOutButton />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() =>
        expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' }),
      );
      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
      expect(consoleError).toHaveBeenCalledWith('[sign-out-button] request failed', { step: 'push', err: failure });
    } finally {
      consoleError.mockRestore();
    }
  });

  // #431. The signup flow mounts this button to open a door, and landing on
  // /login would be a second closed one: someone signing out in order to sign
  // UP wants the signup page.
  it('honours an explicit destination instead of the /login default', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton redirectTo="/signup" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/signup'));
    expect(routerPush).not.toHaveBeenCalledWith('/login');
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  // A non-2xx DELETE (a 502 during a deploy, say) was previously
  // indistinguishable from a genuine success — the session cookie survives,
  // and on a page like /signup that re-mounts this same panel, the reader
  // sees no sign of anything having gone wrong. This pins that the failure
  // is now visible AND that the "never trap the user in a signed-in shell"
  // guarantee (#40) still holds even when the response says failure.
  it('shows a failure message when the DELETE responds not-ok, and still pushes and refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(routerPush).toHaveBeenCalledWith('/login');
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });
});
