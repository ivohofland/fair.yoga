import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { FeatureBand } from './feature-band';
import { examplePreview } from '@/lib/pricing-examples';
import { formatMoney } from '@/lib/format';

describe('FeatureBand', () => {
  it('names itself for the header link and its heading', () => {
    render(<FeatureBand />);
    const band = document.getElementById('features');
    expect(band?.tagName).toBe('SECTION');
    expect(screen.getByRole('region', { name: 'Everything a class needs, nothing it doesn’t' })).toBe(band);
  });

  it('shows the four cards in order', () => {
    render(<FeatureBand />);
    const labels = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(labels).toEqual([
      'Charge what’s fair, earn what you need',
      'Your schedule, set once',
      'Fill the room without chasing',
      'Paid directly, tracked for you',
    ]);
    const cards = screen.getAllByRole('article').map((a) => a.querySelector('p')?.textContent);
    expect(cards).toEqual(['Pricing', 'Classes', 'Students', 'Money']);
  });

  it('links only the two pricing subpages and the proof examples', () => {
    render(<FeatureBand />);
    const links = screen.getAllByRole('link').map((a) => [a.textContent, a.getAttribute('href')]);
    expect(links).toEqual([
      ['Sliding scale', '/sliding-scale'],
      ['Donation-based', '/donation-based'],
      ['See more examples →', '/sliding-scale#examples'],
    ]);
  });

  it('computes the proof from the typical example', () => {
    render(<FeatureBand />);
    const { prices, teacherRate } = examplePreview('typical');
    const proof = screen.getByLabelText('Example class');
    expect(within(proof).getByText('Example: 7 students, a €20 room, your target €90')).toBeTruthy();
    expect(within(proof).getByText(formatMoney(prices[1], 'EUR'))).toBeTruthy();
    expect(within(proof).getByText(formatMoney(prices[5], 'EUR'))).toBeTruthy();
    expect(within(proof).getByText(formatMoney(teacherRate, 'EUR'))).toBeTruthy();
    for (const label of ['lowest tier pays', 'highest tier pays', 'you earn']) {
      expect(within(proof).getByText(label)).toBeTruthy();
    }
  });

  it('carries the copy and the closing strip', () => {
    render(<FeatureBand />);
    const text = document.body.textContent ?? '';
    expect(text).toContain('Your live schedule on your own website, plus a calendar feed students can subscribe to');
    expect(text).toContain('Waive a payment when life happens');
    expect(text).toContain('Works as an app on your phone · No passwords · No commission, ever');
  });
});
