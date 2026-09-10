# Extract worktree-setup/worktree-up's port-allocation wiring — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close issue #555 — `scripts/worktree-setup.ts` and `scripts/worktree-up.ts` each duplicate a `writeRegistryLocked` → `allocatePort` → `catch (RegistryCollisionError) → explainCollision(err, reapFailed)` sequence, checked only by `tsc`, never exercised behaviorally (neither script has a test file). Extract it into one testable function in `src/lib/worktree/registry.ts` and make both scripts thin callers.

**Premise correction (verified against current `main`, commit `5689fac8`):** the issue's suggested signature —
`allocatePortOrExplain(registryPath, rawName, dbSlug, reapFailed): Promise<number>` — doesn't fit `worktree-up.ts`: its locked mutation also has to check whether the registry already has a live `pid` for this `rawName` and short-circuit with `{ port, pid }` *before* calling `allocatePort`, inside the same lock acquisition (`worktree-up.ts:64-73`). A fixed `(registryPath, rawName, dbSlug, reapFailed)` signature can't express that. Generalizing to accept the caller's own registry-mutator closure (same shape `writeRegistryLocked` already takes) fits both scripts without forcing an unrelated branch into the shared helper.

Separately: the *other* half of the duplication the issue's background section describes — the `try { runReap } catch { reapFailed = true }` block above the allocation — is **not** extracted here. `runReap` (`reap.ts`) itself has zero existing test coverage (only its pure core `reapOrphans` is tested, via `ReapDeps` injection); wrapping it in a logged helper would produce another untested glue function, not a testable one, and this codebase's convention is dependency injection over module mocking (no `vi.mock` usage found in `src/lib/worktree/*.test.ts`). The risk the issue names — `reapFailed` failing to propagate into `explainCollision` — lives entirely in the half this plan does extract and test.

**Architecture:** One new generic function in `registry.ts`, consumed by both scripts. Single task — one file pair (`registry.ts`/`registry.test.ts`) plus two thin call-site edits, reviewed together; no cross-task seam to protect.

**Tech Stack:** TypeScript (strict), Vitest, tsx (script runtime).

## Global Constraints

