# Record What Archiving Withdrew Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make "how many classes did archiving remove, and when?" answerable a day later, instead of for one render (#97).

**Architecture:** Two nullable columns on each template model — `archivedAt` and `withdrawnCount` — written inside the same transaction that performs the delete, and cleared on un-archive. The archived template's own detail page renders them. `remaining` is deliberately not stored; it is a live query.

**Tech Stack:** Prisma migration, PostgreSQL, TypeScript strict, Vitest (`unit` and `components` projects), Next.js App Router server components.

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence errors, no eslint suppressions.
- **Schema changes require a migration.** `npx prisma migrate dev --name <description>` per `CLAUDE.md`. Never `db push`, never hand-edited SQL, and never edit a migration that has already been applied.
- **Both columns are nullable with no default and no backfill.** `null` means never archived — which is every existing row, and the correct answer for them. Inventing a timestamp for templates archived before this ships would be worse than admitting the record starts now.
- **`withdrawnCount` is written from the delete's own returned `count`**, never from a separate count query. The whole value of the record is that it reports what was actually removed.
- **The write happens inside the existing archive transaction**, not after it. A record saying three classes were withdrawn must not survive a rollback that withdrew none.
- **Do not reorder the existing `update` and `deleteMany`.** The `update` runs first and takes the row lock that #95's sweep serialisation depends on; moving it after the delete changes when that lock is acquired. Add a second `update` instead — two writes to the same row in one transaction are cheap.
- **`remaining` is not persisted.** Only `deleted` is unrecoverable. Computing `remaining` at render time is more truthful than freezing it, since classes can be cancelled individually afterwards.
- **Un-archiving clears both columns to `null`.** A live template has no withdrawal to report.
- **The separator in the rendered line is U+00B7 MIDDLE DOT**, matching `pauseMessage`'s `date · time`. The archive *messages* use U+2014 EM DASH; this codebase has both in play and they are not interchangeable.
- **The post-click confirmation message stays.** It is the right medium for "here is what just happened"; the persisted line is for "what happened last time I was here." This change adds the second, it does not trade away the first — do not consolidate them.
- **Mutation-verify**, and per the #66 lesson confirm the mutation applied inside the function under test before trusting its result.

---

## File Structure

| File | Change |
|---|---|
| `prisma/schema.prisma` | `archivedAt DateTime?` + `withdrawnCount Int?` on `ClassTemplate` and `StudioClassTemplate` |
| `prisma/migrations/<generated>/migration.sql` | Generated — four additive nullable columns |
| `src/services/class-template-lifecycle.ts` | Write the record on archive, clear it on un-archive |
| `src/services/studio-class-template-lifecycle.ts` | Same, studio family |
| `src/services/class-template-lifecycle.test.ts` | Five service cases |
| `src/services/studio-class-template-lifecycle.test.ts` | The same five |
| `src/components/settings/archived-record.tsx` | The rendered line, as a component so it can be tested |
| `src/components/settings/archived-record.test.tsx` | Four component cases |
| `src/app/(teacher)/settings/recurring/[id]/page.tsx` | Render it |
| `src/app/(teacher)/settings/studio-classes/[id]/page.tsx` | Render it |

**Two tasks.** Task 1 is the data — schema, migration, both services, service tests. Task 2 is the presentation. A reviewer could reasonably reject the storage shape while approving how it is displayed, or the reverse.

---

### Task 1: Store what was withdrawn

**Files:**
- Modify: `prisma/schema.prisma`, `src/services/class-template-lifecycle.ts`, `src/services/studio-class-template-lifecycle.ts`
- Test: `src/services/class-template-lifecycle.test.ts`, `src/services/studio-class-template-lifecycle.test.ts`

**Interfaces:**
- Produces: `ClassTemplate.archivedAt: Date | null`, `ClassTemplate.withdrawnCount: number | null`, and the same pair on `StudioClassTemplate`. Task 2 reads both from rows it already loads.

- [ ] **Step 1: Add the columns to the schema**

In `prisma/schema.prisma`, on `model ClassTemplate` beside `isArchived`:

```prisma
  /// When this template was last archived, and how many future unbooked
  /// classes that archive withdrew. Both null until the first archive, and
  /// cleared again on un-archive — a live template has no withdrawal to
  /// report. Re-archiving overwrites: a teacher asking what archiving removed
  /// means the archive in force, not every archive this template has had.
  ///
  /// `remaining` is deliberately absent. Only the deletion is unrecoverable;
  /// what is still scheduled is a live query, and truer computed than frozen.
  archivedAt      DateTime?
  withdrawnCount  Int?
```

