# Idempotent Toggle Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make six `PATCH` endpoints take the state they should reach rather than negating the state they find, so a retry can never invert the action (#98).

**Architecture:** Each endpoint gains a required `?state=` query parameter validated by a zod schema, and sets the field absolutely. When the row is already in the requested state the endpoint returns 200 with `action: 'unchanged'`, writing nothing and running no side effects. The service result types gain that third success arm, and the routes' existing `const unhandled: never` checks force every call site to answer for it.

**Tech Stack:** TypeScript strict, Next.js App Router route handlers, Prisma, zod, Vitest (`unit` + `integration` projects).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no type assertions to silence errors, no eslint suppressions.
- **The parameter is `state`, not `to`.** `to` is already a date-range bound on `GET /api/classes` (`src/app/api/classes/route.ts:19`).
- **Accepted values are exactly:** `active`, `paused`, `archived`, `unarchived` for the two template routes; `archived`, `unarchived` for `teacher-rooms/[id]` and `students/[id]`.
- **A missing or unrecognised `state` is a 400.** Never fall back to toggling — a fallback leaves the old behaviour reachable for any caller that forgets the parameter.
- **`?action=archive` is removed.** The `state` value identifies the field on its own. Nothing outside this repo consumes it.
- **`unchanged` performs no write and no side effects.** In particular archiving twice must NOT withdraw twice.
- **Existing guards stand:** `?state=active` on an archived template still returns 409 *"Unarchive the template before activating it"*; ownership 403s and not-found 404s are unchanged.
- **Query validation follows the existing convention:** `Object.fromEntries(request.nextUrl.searchParams)` into a zod schema, as `GET /api/rooms` does (`src/app/api/rooms/route.ts:17-21`).
- **Every task ends with a green suite.** Each task therefore updates its own callers — routes, buttons and integration tests together. Do not leave a route requiring `state` while its button still omits it.
- **Mutation-verify each guard**, and per the #66 lesson confirm the mutation actually applied inside the function under test before trusting its result.

---

## File Structure

| File | Change |
|---|---|
| `src/lib/schemas.ts` | Add `templateStateQuerySchema`, `archiveStateQuerySchema` |
| `src/services/class-template-lifecycle.ts` | Both result types gain `action`; both functions take a target |
| `src/services/studio-class-template-lifecycle.ts` | Same, studio family |
| `src/app/api/class-templates/[id]/route.ts` | Parse `state`, dispatch on it, drop `?action=archive` |
| `src/app/api/studio-class-templates/[id]/route.ts` | Same |
| `src/app/api/teacher-rooms/[id]/route.ts` | Parse `state`, set absolutely |
| `src/app/api/students/[id]/route.ts` | Same |
| `src/components/settings/template-action-messages.ts` | Add `resolveTemplateConfirmation`, `resolveStudioConfirmation` |
| The six button components | Send `?state=`, use the resolver |
| Their test files | Cover the above |

---

### Task 1: The `state` parameter and the class-template family

**Files:**
- Modify: `src/lib/schemas.ts`, `src/services/class-template-lifecycle.ts`, `src/app/api/class-templates/[id]/route.ts`, `src/components/settings/template-action-messages.ts`, `src/components/settings/toggle-template-button.tsx`, `src/components/settings/archive-template-button.tsx`
- Test: `src/components/settings/template-action-messages.test.ts`, `tests/integration/class-templates-api.test.ts`

