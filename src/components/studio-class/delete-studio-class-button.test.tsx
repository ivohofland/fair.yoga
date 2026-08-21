import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeleteStudioClassButton } from './delete-studio-class-button';

/**
 * The success path leaves via a full navigation (`window.location.assign`)
 * rather than the router: a soft push serves the back link's stale prefetch
 * of the schedule, which kept rendering a removed row. jsdom's `location` is
 * replaced wholesale here so each test gets a fresh spy.
 */
const stubLocation = () => {
  const assign = vi.fn();
  Object.defineProperty(window, 'location', { value: { assign }, writable: true });
  return assign;
};

describe('DeleteStudioClassButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const openConfirm = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Remove this class' }));
  const confirmRemove = () => fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

  it('names what the removal costs when the class counts toward earnings', () => {
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={45} />);
    openConfirm();
    expect(
      screen.getByText(
        'Remove this class? €45.00 will come off your reported earnings. This cannot be undone.',
      ),
    ).toBeInTheDocument();
  });

  it('claims no cost when the class is outside the reporting window', () => {
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);
    openConfirm();
    expect(
      screen.getByText('Remove this class? This cannot be undone.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reported earnings/)).not.toBeInTheDocument();
  });

  it('sends the removal and leaves for the schedule on success', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);

    openConfirm();
    confirmRemove();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/studio-classes/sc-1');
    expect(init.method).toBe('DELETE');
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });

  it('shows the server message when the removal is refused, and stays put', async () => {
    const assign = stubLocation();
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { message: 'This class has not started yet and comes from a recurring template, so removing it would only create it again. Cancel it instead.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);

    openConfirm();
    confirmRemove();

    expect(await screen.findByText(/Cancel it instead\./)).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);

    openConfirm();
    confirmRemove();

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
  });
});
