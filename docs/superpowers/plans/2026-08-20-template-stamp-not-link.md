# A template is a stamp, not a live link — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Editing a class template stops propagating to already-generated classes; generation becomes keyed per week instead of per date, and the edit tells the teacher when the change takes effect.

**Architecture:** Delete `syncTemplateInstances` entirely. Add a week-occupancy check to `generateInstancesForTemplate`, backed by a second `templateId`-keyed read. Extract the decision into a pure `firstFreeWeek` used by both the generator and a read-only probe in the PUT, so the message and the behaviour cannot disagree.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (3 projects: `unit`, `components`, `integration`), Playwright.

**Spec:** `docs/superpowers/specs/2026-08-20-template-stamp-not-link-design.md` — read §1.4, §3.2 and §3.4 before Task 5.

**Branch:** `fix/194-template-stamp-not-link` (already created, spec already committed at `1ca9661`).

---

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. `noUncheckedIndexedAccess` is on — indexing yields `T | undefined`.
- **A `@db.Date` column is a calendar date at UTC midnight. Read it with UTC accessors.** A `new Date()` is an instant. Never pass a `@db.Date` value to `startOfLocalDay`/`startOfLocalWeek`. This is spec §1.4 and it is the defect this branch exists partly to avoid.
- **`@/lib/log` is pino and server-only.** `src/lib/timezone.ts` imports it, so `timezone.ts` is server-only by transitivity. `src/components/settings/template-action-messages.ts` is reached by `template-form.tsx` (`'use client'`) and must NOT gain a value-import of `timezone.ts`. `src/components/schedule/class-list.tsx` is a **server** component, so its import of `timezone.ts` is fine.
- **`src/lib/generation.ts` is import-free on purpose.** Do not add imports to it. `firstFreeWeek` therefore lives in `class-generator.ts`, not there.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `"src/app/(teacher)/..."`.
- **Never start or restart the dev server on :3000.** It is already running and the integration project needs it.
- **Never write `close/closes/fixes/resolves #N` in a commit message or PR body unless you mean it.** To say an issue is untouched, write "**#N is unaffected**".
- **Commit per task.** The PR is rebase-merged; the commit-per-task history is the record.
- **Week arithmetic takes no timezone.** Both operands are calendar dates.

---

## Task order is load-bearing

Task 4 (delete sync) **must** precede Task 5 (week-keying). `syncTemplateInstances` deletes wrong-day instances and then calls `generateInstancesForTemplate` to refill. Landing week-keying while sync still exists makes that refill's behaviour depend on delete-then-refill ordering inside one transaction, and `template-sync.test.ts` asserts exact counts against it. Deleting first removes the interaction rather than reasoning about it.

Tasks 1–3 are independent and can be done in any order among themselves.

---

## File structure

| File | Responsibility after this branch |
|---|---|
| `src/lib/timezone.ts` | gains exported `mondayOf(date)` — calendar-date week bucket, no timezone |
| `src/lib/generation.ts` | gains `already_this_week` as a fifth `SkipReason` and a third `SkipCounts` field. Stays import-free |
| `src/services/class-generator.ts` | gains exported `firstFreeWeek()`; `generateInstancesForTemplate` gains the week read and the week branch |
| `src/services/template-sync.ts` | **deleted** |
| `src/services/class-template-lifecycle.ts` | `updateClassTemplate` loses the sync call, the `sync` result field and `sync_conflict`; gains the read-only probe |
| `src/app/api/class-templates/[id]/route.ts` | loses the `sync` spread and the `TEMPLATE_SYNC_SLOT_CONFLICT` branch; returns the probe's date |
| `src/components/settings/template-action-messages.ts` | gains the edit message. Client-safe: formats via `@/lib/format` only |
| `src/components/settings/template-form.tsx` | renders the new message instead of the sync counters |

---

### Task 1: `mondayOf` moves to `timezone.ts`

Pure relocation plus the tests it never had. No behaviour change.

**Files:**
- Modify: `src/lib/timezone.ts` (add after `startOfLocalWeek`, which ends at :121)
- Modify: `src/components/schedule/class-list.tsx:29-35` (delete the private copy, import instead)
- Test: `src/lib/timezone.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `export function mondayOf(date: Date): number` — returns the epoch-ms of the UTC-midnight Monday of the week containing `date`. Takes a **calendar date**, not an instant. Used by Tasks 3, 5.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/timezone.test.ts`:

