import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Input, InputSkeleton } from './input';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));
const INTERACTIVE = 'a, button, input, select, textarea, [tabindex]';

describe('Input', () => {
  it('keeps its resting field class set', () => {
    render(<Input aria-label="Search" />);
    expect(set(screen.getByRole('textbox', { name: 'Search' }).className)).toEqual(
      set('border rounded-field px-4 min-h-12 text-ink text-base border-border bg-sand-soft focus:outline-none focus:shadow-focus'),
    );
  });
});

describe('InputSkeleton', () => {
  it('is the resting field\'s own frame and colours, hidden and inert', () => {
    render(<Input aria-label="Search" />);
    const field = set(screen.getByRole('textbox', { name: 'Search' }).className);
    const { container } = render(<InputSkeleton />);
    const skel = container.firstElementChild;
    expect(skel?.getAttribute('aria-hidden')).toBe('true');
    const tokens = set(skel?.className);
    for (const token of ['border', 'rounded-field', 'px-4', 'min-h-12', 'border-border', 'bg-sand-soft']) {
      expect(tokens.has(token)).toBe(true);
    }
    for (const token of tokens) {
      expect(field.has(token)).toBe(true);
    }
    expect(container.querySelector(INTERACTIVE)).toBeNull();
  });
});
