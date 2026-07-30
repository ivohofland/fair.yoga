# Template Service Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the two real P2025 windows in the template services, align the four result types' failure halves to one member per reason, and name the `LastScheduledClass` shape once (#100).

**Architecture:** Three independent changes to the same two service files and their two routes. Task 1 is behaviour (two `catch` blocks plus comments recording why three sibling functions need none). Task 2 is type-level only — splitting union-typed `reason` fields into separate members and re-pointing four `never` guards. Task 3 extracts one shared type. Nothing changes at runtime except the two new catches.

**Tech Stack:** TypeScript strict, Prisma 6 + PostgreSQL, Vitest (`unit` and `integration` projects), Next.js App Router.

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence a type error, no eslint suppressions. The one accepted exception is a **test double** for a Prisma client, and only following the precedent already in `src/services/studio-class-generator.test.ts` — do not invent a new casting pattern.
- **Services stay framework-agnostic** — no HTTP or framework imports in `src/services/`.
- **Do not modify `prisma/schema.prisma` and do not add a migration.** This change is code only.
- **No runtime behaviour changes except the two new P2025 catches.** Every reason keeps its existing status code and message.
- **Do not touch `ResumeTransactionOutcome`** (`studio-class-template-lifecycle.ts`). Module-private, discriminates on `outcome` not `reason`, already `switch`-guarded by #118. Aligning it would undo a fix.
- **Do not fold in #116 or #117.** Both live in `class-template-lifecycle.ts` and will be tempting while editing it. Separate defects, separate analysis.
- **Never restart the dev server on `:3000`** — it is managed manually by the repo owner.
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.
- **Mutation-verify** where the plan says so, and per the #66 lesson confirm each mutation actually landed in the code under test before trusting its result. Apply one at a time and confirm `git diff` is empty before the next.

---

## File Structure

| File | Change |
|---|---|
| `src/services/class-template-lifecycle.ts` | Two P2025 catches; comment on the archive fn; split two failure halves; declare + export `LastScheduledClass` |
| `src/services/studio-class-template-lifecycle.ts` | Comments on both fns; split two failure halves; import `LastScheduledClass` |
| `src/app/api/class-templates/[id]/route.ts` | Two `never` guards re-pointed, two comments deleted |
| `src/app/api/studio-class-templates/[id]/route.ts` | Same, two sites |
| `src/components/settings/template-action-messages.ts` | Import `LastScheduledClass` for `pauseMessage`'s parameter |
| `src/services/class-template-lifecycle.test.ts` | Two P2025 tests |

**Three tasks.** Task 1 is behaviour and is the only one that can break at runtime. Task 2 is a compiler-verified type change across four types and four call sites. Task 3 is a small extraction. A reviewer could reasonably approve any one and reject another.

---

### Task 1: Close the two P2025 windows, and record why three siblings need nothing

**Files:**
- Modify: `src/services/class-template-lifecycle.ts`, `src/services/studio-class-template-lifecycle.ts`
- Test: `src/services/class-template-lifecycle.test.ts`

**Interfaces:**
- Consumes: `Prisma.PrismaClientKnownRequestError` (already imported in both service files), `syncTemplateInstances(db, templateId)` from `./template-sync`.
- Produces: no signature changes. `UpdateClassTemplateResult` and `PauseTemplateResult` keep their shapes — both already have a `not_found` reason.

- [ ] **Step 1: Write the failing test for `pauseOrResumeTemplate`**

The window is between the `findUnique` and the `update`. Rather than racing two connections, interpose deterministically: hand the service a client whose `findUnique` does the real read **and then deletes the row** before returning. That is exactly the sequence the guard exists for, with no timing involved.

Use `$extends` for this, which keeps the client properly typed:

```ts
  /**
   * #100. The read and the write are not one transaction, so a delete landing
   * between them surfaces as Prisma's P2025 rather than a clean `not_found`.
   *
   * Interposed rather than raced: the extension below performs the real read
   * and then deletes the row before returning it, which *is* the interleaving
   * the guard exists for. A two-connection race would only reach the same
   * state less reliably.
   */
  it('maps a delete landing between the read and the write to not_found', async () => {
    const t = await makeTemplate('P2025 Pause');
    await prisma.classTemplate.update({ where: { id: t.id }, data: { isActive: false } });

    let deleted = false;
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async findUnique({ args, query }) {
            const row = await query(args);
            if (!deleted) {
              deleted = true;
              await prisma.class.deleteMany({ where: { templateId: t.id } });
              await prisma.classTemplate.delete({ where: { id: t.id } });
            }
            return row;
          },
        },
      },
    });

    const result = await pauseOrResumeTemplate(interposing, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
```

`$extends` returns a client whose type is not `PrismaClient`. If `tsc` rejects passing it to `pauseOrResumeTemplate`, **do not reach for a cast** — widen the service's `db` parameter is also wrong here. Instead check whether the service already accepts a structural type; if it does not, fall back to the stub-client pattern already used in `src/services/studio-class-generator.test.ts` (read it first and follow it exactly), and say in your report which route you took and why.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t "maps a delete landing"`
Expected: FAIL — the raw `PrismaClientKnownRequestError` (P2025) propagates out of the service instead of being mapped, so the assertion never runs.

- [ ] **Step 3: Add the guard**

In `pauseOrResumeTemplate`, wrap the `db.$transaction(...)` call. The `update` inside it is the first statement of the transaction, so nothing holds the row when it runs:

```ts
  const updated = await db
    .$transaction(
      async (tx) => {
        const t = await tx.classTemplate.update({
          where: { id: templateId },
          data: { isActive: desiredActive },
          include: { teacher: { select: { defaultTimezone: true } } },
        });
        if (t.isActive) await generateInstancesForTemplate(tx, t);
        return t;
      },
      // The claim in `class-generator.ts` holds this row's lock for up to its
      // own 10s transaction; Prisma's 5s default would abort us mid-wait.
      { timeout: 10_000 },
    )
    .catch((err: unknown) => {
      // Same window as `updateClassTemplate`'s guard above: the read at the
      // top of this function and this write are not one transaction, and the
      // `update` is the transaction's first statement, so nothing holds the
      // row when it runs. A delete landing in between surfaces as P2025. Map
      // it to the outcome the read-time check would have produced (#100).
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        return null;
      }
      throw err;
    });

  if (updated === null) return { ok: false, reason: 'not_found' };
```

`.catch()` rather than a `try`/`catch` block **on purpose**: a `try` would need `let updated` with an explicit annotation, and the inferred type here is the `include`d payload — awkward to write by hand and easy to let drift from the `include` above it. `.catch()` keeps inference and widens the type to `… | null`, which the guard below immediately narrows.

Keep the existing `{ timeout: 10_000 }` argument and its comment exactly as they are. Do not change what the transaction does.

- [ ] **Step 4: Run it and watch it pass**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`
Expected: all pass, including the pre-existing ones.

- [ ] **Step 5: Write the failing test for `updateClassTemplate`'s sync call**

This window is different: the `update` has already **committed** when it fires. Interpose on the update instead.

```ts
  /**
   * #100. `updateClassTemplate`'s existing guard covers only its own
   * `update`. `syncTemplateInstances` runs after it, outside that `try`, and
   * opens with a `findUniqueOrThrow` — a P2025 source on Prisma 6.
   *
   * Note what this asserts: `not_found` for a write that *did* land. That is
   * deliberate. The row is gone before the caller is answered, so "no such
   * template" is the state their world is actually in; the alternative is
   * reporting a successful update of something that no longer exists.
   */
  it('maps a delete landing between the write and the sync to not_found', async () => {
    const t = await makeTemplate('P2025 Sync');

    let deleted = false;
    const interposing = prisma.$extends({
      query: {
        classTemplate: {
          async update({ args, query }) {
            const row = await query(args);
            if (!deleted) {
              deleted = true;
              await prisma.class.deleteMany({ where: { templateId: t.id } });
              await prisma.classTemplate.delete({ where: { id: t.id } });
            }
            return row;
          },
        },
      },
    });

    const result = await updateClassTemplate(interposing, t.id, teacherId, {
      classType: 'Renamed',
    });

    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });
