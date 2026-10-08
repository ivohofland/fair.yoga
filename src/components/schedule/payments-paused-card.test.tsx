import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentsPausedCard } from './payments-paused-card';

describe('PaymentsPausedCard', () => {
  it('says payments are paused and links to the resume screen', () => {
    render(<PaymentsPausedCard />);

    expect(screen.getByRole('heading', { name: 'Payments are paused' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Check and resume' })).toHaveAttribute('href', '/settings/resume-payments');
  });
});
