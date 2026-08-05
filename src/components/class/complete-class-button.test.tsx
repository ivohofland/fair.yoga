import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CompleteClassButton } from './complete-class-button';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * Same defect as `PublishClassButton` (#166 re-review M5), with more behind
 * it: completing runs the pricing engine, writes the payment rows and
 * notifies everyone registered. A silent failure leaves the teacher looking
 * at an unchanged page with no idea whether any of that happened, and the
 * obvious response — click again — is the one thing they should not do while
 * uncertain.
 */
describe('CompleteClassButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('posts the completion and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/classes/c-9/complete', { method: 'POST' }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('shows the server message when completion is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'This class has already been completed.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" />);

    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText('This class has already been completed.'),
    ).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<CompleteClassButton classId="c-9" />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
  });
});