```

- [ ] **Step 6: Run it and watch it fail**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts -t "between the write and the sync"`
Expected: FAIL — P2025 from `template-sync.ts`'s `findUniqueOrThrow` propagates uncaught.

- [ ] **Step 7: Extend the guard to cover the sync call**

Move `syncTemplateInstances` inside the existing `try`, and extend that comment rather than duplicating it:

```ts
  let updated: ClassTemplate;
  let sync: TemplateSyncResult;
  try {
    updated = await db.classTemplate.update({ where: { id: templateId }, data });
    // Inside the same `try` as the write above, deliberately. This call opens
    // with a `findUniqueOrThrow` (`template-sync.ts`) and runs after the
    // update has already committed, with no lock held in between — so it has
    // a P2025 window of its own (#100).
    sync = await syncTemplateInstances(db, templateId);
  } catch (err) {
    // The read above and these writes are not one transaction, so a delete
    // landing in between surfaces here as Prisma's P2025. Map it to the same
    // outcome the read-time check above would have produced, rather than
    // letting it fall through as an opaque 500.
    //
    // NOTE, corrected after review: this block originally glossed P2025 as
    // "record to update not found". That is Prisma 4/5 wording. Measured
    // against the installed 6.19.3, the `update` raises "No record was found
    // for an update." and `findUniqueOrThrow` raises "No record was found for
    // a query." — one word apart, so the shipped comment points at the
    // invocation line in `err.message` as the usable discriminator instead.
    //
    // From the sync call this means answering `not_found` for an update that
    // *did* commit. That is the honest answer rather than a convenient one:
    // the row is gone before the caller is answered, so reporting a
    // successful update of a template that no longer exists would be the lie.
    // The `sync` counts are lost with it, which costs nothing — but NOT for
    // the reason this line originally gave. `Class.templateId` is
    // `onDelete: SetNull`, so a template delete ORPHANS its generated classes
    // rather than removing them: still `open`, still bookable, frozen with
    // pre-edit settings. What makes the lost counts free is narrower —
    // `syncTemplateInstances` filters on `templateId`, so after the delete it
    // matches none of them and would have reported `{0,0,0}` anyway. Write
    // the shipped version, not this block's first draft.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
      return { ok: false, reason: 'not_found' };
    }
    throw err;
  }

  return { ok: true, template: updated, sync };
```

`TemplateSyncResult` is already imported in this file — check before adding an import.

- [ ] **Step 8: Run the file**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`
Expected: all pass.

- [ ] **Step 9: Record why the other three need nothing**

Add a short comment to each of `archiveOrUnarchiveTemplate` (`class-template-lifecycle.ts`), `pauseOrResumeStudioTemplate` and `archiveOrUnarchiveStudioTemplate` (`studio-class-template-lifecycle.ts`), placed at the CAS.

Write it so it names **the CAS** as the reason, not the function — if a future change replaces the CAS with a plain write, a comment keyed to the function name becomes silently false, while one keyed to the mechanism reads as a warning. Something of this shape, adapted per function:

```ts
      // No P2025 guard here, unlike `updateClassTemplate` and
      // `pauseOrResumeTemplate` (#100). Not an omission: `updateMany` returns
      // `{ count: 0 }` rather than throwing when nothing matches, and the
      // zero-count branch below already answers `not_found` by re-reading. The
      // `findUniqueOrThrow`/`update` sites further down *can* raise P2025, but
      // only run after this CAS matched, which holds the row's write lock
      // until commit — so a concurrent delete blocks rather than wins. Replace
      // this CAS with a plain write and that stops being true.
