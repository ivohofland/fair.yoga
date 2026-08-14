# Template Lock-Race Reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound the lock wait on the four template-lifecycle functions to 2 s, give each a `busy` outcome its route is compelled to answer with a 503, and record which of the four lost the race.

**Architecture:** Each of the four transactions opens with `setLockTimeout(tx)` so a contended row raises `55P03` in 2 s instead of expiring the 10 s transaction budget. Each catch tests `isTransientDbError(err)` first, logs with an operation-specific message, and returns `{ ok: false, reason: 'busy' }`. The four result unions widen, which makes the `never` guard at each route a compile error until answered. Separately, both template create routes gain the `{ timeout: 10_000 }` their peers already carry.

**Tech Stack:** TypeScript strict, Next.js App Router, Prisma 7, PostgreSQL, Vitest (three projects: `unit`, `components`, `integration`).

**Spec:** `docs/superpowers/specs/2026-08-14-template-lock-race-reporting-design.md`

## Global Constraints

- **Timeout value is `LOCK_TIMEOUT_SQL` (2 s), imported — never a new literal.** `src/lib/db-locks.ts` exists because this bound had already drifted into three copies.
- **`setLockTimeout(tx)` is the first statement of each transaction**, ahead of the compare-and-swap.
- **The `isTransientDbError` branch goes first in every catch**, ahead of `isUniqueConflictOn` and the P2025 sentinel. `P2028`/`P2024` are `PrismaClientKnownRequestError`s, the same class those branches inspect.
- **Copy shape is fixed:** *what happened to the data*, then *what to do*. Never name the sweep as the cause — the contender may be another tab. Exact strings are given per task.
- **Every `busy` return logs first.** Returning instead of throwing removes the API wrapper's automatic line; without a replacement this branch is an observability regression.
- **Status is 503, code is `TEMPLATE_BUSY` or `STUDIO_TEMPLATE_BUSY`.** `ApiFailure['status']` already admits 503.
- **Never write an auto-close keyword immediately before an issue number** in any commit message or PR body. Write "issue 113 is unaffected" or "leaves 113 open". This has closed this issue by accident twice.
- **Never `git add -A`.** Stage exact paths.
- **Never restart the dev server on :3000.** The user runs it; integration tests need it live.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/services/class-template-lifecycle.ts` | `ArchiveTemplateResult` + `PauseTemplateResult` unions; both class-family functions | 1, 3 |
| `src/services/studio-class-template-lifecycle.ts` | `ArchiveStudioTemplateResult` + `PauseStudioTemplateResult` unions; both studio functions | 2, 4 |
| `src/app/api/class-templates/[id]/route.ts` | Answers both class-family `busy` reasons | 1, 3 |
| `src/app/api/studio-class-templates/[id]/route.ts` | Answers both studio `busy` reasons | 2, 4 |
| `src/app/api/class-templates/route.ts` | Create-route transaction budget | 5 |
| `src/app/api/studio-class-templates/route.ts` | Create-route transaction budget | 5 |
| `src/services/class-generator.test.ts` | Class-family contention tests (one **must** be re-pointed) | 1, 3 |
| `src/services/studio-class-generator.test.ts` | Studio contention tests | 2, 4 |
| `docs/lock-order.md` | Records `archiveOrUnarchiveTemplate` as issuing no `lock_timeout` | 6 |
| `src/lib/api-errors.ts` | Docblock describing this work as unqueued | 6 |

## Task Order Is Load-Bearing

**Task 1 must land its test change in the same commit as its bound.** `src/services/class-generator.test.ts` currently holds a template's generation claim for **5.5 seconds** and asserts the contending archive still resolves `ok: true`. That assertion becomes impossible by design the moment the 2 s bound exists. Landing the bound without re-pointing the test leaves the suite red; re-pointing the test without the bound leaves it red the other way. One commit.

Its docblock warns *"do not delete it under the assumption the studio side still covers it"* — that warning stands. Task 1 **re-points** it; it does not delete it.

**Tests that survive untouched — do not "fix" them:**

| Test | Hold | Why it survives |
|---|---|---|
| `class-generator.test.ts` — "makes a concurrent archive wait until the claim transaction commits" | 300 ms | 300 ms < 2 s, so the archive still waits and still succeeds |
| `studio-class-generator.test.ts` — the ~400 ms mutual-exclusion test | 300 ms | same |
| `studio-class-generator.test.ts` — "opens its transaction with { timeout: 10_000 }" | none | spies on `$transaction` options; unaffected |
| `class-generator.test.ts` — the claim-then-archive sequential test | none | no concurrency at all |

---

### Task 1: Class-family archive — bound the wait, answer `busy`

**Files:**
- Modify: `src/services/class-template-lifecycle.ts` (imports, `ArchiveTemplateResult`, `archiveOrUnarchiveTemplate`)
- Modify: `src/app/api/class-templates/[id]/route.ts` (archive narrowing chain)
- Test: `src/services/class-generator.test.ts` (re-point the 5.5 s test)

**Interfaces:**
- Produces: `ArchiveTemplateResult` gains `| { ok: false; reason: 'busy' }`. Tasks 2–4 mirror this shape on their own unions.
- Consumes: `setLockTimeout(tx: TransactionClientOnly): Promise<void>` from `@/lib/db-locks`; `isTransientDbError(error: unknown): boolean` from `@/lib/api-errors`.

- [x] **Step 1: Re-point the failing test**

In `src/services/class-generator.test.ts`, replace the test titled `lets a concurrent archive outlive its own transaction default once the claim holds past it` (and its docblock) with the following. Keep it in the same `describe` block — it needs those fixtures.

```ts
    /**
     * Replaces a test that held the claim for 5.5s and asserted the archive
     * still resolved `ok: true`, proving `{ timeout: 10_000 }` beat Prisma's
     * 5s default. That proof is now unwritable: the archive takes a 2s
     * `lock_timeout`, so it can no longer wait 5.5s for a row under any
     * budget. The 10s budget still matters — it now covers the archive's own
     * work rather than its wait — and `studio-class-generator.test.ts`'s
     * `opens its transaction with { timeout: 10_000 }` pins that it is still
     * passed.
     *
     * What this pins instead is the bound itself, and the two bounds are
     * distinguishable only by timing: a 2s `lock_timeout` and a 10s
     * transaction budget both end in a rejected wait, so asserting merely
     * that the archive failed would go green against either. The upper bound
     * below is the whole assertion — it fails if the `lock_timeout` is
     * removed and the transaction budget produces the outcome instead.
     */
    it(
      'answers busy when the generation claim holds the row past the lock timeout',
      async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });

        const claiming = prisma.$transaction(
          async (tx) => {
            expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        // Let the claim acquire the lock before the archive contends for it.
        await new Promise((r) => setTimeout(r, 100));

        const startedAt = Date.now();
        const result = await archiveOrUnarchiveTemplate(prisma, templateId, teacherId, 'archived');
        const waited = Date.now() - startedAt;

        release();
        await claiming;

        expect(result).toEqual({ ok: false, reason: 'busy' });

        // The 2s lock_timeout produced this, not the 10s transaction budget.
        // Lower bound proves it actually waited rather than failing instantly
        // for some unrelated reason; upper bound proves which clock fired.
        expect(waited).toBeGreaterThanOrEqual(1_800);
        expect(waited).toBeLessThan(5_000);
      },
      20_000,
    );
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t "answers busy"`

Expected: FAIL. The archive currently waits the claim out and resolves `{ ok: true, action: 'archived', ... }`, so the `toEqual` fails — and `waited` is far above 5 000 because the release only happens after the archive settles.

- [x] **Step 3: Widen the union**

In `src/services/class-template-lifecycle.ts`, add the arm to `ArchiveTemplateResult`:

```ts
export type ArchiveTemplateResult =
  | { ok: true; action: 'archived'; template: ClassTemplate; deleted: number; remaining: number }
  | { ok: true; action: 'unarchived'; template: ClassTemplate }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'slot_conflict' }
  /**
   * The template row was held by another writer — the generation sweep, or
   * another tab's archive or resume — for longer than the 2s `lock_timeout`.
   * The whole transaction rolled back, so nothing was applied and the
   * identical request can win the next attempt.
   */
  | { ok: false; reason: 'busy' };