```ts
describe('mondayOf', () => {
  const iso = (ms: number) => new Date(ms).toISOString();

  it('returns the Monday of the week containing a midweek date', () => {
    // 2026-09-24 is a Thursday; its Monday is 2026-09-21.
    expect(iso(mondayOf(new Date('2026-09-24T00:00:00.000Z')))).toBe('2026-09-21T00:00:00.000Z');
  });

  it('returns the date itself when it is already a Monday', () => {
    expect(iso(mondayOf(new Date('2026-09-21T00:00:00.000Z')))).toBe('2026-09-21T00:00:00.000Z');
  });

  it('rolls a Sunday BACK six days, not forward one', () => {
    // 2026-09-27 is a Sunday. Monday-first weeks put it at the END of the
    // week beginning 2026-09-21 — not the start of the one beginning
    // 2026-09-28. This is the off-by-one the whole week rule turns on.
    expect(iso(mondayOf(new Date('2026-09-27T00:00:00.000Z')))).toBe('2026-09-21T00:00:00.000Z');
  });

  it('puts a Sunday and the following Monday in DIFFERENT weeks', () => {
    // The consequence of the rule above, stated as the behaviour that matters:
    // a template moved from Sunday to Monday crosses a week boundary.
    const sunday = mondayOf(new Date('2026-09-27T00:00:00.000Z'));
    const monday = mondayOf(new Date('2026-09-28T00:00:00.000Z'));
    expect(sunday).not.toBe(monday);
  });

  it('ignores the host timezone entirely — it takes a calendar date, not an instant', () => {
    // A @db.Date value is midnight UTC. In America/Los_Angeles that instant is
    // the PREVIOUS afternoon, so anything that resolved it through a zone would
    // answer the previous day — and for a Monday, the previous week.
    // `mondayOf` must not do that: same input, same answer, no zone argument.
    const monday = new Date('2026-09-21T00:00:00.000Z');
    expect(iso(mondayOf(monday))).toBe('2026-09-21T00:00:00.000Z');
    // And the Monday of the previous week is genuinely seven days earlier,
    // proving the function is not silently shifting by an offset.
    expect(iso(mondayOf(new Date('2026-09-14T00:00:00.000Z')))).toBe('2026-09-14T00:00:00.000Z');
  });
});
```

Add `mondayOf` to the existing import at the top of the file.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/lib/timezone.test.ts`
Expected: FAIL — `TypeError: mondayOf is not a function`.

**Not** `"mondayOf" is not exported by …` — that is Rollup's message, and Vitest
transforms with esbuild, which leaves the missing named import as an undefined
binding rather than refusing the module. The failure arrives at the call site, at
runtime. Measured in task 1; the same correction applies to the two later
predictions in this plan.

- [ ] **Step 3: Implement in `src/lib/timezone.ts`**

Add immediately after `startOfLocalWeek`:

```ts
/**
 * The UTC-midnight Monday of the week containing `date`, as epoch-ms.
 *
 * Takes a CALENDAR DATE — a `@db.Date` value, or anything built with
 * `Date.UTC` — and takes no timezone, deliberately. Contrast
 * `startOfLocalWeek` directly above, which takes an INSTANT and resolves it
 * through `Intl` first. The two are not interchangeable and confusing them is
 * a live defect, not a style question: feeding a `@db.Date` (midnight UTC) to
 * `startOfLocalWeek` reads that instant in the target zone, and west of UTC
 * that is the previous calendar day — for a Monday class, the previous week.
 * Issue #194's own text told an implementer to do exactly that; see the spec's
 * §1.4.
 *
 * `class-list.tsx` is the worked example of the pair: it calls this on
 * `item.data.date` (a calendar date, no zone) and `startOfLocalWeek` on `now`
 * (an instant, with the teacher's zone), in the same function.
 *
 * Monday-first, matching the `dayOfWeek` schema convention (0 = Monday).
 * `getUTCDay()` is Sunday-first, so Sunday maps back six days rather than
 * forward one — which is what puts a Sunday and the following Monday in
 * different weeks.
 */
export function mondayOf(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + (day === 0 ? -6 : 1 - day));
  return d.getTime();
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit src/lib/timezone.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-point `class-list.tsx`**

Delete the private `mondayOf` at `src/components/schedule/class-list.tsx:29-35` (keep `WEEK_MS` — `weekLabel` still uses it). Add `mondayOf` to the existing `@/lib/timezone` import on line 8.

- [ ] **Step 6: Prove the guard bites — mutation**

In `src/lib/timezone.ts`, change `(day === 0 ? -6 : 1 - day)` to `(1 - day)`. Run the unit project. **Record the exact failure text in the commit message.** Expected: the Sunday tests fail — `mondayOf` returns `2026-09-28`, one week late. Restore, re-run, confirm green.

- [ ] **Step 7: Run the affected projects and commit**

```bash
npx vitest run --project unit --project components
git add src/lib/timezone.ts src/lib/timezone.test.ts src/components/schedule/class-list.tsx
git commit -m "refactor: mondayOf is shared, and its Sunday case is finally pinned (issue 194)"
```

---

### Task 2: `already_this_week` joins `SkipReason` and `SkipCounts`

**Files:**
- Modify: `src/lib/generation.ts`
- Test: `src/lib/generation.test.ts` (**create** — this module has no test file today)

