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
 * calls both and sets a process exit code; see the `fetch-depth: 0`
 * comment on the `checks` job's checkout step in
 * `.github/workflows/ci.yml` for why this runs only there and not in
 * every other job.
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

const SNAPSHOT_CALL_START_PATTERN = /toHaveScreenshot\(/g;

/** Every snapshot stem named in a `toHaveScreenshot('<stem>.png', ...)` call, in order. */
export function extractSnapshotStems(specSource: string): string[] {
  return [...specSource.matchAll(SNAPSHOT_CALL_PATTERN)].map((m) => m[1] ?? '');
}

export interface CoverageGaps {
  /** Snapshot stems the spec calls that have no ROUTE_BASELINES entry. */
  readonly missingFromMap: readonly string[];
  /** ROUTE_BASELINES entries with no matching call left in the spec. */
  readonly missingFromSpec: readonly string[];
  /**
   * `toHaveScreenshot(` call sites whose name argument isn't a simple
   * quoted string literal — `extractSnapshotStems` can't see these at all,
   * so a non-zero count here means coverage can't be verified for at least
   * one visual test, independent of `missingFromMap`/`missingFromSpec`.
   */
  readonly unparseableCallCount: number;
}

/**
 * Diffs `routes`' names against the `toHaveScreenshot()` calls actually
 * present in `specSource`, in both directions. A non-empty result means
 * the map and the spec have drifted apart.
 *
 * Also reconciles the number of calls whose name `extractSnapshotStems`
 * could read against the number of `toHaveScreenshot(` call sites present,
 * so a call naming its snapshot with anything but a quoted literal is
 * reported as `unparseableCallCount` rather than silently dropped.
 */
export function findCoverageGaps(
  specSource: string,
  routes: readonly RouteBaseline[] = ROUTE_BASELINES,
): CoverageGaps {
  const stems = extractSnapshotStems(specSource);
  const stemsInSpec = new Set(stems);
  const namesInMap = new Set(routes.map((r) => r.name));
  const totalCallSites = [...specSource.matchAll(SNAPSHOT_CALL_START_PATTERN)].length;

  return {
    missingFromMap: [...stemsInSpec].filter((s) => !namesInMap.has(s)),
    missingFromSpec: [...namesInMap].filter((n) => !stemsInSpec.has(n)),
    unparseableCallCount: totalCallSites - stems.length,
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

export const ATTESTATION_PATH = 'tests/e2e/visual-baseline-attestations.json';

export const ATTEST_COMMAND = 'pnpm run attest-visual-baseline <route>';

/**
 * A maintainer's record that one route's source changed WITHOUT changing what
 * it renders — the case `findStaleRoutes` alone cannot clear, because a
 * byte-identical regeneration leaves nothing for git to see.
 *
 * Both hashes are over content, not paths or timestamps, so the record
 * self-invalidates: edit the source again and `sourceSha256` stops matching;
 * regenerate the baseline for real and `baselineSha256` does. It can never
 * become a standing exemption for a route, only for the one pairing a
 * maintainer actually verified. `scripts/attest-visual-baseline.ts` is the
 * only thing that should write one, and it refuses unless the regeneration it
 * runs itself comes back byte-identical.
 */
export interface BaselineAttestation {
  readonly sourceSha256: string;
  readonly baselineSha256: string;
  readonly verifiedAt: string;
  readonly note?: string;
}

export type AttestationMap = Readonly<Record<string, BaselineAttestation>>;

/**
 * sha256 over each file's path and bytes in order. The path is hashed too, so
 * two files swapping contents is a different digest than leaving them alone.
 */
export function hashFiles(
  files: readonly string[],
  readFile: (path: string) => Buffer = (p) => readFileSync(p),
): string {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file);
    digest.update('\0');
    digest.update(readFile(file));
    digest.update('\0');
  }
  return digest.digest('hex');
}

function loadAttestations(readFile: (path: string) => Buffer): AttestationMap {
  try {
    return JSON.parse(readFile(ATTESTATION_PATH).toString('utf8')) as AttestationMap;
  } catch {
    // Absent or unreadable: no route is attested, which fails closed — every
    // stale route stays reported.
    return {};
  }
}

/**
 * Whether `route`'s current source and baseline content are exactly the pair a
 * maintainer recorded as rendering identically. Any read failure (a deleted
 * source file, an unreadable baseline) answers false, so a broken tree never
 * clears a route.
 */
export function isAttested(
  route: RouteBaseline,
  attestations: AttestationMap,
  readFile: (path: string) => Buffer,
): boolean {
  const attestation = attestations[route.name];
  if (!attestation) return false;
  try {
    return (
      attestation.sourceSha256 === hashFiles(route.sourceFiles, readFile) &&
      attestation.baselineSha256 === hashFiles(route.baselineFiles, readFile)
    );
  } catch {
    return false;
  }
}

/**
 * Routes whose source file(s) changed in the diff between `base` and the
 * working tree without a matching change to their baseline file(s) — this
 * diff touched a route's rendering without updating its screenshot.
 *
 * Scoped to the CURRENT diff, not all of history: a route is flagged only
 * by a source change not yet reflected in THIS diff's baseline, so an old,
 * already-merged change never re-flags a route forever.
 *
 * A genuinely non-visual source edit regenerates a byte-identical screenshot,
 * leaving nothing for git to see and no way for the route to clear on its
 * own. That case is settled by an attestation (`ATTESTATION_PATH`): a
 * maintainer's recorded, content-hashed claim that this exact source and this
 * exact baseline were verified to render the same. `isAttested` is consulted
 * only for a route this diff would otherwise flag, so an attestation can
 * never suppress a route whose baseline legitimately changed.
 */
export function findStaleRoutes(
  routes: readonly RouteBaseline[] = ROUTE_BASELINES,
  options: {
    baseRef?: string;
    env?: Record<string, string | undefined>;
    execGit?: (cmd: string) => string;
    attestations?: AttestationMap;
    readFile?: (path: string) => Buffer;
  } = {},
): StaleRoute[] {
  const env = options.env ?? process.env;
  const exec = options.execGit ?? defaultExecGit;
  const readFile = options.readFile ?? ((p: string) => readFileSync(p));
  const attestations = options.attestations ?? loadAttestations(readFile);
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

  const diffOutput = exec(`git diff --name-only ${base}`);
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
    if (sourceChanged && !baselineChanged && !isAttested(route, attestations, readFile)) {
      results.push({
        name: route.name,
        detail:
          `source changed in this diff without a matching baseline update. Regenerate with: ${REGENERATE_COMMAND}` +
          ` — or, if the regeneration comes back byte-identical because the change does not render, record that with: ${ATTEST_COMMAND}`,
      });
    }
  }
  return results;
}
