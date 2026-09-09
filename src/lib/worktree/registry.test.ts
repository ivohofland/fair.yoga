import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  allocatePort,
  setPid,
  removeEntry,
  diffOrphans,
  getRegistryPath,
  readRegistry,
  writeRegistryLocked,
  acquireLock,
  releaseLock,
  isLockStale,
  isPidAlive,
  type Registry,
} from './registry';

describe('allocatePort', () => {
  it('allocates the lowest free port in range for a new rawName', () => {
    const { registry, port } = allocatePort({}, 'fix-517', 'fix_517', { min: 3100, max: 3102 });
    expect(port).toBe(3100);
    expect(registry).toEqual({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } });
  });

  it('skips ports already claimed by other entries', () => {
    const existing: Registry = { 'fix-520': { port: 3100, pid: null, dbSlug: 'fix_520' } };
    const { port } = allocatePort(existing, 'fix-517', 'fix_517', { min: 3100, max: 3102 });
    expect(port).toBe(3101);
  });

  it('returns the existing port unchanged when the rawName is already registered', () => {
    const existing: Registry = { 'fix-517': { port: 3100, pid: 999, dbSlug: 'fix_517' } };
    const { registry, port } = allocatePort(existing, 'fix-517', 'fix_517', { min: 3100, max: 3102 });
    expect(port).toBe(3100);
    expect(registry).toBe(existing);
  });

  it('ignores a mismatched dbSlug for an already-registered rawName — the stored dbSlug is authoritative', () => {
    const existing: Registry = { 'fix-517': { port: 3100, pid: 999, dbSlug: 'fix_517' } };
    const { registry, port } = allocatePort(existing, 'fix-517', 'some_other_slug', { min: 3100, max: 3102 });
    expect(port).toBe(3100);
    expect(registry).toBe(existing);
  });

  it('throws when the range is exhausted', () => {
    const existing: Registry = {
      a: { port: 3100, pid: null, dbSlug: 'a' },
      b: { port: 3101, pid: null, dbSlug: 'b' },
    };
    expect(() => allocatePort(existing, 'c', 'c', { min: 3100, max: 3101 })).toThrow();
  });

  it('throws on a dbSlug collision between two different rawName keys, naming both', () => {
    const existing: Registry = { 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } };
    expect(() => allocatePort(existing, 'fix_517', 'fix_517', { min: 3100, max: 3102 })).toThrow(
      /fix_517.*fix-517|fix-517.*fix_517/,
    );
  });
});

describe('setPid', () => {
  it('updates only the given key', () => {
    const existing: Registry = { 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } };
    expect(setPid(existing, 'fix-517', 4242)).toEqual({
      'fix-517': { port: 3100, pid: 4242, dbSlug: 'fix_517' },
    });
  });

  it('throws for an unregistered key', () => {
    expect(() => setPid({}, 'fix-517', 4242)).toThrow();
  });
});

describe('removeEntry', () => {
  it('removes only the given key', () => {
    const existing: Registry = {
      'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' },
      'fix-520': { port: 3101, pid: null, dbSlug: 'fix_520' },
    };
    expect(removeEntry(existing, 'fix-517')).toEqual({
      'fix-520': { port: 3101, pid: null, dbSlug: 'fix_520' },
    });
  });
});

describe('diffOrphans', () => {
  it('returns entries whose key is not live', () => {
    const existing: Registry = {
      'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' },
      'fix-520': { port: 3101, pid: 4242, dbSlug: 'fix_520' },
    };
    const result = diffOrphans(existing, new Set(['fix-517']));
    expect(result).toEqual([{ key: 'fix-520', entry: { port: 3101, pid: 4242, dbSlug: 'fix_520' } }]);
  });
});

