import { describe, it, expect, afterEach, vi } from 'vitest';
import child_process from 'child_process';
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
  writeRegistryLockedOrExplain,
  acquireLock,
  ACQUIRE_LOCK_MAX_UNKNOWN_PASSES,
  ACQUIRE_LOCK_MAX_RECLAIM_FAILURES,
  releaseLock,
  isLockStale,
  isPidAlive,
  isBenignReclaimRaceError,
  readLockInfo,
  assertLockHeld,
  RegistryCollisionError,
  explainCollision,
  type Registry,
} from './registry';
import type { RawName, DbSlug } from './identity';

describe('allocatePort', () => {
  it('allocates the lowest free port in range for a new rawName', () => {
    const { registry, port } = allocatePort({}, 'fix-517' as RawName, 'fix_517' as DbSlug, { min: 3100, max: 3102 });
    expect(port).toBe(3100);
    expect(registry).toEqual({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } });
  });

  it('skips ports already claimed by other entries', () => {
    const existing: Registry = { 'fix-520': { port: 3100, pid: null, dbSlug: 'fix_520' as DbSlug } };
    const { port } = allocatePort(existing, 'fix-517' as RawName, 'fix_517' as DbSlug, { min: 3100, max: 3102 });
    expect(port).toBe(3101);
  });

  it('returns the existing port unchanged when the rawName is already registered', () => {
    const existing: Registry = { 'fix-517': { port: 3100, pid: 999, dbSlug: 'fix_517' as DbSlug } };
    const { registry, port } = allocatePort(existing, 'fix-517' as RawName, 'fix_517' as DbSlug, { min: 3100, max: 3102 });
    expect(port).toBe(3100);
    expect(registry).toBe(existing);
  });

  it('ignores a mismatched dbSlug for an already-registered rawName — the stored dbSlug is authoritative', () => {
    const existing: Registry = { 'fix-517': { port: 3100, pid: 999, dbSlug: 'fix_517' as DbSlug } };
    const { registry, port } = allocatePort(existing, 'fix-517' as RawName, 'some_other_slug' as DbSlug, { min: 3100, max: 3102 });
    expect(port).toBe(3100);
    expect(registry).toBe(existing);
  });

  it('throws when the range is exhausted', () => {
    const existing: Registry = {
      a: { port: 3100, pid: null, dbSlug: 'a' as DbSlug },
      b: { port: 3101, pid: null, dbSlug: 'b' as DbSlug },
    };
    expect(() => allocatePort(existing, 'c' as RawName, 'c' as DbSlug, { min: 3100, max: 3101 })).toThrow();
  });

  it('throws a RegistryCollisionError on a dbSlug collision between two different rawName keys, naming both', () => {
    const existing: Registry = { 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug } };
    let thrown: unknown;
    try {
      allocatePort(existing, 'fix_517' as RawName, 'fix_517' as DbSlug, { min: 3100, max: 3102 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RegistryCollisionError);
    const err = thrown as RegistryCollisionError;
    expect(err.rawName).toBe('fix_517');
    expect(err.dbSlug).toBe('fix_517');
    expect(err.collidingKey).toBe('fix-517');
    expect(err.collidingKeyIsLegacyShaped).toBe(false);
    expect(err.message).toMatch(/fix_517.*fix-517|fix-517.*fix_517/);
  });

  it('flags collidingKeyIsLegacyShaped when the colliding row is legacy-shaped (its key equals its own dbSlug)', () => {
    const existing: Registry = { fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug } };
    let thrown: unknown;
    try {
      allocatePort(existing, 'fix-517' as RawName, 'fix_517' as DbSlug, { min: 3100, max: 3102 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(RegistryCollisionError);
    expect((thrown as RegistryCollisionError).collidingKeyIsLegacyShaped).toBe(true);
  });
});

describe('explainCollision', () => {
  it('returns the original error unchanged when reap did not fail', () => {
    const err = new RegistryCollisionError('fix-517' as RawName, 'fix_517' as DbSlug, 'fix_517');
    expect(explainCollision(err, false)).toBe(err);
  });

  it('returns the original error unchanged when the colliding key is not legacy-shaped, even if reap failed', () => {
    const err = new RegistryCollisionError('fix_517' as RawName, 'fix_517' as DbSlug, 'fix-517');
    expect(err.collidingKeyIsLegacyShaped).toBe(false);
    expect(explainCollision(err, true)).toBe(err);
  });

  it('enriches the message when reap failed and the colliding key is legacy-shaped', () => {
    const err = new RegistryCollisionError('fix-517' as RawName, 'fix_517' as DbSlug, 'fix_517');
    expect(err.collidingKeyIsLegacyShaped).toBe(true);
    const result = explainCollision(err, true);
    expect(result).not.toBe(err);
    expect(result.message).toContain(err.message);
    expect(result.message).toMatch(/reap\/migration sweep failed/);
    expect(result.message).toMatch(/own not-yet-migrated legacy registry entry/);
  });

  it('returns the original error unchanged when reap succeeded and the collision is not legacy-shaped', () => {
    const err = new RegistryCollisionError('fix-517' as RawName, 'fix_520' as DbSlug, 'fix-520');
    expect(explainCollision(err, false)).toBe(err);
  });
});

describe('writeRegistryLockedOrExplain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-registry-test-'));
  const registryPath = path.join(dir, 'fairyoga-worktrees.json');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('returns the mutate result and persists the mutated registry when there is no collision', async () => {
    const result = await writeRegistryLockedOrExplain(registryPath, false, (registry) => ({
      registry: { ...registry, 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug } },
      result: 3100,
    }));
    expect(result).toBe(3100);
    expect(readRegistry(registryPath)).toEqual({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } });
  });

  it('rethrows the original RegistryCollisionError unchanged when reapFailed is false', async () => {
    const err = new RegistryCollisionError('fix_517' as RawName, 'fix_517' as DbSlug, 'fix-517');
    let thrown: unknown;
    try {
      await writeRegistryLockedOrExplain(registryPath, false, () => {
        throw err;
      });
    } catch (caught) {
      thrown = caught;
    }
    expect(thrown).toBe(err);
  });

  it('rethrows the explainCollision-enriched error when reapFailed is true and the colliding key is legacy-shaped', async () => {
    fs.writeFileSync(registryPath, JSON.stringify({ fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' } }));
    let thrown: unknown;
    try {
      await writeRegistryLockedOrExplain(registryPath, true, (registry) => {
        const result = allocatePort(registry, 'fix-517' as RawName, 'fix_517' as DbSlug);
        return { registry: result.registry, result: result.port };
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).not.toBeInstanceOf(RegistryCollisionError);
    const err = thrown as Error & { cause?: unknown };
    expect(err.message).toMatch(/reap\/migration sweep failed/);
    expect(err.cause).toBeInstanceOf(RegistryCollisionError);
  });

  it('propagates a non-collision error thrown from mutate unchanged, even when reapFailed is true and it happens to carry a truthy collidingKeyIsLegacyShaped', async () => {
    // collidingKeyIsLegacyShaped: true + reapFailed: true is the one
    // combination where explainCollision (see its own condition in
    // registry.ts) treats a non-RegistryCollisionError object differently
    // from an unchanged pass-through — so this shape is what actually
    // distinguishes "the instanceof gate ran" from "explainCollision merely
    // declined to enrich this error": a plain Error() would come back
    // unchanged either way, hiding a dropped instanceof check.
    const plainError = Object.assign(new Error('mutate blew up'), { collidingKeyIsLegacyShaped: true });
    let thrown: unknown;
    try {
      await writeRegistryLockedOrExplain(registryPath, true, () => {
        throw plainError;
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(plainError);
  });
});

describe('setPid', () => {
  it('updates only the given key', () => {
    const existing: Registry = { 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug } };
    expect(setPid(existing, 'fix-517' as RawName, 4242)).toEqual({
      'fix-517': { port: 3100, pid: 4242, dbSlug: 'fix_517' },
    });
  });

  it('throws for an unregistered key', () => {
    expect(() => setPid({}, 'fix-517' as RawName, 4242)).toThrow();
  });
});

describe('removeEntry', () => {
  it('removes only the given key', () => {
    const existing: Registry = {
      'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug },
      'fix-520': { port: 3101, pid: null, dbSlug: 'fix_520' as DbSlug },
    };
    expect(removeEntry(existing, 'fix-517')).toEqual({
      'fix-520': { port: 3101, pid: null, dbSlug: 'fix_520' },
    });
  });
});

describe('diffOrphans', () => {
  it('returns entries whose key is not live', () => {
    const existing: Registry = {
      'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug },
      'fix-520': { port: 3101, pid: 4242, dbSlug: 'fix_520' as DbSlug },
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
    await writeRegistryLocked(registryPath, () => ({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug } }));
    expect(readRegistry(registryPath)).toEqual({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } });
  });

  it('supports an async mutate function', async () => {
    await writeRegistryLocked(registryPath, async (registry) => {
      await Promise.resolve();
      return { ...registry, 'fix-520': { port: 3101, pid: null, dbSlug: 'fix_520' as DbSlug } };
    });
    expect(readRegistry(registryPath)).toEqual({ 'fix-520': { port: 3101, pid: null, dbSlug: 'fix_520' } });
  });

  it('writes atomically — no leftover temp file after a successful write', async () => {
    await writeRegistryLocked(registryPath, () => ({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug } }));
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

  it('returns false for a confirmed dead pid (ESRCH)', () => {
    expect(isPidAlive(2147483647)).toBe(false);
  });

  it('returns false for non-positive or non-integer pids', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(1.5)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });

  it('returns true when process.kill throws EPERM', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    try {
      expect(isPidAlive(12345)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('assumes alive when process.kill throws an unrecognized error code', () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('io error') as NodeJS.ErrnoException;
      err.code = 'EIO';
      throw err;
    });
    try {
      expect(isPidAlive(12345)).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });
});

describe('isBenignReclaimRaceError', () => {
  it('returns true for ENOENT', () => {
    const err = new Error('no such file or directory') as NodeJS.ErrnoException;
    err.code = 'ENOENT';
    expect(isBenignReclaimRaceError(err)).toBe(true);
  });

  it('returns true for ENOTDIR', () => {
    const err = new Error('not a directory') as NodeJS.ErrnoException;
    err.code = 'ENOTDIR';
    expect(isBenignReclaimRaceError(err)).toBe(true);
  });

  it('returns false for EPERM', () => {
    const err = new Error('operation not permitted') as NodeJS.ErrnoException;
    err.code = 'EPERM';
    expect(isBenignReclaimRaceError(err)).toBe(false);
  });

  it('returns false for undefined (no error)', () => {
    expect(isBenignReclaimRaceError(undefined)).toBe(false);
  });

  it('returns false for a defined error with no code property', () => {
    const err = new Error('mystery failure') as NodeJS.ErrnoException;
    expect(isBenignReclaimRaceError(err)).toBe(false);
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
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483647, createdAt: Date.now() }));
    const result = isLockStale(lockDir, 60_000);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain('holder pid 2147483647 is not alive');
  });

  it('preserves a lock when the holder pid is alive, even if older than staleMs', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 120_000 }),
    );
    // Also age the directory's own mtime: isLockStale's age fallback reads directory
    // mtime, not owner.json's createdAt. Without this, the assertion below would still
    // pass even if the alive-pid short-circuit were deleted, because the fallback would
    // then see a freshly-created (not-yet-stale) directory instead of an aged one.
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, twoMinutesAgo, twoMinutesAgo);
    expect(isLockStale(lockDir, 60_000)).toEqual({ stale: false });
  });

  it('detects an unidentified lock directory as stale when directory mtime exceeds staleMs', () => {
    fs.mkdirSync(lockDir);
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, twoMinutesAgo, twoMinutesAgo);

    const result = isLockStale(lockDir, 60_000);
    expect(result.stale).toBe(true);
    expect(result.reason).toContain('exceeded threshold');
  });

  it('detects an unidentified lock directory as not stale when directory mtime is recent', () => {
    fs.mkdirSync(lockDir);
    expect(isLockStale(lockDir, 60_000)).toEqual({ stale: false });
  });

  it('logs a warning when owner.json is corrupted and falls back to directory mtime', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), 'not-json');
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(lockDir, twoMinutesAgo, twoMinutesAgo);

    const result = isLockStale(lockDir, 60_000);
    expect(result.stale).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[registry] corrupted lock info'));
    warnSpy.mockRestore();
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
    const handle = acquireLock(lockDir);
    expect(fs.existsSync(lockDir)).toBe(true);
    const { info } = readLockInfo(lockDir);
    expect(info?.pid).toBe(process.pid);
    expect(info?.token).toBe(handle.token);
    expect(typeof info?.createdAt).toBe('number');

    releaseLock(lockDir, handle.token);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('automatically reclaims a stale lock left by a dead process', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483647, createdAt: Date.now() }));

    const handle = acquireLock(lockDir, { retries: 2, delayMs: 5 });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[registry] reclaimed stale lock'));
    expect(fs.existsSync(lockDir)).toBe(true);
    const { info } = readLockInfo(lockDir);
    expect(info?.pid).toBe(process.pid);

    releaseLock(lockDir, handle.token);
    warnSpy.mockRestore();
  });

  it('automatically reclaims an unidentified lock whose age exceeds staleMs', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fs.mkdirSync(lockDir);
    const oldTime = new Date(Date.now() - 100_000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    const handle = acquireLock(lockDir, { retries: 2, delayMs: 5, staleMs: 50 });

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[registry] reclaimed stale lock'));
    releaseLock(lockDir, handle.token);
    warnSpy.mockRestore();
  });

  it('throws timeout error and does not reclaim lock if held by a live process even past staleMs', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: process.pid, createdAt: Date.now() - 100_000 }),
    );

    expect(() => acquireLock(lockDir, { retries: 2, delayMs: 5, staleMs: 50 })).toThrow(
      /Timed out waiting for lock/,
    );
    expect(fs.existsSync(lockDir)).toBe(true);

    releaseLock(lockDir);
  });

  it('does not spuriously time out when a token read is unreadable rather than genuinely unchanged (#631)', () => {
    // A legacy-shaped lock (no token field) held by this same live process —
    // never reclaimable, so acquireLock can only proceed by waiting for it
    // to be released. Forces the "did the holder change" comparison instead
    // of the staleness-reclaim path.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    // The first read genuinely observes the token-less lock. The very next
    // read of owner.json — whichever of acquireLock's internal checks makes
    // it, since nothing here depends on that — fails for a reason unrelated
    // to the holder actually changing: here, the whole directory disappears
    // out from under the read (a release), so the read gets ENOENT. #631's
    // real trigger was a sibling's mkdirSync landing before its own
    // owner.json write — a different way to fail the same read (owner.json
    // missing while the directory exists) — but both collide the same way:
    // an unrelated read failure coerces to the same `null` as the original
    // observation's genuine, token-less parse.
    const realReadFileSync = fs.readFileSync;
    let calls = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      calls++;
      if (calls === 2) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return realReadFileSync(...args);
    }) as typeof fs.readFileSync);

    try {
      const handle = acquireLock(lockDir, { retries: 1, delayMs: 1 });
      // The unreadable observation actually happened, and what came back is
      // a lock this call itself created — not one left over by a path that
      // skipped consulting the previous holder entirely. 3, not 2: the
      // directory is gone by call 2, so call 3 (whichever check makes it)
      // also fails, naturally rather than by the mock.
      expect(calls).toBe(3);
      expect(handle.pid).toBe(process.pid);
      expect(readLockInfo(lockDir).info?.token).toBe(handle.token);
      releaseLock(lockDir, handle.token);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('does not spuriously time out when the FIRST observation is unreadable rather than a later one (#631)', () => {
    // Mirror of the test above: there, the LATER read fails against a
    // genuinely-known first observation, pinning currentTokenKnown. Here,
    // the FIRST read fails and a later one succeeds against the same
    // legacy content — pinning observedTokenKnown instead. Without this
    // test, forcing observedTokenKnown to `true` unconditionally (ignoring
    // whether the first read actually succeeded) leaves the whole suite
    // green: both known `null` tokens compare equal, so the "did the
    // holder change" check reads "unchanged" and throws — #631 again, from
    // the other side of the comparison.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    const realReadFileSync = fs.readFileSync;
    let calls = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      calls++;
      if (calls === 1) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const result = realReadFileSync(...args);
      if (calls === 3) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
      return result;
    }) as typeof fs.readFileSync);

    try {
      const handle = acquireLock(lockDir, { retries: 1, delayMs: 1 });
      expect(calls).toBe(3);
      expect(handle.pid).toBe(process.pid);
      expect(readLockInfo(lockDir).info?.token).toBe(handle.token);
      releaseLock(lockDir, handle.token);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('does not spuriously time out when owner.json is corrupted rather than genuinely unchanged (#631)', () => {
    // Same collision as the test above, but readLockInfo's `info: null`
    // comes from parseLockInfo rejecting unparseable content (no fs error
    // at all) rather than a failed read — the fix must not care which.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    const realReadFileSync = fs.readFileSync;
    let calls = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      calls++;
      if (calls === 2) {
        fs.rmSync(lockDir, { recursive: true, force: true });
        return 'not valid json{{{';
      }
      return realReadFileSync(...args);
    }) as typeof fs.readFileSync);

    try {
      const handle = acquireLock(lockDir, { retries: 1, delayMs: 1 });
      // 3, not 2: the directory is gone by call 2, so call 3 (whichever
      // check makes it) also fails, naturally rather than by the mock.
      expect(calls).toBe(3);
      expect(handle.pid).toBe(process.pid);
      expect(readLockInfo(lockDir).info?.token).toBe(handle.token);
      releaseLock(lockDir, handle.token);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('times out rather than waiting forever when a lock read never becomes readable', () => {
    // A live, non-stale holder whose owner.json permission-denies every
    // read: isLockStale's own age fallback never fires (the directory stays
    // fresh), so the only thing that can end the wait is the unknown-read
    // bound — proves tolerating a transient unreadable read (the "does not
    // spuriously time out" tests above) does not turn into waiting on a
    // permanently unreadable one forever. Also pins the bound at exactly
    // ACQUIRE_LOCK_MAX_UNKNOWN_PASSES: every pass makes two owner.json reads
    // (isLockStale's own, then the holder-changed check's), plus one more
    // for the initial observation, so throwing at N passes costs exactly
    // 1 + 2*N reads — an off-by-one in the bound changes that count.
    //
    // acquireLock's own wait is a synchronous Atomics.wait spin, which
    // vitest's testTimeout cannot interrupt — if the bound itself regresses
    // to unbounded, this test doesn't fail, it hangs the whole run.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    const realReadFileSync = fs.readFileSync;
    let calls = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      calls++;
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.readFileSync);

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /lock info stayed unreadable/,
      );
      expect(calls).toBe(1 + 2 * ACQUIRE_LOCK_MAX_UNKNOWN_PASSES);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('resets the unreadable-pass budget on any successful read, not just a reclaim', () => {
    // A live, non-stale, never-reclaimable holder (so the only reset path
    // available is the ordinary "a known read clears the count" one the
    // reclaim-path test above deliberately avoids). Two holder-changed
    // reads fail, building the count to 2 — one short of the bound — then
    // a read succeeds while the *original* observation is still unknown
    // (never having succeeded itself), so the comparison still takes the
    // "unknown" branch and consults the count: a carried-over 2+1 hits the
    // bound right there; a correctly-reset 0 does not.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));

    const realReadFileSync = fs.readFileSync;
    let calls = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      calls++;
      if (calls <= 6) {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      const result = realReadFileSync(...args);
      if (calls === 7) {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
      return result;
    }) as typeof fs.readFileSync);

    try {
      const handle = acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 });
      expect(calls).toBe(7);
      expect(handle.pid).toBe(process.pid);
      expect(readLockInfo(lockDir).info?.token).toBe(handle.token);
      releaseLock(lockDir, handle.token);
    } finally {
      readSpy.mockRestore();
    }
  });

  it('resets the unreadable-pass budget when a stale lock is reclaimed', () => {
    // Three unreadable reads accumulate against a fresh, non-stale dead-pid
    // lock (its own age fallback holds off staleness while unreadable, the
    // same as the test above). The fourth read finally succeeds and reveals
    // the dead pid — which makes isLockStale's own read (always the first
    // of a pass) trigger an immediate reclaim, before the holder-changed
    // check ever runs that same pass. So only the reclaim branch's own
    // reset — not the ordinary "a known read clears the count" case the
    // tests above exercise — can be what clears the 3 already accumulated.
    // A sibling wins the race to recreate the slot right after the reclaim
    // (never itself becoming readable, so nothing here depends on which
    // internal check does the reading) and stays unreadable forever after
    // — reaching the bound against it costs a full fresh budget only if
    // the reset actually happened.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: 2147483647, createdAt: Date.now() }));

    const realReadFileSync = fs.readFileSync;
    let calls = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      calls++;
      if (calls <= 3) {
        const err = new Error('EACCES') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return realReadFileSync(...args);
    }) as typeof fs.readFileSync);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const realRenameSync = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementationOnce((...args) => {
      realRenameSync(...(args as Parameters<typeof fs.renameSync>));
      fs.mkdirSync(lockDir);
    });

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /lock info stayed unreadable/,
      );
      // 3 forced-unreadable reads, then the revealing read that triggers
      // the reclaim (4 total) — the reclaim also resets observedToken to
      // undefined, so the very next pass re-observes from scratch and costs
      // 3 reads (mirroring the first pass, before this one), and every pass
      // after that costs 2 — until ACQUIRE_LOCK_MAX_UNKNOWN_PASSES of them
      // have run. A carried-over count would reach the bound sooner than
      // this — verified by mutation: deleting the reclaim branch's own
      // `unknownPasses = 0` drops this count, without failing any other
      // test in this file.
      expect(calls).toBe(4 + 3 + 2 * (ACQUIRE_LOCK_MAX_UNKNOWN_PASSES - 1));
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('bounds failed reclaim attempts rather than retrying a broken reclaim forever (#636)', () => {
    // A lock that is BOTH unreadable (owner.json permission-denied, so
    // isLockStale falls back to directory-age staleness) AND stale (mtime
    // backdated past staleMs) takes the stale-reclaim branch on every
    // pass. fs.renameSync is mocked to always throw — a persistent
    // filesystem error (e.g. EPERM), not a sibling briefly winning the
    // reclaim race — so reclaimStaleLock catches it and returns false on
    // every call. reclaimedStale never flips true, and without
    // ACQUIRE_LOCK_MAX_RECLAIM_FAILURES the branch's own `continue` would
    // retry the doomed reclaim forever (#636).
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const oldTime = new Date(Date.now() - 100_000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    const realReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.readFileSync);

    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /the rename kept failing/,
      );
      // Pins the bound at exactly ACQUIRE_LOCK_MAX_RECLAIM_FAILURES: every
      // stale-and-not-yet-reclaimed pass makes exactly one renameSync
      // call, so throwing after N attempts costs exactly N renameSync
      // calls — an off-by-one in the bound changes this count.
      expect(renameSpy).toHaveBeenCalledTimes(ACQUIRE_LOCK_MAX_RECLAIM_FAILURES);
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('resets failedReclaimAttempts when an intervening pass observes the lock as not stale (#636 review)', () => {
    // Two temporally-separated, causally-unrelated failure episodes against
    // the SAME lockDir, with a genuinely non-stale (live-holder) pass in
    // between. Without the reset, the second episode's failures would be
    // added to the first's, tripping the bound after just 1 more failure
    // instead of a fresh 3 — proving two unrelated one-off contention
    // losses don't get wrongly treated as one broken reclaim.
    //
    // Phase 'stale1': owner.json unreadable (EACCES) + backdated mtime, so
    // isLockStale's age fallback reports stale. renameSync always throws,
    // so reclaimStaleLock always fails. After exactly 2 such failures,
    // reclaimStaleLock's mock flips phase to 'live'.
    //
    // Phase 'live': owner.json reads succeed, reporting this SAME process
    // as a live holder (isPidAlive(process.pid) is genuinely true, so
    // isLockStale reports not-stale for real, not via a forced mock). This
    // makes acquireLock reset failedReclaimAttempts, then fall through to
    // the "did the holder change" check instead of the stale-reclaim
    // branch. Three reads happen in this one pass — the inner retry loop's
    // conditional read, isLockStale's own read, and the holder-changed
    // check's read — each returns a DIFFERENT token, so the holder-changed
    // check sees "the token changed" (not "unchanged, give up") and keeps
    // waiting rather than throwing the unrelated generic timeout. After the
    // 3rd live-phase read, the mock flips phase to 'stale2'.
    //
    // Phase 'stale2': same shape as 'stale1'. If the reset worked,
    // failedReclaimAttempts starts this phase at 0 and needs 3 more
    // failures (5 renameSync calls total) to throw. If it didn't reset,
    // the carried-over count of 2 needs only 1 more (3 renameSync calls
    // total) to throw — a directly observable difference.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    const oldTime = new Date(Date.now() - 100_000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    let phase: 'stale1' | 'live' | 'stale2' = 'stale1';
    let liveReadCount = 0;

    const realReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      if (phase === 'live') {
        liveReadCount += 1;
        const info = JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: `live-${liveReadCount}` });
        if (liveReadCount === 3) {
          phase = 'stale2';
        }
        return info;
      }
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.readFileSync);

    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      renameCalls += 1;
      if (phase === 'stale1' && renameCalls === 2) {
        phase = 'live';
      }
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /the rename kept failing/,
      );
      // 2 (stale1) + 3 (stale2, only reachable if the reset actually
      // happened) = 5. A broken/missing reset would throw after 3 total
      // calls instead (2 carried over + 1 more).
      expect(renameSpy).toHaveBeenCalledTimes(5);
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('resets failedReclaimAttempts when an intervening pass observes the lock as vanished (#636 review)', () => {
    // Same shape as the not-stale reset test above, but the intervening
    // forward-progress signal is the OTHER one acquireLock treats as
    // unambiguous episode-ending progress: `!fs.existsSync(lockDir)`, a few
    // lines above the stale-reclaim branch. The lock directory itself is
    // never actually removed here — fs.existsSync is mocked to report
    // "gone" for exactly one check, faking a sibling deleting it out from
    // under us between our last EEXIST and this check — so every other
    // aspect of the scenario (persistent EACCES reads, persistent EPERM
    // renames, backdated mtime) stays identical on both sides of the fake
    // vanish, isolating the vanished-branch's own reset as the only thing
    // that can explain a fresh 3-failure budget afterward.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    const oldTime = new Date(Date.now() - 100_000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    const realReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.readFileSync);

    let vanishOnNextCheck = false;
    const realExistsSync = fs.existsSync;
    const existsSpy = vi.spyOn(fs, 'existsSync').mockImplementation(((...args: Parameters<typeof fs.existsSync>) => {
      if (args[0] !== lockDir) {
        return realExistsSync(...args);
      }
      if (vanishOnNextCheck) {
        vanishOnNextCheck = false;
        return false;
      }
      return realExistsSync(...args);
    }) as typeof fs.existsSync);

    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      renameCalls += 1;
      if (renameCalls === 2) {
        vanishOnNextCheck = true;
      }
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /the rename kept failing/,
      );
      // 2 (before the faked vanish) + 3 (after, only reachable if the
      // vanished-branch reset actually happened) = 5. A broken/missing
      // reset would throw after 3 total calls instead (2 carried over + 1
      // more).
      expect(renameSpy).toHaveBeenCalledTimes(5);
    } finally {
      readSpy.mockRestore();
      existsSpy.mockRestore();
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('does not count benign reclaim races (ENOENT/ENOTDIR) toward failedReclaimAttempts bound (#638)', () => {
    // A lock that is stale (backdated mtime, owner.json unreadable) on every
    // pass. fs.renameSync is mocked to throw ENOENT (a benign race — a
    // sibling already renamed or removed lockDir) for the first
    // ACQUIRE_LOCK_MAX_RECLAIM_FAILURES + 2 calls (5), then throw EPERM
    // (a persistent filesystem problem) on every call after that. Without
    // the fix, all 5 ENOENT failures would accumulate toward the bound,
    // tripping it after 3 + 0 = 3 calls total; with the fix, the ENOENT
    // calls don't count, so the bound is only tripped after 5 (uncounted)
    // + 3 (genuine) = 8 calls, each throwing EPERM until the bound is hit.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const oldTime = new Date(Date.now() - 100_000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    const realReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.readFileSync);

    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      renameCalls += 1;
      if (renameCalls <= ACQUIRE_LOCK_MAX_RECLAIM_FAILURES + 2) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /the rename kept failing.*EPERM/,
      );
      // 5 benign (ENOENT) + 3 genuine (EPERM) = 8 total. If benign races
      // were incorrectly counted, the throw would happen after call 3
      // instead, and the error message would name ENOENT.
      expect(renameSpy).toHaveBeenCalledTimes((ACQUIRE_LOCK_MAX_RECLAIM_FAILURES + 2) + ACQUIRE_LOCK_MAX_RECLAIM_FAILURES);
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('a benign race interleaved with genuine failures does not reset the count — only skips it (#638)', () => {
    // Same fixture as the previous test: unreadable owner.json (EACCES) +
    // backdated mtime so isLockStale's age fallback reports stale on every
    // pass. This time, fs.renameSync throws an *interleaved* sequence:
    // EPERM(1), EPERM(2), ENOENT, EPERM(3) — 4 calls total. If the benign
    // branch *reset* the counter instead of just skipping the increment, the
    // ENOENT would reset failedReclaimAttempts to 0, requiring 3 more EPERM
    // calls (6 total) to trip the bound. But if it only skips (doesn't
    // increment), the ENOENT call leaves failedReclaimAttempts at 2, so the
    // next EPERM increments it to 3 and trips the bound on call 4.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const oldTime = new Date(Date.now() - 100_000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    const realReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.readFileSync);

    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      renameCalls += 1;
      let code: string;
      // Interleaved: EPERM(1), EPERM(2), ENOENT, EPERM(3)
      if (renameCalls === 1 || renameCalls === 2 || renameCalls === 4) {
        code = 'EPERM';
      } else if (renameCalls === 3) {
        code = 'ENOENT';
      } else {
        code = 'EPERM';
      }
      const err = new Error(code) as NodeJS.ErrnoException;
      err.code = code;
      throw err;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /the rename kept failing.*EPERM/,
      );
      // 4 total calls: EPERM(1) EPERM(2) ENOENT(uncounted, still 2) EPERM(3) →
      // trips at 4. If the benign call reset the counter, we'd need 6 calls
      // total (2 + reset-to-0 + 3 more). A bound mutation to `failedReclaimAttempts = 0`
      // in the benign branch would fail this assertion by allowing 6+ calls.
      expect(renameSpy).toHaveBeenCalledTimes(4);
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('does not count ENOTDIR benign race toward the bound — uses shared predicate for both codes (#638)', () => {
    // Same fixture as the first benign-race test: unreadable owner.json
    // (EACCES) + backdated mtime. But this time fs.renameSync throws ENOTDIR
    // for the first 5 calls (uncounted benign losses) then EPERM for the next
    // 3 (genuine, counted failures). Proves the call site actually uses the
    // shared isBenignReclaimRaceError predicate for ENOTDIR, not just ENOENT
    // — a hardcoded check at the call site would pass the ENOENT test but fail
    // this one.
    fs.mkdirSync(lockDir);
    const ownerPath = path.join(lockDir, 'owner.json');
    fs.writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const oldTime = new Date(Date.now() - 100_000);
    fs.utimesSync(lockDir, oldTime, oldTime);

    const realReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (args[0] !== ownerPath) {
        return realReadFileSync(...args);
      }
      const err = new Error('EACCES') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    }) as typeof fs.readFileSync);

    let renameCalls = 0;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      renameCalls += 1;
      if (renameCalls <= ACQUIRE_LOCK_MAX_RECLAIM_FAILURES + 2) {
        const err = new Error('ENOTDIR') as NodeJS.ErrnoException;
        err.code = 'ENOTDIR';
        throw err;
      }
      const err = new Error('EPERM') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /the rename kept failing.*EPERM/,
      );
      // 5 benign (ENOTDIR) + 3 genuine (EPERM) = 8 total. If the call site
      // special-cases ENOENT and ignores ENOTDIR, the throw would happen
      // after call 3 instead with ENOTDIR in the message.
      expect(renameSpy).toHaveBeenCalledTimes((ACQUIRE_LOCK_MAX_RECLAIM_FAILURES + 2) + ACQUIRE_LOCK_MAX_RECLAIM_FAILURES);
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      readSpy.mockRestore();
      renameSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('releaseLock does not delete lock directory if token or pid does not match', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(
      path.join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2147483647, createdAt: Date.now(), token: 'other-token' }),
    );

    releaseLock(lockDir, process.pid);
    expect(fs.existsSync(lockDir)).toBe(true);

    releaseLock(lockDir, 'my-token');
    expect(fs.existsSync(lockDir)).toBe(true);

    releaseLock(lockDir);
    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it('releaseLock warns and releases anyway when owner.json cannot be verified (not ENOENT)', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      const err = new Error('too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    });
    try {
      releaseLock(lockDir, process.pid);
    } finally {
      readSpy.mockRestore();
    }
    // Releasing anyway (rather than leaking) is the point: a lock this process still
    // holds must not become permanently unreclaimable just because the verification
    // read hit a transient error — see the regression test below for why.
    expect(fs.existsSync(lockDir)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not verify lock ownership'));
    warnSpy.mockRestore();
  });

  it('releaseLock still refuses to delete on a genuine, verified pid/token mismatch even under the same conditions', () => {
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({ pid: 2147483647, createdAt: Date.now() }));
    releaseLock(lockDir, process.pid);
    expect(fs.existsSync(lockDir)).toBe(true);
    releaseLock(lockDir);
  });

  it('regression: a transient release read-failure does not permanently wedge the same still-alive process', () => {
    const handle = acquireLock(lockDir);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      const err = new Error('too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    });
    try {
      releaseLock(lockDir, handle.token);
    } finally {
      readSpy.mockRestore();
    }
    // The leak this guards against: if release silently no-ops here, the directory
    // stays behind showing this process's own (alive) pid as holder. isLockStale would
    // then report it as {stale: false} forever, and no one — including this same
    // process moments later — could ever reclaim it. Proving the directory is actually
    // gone is what distinguishes "released" from "leaked but coincidentally not stale".
    expect(fs.existsSync(lockDir)).toBe(false);
    const reacquired = acquireLock(lockDir, { retries: 5, delayMs: 5 });
    expect(reacquired.pid).toBe(process.pid);
    releaseLock(lockDir, reacquired.token);
  });

  it('writeRegistryLocked aborts and throws if lock is lost before commit', async () => {
    const registryPath = path.join(dir, 'fairyoga-worktrees.json');
    const lockPath = `${registryPath}.lock`;

    await expect(
      writeRegistryLocked(registryPath, async (current) => {
        fs.rmSync(lockPath, { recursive: true, force: true });
        return { ...current, stolen: { port: 3100, pid: null, dbSlug: 'stolen' as DbSlug } };
      }),
    ).rejects.toThrow(/lock at .* was lost during mutation/);

    expect(readRegistry(registryPath)).toEqual({});
    const tmpFiles = fs.readdirSync(dir).filter((f) => f.includes('.tmp.'));
    expect(tmpFiles).toEqual([]);
  });

  it('writeRegistryLocked self-heals when a dead process lock exists', async () => {
    const registryPath = path.join(dir, 'fairyoga-worktrees.json');
    const lockPath = `${registryPath}.lock`;
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 2147483647, createdAt: Date.now() }));

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await writeRegistryLocked(
      registryPath,
      (current) => ({ ...current, healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' as DbSlug } }),
      { retries: 2, delayMs: 5 },
    );

    expect(result).toEqual({ healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' } });
    expect(readRegistry(registryPath)).toEqual({ healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' } });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[registry] reclaimed stale lock'));
    warnSpy.mockRestore();
  });

  it('assertLockHeld recovers from a transient read failure without throwing', () => {
    const handle = acquireLock(lockDir);
    const originalReadFileSync = fs.readFileSync.bind(fs);
    let calls = 0;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
      calls++;
      if (calls === 1) {
        const err = new Error('too many open files') as NodeJS.ErrnoException;
        err.code = 'EMFILE';
        throw err;
      }
      return originalReadFileSync(...args);
    });
    try {
      expect(() => assertLockHeld(handle)).not.toThrow();
      expect(calls).toBeGreaterThan(1);
    } finally {
      readSpy.mockRestore();
      releaseLock(lockDir, handle.token);
    }
  });

  it('assertLockHeld throws a "could not verify" error (not "was lost") on a persistent ambiguous read failure', () => {
    const handle = acquireLock(lockDir);
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      const err = new Error('too many open files') as NodeJS.ErrnoException;
      err.code = 'EMFILE';
      throw err;
    });
    try {
      expect(() => assertLockHeld(handle)).toThrow(/could not verify lock ownership/);
    } finally {
      readSpy.mockRestore();
      releaseLock(lockDir, handle.token);
    }
  });
});

