# Template Archive Withdraws Its Unbooked Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make archiving a class or studio template delete the future classes it generated that nobody booked, leave booked ones standing, and tell the teacher exactly what happened — so archiving stops leaving up to four weeks of publicly bookable classes behind (issue #86).

**Architecture:** The deletion rule and the counts live in services (`class-template-lifecycle.ts`, a new `studio-class-template-lifecycle.ts`); both PATCH handlers become thin wrappers returning those counts; the four settings buttons render a confirmation in place instead of navigating away. Archive's update and delete share one transaction.

**Tech Stack:** Next.js App Router, Prisma, TypeScript strict, Vitest (unit + integration), Playwright.

## Global Constraints

- **No `any`, no casts, no eslint suppressions.** TypeScript `strict: true`.
- **A future class is deletable only when it has no registration in a charged status.** `CHARGED_STATUSES = ['registered', 'attended', 'no_show', 'late_cancel']`. A `cancelled` registration does not count. Never use `settingsLocked` or `ACTIVE_REGISTRATION_STATUSES` for this — the first answers a different question, the second excludes `late_cancel` and would cascade away a billable record.
- **Deletion scope:** `date > now` (today excluded, matching `syncTemplateInstances`), status `draft`/`open` for classes; `cancelledAt: null` for studio classes, which have no `status` field.
- **Archive's template update and its deletion happen in one transaction.** A half-applied archive leaves a shelved template with a bookable window — the exact state this change exists to prevent.
- **Pause deletes nothing.** It stops generation and reports the furthest-out class.
- **Un-archiving deletes nothing** and keeps its current behaviour of leaving the template paused rather than live.
- **Copy lives in the components, not the API.** The API returns numbers and dates; the buttons render sentences.
- Existing guards must survive: ownership 403, 404, and the `409 Unarchive the template before activating it` added in #92.
- Verification commands: `npm run typecheck`, `npm run lint`, `npx vitest run --project unit`, `npx vitest run --project integration`, `npx playwright test`.
- `:3000` is a shared running `next dev` that hot-reloads. **Never rebuild or restart it.**
- Integration runs may show ~6 `signup-api` failures with `429` from a local rate limiter. Known, unrelated. **If it happens, say so — never report the run as clean.**

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/format.ts` | **Modify.** Gains `formatDayHeader`, extracted from two component copies so this change doesn't add a third. |
| `src/components/schedule/class-list.tsx` | **Modify.** Drops its local copy, imports the shared one. |
| `src/app/(student)/bookings/page.tsx` | **Modify.** Same. |
| `src/services/class-lifecycle.ts` | **Modify.** Export `CHARGED_STATUSES` (currently module-private) so the deletion rule uses the same list billing does. |
| `src/services/class-template-lifecycle.ts` | **Modify.** Gains `pauseOrResumeTemplate` and `archiveOrUnarchiveTemplate` with the deletion rule. |
| `src/services/class-template-lifecycle.test.ts` | **Modify.** Unit tests for the rule — the heart of this change. |
| `src/app/api/class-templates/[id]/route.ts` | **Modify.** `PATCH` becomes a thin wrapper. |
| `src/services/studio-class-template-lifecycle.ts` | **Create.** The studio parallel. Deliberately not shared — see Task 5. |
| `src/services/studio-class-template-lifecycle.test.ts` | **Create.** Its unit tests. |
| `src/app/api/studio-class-templates/[id]/route.ts` | **Modify.** Same thin-wrapper treatment. |
| `src/components/settings/{toggle,archive}-template-button.tsx` | **Modify.** Confirm in place; `router.refresh()`. |
| `src/components/settings/{toggle,archive}-studio-template-button.tsx` | **Modify.** Same. |
| `tests/integration/class-templates-api.test.ts` | **Modify.** Route-level counts, and the #86 regression test. |
| `tests/integration/studio-api.test.ts` | **Modify.** Studio route-level counts. |

---

### Task 1: Extract `formatDayHeader` so this change doesn't add a third copy

**Files:**
- Modify: `src/lib/format.ts`
- Modify: `src/components/schedule/class-list.tsx:25-33`
- Modify: `src/app/(student)/bookings/page.tsx:16-21`

**Interfaces:**
- Produces: `formatDayHeader(date: Date): string` exported from `@/lib/format`, returning e.g. `Thursday, Jun 12`. Task 4 uses it for the pause message.

The function exists twice already, identically apart from whitespace. This change needs a third caller, and `src/lib/format.ts` already exists for exactly this kind of helper.

- [ ] **Step 1: Baseline**

Run: `npm run typecheck && npm run lint && npx vitest run --project unit`
Expected: exit 0, unit **293** passing.

- [ ] **Step 2: Add the shared helper**

Append to `src/lib/format.ts`:

```ts
/**
 * A class's day, as the schedule and bookings views render it: `Thursday, Jun 12`.
 *
 * UTC accessors throughout: `Class.date` is a `@db.Date` (midnight UTC) and the
 * time of day lives separately in `startTime`, so reading it in local time would
 * shift the date across the boundary for anyone west of UTC.
 */
