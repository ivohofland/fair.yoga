# Studio Class Deletion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a teacher a way to remove a studio class where removal is stable — a manual one, or one whose start has passed — and write down why the two doors that stay shut (a future generated class, and any template) stay shut.

**Architecture:** A framework-agnostic predicate in `src/services/studio-class-deletion.ts` decides deletability from three fields. A thin `DELETE` route calls it after the ownership check; the detail page calls it to decide whether to draw the button. The predicate's parameter type deliberately excludes `cancelledAt` and the template, so the two edits §4.2 of the spec warns about cannot be made without a visible signature change.

**Tech Stack:** Next.js 14 App Router, TypeScript `strict`, Prisma, vitest (three projects: `unit`, `integration`, `components`), Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-21-studio-class-deletion-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types.
- **Services are framework-agnostic** (CLAUDE.md). `src/services/studio-class-deletion.ts` imports no `next/*` and **no `@/lib/log`** — the route logs. Keeping pino out of it is what lets the server page import it safely.
- **The predicate's parameter is `{ templateId: string | null; date: Date; startTime: string }`** — structural, not the Prisma model, so callers may pass a `select`ed subset and unit tests need no database. Widening it is the visible act §4.2 exists to force.
- **Refusal constants**, mirroring `room-deletion.ts:68,106`:
  - `STUDIO_CLASS_REGENERATES_MESSAGE = 'This class has not started yet and comes from a recurring template, so removing it would only create it again. Cancel it instead.'`
  - `STUDIO_CLASS_REGENERATES_CODE = 'STUDIO_CLASS_REGENERATES'`
- **`respondOk({ deleted: true })`** on success, matching `src/app/api/rooms/[id]/route.ts:114`.
- **P2025 → 404**, via `isRecordNotFound` from `@/lib/api-errors` (`:249`). Do not hand-roll the check.
- **`vitest.config.ts` pins `TZ: 'America/New_York'` at the root.** Deliberate, and west of UTC. It does not affect the predicate (which takes an explicit `timeZone`), but every bare `new Date()` in a test runs in that zone.
- **In the `components` project `fetch` is NOT mocked.** Every test that clicks must stub it with `vi.stubGlobal('fetch', fetchMock)`. A test that forgets gets a real relative-URL request, swallowed as "Network error".
- **Currency is inline `€{n.toFixed(2)}`** — there is no formatter in `src/lib/format.ts`.
- **Never `git add -A`.** Stage exact paths, and **quote any path containing `(teacher)`.**
- **Never start or restart the dev server on :3000.** The user runs it; the `integration` project talks to it over HTTP.

---

### Task 1: The deletability predicate

**Files:**
- Create: `src/services/studio-class-deletion.ts`
- Test: `src/services/studio-class-deletion.test.ts` (the `unit` project — `src/**/*.test.ts`)

**Interfaces:**
- Consumes: `classStartInstant` from `@/lib/timezone` (`:159`).
- Produces, relied on by Tasks 2 and 4:
  ```ts
  export type StudioClassDeletability =
    | { deletable: true }
    | { deletable: false; reason: 'regenerates' };

  export function studioClassDeletability(
    sc: { templateId: string | null; date: Date; startTime: string },
    now: Date,
    timeZone: string,
  ): StudioClassDeletability;

  export const STUDIO_CLASS_REGENERATES_MESSAGE: string;
  export const STUDIO_CLASS_REGENERATES_CODE: 'STUDIO_CLASS_REGENERATES';
  ```

- [ ] **Step 1: Write the failing test**

Create `src/services/studio-class-deletion.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { studioClassDeletability } from './studio-class-deletion';

const AMS = 'Europe/Amsterdam';
const NYC = 'America/New_York';

/** A `@db.Date` value — midnight UTC of the calendar date, as Prisma returns one. */
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe('studioClassDeletability', () => {
  // 2026-06-15T12:00Z is 14:00 in Amsterdam and 08:00 in New York.
  const now = new Date('2026-06-15T12:00:00.000Z');

  describe('the matrix', () => {
    it('allows a manual class that has not started', () => {
      expect(
        studioClassDeletability(
          { templateId: null, date: d('2026-06-20'), startTime: '09:00' },
          now,
          AMS,
        ),
      ).toEqual({ deletable: true });
    });

    it('allows a manual class that has started', () => {
      expect(
        studioClassDeletability(
          { templateId: null, date: d('2026-06-10'), startTime: '09:00' },
          now,
          AMS,
        ),
      ).toEqual({ deletable: true });
    });

    it('refuses a generated class that has not started, because the sweep would create it again', () => {
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-20'), startTime: '09:00' },
          now,
          AMS,
        ),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });

    it('allows a generated class that has started, because it is no longer a candidate', () => {
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-10'), startTime: '09:00' },
          now,
          AMS,
        ),
      ).toEqual({ deletable: true });
    });
  });

  /**
   * BOTH DIRECTIONS, DELIBERATELY. A single zone proves nothing: run only the
   * east-of-UTC case and a UTC-naive implementation still fails it, but run
   * only a case where local and UTC agree and every implementation passes.
   * `prisma/seed.ts:622-625` records that exact failure for the class family.
   */
  describe('the zone decides, not UTC', () => {
    it('east of UTC: a 09:00 Amsterdam class has started by 08:00 UTC', () => {
      // Starts 07:00Z. A UTC-naive reading compares 09:00Z > 08:00Z and refuses.
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-15'), startTime: '09:00' },
          new Date('2026-06-15T08:00:00.000Z'),
          AMS,
        ),
      ).toEqual({ deletable: true });
    });

    it('west of UTC: a 09:00 New York class has not started by 12:00 UTC', () => {
      // Starts 13:00Z. A UTC-naive reading compares 09:00Z <= 12:00Z and allows.
      expect(
        studioClassDeletability(
          { templateId: 'tpl-1', date: d('2026-06-15'), startTime: '09:00' },
          new Date('2026-06-15T12:00:00.000Z'),
          NYC,
        ),
      ).toEqual({ deletable: false, reason: 'regenerates' });
    });
  });

  it('treats the start instant itself as started', () => {
    // The boundary is `<=`. Exactly 09:00 Amsterdam on 2026-06-15 is 07:00Z.
    expect(
      studioClassDeletability(
        { templateId: 'tpl-1', date: d('2026-06-15'), startTime: '09:00' },
        new Date('2026-06-15T07:00:00.000Z'),
        AMS,
      ),
    ).toEqual({ deletable: true });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run --project unit src/services/studio-class-deletion.test.ts
```

