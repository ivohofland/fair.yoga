/**
 * Detects drift between `tests/e2e/visual.spec.ts`'s committed baseline
 * screenshots and the routes they cover, using git history rather than
 * rendering anything. Two independent checks:
 *
 * - `findCoverageGaps`: the spec's `toHaveScreenshot('<name>.png', ...)`
 *   calls and this file's `ROUTE_BASELINES` must name the same routes —
 *   a mismatch means a visual test was added, renamed, or removed without
 *   updating the map here.
 * - `findStaleRoutes`: a route's baseline must have a commit at least as
 *   recent as every one of its source files — otherwise the page changed
 *   and nobody regenerated the screenshot.
 *
 * `scripts/check-visual-baseline-freshness.ts` is the CLI wrapper that
 * calls both and sets a process exit code; see docs there for why this
 * runs only in the `checks` CI job (fetch-depth: 0) and not others.
 */
import { execSync } from 'node:child_process';

export interface RouteBaseline {
  readonly name: string;
  readonly sourceFiles: readonly string[];
  readonly baselineFiles: readonly string[];
}

export const VISUAL_SPEC_PATH = 'tests/e2e/visual.spec.ts';

const SNAPSHOT_DIR = 'tests/e2e/visual.spec.ts-snapshots';

function baselineFiles(stem: string): string[] {
  return [
    `${SNAPSHOT_DIR}/${stem}-chromium-darwin.png`,
    `${SNAPSHOT_DIR}/${stem}-Mobile-Chrome-darwin.png`,
  ];
}

/**
 * The one list `findCoverageGaps` and `findStaleRoutes` both read. Every
 * `toHaveScreenshot('<name>.png', ...)` call in `tests/e2e/visual.spec.ts`
 * must have exactly one entry here — `findCoverageGaps` is what catches a
 * mismatch in either direction.
 */
export const ROUTE_BASELINES: readonly RouteBaseline[] = [
  {
    name: 'login',
    sourceFiles: ['src/app/(public)/login/page.tsx'],
    baselineFiles: baselineFiles('login'),
  },
  {
    name: 'public-page',
    sourceFiles: ['src/app/(public)/[slug]/page.tsx'],
    baselineFiles: baselineFiles('public-page'),
  },
  {
    name: 'schedule',
    sourceFiles: ['src/app/(teacher)/schedule/page.tsx'],
    baselineFiles: baselineFiles('schedule'),
  },
  {
    name: 'class-detail-open',
    sourceFiles: ['src/app/(teacher)/class/[id]/page.tsx'],
    baselineFiles: baselineFiles('class-detail-open'),
  },
  {
    name: 'inbox',
    sourceFiles: ['src/app/(teacher)/inbox/page.tsx'],
    baselineFiles: baselineFiles('inbox'),
  },
  {
    name: 'settings',
    sourceFiles: ['src/app/(teacher)/settings/page.tsx'],
    baselineFiles: baselineFiles('settings'),
  },
  {
    name: 'studio-template',
    sourceFiles: ['src/app/(teacher)/settings/studio-classes/[id]/page.tsx'],
    baselineFiles: baselineFiles('studio-template'),
  },
];

const SNAPSHOT_CALL_PATTERN = /toHaveScreenshot\(\s*['"]([\w-]+)\.png['"]/g;

/** Every snapshot stem named in a `toHaveScreenshot('<stem>.png', ...)` call, in order. */
export function extractSnapshotStems(specSource: string): string[] {
  return [...specSource.matchAll(SNAPSHOT_CALL_PATTERN)].map((m) => m[1] ?? '');
}

export interface CoverageGaps {
  /** Snapshot stems the spec calls that have no ROUTE_BASELINES entry. */
  readonly missingFromMap: readonly string[];
  /** ROUTE_BASELINES entries with no matching call left in the spec. */
  readonly missingFromSpec: readonly string[];
}

/**
 * Diffs `routes`' names against the `toHaveScreenshot()` calls actually
 * present in `specSource`, in both directions. A non-empty result means
 * the map and the spec have drifted apart.
 */
export function findCoverageGaps(
  specSource: string,
  routes: readonly RouteBaseline[] = ROUTE_BASELINES,
): CoverageGaps {
  const stemsInSpec = new Set(extractSnapshotStems(specSource));
  const namesInMap = new Set(routes.map((r) => r.name));

  return {
    missingFromMap: [...stemsInSpec].filter((s) => !namesInMap.has(s)),
    missingFromSpec: [...namesInMap].filter((n) => !stemsInSpec.has(n)),
  };
}

function defaultExecGit(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * The unix timestamp (seconds) of the last commit that touched `path`, or
 * `null` when the path has no commit in history (never committed, or a
 * typo'd path). The path is double-quoted in the shell command — several
 * real paths here contain `(` and `[` (route groups, dynamic segments),
 * which an unquoted shell would try to interpret.
 */
export function lastCommitTime(
  path: string,
  execGit: (cmd: string) => string = defaultExecGit,
): number | null {
  let output: string;
  try {
    output = execGit(`git log -1 --format=%ct -- "${path}"`).trim();
  } catch {
    return null;
  }
  if (!output) return null;
  const time = Number(output);
  return Number.isFinite(time) ? time : null;
}

export interface StaleRoute {
  readonly name: string;
  readonly reason: 'stale' | 'untracked';
  readonly detail: string;
}

const REGENERATE_COMMAND = 'pnpm exec playwright test visual --update-snapshots';

/**
 * Routes whose baseline no longer reflects their source: either a source
 * file's last commit is newer than the route's oldest baseline commit, or
 * one of the route's own paths has no commit in history at all (which the
 * comparison cannot evaluate honestly, so it is reported rather than
 * silently treated as fresh).
 */
export function findStaleRoutes(
  routes: readonly RouteBaseline[] = ROUTE_BASELINES,
  execGit: (cmd: string) => string = defaultExecGit,
): StaleRoute[] {
  const results: StaleRoute[] = [];

  for (const route of routes) {
    const allPaths = [...route.sourceFiles, ...route.baselineFiles];
    const allTimes = allPaths.map((p) => lastCommitTime(p, execGit));
    const untracked = allPaths.filter((_, i) => allTimes[i] === null);

    if (untracked.length > 0) {
      results.push({
        name: route.name,
        reason: 'untracked',
        detail: `no git history found for: ${untracked.join(', ')}`,
      });
      continue;
    }

    const sourceTimes = route.sourceFiles.map((p) => lastCommitTime(p, execGit) as number);
    const baselineTimes = route.baselineFiles.map((p) => lastCommitTime(p, execGit) as number);
    const newestSource = Math.max(...sourceTimes);
    const oldestBaseline = Math.min(...baselineTimes);

    if (oldestBaseline < newestSource) {
      results.push({
        name: route.name,
        reason: 'stale',
        detail: `source changed after this route's baseline was last updated. Regenerate with: ${REGENERATE_COMMAND}`,
      });
    }
  }

  return results;
}
