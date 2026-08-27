# Stage C1: `archiveOrUnarchive` over `ScheduleRule` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the two template families' `archiveOrUnarchive` into one implementation over `ScheduleRule`, and fix the studio `pauseOrResume` CAS-miss residual that answers 500 where the class family answers 503.

**Architecture:** A new `src/services/rule-lifecycle.ts` owns `TemplateFamily<TChild>` (a descriptor record — delegate reads, raw table name, predicate, log noun, and one optional-but-required-null withdraw hook) and `archiveOrUnarchiveRule`. The two existing services keep their exported wrappers and their own result unions, now aliases of a generic. No runtime family test exists anywhere in the shared module.

**Tech Stack:** TypeScript strict, Next.js 14 App Router, Prisma 6.19.3, PostgreSQL 16.12, vitest.

**Spec:** `docs/superpowers/specs/2026-08-27-rule-lifecycle-archive-merge-design.md`

## Global Constraints

- **TypeScript strict, no `any`.** Non-negotiable (CLAUDE.md).
- **Never start or restart the dev server on :3000.** The user runs it; integration tests need it live.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Quote paths containing parentheses** when staging.
- **Test-first.** Write the failing test, see it fail, implement, see it pass.
- **`@/lib/log` is pino and server-only.** `rule-lifecycle.ts` is a service, so it may import it. Do not let any `'use client'` component reach it.
- **Comment discipline (CLAUDE.md).** A comment annotates the code it sits on. No prose counts or rosters. Correct a claim by *replacing* it, never by annotating it — no "this previously read X".
- **Never write `[close-keyword] #N`** in a commit message or PR body — GitHub's parser ignores the negation in front. Write "**#N is unaffected**". When explaining the trap, break the token.
- **`npm run verify` before pushing.** Needs :3000 live.

---

## Measured baseline (2026-08-27, `main` at `ca8325a3`, exit 0)

| project | files | tests |
|---|---:|---:|
| unit | 67 | 1014 |
| components | 46 | 302 |
| unit-sweeps | 10 | 123 |
| integration | 33 | 527 |
| **total** | **156** | **1966** |

`67 + 46 = 113` / `1014 + 302 = 1316` (invocation 1); `10 + 33 = 43` / `123 + 527 = 650` (invocation 2).

**Predicted after: 156 files / 1970 tests** (+4: two residual tests in Task 1, two descriptor tests in Task 3). **Measure it anyway** — #212's handover predicted 1294 and the real figure was 1296, because that branch's own review added tests the prediction could not have known about.

---

## Verify-don't-assume block

Run this first. Every line number below is load-bearing. **If one has drifted, fix the plan and report it** — do not work around it.

```sh
# 1. The four functions. Expect 1451 / 1922 / 1042 / 1429.
grep -nE '^export (async )?function (pauseOrResume|archiveOrUnarchive)' src/services/*class-template-lifecycle.ts

# 2. The studio residual throw. Expect 1209.
grep -n 'matched neither the CAS' src/services/studio-class-template-lifecycle.ts

# 3. The class residual return, the model for the fix. Expect 1659.
grep -n "return { outcome: 'busy' as const };" src/services/class-template-lifecycle.ts

# 4. The studio post-transaction switch. Expect 1372/1374/1376/1378/1387.
grep -n "case 'not_found':\|case 'archived':\|case 'unchanged':\|case 'active':\|case 'paused':" src/services/studio-class-template-lifecycle.ts | head -5

# 5. The interposing lever this branch reuses. Expect 908 and 986.
grep -n 'const interposing = prisma.\$extends' src/services/class-template-lifecycle.test.ts

# 6. The enum the tether keys on. Expect 471.
grep -n '^enum ClassFamily' prisma/schema.prisma

# 7. DB container up.
docker ps --format '{{.Names}}' | grep fairyoga-db-1

# 8. App on :3000 (integration needs it). Expect a status, not a refusal.
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

**Already-verified facts — do not re-derive:**

- The two Archive result unions have **identical** arm sets. The two Pause unions differ by **exactly one** arm, `room_archived` (class only).
- `ArchiveTemplateResult` and `ArchiveStudioTemplateResult` are used **only** as their own functions' return annotations. Nothing imports them.
- The four production call sites are one per function, two per route file, in `src/app/api/class-templates/[id]/route.ts` and `src/app/api/studio-class-templates/[id]/route.ts`.
- `TransactionClientOnly = Prisma.TransactionClient & { $transaction?: never }` (`src/lib/db-locks.ts:67`).
- `lockClassRowsOrdered(tx, { join?, where, entries? }): Promise<string[]>` (`src/lib/db-locks.ts:360`).
- The tether's variance question **is settled** — see Task 3 Step 4. Do not re-derive; do not substitute `TemplateFamily<never>`, which does not compile.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/services/rule-lifecycle.ts` | **Create.** `WithSlot<T>`, `TemplateFamily<TChild>`, `WithdrawHook`, `ArchiveRuleResult<TChild>`, `archiveOrUnarchiveRule`. Imported *by* the two services; imports neither. |
| `src/services/class-template-lifecycle.ts` | **Modify.** `CLASS_FAMILY` descriptor; `archiveOrUnarchiveTemplate` becomes a wrapper; `ArchiveTemplateResult` becomes an alias. `pauseOrResumeTemplate` unchanged except Task 1's test. |
| `src/services/studio-class-template-lifecycle.ts` | **Modify.** Task 1: residual → `busy`. Task 3: `STUDIO_FAMILY` descriptor; wrapper; alias. |
| `src/services/rule-lifecycle.test.ts` | **Create.** The `FAMILY_BY_KIND` tether — this is where it lives, because it may import both services while `rule-lifecycle.ts` may not. |
| `src/services/class-template-lifecycle.test.ts` | **Modify.** Task 1's class residual test. |
| `src/services/studio-class-template-lifecycle.test.ts` | **Modify.** Task 1's studio residual test. |
| `docs/lock-order.md` | **Modify.** Task 4's verdicts. |

