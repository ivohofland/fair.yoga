# Per-Worktree Database + Dev-Server Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every git worktree its own Postgres databases (inside the existing shared `fairyoga-db-1` container — no new containers) and its own long-lived dev server on its own port, so `unit`/`unit-sweeps` stop contending across worktrees (#517) and `integration`/e2e become runnable locally from a worktree at all, with orphaned resources reaped automatically.

**Architecture:** A slug derived from each worktree's git admin-directory name identifies it. A JSON registry file in the main repo's shared `.git` directory maps `slug → {port, pid}`. Pure allocation/diff/reap logic lives in `src/lib/worktree/*.ts` (unit-tested, no real Postgres/git dependency); three thin CLI scripts (`scripts/worktree-{setup,up,down}.ts`) and the existing vitest global setup wire that logic to real `npm install`, `.env` generation, Prisma, and `next dev`.

**Tech Stack:** TypeScript (strict), `tsx` for script execution, Prisma (`@prisma/client`), vitest (`unit` tier for all new tests), existing `child_process`/`fs` — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-08-worktree-db-isolation-design.md`

## Global Constraints

- TypeScript `strict: true` — no `any`, no implicit types. This repo's `tsconfig.json` also sets `noUncheckedIndexedAccess: true`: every array/object index access is `T | undefined` and must be narrowed explicitly.
- Test-first: every new function with real logic gets a failing test before its implementation.
- New tests live under `src/lib/worktree/*.test.ts` and `src/lib/db-provision.test.ts` — matched by the existing `unit` vitest project's `src/**/*.test.ts` include pattern, so no `vitest.config.ts` changes are needed for test discovery.
- Never edit an applied Prisma migration; this plan makes no schema changes, so no migration is created.
- No comments describing history ("this used to...", "previously...") — state current behavior only, per this repo's Comment Discipline.
- Match existing code style exactly where a file already exists: `tests/setup/unit-db.ts`'s existing docblock tone, `.env.example`'s existing comment style for optional vars, `playwright.config.ts`'s existing comment density.

---

### Task 1: Worktree identity and database naming

**Files:**
- Create: `src/lib/worktree/identity.ts`
- Test: `src/lib/worktree/identity.test.ts`

**Interfaces:**
- Produces: `sanitizeSlug(raw: string): string`, `dbNamesForSlug(slug: string): { test: string; dev: string }`, `resolveIdentity(gitDir: string, gitCommonDir: string): { isMainCheckout: boolean; slug: string | null; gitCommonDir: string }`, `getWorktreeIdentity(cwd?: string): { isMainCheckout: boolean; slug: string | null; gitCommonDir: string }`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/worktree/identity.test.ts
import { describe, it, expect } from 'vitest';
import { sanitizeSlug, dbNamesForSlug, resolveIdentity } from './identity';

describe('sanitizeSlug', () => {
  it('lowercases and replaces hyphens with underscores', () => {
    expect(sanitizeSlug('fix-512-Handoff-Timeout')).toBe('fix_512_handoff_timeout');
  });

  it('collapses runs of unsafe characters and trims leading/trailing underscores', () => {
    expect(sanitizeSlug('--weird..name!!')).toBe('weird_name');
  });

  it('truncates to a length that leaves room for the database prefix', () => {
    const long = 'a'.repeat(80);
    const result = sanitizeSlug(long);
    expect(result.length).toBeLessThanOrEqual(40);
  });

  it('throws when nothing safe is left', () => {
    expect(() => sanitizeSlug('!!!')).toThrow();
  });
});

describe('dbNamesForSlug', () => {
  it('prefixes the slug for both database families', () => {
    expect(dbNamesForSlug('fix_517')).toEqual({
      test: 'ethical_yoga_test_fix_517',
      dev: 'ethical_yoga_dev_fix_517',
    });
  });
});

describe('resolveIdentity', () => {
  it('is the main checkout when git-dir equals git-common-dir', () => {
    const result = resolveIdentity('/repo/.git', '/repo/.git');
    expect(result).toEqual({ isMainCheckout: true, slug: null, gitCommonDir: '/repo/.git' });
  });

  it('is a linked worktree when the dirs differ, slug is the git-dir basename', () => {
    const result = resolveIdentity('/repo/.git/worktrees/fix-517', '/repo/.git');
    expect(result).toEqual({
      isMainCheckout: false,
      slug: 'fix_517',
      gitCommonDir: '/repo/.git',
    });
  });

  it('ignores a trailing slash difference', () => {
    const result = resolveIdentity('/repo/.git/', '/repo/.git');
    expect(result.isMainCheckout).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/worktree/identity.test.ts`
Expected: FAIL — `./identity` has no exported members (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/worktree/identity.ts
import { execSync } from 'child_process';
import path from 'path';

const MAX_SLUG_LENGTH = 40;

export function sanitizeSlug(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) {
    throw new Error(`sanitizeSlug: "${raw}" produced an empty slug`);
  }
  return cleaned.slice(0, MAX_SLUG_LENGTH);
}

export interface DatabaseNames {
  test: string;
  dev: string;
}

export function dbNamesForSlug(slug: string): DatabaseNames {
  return {
    test: `ethical_yoga_test_${slug}`,
    dev: `ethical_yoga_dev_${slug}`,
  };
}

export interface WorktreeIdentity {
  isMainCheckout: boolean;
  slug: string | null;
  gitCommonDir: string;
}

function normalizeDir(dir: string): string {
  return dir.replace(/\/+$/, '');
}

function basename(dir: string): string {
  const parts = normalizeDir(dir).split('/');
  const last = parts.pop();
  return last ?? dir;
}

/** Pure — decides identity from git's own output. */
export function resolveIdentity(gitDir: string, gitCommonDir: string): WorktreeIdentity {
  const isMainCheckout = normalizeDir(gitDir) === normalizeDir(gitCommonDir);
  return {
    isMainCheckout,
    slug: isMainCheckout ? null : sanitizeSlug(basename(gitDir)),
    gitCommonDir: normalizeDir(gitCommonDir),
  };
}

