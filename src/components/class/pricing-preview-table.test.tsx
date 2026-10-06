import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { PricingPreviewTable } from './pricing-preview-table';

describe('PricingPreviewTable', () => {
  it('renders every amount in the given currency', () => {
    const { container } = render(
      <PricingPreviewTable
        currency="CHF"
        roomCost={40}
        minRate={10}
        targetRate={30}
        minStudents={4}
        maxStudents={10}
      />,
    );
    expect(container.textContent).toContain('CHF ');
    expect(container.textContent).not.toContain('€');
  });
});