**The import direction is a hard constraint.** `rule-lifecycle.ts` must not import either service. Doing so would drag class-only waitlist and notification code into the shared module and create a cycle. `FAMILY_BY_KIND` needs both descriptors, so it lives in `rule-lifecycle.test.ts` — it is a compile-time tether, not a runtime registry, and nothing dispatches by kind at run time.

---

## Task order is load-bearing

1. **Task 1 first** because it is a user-facing defect fix that is independent of the merge, and landing it first keeps the merge's diff free of behaviour change.
2. **Task 2 (class) before Task 3 (studio)** because the class body is the **superset**. Writing the shared function against the class family means the withdraw hook exists from the first commit and Task 3 only supplies `withdraw: null`. Reversed, the shared function would be written without a hook and Task 3 would restructure it — churn a reviewer reads as two competing designs.

---

## Task 1: The studio residual answers `busy`, not a 500

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` — `ResumeTransactionOutcome` (~981), the residual (~1204-1211), the post-transaction switch (~1372)
- Test: `src/services/studio-class-template-lifecycle.test.ts`, `src/services/class-template-lifecycle.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on. Fully independent.

### Why this is a defect

Both `pauseOrResume` functions run the CAS `where: { isArchived: false, isActive: !desiredActive }` and, on a miss, re-read and check two classifications. A row that changed back between the two statements' READ COMMITTED snapshots matches neither. The class family answers `busy` (503); the studio family throws (500, logged at `error` — the paging level). `aed305f8` fixed the class side for issue 116; the port never happened. **Neither branch has a test.**

- [ ] **Step 1: Write the failing studio test**

Add inside `describe('pauseOrResumeStudioTemplate (DB)', …)` in `src/services/studio-class-template-lifecycle.test.ts`.

The interleaving is driven entirely by `$extends` query hooks at known statement boundaries. **No `setTimeout`, no second connection.**

```ts
  /**
   * The CAS's `where` is `isArchived: false AND isActive: !desiredActive`. A
   * miss means one of those held when the CAS ran, and the branch checks both
   * against a SECOND, later read — so a row that changes back in between
   * matches neither classification and falls through to the residual.
   *
   * Driven by two `$extends` hooks rather than by sleeps: each fires at a
   * known statement boundary, so the interleaving is deterministic.
   */
  it('the residual CAS miss answers busy rather than throwing', async () => {
    const t = await makeTemplate('Residual Miss');
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    // Guards: each hook must fire ONCE. The miss branch re-reads through the
    // same `findUnique` the first hook is attached to, so an unguarded hook
    // would fire again there and undo the setup this test depends on.
    let armedRead = true;
    let armedCas = true;

    const interposing = prisma.$extends({
      query: {
        studioClassTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (armedRead) {
              armedRead = false;
              // Commits AFTER the service's pre-transaction read, so the row
              // it holds says `isActive: false` while the database says true —
              // which is what makes the CAS's `isActive: false` predicate miss.
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isActive: true },
              });
            }
            return row;
          },
        },
        scheduleRule: {
          async updateMany({ args, query }) {
            const res = await query(args);
            if (armedCas) {
              armedCas = false;
              // Commits AFTER the CAS has missed, putting the row back so the
              // re-read below sees neither already-desired nor archived.
              // Targets `ScheduleRule` while the transaction holds `FOR UPDATE`
              // on `StudioClassTemplate` — a different table, so no wait.
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isActive: false },
              });
            }
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeStudioTemplate(interposing, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'busy' });
  });
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```sh
npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts -t 'residual CAS miss'
```

Expected: FAIL with the thrown `pauseOrResumeStudioTemplate: template … matched neither the CAS nor any of its disambiguated misses`.

**If it fails any other way the interleaving is not landing** — most likely a hook fired twice. Check the `armed` guards before changing the assertion. Per the spec's §4.5, the fallback is the held-lock barrier at `studio-class-template-lifecycle.test.ts:1140` or `template-lock-order.test.ts`'s two-connection harness — **never** a unit test of the outcome mapping, which would assert that a switch has an arm rather than that the residual is reached.

- [ ] **Step 3: Add the `busy` arm to the internal union**

In `src/services/studio-class-template-lifecycle.ts`, `ResumeTransactionOutcome` (~981):

```ts
type ResumeTransactionOutcome =
  | { outcome: 'not_found' }
  | { outcome: 'archived' }
  | { outcome: 'busy' }
  | { outcome: 'unchanged'; template: StudioClassTemplateWithSlot }
  | { outcome: 'paused'; template: StudioClassTemplateWithSlot }
```

Also update that type's docblock: it currently enumerates how each arm avoids the stale snapshot and does not mention `busy`. Add `busy` to that enumeration — it carries no template at all, so the question does not arise for it. **Replace the sentence, do not append a correction to it.**

- [ ] **Step 4: Replace the throw with the class family's answer**

Replace the `throw new Error(...)` at ~1204-1211 with this. The comment states what is true now — it does not narrate that a throw used to stand here; that belongs in the PR body.

```ts
          // Residual, and REACHABLE — measured, not conceded. The CAS's
          // `where` is `isArchived: false AND isActive: !desiredActive`; a miss
          // means one of those held *when the CAS ran*, and both are checked
          // above against a second, later read. Under READ COMMITTED each
          // statement takes its own snapshot, so a row that changed back in
          // between reaches here.
          //
          // `busy`, not a throw, and the distinction is the point: the CAS
          // matched ZERO rows, so this transaction has written nothing and
          // rolls back clean. That is a lost race a retry wins, which is what
          // `busy` means everywhere else in this file — the route renders it
          // 503 "Nothing was changed. Wait a moment, then try again." A throw
          // surfaces the same state as a 500 logged at `error`, the paging
          // level, for a condition `classifyApiError`'s transient branch exists
          // to demote. `pauseOrResumeTemplate` reaches the analogous state and
          // answers `busy`; the two families agreeing matters more than a
          // distinction only this branch would draw.
          //
          // Logged rather than silent, because `busy` covers two causes worth
          // telling apart in production: a lock wait that timed out (the
          // `catch` below, which carries `err`) and this one, which carries the
          // observed row instead.
          log.warn(
            {
              templateId,
              teacherId,
              target,
              observed: {
                isActive: current.scheduleRule.isActive,
                isArchived: current.scheduleRule.isArchived,
              },
              desiredActive,
            },
            'studio class pause/resume CAS missed and the re-read matched no classification',
          );
          return { outcome: 'busy' };
