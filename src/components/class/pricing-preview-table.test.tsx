import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PricingPreviewTable } from './pricing-preview-table';

const EXAMPLE = {
  currency: 'EUR',
  roomCost: 20,
  minRate: 40,
  targetRate: 90,
  minStudents: 4,
  maxStudents: 12,
} as const;

/** [count, price] of the tier row whose label is `label`. */
function row(label: string): [string | null, string | null] {
  const cells = Array.from(screen.getByText(label).parentElement?.children ?? []);
  return [cells[1]?.textContent ?? null, cells[2]?.textContent ?? null];
}

function setStudents(n: number): void {
  fireEvent.change(screen.getByRole('slider'), { target: { value: String(n) } });
}

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

  it('opens at the midpoint class size with the normal spread', () => {
    render(<PricingPreviewTable {...EXAMPLE} />);

    expect(screen.getByText('8 students')).toBeTruthy();
    expect(screen.getByText('€65.00')).toBeTruthy();
    expect(screen.getByText('€20.00')).toBeTruthy();
    expect(screen.getByText('€85.00')).toBeTruthy();
    expect(screen.getByText('50%')).toBeTruthy();
    expect(row('1 · Getting by')).toEqual(['1', '€7.22']);
    expect(row('2 · Managing')).toEqual(['2', '€8.89']);
    expect(row('3 · Comfortable')).toEqual(['3', '€11.11']);
    expect(row('4 · Doing well')).toEqual(['2', '€13.33']);
    expect(row('5 · Plenty to share')).toEqual(['0', '€15.00']);
    expect(screen.getByText('Highest pays 1.8× the lowest')).toBeTruthy();
  });

  it('reaches the target rate at a full class', () => {
    render(<PricingPreviewTable {...EXAMPLE} />);
    setStudents(12);

    expect(screen.getByText('12 students')).toBeTruthy();
    expect(screen.getByText('€90.00')).toBeTruthy();
    expect(screen.getByText('€110.00')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
    expect(row('1 · Getting by')).toEqual(['1', '€5.96']);
    expect(row('2 · Managing')).toEqual(['3', '€7.33']);
    expect(row('3 · Comfortable')).toEqual(['4', '€9.17']);
    expect(row('4 · Doing well')).toEqual(['3', '€11.00']);
    expect(row('5 · Plenty to share')).toEqual(['1', '€12.38']);
    expect(screen.getByText('Highest pays 2.1× the lowest')).toBeTruthy();
  });

  it('pays the minimum rate at the minimum class size', () => {
    render(<PricingPreviewTable {...EXAMPLE} />);
    setStudents(4);

    expect(screen.getByText('€40.00')).toBeTruthy();
    expect(screen.getByText('€60.00')).toBeTruthy();
    expect(screen.getByText('0%')).toBeTruthy();
    expect(row('1 · Getting by')).toEqual(['0', '€9.75']);
    expect(row('5 · Plenty to share')).toEqual(['0', '€20.25']);
    expect(screen.getByText('Highest pays 1.5× the lowest')).toBeTruthy();
  });

  it('shows full progress when the minimum and target rates are equal', () => {
    render(<PricingPreviewTable {...EXAMPLE} minRate={60} targetRate={60} />);

    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('keeps the class size when shuffling the mix', () => {
    render(<PricingPreviewTable {...EXAMPLE} />);
    fireEvent.click(screen.getByRole('button', { name: 'Shuffle mix' }));

    const counts = ['1 · Getting by', '2 · Managing', '3 · Comfortable', '4 · Doing well', '5 · Plenty to share'].map((l) => Number(row(l)[0]));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(8);
  });

  describe('with a fixed random source', () => {
    // Math.random() = 0.5 puts every draw at z ≈ −1.18, which rounds to tier 2.
    beforeEach(() => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('shuffles away from the normal spread, stays shuffled across a resize, and returns to normal', () => {
      render(<PricingPreviewTable {...EXAMPLE} />);

      fireEvent.click(screen.getByRole('button', { name: 'Shuffle mix' }));
      expect(row('2 · Managing')[0]).toBe('8');
      expect(row('3 · Comfortable')[0]).toBe('0');

      setStudents(12);
      expect(row('2 · Managing')[0]).toBe('12');

      fireEvent.click(screen.getByRole('button', { name: 'Normal spread' }));
      expect(row('2 · Managing')[0]).toBe('3');
      expect(row('3 · Comfortable')[0]).toBe('4');
    });
  });

  it('follows the form when its rates change', () => {
    const { rerender } = render(<PricingPreviewTable {...EXAMPLE} />);
    rerender(<PricingPreviewTable {...EXAMPLE} targetRate={130} />);

    // 8 students: 40 + 90 × (8 − 4) / (12 − 4)
    expect(screen.getByText('€85.00')).toBeTruthy();
    expect(screen.getByText('€105.00')).toBeTruthy();
  });

  it('treats a minimum below one as one, as while the field is being cleared', () => {
    render(<PricingPreviewTable {...EXAMPLE} minStudents={0} />);

    // range 1–12, opening at round(6.5) = 7: 40 + 50 × (7 − 1) / (12 − 1)
    expect(screen.getByText('7 students')).toBeTruthy();
    expect(screen.getByText('€67.27')).toBeTruthy();
    expect(screen.getByText('1 min')).toBeTruthy();
    expect(screen.getByText('12 max')).toBeTruthy();
  });
});
