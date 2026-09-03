# Reconciliation Transience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A waitlist reconciliation tick whose failures are all transient stops reporting the job degraded — without letting a permanently contended sweep report success forever.

**Architecture:** `reconcileOne` already computes `isTransientDbError(err)` and discards it; this carries it into `ClassOutcome`, out through `ReconcileSummary`, and into a new escalation decision guarded by a cross-tick streak that production owns and every caller must name. Alongside it, `handleSpotFreed` wraps what it throws in a typed error carrying the window it was in, so its three callers can say which loss actually occurred.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess`, `lib: esnext`), Next.js App Router, Prisma/PostgreSQL, Vitest (projects: `unit`, `unit-sweeps`, `components`, `integration`), pino.

**Spec:** `docs/superpowers/specs/2026-09-03-reconciliation-transience-design.md`

## Global Constraints

- **`MAX_CONSECUTIVE_CONTENDED_TICKS = 5`.** The one threshold. Reused for both the tick-level and per-class escalations, because it has one meaning: *this has stood for five minutes*.
- **The number `5` is stated in `DEPLOYMENT.md`, never in a docblock.** It is operator-facing and it is a count; CLAUDE.md's *Comment Discipline* puts counts where they have an owner.
- **TypeScript strict, no `any`.** `noUncheckedIndexedAccess` is on: `Map.get()` returns `T | undefined` and needs `?? 0`. A `Record<UnionOfLiterals, T>` indexed by that union does **not** — it is a mapped type with explicit properties, not an index signature.
- **No migration, no schema change, no user-visible behaviour change.** Every difference is a log line, a thrown error, and one field of `/api/health`.
- **Every guard is broken before it is trusted.** Apply the named mutation, record the exact failure text in the commit body or the ledger, restore, re-verify.
- **Stage exact paths.** Never `git add -A` or `git add .`.
- **Comments state what is true now.** Correct a claim by replacing it, never by annotating it with what it used to say. The before-and-after goes in the PR body.
- **Task order is load-bearing.** Task 1 must precede Task 2 (the wrapper would otherwise silently break transience classification); Task 2 must precede Tasks 3 and 4 (they read `SpotFreedError`); Task 4 must precede Task 5 (the escalation reads `transientFailedClassIds`).

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/lib/api-errors.ts` | Classification. Gains a bounded `cause`-chain walk in `isTransientDbError`. | 1 |
| `src/lib/api-errors.test.ts` | Its tests. | 1 |
| `src/services/waitlist.ts` | `SpotFreedError`, the loss-phrase roster, `handleSpotFreed`'s wrapping. | 2 |
| `src/services/waitlist.test.ts` | Its tests. | 2 |
| `src/app/api/registrations/[id]/route.ts` | `promoteAfterCancel` names the loss. | 3 |
| `src/services/gdpr.ts` | The post-commit loop names the loss. | 3 |
| `src/services/gdpr.test.ts` | Asserts the branch reaches the payload. | 3 |
| `src/services/waitlist-reconciliation.ts` | Transience through the fold; the streak type; the escalation; the production entry point. | 4, 5, 6 |
| `src/services/waitlist-reconciliation.test.ts` | Its tests (`unit-sweeps` project). | 4, 5, 6 |
| `src/lib/scheduler.ts` | Injects the entry point that owns the tracker. | 5 |
| `src/lib/scheduler.test.ts` | Sweep-name pins and the job-table assertion. | 5 |
| `DEPLOYMENT.md` | The operator contract for this job's health. | 7 |

## Test Commands

The reconciliation suite is in the **`unit-sweeps`** project (see `SWEEP_TESTS` in `vitest.config.ts`), not `unit`. Getting this wrong reports "no test files found" and looks like a passing run.

```bash
npx vitest run --project unit        src/lib/api-errors.test.ts
npx vitest run --project unit        src/services/waitlist.test.ts
npx vitest run --project unit        src/services/gdpr.test.ts
npx vitest run --project unit        src/lib/scheduler.test.ts
npx vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts
npm run typecheck
```

These need the dev server live on `:3000` and the shared dev database. **Never kill or restart the server on :3000** — check first; if it is running it is the user's.

---

### Task 1: `isTransientDbError` follows the cause chain

Wrapping an error in Task 2 would otherwise silently reclassify every `P2024`/`P2028`/`P2034` on these paths as non-transient — because the first branch tests `instanceof Prisma.PrismaClientKnownRequestError`, and a wrapper is not that instance, and its message carries no SQLSTATE framing.

**Files:**
- Modify: `src/lib/api-errors.ts` (the `isTransientDbError` function)
- Test: `src/lib/api-errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `isTransientDbError(error: unknown): boolean` — unchanged signature, now walking `Error.cause` up to a fixed depth.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/api-errors.test.ts`, in the `isTransientDbError` describe block:

```ts
/**
 * The wrapping seam. `SpotFreedError` (`services/waitlist.ts`) carries the
 * real failure as `cause`, and the first branch of this matcher is an
 * `instanceof` check a wrapper cannot satisfy — so without the walk, a
 * connection-pool timeout reaching a `handleSpotFreed` call site would be
 * classified as a defect that never clears, log at `error`, and (in the
 * reconciliation sweep) redden `/api/health` immediately.
 */
it('sees a transient Prisma code through one layer of cause wrapping', () => {
  const pool = new Prisma.PrismaClientKnownRequestError('pool timeout', {
    code: 'P2024',
    clientVersion: Prisma.prismaVersion.client,
  });

  expect(isTransientDbError(new Error('spot-freed hook failed', { cause: pool }))).toBe(true);
});

it('sees a transient SQLSTATE through two layers of cause wrapping', () => {
  const lockTimeout = new Error(
    'Raw query failed. Code: `55P03`. Message: `ERROR: canceling statement due to lock timeout`',
  );
  const inner = new Error('spot-freed hook failed', { cause: lockTimeout });

  expect(isTransientDbError(new Error('sweep failed', { cause: inner }))).toBe(true);
});

/**
 * The bound, asserted rather than assumed. A chain is walked to a fixed depth
 * so a pathological or cyclic one cannot hang the classifier; a transient
 * error buried past that depth is reported non-transient, which is the safe
 * direction (it escalates rather than quieting).
 */
it('stops walking past its depth bound', () => {
  const transient = new Error('ERROR code: "55P03" here');
  let wrapped: Error = transient;
  for (let i = 0; i < 8; i += 1) wrapped = new Error(`layer ${i}`, { cause: wrapped });

  expect(isTransientDbError(wrapped)).toBe(false);
});

it('terminates on a cyclic cause chain', () => {
  const a = new Error('a');
  const b = new Error('b', { cause: a });
  (a as { cause?: unknown }).cause = b;

  expect(isTransientDbError(a)).toBe(false);
});

/**
 * A non-Error cause ends the walk rather than throwing — `cause` is typed
 * `unknown` and nothing stops a caller putting a string or a plain object
 * there.
 */
it('ends the walk at a non-Error cause', () => {
  expect(isTransientDbError(new Error('outer', { cause: 'code: "55P03"' }))).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/lib/api-errors.test.ts`