**Interfaces:**
- Produces: `templateStateQuerySchema` and `archiveStateQuerySchema` (Task 2 and Task 3 import these — do not redeclare them). `pauseOrResumeTemplate(db, templateId, teacherId, target: 'active' | 'paused')` and `archiveOrUnarchiveTemplate(db, templateId, teacherId, target: 'archived' | 'unarchived')`. `resolveTemplateConfirmation(data): string | null` (Task 2 adds a studio sibling beside it).

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/integration/class-templates-api.test.ts`. `templateBody`, `cookie` and `sessionToken` already exist in that file:

```ts
  it('rejects a PATCH with no state parameter', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('No State')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(400);

    // The row is untouched — a rejected request must not have toggled anything.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isActive).toBe(true);
  });

  it('rejects an unrecognised state value', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Bad State')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/class-templates/${template.id}?state=sideways`, {
      method: 'PATCH',
      headers: cookie(sessionToken),
    });
    expect(res.status).toBe(400);
  });

  /**
   * The #98 case. Two identical requests must reach the same state, not
   * opposite ones — this is what the old `!current` toggle got wrong when a
   * response was lost and the teacher clicked again.
   */
  it('is idempotent: pausing twice leaves the template paused', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Twice Paused')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const pause = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=paused`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    const first = await pause();
    expect(first.status).toBe(200);
    expect(((await first.json()) as { data: { action: string } }).data.action).toBe('paused');

    const second = await pause();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isActive).toBe(false);
  });

  /**
   * The sharpest half of #98: archiving withdraws unbooked future classes, so a
   * second archive that fell through to un-archive would un-shelve the template.
   * It must be a no-op — and must NOT withdraw a second time.
   */
  it('is idempotent: archiving twice does not withdraw twice', async () => {
    const create = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody('Twice Archived')),
    });
    const { data: template } = (await create.json()) as { data: { id: string } };

    const archive = () =>
      fetch(`${BASE_URL}/api/class-templates/${template.id}?state=archived`, {
        method: 'PATCH',
        headers: cookie(sessionToken),
      });

    const first = await archive();
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { data: { action: string; deleted: number } };
    expect(firstBody.data.action).toBe('archived');

    const survivors = await prisma.class.count({ where: { templateId: template.id } });

    const second = await archive();
    expect(second.status).toBe(200);
    expect(((await second.json()) as { data: { action: string } }).data.action).toBe('unchanged');

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.isArchived).toBe(true);
    expect(await prisma.class.count({ where: { templateId: template.id } })).toBe(survivors);
  });
```

Then update every existing `PATCH` call in that file to carry a `state`. There are nine (`:228`, `:254`, `:279`, `:285`, `:341`, `:366`, `:390`, `:410`, `:624`). Read each one's surrounding assertions to decide the value: a call that previously toggled an active template to paused becomes `?state=paused`; `?action=archive` on an unarchived template becomes `?state=archived`; the un-archive follow-ups become `?state=unarchived`; the call asserting the 409 becomes `?state=active`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: FAIL — the new cases get 200 instead of 400, and the existing ones fail because the route ignores `state` and still toggles.

- [ ] **Step 3: Add the query schemas**

Append to `src/lib/schemas.ts`:

```ts
/**
 * The state a PATCH toggle should reach. Required, and deliberately not
 * defaulted: a request that omits it is a 400, not a toggle. Falling back to
 * toggling would leave the #98 behaviour reachable for any caller that forgets
 * the parameter — which is how one defect came to exist in six places.
 *
 * `state`, not `to`: `to` is already a date-range bound on `GET /api/classes`.
 */
export const templateStateQuerySchema = z.object({
  state: z.enum(['active', 'paused', 'archived', 'unarchived']),
});

/** The archive-only subset, for routes with no active/paused axis. */
export const archiveStateQuerySchema = z.object({
  state: z.enum(['archived', 'unarchived']),
});
```

- [ ] **Step 4: Take a target in the service**

In `src/services/class-template-lifecycle.ts`, replace the two result types:

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
  | { ok: false; reason: 'not_found' | 'forbidden' | 'archived' };

/**
 * Archiving and un-archiving are different operations and report different
 * things; `unchanged` is a third, and reports nothing at all. `deleted`/
 * `remaining` exist only on the archiving arm — un-archiving removes nothing,
 * and a no-op removes nothing twice.
 */
export type ArchiveTemplateResult =
  | { ok: true; action: 'archived'; template: ClassTemplate; deleted: number; remaining: number }
  | { ok: true; action: 'unarchived'; template: ClassTemplate }
  | { ok: true; action: 'unchanged'; template: ClassTemplate }
  | { ok: false; reason: 'not_found' | 'forbidden' };
```

