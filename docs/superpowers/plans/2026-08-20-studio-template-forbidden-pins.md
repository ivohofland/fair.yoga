# Studio Template Forbidden-Field Pin Machinery — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `PUT /api/studio-class-templates/[id]` the compile-time
forbidden-field machinery the class family has, behind a real service function,
with its lock wait bounded.

**Architecture:** Extract `updateStudioClassTemplate` into
`src/services/studio-class-template-lifecycle.ts`, guarded by six `NoneOf` pins
and a caller-binding intersection on its `data` parameter. The write moves
inside a transaction opening with `setLockTimeout`, so contention answers 503 at
~2s instead of waiting. The route becomes a thin reason-to-status mapper.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma, zod, vitest
(three projects: `unit`, `components`, `integration`), pino.

**Spec:** `docs/superpowers/specs/2026-08-20-studio-template-forbidden-pins-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. `npm run typecheck`
  must be exit 0 at every commit.
- **`@/lib/log` is pino and server-only.** Only ever imported into modules no
  `'use client'` component value-imports. `studio-class-template-lifecycle.ts`
  already imports it (`:45`) and states why — that reasoning is unchanged.
- **Never start or restart the dev server on :3000.** The user runs it. The
  `integration` project talks to it over HTTP; without it you get `ECONNREFUSED`.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote any path
  containing parentheses.
- **Never edit an applied migration.** This branch adds none.
- **Commit per task.** The PR is rebase-merged, never squashed; the
  commit-per-task history is the record.
- **`npm run verify` before pushing** — typecheck, lint, and all three vitest
  projects.
- **Measured baseline, 2026-08-20, all green:**
  `unit 63 files / 937 tests` + `components 41 / 242` + `integration 31 / 440`
  = **135 files / 1619 tests**. (`63 + 41 + 31 = 135`; `937 + 242 + 440 = 1619`.)
  Re-measure at the end; do not predict.

## Verify-don't-assume

Run these before Task 1. Every line number below is from 2026-08-20 on `main`
at `2a25971`. If one has drifted, fix the reference in this plan and say so in
the task report — do not silently work around it.

```bash
# The write this branch is about — expect `data: parsed.data` at :60
sed -n '33,73p' 'src/app/api/studio-class-templates/[id]/route.ts'

# The six class-family pins to mirror — expect consts at 72,120,133,186,206,216
grep -n "const _template[A-Za-z]*: NoneOf" src/services/class-template-lifecycle.ts

# The stale claim — expect "with the same five pins" on line 6
sed -n '6p' src/services/class-template-lifecycle.ts

# The runtime register — expect the array at :362 and the roster assertion at :439
sed -n '362,368p' src/lib/schemas.test.ts
sed -n '438,441p' src/lib/schemas.test.ts

# The wire schema — expect six optional fields and `.strict()` at :461
sed -n '454,461p' src/lib/schemas.ts

# The dev server (integration tests need it). Expect 200 or 3xx, never 000.
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/
```

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/services/studio-class-template-lifecycle.ts` | **Modify.** New update section at the top: two types, six pins, `UpdateStudioClassTemplateResult`, `updateStudioClassTemplate`. The existing pause/archive sections are untouched. | 2, 3 |
| `src/services/studio-class-template-lifecycle.test.ts` | **Modify.** New `updateStudioClassTemplate (DB)` describe. | 2, 3 |
| `src/app/api/studio-class-templates/[id]/route.ts` | **Modify.** `PUT` becomes parse → call → map. `GET` and `PATCH` untouched. | 4 |
| `tests/integration/studio-api.test.ts` | **Modify.** Three new cases; four existing PUT cases must stay green **unedited**. | 4 |
| `src/lib/schemas.test.ts` | **Modify.** Key-set test for the studio update schema; three names into `SERVER_OWNED_FIELDS`. | 1, 5 |
| `src/services/class-template-lifecycle.ts` | **Modify.** One docblock word. | 5 |
| `docs/superpowers/plans/2026-08-20-studio-template-forbidden-pins-mutations.md` | **Create.** The mutation record. | 6 |

**Task order is load-bearing between 1 and 2.** Task 1's key-set test is what
makes Task 2's allowlist a checkable claim rather than a copy of the schema —
and if Task 2 lands first, a wrong allowlist is invisible until Task 1 arrives.

---

### Task 1: Pin the studio update schema's key set

