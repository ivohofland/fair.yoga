import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import { LandingPricingDemo } from './landing-pricing-demo';

const BELOW_MINIMUM =
  'This class needs 4 students to go ahead. If it doesn’t get there, it’s cancelled and nobody pays.';

function row(label: string): [string | null, string | null] {
  const cells = Array.from(screen.getByText(label).parentElement?.children ?? []);
  return [cells[1]?.textContent ?? null, cells[2]?.textContent ?? null];
}

const students = () => screen.getByRole('slider', { name: 'Students registered' });
const rate = () => screen.getByRole('slider', { name: 'Your target rate' });

describe('LandingPricingDemo', () => {
  it('opens on a class of 7 at a €90 target', () => {
    render(<LandingPricingDemo />);

    expect(students().getAttribute('aria-valuetext')).toBe('7 students');
    expect(rate().getAttribute('aria-valuetext')).toBe('€90.00');
    expect(screen.getByText('€58.75')).toBeTruthy();
    expect(row('1 · Getting by')).toEqual(['1', '€7.31']);
    expect(row('2 · Managing')).toEqual(['1', '€9.00']);
    expect(row('3 · Comfortable')).toEqual(['3', '€11.25']);
    expect(row('4 · Doing well')).toEqual(['1', '€13.50']);
    expect(row('5 · Plenty to share')).toEqual(['1', '€15.19']);
    expect(screen.getByText('Highest pays 2.1× the lowest')).toBeTruthy();
  });

  it('leaves out rate progress, which only means something to a teacher with rates set', () => {
    render(<LandingPricingDemo />);

    expect(screen.getByText('Room cost')).toBeTruthy();
    expect(screen.queryByText('Rate progress')).toBeNull();
  });

  it('bounds its sliders to the example class', () => {
    render(<LandingPricingDemo />);

    expect([students().getAttribute('min'), students().getAttribute('max')]).toEqual(['2', '12']);
    expect([rate().getAttribute('min'), rate().getAttribute('max'), rate().getAttribute('step')]).toEqual([
      '50',
      '130',
      '5',
    ]);
  });

  it('moves every price with the target rate and keeps the spread', () => {
    render(<LandingPricingDemo />);
    fireEvent.change(rate(), { target: { value: '130' } });

    expect(rate().getAttribute('aria-valuetext')).toBe('€130.00');
    expect(screen.getByText('€73.75')).toBeTruthy();
    expect(row('1 · Getting by')).toEqual(['1', '€8.71']);
    expect(row('2 · Managing')).toEqual(['1', '€10.71']);
    expect(row('3 · Comfortable')).toEqual(['3', '€13.39']);
    expect(row('4 · Doing well')).toEqual(['1', '€16.07']);
    expect(row('5 · Plenty to share')).toEqual(['1', '€18.08']);
    expect(screen.getByText('Highest pays 2.1× the lowest')).toBeTruthy();
  });

  it('goes ahead at exactly the minimum, re-spreading the smaller class', () => {
    render(<LandingPricingDemo />);
    fireEvent.change(students(), { target: { value: '4' } });

    expect(screen.queryByText(BELOW_MINIMUM)).toBeNull();
    expect(screen.getByText('€40.00')).toBeTruthy();
    // 4 students spread 0,1,2,1,0 over a €60.00 class
    expect(row('1 · Getting by')).toEqual(['0', '€9.75']);
    expect(row('3 · Comfortable')).toEqual(['2', '€15.00']);
    expect(screen.getByText('Highest pays 1.5× the lowest')).toBeTruthy();
  });

  it('moves the registration count with the student slider', () => {
    render(<LandingPricingDemo />);
    fireEvent.change(students(), { target: { value: '10' } });

    expect(screen.getByText('/ 4–12').previousElementSibling?.textContent).toBe('10');
  });

  it('draws registrations on the student slider itself, not on a second bar', () => {
    const { container } = render(<LandingPricingDemo />);
    const track = (slider: HTMLElement) => slider.parentElement;

    // One track per slider, each owning its own fill
    expect(container.querySelectorAll('[data-range-fill]')).toHaveLength(2);
    const fill = track(students())?.querySelector<HTMLElement>('[data-range-fill]');
    // 7 on a 2–12 slider is half way, measured between the thumb's two end stops
    expect(fill?.style.width).toBe('calc(var(--thumb) / 2 + (100% - var(--thumb)) * 0.5)');
    // The minimum of 4 sits a fifth of the way along that same travel
    const tick = track(students())?.querySelector<HTMLElement>('[data-range-tick]');
    expect(tick?.style.left).toBe('calc(var(--thumb) / 2 + (100% - var(--thumb)) * 0.2)');
    expect(track(rate())?.querySelector('[data-range-tick]')).toBeNull();
  });

  it('fills the student slider in danger until the class can go ahead', () => {
    render(<LandingPricingDemo />);
    const fill = () => students().parentElement?.querySelector('[data-range-fill]');

    expect(fill()?.className).toContain('bg-teal');
    fireEvent.change(students(), { target: { value: '3' } });
    expect(fill()?.className).toContain('bg-danger');
  });

  it('shows the cancellation instead of prices below the minimum', () => {
    render(<LandingPricingDemo />);
    fireEvent.change(students(), { target: { value: '3' } });

    expect(students().getAttribute('aria-valuetext')).toBe('3 students');
    expect(screen.getByText(BELOW_MINIMUM)).toBeTruthy();
    expect(screen.queryByText('You earn')).toBeNull();
  });

  it('keeps its live region mounted so the cancellation is announced when it appears', () => {
    render(<LandingPricingDemo />);
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('');

    fireEvent.change(students(), { target: { value: '3' } });

    expect(screen.getByRole('status')).toBe(region);
    expect(region.textContent).toBe(BELOW_MINIMUM);
  });

  it('server-renders the default state with no shuffle control', () => {
    const html = renderToStaticMarkup(<LandingPricingDemo />);

    expect(html).toContain('€58.75');
    expect(html).not.toContain('Shuffle mix');
  });
});