Expected: FAIL — `Failed to resolve import "./studio-class-deletion"`.

- [ ] **Step 3: Write the implementation**

Create `src/services/studio-class-deletion.ts`:

```ts
import { classStartInstant } from '@/lib/timezone';

/**
 * When a studio class may be removed, and why the answer is not "whenever the
 * teacher asks" (issue 279).
 *
 * The sibling of `room-deletion.ts`, and deliberately shaped like it: that file
 * exists because archiving and deleting ask different questions and must answer
 * them differently. Here the two doors are CANCEL and REMOVE.
 *
 * THE RULE: a studio class may be removed when removal is STABLE — when nothing
 * will create it again.
 *
 *   removable ⟺ templateId === null            (manual: no generator owns it)
 *             ∨ its start instant has passed   (never a generation candidate)
 *
 * The second clause is not a preference. It is read off the generator's own
 * candidate filter, `src/services/studio-class-generator.ts:138-143`, which
 * keeps only occurrences whose `classStartInstant(...)` is still AHEAD of now.
 * A class whose start has passed can never be regenerated, so removing it
 * sticks.
 *
 * Removing a FUTURE GENERATED class would release its `(templateId, date)` key
 * and the hourly sweep would recreate it — within the hour, silently, forever.
 * That is the same failure that made issue 275 withdraw "narrow the unique
 * index to live rows" as a remedy. A delete that quietly reverses itself reads
 * as the app ignoring the teacher, so this door refuses and names the one that
 * works. Cancel is the correct operation there, and it already exists.
 *
 * ── THE PARAMETER TYPE IS THE GUARD. DO NOT WIDEN IT. ──────────────────────
 *
 * `sc` carries three fields and no more, which makes two wrong edits
 * unrepresentable rather than merely discouraged:
 *
 *   1. TEMPLATE STATE (`isActive`, `isArchived`). Tempting, because an archived
 *      template generates nothing, so a future class under one looks safe to
 *      remove. It is not: template state is REVERSIBLE. Un-archive → resume →
 *      generation restarts, and a date released under the archived reading is
 *      refilled. A predicate that reads reversible state is a predicate that
 *      can flip. `room-deletion.ts:14-21` gives this exact warning one model
 *      over — "the single most likely wrong edit here: it compiles, it passes
 *      any test written against a live template".
 *
 *   2. `cancelledAt`. Removability is about whether the sweep brings the class
 *      back, and the sweep counts a cancelled own-row as occupancy either way
 *      (`studio-class-generator.ts:166`, `blocked_by_cancelled`). Making
 *      cancellation a precondition would force the teacher to create the litter
 *      before they could clear it.
 *
 * Adding either read requires widening this signature, which breaks every call
 * site and every test at once. That is the intended cost.
 *
 * ── AFTER WEEK-KEYED GENERATION (issue 284) ────────────────────────────────
 *
 * Issue 284 makes occupancy per `(template, week)` rather than per
 * `(template, date)`, cancelled rows included. A PAST class occupies its week
 * just as a future one does, so removing a past GENERATED class can free that
 * week and let the sweep fill a still-future candidate in the same week — for
 * instance a template moved Tuesday → Thursday mid-week.
 *
 * The rule does not change and this predicate does not narrow. What changes is
 * the sentence above: removal never resurrects the removed class, but under
 * week-keying it may free that class's WEEK, which is the week rule working as
 * specified. A manual class belongs to no template's week and is unaffected in
 * either era. See the spec's §5 for the worked path.
 */
export type StudioClassDeletability =
  | { deletable: true }
  | { deletable: false; reason: 'regenerates' };

/**
 * One refusal, naming the remedy — the shape `ROOM_DELETE_BLOCKED_MESSAGE`
 * uses ("This room is still in use and cannot be deleted. Archive it
 * instead."). Prose, not a developer string: `src/app/(teacher)` renders
 * `error.message` verbatim, which is what issue 197 is about.
 */
export const STUDIO_CLASS_REGENERATES_MESSAGE =
  'This class has not started yet and comes from a recurring template, so removing it would only create it again. Cancel it instead.';

/**
 * Asserted by the integration cases, so a route that stops consulting the
 * predicate reddens them rather than silently answering 200 — the property
 * `ROOM_IN_USE_CODE`'s docblock was added to buy for its own door.
 */
export const STUDIO_CLASS_REGENERATES_CODE = 'STUDIO_CLASS_REGENERATES';

export function studioClassDeletability(
  sc: { templateId: string | null; date: Date; startTime: string },
  now: Date,
  timeZone: string,
): StudioClassDeletability {
  if (sc.templateId === null) return { deletable: true };
  if (classStartInstant(sc.date, sc.startTime, timeZone) <= now) return { deletable: true };
  return { deletable: false, reason: 'regenerates' };
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run --project unit src/services/studio-class-deletion.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Prove each guard bites — four mutations**

For each: apply the edit, run the command, **record the exact failure text**, then restore and re-run to confirm green. Write the results to `docs/superpowers/plans/2026-08-21-studio-class-deletion-mutations.md` as you go — the PR body quotes it.

| # | Mutation | Command | Must fail |
|---|---|---|---|
| M1 | Replace the second clause with `startOfLocalDay(sc.date, timeZone) <= startOfLocalDay(now, timeZone)` (day granularity) | `npx vitest run --project unit src/services/studio-class-deletion.test.ts` | "west of UTC: a 09:00 New York class has not started by 12:00 UTC" |
| M2 | Delete the `sc.templateId === null` line | same | "allows a manual class that has not started" |
| M3 | Delete the `classStartInstant(...) <= now` line | same | both "has started" cases |
| M4 | Widen the parameter to `{ …, template: { isArchived: boolean } }` and return `{ deletable: true }` when archived | `npm run typecheck` | every call site and every test — record the `tsc` output |
| M5 | Change `<=` to `<` | `npx vitest run --project unit src/services/studio-class-deletion.test.ts` | "treats the start instant itself as started" |

M4 is the one that matters most and is the reason the parameter type is narrow: the guard against §4.2's wrong edit is the compiler, not a test, so its proof is a compile failure rather than a red test.

- [ ] **Step 6: Commit**

```bash
git add src/services/studio-class-deletion.ts src/services/studio-class-deletion.test.ts
git commit -m "feat: a studio class is removable where the sweep cannot undo it (issue 279)"
```

---

### Task 2: The `DELETE` route

**Files:**
- Modify: `src/app/api/studio-classes/[id]/route.ts` (append after the `PUT`, which ends at `:79`)
- Test: `tests/integration/studio-api.test.ts` (append; the file is 1080 lines and API-only)

**Interfaces:**
- Consumes: `studioClassDeletability`, `STUDIO_CLASS_REGENERATES_MESSAGE`, `STUDIO_CLASS_REGENERATES_CODE` from Task 1; `isRecordNotFound` from `@/lib/api-errors`; `log` from `@/lib/log`.
- Produces: `DELETE /api/studio-classes/[id]` → `200 {"deleted":true}` | `401` | `403` | `404` | `409 STUDIO_CLASS_REGENERATES`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/integration/studio-api.test.ts`. Reuse the file's existing `send`, `makeTemplate`, `ownerId`/`ownerToken`/`otherToken` and `suffix`. Every fixture below needs its **own `date`/`startTime`**: `StudioClass_teacher_slot_unique` is `(teacherId, date, startTime) WHERE cancelledAt IS NULL`, and `StudioClassTemplate_teacher_slot_unique` is `(teacherId, dayOfWeek, startTime) WHERE isArchived = false`.

