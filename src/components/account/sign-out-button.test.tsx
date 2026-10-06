import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { routerPush, routerRefresh } from '../../../tests/setup/components';

const disablePushMock = vi.fn<() => Promise<'off' | 'failed'>>();
vi.mock('@/lib/push-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/push-client')>();
  return {
    ...actual,
    disablePush: (...args: Parameters<typeof actual.disablePush>) => disablePushMock(...args),
  };
});

const clearOfflinePages = vi.fn<() => Promise<void>>(async () => {});
vi.mock('@/lib/offline-client', () => ({
  clearOfflinePages: () => clearOfflinePages(),
}));

import { SignOutButton } from './sign-out-button';
import { enqueueAttendance, getOutbox, resetOutboxForTests } from '@/lib/attendance-outbox';
import { resetSyncForTests } from '@/lib/attendance-sync';

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
    localStorage.clear();
    resetOutboxForTests();
    resetSyncForTests();
    disablePushMock.mockResolvedValue('off');
  });

  afterEach(() => {
    fetchMock.mockReset();
    disablePushMock.mockReset();
    clearOfflinePages.mockClear();
    vi.unstubAllGlobals();
  });

  it('DELETEs the session, then pushes and refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton accountId="owner-1" />);

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
    render(<SignOutButton accountId="owner-1" />);

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
    render(<SignOutButton accountId="owner-1" />);

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
    render(<SignOutButton accountId="owner-1" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(order).toEqual(['disablePush', 'fetch']);
  });

  // The device's stored teacher pages belong to the account that just left.
  it.each([
    ['answers ok', () => Promise.resolve({ ok: true })],
    ['answers not-ok', () => Promise.resolve({ ok: false })],
    ['rejects', () => Promise.reject(new Error('offline'))],
  ])('clears the stored pages after the DELETE %s, before it navigates', async (_label, answer) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push('fetch');
      return answer();
    });
    clearOfflinePages.mockImplementation(async () => {
      await Promise.resolve();
      order.push('cleared');
    });
    routerPush.mockImplementation(() => order.push('push'));
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton accountId="owner-1" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(order).toEqual(['fetch', 'cleared', 'push']);
    clearOfflinePages.mockImplementation(async () => {});
    routerPush.mockReset();
  });

  it('proceeds within 3s when disablePush never resolves', async () => {
    vi.useFakeTimers();
    disablePushMock.mockReturnValue(new Promise<'off' | 'failed'>(() => {}));
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<SignOutButton accountId="owner-1" />);

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
      render(<SignOutButton accountId="owner-1" />);

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
      render(<SignOutButton accountId="owner-1" />);

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

  it('still leaves, and re-enables, when clearing the queued attendance rejects', async () => {
    const failure = new Error('lock unavailable');
    Object.defineProperty(navigator, 'locks', {
      value: { request: () => Promise.reject(failure) },
      configurable: true,
    });
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(<SignOutButton accountId="owner-1" />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
      expect(routerRefresh).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
      expect(consoleError).toHaveBeenCalledWith('[sign-out-button] request failed', {
        step: 'clear-outbox',
        err: failure,
      });
    } finally {
      consoleError.mockRestore();
      Reflect.deleteProperty(navigator, 'locks');
    }
  });

  // #431. The signup flow mounts this button to open a door, and landing on
  // /login would be a second closed one: someone signing out in order to sign
  // UP wants the signup page.
  it('honours an explicit destination instead of the /login default', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton accountId="owner-1" redirectTo="/signup" />);

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
    render(<SignOutButton accountId="owner-1" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(routerPush).toHaveBeenCalledWith('/login');
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  describe('queued attendance', () => {
    function queue(n: number) {
      return Promise.all(
        Array.from({ length: n }, (_, i) =>
          enqueueAttendance({
            ownerId: 'owner-1',
            registrationId: `reg-${i}`,
            classId: 'class-1',
            studentName: `Student ${i}`,
            status: 'attended',
          }),
        ),
      );
    }

    function stubFetch(attendance: (url: string) => Promise<unknown>) {
      fetchMock.mockImplementation((url: string) =>
        url === '/api/auth/session' ? Promise.resolve({ ok: true }) : attendance(url),
      );
      vi.stubGlobal('fetch', fetchMock);
    }

    const confirmed = (url: string) =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { id: url.split('/').pop(), status: 'attended' } }), {
          status: 200,
          headers: { Date: new Date().toUTCString() },
        }),
      );

    it('signs out at once when nothing is queued', async () => {
      stubFetch(() => Promise.reject(new Error('unused')));
      render(<SignOutButton accountId="owner-1" />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('signs out without a warning when the flush confirms every entry', async () => {
      await queue(2);
      stubFetch(confirmed);
      render(<SignOutButton accountId="owner-1" />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
      expect(screen.queryByText(/haven't synced yet/)).not.toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' });
    });

    it('counts entries another tab wrote after this one cached the outbox', async () => {
      getOutbox();
      localStorage.setItem(
        'fy-outbox-v1',
        JSON.stringify({
          pending: {
            'reg-9': {
              id: 'e9',
              ownerId: 'owner-1',
              registrationId: 'reg-9',
              classId: 'class-1',
              studentName: 'Student 9',
              status: 'attended',
              recordedAt: Date.now(),
            },
          },
          confirmed: {},
          refused: {},
        }),
      );
      stubFetch(() => Promise.reject(new Error('offline')));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<SignOutButton accountId="owner-1" />);

      fireEvent.click(screen.getByRole('button'));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "1 attendance change hasn't synced yet. Signing out discards them.",
      );
    });

    it('warns with the count, and neither tears down push nor DELETEs, when entries remain', async () => {
      await queue(2);
      stubFetch(() => Promise.reject(new Error('offline')));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<SignOutButton accountId="owner-1" />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent("2 attendance changes haven't synced yet. Signing out discards them.");
      expect(disablePushMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' });
      expect(routerPush).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Sign out anyway' })).toBeInTheDocument();
    });

    it('sends only the signed-in account\'s queued changes, and warns with every account\'s', async () => {
      await queue(1);
      await enqueueAttendance({
        ownerId: 'owner-2',
        registrationId: 'reg-other',
        classId: 'class-2',
        studentName: 'Someone Else',
        status: 'no_show',
      });
      stubFetch(confirmed);
      render(<SignOutButton accountId="owner-1" />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "1 attendance change hasn't synced yet. Signing out discards them.",
      );
      expect(fetchMock).toHaveBeenCalledWith('/api/registrations/reg-0', expect.anything());
      expect(fetchMock).not.toHaveBeenCalledWith('/api/registrations/reg-other', expect.anything());
      expect(Object.keys(getOutbox().pending)).toEqual(['reg-other']);
    });

    it('with no signed-in account to send for, sends nothing and warns with every queued change', async () => {
      await queue(2);
      stubFetch(confirmed);
      render(<SignOutButton accountId={null} />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        "2 attendance changes haven't synced yet. Signing out discards them.",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not wait on a flush that never settles', async () => {
      vi.useFakeTimers();
      await queue(1);
      stubFetch(() => new Promise(() => {}));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        render(<SignOutButton accountId="owner-1" />);

        fireEvent.click(screen.getByRole('button'));
        await act(() => vi.advanceTimersByTimeAsync(2_999));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        await act(() => vi.advanceTimersByTimeAsync(1));

        expect(screen.getByRole('alert')).toHaveTextContent("1 attendance change hasn't synced yet.");
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      ['answers ok', () => Promise.resolve({ ok: true })],
      ['rejects', () => Promise.reject(new Error('offline'))],
    ])('sign out anyway clears whatever the DELETE %s', async (_label, answer) => {
      await queue(1);
      fetchMock.mockImplementation((url: string) =>
        url === '/api/auth/session' ? answer() : Promise.reject(new Error('offline')),
      );
      vi.stubGlobal('fetch', fetchMock);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      render(<SignOutButton accountId="owner-1" />);
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Sign out anyway' }));

      await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' });
      expect(disablePushMock).toHaveBeenCalled();
      expect(Object.keys(getOutbox().pending)).toEqual([]);
    });
  });
});