export function formatDayHeader(date: Date): string {
  const d = new Date(date);
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ];
  return `${days[d.getUTCDay()]}, ${months[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
```

- [ ] **Step 3: Point both existing callers at it**

In `src/components/schedule/class-list.tsx`, delete the local `function formatDayHeader(...)` block and add `formatDayHeader` to its imports from `@/lib/format` (add the import if the file has none).

In `src/app/(student)/bookings/page.tsx`, do the same.

Leave every call site unchanged — the output is identical, so no rendering changes.

- [ ] **Step 4: Verify nothing moved**

Run: `npm run typecheck && npm run lint && npx vitest run --project unit`
Expected: exit 0, unit **293** — unchanged.

Run: `npx playwright test tests/e2e/visual.spec.ts --reporter=line`
Expected: PASS. Visual snapshots are the check that the rendered strings are byte-identical; if any snapshot differs, the extraction changed output and is wrong.

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/components/schedule/class-list.tsx "src/app/(student)/bookings/page.tsx"
git commit -m "refactor: share formatDayHeader instead of copying it a third time (#86)"
```

---

### Task 2: The deletion rule, as a service

**Files:**
- Modify: `src/services/class-lifecycle.ts` (export `CHARGED_STATUSES`)
- Modify: `src/services/class-template-lifecycle.ts` (append)
- Modify: `src/services/class-template-lifecycle.test.ts` (append)

**Interfaces:**
- Consumes: `CHARGED_STATUSES` from `./class-lifecycle`, newly exported.
- Produces, for Task 3:
  ```ts
  export type PauseTemplateResult =
    | { ok: true; template: ClassTemplate; lastScheduled: { date: Date; startTime: string } | null }
    | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

  export type ArchiveTemplateResult =
    | { ok: true; template: ClassTemplate; deleted: number; remaining: number }
    | { ok: false; reason: 'not_found' | 'forbidden' };

  export async function pauseOrResumeTemplate(
    db: PrismaClient, templateId: string, teacherId: string,
  ): Promise<PauseTemplateResult>;

  export async function archiveOrUnarchiveTemplate(
    db: PrismaClient, templateId: string, teacherId: string,
  ): Promise<ArchiveTemplateResult>;
  ```

This is the task that matters. The deletion rule is the thing most likely to be got wrong, and getting it wrong destroys data.

- [ ] **Step 1: Export `CHARGED_STATUSES`**

In `src/services/class-lifecycle.ts`, change:

```ts
const CHARGED_STATUSES: RegistrationStatus[] = ['registered', 'attended', 'no_show', 'late_cancel'];
```

to:

```ts
/**
 * Registration statuses that represent a real obligation: the student is
 * charged for these when the class completes. Exported because the archive
 * rule in `class-template-lifecycle.ts` decides what is safe to delete by the
 * same list — a class carrying any of these is one a student is still on the
 * hook for, and must not be removed silently.
 */
