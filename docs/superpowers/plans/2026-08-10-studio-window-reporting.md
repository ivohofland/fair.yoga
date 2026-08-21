# Studio window reporting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A studio template resume reports what the window holds and what it added (#119), and creating a studio template fills its window inside the create transaction (#120).

**Architecture:** The resume path already produces the number it throws away. Carry it up through four layers — service outcome, public result, PATCH body, response type — and add a sibling count so the copy reports occupancy rather than a bare delta. The studio toggle response type splits from the class family's rather than gaining optional fields. Separately, `POST /api/studio-class-templates` takes the shape `POST /api/class-templates` already has: create and generate in one transaction.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict` + `noUncheckedIndexedAccess`, Prisma/PostgreSQL, Vitest (unit + `integration` project against a live server on :3000), React Testing Library.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-08-10-studio-window-reporting-design.md`. Read it before Task 1; it records which of the two issues' claims were false and why.
- **Copy is exact.** The five strings in Task 1 are the specification, character for character. Do not reword, re-punctuate, or add "for the next 4 weeks" — §2 of the spec explains why that phrase is deliberately absent.
- **`generateStudioInstancesForTemplate` keeps its `Promise<number>` signature.** Its own docblock advertises parity with `generateInstancesForTemplate` ("same client union, same optional `from`, same count of rows created"). Nothing in this plan changes it.
- **The probe's missing `cancelledAt` filter is left alone deliberately.** `StudioClass` carries `@@unique([templateId, date])`, so skipping a cancelled date is the only reachable behaviour; adding the filter would produce a P2002 and falsify the hedge's own warning text. Do not "fix" it.
- **The class family is out of scope.** `pauseOrResumeTemplate`, `template-sync.ts` and `POST /api/class-templates` discard their counts identically. That is tracked on #116. Touch none of them.
- **Never `git add -A` or `git add .`** — stage the exact paths listed in each task.
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project needs it live.
- **Task order is load-bearing between Tasks 3 and 4.** See the note under Task 4.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/components/settings/template-action-messages.ts` | All confirmation copy + the two response types + both resolvers | 1, 4 |
| `src/components/settings/template-action-messages.test.ts` | Copy unit tests | 1, 4 |
| `src/services/studio-class-template-lifecycle.ts` | `scheduled`/`added` on the `active` arm | 2 |
| `src/services/studio-class-template-lifecycle.test.ts` | Service tests incl. the `pause → archive → un-archive → resume` case | 2 |
| `src/app/api/studio-class-templates/[id]/route.ts` | Forwards the pair; ternary → `switch` | 3 |
| `src/components/settings/toggle-studio-template-button.tsx` | Adopts the studio response type | 4 |
| `src/components/settings/archive-studio-template-button.tsx` | Adopts the studio response type | 4 |
| `src/components/settings/toggle-studio-template-button.test.tsx` | Renders the resume message; stale fixture corrected | 4 |
| `src/app/api/studio-class-templates/route.ts` | POST generates in a transaction | 5 |
| `src/services/studio-class-generator.ts` | Two docstring rosters corrected (comments only) | 5 |
| `tests/integration/studio-api.test.ts` | PATCH body carries the pair; POST fills the window; rollback | 3, 5 |

---

### Task 1: The resume copy

Pure function, no wiring, no dependencies. It exists first so later tasks reference exact strings rather than inventing them.

**Files:**
- Modify: `src/components/settings/template-action-messages.ts` (add after `archiveStudioMessage`, which ends at `:85`)
- Test: `src/components/settings/template-action-messages.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `resumeStudioMessage(added: number, scheduled: number): string`. Task 4 calls it from `resolveStudioConfirmation`.

- [ ] **Step 1: Write the failing tests**

Append to `src/components/settings/template-action-messages.test.ts`:

```ts
describe('resumeStudioMessage', () => {
  it('reports the window when the resume filled it', () => {
    expect(resumeStudioMessage(4, 4)).toBe('4 classes on your schedule.');
  });

  it('says nothing needed adding when the window was already full', () => {
    expect(resumeStudioMessage(0, 4)).toBe(
      '4 classes on your schedule. Nothing needed adding.',
    );
  });

  it('reports a short window without claiming why it is short', () => {
    expect(resumeStudioMessage(2, 2)).toBe('2 classes on your schedule.');
  });

  it('agrees in number at one class', () => {
    expect(resumeStudioMessage(1, 1)).toBe('1 class on your schedule.');
    expect(resumeStudioMessage(0, 1)).toBe(
      '1 class on your schedule. Nothing needed adding.',
    );
  });

  it('reports an empty window without naming a cause', () => {
    expect(resumeStudioMessage(0, 0)).toBe('Nothing is scheduled from this template.');
  });

  // The argument order is delta-first to match `archiveStudioMessage` even
  // though the sentence leads with the second argument, so the two outputs must
  // stay distinguishable. NOTE (corrected after PR review): this pins the
  // *function's* parameter order only. It does NOT guard the call site — see
  // Task 4, which is where the real guard had to go.
  it('distinguishes its two arguments', () => {
    expect(resumeStudioMessage(0, 4)).not.toBe(resumeStudioMessage(4, 0));
  });
});
```

