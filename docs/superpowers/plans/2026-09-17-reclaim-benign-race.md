# Reclaim Benign-Race Classification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `reclaimStaleLock`'s rename failure currently counts two structurally different causes identically toward `ACQUIRE_LOCK_MAX_RECLAIM_FAILURES` (#638, filed during #637's review): a **benign race** (`ENOENT`/`ENOTDIR` — a sibling already renamed or removed `lockDir` a moment earlier) and a **genuine, persistent filesystem problem** (`EPERM`, `EACCES`, `EXDEV`, `EMFILE`/`ENFILE`, ...). Under sustained multi-way contention on one lock path, several consecutive benign-race losses could trip the "reclaim is broken" bound even though nothing is actually broken. Classify the two and stop counting the benign one.

**Architecture:** Add a small exported pure predicate, `isBenignReclaimRaceError`, backed by a `BENIGN_RECLAIM_RACE_CODES` set (`ENOENT`, `ENOTDIR`). `acquireLock`'s stale-reclaim branch checks `reclaimError` against it: a benign race is logged but does **not** increment `failedReclaimAttempts`; everything else (a genuine fs error, or the pre-existing "rename succeeded but lock still alive on re-check" case) counts exactly as it did after #637.

**Decision (acceptance criterion 1 — does a benign race need its own bound?):** No separate counter. A benign race is excluded from `ACQUIRE_LOCK_MAX_RECLAIM_FAILURES` entirely and relies on the loop's own existing forward-progress checks to resolve it, typically within a pass or two:
- The very state change that produced the `ENOENT`/`ENOTDIR` (a sibling renamed or removed `lockDir`) is independently visible on the *next* pass through `acquireLock`'s own `!fs.existsSync(lockDir)` check (already resets `failedReclaimAttempts`/`unknownPasses` and retries — if `lockDir` is now gone, our own `mkdirSync` on the next inner-loop pass claims it outright) or through `isLockStale` reporting a fresh state (a new legitimate holder whose pid is alive resets the counter and falls through to the ordinary holder-token-changed wait, itself bounded by `ACQUIRE_LOCK_MAX_UNKNOWN_PASSES`/`retries`).
- This does **not** reopen #636's original hazard (an unbounded loop): #636's failure was a *persistent, unchanging* signal — same error, same lock state, no forward progress between attempts, ever. A benign race is by definition accompanied by real state change (the directory moved or vanished), so it cannot repeat identically forever the way a permanent `EPERM` can.
- Matches the issue's own suggested resolution: "excluded entirely, relying on the caller's own `retries`/`delayMs` budget to eventually succeed via the ordinary `mkdirSync` retry loop."

**Decision (acceptance criterion 2 — message per cause):** Unchanged for the two cases #637 already built: `"the rename kept failing: <error>"` (genuine fs error) and `"the lock kept appearing genuinely held on re-check"` (rename succeeded, recheck found it alive). Both remain accurate to their cause. The behavioral fix above is what stops a benign race from ever reaching the first message via accumulated benign losses — no wording change is needed in the give-up message itself, since a benign race can no longer be *why* that message fires. A new, distinct `console.warn` line marks a benign-race loss as unabridged (uncounted) progress, so an operator reading the logs can tell "we lost a race, retrying" apart from "N/`ACQUIRE_LOCK_MAX_RECLAIM_FAILURES` counted failures."

**Tech Stack:** TypeScript, Vitest, Node's `fs` module (no new dependencies).

**Spec:** None — same class of task as #636/#637 (single function, single file, one reasonable design; the issue itself already laid out the design space in its acceptance criteria). Design rationale lives in this plan and will be restated in the PR body.

## Global Constraints

- No `any`, no implicit types (project-wide `strict: true`).
- Match the file's existing error style: a bare `Error` with a descriptive message.
- Comment Discipline (CLAUDE.md): no prose census of every `NodeJS.ErrnoException` code that could occur — `BENIGN_RECLAIM_RACE_CODES`'s own two-element `Set` literal is the tether; a comment may give illustrative examples of the "genuine" bucket ("EPERM, EACCES, ...") without claiming to enumerate it, since "anything else" already covers exhaustiveness.
- Never edit an applied migration — not applicable here (no schema change).

