import { execSync } from 'child_process';
import path from 'path';

const MAX_SLUG_LENGTH = 40;

declare const rawNameBrand: unique symbol;
declare const dbSlugBrand: unique symbol;

/** Git's own admin-dir basename — unique by git's own construction (see
 *  WorktreeIdentity.rawName's docblock). Obtained only from resolveIdentity. */
export type RawName = string & { readonly [rawNameBrand]: true };
/** sanitizeSlug(rawName) — Postgres-identifier-safe, not guaranteed unique.
 *  Obtained only from resolveIdentity or a caller that reasons explicitly
 *  about the rawName/dbSlug distinction. */
export type DbSlug = string & { readonly [dbSlugBrand]: true };

export function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) {
    throw new Error(`sanitizeSlug: "${raw}" produced an empty slug`);
  }
  return cleaned.slice(0, MAX_SLUG_LENGTH);
}

export interface DatabaseNames {
  test: string;
  dev: string;
}

export function dbNamesForSlug(slug: DbSlug): DatabaseNames {
  return {
    test: `ethical_yoga_test_${slug}`,
    dev: `ethical_yoga_dev_${slug}`,
  };
}

/**
 * True only for the shared `ethical_yoga_test` or a per-worktree
 * `ethical_yoga_test_<slug>` — anchored at both ends, so a name merely
 * ending in `_test` or `_test_<slug>` (e.g. a dev database whose slug
 * contains "test") does not match.
 */
export function isTestDatabaseName(name: string): boolean {
  return /^ethical_yoga_test(_[a-z0-9_]+)?$/.test(name);
}

export interface WorktreeIdentity {
  isMainCheckout: boolean;
  /**
   * Git's own admin-dir basename — empirically verified unique on creation;
   * see docs/superpowers/specs/2026-09-09-worktree-registry-key-collision-design.md §1.
   */
  rawName: RawName | null;
  /** sanitizeSlug(rawName) — Postgres-identifier-safe, not guaranteed unique. */
  dbSlug: DbSlug | null;
  gitCommonDir: string;
}

function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, '');
}

function basename(dir: string): string {
  const parts = normalizeDir(dir).split('/');
  const last = parts.pop();
  return last ?? dir;
}

/** Pure — decides identity from git's own output. */
export function resolveIdentity(gitDir: string, gitCommonDir: string): WorktreeIdentity {
  const isMainCheckout = normalizeDir(gitDir) === normalizeDir(gitCommonDir);
  const rawName = isMainCheckout ? null : (basename(gitDir) as RawName);
  let dbSlug: DbSlug | null = null;
  if (rawName !== null) {
    try {
      dbSlug = sanitizeSlug(rawName) as DbSlug;
    } catch (err) {
      throw new Error(
        `resolveIdentity: worktree admin-dir name "${rawName}" cannot be turned into a database slug ` +
          `(${(err as Error).message}) — rename this worktree's directory to include at least one of [a-z0-9_]`,
      );
    }
  }
  return {
    isMainCheckout,
    rawName,
    dbSlug,
    gitCommonDir: normalizeDir(gitCommonDir),
  };
}

/** Shells out to git. Not unit tested directly — resolveIdentity carries the logic. */
export function getWorktreeIdentity(cwd: string = process.cwd()): WorktreeIdentity {
  const gitDir = execSync('git rev-parse --git-dir', { cwd, encoding: 'utf8' }).trim();
  const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf8' }).trim();
  return resolveIdentity(path.resolve(cwd, gitDir), path.resolve(cwd, gitCommonDir));
}
