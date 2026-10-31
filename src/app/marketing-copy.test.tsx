import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/lib/session', () => ({ getSession: async () => null }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

beforeEach(() => document.body.replaceChildren());

// No religious or spiritual vocabulary, to avoid misinterpretation (spec §2
// anti-goals); the Sanskrit word for giving is the one this guards.
const FORBIDDEN = /\bd[aā]na\b/i;

describe('marketing copy', () => {
  it('the landing page keeps to its own words', async () => {
    const { default: Page } = await import('./page');
    render(await Page());
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  it('/sliding-scale keeps to its own words', async () => {
    const { default: Page } = await import('./sliding-scale/page');
    render(await Page({ searchParams: Promise.resolve({}) }));
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });

  it('/donation-based keeps to its own words', async () => {
    const { default: Page } = await import('./donation-based/page');
    render(await Page());
    expect(document.body.textContent).not.toMatch(FORBIDDEN);
  });
});
