import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SendReminderButton } from './send-reminder-button';

/**
 * What the button reports upward is its whole contract: `onSent` with the
 * stamp the server returns, or `onError` with something the teacher can act
 * on. A retry inside the server's cooldown answers 200 `unchanged` with the
 * stamp that suppressed it, and must read as sent.
 */
describe('SendReminderButton', () => {
  const fetchMock = vi.fn();
  const onSent = vi.fn();
  const onError = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    onSent.mockReset();
    onError.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function renderButton(): HTMLElement {
    render(
      <SendReminderButton
        paymentId="pay-1"
        studentName="Ana de Vries"
        context={null}
        onSent={onSent}
        onError={onError}
      />,
    );
    return screen.getByRole('button', { name: 'Send reminder to Ana de Vries' });
  }

  /** Every message `onError` received other than the '' that clears it. */
  function reportedErrors(): unknown[] {
    return onError.mock.calls.map(([message]) => message).filter((message) => message !== '');
  }

  it('POSTs to the remind endpoint and reports the stamp it returns', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { reminderSentAt: '2026-09-17T10:00:00.000Z' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.click(renderButton());

    await waitFor(() => expect(onSent).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/payments/pay-1/remind', { method: 'POST' });
    expect(onSent).toHaveBeenCalledWith(new Date('2026-09-17T10:00:00.000Z'));
    expect(reportedErrors()).toEqual([]);
  });

  it('reports an unchanged answer as sent, with the stamp that suppressed it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: { reminderSentAt: '2026-09-17T09:59:00.000Z' },
        outcome: 'unchanged',
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const button = renderButton();
    fireEvent.click(button);

    await waitFor(() => expect(onSent).toHaveBeenCalledWith(new Date('2026-09-17T09:59:00.000Z')));
    expect(reportedErrors()).toEqual([]);
    await waitFor(() => expect(button).toBeEnabled());
  });

  it('reports a refusal through onError and nothing through onSent', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: {
          message: 'This payment is already settled, so no reminder is needed.',
          code: 'PAYMENT_SETTLED',
        },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const button = renderButton();
    fireEvent.click(button);

    await waitFor(() =>
      expect(onError).toHaveBeenLastCalledWith(
        'This payment is already settled, so no reminder is needed.',
      ),
    );
    expect(onSent).not.toHaveBeenCalled();
    await waitFor(() => expect(button).toBeEnabled());
  });

  /**
   * A 200 without a readable stamp is sent-but-unconfirmed, and the teacher is
   * told to reload rather than to send again. This is why every 200 from the
   * endpoint, the unchanged one included, carries the stamp.
   */
  it('asks for a reload when a 200 carries no stamp', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.click(renderButton());

    await waitFor(() =>
      expect(onError).toHaveBeenLastCalledWith(
        'Reminder sent — reload to confirm before sending again.',
      ),
    );
    expect(onSent).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[send-reminder] sent, but the response was unreadable',
      expect.objectContaining({ paymentId: 'pay-1' }),
    );
  });

  it('reports a network failure as one', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetchMock);

    fireEvent.click(renderButton());

    await waitFor(() => expect(onError).toHaveBeenLastCalledWith('Network error. Try again.'));
    expect(onSent).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      '[send-reminder] request failed',
      expect.objectContaining({ paymentId: 'pay-1' }),
    );
  });
});