```

- [x] **Step 4: Confirm the union widening is a compile error at the route**

Run: `npx tsc --noEmit`

Expected: FAIL at `src/app/api/class-templates/[id]/route.ts` on `const unhandled: never = result;` — `Type '{ ok: false; reason: "busy"; }' is not assignable to type 'never'`.

This is the forcing function working. Record the exact message; it is the proof that the compile-time half of this design does what the spec claims.

- [x] **Step 5: Add the imports**

In `src/services/class-template-lifecycle.ts`, beside the existing `isUniqueConflictOn` import:

```ts
import { isUniqueConflictOn } from '@/lib/unique-conflict';
import { isTransientDbError } from '@/lib/api-errors';
import { setLockTimeout } from '@/lib/db-locks';
```

`@/lib/api-errors` imports only `@prisma/client`, and `@/lib/db-locks` is import-free besides Prisma types, so neither adds a server-only dependency to this chain.

- [x] **Step 6: Bound the wait**

In `archiveOrUnarchiveTemplate`, make `setLockTimeout(tx)` the first statement of the transaction callback, immediately before the CAS:

```ts
    return await db.$transaction(
      async (tx) => {
        // Bounds every statement left in this transaction, the CAS below
        // first among them. Without it the CAS waits on a sweep's claim for
        // the whole 10s budget and then dies as an opaque budget expiry that
        // says nothing about why. See `setLockTimeout` for why re-issuing it
        // later in the same transaction is safe.
        await setLockTimeout(tx);

        // Compare-and-swap, the pattern `updateClass` already uses for #72.
```

Then correct the comment a few lines below, which says the CAS is *"Still the transaction's first statement, deliberately"*. That is now false as written and true as meant — `SET LOCAL` takes no lock. Replace that sentence with:

```ts
        // Still the first statement to take a LOCK, deliberately — the
        // `setLockTimeout` above takes none. This is what locks the row
```

- [x] **Step 7: Return `busy` from the catch**

Replace the catch at the end of `archiveOrUnarchiveTemplate`:

```ts
  } catch (err) {
    // First, ahead of the unique-constraint branch below: `P2028`/`P2024` are
    // `PrismaClientKnownRequestError`s too, and testing for a slot conflict
    // first would let a transient code fall past a branch that cannot match
    // it into the rethrow — which is the generic failure this exists to
    // remove. Same ordering, same reason, as `classifyApiError`.
    //
    // Logged here rather than left to the API wrapper: returning instead of
    // throwing means the wrapper never sees this, and its automatic line
    // disappears with it. The message names the operation because the wrapper
    // cannot — an archive and a resume reach the same route with the same
    // method and the same path, and the query parameter that separates them
    // is deliberately excluded from request logs.
    if (isTransientDbError(err)) {
      log.warn({ err, templateId, teacherId }, 'recurring class archive lost the template lock race');
      return { ok: false, reason: 'busy' };
    }
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      return { ok: false, reason: 'slot_conflict' };
    }
    throw err;
  }
