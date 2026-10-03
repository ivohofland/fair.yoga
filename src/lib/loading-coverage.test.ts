import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(__dirname, '..');
const APP = path.join(SRC, 'app');

/**
 * 'neutral': the closest loading.tsx is the neutral `RouteLoading` re-export.
 * 'none': no loading.tsx covers it; the previous page stays until it is ready.
 */
type FallbackKind = 'neutral' | 'none';

// Every page.tsx without a skeleton of its own in its own segment, and the
// fallback it relies on. A new page fails the first test below until it gets
// its own loading.tsx or an entry here (docs/design-brief.md, Loading states).
const FALLBACK_ROUTES: Readonly<Record<string, FallbackKind>> = {
  '(public)': 'none',
  '(public)/[slug]': 'none',
  '(public)/[slug]/book/[classId]': 'none',
  '(public)/login': 'none',
  '(public)/signup': 'none',
  '(public)/signup/profile': 'none',
  '(public)/start': 'none',
  '(public)/verify': 'none',
  '(student)/account': 'none',
  '(student)/account/data': 'none',
  '(student)/account/notifications': 'none',
  '(student)/account/privacy': 'none',
  '(student)/account/tier': 'none',
  '(student)/bookings': 'none',
  '(student)/updates': 'none',
  '(teacher)/class/[id]/edit': 'neutral',
  '(teacher)/inbox/invitations': 'neutral',
  '(teacher)/schedule/past': 'neutral',
  '(teacher)/settings/notifications': 'neutral',
  '(teacher)/settings/payments': 'neutral',
  '(teacher)/settings/profile': 'neutral',
  '(teacher)/settings/recurring': 'neutral',
  '(teacher)/settings/recurring/[id]': 'neutral',
  '(teacher)/settings/recurring/archived': 'neutral',
  '(teacher)/settings/recurring/new': 'neutral',
  '(teacher)/settings/reporting': 'neutral',
  '(teacher)/settings/rooms': 'neutral',
  '(teacher)/settings/rooms/[id]': 'neutral',
  '(teacher)/settings/rooms/archived': 'neutral',
  '(teacher)/settings/rooms/new': 'neutral',
  '(teacher)/settings/studio-classes': 'neutral',
  '(teacher)/settings/studio-classes/[id]': 'neutral',
  '(teacher)/settings/studio-classes/archived': 'neutral',
  '(teacher)/settings/studio-classes/new': 'neutral',
  '(teacher)/students/[id]': 'neutral',
  '(teacher)/students/archived': 'neutral',
  '(teacher)/students/contacts/[id]': 'neutral',
  '(teacher)/students/contacts/archived': 'neutral',
  '(teacher)/students/new': 'neutral',
  '(teacher)/studio-class/[id]': 'neutral',
  '(teacher)/studio-class/[id]/edit': 'neutral',
  '(teacher)/studio-class/new': 'neutral',
};

const toKey = (dir: string) => path.relative(APP, dir).split(path.sep).join('/');

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? files(full) : [full];
  });
}

const all = files(APP);
const pages = all.filter((f) => path.basename(f) === 'page.tsx').map((f) => toKey(path.dirname(f)));
const loadings = all.filter((f) => path.basename(f) === 'loading.tsx');

const ownLoading = (key: string) => existsSync(path.join(APP, key, 'loading.tsx'));

// The whole source of a segment loading.tsx that shows the neutral fallback.
const NEUTRAL_SOURCE = "export { RouteLoading as default } from '@/components/layout/route-loading';";
const isNeutral = (key: string) =>
  readFileSync(path.join(APP, key, 'loading.tsx'), 'utf8').trim() === NEUTRAL_SOURCE;
/** A loading.tsx in the page's own segment that draws this route's own skeleton. */
const ownSkeleton = (key: string) => ownLoading(key) && !isNeutral(key);

/** The segment whose loading.tsx would wrap this page, or null: closest first, as Next resolves it. */
function closestLoading(key: string): string | null {
  const segments = key === '' ? [] : key.split('/');
  for (let n = segments.length; n >= 0; n--) {
    const candidate = segments.slice(0, n).join('/');
    if (ownLoading(candidate)) return candidate;
  }
  return null;
}

