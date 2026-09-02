import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NotChargedPaymentRow } from './not-charged-payment-row';

/**
 * Mirrors `received-payment-row.test.tsx`'s fixture shape — same prop names,
 * same kind of dates — since the two rows take an identical shape and read
 * side by side.
 */
describe('NotChargedPaymentRow', () => {
  const baseProps = {
    paymentId: 'pay-1',
    studentName: 'Anna Smith',
    classType: 'Vinyasa',
    classDate: new Date('2026-09-02T00:00:00Z'),
    startTime: new Date('1970-01-01T18:00:00Z'),
    notChargedAt: new Date('2026-09-02T12:00:00Z'),
    timeZone: 'Europe/Amsterdam',
    amount: 15,
  };

  it('shows the state, the amount and the reversal', () => {
    render(<NotChargedPaymentRow {...baseProps} />);

    expect(screen.getByText('⊘ Not charged')).toBeInTheDocument();
    expect(screen.getByText('€15.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Mark unpaid — Anna Smith/ })).toBeInTheDocument();
  });

  it('renders the not-charged date in the teacher day, not UTC', () => {
    // 02:00 UTC on the 3rd is still the 2nd in Los Angeles. Without
    // startOfLocalDay this renders "3 Sep" — the #140 bug, in a new component.
    render(
      <NotChargedPaymentRow
        {...baseProps}
        notChargedAt={new Date('2026-09-03T02:00:00Z')}
        timeZone="America/Los_Angeles"
      />,
    );

    expect(screen.getByText(/2 Sep/)).toBeInTheDocument();
  });

  it('shows no date when the payment has none', () => {
    render(<NotChargedPaymentRow {...baseProps} notChargedAt={null} />);

    expect(screen.getByText('Vinyasa · 2 Sep · 18:00')).toBeInTheDocument();
  });
});