Add the identical pair, with the same comment, to `model StudioClassTemplate` beside its `isArchived`.

- [ ] **Step 2: Generate the migration**

```bash
npx prisma migrate dev --name record_what_archiving_withdrew
```

Then read the generated SQL and confirm it is four `ADD COLUMN` statements with no `NOT NULL` and no `DEFAULT`. If it contains anything else — a drop, a rename, a data migration — stop and report; that means the schema drifted from the migration history and this plan is not the place to fix it.

- [ ] **Step 3: Write the failing service tests (class family)**

Add to `src/services/class-template-lifecycle.test.ts`, inside the existing `describe('archiveOrUnarchiveTemplate (DB)')` block, which already provides `makeTemplate`, `makeClass`, `register`, `future()`, `futureOn()`, `today()` and `teacherId`:

```ts
  /**
   * #97. The counts used to live only in the confirmation message, so closing
   * the tab lost them. `withdrawnCount` comes from the `deleteMany`'s own
   * returned count — not a separate query — so the record cannot claim a
   * different number from the one the delete actually removed.
   */
  it('records when it archived and how many classes it withdrew', async () => {
    const t = await makeTemplate('Records Withdrawal');
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });

    const before = Date.now();
    const archived = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));

    expect(archived.deleted).toBe(2);
    expect(archived.template.withdrawnCount).toBe(2);
    expect(archived.template.archivedAt).not.toBeNull();
    expect(archived.template.archivedAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  /**
   * The count must equal what was deleted, not what was scheduled. Today's
   * class is spared by the delete's boundary, so the two numbers differ here —
   * which is exactly the case a `count()` written from the wrong query would
   * get wrong while looking right.
   */
  it('records the deleted count, not the scheduled count', async () => {
    const t = await makeTemplate('Withdrawal Excludes Today');
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: today() });

    const archived = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));

    expect(archived.deleted).toBe(1);
    expect(archived.remaining).toBe(1);
    expect(archived.template.withdrawnCount).toBe(1);
  });

  /**
   * Zero is a real answer and must be distinguishable from "never archived".
   * That distinction is the entire reason both columns are nullable.
   */
  it('records zero when there was nothing to withdraw', async () => {
    const t = await makeTemplate('Nothing To Withdraw');

    const archived = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));

    expect(archived.template.withdrawnCount).toBe(0);
    expect(archived.template.archivedAt).not.toBeNull();
  });

  it('clears the record when un-archiving', async () => {
    const t = await makeTemplate('Cleared On Resume');
    await makeClass(t.id, { date: futureOn(5) });
    expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));

    const resumed = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'unarchived');
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');

    expect(resumed.template.archivedAt).toBeNull();
    expect(resumed.template.withdrawnCount).toBeNull();
  });

  /**
   * Overwrite, not accumulate. The second archive withdrew one class; a
   * running total would report two and describe an archive that never happened.
   */
  it('overwrites the record when archiving a second time', async () => {
    const t = await makeTemplate('Archived Twice');
    await makeClass(t.id, { date: futureOn(5) });
    await makeClass(t.id, { date: futureOn(6) });
    expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));
    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'unarchived');

    await makeClass(t.id, { date: futureOn(7) });
    const second = expectArchived(await archiveOrUnarchiveTemplate(prisma, t.id, teacherId, 'archived'));

    expect(second.deleted).toBe(1);
    expect(second.template.withdrawnCount).toBe(1);
  });
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`
Expected: FAIL — `withdrawnCount` and `archivedAt` are `undefined` on the returned template until Step 5 writes them. (They exist as columns after Step 2, so this is a value failure, not a type error.)

- [ ] **Step 5: Write the record in the class service**

In `archiveOrUnarchiveTemplate`, capture one clock reading and use it for both the calendar boundary and the timestamp, then add a second `update` after the `deleteMany`.

Replace the un-archive early return so it clears the record:

```ts
      if (!archiving) {
        const cleared = await tx.classTemplate.update({
          where: { id: templateId },
          data: { archivedAt: null, withdrawnCount: null },
        });
        // A live template has no withdrawal to report. Leaving a stale count
        // on it would be worse than having none (#97).
        return { ok: true as const, action: 'unarchived' as const, template: cleared };
      }
```

Change the clock reading so one instant serves both purposes:

```ts
      const now = new Date();
      const today = startOfLocalDay(now, timeZone);
```

And after the `deleteMany` and the `remaining` count, before the return:

```ts
      // Written from the delete's own `count`, inside the same transaction, so
      // the record cannot claim a number the delete did not produce and cannot
      // survive a rollback that withdrew nothing (#97). A second `update`
      // rather than folding this into the first: that one runs before the
      // delete and takes the row lock the sweep serialises against (#95), and
      // moving it would change when that lock is acquired.
      const recorded = await tx.classTemplate.update({
        where: { id: templateId },
        data: { archivedAt: now, withdrawnCount: deleted },
      });

      return { ok: true as const, action: 'archived' as const, template: recorded, deleted, remaining };
```

The first `update`'s result is now unused on both paths — un-archive returns `cleared`, archive returns `recorded`. **Drop the binding but keep the statement**: `await tx.classTemplate.update({ where: { id: templateId }, data: { isArchived: archiving, isActive: false } });`. The write still happens in the same position, so the row lock is acquired exactly when it was before; only the unused variable goes. Do not move or merge that statement.

- [ ] **Step 6: Run them to verify they pass**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`
Expected: PASS, including the pre-existing archive tests — several assert on the returned `template`, and it is now the row from the second `update` rather than the first.

- [ ] **Step 7: Mirror both into the studio family**

Add the same five tests to `src/services/studio-class-template-lifecycle.test.ts`, using that file's own fixtures, and make the same two service changes in `archiveOrUnarchiveStudioTemplate` against `tx.studioClassTemplate`.

**Read the finished class version first** — the studio one should be recognisably its sibling. The studio delete has no charged-registration filter and its `remaining` counts uncancelled rows, so the "records the deleted count, not the scheduled count" test needs a studio-shaped fixture: one future class plus one dated today, where the delete spares today's.

Run: `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts`
Expected: PASS.

- [ ] **Step 8: Mutation-verify**

```bash
git add -A   # `git checkout --` restores from the index; docs/backlog-roadmap.md
             # is untracked and must stay that way — unstage it if swept in
```

**Mutation A — write the count from a query instead of the delete.** In the class service, replace `withdrawnCount: deleted` with `withdrawnCount: remaining`. Confirm by reading the line that it landed in the service, then run the class test file.
Expected: `'records the deleted count, not the scheduled count'` FAILS (1 vs 1 would pass by coincidence in the other tests — this is the case built to separate them). If it passes, the fixture is not producing different numbers and the test is not doing its job.

**Mutation B — move the record outside the transaction.** Restore, then move the second `update` to after `db.$transaction(...)` returns, using `db` rather than `tx`. Run again.
Expected: the tests still pass — this mutation is *not* caught, and that is worth knowing rather than assuming. Report it. The transaction requirement is defended by the Global Constraint and by review, not by a test, because reproducing a mid-transaction rollback here would take more machinery than the guarantee is worth.

Restore both: `git checkout -- src/services/class-template-lifecycle.ts`

- [ ] **Step 9: Full verification and commit**

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project unit
```

Expected: clean. Baseline before this plan: 388 unit; this task adds 10.

```bash
git add prisma/schema.prisma prisma/migrations \
  src/services/class-template-lifecycle.ts src/services/studio-class-template-lifecycle.ts \
  src/services/class-template-lifecycle.test.ts src/services/studio-class-template-lifecycle.test.ts
git commit -m "feat: record when a template was archived and what it withdrew (#97)"
```

---

### Task 2: Show it on the template's own page

**Files:**
- Create: `src/components/settings/archived-record.tsx`, `src/components/settings/archived-record.test.tsx`
- Modify: `src/app/(teacher)/settings/recurring/[id]/page.tsx`, `src/app/(teacher)/settings/studio-classes/[id]/page.tsx`

**Interfaces:**
- Consumes: `archivedAt: Date | null` and `withdrawnCount: number | null` from Task 1, both already present on the template rows these pages load.
- Produces: `ArchivedRecord({ archivedAt, withdrawnCount })`, a server-safe presentational component rendering nothing when `archivedAt` is `null`.

- [ ] **Step 1: Write the failing component test**

