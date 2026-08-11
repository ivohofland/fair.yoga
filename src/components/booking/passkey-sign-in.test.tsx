import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PasskeySignIn } from './passkey-sign-in';
import { routerPush, routerRefresh } from '../../../tests/setup/components';

const startAuthentication = vi.fn();
vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthentication(...args),
}));

/**
 * #40. Sign-in is the gate to the whole app, and this button froze at
 * "Follow your device…" on a URL that did not change — so nothing on screen
 * suggested a reload and the user simply could not get in.
 *
 * The reset is explicit rather than a `finally` because `state` carries the
 * error too; see the last test, which fails against a `finally` version.
 */
describe('PasskeySignIn', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    startAuthentication.mockReset();
    startAuthentication.mockResolvedValue({ id: 'cred-1' });
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubHappyPath() {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { options: { challenge: 'c' }, challengeId: 'ch-1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { redirectTo: '/bookings' } }),
      });
    vi.stubGlobal('fetch', fetchMock);
  }

  it('pushes the returned redirect and refreshes', async () => {
    stubHappyPath();
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/bookings'));
    expect(routerRefresh).toHaveBeenCalledTimes(1);
  });

  // G4
  it('returns to idle when the push and refresh commit nothing', async () => {
    stubHappyPath();
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in with a passkey/i })).toBeEnabled(),
    );
  });

  // G5 — the reset must not be a `finally`, or this error is erased.
  it('shows the fallback message when verification fails', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { options: { challenge: 'c' }, challengeId: 'ch-1' } }),
      })
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal('fetch', fetchMock);
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText(/use the email link instead/i)).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('returns silently to idle when the user dismisses the OS prompt', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: { options: { challenge: 'c' }, challengeId: 'ch-1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const dismissed = new Error('dismissed');
    dismissed.name = 'NotAllowedError';
    startAuthentication.mockRejectedValue(dismissed);
    render(<PasskeySignIn />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /sign in with a passkey/i })).toBeEnabled(),
    );
    expect(screen.queryByText(/use the email link instead/i)).toBeNull();
  });
});
