import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('@/lib/session', () => ({ getSession: async () => null }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

beforeEach(() => document.body.replaceChildren());

// The copy never names the project it was inspired by. Spec §8.
const FORBIDDEN = /\bdana\b/i;

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
