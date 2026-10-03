import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PageHeader, PageHeaderSkeleton } from './page-header';

const set = (s: string | null | undefined) => new Set((s ?? '').split(/\s+/).filter(Boolean));

describe('PageHeaderSkeleton', () => {
  it('shares the header frame and anchor with PageHeader', () => {
    const real = render(<PageHeader title="Rooms" backHref="/settings" backLabel="Settings" />).container.firstElementChild;
    const skel = render(<PageHeaderSkeleton backHref="/settings" />).container.firstElementChild;
    expect(real?.getAttribute('data-layout-anchor')).toBe('header');
    expect(skel?.getAttribute('data-layout-anchor')).toBe('header');
    expect(set(skel?.className)).toEqual(set(real?.className));
  });

  it('draws the back-link slot with the link\'s classes but no link', () => {
    render(<PageHeader title="Rooms" backHref="/settings" backLabel="Settings" />);
    const link = screen.getByRole('link', { name: 'Settings' });
    const { container } = render(<PageHeaderSkeleton />);
    expect(container.querySelector('a')).toBeNull();
    const slot = container.firstElementChild?.firstElementChild;
    for (const token of ['inline-flex', 'items-center', 'gap-1.5', 'type-label', 'mb-2']) {
      expect(link.classList.contains(token)).toBe(true);
      expect(slot?.classList.contains(token)).toBe(true);
    }
  });

  it('has no back slot on a tab page, and the variant\'s title style', () => {
    const { container } = render(<PageHeaderSkeleton backHref={null} variant="display" />);
    const root = container.firstElementChild;
    expect(root?.children.length).toBe(1);
    expect(root?.querySelector('.type-display')).not.toBeNull();
    expect(root?.querySelector('h1')).toBeNull();
  });

  it('draws an action placeholder only when asked', () => {
    const row = (action: boolean) =>
      render(<PageHeaderSkeleton backHref={null} action={action} />).container.firstElementChild?.lastElementChild;
    expect(row(false)?.children.length).toBe(1);
    expect(row(true)?.children.length).toBe(2);
  });
});

describe('PageHeader', () => {
  // Literal, not derived from PageHeaderFrame or any shared constant: the
  // skeleton tests above compare the skeleton to this component at test
  // time, so an edit to the shared frame moves both together and neither
  // test above would notice. These strings pin what a reader actually sees
  // today, so that same edit shows up as a diff here.
  it('pins its real rendered class sets as literal strings', () => {
    const { container } = render(
      <PageHeader title="Rooms" backHref="/settings" backLabel="Settings" />,
    );
    const root = container.firstElementChild;
    const backLink = screen.getByRole('link', { name: 'Settings' });
    const titleRow = root?.children[1];
    const h1 = screen.getByRole('heading', { name: 'Rooms' });
    expect(set(root?.className)).toEqual(set('mb-6'));
    expect(set(backLink.className)).toEqual(
      set('inline-flex items-center gap-1.5 type-label mb-2 text-teal no-underline'),
    );
    expect(set(titleRow?.className)).toEqual(set('flex items-center justify-between gap-3'));
    expect(h1.tagName).toBe('H1');
    expect(set(h1.className)).toEqual(set('type-title'));
  });
});