```ts
describe('DELETE /api/studio-classes/[id]', () => {
  const makeClass = (data: {
    templateId?: string | null;
    date: Date;
    startTime: string;
    cancelledAt?: Date | null;
  }) =>
    prisma.studioClass.create({
      data: {
        teacherId: ownerId,
        classType: 'Removable',
        durationMinutes: 60,
        location: 'Community Studio',
        hourlyRate: 45,
        ...data,
      },
    });

  const FUTURE = new Date('2099-07-01T00:00:00.000Z');
  const PAST = new Date('2020-07-01T00:00:00.000Z');

  it('refuses without a session', async () => {
    const sc = await makeClass({ date: PAST, startTime: '05:00' });
    const res = await fetch(`${BASE_URL}/api/studio-classes/${sc.id}`, { method: 'DELETE' });
    expect(res.status).toBe(401);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id } })).not.toBeNull();
  });

  it("refuses another teacher's class with 403", async () => {
    const sc = await makeClass({ date: PAST, startTime: '05:15' });
    const res = await send('DELETE', otherToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(403);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id } })).not.toBeNull();
  });

  it('answers 404 for an id that is not there', async () => {
    const res = await send(
      'DELETE',
      ownerToken,
      '/api/studio-classes/00000000-0000-4000-8000-000000000000',
    );
    expect(res.status).toBe(404);
  });

  it('refuses a future generated class, naming cancel and the code', async () => {
    const tpl = await makeTemplate(ownerId, 'Del Future', '05:30');
    const sc = await makeClass({ templateId: tpl.id, date: FUTURE, startTime: '05:30' });

    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { message: string; code?: string } };
    expect(body.error.code).toBe('STUDIO_CLASS_REGENERATES');
    expect(body.error.message).toContain('Cancel it instead.');
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id } })).not.toBeNull();
  });

  /**
   * The behavioural half of the predicate's §4.2 guard. The parameter type
   * already makes reading `isArchived` a compile error; this case is what
   * catches someone who widens the type properly and then adds the read.
   * Template state is reversible — un-archive, resume, and the date is refilled.
   */
  it('still refuses a future generated class when its template is archived', async () => {
    const tpl = await makeTemplate(ownerId, 'Del Archived', '05:45', {
      isArchived: true,
      isActive: false,
    });
    const sc = await makeClass({ templateId: tpl.id, date: FUTURE, startTime: '05:45' });

    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(409);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id } })).not.toBeNull();
  });

  it('removes a future manual class, because nothing regenerates it', async () => {
    const sc = await makeClass({ templateId: null, date: FUTURE, startTime: '06:00' });
    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id } })).toBeNull();
  });

  it('removes a past generated class', async () => {
    const tpl = await makeTemplate(ownerId, 'Del Past', '06:15');
    const sc = await makeClass({ templateId: tpl.id, date: PAST, startTime: '06:15' });
    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id } })).toBeNull();
  });

  /** Cancellation is orthogonal to removability — the predicate cannot read it. */
  it('removes a cancelled past class', async () => {
    const sc = await makeClass({
      date: PAST,
      startTime: '06:30',
      cancelledAt: new Date('2020-07-01T10:00:00.000Z'),
    });
    const res = await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`);
    expect(res.status).toBe(200);
    expect(await prisma.studioClass.findUnique({ where: { id: sc.id } })).toBeNull();
  });

  /** The double-click. P2025 must read as 404, not as a 500. */
  it('answers the second removal with 404 rather than a 500', async () => {
    const sc = await makeClass({ date: PAST, startTime: '06:45' });
    expect((await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`)).status).toBe(200);
    expect((await send('DELETE', ownerToken, `/api/studio-classes/${sc.id}`)).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

The dev server must already be running on :3000 (do not start it).

```bash
npx vitest run --project integration tests/integration/studio-api.test.ts -t 'DELETE /api/studio-classes'
```

Expected: FAIL — every case gets `405 Method Not Allowed`, because the route has no `DELETE` export.

- [ ] **Step 3: Write the implementation**

In `src/app/api/studio-classes/[id]/route.ts`, extend the import block and append the handler:

```ts
import { isRecordNotFound } from '@/lib/api-errors';
import { log } from '@/lib/log';
import {
  studioClassDeletability,
  STUDIO_CLASS_REGENERATES_MESSAGE,
  STUDIO_CLASS_REGENERATES_CODE,
} from '@/services/studio-class-deletion';
```

```ts
/**
 * Remove a studio class outright (issue 279). The policy lives in
 * `studio-class-deletion.ts`; this handler is the thin wrapper CLAUDE.md asks
 * for, and its gate order matches the `GET` and `PUT` above.
 *
 * NO CHECK-TO-DELETE RACE TO BACKSTOP, DELIBERATELY, and this is where the
 * obvious wrong edit is: `room-deletion.ts` is the model for this file and it
 * carries an FK backstop, so copying one here looks like diligence. There is
 * nothing to back stop. Neither disjunct of the predicate can flip
 * `removable → not removable`: `templateId` is written once at creation, and a
 * class whose start has passed cannot un-pass it. The archive door's
 * `deleteMany` is keyed on a concrete `templateId` and filters
 * `cancelledAt: null` with `date: { gt: today }`
 * (`studio-class-template-lifecycle.ts:1262`, `:664`), so it can match neither
 * a manual row nor a past one. The only real race is a second click, and
 * `isRecordNotFound` answers it the way `DELETE /api/waitlist/[id]` answers
 * its own — as never having had the row.
 */
export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const studioClass = await prisma.studioClass.findUnique({
    where: { id },
    select: { teacherId: true, templateId: true, date: true, startTime: true },
  });
  if (!studioClass) return respondError('Studio class not found', 404);
  if (studioClass.teacherId !== session.teacherId) return respondError('Access denied', 403);

  const verdict = studioClassDeletability(studioClass, new Date(), session.defaultTimezone);
  if (!verdict.deletable) {
    log.info(
      { studioClassId: id, teacherId: session.teacherId, templateId: studioClass.templateId },
      'studio class removal refused: the sweep would create it again',
    );
    return respondError(STUDIO_CLASS_REGENERATES_MESSAGE, 409, STUDIO_CLASS_REGENERATES_CODE);
  }

  try {
    await prisma.studioClass.delete({ where: { id } });
  } catch (err) {
    if (isRecordNotFound(err)) return respondError('Studio class not found', 404);
    throw err;
  }

  // The only record this removal leaves, and deliberately the only one — see
  // the spec's §6.4. The app has no audit-log table, `withdrawnCount` exists
  // because an ARCHIVE removes rows the teacher never sees, and a `deletedAt`
  // column would re-create the tombstone removal exists to clear.
  log.info(
    { studioClassId: id, teacherId: session.teacherId, templateId: studioClass.templateId },
    'studio class removed',
  );
  return respondOk({ deleted: true });
});
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --project integration tests/integration/studio-api.test.ts
```

Expected: PASS, the whole file including the pre-existing cases.

- [ ] **Step 5: Prove the route's guards bite — two mutations**

**Warm the route first.** `next dev` recompiles lazily after a source edit, and the first request pays compilation, which can blow a timeout that reads exactly like an assertion failure. Apply the mutation, `curl` the route once, then judge.

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X DELETE http://localhost:3000/api/studio-classes/warm
```

| # | Mutation | Must fail |
|---|---|---|
| M6 | Delete the `studioClass.teacherId !== session.teacherId` line | "refuses another teacher's class with 403" |
| M7 | Delete the `if (!verdict.deletable)` block | "refuses a future generated class, naming cancel and the code" **and** "still refuses … when its template is archived" |

M6 is listed explicitly because ownership is the gate this project's defects live in, and it hides precisely because authentication and validation pass in front of it. Append both results to the mutations file.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/studio-classes/[id]/route.ts" tests/integration/studio-api.test.ts
git commit -m "feat: DELETE /api/studio-classes/[id], refusing what the sweep would rebuild (issue 279)"
```

---

### Task 3: The Remove button

**Files:**
- Create: `src/components/studio-class/delete-studio-class-button.tsx`
- Test: `src/components/studio-class/delete-studio-class-button.test.tsx` (the `components` project)

**Interfaces:**
- Consumes: `Button` from `@/components/ui/button`, `readErrorMessage` from `@/lib/client-errors`.
- Produces, relied on by Task 4:
  ```ts
  interface DeleteStudioClassButtonProps {
    studioClassId: string;
    earningsAtRisk: number | null;
  }
  export function DeleteStudioClassButton(props: DeleteStudioClassButtonProps): JSX.Element;
  ```

- [ ] **Step 1: Write the failing test**

Create `src/components/studio-class/delete-studio-class-button.test.tsx`, mirroring `cancel-studio-class-button.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DeleteStudioClassButton } from './delete-studio-class-button';
import { routerPush } from '../../../tests/setup/components';

describe('DeleteStudioClassButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const openConfirm = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Remove this class' }));
  const confirmRemove = () => fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

  it('names what the removal costs when the class counts toward earnings', () => {
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={45} />);
    openConfirm();
    expect(
      screen.getByText(
        'Remove this class? €45.00 will come off your reported earnings. This cannot be undone.',
      ),
    ).toBeInTheDocument();
  });

  it('claims no cost when the class is outside the reporting window', () => {
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);
    openConfirm();
    expect(
      screen.getByText('Remove this class? This cannot be undone.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/reported earnings/)).not.toBeInTheDocument();
  });

  it('sends the removal and leaves for the schedule on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);

    openConfirm();
    confirmRemove();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/studio-classes/sc-1');
    expect(init.method).toBe('DELETE');
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith('/'));
  });

  it('shows the server message when the removal is refused, and stays put', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({
        error: { message: 'This class has not started yet and comes from a recurring template, so removing it would only create it again. Cancel it instead.' },
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);

    openConfirm();
    confirmRemove();

    expect(await screen.findByText(/Cancel it instead\./)).toBeInTheDocument();
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('says something when the request never reaches the server', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<DeleteStudioClassButton studioClassId="sc-1" earningsAtRisk={null} />);

    openConfirm();
    confirmRemove();

    expect(await screen.findByText('Network error. Please try again.')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run --project components src/components/studio-class/delete-studio-class-button.test.tsx
```

Expected: FAIL — `Failed to resolve import "./delete-studio-class-button"`.

- [ ] **Step 3: Write the implementation**

Create `src/components/studio-class/delete-studio-class-button.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';

interface DeleteStudioClassButtonProps {
  studioClassId: string;
  /**
   * What this removal takes off the teacher's reported earnings, or null when
   * the class is outside reporting's window.
   *
   * COMPUTED BY THE PAGE, from REPORTING'S predicate — `cancelledAt === null`
   * and `date <= endOfToday` (`settings/reporting/page.tsx:36`) — NOT from the
   * removability one. The two overlap heavily and are not the same: a
   * future-dated manual class is removable and counts nothing, and a class
   * dated today whose start has passed is removable and counts. Deriving this
   * from `deletable` would be wrong in both of those directions.
   */
  earningsAtRisk: number | null;
}

/**
 * The second destructive door on the studio class page, beside "Cancel class"
 * (issue 279). The word is REMOVE, not DELETE, so the page carries one
 * destructive verb per action rather than two that read alike; the HTTP verb
 * stays `DELETE`.
 *
 * Naming the cost before the click mirrors the archive door, whose `remaining`
 * count exists for exactly one confirmation message and is deliberately never
 * persisted (`prisma/schema.prisma`, `withdrawnCount`).
 *
 * `router.push('/')` and not `refresh()`, unlike `CancelStudioClassButton`
 * beside it: the page this button lives on no longer exists after a success.
 * Same choice `DeleteRoomButton` makes. The confirm-then-silence failure that
 * button's sibling documents applies here too — the teacher has already
 * answered "yes, remove it", so an unchanged page reads as success.
 */
export function DeleteStudioClassButton({
  studioClassId,
  earningsAtRisk,
}: DeleteStudioClassButtonProps) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState('');

  // Built as one string rather than conditional JSX so it is one text node —
  // a split node is what makes `getByText` on a whole sentence fail.
  const confirmText =
    earningsAtRisk === null
      ? 'Remove this class? This cannot be undone.'
      : `Remove this class? €${earningsAtRisk.toFixed(2)} will come off your reported earnings. This cannot be undone.`;

  async function handleRemove() {
    setRemoving(true);
    setError('');
    try {
      const res = await fetch(`/api/studio-classes/${studioClassId}`, { method: 'DELETE' });
      if (res.ok) {
        router.push('/');
      } else {
        setError(await readErrorMessage(res, 'Could not remove the class. Please try again.'));
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setRemoving(false);
    }
  }

  if (!confirming) {
    return (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className="type-label text-danger"
      >
        Remove this class
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="type-body">{confirmText}</p>
      <div className="flex gap-3">
        <Button variant="destructive" onClick={handleRemove} disabled={removing}>
          {removing ? 'Removing...' : 'Remove'}
        </Button>
        <Button variant="secondary" onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </div>
      {error && <p className="type-caption text-danger">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run --project components src/components/studio-class/delete-studio-class-button.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/components/studio-class/delete-studio-class-button.tsx src/components/studio-class/delete-studio-class-button.test.tsx
git commit -m "feat: a Remove button that names what the removal costs (issue 279)"
```

---

### Task 4: Wire the page, and cover it

**Files:**
- Modify: `src/app/(teacher)/studio-class/[id]/page.tsx` (the cancelled branch at `:60-64` and the action section at `:73-75`)
- Create: `tests/integration/studio-class-page.test.ts`

**Interfaces:**
- Consumes: `studioClassDeletability` (Task 1), `DeleteStudioClassButton` (Task 3), `startOfLocalDay` from `@/lib/timezone`.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/studio-class-page.test.ts`, following the `privacy-api.test.ts` / `privacy-page.test.ts` split and fetching pages the way `privacy-page.test.ts:111-120` does:

```ts
/**
 * `/(teacher)/studio-class/[id]` — the page half of issue 279, and the first
 * integration coverage this page has had (issue 143 lists it as one of three
 * uncovered teacher detail pages).
 *
 * What is worth pinning here is the pair of predicates the page computes, which
 * are close enough to be conflated and are not the same: REMOVABILITY decides
 * whether the button is drawn, REPORTING'S WINDOW decides whether the confirm
 * claims a cost. A single shared predicate passes the first two cases below and
 * fails the last two.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { startOfLocalDay } from '@/lib/timezone';
import { BASE_URL, cookie, uniqueSuffix, seedSession } from '../helpers';

const prisma = new PrismaClient();
const suffix = uniqueSuffix();

/** The `Teacher.defaultTimezone` default, and what every fixture here assumes. */
const TZ = 'Europe/Amsterdam';

let teacherId: string;
let token: string;

const page = (id: string) =>
  fetch(`${BASE_URL}/studio-class/${id}`, { headers: cookie(token) }).then((r) => r.text());

const makeClass = (data: {
  templateId?: string | null;
  date: Date;
  startTime: string;
  cancelledAt?: Date | null;
  hourlyRate?: number;
}) =>
  prisma.studioClass.create({
    data: {
      teacherId,
      classType: 'Page Case',
      durationMinutes: 60,
      location: 'Community Studio',
      hourlyRate: 45,
      ...data,
    },
  });

beforeAll(async () => {
  await prisma.$connect();
  const email = `studiopage-${suffix}@test.local`;
  const teacher = await prisma.teacher.create({
    data: {
      firstName: 'Studio',
      lastName: 'Page',
      email,
      account: { create: { email } },
      bio: 'Studio class page tests',
      pageSlug: `studiopage-${suffix}`,
    },
  });
  teacherId = teacher.id;
  token = await seedSession(prisma, teacher.accountId);
});

afterAll(async () => {
  await prisma.studioClass.deleteMany({ where: { teacherId } });
  await prisma.studioClassTemplate.deleteMany({ where: { teacherId } });
  await prisma.$disconnect();
});

describe('the studio class page: which classes offer removal', () => {
  it('offers no removal on a future generated class', async () => {
    const tpl = await prisma.studioClassTemplate.create({
      data: {
        teacherId,
        classType: 'Page Template',
        dayOfWeek: 3,
        startTime: '07:00',
        durationMinutes: 60,
        location: 'Community Studio',
        hourlyRate: 45,
      },
    });
    const sc = await makeClass({
      templateId: tpl.id,
      date: new Date('2099-08-05T00:00:00.000Z'),
      startTime: '07:00',
    });
    expect(await page(sc.id)).not.toContain('Remove this class');
  });

  it('offers removal on a cancelled past class, where the page used to dead-end', async () => {
    const sc = await makeClass({
      date: new Date('2020-08-05T00:00:00.000Z'),
      startTime: '07:15',
      cancelledAt: new Date('2020-08-01T10:00:00.000Z'),
    });
    const html = await page(sc.id);
    expect(html).toContain('This class was cancelled.');
    expect(html).toContain('Remove this class');
  });
});

describe('the studio class page: what the removal claims it costs', () => {
  it('claims nothing for a future-dated manual class, which reporting does not count', async () => {
    const sc = await makeClass({
      templateId: null,
      date: new Date('2099-08-06T00:00:00.000Z'),
      startTime: '07:30',
    });
    const html = await page(sc.id);
    expect(html).toContain('Remove this class');
    expect(html).not.toContain('will come off your reported earnings');
  });

  /**
   * DATED TODAY, STARTING AT LOCAL MIDNIGHT — not at a convenient hour.
   * `classStartInstant(today, '00:00', TZ)` is local midnight of today, which
   * is in the past at every wall-clock moment of the day. A fixture at, say,
   * '09:00' would be removable only after 09:00 Amsterdam and would fail every
   * morning, which reads as a bug rather than as a fixture choice.
   */
  it('claims the earnings for a class dated today whose start has passed', async () => {
    const today = startOfLocalDay(new Date(), TZ);
    const sc = await makeClass({
      templateId: null,
      date: today,
      startTime: '00:00',
      hourlyRate: 45,
    });
    const html = await page(sc.id);
    expect(html).toContain('Remove this class');
    // 45.00 x 60 / 60
    expect(html).toContain('45.00 will come off your reported earnings');
  });
});

/**
 * The end-to-end proof of the spec's §1.5 — the claim issue 279 inherited from
 * `prisma/schema.prisma:488` and built half its dilemma on. A studio class's
 * earnings are `hourlyRate x durationMinutes / 60` and nothing else;
 * `studentCount` never touches money; and removing the class takes the figure
 * with it.
 *
 * ITS OWN TEACHER, because the assertion is on an absolute total and every
 * other fixture in this file would otherwise be inside it.
 */
describe('the reporting page, which is where the income claim is settled', () => {
  let soloId: string;
  let soloToken: string;

  beforeAll(async () => {
    const email = `studiopage-solo-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Studio',
        lastName: 'Solo',
        email,
        account: { create: { email } },
        bio: 'Studio reporting removal',
        pageSlug: `studiopage-solo-${suffix}`,
      },
    });
    soloId = teacher.id;
    soloToken = await seedSession(prisma, teacher.accountId);
  });

  afterAll(async () => {
    await prisma.studioClass.deleteMany({ where: { teacherId: soloId } });
  });

  it('loses the removed class earnings, which a cancelled class never had', async () => {
    const reporting = () =>
      fetch(`${BASE_URL}/settings/reporting`, { headers: cookie(soloToken) }).then((r) => r.text());

    // 60.00/hr x 90 min = 90.00, and studentCount is deliberately left null to
    // show it plays no part in the figure.
    const sc = await prisma.studioClass.create({
      data: {
        teacherId: soloId,
        classType: 'Solo Case',
        templateId: null,
        date: new Date('2020-08-07T00:00:00.000Z'),
        startTime: '08:00',
        durationMinutes: 90,
        location: 'Community Studio',
        hourlyRate: 60,
        studentCount: null,
      },
    });

    expect(await reporting()).toContain('90.00');

    const res = await fetch(`${BASE_URL}/api/studio-classes/${sc.id}`, {
      method: 'DELETE',
      headers: cookie(soloToken),
    });
    expect(res.status).toBe(200);

    expect(await reporting()).not.toContain('90.00');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run --project integration tests/integration/studio-class-page.test.ts
```

Expected: FAIL — every case, because the page renders no `Remove this class` anywhere.

- [ ] **Step 3: Write the implementation**

In `src/app/(teacher)/studio-class/[id]/page.tsx`, add the imports:

```tsx
import { DeleteStudioClassButton } from '@/components/studio-class/delete-studio-class-button';
import { studioClassDeletability } from '@/services/studio-class-deletion';
import { startOfLocalDay } from '@/lib/timezone';
```

After the ownership redirect, compute both values:

```tsx
  // TWO PREDICATES, ON PURPOSE. They overlap almost everywhere and disagree in
  // the two places that matter, so neither may be derived from the other:
  //
  //   REMOVABLE      — can the hourly sweep undo this removal
  //                    (`studio-class-deletion.ts`, start-instant based)
  //   COUNTS         — is this row inside reporting's window
  //                    (`settings/reporting/page.tsx:36`, calendar-date based)
  //
  // A future-dated MANUAL class is removable and counts nothing. A class dated
  // TODAY whose start has passed is removable and counts. Collapsing these into
  // one flag gets both of those wrong, which is what
  // `tests/integration/studio-class-page.test.ts` pins.
  const { deletable } = studioClassDeletability(
    studioClass,
    new Date(),
    session.defaultTimezone,
  );

  const endOfToday = startOfLocalDay(new Date(), session.defaultTimezone);
  endOfToday.setUTCHours(23, 59, 59, 999);
  const countsTowardEarnings =
    studioClass.cancelledAt === null && studioClass.date <= endOfToday;
  const earningsAtRisk = countsTowardEarnings
    ? (Number(studioClass.hourlyRate) * studioClass.durationMinutes) / 60
    : null;
```

Replace the cancelled branch and add the button to the live branch:

```tsx
      {studioClass.cancelledAt ? (
        <>
          <div className="py-8 text-center type-body">
            This class was cancelled.
          </div>

          {deletable && (
            <section className="mt-2 pt-6 border-t border-border">
              <DeleteStudioClassButton
                studioClassId={studioClass.id}
                earningsAtRisk={earningsAtRisk}
              />
            </section>
          )}
        </>
      ) : (
        <>
          <section>
            <StudentCountEditor
              studioClassId={studioClass.id}
              initialCount={studioClass.studentCount}
            />
          </section>

          <section className="mt-8 pt-6 border-t border-border flex flex-col items-start gap-3">
            <CancelStudioClassButton studioClassId={studioClass.id} />
            {deletable && (
              <DeleteStudioClassButton
                studioClassId={studioClass.id}
                earningsAtRisk={earningsAtRisk}
              />
            )}
          </section>
        </>
      )}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run --project integration tests/integration/studio-class-page.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Check the stale-prop direction in the running app**

`deletable` is a server-render snapshot, and this project has been bitten by gating a control on server state a sweep can change. It is safe here in one direction only, and this step confirms the direction rather than assuming it: open a studio class dated today whose start is still ahead, confirm **no** Remove action, wait past the start, reload, confirm the action appears. A stale `false` hides a button a reload restores; a stale `true` is unreachable, because neither disjunct can flip back.

While there, confirm the schedule no longer lists a class removed via the button — if it does, that is Next's client Router Cache and the fix is a `router.refresh()` beside the `push`. `DeleteRoomButton` does not need one; verify rather than infer.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(teacher)/studio-class/[id]/page.tsx" tests/integration/studio-class-page.test.ts
git commit -m "feat: the studio class page offers removal where it is stable (issue 279)"
```

---

### Task 5: The decision, written down

**Files:**
- Modify: `CLAUDE.md`
- Modify: `prisma/schema.prisma:488` (the false sentence) and the `StudioClass` model at `:517-536`

**Interfaces:** none — this task is issue 279's stated acceptance.

- [ ] **Step 1: Correct the false claim in the schema**

At `prisma/schema.prisma:488`, inside the `withdrawnCount` docblock, replace:

```
/// no registrations to consult, so the only filter is `cancelledAt: null`
/// and every uncancelled future studio class the boundary reaches is
/// withdrawn. An already-cancelled one is an income record and survives.
```

with:

```
/// no registrations to consult, so the only filter is `cancelledAt: null`
/// and every uncancelled future studio class the boundary reaches is
/// withdrawn. An already-cancelled one survives — NOT because it is an
/// income record, which it is not: `settings/reporting/page.tsx:36` queries
/// with `cancelledAt: null` and excludes it from earnings and from the month
/// rollup outright. It survives because it holds `(templateId, date)`, and a
/// date the teacher cancelled deliberately must not be refilled on the next
/// resume. Corrected under issue 279, which inherited the wrong reason from
/// this sentence.
```

- [ ] **Step 2: Document the two doors on the model**

Add above `cancelledAt` in the `StudioClass` model:

```
  /// Cancelled, as opposed to removed — the two doors, and which is which
  /// (issue 279).
  ///
  /// CANCEL says "this was scheduled and did not happen". It withholds the row
  /// from earnings (`settings/reporting/page.tsx:36`), drops it out of the
  /// partial slot index `(teacherId, date, startTime) WHERE "cancelledAt" IS
  /// NULL`, and keeps `@@unique([templateId, date])` — so a generated class
  /// goes on holding its date against the sweep, which is the point when a
  /// teacher cancelled in order to teach something else in that slot.
  ///
  /// REMOVE (`DELETE /api/studio-classes/[id]`) takes the row away entirely,
  /// and is allowed only where the sweep cannot undo it: a manual class, or one
  /// whose start has passed. `studio-class-deletion.ts` holds the rule and the
  /// reasoning. A future generated class is refused there, with cancel named as
  /// the remedy.
  ///
  /// Cancellation is NOT a precondition of removal, and the removability
  /// predicate cannot read this column — its parameter type has no field for
  /// it. Requiring a cancel first would force the teacher to create the litter
  /// before they could clear it.
```

- [ ] **Step 3: State the rule in CLAUDE.md**

In the `## Core Business Logic` area, after the recurring-classes bullets that already describe the studio family, add:

```markdown
- **Removal, and the two doors it is not** (#279): a studio class may be
  removed outright only where the hourly sweep cannot undo it — a manually
  logged one, or one whose start instant has passed. A generated class still to
  come is refused with 409 and told to cancel instead, because removing it
  releases `(templateId, date)` and the sweep recreates it within the hour. A
  `StudioClassTemplate` is never removed at all: archiving withdraws its future
  window and records what it withdrew (`archivedAt`/`withdrawnCount`), and a
  delete would destroy that record. A cancelled studio class is **not** an
  income record — reporting excludes it — so nothing about keeping one is about
  money; it survives because it holds its template's date.
```

- [ ] **Step 4: Verify nothing else repeats the corrected claim**

```bash
grep -rn "income record" prisma/ src/ docs/ CLAUDE.md
```

Expected: only the corrected passage in `prisma/schema.prisma` and the spec's §1.5, which quotes it as the error it is. Any other hit is a twin that must be corrected in the same commit — a finding that names N locations gets N verdicts.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md prisma/schema.prisma
git commit -m "docs: the studio removal rule, and the income-record claim it disproves (issue 279)"
```

---

### Task 6: Whole-branch verification

**Files:** none changed unless verification finds something.

- [ ] **Step 1: Run the full gate**

The dev server must be running on :3000 — without it the `integration` project returns a wall of `ECONNREFUSED`.

```bash
npm run verify
```

This is `typecheck && lint && vitest run` across all three projects. Record the per-project file and test counts, with totals that reconcile, for the PR body. A green `verify` **is** the whole integration suite — say so with the arithmetic rather than repeating that integration is never run in full, which is no longer true.

- [ ] **Step 2: Confirm the migration story**

There is none, deliberately: this branch adds no column, no index and no constraint. Confirm it:

```bash
git diff main --stat -- prisma/
```

Expected: `prisma/schema.prisma` only, docblocks only — **no `prisma/migrations/` entry**. If a migration appears, something was added that the spec did not ask for.

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin feat/279-studio-class-deletion
```

The PR body records: which of the issue's claims held (§1.1, §1.2, §1.3, §1.6) and which were wrong (§1.4, §1.5), the mutation table with its recorded errors, the `verify` arithmetic, the `tests/integration/` files this branch touched **by path** (`studio-api.test.ts`, `studio-class-page.test.ts`), and what it does not do.

**In that last section write "#N is unaffected", never the negated close-keyword form.** GitHub's auto-close parser matches the keyword and does not read the negation in front of it; PR #191 closed issue 113 that way, and the commit written afterwards to document the trap closed it a second time by quoting the phrase. Say "leaves #275 open", "#276 is unaffected".

- [ ] **Step 4: Post the four issue updates**

Write each body to a file in the scratchpad and pass `--body-file`. **Never `--body "…"`** — backticks inside a double-quoted zsh string reach the shell as command substitution even escaped, and it fails silently: the comment posts, returns a URL, and has words missing.

| Issue | Body |
|---|---|
| 274 | 279 settles removal only; 276 keeps editability. The 275/276/277 working set is two files, not three — this branch took `api/studio-classes/[id]/route.ts` and `studio-class/[id]/page.tsx` and never touched `updateStudioClassSchema`. |
| 284 | The spec's §5 worked path: after week-keying, removing a past **generated** class frees that class's week and can let the sweep fill a still-future candidate in the same week. Not a defect — the week rule working as specified — but its acceptance should say so. |
| 275 | Removal is refused on future generated classes, so un-cancel is the only remedy left standing; "release the date" was withdrawn in that issue's own first comment. |
| 143 | `studio-class/[id]/page.tsx` now has integration coverage (`tests/integration/studio-class-page.test.ts`, 5 cases). The issue narrows to the other two pages and stays open. |