**Files:**
- Test: `src/lib/schemas.test.ts` (modify — add a `describe` after
  `updateClassTemplateSchema`'s, which ends at `:281`)

**Interfaces:**
- Consumes: nothing.
- Produces: the authoritative six-name list Task 2's
  `TeacherEditableStudioTemplateField` must equal —
  `classType`, `dayOfWeek`, `durationMinutes`, `hourlyRate`, `location`,
  `startTime`.

- [ ] **Step 1: Write the failing test**

Add `updateStudioClassTemplateSchema` to the named-import block at
`src/lib/schemas.test.ts:5-19`, then add this `describe` immediately after the
`updateClassTemplateSchema` one:

```ts
describe('updateStudioClassTemplateSchema', () => {
  // Mirrors the updateClassTemplateSchema key-set test above, and exists for
  // the reason #114 measured: `.strict()` means an undeclared key is a 400, so
  // the ONLY way a forbidden column reaches `studioClassTemplate.update` is by
  // being declared here. A failure below is therefore a decision, not a chore.
  //
  // Read `PlainUpdateForbiddenStudioTemplateField`'s doc comment in
  // `studio-class-template-lifecycle.ts` before adding a key. Adding one that
  // names a column on that list is refused by a compile-time pin, not by this
  // test — this test is what makes an *authorized* addition deliberate.
  it('accepts exactly the teacher-editable field set', () => {
    expect(Object.keys(updateStudioClassTemplateSchema.shape).sort()).toEqual([
      'classType',
      'dayOfWeek',
      'durationMinutes',
      'hourlyRate',
      'location',
      'startTime',
    ]);
  });
});
```

- [ ] **Step 2: Run it and watch it pass, then prove it can fail**

Run: `npx vitest run --project unit src/lib/schemas.test.ts -t "teacher-editable field set"`

Expected: 2 passed (this one and the class-template twin).

This test passes on arrival, so passing proves nothing. Prove it bites:
temporarily delete `location: z.string().min(1).optional(),` from
`updateStudioClassTemplateSchema` (`src/lib/schemas.ts:459`), re-run, and record
the exact failure text. Expect a diff naming `location`. **Restore the line and
re-run to green before continuing.**

- [ ] **Step 3: Commit**

```bash
git add src/lib/schemas.test.ts
git commit -m "test: pin the studio template update schema's key set (issue 114)"
```

---

### Task 2: The types and the six pins

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` (insert after the
  import block, which ends at `:50`, and before
  `export type PauseStudioTemplateResult` at `:72`)

**Interfaces:**
- Consumes: Task 1's six-name list.
- Produces, for Task 3 and Task 4:
  - `export type StudioClassTemplateUpdateData = z.infer<typeof updateStudioClassTemplateSchema>`
  - `type TeacherEditableStudioTemplateField` (module-private)
  - `type PlainUpdateForbiddenStudioTemplateField` (module-private)

- [ ] **Step 1: Add the imports**

`src/services/studio-class-template-lifecycle.ts` currently imports
`import type { PrismaClient, StudioClassTemplate } from '@prisma/client';` at
`:35`. Change that line and add three more, keeping the existing import order:

```ts
import type { Prisma, PrismaClient, StudioClassTemplate } from '@prisma/client';
import type { z } from 'zod';
import type { updateStudioClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
```

All four are **type-only** and erase completely.

`Prisma` is deliberately `import type` here where `class-template-lifecycle.ts:26`
imports it as a value — not an inconsistency to "fix". That file needs the value
because it tests `err instanceof Prisma.PrismaClientKnownRequestError` directly
at `:542`; Task 3 below reaches the same outcome through `isRecordNotFound`
(`api-errors.ts:245`), so nothing here needs `Prisma` at runtime. If you find
yourself adding a value use of `Prisma`, widen the import then — not
pre-emptively.

- [ ] **Step 2: Add the update section**

Insert immediately after the import block:

```ts
/**
 * The fields a teacher may change on an existing studio template.
 *
 * Derived from `updateStudioClassTemplateSchema`, not hand-declared: deriving
 * is what puts a newly added schema field into `keyof`, which is what every
 * pin below depends on. A hand-declared type would never see the offending
 * field at all.
 *
 * Needs no `Omit`/intersection — every schema field maps to a column of the
 * same type, `hourlyRate: number` included, which assigns to the `Decimal`
 * column's input union directly. Measured with `tsc --noEmit`, not assumed
 * (spec, "Verified mechanics"). So the reverse pin here has no equivalent of
 * the `date` blind spot `class-lifecycle.ts` documents.
 */
export type StudioClassTemplateUpdateData = z.infer<typeof updateStudioClassTemplateSchema>;

/**
 * Compile-time pin: every field the wire schema accepts must name a column
 * `update` can write on `StudioClassTemplate` — the write checks the types,
 * this checks the name, and only this catches a name Prisma has never heard of.
 *
 * The *Many* input is the reference deliberately, as in both class services:
 * the single-record type additionally accepts a nested relation write
 * (`studioClasses`) that a plain field update should never receive, so pinning
 * against it would wave through a schema field named after that relation.
 */
const _studioTemplateUpdateColumnsExist: NoneOf<
  Exclude<
    keyof StudioClassTemplateUpdateData,
    keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput
  >
> = true;
void _studioTemplateUpdateColumnsExist;

/**
 * The fields a teacher may change on their own studio template via
 * `PUT /api/studio-class-templates/[id]`.
 *
 * Adding a member is how a new schema field gets authorized. Two members here
 * already carry consequences beyond the template row:
 *   - `dayOfWeek`, `startTime` → both are in
 *     `StudioClassTemplate_teacher_slot_unique` (`(teacherId, dayOfWeek,
 *     startTime) WHERE isArchived = false`, #196), so editing either can
 *     collide with another of this teacher's live templates.
 *   - `dayOfWeek` additionally → generated `StudioClass` rows are NOT moved or
 *     withdrawn. Unlike the class family, this family has no
 *     `syncTemplateInstances` equivalent, so an edit leaves four weeks of
 *     classes on the superseded weekday. That is #194, which this branch does
 *     not address; it is named here because this list is where someone would
 *     look for it.
 */
type TeacherEditableStudioTemplateField =
  | 'classType'
  | 'dayOfWeek'
  | 'startTime'
  | 'durationMinutes'
  | 'location'
  | 'hourlyRate';

/**
 * Compile-time pin (forward): every field the schema accepts must be on the
 * allowlist. Add a column-shaped field to the schema without adding it here and
 * this names that field instead of resolving to `true`.
 *
 * Forward and reverse together force the allowlist to *equal* the schema's key
 * set, so the allowlist holds no policy of its own. What it buys is that the
 * grant must be explicit — a second edit, next to the hazards above. The
 * forbidden pins below refuse the grants that are never right.
 */
const _studioTemplateFieldsArePermitted: NoneOf<
  Exclude<keyof StudioClassTemplateUpdateData, TeacherEditableStudioTemplateField>
> = true;
void _studioTemplateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema accepts, so the list cannot rot into granting permission for a column
 * that no longer flows through this route.
 *
 * Also the only pin that fires if `StudioClassTemplateUpdateData` ever degrades
 * to `{}` or `unknown` — on an empty `keyof` the forward pin passes vacuously.
 */
const _studioTemplateAllowlistHasNoStaleFields: NoneOf<
  Exclude<TeacherEditableStudioTemplateField, keyof StudioClassTemplateUpdateData>
> = true;
void _studioTemplateAllowlistHasNoStaleFields;

/**
 * The `StudioClassTemplate` columns the plain update path must never write.
 *
 * "Plain update path", not "never": `isActive` and `isArchived` are edited
 * constantly — by `PATCH` on this very route — and that is the point. Each
 * column here is owned by a different, guarded path:
 *   - `id`             → identity
 *   - `teacherId`      → ownership
 *   - `isActive`       → `PATCH ?state=active|paused`, which flips it inside a
 *                        transaction that also takes the generation claim and
 *                        generates the window (#94, #120). A bare flip to
 *                        `true` would mark a template active with no window.
 *   - `isArchived`     → `PATCH ?state=archived`, which also forces
 *                        `isActive: false`. Writing it alone can produce the
 *                        archived-but-active state `PATCH` refuses to create,
 *                        and moves the row in and out of
 *                        `StudioClassTemplate_teacher_slot_unique`'s partial
 *                        scope without the conflict handling that owns it.
 *   - `archivedAt`,
 *     `withdrawnCount` → written only by the same archive transaction that
 *                        owns `isArchived` (#97, #111). A plain update setting
 *                        these could forge "Archived <date> · <count>
 *                        withdrawn" onto a template that was never archived —
 *                        the exact stale-record state the un-archive clear
 *                        exists to prevent.
 *   - `createdAt`,
 *     `updatedAt`      → Prisma-managed.
 *
 * The same eight names as `PlainUpdateForbiddenTemplateField`
 * (`class-template-lifecycle.ts`). The allowlists differ entirely; these do
 * not, because the two models carry the same lifecycle columns.
 *
 * The forward and reverse pins make the allowlist mirror the schema, so the
 * quickest way to clear a forward-pin failure is to paste the offending name
 * into the allowlist — the reflexive grant #79 is about. This is the set where
 * that repair is never right.
 *
 * A runtime guard covers five of these already and is worth knowing about,
 * because it is weaker in exactly the way that matters: `schemas.test.ts`'s
 * `server-owned fields` register walks every exported schema and refuses
 * `id`, `teacherId`, `isArchived`, `archivedAt` and `withdrawnCount`. But its
 * failure message says "add it to EXPECTED with a reason" — so *its* quickest
 * repair IS the reflexive grant. The pin below is what refuses that.
 */
type PlainUpdateForbiddenStudioTemplateField =
  | 'id'
  | 'teacherId'
  | 'isActive'
  | 'isArchived'
  | 'archivedAt'
  | 'withdrawnCount'
  | 'createdAt'
  | 'updatedAt';

/**
 * Compile-time pin (completeness): every column on the model must be claimed by
 * one of the two lists above. Catches a deletion from either — and, unlike the
 * class family's twin, a column a migration adds that nobody classified.
 *
 * **Deliberately not a copy of `_templateForbiddenListIsComplete`**
 * (`class-template-lifecycle.ts:186`). That pin duplicates the forbidden union
 * literally and `Exclude`s it against itself, so it never consults Prisma and
 * is structurally blind to a new column. Measured (spec, section A): a
 * simulated migration adding an unclassified column leaves the duplicate-union
 * form green and turns this form red, naming it. When #111 added `archivedAt`
 * and `withdrawnCount` to both models, every pin then in place stayed green
 * until a human remembered to classify them; this one would have gone red on
 * the migration.
 *
 * Available here only because the two lists partition the model exactly —
 * 6 + 8 = 14 columns, measured, not counted off `schema.prisma`. If a future
 * column is legitimately neither teacher-editable nor forbidden, this pin is
 * the wrong shape and should be replaced rather than have a name pasted into
 * one of the lists to silence it.
 */
const _studioTemplateListsPartitionTheModel: NoneOf<
  Exclude<
    keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput,
    TeacherEditableStudioTemplateField | PlainUpdateForbiddenStudioTemplateField
  >
> = true;
void _studioTemplateListsPartitionTheModel;

/**
 * Compile-time pin: every name on the forbidden list must be a real
 * `StudioClassTemplate` column. Without this a typo (`isActiv`) would sit there
 * protecting nothing while looking like protection.
 *
 * Overlaps the partition pin above — a typo trips both — and is kept anyway,
 * because the two name different halves of the same mistake. This one says
 * "`isActiv` is not a column"; the partition pin says "`isActive` is
 * unclassified". The first is the one that points at the fix.
 */
const _studioTemplateForbiddenColumnsExist: NoneOf<
  Exclude<
    PlainUpdateForbiddenStudioTemplateField,
    keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput
  >
> = true;
void _studioTemplateForbiddenColumnsExist;

/**
 * Compile-time pin (forbidden): no forbidden column may appear on the
 * allowlist. Fails on a const whose name carries the reason, because the const
 * name is the part of a type error people actually read.
 */
const _studioTemplateAllowlistHasNoForbiddenFields: NoneOf<
  Extract<TeacherEditableStudioTemplateField, PlainUpdateForbiddenStudioTemplateField>
> = true;
void _studioTemplateAllowlistHasNoForbiddenFields;
```

- [ ] **Step 3: Update the file docblock**

`src/services/studio-class-template-lifecycle.ts:2-3` currently reads:

```
 * Studio Class Template lifecycle — pause/resume and archive/un-archive for
 * `PATCH /api/studio-class-templates/[id]` (#86, #98).
```

Replace those two lines with:

```
 * Studio Class Template lifecycle — the teacher-editable boundary for
 * `PUT /api/studio-class-templates/[id]` (#114), plus pause/resume and
 * archive/un-archive for `PATCH` on the same route (#86, #98).
```

Leave the three numbered differences below it exactly as they are.

- [ ] **Step 4: Verify it compiles and lints**

Run: `npm run typecheck && npm run lint`
Expected: both exit 0. All six pins resolve to `true`.

- [ ] **Step 5: Commit**

```bash
git add src/services/studio-class-template-lifecycle.ts
git commit -m "feat: six forbidden-field pins for StudioClassTemplate, one stronger than the class twin's (issue 114)"
```

---

### Task 3: `updateStudioClassTemplate`

**Files:**
- Modify: `src/services/studio-class-template-lifecycle.ts` (append the result
  type and function immediately after Task 2's pins)
- Test: `src/services/studio-class-template-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 2's three types.
- Produces, for Task 4:
  - `export type UpdateStudioClassTemplateResult`
  - `export async function updateStudioClassTemplate(db, templateId, teacherId, data)`

- [ ] **Step 1: Write the failing tests**

Append a new `describe` at the end of
`src/services/studio-class-template-lifecycle.test.ts`. Add
`updateStudioClassTemplate` to the import block at `:3-6`, and add
`vi` to the vitest import at `:1` plus `import { log } from '@/lib/log';`.

```ts
describe('updateStudioClassTemplate (DB)', () => {
  let teacherId: string;
  let otherTeacherId: string;
  let counter = 0;

  const makeTemplate = async (owner: string, classType: string) => {
    counter += 1;
    return prisma.studioClassTemplate.create({
      data: {
        teacherId: owner,
        classType,
        dayOfWeek: 4,
        startTime: slotTime(counter),
        durationMinutes: 60,
        location: 'Update Studio',
        hourlyRate: 45,
      },
    });
  };

  beforeAll(async () => {
    ({ teacherId } = await seedTeacher('update-owner'));
    ({ teacherId: otherTeacherId } = await seedTeacher('update-other'));
  });

  it('returns not_found for a template that does not exist', async () => {
    const result = await updateStudioClassTemplate(
      prisma,
      '00000000-0000-0000-0000-000000000000',
      teacherId,
      { classType: 'Ghost' },
    );
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it("returns forbidden for another teacher's template, and leaves it untouched", async () => {
    const t = await makeTemplate(otherTeacherId, 'Not Yours');

    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
      classType: 'Hijacked',
    });

    expect(result).toEqual({ ok: false, reason: 'forbidden' });
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.classType).toBe('Not Yours');
  });

  it('returns no_fields for an empty payload', async () => {
    const t = await makeTemplate(teacherId, 'Empty Payload');
    expect(await updateStudioClassTemplate(prisma, t.id, teacherId, {})).toEqual({
      ok: false,
      reason: 'no_fields',
    });
  });

  // The case a key-count check lets through. Unreachable over the wire — JSON
  // cannot carry `undefined`, so a key never arrives with that value — and
  // reachable here, which is the whole point of there being a function
  // boundary. `Object.keys({ classType: undefined }).length` is 1.
  it('returns no_fields for a payload whose only key is undefined', async () => {
    const t = await makeTemplate(teacherId, 'Undefined Only');
    expect(
      await updateStudioClassTemplate(prisma, t.id, teacherId, { classType: undefined }),
    ).toEqual({ ok: false, reason: 'no_fields' });

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.classType).toBe('Undefined Only');
  });

  it('writes the edited fields and returns the updated row', async () => {
    const t = await makeTemplate(teacherId, 'Editable');

    const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
      classType: 'Edited',
      hourlyRate: 62.5,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.template.classType).toBe('Edited');
    expect(Number(result.template.hourlyRate)).toBe(62.5);
    // Untouched fields survive a partial update.
    expect(result.template.location).toBe('Update Studio');
  });

  it('returns slot_conflict when the edit lands on a live sibling slot, and logs it', async () => {
    const occupant = await makeTemplate(teacherId, 'Slot Occupant');
    const mover = await makeTemplate(teacherId, 'Slot Mover');

    const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
    try {
      const result = await updateStudioClassTemplate(prisma, mover.id, teacherId, {
        startTime: occupant.startTime,
      });

      expect(result).toEqual({ ok: false, reason: 'slot_conflict' });

      // #231: a RETURNED failure never reaches `withErrorHandler`, and
      // `respondError` does not log. Catching this P2002 is what would delete
      // the line `classifyApiError` emits when it escapes, so the catch has to
      // put one back.
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ templateId: mover.id, teacherId }),
        'studio template edit refused by the slot index',
      );
    } finally {
      warn.mockRestore();
    }

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: mover.id } });
    expect(after.startTime).toBe(mover.startTime);
  });

  /**
   * The bound, proved the way `studio-class-generator.test.ts`'s twin proves
   * the archive's: a third transaction holds the row `FOR UPDATE`, the edit
   * queues behind it, and the timing assertions carry the claim. The lower
   * bound proves it actually waited; the upper proves it answered near the 2s
   * `setLockTimeout` bound rather than at the 10s budget.
   *
   * Removing `setLockTimeout` does not slide the answer later — it stops the
   * edit settling at all, so the test dies on its own 20s timeout. That is the
   * mutation record, not a prediction.
   */
  it(
    'returns busy when another transaction holds the row past the lock timeout, and logs it',
    async () => {
      const t = await makeTemplate(teacherId, 'Busy Edit');

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const blocking = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "StudioClassTemplate" WHERE "id" = ${t.id} FOR UPDATE`;
          await held;
        },
        { timeout: 15_000 },
      );

      await new Promise((r) => setTimeout(r, 100));

      const warn = vi.spyOn(log, 'warn').mockImplementation(() => log);
      try {
        const startedAt = Date.now();
        const result = await updateStudioClassTemplate(prisma, t.id, teacherId, {
          classType: 'Blocked',
        });
        const waited = Date.now() - startedAt;

        expect(result).toEqual({ ok: false, reason: 'busy' });
        expect(waited).toBeGreaterThanOrEqual(1_800);
        expect(waited).toBeLessThan(5_000);

        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ templateId: t.id, teacherId }),
          'studio template edit lost the template lock race — nothing committed',
        );
      } finally {
        warn.mockRestore();
        release();
        await blocking.catch(() => {});
      }

      const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
      expect(after.classType).toBe('Busy Edit');
    },
    20_000,
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts -t "updateStudioClassTemplate"`

Expected: FAIL. The import of `updateStudioClassTemplate` does not resolve, so
the file fails to load — every case in it errors, not just the new ones. That is
the correct starting state; do not "fix" it by stubbing.

- [ ] **Step 3: Write the implementation**

Append to `src/services/studio-class-template-lifecycle.ts`, immediately after
Task 2's last pin:

```ts
/**
 * Why an update did or did not happen. Every business outcome is a variant;
 * callers own the user-facing wording.
 */
