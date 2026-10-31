import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SiteFooter } from './site-footer';

const href = (name: string | RegExp) => screen.getByRole('link', { name }).getAttribute('href');

describe('SiteFooter', () => {
  it('links both pricing subpages', () => {
    render(<SiteFooter signedIn={false} />);
    expect(href('Sliding scale')).toBe('/sliding-scale');
    expect(href('Donation-based')).toBe('/donation-based');
  });

  it('keeps the repository and contact links', () => {
    render(<SiteFooter signedIn={false} />);
    expect(href('Open source')).toBe('https://github.com/ivohofland/fair.yoga');
    expect(href('Contact')).toBe('mailto:hello@fair.yoga');
  });

  it('swaps Sign in for Open the app when signed in', () => {
    const { unmount } = render(<SiteFooter signedIn={false} />);
    expect(href('Sign in')).toBe('/login');
    expect(screen.queryByRole('link', { name: 'Open the app' })).toBeNull();
    unmount();
    render(<SiteFooter signedIn />);
    expect(href('Open the app')).toBe('/start');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });
});
