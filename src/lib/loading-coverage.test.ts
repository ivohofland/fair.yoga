import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const APP = path.resolve(__dirname, '../app');

/**
 * 'group': the route deliberately shows its route group's neutral fallback.
 * 'none': no loading.tsx covers it; the previous page stays until it is ready.
 */
type FallbackKind = 'group' | 'none';

// Every page.tsx without a loading.tsx in its own segment, and the fallback
// it relies on. A new page fails the first test below until it gets its own
// loading.tsx or an entry here (docs/design-brief.md, Loading states).
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
  '(teacher)/class/[id]/edit': 'group',
  '(teacher)/class/new': 'group',
  '(teacher)/inbox/invitations': 'group',
  '(teacher)/schedule/past': 'group',
  '(teacher)/settings/notifications': 'group',
  '(teacher)/settings/payments': 'group',
  '(teacher)/settings/profile': 'group',
  '(teacher)/settings/recurring': 'group',
  '(teacher)/settings/recurring/[id]': 'group',
  '(teacher)/settings/recurring/archived': 'group',
  '(teacher)/settings/recurring/new': 'group',
  '(teacher)/settings/reporting': 'group',
  '(teacher)/settings/rooms': 'group',
  '(teacher)/settings/rooms/[id]': 'group',
  '(teacher)/settings/rooms/archived': 'group',
  '(teacher)/settings/rooms/new': 'group',
  '(teacher)/settings/studio-classes': 'group',
  '(teacher)/settings/studio-classes/[id]': 'group',
  '(teacher)/settings/studio-classes/archived': 'group',
  '(teacher)/settings/studio-classes/new': 'group',
  '(teacher)/students/[id]': 'group',
  '(teacher)/students/archived': 'group',
  '(teacher)/students/contacts/[id]': 'group',
  '(teacher)/students/contacts/archived': 'group',
  '(teacher)/students/new': 'group',
  '(teacher)/studio-class/[id]': 'group',
  '(teacher)/studio-class/[id]/edit': 'group',
  '(teacher)/studio-class/new': 'group',
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
  it('each page has its own loading.tsx or a FALLBACK_ROUTES entry', () => {
    const unchosen = pages.filter((key) => !ownLoading(key) && !(key in FALLBACK_ROUTES));
    expect(unchosen).toEqual([]);
  });

  it('a group entry is actually covered by its route group\'s fallback, not a sibling\'s skeleton', () => {
    const wrong = Object.entries(FALLBACK_ROUTES)
      .filter(([, kind]) => kind === 'group')
      .flatMap(([key]) => {
        const covering = closestLoading(key);
        const group = routeGroup(key);
        return covering !== null && covering === group ? [] : [`${key} is covered by ${covering ?? 'nothing'}`];
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

  it('names no page that does not exist, and none that has its own loading.tsx', () => {
    const stale = Object.keys(FALLBACK_ROUTES).filter((key) => !pages.includes(key));
    const redundant = Object.keys(FALLBACK_ROUTES).filter((key) => pages.includes(key) && ownLoading(key));
    expect({ stale, redundant }).toEqual({ stale: [], redundant: [] });
  });

  it('no loading.tsx imports from @/components/ui/skeleton at all', () => {
    const raw = loadings
      .filter((file) => readFileSync(file, 'utf8').includes('@/components/ui/skeleton'))
      .map((file) => toKey(path.dirname(file)));
    expect(raw).toEqual([]);
  });
});
