import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  allocatePort,
  setPid,
  removeSlug,
  diffOrphans,
  getRegistryPath,
  readRegistry,
  writeRegistryLocked,
  type Registry,
} from './registry';

describe('allocatePort', () => {
  it('allocates the lowest free port in range for a new slug', () => {
    const { registry, port } = allocatePort({}, 'fix_517', { min: 3100, max: 3102 });
    expect(port).toBe(3100);
    expect(registry).toEqual({ fix_517: { port: 3100, pid: null } });
  });

  it('skips ports already claimed by other slugs', () => {
    const existing: Registry = { fix_520: { port: 3100, pid: null } };
    const { port } = allocatePort(existing, 'fix_517', { min: 3100, max: 3102 });
    expect(port).toBe(3101);
  });

  it('returns the existing port unchanged when the slug is already registered', () => {
    const existing: Registry = { fix_517: { port: 3100, pid: 999 } };
    const { registry, port } = allocatePort(existing, 'fix_517', { min: 3100, max: 3102 });
    expect(port).toBe(3100);
    expect(registry).toBe(existing);
  });

  it('throws when the range is exhausted', () => {
    const existing: Registry = { a: { port: 3100, pid: null }, b: { port: 3101, pid: null } };
    expect(() => allocatePort(existing, 'c', { min: 3100, max: 3101 })).toThrow();
  });
});

describe('setPid', () => {
  it('updates only the given slug', () => {
    const existing: Registry = { fix_517: { port: 3100, pid: null } };
    expect(setPid(existing, 'fix_517', 4242)).toEqual({ fix_517: { port: 3100, pid: 4242 } });
  });

  it('throws for an unregistered slug', () => {
    expect(() => setPid({}, 'fix_517', 4242)).toThrow();
  });
});

describe('removeSlug', () => {
  it('removes only the given slug', () => {
    const existing: Registry = {
      fix_517: { port: 3100, pid: null },
      fix_520: { port: 3101, pid: null },
    };
    expect(removeSlug(existing, 'fix_517')).toEqual({ fix_520: { port: 3101, pid: null } });
  });
});

describe('diffOrphans', () => {
  it('returns entries whose slug is not live', () => {
    const existing: Registry = {
      fix_517: { port: 3100, pid: null },
      fix_520: { port: 3101, pid: 4242 },
    };
    const result = diffOrphans(existing, new Set(['fix_517']));
    expect(result).toEqual([{ slug: 'fix_520', entry: { port: 3101, pid: 4242 } }]);
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

  it('writes what the mutate function returns and persists it', async () => {
    await writeRegistryLocked(registryPath, () => ({ fix_517: { port: 3100, pid: null } }));
    expect(readRegistry(registryPath)).toEqual({ fix_517: { port: 3100, pid: null } });
  });

  it('supports an async mutate function', async () => {
    await writeRegistryLocked(registryPath, async (registry) => {
      await Promise.resolve();
      return { ...registry, fix_520: { port: 3101, pid: null } };
    });
    expect(readRegistry(registryPath)).toEqual({ fix_520: { port: 3101, pid: null } });
  });

  it('writes atomically — no leftover temp file after a successful write', async () => {
    await writeRegistryLocked(registryPath, () => ({ fix_517: { port: 3100, pid: null } }));
    const files = fs.readdirSync(dir);
    expect(files.filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

describe('getRegistryPath', () => {
  it('names the registry file inside the given git-common-dir', () => {
    expect(getRegistryPath('/repo/.git')).toBe(path.join('/repo/.git', 'fairyoga-worktrees.json'));
  });
});