Expected: the first two FAIL (`expected false to be true`); the last three already pass, since a single-pass matcher returns `false` for all of them. That asymmetry is fine — they are regression pins for the bound, not drivers.

- [ ] **Step 3: Implement the walk**

In `src/lib/api-errors.ts`, rename the existing body to a private single-value predicate and add the walk. Keep the existing docblock on the exported function; add only what is newly true.

```ts
/**
 * How far `isTransientDbError` follows `Error.cause`.
 *
 * A bound rather than a full traversal: the chain is attacker-independent but
 * not guaranteed acyclic, and a classifier that can hang is worse than one
 * that occasionally escalates. Failing to find a transient cause past this
 * depth reports non-transient, which pages someone rather than quieting them.
 */
const MAX_CAUSE_DEPTH = 4;

/** The classification for one error, ignoring any `cause` it carries. */
function isTransientDbErrorShallow(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (TRANSIENT_PRISMA_CODES.has(error.code)) return true;
  }
  if (!(error instanceof Error)) return false;
  return TRANSIENT_SQLSTATES.some(
    (state) =>
      error.message.includes(`code: "${state}"`) || error.message.includes(`Code: \`${state}\``),
  );
}

export function isTransientDbError(error: unknown): boolean {
  let current = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH; depth += 1) {
    if (isTransientDbErrorShallow(current)) return true;
    if (!(current instanceof Error)) return false;
    current = current.cause;
  }
  return false;
}
```

Then extend the exported function's existing docblock with a paragraph stating the walk and why the bound is the safe direction. Do not describe what the function used to do.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/api-errors.test.ts`
Expected: PASS, all of them, including every pre-existing case.

- [ ] **Step 5: Prove the guard bites**

Replace the loop body with a single `return isTransientDbErrorShallow(error);`. Re-run. Record the exact failure text — expect `sees a transient Prisma code through one layer of cause wrapping` failing with `expected false to be true`. Restore, re-run, confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api-errors.ts src/lib/api-errors.test.ts
git commit -m "fix(errors): classify a transient failure through a wrapping cause chain"
```

---

### Task 2: `SpotFreedError` carries the window

**Files:**
- Modify: `src/services/waitlist.ts` (near `SpotFreedResult` and `handleSpotFreed`)
- Test: `src/services/waitlist.test.ts`

**Interfaces:**
- Consumes: `isTransientDbError` from Task 1.
- Produces:
  - `class SpotFreedError extends Error` with `readonly classId: string` and `readonly window: SpotFreedBranch | null`; the original failure is `cause`.
  - `type SpotFreedBranch = Exclude<WaitlistWindow, 'frozen'>`
  - `function spotFreedLoss(window: SpotFreedBranch | null): string`

- [ ] **Step 1: Write the failing tests**

Add to `src/services/waitlist.test.ts`, inside `describe('handleSpotFreed (DB)')`. These reuse the file's existing `$extends` injection idiom and its `classId` / `IN_CLAIM_WINDOW` fixtures.

```ts
/**
 * Which loss occurred, which no caller could previously tell.
 *
 * On the auto-promote branch the loss is one specific student not holding a
 * seat they should. On the broadcast branch it is N waiting students never
 * told a seat is free. Before this the three callers logged one message that
 * was true on either branch and specific to neither.
 */
it('wraps an auto-promote failure with its branch', async () => {
  const boom = new Error('injected: promotion failed');
  const failing = prisma.$extends({
    query: { waitlistEntry: { findMany() { throw boom; } } },
  }) as unknown as PrismaClient;

  const err = await handleSpotFreed(failing, classId, BEFORE_CLAIM_WINDOW).catch((e) => e);

  expect(err).toBeInstanceOf(SpotFreedError);
  expect(err).toMatchObject({ classId, window: 'auto_promote', cause: boom });
});

it('wraps a broadcast failure with its branch', async () => {
  const boom = new Error('injected: notification write failed');
  const failing = prisma.$extends({
    query: { notification: { createMany() { throw boom; } } },
  }) as unknown as PrismaClient;

  const err = await handleSpotFreed(failing, classId, IN_CLAIM_WINDOW).catch((e) => e);

  expect(err).toBeInstanceOf(SpotFreedError);
  expect(err).toMatchObject({ classId, window: 'first_come_first_claimed', cause: boom });
});

/**
 * The opening `class.findUnique` runs before the window resolves, so a failure
 * there has no branch to name. `null` is the honest answer and its own
 * diagnostic, not a missing value.
 */
it('wraps a pre-window failure with a null branch', async () => {
  const boom = new Error('injected: class read failed');
  const failing = prisma.$extends({
    query: { class: { findUnique() { throw boom; } } },
  }) as unknown as PrismaClient;

  const err = await handleSpotFreed(failing, classId, IN_CLAIM_WINDOW).catch((e) => e);

  expect(err).toBeInstanceOf(SpotFreedError);
  expect(err).toMatchObject({ classId, window: null, cause: boom });
});

/**
 * The seam with `isTransientDbError` (`lib/api-errors.ts`), asserted here
 * because this is where both halves exist. Wrapping moves the real failure out
 * of `instanceof` range; if the matcher stopped seeing it, every routine pool
 * timeout on these paths would log at `error` and — in the reconciliation
 * sweep — redden `/api/health` on the spot.
 */
it('stays classifiable as transient through the wrapper', async () => {
  const pool = new Prisma.PrismaClientKnownRequestError('pool timeout', {
    code: 'P2024',
    clientVersion: Prisma.prismaVersion.client,
  });
  const failing = prisma.$extends({
    query: { class: { findUnique() { throw pool; } } },
  }) as unknown as PrismaClient;

  const err = await handleSpotFreed(failing, classId, IN_CLAIM_WINDOW).catch((e) => e);

  expect(isTransientDbError(err)).toBe(true);
});

