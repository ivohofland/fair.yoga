import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CancelStudioClassButton } from './cancel-studio-class-button';
import { routerRefresh } from '../../../tests/setup/components';

/**
 * Same defect as the two class buttons (#166 re-review M5). The confirm step
 * makes it worse rather than better: the teacher has already answered "yes,
 * cancel this", so an unchanged page reads as the cancellation having gone
 * through, and the class stays on their schedule and in their income figures.
 */
describe('CancelStudioClassButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const confirm = () => {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel class' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  };

  it('sends the cancellation and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelStudioClassButton studioClassId="sc-3" />);

    confirm();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/studio-classes/sc-3');
    expect(init.method).toBe('PUT');
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('shows the server message when the cancellation is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'This class was already cancelled.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelStudioClassButton studioClassId="sc-3" />);

    confirm();

    expect(await screen.findByText('This class was already cancelled.')).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<CancelStudioClassButton studioClassId="sc-3" />);

    confirm();

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
  });
});