```

- [x] **Step 8: Answer it at the route**

In `src/app/api/class-templates/[id]/route.ts`, inside the `state === 'archived' || state === 'unarchived'` block, add above the `never` guard:

```ts
    if (result.reason === 'busy') {
      return respondError(
        `The system was busy and could not ${state === 'archived' ? 'archive' : 'unarchive'} this recurring class. Nothing was changed. Wait a moment, then try again.`,
        503,
        'TEMPLATE_BUSY',
      );
    }
```

"Nothing was changed" is load-bearing and true: every failure reaching here aborted the whole interactive transaction. It is also what makes the retry safe to invite.

- [x] **Step 9: Run the test and the typecheck**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS, including the three neighbouring tests listed in "Tests that survive untouched".

Run: `npx tsc --noEmit`
Expected: clean.

- [x] **Step 10: Mutation — prove the bound is what produced the outcome**

Comment out `await setLockTimeout(tx);` from Step 6.

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t "answers busy"`
Expected: FAIL — the archive waits the full claim out and resolves `ok: true`.

Record the exact failure text in `docs/superpowers/plans/2026-08-14-template-lock-race-reporting-mutations.md` under a `## Task 1` heading, then restore the line and re-run to confirm PASS.

- [x] **Step 11: Mutation — prove the catch branch is what classifies it**

Restore Step 6, then comment out the `isTransientDbError` branch from Step 7.

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t "answers busy"`
Expected: FAIL — the `55P03` is rethrown, so the `await` rejects instead of resolving `{ ok: false, reason: 'busy' }`.

Record the exact text, restore, re-run to confirm PASS.

- [x] **Step 12: Commit**

```bash
git add src/services/class-template-lifecycle.ts \
        "src/app/api/class-templates/[id]/route.ts" \
        src/services/class-generator.test.ts \
        docs/superpowers/plans/2026-08-14-template-lock-race-reporting-mutations.md
git commit -m "fix: an archive that loses the race says so in two seconds, not ten"
```

---

### Task 2: Studio archive — the same shape, on a union of its own

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` (imports, `ArchiveStudioTemplateResult`, `archiveOrUnarchiveStudioTemplate`)
- Modify: `src/app/api/studio-class-templates/[id]/route.ts` (archive narrowing chain)
- Test: `src/services/studio-class-generator.test.ts`

**Interfaces:**
- Consumes: `setLockTimeout`, `isTransientDbError` — same signatures as Task 1.
- Produces: `ArchiveStudioTemplateResult` gains `| { ok: false; reason: 'busy' }`.

- [x] **Step 1: Write the failing test**

Add to `src/services/studio-class-generator.test.ts`, in the same `describe` block as the existing mutual-exclusion test:

```ts
    /**
     * The studio half of the bound. The class family's equivalent
     * (`class-generator.test.ts`'s `answers busy when the generation claim
     * holds the row past the lock timeout`) proves the same mechanism, but
     * this is not a duplicate of it: the two functions have separate
     * transactions, separate catches and separate result unions, so a bound
     * dropped from one leaves the other's test green.
     *
     * The upper bound is the assertion that matters — a 2s `lock_timeout`
     * and a 10s transaction budget both end in a rejected wait, and only the
     * timing separates them.
     */
    it(
      'answers busy when the generation claim holds the row past the lock timeout',
      async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });

        const claiming = prisma.$transaction(
          async (tx) => {
            expect(await claimStudioTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        await new Promise((r) => setTimeout(r, 100));

        const startedAt = Date.now();
        const result = await archiveOrUnarchiveStudioTemplate(
          prisma,
          templateId,
          teacherId,
          'archived',
        );
        const waited = Date.now() - startedAt;

        release();
        await claiming;

        expect(result).toEqual({ ok: false, reason: 'busy' });
        expect(waited).toBeGreaterThanOrEqual(1_800);
        expect(waited).toBeLessThan(5_000);
      },
      20_000,
    );
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts -t "answers busy"`
Expected: FAIL — the archive waits the claim out and resolves `ok: true`.

- [x] **Step 3: Widen the union**

In `src/services/studio-class-template-lifecycle.ts`:

```ts
export type ArchiveStudioTemplateResult =
  | {
      ok: true;
      action: 'archived';
      template: StudioClassTemplate;
      deleted: number;
      remaining: number;
    }
  | { ok: true; action: 'unarchived'; template: StudioClassTemplate }
  | { ok: true; action: 'unchanged'; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'slot_conflict' }
  /** See `ArchiveTemplateResult`'s own `busy` arm — same meaning, same rollback guarantee. */
  | { ok: false; reason: 'busy' };
```

- [x] **Step 4: Confirm the compile error**

Run: `npx tsc --noEmit`
Expected: FAIL at `src/app/api/studio-class-templates/[id]/route.ts` on `const unhandled: never = result;`.

- [x] **Step 5: Add the imports**

```ts
import { isTransientDbError } from '@/lib/api-errors';
import { setLockTimeout } from '@/lib/db-locks';
```

- [x] **Step 6: Bound the wait**

First statement of `archiveOrUnarchiveStudioTemplate`'s transaction callback:

```ts
    return await db.$transaction(
      async (tx) => {
        // Bounds every statement left in this transaction, the CAS below
        // first among them — see the class family's twin for the full
        // reasoning.
        await setLockTimeout(tx);

        // Compare-and-swap, mirroring `archiveOrUnarchiveTemplate` — see there
```

Then correct the *"Still the transaction's first statement, deliberately"* sentence a few lines down, exactly as Task 1 did:

```ts
        // Still the first statement to take a LOCK, deliberately — the
        // `setLockTimeout` above takes none. This is what locks the row
```

- [x] **Step 7: Return `busy` from the catch**

```ts
  } catch (err) {
    // Transient first, ahead of the slot-conflict branch — see the class
    // family's twin for why the ordering is load-bearing rather than
    // stylistic, and for why the log line lives here rather than in the API
    // wrapper.
    if (isTransientDbError(err)) {
      log.warn(
        { err, templateId, teacherId },
        'studio class archive lost the template lock race',
      );
      return { ok: false, reason: 'busy' };
    }
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      return { ok: false, reason: 'slot_conflict' };
    }
    throw err;
  }
```

- [x] **Step 8: Answer it at the route**

In `src/app/api/studio-class-templates/[id]/route.ts`, above the archive block's `never` guard:

```ts
    if (result.reason === 'busy') {
      return respondError(
        `The system was busy and could not ${state === 'archived' ? 'archive' : 'unarchive'} this studio class. Nothing was changed. Wait a moment, then try again.`,
        503,
        'STUDIO_TEMPLATE_BUSY',
      );
    }
```

- [x] **Step 9: Run the tests and the typecheck**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: PASS, including the two neighbouring tests that must survive untouched.

Run: `npx tsc --noEmit`
Expected: clean.

- [x] **Step 10: Mutations**

Both mutations from Task 1, against this function: remove `setLockTimeout(tx)` (expect the archive to succeed instead), then restore and remove the `isTransientDbError` branch (expect a rejection instead of `busy`). Record both exact texts under `## Task 2` in the mutations file, restore, re-verify.

- [x] **Step 11: Commit**

```bash
git add src/services/studio-class-template-lifecycle.ts \
        "src/app/api/studio-class-templates/[id]/route.ts" \
        src/services/studio-class-generator.test.ts \
        docs/superpowers/plans/2026-08-14-template-lock-race-reporting-mutations.md
git commit -m "fix: the studio archive gets the same two-second answer"
```

---

### Task 3: Class-family pause/resume — a catch whose only sentinel is taken

**Files:**
- Modify: `src/services/class-template-lifecycle.ts` (`PauseTemplateResult`, `pauseOrResumeTemplate`)
- Modify: `src/app/api/class-templates/[id]/route.ts` (pause/resume narrowing chain)
- Test: `src/services/class-generator.test.ts`

**Interfaces:**
- Produces: `PauseTemplateResult` gains `| { ok: false; reason: 'busy' }`.
- Structural note: this function does not use `try`/`catch`. It uses a promise `.catch()` that returns `null` to mean "P2025 — the row went away", which the caller maps to `not_found`. `null` is therefore already spoken for. This task adds a **second** sentinel, `'busy'`, and a second narrowing beside `if (updated === null)`.

- [x] **Step 1: Write the failing test**

Add to `src/services/class-generator.test.ts`, in the same `describe` block as Task 1's test:

```ts
    /**
     * Pause/resume takes the same row as the archive, in the same kind of
     * transaction, against the same sweep — so it had the same unbounded
     * wait. Its own union carries `busy` separately, and a bound dropped
     * here would leave the archive's test green.
     *
     * The PAUSE arm, and that is forced rather than chosen.
     * `claimTemplateForGeneration` selects `WHERE isActive = true AND
     * isArchived = false`, so the sweep never claims a paused template — and
     * a resume only ever runs on one, because `isActive === desiredActive`
     * returns `unchanged` before the transaction otherwise. The two sets are
     * disjoint, so a resume cannot lose to the claim except through a narrow
     * interleaving where the template is activated between this function's
     * pre-transaction read and its write. The pause arm contends head-on:
     * active template, sweep holds it `FOR UPDATE`, the write blocks.
     *
     * It is also the tighter test. The pause arm returns at `if (!t.isActive)`
     * before generation, so its transaction is a single `update` — the lock
     * wait under test is the only thing in it.
     */
    it(
      'answers busy when a pause loses the row to the generation claim',
      async () => {
        // The sweep claims only an ACTIVE template, so this test needs one.
        await prisma.classTemplate.update({
          where: { id: templateId },
          data: { isActive: true, isArchived: false },
        });

        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });

        const claiming = prisma.$transaction(
          async (tx) => {
            expect(await claimTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        await new Promise((r) => setTimeout(r, 100));

        const startedAt = Date.now();
        const result = await pauseOrResumeTemplate(prisma, templateId, teacherId, 'paused');
        const waited = Date.now() - startedAt;

        release();
        await claiming;

        expect(result).toEqual({ ok: false, reason: 'busy' });
        expect(waited).toBeGreaterThanOrEqual(1_800);
        expect(waited).toBeLessThan(5_000);

        // Not redundant with the setup above, and it matters most during
        // mutation runs: with the bound removed the pause SUCCEEDS, and an
        // un-restored paused template would silently change what later tests
        // in this file are running against.
        await prisma.classTemplate.update({
          where: { id: templateId },
          data: { isActive: true },
        });
      },
      20_000,
    );
```

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t "answers busy when a pause"`
Expected: FAIL — the pause waits the claim out and resolves `{ ok: true, action: 'paused', ... }`.

If instead it fails at the *setup* assertion (`claimTemplateForGeneration` returning `null`), the template was not active when the claim ran. That is the failure mode this test was originally written into and is the reason it now forces `isActive: true` first.

- [x] **Step 3: Widen the union**

```ts
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'archived' }
  /** See `ArchiveTemplateResult`'s own `busy` arm — same meaning, same rollback guarantee. */
  | { ok: false; reason: 'busy' };