```

**The two things these tests need from the file.**

Add to the imports: `SpotFreedError` from `./waitlist`, and `isTransientDbError`
from `@/lib/api-errors`. `Prisma` and `PrismaClient` are already imported.

Add `BEFORE_CLAIM_WINDOW` beside the existing `IN_CLAIM_WINDOW` at the top of
`describe('handleSpotFreed (DB)')`, deriving it from the same fixed class the
block already documents there:

```ts
//   class starts       2026-06-03 09:00 UTC  (teacher default timezone UTC)
//   HOURS_24        →  deadline 2026-06-02 09:00 UTC
//   cutoff = deadline − 1h        2026-06-02 08:00 UTC
const IN_CLAIM_WINDOW = new Date('2026-06-02T08:30:00Z');
/** Before the cutoff, so `getWaitlistWindow` answers `auto_promote`. */
const BEFORE_CLAIM_WINDOW = new Date('2026-06-01T09:00:00Z');
```

**No test for `WaitlistPromotionError`, and the reason is structural rather
than an omission.** That error is caught *inside* `handleSpotFreed`'s
auto-promote branch and answered with `{ action: 'none' }` from within the
`try`, so it never reaches the new `catch` and there is no throw to wrap.
Record that in the implementation comment rather than writing a test that
would pass against a wrapper placed anywhere at all.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/waitlist.test.ts`
Expected: FAIL — `SpotFreedError` is not exported, so the file will not compile. That is the correct first failure.

- [ ] **Step 3: Implement the error, the roster, and the wrapping**

In `src/services/waitlist.ts`, immediately after the `SpotFreedResult` type:

```ts
/**
 * The window a throw came from.
 *
 * `'frozen'` is excluded because that window RETURNS `{ action: 'frozen' }`
 * before doing any work, so no throw can carry it. The `Exclude` is what makes
 * that a compiler fact rather than a sentence someone has to keep true.
 */
export type SpotFreedBranch = Exclude<WaitlistWindow, 'frozen'>;

/**
 * What was actually lost, by branch.
 *
 * A `Record` keyed on the branch union rather than a `switch` or an `if`
 * chain: adding a window member becomes a compile error here, and the three
 * call sites share one roster instead of keeping three copies of it in prose.
 */
const SPOT_FREED_LOSS: Record<SpotFreedBranch, string> = {
  auto_promote: 'the queue head was not promoted into the freed seat',
  first_come_first_claimed: 'the waiting students were not told the seat is free',
};

/** The deliberately general wording, for a failure that predates the window. */
const SPOT_FREED_LOSS_UNKNOWN = 'the freed seat was neither promoted nor broadcast';

/** The one phrase every `handleSpotFreed` caller logs, so the three cannot drift. */
export function spotFreedLoss(window: SpotFreedBranch | null): string {
  return window === null ? SPOT_FREED_LOSS_UNKNOWN : SPOT_FREED_LOSS[window];
}

/**
 * A `handleSpotFreed` failure, carrying the branch it happened on.
 *
 * The real failure is `cause`, which is why `isTransientDbError`
 * (`lib/api-errors.ts`) walks the cause chain: the classification that decides
 * a caller's log level — and, in the reconciliation sweep, whether the job
 * reports degraded — has to survive this wrapper.
 */
export class SpotFreedError extends Error {
  constructor(
    readonly classId: string,
    readonly window: SpotFreedBranch | null,
    cause: unknown,
  ) {
    super(`spot-freed hook failed for class ${classId}: ${spotFreedLoss(window)}`, { cause });
    this.name = 'SpotFreedError';
  }
}
```

Then restructure `handleSpotFreed`'s body. The existing body is unchanged apart from the surrounding `try`, the `branch` assignment, and the new `catch`:

```ts
export async function handleSpotFreed(
  db: PrismaClient,
  classId: string,
  now?: Date,
): Promise<SpotFreedResult> {
  let branch: SpotFreedBranch | null = null;
  try {
    // ... existing body, unchanged, except that immediately after
    //     `if (window === 'frozen') return { action: 'frozen' };`
    //     TypeScript has narrowed `window` to `SpotFreedBranch`, so add:
    //         branch = window;
  } catch (err) {
    throw new SpotFreedError(classId, branch, err);
  }
}
```

Place `branch = window;` on the line directly after the frozen early-return. Do not re-derive the window; the narrowing is what makes the assignment type-check without a cast.

Correct `handleSpotFreed`'s docblock where it describes the throw contract the three callers see. State what is true now; the previous wording belongs in the PR body.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/services/waitlist.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the guard bites**

Replace `branch = window;` with `branch = null;`. Re-run. Record the exact failures — expect both branch tests failing with `window: null` against the expected member. Restore, re-run, confirm green.

- [ ] **Step 6: Commit**

```bash
git add src/services/waitlist.ts src/services/waitlist.test.ts
git commit -m "feat(waitlist): name which loss a failed spot-freed hook caused"
```

---

### Task 3: The two live call sites name the loss

**Files:**
- Modify: `src/app/api/registrations/[id]/route.ts` (`promoteAfterCancel`)
- Modify: `src/services/gdpr.ts` (the post-commit loop in `deleteStudentAccount`)
- Test: `src/services/gdpr.test.ts`

**Interfaces:**
- Consumes: `SpotFreedError`, `spotFreedLoss` from Task 2.
- Produces: a `branch` field on both sites' log payloads, valued `'auto_promote' | 'first_come_first_claimed' | 'unknown'`.

- [ ] **Step 1: Write the failing test**

`gdpr.test.ts` already has `a diagnostic-loop failure after a lost handleSpotFreed race does not fail the already-committed erasure`, which injects at `handleSpotFreed`'s first statement. Add a sibling that injects on the **broadcast** branch, so the branch reaching the payload is a member rather than the `null` fallback:

```ts
/**
 * The branch reaches the log line.
 *
 * Before this the erasure's loop logged one message that was true whichever
 * branch threw — "the freed seat was neither promoted nor broadcast" — so an
 * operator reading it could not tell one student's lost seat from N students
 * never told about one. The window is resolved inside the hook; this asserts
 * it survives the throw.
 */
it('names the broadcast branch when the spot-freed hook fails after erasure', async () => {
  const fixture = await makeStudentWithFreedSpot();
  try {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
    onTestFinished(() => warn.mockRestore());

    // Inject INSIDE the broadcast transaction, past the point where the window
    // resolves — unlike the sibling test above, which fails the opening
    // `class.findUnique` and therefore gets the honest `null` branch.
    // `createBulkNotifications` (`services/notifications.ts`) issues exactly
    // one `notification.createMany`, and matching on the `spot_available` type
    // keeps this from touching any other notification write.
    const failing = prisma.$extends({
      query: {
        notification: {
          async createMany({ args, query }) {
            const rows = args.data as Array<{ type?: string }> | undefined;
            if (!Array.isArray(rows) || !rows.some((r) => r.type === 'spot_available')) {
              return query(args);
            }
            throw new Error('injected: broadcast write failed (code: "55P03")');
          },
        },
      },
    }) as unknown as PrismaClient;

    await expect(deleteStudentAccount(failing, fixture.studentId)).resolves.toBeUndefined();

    const logged = warn.mock.calls.find(
      (c) => (c[0] as { classId?: string } | undefined)?.classId === fixture.classId,
    );
    expect(logged?.[0]).toMatchObject({
      classId: fixture.classId,
      transient: true,
      branch: 'first_come_first_claimed',
    });
    expect(logged?.[1]).toContain('the waiting students were not told the seat is free');
  } finally {
    await cleanup(fixture);
  }
}, 15_000);
```