export type UpdateStudioClassTemplateResult =
  | { ok: true; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'busy' };

/**
 * Applies a teacher's edit to their own studio template.
 *
 * Ownership lives here, not in the route, so the guard travels with the
 * function — the same choice `updateClassTemplate` made and for the same
 * reason.
 *
 * The `data` parameter's intersection with
 * `Partial<Record<PlainUpdateForbiddenStudioTemplateField, never>>` is what
 * makes the forbidden list bind *callers*, not just the wire schema. The pins
 * above only prove the allowlist and the schema agree; they say nothing about
 * a caller. TypeScript's excess-property check fires only on a fresh object
 * literal — build `data` as a variable first
 * (`const patch = { classType: 'Yin', isActive: true };
 * updateStudioClassTemplate(db, id, me, patch)`) and it never triggers, so a
 * value with no matching type declaration would sail straight through to
 * `update`. Marking each forbidden key optional-and-`never` forces TypeScript
 * to reject that argument however it arrives.
 *
 * No instance sync. Unlike the class family, editing `dayOfWeek` or
 * `startTime` here leaves generated `StudioClass` rows on the superseded
 * schedule — there is no `syncTemplateInstances` equivalent for this family.
 * That is #194, with two open product decisions of its own; this function is
 * the seam it will attach to, which is why the omission is stated rather than
 * left to be discovered.
 */
