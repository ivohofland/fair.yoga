import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaymentChecklist, type PaymentItem } from './payment-checklist';

/**
 * #58 review. The row's status used to read
 * `paymentState[item.paymentId] ?? 'pending'`, fabricating a status while the
 * item's own — the server's, right there in the props — was discarded.
 * `outstanding-payment-row.tsx`'s `?? status` fallback had it right; these two
 * surfaces now match it.
 *
 * The fallback is not decorative and not unreachable, which is the whole point
 * of this test. `usePaymentActions` seeds its state from `items` through
 * `useState`, which ignores every later argument, and this component's parent
 * is a server component: a `router.refresh()` re-renders it with new props
 * *without remounting* (the mechanism `outstanding-payment-row.tsx` documents
 * for its reminded caption). So a payment that appears after mount — a walk-in
 * charged post-class, a class completed in another tab — has no entry in
 * `paymentState`, and it is exactly that row the old fallback mislabelled:
 * an overdue payment rendered as the calm "○ Unpaid", with the reminder button
 * shown for a debt whose real state the teacher could not see.
 */
describe('PaymentChecklist', () => {
  const seeded: PaymentItem = {
    paymentId: 'pay-1',
    studentId: 'stu-1',
    studentName: 'Ana de Vries',
    amount: 18,
    status: 'paid',
    reminderSentAt: null,
    studentReportedOn: null,
    processorAttempts: [],
  };

  const appeared: PaymentItem = {
    paymentId: 'pay-2',
    studentId: 'stu-2',
    studentName: 'Bo Jansen',
    amount: 18,
    status: 'overdue',
    reminderSentAt: null,
    studentReportedOn: null,
    processorAttempts: [],
  };

  const fetchMock = vi.fn();

  /** Fills in the fields these tests don't care about (`studentId`, `reminderSentAt`, `studentReportedOn`). */
  function renderChecklist(
    items: Array<Pick<PaymentItem, 'paymentId' | 'studentName' | 'status' | 'amount'> & Partial<PaymentItem>>,
  ) {
    render(
      <PaymentChecklist currency="EUR"
        items={items.map((item, i) => ({
          studentId: `stu-${i}`,
          reminderSentAt: null,
          studentReportedOn: null,
    processorAttempts: [],
          ...item,
        }))}
      />,
    );
  }

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a row that appeared after mount with its own status, not a fabricated 'pending'", () => {
    const { rerender } = render(<PaymentChecklist currency="EUR" items={[seeded]} />);
    rerender(<PaymentChecklist currency="EUR" items={[seeded, appeared]} />);

    expect(screen.getByText('! Overdue')).toBeInTheDocument();
    expect(screen.queryByText('○ Unpaid')).not.toBeInTheDocument();
    // The seeded row is untouched — the state that exists still wins.
    expect(screen.getByText('✓ Paid')).toBeInTheDocument();
  });

  /**
   * #129. WCAG 2.5.3 (Label in Name) requires the accessible name to contain
   * the visible text contiguously and in order. The visible text is "Mark paid",
   * so leading with it ensures speech-input activation works.
   */
  it('gives the mark-paid button the conforming accessible name', () => {
    const pendingItem: PaymentItem = {
      paymentId: 'pay-pending',
      studentId: 'stu-3',
      studentName: 'Clara Meijer',
      amount: 18,
      status: 'pending',
      reminderSentAt: null,
      studentReportedOn: null,
    processorAttempts: [],
    };
    render(<PaymentChecklist currency="EUR" items={[pendingItem]} />);

    expect(
      screen.getByRole('button', { name: 'Mark paid — Clara Meijer' }),
    ).toBeInTheDocument();
  });

  /**
   * Asserts the WCAG 2.5.3 containment relation directly so that changing the
   * visible button copy without updating the accessible name fails CI.
   */
  it('keeps each button visible text inside its accessible name', () => {
    const pendingItem: PaymentItem = {
      paymentId: 'pay-pending',
      studentId: 'stu-3',
      studentName: 'Clara Meijer',
      amount: 18,
      status: 'pending',
      reminderSentAt: null,
      studentReportedOn: null,
    processorAttempts: [],
    };
    const paidItem: PaymentItem = {
      paymentId: 'pay-paid',
      studentId: 'stu-4',
      studentName: 'Dirk Bakker',
      amount: 18,
      status: 'paid',
      reminderSentAt: null,
      studentReportedOn: null,
    processorAttempts: [],
    };
    render(<PaymentChecklist currency="EUR" items={[pendingItem, paidItem]} />);

    const markPaid = screen.getAllByRole('button', { name: /^Mark paid/ });
    expect(markPaid).toHaveLength(1);
    markPaid.forEach((button) => expect(button).toHaveTextContent('Mark paid'));

    const reminder = screen.getAllByRole('button', { name: /^Send reminder/ });
    expect(reminder).toHaveLength(1);
    reminder.forEach((button) => expect(button).toHaveTextContent('Send reminder'));

    // The paid row renders no mark-paid control at all — its state is
    // already the "✓ Paid" text next to the euro amount.
    expect(screen.queryByRole('button', { name: /payment is paid/ })).not.toBeInTheDocument();
  });

  it('gives the undo button a conforming accessible name and visible text', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    const pendingItem: PaymentItem = {
      paymentId: 'pay-pending',
      studentId: 'stu-3',
      studentName: 'Clara Meijer',
      amount: 18,
      status: 'pending',
      reminderSentAt: null,
      studentReportedOn: null,
    processorAttempts: [],
    };
    render(<PaymentChecklist currency="EUR" items={[pendingItem]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mark paid — Clara Meijer' }));

    const undoButton = await screen.findByRole('button', {
      name: 'Undo marking Clara Meijer as paid',
    });
    expect(undoButton).toBeInTheDocument();
    expect(undoButton).toHaveTextContent('Undo');
  });

  it('offers no mark-paid control on a not-charged payment', () => {
    renderChecklist([{ paymentId: 'p1', studentName: 'Anna Smith', status: 'not_charged', amount: 12 }]);
    expect(screen.queryByRole('button', { name: /Mark paid/i })).not.toBeInTheDocument();
    expect(screen.getByText('⊘ Not charged')).toBeInTheDocument();
  });

  it('colors the amount brown only when still owed', () => {
    renderChecklist([
      { paymentId: 'p1', studentName: 'Anna Smith', status: 'not_charged', amount: 12 },
      { paymentId: 'p2', studentName: 'Bo Jansen', status: 'pending', amount: 15 },
      { paymentId: 'p3', studentName: 'Clara Meijer', status: 'paid', amount: 18 },
    ]);
    expect(screen.getByText('€12.00')).not.toHaveClass('text-brown');
    expect(screen.getByText('€15.00')).toHaveClass('text-brown');
    expect(screen.getByText('€18.00')).not.toHaveClass('text-brown');
  });

  it('shows the amounts in the class currency', () => {
    const { container } = render(
      <PaymentChecklist
       
        currency="GBP"
        items={[
          { paymentId: 'p1', studentId: 'stu-1', studentName: 'Anna Smith', status: 'pending', amount: 15, reminderSentAt: null, studentReportedOn: null, processorAttempts: [] },
          { paymentId: 'p2', studentId: 'stu-2', studentName: 'Bo Jansen', status: 'paid', amount: 18, reminderSentAt: null, studentReportedOn: null, processorAttempts: [] },
        ]}
      />,
    );
    expect(screen.getByText('£15.00')).toBeInTheDocument();
    expect(screen.getByText('£18.00')).toBeInTheDocument();
    expect(container.textContent).not.toContain('€');
  });

  describe('a payment the student says they sent (#898)', () => {
    const reportedOn = new Date('2026-10-12T00:00:00.000Z');

    it('shows the claim in place of the status label', () => {
      renderChecklist([
        { paymentId: 'p1', studentName: 'Anna Smith', status: 'overdue', amount: 15, studentReportedOn: reportedOn },
      ]);
      expect(screen.getByText('! Says paid · 12 Oct')).toBeInTheDocument();
      expect(screen.queryByText('! Overdue')).toBeNull();
    });

    it('offers Not received before Send reminder, and keeps Mark paid', () => {
      renderChecklist([
        { paymentId: 'p1', studentName: 'Anna Smith', status: 'pending', amount: 15, studentReportedOn: reportedOn },
      ]);
      const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
      expect(names).toEqual(['Not received — Anna Smith', 'Send reminder to Anna Smith', 'Mark paid — Anna Smith']);
      expect(screen.getByRole('button', { name: /^Not received/ })).toHaveTextContent('Not received');
    });

    it('offers no Not received on a row without a claim', () => {
      renderChecklist([{ paymentId: 'p1', studentName: 'Anna Smith', status: 'pending', amount: 15 }]);
      expect(screen.queryByRole('button', { name: /^Not received/ })).toBeNull();
      expect(screen.getByText('○ Unpaid')).toBeInTheDocument();
    });

    it('returns the row to its status label on Not received', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: {} }) });
      vi.stubGlobal('fetch', fetchMock);
      renderChecklist([
        { paymentId: 'p1', studentName: 'Anna Smith', status: 'pending', amount: 15, studentReportedOn: reportedOn },
      ]);

      fireEvent.click(screen.getByRole('button', { name: /^Not received/ }));

      expect(await screen.findByText('○ Unpaid')).toBeInTheDocument();
      expect(screen.queryByText(/Says paid/)).toBeNull();
      expect(fetchMock).toHaveBeenCalledWith('/api/payments/p1/not-received', { method: 'POST' });
    });

    it('shows the reminder stamp Not received made', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: { reminderSentAt: new Date().toISOString() } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      renderChecklist([
        { paymentId: 'p1', studentName: 'Anna Smith', status: 'pending', amount: 15, studentReportedOn: reportedOn },
      ]);

      fireEvent.click(screen.getByRole('button', { name: /^Not received/ }));

      expect(await screen.findByText('Reminded just now')).toBeInTheDocument();
    });

    it('shows a refused Not received in the shared alert', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: { message: 'Payments are paused.', code: 'PAYMENTS_PAUSED' } }),
      });
      vi.stubGlobal('fetch', fetchMock);
      renderChecklist([
        { paymentId: 'p1', studentName: 'Anna Smith', status: 'pending', amount: 15, studentReportedOn: reportedOn },
      ]);

      fireEvent.click(screen.getByRole('button', { name: /^Not received/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Payments are paused.');
      expect(screen.getByText('Says paid · 12 Oct')).toBeInTheDocument();
    });
  });

  describe('a payment Mollie settled (Decision 17)', () => {
    const settling = {
      id: 'att-1', method: 'ideal', status: 'paid' as const, settledPayment: true, chargedBackAt: null, amount: 12, currency: 'EUR' as const, refunds: [],
    };

    it('offers Refund on the paid row', () => {
      renderChecklist([{ paymentId: 'pay-1', studentName: 'Ana', status: 'paid', amount: 12, processorAttempts: [settling] }]);
      expect(screen.getByRole('button', { name: /^Refund iDEAL €12\.00 — Ana/ })).toBeInTheDocument();
    });

    it('offers no Refund once the student’s bank took it back', () => {
      renderChecklist([
        { paymentId: 'pay-1', studentName: 'Ana', status: 'paid', amount: 12, processorAttempts: [{ ...settling, settledPayment: false, chargedBackAt: new Date() }] },
      ]);
      expect(screen.queryByRole('button', { name: /^Refund/ })).not.toBeInTheDocument();
    });
  });
});
