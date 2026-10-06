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

function row(label: string): [string | null, string | null] {
  const cells = Array.from(screen.getByText(label).parentElement?.children ?? []);
  return [cells[1]?.textContent ?? null, cells[2]?.textContent ?? null];
}

describe('PricingPreviewResult', () => {
  it('labels each tier with its number and name', () => {
    render(<PricingPreviewResult {...EXAMPLE} studentCount={8} distribution={[1, 2, 3, 2, 0]} />);

    expect(row('1 · Getting by')).toEqual(['1', '€7.22']);
    expect(row('2 · Managing')).toEqual(['2', '€8.89']);
    expect(row('3 · Comfortable')).toEqual(['3', '€11.11']);
    expect(row('4 · Doing well')).toEqual(['2', '€13.33']);
    expect(row('5 · Plenty to share')).toEqual(['0', '€15.00']);
    expect(screen.getByText('€65.00')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(screen.getByText('Highest pays 1.8× the lowest')).toBeTruthy();
  });

  it('renders the caller’s control above the tier rows', () => {
    render(
      <PricingPreviewResult
        {...EXAMPLE}
        studentCount={8}
        distribution={[1, 2, 3, 2, 0]}
        distributionControl={<button type="button">Mix control</button>}
      />,
    );
    const control = screen.getByRole('button', { name: 'Mix control' });
    const firstRow = screen.getByText('1 · Getting by');
    expect(control.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
