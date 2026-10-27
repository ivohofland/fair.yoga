import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PriceRange, PersonalPriceRange, ClassPriceLine } from './price-range';

describe('PriceRange', () => {
  it('renders the anonymous range in the class currency', () => {
    const { container } = render(<PriceRange estimates={[10, 11, 12, 13, 14]} currency="CHF" />);
    expect(container.textContent).toContain('CHF 10.00 – CHF 14.00');
    expect(container.textContent).not.toContain('€');
  });

  it('renders the personal range in the class currency', () => {
    const { container } = render(<PersonalPriceRange spread={{ low: 9, high: 15 }} currency="GBP" />);
    expect(container.textContent).toContain('£9.00 – £15.00');
  });

  it('says when a donation class asks for a gift, and suggests no amount (#912)', () => {
    const { container } = render(<ClassPriceLine line={{ kind: 'donation' }} currency="EUR" />);
    expect(container.textContent).toBe('By donation · give what you like after class');
  });
});
