# Teacher-Editable Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop a `Class` column that a teacher must not edit (`status`,
`teacherId`, `settingsLocked`, the financial totals) from silently becoming
writable through `PUT /api/classes/[id]` if a future contributor adds it to
`updateClassSchema` (issue #79).

**Architecture:** Two compile-time type pins over `ClassUpdateData`, beside the
existing `ClassUpdateColumnsExist` pin in `src/services/class-lifecycle.ts`, and
a hand-maintained `TEACHER_EDITABLE_CLASS_FIELDS` allowlist they check against.
Type-level only — no runtime code, no route change, no new dependency.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess: true`), verified
with `npx tsc --noEmit`.

## Global Constraints

- **Type-level only.** No runtime code path changes, no route edits, no new
  Vitest file. The allowlist array is consumed solely by the two pins.
- **No `any`, no casts.** `strict: true` throughout.
- Follow the existing `ClassUpdateColumnsExist` pin's idiom exactly: tuple-wrapped
  `[X] extends [never] ? true : X`, a `void`-suppressed const, doc comments.
- The pins must **name the offending field** on failure — a pin that resolves to
  a bare boolean is useless. This is verified, not assumed.
- `TEACHER_EDITABLE_CLASS_FIELDS` is deliberately hand-maintained: it is an
  authorization boundary, and permission is a decision, not something derived.

---

### Task 1: Add the allowlist and the two bidirectional pins

**Files:**
- Modify: `src/services/class-lifecycle.ts` (insert after the existing
  `_classUpdateDataMatchesSchema` block, currently ending at line 272)

**Interfaces:**
- Consumes: `ClassUpdateData` (already declared just above, at line 239) and its
  `keyof`. Nothing else.
- Produces: `TEACHER_EDITABLE_CLASS_FIELDS` and `TeacherEditableClassField` —
  used only within this file, by the two pins.

The insertion point is immediately after line 272
(`void _classUpdateDataMatchesSchema;`) and before the `/** Thrown when
updateClass reaches... */` block that begins the `UpdateClassInvariantError`
declaration at line 274. Do not disturb the existing column pin above it.

- [ ] **Step 1: Baseline — confirm the tree is green before touching it**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0, no output. (If not, stop — something is wrong before this task
begins.)

- [ ] **Step 2: Insert the allowlist and both pins**

Insert exactly this block after line 272 (`void _classUpdateDataMatchesSchema;`),
separated by one blank line:

```ts

/**
 * The fields a teacher may change on their own class via `PUT /api/classes/[id]`.
 *
 * This is an authorization boundary, not a field list for convenience: adding
 * an entry grants write access to a `Class` column that may be gated by
 * business logic the plain update path does not run. Before adding one, check
 * what else guards that column —
 *   - `status`             → the lifecycle state machine (`VALID_TRANSITIONS`)
 *   - `settingsLocked`     → the economic lock (this very function)
 *   - `teacherId`          → class ownership
 *   - the financial totals → set only by `completeClass`'s pricing run
 * — because the compiler will not.
 */
const TEACHER_EDITABLE_CLASS_FIELDS = [
  'classType',
  'description',
  'date',
  'startTime',
  'durationMinutes',
  'roomCost',
  'minRate',
  'targetRate',
  'minStudents',
  'maxStudents',
] as const;

type TeacherEditableClassField = (typeof TEACHER_EDITABLE_CLASS_FIELDS)[number];

/**
 * Compile-time pin (forward): every field `updateClassSchema` accepts must be
 * on the teacher-editable allowlist. Add a column-shaped field to the schema
 * without adding it to the allowlist and this resolves to that field's name
 * instead of `true`, failing the build with the field named. This is the guard
 * the column pin above does NOT provide — it proves a field is *permitted*, not
 * merely that it is a real, writable column. See issue #79 for the `status`
 * bypass this closes.
 */
type UnpermittedClassFields = Exclude<keyof ClassUpdateData, TeacherEditableClassField>;
type ClassUpdateFieldsArePermitted = [UnpermittedClassFields] extends [never]
  ? true
  : UnpermittedClassFields;
const _classUpdateFieldsArePermitted: ClassUpdateFieldsArePermitted = true;
void _classUpdateFieldsArePermitted;

/**
 * Compile-time pin (reverse): every allowlist entry must still be a field the
 * schema accepts. Remove a field from `updateClassSchema` but leave it on the
 * allowlist and this names the stale entry, so the list can't rot into granting
 * permission for a column that no longer flows through this route.
 */
type StaleAllowlistFields = Exclude<TeacherEditableClassField, keyof ClassUpdateData>;
type AllowlistHasNoStaleFields = [StaleAllowlistFields] extends [never]
  ? true
  : StaleAllowlistFields;
const _allowlistHasNoStaleFields: AllowlistHasNoStaleFields = true;
void _allowlistHasNoStaleFields;
```

- [ ] **Step 3: Confirm the current schema is in agreement (baseline still green)**

Run: `npx tsc --noEmit && npx eslint src tests`
Expected: exit 0, no output. Both new pins resolve to `true` because
`updateClassSchema`'s ten fields and `TEACHER_EDITABLE_CLASS_FIELDS` are exactly
equal today. If this fails, the allowlist and the schema already disagree —
reconcile before continuing, and note which side was wrong in your report.

- [ ] **Step 4: Commit**

```bash
git add src/services/class-lifecycle.ts
git commit -m "feat: pin the fields a teacher may edit on a class, not just that they are columns (#79)"
```

---

### Task 2: Prove both pins have teeth (reverted mutation)

**Files:**
- Temporarily modify (and revert — **never commit**): `src/lib/schemas.ts` and
  `src/services/class-lifecycle.ts`.

**Interfaces:**
- Consumes: the pins from Task 1.
- Produces: nothing — the deliverable is evidence, reported in full.

A pin that never fails is indistinguishable from no pin. The spec's central
claims are "adding `status` fails naming `status`" and "removing a list entry
fails naming it". Both were checked against `tsc` on stand-in types while
writing the spec; this task confirms they hold against the **real**
`ClassUpdateData` and `updateClassSchema`, then reverts.

- [ ] **Step 1: Forward pin — add a dangerous field to the schema**

In `src/lib/schemas.ts`, inside `updateClassSchema`'s object, add one line after
`classType: z.string().min(1).optional(),`:

```ts
  status: z.enum(['draft', 'open', 'in_progress', 'completed', 'cancelled']).optional(),
```

Run: `npx tsc --noEmit`
Expected: **FAIL**, and the error must **name `status`** — e.g.
`Type 'true' is not assignable to type '"status"'` at the
`_classUpdateFieldsArePermitted` assignment in `class-lifecycle.ts`. The existing
column pin must NOT fire (`status` is a real column), so the *only* failure is
the new forward pin. Record the exact error text.

If the build passes, or fails only on the column pin, or names something other
than `status` — stop and report. The forward pin does not work as designed.

- [ ] **Step 2: Revert the schema**

```bash
git checkout -- src/lib/schemas.ts
```

Run: `git status --short src/lib/schemas.ts`
Expected: empty output.

- [ ] **Step 3: Reverse pin — remove a field from the allowlist**

In `src/services/class-lifecycle.ts`, delete the `'description',` line from
`TEACHER_EDITABLE_CLASS_FIELDS` (leaving `description` in the schema).

Run: `npx tsc --noEmit`
Expected: **FAIL**, and the error must **name `description`** — e.g.
`Type 'true' is not assignable to type '"description"'` at the
`_classUpdateFieldsArePermitted` assignment (the *forward* pin fires here:
`description` is now a schema field with no allowlist entry). Record the exact
error text.

This single mutation exercises the forward pin from the allowlist side. To
exercise the **reverse** pin specifically, do Step 4.

- [ ] **Step 4: Revert, then mutate for the reverse pin**

```bash
git checkout -- src/services/class-lifecycle.ts
```

Now add a stale entry that is NOT a schema field — insert `'notAField',` into
`TEACHER_EDITABLE_CLASS_FIELDS`:

```ts
  'maxStudents',
  'notAField',
] as const;
```

Run: `npx tsc --noEmit`
Expected: **FAIL** naming `notAField` — e.g.
`Type 'true' is not assignable to type '"notAField"'` at the
`_allowlistHasNoStaleFields` assignment (the *reverse* pin). Record the exact
error text. This is the case only the reverse pin catches — the forward pin is
blind to an allowlist entry that isn't a schema field.

- [ ] **Step 5: Revert and prove the tree is clean**

```bash
git checkout -- src/services/class-lifecycle.ts
```

Run: `git status --short src/`
Expected: **empty**. If anything remains under `src/`, a mutation was not
reverted — stop and report. No commit in this plan may carry a mutation.

- [ ] **Step 6: Final gate on the reverted tree**

```bash
npx tsc --noEmit && npx eslint src tests
npx vitest run --project unit
```

Expected: tsc and eslint exit 0; the unit project green (this is a type-level
change, so no test behaviour shifts). Running the integration project is
optional here — nothing in it exercises type-level pins — but if you do,
`signup-api.test.ts` may 429 from the local limiter; that is unrelated.

- [ ] **Step 7: Report the mutation evidence**

Nothing to commit in this task. In your report, quote verbatim:
- the Step 1 failure (forward pin, `status`),
- the Step 3 failure (forward pin from the allowlist side, `description`),
- the Step 4 failure (reverse pin, `notAField`),
- the Step 5 `git status` output.

---

### Task 3: Push and open the PR

- [ ] **Step 1: Push**

```bash
git push -u origin feat/teacher-editable-allowlist
```

- [ ] **Step 2: Open the PR** — closes #79:

```bash
gh pr create --title "feat: allowlist the fields a teacher may edit on a class (#79)" --body "$(cat <<'BODY'
Closes #79. Spec: `docs/superpowers/specs/2026-07-25-teacher-editable-allowlist-design.md`

