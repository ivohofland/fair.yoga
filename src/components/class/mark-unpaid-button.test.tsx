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

    // Review F7. This test used to end at `release`, so the half that matters
    // most went unasserted. The component states this contract in prose — "if
    // that request later succeeds, the settled state renders, which is the
    // honest outcome" — and it holds only because `done` is checked *above*
    // the `confirming` branch. Tapped Keep or not, a POST that commits must
    // not leave the row reading "Mark unpaid" over a payment now unpaid.
    expect(await screen.findByText('Marked unpaid')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /mark unpaid/i })).toBeNull();
  });

  /**
   * PR #198 review P3/P4. G2 above proves Keep is *clickable* in flight. It
   * does not prove Keep achieves anything: it only reset `confirming`, so
   * `busy` walked out of the confirm view still true. The POST is hung —
   * deliberately never released — so nothing will ever clear it, and the
   * teacher's next click on "Mark unpaid" reopens a confirm whose only action
   * reads "Updating…" and is disabled. That is #40's frozen control exactly,
   * relocated one click later.
   *
   * The release is omitted on purpose: a test that has to resolve the promise
   * to reach its assertion is testing the resolution, not the escape.
   */
  it('leaves no in-flight state behind, so a reopened confirm is operable', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /updating/i })).toBeDisabled());

    fireEvent.click(screen.getByRole('button', { name: /keep/i }));
    fireEvent.click(screen.getByRole('button', { name: /mark unpaid/i }));

    expect(screen.queryByRole('button', { name: /updating/i })).toBeNull();
    expect(screen.getByRole('button', { name: /^confirm unpaid$/i })).toBeEnabled();
  });

  /**
   * PR #198 review P4. The same leak in the error channel. `error` renders
   * inside the confirm branch, so Keep hides it without clearing it — and the
   * next "Mark unpaid" reopens the confirm with a red server message from an
   * attempt the teacher already walked away from, attached to a click they
   * have not made yet.
   */
  it('clears a failed attempt, so a reopened confirm is not pre-labelled as failed', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      json: async () => ({ error: 'Cannot undo: current status is "pending". Must be "paid".' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    openConfirm();

    fireEvent.click(screen.getByRole('button', { name: /confirm unpaid/i }));
    await screen.findByText('Cannot undo: current status is "pending". Must be "paid".');

    fireEvent.click(screen.getByRole('button', { name: /keep/i }));
    fireEvent.click(screen.getByRole('button', { name: /mark unpaid/i }));

    expect(
      screen.queryByText('Cannot undo: current status is "pending". Must be "paid".'),
    ).toBeNull();
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
