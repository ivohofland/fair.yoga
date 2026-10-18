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

  it('opens as a modal dialog, offers the two outcomes as a choice, and refunds only once one is chosen', () => {
    render(<RefundDialog {...base} settles />);

    const dialog = screen.getByRole('dialog');
    expect(dialog.tagName).toBe('DIALOG');
    expect(dialog).toHaveAttribute('open');
    expect(screen.getByText('€10.00 goes back to Ana D. from your Mollie balance.')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Refund and waive' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Refund and ask again' })).not.toBeChecked();
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Refund €10.00', 'Cancel']);
    expect(screen.getByRole('button', { name: 'Refund €10.00' })).toBeDisabled();
  });

  it.each([
    ['Refund and waive', 'waive'],
    ['Refund and ask again', 'ask_again'],
  ] as const)('%s posts the choice %s and reports the refund’s status', async (label, choice) => {
    answer(200, { data: { refundStatus: 'queued', outcomeApplied: false, payment: { id: 'pay-1' } } });
    render(<RefundDialog {...base} settles />);

    fireEvent.click(screen.getByRole('radio', { name: label }));
    fireEvent.click(screen.getByRole('button', { name: 'Refund €10.00' }));

    await waitFor(() => expect(onRequested).toHaveBeenCalledWith('queued'));
    expect(sentBody()).toEqual({ attemptId: 'att-1', choice });
  });

  it('locks the page’s scroll while open', () => {
    const { unmount } = render(<RefundDialog {...base} settles />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('');
  });

  it('reopens itself when the browser closes it while the refund is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<RefundDialog {...base} settles={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Refund duplicate payment' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());

    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    dialog.close();

    expect(dialog).toHaveAttribute('open');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('reports a close by the browser as a dismissal when nothing is in flight', () => {
    render(<RefundDialog {...base} settles />);
    (screen.getByRole('dialog') as HTMLDialogElement).close();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('cannot be dismissed while the refund is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<RefundDialog {...base} settles={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refund duplicate payment' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
    const dialog = screen.getByRole('dialog');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    fireEvent.click(dialog);
    expect(onClose).not.toHaveBeenCalled();
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

    fireEvent.click(screen.getByRole('radio', { name: 'Refund and waive' }));
    fireEvent.click(screen.getByRole('button', { name: 'Refund €10.00' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Your Mollie balance is too low for this refund.');
    expect(onRequested).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('closes on Cancel, on Escape and on the backdrop without posting', () => {
    render(<RefundDialog {...base} settles />);
    const dialog = screen.getByRole('dialog');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    fireEvent.click(dialog);

    expect(onClose).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