```

- [ ] **Step 5: Add the switch arm**

In the post-transaction `switch` (~1372), after `case 'archived':`:

```ts
    case 'busy':
      return { ok: false, reason: 'busy' };
```

`PauseStudioTemplateResult` already carries a `busy` arm and the route already answers it 503 `STUDIO_TEMPLATE_BUSY`. **No wire change, no copy change, no public type change.**

- [ ] **Step 6: Run the studio test — it passes**

```sh
npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts -t 'residual CAS miss'
```

Expected: PASS.

- [ ] **Step 7: Write the class family's test**

The class family's fix has stood since `aed305f8` **with no test**. This test is written green, which is exactly why Step 9 mutates it.

Add inside `describe('pauseOrResumeTemplate (DB)', …)` in `src/services/class-template-lifecycle.test.ts`. Same shape, with `classTemplate` as the hooked delegate. **The class family's `makeTemplate` must produce a template on a non-archived room** — the room guard sits between the fast paths and the transaction and would return `room_archived` before the CAS ever runs. Use the block's existing helper unchanged; it already does.

```ts
  it('the residual CAS miss answers busy rather than throwing', async () => {
    const t = await makeTemplate('Residual Miss');
    await prisma.scheduleRule.update({
      where: { id: t.scheduleRuleId },
      data: { isActive: false },
    });

    let armedRead = true;
    let armedCas = true;

    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (armedRead) {
              armedRead = false;
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isActive: true },
              });
            }
            return row;
          },
        },
        scheduleRule: {
          async updateMany({ args, query }) {
            const res = await query(args);
            if (armedCas) {
              armedCas = false;
              await prisma.scheduleRule.update({
                where: { id: t.scheduleRuleId },
                data: { isActive: false },
              });
            }
            return res;
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'busy' });
  });
```

- [ ] **Step 8: Run it — it passes immediately**

```sh
npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t 'residual CAS miss'
```

Expected: PASS, first run. That is the problem Step 9 solves.

- [ ] **Step 9: Score all three mutations**

Apply each, run, record the exact error text, restore, re-verify. **Row 2 is the one that matters** — a test written green needs its own mutation more than one written red does.

| # | Mutation | Expect |
|---|---|---|
| 1 | Studio: restore the `throw` in place of `return { outcome: 'busy' }` | studio test RED |
| 2 | **Class (`class-template-lifecycle.ts:1659`): replace `return { outcome: 'busy' as const };` with a `throw new Error('mutation')`** | **class test RED** |
| 3 | Studio: delete `case 'busy':` from the post-transaction switch | **compile error** from the `never` default — not a test failure |

Mutation 3 is scored by `npm run typecheck`, not by vitest. Record its exact `TS2322` text.

Write the three verdicts and their error text into the task's report. A mutation that does not go RED is a finding, not a formality — report it rather than adjusting the mutation until it passes.

- [ ] **Step 10: Full unit project, then commit**

```sh
npx vitest run --project unit
```

Expected: green, 1016 tests (1014 + 2).

```sh
git add src/services/studio-class-template-lifecycle.ts \
        src/services/studio-class-template-lifecycle.test.ts \
        src/services/class-template-lifecycle.test.ts
git commit -m "fix: the studio pause/resume residual answers busy, not a 500 (issue 332)"
```

---

## Task 2: `rule-lifecycle.ts`, and the class family moves onto it

**Files:**
- Create: `src/services/rule-lifecycle.ts`
- Modify: `src/services/class-template-lifecycle.ts` — `ArchiveTemplateResult` (~1290), `archiveOrUnarchiveTemplate` (~1922-2555)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces, for Task 3:
  - `WithSlot<T>` — `T & { teacherId: string; classType: string; dayOfWeek: number; startTime: string; durationMinutes: number; isActive: boolean; isArchived: boolean; archivedAt: Date | null; withdrawnCount: number | null }`
  - `ChildWithRule<TChild>` — `TChild & { scheduleRuleId: string; scheduleRule: ScheduleRule & { teacher: { defaultTimezone: string } } }`
  - `TemplateFamily<TChild>` — the eight required fields below
  - `WithdrawHook<TState>` — `{ deleteFilter: Prisma.ClassWhereInput; before(tx, ctx): Promise<TState>; after(tx, ctx, state): Promise<void> }`
  - `ArchiveRuleResult<TChild>` — the seven arms below
  - `archiveOrUnarchiveRule<TChild>(db: PrismaClient, family: TemplateFamily<TChild>, templateId: string, teacherId: string, target: 'archived' | 'unarchived'): Promise<ArchiveRuleResult<TChild>>`

- [ ] **Step 1: Create `rule-lifecycle.ts` with the types**

```ts
import { Prisma } from '@prisma/client';
import type { PrismaClient, ScheduleRule, ClassFamily } from '@prisma/client';
import type { TransactionClientOnly } from '@/lib/db-locks';
import { setLockTimeout } from '@/lib/db-locks';
import { startOfLocalDay } from '@/lib/timezone';
import { timeToHHmm } from '@/lib/time-of-day';
import { isExclusionConflictOn } from '@/lib/exclusion-conflict';
import { ruleSlotHolder, minutesSinceMidnight, type RuleSlotHolder } from '@/lib/rule-slot-holder';
import { isTransientDbError } from '@/lib/api-errors';
import { log } from '@/lib/log';

