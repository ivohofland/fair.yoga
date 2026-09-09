# Worktree Registry Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four findings issue #528 deferred from PR #527's review — branded `RawName`/`DbSlug` types, an actionable error for the `runReap`-before-`allocatePort` collision ambiguity, visibility into rows `reapEntry` fails to reap, and a guarded `resolveIdentity` for an unsanitizable worktree name.

**Architecture:** Four sequential tasks against `src/lib/worktree/{identity,registry,reap,live-slugs}.ts` and their three script consumers (`scripts/worktree-{setup,up,down}.ts`, `tests/setup/unit-db.ts`). Task 1 (types) must land first — it changes signatures every other task's new code is written against. Tasks 2 and 3 both touch `scripts/worktree-setup.ts` and `scripts/worktree-up.ts`, so they run in this order, each building on the previous task's edits to those two files. Task 4 touches only `identity.ts` and is independent of 2/3.

**Tech Stack:** TypeScript (strict), Vitest, tsx (script runtime).

**Spec:** `docs/superpowers/specs/2026-09-09-worktree-registry-followups-design.md`

## Global Constraints

- Branded-type idiom (already established by `WeekKeyBrand` in `src/lib/timezone.ts`, `browserNonceBrand` in `src/lib/auth/origin-nonce.ts`): `declare const xBrand: unique symbol; export type X = string & { readonly [xBrand]: true };`
- `Registry`'s key type (`Record<string, RegistryEntry>`) is never branded — it is deliberately dual-meaning during the migration window (a legacy row's key is a bare `DbSlug`; a migrated row's key is a `RawName`).
- Every `as RawName` / `as DbSlug` cast sits at a point already proven safe by surrounding code (a runtime check, or a documented equivalence) — never a blind assertion. Add a one-line comment only where that justification isn't already obvious from the three lines around it (this project's Comment Discipline: state the non-obvious WHY, nothing else).
- `npm run typecheck` = `tsc --noEmit`. `npm run verify` = typecheck + lint + full test suite (needs the app live — it already is, on this worktree's own port). Fast inner loop for a single file: `npx vitest run --project unit src/lib/worktree/<file>.test.ts`.
- This plan executes inside the worktree already set up at the repo root (`npm run worktree:setup && npm run worktree:up` have already run; the dev server is live on this worktree's own allocated port). Do not touch `:3000` or any other worktree.
- Never edit an applied Prisma migration. Not applicable to this plan (no schema changes), noted only because it's a standing project rule.

---

### Task 1: Branded `RawName` / `DbSlug` types

**Files:**
- Modify: `src/lib/worktree/identity.ts`
- Modify: `src/lib/worktree/registry.ts`
- Modify: `src/lib/worktree/reap.ts`
- Modify: `src/lib/worktree/live-slugs.ts`
- Test: `src/lib/worktree/identity.test.ts`
- Test: `src/lib/worktree/registry.test.ts` (lines 1–172 only — the rest of the file, lock/lease logic from `getRegistryPath` onward, is untouched)
- Test: `src/lib/worktree/reap.test.ts`
- Test: `src/lib/worktree/live-slugs.test.ts` (lines 1–31 only — `listWorktreeAdminEntries`'s describe block, lines 33–104, asserts only on function *output* via `.toEqual`, which needs no casts; leave it untouched)

**Interfaces:**
- Produces: `RawName`, `DbSlug` (exported from `identity.ts`); `WorktreeIdentity.rawName: RawName | null`, `.dbSlug: DbSlug | null`; `allocatePort(registry: Registry, rawName: RawName, dbSlug: DbSlug, range?): {registry: Registry; port: number}`; `dbNamesForSlug(slug: DbSlug): DatabaseNames`; `RegistryEntry.dbSlug: DbSlug`; `WorktreeAdminEntry.rawName: RawName`; `computeLiveWorktreeNames(entries): Set<RawName>`; `getLiveWorktreeNames(gitCommonDir): Set<RawName>`; `reapOrphans(registry: Registry, liveRawNames: ReadonlySet<RawName>, deps: ReapDeps): Promise<ReapResult>`. All consumed by Tasks 2–4.
- No behavior change in this task — every existing test assertion (expected values, thrown messages) stays identical. Only types and, where a plain string now needs to satisfy a branded parameter or field, an `as RawName`/`as DbSlug` cast.

This task is a type-level refactor, not new behavior, so its red/green cycle is adapted: "RED" is `npm run typecheck` failing (expected — it's the compiler newly catching what plain `string` typing let through); "GREEN" is `npm run typecheck` passing *and* every pre-existing test assertion in the four touched test files still passing unchanged, proving no behavior moved.

- [ ] **Step 1: Retype the production files**

Replace the full content of `src/lib/worktree/identity.ts` with:

```ts
import { execSync } from 'child_process';
import path from 'path';

const MAX_SLUG_LENGTH = 40;

declare const rawNameBrand: unique symbol;
declare const dbSlugBrand: unique symbol;

/** Git's own admin-dir basename — unique by git's own construction (see
 *  WorktreeIdentity.rawName's docblock). Obtained only from resolveIdentity. */
export type RawName = string & { readonly [rawNameBrand]: true };
/** sanitizeSlug(rawName) — Postgres-identifier-safe, not guaranteed unique.
 *  Obtained only from resolveIdentity or a caller that reasons explicitly
 *  about the rawName/dbSlug distinction. */
export type DbSlug = string & { readonly [dbSlugBrand]: true };

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

export function dbNamesForSlug(slug: DbSlug): DatabaseNames {
  return {
    test: `ethical_yoga_test_${slug}`,
    dev: `ethical_yoga_dev_${slug}`,
  };
}

/**
 * True only for the shared `ethical_yoga_test` or a per-worktree
 * `ethical_yoga_test_<slug>` — anchored at both ends, so a name merely
 * ending in `_test` or `_test_<slug>` (e.g. a dev database whose slug
 * contains "test") does not match.
 */
export function isTestDatabaseName(name: string): boolean {
  return /^ethical_yoga_test(_[a-z0-9_]+)?$/.test(name);
}

export interface WorktreeIdentity {
  isMainCheckout: boolean;
  /**
   * Git's own admin-dir basename — empirically verified unique on creation;
   * see docs/superpowers/specs/2026-09-09-worktree-registry-key-collision-design.md §1.
   */
  rawName: RawName | null;
  /** sanitizeSlug(rawName) — Postgres-identifier-safe, not guaranteed unique. */
  dbSlug: DbSlug | null;
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
  const rawName = isMainCheckout ? null : (basename(gitDir) as RawName);
  return {
    isMainCheckout,
    rawName,
    dbSlug: rawName === null ? null : (sanitizeSlug(rawName) as DbSlug),
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

In `src/lib/worktree/registry.ts`:
1. Add `import type { RawName, DbSlug } from './identity';` to the top imports.
2. Change `RegistryEntry.dbSlug: string;` to `RegistryEntry.dbSlug: DbSlug;` (keep the existing docblock line above it unchanged).
3. Change `allocatePort`'s signature from `(registry: Registry, rawName: string, dbSlug: string, range: PortRange = DEFAULT_PORT_RANGE)` to `(registry: Registry, rawName: RawName, dbSlug: DbSlug, range: PortRange = DEFAULT_PORT_RANGE)`. Leave the function body untouched — every existing statement inside it (`registry[rawName]`, `entry.dbSlug === dbSlug`, the thrown `Error`, `{ ...registry, [rawName]: { port, pid: null, dbSlug } }`) already type-checks against the new parameter types with no further edits.
4. In `readRegistry`'s backfill loop, change `backfilled[key] = { ...entry, dbSlug: entry.dbSlug ?? key };` to `backfilled[key] = { ...entry, dbSlug: (entry.dbSlug ?? key) as DbSlug };` — safe because under the pre-migration scheme the key *was* always exactly `sanitizeSlug(rawName)`, so a missing `dbSlug` field is correctly backfilled from the key.
5. Leave every other export (`setPid`, `removeEntry`, `diffOrphans`, `OrphanEntry`, `getRegistryPath`, the lock functions) untouched — their `key`/`liveKeys` parameters stay plain `string` on purpose, matching `Registry`'s dual-meaning key.

In `src/lib/worktree/live-slugs.ts`, replace the full file content with:

```ts
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
```

In `src/lib/worktree/reap.ts`:
1. Change the import line from `import { dbNamesForSlug, sanitizeSlug } from './identity';` to `import { dbNamesForSlug, sanitizeSlug, type RawName, type DbSlug } from './identity';`.
2. Change `sanitizesTo`'s signature from `(rawName: string, dbSlug: string): boolean` to `(rawName: RawName, dbSlug: DbSlug): boolean`. Body unchanged.
3. Change `reapOrphans`'s signature from `(registry: Registry, liveRawNames: ReadonlySet<string>, deps: ReapDeps)` to `(registry: Registry, liveRawNames: ReadonlySet<RawName>, deps: ReapDeps)`.
4. Inside `reapOrphans`'s loop, change `if (liveRawNames.has(key)) {` to `if (liveRawNames.has(key as RawName)) {` — `key` here is `Registry`'s deliberately-plain-string key; this probes whether it happens to already be a live raw name.
5. Inside the `key === entry.dbSlug` branch, change `const target = [...liveRawNames].find((name) => sanitizesTo(name, key));` to `const target = [...liveRawNames].find((name) => sanitizesTo(name, key as DbSlug));` — safe because the `if (key === entry.dbSlug)` condition immediately above already proves `key` is this row's own `DbSlug` value.
6. `scripts/worktree-setup.ts`, `scripts/worktree-up.ts`, `scripts/worktree-down.ts` need **no changes** in this task — their local `rawName`/`dbSlug` consts are narrowed automatically from `WorktreeIdentity`'s now-branded fields after each script's existing `!identity.rawName || !identity.dbSlug` guard, and every call site already passes those exact variables positionally in the correct order.

- [ ] **Step 2: Verify RED — confirm typecheck fails exactly where expected**

Run: `npm run typecheck`

Expected: FAILS, with every error located in `src/lib/worktree/identity.test.ts`, `registry.test.ts`, `reap.test.ts`, or `live-slugs.test.ts` — a string literal not assignable to `RawName`/`DbSlug`. If any error appears outside these four files, stop and re-examine Step 1 (something in the "no changes needed" claims above was wrong).

- [ ] **Step 3: Fix the four test files' fixtures — casts only, no assertion changes**

Rule: wherever `npm run typecheck` reports a string literal not assignable to `RawName` or `DbSlug`, add `as RawName` / `as DbSlug` directly to that literal. Never change an expected value, a thrown-message regex, or a test's behavior — every existing assertion must keep passing unchanged after this step. Two exceptions, both because they represent literal on-disk JSON rather than a typed `Registry` value, and must **not** be cast: the `JSON.stringify({...})` arguments to `fs.writeFileSync` in `registry.test.ts`'s and `reap.test.ts`'s round-trip tests (e.g. `fs.writeFileSync(registryPath, JSON.stringify({ fix_517: { port: 3100, pid: null } }))`), and any `.toEqual(...)`/`.toBe(...)` *expected*-side argument (Vitest's `toEqual`/`toBe` accept an independently-typed argument, so a plain string literal there already compiles with no cast needed — if `typecheck` reports an error inside a `.toEqual(...)` call, that's a sign the literal is in the wrong place, not that it needs a cast).

Worked examples — apply this pattern to every remaining error `typecheck` reports:

In `identity.test.ts`, add `type DbSlug` to the existing import line (`import { sanitizeSlug, dbNamesForSlug, resolveIdentity, isTestDatabaseName, type DbSlug, type RawName } from './identity';`) and fix the one call site:

```ts
describe('dbNamesForSlug', () => {
  it('prefixes the slug for both database families', () => {
    expect(dbNamesForSlug('fix_517' as DbSlug)).toEqual({
      test: 'ethical_yoga_test_fix_517',
      dev: 'ethical_yoga_dev_fix_517',
    });
  });
});
```

The `resolveIdentity` describe block (lines 59–94) needs **no changes** — every assertion there is `.toEqual(...)` against `resolveIdentity`'s return value, which needs no cast (see the rule above).

In `registry.test.ts`, add `import type { RawName, DbSlug } from './identity';` below the existing `from './registry'` import. Two worked examples — a direct `allocatePort` argument, and a `Registry`-typed fixture:

```ts
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
```

Apply the same pattern to every other `allocatePort(...)` call (its 2nd and 3rd positional args) and every `Registry`-typed object literal's `dbSlug:` field in this file, in the `allocatePort`, `setPid`, `removeEntry`, `diffOrphans`, and `readRegistry / writeRegistryLocked` describe blocks (lines 23–172). `setPid(existing, 'fix-517', 4242)` and `removeEntry(existing, 'fix-517')` calls need **no cast** on their string argument — that parameter is `key: string`, intentionally unbranded. Inside `readRegistry / writeRegistryLocked`, the `writeRegistryLocked(registryPath, () => ({ 'fix-517': { port: 3100, pid: null, dbSlug: 'fix_517' } }))`-shaped calls (three of them) need the cast on `dbSlug` because the arrow function's return type is checked against `Registry`; the `fs.writeFileSync(registryPath, JSON.stringify({...}))`-shaped calls do not (see the exception above). Lines 174 onward (`getRegistryPath`, `isPidAlive`, `isLockStale`, `acquireLock`/`releaseLock`, `assertLockHeld`, `multi-process concurrent locking`) are entirely unaffected — do not modify them.

In `reap.test.ts`, add `import type { RawName, DbSlug } from './identity';`. Every `Registry`-typed `const registry: Registry = {...}` literal's `dbSlug:` field needs `as DbSlug`; every `new Set([...])` passed as `reapOrphans`'s second argument needs the whole expression cast: `new Set([...]) as ReadonlySet<RawName>`. One worked example:

```ts
it('kills the pid, drops both databases, and removes the entry for each orphan', async () => {
  const registry: Registry = {
    fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug },
    fix_520: { port: 3101, pid: 4242, dbSlug: 'fix_520' as DbSlug },
  };
  const dropDatabase = vi.fn().mockResolvedValue(undefined);
  const killPid = vi.fn();

  const result = await reapOrphans(registry, new Set(['fix_517']) as ReadonlySet<RawName>, { dropDatabase, killPid });

  expect(result.reaped).toEqual(['fix_520']);
  expect(result.registry).toEqual({ fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' } });
  // ... rest of the test's assertions unchanged
});
```

Copy every assertion from the file exactly as it stands today — this task adds casts only; it must not change any expected value.

Apply the same two rules (`Registry` literal's `dbSlug:` → cast; `reapOrphans`'s live-name `Set` argument → cast the whole `new Set([...])`) to every test in the file, including the `migration awareness` and `readRegistry -> reapOrphans (real JSON round-trip)` nested `describe` blocks. The one exception, matching `registry.test.ts`'s rule: `fs.writeFileSync(registryPath, JSON.stringify({ fix_517: { port: 3100, pid: 4242 } }))` in the round-trip test stays untouched — it represents real on-disk pre-migration JSON.

In `live-slugs.test.ts`, add `import type { RawName } from './identity';` below the existing import. Fix `computeLiveWorktreeNames`'s three input-array literals (lines 9–12, 24–27 — two call sites, three total array-literal objects across them):

```ts
describe('computeLiveWorktreeNames', () => {
  it('keeps only entries whose working directory still exists', () => {
    const result = computeLiveWorktreeNames([
      { rawName: 'fix-517' as RawName, workingDirExists: true },
      { rawName: 'fix-520' as RawName, workingDirExists: false },
    ]);
    expect(result).toEqual(new Set(['fix-517']));
  });

  it('returns an empty set for no entries', () => {
    expect(computeLiveWorktreeNames([])).toEqual(new Set());
  });

  it('keeps two admin-dir names that would have collided under the old sanitize-then-compare approach', () => {
    const result = computeLiveWorktreeNames([
      { rawName: 'fix-517' as RawName, workingDirExists: true },
      { rawName: 'fix_517' as RawName, workingDirExists: true },
    ]);
    expect(result).toEqual(new Set(['fix-517', 'fix_517']));
    expect(result.size).toBe(2);
  });
});
```

`listWorktreeAdminEntries`'s describe block (lines 33–104) needs **no changes** — every assertion there is `.toEqual(...)` against the function's return value.

- [ ] **Step 4: Add the compile-time brand pins**

Matching `src/lib/timezone.test.ts:468-475`'s existing pattern exactly (an unexported function, `@ts-expect-error` on the line that must fail to compile, an `eslint-disable-next-line` for the unused function).

At the end of `identity.test.ts`:

```ts
/**
 * Compile-time assertion that `RawName` and `DbSlug` cannot be assigned from
 * a plain string without a cast, and that a `RawName` cannot stand in for a
 * `DbSlug` at `dbNamesForSlug` (#528).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _rawNameBrandRejectsPlainString(s: string): RawName {
  // @ts-expect-error Plain string cannot be assigned to RawName
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _dbSlugBrandRejectsPlainString(s: string): DbSlug {
  // @ts-expect-error Plain string cannot be assigned to DbSlug
  return s;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _dbNamesForSlugRejectsRawName(rawName: RawName) {
  // @ts-expect-error A RawName is not a DbSlug
  return dbNamesForSlug(rawName);
}
```

At the end of `registry.test.ts`:

```ts
/**
 * Compile-time assertion that allocatePort's rawName and dbSlug parameters
 * cannot be swapped positionally (#528 — three review rounds on #527 had to
 * verify this by hand at every call site).
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _allocatePortArgsCannotBeSwapped(registry: Registry, rawName: RawName, dbSlug: DbSlug): void {
  // @ts-expect-error rawName and dbSlug must not be swappable positionally
  allocatePort(registry, dbSlug, rawName);
}
```

- [ ] **Step 5: Verify GREEN**

Run: `npm run typecheck`
Expected: PASSES with zero errors.

Run: `npx vitest run --project unit src/lib/worktree/`
Expected: PASSES — same test count as the pre-task baseline (109 tests across 8 files), zero failures. If any assertion's expected value differs from before this task, that's a bug in this task — fix the fixture, not the assertion.

- [ ] **Step 6: Commit**

```bash
git add src/lib/worktree/identity.ts src/lib/worktree/registry.ts src/lib/worktree/reap.ts src/lib/worktree/live-slugs.ts src/lib/worktree/identity.test.ts src/lib/worktree/registry.test.ts src/lib/worktree/reap.test.ts src/lib/worktree/live-slugs.test.ts
git commit -m "$(cat <<'EOF'
fix(worktree): brand RawName/DbSlug so allocatePort's args can't swap (#528)

Adds RawName/DbSlug branded types (matching the existing WeekKeyBrand
idiom) threaded through WorktreeIdentity, allocatePort, dbNamesForSlug,
RegistryEntry, and live-slugs.ts. Registry's own key type stays
unbranded — it's deliberately dual-meaning during the migration window.
Two @ts-expect-error compile pins prove the brand actually rejects a
plain string and that allocatePort's two positional args can't be
swapped, the exact defect three review rounds on #527 had to check by
hand.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `RegistryCollisionError` and the `runReap`-before-`allocatePort` hint

**Files:**
- Modify: `src/lib/worktree/registry.ts`
- Modify: `scripts/worktree-setup.ts`
- Modify: `scripts/worktree-up.ts`
- Test: `src/lib/worktree/registry.test.ts`

**Interfaces:**
- Consumes: `Registry`, `RegistryEntry` (Task 1), `RawName`, `DbSlug` (Task 1).
- Produces: `RegistryCollisionError` (class, with `rawName: string`, `dbSlug: string`, `collidingKey: string`, `collidingKeyIsLegacyShaped: boolean`), `explainCollision(err: RegistryCollisionError, reapFailed: boolean): Error` — both exported from `registry.ts`. Not consumed by Tasks 3 or 4.

- [ ] **Step 1: Write the failing tests**

In `registry.test.ts`, add `RegistryCollisionError` and `explainCollision` to the import list from `./registry`. Replace the existing collision test in the `allocatePort` describe block:

```ts
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
```

(This replaces Task 1's `'throws on a dbSlug collision between two different rawName keys, naming both'` test with the same assertion plus type/field checks, and adds one new test — both belong to this task since they test `RegistryCollisionError`, which doesn't exist until Step 2 below.)

Add a new top-level describe block, after the `allocatePort` describe block:

```ts
describe('explainCollision', () => {
  it('returns the original error unchanged when reap did not fail', () => {
    const err = new RegistryCollisionError('fix-517', 'fix_517', 'fix_517');
    expect(explainCollision(err, false)).toBe(err);
  });

  it('returns the original error unchanged when the colliding key is not legacy-shaped, even if reap failed', () => {
    const err = new RegistryCollisionError('fix_517', 'fix_517', 'fix-517');
    expect(err.collidingKeyIsLegacyShaped).toBe(false);
    expect(explainCollision(err, true)).toBe(err);
  });

  it('enriches the message when reap failed and the colliding key is legacy-shaped', () => {
    const err = new RegistryCollisionError('fix-517', 'fix_517', 'fix_517');
    expect(err.collidingKeyIsLegacyShaped).toBe(true);
    const result = explainCollision(err, true);
    expect(result).not.toBe(err);
    expect(result.message).toContain(err.message);
    expect(result.message).toMatch(/reap\/migration sweep failed/);
    expect(result.message).toMatch(/own not-yet-migrated legacy registry entry/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/lib/worktree/registry.test.ts`
Expected: FAILS — `RegistryCollisionError` and `explainCollision` are not exported from `./registry` yet (import error / undefined).

- [ ] **Step 3: Implement**

In `src/lib/worktree/registry.ts`, insert this class and function immediately before `allocatePort`'s existing definition:

```ts
export class RegistryCollisionError extends Error {
  readonly rawName: string;
  readonly dbSlug: string;
  readonly collidingKey: string;
  /** True when the colliding row's own registry key textually equals this
   *  run's dbSlug — i.e. that row is legacy-shaped (unmigrated), so it could
   *  be this worktree's own not-yet-migrated past self rather than a
   *  genuinely different worktree. See explainCollision. */
  readonly collidingKeyIsLegacyShaped: boolean;

  constructor(rawName: string, dbSlug: string, collidingKey: string) {
    super(
      `allocatePort: worktree "${rawName}" sanitizes to database slug "${dbSlug}", which is already claimed by ` +
        `registered worktree "${collidingKey}" — rename one of the two worktree directories to resolve the collision.`,
    );
    this.name = 'RegistryCollisionError';
    this.rawName = rawName;
    this.dbSlug = dbSlug;
    this.collidingKey = collidingKey;
    this.collidingKeyIsLegacyShaped = collidingKey === dbSlug;
  }
}

/**
 * Enriches a RegistryCollisionError with a hint when the collision could
 * plausibly be against this worktree's own not-yet-migrated legacy row
 * rather than a genuinely different worktree — see
 * docs/superpowers/specs/2026-09-09-worktree-registry-followups-design.md §2.
 * Returns `err` unchanged otherwise.
 */
export function explainCollision(err: RegistryCollisionError, reapFailed: boolean): Error {
  if (!reapFailed || !err.collidingKeyIsLegacyShaped) {
    return err;
  }
  return new Error(
    `${err.message}\n` +
      'note: the reap/migration sweep failed earlier in this run (see the warning above) — this collision ' +
      "may be against this worktree's own not-yet-migrated legacy registry entry, not a genuinely different " +
      'worktree. Re-run this command: if the reap sweep succeeds, migration happens automatically and the ' +
      'collision should clear.',
  );
}
```

Then change `allocatePort`'s collision branch from:

```ts
  const collision = Object.entries(registry).find(([, entry]) => entry.dbSlug === dbSlug);
  if (collision) {
    const [collidingKey] = collision;
    throw new Error(
      `allocatePort: worktree "${rawName}" sanitizes to database slug "${dbSlug}", which is already claimed by ` +
        `registered worktree "${collidingKey}" — rename one of the two worktree directories to resolve the collision.`,
    );
  }
```

to:

```ts
  const collision = Object.entries(registry).find(([, entry]) => entry.dbSlug === dbSlug);
  if (collision) {
    const [collidingKey] = collision;
    throw new RegistryCollisionError(rawName, dbSlug, collidingKey);
  }
```

In `scripts/worktree-setup.ts`, change the import line from:

```ts
import { getRegistryPath, writeRegistryLocked, allocatePort } from '../src/lib/worktree/registry';
```

to:

```ts
import { getRegistryPath, writeRegistryLocked, allocatePort, RegistryCollisionError, explainCollision } from '../src/lib/worktree/registry';
```

Then change:

```ts
  try {
    const reaped = await runReap(identity.gitCommonDir, registryPath, `${DB_HOST}/postgres`);
    if (reaped.length > 0) {
      console.log(`[worktree:setup] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  } catch (err) {
    console.warn('[worktree:setup] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }

  let port = 0;
  await writeRegistryLocked(registryPath, (registry) => {
    const result = allocatePort(registry, rawName, dbSlug);
    port = result.port;
    return result.registry;
  });
```

to:

```ts
  let reapFailed = false;
  try {
    const reaped = await runReap(identity.gitCommonDir, registryPath, `${DB_HOST}/postgres`);
    if (reaped.length > 0) {
      console.log(`[worktree:setup] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  } catch (err) {
    reapFailed = true;
    console.warn('[worktree:setup] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }

  let port = 0;
  try {
    await writeRegistryLocked(registryPath, (registry) => {
      const result = allocatePort(registry, rawName, dbSlug);
      port = result.port;
      return result.registry;
    });
  } catch (err) {
    throw err instanceof RegistryCollisionError ? explainCollision(err, reapFailed) : err;
  }
```

In `scripts/worktree-up.ts`, change the import line from:

```ts
import { getRegistryPath, writeRegistryLocked, allocatePort, setPid } from '../src/lib/worktree/registry';
```

to:

```ts
import { getRegistryPath, writeRegistryLocked, allocatePort, setPid, RegistryCollisionError, explainCollision } from '../src/lib/worktree/registry';
```

Then change:

```ts
  try {
    const reaped = await runReap(identity.gitCommonDir, registryPath, devUrl);
    if (reaped.length > 0) {
      console.log(`[worktree:up] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  } catch (err) {
    console.warn('[worktree:up] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }

  let port = 0;
  let alreadyRunning = null as { port: number; pid: number } | null;
  await writeRegistryLocked(registryPath, (registry) => {
    const existing = registry[rawName];
    if (existing?.pid != null && isPidAlive(existing.pid)) {
      alreadyRunning = { port: existing.port, pid: existing.pid };
      return registry;
    }
    const result = allocatePort(registry, rawName, dbSlug);
    port = result.port;
    return result.registry;
  });
```

to:

```ts
  let reapFailed = false;
  try {
    const reaped = await runReap(identity.gitCommonDir, registryPath, devUrl);
    if (reaped.length > 0) {
      console.log(`[worktree:up] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  } catch (err) {
    reapFailed = true;
    console.warn('[worktree:up] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }

  let port = 0;
  let alreadyRunning = null as { port: number; pid: number } | null;
  try {
    await writeRegistryLocked(registryPath, (registry) => {
      const existing = registry[rawName];
      if (existing?.pid != null && isPidAlive(existing.pid)) {
        alreadyRunning = { port: existing.port, pid: existing.pid };
        return registry;
      }
      const result = allocatePort(registry, rawName, dbSlug);
      port = result.port;
      return result.registry;
    });
  } catch (err) {
    throw err instanceof RegistryCollisionError ? explainCollision(err, reapFailed) : err;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/worktree/registry.test.ts`
Expected: PASSES, all tests including the three new/changed ones.

Run: `npm run typecheck`
Expected: PASSES — confirms `worktree-setup.ts`/`worktree-up.ts` still compile (these two scripts have no test file; typecheck is their only automated check in this task).

- [ ] **Step 5: Manually confirm the scripts still run cleanly**

Run: `npm run worktree:setup` (in this worktree — safe, it's already been run once as this worktree's own baseline setup)
Expected: succeeds exactly as before, no `RegistryCollisionError` (this worktree has no collision).

- [ ] **Step 6: Commit**

```bash
git add src/lib/worktree/registry.ts scripts/worktree-setup.ts scripts/worktree-up.ts src/lib/worktree/registry.test.ts
git commit -m "$(cat <<'EOF'
fix(worktree): explain an allocatePort collision after a failed reap (#528)

allocatePort now throws a typed RegistryCollisionError instead of a
plain Error. worktree-setup.ts and worktree-up.ts both already run
runReap non-fatally before allocatePort — if runReap fails and this
worktree still has a legacy (unmigrated) row, allocatePort's own
collision check can name that row as though it belonged to a
different worktree. explainCollision appends a hint only when both
are true: this run's reap failed, and the colliding row is
legacy-shaped — never for a provably different worktree's collision.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `reapEntry` failure visibility

**Files:**
- Modify: `src/lib/worktree/reap.ts`
- Modify: `scripts/worktree-setup.ts`
- Modify: `scripts/worktree-up.ts`
- Modify: `tests/setup/unit-db.ts`
- Test: `src/lib/worktree/reap.test.ts`

**Interfaces:**
- Consumes: `Registry`, `RegistryEntry`, `removeEntry` (Task 1), `RawName`, `DbSlug` (Task 1). Builds on Task 2's edits to `worktree-setup.ts`/`worktree-up.ts` (the `reapFailed`/`try`-around-`allocatePort` structure Task 2 introduced stays; this task only touches each script's `runReap`-calling block above it).
- Produces: `ReapResult.failed: Array<{ key: string; error: unknown }>`; `RunReapResult` (`{ reaped: string[]; failed: Array<{ key: string; error: unknown }> }`); `runReap(...): Promise<RunReapResult>` (changed from `Promise<string[]>`). Not consumed by any later task.

- [ ] **Step 1: Write the failing test**

In `reap.test.ts`, replace the existing failure test:

```ts
it("does not let one orphan's failure prevent a later orphan in the same call from being reaped", async () => {
  const registry: Registry = {
    fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug },
    fix_520: { port: 3101, pid: null, dbSlug: 'fix_520' as DbSlug },
  };
  const dropDatabase = vi.fn().mockImplementation((dbName: string) => {
    if (dbName.includes('fix_517')) {
      return Promise.reject(new Error('simulated drop failure'));
    }
    return Promise.resolve();
  });
  const killPid = vi.fn();

  const result = await reapOrphans(registry, new Set() as ReadonlySet<RawName>, { dropDatabase, killPid });

  expect(result.reaped).toEqual(['fix_520']);
  expect(result.registry).toEqual({ fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' } });
});
```

with:

```ts
it("does not let one orphan's failure prevent a later orphan in the same call from being reaped, and records the failure in result.failed", async () => {
  const registry: Registry = {
    fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' as DbSlug },
    fix_520: { port: 3101, pid: null, dbSlug: 'fix_520' as DbSlug },
  };
  const failure = new Error('simulated drop failure');
  const dropDatabase = vi.fn().mockImplementation((dbName: string) => {
    if (dbName.includes('fix_517')) {
      return Promise.reject(failure);
    }
    return Promise.resolve();
  });
  const killPid = vi.fn();

  const result = await reapOrphans(registry, new Set() as ReadonlySet<RawName>, { dropDatabase, killPid });

  expect(result.reaped).toEqual(['fix_520']);
  expect(result.registry).toEqual({ fix_517: { port: 3100, pid: null, dbSlug: 'fix_517' } });
  expect(result.failed).toEqual([{ key: 'fix_517', error: failure }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/lib/worktree/reap.test.ts`
Expected: FAILS — `result.failed` is `undefined` (property doesn't exist on `ReapResult` yet).

- [ ] **Step 3: Implement**

In `src/lib/worktree/reap.ts`, change `ReapResult`:

```ts
export interface ReapResult {
  registry: Registry;
  reaped: string[];
  migrated: Array<{ from: string; to: string }>;
  failed: Array<{ key: string; error: unknown }>;
}
```

Change `reapEntry`'s signature and its catch block:

```ts
async function reapEntry(
  registry: Registry,
  key: string,
  entry: RegistryEntry,
  deps: ReapDeps,
  reaped: string[],
  failed: Array<{ key: string; error: unknown }>,
): Promise<Registry> {
  try {
    if (entry.pid !== null) {
      deps.killPid(entry.pid);
    }
    const { test, dev } = dbNamesForSlug(entry.dbSlug);
    await deps.dropDatabase(test);
    await deps.dropDatabase(dev);
    reaped.push(key);
    return removeEntry(registry, key);
  } catch (err) {
    console.warn(`[reap] failed to reap orphaned worktree "${key}" — will retry on the next sweep:`, err);
    failed.push({ key, error: err });
    return registry;
  }
}
```

In `reapOrphans`, add the accumulator, thread it into the `reapEntry` call, and return it:

```ts
export async function reapOrphans(
  registry: Registry,
  liveRawNames: ReadonlySet<RawName>,
  deps: ReapDeps,
): Promise<ReapResult> {
  let next = registry;
  const reaped: string[] = [];
  const migrated: Array<{ from: string; to: string }> = [];
  const failed: Array<{ key: string; error: unknown }> = [];

  for (const [key, entry] of Object.entries(registry)) {
    if (liveRawNames.has(key as RawName)) {
      continue; // already rawName-keyed, live
    }

    if (key === entry.dbSlug) {
      const target = [...liveRawNames].find((name) => sanitizesTo(name, key as DbSlug));
      if (target !== undefined) {
        if (registry[target] === undefined) {
          next = removeEntry(next, key);
          next = { ...next, [target]: { ...entry } };
          migrated.push({ from: key, to: target });
        } else {
          next = removeEntry(next, key);
        }
        continue;
      }
    }

    next = await reapEntry(next, key, entry, deps, reaped, failed);
  }

  return { registry: next, reaped, migrated, failed };
}
```

(Only the added `failed` accumulator and the extra `reapEntry` argument change here — the rest of the function, including its existing docblock, stays as-is.)

Change `runReap`:

```ts
export interface RunReapResult {
  reaped: string[];
  failed: Array<{ key: string; error: unknown }>;
}

/** Real IO wired up: live git state in, dropped databases and a persisted registry out. */
export async function runReap(
  gitCommonDir: string,
  registryPath: string,
  anyDatabaseUrl: string,
): Promise<RunReapResult> {
  const liveRawNames = getLiveWorktreeNames(gitCommonDir);
  let reapedKeys: string[] = [];
  let failedEntries: Array<{ key: string; error: unknown }> = [];
  await writeRegistryLocked(registryPath, async (registry) => {
    const { registry: next, reaped, migrated, failed } = await reapOrphans(registry, liveRawNames, {
      dropDatabase: (dbName) => dropDatabaseReal(dbName, anyDatabaseUrl),
      killPid: killPidReal,
    });
    reapedKeys = reaped;
    failedEntries = failed;
    if (migrated.length > 0) {
      console.log(
        `[reap] migrated legacy registry entries to their live raw name: ${migrated
          .map((m) => `${m.from} -> ${m.to}`)
          .join(', ')}`,
      );
    }
    return next;
  });
  return { reaped: reapedKeys, failed: failedEntries };
}
```

In `scripts/worktree-setup.ts`, change:

```ts
  let reapFailed = false;
  try {
    const reaped = await runReap(identity.gitCommonDir, registryPath, `${DB_HOST}/postgres`);
    if (reaped.length > 0) {
      console.log(`[worktree:setup] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  } catch (err) {
    reapFailed = true;
    console.warn('[worktree:setup] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }
```

to:

```ts
  let reapFailed = false;
  try {
    const result = await runReap(identity.gitCommonDir, registryPath, `${DB_HOST}/postgres`);
    if (result.reaped.length > 0) {
      console.log(`[worktree:setup] reaped orphaned worktree resources: ${result.reaped.join(', ')}`);
    }
    if (result.failed.length > 0) {
      console.error(
        `[worktree:setup] FAILED to reap ${result.failed.length} orphaned worktree resource(s) — will retry on next sweep: ${result.failed.map((f) => f.key).join(', ')}`,
      );
    }
  } catch (err) {
    reapFailed = true;
    console.warn('[worktree:setup] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }
```

In `scripts/worktree-up.ts`, apply the identical change (same shape, `[worktree:up]` prefix instead of `[worktree:setup]`) to its own `runReap`-calling block.

In `tests/setup/unit-db.ts`, change:

```ts
  try {
    const identity = getWorktreeIdentity();
    const reaped = await runReap(identity.gitCommonDir, getRegistryPath(identity.gitCommonDir), testUrl);
    if (reaped.length > 0) {
      console.log(`[unit-db] reaped orphaned worktree resources: ${reaped.join(', ')}`);
    }
  } catch (err) {
    console.warn('[unit-db] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }
```

to:

```ts
  try {
    const identity = getWorktreeIdentity();
    const result = await runReap(identity.gitCommonDir, getRegistryPath(identity.gitCommonDir), testUrl);
    if (result.reaped.length > 0) {
      console.log(`[unit-db] reaped orphaned worktree resources: ${result.reaped.join(', ')}`);
    }
    if (result.failed.length > 0) {
      console.error(
        `[unit-db] FAILED to reap ${result.failed.length} orphaned worktree resource(s) — will retry on next sweep: ${result.failed.map((f) => f.key).join(', ')}`,
      );
    }
  } catch (err) {
    console.warn('[unit-db] reap sweep failed — continuing without it, this worktree is unaffected:', err);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/lib/worktree/reap.test.ts`
Expected: PASSES, including the updated failure test.

Run: `npm run typecheck`
Expected: PASSES.

- [ ] **Step 5: Confirm the unit-db global setup still runs cleanly**

Run: `npx vitest run --project unit src/lib/worktree/`
Expected: PASSES — this exercises `tests/setup/unit-db.ts`'s global setup (which calls `runReap`) as a side effect of running any `unit`-project test, confirming the return-shape change didn't break it.

- [ ] **Step 6: Commit**

```bash
git add src/lib/worktree/reap.ts scripts/worktree-setup.ts scripts/worktree-up.ts tests/setup/unit-db.ts src/lib/worktree/reap.test.ts
git commit -m "$(cat <<'EOF'
fix(worktree): surface rows reapEntry fails to reap (#528)

reapEntry already logged a per-row warning on failure but gave its
caller no way to know a row is stuck versus successfully reaped.
ReapResult and runReap's return value now carry a failed list; all
three callers (worktree-setup.ts, worktree-up.ts, tests/setup/
unit-db.ts) log it distinctly (console.error) from the routine
"N reaped" line. Does not attempt to distinguish transient from
permanent failure across sweeps — visibility is the fix in scope.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Guard `resolveIdentity`'s unsanitizable-name throw

**Files:**
- Modify: `src/lib/worktree/identity.ts`
- Test: `src/lib/worktree/identity.test.ts`

**Interfaces:**
- Consumes: `RawName`, `DbSlug`, `sanitizeSlug` (Task 1, unchanged). Independent of Tasks 2 and 3 — touches neither `registry.ts`/`reap.ts` nor any script.
- Produces: no new exports; `resolveIdentity`'s behavior changes (see below). Nothing later in this plan consumes this change.

- [ ] **Step 1: Write the failing test**

In `identity.test.ts`'s `resolveIdentity` describe block, add:

```ts
it('throws an actionable error naming the raw name when it cannot be sanitized to any safe characters', () => {
  expect(() => resolveIdentity('/repo/.git/worktrees/___', '/repo/.git')).toThrow(
    /resolveIdentity:.*"___".*rename this worktree's directory/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit src/lib/worktree/identity.test.ts`
Expected: FAILS — today, `resolveIdentity('/repo/.git/worktrees/___', '/repo/.git')` throws `sanitizeSlug`'s bare `sanitizeSlug: "___" produced an empty slug"`, which doesn't match `/resolveIdentity:.*rename this worktree's directory/`.

- [ ] **Step 3: Implement**

In `identity.ts`, replace `resolveIdentity`'s body:

```ts
/** Pure — decides identity from git's own output. */
export function resolveIdentity(gitDir: string, gitCommonDir: string): WorktreeIdentity {
  const isMainCheckout = normalizeDir(gitDir) === normalizeDir(gitCommonDir);
  const rawName = isMainCheckout ? null : (basename(gitDir) as RawName);
  let dbSlug: DbSlug | null = null;
  if (rawName !== null) {
    try {
      dbSlug = sanitizeSlug(rawName) as DbSlug;
    } catch (err) {
      throw new Error(
        `resolveIdentity: worktree admin-dir name "${rawName}" cannot be turned into a database slug ` +
          `(${(err as Error).message}) — rename this worktree's directory to include at least one of [a-z0-9_]`,
      );
    }
  }
  return {
    isMainCheckout,
    rawName,
    dbSlug,
    gitCommonDir: normalizeDir(gitCommonDir),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit src/lib/worktree/identity.test.ts`
Expected: PASSES, including all pre-existing `resolveIdentity` tests unchanged (the three success-path tests never hit the new `catch`).

Run: `npm run typecheck`
Expected: PASSES.

- [ ] **Step 5: Commit**

```bash
git add src/lib/worktree/identity.ts src/lib/worktree/identity.test.ts
git commit -m "$(cat <<'EOF'
fix(worktree): give resolveIdentity's unsanitizable-name throw context (#528)

reap.ts's sanitizesTo already guards the identical sanitizeSlug throw
for live names it's comparing against; resolveIdentity had no
equivalent for the worktree's own identity, so an admin-dir name that
sanitizes to nothing (e.g. "___") threw sanitizeSlug's generic
"produced an empty slug" uncaught. Still throws — an unsanitizable
name genuinely needs a rename — but now names the worktree and the
fix instead of leaking the generic message.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (after all four tasks)

- [ ] Run `npm run verify` from this worktree (typecheck + lint + the full test suite — unit, unit-sweeps, components, and integration, needing this worktree's own dev server, already live).
- [ ] Confirm the worktree test count grew by exactly the tests this plan added (Task 1: 2 assertion replacements + 4 new `@ts-expect-error` pins across `identity.test.ts`/`registry.test.ts`, no net new runtime test count from those pins since they're not `it()` blocks; Task 2: 1 replaced + 2 new `allocatePort` tests, 3 new `explainCollision` tests; Task 3: 1 test's assertions extended, no new test count; Task 4: 1 new test) — reconcile against `git diff main --stat` on the four touched test files rather than re-deriving the count from memory.