## The gap
PR #78 added a compile-time pin asserting every field `updateClassSchema` accepts is a real, writable `Class` column. That proves **"this is a real column"** — not **"a teacher may edit it."** Different invariants.

Demonstrated in that PR's re-review: adding `status: z.enum([...]).optional()` to `updateClassSchema` **alone** compiles clean. `.strict()` accepts the now-declared key, the column pin accepts a genuine column, and it reaches `updateMany` — letting a teacher flip a class straight to `completed`, bypassing `VALID_TRANSITIONS` and `completeClass`'s pricing → payment → notification pipeline. Same shape for `teacherId`, `settingsLocked`, and the financial totals.

Nothing is exploitable today; this closes what the guard **permits the next contributor to add without a signal.**

## The fix
A hand-maintained `TEACHER_EDITABLE_CLASS_FIELDS` allowlist — deliberately hand-maintained, because permission is a decision, not something to derive — plus two compile-time pins over `ClassUpdateData`:

- **forward**: a schema field not on the allowlist fails the build, naming it;
- **reverse**: a stale allowlist entry (field removed from the schema) fails the build, naming it.

Adding `status` now fails with `status` named, and the contributor has to consciously add it to an allowlist whose comment says what they're granting.

## Purely compile-time, on purpose
`updateClassSchema` is `.strict()`, so an undeclared key is already a 400 at runtime. The only way a dangerous field reaches `updateMany` is by being *declared* in the schema — a source edit, caught at compile time. A behavioural test can't express the threat without first making that edit. A runtime agreement test was declined: `updateClassSchema` is a `ZodEffects` (two `.refine`s), so reading its key-set at runtime means reaching into zod internals — a fragile check, the exact failure mode this route's history kept hitting. The bidirectional compile pins cover both drift directions without it.

