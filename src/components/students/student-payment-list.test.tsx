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

function renderList(items: StudentPaymentItem[]) {
  render(<StudentPaymentList items={items} />);
}

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

  it('offers no mark-paid control on a not-charged payment', () => {
    renderList([{ paymentId: 'p1', classType: 'Vinyasa', classDate: 'Tue 2 Sep', status: 'not_charged', amount: 12 }]);
    expect(screen.queryByRole('button', { name: /Mark paid/i })).not.toBeInTheDocument();
  });

  it('colors the amount brown only when still owed', () => {
    renderList([
      { paymentId: 'p1', classType: 'Vinyasa', classDate: 'Tue 2 Sep', status: 'not_charged', amount: 12 },
      { paymentId: 'p2', classType: 'Yin', classDate: 'Thu 4 Sep', status: 'pending', amount: 15 },
      { paymentId: 'p3', classType: 'Hatha', classDate: 'Fri 5 Sep', status: 'paid', amount: 18 },
    ]);
    expect(screen.getByText('€12.00')).not.toHaveClass('text-brown');
    expect(screen.getByText('€15.00')).toHaveClass('text-brown');
    expect(screen.getByText('€18.00')).not.toHaveClass('text-brown');
  });

  it('gives each mark-paid button a distinct accessible name', () => {
    renderList([
      { paymentId: 'p1', classType: 'Vinyasa', classDate: 'Tue 2 Sep', status: 'pending', amount: 12 },
      { paymentId: 'p2', classType: 'Yin', classDate: 'Thu 4 Sep', status: 'pending', amount: 10 },
    ]);
    expect(screen.getByRole('button', { name: 'Mark paid — Vinyasa, Tue 2 Sep' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark paid — Yin, Thu 4 Sep' })).toBeInTheDocument();
  });
});