export const CHARGED_STATUSES: RegistrationStatus[] = ['registered', 'attended', 'no_show', 'late_cancel'];
```

- [ ] **Step 2: Write the failing unit tests**

Append to `src/services/class-template-lifecycle.test.ts` inside a **new** `describe`.

**Scope trap, verified:** the existing `seedTeacher(label)` and `makeTemplate(classType)` live *inside* `describe('updateClassTemplate (DB)')`, and `makeTemplate` closes over that block's `teacherId`/`teacherRoomId`. A sibling describe cannot see either. So first **hoist `seedTeacher` to module scope** — it is already a pure function of its label — leaving the `let` fixture variables where they are. Then give the new describe its own `let`s, its own `beforeAll` calling `seedTeacher('archive')`, its own `makeTemplate`, and its own `afterAll`. Model the teardown on the existing block's.

```ts
describe('archiveOrUnarchiveTemplate (DB)', () => {
  // Every case below is one row of the deletion rule. They are separate tests
  // rather than one sweep because when this breaks, which row broke is the
  // whole diagnosis.
  const DAY = 24 * 60 * 60 * 1000;
  const future = () => new Date(Date.now() + 5 * DAY);
  const past = () => new Date(Date.now() - 5 * DAY);
  const today = () => new Date();

  // Closes over the block's own teacherId/teacherRoomId, like the sibling
  // block's makeTemplate does.
  const makeClass = async (
    templateId: string,
    opts: { date: Date; status?: 'draft' | 'open' | 'cancelled' },
  ) =>
    prisma.class.create({
      data: {
        teacherId,
        teacherRoomId,
        templateId,
        classType: 'Archive Rule',
        date: opts.date,
        startTime: '09:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
        status: opts.status ?? 'open',
      },
    });

  const register = (classId: string, studentId: string, status: RegistrationStatus) =>
    prisma.registration.create({ data: { classId, studentId, tierAtBooking: 3, status } });

  it('deletes a future class nobody booked', async () => { /* Step 3 fills these */ });
  it('deletes a future class whose only registration is cancelled', async () => {});
  it('keeps a future class with a late_cancel registration — it is still charged', async () => {});
  it('keeps a future class with a registered student', async () => {});
  it("keeps today's class — the date > now boundary", async () => {});
  it('keeps past classes', async () => {});
  it('reports deleted and remaining counts', async () => {});
  it('leaves the window untouched when un-archiving', async () => {});
});
```

**Do not leave those bodies empty.** Step 3 is where each is written; they are listed here so the shape of the matrix is visible before any of it exists.

- [ ] **Step 3: Fill in each case**

Each test creates its own template (so cases cannot interfere), the classes described by its name, calls `archiveOrUnarchiveTemplate(prisma, templateId, teacherId)`, then asserts which class ids still exist. Concretely, for the first two and the money case:

```ts
  it('deletes a future class nobody booked', async () => {
    const t = await makeTemplate('Del Unbooked');
    const c = await makeClass(t.id, { date: future() });

    const result = await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    expect(result.ok).toBe(true);
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  it('deletes a future class whose only registration is cancelled', async () => {
    const t = await makeTemplate('Del Cancelled');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'cancelled');

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    // Nobody is affected and nothing is owed, so this is not "booked".
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(0);
  });

  it('keeps a future class with a late_cancel registration — it is still charged', async () => {
    const t = await makeTemplate('Keep LateCancel');
    const c = await makeClass(t.id, { date: future() });
    await register(c.id, studentId, 'late_cancel');

    await archiveOrUnarchiveTemplate(prisma, t.id, teacherId);

    // ACTIVE_REGISTRATION_STATUSES excludes late_cancel; CHARGED_STATUSES does
    // not. Deleting this would cascade away a registration the student owes
    // for. If this test ever fails, check which constant the rule is using.
    expect(await prisma.class.count({ where: { id: c.id } })).toBe(1);
  });
```

Write the remaining five in the same shape. The counts test asserts both numbers off one template carrying a mix — e.g. two unbooked future, one booked future, one past → `deleted: 2, remaining: 1`. The un-archive test archives, notes the surviving ids, then calls the function again and asserts nothing further was removed.

A `studentId` fixture is needed; add one to the block's `beforeAll` alongside the existing teacher/room fixtures, and delete it in `afterAll` before the teacher.

- [ ] **Step 4: Run — expect failure**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`
Expected: FAIL — `archiveOrUnarchiveTemplate` is not exported.

- [ ] **Step 5: Implement both functions**

Append to `src/services/class-template-lifecycle.ts` (widen the existing `@prisma/client` type import rather than adding a second one):

```ts
/** The furthest-out class still on the schedule, for the pause confirmation. */
export type PauseTemplateResult =
  | { ok: true; template: ClassTemplate; lastScheduled: { date: Date; startTime: string } | null }
  | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

export type ArchiveTemplateResult =
  | { ok: true; template: ClassTemplate; deleted: number; remaining: number }
  | { ok: false; reason: 'not_found' | 'forbidden' };

/** Future classes still on the schedule for a template — the actionable ones. */
const scheduledWhere = (templateId: string, now: Date) => ({
  templateId,
  date: { gt: now },
  status: { in: ['draft', 'open'] as const },
});

/**
 * Pause or resume generation. Deletes nothing: pausing means "no new classes",
 * not "withdraw what I already offered" — that is what archiving is for.
 */
export async function pauseOrResumeTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
): Promise<PauseTemplateResult> {
  const template = await db.classTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };
  if (template.isArchived) return { ok: false, reason: 'archived' };

  const updated = await db.classTemplate.update({
    where: { id: templateId },
    data: { isActive: !template.isActive },
  });
  if (updated.isActive) await generateInstancesForTemplate(db, { ...updated, teacher: { defaultTimezone: '' } } as never);

  const lastScheduled = await db.class.findFirst({
    where: scheduledWhere(templateId, new Date()),
    orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
    select: { date: true, startTime: true },
  });

  return { ok: true, template: updated, lastScheduled };
}
```

**Stop before copying that `generateInstancesForTemplate` line.** The existing route regenerates on re-activation inside a transaction, with a properly-typed template include. Read `src/app/api/class-templates/[id]/route.ts`'s current `PATCH` and move its real logic — including the transaction and the typed `include` — rather than the sketch above. If you cannot preserve the regeneration exactly, stop and report; silently dropping it would break resume.

Then the archive half:

```ts
/**
 * Archive or un-archive. Archiving withdraws the future classes nobody booked
 * and leaves the rest standing (#86): generated instances are created `open`
 * and the public booking page filters on status and date without consulting
 * the template, so without this an archived template keeps up to four weeks of
 * classes publicly bookable.
 *
 * "Nobody booked" means no registration in a CHARGED status — deliberately not
 * `settingsLocked` (which answers whether the price may change, and stays true
 * forever) and not `ACTIVE_REGISTRATION_STATUSES` (which excludes `late_cancel`,
 * so a class a student still owes for would be cascaded away).
 *
 * The update and the delete share a transaction: a half-applied archive is
 * exactly the shelved-but-bookable state this exists to prevent.
 */
export async function archiveOrUnarchiveTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
): Promise<ArchiveTemplateResult> {
  const template = await db.classTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = !template.isArchived;

  return db.$transaction(async (tx) => {
    const updated = await tx.classTemplate.update({
      where: { id: templateId },
      data: { isArchived: archiving, isActive: false },
    });

    if (!archiving) return { ok: true as const, template: updated, deleted: 0, remaining: 0 };

    const now = new Date();
    const deletable = await tx.class.findMany({
      where: {
        ...scheduledWhere(templateId, now),
        registrations: { none: { status: { in: CHARGED_STATUSES } } },
      },
      select: { id: true },
    });

    if (deletable.length > 0) {
      await tx.class.deleteMany({ where: { id: { in: deletable.map((c) => c.id) } } });
    }

    const remaining = await tx.class.count({ where: scheduledWhere(templateId, now) });

    return { ok: true as const, template: updated, deleted: deletable.length, remaining };
  });
}
```

- [ ] **Step 6: Run — expect pass**

Run: `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`
Expected: PASS, all eight new cases.

- [ ] **Step 7: Prove the rule bites**

Stage first (`git add` — `git checkout --` restores from the index and will otherwise wipe your work). Then, one at a time, reverting between each:

```bash
# The money case: swap the constant for the one that excludes late_cancel.
# MUST fail the late_cancel test.
# The boundary: change `date: { gt: now }` to `gte`. MUST fail today's-class test.
# The status filter: drop `status: { in: ['draft','open'] }`. MUST fail a kept-class case.
```

Apply each by hand, run `npx vitest run --project unit src/services/class-template-lifecycle.test.ts`, and **check the mutation actually landed inside the function you are testing before trusting a green run** — a non-global substitution on a string that appears more than once in the file silently mutates the wrong place and reports a false pass. Record each failure verbatim.

- [ ] **Step 8: Commit**

```bash
git status --short src/   # no mutation residue
git add src/services/class-lifecycle.ts src/services/class-template-lifecycle.ts src/services/class-template-lifecycle.test.ts
git commit -m "feat: archiving a class template withdraws its unbooked window (#86)"
```

---

### Task 3: Route wrapper, integration coverage, and the #86 regression test

**Files:**
- Modify: `src/app/api/class-templates/[id]/route.ts` (the `PATCH` handler only)
- Modify: `tests/integration/class-templates-api.test.ts`

**Interfaces:**
- Consumes: `pauseOrResumeTemplate`, `archiveOrUnarchiveTemplate`, `PauseTemplateResult`, `ArchiveTemplateResult` from Task 2.
- Produces: the `PATCH` response shape Task 4's UI reads — `{ ...template, lastScheduled }` for a pause and `{ ...template, deleted, remaining }` for an archive.

- [ ] **Step 1: Write the failing integration tests**

Add to the existing `PATCH /api/class-templates/[id]` describe block in `tests/integration/class-templates-api.test.ts`.

**Scope trap, verified:** `createTemplate` is defined inside the *`PUT`* describe further down the file and is **not** visible here. The `PATCH` block builds templates with the module-scope `templateBody(...)` helper and a raw `POST`, as its existing case does. Follow that, and add a local helper at the top of the `PATCH` describe rather than repeating the POST four times:

```ts
  const newTemplate = async (classType: string): Promise<string> => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody(classType)),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { data: { id: string } }).data.id;
  };
```


```ts
  it('archiving deletes the unbooked future window and reports the counts', async () => {
    const id = await newTemplate('Archive Counts');
    // The POST generates a 4-week window; every class is unbooked.
    const before = await prisma.class.count({
      where: { templateId: id, date: { gt: new Date() } },
    });
    expect(before).toBeGreaterThan(0);

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}?action=archive`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as { data: { deleted: number; remaining: number } };
    expect(data.deleted).toBe(before);
    expect(data.remaining).toBe(0);
    expect(
      await prisma.class.count({ where: { templateId: id, date: { gt: new Date() } } }),
    ).toBe(0);
  });

  // The bug #86 is actually about: after archiving, the classes must stop being
  // publicly bookable. The public page filters on `status: 'open'` and
  // `date >= today` and never consults the template, so this is the assertion
  // that fails if someone later "optimises" the deletion away.
  it('archived templates leave nothing the public booking page would show', async () => {
    const id = await newTemplate('No Longer Bookable');

    await fetch(`${BASE_URL}/api/class-templates/${id}?action=archive`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });

    const stillBookable = await prisma.class.count({
      where: { templateId: id, status: 'open', date: { gte: new Date() } },
    });
    expect(stillBookable).toBe(0);
  });

  it('pausing deletes nothing and reports the last scheduled class', async () => {
    const id = await newTemplate('Pause Counts');
    const before = await prisma.class.count({ where: { templateId: id } });

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { lastScheduled: { startTime: string } | null };
    };
    expect(data.lastScheduled).not.toBeNull();
    expect(await prisma.class.count({ where: { templateId: id } })).toBe(before);
  });
