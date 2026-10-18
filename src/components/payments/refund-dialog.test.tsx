import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RefundDialog } from './refund-dialog';

describe('RefundDialog', () => {
  const fetchMock = vi.fn();
  const onClose = vi.fn();
  const onRequested = vi.fn();

  const base = {
    paymentId: 'pay-1',
    attemptId: 'att-1',
    amount: 10,
    currency: 'EUR' as const,
    studentName: 'Ana D.',
    onClose,
    onRequested,
  };

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    onClose.mockReset();
    onRequested.mockReset();
    vi.unstubAllGlobals();
  });

  function answer(status: number, body: unknown) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  }

  function sentBody(): unknown {
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/payments/pay-1/refund');
    expect(init.method).toBe('POST');
    return JSON.parse(init.body as string);
  }

  it('offers the settling attempt’s two outcomes and states the amount and where it comes from', () => {
    render(<RefundDialog {...base} settles />);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('€10.00 goes back to Ana D. from your Mollie balance.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refund and waive' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refund and ask again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refund duplicate payment' })).not.toBeInTheDocument();
  });

  it.each([
    ['Refund and waive', 'waive'],
    ['Refund and ask again', 'ask_again'],
  ] as const)('%s posts the choice %s and reports the refund’s status', async (label, choice) => {
    answer(200, { data: { refundStatus: 'queued', outcomeApplied: false, payment: { id: 'pay-1' } } });
    render(<RefundDialog {...base} settles />);

    fireEvent.click(screen.getByRole('button', { name: label }));

    await waitFor(() => expect(onRequested).toHaveBeenCalledWith('queued'));
    expect(sentBody()).toEqual({ attemptId: 'att-1', choice });
  });

  it('offers a duplicate’s refund alone, and posts no choice', async () => {
    answer(200, { data: { refundStatus: 'refunded', outcomeApplied: false, payment: { id: 'pay-1' } } });
    render(<RefundDialog {...base} settles={false} />);

    expect(screen.queryByRole('button', { name: 'Refund and waive' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refund duplicate payment' }));

    await waitFor(() => expect(onRequested).toHaveBeenCalledWith('refunded'));
    expect(sentBody()).toEqual({ attemptId: 'att-1', choice: null });
  });

  it('shows a refusal’s message and stays open', async () => {
    answer(409, { error: { code: 'REFUND_REFUSED', message: 'Your Mollie balance is too low for this refund. Top it up in Mollie, then try again.' } });
    render(<RefundDialog {...base} settles />);

    fireEvent.click(screen.getByRole('button', { name: 'Refund and waive' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your Mollie balance is too low for this refund.');
    expect(onRequested).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Cancel and on Escape without posting', () => {
    render(<RefundDialog {...base} settles />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
