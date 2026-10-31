import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SiteHeader } from './site-header';

const href = (name: string | RegExp) => screen.getByRole('link', { name }).getAttribute('href');

describe('SiteHeader', () => {
  it('offers Sign in to a visitor, and no way into the app', () => {
    render(<SiteHeader signedIn={false} onHome />);
    expect(href('Sign in')).toBe('/login');
    expect(screen.queryByRole('link', { name: 'Open the app' })).toBeNull();
  });

  it('offers Open the app to a signed-in account, and no Sign in', () => {
    render(<SiteHeader signedIn onHome />);
    expect(href('Open the app')).toBe('/start');
    expect(screen.queryByRole('link', { name: 'Sign in' })).toBeNull();
  });

  it('anchors in place on the homepage', () => {
    render(<SiteHeader signedIn={false} onHome />);
    expect(href('What it does')).toBe('#features');
    expect(href('Open source')).toBe('#open-source');
  });

  it('anchors back to the homepage from a subpage', () => {
    render(<SiteHeader signedIn={false} onHome={false} />);
    expect(href('What it does')).toBe('/#features');
    expect(href('Open source')).toBe('/#open-source');
  });
});
