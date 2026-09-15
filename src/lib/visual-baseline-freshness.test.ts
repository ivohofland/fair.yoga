import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_BASELINES,
  extractSnapshotStems,
  findCoverageGaps,
  findStaleRoutes,
} from './visual-baseline-freshness';

describe('extractSnapshotStems', () => {
  it('extracts every toHaveScreenshot stem in order', () => {
    const source = `
      await expect(page).toHaveScreenshot('login.png', { fullPage: true });
      await expect(page).toHaveScreenshot('public-page.png', {
        fullPage: true,
      });
    `;
    expect(extractSnapshotStems(source)).toEqual(['login', 'public-page']);
  });

  it('returns an empty list when there are no calls', () => {
    expect(extractSnapshotStems('const x = 1;')).toEqual([]);
  });

  it('matches double-quoted calls too', () => {
    const source = `await expect(page).toHaveScreenshot("settings.png", {});`;
    expect(extractSnapshotStems(source)).toEqual(['settings']);
  });
});

describe('findCoverageGaps', () => {
  const routes = [
    { name: 'login', sourceFiles: ['a.tsx'], baselineFiles: ['a.png'] },
    { name: 'settings', sourceFiles: ['b.tsx'], baselineFiles: ['b.png'] },
  ];

  it('reports no gaps when the spec and the map agree', () => {
    const source = `
      toHaveScreenshot('login.png', {});
      toHaveScreenshot('settings.png', {});
    `;
    expect(findCoverageGaps(source, routes)).toEqual({
      missingFromMap: [],
      missingFromSpec: [],
    });
  });

  it('reports a spec call with no matching map entry', () => {
    const source = `
      toHaveScreenshot('login.png', {});
      toHaveScreenshot('settings.png', {});
      toHaveScreenshot('new-route.png', {});
    `;
    expect(findCoverageGaps(source, routes)).toEqual({
      missingFromMap: ['new-route'],
      missingFromSpec: [],
    });
  });

  it('reports a map entry with no matching spec call', () => {
    const source = `toHaveScreenshot('login.png', {});`;
    expect(findCoverageGaps(source, routes)).toEqual({
      missingFromMap: [],
      missingFromSpec: ['settings'],
    });
  });

  it('validates the real ROUTE_BASELINES against the real visual.spec.ts', () => {
    const source = readFileSync('tests/e2e/visual.spec.ts', 'utf8');
    expect(findCoverageGaps(source, ROUTE_BASELINES)).toEqual({
      missingFromMap: [],
      missingFromSpec: [],
    });
  });
});

describe('ROUTE_BASELINES', () => {
  it('every declared source and baseline file exists on disk', () => {
    for (const route of ROUTE_BASELINES) {
      for (const file of [...route.sourceFiles, ...route.baselineFiles]) {
        expect(existsSync(file)).toBe(true);
      }
    }
  });
});

describe('findStaleRoutes', () => {
  const routes = [
    { name: 'login', sourceFiles: ['src/login.tsx'], baselineFiles: ['snap/login.png'] },
  ];

  it('flags a route whose source changed in the diff without a matching baseline update', () => {
    const execGit = (cmd: string) => (cmd.includes('diff --name-only') ? 'src/login.tsx\n' : '');
    const stale = findStaleRoutes(routes, { baseRef: 'main', execGit });
    expect(stale).toEqual([
      {
        name: 'login',
        detail:
          'source changed in this diff without a matching baseline update. Regenerate with: pnpm exec playwright test visual --update-snapshots',
      },
    ]);
  });

  it('does not flag a route whose source and baseline both changed in the diff', () => {
    const execGit = () => 'src/login.tsx\nsnap/login.png\n';
    expect(findStaleRoutes(routes, { baseRef: 'main', execGit })).toEqual([]);
  });

  it('does not flag a route the diff never touches', () => {
    const execGit = () => 'some/unrelated/file.ts\n';
    expect(findStaleRoutes(routes, { baseRef: 'main', execGit })).toEqual([]);
  });

  it('does not flag a route whose baseline changed but source did not (a deliberate baseline refresh)', () => {
    const execGit = () => 'snap/login.png\n';
    expect(findStaleRoutes(routes, { baseRef: 'main', execGit })).toEqual([]);
  });

  it('throws when CI env vars are set but base resolution degrades to HEAD', () => {
    const execGit = () => {
      throw new Error('no merge base available');
    };
    expect(() =>
      findStaleRoutes(routes, {
        env: { GITHUB_BASE_REF: 'main', GITHUB_EVENT_NAME: 'pull_request' },
        execGit,
      }),
    ).toThrow(/Cannot resolve a base ref/);
  });

  it('flags a real repo route via a real git diff against the empty tree, proving the real shell-out and path matching work end to end', () => {
    // The empty-tree hash is git's well-known constant for "no commit, no
    // files" — diffing HEAD against it lists every file currently tracked,
    // so this doesn't depend on any specific commit and won't rot over time.
    const EMPTY_TREE_HASH = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const routes = [
      {
        name: 'login',
        sourceFiles: ['src/app/(public)/login/page.tsx'],
        baselineFiles: ['tests/e2e/visual.spec.ts-snapshots/this-file-does-not-exist.png'],
      },
    ];
    const stale = findStaleRoutes(routes, { baseRef: EMPTY_TREE_HASH });
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ name: 'login' });
  });
});