Add `resumeStudioMessage` to the existing import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/settings/template-action-messages.test.ts`
Expected: FAIL. The import does not resolve, so the whole file errors — not six individual assertion failures.

- [ ] **Step 3: Implement**

Insert after `archiveStudioMessage` in `src/components/settings/template-action-messages.ts`:

```ts
/**
 * Confirmation shown after resuming a studio class template (#119).
 *
 * Reports what the window *holds*, not only what this click *added* —
 * mirroring `archiveStudioMessage`'s `deleted`/`remaining` pair, because the
 * same asymmetry applies: the teacher is on Settings and the effect lands on
 * the Schedule tab, so a bare delta is unreadable without its baseline.
 *
 * Deliberately makes no "for the next 4 weeks" claim. `scheduled` is counted
 * with `scheduledWhere(templateId, { gte: today })` — the same unbounded
 * from-today predicate archive's `remaining` uses — so no upper boundary backs
 * such a phrase. Bounding the count to the window would mean re-deriving the
 * generator's date *set* as a *range*, and two boundaries that can disagree at
 * the edges is the gt/gte defect this codebase has already paid for twice.
 *
 * The `scheduled === 0` branch names no cause. It is reachable exactly when
 * every candidate date holds a cancelled row — `pause → archive → un-archive →
 * resume` at its limit, the sequence #119 was filed about. That inference is
 * sound today and rests on generator internals, so it stays out of the copy:
 * occupancy is checkable by whoever reads the message, cause is not.
 *
 * Argument order is delta-first, matching `archiveStudioMessage(deleted,
 * remaining)`, even though the sentence leads with the second argument. The
 * outputs for `(0, 4)` and `(4, 0)` differ, which is what makes a transposition
 * detectable at all — but see Task 4: detectable is not the same as guarded, and
 * the version of this docblock that claimed otherwise was false. The shipped
 * wording is in `template-action-messages.ts`; do not restore this one.
 *
 * No verb after the count, for the reason `archiveMessage` records above:
 * nothing left that can fall out of agreement with `classWord`.
 */
