import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ListRow, ListRowSkeleton, listRowClass } from './list-row';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

describe('listRowClass', () => {
  it('is the 56px directory row: py-2, divider between rows', () => {
    expect(set(listRowClass())).toEqual(set('min-h-14 py-2 border-b border-border last:border-b-0'));
  });
  it('names the relaxed padding and the every-row divider', () => {
    expect(set(listRowClass({ density: 'relaxed', divider: 'after-each', className: 'flex gap-3' })))
      .toEqual(set('min-h-14 py-3 border-b border-border flex gap-3'));
  });
});

describe('ListRow', () => {
  it('renders a div, or a link when given href, through the same frame', () => {
    render(<><ListRow className="flex">A</ListRow><ListRow href="/x" className="flex no-underline">B</ListRow></>);
    expect(set(screen.getByText('A').className)).toEqual(set(listRowClass({ className: 'flex' })));
    const link = screen.getByRole('link', { name: 'B' });
    expect(link.getAttribute('href')).toBe('/x');
    expect(set(link.className)).toEqual(set(listRowClass({ className: 'flex no-underline' })));
  });
});

describe('ListRowSkeleton', () => {
  it('shares the frame with ListRow for the same options', () => {
    const { container } = render(<ListRowSkeleton density="relaxed" divider="after-each" />);
    const row = container.firstElementChild;
    expect(row?.getAttribute('aria-hidden')).toBe('true');
    for (const token of set(listRowClass({ density: 'relaxed', divider: 'after-each' }))) {
      expect(row?.classList.contains(token)).toBe(true);
    }
  });
  it('draws two lines by default and one on request', () => {
    const two = render(<ListRowSkeleton />).container.firstElementChild;
    const one = render(<ListRowSkeleton lines={1} />).container.firstElementChild;
    expect(two?.children.length).toBe(2);
    expect(one?.children.length).toBe(1);
  });
});
