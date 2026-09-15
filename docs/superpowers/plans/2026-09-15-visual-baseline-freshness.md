# Visual Baseline Freshness Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close #542 — the visual regression suite (`tests/e2e/visual.spec.ts`) self-skips in CI (Linux, no `-linux` baselines) and has been silently red on macOS for a week after the login page changed, with nothing surfacing that anywhere a person would see it. Add a git-history-based staleness check that fails the (blocking) `checks` CI job when a route's source changed after its committed baseline did, then fix the one route (`login`) the check actually finds stale.

**Architecture:** Same script/lib split this repo already uses for every other CI policy check (`scripts/check-migrations.ts` → `src/lib/migration-policy.ts`, `scripts/check-lockfile.ts`, `scripts/check-service-image-freshness.ts` → `src/lib/service-image-*.ts`): pure, git-agnostic logic lives in a new `src/lib/visual-baseline-freshness.ts` (unit-tested with an injectable `execGit` — no real subprocess in tests), and a thin `scripts/check-visual-baseline-freshness.ts` wrapper does the real I/O and sets `process.exitCode`. The check is wired into the `checks` job specifically — it is the *only* job in `.github/workflows/ci.yml` that checks out with `fetch-depth: 0`. Every other job gets GitHub's default depth-1 shallow clone, where `git log -1 --format=%ct -- <path>` returns the tip commit's timestamp for *any* tracked path regardless of whether that commit touched it — so a copy of this check in, say, the `test-unit` job would report every route's source and baseline as "changed in the same commit" and never flag anything, silently. This is why the change also extends the existing `fetch-depth: 0` justification comment on the `checks` job's checkout step to name both checks that now depend on it.

**Premise verified:** Re-derived every claim in #542 directly against the repo (measured 2026-09-15, HEAD `67b651cc`): `login-chromium-darwin.png`'s last commit is `65f2a676` (2026-07-20); `src/app/(public)/login/page.tsx` gained its "New here?" link in `fe6a36a6` (2026-09-02, inside the page's `flex-1 flex flex-col justify-center` vertically-centered container, confirming the shift-everything-up mechanism); `git ls-files tests/e2e/visual.spec.ts-snapshots/` shows 14 files, all `-darwin`, zero `-linux`; every job in `.github/workflows/ci.yml` runs `ubuntu-latest`, so `hasBaselines` (`tests/e2e/visual.spec.ts:24-26`) is genuinely false in CI and the `test.skip` at line 215 genuinely skips all 7 visual assertions there. The issue's own acceptance criterion ("a baseline that goes stale again produces a failure somewhere a person will actually see") rules out its own third option (accept as on-demand, stop treating red as a signal) — confirmed with the user, who chose the staleness-check option over committing a second (`-linux`) baseline set.

**Tech Stack:** TypeScript (`strict: true`, no `any`), vitest (`unit` project), Node's `child_process.execSync`, no new dependencies.

**Spec:** None — classified "bounded" during brainstorming (single existing subsystem, one agreed design, no data-model/auth/money involved). Direction (staleness check vs. committing Linux baselines vs. accepting no gate) was put to the user via a direct question and confirmed before this plan was written.

## Global Constraints

- TypeScript `strict: true` everywhere touched — no `any`, no implicit types.
- Pure logic in `src/lib/visual-baseline-freshness.ts` never calls `execSync`/`readFileSync` directly inside its exported decision functions — every git-dependent function takes an injectable `execGit: (cmd: string) => string` parameter defaulting to a real implementation, exactly like `src/lib/migration-policy.ts`'s `execGit` parameter. This is what makes the unit tests real tests (canned strings in, structured results out) rather than integration tests in disguise.
- Every path interpolated into a `git` shell command MUST be double-quoted (`-- "${path}"`) — several real paths here contain `(` and `[` (`src/app/(public)/login/page.tsx`, `src/app/(public)/[slug]/page.tsx`), which an unquoted shell would try to interpret as glob/subshell syntax. This is the same hazard this project's own conventions already name for `git add` with parenthesized route-group paths.
- New test file lands at `src/lib/visual-baseline-freshness.test.ts`, which the `unit` vitest project already globs (`src/**/*.test.ts` per `vitest.config.ts`) — no config change needed.
- `pnpm run check-visual-baseline-freshness` must be a **blocking** step in the `checks` job (no `continue-on-error`) — a stale baseline silently passing is exactly the defect #542 exists to close.
- Run `pnpm run verify` before pushing (needs the app live on :3000 — see the `verify` skill's launch recipe; never restart a dev server that's already running).

