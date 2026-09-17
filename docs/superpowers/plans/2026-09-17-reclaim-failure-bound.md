# Reclaim-Failure Bound Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound `acquireLock`'s stale-reclaim branch so a persistently-failing `reclaimStaleLock` (e.g. a permanent `EPERM`/`EACCES` on the lock directory) terminates within a fixed number of attempts instead of looping forever (#636).

**Architecture:** Add a dedicated `failedReclaimAttempts` counter, bounded by a new `ACQUIRE_LOCK_MAX_RECLAIM_FAILURES` constant, incremented only when `reclaimStaleLock` returns `false`. The counter resets whenever the lock is observed not-stale — see "Why a reset is needed" below. On hitting the bound, throw a distinct error naming the reclaim itself as broken, so this failure mode doesn't read as either of #631's two messages (a generic "Timed out waiting for lock" or "lock info stayed unreadable for N consecutive passes").

**Tech Stack:** TypeScript, Vitest, Node's `fs` module (no new dependencies).

**Spec:** None — classified as a bounded task during brainstorming (single function, single file, one reasonable design once the actual failure paths are traced). Design rationale lives in this plan and will be restated in the PR body.

## Global Constraints

- No `any`, no implicit types (project-wide `strict: true`).
- Match the file's existing error style: a bare `Error` with a descriptive message (this file does not use a custom error class for lock-acquisition failures — `RegistryCollisionError` is for a different, unrelated scenario).
- Comment Discipline (CLAUDE.md): correct the existing comment's now-false claim in place; never leave "this previously said X" prose behind.
- Never edit an applied migration — not applicable here (no schema change).

---

### Task 1: Bound failed reclaim attempts in `acquireLock`

**Files:**
- Modify: `src/lib/worktree/registry.ts:329-429` (the `ACQUIRE_LOCK_MAX_UNKNOWN_PASSES` constant and `acquireLock` function)
- Test: `src/lib/worktree/registry.test.ts` (add one test to the `describe('acquireLock / releaseLock staleness recovery', ...)` block, and add the new export to the existing import list at the top of the file)

**Interfaces:** N/A — this is the only task in this plan.

**Why a reset is needed (read before implementing):** `reclaimedStale` only ever transitions `false → true`, never back, so it's tempting to conclude that any run of entries into the `if (stale && !reclaimedStale)` branch is, by construction, an unbroken run of failures. That conclusion is wrong: `reclaimedStale` staying `false` only proves *we* never succeeded — it says nothing about whether the *lock itself* went through an intervening live period. Between two entries into this branch, the outer `while (true)` loop can pass through an arbitrary number of "not stale" iterations where a legitimate holder has the lock (our own reclaim attempt fails once against holder A; holder A's lock later expires and is genuinely held by a different holder B for a while — not stale, just an ordinary wait; holder B later dies, the lock goes stale again, and our reclaim attempt against *that* new stale lock fails too). Without a reset, `failedReclaimAttempts` would carry across that live period and let two temporally-separated, causally-unrelated one-off contention losses wrongly trip the bound as if they were one broken reclaim. The fix mirrors `unknownPasses`'s own reset pattern: whenever `isLockStale` reports the lock as *not* stale, that is forward progress unrelated to our own reclaim history, so `failedReclaimAttempts` resets to 0 right there (`src/lib/worktree/registry.ts`, in `acquireLock`, immediately before the `if (stale && !reclaimedStale)` check). The lock vanishing entirely (`!fs.existsSync(lockDir)`) is the same kind of signal, one rung stronger, and resets it too, alongside the existing `unknownPasses = 0`. See `src/lib/worktree/registry.test.ts`'s `'resets failedReclaimAttempts when an intervening pass observes the lock as not stale (#636 review)'` test, which constructs exactly the two-episode scenario above and asserts the bound requires a fresh 3 failures in the second episode rather than 1.

- [ ] **Step 1: Add the new constant and counter**

In `src/lib/worktree/registry.ts`, immediately after the existing constant declaration:

```ts
export const ACQUIRE_LOCK_MAX_UNKNOWN_PASSES = 3;
```

add:

```ts
export const ACQUIRE_LOCK_MAX_RECLAIM_FAILURES = 3;
```

Inside `acquireLock`, immediately after the existing `let reclaimedStale = false;` declaration, add:

```ts
let failedReclaimAttempts = 0;
```

- [ ] **Step 2: Correct the now-false comment and update the stale-reclaim branch**

The existing comment block above `let observedToken: string | null | undefined = undefined;` ends with:

```ts
  // owner.json (permission error, permanent corruption) times out rather
  // than waiting forever, as long as the lock never also looks stale: a
  // stale lock whose reclaim keeps failing retries the reclaim itself
  // forever below, a pre-existing gap unrelated to this bound.
```

Replace those last four lines with:

```ts
  // owner.json (permission error, permanent corruption) times out rather
  // than waiting forever, as long as the lock never also looks stale. A
  // stale lock whose reclaim keeps failing is a different failure mode —
  // the reclaim itself broken, not merely a slow wait — bounded
  // separately by failedReclaimAttempts/ACQUIRE_LOCK_MAX_RECLAIM_FAILURES
  // below, with its own distinct error so the two don't read as the same
  // timeout (#636).
```

Then replace the whole stale-reclaim branch:

```ts
    const { stale } = isLockStale(lockDir, staleMs);
    if (stale && !reclaimedStale) {
      const reclaimed = reclaimStaleLock(lockDir, staleMs);
      if (reclaimed) {
        reclaimedStale = true;
      }
      observedToken = undefined;
      observedTokenKnown = false;
      unknownPasses = 0;
      continue;
    }
```