**Why this fixture reaches the broadcast branch.**
`makeStudentWithFreedSpot()` builds its class 48 h 30 min out with
`cancelDeadline: 'HOURS_48'`, so the deadline is 30 minutes ahead and the
cutoff (deadline − 1 h) is 30 minutes behind — `now` sits inside
`[cutoff, deadline)`, which is `first_come_first_claimed`. That is why the
race test beside it asserts a `spot_available` notification at all. Do not
build a second fixture.

The injected message carries `code: "55P03"` so `isTransientDbError` routes the
line to `log.warn`, matching the sibling test's reasoning and keeping
`log.error` free.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project unit src/services/gdpr.test.ts`
Expected: FAIL — the payload has no `branch` key, and the message is the general one.

- [ ] **Step 3: Implement both call sites**

In `src/services/gdpr.ts`, inside the post-commit loop's catch, replace the message selection:

```ts
const transient = isTransientDbError(err);
const window = err instanceof SpotFreedError ? err.window : null;
log[transient ? 'warn' : 'error'](
  { err, classId, waiting, transient, branch: window ?? 'unknown' },
  transient
    ? `gdpr: spot-freed hook lost a lock race after erasure — ${spotFreedLoss(window)}`
    : `gdpr: spot-freed hook failed after erasure — ${spotFreedLoss(window)}`,
);
```

Apply the identical shape in `promoteAfterCancel` with its own prefix (`waitlist spot-freed hook lost a lock race after cancel — …` / `waitlist spot-freed hook failed after cancel — …`).

**The route's line gets no test of its own, deliberately.** `promoteAfterCancel`
runs inside a Next.js route handler that must not throw, and asserting on its
log payload would mean driving the whole DELETE endpoint to provoke a
mid-transaction failure. What keeps the two sites honest is not a second test
but the shared `spotFreedLoss` roster from Task 2: both read the same
compiler-tethered `Record`, so the wording cannot drift between them and a new
window member is a compile error at one place. Say so in the code review rather
than leaving the gap unexplained.

Import `SpotFreedError` and `spotFreedLoss` from `./waitlist` (gdpr) and `@/services/waitlist` (the route).

Correct both docblocks. `promoteAfterCancel`'s records that the handler "cannot see" which branch threw and that `handleSpotFreed` knows; `gdpr.ts`'s cross-references it. Both are now false — replace them with what is true, and note in the PR body what they used to say.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/services/gdpr.test.ts && npm run typecheck`
Expected: PASS, including the pre-existing sibling test (whose injected error is now the `cause`, and whose branch is `'unknown'`).

- [ ] **Step 5: Prove the guard bites**

Hard-code `branch: 'unknown'` in the gdpr payload. Re-run; record the failure. Restore. Then separately confirm the pre-existing sibling test still passes with the real code — it is the case where `'unknown'` is *correct*, and a mutation that made every branch `'unknown'` must fail the new test while leaving that one green. If both fail, the fixture is wrong.

- [ ] **Step 6: Commit**

```bash
git add src/services/gdpr.ts src/services/gdpr.test.ts "src/app/api/registrations/[id]/route.ts"
git commit -m "fix(waitlist): both live spot-freed callers name the loss they caused"
```

---

### Task 4: Transience survives the fold

No escalation change yet — this is the seam Task 5 reads.

**Files:**
- Modify: `src/services/waitlist-reconciliation.ts`
- Test: `src/services/waitlist-reconciliation.test.ts`

**Interfaces:**
- Consumes: `SpotFreedError`, `spotFreedLoss` from Task 2.
- Produces:
  - `ClassOutcome`'s failed arm is `{ kind: 'failed'; transient: boolean }`
  - `ReconcileSummary.transientFailedClassIds: readonly string[]` — a subset of `failedClassIds`

- [ ] **Step 1: Write the failing assertions**

Extend the file's two existing classification tests rather than adding new ones — they already build the exact fixtures.

In `logs a non-transient per-class failure at error level`, after the existing assertions:

```ts
// The classification now leaves the function that computed it. Before this it
// picked a log level and was discarded, so nothing downstream could tell a
// lost race from a defect that will never clear.
expect(summary.transientFailedClassIds).not.toContain(broken.id);
```

In `logs a transient per-class failure at warn level`:

```ts
expect(summary.transientFailedClassIds).toContain(contended.id);
// A subset of `failedClassIds`, not a replacement for it — the same
// relationship `repairedClassIds` has to `reconciledClassIds`.
expect(summary.failedClassIds).toContain(contended.id);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts`
Expected: FAIL — `transientFailedClassIds` does not exist, so the file will not compile.

- [ ] **Step 3: Implement**

In `src/services/waitlist-reconciliation.ts`:

1. `ClassOutcome`'s failed arm becomes `| { kind: 'failed'; transient: boolean }`.
2. `ReconcileSummary` gains, immediately after `failedClassIds`:

```ts
/**
 * The subset of `failedClassIds` whose failure `isTransientDbError`
 * classified as a lost contention race — one a retry can win.
 *
 * A subset rather than a second partition, following `repairedClassIds`'
 * relationship to `reconciledClassIds`. It is what lets a caller separate "the
 * next tick will fix this" from "this fails again every sixty seconds
 * forever", which the summary previously could not express at all.
 */
readonly transientFailedClassIds: readonly string[];
```

3. `foldOutcomes` collects it in the `'failed'` case:

```ts
case 'failed':
  failedClassIds.push(classId);
  if (outcome.transient) transientFailedClassIds.push(classId);
  break;
```

4. `emptySummary` returns `transientFailedClassIds: []`.
5. `reconcileOne`'s catch returns `{ kind: 'failed', transient }` and adopts the loss phrase:

```ts
const transient = isTransientDbError(err);
const window = err instanceof SpotFreedError ? err.window : null;
log[transient ? 'warn' : 'error'](
  { err, classId: cls.id, transient, branch: window ?? 'unknown' },
  transient
    ? `waitlist reconciliation lost a lock race for one class — ${spotFreedLoss(window)}, retrying next tick`
    : `waitlist reconciliation failed for one class and will not recover by retrying — ${spotFreedLoss(window)}`,
);
return { kind: 'failed', transient };
```

