# Worktree CRON_SECRET Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh worktree's `.env` gets a real, usable `CRON_SECRET` from `npm run worktree:setup`, and a pre-existing worktree `.env` that still carries the blank default gets flagged the same way other isolation mismatches already are.

**Architecture:** `CRON_SECRET` is not shared infrastructure (unlike `DATABASE_URL`/`INTEGRATION_BASE_URL`/`NEXT_PUBLIC_APP_URL`), so it does not belong in `buildEnvOverrides` — that function stays untouched. Two new pure functions in `src/lib/worktree/env-file.ts` — `generateCronSecret()` and `hasEmptyCronSecret()` — carry the new behavior, and `scripts/worktree-setup.ts` wires them in at the two points that matter: the write-if-missing call (fresh worktree gets a real secret) and the existing-`.env` warning path (stale worktree gets flagged). `findMismatchedEnvKeys` keeps its existing exact-equality contract and does not gain `CRON_SECRET` — a freshly-generated random value can never equality-match a previously-stored one, so folding it into that comparison would falsely flag every healthy secret on every run.

**Tech Stack:** TypeScript, Node's built-in `crypto` module, Vitest (unit project).

**Spec:** None — bounded fix, single reasonable design, approved in chat during brainstorming (issue #546). No spec file per the solve-issue skill's gating (spec is only required for genuinely difficult issues: multiple subsystems, more than one reasonable design, a changed invariant/data model, or money/auth/concurrency — none apply here; `requireCronAuth`'s own auth logic is unchanged, only the tooling that generates the secret's value changes).

## Global Constraints

- `crypto.randomBytes(24).toString('hex')` is the exact generation recipe — it matches `DEPLOYMENT.md`'s documented production recipe (`openssl rand -hex 24`) byte-for-byte, so a worktree's local secret has the same shape as a real deployment's.
- Never mutate an `.env` that already exists — this is an existing project invariant (`writeEnvIfMissing`'s own "never overwrites an existing .env" test). This plan's stale-`.env` handling is detect-and-warn only, never auto-heal.
- This is a single-task plan. Per the solve-issue skill, the whole-branch review step is skipped once this task's own review closes — a single task's review already covers 100% of the diff. Go straight to push + PR after the task's fix loop.

---

### Task 1: Generate and validate a per-worktree CRON_SECRET

**Files:**
- Modify: `src/lib/worktree/env-file.ts` (add two functions, after `findMismatchedEnvKeys`)
- Modify: `src/lib/worktree/env-file.test.ts` (add two `describe` blocks)
- Modify: `scripts/worktree-setup.ts:7` (import line), `scripts/worktree-setup.ts:49-63` (wiring)
- Modify: `tests/e2e/recurring.spec.ts:18-24` (`cronSecret()` helper)

**Interfaces:**
- Produces: `generateCronSecret(): string` — returns a 48-character lowercase hex string (24 random bytes), a different value on every call.
- Produces: `hasEmptyCronSecret(envPath: string): boolean` — `true` when `CRON_SECRET` is absent from the file at `envPath` or present with an empty value (`CRON_SECRET=""`); `false` when it holds any non-empty value.
- Consumes (unchanged, already exist): `readEnvValue(envPath: string, key: string): string | undefined` and `findMismatchedEnvKeys(envPath: string, overrides: Record<string, string>): string[]` from `src/lib/worktree/env-file.ts`; `buildEnvOverrides(dbHost: string, dev: string, test: string, port: number): Record<string, string>` from `src/lib/worktree/env-overrides.ts` (both untouched by this task).

- [ ] **Step 1: Write the failing unit tests for `generateCronSecret` and `hasEmptyCronSecret`**

Append to `src/lib/worktree/env-file.test.ts` (after the existing `findMismatchedEnvKeys` describe block, keeping the same `import` line — add `generateCronSecret` and `hasEmptyCronSecret` to the existing named import from `./env-file`):

```typescript
describe('generateCronSecret', () => {
  it('returns a 48-character lowercase hex string', () => {
    const secret = generateCronSecret();
    expect(secret).toMatch(/^[0-9a-f]{48}$/);
  });

  it('returns a different value on each call', () => {
    expect(generateCronSecret()).not.toBe(generateCronSecret());
  });
});

describe('hasEmptyCronSecret', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fairyoga-env-cron-test-'));
  const envPath = path.join(dir, '.env');

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  });

  it('returns true when CRON_SECRET is missing entirely', () => {
    fs.writeFileSync(envPath, 'OTHER="x"');
    expect(hasEmptyCronSecret(envPath)).toBe(true);
  });

  it('returns true when CRON_SECRET is present but blank', () => {
    fs.writeFileSync(envPath, 'CRON_SECRET=""');
    expect(hasEmptyCronSecret(envPath)).toBe(true);
  });

  it('returns false when CRON_SECRET holds a value', () => {
    fs.writeFileSync(envPath, 'CRON_SECRET="abc123"');
    expect(hasEmptyCronSecret(envPath)).toBe(false);
  });
});
```

The full updated import line at the top of the file:

```typescript
import { generateEnvContent, writeEnvIfMissing, readEnvValue, findMismatchedEnvKeys, generateCronSecret, hasEmptyCronSecret } from './env-file';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/lib/worktree/env-file.test.ts`
Expected: FAIL — `generateCronSecret` and `hasEmptyCronSecret` are not exported from `./env-file` (TypeScript/import error, or `undefined is not a function`).

- [ ] **Step 3: Implement `generateCronSecret` and `hasEmptyCronSecret`**

Add to `src/lib/worktree/env-file.ts`. First add the import at the top of the file (the file currently starts with `import fs from 'fs';`):

```typescript
import fs from 'fs';
import crypto from 'crypto';
```

Then append after `findMismatchedEnvKeys` (end of file):

```typescript

/** `openssl rand -hex 24`'s equivalent — matches DEPLOYMENT.md's production CRON_SECRET recipe. */
export function generateCronSecret(): string {
  return crypto.randomBytes(24).toString('hex');
}

/** True when `envPath`'s CRON_SECRET is missing or blank — the value `.env.example` ships, and what a pre-fix worktree's `.env` still carries. */
export function hasEmptyCronSecret(envPath: string): boolean {
  return !readEnvValue(envPath, 'CRON_SECRET');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/worktree/env-file.test.ts`
Expected: PASS — all tests in the file, including the new ones, green.

- [ ] **Step 5: Wire the new functions into `scripts/worktree-setup.ts`**

Change the import on line 7 from:

```typescript
import { writeEnvIfMissing, findMismatchedEnvKeys } from '../src/lib/worktree/env-file';
```

to:

```typescript
import { writeEnvIfMissing, findMismatchedEnvKeys, generateCronSecret, hasEmptyCronSecret } from '../src/lib/worktree/env-file';
```

Change lines 49-63 from:

```typescript
  const overrides = buildEnvOverrides(DB_HOST, dev, test, port);
  const wrote = writeEnvIfMissing(envPath, examplePath, overrides);

  console.log(`[worktree:setup] rawName: ${rawName}`);
  console.log(`[worktree:setup] dbSlug: ${dbSlug}`);
  console.log(`[worktree:setup] port: ${port}`);
  console.log(`[worktree:setup] databases: ${dev}, ${test}`);
  console.log(wrote ? '[worktree:setup] wrote .env' : '[worktree:setup] .env already exists — left untouched');

  if (!wrote) {
    const mismatched = findMismatchedEnvKeys(envPath, overrides);
    if (mismatched.length > 0) {
      console.warn(`[worktree:setup] .env already exists and does not match this worktree's isolation settings for: ${mismatched.join(', ')}`);
      console.warn('[worktree:setup] if this .env was copied from elsewhere, delete it and re-run this command to regenerate it correctly');
    }
  }