Give `pauseOrResumeTemplate` a fourth parameter and an early return. The guard order matters and is not arbitrary — read the comment before rearranging:

```ts
export async function pauseOrResumeTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'active' | 'paused',
): Promise<PauseTemplateResult> {
  const template = await db.classTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const { teacher: _t, ...bare } = template;
  void _t;

  const desiredActive = target === 'active';

  // Before the archived guard, deliberately. Archiving forces `isActive:
  // false`, so `?state=paused` on an archived template is already true and
  // there is nothing to refuse — only `?state=active` is the transition the
  // guard exists to block.
  if (template.isActive === desiredActive) {
    return { ok: true, action: 'unchanged', template: bare };
  }

  if (template.isArchived) return { ok: false, reason: 'archived' };

  const updated = await db.$transaction(
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
  );

  const { teacher, ...template_ } = updated;
  void teacher;

  if (!desiredActive) {
    const today = startOfLocalDay(new Date(), template.teacher.defaultTimezone);
    const lastScheduled = await db.class.findFirst({
      where: scheduledWhere(templateId, { gte: today }),
      orderBy: [{ date: 'desc' }, { startTime: 'desc' }],
      select: { date: true, startTime: true },
    });
    return { ok: true, action: 'paused', template: template_, lastScheduled };
  }

  return { ok: true, action: 'active', template: template_ };
}
```

And `archiveOrUnarchiveTemplate` — replace only its signature, its guards and the `archiving` derivation; the transaction body, the `deleteMany`, the `startOfLocalDay` boundary and the counts all stay exactly as they are:

```ts
export async function archiveOrUnarchiveTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  target: 'archived' | 'unarchived',
): Promise<ArchiveTemplateResult> {
  const template = await db.classTemplate.findUnique({
    where: { id: templateId },
    include: { teacher: { select: { defaultTimezone: true } } },
  });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  const archiving = target === 'archived';

  // No write, no delete. Archiving twice must not withdraw twice — the
  // withdrawal is a consequence of the transition, not of the request.
  if (template.isArchived === archiving) {
    const { teacher: _t, ...bare } = template;
    void _t;
    return { ok: true, action: 'unchanged', template: bare };
  }

  const timeZone = template.teacher.defaultTimezone;
  // ... transaction body unchanged from here down
```

- [ ] **Step 5: Dispatch on `state` in the route**

Replace the `action`/`?action=archive` dispatch in `src/app/api/class-templates/[id]/route.ts`:

```ts
  const parsed = templateStateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return respondError('A state of active, paused, archived or unarchived is required', 400);
  }
  const { state } = parsed.data;

  if (state === 'archived' || state === 'unarchived') {
    const result = await archiveOrUnarchiveTemplate(prisma, id, session.teacherId, state);

    // Only the archiving direction reports counts. The other two arms deleted
    // nothing, and answering them with zeros would put two numbers on the wire
    // that mean "not applicable" while reading like "archived, nothing matched".
    if (result.ok) {
      return result.action === 'archived'
        ? respondOk({
            ...result.template,
            action: result.action,
            deleted: result.deleted,
            remaining: result.remaining,
          })
        : respondOk({ ...result.template, action: result.action });
    }

    if (result.reason === 'not_found') return respondError('Class template not found', 404);
    if (result.reason === 'forbidden') return respondError('Access denied', 403);

    const unhandled: never = result.reason;
    return unhandled;
  }

  const result = await pauseOrResumeTemplate(prisma, id, session.teacherId, state);

  if (result.ok) {
    return result.action === 'paused'
      ? respondOk({ ...result.template, action: result.action, lastScheduled: result.lastScheduled })
      : respondOk({ ...result.template, action: result.action });
  }

  if (result.reason === 'not_found') return respondError('Class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  // An archived template has no live half to toggle to — activating one would
  // instantly materialize bookable classes for something the teacher shelved.
  if (result.reason === 'archived') {
    return respondError('Unarchive the template before activating it', 409);
  }

  const unhandled: never = result.reason;
  return unhandled;
```

Import `templateStateQuerySchema` from `@/lib/schemas`, and drop the now-unused `const url = new URL(request.url)` if nothing else uses it.

- [ ] **Step 6: Run the integration tests to verify they pass**

Run: `npx vitest run --project integration tests/integration/class-templates-api.test.ts`
Expected: PASS. If the dev server on `:3000` returns 429 on signup-adjacent tests, that is the local rate limiter, not this change — report it rather than working around it.

- [ ] **Step 7: Write the failing resolver test**

Add to `src/components/settings/template-action-messages.test.ts`:

```ts
describe('resolveTemplateConfirmation', () => {
  it('returns the pause message when the template was paused', () => {
    expect(
      resolveTemplateConfirmation({
        action: 'paused',
        lastScheduled: { date: '2026-06-12T00:00:00.000Z', startTime: '09:30' },
      }),
    ).toBe(
      'No new classes will be added to your schedule. The last one still scheduled is Friday, Jun 12 · 09:30.',
    );
  });

  it('returns the archive message when the template was archived', () => {
    expect(resolveTemplateConfirmation({ action: 'archived', deleted: 2, remaining: 1 })).toBe(
      'Classes on the schedule without bookings are now deleted. 1 class still on the schedule — cancel individually if needed.',
    );
  });

  /**
   * Both would describe something that did not happen. `unchanged` in
   * particular is what a stale second tab and a retry-after-lost-response
   * reach, so captioning it with either message is the #98 bug wearing a
   * different hat.
   */
  it.each(['active', 'unarchived', 'unchanged'] as const)('says nothing for %s', (action) => {
    expect(resolveTemplateConfirmation({ action })).toBeNull();
  });
});
```

Add `resolveTemplateConfirmation` to the import from `./template-action-messages`.

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run --project unit src/components/settings/template-action-messages.test.ts`
Expected: FAIL — `resolveTemplateConfirmation` is not exported.

- [ ] **Step 9: Implement the resolver**

Append to `src/components/settings/template-action-messages.ts`:

```ts
/** The `data` payload of a successful PATCH on a class template. */
export type TemplateToggleResponse =
  | { action: 'paused'; lastScheduled: { date: string; startTime: string } | null }
  | { action: 'archived'; deleted: number; remaining: number }
  | { action: 'active' | 'unarchived' | 'unchanged' };

/**
 * Decides whether the button says anything, and what.
 *
 * `null` means "say nothing", which is the correct answer for three of the five
 * actions — and `unchanged` is the one that matters: it is what a stale second
 * tab and a retry-after-lost-response reach, so showing either confirmation
 * there would describe something that did not happen.
 *
 * Pure, and separated from the components for that reason: this is the seam the
 * #93 wrong-shape bug lived in (`archiveStudioMessage` had the wrong signature
 * and the button silently discarded `remaining`), and it was caught by review
 * rather than by a test because nothing here was testable.
 */
export function resolveTemplateConfirmation(data: TemplateToggleResponse): string | null {
  if (data.action === 'paused') {
    const last = data.lastScheduled;
    return pauseMessage(last ? { date: new Date(last.date), startTime: last.startTime } : null);
  }
  if (data.action === 'archived') return archiveMessage(data.deleted, data.remaining);
  return null;
}
```

- [ ] **Step 10: Run it to verify it passes**

Run: `npx vitest run --project unit src/components/settings/template-action-messages.test.ts`
Expected: PASS.

- [ ] **Step 11: Point the two class-template buttons at `state`**

In `src/components/settings/toggle-template-button.tsx`, replace the fetch and the message block:

```tsx
      // Derived beside the label below, from the same prop, so the two cannot
      // disagree about which direction this click means.
      const target = isActive ? 'paused' : 'active';
      const res = await fetch(`/api/class-templates/${templateId}?state=${target}`, {
        method: 'PATCH',
      });
      if (res.ok) {
        const { data } = (await res.json()) as { data: TemplateToggleResponse };
        setMessage(resolveTemplateConfirmation(data) ?? '');
        router.refresh();
      } else {
```

In `src/components/settings/archive-template-button.tsx`, the same shape:

```tsx
      const target = isArchived ? 'unarchived' : 'archived';
      const res = await fetch(`/api/class-templates/${templateId}?state=${target}`, {
        method: 'PATCH',
      });
      if (res.ok) {
        const { data } = (await res.json()) as { data: TemplateToggleResponse };
        setMessage(resolveTemplateConfirmation(data) ?? '');
        router.refresh();
      } else {
```

Both import `resolveTemplateConfirmation` and `type TemplateToggleResponse` from `./template-action-messages`, and both drop their now-unused local response interface and their `if (isArchived)` / `if (isActive)` message branch — the server's `action` decides now, not a prop captured at the last render.

- [ ] **Step 12: Verify the whole suite and the types**

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project unit
npx vitest run --project integration
```

Expected: all clean. Baseline before this plan: 368 unit, 192 integration.

- [ ] **Step 13: Mutation-verify the idempotency guard**

```bash
git add -A   # `git checkout --` restores from the index
```

In `archiveOrUnarchiveTemplate`, delete the `if (template.isArchived === archiving)` early return, then confirm by reading the line that it is gone from that function and not another:

```bash
grep -n "isArchived === archiving" src/services/class-template-lifecycle.ts
npx vitest run --project integration tests/integration/class-templates-api.test.ts
```

Expected: `'is idempotent: archiving twice does not withdraw twice'` FAILS with `expected 'unarchived' to be 'unchanged'`. Restore with `git checkout -- src/services/class-template-lifecycle.ts`.

- [ ] **Step 14: Commit**

```bash
git add src/lib/schemas.ts src/services/class-template-lifecycle.ts \
  "src/app/api/class-templates/[id]/route.ts" \
  src/components/settings/template-action-messages.ts \
  src/components/settings/template-action-messages.test.ts \
  src/components/settings/toggle-template-button.tsx \
  src/components/settings/archive-template-button.tsx \
  tests/integration/class-templates-api.test.ts
git commit -m "fix: class-template toggles take the state they should reach (#98)"
```

---

### Task 2: The studio-template family

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts`, `src/app/api/studio-class-templates/[id]/route.ts`, `src/components/settings/template-action-messages.ts`, `src/components/settings/toggle-studio-template-button.tsx`, `src/components/settings/archive-studio-template-button.tsx`
- Test: `src/components/settings/template-action-messages.test.ts`, `tests/integration/studio-api.test.ts`

**Interfaces:**
- Consumes: `templateStateQuerySchema` from `@/lib/schemas` (Task 1 — import it, do not redeclare). `resolveTemplateConfirmation` and `TemplateToggleResponse` exist in `template-action-messages.ts`; add the studio sibling beside them.
- Produces: `resolveStudioConfirmation(data: TemplateToggleResponse): string | null`.

**Read the finished class family first** (`src/services/class-template-lifecycle.ts`, `src/app/api/class-templates/[id]/route.ts`) — this task mirrors it, and the result should be recognisably its sibling. Two differences are real and must survive: `pauseOrResumeStudioTemplate` does **not** call a generator (`generateStudioClassInstances` takes no `teacherId` and sweeps platform-wide), and it has no `$transaction` at all, which is correct — its `update` is autocommit, so there is no Prisma transaction timeout to bust.

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/integration/studio-api.test.ts`, mirroring Task 1's four cases against `/api/studio-class-templates/${id}`: missing `state` → 400 with the row untouched; unrecognised `state` → 400; pausing twice gives `paused` then `unchanged` with `isActive` false; archiving twice gives `archived` then `unchanged` with the surviving `studioClass` count unmoved. Use that file's existing fixture helpers rather than introducing new ones.

Then update the existing `PATCH` calls in that file to carry a `state`, reading each one's assertions to pick the value.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: FAIL — 200 where 400 is expected, and the existing calls fail because the route still toggles.

- [ ] **Step 3: Take a target in the studio service**

In `src/services/studio-class-template-lifecycle.ts`, give both result types the same three success arms as their class siblings (`PauseStudioTemplateResult` gains `action: 'paused' | 'active' | 'unchanged'` with `lastScheduled` only on `paused`; `ArchiveStudioTemplateResult` gains `action: 'unchanged'`), and give both functions a fourth `target` parameter with the same early returns:

- `pauseOrResumeStudioTemplate(db, templateId, teacherId, target: 'active' | 'paused')` — `if (template.isActive === (target === 'active')) return { ok: true, action: 'unchanged', template }` **before** the `isArchived` guard, for the same reason as the class family: archiving forces `isActive: false`, so `?state=paused` on an archived template has nothing to refuse.
- `archiveOrUnarchiveStudioTemplate(db, templateId, teacherId, target: 'archived' | 'unarchived')` — `if (template.isArchived === (target === 'archived')) return { ok: true, action: 'unchanged', template }` before the transaction, so archiving twice does not withdraw twice.

Strip the joined `teacher` from the template before returning it on the `unchanged` arm, as the existing code does on its other arms.

- [ ] **Step 4: Dispatch on `state` in the studio route**

Mirror Task 1's Step 5 in `src/app/api/studio-class-templates/[id]/route.ts`: parse with `templateStateQuerySchema`, and on failure return
`respondError('A state of active, paused, archived or unarchived is required', 400)` —
the exact string Task 1 uses, so the two routes answer identically. Branch `archived`/`unarchived` to the archive service and `active`/`paused` to the pause service, return `action` on every success arm and the counts only on `archived`, and keep the 409 and the `const unhandled: never` checks.

- [ ] **Step 5: Run the integration tests to verify they pass**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: PASS.

- [ ] **Step 6: Add the studio resolver and its test**

Append to `src/components/settings/template-action-messages.ts`:

```ts
/**
 * The studio sibling of `resolveTemplateConfirmation`. A separate function
 * rather than a parameter, because only the archive wording differs and
 * threading a message function through would put most of the English in the
 * caller — the two families are kept parallel-but-separate throughout.
 */
export function resolveStudioConfirmation(data: TemplateToggleResponse): string | null {
  if (data.action === 'paused') {
    const last = data.lastScheduled;
    return pauseMessage(last ? { date: new Date(last.date), startTime: last.startTime } : null);
  }
  if (data.action === 'archived') return archiveStudioMessage(data.deleted, data.remaining);
  return null;
}
```

Add a `describe('resolveStudioConfirmation')` to `template-action-messages.test.ts` mirroring Task 1's Step 7 — the same three shapes, with the studio archive wording for the `archived` case and `null` for `active`, `unarchived` and `unchanged`.

- [ ] **Step 7: Point the two studio buttons at `state`**

`toggle-studio-template-button.tsx` sends `?state=${isActive ? 'paused' : 'active'}`, `archive-studio-template-button.tsx` sends `?state=${isArchived ? 'unarchived' : 'archived'}`, both to `/api/studio-class-templates/${templateId}`. Both call `resolveStudioConfirmation(data) ?? ''`, both drop their local response interface and their prop-based message branch.

- [ ] **Step 8: Verify and mutation-check**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project integration
```

Then stage, delete the `isArchived === (target === 'archived')` early return from `archiveOrUnarchiveStudioTemplate`, confirm by reading the matching line that it left the studio function and not the class one, and check the studio archive-twice test fails. Restore.

- [ ] **Step 9: Commit**

```bash
git add src/services/studio-class-template-lifecycle.ts \
  "src/app/api/studio-class-templates/[id]/route.ts" \
  src/components/settings/template-action-messages.ts \
  src/components/settings/template-action-messages.test.ts \
  src/components/settings/toggle-studio-template-button.tsx \
  src/components/settings/archive-studio-template-button.tsx \
  tests/integration/studio-api.test.ts
git commit -m "fix: studio-template toggles take the state they should reach (#98)"
```

---

### Task 3: The room and student archive toggles

**Files:**
- Modify: `src/app/api/teacher-rooms/[id]/route.ts`, `src/app/api/students/[id]/route.ts`, `src/components/settings/archive-room-button.tsx`, `src/components/students/archive-student-button.tsx`
- Test: `tests/integration/teacher-rooms-api.test.ts`, `tests/integration/students-api.test.ts`

**Interfaces:**
- Consumes: `archiveStateQuerySchema` from `@/lib/schemas` (Task 1 — import it, do not redeclare). Note this is the **two-value** schema, not the template one.

**These two are the ones #98 missed** — they live outside `settings/` and were not in the #93 diff that the issue was written from. They have no service layer and this task does not add one: both handlers are a guard plus an update, and two-line handlers do not need a service.

- [ ] **Step 1: Write the failing integration tests**

In `tests/integration/teacher-rooms-api.test.ts`, using that file's existing fixtures, add: missing `state` → 400 with `isArchived` unchanged; `?state=nonsense` → 400; `?state=archived` twice → `action: 'archived'` then `action: 'unchanged'`, with `isArchived` true after both. Add the same three to `tests/integration/students-api.test.ts` against `/api/students/${id}`.

Then update the existing `PATCH` calls in both files to carry a `state`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project integration tests/integration/teacher-rooms-api.test.ts`
Expected: FAIL — 200 where 400 is expected.

- [ ] **Step 3: Set the state absolutely in both routes**

In `src/app/api/teacher-rooms/[id]/route.ts`, replace the toggle:

```ts
  const parsed = archiveStateQuerySchema.safeParse(
    Object.fromEntries(request.nextUrl.searchParams),
  );
  if (!parsed.success) {
    return respondError('A state of archived or unarchived is required', 400);
  }
  const archiving = parsed.data.state === 'archived';

  const teacherRoom = await prisma.teacherRoom.findUnique({ where: { id } });
  if (!teacherRoom) return respondError('Teacher-room not found', 404);
  if (teacherRoom.teacherId !== session.teacherId) {
    return respondError('Access denied', 403);
  }

  // Already there: no write. The point of #98 — a retry after a lost response
  // must not undo what the first attempt did.
  if (teacherRoom.isArchived === archiving) {
    return respondOk({ isArchived: teacherRoom.isArchived, action: 'unchanged' });
  }

  const updated = await prisma.teacherRoom.update({
    where: { id },
    data: { isArchived: archiving },
  });

  return respondOk({
    isArchived: updated.isArchived,
    action: archiving ? 'archived' : 'unarchived',
  });
```

Apply the identical shape in `src/app/api/students/[id]/route.ts`, against `link` / `prisma.teacherStudent` and keeping its existing `'Student not in your contacts'` 403.

- [ ] **Step 4: Run the integration tests to verify they pass**

Run: `npx vitest run --project integration`
Expected: PASS across all files.

- [ ] **Step 5: Point both buttons at `state`**

`archive-room-button.tsx` sends `?state=${isArchived ? 'unarchived' : 'archived'}` to `/api/teacher-rooms/${teacherRoomId}`; `archive-student-button.tsx` sends the same to `/api/students/${studentId}`. Neither shows a confirmation message today, so neither needs a resolver — leave their existing success handling alone beyond the URL.

- [ ] **Step 6: Full verification**

```bash
npx tsc --noEmit
npm run lint
npx vitest run --project unit
npx vitest run --project integration
npx playwright test
```

Expected: all green. Confirm no `action=archive` survives anywhere:

```bash
grep -rn "action=archive" src/ tests/
```

Expected: no matches.

- [ ] **Step 7: Commit**

```bash
git add "src/app/api/teacher-rooms/[id]/route.ts" "src/app/api/students/[id]/route.ts" \
  src/components/settings/archive-room-button.tsx \
  src/components/students/archive-student-button.tsx \
  tests/integration/teacher-rooms-api.test.ts tests/integration/students-api.test.ts
git commit -m "fix: room and student archive toggles take the state they should reach (#98)"
```

---

## Verification before opening the PR

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 368 baseline plus this plan's additions
- [ ] `npx vitest run --project integration` — 192 baseline plus this plan's additions
- [ ] `npx playwright test` — 118 passing
- [ ] `grep -rn "action=archive" src/ tests/` — no matches
- [ ] `grep -rn "method: 'PATCH'" src/components/` — every one carries a `?state=`