6. Correct the paragraph in that catch describing `transient` as deciding "a log level and a message" — it now also leaves the function.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the guard bites**

Hard-code `return { kind: 'failed', transient: false };`. Re-run; record the failure (`transientFailedClassIds` missing the contended id). Restore, re-verify.

- [ ] **Step 6: Commit**

```bash
git add src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts
git commit -m "feat(waitlist): carry per-class transience out of the reconciliation fold"
```

---

### Task 5: The streak, the required tracker, and the tick escalation

The largest task, and it does not split: the required-`opts` signature change and the scheduler wiring must land in one commit or the tree does not compile, and the escalation is the only reason the state exists.

**Files:**
- Modify: `src/services/waitlist-reconciliation.ts`
- Modify: `src/lib/scheduler.ts`
- Modify: `src/lib/scheduler.test.ts`
- Test: `src/services/waitlist-reconciliation.test.ts` (19 existing call sites gain a tracker — `grep -c "reconcileWaitlists(" src/services/waitlist-reconciliation.test.ts`)

**Interfaces:**
- Consumes: `transientFailedClassIds` from Task 4.
- Produces:
  - `interface ReconciliationStreaks { allTransientTicks: number; failuresByClass: Map<string, number> }`
  - `function createReconciliationStreaks(): ReconciliationStreaks`
  - `function reconcileWaitlists(db: PrismaClient, opts: ReconcileOptions): Promise<ReconcileSummary>` — `opts` **required**, with a **required** `streaks` field
  - `function runWaitlistReconciliationTick(db: PrismaClient): Promise<ReconcileSummary>`
  - `ReconciliationFailedError` gains `readonly reason: 'non_transient' | 'contended'`

- [ ] **Step 1: Write the failing tests**

Add to `src/services/waitlist-reconciliation.test.ts`:

```ts
/**
 * A tick that lost every class to contention must NOT report the job
 * degraded — and after five of them in a row, it must.
 *
 * On a single-teacher VPS one candidate class per tick is the ordinary case,
 * so "every class it tried failed" is reachable from one benign lock race that
 * the next tick repairs. Throwing on that trains an operator to ignore
 * `/api/health`. But never throwing reproduces #354 here: a leaked `idle in
 * transaction` session holding a Class row makes every tick fail forever while
 * the job reports success.
 */
it('tolerates consecutive all-transient ticks, then reports the job degraded', async () => {
  const contended = await makeFreedSeat('StreakContended');
  const clocks = windowClocks(contended.startTime);
  const streaks = createReconciliationStreaks();

  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  onTestFinished(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  // Injected for EVERY class, so whatever leftover candidates another run left
  // behind fail too and the all-failed condition holds without this test
  // owning every row — the same reasoning as `throws when every class it
  // invoked failed`.
  const faulty = prisma.$extends({
    query: {
      class: {
        findUnique() {
          throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
            code: 'P2024',
            clientVersion: Prisma.prismaVersion.client,
          });
        },
      },
    },
  }) as unknown as PrismaClient;

  for (let tick = 1; tick < 5; tick += 1) {
    const summary = await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
    expect(summary.failedClassIds).toContain(contended.id);
    expect(streaks.allTransientTicks).toBe(tick);
  }

  await expect(
    reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks }),
  ).rejects.toMatchObject({ name: 'ReconciliationFailedError', reason: 'contended' });
});

/**
 * The streak is about UNBROKEN contention. A tick that reconciled something
 * proves the sweep is working, so the count starts again — otherwise five
 * scattered lock races over an hour would report a wedged sweep.
 */
it('resets the contention streak on a tick that reconciled a class', async () => {
  const contended = await makeFreedSeat('StreakReset');
  const clocks = windowClocks(contended.startTime);
  const streaks = createReconciliationStreaks();

  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  onTestFinished(() => warn.mockRestore());

  const faulty = prisma.$extends({
    query: {
      class: {
        findUnique() {
          throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
            code: 'P2024',
            clientVersion: Prisma.prismaVersion.client,
          });
        },
      },
    },
  }) as unknown as PrismaClient;

  await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
  expect(streaks.allTransientTicks).toBe(1);

  await reconcileWaitlists(prisma, { now: clocks.inClaimWindow, streaks });
  expect(streaks.allTransientTicks).toBe(0);
});

/**
 * A failure that will never clear by retrying escalates on the FIRST tick.
 * Routing it through the streak would hide a permanently broken promotion path
 * for five minutes, which is the defect this module exists to remove.
 */
it('reports the job degraded immediately for a non-transient all-failed tick', async () => {
  const cls = await makeFreedSeat('ImmediateFail');
  const clocks = windowClocks(cls.startTime);
  const streaks = createReconciliationStreaks();

  const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  onTestFinished(() => error.mockRestore());

  const faulty = prisma.$extends({
    query: { class: { findUnique() { throw new Error('schema drift'); } } },
  }) as unknown as PrismaClient;

  await expect(
    reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks }),
  ).rejects.toMatchObject({ name: 'ReconciliationFailedError', reason: 'non_transient' });
});

/**
 * **Issue #269's acceptance criterion, at the real mechanism.** Everything
 * above injects a fault; this holds an actual `Class` row past
 * `lockClassRow`'s 2 s bound so the failure is a genuine `55P03` from
 * Postgres, with ONE candidate so the tick is all-failed.
 *
 * Follows `reconciles the remaining classes when one loses its lock race`,
 * which uses the same holder shape with two candidates.
 */
it('does not report degraded when its only class loses a real lock race', async () => {
  const contended = await makeFreedSeat('RealLockSolo');
  const clocks = windowClocks(contended.startTime);
  const streaks = createReconciliationStreaks();

  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  onTestFinished(() => warn.mockRestore());

  const holderClient = new PrismaClient();
  let signalHeld!: () => void;
  const lockHeld = new Promise<void>((r) => { signalHeld = r; });
  const holder = holderClient.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Class" WHERE id = ${contended.id} FOR UPDATE`;
      signalHeld();
      // Past lockClassRow's 2s bound, under Prisma's 5s default budget, so the
      // failure is 55P03 from Postgres rather than P2028 from the client.
      await new Promise((r) => setTimeout(r, 3_500));
    },
    { timeout: 30_000 },
  );
  await lockHeld;

  const summary = await reconcileWaitlists(prisma, { now: clocks.inClaimWindow, streaks });

  await holder;
  await holderClient.$disconnect();

  expect(summary.failedClassIds).toContain(contended.id);
  expect(summary.transientFailedClassIds).toContain(contended.id);
});
```

**A hazard this test must respect:** the sweep is database-wide, so another
class left behind by an earlier test may reconcile in the same tick and make
this one not all-failed. The assertions above are deliberately about
`contended.id` alone rather than about the tick throwing, which keeps them true
either way. Do not strengthen them to `expect(...).resolves` on the tick.

Add to `src/lib/scheduler.test.ts`: rename `reconcileWaitlists` to
`runWaitlistReconciliationTick` in `SWEEP_NAMES`, and in the job-table equality
change `'waitlist-reconciliation': ['reconcileWaitlists']` to
`['runWaitlistReconciliationTick']`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts`
Expected: FAIL — `createReconciliationStreaks` is not exported.

