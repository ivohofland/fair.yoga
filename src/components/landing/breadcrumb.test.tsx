import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { Breadcrumb } from './breadcrumb';

vi.mock('@/lib/log', () => ({ log: { error: vi.fn() } }));

function structuredData(): Record<string, unknown> {
  const script = document.querySelector('script[type="application/ld+json"]');
  return JSON.parse(script?.textContent ?? '{}') as Record<string, unknown>;
}

describe('Breadcrumb', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('shows the trail home, the current page marked as current', () => {
    render(<Breadcrumb current="Sliding scale" path="/sliding-scale" />);
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'fair.yoga' }).getAttribute('href')).toBe('/');
    expect(within(nav).getByText('Sliding scale').getAttribute('aria-current')).toBe('page');
  });

  // Search engines read the same trail the visitor sees.
  it('describes the same trail to search engines, with absolute URLs', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://fair.yoga');
    render(<Breadcrumb current="Sliding scale" path="/sliding-scale" />);
    expect(structuredData()).toEqual({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'fair.yoga', item: 'https://fair.yoga/' },
        { '@type': 'ListItem', position: 2, name: 'Sliding scale', item: 'https://fair.yoga/sliding-scale' },
      ],
    });
  });

  it('escapes < so no name can close the script element', () => {
    render(<Breadcrumb current="</script><b>x" path="/x" />);
    const raw = document.querySelector('script[type="application/ld+json"]')?.innerHTML ?? '';
    expect(raw).not.toContain('</script>');
    expect(structuredData()).toMatchObject({ itemListElement: [{}, { name: '</script><b>x' }] });
  });
});
