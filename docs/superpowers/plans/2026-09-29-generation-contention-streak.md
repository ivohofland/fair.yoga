# Generation contention streak Implementation Plan (#354)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the hourly generation job from reporting success while one template is stuck behind a lock it never gets; keep a single contended skip green (#122).

**Architecture:** A shared, framework-agnostic streak module (`src/services/generation-contention.ts`) counts consecutive contended sweeps per template. Both family sweeps feed it after their loop and throw `GenerationContendedError` at the threshold. The streak is a required option, and the scheduler reaches it through per-family tick wrappers over a module-level tracker. This is the `ReconciliationStreaks` pattern (`waitlist-reconciliation.ts`).

**Tech Stack:** TypeScript strict, Prisma, Vitest (`unit` project runs `src/**/*.test.ts` against the DB; files in `vitest.tiers.ts` `SERIAL_TESTS` run under `unit-sweeps`).

**Spec:** `docs/superpowers/specs/2026-09-29-generation-contention-streak-design.md`

## Global Constraints

- `MAX_CONSECUTIVE_CONTENDED_SWEEPS = 3`.
- The sweeps' `opts` parameter has **no default value and is not optional** (`opts?:`). Either would let a memoryless sweep fit `SchedulerSweeps`' `(db) => Promise<unknown>` slot.
- A genuine error still wins the rethrow over `GenerationContendedError`.
- Skip predicate stays "lock timeout only". `isLockTimeout` becomes `transientDbFailure(error)?.kind === 'lock_timeout'`.
- Comment Discipline (CLAUDE.md): no counts or rosters in comments, no correction history, and no claims about other files beyond a link.
- Commit per step group; stage exact paths; never `git add -A`.

## Review Focus