const routeGroup = (key: string) => (/^\(.+\)$/.test(key.split('/')[0] ?? '') ? key.split('/')[0] ?? null : null);

describe('every route\'s loading state is chosen', () => {
  it('each page has its own skeleton or a FALLBACK_ROUTES entry', () => {
    const unchosen = pages.filter((key) => !ownSkeleton(key) && !(key in FALLBACK_ROUTES));
    expect(unchosen).toEqual([]);
  });

  it('a neutral entry is actually covered by the neutral fallback, not a sibling\'s skeleton', () => {
    const wrong = Object.entries(FALLBACK_ROUTES)
      .filter(([, kind]) => kind === 'neutral')
      .flatMap(([key]) => {
        const covering = closestLoading(key);
        return covering !== null && isNeutral(covering) ? [] : [`${key} is covered by ${covering ?? 'nothing'}`];
      });
    expect(wrong).toEqual([]);
  });

  it('a none entry has no loading.tsx above it', () => {
    const covered = Object.entries(FALLBACK_ROUTES)
      .filter(([, kind]) => kind === 'none')
      .flatMap(([key]) => {
        const covering = closestLoading(key);
        return covering === null ? [] : [`${key} is covered by ${covering}`];
      });
    expect(covered).toEqual([]);
  });

  it('names no page that does not exist, and none that has its own skeleton', () => {
    const stale = Object.keys(FALLBACK_ROUTES).filter((key) => !pages.includes(key));
    const redundant = Object.keys(FALLBACK_ROUTES).filter((key) => pages.includes(key) && ownSkeleton(key));
    expect({ stale, redundant }).toEqual({ stale: [], redundant: [] });
  });

  it('no loading.tsx imports from @/components/ui/skeleton at all', () => {
    const raw = loadings
      .filter((file) => readFileSync(file, 'utf8').includes('@/components/ui/skeleton'))
      .map((file) => toKey(path.dirname(file)));
    expect(raw).toEqual([]);
  });

  // A loading boundary shows only when the segment it wraps changes, so a
  // navigation between two pages below the same segment shows the closest
  // boundary below that segment — none, unless the segment has its own.
  it('every segment with pages below it has a loading.tsx of its own, outside the route groups that use none', () => {
    const groupsWithLoading = new Set(
      pages.filter((key) => FALLBACK_ROUTES[key] !== 'none').map(routeGroup),
    );
    const segments = new Set(
      pages.flatMap((key) => {
        const parts = key.split('/');
        return parts.slice(0, -1).map((_, n) => parts.slice(0, n + 1).join('/'));
      }),
    );
    const missing = [...segments]
      .filter((key) => groupsWithLoading.has(routeGroup(key)) && !ownLoading(key))
      .sort();
    expect(missing).toEqual([]);
  });
});

const CLIENT_DIRECTIVE = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*['"]use client['"]/;

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith('@/')
    ? path.join(SRC, specifier.slice(2))
    : specifier.startsWith('.')
    ? path.resolve(path.dirname(from), specifier)
    : null;
  if (base === null) return null;
  const candidates = [base, `${base}.tsx`, `${base}.ts`, path.join(base, 'index.tsx'), path.join(base, 'index.ts')];
  return candidates.find((c) => existsSync(c) && !statSync(c).isDirectory()) ?? null;
}

// A loading.tsx's fallback that renders a client component cannot paint until
// that component's JS has loaded; until then it suspends and the boundary
// above shows its own fallback instead (docs/design-brief.md, Loading states).
describe('every loading.tsx paints without waiting for JS', () => {
  it('imports nothing from a \'use client\' module', () => {
    const offending = loadings.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].flatMap(([, specifier]) => {
        if (specifier === undefined) return [];
        if (!specifier.startsWith('@/') && !specifier.startsWith('.')) return [];
        const target = resolveImport(file, specifier);
        if (target === null) return [`${toKey(path.dirname(file))}/loading.tsx → ${specifier} (unresolved)`];
        return CLIENT_DIRECTIVE.test(readFileSync(target, 'utf8'))
          ? [`${toKey(path.dirname(file))}/loading.tsx → ${path.relative(SRC, target)}`]
          : [];
      }),
    );
    expect(offending).toEqual([]);
  });
});