```

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: the three new cases FAIL — `deleted`/`remaining`/`lastScheduled` are absent from the response.

- [ ] **Step 3: Make PATCH a thin wrapper**

Rewrite the `PATCH` handler to delegate. Preserve every existing response exactly: `404 Class template not found`, `403 Access denied`, and `409 Unarchive the template before activating it`. Close the reason chain with the same exhaustiveness bracket the sibling handlers use:

```ts
  const unhandled: never = result;
  return unhandled;
```

On success return `respondOk({ ...result.template, ...extras })` where `extras` is `{ lastScheduled }` for the toggle path and `{ deleted, remaining }` for the archive path.

- [ ] **Step 4: Run — expect pass**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: PASS, including the three from #92 that guard ownership, the archived-activation 409, and the un-archive behaviour. **If any #92 test now fails, you changed behaviour — fix the handler, not the test.**

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/class-templates/[id]/route.ts" tests/integration/class-templates-api.test.ts
git commit -m "feat: PATCH /api/class-templates/[id] reports what archiving withdrew (#86)"
```

---

### Task 4: The confirmations, in place

**Files:**
- Modify: `src/components/settings/toggle-template-button.tsx`
- Modify: `src/components/settings/archive-template-button.tsx`

**Interfaces:**
- Consumes: `formatDayHeader` from Task 1; the `PATCH` response shape from Task 3.

