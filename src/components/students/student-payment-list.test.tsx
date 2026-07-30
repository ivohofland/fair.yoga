import type { ComponentProps } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StudentPaymentList } from './student-payment-list';

/**
 * #58 review. The same one-line fix as `payment-checklist.test.tsx`, on the
 * other surface that had it wrong: `paymentState[item.paymentId] ?? 'pending'`
 * became `?? item.status`. Kept as its own test rather than trusted to the
 * sibling's, because the mutation is per-file — reverting either line alone
 * leaves the other's test green.
 *
 * Reachable for the same reason: `usePaymentActions` seeds from `items` via
 * `useState` and ignores later arguments, while a `router.refresh()` on the
 * student page re-renders this component with new props without remounting.
 * A payment added after mount then has no entry in `paymentState`.
 *
 * `StudentPaymentItem` is not exported, so the fixture is typed as the prop
 * element — no assertion, and a shape change breaks this file.
 */
type StudentPaymentItem = ComponentProps<typeof StudentPaymentList>['items'][number];

describe('StudentPaymentList', () => {
  const seeded: StudentPaymentItem = {
    paymentId: 'pay-1',
    classType: 'Vinyasa',
    classDate: '12 Jun 2026',
    amount: 18,
    status: 'paid',
  };

  const appeared: StudentPaymentItem = {
    paymentId: 'pay-2',
    classType: 'Yin',
    classDate: '19 Jun 2026',
    amount: 18,
    status: 'overdue',
  };

  it("renders a row that appeared after mount with its own status, not a fabricated 'pending'", () => {
    const { rerender } = render(<StudentPaymentList items={[seeded]} />);
    rerender(<StudentPaymentList items={[seeded, appeared]} />);

    expect(screen.getByText(/! Overdue/)).toBeInTheDocument();
    expect(screen.queryByText(/○ Unpaid/)).not.toBeInTheDocument();
    expect(screen.getByText(/✓ Paid/)).toBeInTheDocument();
  });
});
