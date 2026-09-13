import { execSync } from 'node:child_process';

export type MigrationViolationType =
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'type-changed'
  | 'unknown';

export type MigrationViolation =
  | {
      readonly type: 'renamed';
      readonly status: string;
      readonly path: string;
      readonly oldPath: string;
    }
  | {
      readonly type: Exclude<MigrationViolationType, 'renamed'>;
      readonly status: string;
      readonly path: string;
    };

/**
 * Parses the tab-delimited output of `git diff --name-status` and returns
 * violations for any path whose status indicates a modification, deletion,
 * rename, or type change.
 *
 * New paths (status 'A') are legitimate and ignored, and any unrecognized
 * status is surfaced as `type: 'unknown'` instead of being silently dropped.
 *
 * This is a pure status parser: it does not itself know which paths matter.
 * The caller scopes the git diff to `prisma/migrations/` and filters the
 * results down to `.sql` paths (see `findMigrationViolations`).
 */
export function parseMigrationDiff(diffOutput: string): MigrationViolation[] {
  const lines = diffOutput
    .trim()
    .split('\n')
    .filter((l) => l.trim().length > 0);

  const violations: MigrationViolation[] = [];

  for (const line of lines) {
    const parts = line.split('\t');
    const status = parts[0]?.trim() ?? '';
    if (!status || status === 'A') {
      continue;
    }

    if (status.startsWith('M')) {
      violations.push({
        type: 'modified',
        status,
        path: parts[1] ?? '',
      });
    } else if (status.startsWith('D')) {
      violations.push({
        type: 'deleted',
        status,
        path: parts[1] ?? '',
      });
    } else if (status.startsWith('R')) {
      if (parts.length >= 3) {
        violations.push({
          type: 'renamed',
          status,
          oldPath: parts[1] ?? '',
          path: parts[2] ?? '',
        });
      } else {
        // A rename line with no destination path cannot be reported as one.
        violations.push({
          type: 'unknown',
          status,
          path: parts[1] ?? '',
        });
      }
    } else if (status.startsWith('T')) {
      violations.push({
        type: 'type-changed',
        status,
        path: parts[1] ?? '',
      });
    } else {
      violations.push({
        type: 'unknown',
        status,
        path: parts[1] ?? '',
      });
    }
  }

  return violations;
}

function defaultExecGit(cmd: string): string {
  return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

/**
 * Resolves the base commit reference to compare against.
 *
 * Precedence:
 * 1. CI Pull Request: merge base of `origin/<GITHUB_BASE_REF>` and HEAD,
 *    falling back to the local `<GITHUB_BASE_REF>` branch.
 * 2. CI Push: `GITHUB_BEFORE` (a valid, non-zero commit SHA). After a push
 *    `origin/main` points at HEAD itself, so a merge-base against it is useless
 *    — if `GITHUB_BEFORE` cannot be resolved or is all-zeros (initial push)
 *    there is no valid base and the resolution degrades to `HEAD` for callers
 *    to fail closed on.
 * 3. Local development: merge base against `origin/main`, `main`,
 *    `origin/master`, or `master`.
 * 4. Fallback: `HEAD`. Callers running under CI must fail closed on this
 *    instead of comparing HEAD to HEAD — see `findMigrationViolations`.
 */
export function resolveBaseRef(
  env: Record<string, string | undefined> = process.env,
  execGit: (cmd: string) => string = defaultExecGit,
): string {
  // 1. CI Pull Request
  if (env.GITHUB_BASE_REF) {
    const baseBranch = env.GITHUB_BASE_REF;
    for (const cand of [`origin/${baseBranch}`, baseBranch]) {
      try {
        const mergeBase = execGit(`git merge-base ${cand} HEAD`).trim();
        if (mergeBase) return mergeBase;
      } catch {
        // try the next candidate
      }
    }
  }

  // 2. CI Push event with a previous commit SHA
  if (env.GITHUB_EVENT_NAME === 'push') {
    const before = env.GITHUB_BEFORE;
    if (before && !/^0+$/.test(before)) {
      try {
        const rev = execGit(`git rev-parse --verify ${before}^{commit}`).trim();
        if (rev) return rev;
      } catch {
        // GITHUB_BEFORE is unreachable: rewritten/force-pushed history, or a
        // shallow checkout that never fetched the previous commit.
      }
    }
    // GITHUB_BEFORE is the only valid base for a push: after a push origin/main
    // points at HEAD itself, so a merge-base against it resolves to HEAD and
    // would compare the diff against HEAD silently. Refuse to degrade; return
    // 'HEAD' and let callers running under CI fail closed.
    return 'HEAD';
  }

  // 3. Local development or fallback
  for (const cand of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      const mergeBase = execGit(`git merge-base ${cand} HEAD`).trim();
      if (mergeBase) return mergeBase;
    } catch {
      // try the next candidate
    }
  }

  return 'HEAD';
}

/**
 * Collects migration immutability violations in the given working directory.
 *
 * The git diff is scoped to `prisma/migrations/` and only paths ending in `.sql`
 * count as violations, so edits to Prisma-managed sidecars
 * (`migration_lock.toml`, per-migration README files) are not treated as
 * migration amendments. A rename counts if either side is a `.sql` path —
 * moving an applied `migration.sql` to another name is still flagged.
 *
 * When no `baseRef` is given, the base is resolved from the environment.
 * Under CI variables (`GITHUB_BASE_REF` / `GITHUB_EVENT_NAME`) a resolution
 * that degrades to `HEAD` throws instead of silently passing a comparison of
 * HEAD against itself. Outside CI the `HEAD` fallback is kept (it covers
 * uncommitted/staged edits) and a warning is printed.
 */
export function findMigrationViolations(
  options: {
    cwd?: string;
    baseRef?: string;
    env?: Record<string, string | undefined>;
    execGit?: (cmd: string) => string;
  } = {},
): MigrationViolation[] {
  const env = options.env ?? process.env;
  const exec =
    options.execGit ??
    ((cmd: string) =>
      execSync(cmd, {
        cwd: options.cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }));

  const base = options.baseRef ?? resolveBaseRef(env, exec);

  if (!options.baseRef && base === 'HEAD') {
    if (env.GITHUB_BASE_REF || env.GITHUB_EVENT_NAME) {
      throw new Error(
        'Cannot resolve a base ref to compare against in CI: the pull request merge base ' +
          'or the previous commit GITHUB_BEFORE is unavailable. Comparing HEAD to HEAD ' +
          'would report zero violations on any input — refusing to pass. Check that ' +
          'checkout fetches full history (fetch-depth: 0).',
      );
    }
    console.warn(
      'Warning: no upstream base ref (origin/main, main, origin/master, master) could be ' +
        'resolved; comparing migration files against HEAD. Only uncommitted/staged edits ' +
        'are covered — a stale local branch may miss committed changes to applied migrations.',
    );
  }

  const diffOutput = exec(`git diff --name-status ${base} -- prisma/migrations/`);

  return parseMigrationDiff(diffOutput).filter((v) =>
    v.type === 'renamed'
      ? isMigrationSqlPath(v.path) || isMigrationSqlPath(v.oldPath)
      : isMigrationSqlPath(v.path),
  );
}

function isMigrationSqlPath(path: string): boolean {
  return path.endsWith('.sql');
}
