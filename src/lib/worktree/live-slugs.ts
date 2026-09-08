import fs from 'fs';
import path from 'path';
import { sanitizeSlug } from './identity';

export interface WorktreeAdminEntry {
  slug: string;
  workingDirExists: boolean;
}

/** Pure — given what's on disk, decides which slugs are still live. */
export function computeLiveSlugs(entries: WorktreeAdminEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.workingDirExists).map((entry) => entry.slug));
}

/**
 * Git keeps one directory per linked worktree at `<gitCommonDir>/worktrees/<name>/`,
 * each holding a `gitdir` file pointing at that worktree's `.git` file. If the
 * worktree's own directory was deleted without `git worktree remove`, that
 * target no longer exists — the same staleness check `git worktree prune` uses.
 * The raw directory name is sanitized the same way `identity.ts` sanitizes a
 * worktree's own slug, so the result compares equal to registry keys.
 */
export function listWorktreeAdminEntries(gitCommonDir: string): WorktreeAdminEntry[] {
  const worktreesDir = path.join(gitCommonDir, 'worktrees');
  if (!fs.existsSync(worktreesDir)) {
    return [];
  }
  return fs.readdirSync(worktreesDir).flatMap((rawName) => {
    let slug: string;
    try {
      slug = sanitizeSlug(rawName);
    } catch {
      // A raw admin-dir name with no safe characters could never have been
      // registered under a matching key either — nothing to report for it.
      return [];
    }

    let workingDirExists = true;
    try {
      const gitdirFile = path.join(worktreesDir, rawName, 'gitdir');
      const target = fs.readFileSync(gitdirFile, 'utf8').trim();
      workingDirExists = fs.existsSync(path.dirname(target));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        workingDirExists = false;
      }
      // any other error: treat the worktree as still live rather than
      // reclassifying it as an orphan to destroy.
    }
    return [{ slug, workingDirExists }];
  });
}

export function getLiveSlugs(gitCommonDir: string): Set<string> {
  return computeLiveSlugs(listWorktreeAdminEntries(gitCommonDir));
}
