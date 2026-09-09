import fs from 'fs';
import path from 'path';
import type { RawName } from './identity';

export interface WorktreeAdminEntry {
  rawName: RawName;
  workingDirExists: boolean;
}

/** Pure — given what's on disk, decides which raw worktree names are still live. */
export function computeLiveWorktreeNames(entries: WorktreeAdminEntry[]): Set<RawName> {
  return new Set(entries.filter((entry) => entry.workingDirExists).map((entry) => entry.rawName));
}

/**
 * Git keeps one directory per linked worktree at `<gitCommonDir>/worktrees/<name>/`,
 * each holding a `gitdir` file pointing at that worktree's `.git` file. If the
 * worktree's own directory was deleted without `git worktree remove`, that
 * target no longer exists — the same staleness check `git worktree prune` uses.
 * The raw directory name is what identity.ts's resolveIdentity computes as
 * rawName for that worktree — see
 * docs/superpowers/specs/2026-09-09-worktree-registry-key-collision-design.md
 * §3 for why the two are guaranteed equal.
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
    // rawName here is the directory name read directly off disk under
    // <gitCommonDir>/worktrees/ — the same value identity.ts's resolveIdentity
    // computes as RawName for that worktree (docblock above).
    return { rawName: rawName as RawName, workingDirExists };
  });
}

export function getLiveWorktreeNames(gitCommonDir: string): Set<RawName> {
  return computeLiveWorktreeNames(listWorktreeAdminEntries(gitCommonDir));
}
