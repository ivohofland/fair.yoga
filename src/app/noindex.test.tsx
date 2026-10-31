import { describe, it, expect, vi } from 'vitest';
import type { Metadata } from 'next';

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers() }));

// robots.txt names no path (see robots.test.ts), so these keep themselves out
// of search: the signed-in sections, and the pages a token link lands on.
const NOINDEX_MODULES: Record<string, () => Promise<{ metadata?: Metadata }>> = {
  'teacher section': () => import('./(teacher)/layout'),
  'student section': () => import('./(student)/layout'),
  'admin section': () => import('./(admin)/layout'),
  '/verify': () => import('./(public)/verify/layout'),
  '/unsubscribe': () => import('./(public)/unsubscribe/page'),
  '/payout-pause': () => import('./(public)/payout-pause/page'),
  '/passkey-revoke': () => import('./(public)/passkey-revoke/page'),
};

describe('pages kept out of search', () => {
  it.each(Object.entries(NOINDEX_MODULES))('%s says noindex', async (_name, load) => {
    const { metadata } = await load();
    expect(metadata?.robots).toEqual({ index: false });
  });
});
