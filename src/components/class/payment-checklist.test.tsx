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
  };

  const appeared: PaymentItem = {
    paymentId: 'pay-2',
    studentId: 'stu-2',
    studentName: 'Bo Jansen',
    amount: 18,
    status: 'overdue',
    reminderSentAt: null,
  };

  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders a row that appeared after mount with its own status, not a fabricated 'pending'", () => {
    const { rerender } = render(<PaymentChecklist items={[seeded]} />);
    rerender(<PaymentChecklist items={[seeded, appeared]} />);

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
    };
    render(<PaymentChecklist items={[pendingItem]} />);

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
    };
    const paidItem: PaymentItem = {
      paymentId: 'pay-paid',
      studentId: 'stu-4',
      studentName: 'Dirk Bakker',
      amount: 18,
      status: 'paid',
      reminderSentAt: null,
    };
    render(<PaymentChecklist items={[pendingItem, paidItem]} />);

    const markPaid = screen.getAllByRole('button', { name: /^Mark paid/ });
    expect(markPaid).toHaveLength(1);
    markPaid.forEach((button) => expect(button).toHaveTextContent('Mark paid'));

    const reminder = screen.getAllByRole('button', { name: /^Send reminder/ });
    expect(reminder).toHaveLength(1);
    reminder.forEach((button) => expect(button).toHaveTextContent('Send reminder'));

    const paidButton = screen.getByRole('button', { name: /payment is paid/ });
    expect(paidButton).toHaveTextContent('Paid');
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
    };
    render(<PaymentChecklist items={[pendingItem]} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mark paid — Clara Meijer' }));

    const undoButton = await screen.findByRole('button', {
      name: 'Undo marking Clara Meijer as paid',
    });
    expect(undoButton).toBeInTheDocument();
    expect(undoButton).toHaveTextContent('Undo');
  });
});
