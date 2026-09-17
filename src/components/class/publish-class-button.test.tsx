import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PublishClassButton } from './publish-class-button';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * The fourth instance of the same defect (#166 re-review M5): `if (res.ok)`
 * with no `else` and no `catch`. The success path is a `router.refresh()`,
 * so a failure that says nothing repaints nothing — the button re-enables
 * and the class is still a draft, which reads as a click that never landed.
 * A teacher's response to that is to click again, and again.
 *
 * This is the transition a class's whole life hangs off: unpublished, no
 * student can find it.
 */
describe('PublishClassButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('posts the open transition and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublishClassButton classId="c-1" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/classes/c-1/transition', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'open' }),
      }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('shows the server message when the transition is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          code: 'CLASS_STARTS_IN_PAST',
          message: "This class's start time has already passed, so it can't be published.",
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublishClassButton classId="c-1" />);

    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText("This class's start time has already passed, so it can't be published."),
    ).toBeInTheDocument();
    // Refreshes on refusal as well as on success (#249), which is the reverse
    // of what this line asserted until the past-start guard landed. A 409 here
    // means the server knows something the rendered page does not, and since
    // one of the reasons is now "this draft's start has already passed" — a
    // fact a clock can make true with no write at all — the page that decided
    // to show a Publish button is stale by definition. `ClassEditForm` has
    // refreshed on refusal since #247 for the same reason; this button is the
    // one that did not.
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('treats an unchanged answer as success: the class was already published', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { ok: true, newStatus: 'open' }, outcome: 'unchanged' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublishClassButton classId="c-1" />);

    fireEvent.click(screen.getByRole('button'));

    // The button re-enables in the handler's `finally`, after whichever branch
    // ran — so this is the settle point, not the assertion. Saying nothing is
    // the assertion: `router.refresh()` cannot separate the two branches here,
    // because this button refreshes on refusal as well (#249).
    await waitFor(() => expect(screen.getByRole('button')).toBeEnabled());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublishClassButton classId="c-1" />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
  });
});