export async function updateStudioClassTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  data: StudioClassTemplateUpdateData &
    Partial<Record<PlainUpdateForbiddenStudioTemplateField, never>>,
): Promise<UpdateStudioClassTemplateResult> {
  const template = await db.studioClassTemplate.findUnique({ where: { id: templateId } });
  // Deliberately silent, all three of the returns in this block. #231's own
  // acceptance criterion allows a failure to go unlogged when it carries no
  // information an operator could act on, and a 404 or a 403 for a template
  // the caller never owned is that case. The two returns from the `catch`
  // below are not, and both log.
  if (!template) return { ok: false, reason: 'not_found' };
  if (template.teacherId !== teacherId) return { ok: false, reason: 'forbidden' };

  // Defined-value scan, not a key count, matching `updateClassTemplate`: a key
  // present with value `undefined` is not an edit. A key-count check would let
  // `{ classType: undefined }` through and issue a no-op `update` that still
  // reported `ok: true`. The wire cannot produce that shape — JSON has no
  // `undefined` — but this function is callable without a wire.
  const hasEdit = Object.values(data).some((v) => v !== undefined);
  if (!hasEdit) return { ok: false, reason: 'no_fields' };

  try {
    return await db.$transaction(
      async (tx): Promise<UpdateStudioClassTemplateResult> => {
        // Bounds the wait for this row. `archiveOrUnarchiveStudioTemplate`'s
        // CAS holds it inside a transaction that then deletes and generates,
        // so a concurrent edit really can queue behind it.
        //
        // Without this the wait is bounded by NOTHING — a stronger statement
        // than the 10s budget below and the one that is true: Prisma checks
        // that budget at statement boundaries, so it "cannot roll back a
        // statement already blocked inside Postgres, only refuse to start a
        // new one" (`db-locks.ts`). The mutation record measures it: removing
        // this line ends in a hung test, never a budget expiry.
        //
        // No `SELECT … FOR UPDATE` before the write, and no re-read. The gap
        // between this function's opening read and this write is not a
        // correctness problem: archiving only ever *leaves*
        // `StudioClassTemplate_teacher_slot_unique`'s partial scope
        // (`WHERE isArchived = false`), un-archiving re-enters it and the
        // index itself arbitrates, and every column the archive writes
        // (`isActive`, `isArchived`, `archivedAt`, `withdrawnCount`) is on the
        // forbidden list — so disjoint from anything this write touches.
        await setLockTimeout(tx);

        const updated = await tx.studioClassTemplate.update({
          where: { id: templateId },
          data,
        });

        return { ok: true, template: updated };
      },
      { timeout: 10_000 },
    );
  } catch (err) {
    // Transient first. `isTransientDbError` matches the SQLSTATE inside its
    // Postgres framing, and a lock timeout arrives as `55P03` wrapped in a
    // `PrismaClientUnknownRequestError` from a model write — the first of the
    // two shapes its docblock records.
    if (isTransientDbError(err)) {
      log.warn(
        { err, templateId, teacherId },
        'studio template edit lost the template lock race — nothing committed',
      );
      return { ok: false, reason: 'busy' };
    }

    // The read above and the write inside the transaction are not the same
    // statement, so a delete landing in the gap surfaces here as P2025.
    //
    // Defensive parity with the class family, NOT a bug fix: nothing in
    // production deletes a `StudioClassTemplate`. `deleteTeacherAccount`
    // (`gdpr.ts`) archives, there is no `DELETE` route, and the only reachable
    // path is the `Teacher` cascade, which takes the caller's own row with it.
    // Mapped anyway because `classifyApiError` has no P2025 branch and would
    // fall through to a bare 500 — see `isRecordNotFound`'s own docblock.
    //
    // Silent, unlike the two arms either side of it, and that asymmetry is
    // deliberate: this is the branch #231 calls "unreachable today", where a
    // future statement inside the transaction could turn a genuine bug into a
    // 404 leaving no trace. It stays silent only while this transaction holds
    // exactly one statement that can raise P2025. Add a second and log here.
    if (isRecordNotFound(err)) return { ok: false, reason: 'not_found' };

    // `dayOfWeek` and `startTime` are both teacher-editable and both in
    // `StudioClassTemplate_teacher_slot_unique` (#196), so an edit can move
    // this template onto a slot another of its owner's live templates holds.
    //
    // The log line is the point of catching rather than rethrowing. #231:
    // "`classifyApiError` logs this same P2002 at `warn` when it escapes;
    // catching it here must not be what removes that."
    if (isUniqueConflictOn(err, ['teacherId', 'dayOfWeek', 'startTime'])) {
      log.warn(
        { err, templateId, teacherId },
        'studio template edit refused by the slot index',
      );
      return { ok: false, reason: 'slot_conflict' };
    }

    throw err;
  }
}
```

Add `isRecordNotFound` to the existing `@/lib/api-errors` import at
`:38` — it currently reads `import { isTransientDbError } from '@/lib/api-errors';`
and becomes `import { isRecordNotFound, isTransientDbError } from '@/lib/api-errors';`.
`isUniqueConflictOn` and `setLockTimeout` are already imported (`:37`, `:39`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/services/studio-class-template-lifecycle.test.ts`

