# A teacher-editable allowlist for `PUT /api/classes/[id]`

**Date:** 2026-07-25
**Status:** Approved (issue #79; scope agreed with Ivo — bidirectional
compile-time pins, no runtime test)

## Problem

PR #78 added a compile-time pin over `ClassUpdateData` (the type the class-PUT
route hands to `updateMany`) asserting every field the wire schema accepts is a
real, writable `Class` column. That pin proves **"this is a real column."** It
does not prove **"a teacher may edit this column"** — and those are different
invariants.

`Class` has columns a teacher must never write through a plain field update:

- `status` — flipping it directly bypasses `VALID_TRANSITIONS`,
  `validateTransition`, and `completeClass`'s pricing → payment → notification
  pipeline. The codebase already names this hazard for the sibling schema
  (`src/lib/schemas.ts`, on `transitionClassSchema`: *"'completed' is
  deliberately absent... A bare status flip would silently skip billing"*).
- `teacherId` — reassign another teacher's class to yourself.
- `settingsLocked` — unlock economics after students booked at a tier.
- `effectiveTeacherRate`, `totalStudents`, `totalRevenue` — rewrite a completed
  class's financial record.

Demonstrated during the PR #78 re-review: adding `status:
z.enum([...]).optional()` to `updateClassSchema` **alone** compiles clean.
`.strict()` accepts it (the key is now declared), the existing pin accepts it
(`status` is a genuine column), and it reaches `updateMany`.

Nothing is exploitable today — no such field is in the schema. This closes what
the guard **permits the next contributor to add without any signal.**

## Why the guard is purely compile-time

`updateClassSchema` is `.strict()`, so an undeclared key is rejected at parse
time with a 400. The only way a dangerous field reaches `updateMany` is by
being **declared in the schema** — a source change. There is no runtime
scenario to defend that doesn't begin with editing the schema, so a behavioural
test cannot express the threat: to write "a `status` field is rejected" you
would first have to add `status` to the schema, at which point the design
decision has already been made consciously. The guard belongs at compile time,
where the schema edit happens.

## Design

In `src/services/class-lifecycle.ts`, beside the existing
`ClassUpdateColumnsExist` pin, add the allowlist and two pins.

### The allowlist

```ts
/**
 * The fields a teacher may change on their own class via `PUT /api/classes/[id]`.
 *
 * This is an authorization boundary, not a field list for convenience: adding
 * an entry grants write access to a `Class` column that may be gated by
 * business logic the plain update path does not run. Before adding one, check
 * what else guards that column —
 *   - `status`         → the lifecycle state machine (`VALID_TRANSITIONS`)
 *   - `settingsLocked`  → the economic lock (this very function)
 *   - `teacherId`       → class ownership
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
```

### Forward pin — no schema field escapes the allowlist (the security direction)

```ts
/**
 * Compile-time pin: every field `updateClassSchema` accepts must be on the
 * teacher-editable allowlist. Add a column-shaped field to the schema without
 * adding it to the allowlist and this resolves to that field's name instead of
 * `true`, failing the build with the field named. This is the guard the
 * existing column pin does not provide — it proves a field is *permitted*, not
 * merely that it is a real column.
 */
type UnpermittedClassFields = Exclude<keyof ClassUpdateData, TeacherEditableClassField>;
type ClassUpdateFieldsArePermitted = [UnpermittedClassFields] extends [never]
  ? true
  : UnpermittedClassFields;
const _classUpdateFieldsArePermitted: ClassUpdateFieldsArePermitted = true;
void _classUpdateFieldsArePermitted;
```

### Reverse pin — no dead allowlist entry (the hygiene direction)

```ts
/**
 * Compile-time pin: every allowlist entry must still be a field the schema
 * accepts. Remove a field from `updateClassSchema` but leave it on the
 * allowlist and this names the stale entry, so the allowlist can't rot into
 * granting permissions for columns that no longer flow through this route.
 */
type StaleAllowlistFields = Exclude<TeacherEditableClassField, keyof ClassUpdateData>;
type AllowlistHasNoStaleFields = [StaleAllowlistFields] extends [never]
  ? true
  : StaleAllowlistFields;
const _allowlistHasNoStaleFields: AllowlistHasNoStaleFields = true;
void _allowlistHasNoStaleFields;
```

Both use the tuple-wrapped `[X] extends [never]` idiom already established in
this file — kept for consistency and for the day the check becomes generic, not
because distribution matters on a concrete alias (measured: it does not).

`void` on each const because this repo's eslint `no-unused-vars` has no
`varsIgnorePattern`; the consts exist only to force the conditional types to
evaluate.

### Nothing else changes

No route change, no runtime code, no new dependency. The allowlist array is
consumed only by the two type-level pins.

## Testing

**Compile-time is the test.** The pins are the guard and the assertion at once;
there is no reachable runtime behaviour to exercise (see "Why the guard is
purely compile-time").

Verification is by deliberate, reverted mutation — proving each pin fails in the
right direction and names the offender, since a pin that never fails is
indistinguishable from no pin:

1. **Baseline** — `tsc --noEmit` exits 0.
2. **Forward, single** — add `status: z.enum([...]).optional()` to
   `updateClassSchema`. Build must fail naming `status`. Revert.
3. **Forward, unrelated** — add a plainly non-editable field
   (`teacherId: z.string().optional()`). Build must fail naming `teacherId`.
   Revert.
4. **Reverse** — remove `description` from the allowlist. Build must fail naming
   `description`. Revert.

No new Vitest test file. A runtime agreement test was considered and declined:
`updateClassSchema` is a `ZodEffects` (two `.refine` calls), so reading its
key-set at runtime means reaching past `.refine` into zod's internal
representation — a fragile check whose own correctness would need continual
re-verification, the exact failure mode this route's history kept hitting. The
bidirectional compile pins cover both drift directions without it.

> **Retracted 2026-07-25 in review — both sentences above are wrong.** See
> "Correction 2: the runtime test was declined on false grounds" below. The
> agreement test shipped.

## Out of scope

- **Making `status` editable through any route.** Status changes go through
  `POST /api/classes/[id]/transition` and `/complete`, deliberately. This spec
  only stops a *silent* grant; a conscious one (adding to both schema and
  allowlist) remains the contributor's call, which is the point.
- **The other pins from PR #78.** The column-existence pin and the
  non-empty-tuple guarantee stay as they are.

## Verification

`tsc` + `eslint` clean; the unit and integration projects green (the change is
type-level only, so no test behaviour shifts). The four mutation checks above
each produce the named-field failure and revert cleanly.

## Correction (2026-07-25, from implementation)

The allowlist above is written as a `const TEACHER_EDITABLE_CLASS_FIELDS = [...] as const` array with a `typeof …[number]` alias. Building it revealed that form earns an eslint `no-unused-vars` warning: nothing reads the array at runtime — the schema's `.strict()` already rejects undeclared keys — so its only reference is the `typeof` query, and the fix would be a `void` suppression like the assertion consts use.

That suppression papers over the real point: this is a compile-time-only authorization boundary, so it should be a **type**, not a runtime value pretending to be used. Shipped as a direct union instead —

```ts
type TeacherEditableClassField =
  | 'classType' | 'description' | 'date' | 'startTime' | 'durationMinutes'
  | 'roomCost' | 'minRate' | 'targetRate' | 'minStudents' | 'maxStudents';
```

— which drives both pins identically (each still names the offending field), needs no suppression, and does not falsely echo `ECONOMIC_FIELDS`' frozen-array form when, unlike that constant, nothing iterates it. The two pins are otherwise exactly as specified.

## Correction 2 (2026-07-25, from PR review)

Three claims in this spec were wrong. They are corrected here rather than
deleted, because the reasoning that produced them is the kind worth being able
to recognise later.

### The `ZodEffects` justification was false for this repo

The Testing section declined a runtime agreement test on the grounds that
`updateClassSchema` is a `ZodEffects` whose key-set is reachable only through
zod internals. **That describes zod v3.** This project is on zod **4.4.3**,
where `ZodEffects` does not exist (`'ZodEffects' in z === false`), `.refine()`
returns the same `ZodObject`, and `.shape` is public API. Measured: the schema's
constructor is `ZodObject`, `Object.keys(updateClassSchema.shape)` returns the
ten field names, and it typechecks under `strict: true` with **no cast**.

The declined test was three lines and touched nothing internal. It has shipped
in `src/lib/schemas.test.ts`.

The general lesson is not "check the version" but that the argument was accepted
because it *sounded* like the kind of fragility the route's history had already
taught us to avoid. A plausible-sounding reason to skip a test deserves the same
verification as a claim in the code.

### "The bidirectional compile pins cover both drift directions" was false

They cover both directions for nine of the ten fields. `ClassUpdateData` is
`Omit<z.infer<…>, 'date'> & { date?: Date }`, so `date` is present in `keyof`
whether or not the schema declares it — remove `date` from `updateClassSchema`
and **both pins stay green**. The reverse pin's mutation check used an invented
`'notAField'`, which it does catch, rather than a real field with a hand-declared
type member, which it does not.

The build does still break in that case, at the route's `const { date: dateString,
...rest }` destructure — but with an error that never mentions the allowlist. The
shipped key-set test closes this properly, and the blind spot is now documented
beside the reverse pin itself.

### The allowlist proves less than "permitted"

The forward and reverse pins together force the allowlist to *equal* the
schema's key set. So the allowlist carries no policy of its own: the state "the
schema has `status` but a teacher may not write it" does not compile. What the
pins buy is that a grant must be **explicit** — a second edit, in a file whose
comment lists the hazards — not that it is *correct*. The original wording
("proves a field is *permitted*") claimed the latter.

A third pin now closes the gap the first two left: a `NeverTeacherEditableClassField`
denylist (`id`, `teacherId`, `status`, `settingsLocked`, and the three financial
totals) that refuses the reflexive repair of pasting the offending name into the
allowlist. It is itself pinned against `Prisma.ClassUncheckedUpdateManyInput`, so
a typo in the denylist fails rather than silently protecting nothing.
