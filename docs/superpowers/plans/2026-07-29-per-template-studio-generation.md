# Per-Template Studio Generation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resuming a studio template fills its window immediately instead of leaving an empty schedule until the next hourly cron sweep (#94).

**Architecture:** Extract the studio sweep's inline generation loop into `generateStudioInstancesForTemplate(db, template, from?)`, mirroring `generateInstancesForTemplate` in the class family — same client union, same `from`, same return. The sweep delegates to it, so there is one implementation. `pauseOrResumeStudioTemplate` then wraps its flag flip in a transaction, takes the `FOR UPDATE` claim, and generates from the row the claim returns.

**Tech Stack:** Prisma + PostgreSQL, TypeScript strict, Vitest (`unit` and `integration` projects), Next.js App Router.

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence errors, no eslint suppressions.
- **Services stay framework-agnostic.** No HTTP or framework imports in `src/services/`.
- **Do not modify `prisma/schema.prisma` and do not add a migration.** This change is code only.
- **Do not call `generateStudioClassInstances` from the resume path.** That is the platform-wide sweep across every teacher; the whole point of this issue is that it must not be called from a request handler.
- **The `10_000` ms transaction timeout is deliberate**, matching the class family: the sweep's claim can hold this row for its own full 10 s, and Prisma's 5 s default would abort a waiter mid-wait. Do not lower it.
- **Do not weaken `FOR UPDATE`** in the claim. It is what makes a concurrent insert for the template impossible, which is what keeps the `P2002` branch unreachable.
- **`DEFAULT_WEEKS` stays declared once per generator module.** The two families are deliberately parallel-but-separate; do not extract a shared constant.
- **Never restart the dev server on `:3000`.** It is managed manually. `signup-api` 429s are a local rate limiter, not this change.
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.
- **Mutation-verify**, and per the #66 lesson confirm each mutation actually applied inside the function under test before trusting its result.

---

## File Structure

| File | Change |
|---|---|
| `src/services/studio-class-generator.ts` | Add `StudioTemplateWithTimezone` + `generateStudioInstancesForTemplate`; widen the claim's return; sweep delegates |
| `src/services/studio-class-generator.test.ts` | Unit cases for the new function, including the filter and a timezone-discriminating pair |
| `src/services/studio-class-template-lifecycle.ts` | Resume wraps in `$transaction`, claims, generates |
| `src/services/studio-class-template-lifecycle.test.ts` | Resume generates; pause does not; archived refused; rollback |
| `tests/integration/studio-api.test.ts` | `PATCH ?state=active` returns a populated window |

**Two tasks.** Task 1 is the generator — extraction, parity, sweep delegation. Task 2 is the resume path that consumes it. A reviewer could reasonably approve the extraction while rejecting how the lifecycle wires it, or the reverse.

---

### Task 1: Extract the per-template studio generator, with parity

**Files:**
- Modify: `src/services/studio-class-generator.ts`
- Test: `src/services/studio-class-generator.test.ts`

**Interfaces:**
- Consumes: `getNextOccurrences(dayOfWeek: number, from: Date, weeks: number): Date[]` from `./class-generator`; `classStartInstant(classDate: Date, startTime: string, timeZone: string): Date` from `@/lib/timezone`.
- Produces: `generateStudioInstancesForTemplate(db: PrismaClient | Prisma.TransactionClient, template: StudioTemplateWithTimezone, from?: Date): Promise<number>` and the exported type `StudioTemplateWithTimezone`. Task 2 calls both. `claimStudioTemplateForGeneration` keeps its signature but now returns `Promise<StudioTemplateWithTimezone | null>`.

- [ ] **Step 1: Add the payload alias and widen the claim's read**

In `src/services/studio-class-generator.ts`, add the import and the alias near the top (beside `DEFAULT_WEEKS`):

```ts
import { classStartInstant } from '@/lib/timezone';

/**
 * The studio mirror of `class-generator.ts`'s `TemplateWithTimezone`. The
 * teacher's zone is not decoration: `generateStudioInstancesForTemplate`
 * needs it to decide whether today's class has already started, and
 * `StudioClassTemplate` carries no zone of its own.
 */
export type StudioTemplateWithTimezone = Prisma.StudioClassTemplateGetPayload<{
  include: { teacher: { select: { defaultTimezone: true } } };
}>;
```