```

- [ ] **Step 10: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
git add src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts src/services/class-template-lifecycle.test.ts
git commit -m "fix: close the two real P2025 windows in the template services (#100)"
```

---

### Task 2: Align the four failure halves to one member per reason

**Files:**
- Modify: `src/services/class-template-lifecycle.ts`, `src/services/studio-class-template-lifecycle.ts`, `src/app/api/class-templates/[id]/route.ts`, `src/app/api/studio-class-templates/[id]/route.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `PauseTemplateResult`, `ArchiveTemplateResult`, `PauseStudioTemplateResult` and `ArchiveStudioTemplateResult` each gain separate `{ ok: false; reason: … }` members in place of one union-typed member. Every reason value and every `ok: true` member is unchanged, so Task 3 and all existing callers are unaffected.

- [ ] **Step 1: Split the four failure halves**

In `class-template-lifecycle.ts`:

```ts
export type PauseTemplateResult =
  | {
      ok: true;
      action: 'paused';
      template: ClassTemplate;
      lastScheduled: { date: Date; startTime: string } | null;
    }
  | { ok: true; action: 'active'; template: ClassTemplate }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'archived' };

export type ArchiveTemplateResult =
  | { ok: true; action: 'archived'; template: ClassTemplate; deleted: number; remaining: number }
  | { ok: true; action: 'unarchived'; template: ClassTemplate }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' };
```

In `studio-class-template-lifecycle.ts`, the same split on `PauseStudioTemplateResult` (three reasons: `not_found`, `forbidden`, `archived`) and `ArchiveStudioTemplateResult` (two: `not_found`, `forbidden`), keeping their `StudioClassTemplate` types and their existing `ok: true` members exactly as they are.

Leave the `lastScheduled` inline shape alone — Task 3 replaces it.

- [ ] **Step 2: Re-point the four `never` guards**

Four sites. In `src/app/api/class-templates/[id]/route.ts`, both the archive block and the pause block currently end:

```ts
    const unhandled: never = result.reason;
    return unhandled;