export function resumeStudioMessage(added: number, scheduled: number): string {
  if (scheduled === 0) return 'Nothing is scheduled from this template.';

  const classWord = scheduled === 1 ? 'class' : 'classes';

  return added === 0
    ? `${scheduled} ${classWord} on your schedule. Nothing needed adding.`
    : `${scheduled} ${classWord} on your schedule.`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/settings/template-action-messages.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Correct the `pauseMessage` docblock, which this settles**

`pauseMessage`'s docblock (`:4-16`) currently ends: *"Whether it should say something is a copy decision, deliberately not taken here — only the stale justification is removed."* That decision is now taken. Replace those two sentences with:

```
 * That used to be justified as "resuming needs no explanation", which was
 * true when resuming did nothing but flip a flag. It is not true any more:
 * since #94 resuming a studio template generates its four-week window on the
 * spot, as the class family already did. `resumeStudioMessage` below is the
 * studio side's answer to that (#119); the class family's resume still says
 * nothing, tracked on #116.
```

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/template-action-messages.ts src/components/settings/template-action-messages.test.ts
git commit -m "feat: copy for a studio resume, which has said nothing since #94"
```

---

### Task 2: The service reports what the window holds

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` (`:49-60`, `:114-119`, `:342-346`, `:370-371`)
- Test: `src/services/studio-class-template-lifecycle.test.ts` (the `pauseOrResumeStudioTemplate (DB)` block, from `:510`)

**Interfaces:**
- Consumes: `generateStudioInstancesForTemplate(db, template, from?): Promise<number>` (unchanged), `scheduledWhere(templateId, { gte: Date })` (already in this file at `:92`), `startOfLocalDay(date, timeZone)` (already imported).
- Produces: `PauseStudioTemplateResult`'s `active` arm gains `scheduled: number` and `added: number`. Tasks 3 and 4 depend on both names.

**Note on the fixtures:** two tests below need a template whose weekday is **never today**, because the archive's `gt: today` carve-out changes the expected arithmetic when the window contains a class dated today. Without that, the tests pass or fail depending on the day they run — the #138 failure mode, where a check proved nothing because both paths agreed at the hour it ran.

- [ ] **Step 1: Write the failing tests**

Add to the top of the `pauseOrResumeStudioTemplate (DB)` block, beside the existing `futureOn` helper:

```ts
  /**
   * A `dayOfWeek` two days out, so a generated window never contains a class
   * dated today. The archive's delete boundary is `gt: today` while the counts
   * are `gte: today`, so a today-dated class changes the expected numbers in
   * the two tests below — and whether one exists depends on what weekday the
   * suite happens to run on. Pinned rather than left to chance: a test whose
   * expectations shift with the calendar is the #138 shape, where a check
   * passed because both code paths agreed at the hour it ran.
   *
   * Two days rather than one so a run that crosses local midnight cannot turn
   * "tomorrow" into "today" mid-test.
   */
  const dayOfWeekNeverToday = () => {
    const jsDay = new Date().getUTCDay(); // 0=Sun … 6=Sat
    const schemaToday = (jsDay + 6) % 7; // schema: 0=Mon … 6=Sun
    return (schemaToday + 2) % 7;
  };

  const makeTemplateOn = (classType: string, dayOfWeek: number) =>
    prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType,
        dayOfWeek,
        startTime: '09:30',
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
      },
    });
```

Then add the two tests.

> **Correction, issue 279 (2026-08-21):** the comment below says cancelled
> classes are spared because "they are income records". They are not —
> `settings/reporting/page.tsx:36` filters on `cancelledAt: null` and excludes
> them from earnings. The *mechanism* the comment describes is right
> (`@@unique([templateId, date])` makes those dates unrepresentable); only the
> reason is wrong. The shipped comment was corrected; this block is left as
> written to record what the round believed.

```ts
  /**
   * The case #119 exists for. `pause → archive → un-archive → resume` is the
   * sequence #94's PR body named: the archive deliberately spares cancelled
   * classes (they are income records), and the generator's existence probe has
   * no `cancelledAt` filter, so those dates cannot be regenerated either —
   * `@@unique([templateId, date])` makes it unrepresentable. The teacher
   * therefore gets back fewer classes than the archive withdrew, and before
   * this test nothing said so.
   */
  it('reports a window shortened by cancelled classes, not the four it withdrew', async () => {
    const t = await makeTemplateOn('Resume After Archive', dayOfWeekNeverToday());
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false },
    });

    const filled = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');
    expect(filled.ok).toBe(true);
    if (!filled.ok) throw new Error('expected ok');
    if (filled.action !== 'active') throw new Error('expected the active action');
    expect(filled.added).toBe(4);
    expect(filled.scheduled).toBe(4);

    // Cancel the two furthest-out. `.slice(2)` rather than indexing, so this
    // needs no non-null assertions under `noUncheckedIndexedAccess`.
    const generated = await prisma.studioClass.findMany({
      where: { templateId: t.id },
      orderBy: { date: 'asc' },
      select: { id: true },
    });
    expect(generated).toHaveLength(4);
    const toCancel = generated.slice(2).map((c) => c.id);
    expect(toCancel).toHaveLength(2);
    await prisma.studioClass.updateMany({
      where: { id: { in: toCancel } },
      data: { cancelledAt: new Date() },
    });

    await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');
    const archived = await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'archived');
    expect(archived.ok).toBe(true);
    if (!archived.ok) throw new Error('expected ok');
    if (archived.action !== 'archived') throw new Error('expected the archived action');
    // Two of the four: the cancelled pair is spared.
    expect(archived.deleted).toBe(2);
    await archiveOrUnarchiveStudioTemplate(prisma, t.id, teacherId, 'unarchived');

    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    if (resumed.action !== 'active') throw new Error('expected the active action');
    // Two, not four. Only the dates the archive emptied come back.
    expect(resumed.added).toBe(2);
    expect(resumed.scheduled).toBe(2);
    // `scheduled >= added` — every added row is future-dated and uncancelled,
    // so it necessarily falls inside `scheduled`'s range.
    expect(resumed.scheduled).toBeGreaterThanOrEqual(resumed.added);

    // The spared pair still stands: the archive left them and the resume did
    // not resurrect them.
    expect(
      await prisma.studioClass.count({
        where: { templateId: t.id, cancelledAt: { not: null } },
      }),
    ).toBe(2);
  });

  /**
   * The two filters inside `scheduled`'s count, each pinned by a row the other
   * filter would not move: one dated exactly on the `gte` boundary, one
   * cancelled and comfortably inside it. Both sit off the template's own
   * weekday, so generation neither creates nor touches them.
   */
  it('counts a class dated today, and excludes a cancelled one', async () => {
    const t = await makeTemplateOn('Resume Counts Boundary', dayOfWeekNeverToday());
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false },
    });

    // Exactly on the `gte: today` boundary.
    await makeClass(t.id, new Date(), '07:00');
    // Inside the boundary but cancelled. `futureOn(1)` cannot collide with the
    // generated window, which starts two days out by construction.
    await prisma.studioClass.create({
      data: {
        teacherId,
        templateId: t.id,
        classType: 'Pause Rule',
        date: futureOn(1),
        startTime: '07:30',
        durationMinutes: 60,
        location: 'Studio Loft',
        hourlyRate: 45,
        cancelledAt: new Date(),
      },
    });

    const resumed = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error('expected ok');
    if (resumed.action !== 'active') throw new Error('expected the active action');
    expect(resumed.added).toBe(4);
    // Four generated plus today's = 5. The cancelled one does not count.
    expect(resumed.scheduled).toBe(5);
    expect(resumed.scheduled).toBeGreaterThanOrEqual(resumed.added);
  });
```

Also extend the existing `'fills the window when resuming'` test (`:703`) with the numbers it can now see, immediately after its `expect(result.action).toBe('active')`:

```ts
    if (result.action !== 'active') throw new Error('expected the active action');
    expect(result.added).toBe(4);
    expect(result.scheduled).toBe(4);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/services/studio-class-template-lifecycle.test.ts`
Expected: FAIL at typecheck/runtime on `filled.added` — the property does not exist on the `active` arm. This is the discard #119 names, observed.

- [ ] **Step 3: Widen the two result types**

In `src/services/studio-class-template-lifecycle.ts`, replace the `PauseStudioTemplateResult` docblock and `active` arm (`:43-60`):

```ts
/**
 * Outcome of a pause/resume PATCH. `paused` carries the furthest-out class
 * still on the schedule, for the pause confirmation; `active` carries what the
 * window holds and what this resume added (#119); `unchanged` reports nothing
 * beyond the template itself.
 *
 * `active` is where this stops mirroring `PauseTemplateResult` in the class
 * family. `pauseOrResumeTemplate` (`class-template-lifecycle.ts`) generates on
 * resume too and discards the count identically — deliberately not fixed
 * alongside this, because that resume generates *without* taking the claim, so
 * a count from it would be a count from a racy generation. Tracked on #116.
 */
export type PauseStudioTemplateResult =
  | {
      ok: true;
      action: 'paused';
      template: StudioClassTemplate;
      lastScheduled: LastScheduledClass | null;
    }
  | {
      ok: true;
      action: 'active';
      template: StudioClassTemplate;
      /**
       * Uncancelled studio classes for this template from the start of the
       * teacher's today onward — the same predicate and boundary
       * `ArchiveStudioTemplateResult`'s `remaining` uses, so the two numbers a
       * teacher sees from archiving and from resuming mean the same thing.
       * Unbounded above; see `resumeStudioMessage` for why the copy therefore
       * promises no window.
       */
      scheduled: number;
      /** Rows this resume created. `scheduled >= added`, always. */
      added: number;
    }
  | { ok: true; action: 'unchanged'; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'archived' };
```

And the `ResumeTransactionOutcome` `active` arm (`:119`):

```ts
  | {
      outcome: 'active';
      template: StudioClassTemplate;
      scheduled: number;
      added: number;
    };
```

- [ ] **Step 4: Capture the count inside the transaction**

Replace `:342-346` (from `await generateStudioInstancesForTemplate(tx, claimed);` through the `return`):

```ts
      const added = await generateStudioInstancesForTemplate(tx, claimed);

      // Same helper and same boundary as `archiveOrUnarchiveStudioTemplate`'s
      // `remaining`, so archiving and resuming report on one basis. `gte`, not
      // `gt`: this path deletes nothing, so there is no spare-today carve-out
      // to mirror — a class dated today is on the schedule and must be counted.
      //
      // Inside the transaction, under the claim's `FOR UPDATE`, and from the
      // *locked* row's timezone rather than the pre-transaction snapshot's —
      // unlike the `paused` arm below, which derives its boundary after the
      // transaction has committed and has no lock left to read under.
      const today = startOfLocalDay(new Date(), claimed.teacher.defaultTimezone);
      const scheduled = await tx.studioClass.count({
        where: scheduledWhere(templateId, { gte: today }),
      });

      const { teacher: _claimTeacher, ...bareClaimed } = claimed;
      void _claimTeacher;
      return { outcome: 'active', template: bareClaimed, scheduled, added };
```

Then the switch's `active` case (`:370-371`):

```ts
    case 'active':
      return {
        ok: true,
        action: 'active',
        template: result.template,
        scheduled: result.scheduled,
        added: result.added,
      };
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/services/studio-class-template-lifecycle.test.ts`
Expected: PASS, whole file — the pre-existing tests included.

- [ ] **Step 6: Prove the `cancelledAt` filter can fail**

A guard nobody has watched fail is not a guard. Break it, record the output, restore, re-verify.

1. In `scheduledWhere` (`:92-96`), comment out `cancelledAt: null`.
2. Run: `npx vitest run src/services/studio-class-template-lifecycle.test.ts`
3. Expected: FAIL. `'counts a class dated today, and excludes a cancelled one'` gets `scheduled: 6` where 5 was expected, and `'reports a window shortened by cancelled classes'` gets `scheduled: 4` where 2 was expected. Record both actual numbers verbatim in your report.
4. Restore the line. Re-run. Expected: PASS.

Note in your report that this mutation also perturbs the archive block, since `scheduledWhere` is shared — that is expected and is itself evidence the helper is the one both paths use.

- [ ] **Step 7: Prove the `gte` boundary can fail**

1. Change the new count's `{ gte: today }` to `{ gt: today }`.
2. Run: `npx vitest run src/services/studio-class-template-lifecycle.test.ts`
3. Expected: FAIL — `'counts a class dated today, and excludes a cancelled one'` gets `scheduled: 4`, expected 5. Record it.
4. Restore. Re-run. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/services/studio-class-template-lifecycle.ts src/services/studio-class-template-lifecycle.test.ts
git commit -m "feat: a studio resume returns what the window holds, and what it added"
```

---

### Task 3: The PATCH route forwards the pair

**Files:**
- Modify: `src/app/api/studio-class-templates/[id]/route.ts:103-107`
- Test: `tests/integration/studio-api.test.ts`

**Interfaces:**
- Consumes: `PauseStudioTemplateResult`'s `active` arm with `scheduled`/`added` (Task 2).
- Produces: the PATCH `data` payload carries `scheduled` and `added` alongside `action: 'active'`. Task 4's response type describes exactly this body.

- [ ] **Step 1: Write the failing test**

Add to the `/api/studio-class-templates/[id]` area of `tests/integration/studio-api.test.ts`:

```ts
describe('PATCH /api/studio-class-templates/[id] — resume reporting', () => {
  /**
   * #119. The service produced this number and four layers dropped it, ending
   * at `setMessage('')`. This is the wire half of that chain.
   */
  it('carries what the window holds and what the resume added', async () => {
    const t = await makeTemplate(ownerId, 'Resume Reports');
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false },
    });

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${t.id}?state=active`);
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { action: string; scheduled: number; added: number };
    };
    expect(data.action).toBe('active');
    expect(data.added).toBe(4);
    expect(data.scheduled).toBe(4);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: FAIL — `data.added` is `undefined`, because the route spreads only `...result.template` and `action`.

Requires the dev server live on :3000. A wall of `ECONNREFUSED` means it is not — ask, do not start it.

- [ ] **Step 3: Replace the ternary with a switch**

In `src/app/api/studio-class-templates/[id]/route.ts`, replace `:103-107`:

```ts
  if (result.ok) {
    // A `switch` rather than the two-way ternary this replaces. `active` now
    // carries fields of its own (#119), and the ternary's `else` limb would
    // have dropped them silently while staying correct for `unchanged` — the
    // same accidental-exhaustiveness failure `pauseOrResumeStudioTemplate`
    // records for its own switch, where a new arm compiled clean and was
    // answered with the wrong action.
    switch (result.action) {
      case 'paused':
        return respondOk({
          ...result.template,
          action: result.action,
          lastScheduled: result.lastScheduled,
        });
      case 'active':
        return respondOk({
          ...result.template,
          action: result.action,
          scheduled: result.scheduled,
          added: result.added,
        });
      case 'unchanged':
        return respondOk({ ...result.template, action: result.action });
      default: {
        const unhandled: never = result;
        return unhandled;
      }
    }
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: PASS, whole file.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/studio-class-templates/[id]/route.ts" tests/integration/studio-api.test.ts
git commit -m "feat: the studio PATCH forwards the resume counts it was dropping"
```

---

### Task 4: The response type splits, and the button speaks

**Order matters: this task must follow Task 3, not precede it.** `StudioTemplateToggleResponse` declares `scheduled` and `added` as **required** on the `active` arm. Landing it before the route sends them would leave a type asserting wire fields that do not exist, and the button's fixtures would have to fabricate them — a lie that compiles and passes. Task 3 first means the type never over-claims.

**Files:**
- Modify: `src/components/settings/template-action-messages.ts` (`:87-91` type, `:115-128` resolver)
- Modify: `src/components/settings/toggle-studio-template-button.tsx:6,31`
- Modify: `src/components/settings/archive-studio-template-button.tsx:~6,29`
- Test: `src/components/settings/toggle-studio-template-button.test.tsx`

**Interfaces:**
- Consumes: `resumeStudioMessage(added, scheduled)` (Task 1); the PATCH body from Task 3.
- Produces: `StudioTemplateToggleResponse`; `resolveStudioConfirmation(data: StudioTemplateToggleResponse)`.

- [ ] **Step 1: Write the failing test, and correct the stale fixture**

In `src/components/settings/toggle-studio-template-button.test.tsx`, add an `activeOk` fixture beside `pausedOk`:

```tsx
  const activeOk = {
    ok: true,
    json: async () => ({ data: { action: 'active', scheduled: 4, added: 4 } }),
  };
```

Then add the test:

```tsx
  it('renders the resume confirmation, where it used to render nothing', async () => {
    stubFetch(activeOk);
    render(<ToggleStudioTemplateButton templateId="tpl-1" isActive={false} />);

    fireEvent.click(screen.getByRole('button'));

    // The whole string. #119's whole content is that this seam was `''`.
    expect(await screen.findByText('4 classes on your schedule.')).toBeInTheDocument();
    await waitFor(() => expect(routerRefresh).toHaveBeenCalled());
  });
```

**And correct the existing `'sends state=active when the template is not active'` test at `:46`.** It stubs `{ data: { action: 'active' } }` — a payload the route can no longer produce, since Task 3. The stub is cast rather than typechecked, so it compiles either way and the test still passes on its URL assertion; that is precisely why it needs fixing by hand. Replace its inline stub with the shared fixture:

```tsx
    stubFetch(activeOk);
```

- [ ] **Step 2: Run the tests to verify the new one fails**

Run: `npx vitest run src/components/settings/toggle-studio-template-button.test.tsx`
Expected: FAIL on the new test — `Unable to find an element with the text: 4 classes on your schedule.` The pre-existing five still pass.

- [ ] **Step 3: Add the studio response type**

In `src/components/settings/template-action-messages.ts`, leave `TemplateToggleResponse` (`:87-91`) exactly as it is and add below it:

```ts
/**
 * The `data` payload of a successful PATCH on a *studio* class template (#119).
 *
 * Split from `TemplateToggleResponse` rather than adding optional fields to its
 * shared `active` arm. The optional-field version is the smaller diff and
 * certifies nothing: the class family would carry `scheduled?`/`added?` it
 * never sets, and nothing would notice if the studio route stopped setting
 * them. That is the failure `resolveTemplateConfirmation` records below — #93's
 * wrong-shape bug, where `archiveStudioMessage` had the wrong signature and the
 * button silently discarded `remaining` — and the one #136's pins exist to
 * prevent.
 *
 * `scheduled` and `added` are required, not optional. The route sends both on
 * every `active` response; a type that allowed their absence would be
 * describing a payload the server cannot produce.
 */
export type StudioTemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | { action: 'active'; scheduled: number; added: number }
  | { action: 'unarchived' | 'unchanged' };
```

- [ ] **Step 4: Narrow the resolver and give it the resume branch**

Replace `resolveStudioConfirmation` and its docblock (`:115-128`):

```ts
/**
 * The studio sibling of `resolveTemplateConfirmation`. A separate function
 * rather than a parameter: the two families now differ in the archive wording
 * *and* in whether resuming says anything at all (#119), so threading a message
 * function through would put most of the English in the caller — and they are
 * kept parallel-but-separate throughout regardless.
 *
 * `null` is the right answer for two of the five actions here, not the class
 * family's three: `active` speaks now. `unchanged` is the one that still must
 * not — it is what a stale second tab and a retry-after-lost-response reach, so
 * a confirmation there would describe something that did not happen.
 *
 * Nothing is said on **create**, and that is a decision rather than an
 * oversight to be tidied up later. Creating a weekly template means "put this
 * on my schedule weekly", so four classes appearing is the definition of the
 * thing working, not a consequence needing disclosure — and both families'
 * create forms navigate to their own settings list, where the teacher sees the
 * template they just made. The class family settled the same question for its
 * own POST: see
 * `docs/superpowers/specs/2026-07-23-template-generate-on-create-design.md`
 * ("Response shapes are unchanged … The front-end needs no changes").
 */
export function resolveStudioConfirmation(data: StudioTemplateToggleResponse): string | null {
  if (data.action === 'paused') {
    const last = data.lastScheduled;
    return pauseMessage(last ? { date: new Date(last.date), startTime: last.startTime } : null);
  }
  if (data.action === 'archived') return archiveStudioMessage(data.deleted, data.remaining);
  if (data.action === 'active') return resumeStudioMessage(data.added, data.scheduled);
  return null;
}
```

- [ ] **Step 5: Point both studio buttons at the new type**

In `src/components/settings/toggle-studio-template-button.tsx` and `src/components/settings/archive-studio-template-button.tsx`, change the import and the cast from `TemplateToggleResponse` to `StudioTemplateToggleResponse`. Two lines each — the import at the top and the `as { data: … }` at the `res.json()` call. Leave `toggle-template-button.tsx` and `archive-template-button.tsx` alone.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/components/settings/ && npx tsc --noEmit`
Expected: PASS, and `tsc` clean.

- [ ] **Step 7: Prove the type split can fail**

This is the step the whole split stands on. A type pin that compiles clean proves nothing — #39 shipped three such guards, all caught only at PR review.

1. In `toggle-studio-template-button.tsx`, revert **only** the `as { data: … }` cast to `TemplateToggleResponse` (keep both imports so the revert is minimal).
2. Run: `npx tsc --noEmit`
3. Expected: FAIL, because `TemplateToggleResponse`'s `active` arm has no `scheduled`, so it is not assignable where `StudioTemplateToggleResponse` is required. **Record the exact error text.**
4. **If `tsc` passes, stop and report it.** The split is then worthless as written and the design needs revisiting before this branch is worth merging — do not paper over it with a `satisfies` clause or a cast.
5. Restore. Re-run `npx tsc --noEmit`. Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/template-action-messages.ts src/components/settings/toggle-studio-template-button.tsx src/components/settings/archive-studio-template-button.tsx src/components/settings/toggle-studio-template-button.test.tsx
git commit -m "feat: the studio toggle response splits from the class family's, and says the count"
```

---

### Task 5: Creating a studio template fills its window (#120)

Independent of Tasks 1–4 — different file, different issue. Last because the roadmap sequences #119 first.

**Files:**
- Modify: `src/app/api/studio-class-templates/route.ts:18-33`
- Modify: `src/services/studio-class-generator.ts` (two docblocks: `:70-76` and `:150-158`) — comments only, no code
- Test: `tests/integration/studio-api.test.ts`

**Interfaces:**
- Consumes: `generateStudioInstancesForTemplate(db, template, from?)` from `@/services/studio-class-generator`, where `template` must include `{ teacher: { select: { defaultTimezone: true } } }`.
- Produces: nothing other tasks depend on. Response shape is unchanged (201, template).

- [ ] **Step 1: Write the failing tests**

Add to the `POST /api/studio-class-templates` describe block in `tests/integration/studio-api.test.ts`:

```ts
  /**
   * #120. The class family's POST has generated inside its own transaction
   * since #56; the studio POST was a plain `create`, so a new template sat
   * `isActive: true` with an empty window until the next hourly sweep — up to
   * 60 minutes during which the only control the teacher can see ("Resume
   * studio class") answers `200 unchanged` and generates nothing.
   */
  it('fills the window, so a new template is not empty until the next sweep', async () => {
    const res = await send('POST', ownerToken, '/api/studio-class-templates', {
      classType: 'Generates On Create',
      dayOfWeek: 2,
      startTime: '11:00',
      durationMinutes: 60,
      location: 'Generating Studio',
      hourlyRate: 55,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    expect(await prisma.studioClass.count({ where: { templateId: data.id } })).toBe(4);
  });

  /**
   * Atomicity, ported from the class family's proven pattern in
   * `class-templates-api.test.ts`: force a *deterministic* FK failure (P2003)
   * rather than the P2002 the generator hedges and swallows, and assert the
   * whole transaction rolled back. A template that persists while its window
   * does not is the state #56 removed for the class family.
   */
  it('rolls the template back when generation fails', async () => {
    const before = await prisma.studioClassTemplate.count({ where: { teacherId: ownerId } });

    await expect(
      prisma.$transaction(async (tx) => {
        const created = await tx.studioClassTemplate.create({
          data: {
            teacherId: ownerId,
            classType: 'Rolls Back',
            dayOfWeek: 4,
            startTime: '12:00',
            durationMinutes: 60,
            location: 'Doomed Studio',
            hourlyRate: 40,
          },
          include: { teacher: { select: { defaultTimezone: true } } },
        });
        // A teacherId no Teacher row has: `studioClass.create` fails its FK
        // check with P2003, which nothing in the generator catches.
        await generateStudioInstancesForTemplate(tx, {
          ...created,
          teacherId: '00000000-0000-0000-0000-000000000000',
        });
      }),
    ).rejects.toThrow();

    expect(await prisma.studioClassTemplate.count({ where: { teacherId: ownerId } })).toBe(before);
    expect(
      await prisma.studioClass.count({ where: { location: 'Doomed Studio' } }),
    ).toBe(0);
  });
```

Add to the file's imports — the `@/` alias, matching
`class-templates-api.test.ts:3`, which imports its own generator exactly this way
for exactly this test:

```ts
import { generateStudioInstancesForTemplate } from '@/services/studio-class-generator';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: the window test FAILS with `expected 0 to be 4`. The rollback test may already pass — it exercises the generator directly rather than the route, so it is a pin on the transaction semantics the route is about to rely on, not on the route itself. Report which of the two failed.

- [ ] **Step 3: Generate inside the create transaction**

Replace the `POST` handler body in `src/app/api/studio-class-templates/route.ts`:

```ts
  // Atomic, matching `api/class-templates/route.ts` (#56): a generation failure
  // rolls the template create back and propagates a 500, rather than leaving a
  // template flagged live that produces no classes. Before this the studio POST
  // was a plain `create`, so a new template sat `isActive: true` with an empty
  // window until the hourly sweep — and the only control on screen ("Resume
  // studio class") answers `200 unchanged` and generates nothing (#120).
  //
  // No claim is taken, and that is reasoning rather than omission: this row's
  // uuid is brand-new inside this transaction, so nothing else can reference it
  // yet and nothing can race the insert. The generator's P2002 hedge is
  // therefore dead for this caller, not load-bearing — the same argument
  // `claimStudioTemplateForGeneration` already makes for the class family's
  // POST, and the reason it does not generalise to a caller that reuses this
  // shape against an *existing* row.
  const template = await prisma.$transaction(async (tx) => {
    const created = await tx.studioClassTemplate.create({
      data: {
        teacherId: session.teacherId,
        ...parsed.data,
      },
      include: { teacher: { select: { defaultTimezone: true } } },
    });
    await generateStudioInstancesForTemplate(tx, created);
    return created;
  });

  const { teacher, ...created } = template;
  void teacher;
  return respondOk(created, 201);
```

Add the import:

```ts
import { generateStudioInstancesForTemplate } from '@/services/studio-class-generator';
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: PASS, whole file. The pre-existing `'creates the template against the calling teacher…'` test must still pass — the response shape is unchanged.

- [ ] **Step 5: Correct both docblocks this caller falsifies**

Neither is optional. A third production caller that deliberately skips the claim contradicts one specific sentence in each place, and one of them *names this exact caller as a hypothetical*.

In `src/services/studio-class-generator.ts`, in `claimStudioTemplateForGeneration`'s docblock (`:70-76`), replace the final clause — *"a future caller that skips the claim and goes straight to `generateStudioInstancesForTemplate` would reopen it"* — with:

```
 * sweep and `pauseOrResumeStudioTemplate`'s resume (`studio-class-template-
 * lifecycle.ts`, #94) both do. `api/studio-class-templates/route.ts`'s POST
 * (#120) does not, and does not reopen the branch either: it generates from a
 * row it created inside its own transaction, whose uuid nothing else can
 * reference yet, so there is no concurrent insert to collide with — the same
 * exemption the class family's POST has above. A caller that skips the claim
 * against an *existing* row would reopen it.
```

Then in `generateStudioInstancesForTemplate`'s docblock (`:150-158`), the roster sentence — *"In production, `generateStudioClassInstances`'s sweep and `pauseOrResumeStudioTemplate`'s resume both claim before calling this function"* — becomes:

```
    // production there are three callers: `generateStudioClassInstances`'s
    // sweep and `pauseOrResumeStudioTemplate`'s resume both claim before
    // calling this function, and `api/studio-class-templates/route.ts`'s POST
    // does not — its row is new inside its own transaction, so its hedge is
    // dead rather than broken (#120).
```

Leave the *"one transactional caller out of six"* figure alone: it counts this file's own test callers, which this task does not change. Both were re-measured — six calls in `studio-class-generator.test.ts`, one of them inside a `prisma.$transaction` at `:599`.

- [ ] **Step 6: Prove the generation can fail**

1. Delete the `await generateStudioInstancesForTemplate(tx, created);` line from the POST.
2. Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
3. Expected: FAIL — `'fills the window…'` gets `expected 0 to be 4`. Record it.
4. Restore. Re-run. Expected: PASS.

- [ ] **Step 7: Prove the atomicity claim can fail**

The comment says a generation failure rolls the create back. Show the rollback is real, not asserted.

1. Move the `create` *outside* the `$transaction` (leaving generation inside it), so a generation failure can no longer undo the create.
2. Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
3. Expected: the route's own tests still pass — which is the finding. **Report that the route-level tests cannot see this mutation**, and that the rollback claim is pinned only by the direct-generator test in Step 1. If you can construct a route-level failure injection that does catch it, say how; if not, say so plainly rather than implying the coverage exists.
4. Restore. Re-run. Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/studio-class-templates/route.ts src/services/studio-class-generator.ts tests/integration/studio-api.test.ts
git commit -m "fix: a new studio template no longer waits an hour for its window"
```

---

## Whole-branch verification

Task reviewers see only their own diff, so a class of defect is invisible to them — an assertion count right per task and wrong for the branch, a policy chosen at one call site and silently applied to a second.

- [ ] Run `npm run verify` (typecheck, lint, and the whole suite including every file in `tests/integration/`). Needs the app live on :3000. Green `verify` is a strong signal, not a substitute for CI — CI also runs `prisma validate`, a migration-drift check, `npm run build`, and Playwright.
- [ ] `grep -rn "for the next 4 weeks" src/` — must return **exactly one** line: the docblock in `template-action-messages.ts` that explains the phrase's deliberate absence (spec §2). A second hit, especially inside a template literal, is the regression. (This item originally said "must return nothing", which contradicted Task 1 Step 3's own mandated docblock — that docblock quotes the phrase in order to forbid it. Corrected after execution surfaced it.)
- [ ] Confirm `TemplateToggleResponse`, `resolveTemplateConfirmation`, `toggle-template-button.tsx`, `archive-template-button.tsx`, `class-template-lifecycle.ts`, `template-sync.ts` and `api/class-templates/route.ts` are **untouched** by `git diff main --stat`. The class family is out of scope.
- [ ] Confirm every mutation from Steps 2/6/7 and 4/7 was restored: `git diff` clean against the last commit.
- [ ] Collect the recorded error texts from all five mutation steps into the PR body. A mutation whose output was not written down did not happen.

## Self-review notes

**Spec coverage.** §1 → Task 2. §2 → Task 1. §3 → Task 4 Steps 3, 5, 7. §4 → Task 3. §5 → Task 5 Steps 3. §6 → Task 5 Step 5. Testing items 1–2 → Task 2 Step 1 (the extended `'fills the window'` test covers item 2's intact-window case, which already existed and now asserts the numbers). Item 3 → Task 2's sharp test. Item 4 → Task 2's boundary test. Items 6–8 → Tasks 3 and 5. All five mutations → Task 2 Steps 6–7, Task 4 Step 7, Task 5 Steps 6–7.

**One deliberate deviation from the spec's test list.** Spec testing item 5 ("the `scheduled >= added` invariant") is implemented as an inline assertion in the two new service tests rather than as a standalone test. A standalone test asserting the invariant on one hand-picked case proves less than asserting it wherever both numbers are already known and independently pinned. Flagged here so a reviewer checking spec coverage does not go looking for a missing test.

**Known coverage gap, stated rather than hidden.** Task 5 Step 7 predicts that the route-level tests cannot detect the create being moved outside the transaction. If that prediction holds, the atomicity claim in the POST's comment is pinned only by the direct-generator test, and the PR body must say so.

## Corrections after execution

Four defects in this plan surfaced while it was being followed. Recorded here rather than silently patched, because a plan that reads as though it were right first time teaches nothing.

1. **The `for the next 4 weeks` checklist item contradicted Task 1 Step 3.** Fixed above. The grep returns exactly one hit — the docblock that forbids the phrase quotes it in order to do so.
2. **Task 4's file list omitted `src/components/settings/template-action-messages.test.ts`.** Narrowing `resolveStudioConfirmation` to `StudioTemplateToggleResponse` breaks that file's `it.each(['active', 'unarchived', 'unchanged'])`, which asserted `active` returns `null` — the very thing this branch makes false. The correct fix, applied: move `active` to its own positive test asserting the resume message, and narrow the `it.each` to `['unarchived', 'unchanged']`. Net test count unchanged.
3. **Task 1 Step 2's predicted failure was wrong.** It said the whole test file would fail to load. Adding a *new export to an existing module* leaves the import resolving to `undefined`, so the actual result is six per-test `TypeError: resumeStudioMessage is not a function` with the file's other 25 tests still passing.
4. **Task 5 Step 1's predicted failure was wrong.** It said both new tests would fail. Only the window test does. The rollback test drives `generateStudioInstancesForTemplate` directly through an injected `tx` — which is what lets it inject the failure at all — so it never touches the route and passed before the route changed.

**And one correction to what Task 2 Step 6's mutation proves.** The plan implies the `cancelledAt: null` mutation is caught by the sharp test's `scheduled` assertion going 4 → 2. Measured, it is not: `scheduledWhere` also feeds the archive's `deleteMany`, so the test dies earlier at `expect(archived.deleted).toBe(2)` — *also* 4 → 2, which is how the wrong reading survives. The resume count's own filter is isolated by the boundary test alone (`expected 6 to be 5`). Both facts are now recorded beside the assertion in the test file.