/**
 * A child template with the calendar identity its rule holds, plus the one
 * `Teacher` column the archive's date boundary needs.
 */
export type ChildWithRule<TChild> = TChild & {
  scheduleRuleId: string;
  scheduleRule: ScheduleRule & { teacher: { defaultTimezone: string } };
};

/**
 * A child template with its rule's columns flattened onto it, `startTime`
 * converted to the wire's `"HH:MM"`. Structurally what both families'
 * `ClassTemplateWithSlot` / `StudioClassTemplateWithSlot` already are.
 */
export type WithSlot<T> = T & {
  teacherId: string;
  classType: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  isActive: boolean;
  isArchived: boolean;
  archivedAt: Date | null;
  withdrawnCount: number | null;
};

/** What the withdraw hook is handed. */
export type WithdrawContext = { scheduleRuleId: string; today: Date };

/**
 * The family-specific work that brackets the archive's shared delete.
 *
 * One hook rather than two independent ones because the halves share state:
 * the class family reads its about-to-be-withdrawn waitlist entries BEFORE the
 * delete and diffs them against the survivors AFTER it. `TState` is whatever
 * the first half needs to hand the second.
 *
 * Every member of this hook does work INSIDE the transaction and returns
 * nothing to the caller. That is the property that makes it expressible at
 * all: no family-specific refusal reaches `ArchiveRuleResult`. A hook that
 * needed to widen the result union would be a different and much larger
 * claim — see the spec's §6.3.
 */
export type WithdrawHook<TState> = {
  /**
   * Extra `Class`-side conjunct for the delete's predicate. The class family
   * spares classes carrying a charged registration; the studio family has no
   * registrations and supplies no hook at all.
   */
  deleteFilter: Prisma.ClassWhereInput;
  before: (tx: TransactionClientOnly, ctx: WithdrawContext) => Promise<TState>;
  after: (tx: TransactionClientOnly, ctx: WithdrawContext, state: TState) => Promise<void>;
};

/**
 * Everything `archiveOrUnarchiveRule` needs in order to run over one family.
 *
 * A dispatch table, not a runtime discriminator: each family's entry is
 * complete on its own, and nothing in this module ever asks which family it is
 * holding. An `if (family.kind === 'regular')` anywhere below is the stop
 * condition issue 332 names, not an implementation detail.
 *
 * NO FIELD IS OPTIONAL, deliberately. `withdraw` is `WithdrawHook | null` —
 * required and explicitly null for the family without one — because an
 * optional field is exactly the hole where a third family is half-defined and
 * nothing complains. `rule-lifecycle.test.ts` holds the tether that closes the
 * other half.
 */
export type TemplateFamily<TChild, TState = unknown> = {
  kind: ClassFamily;
  /** Raw SQL identifier for the child's row lock. Never interpolated from input. */
  childTable: string;
  /** The noun this family's log lines use: "recurring class" / "studio class". */
  logNoun: string;
  readChild: (
    client: PrismaClient | TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild> | null>;
  readChildOrThrow: (
    client: TransactionClientOnly,
    templateId: string,
  ) => Promise<ChildWithRule<TChild>>;
  scheduledWhere: (
    scheduleRuleId: string,
    date: { gt: Date } | { gte: Date },
    alsoOnClass?: Prisma.ClassWhereInput,
  ) => Prisma.CalendarEntryWhereInput;
  withSlot: (child: TChild, rule: ScheduleRule) => WithSlot<TChild>;
  withdraw: WithdrawHook<TState> | null;
};

/**
 * Archiving and un-archiving are different operations and report different
 * things; `unchanged` is a third, and reports nothing at all. `deleted`/
 * `remaining` exist only on the archiving arm — un-archiving removes nothing,
 * and a no-op removes nothing twice.
 *
 * Generic in the child rather than one type per family: the two families'
 * archive unions were measured arm-for-arm identical. They stay
 * non-interchangeable anyway, because `ArchiveRuleResult<ClassTemplate>` and
 * `ArchiveRuleResult<StudioClassTemplate>` differ in `template` — the same job
 * `templateKind` does for the wire types in `template-action-messages.ts`.
 */
export type ArchiveRuleResult<TChild> =
  | { ok: true; action: 'archived'; template: WithSlot<TChild>; deleted: number; remaining: number }
  | { ok: true; action: 'unarchived'; template: WithSlot<TChild> }
  | { ok: true; action: 'unchanged'; template: WithSlot<TChild> }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'slot_conflict'; heldBy: RuleSlotHolder }
  | { ok: false; reason: 'busy' };
