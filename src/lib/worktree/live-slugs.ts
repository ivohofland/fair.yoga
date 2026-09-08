import fs from 'fs';
import path from 'path';

export interface WorktreeAdminEntry {
  slug: string;
  workingDirExists: boolean;
}

/** Pure — given what's on disk, decides which slugs are still live. */
export function computeLiveSlugs(entries: WorktreeAdminEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.workingDirExists).map((entry) => entry.slug));
}

/**
 * Git keeps one directory per linked worktree at `<gitCommonDir>/worktrees/<slug>/`,
 * each holding a `gitdir` file pointing at that worktree's `.git` file. If the
 * worktree's own directory was deleted without `git worktree remove`, that
 * target no longer exists — the same staleness check `git worktree prune` uses.
 */
export function listWorktreeAdminEntries(gitCommonDir: string): WorktreeAdminEntry[] {
  const worktreesDir = path.join(gitCommonDir, 'worktrees');
  if (!fs.existsSync(worktreesDir)) {
    return [];
  }
  return fs.readdirSync(worktreesDir).map((slug) => {
    const gitdirFile = path.join(worktreesDir, slug, 'gitdir');
    let workingDirExists = false;
    try {
      const target = fs.readFileSync(gitdirFile, 'utf8').trim();
      workingDirExists = fs.existsSync(path.dirname(target));
    } catch {
      workingDirExists = false;
    }
    return { slug, workingDirExists };
  });
}

export function getLiveSlugs(gitCommonDir: string): Set<string> {
  return computeLiveSlugs(listWorktreeAdminEntries(gitCommonDir));
}
