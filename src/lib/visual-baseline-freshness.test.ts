import { readFileSync } from 'node:fs';
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

  it('validates the real ROUTE_BASELINES + resolveBaseRef wiring against this actual repo', () => {
    // Real execGit (the default), real `git diff` against the immediately
    // preceding commit — proves the default wiring actually shells out
    // correctly end to end, not just the pure comparison logic above. Does
    // not assert which routes are stale (that depends on what the parent
    // commit touched, which changes over time) — only that it runs and
    // returns an array.
    const result = findStaleRoutes(ROUTE_BASELINES, { baseRef: 'HEAD~1' });
    expect(Array.isArray(result)).toBe(true);
  });
});
