import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';

const getSession = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

beforeEach(() => {
  getSession.mockReset();
});

const base = { sessionId: 's1', accountId: 'a1', defaultTimezone: 'Europe/Amsterdam' };

const ALLOWED_HREFS = new Set([
  '/signup',
  '/login',
  '#pricing',
  '#open-source',
  'https://github.com/ivohofland/fair.yoga',
  'mailto:hello@fair.yoga',
]);

async function renderAsVisitor(): Promise<void> {
  const { default: LandingPage } = await import('./page');
  getSession.mockResolvedValue(null);
  render(await LandingPage());
}

describe('LandingPage', () => {
  it.each([
    ['teacher', { teacherId: 't1', studentId: null }, '/schedule'],
    ['student', { teacherId: null, studentId: 'st1' }, '/bookings'],
    ['two-hat account', { teacherId: 't1', studentId: 'st1' }, '/schedule'],
  ])('sends a signed-in %s home', async (_who, hats, home) => {
    const { default: LandingPage } = await import('./page');
    getSession.mockResolvedValue({ ...base, ...hats });

    await expect(LandingPage()).rejects.toThrow(`REDIRECT:${home}`);
  });

  it('shows the page to a signed-in account with neither hat', async () => {
    const { default: LandingPage } = await import('./page');
    getSession.mockResolvedValue({ ...base, teacherId: null, studentId: null });
    render(await LandingPage());

    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });

  it('sends each call to action where it says', async () => {
    await renderAsVisitor();
    const href = (scope: HTMLElement, name: string | RegExp) =>
      within(scope).getByRole('link', { name }).getAttribute('href');

    const nav = screen.getByRole('navigation', { name: 'Site' });
    const footer = screen.getByRole('contentinfo');
    const hrefs = (name: string | RegExp) =>
      screen.getAllByRole('link', { name }).map((a) => a.getAttribute('href'));
    expect(href(nav, 'Sign in')).toBe('/login');
    expect(href(nav, 'How the pricing works')).toBe('#pricing');
    expect(href(nav, 'Open source')).toBe('#open-source');
    expect(hrefs('Set up your first class')).toEqual(['/signup', '/signup']);
    expect(href(document.body, /See how the pricing works/)).toBe('#pricing');
    expect(href(document.body, 'See the code on GitHub')).toBe('https://github.com/ivohofland/fair.yoga');
    expect(href(footer, 'Open source')).toBe('https://github.com/ivohofland/fair.yoga');
    expect(href(footer, 'Contact')).toBe('mailto:hello@fair.yoga');
    expect(href(footer, 'Sign in')).toBe('/login');
  });

  it('lands the pricing link on the demo', async () => {
    await renderAsVisitor();

    const pricing = document.getElementById('pricing');
    expect(pricing?.contains(screen.getByRole('slider', { name: 'Students registered' }))).toBe(true);
  });

  it('opens on what it is and who it is for', async () => {
    await renderAsVisitor();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'A free booking system that prices no one out.',
    );
  });

  it('lands the open source link on the open source section', async () => {
    await renderAsVisitor();

    const section = document.getElementById('open-source');
    expect(section?.contains(screen.getByRole('link', { name: 'See the code on GitHub' }))).toBe(true);
  });

  it('tells the story in the design’s order', async () => {
    await renderAsVisitor();

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Look around the room. Do the people on the mats look like your neighbourhood?',
      'Same class, a fair price for each person in it',
      'Your students, your income, your rules',
      'Fair to everyone in the room',
      'Your first class, ready in a few minutes',
    ]);
  });

  it('links only where a page exists', async () => {
    await renderAsVisitor();

    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs.filter((h) => !ALLOWED_HREFS.has(h ?? ''))).toEqual([]);
    for (const href of ALLOWED_HREFS) expect(hrefs).toContain(href);
    expect(document.getElementById('pricing')).not.toBeNull();
  });

  it('promises only what the product does', async () => {
    await renderAsVisitor();
    const text = document.body.textContent ?? '';

    expect(text).toContain('who’s paid and who hasn’t');
    expect(text).toContain('Prices are set so you always land between your minimum and your target.');
    expect(text).toContain('Students tell us which income tier fits them. Nobody asks them for proof.');
    expect(text).toContain('Five short steps, then you have a page to share with your students.');
    expect(text).not.toContain('Transparent costs');
    expect(text).not.toContain('The app protects it');
  });

  it('carries the pricing demo', async () => {
    await renderAsVisitor();

    expect(screen.getByRole('slider', { name: 'Students registered' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Your target rate' })).toBeTruthy();
  });
});
