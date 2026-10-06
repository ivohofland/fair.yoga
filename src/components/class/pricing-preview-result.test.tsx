import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PricingPreviewResult } from './pricing-preview-result';

const EXAMPLE = {
  currency: 'EUR',
  roomCost: 20,
  minRate: 40,
  targetRate: 90,
  minStudents: 4,
  maxStudents: 12,
} as const;
const EIGHT = { 1: 1, 2: 2, 3: 3, 4: 2, 5: 0 };

function row(label: string): [string | null, string | null] {
  const cells = Array.from(screen.getByText(label).parentElement?.children ?? []);
  return [cells[1]?.textContent ?? null, cells[2]?.textContent ?? null];
}

describe('PricingPreviewResult', () => {
  it('labels each tier with its number and name', () => {
    render(<PricingPreviewResult {...EXAMPLE} distribution={EIGHT} />);

    expect(row('1 · Getting by')).toEqual(['1', '€7.22']);
    expect(row('2 · Managing')).toEqual(['2', '€8.89']);
    expect(row('3 · Comfortable')).toEqual(['3', '€11.11']);
    expect(row('4 · Doing well')).toEqual(['2', '€13.33']);
    expect(row('5 · Plenty to share')).toEqual(['0', '€15.00']);
    expect(screen.getByText('Highest pays 1.8× the lowest')).toBeTruthy();
  });

  it('pays the rate for the class the distribution describes', () => {
    render(<PricingPreviewResult {...EXAMPLE} distribution={EIGHT} />);

    // 8 students: 40 + 50 × (8 − 4) / (12 − 4)
    expect(screen.getByText('€65.00')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
  });

  it('dims only the tiers nobody is in', () => {
    render(<PricingPreviewResult {...EXAMPLE} distribution={EIGHT} />);

    expect(screen.getByText('5 · Plenty to share').parentElement?.className).toContain('opacity-40');
    expect(screen.getByText('4 · Doing well').parentElement?.className).not.toContain('opacity-40');
  });

  it('has no spread to show with a single occupied tier', () => {
    render(<PricingPreviewResult {...EXAMPLE} distribution={{ 1: 0, 2: 0, 3: 1, 4: 0, 5: 0 }} />);

    expect(screen.queryByText(/Highest pays/)).toBeNull();
  });

  it('renders the caller’s control above the tier rows', () => {
    render(
      <PricingPreviewResult
        {...EXAMPLE}
        distribution={EIGHT}
        distributionControl={<button type="button">Mix control</button>}
      />,
    );
    const control = screen.getByRole('button', { name: 'Mix control' });
    const firstRow = screen.getByText('1 · Getting by');
    expect(control.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