---

### Task 1: Classify benign-race reclaim failures separately from genuine ones

**Files:**
- Modify: `src/lib/worktree/registry.ts` (add `BENIGN_RECLAIM_RACE_CODES`/`isBenignReclaimRaceError` near `reclaimStaleLock`; update `acquireLock`'s stale-reclaim branch)
- Test: `src/lib/worktree/registry.test.ts` (add `isBenignReclaimRaceError` to the import list; add a direct `describe('isBenignReclaimRaceError', ...)` block; add one `acquireLock`-level test to `describe('acquireLock / releaseLock staleness recovery', ...)`)

**Interfaces:** N/A — this is the only task in this plan.

- [ ] **Step 1: Add the classification predicate**

In `src/lib/worktree/registry.ts`, immediately above `export function reclaimStaleLock`, add:

```ts
// ENOENT/ENOTDIR mean a sibling already renamed or removed lockDir out from
// under us mid-reclaim — ordinary multi-way contention, not a broken
// reclaim (#638). Anything else (EPERM, EACCES, EXDEV, EMFILE/ENFILE, an
// unrecognized code, or no code at all) is treated as a genuine, persistent
// filesystem problem and counts toward ACQUIRE_LOCK_MAX_RECLAIM_FAILURES.
const BENIGN_RECLAIM_RACE_CODES = new Set<string>(['ENOENT', 'ENOTDIR']);

export function isBenignReclaimRaceError(error: NodeJS.ErrnoException | undefined): boolean {
  return error?.code !== undefined && BENIGN_RECLAIM_RACE_CODES.has(error.code);
}
```

- [ ] **Step 2: Use it in `acquireLock`'s stale-reclaim branch**

Replace the current branch body:

```ts
      const { reclaimed, error: reclaimError } = reclaimStaleLock(lockDir, staleMs);
      if (reclaimed) {
        reclaimedStale = true;
      } else {
        failedReclaimAttempts += 1;
        console.warn(
          `[registry] reclaim attempt ${failedReclaimAttempts}/${ACQUIRE_LOCK_MAX_RECLAIM_FAILURES} failed for ${lockDir}${reclaimError ? ` (${reclaimError})` : ' (lock was still alive on re-check)'}`,
        );
        if (failedReclaimAttempts >= ACQUIRE_LOCK_MAX_RECLAIM_FAILURES) {
          const reason = reclaimError
            ? `the rename kept failing: ${reclaimError}`
            : 'the lock kept appearing genuinely held on re-check';
          throw new Error(
            `Failed to reclaim stale lock at ${lockDir} after ${ACQUIRE_LOCK_MAX_RECLAIM_FAILURES} consecutive attempts (${reason} — if nothing legitimate holds this lock, remove ${lockDir} manually and retry)`,
          );
        }
      }
```

with:

```ts
      const { reclaimed, error: reclaimError } = reclaimStaleLock(lockDir, staleMs);
      if (reclaimed) {
        reclaimedStale = true;
      } else if (isBenignReclaimRaceError(reclaimError)) {
        // Lost a benign race, not a broken reclaim — does not count toward
        // ACQUIRE_LOCK_MAX_RECLAIM_FAILURES. The next pass observes the
        // resulting state change (lockDir gone, or a fresh holder) through
        // the existsSync/isLockStale checks above and below, so this
        // resolves within a pass or two rather than needing its own bound.
        console.warn(`[registry] reclaim attempt lost a benign race for ${lockDir} (${reclaimError})`);
      } else {
        failedReclaimAttempts += 1;
        console.warn(
          `[registry] reclaim attempt ${failedReclaimAttempts}/${ACQUIRE_LOCK_MAX_RECLAIM_FAILURES} failed for ${lockDir}${reclaimError ? ` (${reclaimError})` : ' (lock was still alive on re-check)'}`,
        );
        if (failedReclaimAttempts >= ACQUIRE_LOCK_MAX_RECLAIM_FAILURES) {
          const reason = reclaimError
            ? `the rename kept failing: ${reclaimError}`
            : 'the lock kept appearing genuinely held on re-check';
          throw new Error(
            `Failed to reclaim stale lock at ${lockDir} after ${ACQUIRE_LOCK_MAX_RECLAIM_FAILURES} consecutive attempts (${reason} — if nothing legitimate holds this lock, remove ${lockDir} manually and retry)`,
          );
        }
      }
```

`isBenignReclaimRaceError(undefined)` returns `false`, so the pre-existing "still alive on re-check" branch (no `reclaimError`) is untouched and still counts, exactly as after #637.

- [ ] **Step 3: Direct unit tests for the predicate**

Add `isBenignReclaimRaceError` to the import list at the top of `src/lib/worktree/registry.test.ts`. Add a new `describe('isBenignReclaimRaceError', ...)` block (placed near the existing `describe('isPidAlive', ...)` block) with cases:
- `ENOENT` → `true`
- `ENOTDIR` → `true`
- `EPERM` → `false`
- `undefined` (no error) → `false`

- [ ] **Step 4: `acquireLock`-level proof that benign races don't count, and genuine ones still do**

Add one test to `describe('acquireLock / releaseLock staleness recovery', ...)`, next to the existing `#636` tests. Shape (mirrors the existing bound test's setup — unreadable `owner.json` via `EACCES` + backdated mtime, so `isLockStale`'s age fallback reports `stale: true` on every pass):

- Mock `fs.renameSync` to throw `ENOENT` for the first `ACQUIRE_LOCK_MAX_RECLAIM_FAILURES + 2` calls (5, at the current bound of 3 — deliberately *more* than the bound, proving those losses don't accumulate), then throw `EPERM` on every call after that.
- Assert `acquireLock(lockDir, { retries: 1, delayMs: 1, staleMs: 60_000 })` throws `/the rename kept failing.*EPERM/` — if the `ENOENT` calls had counted, it would have thrown after the 3rd one instead, with an `ENOENT` message.
- Assert `renameSpy` was called exactly `(ACQUIRE_LOCK_MAX_RECLAIM_FAILURES + 2) + ACQUIRE_LOCK_MAX_RECLAIM_FAILURES` times (8): the 5 uncounted benign losses, plus a fresh `ACQUIRE_LOCK_MAX_RECLAIM_FAILURES` genuine failures needed to trip the bound.
- One test proves both halves of the acceptance criteria at once: benign races don't count (otherwise it throws early, with the wrong message), and genuine errors still do (it does eventually throw, at the right count, with the right message) — no separate "still works for real errors" regression test is needed since the existing `#636`/`#636 review` tests already cover that unchanged behavior on their own (EPERM-only, no ENOENT prefix).

- [ ] **Step 5: Verify**

Run `pnpm exec vitest run --project unit src/lib/worktree/registry.test.ts` — RED before Steps 1–2 exist (import of `isBenignReclaimRaceError` fails to resolve), GREEN after. Then run the full `pnpm run verify` before pushing (per the `solve-issue` skill's hazards: `verify` is not a CI substitute for `prisma validate`/migration-drift/build/Playwright, but this change touches neither Prisma nor Playwright surfaces).

## What this plan does not do

- Does not change the "rename succeeded but lock still alive on re-check" case — unrelated to #638's scope (that's not a race against a sibling's rename; it's our own outer `isLockStale` snapshot going stale between the outer check and our own reclaim), and it already gets its own accurate message.
- Does not add a separate counter/bound for benign races — see the Decision section above for why relying on existing forward-progress checks is sufficient and does not reopen #636.
- Does not touch `unknownPasses`/`ACQUIRE_LOCK_MAX_UNKNOWN_PASSES` — untouched by #637, untouched here.
