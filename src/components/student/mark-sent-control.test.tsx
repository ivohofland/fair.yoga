import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MarkSentControl } from './mark-sent-control';
import { routerRefresh } from '../../../tests/setup/components';

function reply(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, url: '/api/payments/pay-1/sent', json: async () => body };
}

describe('MarkSentControl', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('offers "I\'ve sent it" when unclaimed, and POSTs then refreshes', async () => {
    fetchMock.mockResolvedValue(reply(200, { data: {}, outcome: 'done' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MarkSentControl paymentId="pay-1" claimedLine={null} />);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: "I've sent it" }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/payments/pay-1/sent', { method: 'POST' });
  });

  it('shows the claim line and Undo when claimed, and DELETEs then refreshes', async () => {
    fetchMock.mockResolvedValue(reply(200, { data: {}, outcome: 'done' }));
    vi.stubGlobal('fetch', fetchMock);
    render(<MarkSentControl paymentId="pay-1" claimedLine="You marked this as sent on 17 Oct." />);
    expect(screen.getByText(/You marked this as sent on 17 Oct\./)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: "I've sent it" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/payments/pay-1/sent', { method: 'DELETE' });
  });

  it('announces a mark and moves focus to Undo once the claim arrives', async () => {
    fetchMock.mockResolvedValue(reply(200, { data: {}, outcome: 'done' }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<MarkSentControl paymentId="pay-1" claimedLine={null} />);

    fireEvent.click(screen.getByRole('button', { name: "I've sent it" }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('Marked as sent.');
    rerender(<MarkSentControl paymentId="pay-1" claimedLine="You marked this as sent on 17 Oct." />);
    expect(screen.getByRole('button', { name: 'Undo' })).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Marked as sent.');
  });

  it('announces an Undo and moves focus to "I\'ve sent it" once the claim is gone', async () => {
    fetchMock.mockResolvedValue(reply(200, { data: {}, outcome: 'done' }));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(
      <MarkSentControl paymentId="pay-1" claimedLine="You marked this as sent on 17 Oct." />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('Marked as not sent.');
    rerender(<MarkSentControl paymentId="pay-1" claimedLine={null} />);
    expect(screen.getByRole('button', { name: "I've sent it" })).toHaveFocus();
  });

  it('shows a refusal\'s message in a status region and still refreshes', async () => {
    fetchMock.mockResolvedValue(
      reply(409, { error: { code: 'PAYMENT_ALREADY_PAID', message: 'Your teacher already marked this paid.' } }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<MarkSentControl paymentId="pay-1" claimedLine={null} />);

    fireEvent.click(screen.getByRole('button', { name: "I've sent it" }));

    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
    expect(screen.getByRole('status')).toHaveTextContent('Your teacher already marked this paid.');
  });

  it('says so on a network failure, without refreshing', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(<MarkSentControl paymentId="pay-1" claimedLine={null} />);

    fireEvent.click(screen.getByRole('button', { name: "I've sent it" }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Network error. Try again.'));
    expect(routerRefresh).not.toHaveBeenCalled();
  });
});
