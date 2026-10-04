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

const clearOfflinePages = vi.fn<() => Promise<void>>(async () => {});
vi.mock('@/lib/offline-client', () => ({
  clearOfflinePages: () => clearOfflinePages(),
}));

const flushOutbox = vi.fn<(owner: string) => Promise<{ applied: number }>>(async () => ({ applied: 0 }));
const pendingCount = vi.fn<(owner: string) => number>(() => 0);
const clearAllOutboxes = vi.fn<() => void>();
vi.mock('@/lib/attendance-outbox', () => ({
  flushOutbox: (owner: string) => flushOutbox(owner),
  pendingCount: (owner: string) => pendingCount(owner),
  clearAllOutboxes: () => clearAllOutboxes(),
}));

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
    clearOfflinePages.mockClear();
    flushOutbox.mockReset();
    flushOutbox.mockImplementation(async () => ({ applied: 0 }));
    pendingCount.mockReset();
    pendingCount.mockImplementation(() => 0);
    clearAllOutboxes.mockReset();
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
    render(<SignOutButton />);

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

// #726, spec D6 and D8. Queued attendance belongs to the account that leaves;
// on the teacher settings page the button first tries to sync it and, failing
// that, says what will be lost before anything is sent.
describe('SignOutButton and the attendance outbox', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    disablePushMock.mockResolvedValue('off');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    fetchMock.mockReset();
    disablePushMock.mockReset();
    clearOfflinePages.mockClear();
    flushOutbox.mockReset();
    flushOutbox.mockImplementation(async () => ({ applied: 0 }));
    pendingCount.mockReset();
    pendingCount.mockImplementation(() => 0);
    clearAllOutboxes.mockReset();
    routerPush.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ['without an owner, DELETE ok', undefined, () => Promise.resolve({ ok: true })],
    ['without an owner, DELETE not-ok', undefined, () => Promise.resolve({ ok: false })],
    ['without an owner, DELETE rejects', undefined, () => Promise.reject(new Error('offline'))],
    ['with an owner, DELETE ok', 'acc-1', () => Promise.resolve({ ok: true })],
    ['with an owner, DELETE rejects', 'acc-1', () => Promise.reject(new Error('offline'))],
  ])('clears every outbox before it navigates (%s)', async (_label, owner, answer) => {
    const order: string[] = [];
    fetchMock.mockImplementation(async () => {
      order.push('fetch');
      return answer();
    });
    clearAllOutboxes.mockImplementation(() => order.push('outboxes'));
    routerPush.mockImplementation(() => order.push('push'));
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton outboxOwner={owner} />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(order).toEqual(['fetch', 'outboxes', 'push']);
  });

  it('never flushes without an owner', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(flushOutbox).not.toHaveBeenCalled();
    expect(pendingCount).not.toHaveBeenCalled();
  });

  it("flushes the owner's queue before the push teardown and the DELETE, and asks nothing once it empties", async () => {
    const order: string[] = [];
    let flushed = false;
    pendingCount.mockImplementation(() => (flushed ? 0 : 1));
    flushOutbox.mockImplementation(async (owner) => {
      order.push(`flush:${owner}`);
      flushed = true;
      return { applied: 1 };
    });
    disablePushMock.mockImplementation(async () => {
      order.push('disablePush');
      return 'off';
    });
    fetchMock.mockImplementation(async () => {
      order.push('fetch');
      return { ok: true };
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton outboxOwner="acc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(order).toEqual(['flush:acc-1', 'disablePush', 'fetch']);
    expect(screen.queryByText(/will be lost/)).not.toBeInTheDocument();
  });

  it('stops waiting for the flush after 5 s', async () => {
    vi.useFakeTimers();
    flushOutbox.mockReturnValue(new Promise<{ applied: number }>(() => {}));
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    try {
      render(<SignOutButton outboxOwner="acc-1" />);

      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      await vi.advanceTimersByTimeAsync(4_999);
      expect(pendingCount).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(pendingCount).toHaveBeenCalledWith('acc-1');
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { method: 'DELETE' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [1, '1 attendance change hasn\'t synced and will be lost.'],
    [3, '3 attendance changes haven\'t synced and will be lost.'],
  ])('with %i queued change(s) left after the flush, confirms in the button\'s place and sends nothing', async (count, copy) => {
    pendingCount.mockReturnValue(count);
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton outboxOwner="acc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText(copy)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out anyway' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(disablePushMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clearAllOutboxes).not.toHaveBeenCalled();
    expect(clearOfflinePages).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('"Sign out anyway" tears push down, DELETEs and clears', async () => {
    const order: string[] = [];
    pendingCount.mockReturnValue(2);
    disablePushMock.mockImplementation(async () => {
      order.push('disablePush');
      return 'off';
    });
    fetchMock.mockImplementation(async () => {
      order.push('fetch');
      return { ok: true };
    });
    clearAllOutboxes.mockImplementation(() => order.push('outboxes'));
    clearOfflinePages.mockImplementation(async () => {
      order.push('pages');
    });
    routerPush.mockImplementation(() => order.push('push'));
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton outboxOwner="acc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out anyway' }));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    expect(flushOutbox).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['disablePush', 'fetch', 'pages', 'outboxes', 'push']);
    clearOfflinePages.mockImplementation(async () => {});
  });

  it('"Cancel" restores the button and sends nothing', async () => {
    pendingCount.mockReturnValue(1);
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton outboxOwner="acc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('button', { name: 'Sign out' })).toBeEnabled();
    expect(screen.queryByText(/will be lost/)).not.toBeInTheDocument();
    expect(disablePushMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clearAllOutboxes).not.toHaveBeenCalled();
    expect(clearOfflinePages).not.toHaveBeenCalled();
    expect(routerPush).not.toHaveBeenCalled();
  });
});