```

- [ ] **Step 2: Run typecheck on the types alone**

```sh
npm run typecheck
```

Expected: PASS. The module exports types and imports only; nothing consumes it yet.

- [ ] **Step 3: Write `archiveOrUnarchiveRule`**

Move the body from `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts:1922-2555`), substituting the descriptor at the five measured difference sites.

**Move the existing comments with their code.** This plan deliberately does not reproduce them: a copy here would be a fifth copy of prose whose whole problem is that it exists four times. Open the source, cut, paste, and then do Task 4's sweep over what the move invalidated.

```ts
export async function archiveOrUnarchiveRule<TChild, TState>(
  db: PrismaClient,
  family: TemplateFamily<TChild, TState>,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveRuleResult<TChild>> {
  const template = await family.readChild(db, templateId);
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.scheduleRule.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = target === 'archived';

  if (template.scheduleRule.isArchived === archiving) {
    const { scheduleRule, ...bare } = template;
    return {
      ok: true,
      action: 'unchanged',
      template: family.withSlot(bare as unknown as TChild, scheduleRule),
    };
  }

  const timeZone = template.scheduleRule.teacher.defaultTimezone;

  try {
    return await db.$transaction(
      async (tx): Promise<ArchiveRuleResult<TChild>> => {
        await setLockTimeout(tx);

        // `Prisma.raw` on `family.childTable`, and safe for exactly one
        // reason: every value it can hold is a hard-coded literal in a
        // descriptor in this repo, never input. `$queryRaw`'s template
        // placeholders cannot carry an identifier, only a value.
        const childLock = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM ${Prisma.raw(`"${family.childTable}"`)} WHERE "id" = ${templateId} FOR UPDATE`;
        if (childLock.length === 0) return { ok: false, reason: 'not_found' };

        const swapped = await tx.scheduleRule.updateMany({
          where: { id: template.scheduleRuleId, isArchived: !archiving },
          data: {
            isArchived: archiving,
            isActive: false,
            ...(archiving ? {} : { archivedAt: null, withdrawnCount: null }),
          },
        });

        if (swapped.count === 0) {
          const current = await family.readChild(tx, templateId);
          if (!current) return { ok: false, reason: 'not_found' };
          const { scheduleRule, ...bare } = current;
          return {
            ok: true,
            action: 'unchanged',
            template: family.withSlot(bare as unknown as TChild, scheduleRule),
          };
        }

        if (!archiving) {
          const cleared = await family.readChildOrThrow(tx, templateId);
          const { scheduleRule, ...bare } = cleared;
          return {
            ok: true,
            action: 'unarchived',
            template: family.withSlot(bare as unknown as TChild, scheduleRule),
          };
        }

        const now = new Date();
        const today = startOfLocalDay(now, timeZone);
        const ctx: WithdrawContext = { scheduleRuleId: template.scheduleRuleId, today };

        const state = family.withdraw ? await family.withdraw.before(tx, ctx) : null;

        const { count: deleted } = await tx.calendarEntry.deleteMany({
          where: family.scheduledWhere(
            template.scheduleRuleId,
            { gt: today },
            family.withdraw?.deleteFilter,
          ),
        });

        if (family.withdraw) {
          await family.withdraw.after(tx, ctx, state as TState);
        }

        const remaining = await tx.calendarEntry.count({
          where: family.scheduledWhere(template.scheduleRuleId, { gte: today }),
        });

        const recordedRule = await tx.scheduleRule.update({
          where: { id: template.scheduleRuleId },
          data: { archivedAt: now, withdrawnCount: deleted },
        });

        const { scheduleRule: _sr, ...bareTemplate } = template;
        void _sr;
        return {
          ok: true,
          action: 'archived',
          template: family.withSlot(bareTemplate as unknown as TChild, recordedRule),
          deleted,
          remaining,
        };
      },
      { timeout: 10_000 },
    );
  } catch (err) {
    if (isTransientDbError(err)) {
      log.warn(
        { err, templateId, teacherId, target },
        `${family.logNoun} archive lost the template lock race`,
      );
      return { ok: false, reason: 'busy' };
    }
    if (isExclusionConflictOn(err, 'ScheduleRule_teacher_slot_excl')) {
      const heldBy = await ruleSlotHolder(db, {
        teacherId,
        dayOfWeek: template.scheduleRule.dayOfWeek,
        startMinutes: minutesSinceMidnight(template.scheduleRule.startTime),
        durationMinutes: template.scheduleRule.durationMinutes,
        excludeRuleId: template.scheduleRuleId,
      });
      log.warn(
        { err, templateId, teacherId, heldBy },
        `${family.logNoun} un-archive refused: that slot is taken`,
      );
      return { ok: false, reason: 'slot_conflict', heldBy };
    }
    throw err;
  }
}
```

**Two things to check rather than assume as you write this:**

1. **The `as unknown as TChild` casts.** `ChildWithRule<TChild>` is `TChild & {…}`, so destructuring `scheduleRule` off it leaves a type TypeScript cannot prove is `TChild`. If a cleaner formulation compiles — a `bareChild` field on the descriptor, or `Omit<>` gymnastics — prefer it and report the change. **Do not reach for `any`.** If the casts stay, each needs a one-line comment saying what it is asserting.
2. **`Prisma.raw` on the table name.** This is string-built SQL. It is defensible only because every value is a hard-coded literal in this repo, which is the same precondition `SCHEDULED_STATUSES_SQL` (`class-template-lifecycle.ts:1373`) documents for itself. Follow that docblock's shape.

- [ ] **Step 4: Build `CLASS_FAMILY` and rewire the class service**

In `src/services/class-template-lifecycle.ts`:

```ts
const CLASS_FAMILY: TemplateFamily<ClassTemplate, WaitlistCandidate[]> = {
  kind: 'regular',
  childTable: 'ClassTemplate',
  logNoun: 'recurring class',
  readChild: (client, templateId) =>
    client.classTemplate.findUnique({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    }),
  readChildOrThrow: (client, templateId) =>
    client.classTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    }),
  scheduledWhere,
  withSlot,
  withdraw: {
    deleteFilter: { registrations: { none: { status: { in: [...CHARGED_STATUSES] } } } },
    before: async (tx, { scheduleRuleId, today }) => {
      await lockClassRowsOrdered(tx, {
        join: Prisma.sql`JOIN "CalendarEntry" e ON e.id = c."calendarEntryId"`,
        where: Prisma.sql`e."scheduleRuleId" = ${scheduleRuleId}
          AND e."cancelledAt" IS NULL
          AND e.date > ${today}
          AND c.status IN (${SCHEDULED_STATUSES_SQL})`,
        entries: true,
      });
      return tx.waitlistEntry.findMany({
        where: {
          status: 'waiting',
          class: { calendarEntry: scheduledWhere(scheduleRuleId, { gt: today }) },
        },
        select: {
          studentId: true,
          classId: true,
          class: {
            select: {
              calendarEntry: { select: { classType: true, date: true, startTime: true } },
            },
          },
        },
      });
    },
    after: async (tx, _ctx, candidates) => {
      if (candidates.length === 0) return;
      const survivors = await tx.class.findMany({
        where: { id: { in: [...new Set(candidates.map((c) => c.classId))] } },
        select: { id: true },
      });
      const survived = new Set(survivors.map((s) => s.id));
      const withdrawn = candidates.filter((c) => !survived.has(c.classId));
      if (withdrawn.length === 0) return;
      const notifications: CreateNotificationInput[] = withdrawn.map((c) => ({
        recipientType: 'student' as const,
        recipientId: c.studentId,
        type: 'class_cancelled' as const,
        title: 'Class cancelled',
        body: `The ${c.class.calendarEntry.classType} class on ${formatDayHeader(c.class.calendarEntry.date)} at ${timeToHHmm(c.class.calendarEntry.startTime)} has been withdrawn by your teacher. You were on its waiting list.`,
      }));
      await createBulkNotifications(tx, notifications);
    },
  },
};
```

`WaitlistCandidate` is the element type of that `findMany`'s result. Derive it rather than hand-writing it:

```ts
type WaitlistCandidate = Awaited<
  ReturnType<NonNullable<TemplateFamily<ClassTemplate, never>['withdraw']>['before']>
>;
```

If that self-reference does not resolve, declare the shape explicitly and pin it against the query with `satisfies` — **do not** widen it to `any` or drop the type parameter.

Then replace the function body:

```ts
export type ArchiveTemplateResult = ArchiveRuleResult<ClassTemplate>;

export function archiveOrUnarchiveTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveTemplateResult> {
  return archiveOrUnarchiveRule(db, CLASS_FAMILY, templateId, teacherId, target);
}
```

**Keep `ArchiveTemplateResult`'s existing docblocks** — the `slot_conflict` and `busy` paragraphs are the originals that `studio-class-template-lifecycle.ts` cites by name. Moving them to `ArchiveRuleResult` in `rule-lifecycle.ts` is correct (they now annotate the one declaration), and Task 4 fixes the citations.

- [ ] **Step 5: Run the class family's whole test file**

```sh
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
```

Expected: green, unchanged count. **Not one assertion in that file should need editing.** If one does, the merge changed behaviour — stop and report it rather than adjusting the test.

- [ ] **Step 6: Run the two other suites that exercise this function**

```sh
npx vitest run --project unit src/services/class-generator.test.ts src/services/template-lock-order.test.ts
```

Expected: green. `template-lock-order.test.ts` is the one that proves the ordered pre-lock still runs where it did — the hook's `before` must fire before the delete, and this file is what catches it if it does not.

- [ ] **Step 7: Commit**

```sh
git add src/services/rule-lifecycle.ts src/services/class-template-lifecycle.ts
git commit -m "refactor: the class family's archive runs on rule-lifecycle (issue 332)"
```

---

## Task 3: The studio family moves onto it, and the tether lands

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` — `ArchiveStudioTemplateResult` (~889), `archiveOrUnarchiveStudioTemplate` (~1429-1734)
- Create: `src/services/rule-lifecycle.test.ts`

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: `STUDIO_FAMILY`, exported so `rule-lifecycle.test.ts` can tether it. `CLASS_FAMILY` must be exported from the class service for the same reason — **add that export in this task**, not Task 2, so its only consumer lands with it.

- [ ] **Step 1: Build `STUDIO_FAMILY` and rewire**

```ts
export const STUDIO_FAMILY: TemplateFamily<StudioClassTemplate, never> = {
  kind: 'studio',
  childTable: 'StudioClassTemplate',
  logNoun: 'studio class',
  readChild: (client, templateId) =>
    client.studioClassTemplate.findUnique({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    }),
  readChildOrThrow: (client, templateId) =>
    client.studioClassTemplate.findUniqueOrThrow({
      where: { id: templateId },
      include: { scheduleRule: { include: { teacher: { select: { defaultTimezone: true } } } } },
    }),
  scheduledWhere,
  withSlot,
  // Required and explicitly null, not omitted. `StudioClass` has no
  // registrations and no waitlist, so there is nothing to withdraw beyond the
  // entries the shared delete already removes.
  withdraw: null,
};

export type ArchiveStudioTemplateResult = ArchiveRuleResult<StudioClassTemplate>;

export function archiveOrUnarchiveStudioTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveStudioTemplateResult> {
  return archiveOrUnarchiveRule(db, STUDIO_FAMILY, templateId, teacherId, target);
}
```

**The studio `scheduledWhere` takes two parameters and the descriptor's field takes three.** A two-parameter function is assignable to a three-parameter type in TypeScript, so this compiles — and it is correct, because `family.withdraw?.deleteFilter` is `undefined` for this family and the argument is discarded. **Add a comment at the descriptor saying so**, because a reader who notices the arity gap will otherwise assume a bug. Its `kind: 'studio'` conjunct is what keeps the delete scoped, exactly as its existing docblock says.

- [ ] **Step 2: Export `CLASS_FAMILY`**

Change `const CLASS_FAMILY` to `export const CLASS_FAMILY` in `class-template-lifecycle.ts`.

- [ ] **Step 3: Run the studio family's suites**

```sh
npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts
npx vitest run --project unit-sweeps src/services/studio-class-generator.test.ts
```

Expected: green, unchanged counts, **no assertion edited**. `studio-class-generator.test.ts` is in the `unit-sweeps` project, not `unit` — running it under `--project unit` selects nothing and reports success, which reads exactly like a pass.

- [ ] **Step 4: Write the tether**

Create `src/services/rule-lifecycle.test.ts`. **This is the settled form** — `TemplateFamily<never>` does NOT compile (`TChild` appears in return position, so `TemplateFamily<ClassTemplate>` is not assignable to it), and `Record<ClassFamily, unknown>` is blind to a half-defined family. Both measured.

```ts
import { describe, it, expect } from 'vitest';
import type { ClassFamily, ClassTemplate, StudioClassTemplate } from '@prisma/client';
import type { TemplateFamily } from './rule-lifecycle';
import { CLASS_FAMILY } from './class-template-lifecycle';
import { STUDIO_FAMILY } from './studio-class-template-lifecycle';

/**
 * Every family this repo has, as a union.
 *
 * Named rather than written as `TemplateFamily<never>`: `TChild` appears in
 * `withSlot`'s return position, so `TemplateFamily<ClassTemplate>` is not
 * assignable to `TemplateFamily<never>` and that spelling does not compile.
 * Measured, not reasoned.
 */
type AnyTemplateFamily =
  | TemplateFamily<ClassTemplate, never>
  | TemplateFamily<StudioClassTemplate, never>;

/**
 * A third `ClassFamily` variant becomes a compile error HERE rather than a
 * silent gap — the tether `COUNT_KEYS` (`template-action-messages.ts`) and
 * `ROOM_SEARCH_SELECT` (`api/rooms/route.ts`) use, applied to families.
 *
 * The value type is `AnyTemplateFamily`, not `unknown`, and the difference is
 * measured rather than stylistic: with `unknown` this object accepts
 * `{ regular: CLASS_FAMILY, studio: 42 }` without complaint. Both spellings
 * catch a MISSING key; only this one catches a half-defined family, which is
 * the failure the tether exists for.
 *
 * `prisma/schema.prisma`'s own `ClassFamily` docblock anticipates a third
 * variant, which is why this is worth having rather than hypothetical.
 */
const FAMILY_BY_KIND = {
  regular: CLASS_FAMILY,
  studio: STUDIO_FAMILY,
} satisfies Record<ClassFamily, AnyTemplateFamily>;

describe('rule-lifecycle family descriptors', () => {
  it('each descriptor declares the kind it is filed under', () => {
    for (const [kind, family] of Object.entries(FAMILY_BY_KIND)) {
      expect(family.kind).toBe(kind);
    }
  });

  it('the family without a withdraw hook says so explicitly rather than omitting it', () => {
    // `null`, not `undefined`. `TemplateFamily.withdraw` is required, so an
    // omission is a compile error — this asserts the runtime half: that the
    // studio descriptor has actually made the choice rather than inherited it.
    expect(STUDIO_FAMILY.withdraw).toBeNull();
    expect(CLASS_FAMILY.withdraw).not.toBeNull();
  });
});
```

The runtime tests matter beyond the compile tether: `kind` is the one descriptor field nothing else reads, so without the first test a copy-paste error (`studio: { ...STUDIO_FAMILY, kind: 'regular' }`) would compile and sit undetected.

- [ ] **Step 5: Score the tether's mutations**

| # | Mutation | Expect |
|---|---|---|
| 1 | Delete `studio: STUDIO_FAMILY` from `FAMILY_BY_KIND` | `npm run typecheck` fails — missing key |
| 2 | Replace `studio: STUDIO_FAMILY` with `studio: 42` | `npm run typecheck` fails — not a family |
| 3 | Change `STUDIO_FAMILY.withdraw` from `null` to omitted | `npm run typecheck` fails — required field |
| 4 | Set `STUDIO_FAMILY.kind` to `'regular'` | the first runtime test goes RED |

Record each one's exact error text. Mutation 2 is the one that distinguishes this tether from the loose version — if it does **not** fail, `AnyTemplateFamily` has been widened by accident and the tether is back to being blind.

- [ ] **Step 6: Full verify**

```sh
npm run verify
```

Expected: green. Record the after-figure per project. **Measure, do not copy the prediction.**

- [ ] **Step 7: Commit**

```sh
git add src/services/studio-class-template-lifecycle.ts \
        src/services/class-template-lifecycle.ts \
        src/services/rule-lifecycle.test.ts
git commit -m "refactor: the studio family's archive runs on rule-lifecycle, and the families are tethered (issue 332)"
```

---

## Task 4: The prose sweep

**Files:**
- Modify: `docs/lock-order.md`, `src/services/rule-lifecycle.ts`, both services, `src/lib/db-locks.ts:323`

**Interfaces:** Consumes Tasks 2 and 3. Produces nothing.

This is the larger half of the change: 534 lines of code carried 1322 lines of comment, and the merge orphans every cross-reference that named the other copy.

- [ ] **Step 1: Derive the sweep from what was REMOVED, not from what changed**

List the objects this branch destroyed, then grep for those names. This is the #315 lesson: every early sweep there was keyed on the code that changed, and every stale claim was about the objects that went.

```sh
# The removed objects:
#   - archiveOrUnarchiveStudioTemplate as a BODY (the name survives as a wrapper)
#   - archiveOrUnarchiveTemplate as a BODY (ditto)
#   - the studio residual throw
#   - the studio ResumeTransactionOutcome's throw-only miss branch
grep -rn 'archiveOrUnarchiveStudioTemplate\|archiveOrUnarchiveTemplate' src docs --include='*.ts' --include='*.md'
grep -rn 'matched neither the CAS' src docs
```

**Expect legitimate survivors.** Both wrapper names still exist and most references are still true. Give every hit a verdict — rewriting a still-true claim is the mirror-image defect and costs more than the staleness did.

- [ ] **Step 2: Read whole docblocks in the touched functions**

A grep finds a stale **name**, never a stale **description**. These sentences name no object and a keyword sweep cannot reach them:

- `studio-class-template-lifecycle.ts` — "see `archiveOrUnarchiveTemplate` for the full reasoning, which holds here unchanged" (its archive docblock). The reasoning now lives in one place; the sentence describes an arrangement that no longer exists.
- Both services' `busy` arms — "See `ArchiveTemplateResult`'s `busy` arm (`class-template-lifecycle.ts`)". That type is now an alias; the paragraph lives on `ArchiveRuleResult`.
- The studio `scheduledWhere` docblock — "The studio analogue of `scheduledWhere` in `class-template-lifecycle.ts`". Both are now descriptor fields.
- `pauseOrResumeStudioTemplate`'s docblock — "mirroring `archiveOrUnarchiveStudioTemplate`, see that function for the fuller account". That function is now a wrapper with no account in it.
- The class family's `ResumeTransactionOutcome` docblock — "Mirrors `ResumeTransactionOutcome` in `studio-class-template-lifecycle.ts`". Still true, and now *more* true after Task 1. **Verdict: keep.**

- [ ] **Step 3: `docs/lock-order.md` — 18 hits, every one verdicted**

```sh
grep -n 'pauseOrResume\|archiveOrUnarchive' docs/lock-order.md
```

18 hits. The four rows of the lock-node table at `:1238`, `:1239`, `:1241`, `:1242` still describe four callable functions taking a single-id `FOR UPDATE` — **still true**, because the wrappers preserve the call sites and the shared body takes the same lock. What needs checking is any hit that describes where the lock is *taken from*, since that moved to `rule-lifecycle.ts`.

Write the verdict count into the task report: *N* hits, *M* rewritten, *18−M* verified still-true.

- [ ] **Step 4: `src/lib/db-locks.ts:323`**

That comment says "…and `archiveOrUnarchiveTemplate`". It is about which callers use the ordered pre-lock. The pre-lock now runs inside `CLASS_FAMILY.withdraw.before`. Decide whether the sentence should name the wrapper or the hook, and rewrite it to whichever a reader chasing the lock would actually find.

- [ ] **Step 5: Update `docs/data-model.md` and `CLAUDE.md` only if a claim there is now false**

```sh
grep -n 'archiveOrUnarchive\|pauseOrResume' CLAUDE.md docs/data-model.md docs/technical-architecture.md
```

If nothing hits, say so in the report. **Do not add a paragraph describing the refactor to CLAUDE.md** — it documents behaviour and constraints, and this task changes neither.

- [ ] **Step 6: Full verify and commit**

```sh
npm run verify
```

```sh
git add docs/lock-order.md src/lib/db-locks.ts src/services/rule-lifecycle.ts \
        src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts
git commit -m "docs: the sweep for what the merge invalidated, verdicted hit by hit (issue 332)"
```

---

## What the PR body must record

- The four line numbers that had drifted (`1449→1451`, `1920→1922`, `1032→1042`, `1419→1429`), and that the issue's re-derivation commands are what caught it.
- **The 534 / 1322 measurement**, with the command. The issue's "identical docblocks" was the claim that did not survive.
- The archive unions' identical arm sets versus the pause unions' one-arm difference — the measurement the scope decision rests on.
- The defect: `aed305f8` fixed one side and the port never happened; both residual branches were untested; **mutation row 2** is why the class test is trustworthy.
- That `TemplateFamily<never>` was tried and does not compile, and `Record<ClassFamily, unknown>` is blind to a half-defined family. Both measured; the tether is the third form.
- **C1b's trigger**, with its `diff` command, and what C1 does *not* settle (§6.3 of the spec).
- Baseline `156 files / 1966 tests` → the **measured** after-figure, with per-project arithmetic that reconciles.
- Which suites ran. A green `npm run verify` **is** the whole integration suite — say so with the arithmetic. While anything earlier is red, `integration` reports nothing at all rather than zero failures, so invoke `npx vitest run --project integration` directly instead of reading a red `verify` as evidence about that tier.
- **#284 is unaffected. #272 is left open.** Never the other phrasing.

---

## Self-review

**Spec coverage.** §2's three in-scope items → Tasks 2+3, Task 1, and the roadmap/PR record. §3.1's five difference sites → Task 2 Step 3 and Step 4. §3.2 → the `ArchiveRuleResult` docblock. §3.3 → Task 2 Step 4's alias, Task 3 Step 1's. §3.4's tether → Task 3 Step 4, with the variance question now **settled by compilation** rather than deferred. §3.5's stop condition → the `TemplateFamily` docblock and the acceptance grep. §4 → Task 1 entire. §5 → Task 4. §6 → the PR body. §7's baseline → the header. **No gap found.**

**Placeholder scan.** No TBDs. Every code step carries real code. Two steps deliberately do *not* paste content: Task 2 Step 3 says to move comments rather than reproducing 500 lines of them in the plan (a fifth copy would be the exact problem this branch exists to fix), and Task 4 works from greps rather than a hand-listed roster — which is the CLAUDE.md rule about prose rosters applied to the plan itself.

**Type consistency.** `TemplateFamily<TChild, TState>` carries both parameters at every use: `TemplateFamily<ClassTemplate, WaitlistCandidate[]>`, `TemplateFamily<StudioClassTemplate, never>`, and `TemplateFamily<ClassTemplate, never>` in the test's union. `WithdrawHook<TState>` matches. `archiveOrUnarchiveRule<TChild, TState>` matches its declared Produces block. `ChildWithRule`, `WithSlot`, `ArchiveRuleResult` are used with the same names in Tasks 2 and 3.

**One thing flagged for the executor rather than resolved here:** the `as unknown as TChild` casts in Task 2 Step 3. They compile but they are the weakest part of the design, and the step says to prefer a cleaner formulation if one exists and to report the change. Deciding that requires the compiler, not the plan.