---

### Task 1: `src/lib/visual-baseline-freshness.ts` — the pure staleness/coverage logic, unit-tested

**Files:**
- Create: `src/lib/visual-baseline-freshness.ts`
- Create: `src/lib/visual-baseline-freshness.test.ts`

**Interfaces:**
- Produces (used by Task 2's script):
  ```ts
  export interface RouteBaseline {
    readonly name: string;
    readonly sourceFiles: readonly string[];
    readonly baselineFiles: readonly string[];
  }
  export const VISUAL_SPEC_PATH: string; // 'tests/e2e/visual.spec.ts'
  export const ROUTE_BASELINES: readonly RouteBaseline[];

  export function extractSnapshotStems(specSource: string): string[];

  export interface CoverageGaps {
    readonly missingFromMap: readonly string[];
    readonly missingFromSpec: readonly string[];
  }
  export function findCoverageGaps(
    specSource: string,
    routes?: readonly RouteBaseline[],
  ): CoverageGaps;

  export function lastCommitTime(
    path: string,
    execGit?: (cmd: string) => string,
  ): number | null;

  export interface StaleRoute {
    readonly name: string;
    readonly reason: 'stale' | 'untracked';
    readonly detail: string;
  }
  export function findStaleRoutes(
    routes?: readonly RouteBaseline[],
    execGit?: (cmd: string) => string,
  ): StaleRoute[];
  ```

- [ ] **Step 1: Write the failing tests**

Create `src/lib/visual-baseline-freshness.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run --project unit src/lib/visual-baseline-freshness.test.ts`
Expected: FAIL — the module `./visual-baseline-freshness` does not exist yet.

- [ ] **Step 3: Write the implementation**

Create `src/lib/visual-baseline-freshness.ts`:

```ts
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
  return [...specSource.matchAll(SNAPSHOT_CALL_PATTERN)].map((m) => m[1]);
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
```

Note: `findStaleRoutes` calls `lastCommitTime` a second time for the paths already resolved in `allTimes` (once to check for `null`, again to build `sourceTimes`/`baselineTimes`). This is deliberate simplicity over micro-optimizing away seven routes' worth of `git log` calls that already ran twice each — not a hot path (a CI step, once per run). If a reviewer flags it, resolving `allTimes` once and slicing it into the two halves (`allTimes.slice(0, route.sourceFiles.length)` / `.slice(route.sourceFiles.length)`) instead of re-calling `lastCommitTime` is the fix — but don't pre-optimize this in Step 3.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run --project unit src/lib/visual-baseline-freshness.test.ts`
Expected: PASS — all tests, including the "double-quotes the path" real-git test and the "validates the real ROUTE_BASELINES against the real visual.spec.ts" test (both exercise the actual repo state, not fixtures).

- [ ] **Step 5: Commit**

```bash
git add src/lib/visual-baseline-freshness.ts src/lib/visual-baseline-freshness.test.ts
git commit -m "$(cat <<'EOF'
test(e2e): add visual baseline freshness detection library (#542)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Wire the check into the CLI, `package.json`, and CI

**Files:**
- Create: `scripts/check-visual-baseline-freshness.ts`
- Modify: `package.json` (new `check-visual-baseline-freshness` script)
- Modify: `.github/workflows/ci.yml` (new step in the `checks` job; extend the `fetch-depth: 0` comment)
- Modify: `tests/e2e/visual.spec.ts` (one sentence added to the existing top-of-file docblock)

**Interfaces:**
- Consumes: `VISUAL_SPEC_PATH`, `ROUTE_BASELINES`, `findCoverageGaps`, `findStaleRoutes` from `src/lib/visual-baseline-freshness.ts` (Task 1).

- [ ] **Step 1: Create the script**

Create `scripts/check-visual-baseline-freshness.ts`:

```ts
// scripts/check-visual-baseline-freshness.ts
import { readFileSync } from 'node:fs';
import {
  ROUTE_BASELINES,
  VISUAL_SPEC_PATH,
  findCoverageGaps,
  findStaleRoutes,
} from '../src/lib/visual-baseline-freshness';

try {
  const specSource = readFileSync(VISUAL_SPEC_PATH, 'utf8');
  const gaps = findCoverageGaps(specSource);

  let failed = false;

  if (gaps.missingFromMap.length > 0) {
    console.error(
      `\n❌ ${VISUAL_SPEC_PATH} has toHaveScreenshot() call(s) with no entry in ROUTE_BASELINES ` +
        `(src/lib/visual-baseline-freshness.ts): ${gaps.missingFromMap.join(', ')}`,
    );
    failed = true;
  }

  if (gaps.missingFromSpec.length > 0) {
    console.error(
      `\n❌ ROUTE_BASELINES (src/lib/visual-baseline-freshness.ts) names route(s) with no ` +
        `matching toHaveScreenshot() call in ${VISUAL_SPEC_PATH}: ${gaps.missingFromSpec.join(', ')}`,
    );
    failed = true;
  }

  if (failed) {
    process.exit(1);
  }

  const stale = findStaleRoutes(ROUTE_BASELINES);

  if (stale.length > 0) {
    console.error(`\n❌ ${stale.length} visual baseline(s) are stale:`);
    for (const s of stale) {
      console.error(`  [${s.name}] ${s.detail}`);
    }
    process.exit(1);
  }

  console.log('✓ Visual baselines are up to date with the routes they cover');
} catch (err) {
  console.error(
    `Failed to verify visual baseline freshness: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
```

- [ ] **Step 2: Add the package.json script**

In `package.json`, add a new line immediately after `"check-service-image-freshness": "tsx scripts/check-service-image-freshness.ts",` (alphabetical order within the `check-*` group):

```json
    "check-visual-baseline-freshness": "tsx scripts/check-visual-baseline-freshness.ts",
```

- [ ] **Step 3: Run the script against the current repo and record its output**

Run: `pnpm run check-visual-baseline-freshness`
Expected: exits 1, reporting `login` as `stale` (this is the mutation-test proof the check works — it must catch the real, known failure before you fix anything). Record the exact output in the task's report — it is the evidence for Task 3, and it is also the answer to whether any of the other 6 routes are quietly stale too (do not assume they are clean; read the actual output).

- [ ] **Step 4: Wire the step into the `checks` job**

In `.github/workflows/ci.yml`, the `checks` job has a step:

```yaml
      - name: Check migration immutability
        env:
          GITHUB_BEFORE: ${{ github.event.before }}
        run: pnpm run check-migrations

      - name: Validate Prisma schema
        run: pnpm exec prisma validate
```

Insert a new step between them:

```yaml
      - name: Check migration immutability
        env:
          GITHUB_BEFORE: ${{ github.event.before }}
        run: pnpm run check-migrations

      - name: Check visual baseline freshness
        run: pnpm run check-visual-baseline-freshness

      - name: Validate Prisma schema
        run: pnpm exec prisma validate
```

Do **not** add `continue-on-error: true` — this step must block, unlike the advisory/freshness checks further down in the same job.

Also update the existing comment on the job's checkout step (currently justifying `fetch-depth: 0` only for the migration check) to name both checks that now depend on full history:

```yaml
      - uses: actions/checkout@v7
        with:
          # fetch-depth: 0 is load-bearing for two static checks below: the
          # migration-immutability check needs refs/remotes/origin/main (PRs)
          # and the full history so GITHUB_BEFORE resolves on pushes; the
          # visual-baseline-freshness check needs `git log` to see the real
          # last-modified commit for each route's source and baseline files,
          # which a shallow clone cannot distinguish from the tip commit
          # (every job but this one gets GitHub's default depth-1 checkout).
          # Without full history the migration check fails the job rather
          # than passing — it deliberately refuses to compare HEAD to HEAD —
          # and the freshness check would silently pass everything.
          fetch-depth: 0
```

- [ ] **Step 5: Update the visual.spec.ts docblock**

In `tests/e2e/visual.spec.ts`, the existing docblock currently ends:

```ts
 * Baselines are platform-suffixed (-darwin/-linux). When a platform has
 * no baselines (currently CI/linux), the suite skips itself rather than
 * failing — regenerate with:  pnpm exec playwright test visual --update-snapshots
 */
```

Add one sentence after it:

```ts
 * Baselines are platform-suffixed (-darwin/-linux). When a platform has
 * no baselines (currently CI/linux), the suite skips itself rather than
 * failing — regenerate with:  pnpm exec playwright test visual --update-snapshots
 *
 * A baseline going stale on macOS (the only platform with baselines, and
 * this suite's only real coverage) is caught separately by
 * `pnpm run check-visual-baseline-freshness`, which runs in CI's `checks`
 * job using git history rather than rendering anything — see
 * src/lib/visual-baseline-freshness.ts.
 */
```

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm run typecheck && pnpm run lint`
Expected: PASS, no errors introduced.

- [ ] **Step 7: Commit**

```bash
git add scripts/check-visual-baseline-freshness.ts package.json .github/workflows/ci.yml tests/e2e/visual.spec.ts
git commit -m "$(cat <<'EOF'
feat(ci): block on stale visual regression baselines (#542)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Fix the flagged baseline(s), confirm green, record the decision on #542

**Files:**
- Modify: `tests/e2e/visual.spec.ts-snapshots/*.png` (only whichever files Task 2 Step 3 actually flagged — expected `login-chromium-darwin.png` and `login-Mobile-Chrome-darwin.png`, but verify against that recorded output rather than assuming)
- No source files touched in this task.

**Interfaces:** None — this task consumes Task 2's recorded output and produces regenerated baseline images plus a GitHub issue comment.

- [ ] **Step 1: Regenerate exactly the flagged baseline(s)**

Using the route name(s) Task 2 Step 3 reported as stale, regenerate only those — do not run a bare `--update-snapshots` that would touch unrelated, non-stale baselines. For the expected `login` finding:

Run: `pnpm exec playwright test visual --update-snapshots -g "login"`
Expected: the two `login-*-darwin.png` files are rewritten; no other file under `tests/e2e/visual.spec.ts-snapshots/` changes (`git status` should show exactly those two files, or the additional route(s) Task 2 actually flagged and nothing else).

- [ ] **Step 2: Confirm the check now passes**

Run: `pnpm run check-visual-baseline-freshness`
Expected: exits 0, prints `✓ Visual baselines are up to date with the routes they cover`.

- [ ] **Step 3: Confirm the regenerated baseline actually matches the live page**

Run: `pnpm exec playwright test visual -g "login"`
Expected: PASS (the freshly-generated baseline matches a fresh render — this is the acceptance criterion "the two login baselines match the shipped page", not just "the check is quiet").

- [ ] **Step 4: Run the full verify suite**

Run: `pnpm run verify`
Expected: PASS. This is `typecheck && lint && test (unit+components+unit-sweeps+integration) && check-lockfile && check-migrations` — note it does **not** run `check-visual-baseline-freshness` or the e2e/Playwright suite (`verify` predates both); Steps 1-3 above are what actually exercise this change. Say so explicitly in the PR body rather than implying `verify` alone covers it.

- [ ] **Step 5: Record the decision on issue #542**

Post a comment on issue #542 (`gh issue comment 542 --body-file <scratchpad-file>`, never `--body "..."` — backticks in the comment body would hit the shell) stating:
- Which of the three options was chosen (the staleness check) and why (catches the real failure shape at near-zero cost; committing `-linux` baselines was rejected for doubling the baseline set to maintain plus cross-platform font-rendering flakiness; the "accept as on-demand, no gate" option was rejected because it conflicts with the issue's own acceptance criterion).
- The evidence gathered during premise verification (baseline commit `65f2a676` 2026-07-20 vs. source commit `fe6a36a6` 2026-09-02; 14/14 committed baselines are `-darwin`; every CI job runs `ubuntu-latest`).
- What Task 2 Step 3's check run actually found stale (the concrete route list — do not write this from memory, copy it from that step's recorded output).
- That `pnpm run verify` is green but does not itself cover this change (Step 4's note).

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/visual.spec.ts-snapshots
git commit -m "$(cat <<'EOF'
fix(e2e): regenerate stale login visual baseline (#542)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
