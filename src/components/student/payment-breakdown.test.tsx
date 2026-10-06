import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { formatDayHeader } from '@/lib/format';
import { PaymentBreakdown } from './payment-breakdown';

const DATE = new Date('2026-06-01T00:00:00.000Z');
const LINES = { roomCents: 4000, teacherCents: 1625, totalCents: 5625, students: 9, shareCents: 750 };

/** The value rendered beside a label in the breakdown's description list. */
function valueFor(label: string): string | null {
  return screen.getByText(label, { selector: 'dt' }).nextElementSibling?.textContent ?? null;
}

describe('PaymentBreakdown', () => {
  it('renders each line beside its label', () => {
    render(<PaymentBreakdown currency="EUR" lines={LINES} classType="Vinyasa" date={DATE} />);
    expect(valueFor('Room')).toBe('€40.00');
    expect(valueFor('Teacher')).toBe('€16.25');
    expect(valueFor('Class total')).toBe('€56.25');
    expect(valueFor('Students')).toBe('9');
    expect(valueFor('Your share')).toBe('€7.50');
  });

  it('renders a negative teacher line with a minus sign before the euro sign', () => {
    render(<PaymentBreakdown currency="EUR" lines={{ ...LINES, teacherCents: -400 }} classType="Vinyasa" date={DATE} />);
    expect(valueFor('Teacher')).toBe('−€4.00');
  });

  it('pads single-digit cents', () => {
    render(<PaymentBreakdown currency="EUR" lines={{ ...LINES, shareCents: 5 }} classType="Vinyasa" date={DATE} />);
    expect(valueFor('Your share')).toBe('€0.05');
  });

  it('renders every line in the given currency', () => {
    render(<PaymentBreakdown currency="CHF" lines={LINES} classType="Vinyasa" date={DATE} />);
    expect(valueFor('Room')).toBe('CHF 40.00');
    expect(valueFor('Your share')).toBe('CHF 7.50');
    expect(document.body.textContent).not.toContain('€');
  });

  it('names the class and day in the summary, so several past classes stay distinguishable', () => {
    render(<PaymentBreakdown currency="EUR" lines={LINES} classType="Vinyasa" date={DATE} />);
    expect(
      screen.getByLabelText(`Where your payment goes — Vinyasa, ${formatDayHeader(DATE)}`),
    ).toBeInTheDocument();
  });
});
