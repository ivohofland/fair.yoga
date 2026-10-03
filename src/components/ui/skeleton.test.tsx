import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Skeleton, SkeletonText } from './skeleton';

describe('Skeleton', () => {
  it('is sand-soft on the page and one sand step darker on a card', () => {
    const { container: page } = render(<Skeleton className="h-4" />);
    const { container: card } = render(<Skeleton className="h-4" surface="card" />);
    expect(page.firstElementChild?.classList.contains('bg-sand-soft')).toBe(true);
    expect(card.firstElementChild?.classList.contains('bg-sand')).toBe(true);
    expect(card.firstElementChild?.classList.contains('bg-sand-soft')).toBe(false);
  });
});

describe('SkeletonText', () => {
  it('carries the type style on a block so its line box is the real line height', () => {
    const { container } = render(<SkeletonText type="type-display" width="w-2/5" className="mt-1" />);
    const line = container.firstElementChild;
    expect(line?.getAttribute('aria-hidden')).toBe('true');
    expect(line?.classList.contains('type-display')).toBe(true);
    expect(line?.classList.contains('mt-1')).toBe(true);
    const bar = line?.firstElementChild;
    expect(bar?.classList.contains('inline-block')).toBe(true);
    expect(bar?.classList.contains('w-2/5')).toBe(true);
    expect(bar?.classList.contains('bg-sand-soft')).toBe(true);
  });

  it('uses the card tone when asked', () => {
    const { container } = render(<SkeletonText type="type-label" width="w-20" surface="card" />);
    expect(container.firstElementChild?.firstElementChild?.classList.contains('bg-sand')).toBe(true);
  });
});