/** Shells out to git. Not unit tested directly — resolveIdentity carries the logic. */
export function getWorktreeIdentity(cwd: string = process.cwd()): WorktreeIdentity {
  const gitDir = execSync('git rev-parse --git-dir', { cwd, encoding: 'utf8' }).trim();
  const gitCommonDir = execSync('git rev-parse --git-common-dir', { cwd, encoding: 'utf8' }).trim();
  return resolveIdentity(path.resolve(cwd, gitDir), path.resolve(cwd, gitCommonDir));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/worktree/identity.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree/identity.ts src/lib/worktree/identity.test.ts
git commit -m "feat(worktrees): derive worktree slug and per-slug database names"
```

---

### Task 2: Live worktree slugs from git's own bookkeeping

**Files:**
- Create: `src/lib/worktree/live-slugs.ts`
- Test: `src/lib/worktree/live-slugs.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `computeLiveSlugs(entries: { slug: string; workingDirExists: boolean }[]): Set<string>`, `listWorktreeAdminEntries(gitCommonDir: string): { slug: string; workingDirExists: boolean }[]`, `getLiveSlugs(gitCommonDir: string): Set<string>`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/worktree/live-slugs.test.ts
import { describe, it, expect } from 'vitest';
import { computeLiveSlugs } from './live-slugs';

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/lib/worktree/live-slugs.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/worktree/live-slugs.ts
import fs from 'fs';
import path from 'path';

export interface WorktreeAdminEntry {
  slug: string;
  workingDirExists: boolean;
}

/** Pure — given what's on disk, decides which slugs are still live. */
export function computeLiveSlugs(entries: WorktreeAdminEntry[]): Set<string> {
  return new Set(entries.filter((entry) => entry.workingDirExists).map((entry) => entry.slug));
}

/**
 * Git keeps one directory per linked worktree at `<gitCommonDir>/worktrees/<slug>/`,
 * each holding a `gitdir` file pointing at that worktree's `.git` file. If the
 * worktree's own directory was deleted without `git worktree remove`, that
 * target no longer exists — the same staleness check `git worktree prune` uses.
 */
export function listWorktreeAdminEntries(gitCommonDir: string): WorktreeAdminEntry[] {
  const worktreesDir = path.join(gitCommonDir, 'worktrees');
  if (!fs.existsSync(worktreesDir)) {
    return [];
  }
  return fs.readdirSync(worktreesDir).map((slug) => {
    const gitdirFile = path.join(worktreesDir, slug, 'gitdir');
    let workingDirExists = false;
    try {
      const target = fs.readFileSync(gitdirFile, 'utf8').trim();
      workingDirExists = fs.existsSync(path.dirname(target));
    } catch {
      workingDirExists = false;
    }
    return { slug, workingDirExists };
  });
}

export function getLiveSlugs(gitCommonDir: string): Set<string> {
  return computeLiveSlugs(listWorktreeAdminEntries(gitCommonDir));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit src/lib/worktree/live-slugs.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree/live-slugs.ts src/lib/worktree/live-slugs.test.ts
git commit -m "feat(worktrees): read live worktree slugs from git's own admin dirs"
```

---

### Task 3: The port/PID registry

**Files:**
- Create: `src/lib/worktree/registry.ts`
- Test: `src/lib/worktree/registry.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `type RegistryEntry = { port: number; pid: number | null }`, `type Registry = Record<string, RegistryEntry>`, `type PortRange = { min: number; max: number }`, `DEFAULT_PORT_RANGE: PortRange` (`{ min: 3100, max: 3999 }`), `allocatePort(registry: Registry, slug: string, range?: PortRange): { registry: Registry; port: number }`, `setPid(registry: Registry, slug: string, pid: number | null): Registry`, `removeSlug(registry: Registry, slug: string): Registry`, `diffOrphans(registry: Registry, liveSlugs: ReadonlySet<string>): { slug: string; entry: RegistryEntry }[]`, `getRegistryPath(gitCommonDir: string): string`, `readRegistry(registryPath: string): Registry`, `writeRegistryLocked(registryPath: string, mutate: (registry: Registry) => Registry | Promise<Registry>): Promise<Registry>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/worktree/registry.test.ts
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

  it('reads an empty registry for corrupt JSON rather than throwing', () => {
    fs.writeFileSync(registryPath, 'not json');
    expect(readRegistry(registryPath)).toEqual({});
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
});

describe('getRegistryPath', () => {
  it('names the registry file inside the given git-common-dir', () => {
    expect(getRegistryPath('/repo/.git')).toBe(path.join('/repo/.git', 'fairyoga-worktrees.json'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/worktree/registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/worktree/registry.ts
import fs from 'fs';
import path from 'path';

export interface RegistryEntry {
  port: number;
  pid: number | null;
}

export type Registry = Record<string, RegistryEntry>;

export interface PortRange {
  min: number;
  max: number;
}

export const DEFAULT_PORT_RANGE: PortRange = { min: 3100, max: 3999 };

export function allocatePort(
  registry: Registry,
  slug: string,
  range: PortRange = DEFAULT_PORT_RANGE,
): { registry: Registry; port: number } {
  const existing = registry[slug];
  if (existing) {
    return { registry, port: existing.port };
  }
  const claimed = new Set(Object.values(registry).map((entry) => entry.port));
  for (let port = range.min; port <= range.max; port++) {
    if (!claimed.has(port)) {
      return { registry: { ...registry, [slug]: { port, pid: null } }, port };
    }
  }
  throw new Error(`No free port in range ${range.min}-${range.max}`);
}

export function setPid(registry: Registry, slug: string, pid: number | null): Registry {
  const existing = registry[slug];
  if (!existing) {
    throw new Error(`setPid: no registry entry for slug "${slug}" — call allocatePort first`);
  }
  return { ...registry, [slug]: { ...existing, pid } };
}

export function removeSlug(registry: Registry, slug: string): Registry {
  const next = { ...registry };
  delete next[slug];
  return next;
}

export interface OrphanEntry {
  slug: string;
  entry: RegistryEntry;
}

export function diffOrphans(registry: Registry, liveSlugs: ReadonlySet<string>): OrphanEntry[] {
  return Object.entries(registry)
    .filter(([slug]) => !liveSlugs.has(slug))
    .map(([slug, entry]) => ({ slug, entry }));
}

export function getRegistryPath(gitCommonDir: string): string {
  return path.join(gitCommonDir, 'fairyoga-worktrees.json');
}

export function readRegistry(registryPath: string): Registry {
  try {
    const raw = fs.readFileSync(registryPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Registry;
    }
    return {};
  } catch {
    return {};
  }
}

function sleepSync(ms: number): void {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function acquireLock(lockDir: string, retries = 50, delayMs = 20): void {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      fs.mkdirSync(lockDir);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
      sleepSync(delayMs);
    }
  }
  throw new Error(`Timed out waiting for lock at ${lockDir}`);
}

function releaseLock(lockDir: string): void {
  fs.rmSync(lockDir, { recursive: true, force: true });
}

export async function writeRegistryLocked(
  registryPath: string,
  mutate: (registry: Registry) => Registry | Promise<Registry>,
): Promise<Registry> {
  const lockDir = `${registryPath}.lock`;
  acquireLock(lockDir);
  try {
    const current = readRegistry(registryPath);
    const next = await mutate(current);
    fs.writeFileSync(registryPath, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } finally {
    releaseLock(lockDir);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/worktree/registry.test.ts`
Expected: PASS (13 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree/registry.ts src/lib/worktree/registry.test.ts
git commit -m "feat(worktrees): add the port/pid registry with locked reads and writes"
```

---

### Task 4: `.env` generation that never overwrites

**Files:**
- Create: `src/lib/worktree/env-file.ts`
- Test: `src/lib/worktree/env-file.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: `generateEnvContent(templateContent: string, overrides: Record<string, string>): string`, `writeEnvIfMissing(envPath: string, examplePath: string, overrides: Record<string, string>): boolean`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/worktree/env-file.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { generateEnvContent, writeEnvIfMissing } from './env-file';

describe('generateEnvContent', () => {
  it('replaces an existing key in place', () => {
    const template = 'DATABASE_URL="postgresql://old"\nOTHER="keep"';
    const result = generateEnvContent(template, { DATABASE_URL: 'postgresql://new' });
    expect(result).toBe('DATABASE_URL="postgresql://new"\nOTHER="keep"');
  });

  it('appends a key that is not present in the template', () => {
    const template = 'DATABASE_URL="postgresql://old"';
    const result = generateEnvContent(template, { INTEGRATION_BASE_URL: 'http://localhost:3100' });
    expect(result).toBe('DATABASE_URL="postgresql://old"\n\nINTEGRATION_BASE_URL="http://localhost:3100"');
  });

  it('leaves lines with no matching override untouched', () => {
    const template = 'PASSKEY_RP_ID="localhost"';
    const result = generateEnvContent(template, { DATABASE_URL: 'postgresql://new' });
    expect(result).toBe('PASSKEY_RP_ID="localhost"\n\nDATABASE_URL="postgresql://new"');
  });
});

describe('writeEnvIfMissing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-env-test-'));
  const envPath = path.join(dir, '.env');
  const examplePath = path.join(dir, '.env.example');
  fs.writeFileSync(examplePath, 'DATABASE_URL="postgresql://old"');

  afterEach(() => {
    fs.rmSync(envPath, { force: true });
  });

  it('writes .env from the template when it does not exist', () => {
    const wrote = writeEnvIfMissing(envPath, examplePath, { DATABASE_URL: 'postgresql://new' });
    expect(wrote).toBe(true);
    expect(fs.readFileSync(envPath, 'utf8')).toContain('postgresql://new');
  });

  it('never overwrites an existing .env', () => {
    fs.writeFileSync(envPath, 'DATABASE_URL="postgresql://hand-edited"');
    const wrote = writeEnvIfMissing(envPath, examplePath, { DATABASE_URL: 'postgresql://new' });
    expect(wrote).toBe(false);
    expect(fs.readFileSync(envPath, 'utf8')).toBe('DATABASE_URL="postgresql://hand-edited"');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/worktree/env-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/worktree/env-file.ts
import fs from 'fs';

export function generateEnvContent(templateContent: string, overrides: Record<string, string>): string {
  const lines = templateContent.split('\n');
  const applied = new Set<string>();
  const result = lines.map((line) => {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=/);
    const key = match?.[1];
    if (key !== undefined && key in overrides) {
      const value = overrides[key];
      if (value !== undefined) {
        applied.add(key);
        return `${key}="${value}"`;
      }
    }
    return line;
  });

  const remaining = Object.keys(overrides).filter((key) => !applied.has(key));
  if (remaining.length > 0) {
    result.push('');
    for (const key of remaining) {
      const value = overrides[key];
      if (value !== undefined) {
        result.push(`${key}="${value}"`);
      }
    }
  }
  return result.join('\n');
}

export function writeEnvIfMissing(
  envPath: string,
  examplePath: string,
  overrides: Record<string, string>,
): boolean {
  if (fs.existsSync(envPath)) {
    return false;
  }
  const template = fs.readFileSync(examplePath, 'utf8');
  fs.writeFileSync(envPath, generateEnvContent(template, overrides));
  return true;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/worktree/env-file.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree/env-file.ts src/lib/worktree/env-file.test.ts
git commit -m "feat(worktrees): generate .env from .env.example without ever overwriting it"
```

---

### Task 5: Generalize database provisioning out of `tests/setup/unit-db.ts`

**Files:**
- Create: `src/lib/db-provision.ts`
- Test: `src/lib/db-provision.test.ts`

`tests/setup/unit-db.ts` is refactored in Task 6, not here — it needs both
`provisionDatabase` (this task) and `runReap` (Task 6), and committing it
mid-refactor with only the first would leave its import of `runReap`
unresolved until Task 6 lands.

**Interfaces:**
- Consumes: nothing from Tasks 1-4.
- Produces: `assertSafeDatabaseName(dbName: string): void`, `withDatabaseName(baseUrl: string, dbName: string): string`, `provisionDatabase(url: string, options: { seed: boolean }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/db-provision.test.ts
import { describe, it, expect } from 'vitest';
import { assertSafeDatabaseName, withDatabaseName } from './db-provision';

describe('assertSafeDatabaseName', () => {
  it('accepts alphanumeric-and-underscore names', () => {
    expect(() => assertSafeDatabaseName('ethical_yoga_test_fix_517')).not.toThrow();
  });

  it('rejects a name with SQL-unsafe characters', () => {
    expect(() => assertSafeDatabaseName('ethical_yoga"; DROP TABLE x; --')).toThrow();
  });
});

describe('withDatabaseName', () => {
  it('replaces only the path of the connection URL', () => {
    const result = withDatabaseName('postgresql://yoga:pw@localhost:5432/ethical_yoga', 'postgres');
    expect(result).toBe('postgresql://yoga:pw@localhost:5432/postgres');
  });
});
```

`provisionDatabase` itself needs a real Postgres connection and is exercised by Task 11's acceptance check, not a unit test — matching the spec's Testing section.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/db-provision.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/db-provision.ts
import { execSync } from 'child_process';
import { PrismaClient } from '@prisma/client';

export function assertSafeDatabaseName(dbName: string): void {
  if (!/^[a-z0-9_]+$/i.test(dbName)) {
    throw new Error(`unsafe database name: ${dbName}`);
  }
}

export function withDatabaseName(baseUrl: string, dbName: string): string {
  assertSafeDatabaseName(dbName);
  const url = new URL(baseUrl);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export interface ProvisionOptions {
  seed: boolean;
}

/**
 * Create-if-missing + `prisma migrate deploy` against `url`, optionally
 * seeding — but only on the run that actually creates the database, so a
 * re-run against an existing one never wipes data a developer put there.
 */
export async function provisionDatabase(url: string, options: ProvisionOptions): Promise<void> {
  const dbName = new URL(url).pathname.slice(1);
  assertSafeDatabaseName(dbName);

  const admin = new PrismaClient({ datasources: { db: { url: withDatabaseName(url, 'postgres') } } });
  let created = false;
  try {
    const exists = await admin.$queryRaw<
      { one: number }[]
    >`SELECT 1 AS one FROM pg_database WHERE datname = ${dbName}`;
    if (exists.length === 0) {
      await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);
      created = true;
      console.log(`[db-provision] created database ${dbName}`);
    }
  } finally {
    await admin.$disconnect();
  }

  execSync('npx prisma migrate deploy', {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });

  if (options.seed && created) {
    execSync('npx prisma db seed', {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    console.log(`[db-provision] seeded database ${dbName}`);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/db-provision.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db-provision.ts src/lib/db-provision.test.ts
git commit -m "feat(worktrees): add provisionDatabase, extracted for reuse beyond the vitest global setup"
```

`tests/setup/unit-db.ts` still has its original body at the end of this task — Task 6 is what rewrites it, once `runReap` exists too.

---

### Task 6: Reap orphaned worktree resources

**Files:**
- Create: `src/lib/worktree/side-effects.ts`
- Create: `src/lib/worktree/reap.ts`
- Test: `src/lib/worktree/reap.test.ts`
- Modify: `tests/setup/unit-db.ts` (full replacement, Step 5 below — deferred
  from Task 5 because it needs both `provisionDatabase`, Task 5, and
  `runReap`, produced by this task's Step 3)

**Interfaces:**
- Consumes: `diffOrphans`, `removeSlug`, `Registry`, `writeRegistryLocked` (Task 3); `dbNamesForSlug` (Task 1); `getLiveSlugs` (Task 2); `withDatabaseName`, `assertSafeDatabaseName` (Task 5).
- Produces: `dropDatabaseReal(dbName: string, anyDatabaseUrl: string): Promise<void>`, `killPidReal(pid: number): void`, `reapOrphans(registry: Registry, liveSlugs: ReadonlySet<string>, deps: { dropDatabase: (dbName: string) => Promise<void>; killPid: (pid: number) => void }): Promise<{ registry: Registry; reaped: string[] }>`, `runReap(gitCommonDir: string, registryPath: string, anyDatabaseUrl: string): Promise<string[]>`.

- [ ] **Step 1: Write the failing tests**

```typescript
// src/lib/worktree/reap.test.ts
import { describe, it, expect, vi } from 'vitest';
import { reapOrphans } from './reap';
import type { Registry } from './registry';

describe('reapOrphans', () => {
  it('kills the pid, drops both databases, and removes the entry for each orphan', async () => {
    const registry: Registry = {
      fix_517: { port: 3100, pid: null },
      fix_520: { port: 3101, pid: 4242 },
    };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    const result = await reapOrphans(registry, new Set(['fix_517']), { dropDatabase, killPid });

    expect(result.reaped).toEqual(['fix_520']);
    expect(result.registry).toEqual({ fix_517: { port: 3100, pid: null } });
    expect(killPid).toHaveBeenCalledTimes(1);
    expect(killPid).toHaveBeenCalledWith(4242);
    expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_test_fix_520');
    expect(dropDatabase).toHaveBeenCalledWith('ethical_yoga_dev_fix_520');
    expect(dropDatabase).toHaveBeenCalledTimes(2);
  });

  it('does not call killPid for an orphan with no recorded pid', async () => {
    const registry: Registry = { fix_520: { port: 3101, pid: null } };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    await reapOrphans(registry, new Set(), { dropDatabase, killPid });

    expect(killPid).not.toHaveBeenCalled();
  });

  it('leaves a registry with no orphans untouched', async () => {
    const registry: Registry = { fix_517: { port: 3100, pid: null } };
    const dropDatabase = vi.fn().mockResolvedValue(undefined);
    const killPid = vi.fn();

    const result = await reapOrphans(registry, new Set(['fix_517']), { dropDatabase, killPid });

    expect(result.reaped).toEqual([]);
    expect(result.registry).toEqual(registry);
    expect(dropDatabase).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/worktree/reap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/worktree/side-effects.ts
import { PrismaClient } from '@prisma/client';
import { assertSafeDatabaseName, withDatabaseName } from '../db-provision';

export async function dropDatabaseReal(dbName: string, anyDatabaseUrl: string): Promise<void> {
  assertSafeDatabaseName(dbName);
  const admin = new PrismaClient({ datasources: { db: { url: withDatabaseName(anyDatabaseUrl, 'postgres') } } });
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}"`);
  } finally {
    await admin.$disconnect();
  }
}

export function killPidReal(pid: number): void {
  try {
    process.kill(pid, 0);
    process.kill(pid, 'SIGTERM');
  } catch {
    // already gone — best effort, nothing to do
  }
}
```

```typescript
// src/lib/worktree/reap.ts
import { diffOrphans, removeSlug, writeRegistryLocked, type Registry } from './registry';
import { dbNamesForSlug } from './identity';
import { getLiveSlugs } from './live-slugs';
import { dropDatabaseReal, killPidReal } from './side-effects';

export interface ReapDeps {
  dropDatabase: (dbName: string) => Promise<void>;
  killPid: (pid: number) => void;
}

export async function reapOrphans(
  registry: Registry,
  liveSlugs: ReadonlySet<string>,
  deps: ReapDeps,
): Promise<{ registry: Registry; reaped: string[] }> {
  const orphans = diffOrphans(registry, liveSlugs);
  let next = registry;
  const reaped: string[] = [];
  for (const { slug, entry } of orphans) {
    if (entry.pid !== null) {
      deps.killPid(entry.pid);
    }
    const { test, dev } = dbNamesForSlug(slug);
    await deps.dropDatabase(test);
    await deps.dropDatabase(dev);
    next = removeSlug(next, slug);
    reaped.push(slug);
  }
  return { registry: next, reaped };
}

/** Real IO wired up: live git state in, dropped databases and a persisted registry out. */
export async function runReap(
  gitCommonDir: string,
  registryPath: string,
  anyDatabaseUrl: string,
): Promise<string[]> {
  const liveSlugs = getLiveSlugs(gitCommonDir);
  let reapedSlugs: string[] = [];
  await writeRegistryLocked(registryPath, async (registry) => {
    const { registry: next, reaped } = await reapOrphans(registry, liveSlugs, {
      dropDatabase: (dbName) => dropDatabaseReal(dbName, anyDatabaseUrl),
      killPid: killPidReal,
    });
    reapedSlugs = reaped;
    return next;
  });
  return reapedSlugs;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/worktree/reap.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Refactor `tests/setup/unit-db.ts` to use `provisionDatabase` and `runReap`**

Replace the file's contents entirely with:

```typescript
// tests/setup/unit-db.ts
/**
 * Global setup for the vitest `unit` AND `unit-sweeps` projects: provision
 * and migrate the dedicated test database (docs/test-database.md), and —
 * in a linked worktree — reap any other worktree's orphaned databases and
 * dev-server process (docs/superpowers/specs/2026-09-08-worktree-db-isolation-design.md).
 *
 * `unit-sweeps` is the tier holding the service tests that inject far-future
 * clocks into database-wide sweeps — on a shared database those once
 * completed the seed's future classes and mailed their payment requests.
 * This setup PROVISIONS `DATABASE_URL_TEST` (creates it, migrates it) so
 * those tests have somewhere isolated to run.
 *
 * IT DOES NOT GUARANTEE THEY RUN THERE. The switch is made by
 * `vitest.config.ts`, which resolves both projects' `DATABASE_URL` to
 * `DATABASE_URL_TEST ?? devUrl`. When `DATABASE_URL_TEST` is unset this
 * function returns early and that fallback is the DEV database — the
 * isolation is a value in `.env`, i.e. configuration, not a guard. Suites
 * taking an unscoped destructive write correct this in their own headers;
 * stated here too, because this is the source they copy from.
 *
 * A suite that takes an UNSCOPED destructive write must therefore carry its own
 * runtime guard on the connected database's name, as
 * `waitlist-retention.test.ts` does. CI sets `DATABASE_URL_TEST` explicitly
 * (`.github/workflows/ci.yml`, the `test-unit` job) precisely so that guard does not skip the suite
 * on the merge gate; the early return below is what made it do exactly that.
 */

import { loadEnv } from 'vite';
import { provisionDatabase } from '../../src/lib/db-provision';
import { getWorktreeIdentity } from '../../src/lib/worktree/identity';
import { getRegistryPath } from '../../src/lib/worktree/registry';
import { runReap } from '../../src/lib/worktree/reap';

export default async function setup(): Promise<void> {
  const fileEnv = loadEnv('', process.cwd(), '');
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  const testUrl = process.env.DATABASE_URL_TEST ?? fileEnv.DATABASE_URL_TEST;

  if (!testUrl) {
    console.log('[unit-db] DATABASE_URL_TEST not set — using DATABASE_URL as-is');
    return;
  }
  if (testUrl === devUrl) {
    throw new Error(
      '[unit-db] DATABASE_URL_TEST equals DATABASE_URL — refusing to run unit tests ' +
        'against the dev database. Point DATABASE_URL_TEST at a separate database.',
    );
  }

  const identity = getWorktreeIdentity();
  if (!identity.isMainCheckout) {
    const reaped = await runReap(identity.gitCommonDir, getRegistryPath(identity.gitCommonDir), testUrl);
    if (reaped.length > 0) {
      console.log(`[unit-db] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  }

  await provisionDatabase(testUrl, { seed: false });
  console.log(`[unit-db] unit tests run against ${new URL(testUrl).pathname.slice(1)}`);
}
```

- [ ] **Step 6: Confirm the full unit/unit-sweeps run still passes**

Run: `npm test`
Expected: PASS — on the main checkout `identity.isMainCheckout` is `true` so reap never runs, and behavior matches today exactly.

- [ ] **Step 7: Commit**

```bash
git add src/lib/worktree/side-effects.ts src/lib/worktree/reap.ts src/lib/worktree/reap.test.ts tests/setup/unit-db.ts
git commit -m "feat(worktrees): reap databases and dev-server pids for removed worktrees"
```

---

### Task 7: Detached dev-server spawning

**Files:**
- Create: `src/lib/worktree/dev-server.ts`
- Test: `src/lib/worktree/dev-server.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: nothing from Tasks 1-6.
- Produces: `buildDevServerLogPath(cwd: string): string`, `spawnDevServer(cwd: string, port: number, spawnFn?: typeof import('child_process').spawn): number`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/lib/worktree/dev-server.test.ts
import { describe, it, expect, vi } from 'vitest';
import path from 'path';
import { buildDevServerLogPath, spawnDevServer } from './dev-server';

describe('buildDevServerLogPath', () => {
  it('places the log at the worktree root', () => {
    expect(buildDevServerLogPath('/worktree')).toBe(path.join('/worktree', 'worktree-dev.log'));
  });
});

describe('spawnDevServer', () => {
  it('spawns next dev on the given port, detached, and returns its pid', () => {
    const unref = vi.fn();
    const fakeChild = { pid: 4242, unref };
    const spawnFn = vi.fn().mockReturnValue(fakeChild);

    const pid = spawnDevServer('/worktree', 3100, spawnFn as never);

    expect(pid).toBe(4242);
    expect(unref).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledWith(
      'npx',
      ['next', 'dev', '-p', '3100'],
      expect.objectContaining({ cwd: '/worktree', detached: true }),
    );
  });

  it('throws if the spawned process has no pid', () => {
    const spawnFn = vi.fn().mockReturnValue({ pid: undefined, unref: vi.fn() });
    expect(() => spawnDevServer('/worktree', 3100, spawnFn as never)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/worktree/dev-server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// src/lib/worktree/dev-server.ts
import { spawn as spawnReal } from 'child_process';
import fs from 'fs';
import path from 'path';

export function buildDevServerLogPath(cwd: string): string {
  return path.join(cwd, 'worktree-dev.log');
}

export function spawnDevServer(
  cwd: string,
  port: number,
  spawnFn: typeof spawnReal = spawnReal,
): number {
  const logPath = buildDevServerLogPath(cwd);
  const logFd = fs.openSync(logPath, 'a');
  try {
    const child = spawnFn('npx', ['next', 'dev', '-p', String(port)], {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
    if (child.pid === undefined) {
      throw new Error('failed to spawn next dev — no pid assigned');
    }
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/worktree/dev-server.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Ignore the dev-server log**

Add to `.gitignore`, in the "misc" section alongside `.DS_Store`:

```
/worktree-dev.log
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/worktree/dev-server.ts src/lib/worktree/dev-server.test.ts .gitignore
git commit -m "feat(worktrees): spawn a detached next dev on an allocated port"
```

---

### Task 8: `scripts/worktree-setup.ts` and the `worktree:setup` command

**Files:**
- Create: `scripts/worktree-setup.ts`
- Modify: `.env.example`
- Modify: `package.json` (add script)

**Interfaces:**
- Consumes: `getWorktreeIdentity`, `dbNamesForSlug` (Task 1); `getRegistryPath`, `writeRegistryLocked`, `allocatePort` (Task 3); `writeEnvIfMissing` (Task 4).
- Produces: the `npm run worktree:setup` command; no exported interface (CLI entrypoint).

This script shells out to real `npm install` and touches the real filesystem — it is exercised by the acceptance checks (Task 11), not a unit test, matching every other script task in this plan.

- [ ] **Step 1: Add `INTEGRATION_BASE_URL` to `.env.example`**

In `.env.example`, immediately after the existing `DATABASE_URL_TEST` line, add:

```
# Local development only, worktrees: the port your worktree's dev server runs
# on (allocated by `npm run worktree:setup`) — playwright and the integration
# test tier both read this to reach it instead of :3000. Not needed outside a
# worktree.
# INTEGRATION_BASE_URL="http://localhost:3100"
```

- [ ] **Step 2: Write `scripts/worktree-setup.ts`**

```typescript
// scripts/worktree-setup.ts
import { execSync } from 'child_process';
import path from 'path';
import { getWorktreeIdentity, dbNamesForSlug } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, allocatePort } from '../src/lib/worktree/registry';
import { writeEnvIfMissing } from '../src/lib/worktree/env-file';

const DB_HOST = 'postgresql://yoga:yoga_dev_password@localhost:5432';

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.slug) {
    console.log('[worktree:setup] main checkout — nothing to do');
    return;
  }
  const slug = identity.slug;

  const registryPath = getRegistryPath(identity.gitCommonDir);
  let port = 0;
  await writeRegistryLocked(registryPath, (registry) => {
    const result = allocatePort(registry, slug);
    port = result.port;
    return result.registry;
  });

  console.log('[worktree:setup] running npm install...');
  execSync('npm install', { stdio: 'inherit' });

  const { test, dev } = dbNamesForSlug(slug);
  const envPath = path.resolve(process.cwd(), '.env');
  const examplePath = path.resolve(process.cwd(), '.env.example');
  const wrote = writeEnvIfMissing(envPath, examplePath, {
    DATABASE_URL: `${DB_HOST}/${dev}`,
    DATABASE_URL_TEST: `${DB_HOST}/${test}`,
    INTEGRATION_BASE_URL: `http://localhost:${port}`,
  });

  console.log(`[worktree:setup] slug: ${slug}`);
  console.log(`[worktree:setup] port: ${port}`);
  console.log(`[worktree:setup] databases: ${dev}, ${test}`);
  console.log(wrote ? '[worktree:setup] wrote .env' : '[worktree:setup] .env already exists — left untouched');
  console.log('[worktree:setup] next: npm run worktree:up');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm script**

In `package.json`, in the `"scripts"` block, add after `"db:reset"`:

```json
    "worktree:setup": "tsx scripts/worktree-setup.ts",
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/worktree-setup.ts .env.example package.json
git commit -m "feat(worktrees): add npm run worktree:setup — install, allocate, generate .env"
```

---

### Task 9: `scripts/worktree-up.ts` and `scripts/worktree-down.ts`

**Files:**
- Create: `scripts/worktree-up.ts`
- Create: `scripts/worktree-down.ts`
- Modify: `package.json` (add two scripts)

**Interfaces:**
- Consumes: `getWorktreeIdentity` (Task 1); `getRegistryPath`, `readRegistry`, `writeRegistryLocked`, `allocatePort`, `setPid` (Task 3); `runReap` (Task 6); `provisionDatabase` (Task 5); `spawnDevServer` (Task 7).
- Produces: the `npm run worktree:up` / `npm run worktree:down` commands.

Both scripts shell out to real Postgres, git, and process control — exercised by the acceptance checks (Task 11), not a unit test.

- [ ] **Step 1: Write `scripts/worktree-up.ts`**

```typescript
// scripts/worktree-up.ts
import { loadEnv } from 'vite';
import { getWorktreeIdentity } from '../src/lib/worktree/identity';
import { getRegistryPath, writeRegistryLocked, allocatePort, setPid } from '../src/lib/worktree/registry';
import { runReap } from '../src/lib/worktree/reap';
import { provisionDatabase } from '../src/lib/db-provision';
import { spawnDevServer } from '../src/lib/worktree/dev-server';

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.slug) {
    console.log('[worktree:up] main checkout — run `npm run dev` directly instead');
    return;
  }
  const slug = identity.slug;

  const registryPath = getRegistryPath(identity.gitCommonDir);

  const fileEnv = loadEnv('', process.cwd(), '');
  const devUrl = process.env.DATABASE_URL ?? fileEnv.DATABASE_URL;
  if (!devUrl) {
    throw new Error('[worktree:up] DATABASE_URL not set — run `npm run worktree:setup` first');
  }

  const reaped = await runReap(identity.gitCommonDir, registryPath, devUrl);
  if (reaped.length > 0) {
    console.log(`[worktree:up] reaped orphaned worktree resources: ${reaped.join(', ')}`);
  }

  let port = 0;
  await writeRegistryLocked(registryPath, (registry) => {
    const result = allocatePort(registry, slug);
    port = result.port;
    return result.registry;
  });

  await provisionDatabase(devUrl, { seed: true });

  const pid = spawnDevServer(process.cwd(), port);
  await writeRegistryLocked(registryPath, (registry) => setPid(registry, slug, pid));

  console.log(`[worktree:up] dev server running at http://localhost:${port} (pid ${pid})`);
  console.log(`[worktree:up] INTEGRATION_BASE_URL=http://localhost:${port}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Write `scripts/worktree-down.ts`**

```typescript
// scripts/worktree-down.ts
import { getWorktreeIdentity } from '../src/lib/worktree/identity';
import { getRegistryPath, readRegistry, writeRegistryLocked, setPid } from '../src/lib/worktree/registry';
import { killPidReal } from '../src/lib/worktree/side-effects';

async function main(): Promise<void> {
  const identity = getWorktreeIdentity();
  if (identity.isMainCheckout || !identity.slug) {
    console.log('[worktree:down] main checkout — nothing to do');
    return;
  }
  const slug = identity.slug;

  const registryPath = getRegistryPath(identity.gitCommonDir);
  const registry = readRegistry(registryPath);
  const entry = registry[slug];
  if (!entry) {
    console.log(`[worktree:down] no registry entry for ${slug} — nothing to do`);
    return;
  }

  if (entry.pid !== null) {
    killPidReal(entry.pid);
    console.log(`[worktree:down] stopped pid ${entry.pid}`);
  }

  await writeRegistryLocked(registryPath, (current) => setPid(current, slug, null));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Add the npm scripts**

In `package.json`, after `"worktree:setup"`:

```json
    "worktree:up": "tsx scripts/worktree-up.ts",
    "worktree:down": "tsx scripts/worktree-down.ts",
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add scripts/worktree-up.ts scripts/worktree-down.ts package.json
git commit -m "feat(worktrees): add npm run worktree:up / worktree:down"
```

---

### Task 10: Playwright fails fast instead of silently booting on :3000

**Files:**
- Modify: `playwright.config.ts:59-65`

**Interfaces:**
- Consumes: nothing new — reads `process.env.INTEGRATION_BASE_URL`, already read elsewhere in this same file.

- [ ] **Step 1: Make the change**

Replace the existing `webServer` block:

```typescript
  webServer: {
    command: 'npm run dev',
    url: process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000',
    // CI pre-starts the production build on :3000 before the e2e step;
    // locally this reuses the running dev server.
    reuseExistingServer: true,
  },
```

with:

```typescript
  webServer: {
    // In a worktree (INTEGRATION_BASE_URL set), the dev server is expected
    // to already be running — `npm run worktree:up` starts it. This command
    // only runs when `reuseExistingServer`'s health check against `url`
    // fails, i.e. it was NOT started: fail fast with an actionable message
    // instead of silently booting an unparameterized `next dev` on :3000,
    // using the worktree's isolated database on the wrong port.
    command: process.env.INTEGRATION_BASE_URL
      ? `node -e "console.error('INTEGRATION_BASE_URL is set to ${process.env.INTEGRATION_BASE_URL} but nothing is listening there. Run: npm run worktree:up'); process.exit(1)"`
      : 'npm run dev',
    url: process.env.INTEGRATION_BASE_URL ?? 'http://localhost:3000',
    // CI pre-starts the production build on :3000 before the e2e step;
    // locally this reuses the running dev server.
    reuseExistingServer: true,
  },
```

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Verify the unchanged path**

Run: `INTEGRATION_BASE_URL= npx playwright test --list` (from the main checkout, `:3000` already running per this repo's standing dev-server convention)
Expected: lists specs without error — confirms `command` still resolves to `'npm run dev'` when `INTEGRATION_BASE_URL` is unset, matching today's behavior exactly.

- [ ] **Step 4: Commit**

```bash
git add playwright.config.ts
git commit -m "fix(worktrees): fail fast when INTEGRATION_BASE_URL is set but unreachable"
```

---

### Task 11: Acceptance checks against the real container and worktrees

**Files:** none (verification only — no code changes).

This task runs the spec's acceptance criteria for real, in this order, each building on the last:

- [ ] **Step 1: Main checkout is unchanged**

From the primary checkout (not a worktree): `npm run verify`.
Expected: PASS, identical to before this plan — `getWorktreeIdentity()` reports `isMainCheckout: true` there, so every new code path is a no-op.

- [ ] **Step 2: `worktree:setup` bootstraps a fresh worktree**

```bash
git worktree add .claude/worktrees/verify-517 -b verify-517-worktree-isolation main
cd .claude/worktrees/verify-517
npm run worktree:setup
cat .env | grep -E 'DATABASE_URL|INTEGRATION_BASE_URL'
```

Expected: `node_modules` populated, `.env` created with `ethical_yoga_dev_verify_517`, `ethical_yoga_test_verify_517`, and an `INTEGRATION_BASE_URL` at an allocated port. Re-running `npm run worktree:setup` immediately after: `.env` is byte-identical (diff empty).

- [ ] **Step 3: `worktree:up` boots an isolated app + database**

```bash
npm run worktree:up
curl -sf "$(grep INTEGRATION_BASE_URL .env | cut -d'"' -f2)" >/dev/null && echo "app is up"
```

Expected: prints the allocated port and pid; the database `ethical_yoga_dev_verify_517` exists, migrated and seeded (verify via `npx prisma studio` or a one-off query); the app responds.

- [ ] **Step 4: `npm test` from this worktree does not contend with any other worktree**

From this worktree: `npm test`, while concurrently (in a second terminal, from the primary checkout) polling `pg_stat_activity`:

```bash
docker exec fairyoga-db-1 psql -U yoga -d postgres -c \
  "SELECT datname, count(*) FROM pg_stat_activity WHERE datname LIKE 'ethical_yoga%' GROUP BY datname;"
```

Expected: while this worktree's `npm test` runs, activity is scoped to `ethical_yoga_test_verify_517` — zero rows against any other worktree's database, and zero rows against this worktree's database once its own `npm test` completes.

- [ ] **Step 5: `worktree:up && playwright test` runs integration/e2e locally**

```bash
npx playwright test --project=chromium -g "@smoke" || npx playwright test --project=chromium
```

(Substitute any small existing spec if no `@smoke` tag exists.) Expected: green against `INTEGRATION_BASE_URL`'s port, using `ethical_yoga_dev_verify_517` — not `:3000`, not the primary checkout's `ethical_yoga`.

- [ ] **Step 6: Removing the worktree gets reaped from anywhere else**

```bash
cd /Users/ivohofland/Projects/fair.yoga
npm run worktree:down --prefix .claude/worktrees/verify-517
git worktree remove .claude/worktrees/verify-517
```

Then, from any *other* worktree (or the main checkout), run `npm test` and check the log for `[unit-db] reaped orphaned worktree resources: verify_517`. Confirm both `ethical_yoga_dev_verify_517` and `ethical_yoga_test_verify_517` are gone:

```bash
docker exec fairyoga-db-1 psql -U yoga -d postgres -c \
  "SELECT datname FROM pg_database WHERE datname LIKE '%verify_517%';"
```

Expected: zero rows.

- [ ] **Step 7: Note which acceptance criteria were verified**

In the PR body, note that this task's steps 1-6 verified the spec's six "Acceptance criteria" items one-to-one (spec §"Acceptance criteria") — no file changes needed for this step.

---

### Task 12: Documentation updates

**Files:**
- Modify: `docs/test-database.md`
- Modify: `.claude/skills/solve-issue/SKILL.md:247-254`
- Modify: `.claude/skills/verify/SKILL.md`

- [ ] **Step 1: `docs/test-database.md` §5**

Replace the "## 5. Future extension (not now)" section (currently describing per-worktree isolation as future work) with:

```markdown
## 5. Per-worktree isolation

Implemented — `docs/superpowers/specs/2026-09-08-worktree-db-isolation-design.md`.
Every linked worktree gets its own `ethical_yoga_test_<slug>` (this section's
`unit`/`unit-sweeps` databases) and its own seeded `ethical_yoga_dev_<slug>`
plus a private `next dev` on its own port, inside the same shared
`fairyoga-db-1` container — no per-worktree Docker container. Run `npm run
worktree:setup` once per worktree, then `npm run worktree:up` to boot the
app; `integration`/e2e read `INTEGRATION_BASE_URL` for that port instead of
`:3000`. Orphaned resources from a removed worktree are reaped
automatically the next time any `npm test` runs anywhere.
```

Also update the `3.1` table's `integration` row ("dev `ethical_yoga` (unchanged — must match the running app)") to read: "dev `ethical_yoga` in the main checkout, `ethical_yoga_dev_<slug>` in a worktree — must match whichever app is running".

- [ ] **Step 2: `.claude/skills/solve-issue/SKILL.md`**

Replace the bullet at lines 247-254 (starting "**In a worktree, integration and e2e can't run locally**") with:

```markdown
- **In a worktree, integration and e2e run against the worktree's own isolated
  app, not `:3000`.** Run `npm run worktree:setup` once, then `npm run
  worktree:up` before `--project integration` or `playwright test` — both
  read `INTEGRATION_BASE_URL` automatically. `npm run worktree:down` stops
  the dev server when done; forgetting it is not a resource leak, an
  opportunistic reap on the next `npm test` anywhere cleans it up.
  `docs/superpowers/specs/2026-09-08-worktree-db-isolation-design.md` has
  the mechanism.
```

- [ ] **Step 3: `.claude/skills/verify/SKILL.md`**

In the "## Launch" section, after the existing `:3000` bullet, add:

```markdown
- **In a worktree:** `npm run worktree:setup` (once), then `npm run worktree:up` —
  boots a private `next dev` on its own port against its own seeded database.
  The "never kill or restart :3000" rule above is about the *main checkout's*
  server and doesn't apply to a worktree's own instance; stop it with `npm run
  worktree:down` when done.
```

- [ ] **Step 4: Commit**

```bash
git add docs/test-database.md .claude/skills/solve-issue/SKILL.md .claude/skills/verify/SKILL.md
git commit -m "docs(worktrees): document worktree:setup/up/down across test-database, solve-issue, verify"
```

---

## Plan self-review

**Spec coverage:** Goals 1-6 — Task 1 (naming) + Task 6 (reap) + Task 9 (`worktree:up` provisioning) cover Goal 6 (worktree's own `DATABASE_URL` by default); Task 8 covers Goal 4 (`npm install` + `.env` folded into one command); Task 6 covers Goal 5 (self-healing reap); Tasks 1-10 together cover Goals 1-3. Non-goals are respected: no pnpm migration, no CI changes, no per-worktree container anywhere in this plan. Error-handling cases from the spec — registry corruption (Task 3's `readRegistry` catch-all), port collision (spec accepts a hard failure, Task 9 does not swallow the `next dev` bind error), `.env` precondition (Task 9's `worktree-up.ts` throws if `DATABASE_URL` unset), Playwright's fallback (Task 10) — all have a task. Documentation updates named in the spec are Task 12, one bullet each.

**Placeholder scan:** no TBD/TODO; every test has real assertions; every implementation step has complete code, not a description of code.

**Type consistency:** `Registry`/`RegistryEntry` (Task 3) used identically in Tasks 6, 9; `WorktreeIdentity`'s `slug: string | null` is narrowed with an explicit `if (identity.isMainCheckout || !identity.slug) return` guard immediately followed by `const slug = identity.slug` in every script (Tasks 8, 9) — that local `slug: string` is what every later call in the same function uses, not `identity.slug` again, since narrowing a destructured property does not persist across an `await` boundary in TypeScript's control-flow analysis.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
