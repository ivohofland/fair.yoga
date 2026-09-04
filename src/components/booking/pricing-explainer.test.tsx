import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PricingExplainer, PRICING_EXPLANATION } from './pricing-explainer';

describe('PricingExplainer', () => {
  it('renders the canonical pricing explanation copy', () => {
    render(<PricingExplainer />);

    expect(screen.getByText(PRICING_EXPLANATION)).toBeInTheDocument();
    expect(
      screen.getByText(/Prices are income-based: everyone in the room pays what fits their situation/i),
    ).toBeInTheDocument();
  });

  it('renders inside a teal-tint rounded-card container', () => {
    const { container } = render(<PricingExplainer className="custom-class" />);
    const card = container.firstChild as HTMLElement;

    expect(card).toHaveClass('bg-teal-tint');
    expect(card).toHaveClass('rounded-card');
    expect(card).toHaveClass('p-5');
    expect(card).toHaveClass('custom-class');
  });

  it('carries no stray whitespace in its class list when className is omitted', () => {
    const { container } = render(<PricingExplainer />);
    const card = container.firstChild as HTMLElement;

    expect(card).toHaveAttribute('class', 'bg-teal-tint rounded-card p-5');
  });
});