**Interfaces:**
- Consumes: nothing.
- Produces: `'already_this_week'` as a fifth `SkipReason` member; `SkipCounts.alreadyThisWeek: number`; `countSkipReasons` counts it. Used by Tasks 5, 6.

- [ ] **Step 1: Write the failing test**

Create `src/lib/generation.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { countSkipReasons, type SkippedSlot } from './generation';

const at = (iso: string, reason: SkippedSlot['reason']): SkippedSlot => ({
  date: new Date(iso),
  reason,
});

describe('countSkipReasons', () => {
  it('counts the three reasons a teacher is shown, and ignores the two they are not', () => {
    const counts = countSkipReasons([
      at('2026-09-21T00:00:00.000Z', 'blocked_by_cancelled'),
      at('2026-09-28T00:00:00.000Z', 'slot_taken'),
      at('2026-10-05T00:00:00.000Z', 'already_this_week'),
      at('2026-10-12T00:00:00.000Z', 'already_this_week'),
      // Deliberately excluded — see SkipCounts' docblock.
      at('2026-10-19T00:00:00.000Z', 'already_generated'),
      at('2026-10-26T00:00:00.000Z', 'raced'),
    ]);

    expect(counts).toEqual({ blockedByCancelled: 1, slotTaken: 1, alreadyThisWeek: 2 });
  });

  it('returns zeroes for an empty skip list', () => {
    expect(countSkipReasons([])).toEqual({
      blockedByCancelled: 0,
      slotTaken: 0,
      alreadyThisWeek: 0,
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/lib/generation.test.ts`
Expected: FAIL — TypeScript rejects `'already_this_week'` as a `SkipReason`, and `alreadyThisWeek` is not on `SkipCounts`.

- [ ] **Step 3: Implement**

In `src/lib/generation.ts`, add to `SkipReason` after `'slot_taken'`:

```ts
  /**
   * This template already has a class in the WEEK containing that date, on a
   * different date (#194). Distinct from `already_generated`, which is the
   * same template's class on the date ITSELF — and the distinction is the
   * whole diagnostic value: this reason can only arise when the template's
   * `dayOfWeek`/`startTime` moved and the previously generated classes still
   * hold those weeks.
   *
   * Counted with no status filter: a cancelled class holds its week. That is
   * deliberate and is the one place this codebase does NOT read cancelled as
   * free — see the spec's §3.2 for the flip-flop schedule the alternative
   * produces. Do not "fix" it for consistency with `Class_teacher_slot_unique`.
   */
  | 'already_this_week'
```

Add to `SkipCounts`:

```ts
  /** Candidate dates whose week this template already occupies (#194). */
  alreadyThisWeek: number;
```

In `countSkipReasons`, add `let alreadyThisWeek = 0;`, a `case 'already_this_week': alreadyThisWeek += 1; break;`, and include it in the returned object.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit src/lib/generation.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the exhaustiveness guard bites — mutation**

Add a sixth member `| 'invented'` to `SkipReason` **without** adding a `case` for it. Run `npx tsc --noEmit`. **Record the exact error text** — it must name `countSkipReasons`'s `const unhandled: never`. Remove the member, re-run, confirm clean.

- [ ] **Step 6: Commit**

```bash
npx vitest run --project unit
git add src/lib/generation.ts src/lib/generation.test.ts
git commit -m "feat: already_this_week is a skip reason, and generation.ts finally has a test (issue 194)"
```

---

### Task 3: `firstFreeWeek` in `class-generator.ts`

**Files:**
- Modify: `src/services/class-generator.ts` (export beside `getNextOccurrences`)
- Test: `src/services/class-generator.test.ts`

