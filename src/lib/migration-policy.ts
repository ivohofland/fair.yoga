// src/lib/migration-policy.ts
import { execSync } from 'node:child_process';

export type MigrationViolationType =
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'type-changed'
  | 'unknown';

export interface MigrationViolation {
  type: MigrationViolationType;
  status: string;
  path: string;
  oldPath?: string;
}

/**
 * Parses the tab-delimited output of `git diff --name-status` and returns any
 * violations where an applied migration was modified, deleted, renamed, or had its type changed.
 *
 * New migrations (status 'A') are legitimate and ignored.
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
      violations.push({
        type: 'renamed',
        status,
        oldPath: parts[1] ?? '',
        path: parts[2] ?? '',
      });
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
 * 1. CI Pull Request: merge base of `origin/<GITHUB_BASE_REF>` and HEAD.
 * 2. CI Push: `GITHUB_BEFORE` (if valid SHA), else merge base against `origin/main` / `main`.
 * 3. Local development: merge base against `origin/main`, falling back to `main`, `origin/master`, `master`.
 * 4. Fallback: `HEAD`.
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
        // continue
      }
    }
  }

  // 2. CI Push event with a previous commit SHA
  if (env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_BEFORE) {
    const before = env.GITHUB_BEFORE;
    if (before && !/^0+$/.test(before)) {
      try {
        const rev = execGit(`git rev-parse --verify ${before}^{commit}`).trim();
        if (rev) return rev;
      } catch {
        // continue
      }
    }
  }

  // 3. Local development or fallback
  for (const cand of ['origin/main', 'main', 'origin/master', 'master']) {
    try {
      const mergeBase = execGit(`git merge-base ${cand} HEAD`).trim();
      if (mergeBase) return mergeBase;
    } catch {
      // continue
    }
  }

  return 'HEAD';
}

/**
 * Collects migration immutability violations in the given working directory.
 */
export function findMigrationViolations(
  options: {
    cwd?: string;
    baseRef?: string;
    env?: Record<string, string | undefined>;
    execGit?: (cmd: string) => string;
  } = {},
): MigrationViolation[] {
  const exec =
    options.execGit ??
    ((cmd: string) =>
      execSync(cmd, {
        cwd: options.cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }));

  const base = options.baseRef ?? resolveBaseRef(options.env ?? process.env, exec);

  const diffOutput = exec(
    `git diff --name-status --diff-filter=a ${base} -- prisma/migrations/`,
  );

  return parseMigrationDiff(diffOutput);
}