```

- [x] **Step 4: Confirm the compile error**

Run: `npx tsc --noEmit`
Expected: FAIL at `src/app/api/class-templates/[id]/route.ts` on the **last** `const unhandled: never = result;` in the file — the one closing the pause/resume *reason* chain.

Identify it by what it closes, not by counting. That file has **four** such guards and only two of them belong to this branch:

| Guard closes | Touched by |
|---|---|
| `UpdateTemplateResult` (from `updateClassTemplate`) | nobody — leave it |
| `ArchiveTemplateResult` | Task 1 |
| `switch (result.action)` on the **`ok: true`** arm | nobody — `busy` is `ok: false` and never reaches it |
| `PauseTemplateResult` reasons | **this task** |

- [x] **Step 5: Bound the wait and add the second sentinel**

In `pauseOrResumeTemplate`, add `setLockTimeout` as the first statement and widen the `.catch`:

```ts
  const updated = await db
    .$transaction(
      async (tx) => {
        // Bounds every statement left in this transaction, the `update` below
        // first among them — the sweep's claim holds this row `FOR UPDATE`,
        // and without this the wait is bounded only by the 10s budget.
        await setLockTimeout(tx);

        const t = await tx.classTemplate.update({
```

and:

```ts
    .catch((err: unknown) => {
      // Transient first, ahead of the P2025 sentinel below: `P2028`/`P2024`
      // are `PrismaClientKnownRequestError`s too, so testing `err.code ===
      // 'P2025'` first is safe today only because those codes differ — the
      // ordering is kept explicit so it stays safe if either test widens.
      //
      // A SECOND sentinel, because `null` already means P2025 below. Both are
      // narrowed at the call site; returning a bare `null` here for both would
      // report a busy template as `not_found`, which is the wrong answer and
      // an unretryable-sounding one.
      if (isTransientDbError(err)) {
        log.warn(
          { err, templateId, teacherId },
          'recurring class pause/resume lost the template lock race',
        );
        return 'busy' as const;
      }
      // Same window as `updateClassTemplate`'s guard above: the read at the
```

(keep the entire existing P2025 docblock and its `if` intact below this addition)

- [x] **Step 6: Narrow the second sentinel at the call site**

Immediately after the `.catch` block, ahead of the existing `null` check:

```ts
  if (updated === 'busy') return { ok: false, reason: 'busy' };
  if (updated === null) return { ok: false, reason: 'not_found' };
```

Order matters only for readability here — the two sentinels are disjoint — but `busy` goes first to match the catch.

- [x] **Step 7: Answer it at the route**

In `src/app/api/class-templates/[id]/route.ts`, above the second `never` guard:

```ts
  if (result.reason === 'busy') {
    return respondError(
      'The system was busy and could not update this recurring class. Nothing was changed. Wait a moment, then try again.',
      503,
      'TEMPLATE_BUSY',
    );
  }
```

"update" rather than "pause"/"resume": this arm serves both directions, and the CAS makes the transition itself the thing that did not happen.

- [x] **Step 8: Run the tests and the typecheck**

Run: `npx vitest run --project unit src/services/class-generator.test.ts src/services/class-template-lifecycle.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: clean.

- [x] **Step 9: Mutations**

Three here, not two — the second sentinel needs its own:

1. Remove `setLockTimeout(tx)` → the resume succeeds. Expect FAIL.
2. Remove the `isTransientDbError` branch → the error rejects. Expect FAIL.
3. Change `return 'busy' as const` to `return null` → the result becomes `{ ok: false, reason: 'not_found' }`. Expect FAIL on the `toEqual`. **This is the mutation that proves the two sentinels are actually distinguished** rather than collapsing into one answer.

Record all three exact texts under `## Task 3`, restore, re-verify.

- [x] **Step 10: Commit**

```bash
git add src/services/class-template-lifecycle.ts \
        "src/app/api/class-templates/[id]/route.ts" \
        src/services/class-generator.test.ts \
        docs/superpowers/plans/2026-08-14-template-lock-race-reporting-mutations.md
git commit -m "fix: a pause that loses the race stops calling itself not_found"
```

---

### Task 4: Studio pause/resume — a catch that does not exist

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` (`PauseStudioTemplateResult`, `pauseOrResumeStudioTemplate`)
- Modify: `src/app/api/studio-class-templates/[id]/route.ts` (pause/resume narrowing chain)
- Test: `src/services/studio-class-generator.test.ts`

**Interfaces:**
- Produces: `PauseStudioTemplateResult` gains `| { ok: false; reason: 'busy' }`.
- Structural note: this function has **no error handling at all** — the transaction result feeds a `switch` on `result.outcome`. A thrown error produces no `result` to switch on, so the catch must wrap the `$transaction` call rather than join the switch. This is the site neither the issue nor its two update comments identify.

- [x] **Step 1: Write the failing test**

Add to `src/services/studio-class-generator.test.ts`:

```ts
    /**
     * The site the issue never names. Unlike its three siblings this function
     * had no `catch` whatsoever, so a lost lock race propagated raw.
     *
     * The PAUSE arm, for the reason its class-family twin records in full:
     * `claimStudioTemplateForGeneration` selects `WHERE isActive = true`, a
     * resume only runs on a paused template, and the two sets are disjoint —
     * so a resume cannot lose to the claim.
     *
     * One consequence worth stating, because it is a coverage gap rather than
     * a non-issue: the pause arm does NOT take the generation claim (only the
     * active arm does), so this test does not exercise the claim re-issuing
     * the same 2s bound partway through the transaction. That re-issue is
     * safe by `setLockTimeout`'s own documented overwrite semantics, and the
     * bound the CAS waits under is the one set at the top either way — but
     * nothing here proves it.
     */
    it(
      'answers busy when a studio pause loses the row to the generation claim',
      async () => {
        // The sweep claims only an ACTIVE template, so this test needs one.
        await prisma.studioClassTemplate.update({
          where: { id: templateId },
          data: { isActive: true, isArchived: false },
        });

        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });

        const claiming = prisma.$transaction(
          async (tx) => {
            expect(await claimStudioTemplateForGeneration(tx, templateId)).not.toBeNull();
            await held;
          },
          { timeout: 15_000 },
        );

        await new Promise((r) => setTimeout(r, 100));

        const startedAt = Date.now();
        const result = await pauseOrResumeStudioTemplate(prisma, templateId, teacherId, 'paused');
        const waited = Date.now() - startedAt;

        release();
        await claiming;

        expect(result).toEqual({ ok: false, reason: 'busy' });
        expect(waited).toBeGreaterThanOrEqual(1_800);
        expect(waited).toBeLessThan(5_000);

        // Matters most during mutation runs: with the bound removed the pause
        // SUCCEEDS, and an un-restored paused template would silently change
        // what later tests in this file are running against.
        await prisma.studioClassTemplate.update({
          where: { id: templateId },
          data: { isActive: true },
        });
      },
      20_000,
    );
```

Add `pauseOrResumeStudioTemplate` to the existing import from `./studio-class-template-lifecycle` at the top of the file.

- [x] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts -t "answers busy when a studio pause"`
Expected: FAIL — the pause waits the claim out and succeeds, because nothing bounds it yet. Same shape as Tasks 1–3 at this point; what makes this function different shows up at the mutation in Step 9, where removing the branch restores a function with no `catch` at all.

- [x] **Step 3: Widen the union**

```ts
  | { ok: true; action: 'unchanged'; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'archived' }
  /** See `ArchiveTemplateResult`'s own `busy` arm — same meaning, same rollback guarantee. */
  | { ok: false; reason: 'busy' };
```

- [x] **Step 4: Confirm the compile error**

Run: `npx tsc --noEmit`
Expected: FAIL at `src/app/api/studio-class-templates/[id]/route.ts` on the **last** `const unhandled: never = result;` in the file — the one closing the pause/resume *reason* chain.

That file has **three** such guards: the archive's (Task 2), one inside the `switch (result.action)` over the `ok: true` arm (untouched — `busy` is `ok: false`), and this one.

- [x] **Step 5: Bound the wait and add the catch that does not exist**

Change `const result = await db.$transaction(` to a `let` with a `try`/`catch` around it, and open the callback with the bound:

```ts
  let result: ResumeTransactionOutcome;
  try {
    result = await db.$transaction(
      async (tx): Promise<ResumeTransactionOutcome> => {
        // Bounds every statement left in this transaction, the CAS below
        // first among them. This function's own docstring above used to note
        // that the claim's 2s bound "is not set yet at that point, so nothing
        // bounds this particular wait but the 10s" — this is what closes
        // that. The claim below re-issues the same bound, which overwrites
        // rather than stacks (see `setLockTimeout`).
        await setLockTimeout(tx);

        // Compare-and-swap, mirroring `archiveOrUnarchiveStudioTemplate`:
```

and after the transaction's closing `{ timeout: 10_000 },` / `);`:

```ts
  } catch (err) {
    // This function had no error handling at all before, so a lost lock race
    // propagated raw to the API wrapper — the only one of the four template
    // lifecycle functions in that state. The catch wraps the whole
    // `$transaction` rather than joining the switch below, because a throw
    // produces no `result` to switch on.
    if (isTransientDbError(err)) {
      log.warn(
        { err, templateId, teacherId },
        'studio class pause/resume lost the template lock race',
      );
      return { ok: false, reason: 'busy' };
    }
    throw err;
  }
```

Add the two imports if Task 2 has not already added them to this file:

```ts
import { isTransientDbError } from '@/lib/api-errors';
import { setLockTimeout } from '@/lib/db-locks';
```

- [x] **Step 6: Correct the docstring this falsifies**

`pauseOrResumeStudioTemplate`'s own docstring states the wait is unbounded. Replace that sentence:

```
 * concurrent archive's own CAS (also `FOR NO KEY UPDATE`), and can queue
 * behind either — bounded by the `setLockTimeout` this transaction now opens
 * with, so a wait it loses raises `55P03` in 2s and is reported as `busy`
 * rather than consuming the 10s budget. Once the CAS succeeds this
```

- [x] **Step 7: Answer it at the route**

Above the second `never` guard in `src/app/api/studio-class-templates/[id]/route.ts`:

```ts
  if (result.reason === 'busy') {
    return respondError(
      'The system was busy and could not update this studio class. Nothing was changed. Wait a moment, then try again.',
      503,
      'STUDIO_TEMPLATE_BUSY',
    );
  }
```

- [x] **Step 8: Run the tests and the typecheck**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts src/services/studio-class-template-lifecycle.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: clean.

- [x] **Step 9: Mutations**

1. Remove `setLockTimeout(tx)` → the resume succeeds. Expect FAIL.
2. Remove the `isTransientDbError` branch → the error rejects, restoring this function's pre-branch behaviour exactly. Expect FAIL.

Record both exact texts under `## Task 4`, restore, re-verify.

- [x] **Step 10: Commit**

```bash
git add src/services/studio-class-template-lifecycle.ts \
        "src/app/api/studio-class-templates/[id]/route.ts" \
        src/services/studio-class-generator.test.ts \
        docs/superpowers/plans/2026-08-14-template-lock-race-reporting-mutations.md
git commit -m "fix: the one lifecycle function with no catch at all"
```

---

### Task 5: Both create routes get the budget their peers carry

**Files:**
- Modify: `src/app/api/class-templates/route.ts`
- Modify: `src/app/api/studio-class-templates/route.ts`
- Test: `src/services/class-generator.test.ts`, `src/services/studio-class-generator.test.ts` — **no new tests**; see below.

**Interfaces:** none. This changes only a transaction option.

**Why no test.** The existing pin for this pattern is `studio-class-generator.test.ts`'s `opens its transaction with { timeout: 10_000 }`, which proxies `$transaction` to record its options. That technique needs a seam to inject the proxy through, and these two transactions are opened directly on the imported `prisma` singleton inside a route handler — there is no parameter to pass a spy through. Adding one to make the option testable would be a production change made solely for a test, on a route whose behaviour is otherwise unchanged. Recorded here as a deliberate gap rather than an oversight; the `{ timeout: 10_000 }` literal is visible in review and in `git log`.

- [x] **Step 1: Give the class create route the budget**

In `src/app/api/class-templates/route.ts`, add the options argument to the `$transaction` call:

```ts
      const generation = await generateInstancesForTemplate(tx, created);
      return { created, generation };
    },
    // Nine sequential statements on a 2GB VPS — one create, four candidate
    // probes and four inserts — against Prisma's 5s default, which every
    // peer transaction touching these rows already declines to run on. No
    // claim is taken here (the row is brand-new inside this transaction, so
    // nothing can race the insert), which also means no claim `lock_timeout`
    // bounds the FK waits: each generated class needs `FOR KEY SHARE` on the
    // `Teacher` row, and `email`/`pageSlug`/`accountId` are all `@unique`, so
    // a teacher changing their page slug in another tab takes `FOR UPDATE`
    // there and conflicts. This budget is what bounds that.
    { timeout: 10_000 },
  );
```

- [x] **Step 2: Give the studio create route the same**

In `src/app/api/studio-class-templates/route.ts`:

```ts
      const generation = await generateStudioInstancesForTemplate(tx, created);
      return { created, generation };
    },
    // Same reasoning as the class family's POST — both or neither. Raising
    // one family's create budget without the other reintroduces exactly the
    // asymmetry #191 was designed to avoid.
    { timeout: 10_000 },
  );
```

- [x] **Step 3: Verify both still pass**

Run: `npx vitest run --project unit src/services/class-generator.test.ts src/services/studio-class-generator.test.ts`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: clean.

- [x] **Step 4: Commit**

```bash
git add src/app/api/class-templates/route.ts src/app/api/studio-class-templates/route.ts
git commit -m "fix: both create routes stop running on Prisma's five-second default"
```

---

### Task 6: Correct every claim this branch made false

**Files:**
- Modify: `src/lib/api-errors.ts` (the `classifyApiError` docblock)
- Modify: `docs/lock-order.md` (the archive's row in the table, and "The two that do not")
- Modify: `src/services/class-template-lifecycle.ts` (the archive's `{ timeout: 10_000 }` comment)
- Modify: `src/services/studio-class-template-lifecycle.ts` (the archive's three-budget-chain comment)

**Interfaces:** none. Documentation and comments only.

**Why this is a task and not a step.** On issue 41 this exact instruction was followed and the defect shipped anyway, because a fix wave corrected two of a finding's three locations and reported success. Each location below gets its own checkbox and its own verdict.

- [x] **Step 1: `src/lib/api-errors.ts` — the docblock describing this work as unqueued**

`classifyApiError`'s docblock says the lock-race-to-503 mapping has landed but does not close this issue, and describes the `busy` variant as wanted. That is now history. Replace the paragraph with:

```
 * The lock-race-to-503 mapping this docblock once described as unqueued has
 * landed (the transient branch below), and the `busy` variants on the four
 * template lifecycle result unions have landed alongside it. They remain
 * complementary rather than redundant, and it is worth saying which does
 * what: the unions make contention a COMPILE error at four specific routes,
 * which a catch-all cannot; this branch makes it legible everywhere else,
 * which the unions cannot. A service that catches contention never reaches
 * here — by design, since it can say something more specific than this can.
```

**Hazard, and it has fired twice on this issue.** The text being replaced contains an auto-close keyword immediately followed by an issue number. That is inert in a source file — GitHub parses commit messages and PR bodies, not file contents — but quoting the old line into this task's commit message would close the issue for a third time. Do not quote it. Describe it.

- [x] **Step 2: `docs/lock-order.md` — the archive's `lock_timeout` status**

Two places, and both must change:

1. The table row listing `archiveOrUnarchiveTemplate` with its `Class` lock order — add that its statements are now bounded at 2 s.
2. "The two that do not — live, unfixed, and partly branch-caused", reason 2, which reads *"`archiveOrUnarchiveTemplate` under an explicit `{ timeout: 10_000 }`, and adding N × 2s `lockClassRow` waits to either needs the same timeout arithmetic"*.

For the second, append rather than rewrite — the cycle is **not fixed here** and the section must keep saying so:

```
Since the template lock-race work, `archiveOrUnarchiveTemplate` also issues
`SET LOCAL lock_timeout = '2s'`. That does not close this cycle and must not
be read as closing it: a bounded wait still deadlocks, it merely also has a
second way to end. What it changes is which SQLSTATE a caught race reports —
`40P01` when the detector fires first (it runs on a 1s `deadlock_timeout`, so
usually), `55P03` when the bound does. Both are in `TRANSIENT_SQLSTATES` and
both now answer `busy`, so the user-visible outcome is the same either way.

It also removes one of reason 2's obstacles rather than adding to it: the
arithmetic that paragraph worries about is now partly done. The archive's
transaction holds at most three statements that can wait on a lock — the CAS,
the `deleteMany`, and the notification inserts — so 3 × 2s sits inside the 10s
budget with headroom. An ordered pre-lock would add to that count, and its
author still owes this document the new sum.
```

- [x] **Step 3: `src/services/class-template-lifecycle.ts` — the archive's budget comment**

The comment above `{ timeout: 10_000 }` says matching the sweep's timeout "means this waits at most as long as the sweep could possibly run". With the 2 s bound that is no longer what the budget does. Replace the final sentence:

```ts
      // KEY UPDATE` conflicts with that, so an archive can block on a sweep
      // in progress. The wait itself is now bounded to 2s by the
      // `setLockTimeout` at the top of this transaction, so this budget no
      // longer governs the wait — it governs the archive's own work after the
      // lock is won, which on a loaded VPS can exceed Prisma's 5s default.
      { timeout: 10_000 },
```

- [x] **Step 4: `src/services/studio-class-template-lifecycle.ts` — the three-budget chain**

The long comment above the studio archive's `{ timeout: 10_000 }` reasons about a chain of three 10 s budgets and ends by attributing the resulting error surface to this issue. The chain reasoning is now wrong in its conclusion: each link waits at most 2 s, so the last link cannot exhaust its budget in lock-wait. Replace from *"Three 10s budgets do not compose, though"* to the end of that paragraph:

```ts
      // ordinary archive click into an opaque P2028. Three 10s budgets used
      // not to compose: a sweep holding the row, a PAUSE queued behind it and
      // this archive queued behind that pause meant the last link's own clock
      // ran while it waited its turn, and it was the one most likely to
      // exhaust its budget without ever reaching its own work. The
      // `setLockTimeout` at the top of this transaction is what took that
      // apart — each link now waits at most 2s and reports `busy`, so the
      // budget below covers only this transaction's own statements.
      //
      // A pause, not a resume, and the distinction is worth keeping: the
      // sweep's claim selects `WHERE isActive = true`, and a resume only runs
      // on a paused template, so a resume cannot be the middle link of that
      // chain. It can still be the HEAD of one — its CAS holds this row from
      // its `updateMany` through generation to commit — which is the case the
      // paragraph above describes.
```

- [x] **Step 5: Reconcile against the diff, not against a keyword**

Do not `grep` for a phrase. List what the wave changed and what it was supposed to change, and compare:

```bash
git diff --name-only HEAD~1
```

Expected, exactly four files: `src/lib/api-errors.ts`, `docs/lock-order.md`, `src/services/class-template-lifecycle.ts`, `src/services/studio-class-template-lifecycle.ts`.

A keyword sweep scoped to one correction cannot see another correction's twin — that is how issue 41 shipped a defect through two gates.

- [x] **Step 6: Full verification**

Run: `npm run verify`

This is typecheck + lint + all three vitest projects, including every file in `tests/integration/`. It needs the app running on :3000 — **do not start or restart it**; if it is not running, ask.

Expected: clean. Record the per-project file and test counts; the PR body needs them, and they must reconcile as a sum.

- [x] **Step 7: Commit**

```bash
git add src/lib/api-errors.ts docs/lock-order.md \
        src/services/class-template-lifecycle.ts \
        src/services/studio-class-template-lifecycle.ts
git commit -m "docs: four claims this branch made false by succeeding"
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: bound the wait → Tasks 1–4 Step 6/5; `busy` on the unions → Tasks 1–4 Step 3; copy → Tasks 1–4 Step 8/7; logging → Tasks 1–4 Step 7/5; create-route parity → Task 5; stale claims → Task 6; per-guard mutations → Tasks 1–4 Step 10/9.

**One spec item deliberately unmet, and it is recorded rather than dropped:** the spec asks for a test per function, and Task 5's create-route change ships without one. The reason is in Task 5 — there is no seam to inject a `$transaction` spy through without adding a parameter to production code for a test's benefit. Flagged for the reviewer to overrule if they disagree.

**Type consistency.** `setLockTimeout` and `isTransientDbError` are used with identical signatures in all four service tasks. `reason: 'busy'` is spelled identically in all four unions, all four services and all four routes. Error codes are `TEMPLATE_BUSY` (class family, both operations) and `STUDIO_TEMPLATE_BUSY` (studio family, both operations).

**Placeholder scan.** No TBD/TODO. Every code step carries the actual code.
