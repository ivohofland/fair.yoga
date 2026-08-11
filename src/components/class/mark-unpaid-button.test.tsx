import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarkUnpaidButton } from './mark-unpaid-button';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * #40. The success path is a `router.refresh()`, which returns `void` — the
 * component cannot learn whether the commit landed. It used to bet that the
 * refresh would unmount it, leaving `busy` true forever when that bet lost:
 * both "Confirm unpaid" and its "Keep" escape disabled, on a money-correcting
 * action, while the row still read "✓ paid".
 *
 * The router mock in `tests/setup/components.ts` is a bare `vi.fn()`, so every
 * test here already runs in exactly that dropped-commit state.
 */
describe('MarkUnpaidButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function openConfirm() {
    render(<MarkUnpaidButton paymentId="pay-1" />);
    fireEvent.click(screen.getByRole('button', { name: /mark unpaid/i }));
  }

  it('POSTs to the unpaid endpoint and refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/payments/pay-1/unpaid', { method: 'POST' }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
  });

  // G1
  it('settles to "Marked unpaid" when the refresh commits nothing', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    expect(await screen.findByText('Marked unpaid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /updating/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /confirm unpaid/i })).toBeNull();
  });

  // G1, second half: the settled state must not re-offer the action.
  it('cannot send a second POST once settled', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));
    await screen.findByText('Marked unpaid');

    fireEvent.click(screen.getByRole('button', { name: /refresh/i }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(routerRefresh).toHaveBeenCalledTimes(2);
  });

  // G2
  it('leaves Keep operable while the POST is in flight', async () => {
    let release!: (value: { ok: boolean }) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    const keep = screen.getByRole('button', { name: /keep/i });
    await waitFor(() => expect(screen.getByRole('button', { name: /updating/i })).toBeDisabled());
    expect(keep).toBeEnabled();

    fireEvent.click(keep);
    expect(screen.getByRole('button', { name: /mark unpaid/i })).toBeInTheDocument();

    release({ ok: true });
  });

  it('shows the server error and re-enables on a failed POST', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Cannot undo: current status is "pending". Must be "paid".' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));

    expect(
      await screen.findByText('Cannot undo: current status is "pending". Must be "paid".'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm unpaid/i })).toBeEnabled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
