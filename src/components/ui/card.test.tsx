import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Card, CardLink } from './card';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

describe('Card', () => {
  it('without href renders a div with the surface frame', () => {
    const { container } = render(<Card>hello</Card>);
    const el = container.firstElementChild;
    expect(el?.tagName).toBe('DIV');
    expect(set(el?.className)).toEqual(
      set('bg-sand-soft border border-border rounded-card p-5'),
    );
  });

  it('with href renders a link with the surface frame plus hover and any className', () => {
    render(<Card href="/class/1" className="opacity-70">hello</Card>);
    const link = screen.getByRole('link', { name: 'hello' });
    expect(set(link.className)).toEqual(
      set('block bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand opacity-70'),
    );
  });

  it('with href and no className matches the plain hover set exactly', () => {
    render(<Card href="/class/1">hello</Card>);
    const link = screen.getByRole('link', { name: 'hello' });
    expect(set(link.className)).toEqual(
      set('block bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand'),
    );
  });
});

describe('CardLink', () => {
  it("keeps today's class set", () => {
    render(<CardLink href="/room/1">hello</CardLink>);
    const link = screen.getByRole('link', { name: /hello/ });
    expect(set(link.className)).toEqual(
      set('flex items-center gap-3 bg-sand-soft border border-border rounded-card p-5 no-underline hover:bg-sand'),
    );
  });
});