Expected: PASS, including every pre-existing case in the file. The new describe
adds 7.

- [ ] **Step 5: Commit**

```bash
git add src/services/studio-class-template-lifecycle.ts src/services/studio-class-template-lifecycle.test.ts
git commit -m "feat: updateStudioClassTemplate, with a bounded lock wait and two log lines #231 asks for (issue 114)"
```

---

### Task 4: The route becomes a thin wrapper

**Files:**
- Modify: `src/app/api/studio-class-templates/[id]/route.ts:33-73` (the `PUT`
  handler only — `GET` and `PATCH` unchanged)
- Test: `tests/integration/studio-api.test.ts`

**Interfaces:**
- Consumes: Task 3's `updateStudioClassTemplate` and
  `UpdateStudioClassTemplateResult`.
- Produces: no new exports.

**Requires the dev server on :3000.** Do not start it.

- [ ] **Step 1: Write the failing tests**

Add these to `tests/integration/studio-api.test.ts`, after the existing
`PUT … collides on the slot key (#196)` describe (ends `:361`).

```ts
describe('PUT /api/studio-class-templates/[id] — the teacher-editable boundary', () => {
  it('writes the edited fields and answers 200', async () => {
    const t = await makeTemplate(ownerId, 'Boundary Edit', '18:40');

    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${t.id}`, {
      classType: 'Boundary Edited',
      hourlyRate: 71,
    });
    expect(res.status).toBe(200);

    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.classType).toBe('Boundary Edited');
    expect(Number(after.hourlyRate)).toBe(71);
    expect(after.location).toBe('Community Studio');
  });

  // This is the runtime behaviour every compile-time pin's reasoning rests on:
  // an undeclared key is a 400, so the ONLY way a forbidden column reaches
  // Prisma is by being declared in the schema — a source edit, which the pins
  // in studio-class-template-lifecycle.ts catch. If this test ever fails, the
  // pins are guarding the wrong thing. Ported from the class family's twin in
  // class-templates-api.test.ts, which the studio family never had (#114).
  it('rejects an undeclared key — the schema is strict', async () => {
    const t = await makeTemplate(ownerId, 'Strict Studio Flow', '18:41');

    const res = await send('PUT', ownerToken, `/api/studio-class-templates/${t.id}`, {
      classType: 'Renamed',
      isActive: false,
    });
    expect(res.status).toBe(400);

    // Rejected whole: the declared field is not written either.
    const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
    expect(after.classType).toBe('Strict Studio Flow');
    expect(after.isActive).toBe(true);
  });

  it(
    'answers 503 STUDIO_TEMPLATE_BUSY when an edit loses the row, and changes nothing',
    async () => {
      const t = await makeTemplate(ownerId, 'Busy Studio Edit', '18:42');

      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const settled = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM "StudioClassTemplate" WHERE id = ${t.id} FOR UPDATE`;
          await held;
        },
        { timeout: 15_000 },
      );
      await new Promise((r) => setTimeout(r, 100));

      try {
        const res = await send('PUT', ownerToken, `/api/studio-class-templates/${t.id}`, {
          classType: 'Blocked Edit',
        });

        expect(res.status).toBe(503);
        const json = (await res.json()) as { error: { code: string; message: string } };
        expect(json.error.code).toBe('STUDIO_TEMPLATE_BUSY');
        expect(json.error.message).toContain('could not edit this recurring studio class');
        expect(json.error.message).toContain('Nothing was changed.');

        const after = await prisma.studioClassTemplate.findUniqueOrThrow({ where: { id: t.id } });
        expect(after.classType).toBe('Busy Studio Edit');
      } finally {
        release();
        await settled.catch(() => {});
      }
    },
    20_000,
  );
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts -t "teacher-editable boundary"`

Expected: the 200 case PASSES already (the route works today), the strict case
PASSES already (`.strict()` is already on the schema), and the **503 case FAILS**
— today's `PUT` has no bound, so it blocks until the holder releases and then
answers 200. It will fail on the 20s test timeout, not on a status mismatch.

Only one of the three is red, and that is expected. The other two are
characterization tests: they exist to go red if Task 4's rewrite drifts, which
is a thing they can only do by being written before it.

- [ ] **Step 3: Rewrite the PUT handler**

Replace `src/app/api/studio-class-templates/[id]/route.ts:33-73` entirely with:

```ts
export const PUT = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // Parsed before the exists/ownership checks, because the service owns those
  // and needs typed data to be called at all. So a malformed body against
  // another teacher's template is now a 400 where it used to be a 403 — the
  // same reordering `class-templates/[id]` accepted for the same reason, and
  // not an information leak: the cheap probe is `{}`, which parses fine and
  // still yields 403 (pinned by the ownership case in `studio-api.test.ts`).
  // This ordering tells a prober strictly less, not more.
  const parsed = await parseBody(request, updateStudioClassTemplateSchema);
  if ('error' in parsed) return parsed.error;

  // Annotated for insurance, not for wiring: `parsed.data` already has this
  // type. It would start earning its keep if `StudioClassTemplateUpdateData`
  // ever stops being a bare `z.infer` of the schema. Left at that type rather
  // than widened to `updateStudioClassTemplate`'s actual, narrower parameter
  // type — the allowlist intersected with the forbidden-field exclusions. That
  // narrowing holds only because the schema declares none of the forbidden
  // keys, which is exactly what the pins in `studio-class-template-lifecycle.ts`
  // already enforce; restating it here would duplicate a check that has an owner.
  const data: StudioClassTemplateUpdateData = parsed.data;

  const result = await updateStudioClassTemplate(prisma, id, session.teacherId, data);

  if (result.ok) return respondOk(result.template);

  // Narrowed one reason at a time so each maps to the response this route
  // returned before the service existed.
  if (result.reason === 'not_found') return respondError('Studio class template not found', 404);
  if (result.reason === 'forbidden') return respondError('Access denied', 403);
  if (result.reason === 'no_fields') return respondError('No valid fields to update', 400);
  // `StudioClassTemplate_teacher_slot_unique` is (teacherId, dayOfWeek,
  // startTime) WHERE isArchived = false (#196). This route never touches
  // `isArchived` — `PATCH` owns that, and the forbidden list makes it a compile
  // error here — but `dayOfWeek`/`startTime` are both teacher-editable, so a
  // plain edit into a slot another of this teacher's live templates already
  // holds collides.
  if (result.reason === 'slot_conflict') {
    return respondError(
      'You already have a recurring studio class on that day at that time.',
      409,
      'DUPLICATE_STUDIO_TEMPLATE_SLOT',
    );
  }
  if (result.reason === 'busy') {
    return respondError(
      'The system was busy and could not edit this recurring studio class. Nothing was changed. Wait a moment, then try again.',
      503,
      'STUDIO_TEMPLATE_BUSY',
    );
  }

  // Exhaustiveness: a new UpdateStudioClassTemplateResult reason becomes a
  // compile error here rather than being silently answered with the wrong
  // status. The success half gets no `switch`, unlike PATCH's below: that
  // result carries an `action` discriminant with three arms, this one is a
  // single variant with nothing to switch on, and inventing a discriminant to
  // match the shape would be ceremony.
  const unhandled: never = result;
  return unhandled;
});
```

Then fix the imports at the top of the file:

- `updateStudioClassTemplateSchema` is already imported at `:11`. Leave it.
- Extend the service import at `:12-15` to:

```ts
import {
  updateStudioClassTemplate,
  type StudioClassTemplateUpdateData,
  pauseOrResumeStudioTemplate,
  archiveOrUnarchiveStudioTemplate,
} from '@/services/studio-class-template-lifecycle';
```

- **Delete** `import { isUniqueConflictOn } from '@/lib/unique-conflict';` at
  `:16`. The service owns that mapping now, and lint will fail on the unused
  import if you leave it.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`

Expected: PASS, all cases. **The four pre-existing `PUT` cases must be green
without being edited** — `:305` (403 for another teacher), `:328` (404),
`:337` (empty PUT is 400), `:348` (slot collision 409). If any of them needs an
edit to pass, the extraction drifted; stop and report which one and why rather
than adjusting the test.

- [ ] **Step 5: Commit**

```bash
git add 'src/app/api/studio-class-templates/[id]/route.ts' tests/integration/studio-api.test.ts
git commit -m "refactor: studio template PUT becomes a thin wrapper, with a 503 it could not answer before (issue 114)"
```

---

### Task 5: Widen the runtime register, and fix the stale docblock

**Files:**
- Modify: `src/lib/schemas.test.ts:362-368` and `:439-461`
- Modify: `src/services/class-template-lifecycle.ts:6`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Widen `SERVER_OWNED_FIELDS`**

At `src/lib/schemas.test.ts:362-368`, add three names in alphabetical position
and a comment above the array's closing bracket:

```ts
const SERVER_OWNED_FIELDS = [
  'accountId', 'archivedAt', 'cancelledAt', 'claimedAt', 'createdAt',
  'createdById', 'effectiveTeacherRate', 'id', 'isActive', 'isArchived',
  'isPublic', 'paidAt', 'photoUrl', 'settingsLocked', 'status', 'studentId',
  'teacherId', 'templateId', 'tierAtBooking', 'tierSelectedAt', 'totalRevenue',
  'totalStudents', 'updatedAt', 'withdrawnCount',
] as const;
```

Then replace the roster assertion's expected array at `:439-461` with this
exact list. Both sides of that assertion are `.sort()`ed, so the order below is
load-bearing — it is JS lexicographic order, in which `createdAt` precedes
`createdById` (`A` < `B`) and `isActive` precedes `isArchived` (`c` < `r`):

```ts
    expect([...SERVER_OWNED_FIELDS].sort()).toEqual([
      'accountId',
      'archivedAt',
      'cancelledAt',
      'claimedAt',
      'createdAt',
      'createdById',
      'effectiveTeacherRate',
      'id',
      'isActive',
      'isArchived',
      'isPublic',
      'paidAt',
      'photoUrl',
      'settingsLocked',
      'status',
      'studentId',
      'teacherId',
      'templateId',
      'tierAtBooking',
      'tierSelectedAt',
      'totalRevenue',
      'totalStudents',
      'updatedAt',
      'withdrawnCount',
    ]);
```

Then append this paragraph to the end of the existing docblock above
`const SERVER_OWNED_FIELDS` — the one whose last paragraph starts
"Curation:" — keeping it inside the same `/** … */`:

```
 * `isActive`, `createdAt` and `updatedAt` were added by #114. `isActive` is the
 * one with teeth: it exists on exactly two models (`ClassTemplate`,
 * `StudioClassTemplate`), and on both a plain `PUT` flipping it would bypass
 * the transaction-and-generate path `PATCH` owns. Both template families now
 * also refuse it at compile time, so this is the generalisation — it covers
 * every schema in the repo, including ones nobody has written yet. Measured
 * when added: no exported schema declared any of the three, so none needed an
 * EXPECTED entry.
```

- [ ] **Step 2: Run the register and prove it bites**

Run: `npx vitest run --project unit src/lib/schemas.test.ts -t "server-owned fields"`
Expected: 2 passed.

Passing on arrival proves nothing, so prove it: temporarily add
`isActive: z.boolean().optional(),` to `updateStudioClassTemplateSchema`
(`src/lib/schemas.ts:454-461`). Re-run and record **both** failures — the
register naming `updateStudioClassTemplateSchema`, and `npm run typecheck`
naming `_studioTemplateFieldsArePermitted`. Two independent layers catching the
same edit is the point of this branch; record both texts.

**Remove the line and re-run both to green before continuing.**

- [ ] **Step 3: Fix the stale docblock**

`src/services/class-template-lifecycle.ts:6` reads:

```
 * over), with the same five pins. Three things deliberately differ, and are
```

Replace with:

```
 * over), with the same six pins. Three things deliberately differ, and are
