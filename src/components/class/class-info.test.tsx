import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { classRow } from '@/components/schedule/class-list-fixtures';
import { ClassInfo, ClassInfoSkeleton } from './class-info';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));
const INTERACTIVE = 'a, button, input, select, textarea, [tabindex]';

describe('ClassInfoSkeleton', () => {
  it('draws through ClassInfo\'s own frame and badge row, on the page surface, hidden and inert', () => {
    const real = render(
      <ClassInfo cls={classRow('c-1', 'open', [])} registrationCount={3} waitlistCount={0} />,
    ).container.firstElementChild;
    const { container } = render(<ClassInfoSkeleton />);
    const skel = container.firstElementChild;

    expect(skel?.getAttribute('aria-hidden')).toBe('true');
    expect(set(skel?.className)).toEqual(set(real?.className));
    expect(set(skel?.firstElementChild?.className)).toEqual(set(real?.firstElementChild?.className));

    // The frame is the page, not a card: placeholders take the page fill.
    expect(skel?.querySelector('.bg-sand-soft')).not.toBeNull();
    expect(skel?.querySelector('.bg-sand')).toBeNull();

    // The date, room and count lines carry the real lines' type styles and
    // vertical margins, so each placeholder line is its line's height.
    const geometry = (el: Element) => [...set(el.className)].filter((t) => t.startsWith('type-') || /^m[tb]-/.test(t)).sort();
    const lines = [...(real?.querySelectorAll('p') ?? [])].map(geometry);
    const skelLines = [...(skel?.children ?? [])].slice(1).map(geometry);
    expect(skelLines).toEqual(lines);

    expect(container.querySelector(INTERACTIVE)).toBeNull();
  });
});