Then change `claimStudioTemplateForGeneration`'s return type and its final read. The raw `FOR UPDATE` statement above it is unchanged — do not touch it.

```ts
export async function claimStudioTemplateForGeneration(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<StudioTemplateWithTimezone | null> {
```

and its last statement:

```ts
  return tx.studioClassTemplate.findUniqueOrThrow({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
```

The `StudioClassTemplate` type import may now be unused — remove it only if `tsc` says so.

- [ ] **Step 2: Write the failing tests for the new function**

Add to `src/services/studio-class-generator.test.ts`. Put them in a new top-level `describe`, with their own teacher fixtures — the existing block's teacher has no explicit timezone.

```ts
describe('generateStudioInstancesForTemplate (DB)', () => {
  // Two teachers 25 hours apart. A UTC-only fixture cannot tell the
  // "already started" filter from its absence, because at UTC the local
  // start time and the UTC start time are the same instant.
  const EAST = 'Pacific/Kiritimati'; // UTC+14
  const WEST = 'Pacific/Niue'; // UTC-11

  let eastTeacherId: string;
  let westTeacherId: string;
  const templateIds: string[] = [];

  const seedTeacher = async (label: string, defaultTimezone: string) => {
    const email = `studio-pertpl-${label}-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: label,
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: `Per-template studio generation, ${label}`,
        pageSlug: `studio-pertpl-${label}-${uniqueSuffix}`,
        defaultTimezone,
      },
    });
    return teacher.id;
  };

  const makeTemplate = async (teacherId: string, dayOfWeek: number, startTime: string) => {
    const t = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Per Template',
        location: 'Studio Per Template',
        dayOfWeek,
        startTime,
        durationMinutes: 60,
        hourlyRate: 45,
        isActive: true,
      },
    });
    templateIds.push(t.id);
    return t.id;
  };

  /** Loads a template in the shape the generator takes. */
  const withZone = (id: string) =>
    prisma.studioClassTemplate.findUniqueOrThrow({
      where: { id },
      include: { teacher: { select: { defaultTimezone: true } } },
    });

  const datesFor = (templateId: string) =>
    prisma.studioClass.findMany({
      where: { templateId },
      orderBy: { date: 'asc' },
      select: { date: true },
    });

  beforeAll(async () => {
    eastTeacherId = await seedTeacher('east', EAST);
    westTeacherId = await seedTeacher('west', WEST);
  });

  afterAll(async () => {
    await prisma.studioClass.deleteMany({ where: { templateId: { in: templateIds } } });
    await prisma.studioClassTemplate.deleteMany({ where: { id: { in: templateIds } } });
    await prisma.teacher.deleteMany({ where: { id: { in: [eastTeacherId, westTeacherId] } } });
  });

  it('creates the four-week window and is idempotent on a second run', async () => {
    const id = await makeTemplate(eastTeacherId, 3, '09:00');
    const tpl = await withZone(id);

    const first = await generateStudioInstancesForTemplate(prisma, tpl);
    const second = await generateStudioInstancesForTemplate(prisma, tpl);

    expect(first).toBe(4);
    expect(second).toBe(0);
    expect(await prisma.studioClass.count({ where: { templateId: id } })).toBe(4);
  });

  /**
   * The parity case. `from` is an explicit instant so this does not depend on
   * when the suite runs: it is noon in the teacher's own zone on a day that
   * matches the template's `dayOfWeek`, with the template starting at 09:00.
   * Today's occurrence has therefore already started and must be skipped, and
   * the window must slide a week rather than come back one short.
   */
  it('skips an occurrence whose start time has already passed, and still creates four', async () => {
    // 2026-08-05T00:00:00Z is a Wednesday. In Kiritimati (UTC+14) that instant
    // is 14:00 the same Wednesday — after a 09:00 start.
    const from = new Date('2026-08-05T00:00:00.000Z');
    const dayOfWeek = (from.getUTCDay() + 6) % 7; // schema convention: 0 = Monday
    const id = await makeTemplate(eastTeacherId, dayOfWeek, '09:00');
    const tpl = await withZone(id);

    const created = await generateStudioInstancesForTemplate(prisma, tpl, from);

    expect(created).toBe(4);
    const dates = (await datesFor(id)).map((d) => d.date.toISOString().slice(0, 10));
    expect(dates).not.toContain('2026-08-05');
    expect(dates[0]).toBe('2026-08-12');
  });

  /**
   * The same instant and the same template shape, read from two zones 25 hours
   * apart, must disagree about whether today's class is still ahead. If this
   * passes with the filter deleted, the filter is not being exercised.
   */
  it('decides "already started" in the teacher zone, not in UTC', async () => {
    // 20:00Z on a Wednesday. Kiritimati (UTC+14) is already Thursday 10:00, so
    // Wednesday is long gone. Niue (UTC-11) is still Wednesday 09:00 — an hour
    // before a 10:00 start, so Wednesday is still ahead.
    const from = new Date('2026-08-05T20:00:00.000Z');
    const dayOfWeek = (new Date('2026-08-05T00:00:00.000Z').getUTCDay() + 6) % 7;

    const eastId = await makeTemplate(eastTeacherId, dayOfWeek, '10:00');
    const westId = await makeTemplate(westTeacherId, dayOfWeek, '10:00');

    await generateStudioInstancesForTemplate(prisma, await withZone(eastId), from);
    await generateStudioInstancesForTemplate(prisma, await withZone(westId), from);

    const east = (await datesFor(eastId)).map((d) => d.date.toISOString().slice(0, 10));
    const west = (await datesFor(westId)).map((d) => d.date.toISOString().slice(0, 10));

    expect(east).not.toContain('2026-08-05');
    expect(west).toContain('2026-08-05');
  });

  it('accepts a transaction client, so a caller can compose it', async () => {
    const id = await makeTemplate(westTeacherId, 4, '08:00');
    const tpl = await withZone(id);

    const created = await prisma.$transaction(
      async (tx) => generateStudioInstancesForTemplate(tx, tpl),
      { timeout: 10_000 },
    );

    expect(created).toBe(4);
    expect(await prisma.studioClass.count({ where: { templateId: id } })).toBe(4);
  });
});
```

Add `generateStudioInstancesForTemplate` to the file's existing import from `./studio-class-generator`.

- [ ] **Step 3: Run them and watch them fail**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: the four new tests fail — `generateStudioInstancesForTemplate is not a function`. The pre-existing tests in the file still pass at this point.

- [ ] **Step 4: Extract the function**

Add to `src/services/studio-class-generator.ts`, above `generateStudioClassInstances`:

```ts
/**
 * Generates one template's rolling window. The studio mirror of
 * `generateInstancesForTemplate` (`class-generator.ts`) — same client union,
 * same optional `from`, same count of rows created — so the two families can
 * be read against each other.
 *
 * Takes `PrismaClient | Prisma.TransactionClient` so a caller can compose it
 * into a transaction it already owns. That is the whole reason this function
 * exists: before #94 the loop was inlined in the sweep, so
 * `pauseOrResumeStudioTemplate` had nothing to call but the platform-wide
 * sweep, and left a resumed template empty until the next cron run.
 */
