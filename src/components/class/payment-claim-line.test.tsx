import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentClaimLine } from './payment-claim-line';

describe('PaymentClaimLine', () => {
  const reportedOn = new Date('2026-10-12T00:00:00Z');

  it('shows a pending claim in brown', () => {
    const { container } = render(<PaymentClaimLine overdue={false} reportedOn={reportedOn} />);
    const line = container.firstElementChild!;
    expect(line).toHaveClass('text-brown');
    expect(line).not.toHaveClass('text-danger');
    expect(screen.getByText('Says paid · 12 Oct')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Says paid on 12 October')).toHaveClass('sr-only');
  });

  it('marks an overdue claim in danger and says so in words, not colour alone', () => {
    const { container } = render(<PaymentClaimLine overdue reportedOn={reportedOn} />);
    expect(container.firstElementChild).toHaveClass('text-danger');
    expect(screen.getByText('! Says paid · 12 Oct')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Overdue, says paid on 12 October')).toHaveClass('sr-only');
  });

  // The suite runs west of UTC; a local read would render 30 Sep.
  it('reads the calendar day it is given', () => {
    render(<PaymentClaimLine overdue={false} reportedOn={new Date('2026-10-01T00:00:00Z')} />);
    expect(screen.getByText('Says paid · 1 Oct')).toBeInTheDocument();
  });
});
