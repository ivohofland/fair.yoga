import { describe, it, expect, afterEach } from 'vitest';
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
