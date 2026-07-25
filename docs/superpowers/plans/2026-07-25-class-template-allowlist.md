# Class-Template Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `PUT /api/class-templates/[id]` the three guards `PUT /api/classes/[id]` gained in #78/#80 — a derived update type, a teacher-editable allowlist, and a forbidden-column list — so a `ClassTemplate` column a teacher must not write cannot silently become writable by being added to `updateClassTemplateSchema` (issue #82).

**Architecture:** Extract the never-check idiom into a `NoneOf<T>` helper and move `class-lifecycle.ts`'s five pins onto it. Add `src/services/class-template-lifecycle.ts` holding a derived `ClassTemplateUpdateData`, the two field lists, five compile-time pins, and an `updateClassTemplate` service function. The route becomes a thin wrapper that maps result variants to status codes.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess: true`), Prisma, zod 4.4.3, Vitest (projects `unit` and `integration`), verified with `npm run typecheck`.

## Global Constraints

- **No `any`, no casts, no eslint suppressions.** `strict: true` throughout.
- **Every pin must name the offending field on failure.** A pin resolving to a bare boolean is useless. This is verified by reverted mutation, never assumed.
- **Preserve the four existing PUT responses byte-for-byte:** `not_found` → 404 `'Class template not found'`, `forbidden` → 403 `'Access denied'`, `no_fields` → 400 `'No valid fields to update'`, `invalid_room` → 400 `'Invalid teacher room'`.
- **Do not change write/sync transactionality.** Today the write and `syncTemplateInstances` are two sequential `await`s; a sync failure leaves the template updated and returns 500. That stays. It is deferred to its own issue in Task 6.
- **Never commit a mutation.** Tasks 2, 3 and 6 deliberately break the build to prove pins fire. Every one is reverted and `git status` proven clean before committing.
- **Branch:** `feat/class-template-allowlist`, already checked out with the spec committed. `main` requires a PR (rebase-only), so never commit there.
- Run the unit project with `npx vitest run --project unit`. The integration project needs the app on `:3000` and a database — see Task 1 Step 1.

## File Structure

| File | Responsibility |
|---|---|
| `src/lib/type-pins.ts` | **Create.** `NoneOf<T>` — the one generic behind every pin in the codebase. |
| `src/services/class-lifecycle.ts` | **Modify.** Five pins refactored onto `NoneOf`; `NeverTeacherEditableClassField` renamed to `PlainUpdateForbiddenClassField`. No behaviour change. |
| `src/services/class-template-lifecycle.ts` | **Create.** `ClassTemplateUpdateData`, the allowlist, the forbidden list, five pins, `UpdateClassTemplateResult`, `updateClassTemplate`. |
| `src/services/class-template-lifecycle.test.ts` | **Create.** DB-backed unit tests, one per result variant. |
| `src/app/api/class-templates/[id]/route.ts` | **Modify.** `PUT` becomes a thin wrapper. `GET` and `PATCH` untouched. |
| `src/lib/schemas.test.ts` | **Modify.** Key-set test for `updateClassTemplateSchema`. |
| `tests/integration/class-templates-api.test.ts` | **Modify.** A second teacher fixture, plus the first `PUT` HTTP coverage this route has ever had. |

---

### Task 1: Characterization tests for `PUT` — write the contract before moving it

**Files:**
- Modify: `tests/integration/class-templates-api.test.ts`

**Interfaces:**
- Consumes: `BASE_URL`, `cookie`, `uniqueSuffix`, `seedSession` from `./helpers`; the module-scope `teacherId`, `roomId`, `teacherRoomId`, `sessionToken`, `templateBody` already in the file.
- Produces: module-scope `otherSessionToken` and `otherTeacherRoomId`, used by later cases in this same file.

This route has **no `PUT` coverage at all** — the file covers `POST` and `PATCH` only. Task 5 rewrites the handler, so the safety net has to exist first. These tests must pass against the **current, unmodified** route: that is what makes them a characterization of today's behaviour rather than a description of tomorrow's.

- [ ] **Step 1: Start the app and confirm the baseline is green**

The integration project talks to a running app on `:3000` against the dev database.

```bash
npm run build && npm run start > /tmp/app.log 2>&1 &
until curl -sf http://localhost:3000/api/health > /dev/null; do sleep 1; done
npx vitest run --project integration tests/integration/class-templates-api.test.ts
```

Expected: PASS. (If the dev server is already running on `:3000`, use it — but restart it if Prisma types were regenerated since it started.) Leave the app running; Steps 3 and 5 need it.

- [ ] **Step 2: Add the second-teacher fixture**

Two of the four new cases are cross-teacher. Add these declarations directly below the existing `let sessionToken: string;`:

```ts
const otherEmail = `tmpl-other-${suffix}@test.local`;
let otherTeacherId: string;
let otherTeacherAccountId: string;
let otherRoomId: string;
let otherTeacherRoomId: string;
let otherSessionToken: string;
```

Append to the existing `beforeAll`, immediately before its closing `});`:

```ts
  // A second teacher, for the two cross-teacher PUT cases: editing
  // someone else's template (403) and attaching to someone else's room
  // (400). Both guards live in the route today and move into the service
  // in Task 5 — these tests are what prove the move preserved them.
  const other = await prisma.teacher.create({
    data: {
      firstName: 'Other',
      lastName: 'Teacher',
      email: otherEmail,
      account: { create: { email: otherEmail } },
      bio: 'Second teacher for template API tests',
      pageSlug: `tmpl-other-${suffix}`,
      defaultTimezone: 'UTC',
    },
  });
  otherTeacherId = other.id;
  otherTeacherAccountId = other.accountId;

  const otherRoom = await prisma.room.create({
    data: {
      venueName: 'Other Venue',
      address: `${suffix} Other St`,
      city: 'Testville',
      postcode: '5678TP',
      floor: '2',
      roomName: 'Studio',
      maxCapacity: 10,
      createdById: otherTeacherId,
    },
  });
  otherRoomId = otherRoom.id;
  const otherTeacherRoom = await prisma.teacherRoom.create({
    data: { teacherId: otherTeacherId, roomId: otherRoomId, capacityOverride: 8, rentalRate: 15 },
  });
  otherTeacherRoomId = otherTeacherRoom.id;
  otherSessionToken = await seedSession(prisma, other.accountId);
```