Create `src/components/settings/archived-record.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArchivedRecord } from './archived-record';

/**
 * #97. The counts used to exist only in the post-click confirmation, so a
 * refresh lost them. This line is the durable half; the confirmation stays as
 * the immediate half.
 */
describe('ArchivedRecord', () => {
  it('renders the date and the count', () => {
    render(<ArchivedRecord archivedAt={new Date('2026-06-12T00:00:00.000Z')} withdrawnCount={3} />);

    expect(screen.getByText('Archived Friday, Jun 12 · 3 classes withdrawn')).toBeInTheDocument();
  });

  it('uses the singular for one class', () => {
    render(<ArchivedRecord archivedAt={new Date('2026-06-12T00:00:00.000Z')} withdrawnCount={1} />);

    expect(screen.getByText('Archived Friday, Jun 12 · 1 class withdrawn')).toBeInTheDocument();
  });

  /**
   * "0 classes withdrawn" answers a question nobody asked and reads like a
   * failure. The date still matters — it is when the template was shelved.
   */
  it('omits the count when nothing was withdrawn', () => {
    render(<ArchivedRecord archivedAt={new Date('2026-06-12T00:00:00.000Z')} withdrawnCount={0} />);

    expect(screen.getByText('Archived Friday, Jun 12')).toBeInTheDocument();
  });

  /**
   * Never archived, including every template that existed before #97 shipped.
   * No line, no "unknown" placeholder, no invented history.
   */
  it('renders nothing when the template was never archived', () => {
    const { container } = render(<ArchivedRecord archivedAt={null} withdrawnCount={null} />);

    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project components src/components/settings/archived-record.test.tsx`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/settings/archived-record.tsx`:

```tsx
import { formatDayHeader } from '@/lib/format';

interface ArchivedRecordProps {
  archivedAt: Date | null;
  withdrawnCount: number | null;
}

/**
 * The durable half of what archiving reports (#97). The confirmation message
 * shown right after the click is the immediate half; this is what is still
 * here tomorrow.
 *
 * No line at all when the template was never archived — which includes every
 * template that existed before #97 shipped. An "unknown" placeholder would
 * invent a history the database does not have.
 *
 * The count is omitted when it is zero: "0 classes withdrawn" answers a
 * question nobody asked and reads like something went wrong. The date still
 * shows, because when the template was shelved is worth knowing either way.
 *
 * `remaining` is deliberately not here. It is a live query on the page that
 * uses this, and truer computed than frozen — a teacher who cancels one of the
 * survivors afterwards should see that number drop.
 */
export function ArchivedRecord({ archivedAt, withdrawnCount }: ArchivedRecordProps) {
  if (!archivedAt) return null;

  const withdrawn =
    withdrawnCount && withdrawnCount > 0
      ? ` · ${withdrawnCount} ${withdrawnCount === 1 ? 'class' : 'classes'} withdrawn`
      : '';

  return (
    <p className="type-caption">
      {`Archived ${formatDayHeader(archivedAt)}${withdrawn}`}
    </p>
  );
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run --project components src/components/settings/archived-record.test.tsx`
Expected: PASS, all four.

- [ ] **Step 5: Render it on both detail pages**

In `src/app/(teacher)/settings/recurring/[id]/page.tsx`, inside the `<section>` that holds the toggle and archive buttons, above them:

```tsx
        <ArchivedRecord
          archivedAt={template.archivedAt}
          withdrawnCount={template.withdrawnCount}
        />
```

Import it from `@/components/settings/archived-record`. Do the same in `src/app/(teacher)/settings/studio-classes/[id]/page.tsx` — read that file first to find its equivalent section, and match its existing layout rather than importing the recurring page's structure.

Both pages already load the full template row, so no query changes.

- [ ] **Step 6: Verify the pages compile and nothing regressed**

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project components
npx vitest run --project unit
```

Expected: clean; components 24 + 4 = 28, unit at Task 1's total.

- [ ] **Step 7: Mutation-verify the zero case**

Stage, then change the component's condition from `withdrawnCount && withdrawnCount > 0` to `withdrawnCount !== null`. Confirm by reading the line that it landed in the component, then run the component test file.
Expected: `'omits the count when nothing was withdrawn'` FAILS, and the other three still pass. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/archived-record.tsx \
  src/components/settings/archived-record.test.tsx \
  "src/app/(teacher)/settings/recurring/[id]/page.tsx" \
  "src/app/(teacher)/settings/studio-classes/[id]/page.tsx"
git commit -m "feat: show what archiving withdrew on the template's own page (#97)"
```

---

## Verification before opening the PR

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 398 passing
- [ ] `npx vitest run --project components` — 28 passing
- [ ] `npx vitest run --project integration` — 214 passing (needs the app on `:3000`; do not restart it. `signup-api` 429s are the local rate limiter, not this change)
- [ ] `npx playwright test` — 118 passing
- [ ] `git status` — the generated migration directory is committed, and `docs/backlog-roadmap.md` is still untracked