```

Change each to `const unhandled: never = result;` and **delete the comment sentences explaining why it narrows on `.reason`** — they describe a shape that no longer exists. Keep the first sentence of each ("Exhaustiveness: a new … reason becomes a compile error here rather than being silently answered with the wrong status."), which is still true.

Do the same at the two sites in `src/app/api/studio-class-templates/[id]/route.ts`. Locate them by content, not line number.

Do **not** change any `if (result.reason === …)` branch, status code, or message.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean. If it is not, the split is wrong somewhere — read the error rather than adding a cast.

- [ ] **Step 4: Run the suites**

Run: `npx vitest run --project unit && npx vitest run --project integration`
Expected: all pass, **unchanged**. The existing `toEqual` result assertions across the two service test files (20
  at HEAD, counting by `toEqual({ ok:`) assert values, and no value changed. If any of them needed editing, something in Step 1 changed a reason string — go back.

- [ ] **Step 5: Mutation-verify that the guards actually bite**

A passing `tsc` on unchanged code proves nothing about a `never` guard. For each of the four unions, one at a time:

1. Add a new member — e.g. `| { ok: false; reason: 'conflict' }` — to the union.
2. Confirm the edit landed by reading the file back.
3. Run `npx tsc --noEmit`.
4. **Expected: a `TS2322` naming `never` at that union's route site.** If `tsc` passes, the guard is not exhaustive and the split did not achieve its purpose — report that rather than moving on.
5. Revert, and confirm `git diff` is empty before the next.

Report all four results.

- [ ] **Step 6: Commit**

```bash
npm run lint
git add src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts "src/app/api/class-templates/[id]/route.ts" "src/app/api/studio-class-templates/[id]/route.ts"
git commit -m "refactor: one union member per failure reason in the template results (#100)"
```

---

### Task 3: Name the `LastScheduledClass` shape once

**Files:**
- Modify: `src/services/class-template-lifecycle.ts`, `src/services/studio-class-template-lifecycle.ts`, `src/components/settings/template-action-messages.ts`

**Interfaces:**
- Consumes: `PauseTemplateResult` / `PauseStudioTemplateResult` as left by Task 2.
- Produces: `export type LastScheduledClass = { date: Date; startTime: string }` from `src/services/class-template-lifecycle.ts`.

- [ ] **Step 1: Declare and export the type**

In `src/services/class-template-lifecycle.ts`, above `PauseTemplateResult`:

```ts
/**
 * The last class still on the schedule for a template, as `pauseOrResumeTemplate`
 * and its studio twin report it, and as `pauseMessage` renders it.
 *
 * Shared rather than declared per site, which is what #100 asked for. Note the
 * two families are otherwise deliberately parallel-but-separate (see the header
 * of `studio-class-template-lifecycle.ts`, and PR #92, which found they had
 * drifted): that policy is about shared *implementation*, and this is two
 * fields with no logic to drift.
 *
 * `TemplateToggleResponse.lastScheduled` in `template-action-messages.ts` is
 * NOT this type and must not be folded into it — it carries `date: string`,
 * the post-`JSON.parse` wire form, converted back at that file's two
 * `resolve*Confirmation` call sites.
 */
export type LastScheduledClass = { date: Date; startTime: string };
```

- [ ] **Step 2: Use it at the three `Date`-form sites**

In `class-template-lifecycle.ts`, `PauseTemplateResult`'s `paused` member:

```ts
      lastScheduled: LastScheduledClass | null;
```

In `studio-class-template-lifecycle.ts`, import it and use it the same way in `PauseStudioTemplateResult`:

```ts
import type { LastScheduledClass } from './class-template-lifecycle';
```

In `src/components/settings/template-action-messages.ts`, `pauseMessage`'s parameter:

```ts
export function pauseMessage(lastScheduled: LastScheduledClass | null): string {
```

with the matching `import type`. Check the existing import style in that file and match it.

- [ ] **Step 3: Typecheck and run everything**

Run: `npx tsc --noEmit && npm run lint`
Then: `npx vitest run --project unit && npx vitest run --project components && npx vitest run --project integration`

Expected: all pass with no test edits. In particular, `tests/integration/class-templates-api.test.ts` and `tests/integration/studio-api.test.ts` declare a deliberately narrower `{ lastScheduled: { startTime: string } | null }` view of the HTTP JSON — **leave those alone.** They are asserting the wire payload, not this type, and widening them to import a service type would couple an HTTP assertion to a service internal.

- [ ] **Step 4: Confirm the wire form is untouched**

Run: `grep -n "lastScheduled" src/components/settings/template-action-messages.ts`
Expected: `TemplateToggleResponse`'s member still reads `{ date: string; startTime: string } | null`, and both `resolve*Confirmation` call sites still do `new Date(last.date)`. If either changed, the two forms have been conflated — revert and re-read Step 1's docblock.

- [ ] **Step 5: Commit**

```bash
git add src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts src/components/settings/template-action-messages.ts
git commit -m "refactor: name the LastScheduledClass shape once (#100)"
```

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 415 before this branch, plus the two new P2025 tests
- [ ] `npx vitest run --project components` — 32 passing, untouched by this change
- [ ] `npx vitest run --project integration` — 215 passing. Needs the app on `:3000`; do not restart it. `signup-api` 429s are the local rate limiter, not this change.
- [ ] `npx playwright test` — 118 passing
- [ ] `git status` — only `docs/backlog-roadmap.md` untracked
- [ ] All four `never` guards mutation-verified, results reported
- [ ] `TemplateToggleResponse.lastScheduled` still `date: string`
- [ ] No P2025 catch added to any of the three CAS functions — each has a comment instead