**Placement rationale — do not move this into `generation.ts`.** That module is import-free by policy and `firstFreeWeek` needs `mondayOf`. Both its callers (`class-generator.ts` itself, and `class-template-lifecycle.ts`'s probe in Task 6) already import from this file, and `studio-class-generator.ts` already imports `getNextOccurrences` from here — so #284 gets it for free.

**Interfaces:**
- Consumes: `mondayOf` from Task 1.
- Produces: `export function firstFreeWeek(candidates: readonly Date[], heldWeeks: ReadonlySet<number>): Date | null` — the first candidate whose week is not held, or `null`. Used by Tasks 5, 6.

- [ ] **Step 1: Write the failing test**

Add to `src/services/class-generator.test.ts`:

```ts
describe('firstFreeWeek', () => {
  const d = (iso: string) => new Date(iso);
  // Four consecutive Thursdays.
  const thursdays = [
    d('2026-09-24T00:00:00.000Z'),
    d('2026-10-01T00:00:00.000Z'),
    d('2026-10-08T00:00:00.000Z'),
    d('2026-10-15T00:00:00.000Z'),
  ];

  it('returns the first candidate when nothing is held', () => {
    expect(firstFreeWeek(thursdays, new Set())?.toISOString()).toBe('2026-09-24T00:00:00.000Z');
  });

  it('skips candidates whose week is held and returns the first free one', () => {
    // Hold the weeks of the first two Thursdays, via the MONDAY of each —
    // which is what a Tuesday class from the same template would produce.
    const held = new Set([
      mondayOf(d('2026-09-22T00:00:00.000Z')), // Tue, week of Sep 21
      mondayOf(d('2026-09-29T00:00:00.000Z')), // Tue, week of Sep 28
    ]);
    expect(firstFreeWeek(thursdays, held)?.toISOString()).toBe('2026-10-08T00:00:00.000Z');
  });

  it('returns null when every candidate week is held', () => {
    const held = new Set(thursdays.map((t) => mondayOf(t)));
    expect(firstFreeWeek(thursdays, held)).toBeNull();
  });

  it('returns null for an empty candidate list', () => {
    expect(firstFreeWeek([], new Set())).toBeNull();
  });
});
```

Import `firstFreeWeek` from `./class-generator` and `mondayOf` from `@/lib/timezone`.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t firstFreeWeek`
Expected: FAIL — `TypeError: firstFreeWeek is not a function` (see task 1 step 2 for
why it is not "is not exported").

- [ ] **Step 3: Implement**

```ts
/**
 * The first candidate date whose week no class of this template already holds,
 * or `null` if every candidate's week is taken (#194).
 *
 * Pure. Its caller is the template-edit endpoint's probe — `updateClassTemplate`
 * in `class-template-lifecycle.ts` — deciding what to tell the teacher.
 *
 * `generateInstancesForTemplate` below does NOT call it: the generator has to
 * name a reason for EVERY candidate date, not find the first free one, so a
 * function returning a single date cannot express its answer. What the two
 * share is the definition of "held". The probe passes a LONGER candidate list
 * than the generator's own four-occurrence window, and that is the point
 * rather than an inconsistency: when all four of those weeks are held the
 * honest answer is week five — outside anything the generator can see.
 */
export function firstFreeWeek(
  candidates: readonly Date[],
  heldWeeks: ReadonlySet<number>,
): Date | null {
  for (const date of candidates) {
    if (!heldWeeks.has(mondayOf(date))) return date;
  }
  return null;
}
```

Add `mondayOf` to the existing `@/lib/timezone` import.

**The docblock above is the corrected one.** As this plan was first written it said
`generateInstancesForTemplate` "uses it to decide what to create" and called the
arrangement "one function, two callers" — present tense about a call that never
existed. Task 5 proved it could not: `already_this_week` is a `SkipReason` the
generator must attach to each declined date, and a `Date | null` cannot carry one. The
source docblock was corrected at that point, and this block is corrected to match
rather than left contradicting the file it produced. Task 6 went one step further and
extracted the shared predicate as `isWeekHeld`, which is what the shipped docblock
names; see §4 of the spec, which carries the same correction.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit src/services/class-generator.test.ts -t firstFreeWeek`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/class-generator.ts src/services/class-generator.test.ts
git commit -m "feat: firstFreeWeek, shared by the generator and the probe to come (issue 194)"
```

---

### Task 4: Delete `syncTemplateInstances` — **must precede Task 5**

**Files:**
- Delete: `src/services/template-sync.ts`, `src/services/template-sync.test.ts`
- Modify: `src/services/class-template-lifecycle.ts` (the `sync` call at :477, the `sync` result field at :230, the `sync_conflict` reason, the `{ timeout: 15_000 }` budget and its comment)
- Modify: `src/app/api/class-templates/[id]/route.ts` (the `sync` spread at :69, the `sync_conflict` branch at :111-117, the `busy` comment at :118-125)
- Modify: `src/components/settings/template-form.tsx` (the counter-rendering branch, ~:344-380)
- Modify: `src/services/template-lock-order.test.ts` (delete the one sync test at :285; the two `archiveOrUnarchiveTemplate` tests stay)
- Modify: `src/services/class-template-lifecycle.test.ts`, `tests/integration/class-templates-api.test.ts` (drop assertions on `sync`)

**Interfaces:**
- Consumes: nothing.
- Produces: `UpdateClassTemplateResult`'s success arm becomes `{ ok: true; template: ClassTemplate }`. `sync_conflict` no longer exists. The PUT's success body is the bare template. Task 6 extends both.

- [ ] **Step 1: Delete, and let the compiler enumerate the fallout**

```bash
git rm src/services/template-sync.ts src/services/template-sync.test.ts
npx tsc --noEmit
```

Expected: errors at `class-template-lifecycle.ts` (import, `sync` call, `TemplateSyncResult` in the result type), `route.ts`, and `template-form.tsx`. **Work the compiler's list — do not guess at the call sites.**

- [ ] **Step 2: Rewire `updateClassTemplate`**

Remove the `syncTemplateInstances` import and the `const sync = ...` statement; the transaction body becomes `setLockTimeout(tx)` then the `classTemplate.update`. Return `{ ok: true, template: updated }`. Drop `sync: TemplateSyncResult` from the success arm and the `sync_conflict` failure arm.

Replace the transaction-budget comment, which is now false — it says *"Five statements here can wait on a lock at 2s each"* and there is one:

```ts
      // One statement now, where there were five (#194 deleted the sync).
      // The transaction survives only to scope `SET LOCAL lock_timeout`, which
      // is a no-op outside one (`db-locks.ts`) — remove the transaction and
      // the #100/#209 bound goes with it, silently. That is the whole reason
      // it is still here; it is not vestigial.
      { timeout: 10_000 },
```

- [ ] **Step 3: Rewire the route**

`route.ts:69` becomes `if (result.ok) return respondOk(result.template);`. Delete the `sync_conflict` branch and `TEMPLATE_SYNC_SLOT_CONFLICT` entirely. Rewrite the `busy` comment — the PUT no longer takes `Class` locks:

```ts
  // This transaction lost a contention race (#100/#209) on the `ClassTemplate`
  // row itself — a generation claim, an archive, or a pause/resume holding it.
  // It can no longer be lost on a `Class` row: #194 deleted the sync, so this
  // transaction takes no `Class` locks at all and the edit path has left the
  // deadlock graph. Distinct copy from the PATCH pause/resume branch below
  // ("could not update this recurring class"): this is the edit, that is the
  // toggle.
```

- [ ] **Step 4: Simplify `template-form.tsx` to a bare "Saved."**

Replace the whole `const json: { data?: { sync?: TemplateSyncResult } }` block and its `parts` assembly with `setSuccess('Saved.')`. Remove the `TemplateSyncResult` import. Task 6 replaces this with the real message — keep this step mechanical.

- [ ] **Step 5: Delete the one obsolete lock-order test**

In `src/services/template-lock-order.test.ts`, delete the `it(...)` beginning at :285 (*"does not deadlock: syncTemplateInstances (ordered pre-lock) vs deleteStudentAccount…"*). **Keep** the two `archiveOrUnarchiveTemplate` tests and any shared fixture they use (`makeTemplateWithTwoWaitedInstances`). Update the file's header docblock, which frames the file around sync.

- [ ] **Step 6: Fix the two suites that assert on `sync`**

Run each and work the failures:

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
npx vitest run --project integration tests/integration/class-templates-api.test.ts
```

Tests asserting propagation (a day edit deletes/moves instances) now assert the **opposite**: the instances are untouched. Rewrite them to that, do not delete them — they are the coverage for rule 1.

- [ ] **Step 7: Prove rule 1 — add the test that would have caught propagation**

Add to `tests/integration/class-templates-api.test.ts`: generate a template's window, PUT a change to `startTime` **and** `roomCost`, then assert every generated `Class` row is byte-identical on `startTime`, `roomCost`, `date` and `teacherRoomId`.

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/services/class-template-lifecycle.ts src/services/template-lock-order.test.ts src/services/class-template-lifecycle.test.ts src/components/settings/template-form.tsx tests/integration/class-templates-api.test.ts
git add "src/app/api/class-templates/[id]/route.ts"
git commit -m "feat!: template edits stop propagating — syncTemplateInstances is deleted (issue 194)"
```

---

### Task 5: Week-keyed generation

**Files:**
- Modify: `src/services/class-generator.ts` (`generateInstancesForTemplate`)
- Test: `src/services/class-generator.test.ts`

**Interfaces:**
- Consumes: `mondayOf` (Task 1), `'already_this_week'` (Task 2), `firstFreeWeek` (Task 3).
- Produces: `generateInstancesForTemplate` skips week-held dates. `GenerationResult.skipped` may now carry `already_this_week`.

- [ ] **Step 1: Write the failing tests**

Add to `src/services/class-generator.test.ts`. Fixture: a template on Tuesday with a generated window, then move it to Thursday and re-generate.

```ts
it('does not generate into a week that already holds a class from this template', async () => {
  // Window generated on Tuesday, then the template moves to Thursday.
  // Every candidate Thursday falls in a week a Tuesday class already holds.
  const before = await prisma.class.findMany({ where: { templateId }, select: { date: true } });
  expect(before).toHaveLength(4);

  await prisma.classTemplate.update({ where: { id: templateId }, data: { dayOfWeek: 3 } });
  const result = await generateInstancesForTemplate(prisma, await freshTemplate(templateId));

  expect(result.created).toBe(0);
  expect(result.skipped.map((s) => s.reason)).toEqual([
    'already_this_week', 'already_this_week', 'already_this_week', 'already_this_week',
  ]);

  const after = await prisma.class.findMany({ where: { templateId }, select: { date: true } });
  expect(after).toHaveLength(4);
});

it('a CANCELLED class still holds its week', async () => {
  // Spec §3.2. Cancel one Tuesday, move to Thursday: that week must stay
  // empty rather than flipping to the new day for one week and back.
  await prisma.class.update({ where: { id: secondTuesdayId }, data: { status: 'cancelled' } });
  await prisma.classTemplate.update({ where: { id: templateId }, data: { dayOfWeek: 3 } });

  const result = await generateInstancesForTemplate(prisma, await freshTemplate(templateId));

  expect(result.created).toBe(0);
  expect(result.skipped.every((s) => s.reason === 'already_this_week')).toBe(true);
});

it('still reports already_generated, not already_this_week, on a steady-state re-run', async () => {
  // Evaluation order (spec §3.4): the week set contains the candidate's OWN
  // week, so a week-first check would mask already_generated on every re-run.
  const result = await generateInstancesForTemplate(prisma, await freshTemplate(templateId));

  expect(result.created).toBe(0);
  expect(result.skipped.map((s) => s.reason)).toEqual([
    'already_generated', 'already_generated', 'already_generated', 'already_generated',
  ]);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: the first two FAIL — 4 classes created on the new day (the "8 classes" bug). The third PASSES already; it is the regression guard for Step 3's ordering.

- [ ] **Step 3: Implement**

In `generateInstancesForTemplate`, after the existing `occupants` read, add the week read:

```ts
  // Week occupancy for the whole window (#194). A SECOND read rather than a
  // widening of `occupants` above, and keyed on `templateId` rather than
  // `teacherId`, for two reasons. The read above is scoped to the candidate
  // dates and structurally cannot see the class that blocks a week from a
  // DIFFERENT date — which is the entire case this exists for. And keying on
  // `templateId` rides `@@unique([templateId, date])`, which both `Class` and
  // `StudioClass` already carry, so this does not widen an unindexed scan
  // (see the spec's §5; it corrects a claim on #284 that said otherwise).
  //
  // No `status` filter, deliberately: a cancelled class holds its week. Spec
  // §3.2 has the flip-flop schedule the alternative produces. Do not add one
  // for consistency with `Class_teacher_slot_unique`.
  //
  // Bounds derived from `dates` itself, not computed independently — the read
  // and the loop below must not be able to disagree about which weeks are in
  // play.
  const weekStart = new Date(mondayOf(dates[0]!));
  const weekEnd = new Date(mondayOf(dates[dates.length - 1]!) + 7 * 24 * 60 * 60 * 1000);
  const heldWeeks = new Set(
    (
      await db.class.findMany({
        where: { templateId: template.id, date: { gte: weekStart, lt: weekEnd } },
        select: { date: true },
      })
    ).map((c) => mondayOf(c.date)),
  );
```

Guard the whole block with `dates.length === 0` returning early, since `dates[0]!` is otherwise unsound under `noUncheckedIndexedAccess`.

Then inside the per-date loop, **between** the `own` branch and the `slot_taken` branch:

```ts
    // AFTER the own-date branch above, deliberately: `heldWeeks` contains this
    // candidate's own week too, so checking week-first would mask
    // `already_generated` on every steady-state re-run. BEFORE `slot_taken`
    // below, because when a day edit and an unrelated class both block a date,
    // the systematic cause is the one worth reporting.
    if (heldWeeks.has(mondayOf(date))) {
      skipped.push({ date, reason: 'already_this_week' });
      continue;
    }
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --project unit src/services/class-generator.test.ts`
Expected: PASS, all three.

- [ ] **Step 5: Prove all three guards bite — mutations**

Run each, **record the exact failure text**, restore, re-verify:

1. Delete the `heldWeeks.has(...)` branch → test 1 fails with `created: 4`, and 8 classes stand.
2. Add `status: { not: 'cancelled' }` to the week read → test 2 fails; the cancelled week flips to the new day.
3. Move the week branch above the `own` branch → test 3 fails with `already_this_week` where `already_generated` is expected.

- [ ] **Step 6: Verify and commit**

```bash
npm run verify
git add src/services/class-generator.ts src/services/class-generator.test.ts
git commit -m "feat: generation is keyed per week, and a cancelled class holds its own (issue 194)"
```

---

### Task 6: The probe and the message

**Files:**
- Modify: `src/services/class-template-lifecycle.ts` (probe after the transaction)
- Modify: `src/app/api/class-templates/[id]/route.ts`
- Modify: `src/components/settings/template-action-messages.ts`, `src/components/settings/template-form.tsx`
- Test: `src/components/settings/template-action-messages.test.ts`, `tests/integration/class-templates-api.test.ts`

**Client-bundle constraint:** `template-action-messages.ts` is reached by `template-form.tsx` (`'use client'`). It must format the date with `formatDayHeader` from `@/lib/format` (already imported there, client-safe) and must **not** gain an import of `@/lib/timezone` or `class-generator.ts`.

**Interfaces:**
- Consumes: `firstFreeWeek` (Task 3), `getNextOccurrences`, `mondayOf`.
- Produces: `UpdateClassTemplateResult`'s success arm gains `firstEffective: Date | null`. The PUT body gains `firstEffective` as an ISO string. `templateUpdatedMessage(firstEffective: Date | null): string`.

- [ ] **Step 1: Write the failing copy tests**

Add to `src/components/settings/template-action-messages.test.ts`:

```ts
describe('templateUpdatedMessage', () => {
  it('names the week the change first takes effect', () => {
    // The argument is always a MONDAY (the probe converts before returning),
    // so `formatDayHeader` renders "Monday, 21 Sep" and the sentence reads
    // "the week starting Monday, 21 Sep".
    expect(templateUpdatedMessage(new Date('2026-09-21T00:00:00.000Z'))).toBe(
      'Template updated. It takes effect for newly generated classes — your first class on the new schedule is the week starting Monday, 21 Sep. Change existing classes individually if needed.',
    );
  });

  it('drops the middle clause when no free week is in view', () => {
    expect(templateUpdatedMessage(null)).toBe(
      'Template updated. It takes effect for newly generated classes. Change existing classes individually if needed.',
    );
  });
});
```

`formatDayHeader` is `${weekday}, ${d} ${Mon}` on UTC accessors (`src/lib/format.ts:96-100`) — verified, not assumed. It is reused rather than a new day-and-month formatter being added, and the sentence says "week **starting** Monday" so the weekday it emits reads as intentional rather than redundant.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project components src/components/settings/template-action-messages.test.ts`
Expected: FAIL — `TypeError: templateUpdatedMessage is not a function` (see task 1
step 2 for why it is not "is not exported").

- [ ] **Step 3: Implement the copy**

```ts
/**
 * Shown after a template edit (#194). The edit changes nothing that already
 * exists, so this sentence carries the whole of what happened.
 *
 * `firstEffective` is the Monday of the first week the new schedule reaches —
 * computed by `updateClassTemplate`'s probe from the same `firstFreeWeek` the
 * generator uses, so the sentence cannot claim a week the sweep will not fill.
 * `null` when no free week is in the probe's horizon: the clause is dropped
 * rather than a date invented, matching this file's rule that saying nothing
 * beats saying something unfounded.
 *
 * The closing clause is deliberately conditional in tone ("if needed") rather
 * than a promise. `settingsLocked` refuses economic edits on a booked class,
 * so "change existing classes individually" is not universally available —
 * true before #194 too, since the deleted sync skipped those same instances,
 * but this sentence is new and must not over-promise.
 */
export function templateUpdatedMessage(firstEffective: Date | null): string {
  const head = 'Template updated. It takes effect for newly generated classes';
  const tail = 'Change existing classes individually if needed.';
  if (!firstEffective) return `${head}. ${tail}`;
  return `${head} — your first class on the new schedule is the week of ${formatDayHeader(firstEffective)}. ${tail}`;
}
```

- [ ] **Step 4: Add the probe**

In `class-template-lifecycle.ts`, **after** the transaction commits, using the updated template:

```ts
    // Read-only. This PUT creates nothing — generation still happens only on
    // the cron sweep, on create and on resume — so the message has to PREDICT
    // where the new schedule first lands rather than report it.
    //
    // A longer horizon than the generator's own window, and that asymmetry is
    // the point: when all four of the generator's weeks are held by the
    // superseded schedule, the honest answer is week five, which the generator
    // cannot see. `firstFreeWeek` is shared so the prediction and the
    // behaviour cannot disagree about anything else.
    //
    // A stale answer is possible if the sweep runs between this read and the
    // teacher reading the sentence. It can only land EARLIER than predicted,
    // never later, so the failure mode is a pleasant surprise.
    const horizon = getNextOccurrences(updated.dayOfWeek, new Date(), DEFAULT_WEEKS * 2);
    const held = new Set(
      (
        await db.class.findMany({
          where: {
            templateId,
            date: { gte: new Date(mondayOf(horizon[0]!)) },
          },
          select: { date: true },
        })
      ).map((c) => mondayOf(c.date)),
    );
    // Converted to the WEEK's Monday before leaving this function, not left as
    // the candidate date. `firstFreeWeek` returns the occurrence itself (a
    // Thursday, say) and the sentence speaks about weeks — and the conversion
    // has to happen here rather than in the copy layer, because `mondayOf`
    // lives in `@/lib/timezone`, which imports pino and cannot be reached from
    // `template-action-messages.ts` (a `'use client'` file value-imports it).
    const free = firstFreeWeek(horizon, held);
    const firstEffective = free ? new Date(mondayOf(free)) : null;

    return { ok: true, template: updated, firstEffective };
```

`DEFAULT_WEEKS` must be exported from `class-generator.ts` for this. Add `firstEffective: Date | null` to the success arm, documented as **"the Monday of the first week the new schedule reaches"** — a bare `Date` field invites the candidate-date reading this step just corrected.

- [ ] **Step 5: Wire the route and the form**

Route: `return respondOk({ ...result.template, firstEffective: result.firstEffective });`

`template-form.tsx`: read `firstEffective` from the response, `setSuccess(templateUpdatedMessage(firstEffective ? new Date(firstEffective) : null))`.

- [ ] **Step 6: Prove the probe agrees with the generator — integration test**

Add to `tests/integration/class-templates-api.test.ts`: generate a Tuesday window, PUT `dayOfWeek` to Thursday, capture `firstEffective`, then run `generateInstancesForTemplate` and assert the **first class it creates falls in the same week** the message named.

- [ ] **Step 7: Prove the shared function is load-bearing — mutation**

Give the probe its own inline loop instead of `firstFreeWeek` and change its horizon to `DEFAULT_WEEKS`. **Record the exact failure text** from Step 6's test — the probe returns `null` while the generator creates in week 5. Restore, re-verify.

- [ ] **Step 8: Verify and commit**

```bash
npm run verify
git add src/services/class-template-lifecycle.ts src/services/class-generator.ts src/components/settings/template-action-messages.ts src/components/settings/template-action-messages.test.ts src/components/settings/template-form.tsx tests/integration/class-templates-api.test.ts
git add "src/app/api/class-templates/[id]/route.ts"
git commit -m "feat: the edit says when it takes effect, from the generator's own function (issue 194)"
```

---

### Task 7: The documentation sweep — eight artifacts, eight verdicts

**Per the solve-issue skill's §4: a finding that names N locations gets N verdicts, not one.** Work the table; tick each row separately.

**Files:** `CLAUDE.md`, `docs/plan-template-sync-and-student-updates.md`, `docs/lock-order.md`, `docs/technical-architecture.md`, `src/lib/generation.ts`, `src/app/api/class-templates/[id]/route.ts`, `src/services/class-template-lifecycle.ts`

- [ ] **1. `CLAUDE.md:51`** — *"Recurring classes: template generates instances on rolling 4-week basis, runs indefinitely"* → add that generation is week-keyed and that a template edit never touches already-generated classes. This line is loaded into every session; it is the highest-leverage sentence in the repo on this topic.

- [ ] **2. `docs/plan-template-sync-and-student-updates.md`** — Part 1's *"Decision: sync safe instances, say so for the rest"* marked **superseded by #194**, dated 2026-08-20, with the reason. Change `Status: implemented` so it cannot be read as live. **Do not delete the section** — it is the record of why sync existed.

- [ ] **3. `docs/lock-order.md`** — 11 references. The edit path leaves the lock graph entirely (it takes no `Class` locks now). Published probe results for `syncTemplateInstances` vs `updateClass` must be marked as measuring a function that no longer exists, not silently deleted — they are evidence about a real past state.

- [ ] **4. `docs/technical-architecture.md:269`** — remove sync from `generateInstancesForTemplate`'s call-site list; the count changes.

- [ ] **5. `src/lib/generation.ts` docblock** — drops `template-sync.ts` from the value-importer list. Re-derive the list rather than editing one name out; its own text says the "only importers" claim should be re-checked before being trusted.

- [ ] **6. `route.ts` `busy` comment** — done in Task 4 Step 3. **Verify it landed**, do not assume.

- [ ] **7. `UpdateClassTemplateResult.room_archived` docblock** — door 5 stands (you would still generate into an archived room) but its stated reason cited sync relocating instances. Rewrite the reason; keep the door.

- [ ] **8. GitHub #284's comment** — the claim that week-keying makes #205 worse is wrong; the week read is `templateId`-keyed and rides an index `StudioClass` already has. Post a correction **from a `--body-file`**, never `--body "…"` (backticks in a double-quoted shell string are silently eaten).

- [ ] **Reconcile against the diff, not against a keyword.** Run `git diff --name-only main...HEAD`, list the files this task was supposed to touch, and compare the two lists. A keyword sweep scoped to one artifact cannot see another's twin — that is exactly how #41 shipped a half-fixed finding through two gates.

- [ ] **Commit the docs on their own**

```bash
git add CLAUDE.md docs/plan-template-sync-and-student-updates.md docs/lock-order.md docs/technical-architecture.md
git commit -m "docs: eight claims about a function this branch deleted (issue 194)"
```

---

## Definition of done

- [ ] `npm run verify` green, with per-project arithmetic recorded for the PR body (files and tests per project, totals reconciling).
- [ ] Every mutation in Tasks 1, 2, 5, 6 run, its **exact** error text recorded, and restored.
- [ ] All eight artifacts in Task 7 individually verdicted.
- [ ] `syncTemplateInstances` returns nothing from `grep -rn "syncTemplateInstances" src/ docs/ CLAUDE.md` except deliberate historical references in `lock-order.md` and the superseded plan doc.
- [ ] PR body names the touched `tests/integration/` files by path, states which inherited claims were checked, and says **"#284, #276, #205 are unaffected"** — never the auto-close phrasing.
- [ ] #257 and #233 get comments saying they are moot once this merges. **Neither is closed by this PR.**