- [ ] **Step 3: Implement the streak type and the entry point**

In `src/services/waitlist-reconciliation.ts`:

```ts
/**
 * Ticks of unbroken contention before the sweep reports itself degraded.
 *
 * Reused for the per-class escalation because it has one meaning: this has
 * stood for five minutes. The operator-facing statement of what that buys
 * lives in `DEPLOYMENT.md`, not here.
 */
const MAX_CONSECUTIVE_CONTENDED_TICKS = 5;

/**
 * What one caller remembers between ticks.
 *
 * The sweep cannot tell a lock race that the next tick repairs from a wedged
 * row lock that no tick will ever repair, because both look identical inside
 * one tick. Only repetition separates them, and only a caller that persists
 * across ticks can see repetition.
 */
export interface ReconciliationStreaks {
  /** Consecutive ticks in which every invoked class failed, all transiently. */
  allTransientTicks: number;
  /**
   * Consecutive failures per class, rebuilt each tick from that tick's
   * failures — so a class that did not fail leaves the map, and its size is
   * bounded by the candidate set rather than by uptime.
   */
  failuresByClass: Map<string, number>;
}

export function createReconciliationStreaks(): ReconciliationStreaks {
  return { allTransientTicks: 0, failuresByClass: new Map() };
}

export interface ReconcileOptions {
  now?: Date;
  /**
   * REQUIRED, and that is the wiring tether rather than pedantry.
   * `SchedulerSweeps` types every sweep as `(db) => Promise<unknown>`, so a
   * one-parameter `reconcileWaitlists` would fit that slot and run without
   * memory, silently. TypeScript refuses to assign a two-parameter function to
   * a one-parameter signature, so only `runWaitlistReconciliationTick` fits.
   */
  streaks: ReconciliationStreaks;
}

/**
 * The scheduler's entry point: the one caller with memory across ticks.
 *
 * Its tracker is module-level because a tick has no other place to keep state
 * and `scheduler.ts` must not statically import a service module — the dynamic
 * imports in `startScheduler` are what keep `instrumentation.ts` loadable in
 * the edge runtime.
 */
const productionStreaks = createReconciliationStreaks();

export function runWaitlistReconciliationTick(db: PrismaClient): Promise<ReconcileSummary> {
  return reconcileWaitlists(db, { streaks: productionStreaks });
}
```

Change `reconcileWaitlists`' signature to `(db: PrismaClient, opts: ReconcileOptions)` and read `opts.now` as before.

- [ ] **Step 4: Implement the escalation**

Replace `ReconciliationFailedError` and add the decision:

```ts
export class ReconciliationFailedError extends Error {
  constructor(
    public readonly failedClassIds: readonly string[],
    public readonly reason: 'non_transient' | 'contended',
  ) {
    super(
      reason === 'non_transient'
        ? `waitlist reconciliation invoked ${failedClassIds.length} class(es) and every one failed`
        : `waitlist reconciliation lost every class to contention for ${MAX_CONSECUTIVE_CONTENDED_TICKS} consecutive ticks`,
    );
    this.name = 'ReconciliationFailedError';
  }
}

type Escalation = 'none' | 'non_transient' | 'contended';

/** True when the tick invoked classes, failed every one, and every failure was transient. */
function isContendedTick(summary: ReconcileSummary): boolean {
  return (
    summary.failedClassIds.length > 0 &&
    summary.reconciledClassIds.length === 0 &&
    summary.transientFailedClassIds.length === summary.failedClassIds.length
  );
}

/** Pure. The streak has already been updated, so `allTransientTicks` is this tick's. */
function decideEscalation(summary: ReconcileSummary, allTransientTicks: number): Escalation {
  const allFailed =
    summary.failedClassIds.length > 0 && summary.reconciledClassIds.length === 0;
  if (!allFailed) return 'none';
  if (!isContendedTick(summary)) return 'non_transient';
  return allTransientTicks >= MAX_CONSECUTIVE_CONTENDED_TICKS ? 'contended' : 'none';
}
```

In `reconcileWaitlists`, between the fold and `report`:

```ts
const summary = foldOutcomes(classes.length, outcomes);
opts.streaks.allTransientTicks = isContendedTick(summary)
  ? opts.streaks.allTransientTicks + 1
  : 0;
report(summary, opts.streaks.allTransientTicks, decideEscalation(summary, opts.streaks.allTransientTicks));
return summary;
```

Rewrite `report`'s first branch to take the decision rather than re-deriving it:

```ts
function report(
  summary: ReconcileSummary,
  contendedTicks: number,
  escalation: Escalation,
): void {
  const skipCounts = countSkipReasons(summary.skipped);
  const payload = {
    candidates: summary.candidates,
    reconciled: summary.reconciledClassIds.length,
    repaired: summary.repairedClassIds.length,
    failed: summary.failedClassIds.length,
    transientFailed: summary.transientFailedClassIds.length,
    contendedTicks,
    skipped: skipCounts,
  };

  if (escalation !== 'none') {
    // `error`, whatever each individual failure was classified as. A tick that
    // invoked N classes and failed all N is a different statement at any N.
    log.error(
      payload,
      escalation === 'non_transient'
        ? 'waitlist reconciliation repaired nothing — every class it tried failed'
        : 'waitlist reconciliation has lost every class to contention for too many consecutive ticks',
    );
    throw new ReconciliationFailedError(summary.failedClassIds, escalation);
  }

  if (summary.failedClassIds.length > 0 && summary.reconciledClassIds.length === 0) {
    // Every class lost a lock race and the streak is still short. The next
    // tick retries; the job stays healthy. This is the false alarm #269 was
    // filed about, and the line that keeps it visible without paging anyone.
    log.warn(payload, 'waitlist reconciliation lost every class to contention — retrying next tick');
    return;
  }

  // ... the remaining three branches unchanged ...
}
```

Then correct `ReconciliationFailedError`'s docblock (its "costs nothing in the routine case" argument now has a named exception), the module header's "this module detects" framing (it holds cross-tick state now), and `reconcileOne`'s catch paragraph if Task 4 left anything stale.

