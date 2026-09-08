import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { computeLiveSlugs, listWorktreeAdminEntries } from './live-slugs';

describe('computeLiveSlugs', () => {
  it('keeps only entries whose working directory still exists', () => {
    const result = computeLiveSlugs([
      { slug: 'fix_517', workingDirExists: true },
      { slug: 'fix_520', workingDirExists: false },
    ]);
    expect(result).toEqual(new Set(['fix_517']));
  });

  it('returns an empty set for no entries', () => {
    expect(computeLiveSlugs([])).toEqual(new Set());
  });
});

describe('listWorktreeAdminEntries', () => {
  const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-live-slugs-test-'));

  afterEach(() => {
    fs.rmSync(gitCommonDir, { recursive: true, force: true });
    fs.mkdirSync(gitCommonDir, { recursive: true });
  });

  it('returns the sanitized slug, not the raw admin-directory name', () => {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-live-slugs-worktree-'));
    const adminDir = path.join(gitCommonDir, 'worktrees', 'my-worktree-name');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'gitdir'), path.join(worktreeRoot, '.git'));

    const entries = listWorktreeAdminEntries(gitCommonDir);

    expect(entries).toEqual([{ slug: 'my_worktree_name', workingDirExists: true }]);

    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });
});