Both buttons currently `router.push('/settings/recurring')` on success, so the teacher is bounced to the list with no account of what happened. They now confirm in place and `router.refresh()`.

- [ ] **Step 1: Pause confirmation**

In `toggle-template-button.tsx`, add `const [message, setMessage] = useState('')`, and on a successful response read `{ data }` and set:

```ts
// Only the pause direction gets a message — resuming needs no explanation.
if (isActive) {
  const last = data.lastScheduled as { date: string; startTime: string } | null;
  setMessage(
    last
      ? `No new classes will be added to your schedule. The last one still scheduled is ${formatDayHeader(new Date(last.date))} · ${last.startTime}.`
      : 'No new classes will be added to your schedule. Nothing from this template is currently scheduled.',
  );
}
router.refresh();
```

Render it below the button in the same style the error uses, but not as an error:

```tsx
{message && <p className="type-caption mt-2">{message}</p>}
```

- [ ] **Step 2: Archive confirmation**

In `archive-template-button.tsx`, same shape. Only the archiving direction gets a message:

```ts
if (!isArchived) {
  const { deleted, remaining } = data as { deleted: number; remaining: number };
  setMessage(
    deleted === 0 && remaining === 0
      ? 'Nothing from this template was scheduled.'
      : deleted === 0
        ? `No unbooked classes to delete. There are still ${remaining} classes on the schedule — cancel them individually if needed.`
        : remaining === 0
          ? 'Classes on the schedule without bookings are now deleted. Nothing from this template is scheduled any more.'
          : `Classes on the schedule without bookings are now deleted. There are still ${remaining} classes on the schedule — cancel them individually if needed.`,
  );
}
router.refresh();
```