```

to:

```typescript
  const overrides = buildEnvOverrides(DB_HOST, dev, test, port);
  const wrote = writeEnvIfMissing(envPath, examplePath, { ...overrides, CRON_SECRET: generateCronSecret() });

  console.log(`[worktree:setup] rawName: ${rawName}`);
  console.log(`[worktree:setup] dbSlug: ${dbSlug}`);
  console.log(`[worktree:setup] port: ${port}`);
  console.log(`[worktree:setup] databases: ${dev}, ${test}`);
  console.log(wrote ? '[worktree:setup] wrote .env' : '[worktree:setup] .env already exists — left untouched');

  if (!wrote) {
    const mismatched = findMismatchedEnvKeys(envPath, overrides);
    if (hasEmptyCronSecret(envPath)) {
      mismatched.push('CRON_SECRET');
    }
    if (mismatched.length > 0) {
      console.warn(`[worktree:setup] .env already exists and does not match this worktree's isolation settings for: ${mismatched.join(', ')}`);
      console.warn('[worktree:setup] if this .env was copied from elsewhere, delete it and re-run this command to regenerate it correctly');
    }
  }
```

`overrides` itself (passed to `findMismatchedEnvKeys`) is deliberately left unchanged — it still holds only the four deterministic keys `buildEnvOverrides` already returns. Only the object literal passed to `writeEnvIfMissing` gains `CRON_SECRET`.

`scripts/worktree-setup.ts` has no test file of its own (consistent with `getWorktreeIdentity` in `src/lib/worktree/identity.ts`, which carries the same "not unit tested directly — the pure function underneath it is" note) — the two new `env-file.ts` functions carry full unit coverage of this step's new logic.

- [ ] **Step 6: Fix the `cronSecret()` test helper to reject a blank value**

In `tests/e2e/recurring.spec.ts`, change lines 18-24 from:

```typescript
function cronSecret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  const env = fs.readFileSync('.env', 'utf8');
  const match = /^CRON_SECRET=(.*)$/m.exec(env);
  if (!match) throw new Error('CRON_SECRET not found in environment or .env');
  return match[1]!.trim().replace(/^"|"$/g, '');
}
```

to:

```typescript
function cronSecret(): string {
  if (process.env.CRON_SECRET) return process.env.CRON_SECRET;
  const env = fs.readFileSync('.env', 'utf8');
  const match = /^CRON_SECRET=(.*)$/m.exec(env);
  if (!match) throw new Error('CRON_SECRET not found in environment or .env');
  const value = match[1]!.trim().replace(/^"|"$/g, '');
  if (!value) throw new Error('CRON_SECRET is empty in .env');
  return value;
}
```

This is test infrastructure (an e2e helper, not app behavior) — no separate unit test for it, consistent with how the rest of this file's helpers (`uniqueSuffix`, etc.) are untested directly and exercised only by the specs that call them.

- [ ] **Step 7: Run the full unit project to confirm nothing else broke**

Run: `npx vitest run --project unit`
Expected: PASS — all unit tests green, including `src/lib/worktree/env-file.test.ts` and `src/lib/worktree/env-overrides.test.ts` (the latter is untouched by this task and must stay green, confirming `buildEnvOverrides` itself was not modified).

- [ ] **Step 8: Run typecheck and lint**

Run: `npm run verify`

This needs the app live on `:3000` for the integration tier — do not start or restart that server yourself; if it is not already running, note that in your task report rather than starting one. If it is running, this single command covers typecheck, lint, and the whole vitest suite (unit + components + integration). A green result here is not a CI substitute (CI also runs `prisma validate`, a migration-drift check, `npm run build`, and Playwright) but is the right local gate for this change, which touches no schema, no route, and no React component — it does not need CI's build or Playwright tiers to be exercised locally to have confidence in it, though CI will still run them.

- [ ] **Step 9: Commit**

```bash
git add src/lib/worktree/env-file.ts src/lib/worktree/env-file.test.ts scripts/worktree-setup.ts tests/e2e/recurring.spec.ts
git commit -m "fix(worktree): generate a real CRON_SECRET on worktree setup

worktree:setup never populated CRON_SECRET, so a fresh worktree's .env
inherited the blank default from .env.example and every /api/cron/*
request 500'd. generateCronSecret() (crypto.randomBytes(24), matching
DEPLOYMENT.md's openssl rand -hex 24 production recipe) fills it in on
first write; hasEmptyCronSecret() extends the existing stale-.env
warning to catch a pre-fix worktree that still carries the blank value.

Also hardens the e2e cronSecret() test helper to throw on an empty
matched value, not only a missing line, per #546's own follow-up
comment.

Fixes #546"
```
