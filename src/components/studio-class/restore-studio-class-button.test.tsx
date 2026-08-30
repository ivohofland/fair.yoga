import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RestoreStudioClassButton } from './restore-studio-class-button';
import { routerRefresh } from '../../../tests/setup/components';

describe('RestoreStudioClassButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('renders the restore button in idle state', () => {
    render(<RestoreStudioClassButton studioClassId="sc-1" />);
    const button = screen.getByRole('button', { name: 'Restore class' });
    expect(button).toBeInTheDocument();
    expect(button).not.toBeDisabled();
  });

  it('sends cancelledAt: null and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<RestoreStudioClassButton studioClassId="sc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/studio-classes/sc-1');
    expect(init.method).toBe('PUT');
    expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ cancelledAt: null });
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('disables the button and shows in-flight state while restoring', async () => {
    let resolveFetch!: (value: unknown) => void;
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal('fetch', fetchMock);
    render(<RestoreStudioClassButton studioClassId="sc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));

    const button = screen.getByRole('button', { name: 'Restoring...' });
    expect(button).toBeDisabled();

    resolveFetch({ ok: true });
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });

  it('shows the server message when restoration is refused (e.g. 409 duplicate slot)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'You already have a class at 09:00 on 6 May 2031.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<RestoreStudioClassButton studioClassId="sc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));

    expect(await screen.findByText('You already have a class at 09:00 on 6 May 2031.')).toBeInTheDocument();
    expect(routerRefresh).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Restore class' });
    expect(button).not.toBeDisabled();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<RestoreStudioClassButton studioClassId="sc-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Restore class' }));

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Restore class' });
    expect(button).not.toBeDisabled();
  });
});
