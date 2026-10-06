import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

  it('opens on the question in the room', async () => {
    await renderAsVisitor();

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'Look around the room. Do the people on the mats look like your neighbourhood?',
    );
  });

  it('tells the story in the wireframe’s order', async () => {
    await renderAsVisitor();

    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Somewhere along the way, teaching became a business you never signed up for',
      'A free toolkit for independent teachers',
      'Fair pricing, worked out for you',
      'It’s your practice. It stays yours.',
      'Built on yoga’s own values',
      'Set up your first class in a few minutes',
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
    expect(text).toContain('Set a minimum and a target. Every price is worked out to pay you between the two.');
    expect(text).toContain('Fill in your profile and bank details, add your room, create your first class, and share your page.');
    expect(text).not.toContain('Transparent costs');
    expect(text).not.toContain('The app protects it');
  });

  it('carries the pricing demo', async () => {
    await renderAsVisitor();

    expect(screen.getByRole('slider', { name: 'Students registered' })).toBeTruthy();
    expect(screen.getByRole('slider', { name: 'Your target rate' })).toBeTruthy();
  });
});
