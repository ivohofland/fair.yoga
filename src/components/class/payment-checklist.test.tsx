import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentChecklist, type PaymentItem } from './payment-checklist';

/**
 * #58 review. The row's status used to read
 * `paymentState[item.paymentId] ?? 'pending'`, fabricating a status while the
 * item's own — the server's, right there in the props — was discarded.
 * `outstanding-payment-row.tsx:55` had it right with `?? status`; these two
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

  it("renders a row that appeared after mount with its own status, not a fabricated 'pending'", () => {
    const { rerender } = render(<PaymentChecklist items={[seeded]} />);
    rerender(<PaymentChecklist items={[seeded, appeared]} />);

    expect(screen.getByText('! Overdue')).toBeInTheDocument();
    expect(screen.queryByText('○ Unpaid')).not.toBeInTheDocument();
    // The seeded row is untouched — the state that exists still wins.
    expect(screen.getByText('✓ Paid')).toBeInTheDocument();
  });
});
