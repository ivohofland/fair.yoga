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
      json: async () => ({ error: { message: 'Set a room before publishing.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<PublishClassButton classId="c-1" />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Set a room before publishing.')).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<PublishClassButton classId="c-1" />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
  });
});