describe('multi-process concurrent locking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-concurrent-test-'));
  const registryPath = path.join(dir, 'fairyoga-worktrees.json');
  const tsxCli = path.resolve(process.cwd(), 'node_modules/tsx/dist/cli.mjs');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('handles concurrent writers competing for the lock without lost updates', async () => {
    const workerFile = path.join(dir, 'worker.ts');
    fs.writeFileSync(
      workerFile,
      `
import { writeRegistryLocked } from '${path.resolve(__dirname, './registry')}';
const [,, id, registryPath] = process.argv;
writeRegistryLocked(registryPath, (reg) => {
  return { ...reg, [id]: { port: 3100 + Number(id), pid: process.pid, dbSlug: id } };
}, { retries: 300, delayMs: 20 }).then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
    );

    const children = [1, 2, 3].map((id) =>
      new Promise<{ code: number | null }>((resolve) => {
        const cp = child_process.spawn(process.execPath, [tsxCli, workerFile, String(id), registryPath], {
          stdio: 'inherit',
        });
        cp.on('exit', (code) => resolve({ code }));
      }),
    );

    const results = await Promise.all(children);
    for (const r of results) {
      expect(r.code).toBe(0);
    }

    const reg = readRegistry(registryPath);
    expect(Object.keys(reg).sort()).toEqual(['1', '2', '3']);
  }, 20_000);

  it('handles concurrent workers competing to reclaim a stale lock without race conditions', async () => {
    const lockPath = `${registryPath}.lock`;
    fs.mkdirSync(lockPath);
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: 2147483647, createdAt: Date.now() }));

    const workerFile = path.join(dir, 'worker-reclaim.ts');
    fs.writeFileSync(
      workerFile,
      `
import { writeRegistryLocked } from '${path.resolve(__dirname, './registry')}';
const [,, id, registryPath] = process.argv;
writeRegistryLocked(registryPath, (reg) => {
  return { ...reg, [id]: { port: 3200 + Number(id), pid: process.pid, dbSlug: id } };
}, { retries: 300, delayMs: 20 }).then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
`,
    );

    const children = [1, 2, 3].map((id) =>
      new Promise<{ code: number | null }>((resolve) => {
        const cp = child_process.spawn(process.execPath, [tsxCli, workerFile, String(id), registryPath], {
          stdio: 'inherit',
        });
        cp.on('exit', (code) => resolve({ code }));
      }),
    );

    const results = await Promise.all(children);
    for (const r of results) {
      expect(r.code).toBe(0);
    }

    const reg = readRegistry(registryPath);
    expect(Object.keys(reg).sort()).toEqual(['1', '2', '3']);
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 20_000);
});

/**
 * Compile-time assertion that allocatePort's rawName and dbSlug parameters
 * cannot be swapped positionally (#528 — three review rounds on #527 had to
 * verify this by hand at every call site).
 *
 * This check is verified by `npm run typecheck` only (`tsc --noEmit`) and is
 * invisible to Vitest runtime test execution (tests do not typecheck or transpile types).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _allocatePortArgsCannotBeSwapped(registry: Registry, rawName: RawName, dbSlug: DbSlug): void {
  // @ts-expect-error rawName and dbSlug must not be swappable positionally
  allocatePort(registry, dbSlug, rawName);
}