```

Measured, not counted from memory:
`grep -c "const _class[A-Za-z]*: NoneOf\|const _allowlist[A-Za-z]*: NoneOf\|const _forbidden[A-Za-z]*: NoneOf" src/services/class-lifecycle.ts`
returns 6, and the same shape over `class-template-lifecycle.ts` returns 6.
`class-lifecycle.ts` itself makes no pin-count claim and is not edited.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npx vitest run --project unit src/lib/schemas.test.ts`
Expected: all exit 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/schemas.test.ts src/services/class-template-lifecycle.ts
git commit -m "test: isActive into the server-owned register, and the pin count the docblock got wrong (issue 114)"
```

---

### Task 6: Prove every pin bites

**Files:**
- Create: `docs/superpowers/plans/2026-08-20-studio-template-forbidden-pins-mutations.md`

**Interfaces:**
- Consumes: everything built above.
- Produces: the mutation record the PR body cites.

A pin that compiles but cannot fail certifies nothing. Each mutation below is
applied, the **exact** error text recorded verbatim, then reverted, then the
suite re-run to green. Record a reverted-and-green line per mutation; a
mutation left in place is how a branch ships red.

**Mutation values must be ones the code under test cannot produce.** Every
mutation below uses either a real forbidden column name or the literal
`notAColumn` / `publishedAt`, none of which the schema or the model contains.

- [ ] **Step 1: Run mutations 1–5 (the schema/allowlist pins)**

| # | Mutation | Must fire |
|---|---|---|
| 1 | add `isActive: z.boolean().optional(),` to `updateStudioClassTemplateSchema` | `_studioTemplateFieldsArePermitted` **and** the `server-owned fields` register |
| 2 | keep #1 **and** add `\| 'isActive'` to `TeacherEditableStudioTemplateField` | `_studioTemplateAllowlistHasNoForbiddenFields` (the reflexive repair) |
| 3 | add `notAColumn: z.string().optional(),` to the schema **and** `\| 'notAColumn'` to the allowlist | `_studioTemplateUpdateColumnsExist`, and only it |
| 4 | delete `\| 'location'` from `TeacherEditableStudioTemplateField` | `_studioTemplateFieldsArePermitted` **and** `_studioTemplateListsPartitionTheModel` — the one mutation that trips two, because the allowlist is in both |
| 5 | delete `location:` from the schema, leaving it on the allowlist | `_studioTemplateAllowlistHasNoStaleFields`, and only it |

For each: apply, run `npm run typecheck` (and for #1 also
`npx vitest run --project unit src/lib/schemas.test.ts`), paste the error
verbatim into the record, revert, re-run to exit 0.

- [ ] **Step 2: Run mutations 6–8 (the two forbidden-list pins)**

| # | Mutation | Must fire |
|---|---|---|
| 6 | typo `\| 'isActive'` → `\| 'isActiv'` in `PlainUpdateForbiddenStudioTemplateField` | `_studioTemplateForbiddenColumnsExist` (names `isActiv`) **and** `_studioTemplateListsPartitionTheModel` (names `isActive`) |
| 7 | delete `\| 'updatedAt'` from `PlainUpdateForbiddenStudioTemplateField` | `_studioTemplateListsPartitionTheModel`, and only it |
| 8 | change the partition pin's reference to `keyof (Prisma.StudioClassTemplateUncheckedUpdateManyInput & { publishedAt?: Date \| null })`, simulating a migration | `_studioTemplateListsPartitionTheModel`, naming `publishedAt` |

Mutation 7 is the pair's left half and mutation 8 the right, and together they
are the evidence for the spec's claim that this pin is stronger than the class
family's. **While mutation 8 is applied, also confirm the class family's
`_templateForbiddenListIsComplete` form stays green under the same simulation**
— apply the same `& { publishedAt?: Date | null }` to a local copy of its
`Exclude` and record that `tsc` still exits 0. That contrast is the whole claim;
recording only half of it proves nothing.

- [ ] **Step 3: Run mutations 9–11 (the intersection, the bound, the route)**

| # | Mutation | Must fire |
|---|---|---|
| 9 | add, then delete, a temporary call site: `const patch = { classType: 'Yin', isActive: true }; void updateStudioClassTemplate(prisma, 'x', 'y', patch);` | a `tsc` error on `isActive` — this is the excess-property bypass the intersection exists to close, and a fresh object literal would **not** prove it |
| 10 | delete `await setLockTimeout(tx);` from `updateStudioClassTemplate` | the `busy` unit test dies on its own 20s timeout, **not** a budget expiry — record which |
| 11 | in the route, change `if (result.reason === 'busy')` to `if (result.reason === 'no_fields')` (a duplicated branch) | the `const unhandled: never = result` guard, naming `busy` |

Mutation 9 is the one that must be written as a **variable**, not a literal.
A literal trips excess-property checking, which is present with or without the
intersection, so a literal would pass whether or not the intersection exists —
the exact "guard that cannot fail" this project keeps shipping.

- [ ] **Step 4: Write the record**

`docs/superpowers/plans/2026-08-20-studio-template-forbidden-pins-mutations.md`,
one section per mutation: what was changed (with the diff), the verbatim error,
the revert, and the re-run to green. Then a closing paragraph naming any
mutation that did **not** fire as expected and what that means.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/plans/2026-08-20-studio-template-forbidden-pins-mutations.md
git commit -m "docs: eleven mutations, and the contrast that proves the partition pin (issue 114)"
```