1. **A template contended, then free, then contended again**: the streak must restart from 1, not resume. Pinned in Task 1 (reset test).
2. **A wedged template alongside a productive sibling**: must still escalate (the issue's own scenario). Pinned in Task 2 stub tests.
3. **The job stays red while the lock stands**: every sweep past the threshold throws again, so `lastError` is never wiped. Pinned in Task 1 (streak `MAX+1` still returns an error).
4. **The manual cron route**: a fresh tracker per call must never escalate. The sweep-level behaviour is pinned in Task 2 ("fresh tracker per call never rejects"). The route's own choice of a fresh tracker is NOT pinned by a test: the route has no test file, and if it used the production tick instead, manual runs would only add ticks to the scheduler's streak. That is judged not worth a route harness, and the PR body states it.
5. **A real `55P03` from Postgres** (not a hand-built error) feeds the streak. Pinned in Task 3.

---

### Task 1: The streak module, and one lock-timeout classifier

**Files:**
- Create: `src/services/generation-contention.ts`
- Create: `src/services/generation-contention.test.ts`
- Modify: `src/lib/api-errors.ts` (`isLockTimeout`, currently ~line 363-376)
- Modify: `src/lib/api-errors.test.ts` (`describe('isLockTimeout'`, ~line 1036)

**Interfaces — Produces:**

```ts
export const MAX_CONSECUTIVE_CONTENDED_SWEEPS = 3;
export interface ContentionStreaks { readonly byTemplate: ReadonlyMap<string, number> }
export interface ContendedTemplate { readonly templateId: string; readonly teacherId: string }
export function createContentionStreaks(): ContentionStreaks;
export class GenerationContendedError extends Error {
  readonly templateIds: readonly string[];
  constructor(logNoun: string, templateIds: readonly string[]);
}
export function recordSweepContention(
  streaks: ContentionStreaks,
  skipped: readonly ContendedTemplate[],
  logNoun: string,
): GenerationContendedError | null;
```

- [ ] **Step 1: Write the failing unit tests** in `src/services/generation-contention.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { log } from '@/lib/log';
import {
  MAX_CONSECUTIVE_CONTENDED_SWEEPS,
  GenerationContendedError,
  createContentionStreaks,
  recordSweepContention,
} from './generation-contention';

const A = { templateId: 'tpl-A', teacherId: 't1' };
const B = { templateId: 'tpl-B', teacherId: 't2' };

function sweeps(streaks: ReturnType<typeof createContentionStreaks>, n: number, skipped = [A]) {
  let last: GenerationContendedError | null = null;
  for (let i = 0; i < n; i += 1) last = recordSweepContention(streaks, skipped, 'recurring class');
  return last;
}

describe('recordSweepContention', () => {
  afterEach(() => vi.restoreAllMocks());

  it('tolerates MAX − 1 consecutive contended sweeps of the same template', () => {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    expect(sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1)).toBeNull();
    expect(streaks.byTemplate.get('tpl-A')).toBe(MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1);
    expect(log.error).not.toHaveBeenCalled();
  });

  it('escalates on the MAX-th consecutive contended sweep, naming only the stuck template', () => {
    const errorSpy = vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1);
    // B joins on the last sweep: contended once, not stuck.
    const err = recordSweepContention(streaks, [A, B], 'recurring class');
    expect(err).toBeInstanceOf(GenerationContendedError);
    expect(err?.templateIds).toEqual(['tpl-A']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.objectContaining({ templateId: 'tpl-A', teacherId: 't1', streak: MAX_CONSECUTIVE_CONTENDED_SWEEPS }),
      expect.stringContaining('recurring class'),
    );
  });

  it('keeps escalating while the template stays stuck, so a later sweep cannot report success', () => {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    expect(sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS + 1)).toBeInstanceOf(GenerationContendedError);
  });

  it('resets a template that was not contended in a sweep', () => {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1);
    expect(recordSweepContention(streaks, [], 'recurring class')).toBeNull();
    expect(streaks.byTemplate.has('tpl-A')).toBe(false);
    // Starting over: MAX − 1 more contended sweeps are tolerated again.
    expect(sweeps(streaks, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1)).toBeNull();
  });

  it('keeps separate trackers independent', () => {
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const one = createContentionStreaks();
    const two = createContentionStreaks();
    sweeps(one, MAX_CONSECUTIVE_CONTENDED_SWEEPS - 1);
    expect(sweeps(two, 1)).toBeNull();
  });
});
```

- [ ] **Step 2: Run, expect FAIL** (module not found):
`pnpm exec vitest run --project unit src/services/generation-contention.test.ts`

- [ ] **Step 3: Implement** `src/services/generation-contention.ts`:

```ts
/**
 * How long a generation sweep may keep skipping one template for lock
 * contention before the job reports itself unhealthy (#354).
 *
 * A skip is routine: a teacher's edit can hold the template row at the moment
 * the sweep claims it (#122). A row that stays locked on every sweep looks
 * identical inside any one sweep, and only repetition tells the two apart, so
 * the memory lives with the caller that persists across sweeps. Same shape
 * as `ReconciliationStreaks` (`waitlist-reconciliation.ts`).
 */

import { log } from '@/lib/log';

/**
 * Consecutive contended sweeps of ONE template before the job reports itself
 * degraded. Means "this has stood for a while"; the job's interval
 * (`scheduler.ts`) is what makes it a duration. `DEPLOYMENT.md` §7 states the
 * operator-facing tolerance.
 */
export const MAX_CONSECUTIVE_CONTENDED_SWEEPS = 3;

/** What one caller remembers between sweeps: consecutive contended sweeps per template id. */
export interface ContentionStreaks {
  readonly byTemplate: ReadonlyMap<string, number>;
}

/** This module's writable view of the tracker; callers hold only the readonly one. */
interface MutableContentionStreaks {
  byTemplate: Map<string, number>;
}

export interface ContendedTemplate {
  readonly templateId: string;
  readonly teacherId: string;
}

export function createContentionStreaks(): ContentionStreaks {
  return { byTemplate: new Map() } satisfies MutableContentionStreaks;
}

/** Thrown by a sweep in which at least one template reached the streak threshold. */
export class GenerationContendedError extends Error {
  constructor(
    logNoun: string,
    public readonly templateIds: readonly string[],
  ) {
    super(
      `${logNoun} generation skipped ${templateIds.length} template(s) for lock contention on ${MAX_CONSECUTIVE_CONTENDED_SWEEPS} or more consecutive sweeps`,
    );
    this.name = 'GenerationContendedError';
  }
}

/**
 * Folds one sweep's contended templates into the tracker and returns the error
 * the sweep should throw, or `null`.
 *
 * The map is REBUILT from this sweep's skips, so a template that was not
 * contended this sweep leaves it (its streak restarts) and the map's size is
 * bounded by the candidate set rather than by uptime. A template at or past
 * the threshold is logged at `error` on every such sweep, so the job stays
 * unhealthy for as long as the row stays locked.
 */
export function recordSweepContention(
  streaks: ContentionStreaks,
  skipped: readonly ContendedTemplate[],
  logNoun: string,
): GenerationContendedError | null {
  // The one place the readonly view is set aside; see `MutableContentionStreaks`.
  const mutable = streaks as MutableContentionStreaks;
  const next = new Map<string, number>();
  const stuck: string[] = [];
  for (const { templateId, teacherId } of skipped) {
    const streak = (mutable.byTemplate.get(templateId) ?? 0) + 1;
    next.set(templateId, streak);
    if (streak >= MAX_CONSECUTIVE_CONTENDED_SWEEPS) {
      log.error(
        { templateId, teacherId, streak },
        `${logNoun} generation has skipped this template for lock contention on consecutive sweeps`,
      );
      stuck.push(templateId);
    }
  }
  mutable.byTemplate = next;
  return stuck.length > 0 ? new GenerationContendedError(logNoun, stuck) : null;
}
```

- [ ] **Step 4: Run, expect PASS** (same command).

- [ ] **Step 5: Prove the guards bite.** Record each mutation's exact failure text in the task report, then restore it:
  - `streak >= MAX_…` → `streak > MAX_…`: the "escalates on the MAX-th" test fails.
  - Replace `mutable.byTemplate = next;` with merging into the old map (`for (const [k, v] of next) mutable.byTemplate.set(k, v);`): the reset test fails.
  After restoring, `git status` must show only this task's intended files as modified.

- [ ] **Step 6: Failing test for the classifier.** Append inside `describe('isLockTimeout'` in `src/lib/api-errors.test.ts`. Reuse the 55P03 `PrismaClientUnknownRequestError` construction from the first test there, but as a `cause`:

```ts
  it('matches a lock timeout carried as the cause of a wrapper error', () => {
    const inner = new Prisma.PrismaClientUnknownRequestError(
      'Error occurred during query execution:\nConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "55P03", message: "canceling statement due to lock timeout", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })',
      { clientVersion: 'test' },
    );
    expect(isLockTimeout(new Error('wrapped', { cause: inner }))).toBe(true);
  });

  it('defers to the Prisma code, as transientDbFailure does, when both are present', () => {
    // A transaction-budget expiry whose message quotes a 55P03 framing: one
    // matcher means one answer, and the code is checked first.
    const budget = new Prisma.PrismaClientKnownRequestError(
      'Transaction already closed: ... PostgresError { code: "55P03" }',
      { code: 'P2028', clientVersion: 'test' },
    );
    expect(transientDbFailure(budget)?.kind).toBe('tx_budget');
    expect(isLockTimeout(budget)).toBe(false);
  });
```

Run `pnpm exec vitest run --project unit src/lib/api-errors.test.ts -t isLockTimeout`. Expect BOTH new tests to FAIL on the old message-only matcher: the first because it does not walk `cause`, the second because it matches the quoted framing regardless of the code.

- [ ] **Step 7: Implement.** Replace the body of `isLockTimeout` with `return transientDbFailure(error)?.kind === 'lock_timeout';` and rewrite its docblock to say what is true now: it is `transientDbFailure`'s `lock_timeout` kind, so it shares that function's framing rules and walks the same `cause` chain. Keep the two-shapes explanation only as a pointer to `transientDbFailure`'s docblock. Run the whole `api-errors.test.ts`; expect PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/services/generation-contention.ts src/services/generation-contention.test.ts src/lib/api-errors.ts src/lib/api-errors.test.ts
git commit -m "feat(generation): per-template contention streak; one lock-timeout matcher (#354)"
```

---

### Task 2: Wire both sweeps, the scheduler, and the cron route

**Files:**
- Modify: `src/services/class-generator.ts` (`generateClassInstances` and its docblock; add `runClassGenerationTick`)
- Modify: `src/services/studio-class-generator.ts` (`generateStudioClassInstances` and its docblock; add `runStudioClassGenerationTick`)
- Modify: `src/lib/scheduler.ts` (`SchedulerSweeps` fields, `startScheduler` imports, `buildJobs`)
- Modify: `src/lib/scheduler.test.ts` (sweep-name list ~line 29-30, expected wiring ~line 157)
- Modify: `src/app/api/cron/generate-classes/route.ts`
- Modify every caller of the two sweeps in tests: `src/services/class-generator.test.ts`, `src/services/studio-class-generator.test.ts`, `src/services/class-generator-lock-order.test.ts`. Find them with `grep -rn "generateClassInstances(\|generateStudioClassInstances(" src tests`; the compiler lists any that are missed.

**Interfaces — Consumes:** Task 1's exports. **Produces:**

```ts
// class-generator.ts
export interface ClassGenerationSweepOptions {
  /** Required, never defaulted — see the sweep's docblock. */
  streaks: ContentionStreaks;
  from?: Date;
  teacherId?: string;
}
export async function generateClassInstances(db: PrismaClient, opts: ClassGenerationSweepOptions): Promise<number>;
export function runClassGenerationTick(db: PrismaClient): Promise<number>;

// studio-class-generator.ts
export interface StudioGenerationSweepOptions { streaks: ContentionStreaks; from?: Date }
export async function generateStudioClassInstances(db: PrismaClient, opts: StudioGenerationSweepOptions): Promise<number>;
export function runStudioClassGenerationTick(db: PrismaClient): Promise<number>;
```

- [ ] **Step 1: Failing tests, class family.** In `src/services/class-generator.test.ts`, inside `describe('generateClassInstances (per-template isolation)'`, extract the existing lock-timeout test's stub into a local factory, `contendedStub(contended: ReadonlySet<string>, failing: ReadonlySet<string> = new Set())`, returning `{ stub, created }` so the existing test keeps its `created` assertions. It builds the same object as that test: templates `A` and `B`, with `createManyAndReturn` throwing `lockTimeoutError` for `rule-X` when `X ∈ contended` and `new Error('boom-X')` when `X ∈ failing`. Use it in the existing test and add:

```ts
  it('reports a template contended on MAX consecutive sweeps, even while a sibling generates', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => log);
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    const stub = contendedStub(new Set(['A']));
    for (let i = 1; i < MAX_CONSECUTIVE_CONTENDED_SWEEPS; i += 1) {
      await expect(generateClassInstances(stub, { streaks, from })).resolves.toBeGreaterThan(0);
    }
    const last = generateClassInstances(stub, { streaks, from });
    await expect(last).rejects.toBeInstanceOf(GenerationContendedError);
    await expect(last).rejects.toMatchObject({ templateIds: ['A'] });
  });

  it('never escalates with a fresh tracker per call (the manual cron route)', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => log);
    const stub = contendedStub(new Set(['A']));
    for (let i = 0; i < MAX_CONSECUTIVE_CONTENDED_SWEEPS + 1; i += 1) {
      await expect(generateClassInstances(stub, { streaks: createContentionStreaks(), from })).resolves.toBeGreaterThan(0);
    }
  });

  it('rethrows a genuine failure ahead of the contention error in the same sweep', async () => {
    vi.spyOn(log, 'warn').mockImplementation(() => log);
    vi.spyOn(log, 'error').mockImplementation(() => log);
    const streaks = createContentionStreaks();
    const contendedOnly = contendedStub(new Set(['A']));
    for (let i = 1; i < MAX_CONSECUTIVE_CONTENDED_SWEEPS; i += 1) {
      await generateClassInstances(contendedOnly, { streaks, from });
    }
    const both = contendedStub(new Set(['A']), new Set(['B']));
    const rejection = generateClassInstances(both, { streaks, from });
    // The genuine failure, not the contention error: assert the kind, not message text.
    await expect(rejection).rejects.not.toBeInstanceOf(GenerationContendedError);
    await expect(rejection).rejects.toBeInstanceOf(Error);
  });