describe('readRegistry / writeRegistryLocked', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-registry-test-'));
  const registryPath = path.join(dir, 'fairyoga-worktrees.json');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('reads an empty registry when the file does not exist', () => {
    expect(readRegistry(registryPath)).toEqual({});
  });

  it('throws on a corrupt (non-JSON) registry file rather than silently returning empty', () => {
    fs.writeFileSync(registryPath, 'not json');
    expect(() => readRegistry(registryPath)).toThrow();
  });

  it('throws when the registry file is valid JSON but not an object', () => {
    fs.writeFileSync(registryPath, '[]');
    expect(() => readRegistry(registryPath)).toThrow();
  });

  it('still returns {} when the file genuinely does not exist', () => {
    expect(readRegistry(path.join(dir, 'does-not-exist.json'))).toEqual({});
  });

  it('backfills dbSlug: key for a pre-migration entry parsed with no dbSlug field', () => {
    fs.writeFileSync(registryPath, JSON.stringify({ fix_517: { port: 3100, pid: null } }));
    expect(readRegistry(registryPath)).toEqual({ fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' } });
  });

  it('leaves an entry that already has dbSlug untouched (not overwritten with the key)', () => {
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } }),
    );
    expect(readRegistry(registryPath)).toEqual({
      'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' },
    });
  });

  it('throws on an entry with a missing port rather than returning a plausible-looking-but-invalid entry', () => {
    fs.writeFileSync(registryPath, JSON.stringify({ fix_517: { pid: null } }));
    expect(() => readRegistry(registryPath)).toThrow(/fix_517/);
  });

  it('throws on an entry with a non-number pid rather than returning a plausible-looking-but-invalid entry', () => {
    fs.writeFileSync(registryPath, JSON.stringify({ fix_517: { port: 3100, pid: 'not-a-number' } }));
    expect(() => readRegistry(registryPath)).toThrow(/fix_517/);
  });

  it('writes what the mutate function returns and persists it', async () => {
    await writeRegistryLocked(registryPath, () => ({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } }));
    expect(readRegistry(registryPath)).toEqual({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } });
  });

  it('supports an async mutate function', async () => {
    await writeRegistryLocked(registryPath, async (registry) => {
      await Promise.resolve();
      return { ...registry, 'fix-520': { port: 3101, pid: null, dbSlug: 'fix_520' } };
    });
    expect(readRegistry(registryPath)).toEqual({ 'fix-520': { port: 3101, pid: null, dbSlug: 'fix_520' } });
  });

  it('writes atomically — no leftover temp file after a successful write', async () => {
    await writeRegistryLocked(registryPath, () => ({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } }));
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

describe('getRegistryPath', () => {
  it('names the registry file inside the given git-common-dir', () => {
    expect(getRegistryPath('/repo/.git')).toBe(path.join('/repo/.git', 'fairyoga-worktrees.json'));
  });
});

describe('isPidAlive', () => {
  it('returns true for the current process pid', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });

  it('returns false for a pid that does not exist', () => {
    expect(isPidAlive(999999)).toBe(false);
  });

  it('returns false for non-positive or non-integer pids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });
});

describe('isLockStale', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-stale-test-'));
  const lockDir = path.join(dir, 'test.lock');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('returns false if the lock directory does not exist', () => {
    expect(isLockStale(path.join(dir, 'nonexistent.lock'), 60_000)).toEqual({ stale: false });
  });

  it('detects a lock as stale when the holder pid is dead', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() }));
    const result = isLockStale(lockDir, 60_000);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain('holder pid 999999 is not alive');
  });

  it('detects a lock as NOT stale when the holder pid is alive and within threshold', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    expect(isLockStale(lockDir, 60_000)).toEqual({ stale: false });
  });

  it('detects a lock as stale when its age exceeds staleMs even if holder pid is alive', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 120_000 }),
    );
    const result = isLockStale(lockDir, 60_000);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain('exceeded threshold');
  });

  it('detects an empty or corrupt lock directory as stale when directory mtime exceeds staleMs', () => {
    fs.mkdirSync(lockDir);
    // Set mtime to 2 minutes ago
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, twoMinutesAgo, twoMinutesAgo);

    const result = isLockStale(lockDir, 60_000);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain('exceeded threshold');
  });

  it('detects an empty lock directory as not stale when directory mtime is recent', () => {
    fs.mkdirSync(lockDir);
    expect(isLockStale(lockDir, 60_000)).toEqual({ stale: false });
  });
});

describe('acquireLock / releaseLock staleness recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-lock-test-'));
  const lockDir = path.join(dir, 'test.lock');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('writes owner.json on acquire and cleans it up on release', () => {
    acquireLock(lockDir);
    expect(fs.existsSync(lockDir)).toBe(true);
    const ownerPath = path.join(lockDir, 'owner.json');
    expect(fs.existsSync(ownerPath)).toBe(true);
    const info = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    expect(info.pid).toBe(process.pid);
    expect(typeof info.createdAt).toBe('number');

    releaseLock(lockDir);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('automatically reclaims a stale lock left by a dead process', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() }));

    // Retries 2 times with 5ms delay
    acquireLock(lockDir, { retries: 2, delayMs: 5 });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[registry] reclaiming stale lock'));
    expect(fs.existsSync(lockDir)).toBe(true);
    const ownerPath = path.join(lockDir, 'owner.json');
    const info = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    expect(info.pid).toBe(process.pid);

    releaseLock(lockDir);
    warnSpy.mockRestore();
  });

  it('automatically reclaims a lock whose age exceeds staleMs', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 100_000 }),
    );

    acquireLock(lockDir, { retries: 2, delayMs: 5, staleMs: 50 });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[registry] reclaiming stale lock'));
    releaseLock(lockDir);
    warnSpy.mockRestore();
  });

  it('throws timeout error and does not reclaim lock if held by a live process under staleMs', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    expect(() => acquireLock(lockDir, { retries: 2, delayMs: 5, staleMs: 60_000 })).toThrow(
      /Timed out waiting for lock/,
    );
    // Original lock directory remains intact
    expect(fs.existsSync(lockDir)).toBe(true);

    releaseLock(lockDir);
  });

  it('releaseLock does not delete lock directory if it was reclaimed by another process', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() }));

    // Call releaseLock with expectedPid = process.pid, but owner.json has pid 999999
    releaseLock(lockDir, process.pid);

    // Lock must not have been removed because expectedPid does not match owner.json
    expect(fs.existsSync(lockDir)).toBe(true);

    // Unconditional release (no expectedPid) cleans it up
    releaseLock(lockDir);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('writeRegistryLocked self-heals when a dead process lock exists', async () => {
    const registryPath = path.join(dir, 'fairyoga-worktrees.json');
    const lockPath = `${registryPath}.lock`;
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 999999, createdAt: Date.now() }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await writeRegistryLocked(
      registryPath,
      (current) => ({ ...current, healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' } }),
      { retries: 2, delayMs: 5 },
    );

    expect(result).toEqual({ healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' } });
    expect(readRegistry(registryPath)).toEqual({ healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' } });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[registry] reclaiming stale lock'));
    warnSpy.mockRestore();
  });
});

