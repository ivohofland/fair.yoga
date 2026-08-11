import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SignOutButton } from './sign-out-button';
import { routerPush, routerRefresh } from '../../../tests/setup/components';

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

  afterEach(() => {
    fetchMock.mockReset();
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
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<SignOutButton />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/login'));
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
  });
});
