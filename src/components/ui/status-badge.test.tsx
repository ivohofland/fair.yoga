import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { StatusBadge, StatusBadgeSkeleton } from './status-badge';

const BADGE_FRAME_TOKENS = [
  'inline-block',
  'border',
  'rounded-field',
  'px-2.5',
  'py-[3px]',
  'text-[13px]',
  'font-medium',
  'leading-[1.4]',
  'whitespace-nowrap',
];

describe('StatusBadgeSkeleton', () => {
  it("shares the real badge's frame tokens", () => {
    const real = render(<StatusBadge variant="registering" />).container.firstElementChild;
    const skel = render(<StatusBadgeSkeleton />).container.firstElementChild;
    for (const token of BADGE_FRAME_TOKENS) {
      expect(real?.classList.contains(token)).toBe(true);
      expect(skel?.classList.contains(token)).toBe(true);
    }
  });

  it('is aria-hidden with invisible text and border', () => {
    const { container } = render(<StatusBadgeSkeleton />);
    const el = container.firstElementChild;
    expect(el?.getAttribute('aria-hidden')).toBe('true');
    expect(el?.classList.contains('text-transparent')).toBe(true);
    expect(el?.classList.contains('border-transparent')).toBe(true);
  });

  it('uses bg-sand-soft on the page surface and bg-sand on a card', () => {
    const page = render(<StatusBadgeSkeleton />).container.firstElementChild;
    const card = render(<StatusBadgeSkeleton surface="card" />).container.firstElementChild;
    expect(page?.classList.contains('bg-sand-soft')).toBe(true);
    expect(card?.classList.contains('bg-sand')).toBe(true);
    expect(card?.classList.contains('bg-sand-soft')).toBe(false);
  });
});