- [ ] **Step 5: Wire production and update the existing call sites**

In `src/lib/scheduler.ts`: rename the `SchedulerSweeps` key to `runWaitlistReconciliationTick`, destructure it in `buildJobs`, and change the job entry to `run: (db) => runWaitlistReconciliationTick(db)`. In `startScheduler`, import `runWaitlistReconciliationTick` from `@/services/waitlist-reconciliation` in place of `reconcileWaitlists` and pass it under the new key.

In `src/services/waitlist-reconciliation.test.ts`, extend the existing import to
`import { ReconciliationFailedError, createReconciliationStreaks, reconcileWaitlists, runWaitlistReconciliationTick } from './waitlist-reconciliation';`,
then give all 19 calls an explicit tracker. Most become `{ now: …, streaks: createReconciliationStreaks() }`. **One needs care:** `broadcasts once, then gates itself, on the real clock with no injected now` is the file's only no-`opts` call, and its docblock frames that as the production call path. The property it pins is the absent **clock**, which survives — pass `{ streaks }` and keep `now` omitted, with one tracker shared by both calls in that test. Do **not** switch it to `runWaitlistReconciliationTick`: that would couple it to the module-level tracker and hand a shared streak to whatever runs next. Replace the docblock's "no `opts`" framing with what is true.

Add a small delegation test for the wrapper:

```ts
/**
 * The production entry point runs the sweep and, unlike every other caller in
 * this file, carries memory between ticks. Asserting it delegates at all is
 * what stops the wiring in `scheduler.ts` from pointing at a function that
 * quietly forgets.
 */
it('runs the sweep through the production entry point', async () => {
  const summary = await runWaitlistReconciliationTick(prisma);
  expect(summary.candidates).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 6: Run everything**

```bash
npm run typecheck
npx vitest run --project unit src/lib/scheduler.test.ts
npx vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts
```

Expected: PASS.

- [ ] **Step 7: Prove three guards bite**

1. **The wiring tether.** In `scheduler.ts`, pass `reconcileWaitlists` under the `runWaitlistReconciliationTick` key. Run `npm run typecheck`; record the error — expect `TS2322 … Target signature provides too few arguments. Expected 2 or more, but got 1.` Restore.
2. **The tolerance itself.** Restore the unconditional escalation — make `decideEscalation` return `'non_transient'` for any all-failed tick, as it did before this branch. Re-run; record the failure on the **first** loop iteration of `tolerates consecutive all-transient ticks…`. This is the mutation that proves ticks 1–4 stay green, which raising the threshold cannot prove. Restore.
3. **The threshold.** Raise `MAX_CONSECUTIVE_CONTENDED_TICKS` to `50`. Re-run; record the failure on the final `rejects.toMatchObject` of the same test. This proves the throw arrives at 5, which mutation 2 cannot prove. Restore.
4. **The immediate non-transient escalation.** Route the non-transient case through the streak (return `'none'` unless `allTransientTicks >= MAX_…`). Re-run; record the failure in `reports the job degraded immediately…`. Restore.

Mutations 2 and 3 are a pair: one proves the tolerance exists, the other proves
it ends. Either alone leaves half the rule uncovered.

Re-run everything and confirm green before committing.

- [ ] **Step 8: Commit**

```bash
git add src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts src/lib/scheduler.ts src/lib/scheduler.test.ts
git commit -m "feat(waitlist): tolerate benign contention, escalate a wedged sweep"
```

---

### Task 6: The persistently contended class

Today a class contended forever is invisible the moment any *other* class reconciles, because the escalation requires `reconciledClassIds.length === 0`.

**Files:**
- Modify: `src/services/waitlist-reconciliation.ts`
- Test: `src/services/waitlist-reconciliation.test.ts`

**Interfaces:**
- Consumes: `ReconciliationStreaks.failuresByClass` from Task 5.
- Produces: a `classStreak` field on the per-class failure log payload; the level escalates to `error` at the threshold.

- [ ] **Step 1: Write the failing test**

```ts
/**
 * A class stuck behind a healthy sibling.
 *
 * The tick-level escalation cannot see this one: it requires that NO class
 * reconciled, so a single wedged class hides completely as soon as anything
 * else works. That was inherited rather than decided. The decision is an
 * `error` line naming the class and its streak — visible to log alerting,
 * without holding an otherwise-working job at `degraded` indefinitely.
 */
