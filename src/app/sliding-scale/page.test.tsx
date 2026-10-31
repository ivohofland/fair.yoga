import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const getSession = vi.fn();

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

beforeEach(() => {
  getSession.mockReset();
  getSession.mockResolvedValue(null);
});

async function renderPage(params: Record<string, string | string[] | undefined> = {}): Promise<void> {
  const { default: SlidingScalePage } = await import('./page');
  render(await SlidingScalePage({ searchParams: Promise.resolve(params) }));
}

describe('/sliding-scale metadata', () => {
  it('is indexable under its own canonical, with no social card of its own', async () => {
    const { metadata } = await import('./page');
    expect(metadata.title).toEqual({ absolute: 'Sliding-scale pricing for yoga classes · fair.yoga' });
    expect(metadata.description).toBe(
      'Five income tiers, the highest paying about twice the lowest. Set your minimum and target; fair.yoga works out every price. Try the examples.',
    );
    expect(metadata.alternates?.canonical).toBe('/sliding-scale');
    expect(metadata.openGraph).toBeUndefined();
    expect(metadata.robots).toBeUndefined();
  });
});

describe('/sliding-scale page', () => {
  it('has one h1 and never redirects a signed-in visitor', async () => {
    getSession.mockResolvedValue({ sessionId: 's', accountId: 'a', defaultTimezone: 'UTC', teacherId: 't', studentId: null });
    await renderPage();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getAllByRole('link', { name: 'Open the app' }).every((a) => a.getAttribute('href') === '/start')).toBe(true);
  });

  it('trails back home', async () => {
    await renderPage();
    const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(trail.textContent).toContain('Sliding scale');
    expect(trail.querySelector('a')?.getAttribute('href')).toBe('/');
  });

  it('presses the chip named by ?example=', async () => {
    await renderPage({ example: 'popular' });
    expect(screen.getByRole('button', { name: 'A popular class' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('falls back to the typical class for an unknown example', async () => {
    await renderPage({ example: 'nonsense' });
    expect(screen.getByRole('button', { name: 'A typical class' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('lists the five tiers with their multipliers', async () => {
    await renderPage();
    for (const label of ['Getting by', 'Managing', 'Comfortable', 'Doing well', 'Plenty to share']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    for (const x of ['0.65×', '0.8×', '1×', '1.2×', '1.35×']) {
      expect(screen.getByText(x)).toBeTruthy();
    }
  });

  it('hosts the calculator under #examples', async () => {
    await renderPage();
    const band = document.getElementById('examples');
    expect(band?.querySelector('button[aria-pressed]')).toBeTruthy();
  });

  it('answers the questions, the first open', async () => {
    await renderPage();
    for (const q of [
      'Do students have to prove their income?',
      'What if only a few people come?',
      'Can I just charge one price?',
      'What does fair.yoga take?',
    ]) {
      expect(screen.getByText(q)).toBeTruthy();
    }
    const items = document.querySelectorAll('details');
    expect(items).toHaveLength(4);
    expect(items[0]?.hasAttribute('open')).toBe(true);
    expect(items[1]?.hasAttribute('open')).toBe(false);
    expect(document.body.textContent).toContain('a choice that’s off by one makes only a small difference.');
  });

  it('carries the three points and a call to action to /signup', async () => {
    await renderPage();
    for (const t of ['You earn your rate', 'No surprises', 'No one priced out']) {
      expect(screen.getByText(t)).toBeTruthy();
    }
    expect(screen.getByRole('link', { name: 'Set up your first class' }).getAttribute('href')).toBe('/signup');
  });
});