Use `remaining === 1 ? 'class' : 'classes'` rather than a bare plural — a teacher with one class left should not read "1 classes".

- [ ] **Step 3: Verify by hand in the running app**

The dev server on `:3000` already hot-reloads. Create a recurring template in Settings → Recurring, pause it, and confirm the message names a real date. Then archive it and confirm the counts match what the schedule shows. **Do not restart the server.**

Record what you saw in your report — including the exact strings, since the copy is the deliverable here as much as the code.

- [ ] **Step 4: Verify the suites are unmoved**

Run: `npm run typecheck && npm run lint && npx playwright test --reporter=line`
Expected: exit 0; e2e **118** passing. These buttons appear in e2e flows, so a broken render surfaces here.

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/toggle-template-button.tsx src/components/settings/archive-template-button.tsx
git commit -m "feat: tell the teacher what pausing and archiving did (#86)"
```

---

### Task 5: The studio family

**Files:**
- Create: `src/services/studio-class-template-lifecycle.ts`
- Create: `src/services/studio-class-template-lifecycle.test.ts`
- Modify: `src/app/api/studio-class-templates/[id]/route.ts`
- Modify: `src/components/settings/toggle-studio-template-button.tsx`
- Modify: `src/components/settings/archive-studio-template-button.tsx`
- Modify: `tests/integration/studio-api.test.ts`

**Interfaces:**
- Produces: `pauseOrResumeStudioTemplate` and `archiveOrUnarchiveStudioTemplate`, mirroring Task 2's signatures with `StudioClassTemplate` in place of `ClassTemplate`.

**Two differences from the class family that will bite if you copy blindly:**

1. **`StudioClass` has no `status` column.** It uses `cancelledAt`. The deletable predicate is `{ templateId, date: { gt: now }, cancelledAt: null }` — there is no `status: { in: [...] }` clause to carry over.
2. **`StudioClass` has no registrations at all** — the model has a plain `studentCount Int?` and no relation to `Student`. So there is no charged-status filter, every future uncancelled studio class is deletable, and `remaining` is always `0`.

The two families are deliberately **not** sharing an implementation. PR #92 found they had already drifted apart in their guards, and their registration semantics genuinely differ — an abstraction over both would have to be parameterised by exactly the things that make them different. Write the parallel and let the duplication stand.

- [ ] **Step 1: Write the failing unit tests**

Create `src/services/studio-class-template-lifecycle.test.ts` covering: a future uncancelled studio class is deleted; an already-cancelled future one is kept (it is an income record, not an offer); a past one is kept; today's is kept (`date > now`); `remaining` is 0; pause deletes nothing and reports the last scheduled class. Model the fixtures on `src/services/studio-class-generator.test.ts`, which already seeds a teacher and a studio template.

- [ ] **Step 2: Run — expect failure**

Run: `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Write the two functions mirroring Task 2, with the two differences above. Preserve the `409 Unarchive the template before activating it` guard added in #92 — it lives in the route today and moves into `pauseOrResumeStudioTemplate` as the `archived` reason.

- [ ] **Step 4: Route, UI, integration**

Make `PATCH /api/studio-class-templates/[id]` a thin wrapper exactly as Task 3 did, and update the two studio buttons exactly as Task 4 did — with the studio archive copy, which only ever needs its "nothing left" form since `remaining` is always 0:

