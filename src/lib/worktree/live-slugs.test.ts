import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';
import { computeLiveWorktreeNames, listWorktreeAdminEntries } from './live-slugs';

describe('computeLiveWorktreeNames', () => {
  it('keeps only entries whose working directory still exists', () => {
    const result = computeLiveWorktreeNames([
      { rawName: 'fix-517', workingDirExists: true },
      { rawName: 'fix-520', workingDirExists: false },
    ]);
    expect(result).toEqual(new Set(['fix-517']));
  });

  it('returns an empty set for no entries', () => {
    expect(computeLiveWorktreeNames([])).toEqual(new Set());
  });

  it('keeps two admin-dir names that would have collided under the old sanitize-then-compare approach', () => {
    // fix-517 and fix_517 both sanitize to the same dbSlug — this is the
    // issue's own concrete example. Comparing raw names directly must
    // produce two distinct live entries, not one.
    const result = computeLiveWorktreeNames([
      { rawName: 'fix-517', workingDirExists: true },
      { rawName: 'fix_517', workingDirExists: true },
    ]);
    expect(result).toEqual(new Set(['fix-517', 'fix_517']));
    expect(result.size).toBe(2);
  });
});

describe('listWorktreeAdminEntries', () => {
  const gitCommonDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-live-slugs-test-'));

  afterEach(() => {
    fs.rmSync(gitCommonDir, { recursive: true, force: true });
    fs.mkdirSync(gitCommonDir, { recursive: true });
  });

  it('returns the raw admin-directory name, not a sanitized slug', () => {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-live-slugs-worktree-'));
    const adminDir = path.join(gitCommonDir, 'worktrees', 'my-worktree-name');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'gitdir'), path.join(worktreeRoot, '.git'));

    const entries = listWorktreeAdminEntries(gitCommonDir);

    expect(entries).toEqual([{ rawName: 'my-worktree-name', workingDirExists: true }]);

    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('lists two admin dirs whose names differ only by characters sanitizeSlug used to collapse', () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-live-slugs-worktree-'));
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-live-slugs-worktree-'));
    const adminDirA = path.join(gitCommonDir, 'worktrees', 'fix-517');
    const adminDirB = path.join(gitCommonDir, 'worktrees', 'fix_517');
    fs.mkdirSync(adminDirA, { recursive: true });
    fs.mkdirSync(adminDirB, { recursive: true });
    fs.writeFileSync(path.join(adminDirA, 'gitdir'), path.join(rootA, '.git'));
    fs.writeFileSync(path.join(adminDirB, 'gitdir'), path.join(rootB, '.git'));

    const entries = listWorktreeAdminEntries(gitCommonDir);

    expect(entries).toHaveLength(2);
    expect(entries).toEqual(
      expect.arrayContaining([
        { rawName: 'fix-517', workingDirExists: true },
        { rawName: 'fix_517', workingDirExists: true },
      ]),
    );

    fs.rmSync(rootA, { recursive: true, force: true });
    fs.rmSync(rootB, { recursive: true, force: true });
  });

  it('treats a non-ENOENT read error as still live, not orphaned', () => {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-live-slugs-worktree-'));
    const adminDir = path.join(gitCommonDir, 'worktrees', 'broken-worktree');
    fs.mkdirSync(adminDir, { recursive: true });
    // A directory where the gitdir file should be triggers EISDIR on
    // readFileSync — a real, non-ENOENT error class, not "worktree removed."
    fs.mkdirSync(path.join(adminDir, 'gitdir'));

    const entries = listWorktreeAdminEntries(gitCommonDir);

    expect(entries).toEqual([{ rawName: 'broken-worktree', workingDirExists: true }]);

    fs.rmSync(worktreeRoot, { recursive: true, force: true });
  });

  it('returns workingDirExists: false when the worktree directory was actually deleted', () => {
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-live-slugs-worktree-'));
    const adminDir = path.join(gitCommonDir, 'worktrees', 'gone-worktree');
    fs.mkdirSync(adminDir, { recursive: true });
    fs.writeFileSync(path.join(adminDir, 'gitdir'), path.join(worktreeRoot, '.git'));
    fs.rmSync(worktreeRoot, { recursive: true, force: true }); // delete it BEFORE calling

    const entries = listWorktreeAdminEntries(gitCommonDir);

    expect(entries).toEqual([{ rawName: 'gone-worktree', workingDirExists: false }]);
  });
});
