/**
 * Detects a visual-regression baseline left behind by the diff that
 * touched its route, using git diffs rather than rendering anything. Two
 * independent checks:
 *
 * - `findCoverageGaps`: the spec's `toHaveScreenshot('<name>.png', ...)`
 *   calls and this file's `ROUTE_BASELINES` must name the same routes —
 *   a mismatch means a visual test was added, renamed, or removed without
 *   updating the map here.
 * - `findStaleRoutes`: scoped to the diff between a resolved base ref and
 *   the working tree, not all of history — a route is flagged only when
 *   THIS diff touches its source file(s) without touching its baseline
 *   file(s). Reuses `resolveBaseRef` from `./migration-policy` for the same
 *   CI/PR/push/local-dev base-ref resolution `check-migrations` already
 *   solves.
 *
 * `scripts/check-visual-baseline-freshness.ts` is the CLI wrapper that
 * calls both and sets a process exit code; see docs there for why this
 * runs only in the `checks` CI job (fetch-depth: 0) and not others.
 */
import { execSync } from 'node:child_process';
import { resolveBaseRef } from './migration-policy';

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

export interface StaleRoute {
  readonly name: string;
  readonly detail: string;
}

const REGENERATE_COMMAND = 'pnpm exec playwright test visual --update-snapshots';

/**
 * Routes whose source file(s) changed in the diff between `base` and the
 * working tree without a matching change to their baseline file(s) — this
 * diff touched a route's rendering without updating its screenshot.
 *
 * Scoped to the CURRENT diff, not all of history: a route whose baseline
 * predates an old, already-merged source change is not re-flagged forever
 * by this — only a source change not yet reflected in THIS diff's baseline
 * is. This is what lets the check stay a blocking CI gate safely: a route
 * whose screenshot happens to be byte-identical to its old baseline (a
 * non-visual source edit) produces no new commit for that baseline file at
 * all, so a history-wide "is the baseline's commit newer" comparison could
 * never clear once source and baseline drift apart for unrelated reasons —
 * this diff-scoped comparison has no such trap, since it only asks about
 * paths touched in the current diff.
 */
export function findStaleRoutes(
  routes: readonly RouteBaseline[] = ROUTE_BASELINES,
  options: {
    baseRef?: string;
    env?: Record<string, string | undefined>;
    execGit?: (cmd: string) => string;
  } = {},
): StaleRoute[] {
  const env = options.env ?? process.env;
  const exec = options.execGit ?? defaultExecGit;
  const base = options.baseRef ?? resolveBaseRef(env, exec);

  if (!options.baseRef && base === 'HEAD') {
    if (env.GITHUB_BASE_REF || env.GITHUB_EVENT_NAME) {
      throw new Error(
        'Cannot resolve a base ref to compare against in CI: the pull request merge base ' +
          'or the previous commit GITHUB_BEFORE is unavailable. Comparing HEAD to HEAD would ' +
          'report zero changed routes on any input — refusing to pass. Check that checkout ' +
          'fetches full history (fetch-depth: 0).',
      );
    }
    console.warn(
      'Warning: no upstream base ref (origin/main, main, origin/master, master) could be ' +
        'resolved; comparing route files against HEAD. Only uncommitted/staged edits are ' +
        'covered — a stale local branch may miss committed changes to routes.',
    );
  }

  const diffOutput = exec(
    `git diff --name-only ${base} -- src/app tests/e2e/visual.spec.ts-snapshots`,
  );
  const changedPaths = new Set(
    diffOutput
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );

  const results: StaleRoute[] = [];
  for (const route of routes) {
    const sourceChanged = route.sourceFiles.some((f) => changedPaths.has(f));
    const baselineChanged = route.baselineFiles.some((f) => changedPaths.has(f));
    if (sourceChanged && !baselineChanged) {
      results.push({
        name: route.name,
        detail: `source changed in this diff without a matching baseline update. Regenerate with: ${REGENERATE_COMMAND}`,
      });
    }
  }
  return results;
}