export async function generateStudioInstancesForTemplate(
  db: PrismaClient | Prisma.TransactionClient,
  template: StudioTemplateWithTimezone,
  from?: Date,
): Promise<number> {
  const startDate = from ?? new Date();
  let created = 0;

  // The next 4 occurrences whose start is still ahead of startDate. A run
  // after today's start time must not create a class that already happened;
  // the window slides one week further instead. Ported from the class family
  // in #94 — the studio side had no such filter, so the hourly sweep could
  // materialise a class that had already started, and generating on resume
  // would have put that in front of a teacher who was watching.
  const dates = getNextOccurrences(template.dayOfWeek, startDate, DEFAULT_WEEKS + 1)
    .filter(
      (date) =>
        classStartInstant(date, template.startTime, template.teacher.defaultTimezone) > startDate,
    )
    .slice(0, DEFAULT_WEEKS);

  for (const date of dates) {
    const existing = await db.studioClass.findFirst({
      where: { templateId: template.id, date },
    });
    if (existing) continue;

    // Unreachable while a claim holds this template's row lock: no other
    // insert for this templateId can land, so nothing is left to collide with
    // `@@unique([templateId, date])`. Both callers take that claim — the sweep
    // and `pauseOrResumeStudioTemplate` — which is why the branch stays dead.
    // See `claimStudioTemplateForGeneration` for why a caller that skipped the
    // claim would find this hedge broken rather than merely unnecessary.
    try {
      await db.studioClass.create({
        data: {
          teacherId: template.teacherId,
          templateId: template.id,
          classType: template.classType,
          date,
          startTime: template.startTime,
          durationMinutes: template.durationMinutes,
          location: template.location,
          hourlyRate: template.hourlyRate,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        continue; // dead under the claim's lock; see the comment above
      }
      throw err;
    }

    created++;
  }

  return created;
}
```

- [ ] **Step 5: Make the sweep delegate**

Replace the sweep's inline loop body — everything from `let created = 0;` through `return created;` inside the `$transaction` callback — with a single delegating call. The callback becomes exactly:

```ts
        async (tx) => {
          const fresh = await claimStudioTemplateForGeneration(tx, template.id);
          if (!fresh) return 0;

          // `fresh`, not `template`: the loop variable is the pre-filter's
          // snapshot and may be minutes old. #102.
          return generateStudioInstancesForTemplate(tx, fresh, startDate);
        },
```

Leave the `{ timeout: 10_000 }` argument and its comment, the surrounding `try`/`catch`, the `log.error` call, and the `errors` handling exactly as they are.

- [ ] **Step 6: Run the whole file**

Run: `npx vitest run --project unit src/services/studio-class-generator.test.ts`
Expected: all pass, new and pre-existing.

**If a pre-existing sweep test now fails, read it before changing it.** The filter is a real behaviour change to the sweep: a template whose class already started today no longer gets that class. A test that seeded a template for today and expected today's instance is now asserting the old, wrong behaviour and should be updated to the new expectation with a comment saying why. **Do not weaken an assertion to make it pass** — if you cannot explain the new expectation in one sentence, stop and report instead.

- [ ] **Step 7: Mutation-verify the filter**

Delete the `.filter(...)` clause (keeping `DEFAULT_WEEKS + 1` and the `.slice`). Confirm the edit landed in `generateStudioInstancesForTemplate` by reading the file back, then run the file.

Expected: `'skips an occurrence whose start time has already passed, and still creates four'` FAILS **by name**, and `'decides "already started" in the teacher zone, not in UTC'` FAILS. If either passes, its fixture is not exercising the filter and the test is not doing its job.

Then change `DEFAULT_WEEKS + 1` to `DEFAULT_WEEKS` (restoring the filter). Expected: the "still creates four" test fails on the count — proving the `+1`/`slice` pair is load-bearing and not decoration.

Restore both, and confirm with a zero-line `git diff` before continuing.

- [ ] **Step 8: Typecheck, lint, commit**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
git add src/services/studio-class-generator.ts src/services/studio-class-generator.test.ts
git commit -m "feat: extract a per-template studio generator, with class-family parity (#94)"
```

---

### Task 2: Generate on resume

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts`
- Test: `src/services/studio-class-template-lifecycle.test.ts`, `tests/integration/studio-api.test.ts`

**Interfaces:**
- Consumes: `generateStudioInstancesForTemplate(db, template, from?)` and `claimStudioTemplateForGeneration(tx, templateId)` from `./studio-class-generator`. The claim returns `StudioTemplateWithTimezone | null` — the shape the generator takes, so the two compose without a second read.
- Produces: no signature change. `pauseOrResumeStudioTemplate` keeps its parameters and `PauseStudioTemplateResult` keeps its shape, so the PATCH route and its exhaustive narrowing compile untouched.

- [ ] **Step 1: Write the failing service tests**

Add to the `describe('pauseOrResumeStudioTemplate (DB)')` block in `src/services/studio-class-template-lifecycle.test.ts`, using that block's existing fixtures.

```ts
  /**
   * #94. Resuming used to flip `isActive` and stop, leaving the teacher on an
   * empty schedule until the hourly sweep. It could not call
   * `generateStudioClassInstances` — that sweeps every teacher on the
   * instance — so the fix was a per-template generator to call instead.
   */
  it('fills the window when resuming, in the same transaction as the flag flip', async () => {
    const t = await makeTemplate('Resume Generates');
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false },
    });

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.action).toBe('active');
    expect(await prisma.studioClass.count({ where: { templateId: t.id } })).toBe(4);
  });

  it('generates nothing when pausing', async () => {
    const t = await makeTemplate('Pause Generates Nothing');

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'paused');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.action).toBe('paused');
    expect(await prisma.studioClass.count({ where: { templateId: t.id } })).toBe(0);
  });

  /**
   * The archived guard runs before the write, so an archived template must
   * come back refused with nothing generated — not merely un-flipped. This is
   * the case where generating would be worst: archiving just deleted the
   * window on purpose.
   */
  it('refuses to resume an archived template, and generates nothing', async () => {
    const t = await makeTemplate('Archived Resume');
    await prisma.studioClassTemplate.update({
      where: { id: t.id },
      data: { isActive: false, isArchived: true },
    });

    const result = await pauseOrResumeStudioTemplate(prisma, t.id, teacherId, 'active');

    expect(result).toEqual({ ok: false, reason: 'archived' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.isActive).toBe(false);
    expect(await prisma.studioClass.count({ where: { templateId: t.id } })).toBe(0);
  });
```

- [ ] **Step 2: Run them and watch the first fail**

Run: `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts`
Expected: `'fills the window when resuming…'` FAILS with `expected 0 to be 4`. The other two pass already — they pin behaviour that must survive the change, which is what they are for.

- [ ] **Step 3: Wrap the write, claim, and generate**

In `src/services/studio-class-template-lifecycle.ts`, add the import:

```ts
import {
  claimStudioTemplateForGeneration,
  generateStudioInstancesForTemplate,
} from './studio-class-generator';
```

Replace the bare `update` (`const updated = await db.studioClassTemplate.update({ ... })`) with:

```ts
  const updated = await db.$transaction(
    async (tx) => {
      const t = await tx.studioClassTemplate.update({
        where: { id: templateId },
        data: { isActive: desiredActive },
      });

      if (t.isActive) {
        // Take the row lock before generating. The `update` above only flips
        // `isActive`, a non-key column, so Postgres grants it `FOR NO KEY
        // UPDATE` — which does not conflict with the `FOR KEY SHARE` a
        // concurrent `StudioClass` insert takes on this template for FK
        // integrity. Without this claim that race is live, and the
        // generator's P2002 hedge cannot save us: a `catch` inside an
        // interactive transaction leaves Postgres with an aborted
        // transaction that fails the next statement with 25P02 rather than
        // skipping cleanly. `FOR UPDATE` makes the collision impossible
        // instead of trying to recover from it (#94).
        const claimed = await claimStudioTemplateForGeneration(tx, templateId);
        if (!claimed) {
          // Not a race — provably unreachable. The archived case returned
          // above, `isActive` was just set true by the write above, and we
          // hold this row's lock so nothing can archive or delete it in
          // between. A null here means the claim's predicate and this
          // function's guards have drifted apart. Returning 0 instead would
          // hide that behind a silently empty window — the exact failure
          // this issue is about.
          throw new Error(
            `pauseOrResumeStudioTemplate: claim returned null for template ${templateId} ` +
              'while holding its row lock — claim predicate and resume guards disagree',
          );
        }
        await generateStudioInstancesForTemplate(tx, claimed);
      }

      return t;
    },
    // The sweep's claim can hold this row for its own full 10s transaction;
    // Prisma's 5s default would abort us mid-wait.
    { timeout: 10_000 },
  );
```

- [ ] **Step 4: Rewrite the docstring, which is now false**

The docstring above `pauseOrResumeStudioTemplate` currently explains at length why resuming does *not* generate, and ends by naming the empty window as the accepted consequence. Every part of that is now wrong. Replace those two paragraphs with:

```
 * Unlike before #94, resuming generates. It still does not call
 * `generateStudioClassInstances` — that takes no `teacherId` and sweeps every
 * active template platform-wide, across every teacher, which is not
 * something a single PATCH may do. It calls
 * `generateStudioInstancesForTemplate` instead, which is scoped to one
 * template and accepts this transaction's client.
 *
 * The write and the generation share one transaction, so a generation failure
 * rolls the `isActive` flip back rather than leaving a template flagged live
 * with an empty window — the state this issue was filed about.
```

- [ ] **Step 5: Run the service tests**

Run: `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts`
Expected: all pass, including the two from Step 1 that already passed — they are the regression guard on pause and on the archived path.

- [ ] **Step 6: Add the integration test**

In `tests/integration/studio-api.test.ts`, inside the `PATCH /api/studio-class-templates/[id]` block, add:

```ts
  /**
   * #94 end to end: the bug was a teacher resuming and finding an empty
   * schedule, so the assertion is on what the schedule holds afterwards, not
   * on the response body alone.
   */
  it('resuming fills the window rather than waiting for the hourly sweep', async () => {
    const id = (await makeTemplate(ownerId, 'Resume Fills Window')).id;

    await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=paused`);
    // Start from a genuinely empty window, so the count below can only come
    // from the resume itself and not from generation at some earlier step.
    await prisma.studioClass.deleteMany({ where: { templateId: id } });

    const res = await send('PATCH', ownerToken, `/api/studio-class-templates/${id}?state=active`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { action: string } }).data.action).toBe('active');
    expect(await prisma.studioClass.count({ where: { templateId: id } })).toBe(4);
  });
```

`makeTemplate(ownerId, name)` and `send(method, token, url)` are that file's existing helpers, along with `ownerId` and `ownerToken` from its setup — use them, do not add new ones.

**Heads-up before you run the file.** Resuming now generates, so any pre-existing test in this file that sends `?state=active` will materialise four studio classes where it previously created none. That matters most where a resume is followed by an archive: archiving deletes the future unbooked window and reports `deleted`, so a count that was `0` may now be `4`. Read any such failure as the new correct behaviour and update the expectation with a comment — but check first that the number it now reports is the number the window actually holds, rather than assuming.

- [ ] **Step 7: Run integration**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: all pass. The app on `:3000` is already running — do not restart it.

- [ ] **Step 8: Mutation-verify the transaction and the claim**

Three mutations, each confirmed to have landed by reading the file back before trusting the result:

1. Pass `db` instead of `tx` to `generateStudioInstancesForTemplate`. Expected: **the tests still pass.** Generation succeeds either way; what changes is only whether a generation failure would roll the flag flip back. Report that plainly — do not go looking for a way to make it fail.

   The atomicity guarantee is defended by construction and by review, not by a test, and that is a deliberate call rather than an oversight: provoking a mid-transaction generation failure needs fault injection this suite has no mechanism for, which is more machinery than the guarantee is worth. This matches how #97 handled the equivalent case. Say so in your report so the next reader knows the gap was chosen.
2. Delete the `if (!claimed) throw` block and return early instead. Expected: no test fails, because the branch is unreachable. Report this honestly — it is an unreachable-by-construction guard, and the reason it exists is documented in the comment, not defended by a test.
3. Remove the `if (t.isActive)` guard so pausing also generates. Expected: `'generates nothing when pausing'` FAILS by name.

- [ ] **Step 9: Typecheck, lint, full suite, commit**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit && npx vitest run --project integration
git add src/services/studio-class-template-lifecycle.ts src/services/studio-class-template-lifecycle.test.ts tests/integration/studio-api.test.ts
git commit -m "feat: generate a studio template's window when resuming it (#94)"
```

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — all pass (405 before this branch, plus the new cases)
- [ ] `npx vitest run --project components` — 32 passing, untouched by this change
- [ ] `npx vitest run --project integration` — all pass (214 before this branch, plus one). Needs the app on `:3000`; do not restart it. `signup-api` 429s are the local rate limiter, not this change.
- [ ] `npx playwright test` — 118 passing
- [ ] `git status` — only `docs/backlog-roadmap.md` untracked
- [ ] The sweep has no inline generation loop left — `generateStudioClassInstances`'s transaction callback is three statements
- [ ] `pauseOrResumeStudioTemplate`'s docstring no longer claims resuming does not generate