```

(Adapt the destructuring: `const { stub } = contendedStub(...)`. Where the snippets above write `contendedStub(...)` as the stub, use its `.stub`.)

Use `const from = new Date('2099-01-05T00:00:00Z');` as the neighbouring tests do. Restore the spies in an `afterEach(() => vi.restoreAllMocks())` if the describe block has none. Import `createContentionStreaks`, `GenerationContendedError`, `MAX_CONSECUTIVE_CONTENDED_SWEEPS` from `./generation-contention`.

- [ ] **Step 2: Failing tests, studio family.** Make the same three tests in `src/services/studio-class-generator.test.ts`, inside `describe('generateStudioClassInstances (per-template isolation)'`, with a factory built from that describe's own existing lock-timeout stub (its `tmpl` fixture differs; do not copy the class one). Rewrite them in full; do not refer back to the class tests.

- [ ] **Step 3: Failing wiring test.** In `src/lib/scheduler.test.ts`, rename the two sweep names in the name list and the `'class-generation'` expectation to `['runClassGenerationTick', 'runStudioClassGenerationTick']`.

- [ ] **Step 4: Run, expect FAIL** (type errors and assertion failures):
`pnpm run typecheck` and `pnpm exec vitest run --project unit src/services/class-generator.test.ts src/lib/scheduler.test.ts` and `pnpm exec vitest run --project unit-sweeps src/services/studio-class-generator.test.ts`.

- [ ] **Step 5: Implement the class sweep.** In `generateClassInstances`:
  - Change the signature to `(db: PrismaClient, opts: ClassGenerationSweepOptions)`, and derive `startDate = opts.from ?? new Date()` and `teacherId = opts.teacherId`.
  - Declare `const skipped: ContendedTemplate[] = [];`. In the `isLockTimeout` branch, keep the `warn` and add `skipped.push({ templateId: template.id, teacherId: template.scheduleRule.teacherId });`.
  - Replace the tail with:

```ts
  const contended = recordSweepContention(opts.streaks, skipped, CLASS_GENERATOR.logNoun);
  if (errors.length > 0) throw errors[0];
  if (contended) throw contended;
  return totalCreated;
```

  Rewrite the docblock to state what is true now. A single contended skip is a `warn` and does not fail the sweep (#122). A template contended on `MAX_CONSECUTIVE_CONTENDED_SWEEPS` consecutive sweeps of the same tracker fails it with `GenerationContendedError` (#354). A genuine failure is rethrown first. `opts` is required and must never get a default, because that is what keeps a memoryless sweep out of `SchedulerSweeps`' one-parameter slot. Update the in-loop `catch` comment to match. Then add, below the function:

```ts
/**
 * The scheduler's entry point: the one caller that persists across sweeps, so
 * the one whose tracker can see a template stay contended. Module-level
 * because `scheduler.ts` imports services dynamically and has nowhere else to
 * keep it.
 */
const productionStreaks = createContentionStreaks();

export function runClassGenerationTick(db: PrismaClient): Promise<number> {
  return generateClassInstances(db, { streaks: productionStreaks });
}
```

- [ ] **Step 6: Implement the studio sweep** with the identical shape: `STUDIO_GENERATOR.logNoun`, its own module-level tracker, and `runStudioClassGenerationTick`. Update its docblock the same way, including the paragraph about what a throw means to both callers. A throw can now also mean "a template stayed contended".

- [ ] **Step 7: Scheduler.** In `SchedulerSweeps`, rename the two fields to `runClassGenerationTick` / `runStudioClassGenerationTick` (same type). Give them a docblock in the style of `runWaitlistReconciliationTick`'s: the WRAPPER, never the sweep itself, because the sweep's required `opts` makes it unassignable to this slot. Import the tick wrappers in `startScheduler` and pass them. In `buildJobs`, wire `isolatedSweeps('class-generation', [runClassGenerationTick, runStudioClassGenerationTick])`. Give the `class-generation` job entry a short comment in the style of the `waitlist-reconciliation` one: the sweeps skip a contended template, and report the job degraded only when one stays contended across `MAX_CONSECUTIVE_CONTENDED_SWEEPS` consecutive runs. That count is a duration only because of this `intervalMs`.

- [ ] **Step 8: Cron route.** Pass a fresh tracker per call:

```ts
  // A fresh tracker each call: a manual run is a one-off, not a tick in the
  // scheduler's series, so it never escalates contention on its own.
  const [classesCreated, studioClassesCreated] = await Promise.all([
    generateClassInstances(prisma, { streaks: createContentionStreaks() }),
    generateStudioClassInstances(prisma, { streaks: createContentionStreaks() }),
  ]);
```

- [ ] **Step 9: Update every remaining caller** that the compiler flags. `generateClassInstances(prisma, from, teacherId)` becomes `generateClassInstances(prisma, { streaks: createContentionStreaks(), from, teacherId })`, and `generateClassInstances(stub, from)` becomes `generateClassInstances(stub, { streaks: createContentionStreaks(), from })`. Studio callers get the same change. A `.then(...)` chained on a call stays as is.

- [ ] **Step 10: Run, expect PASS:** `pnpm run typecheck`, `pnpm run lint`, and the three test commands from Step 4 plus `pnpm exec vitest run --project unit-sweeps src/services/class-generator-lock-order.test.ts`.

- [ ] **Step 11: Prove the guards bite.** Record the exact failure text for each, then restore:
  - Delete `if (contended) throw contended;` in the class sweep: the class "reports a template contended…" test fails. Do the same in the studio sweep and check that its twin fails.
  - Swap the two throws (contended first) in the class sweep: the "rethrows a genuine failure ahead" test fails.
  - In `startScheduler`, temporarily pass `runClassGenerationTick: generateClassInstances` (the memoryless sweep) to `buildJobs`. `pnpm run typecheck` must refuse it, because a required second parameter is not assignable to `(db) => Promise<unknown>`. Record the compiler message and restore.
  End with a clean `git status` except this task's files.

- [ ] **Step 12: Commit.**

```bash
git add src/services/class-generator.ts src/services/studio-class-generator.ts src/lib/scheduler.ts src/lib/scheduler.test.ts "src/app/api/cron/generate-classes/route.ts" src/services/class-generator.test.ts src/services/studio-class-generator.test.ts src/services/class-generator-lock-order.test.ts
git commit -m "fix(generation): report a template stuck behind a lock across sweeps (#354)"
```

---

### Task 3: A real 55P03 feeds the streak; operator docs

**Files:**
- Modify: `src/services/class-generator-lock-order.test.ts` (new `describe` after the "edit mid-sweep" block)
- Modify: `DEPLOYMENT.md` §7 Monitoring

**Interfaces — Consumes:** `generateClassInstances(db, { streaks, teacherId })`, `createContentionStreaks`, `GenerationContendedError`, `MAX_CONSECUTIVE_CONTENDED_SWEEPS`.

- [ ] **Step 1: Write the test.** Use the file's existing fixture (`teacherId`, `templateId`) and the hold pattern its "edit mid-sweep" test uses: a second `prisma.$transaction` that takes `SELECT "id" FROM "ClassTemplate" WHERE "id" = ${templateId} FOR UPDATE` and awaits a promise released in a `finally`. Do not rely on a sleep for the hold being in place: the holder resolves a `locked` promise right after its `SELECT … FOR UPDATE` returns, and the test awaits `locked` before the first sweep. The holder's `{ timeout }` must be comfortably above `MAX_CONSECUTIVE_CONTENDED_SWEEPS × 2s` plus overhead (use `30_000`). Otherwise the holder's own `P2028` releases the lock mid-test. With one tracker and `teacherId` scoping, run the sweep `MAX − 1` times, expecting each to resolve, then once more, expecting `rejects.toBeInstanceOf(GenerationContendedError)` with `templateIds` equal to `[templateId]`. Spy on `log.warn` and assert that each resolved sweep warned with `templateId`. This shows the skip really came from a real `55P03` claim timeout, not some other path. Clean up any calendar entries created, following the neighbouring `afterEach`. Set the `it` timeout to `30_000`.

- [ ] **Step 2: Run it:** `pnpm exec vitest run --project unit-sweeps src/services/class-generator-lock-order.test.ts -t "<your describe name>"`. Expect PASS, since Task 2's code exists.

- [ ] **Step 3: Prove it bites.** Temporarily set `MAX_CONSECUTIVE_CONTENDED_SWEEPS = 99` in `generation-contention.ts`. The test's final expectation must fail because the last sweep resolved. Record the text and restore. Then check the other direction: temporarily make `isLockTimeout` return `false`. The first sweep must now reject with the raw 55P03 error, not `GenerationContendedError`. Record and restore. `git status` must end clean apart from this task's files.

- [ ] **Step 4: DEPLOYMENT.md.** After the `waitlist-reconciliation` bullet in §7, add a `class-generation` bullet. The hourly job skips a recurring or studio template whose row is locked, since a teacher saving an edit at that moment is routine. It reports the job unhealthy only when the same template has been skipped on `MAX_CONSECUTIVE_CONTENDED_SWEEPS` consecutive runs (`src/services/generation-contention.ts`), roughly two to three hours of an unbroken hold, and stays unhealthy until that row is released. Each such run logs an `error` line naming the `templateId`, `teacherId` and `streak`. The usual cause is an idle-in-transaction session: find it in `pg_stat_activity`. The manual `POST /api/cron/generate-classes` never escalates this on its own. The streak lives in memory, so a process restart resets it to zero.

- [ ] **Step 5: Commit.**

```bash
git add src/services/class-generator-lock-order.test.ts DEPLOYMENT.md
git commit -m "test(generation): a held template row escalates after the streak; document it (#354)"
```
