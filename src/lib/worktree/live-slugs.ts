import fs from 'fs';
import path from 'path';

export interface WorktreeAdminEntry {
  rawName: string;
  workingDirExists: boolean;
}

/** Pure — given what's on disk, decides which raw worktree names are still live. */
export function computeLiveWorktreeNames(entries: WorktreeAdminEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.workingDirExists).map((entry) => entry.rawName));
}

/**
 * Git keeps one directory per linked worktree at `<gitCommonDir>/worktrees/<name>/`,
 * each holding a `gitdir` file pointing at that worktree's `.git` file. If the
 * worktree's own directory was deleted without `git worktree remove`, that
 * target no longer exists — the same staleness check `git worktree prune` uses.
 * The raw directory name IS the value `identity.ts` computes as `rawName` from
 * inside that same worktree, so no sanitizing is needed (or performed) here.
 */
export function listWorktreeAdminEntries(gitCommonDir: string): WorktreeAdminEntry[] {
  const worktreesDir = path.join(gitCommonDir, 'worktrees');
  if (!fs.existsSync(worktreesDir)) {
    return [];
  }
  return fs.readdirSync(worktreesDir).map((rawName) => {
    let workingDirExists = true;
    try {
      const gitdirFile = path.join(worktreesDir, rawName, 'gitdir');
      const target = fs.readFileSync(gitdirFile, 'utf8').trim();
      workingDirExists = fs.existsSync(path.dirname(target));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        workingDirExists = false;
      } else {
        console.warn(`[live-slugs] could not read gitdir for "${rawName}" (${(err as NodeJS.ErrnoException).code ?? err}) — treating as still live rather than reaping it`);
      }
    }
    return { rawName, workingDirExists };
  });
}

export function getLiveWorktreeNames(gitCommonDir: string): Set<string> {
  return computeLiveWorktreeNames(listWorktreeAdminEntries(gitCommonDir));
}
