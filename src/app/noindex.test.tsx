import { describe, it, expect, vi } from 'vitest';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import type { Metadata } from 'next';

vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('@/lib/db', () => ({ prisma: {} }));
vi.mock('next/headers', () => ({ headers: async () => new Headers(), cookies: async () => new Map() }));

// robots.txt names no path (see robots.test.ts), so each page keeps itself out
// of search. Policy: docs/technical-architecture.md (Search engines).
const APP = path.resolve(__dirname);
const PUBLIC = path.join(APP, '(public)');

type Loader = () => Promise<{ metadata?: Metadata }>;

/** Public routes that say noindex, and the module that says it. */
const NOINDEX_PUBLIC: Record<string, Loader> = {
  verify: () => import('./(public)/verify/layout'),
  unsubscribe: () => import('./(public)/unsubscribe/page'),
  'payout-pause': () => import('./(public)/payout-pause/page'),
  'passkey-revoke': () => import('./(public)/passkey-revoke/page'),
  'signup/profile': () => import('./(public)/signup/profile/page'),
};

/** Public routes search engines may index. */
const INDEXABLE_PUBLIC = new Set([
  // A teacher's own page and its classes: found where the teacher shares them.
  // The booking page says noindex for a private class itself.
  '[slug]',
  '[slug]/book/[classId]',
  'login',
  'signup',
  // Only redirects.
  'start',
]);

function routeGroups(): string[] {
  return readdirSync(APP, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\(.+\)$/.test(d.name) && d.name !== '(public)')
    .map((d) => d.name);
}

function publicRoutes(): string[] {
  return readdirSync(PUBLIC, { recursive: true, encoding: 'utf8' })
    .filter((file) => path.basename(file) === 'page.tsx')
    .map((file) => path.dirname(file).split(path.sep).join('/'));
}

describe('pages kept out of search', () => {
  it.each(routeGroups())('the %s section says noindex', async (group) => {
    const { metadata } = (await import(/* @vite-ignore */ path.join(APP, group, 'layout.tsx'))) as {
      metadata?: Metadata;
    };
    expect(metadata?.robots).toEqual({ index: false });
  });

  it('every public page is either noindex or deliberately indexable', () => {
    const unclassified = publicRoutes().filter((r) => !(r in NOINDEX_PUBLIC) && !INDEXABLE_PUBLIC.has(r));
    const stale = [...Object.keys(NOINDEX_PUBLIC), ...INDEXABLE_PUBLIC].filter((r) => !publicRoutes().includes(r));
    expect({ unclassified, stale }).toEqual({ unclassified: [], stale: [] });
  });

  it.each(Object.entries(NOINDEX_PUBLIC))('/%s says noindex', async (_route, load) => {
    const { metadata } = await load();
    expect(metadata?.robots).toEqual({ index: false });
  });
});
