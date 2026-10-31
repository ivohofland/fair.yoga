import { afterEach, describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PricingCalculator } from './pricing-calculator';
import { PRICING_EXAMPLES, examplePreview, type PricingExampleKey } from '@/lib/pricing-examples';
import { formatMoney } from '@/lib/format';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const KEYS = Object.keys(PRICING_EXAMPLES) as PricingExampleKey[];

function tierOnePrice(): string | null {
  const row = screen.getByText('1 · Getting by').parentElement;
  return row?.lastElementChild?.textContent ?? null;
}

const students = () => screen.getByRole('slider', { name: 'Students registered' });
const room = () => screen.getByRole('slider', { name: 'Room cost' });
const minimum = () => screen.getByRole('slider', { name: 'Your minimum' });
const target = () => screen.getByRole('slider', { name: 'Your target' });
const reset = () => screen.getByRole('button', { name: 'Reset to the example' });

describe('PricingCalculator', () => {
  it.each(KEYS)('opens on the %s example, with its chip pressed and its prices shown', (key) => {
    render(<PricingCalculator initialExample={key} />);

    const pressed = screen.getAllByRole('button', { pressed: true });
    expect(pressed.map((b) => b.textContent)).toContain(PRICING_EXAMPLES[key].label);
    expect(tierOnePrice()).toBe(formatMoney(examplePreview(key).prices[1], 'EUR'));
  });

  it('puts the chosen example in the address bar without adding history', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<PricingCalculator initialExample="typical" />);

    fireEvent.click(screen.getByRole('button', { name: 'A popular class' }));

    expect(replace).toHaveBeenCalledWith(null, '', '?example=popular#examples');
    expect(students().getAttribute('aria-valuetext')).toBe('14 students');
  });

  it('leaves the address alone when a slider moves', () => {
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<PricingCalculator initialExample="typical" />);

    fireEvent.change(students(), { target: { value: '9' } });

    expect(replace).not.toHaveBeenCalled();
  });

  it('disables reset until something differs, then restores the example', () => {
    render(<PricingCalculator initialExample="typical" />);
    expect((reset() as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(students(), { target: { value: '9' } });
    expect((reset() as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(reset());
    expect(students().getAttribute('aria-valuetext')).toBe('7 students');
    expect((reset() as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows the auto-cancel note instead of prices below the minimum class size', () => {
    render(<PricingCalculator initialExample="typical" />);
    fireEvent.change(students(), { target: { value: '3' } });

    expect(
      screen.getByText(
        'With 3 students, this class is below your minimum of 4. It would auto-cancel at the time you choose, and nobody pays.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText('1 · Getting by')).toBeNull();
  });

  it('adds a line above the target class size', () => {
    render(<PricingCalculator initialExample="typical" />);
    expect(screen.queryByText('Above your target size, extra students only lower prices.')).toBeNull();

    fireEvent.change(students(), { target: { value: '13' } });
    expect(screen.getByText('Above your target size, extra students only lower prices.')).toBeTruthy();
  });

  it('lowers the minimum when the target is dragged below it', () => {
    render(<PricingCalculator initialExample="typical" />);
    fireEvent.change(target(), { target: { value: '30' } });

    expect(minimum().getAttribute('aria-valuetext')).toBe('€30.00');
    expect(target().getAttribute('aria-valuetext')).toBe('€30.00');
    expect(screen.getByText('Same as your minimum: a flat rate.')).toBeTruthy();
  });

  it('raises the target when the minimum is dragged above it', () => {
    render(<PricingCalculator initialExample="typical" />);
    fireEvent.change(minimum(), { target: { value: '120' } });

    expect(target().getAttribute('aria-valuetext')).toBe('€120.00');
  });

  it('never lets the minimum fall below minus the room cost', () => {
    render(<PricingCalculator initialExample="typical" />);
    fireEvent.change(minimum(), { target: { value: '-20' } });
    expect(screen.getByText('Below zero: you cover part of the room yourself.')).toBeTruthy();

    fireEvent.change(room(), { target: { value: '0' } });

    expect(minimum().getAttribute('aria-valuetext')).toBe('€0.00');
  });

  it('keeps the minimum at the new floor when the room shrinks but not to zero', () => {
    render(<PricingCalculator initialExample="typical" />);
    fireEvent.change(minimum(), { target: { value: '-20' } });
    fireEvent.change(room(), { target: { value: '10' } });

    expect(minimum().getAttribute('aria-valuetext')).toBe('−€10.00');
  });

  it('switches VAT with a three-button group', () => {
    render(<PricingCalculator initialExample="typical" />);
    expect(screen.getByRole('button', { name: 'None' }).getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(screen.getByRole('button', { name: '9%' }));

    expect(screen.getByRole('button', { name: '9%' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByText('VAT (9%)')).toBeTruthy();
  });

  it('shows the hints', () => {
    render(<PricingCalculator initialExample="typical" />);

    expect(screen.getByText('The class runs from 4; your target is reached at 12.')).toBeTruthy();
    expect(screen.getByText('What you earn with 4 students')).toBeTruthy();
    expect(screen.getByText('What you earn with 12 or more')).toBeTruthy();
  });
});