## Verified by reverted mutation
Each pin was proven to fail in the right direction and name the offender: `status` added to the schema → forward pin names `status`; a stale `notAField` on the list → reverse pin names `notAField`. Both reverted; `git status` clean. tsc + eslint clean, unit project green.

Type-level only — no runtime code, no route change, no new dependency.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 3: Report the PR URL. Do NOT merge.**

---

## Self-Review

**Spec coverage:** the allowlist → Task 1 Step 2; the forward pin (security
direction) → Task 1 Step 2, verified Task 2 Steps 1/3; the reverse pin (hygiene
direction) → Task 1 Step 2, verified Task 2 Step 4; "purely compile-time / no
runtime test" → Global Constraints and the PR body; the four mutation checks from
the spec's Testing section → Task 2 (the spec's checks 2–4 map to Task 2 Steps
1, 3, 4; baseline is Task 1 Step 3). The spec's "out of scope" items need no
task.

**Placeholder scan:** none. Every step carries literal code or an exact command
with expected output. Both failure branches in Task 2 (pin passes / names the
wrong thing) say to stop and report rather than improvise.

**Type consistency:** `TEACHER_EDITABLE_CLASS_FIELDS`, `TeacherEditableClassField`,
`UnpermittedClassFields`, `ClassUpdateFieldsArePermitted`,
`StaleAllowlistFields`, `AllowlistHasNoStaleFields`, and the two const names
(`_classUpdateFieldsArePermitted`, `_allowlistHasNoStaleFields`) are spelled
identically wherever they appear. They do not collide with the existing pin's
names (`UnwritableClassFields`, `ClassUpdateColumnsExist`,
`_classUpdateDataMatchesSchema`). `ClassUpdateData` is consumed, not
redeclared.
