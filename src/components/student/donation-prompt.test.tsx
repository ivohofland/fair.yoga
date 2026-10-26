import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DonationPrompt } from './donation-prompt';
import { routerRefresh } from '../../../tests/setup/components';

const props = { registrationId: 'r1', classId: 'c1', classType: 'Vinyasa', date: '2026-06-01T00:00:00.000Z' };

describe('DonationPrompt', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('(#912) links to the give page and names no amount', () => {
    const { container } = render(<DonationPrompt {...props} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/bookings/c1/give');
    expect(container.textContent).not.toMatch(/€|\d+[.,]\d{2}/);
  });

  it('(#912) Hide POSTs the hide route, then refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationPrompt {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/registrations/r1/donation-prompt/hide', { method: 'POST' });
  });

  it('(#912) a refused Hide shows the server message and logs the status', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'DONATION_NOT_INVITED', message: 'Not invited to give.' } }), { status: 409 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationPrompt {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Not invited to give.');
    expect(error).toHaveBeenCalledWith(
      '[donation-prompt] request failed',
      expect.objectContaining({ registrationId: 'r1', status: 409 }),
    );
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('(#912) a rejected request shows the alert and logs it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationPrompt {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Could not hide this. Try again.');
    expect(error).toHaveBeenCalledWith('[donation-prompt] request failed', expect.objectContaining({ registrationId: 'r1' }));
  });
});
