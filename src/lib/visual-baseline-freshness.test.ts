import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ROUTE_BASELINES,
  extractSnapshotStems,
  findCoverageGaps,
  findStaleRoutes,
  lastCommitTime,
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

describe('lastCommitTime', () => {
  it('returns the timestamp git log reports, trimmed', () => {
    const execGit = () => '1700000000\n';
    expect(lastCommitTime('some/file.tsx', execGit)).toBe(1700000000);
  });

  it('returns null when git log finds no history for the path', () => {
    const execGit = () => '';
    expect(lastCommitTime('never/committed.tsx', execGit)).toBeNull();
  });

  it('returns null when the git command throws', () => {
    const execGit = () => {
      throw new Error('not a git repository');
    };
    expect(lastCommitTime('some/file.tsx', execGit)).toBeNull();
  });

  it('double-quotes the path so parentheses in real route-group paths are not shell-interpreted', () => {
    // Real repo, real default execGit, real file with '(' and ')' in its path.
    // If lastCommitTime ever stops quoting the path, this either throws
    // (the shell chokes on the unmatched paren) or silently returns null
    // (glob expands to nothing) instead of a real, plausible timestamp.
    const time = lastCommitTime('src/app/(public)/login/page.tsx');
    expect(time).not.toBeNull();
    expect(time as number).toBeGreaterThan(1735689600); // 2025-01-01, sanity floor
  });
});

describe('findStaleRoutes', () => {
  it('flags a route whose source changed after its baseline was last updated', () => {
    const routes = [
      { name: 'login', sourceFiles: ['src/login.tsx'], baselineFiles: ['snap/login.png'] },
    ];
    const times: Record<string, string> = {
      'src/login.tsx': '2000',
      'snap/login.png': '1000',
    };
    const execGit = (cmd: string) => {
      const path = /-- "(.+)"/.exec(cmd)?.[1] ?? '';
      return times[path] ?? '';
    };
    const stale = findStaleRoutes(routes, execGit);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ name: 'login', reason: 'stale' });
  });

  it('does not flag a route whose baseline is newer than its source', () => {
    const routes = [
      { name: 'login', sourceFiles: ['src/login.tsx'], baselineFiles: ['snap/login.png'] },
    ];
    const times: Record<string, string> = {
      'src/login.tsx': '1000',
      'snap/login.png': '2000',
    };
    const execGit = (cmd: string) => {
      const path = /-- "(.+)"/.exec(cmd)?.[1] ?? '';
      return times[path] ?? '';
    };
    expect(findStaleRoutes(routes, execGit)).toEqual([]);
  });

  it('flags a route with an untracked path instead of treating it as fresh', () => {
    const routes = [
      { name: 'login', sourceFiles: ['src/login.tsx'], baselineFiles: ['snap/login.png'] },
    ];
    const execGit = (cmd: string) => (cmd.includes('src/login.tsx') ? '1000' : '');
    const stale = findStaleRoutes(routes, execGit);
    expect(stale).toHaveLength(1);
    expect(stale[0].reason).toBe('untracked');
    expect(stale[0].detail).toContain('snap/login.png');
  });

  it('treats equal commit times as fresh, not stale (same-commit edit)', () => {
    const routes = [
      { name: 'login', sourceFiles: ['src/login.tsx'], baselineFiles: ['snap/login.png'] },
    ];
    const execGit = () => '5000';
    expect(findStaleRoutes(routes, execGit)).toEqual([]);
  });
});