---

### Task 7: Whole-branch verification

**Files:** none changed unless verification finds something.

- [ ] **Step 1: Run the full suite**

Run: `npm run verify`

Expected: exit 0. Typecheck, lint, and all three vitest projects.
Requires the dev server on :3000 — a wall of `ECONNREFUSED` means it is down;
**ask the user rather than starting it.**

- [ ] **Step 2: Re-measure, do not predict**

```bash
for p in unit components integration; do
  echo -n "$p: "
  npx vitest run --project $p --reporter=dot 2>&1 | grep -E "^ *(Test Files|Tests) " | tr '\n' ' '
  echo
done
```

Record files and tests per project with totals that reconcile. The baseline was
`63/937 + 41/242 + 31/440 = 135/1619`. This branch adds files to none of the
three, and adds tests to three files: `schemas.test.ts` (+1),
`studio-class-template-lifecycle.test.ts` (+7),
`studio-api.test.ts` (+3). **Predicted `135 / 1630` — measure it anyway.** A
review wave can add tests a prediction could not have known about; #212's
handover predicted 1294 and measured 1296.

- [ ] **Step 3: Confirm the untouched-test claim**

```bash
git diff main --stat -- tests/integration/studio-api.test.ts
```

The four pre-existing `PUT` cases must appear as context, not as changes. If the
diff shows an edit inside any of them, that is a behaviour drift the PR body
must name explicitly rather than a tidy-up.

- [ ] **Step 4: Report**

Do not commit. Report the measured figures, the reconciliation arithmetic, and
anything that differed from this plan's predictions.

---

## Out of scope for this branch

Named so nobody folds them in mid-task. All four are **unaffected** by this work
and stay open:

- **#194** — studio template edits leave classes on the superseded weekday.
  Two open product decisions; this branch builds the seam it will attach to.
- **#228** — moving both template *creates* into services.
- **#231** — the four existing template-lifecycle sites that log nothing. The
  new function is written compliant; the existing ones are not changed.
- **Retrofitting `_templateForbiddenListIsComplete` / `_classForbiddenListIsComplete`
  to the partition form.** Filed as its own leaf issue, citing the spec's
  section A.