Add the matching teardown at the **top** of the existing `afterAll`, before the first-teacher cleanup (dependent rows first, same by-teacherId pattern the file already uses):

```ts
  await prisma.class.deleteMany({ where: { teacherId: otherTeacherId } });
  await prisma.classTemplate.deleteMany({ where: { teacherId: otherTeacherId } });
  await prisma.teacherRoom.deleteMany({ where: { teacherId: otherTeacherId } });
  await prisma.room.delete({ where: { id: otherRoomId } });
  if (otherTeacherAccountId) {
    await prisma.session.deleteMany({ where: { accountId: otherTeacherAccountId } });
  }
  await prisma.teacher.delete({ where: { id: otherTeacherId } });
  await prisma.account.deleteMany({ where: { email: otherEmail } });
```

- [ ] **Step 3: Confirm the fixture didn't break the existing suite**

```bash
npx vitest run --project integration tests/integration/class-templates-api.test.ts
```

Expected: PASS, same case count as Step 1. If teardown errors with a foreign-key violation, the cleanup order is wrong — dependent rows must be deleted before the room and teacher.

- [ ] **Step 4: Add the four `PUT` cases**

Append this block at the end of the file:

```ts
describe('PUT /api/class-templates/[id]', () => {
  const createTemplate = async (classType: string): Promise<string> => {
    const res = await fetch(`${BASE_URL}/api/class-templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify(templateBody(classType)),
    });
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    return data.id;
  };

  it('updates the template and propagates to its still-mutable instances', async () => {
    const id = await createTemplate('Editable Flow');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ classType: 'Renamed Flow', durationMinutes: 75 }),
    });
    expect(res.status).toBe(200);

    const { data } = (await res.json()) as {
      data: { classType: string; durationMinutes: number; sync: { synced: number } };
    };
    expect(data.classType).toBe('Renamed Flow');
    expect(data.durationMinutes).toBe(75);

    // Nothing is booked, so every future instance is still mutable. Asserted
    // on the future set rather than a fixed count: syncTemplateInstances uses
    // `date > now`, so whether today's instance is in scope depends on the
    // clock, and pinning "4" here would be flaky by construction.
    expect(data.sync.synced).toBeGreaterThan(0);
    const future = await prisma.class.findMany({
      where: { templateId: id, date: { gt: new Date() } },
    });
    expect(future.length).toBeGreaterThan(0);
    expect(future.every((c) => c.classType === 'Renamed Flow')).toBe(true);
    expect(future.every((c) => c.durationMinutes === 75)).toBe(true);
  });

  it("refuses to edit another teacher's template", async () => {
    const id = await createTemplate('Not Yours');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(otherSessionToken) },
      body: JSON.stringify({ classType: 'Hijacked' }),
    });
    expect(res.status).toBe(403);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.classType).toBe('Not Yours');
  });

  // This is the runtime behaviour every compile-time pin's reasoning rests on:
  // an undeclared key is a 400, so the ONLY way a forbidden column reaches
  // Prisma is by being declared in the schema — a source edit, which the pins
  // catch. If this test ever fails, the pins are guarding the wrong thing.
  it('rejects an undeclared key — the schema is strict', async () => {
    const id = await createTemplate('Strict Flow');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ classType: 'Renamed', isActive: false }),
    });
    expect(res.status).toBe(400);

    // Rejected whole: the declared field is not written either.
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.classType).toBe('Strict Flow');
    expect(after.isActive).toBe(true);
  });

  it("refuses a teacherRoom belonging to another teacher", async () => {
    const id = await createTemplate('Room Guard');

    const res = await fetch(`${BASE_URL}/api/class-templates/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(sessionToken) },
      body: JSON.stringify({ teacherRoomId: otherTeacherRoomId }),
    });
    expect(res.status).toBe(400);

    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });
});
```

- [ ] **Step 5: Run them against the UNMODIFIED route**

```bash
npx vitest run --project integration tests/integration/class-templates-api.test.ts
```

Expected: PASS, four cases more than Step 3. **All four must pass now**, before any source changes. A failure here means the test misdescribes current behaviour — fix the test, not the route. Record the exact case count for Task 5.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/class-templates-api.test.ts
git commit -m "test: characterize PUT /api/class-templates/[id] before extracting it (#82)"
```

---

### Task 2: Extract `NoneOf<T>` and refactor the five class pins

**Files:**
- Create: `src/lib/type-pins.ts`
- Modify: `src/services/class-lifecycle.ts`

**Interfaces:**
- Produces: `NoneOf<T>` from `@/lib/type-pins` — used by Task 3's five template pins.
- Produces: `PlainUpdateForbiddenClassField` (renamed from `NeverTeacherEditableClassField`, module-private).

The idiom is written five times in `class-lifecycle.ts`; Task 3 would make it ten. This is the only task that touches shipped security code, so Step 6 re-proves every pin still fires.

- [ ] **Step 1: Baseline**

```bash
npm run typecheck && npm run lint && npx vitest run --project unit
```

Expected: all exit 0, unit project green. If not, stop — something is wrong before this task begins.

- [ ] **Step 2: Create the helper**

Create `src/lib/type-pins.ts`:

```ts
/**
 * Compile-time invariant pins.
 *
 * A pin is a type that resolves to `true` when an invariant holds and to the
 * offending member's name when it does not, asserted via
 * `const _x: NoneOf<…> = true; void _x;`. The const is what instantiates the
 * conditional type — a pin alias that nothing assigns is never evaluated and
 * reports nothing, so deleting the const/void pair removes the check silently.
 */

/**
 * `true` when `T` is `never`, and `T` itself otherwise — so a failed pin names
 * the offender instead of failing as a bare boolean.
 *
 * The tuple brackets are load-bearing here in a way they were not at the call
 * sites this replaces, where the argument was always a concrete alias. `T` is a
 * naked type parameter, so unbracketed `T extends never` would distribute, and
 * distribution over the empty union is `never`. The failure mode is the
 * counter-intuitive direction: `NoneOf<never>` — the case where the invariant
 * HOLDS — would resolve to `never` and reject `true`, leaving the build
 * permanently red with no offending field to name. Measured on TypeScript
 * 5.9.3: unbracketed, only the passing case breaks; both forms still reject one
 * and two offenders correctly.
 */
export type NoneOf<T> = [T] extends [never] ? true : T;
```

- [ ] **Step 3: Refactor the five pins**

In `src/services/class-lifecycle.ts`, add to the imports:

```ts
import type { NoneOf } from '@/lib/type-pins';
```

Replace each pin's alias-pair-plus-const with a single annotated const. Keep every doc comment exactly as it is — they explain *why* each pin exists and none of that changes. Delete only the now-unused intermediate aliases (`UnwritableClassFields`, `ClassUpdateColumnsExist`, `UnpermittedClassFields`, `ClassUpdateFieldsArePermitted`, `StaleAllowlistFields`, `AllowlistHasNoStaleFields`, `UnknownForbiddenColumns`, `ForbiddenColumnsExist`, `ForbiddenFieldsOnAllowlist`, `AllowlistHasNoForbiddenFields`).

Pin 1 — columns exist:

```ts
const _classUpdateColumnsExist: NoneOf<
  Exclude<keyof ClassUpdateData, keyof Prisma.ClassUncheckedUpdateManyInput>
> = true;
void _classUpdateColumnsExist;
```

Pin 2 — forward:

```ts
const _classUpdateFieldsArePermitted: NoneOf<
  Exclude<keyof ClassUpdateData, TeacherEditableClassField>
> = true;
void _classUpdateFieldsArePermitted;
```

Pin 3 — reverse:

```ts
const _allowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableClassField, keyof ClassUpdateData>
> = true;
void _allowlistHasNoStaleFields;
```

Pin 4 — forbidden columns exist:

```ts
const _forbiddenColumnsExist: NoneOf<
  Exclude<PlainUpdateForbiddenClassField, keyof Prisma.ClassUncheckedUpdateManyInput>
> = true;
void _forbiddenColumnsExist;
```

Pin 5 — forbidden on allowlist:

```ts
const _allowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableClassField, PlainUpdateForbiddenClassField>
> = true;
void _allowlistHasNoForbiddenFields;
```

- [ ] **Step 4: Rename the forbidden list**

Rename the type `NeverTeacherEditableClassField` → `PlainUpdateForbiddenClassField` (declaration plus the two references in pins 4 and 5). Teachers *do* change `status`, via the transition route — the old name overstated what its own doc comment had to qualify.

Replace that type's first doc-comment line:

```ts
/**
 * The `Class` columns the plain update path must never write.
 *
 * "Plain update path", not "never": each of these is owned by a different,
 * guarded route — `status` by `POST …/transition` and `completeClass`,
 * `settingsLocked` by the first registration. The pin says "not here", which is
 * why the name says it too.
 *
```

Keep the rest of that comment (from `* The forward and reverse pins force the allowlist to mirror the schema…`) unchanged.

- [ ] **Step 5: Relocate the bracket note**

The comment above old pin 1 ends with *"The brackets stay correct if this check is ever moved into a generic helper."* That move has now happened and the reasoning lives in `type-pins.ts`. Delete those lines from `class-lifecycle.ts` — the local comment should describe what pin 1 checks, not re-explain the idiom.

- [ ] **Step 6: Verify — refactor is green and every pin still bites**

```bash
npm run typecheck && npm run lint && npx vitest run --project unit
```

Expected: exit 0, unit project green.

Then prove all five still fire. **Stage the refactor first** — `git checkout --`
restores from the index, so with the work unstaged the reverts below would wipe
your refactor instead of just the mutation:

```bash
git add src/lib/type-pins.ts src/services/class-lifecycle.ts
git status --short src/   # both staged before continuing
```

Run these one at a time, reverting between each:

```bash
# Pin 2 (forward): add a real column the allowlist lacks
perl -0pi -e "s/(  classType: z\.string\(\)\.min\(1\)\.optional\(\),\n)/\$1  status: z.enum(['draft','open','in_progress','completed','cancelled']).optional(),\n/" src/lib/schemas.ts
npm run typecheck   # MUST fail naming "status", on _classUpdateFieldsArePermitted
git checkout -- src/lib/schemas.ts

# Pin 3 (reverse): a stale allowlist entry
perl -0pi -e "s/(type TeacherEditableClassField =\n  \| 'classType')/\$1\n  | 'notAField'/" src/services/class-lifecycle.ts
npm run typecheck   # MUST fail naming "notAField", on _allowlistHasNoStaleFields
git checkout -- src/services/class-lifecycle.ts

# Pin 5 (forbidden): the reflexive grant — status on BOTH schema and allowlist
perl -0pi -e "s/(  classType: z\.string\(\)\.min\(1\)\.optional\(\),\n)/\$1  status: z.enum(['draft','open','in_progress','completed','cancelled']).optional(),\n/" src/lib/schemas.ts
perl -0pi -e "s/(type TeacherEditableClassField =\n  \| 'classType')/\$1\n  | 'status'/" src/services/class-lifecycle.ts
npm run typecheck   # MUST fail naming "status", on _allowlistHasNoForbiddenFields
git checkout -- src/lib/schemas.ts src/services/class-lifecycle.ts

# Pin 4 (forbidden columns exist): a typo in the forbidden list
perl -0pi -e "s/  \| 'settingsLocked'\n/  | 'settingsLockd'\n/" src/services/class-lifecycle.ts
npm run typecheck   # MUST fail naming "settingsLockd", on _forbiddenColumnsExist
git checkout -- src/services/class-lifecycle.ts

# Pin 1 (columns exist): a schema field that is not a column
perl -0pi -e "s/(  classType: z\.string\(\)\.min\(1\)\.optional\(\),\n)/\$1  notAColumn: z.string().optional(),\n/" src/lib/schemas.ts
npm run typecheck   # MUST fail naming "notAColumn", on _classUpdateColumnsExist
git checkout -- src/lib/schemas.ts
```

Record each error verbatim. **If any pin fails to fire, or fires on the wrong const, the extraction is wrong — revert `type-pins.ts` and this task's changes rather than patching.** A silently weakened pin is worse than no refactor.

- [ ] **Step 7: Prove the tree is clean, then commit**

```bash
git status --short src/
```

Expected: only the two intended files modified/created — no mutation residue.

```bash
git add src/lib/type-pins.ts src/services/class-lifecycle.ts
git commit -m "refactor: extract NoneOf<T> and scope the forbidden-list name (#82)"
```

---

### Task 3: The template pins — types and five compile-time checks

**Files:**
- Create: `src/services/class-template-lifecycle.ts`
- Modify: `src/lib/schemas.test.ts`

**Interfaces:**
- Consumes: `NoneOf<T>` from Task 2; `updateClassTemplateSchema` from `@/lib/schemas`.
- Produces: `ClassTemplateUpdateData` (exported) — Task 4's function parameter type and Task 5's route annotation.

No service function yet: the pins guard schema↔allowlist agreement, which is independent of who performs the write, so they stand alone and are worth reviewing alone.

- [ ] **Step 1: Write the failing key-set test**

In `src/lib/schemas.test.ts`, add after the existing `updateClassSchema` describe block:

```ts
describe('updateClassTemplateSchema', () => {
  // Mirrors the updateClassSchema key-set test. Less load-bearing here —
  // ClassTemplateUpdateData is a straight z.infer with no intersection, so the
  // reverse pin has no blind spot to compensate for — but it fails naming the
  // field, and it guards against someone introducing an intersection later.
  //
  // A failure here is a decision, not a chore: adding a key grants teachers
  // write access to that column. Read the allowlist's doc comment in
  // class-template-lifecycle.ts before updating this list.
  it('accepts exactly the teacher-editable field set', () => {
    expect(Object.keys(updateClassTemplateSchema.shape).sort()).toEqual([
      'autoCancelCheck',
      'cancelDeadline',
      'classType',
      'dayOfWeek',
      'description',
      'durationMinutes',
      'maxStudents',
      'minRate',
      'minStudents',
      'roomCost',
      'startTime',
      'targetRate',
      'teacherRoomId',
    ]);
  });
});
```

Add `updateClassTemplateSchema` to the existing import from `./schemas` at the top of the file.

- [ ] **Step 2: Run it — it should PASS immediately**

```bash
npx vitest run --project unit src/lib/schemas.test.ts
```

Expected: PASS. This is a characterization test of a schema that already exists, so a green first run is correct. Prove it can fail:

```bash
perl -0pi -e "s/^  dayOfWeek: z\.number\(\)\.int\(\)\.min\(0\)\.max\(6\)\.optional\(\),\n//m" src/lib/schemas.ts
npx vitest run --project unit src/lib/schemas.test.ts   # MUST fail, naming dayOfWeek
git checkout -- src/lib/schemas.ts
npx vitest run --project unit src/lib/schemas.test.ts   # PASS again
```

- [ ] **Step 3: Create the pins module**

Create `src/services/class-template-lifecycle.ts`:

```ts
/**
 * Class Template updates — the teacher-editable boundary for
 * `PUT /api/class-templates/[id]`.
 *
 * The sibling of `class-lifecycle.ts`'s update section, for the same reason
 * (#82 is #79 one route over) and with the same five pins.
 */

import type { Prisma } from '@prisma/client';
import type { z } from 'zod';
import type { updateClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';

/**
 * The fields a teacher may change on an existing template.
 *
 * Derived from `updateClassTemplateSchema`, not hand-declared: deriving is what
 * puts a newly added schema field into `keyof`, which is what every pin below
 * depends on. A hand-declared type would never see the offending field at all.
 *
 * Unlike `ClassUpdateData`, this needs no `Omit`/intersection — every schema
 * field maps to a column of the same type, including the two enums. That is why
 * the reverse pin here has no equivalent of the `date` blind spot documented on
 * the class route.
 */
export type ClassTemplateUpdateData = z.infer<typeof updateClassTemplateSchema>;

/**
 * Compile-time pin: every field the wire schema accepts must be a column
 * `update` can actually write on `ClassTemplate`.
 *
 * The reference is the *Many* input deliberately, as on the class route: the
 * single-record type additionally accepts nested relation writes (`classes`,
 * `teacher`, …) that a plain field update should never receive, so pinning
 * against it would wave through a schema field named after a relation.
 */
const _templateUpdateColumnsExist: NoneOf<
  Exclude<keyof ClassTemplateUpdateData, keyof Prisma.ClassTemplateUncheckedUpdateManyInput>
> = true;
void _templateUpdateColumnsExist;

/**
 * The fields a teacher may change on their own template via
 * `PUT /api/class-templates/[id]`.
 *
 * Adding a member is how a new schema field gets authorized. Three members
 * already here carry consequences beyond the template row — check what you are
 * joining before adding a fourth:
 *   - `dayOfWeek`     → `syncTemplateInstances` DELETES generated instances on
 *                       the old day (a different day is a different class) and
 *                       the generator refills on the new one. The most
 *                       destructive field on this list.
 *   - `teacherRoomId` → cross-teacher. The ownership check in
 *                       `updateClassTemplate` is the only thing stopping a
 *                       teacher attaching their template to another's room.
 *   - the economic fields → propagate to instances with no registrations;
 *                       anything a student has booked keeps its settings.
 */
type TeacherEditableClassTemplateField =
  | 'classType'
  | 'description'
  | 'teacherRoomId'
  | 'dayOfWeek'
  | 'startTime'
  | 'durationMinutes'
  | 'roomCost'
  | 'minRate'
  | 'targetRate'
  | 'minStudents'
  | 'maxStudents'
  | 'cancelDeadline'
  | 'autoCancelCheck';

/**
 * Compile-time pin (forward): every field the schema accepts must be on the
 * allowlist. Add a column-shaped field to the schema without adding it here and
 * this names that field instead of resolving to `true`.
 *
 * As on the class route, forward and reverse together force the allowlist to
 * *equal* the schema's key set, so the allowlist holds no policy of its own.
 * What it buys is that the grant must be explicit — a second edit, next to the
 * hazards above. The forbidden pin below is what refuses the grants that are
 * never right.
 */
const _templateFieldsArePermitted: NoneOf<
  Exclude<keyof ClassTemplateUpdateData, TeacherEditableClassTemplateField>
> = true;
void _templateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema accepts, so the list cannot rot into granting permission for a column
 * that no longer flows through this route.
 *
 * Also the only pin that fires if `ClassTemplateUpdateData` ever degrades to
 * `{}` or `unknown` — on an empty `keyof` the forward pin passes vacuously.
 */
const _templateAllowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableClassTemplateField, keyof ClassTemplateUpdateData>
> = true;
void _templateAllowlistHasNoStaleFields;

/**
 * The `ClassTemplate` columns the plain update path must never write.
 *
 * "Plain update path", not "never": `isActive` and `isArchived` are edited
 * constantly — by `PATCH` on this very route — and that is the point. Each
 * column here is owned by a different, guarded path:
 *   - `id`         → identity
 *   - `teacherId`  → ownership
 *   - `isActive`   → `PATCH`, which wraps the flip in a transaction and calls
 *                    `generateInstancesForTemplate`. A bare flip to `true`
 *                    would mark a template active with no instance window.
 *   - `isArchived` → `PATCH ?action=archive`, which also forces
 *                    `isActive: false`. Writing it alone can produce the
 *                    archived-but-active state `PATCH` refuses to create.
 *   - `createdAt`, `updatedAt` → Prisma-managed.
 *
 * The forward and reverse pins make the allowlist mirror the schema, so the
 * quickest way to clear a forward-pin failure is to paste the offending name
 * into the allowlist — the reflexive grant #79 is about. This is the set where
 * that repair is never right.
 */
type PlainUpdateForbiddenTemplateField =
  | 'id'
  | 'teacherId'
  | 'isActive'
  | 'isArchived'
  | 'createdAt'
  | 'updatedAt';

/**
 * Compile-time pin: every name above must be a real `ClassTemplate` column.
 * Without this a typo (`isActiv`) would sit in the forbidden list protecting
 * nothing while looking like protection.
 */
const _templateForbiddenColumnsExist: NoneOf<
  Exclude<PlainUpdateForbiddenTemplateField, keyof Prisma.ClassTemplateUncheckedUpdateManyInput>
> = true;
void _templateForbiddenColumnsExist;

/**
 * Compile-time pin (forbidden): no forbidden column may appear on the
 * allowlist. Fails on a const whose name carries the reason, because the const
 * name is the part of a type error people actually read.
 */
const _templateAllowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableClassTemplateField, PlainUpdateForbiddenTemplateField>
> = true;
void _templateAllowlistHasNoForbiddenFields;
```

- [ ] **Step 4: Verify green**

```bash
npm run typecheck && npm run lint && npx vitest run --project unit
```

Expected: exit 0. All five pins resolve to `true` because the schema's thirteen fields and the allowlist are exactly equal, and no forbidden column is on the allowlist.

If `_templateUpdateColumnsExist` fails, a schema field is not a writable column — reconcile and report which side was wrong; do not widen the pin.

- [ ] **Step 5: Prove all five bite**

**First, stage your work — this is not optional.** `git checkout -- <file>` restores
from the *index*, not from HEAD. With the work unstaged, the index still holds
pre-task content, so the revert between mutations wipes the module you just wrote
rather than just the mutation. Worse here than in Task 2: `class-template-lifecycle.ts`
is a **new** file, so until it is staged `git checkout --` on it fails outright with
`pathspec did not match`.

```bash
git add src/services/class-template-lifecycle.ts src/lib/schemas.test.ts
git status --short src/   # both staged (A/M in the left column) before continuing
```

Now the index holds the good state and each `git checkout --` below reverts the
mutation *onto* your work. Run them one at a time, reverting between each:

```bash
# forward: a real column the allowlist lacks
perl -0pi -e "s/(export const updateClassTemplateSchema = z\.object\(\{\n)/\$1  isActive: z.boolean().optional(),\n/" src/lib/schemas.ts
npm run typecheck   # MUST fail naming "isActive", on _templateFieldsArePermitted
git checkout -- src/lib/schemas.ts

# reverse: a stale allowlist entry
perl -0pi -e "s/(type TeacherEditableClassTemplateField =\n  \| 'classType')/\$1\n  | 'notAField'/" src/services/class-template-lifecycle.ts
npm run typecheck   # MUST fail naming "notAField", on _templateAllowlistHasNoStaleFields
git checkout -- src/services/class-template-lifecycle.ts

# forbidden: the reflexive grant — isActive on BOTH schema and allowlist
perl -0pi -e "s/(export const updateClassTemplateSchema = z\.object\(\{\n)/\$1  isActive: z.boolean().optional(),\n/" src/lib/schemas.ts
perl -0pi -e "s/(type TeacherEditableClassTemplateField =\n  \| 'classType')/\$1\n  | 'isActive'/" src/services/class-template-lifecycle.ts
npm run typecheck   # MUST fail naming "isActive", on _templateAllowlistHasNoForbiddenFields
git checkout -- src/lib/schemas.ts src/services/class-template-lifecycle.ts

# forbidden columns exist: a typo in the forbidden list
perl -0pi -e "s/  \| 'isArchived'\n/  | 'isArchivd'\n/" src/services/class-template-lifecycle.ts
npm run typecheck   # MUST fail naming "isArchivd", on _templateForbiddenColumnsExist
git checkout -- src/services/class-template-lifecycle.ts

# columns exist: a schema field that is not a column
perl -0pi -e "s/(export const updateClassTemplateSchema = z\.object\(\{\n)/\$1  notAColumn: z.string().optional(),\n/" src/lib/schemas.ts
npm run typecheck   # MUST fail naming "notAColumn", on _templateUpdateColumnsExist
git checkout -- src/lib/schemas.ts
```

Note the third mutation is the one that matters most: it is the only check that distinguishes this from #78's column pin, and the reflexive repair the other four permit.

- [ ] **Step 6: Prove clean, then commit**

```bash
git status --short src/
```

Expected: only `src/services/class-template-lifecycle.ts` (new) and `src/lib/schemas.test.ts` (modified).

```bash
git add src/services/class-template-lifecycle.ts src/lib/schemas.test.ts
git commit -m "feat: pin the fields a teacher may edit on a class template (#82)"
```

---

### Task 4: `updateClassTemplate` — the service function

**Files:**
- Modify: `src/services/class-template-lifecycle.ts`
- Create: `src/services/class-template-lifecycle.test.ts`

**Interfaces:**
- Consumes: `ClassTemplateUpdateData` from Task 3; `syncTemplateInstances` and `TemplateSyncResult` from `./template-sync`.
- Produces:
  ```ts
  export type UpdateClassTemplateResult =
    | { ok: true; template: ClassTemplate; sync: TemplateSyncResult }
    | { ok: false; reason: 'not_found' }
    | { ok: false; reason: 'forbidden' }
    | { ok: false; reason: 'no_fields' }
    | { ok: false; reason: 'invalid_room' };

  export async function updateClassTemplate(
    db: PrismaClient,
    templateId: string,
    teacherId: string,
    data: ClassTemplateUpdateData,
  ): Promise<UpdateClassTemplateResult>;
  ```
  Task 5's route consumes both.

- [ ] **Step 1: Write the failing unit tests**

Create `src/services/class-template-lifecycle.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { updateClassTemplate } from './class-template-lifecycle';

const prisma = new PrismaClient();
const uniqueSuffix = Date.now();

describe('updateClassTemplate (DB)', () => {
  let teacherId: string;
  let accountId: string;
  let roomId: string;
  let teacherRoomId: string;
  let otherTeacherId: string;
  let otherAccountId: string;
  let otherRoomId: string;
  let otherTeacherRoomId: string;

  const makeTemplate = (classType: string) =>
    prisma.classTemplate.create({
      data: {
        teacherId,
        teacherRoomId,
        classType,
        dayOfWeek: 3,
        startTime: '09:30',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 2,
        maxStudents: 8,
      },
    });

  const seedTeacher = async (label: string) => {
    const email = `tpl-${label}-${uniqueSuffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: label,
        lastName: 'Teacher',
        email,
        account: { create: { email } },
        bio: `Teacher for ${label} template tests`,
        pageSlug: `tpl-${label}-${uniqueSuffix}`,
        defaultTimezone: 'UTC',
      },
    });
    const room = await prisma.room.create({
      data: {
        venueName: `${label} Venue`,
        address: `${uniqueSuffix} ${label} St`,
        city: 'Testville',
        postcode: '1234TP',
        floor: '1',
        roomName: 'Loft',
        maxCapacity: 10,
        createdById: teacher.id,
      },
    });
    const teacherRoom = await prisma.teacherRoom.create({
      data: { teacherId: teacher.id, roomId: room.id, capacityOverride: 8, rentalRate: 15 },
    });
    return {
      teacherId: teacher.id,
      accountId: teacher.accountId,
      roomId: room.id,
      teacherRoomId: teacherRoom.id,
    };
  };

  beforeAll(async () => {
    await prisma.$connect();
    const mine = await seedTeacher('owner');
    teacherId = mine.teacherId;
    accountId = mine.accountId;
    roomId = mine.roomId;
    teacherRoomId = mine.teacherRoomId;

    const theirs = await seedTeacher('other');
    otherTeacherId = theirs.teacherId;
    otherAccountId = theirs.accountId;
    otherRoomId = theirs.roomId;
    otherTeacherRoomId = theirs.teacherRoomId;
  });

  afterAll(async () => {
    for (const [t, r, a] of [
      [teacherId, roomId, accountId],
      [otherTeacherId, otherRoomId, otherAccountId],
    ] as const) {
      await prisma.class.deleteMany({ where: { teacherId: t } });
      await prisma.classTemplate.deleteMany({ where: { teacherId: t } });
      await prisma.teacherRoom.deleteMany({ where: { teacherId: t } });
      await prisma.room.delete({ where: { id: r } });
      await prisma.session.deleteMany({ where: { accountId: a } });
      await prisma.teacher.delete({ where: { id: t } });
      await prisma.account.delete({ where: { id: a } });
    }
    await prisma.$disconnect();
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await updateClassTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
      { classType: 'Anything' },
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and writes nothing", async () => {
    const template = await makeTemplate('Not Yours');

    const result = await updateClassTemplate(prisma, template.id, otherTeacherId, {
      classType: 'Hijacked',
    });

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.classType).toBe('Not Yours');
  });

  it('returns no_fields for an empty payload', async () => {
    const template = await makeTemplate('Empty Payload');
    const result = await updateClassTemplate(prisma, template.id, teacherId, {});
    expect(result).toEqual({ ok: false, reason: 'no_fields' });
  });

  it('returns invalid_room for a room that does not exist', async () => {
    const template = await makeTemplate('Ghost Room');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      teacherRoomId: '00000000-0000-0000-0000-000000000000',
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  it("returns invalid_room for another teacher's room, and writes nothing", async () => {
    const template = await makeTemplate('Someone Elses Room');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      teacherRoomId: otherTeacherRoomId,
    });

    expect(result).toEqual({ ok: false, reason: 'invalid_room' });
    const after = await prisma.classTemplate.findUniqueOrThrow({ where: { id: template.id } });
    expect(after.teacherRoomId).toBe(teacherRoomId);
  });

  it('applies the update and returns the sync result', async () => {
    const template = await makeTemplate('Editable');

    const result = await updateClassTemplate(prisma, template.id, teacherId, {
      classType: 'Edited',
      durationMinutes: 75,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.classType).toBe('Edited');
    expect(result.template.durationMinutes).toBe(75);
    // No instances were generated for this bare template, so the sync is a
    // no-op — asserted as shape, not as counts.
    expect(result.sync).toEqual({ synced: 0, regenerated: 0, kept: 0 });
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
```

Expected: FAIL — `updateClassTemplate` is not exported. (TypeScript will also flag the import; that is the same failure.)

- [ ] **Step 3: Implement**

First extend the imports at the **top** of `src/services/class-template-lifecycle.ts`
(Task 3 deliberately imported only what its pins used, so lint stayed clean).
Widen the Prisma type import and add the sync import below the existing ones:

```ts
import type { Prisma, PrismaClient, ClassTemplate } from '@prisma/client';
import { syncTemplateInstances, type TemplateSyncResult } from './template-sync';
```

Then append to the end of the file:

```ts
/**
 * Why an update did or did not happen. Every business outcome is a variant;
 * callers own the user-facing wording.
 */
export type UpdateClassTemplateResult =
  | { ok: true; template: ClassTemplate; sync: TemplateSyncResult }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'invalid_room' };

/**
 * Apply a partial update to a class template, then propagate it to the
 * instances that are still mutable.
 *
 * Takes `teacherId` rather than a session: this is the ownership check, and
 * keeping it a plain argument is what lets the function be tested without HTTP.
 *
 * The write and the propagation are deliberately NOT one transaction, matching
 * the behaviour this replaced: if `syncTemplateInstances` throws, the template
 * row is already updated and the error propagates, so the caller sees a failure
 * for a partially applied change. That window is real and predates this
 * function; closing it changes behaviour (a sync failure would roll the edit
 * back) and belongs in its own change, with its own test.
 */
export async function updateClassTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  data: ClassTemplateUpdateData,
): Promise<UpdateClassTemplateResult> {
  const template = await db.classTemplate.findUnique({ where: { id: templateId } });
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  if (Object.keys(data).length === 0) return { ok: false, reason: 'no_fields' };

  // A teacher may only attach a template to a room they already hold. Checked
  // before the write so a bad room never lands, and checked here rather than in
  // the route so the guard travels with the function.
  if (data.teacherRoomId !== undefined) {
    const teacherRoom = await db.teacherRoom.findUnique({ where: { id: data.teacherRoomId } });
    if (!teacherRoom || teacherRoom.teacherId !== teacherId) {
      return { ok: false, reason: 'invalid_room' };
    }
  }

  const updated = await db.classTemplate.update({ where: { id: templateId }, data });
  const sync = await syncTemplateInstances(db, templateId);

  return { ok: true, template: updated, sync };
}
```

Note the `!== undefined` check rather than the route's truthy `if (updateData.teacherRoomId)`: the schema guarantees a non-empty uuid string when present, so the two agree on every value the schema admits — but `undefined` is the honest test for "field not sent".

- [ ] **Step 4: Run — expect pass**

```bash
npx vitest run --project unit src/services/class-template-lifecycle.test.ts
```

Expected: PASS, 6 cases.

- [ ] **Step 5: Full unit gate and commit**

```bash
npm run typecheck && npm run lint && npx vitest run --project unit
```

Expected: exit 0, whole unit project green.

```bash
git add src/services/class-template-lifecycle.ts src/services/class-template-lifecycle.test.ts
git commit -m "feat: extract updateClassTemplate service with typed outcomes (#82)"
```

---

### Task 5: The route becomes a thin wrapper

**Files:**
- Modify: `src/app/api/class-templates/[id]/route.ts:36-76` (the `PUT` handler only)

**Interfaces:**
- Consumes: `updateClassTemplate` and `ClassTemplateUpdateData` from Task 4.
- Produces: nothing new. `GET` and `PATCH` are untouched.

Task 1's four HTTP tests are the contract. They passed against the old handler and must pass unchanged against the new one — that, not the diff, is the evidence the extraction preserved behaviour.

- [ ] **Step 1: Replace the PUT handler**

Replace the whole `export const PUT = …` block with:

```ts
export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, updateClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  // Annotated, not inferred: this is what routes the payload through the
  // pinned type, so a field added to the schema has to clear the allowlist
  // in class-template-lifecycle.ts before it can reach Prisma.
  const data: ClassTemplateUpdateData = parsed.data;

  const result = await updateClassTemplate(prisma, id, session.teacherId, data);

  if (result.ok) return respondOk({ ...result.template, sync: result.sync });

  // Narrowed one reason at a time so each maps to the response this route
  // returned before the service existed.
  if (result.reason === 'not_found') return respondError('Class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  return respondError('Invalid teacher room', 400);
});
```

- [ ] **Step 2: Fix the imports**

Remove the now-unused `syncTemplateInstances` import if `PATCH` does not use it (it does not — `PATCH` uses `generateInstancesForTemplate`). Add:

```ts
import { updateClassTemplate, type ClassTemplateUpdateData } from '@/services/class-template-lifecycle';
```

`npm run lint` in Step 3 will name any import that is now unused.

- [ ] **Step 3: Static gate**

```bash
npm run typecheck && npm run lint
```

Expected: exit 0.

- [ ] **Step 4: Rebuild and re-run the characterization tests**

The integration project talks to whatever is serving `:3000`, so that server must
be running your new code — otherwise the tests exercise the old handler and pass
for the wrong reason. Which command you need depends on how it is being served:

```bash
# Which is it? `next dev` hot-reloads; `next start` serves a fixed build.
ps aux | grep -E "next (dev|start)" | grep -v grep
```

- **`next dev` already running** (the common local case): it hot-reloads on save.
  Do **not** rebuild or restart it — just re-run the tests. Rebuilding would
  replace someone's dev server with a production one.
- **`next start`, or nothing running:** rebuild, because the served bundle is
  frozen at build time.
  ```bash
  npm run build && npm run start > /tmp/app.log 2>&1 &
  until curl -sf http://localhost:3000/api/health > /dev/null; do sleep 1; done
  ```

Either way, then:

```bash
npx vitest run --project integration tests/integration/class-templates-api.test.ts
```

Expected: PASS, the same case count recorded in Task 1 Step 5 — **with no edits to the test file.** If a test needed changing, behaviour changed; treat that as a bug in this task, not a stale test.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/class-templates/[id]/route.ts"
git commit -m "refactor: PUT /api/class-templates/[id] delegates to the service (#82)"
```

---

### Task 6: Final gate, follow-up issue, PR

**Files:** none modified except by the commands below.

- [ ] **Step 1: Full local gate**

```bash
npm run typecheck && npm run lint && npx vitest run --project unit
```

Expected: exit 0; unit project green with 6 new cases (Task 4) plus 1 (Task 3).

```bash
npx vitest run --project integration
```

Expected: green. `signup-api.test.ts` may 429 from the local rate limiter — that is a known local-only artefact, unrelated to this work. If it appears, say so explicitly rather than reporting a clean run.

- [ ] **Step 2: Confirm no mutation residue anywhere**

```bash
git status --short
git diff main...HEAD --stat
```

Expected: a clean tree, and a diff touching only the seven files in the File Structure table (plus the spec committed before this plan).

- [ ] **Step 3: File the deferred transactionality issue**

```bash
gh issue create --title "PUT /api/class-templates/[id]: template write and instance sync are not atomic" --body "$(cat <<'BODY'
Split out of #82, which deliberately preserved this behaviour rather than changing it inside a type-safety fix.

`updateClassTemplate` (`src/services/class-template-lifecycle.ts`) writes the template and then calls `syncTemplateInstances` as two sequential awaits:

```ts
const updated = await db.classTemplate.update({ where: { id: templateId }, data });
const sync = await syncTemplateInstances(db, templateId);
```

If the sync throws, the template row is already updated and the error propagates as a 500. The client sees a failure for a change that partly applied: the template has the new values, its generated instances still have the old ones — and for a `dayOfWeek` change, instances may be half-deleted.

This predates the extraction; #82 moved the code without altering it, on purpose.

## The decision

Wrapping both in `db.\$transaction` makes a sync failure roll the template edit back. That is almost certainly right, but it *is* a behaviour change and deserves its own test:

- `syncTemplateInstances` already opens its own transaction internally, so it needs to accept a transaction client rather than a `PrismaClient` — check how `completeClass` threads `tx` for the established pattern.
- Worth confirming the nested-transaction shape Prisma produces here before committing to it.

## Test to add

An integration case where sync fails mid-update (inject a failure, or force a constraint violation) asserting the template row is unchanged afterwards.
BODY
)"
```

- [ ] **Step 4: Push and open the PR**

```bash
git push -u origin feat/class-template-allowlist
```

```bash
gh pr create --title "feat: allowlist the fields a teacher may edit on a class template (#82)" --body "$(cat <<'BODY'
Closes #82. Spec: `docs/superpowers/specs/2026-07-25-class-template-allowlist-design.md`

## The gap

`PUT /api/class-templates/[id]` handed parsed schema output straight to Prisma — no derived type, no column pin, no allowlist, no forbidden set. The same latent shape as #79, on the route that never got the guards #78 and #80 gave the class route.

It matters a little more here: this route does not stop at the template. It calls `syncTemplateInstances`, which propagates onto generated `Class` rows — so a bad template field reaches `Class` without going through `PUT /api/classes/[id]` at all.

Nothing was exploitable; none of the dangerous columns is in the schema. This closes what the route permitted the next contributor to add without a signal.

## What changed

- **`NoneOf<T>`** (`src/lib/type-pins.ts`) — the never-check idiom was written five times in `class-lifecycle.ts`; the template pins would have made ten. All five class pins moved onto it, then re-verified by reverted mutation, because that is shipped security code.
- **`PlainUpdateForbiddenClassField`** — renamed from `NeverTeacherEditableClassField`. Teachers *do* change `status`, via the transition route; the name overstated what its doc comment already had to qualify. On templates the gap was starker still: `isActive`/`isArchived` are edited by `PATCH` in the very route the pin guards.
- **`src/services/class-template-lifecycle.ts`** — `ClassTemplateUpdateData`, the thirteen-field allowlist, the six-column forbidden list, five pins, and `updateClassTemplate`.
- **The route** is now a thin wrapper mapping result variants to the four responses it returned before, unchanged.

## Two findings from the spec work

**No blind spot here.** `ClassUpdateData` re-adds `date` through an intersection, so a `date` dropped from the class schema leaves both its pins green. `ClassTemplateUpdateData` needs no intersection — every field maps to a column of the same type, enums included — so the template reverse pin has no equivalent hole. Strictly stronger than what #80 shipped.

**The tuple brackets fail in the surprising direction.** Once `T` is a naked type parameter, unbracketed `T extends never` distributes, and distribution over the empty union is `never` — so `NoneOf<never>`, the *passing* case, would reject `true` and leave the build permanently red with no field to name. Both forms still reject real offenders correctly. The helper's comment records the measurement.

## Tests

`PUT` had **no HTTP coverage at all**. Four cases were written first and made to pass against the unmodified route, then re-run unchanged after the extraction — that, not the diff, is the evidence behaviour was preserved. Plus six service unit tests (one per result variant) and a schema key-set test.

Every pin proven to fail in the right direction and name the offender, then reverted.

## Deferred, on purpose

The write and the sync are still two sequential awaits, so a sync failure leaves a partially applied change. That predates this work; making it atomic is a real behaviour change and got its own issue rather than being smuggled into a type-safety fix.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 5: Report the PR URL and the follow-up issue number. Do NOT merge.**

---

## Self-Review

**Spec coverage.** Section A (extract `NoneOf`) → Task 2. Section B (rename the forbidden lists) → Task 2 Step 4, and Task 3's `PlainUpdateForbiddenTemplateField`. Section C (new service module, `ClassTemplateUpdateData`, allowlist with its three hazard notes) → Task 3 Step 3. Section D (five pins) → Task 3 Steps 3 and 5, one mutation per pin. Section E (`updateClassTemplate`, the result type, the route wrapper, the four preserved responses, the explicit non-transactionality) → Tasks 4 and 5, with the deferral filed in Task 6 Step 3. Section F (`PATCH` gets no pin) → no task, correctly: the spec's conclusion is that nothing should be done. Testing section → Task 1 (HTTP), Task 3 Step 1 (key-set), Task 4 Step 1 (unit), Tasks 2/3 Step 5 (mutation). Both listed risks are mitigated in place: the shipped-pin risk by Task 2 Step 6's five-mutation matrix and its instruction to revert rather than patch, the behaviour-drift risk by Task 1 running before Task 5 and Task 5 Step 4 forbidding test edits.

**Placeholder scan.** None. Every step carries literal code or an exact command with its expected output. Both failure branches that could tempt improvisation say what to do instead: Task 2 Step 6 ("revert rather than patch"), Task 5 Step 4 ("treat that as a bug in this task, not a stale test"), Task 3 Step 4 ("do not widen the pin").

**Type consistency.** `ClassTemplateUpdateData`, `UpdateClassTemplateResult`, `updateClassTemplate`, `TeacherEditableClassTemplateField`, `PlainUpdateForbiddenTemplateField`, `NoneOf`, `TemplateSyncResult` and the five `_template*` const names are spelled identically everywhere they appear. The template consts are prefixed `_template*` so they cannot collide with `class-lifecycle.ts`'s five, which keep their existing names apart from the renamed type. `updateClassTemplate`'s four parameters match between the Task 4 interface block, its implementation, and the Task 5 call site. `TemplateSyncResult` is imported from `./template-sync`, where it is already exported — not redeclared.
