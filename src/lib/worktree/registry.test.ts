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
  acquireLock,
  releaseLock,
  isLockStale,
  isPidAlive,
  readLockInfo,
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
        return { ...current, stolen: { port: 3100, pid: null, dbSlug: 'stolen' } };
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
      (current) => ({ ...current, healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' } }),
      { retries: 2, delayMs: 5 },
    );

    expect(result).toEqual({ healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' } });
    expect(readRegistry(registryPath)).toEqual({ healed_worktree: { port: 3100, pid: null, dbSlug: 'healed_worktree' } });
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('[registry] reclaimed stale lock'));
    warnSpy.mockRestore();
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