with:

```ts
    const { stale } = isLockStale(lockDir, staleMs);
    if (stale && !reclaimedStale) {
      const reclaimed = reclaimStaleLock(lockDir, staleMs);
      if (reclaimed) {
        reclaimedStale = true;
      } else {
        failedReclaimAttempts += 1;
        if (failedReclaimAttempts >= ACQUIRE_LOCK_MAX_RECLAIM_FAILURES) {
          throw new Error(
            `Failed to reclaim stale lock at ${lockDir} after ${ACQUIRE_LOCK_MAX_RECLAIM_FAILURES} consecutive attempts (the reclaim's rename kept failing — this is the reclaim itself being broken, not an ordinary timeout; check filesystem permissions on ${lockDir}, then remove it manually and retry)`,
          );
        }
      }
      observedToken = undefined;
      observedTokenKnown = false;
      unknownPasses = 0;
      continue;
    }
```

- [ ] **Step 3: Sweep for other copies of the now-false claim**

Run:

```bash
grep -rn "retries the reclaim itself\|pre-existing gap unrelated to this bound" --include='*.md' --include='*.ts' .
```

The only expected hit before this change is the comment just edited in `registry.ts`. If the grep finds any other occurrence (e.g. in `docs/`, a plan, or a spec describing the current behavior of `acquireLock`), correct it the same way: state what's true now, not what used to be true, per CLAUDE.md's Comment Discipline. `PR #635`'s own (merged, historical) body is expected to still contain the old claim — that is a historical record of what was true when it was written, not a comment in the codebase, and must not be edited.

- [ ] **Step 4: Add the import and write the test**

In `src/lib/worktree/registry.test.ts`, add `ACQUIRE_LOCK_MAX_RECLAIM_FAILURES` to the existing import block (alongside `ACQUIRE_LOCK_MAX_UNKNOWN_PASSES`):

```ts
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
  readLockInfo,
  assertLockHeld,
  RegistryCollisionError,
  explainCollision,
  type Registry,
} from './registry';
```

Add this test inside the `describe('acquireLock / releaseLock staleness recovery', ...)` block (it uses that block's shared `dir`/`lockDir` and `afterEach` cleanup — place it after the existing `'resets the unreadable-pass budget when a stale lock is reclaimed'` test, before the block's closing `});`):

```ts
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

    try {
      expect(() => acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })).toThrow(
        /reclaim itself being broken/,
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
    }
  });
```

- [ ] **Step 5: Verify RED without hanging the runner**

`acquireLock`'s wait is a synchronous `Atomics.wait` spin, which vitest's own `testTimeout` cannot interrupt (documented already in this file's "times out rather than waiting forever" test, and hit for real during #631/#635's own development). Verify the pre-fix behavior with an external kill instead of trusting vitest:

Before Step 1/2's production-code edit is applied (i.e. on a clean worktree with only Step 4's test added), run:

```bash
timeout 20 pnpm exec vitest run --project unit src/lib/worktree/registry.test.ts -t "bounds failed reclaim attempts" 2>&1; echo "exit code: $?"
```

Expected: the process is killed by the external `timeout` after 20s (exit code `124`), not a normal vitest failure — this confirms the unbounded loop actually hangs rather than merely failing an assertion. If it exits before 20s with a normal failure, stop and re-examine before proceeding — that would mean the test isn't actually exercising the infinite-loop path.

- [ ] **Step 6: Apply the production-code changes and verify GREEN**

Apply Step 1 and Step 2's edits. Run:

```bash
pnpm exec vitest run --project unit src/lib/worktree/registry.test.ts
```

Expected: all tests in the file pass, including the new one, and the run completes quickly (well under a second for this test) — no external timeout needed.

- [ ] **Step 7: Prove the bound actually bites (mutation test)**

Temporarily change `if (failedReclaimAttempts >= ACQUIRE_LOCK_MAX_RECLAIM_FAILURES)` to `if (false)` (or comment out the `throw` block entirely), then re-run the exact command from Step 5 (the `timeout 20 ...` wrapped version, targeting the new test). Confirm it is again killed by the external timeout (exit 124) — this proves the guard is what's terminating the loop, not some other coincidental exit. Restore the real condition and re-run Step 6's plain command to confirm GREEN again. Record both results (the exact commands and their exit behavior) for the PR body — do not just assert this was done, show it.

- [ ] **Step 8: Run the full test file and adjacent checks**

```bash
pnpm exec vitest run --project unit src/lib/worktree/registry.test.ts
pnpm exec tsc --noEmit
pnpm exec eslint src/lib/worktree/registry.ts src/lib/worktree/registry.test.ts
```

Expected: all green — `registry.test.ts` should report 63 passed (62 pre-existing + 1 new; confirm the pre-existing count first with `git show origin/main:src/lib/worktree/registry.test.ts | grep -c '^  it('` before claiming this arithmetic in the PR body), no TypeScript errors, no new lint errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/worktree/registry.ts src/lib/worktree/registry.test.ts
git commit -m "fix(worktree): bound acquireLock's stale-reclaim retries when reclaim itself keeps failing

Fixes #636"
```

(Final attribution line is added by the tooling per repo convention, not typed here.)

---

## Post-task: whole-branch review

Not applicable — this plan has exactly one task, so the task-level review (spec/plan compliance + quality) already covers the whole branch. Per `solve-issue`'s §5, skip the separate whole-branch review pass.

## Post-task: PR

Push the branch, open the PR (body per `solve-issue`'s "The PR body" section — include the Step 7 mutation-test transcript, the Step 8 arithmetic, and what this PR does not do), then run `/pr-review-toolkit:review-pr` before merge.