- `npm run typecheck` = `tsc --noEmit`. Fast inner loop: `npx vitest run --project unit src/lib/worktree/registry.test.ts`.
- This plan executes inside the worktree already set up at this repo root (`npm run worktree:setup && npm run worktree:up` have already run; the dev server is live on this worktree's own allocated port, 3104). Do not touch `:3000` or any other worktree.
- No schema changes — no migration needed.
- Comment Discipline (CLAUDE.md): no prose counts, no docblock reaching past this file.

---

### Task 1: Extract `writeRegistryLockedOrExplain` and wire both scripts to it

**Files:**
- Modify: `src/lib/worktree/registry.ts`
- Modify: `scripts/worktree-setup.ts`
- Modify: `scripts/worktree-up.ts`
- Test: `src/lib/worktree/registry.test.ts`

**Interfaces:**
- Produces: `writeRegistryLockedOrExplain<T>(registryPath: string, reapFailed: boolean, mutate: (registry: Registry) => { registry: Registry; result: T }): Promise<T>`, exported from `registry.ts`, placed directly after `explainCollision` (both used by, and read together with, `allocatePort`/`RegistryCollisionError`).
- Consumed by: `scripts/worktree-setup.ts` (mutator returns `{ registry: result.registry, result: result.port }` — `T = number`); `scripts/worktree-up.ts` (mutator returns a discriminated union `T = { kind: 'already-running'; port: number; pid: number } | { kind: 'allocated'; port: number }`, checking `registry[rawName]` liveness before calling `allocatePort`, matching its current behavior at `worktree-up.ts:64-73`).
- Behavior is unchanged for both scripts — this is a structural extraction, not a logic change. Every existing manual behavior (collision message, `explainCollision` enrichment, already-running short-circuit, freshly-allocated port) must be identical before and after.

- [ ] **Step 1: Write the failing/absent-coverage test first**

  In `registry.test.ts`, add a `describe('writeRegistryLockedOrExplain', ...)` block (placed after the existing `describe('explainCollision', ...)` block, before `describe('setPid', ...)`) using the same temp-registry-file pattern already used by the `readRegistry / writeRegistryLocked` describe block (a real file under a `fs.mkdtempSync`'d temp dir — this codebase doesn't mock `fs` or `registry.ts` internals). Cover:

  1. No collision: `mutate` returns `{ registry: <next>, result: <T> }`; the function returns that `result`, and the registry file on disk reflects `<next>` (read it back with `readRegistry`).
  2. Collision, `reapFailed: false`: the thrown error `=== ` the original `RegistryCollisionError` (identity check, matching `explainCollision`'s existing `toBe(err)` assertions two describe-blocks up) — `explainCollision` returns it unchanged in this branch.
  3. Collision, `reapFailed: true`, colliding key legacy-shaped (`collidingKey === dbSlug`, same setup as the existing `explainCollision` "returns enriched error" test): the thrown error's `.message` contains the "reap/migration sweep failed earlier" note, `instanceof RegistryCollisionError` is `false` on it, and its `.cause` is the original `RegistryCollisionError`.
  4. A non-collision error thrown from inside `mutate` (e.g. `mutate` itself throws a plain `Error`) propagates unchanged — proves the `instanceof RegistryCollisionError` gate still runs, not just "some error was caught and rethrown."

  Run `npx vitest run --project unit src/lib/worktree/registry.test.ts` — RED: `writeRegistryLockedOrExplain` doesn't exist yet, a `TypeScript`/import error.

- [ ] **Step 2: Implement `writeRegistryLockedOrExplain`**

  In `registry.ts`, directly after `explainCollision`:

  ```ts
  export async function writeRegistryLockedOrExplain<T>(
    registryPath: string,
    reapFailed: boolean,
    mutate: (registry: Registry) => { registry: Registry; result: T },
  ): Promise<T> {
    let result: T;
    try {
      await writeRegistryLocked(registryPath, (registry) => {
        const outcome = mutate(registry);
        result = outcome.result;
        return outcome.registry;
      });
    } catch (err) {
      throw err instanceof RegistryCollisionError ? explainCollision(err, reapFailed) : err;
    }
    return result!;
  }
  ```

  Run the Step 1 tests again — GREEN.

- [ ] **Step 3: Mutation-test the `instanceof` gate (prove it bites)**

  Temporarily change the catch clause to `throw explainCollision(err as RegistryCollisionError, reapFailed);` unconditionally (dropping the `instanceof` check). Re-run `registry.test.ts` — confirm Step 1's test 4 (non-collision error) now fails or throws the wrong shape (a plain `Error` passed to `explainCollision`, which reads `.collidingKeyIsLegacyShaped` off it — either a `TypeError` or a wrong-shaped thrown value, not the original error unchanged). Record the exact failure text in the task's completion note, then restore the real implementation and re-run to confirm GREEN again.

- [ ] **Step 4: Wire `scripts/worktree-setup.ts`**

  Replace the port-allocation block (current lines 42–51) with:

  ```ts
  const port = await writeRegistryLockedOrExplain(registryPath, reapFailed, (registry) => {
    const result = allocatePort(registry, rawName, dbSlug);
    return { registry: result.registry, result: result.port };
  });
  ```

  Update the import line: drop `writeRegistryLocked`, `RegistryCollisionError`, `explainCollision`; add `writeRegistryLockedOrExplain`.

- [ ] **Step 5: Wire `scripts/worktree-up.ts`**

  Replace the port-allocation block (current lines 61–76) with:

  ```ts
  const slot = await writeRegistryLockedOrExplain(registryPath, reapFailed, (registry) => {
    const existing = registry[rawName];
    if (existing?.pid != null && isPidAlive(existing.pid)) {
      return { registry, result: { kind: 'already-running' as const, port: existing.port, pid: existing.pid } };
    }
    const result = allocatePort(registry, rawName, dbSlug);
    return { registry: result.registry, result: { kind: 'allocated' as const, port: result.port } };
  });

  if (slot.kind === 'already-running') {
    console.log(`[worktree:up] already running at http://localhost:${slot.port} (pid ${slot.pid})`);
    return;
  }
  const port = slot.port;
  ```

  Update the import line: drop `RegistryCollisionError`, `explainCollision`; add `writeRegistryLockedOrExplain`. Keep `writeRegistryLocked` imported — it's still used unchanged by the two `setPid` calls later in the same file (after spawning the dev server, and on the wait-for-server failure path).

- [ ] **Step 6: Manual verification in this live worktree**

  This worktree's own registry entry is already live (port 3104, dev server running). From `.claude/worktrees/issue-555`:
  - `npm run worktree:up` again — must hit the `already-running` branch and print `already running at http://localhost:3104 (pid ...)`, exiting without touching the registry or re-provisioning the database. This is the one behavior no unit test reaches (it needs this worktree's own real live process), so it's the specific case to confirm here.
  - `npm run typecheck` — clean.

- [ ] **Step 7: Full verification**

  `npm run verify` (typecheck + lint + full suite; the dev server is already live on this worktree's own port). Confirm the reported test count and record it in the completion note.
