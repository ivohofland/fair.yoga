import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DonationsReceivedCard } from './donations-received-card';
import { routerRefresh } from '../../../tests/setup/components';

describe('DonationsReceivedCard (#912)', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const props = { classId: 'c-1', vatPercent: 0, currency: 'EUR' } as const;

  it('(#912) says not recorded yet, and offers Record', () => {
    render(<DonationsReceivedCard {...props} donationTotal={null} />);
    screen.getByText('Donations received');
    screen.getByText('Not recorded yet');
    screen.getByRole('button', { name: 'Record' });
  });

  it('(#912) shows the figure and the VAT it contains', () => {
    render(<DonationsReceivedCard {...props} vatPercent={21} donationTotal={84.5} />);
    screen.getByText('€84.50');
    screen.getByText('incl. €14.67 VAT');
    screen.getByRole('button', { name: 'Edit' });
    screen.getByRole('button', { name: 'Clear' });
  });

  it('(#912) shows no VAT line at 0%', () => {
    render(<DonationsReceivedCard {...props} donationTotal={84.5} />);
    expect(screen.queryByText(/VAT/)).not.toBeInTheDocument();
  });

  it('(#912) Save PUTs the amount and refreshes', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationsReceivedCard {...props} donationTotal={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '84.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/classes/c-1/donation-total',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ amount: 84.5 }) }),
    );
  });

  it('(#912) Save stays disabled until the teacher has typed, so an untouched Record stores nothing', () => {
    render(<DonationsReceivedCard {...props} donationTotal={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('(#912) typing 0 explicitly records 0', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationsReceivedCard {...props} donationTotal={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '5' } });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/classes/c-1/donation-total',
        expect.objectContaining({ body: JSON.stringify({ amount: 0 }) }),
      ),
    );
  });

  it('(#912) Edit on a recorded total can save without typing', () => {
    render(<DonationsReceivedCard {...props} donationTotal={84.5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
  });

  it('(#912) Clear PUTs null', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationsReceivedCard {...props} donationTotal={84.5} />);

    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/classes/c-1/donation-total',
        expect.objectContaining({ method: 'PUT', body: JSON.stringify({ amount: null }) }),
      ),
    );
  });

  it('(#912) shows the server message when the save is refused', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'CLASS_CANCELLED', message: 'This class has been cancelled.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DonationsReceivedCard {...props} donationTotal={null} />);

    fireEvent.click(screen.getByRole('button', { name: 'Record' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('This class has been cancelled.');
  });
});
