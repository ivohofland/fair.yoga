import { describe, it, expect, vi } from 'vitest';
import { reapOrphans } from './reap';
import type { Registry } from './registry';

describe('reapOrphans', () => {
  it('kills the pid, drops both databases, and removes the entry for each orphan', async () => {
    const registry: Registry = {
      fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' },
      fix_520: { port: 3101, pid: 4242, dbSlug: 'fix_520' },
    };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    const result = await reapOrphans(registry, new Set(['fix_517']), { dropDatabase, killPid });

    expect(result.reaped).toEqual(['fix_520']);
    expect(result.registry).toEqual({ fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' } });
    expect(result.migrated).toEqual([]);
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(killPid).toHaveBeenCalledWith(4242);
    expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_test_fix_520');
    expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_dev_fix_520');
    expect(dropDatabase).toHaveBeenCalledTimes(2);
  });

  it('does not call killPid for an orphan with no recorded pid', async () => {
    const registry: Registry = { fix_520: { port: 3101, pid: null, dbSlug: 'fix_520' } };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    await reapOrphans(registry, new Set(), { dropDatabase, killPid });

    expect(killPid).not.toHaveBeenCalled();
  });

  it('leaves a live rawName-keyed row untouched', async () => {
    const registry: Registry = { 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    const result = await reapOrphans(registry, new Set(['fix-517']), { dropDatabase, killPid });

    expect(result.reaped).toEqual([]);
    expect(result.migrated).toEqual([]);
    expect(result.registry).toEqual(registry);
    expect(dropDatabase).not.toHaveBeenCalled();
    expect(killPid).not.toHaveBeenCalled();
  });

  it("does not let one orphan's failure prevent a later orphan in the same call from being reaped", async () => {
    const registry: Registry = {
      fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' },
      fix_520: { port: 3101, pid: null, dbSlug: 'fix_520' },
    };
    const dropDatabase = vi.fn().mockImplementation((dbName: string) => {
      if (dbName.includes('fix_517')) {
        return Promise.reject(new Error('simulated drop failure'));
      }
      return Promise.resolve();
    });
    const killPid = vi.fn();

    const result = await reapOrphans(registry, new Set(), { dropDatabase, killPid });

    expect(result.reaped).toEqual(['fix_520']);
    expect(result.registry).toEqual({ fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' } });
  });

  describe('migration awareness', () => {
    it('rekeys a legacy row (key equals its own dbSlug) to the live raw name whose sanitizeSlug output matches that key', async () => {
      // "fix_517" is the pre-migration key/dbSlug for a worktree whose real
      // admin-dir name is "fix-517" (sanitizeSlug('fix-517') === 'fix_517').
      const registry: Registry = { fix_517: { port: 3100, pid: 4242, dbSlug: 'fix_517' } };
      const dropDatabase = vi.fn().mockResolvedValue(undefined);
      const killPid = vi.fn();

      const result = await reapOrphans(registry, new Set(['fix-517']), { dropDatabase, killPid });

      expect(result.registry).toEqual({ 'fix-517': { port: 3100, pid: 4242, dbSlug: 'fix_517' } });
      expect(result.migrated).toEqual([{ from: 'fix_517', to: 'fix-517' }]);
      expect(result.reaped).toEqual([]);
      expect(killPid).not.toHaveBeenCalled();
      expect(dropDatabase).not.toHaveBeenCalled();
    });

    it("silently drops a legacy row when the target raw name already has its own entry", async () => {
      const registry: Registry = {
        // Stale leftover from "fix-517"'s own earlier self-migration.
        fix_517: { port: 3100, pid: 4242, dbSlug: 'fix_517' },
        // "fix-517" already re-registered itself under its true rawName key.
        'fix-517': { port: 3105, pid: 555, dbSlug: 'fix_517' },
      };
      const dropDatabase = vi.fn().mockResolvedValue(undefined);
      const killPid = vi.fn();

      const result = await reapOrphans(registry, new Set(['fix-517']), { dropDatabase, killPid });

      expect(result.registry).toEqual({ 'fix-517': { port: 3105, pid: 555, dbSlug: 'fix_517' } });
      expect(result.migrated).toEqual([]);
      expect(result.reaped).toEqual([]);
      expect(killPid).not.toHaveBeenCalled();
      expect(dropDatabase).not.toHaveBeenCalled();
    });

    it('still reaps (kill + drop + remove) a legacy row with no live claimant', async () => {
      const registry: Registry = { fix_517: { port: 3100, pid: 4242, dbSlug: 'fix_517' } };
      const dropDatabase = vi.fn().mockResolvedValue(undefined);
      const killPid = vi.fn();

      // No live raw name sanitizes to "fix_517".
      const result = await reapOrphans(registry, new Set(['some-other-worktree']), { dropDatabase, killPid });

      expect(result.registry).toEqual({});
      expect(result.reaped).toEqual(['fix_517']);
      expect(result.migrated).toEqual([]);
      expect(killPid).toHaveBeenCalledWith(4242);
      expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_test_fix_517');
      expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_dev_fix_517');
    });

    it('still reaps a rawName-keyed (non-legacy-shaped) dead row with no live claimant', async () => {
      const registry: Registry = { 'fix-517': { port: 3100, pid: 4242, dbSlug: 'fix_517' } };
      const dropDatabase = vi.fn().mockResolvedValue(undefined);
      const killPid = vi.fn();

      const result = await reapOrphans(registry, new Set(), { dropDatabase, killPid });

      expect(result.registry).toEqual({});
      expect(result.reaped).toEqual(['fix-517']);
      expect(result.migrated).toEqual([]);
      expect(killPid).toHaveBeenCalledWith(4242);
      expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_test_fix_517');
      expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_dev_fix_517');
    });

    it('reaps, not rescues, a rawName-keyed dead row whose dbSlug happens to collide with a different live entry\'s dbSlug (mutation check for the key === entry.dbSlug gate)', async () => {
      // "old-name" is dead and rawName-keyed (its key "old-name" is NOT its
      // own dbSlug), but its dbSlug field happens to equal "live-name"'s
      // dbSlug — a pre-existing dbSlug collision the allocatePort guard
      // cannot retroactively fix (see spec Non-goals). Because
      // key !== entry.dbSlug for "old-name", the legacy-rescue branch must
      // never fire for it: it has to be reaped outright, not silently
      // dropped as if it were a stale leftover of "live-name"'s own
      // migration. Removing the `key === entry.dbSlug` gate — and looking up
      // the rescue target by entry.dbSlug instead — makes this row match
      // "live-name" (which already has its own row) and get silently
      // dropped with no killPid/dropDatabase call, which is what this test
      // catches.
      // "live-worktree" is live and legitimately owns dbSlug "live_worktree"
      // (sanitizeSlug('live-worktree') === 'live_worktree'). "old-name" is
      // dead and rawName-keyed, but its dbSlug field happens to equal that
      // same "live_worktree" value.
      const registry: Registry = {
        'old-name': { port: 3100, pid: 4242, dbSlug: 'live_worktree' },
        'live-worktree': { port: 3200, pid: 111, dbSlug: 'live_worktree' },
      };
      const dropDatabase = vi.fn().mockResolvedValue(undefined);
      const killPid = vi.fn();

      const result = await reapOrphans(registry, new Set(['live-worktree']), { dropDatabase, killPid });

      expect(result.reaped).toEqual(['old-name']);
      expect(result.migrated).toEqual([]);
      expect(result.registry).toEqual({ 'live-worktree': { port: 3200, pid: 111, dbSlug: 'live_worktree' } });
      expect(killPid).toHaveBeenCalledWith(4242);
      expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_test_live_worktree');
      expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_dev_live_worktree');
    });
  });
});