it('escalates a class contended for too many consecutive ticks, without reddening the job', async () => {
  const stuck = await makeFreedSeat('PerClassStuck');
  const healthy = await makeFreedSeat('PerClassHealthy');
  const clocks = windowClocks(stuck.startTime);
  const streaks = createReconciliationStreaks();

  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);
  onTestFinished(() => {
    warn.mockRestore();
    error.mockRestore();
  });

  const faulty = prisma.$extends({
    query: {
      class: {
        findUnique({ args, query }) {
          if (args.where?.id === stuck.id) {
            throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
              code: 'P2024',
              clientVersion: Prisma.prismaVersion.client,
            });
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;

  const forClass = (
    calls: Array<[unknown, ...unknown[]]>,
  ): Array<{ classId?: string; classStreak?: number }> =>
    calls
      .map((c) => c[0] as { classId?: string; classStreak?: number })
      .filter((p) => p?.classId === stuck.id);

  for (let tick = 1; tick < 5; tick += 1) {
    await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
    expect(forClass(warn.mock.calls).at(-1)).toMatchObject({ classStreak: tick });
    expect(forClass(error.mock.calls)).toHaveLength(0);
  }

  // The fifth consecutive failure crosses the threshold. `healthy` is still
  // reconciling every tick, so the job itself never reports degraded.
  const summary = await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
  expect(summary.reconciledClassIds).toContain(healthy.id);
  expect(forClass(error.mock.calls).at(-1)).toMatchObject({ classStreak: 5 });
});

/**
 * The map is rebuilt from each tick's failures, so a class that recovers does
 * not carry its old count into a later failure.
 */
it('drops a class from the streak map once it stops failing', async () => {
  const flaky = await makeFreedSeat('PerClassFlaky');
  const clocks = windowClocks(flaky.startTime);
  const streaks = createReconciliationStreaks();

  const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);
  onTestFinished(() => warn.mockRestore());

  const faulty = prisma.$extends({
    query: {
      class: {
        findUnique({ args, query }) {
          if (args.where?.id === flaky.id) {
            throw new Prisma.PrismaClientKnownRequestError('pool timeout', {
              code: 'P2024',
              clientVersion: Prisma.prismaVersion.client,
            });
          }
          return query(args);
        },
      },
    },
  }) as unknown as PrismaClient;

  await reconcileWaitlists(faulty, { now: clocks.inClaimWindow, streaks });
  expect(streaks.failuresByClass.get(flaky.id)).toBe(1);

  await reconcileWaitlists(prisma, { now: clocks.inClaimWindow, streaks });
  expect(streaks.failuresByClass.has(flaky.id)).toBe(false);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts`
Expected: FAIL — no `classStreak` in the payload.

- [ ] **Step 3: Implement**

Thread a per-tick context into `reconcileOne` rather than moving the logging into the fold. `reconcileOne`'s docblock argues the extraction exists so a class's outcome is a **return value**; putting the error into the outcome so the fold could log it would make the outcome carry a side effect the function already performed.

```ts
/**
 * The two failure maps one tick needs: the previous tick's counts to read, and
 * this tick's to build. Swapped in once after the loop, so a class that did
 * not fail simply is not in the new one.
 */
interface TickFailures {
  readonly prior: ReadonlyMap<string, number>;
  readonly next: Map<string, number>;
}
```

In `reconcileWaitlists`, before the loop:

```ts
const failures: TickFailures = { prior: opts.streaks.failuresByClass, next: new Map() };
```

pass `failures` to each `reconcileOne` call, and after the loop:

```ts
opts.streaks.failuresByClass = failures.next;
```

In `reconcileOne`'s catch:

```ts
const transient = isTransientDbError(err);
const classStreak = (failures.prior.get(cls.id) ?? 0) + 1;
failures.next.set(cls.id, classStreak);
const window = err instanceof SpotFreedError ? err.window : null;
// `error` for a failure that will not clear by retrying (as before) OR for a
// transient one that has now stood for the whole threshold. The second is the
// only signal a class wedged behind a healthy sibling ever produces: the
// tick-level escalation requires that nothing reconciled, so it cannot see
// this class at all.
const stuck = transient && classStreak >= MAX_CONSECUTIVE_CONTENDED_TICKS;
log[transient && !stuck ? 'warn' : 'error'](
  { err, classId: cls.id, transient, classStreak, branch: window ?? 'unknown' },
  // ... the two messages from Task 4 ...
);
return { kind: 'failed', transient };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit-sweeps src/services/waitlist-reconciliation.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Prove the guard bites**

Hold the level at `warn` for a transient failure (drop the `stuck` term). Re-run; record the failure. Restore. Then separately delete the `failures.next.set(...)` line and confirm `drops a class from the streak map…` and the escalation test both fail — a streak that never records is a counter that cannot climb.

- [ ] **Step 6: Commit**

```bash
git add src/services/waitlist-reconciliation.ts src/services/waitlist-reconciliation.test.ts
git commit -m "feat(waitlist): surface a class contended behind a healthy sibling"
```

---

### Task 7: The claim sweep

Correct every claim this branch falsified, in every artifact — not only the file in front of you.

**Files:**
- Modify: `DEPLOYMENT.md` (§7 Monitoring)
- Modify: `src/services/waitlist-retention.ts` (one docblock cross-reference)
- Verify: every row of the spec's §6 table

- [ ] **Step 1: State the operator contract**

In `DEPLOYMENT.md` §7, after the `/api/health` bullet, add:

```markdown
- `waitlist-reconciliation` is deliberately slower to flip than the other
  jobs. It runs every minute and repairs waitlists whose live spot-freed hook
  was dropped, so a single lost row-lock race is routine and self-healing. It
  reports the job unhealthy when a failure will not clear by retrying, or when
  five consecutive ticks lost **every** class to contention
  (`MAX_CONSECUTIVE_CONTENDED_TICKS` in
  `src/services/waitlist-reconciliation.ts`) — roughly five minutes of an
  unbroken hold. A single class stuck while others succeed does **not** flip
  the flag; it logs at `error` with a `classStreak` field naming the class.
```

That is where the number `5` lives. Do not restate it in a docblock.

- [ ] **Step 2: Correct the sibling's cross-reference**

`waitlist-retention.ts`'s `RetentionFailedError` docblock says it "Mirrors `ReconciliationFailedError` … and exists for the same reason". They diverge now: retention still throws on any all-failed run regardless of transience, deliberately — a daily cadence over batches of terminal classes nothing contends for makes an all-failed run a signal rather than a false alarm. Replace the claim with what is true, including the divergence and its reason.

While in that docblock, fix a stale path found in passing (spec §10): the same
file cites `docs/DEPLOYMENT.md` in one place and `DEPLOYMENT.md` in another.
The file is at the repository root, so the `docs/`-prefixed one is wrong.

```bash
grep -rn "docs/DEPLOYMENT.md" --include="*.ts" src
```

Every hit is the same error. One word each, and this branch is already editing
the file.

- [ ] **Step 3: Sweep the spec's §6 table**

Open the spec's *Claims this branch falsifies* table and give **every row a verdict**, naming the file and what now stands there. Tasks 2–6 should already have handled most; the ones easily missed are `scheduler.ts`'s job-table comment, `scheduler.test.ts`'s `makeTick` docblock, and the module header's "this module detects" framing.

Then derive a second sweep from the branch's own diff rather than from a keyword:

```bash
git diff main... --stat
grep -rn "every one failed\|foldOutcomes\|cannot see that\|which branch" --include="*.ts" --include="*.md" src DEPLOYMENT.md
```

List what changed, list what was supposed to change, reconcile the two. Expect legitimate survivors and give each one a verdict.

- [ ] **Step 4: Full verification**

```bash
npm run verify
```

Expected: green — typecheck, lint, and every vitest project. If anything earlier is red, run `npx vitest run --project unit-sweeps` and `--project integration` directly: `npm test` chains two invocations with `&&`, so one red unit test means the second never runs and `integration` reports *nothing*, not zero failures.

- [ ] **Step 5: Commit**

```bash
git add DEPLOYMENT.md src/services/waitlist-retention.ts
git commit -m "docs: state the reconciliation job's health contract for operators"
```

---

## After the tasks

Seven tasks, so the whole-branch review applies: one review on the most capable model, one fix wave, one scoped re-review. Its purpose is cross-task blindness — each task's reviewer saw only its own diff, and the failure modes here are exactly that shape:

- A tick-level rule (Task 5) and a per-class rule (Task 6) that each read correctly alone but disagree about what the shared threshold means.
- `MAX_CAUSE_DEPTH` (Task 1) certifying a chain depth that `SpotFreedError` (Task 2) never produces — a pin connected to nothing.
- The loss-phrase roster (Task 2) consumed at four sites across Tasks 3, 4 and 6, where a fifth could be added without it.
- Comment corrections landing in one artifact while their twin stands.
