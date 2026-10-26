import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DonationSummary } from './donation-summary';

describe('DonationSummary', () => {
  it('names the room cost as the break-even for a class in a room (#912)', () => {
    render(<DonationSummary format="in_person" roomCost={30} vatPercent={21} currency="EUR" />);
    expect(screen.getByText('By donation')).toBeInTheDocument();
    expect(
      screen.getByText('Room cost €30.00: your break-even is €36.30 in donations, VAT included.'),
    ).toBeInTheDocument();
  });

  it('shows no room cost or break-even line for an online class (#912)', () => {
    const { container } = render(<DonationSummary format="online" roomCost={0} vatPercent={21} currency="EUR" />);
    expect(screen.getByText('By donation')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Room cost|break-even/);
  });
});