```
`Deleted ${deleted} scheduled studio ${deleted === 1 ? 'class' : 'classes'}. Nothing from this template is scheduled any more.`
```

and `'Nothing from this template was scheduled.'` when `deleted === 0`.

Add integration cases to `tests/integration/studio-api.test.ts` mirroring Task 3's: archiving reports `deleted` and removes the future window; pausing removes nothing.

- [ ] **Step 5: Verify and commit**

Run: `npm run typecheck && npm run lint && npx vitest run --project unit && npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: exit 0. **The #92 studio tests must still pass unchanged** — ownership, the 409, and the un-archive-leaves-paused case.

```bash
git add src/services/studio-class-template-lifecycle.ts src/services/studio-class-template-lifecycle.test.ts "src/app/api/studio-class-templates/[id]/route.ts" src/components/settings/toggle-studio-template-button.tsx src/components/settings/archive-studio-template-button.tsx tests/integration/studio-api.test.ts
git commit -m "feat: archiving a studio template withdraws its scheduled window (#86)"
```

---

### Task 6: Final gate and PR

- [ ] **Step 1: Full local gate**

```bash
npm run typecheck && npm run lint
npx vitest run --project unit
npx vitest run --project integration
npx playwright test --reporter=line
```

Expected: typecheck/lint exit 0; e2e **118**. Unit and integration both up by the new cases. If `signup-api` shows ~6 `429` failures, that is the known local rate limiter — **report it explicitly rather than calling the run clean.**

- [ ] **Step 2: Confirm no mutation residue**

```bash
git status --short
git diff main...HEAD --stat
```

Expected: a clean tree apart from the pre-existing untracked `docs/backlog-roadmap.md`, and a diff touching only the files in the File Structure table plus the spec.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/template-archive-withdraws-window
```

Open a PR titled `feat: archiving a template withdraws its unbooked window (#86)` with `Closes #86`. The body must cover: that #86's original framing was wrong and why (edits already skip booked classes via `settingsLocked`; the real bug is that archive never touched the window, leaving classes publicly bookable); the pause-vs-archive model; the charged-status rule and both rules rejected, including the `late_cancel` cascade that made `ACTIVE_REGISTRATION_STATUSES` unsafe; the confirmation copy with its empty states; the two studio differences; and the mutation evidence from Task 2 Step 7.

- [ ] **Step 4: Report the PR URL. Do NOT merge.**

---

## Self-Review

**Spec coverage.** The model (pause vs archive) → Tasks 2 and 5. The charged-status deletion rule with its two rejected alternatives → Task 2 Steps 1, 3, 5, plus the mutation in Step 7. The `date > now` boundary → Task 2's boundary test and its mutation. The transaction → Task 2 Step 5. Both confirmation messages and all four empty states → Tasks 4 and 5 Step 4. The studio simplification → Task 5's two named differences. Services-own-the-logic → Tasks 2, 3, 5. The #86 regression test (archived classes no longer match the public booking query) → Task 3 Step 1. The cascade map → exercised implicitly by the deletion tests; the `cancelled`-registration case in Task 2 Step 3 is the one that actually drives a cascade. Out-of-scope items need no task.

**Placeholder scan.** One deliberate near-miss: Task 2 Step 2 lists eight `it(...)` titles with empty bodies, and Step 3 fills them — the step says so explicitly and gives three worked examples plus the shape of the rest. Task 5 Step 1 describes its six cases in prose rather than code, on the grounds that they are the same shapes with two named substitutions; if that proves too thin in execution, the implementer should say so rather than guess. Task 2 Step 5 contains a **deliberately wrong** `generateInstancesForTemplate` line with a stop-and-read instruction attached — the regeneration logic must be moved from the existing route, not reconstructed, and flagging it as a trap is safer than omitting it.

**Type consistency.** `PauseTemplateResult`, `ArchiveTemplateResult`, `pauseOrResumeTemplate`, `archiveOrUnarchiveTemplate`, `CHARGED_STATUSES`, `scheduledWhere`, `formatDayHeader`, `lastScheduled`, `deleted`, `remaining` are spelled identically wherever they appear. The studio names are the same with `Studio` infixed. `ClassTemplate` and `StudioClassTemplate` are the Prisma model types, imported not redeclared. The reason unions (`not_found`/`forbidden`/`archived`) match the route's existing 404/403/409 mapping.
