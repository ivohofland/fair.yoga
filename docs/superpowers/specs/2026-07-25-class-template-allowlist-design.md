# A teacher-editable allowlist for `PUT /api/class-templates/[id]`

**Date:** 2026-07-25
**Status:** Approved (issue #82; scope agreed with Ivo — extract the shared pin
helper, scope the forbidden-list names, extract an `updateClassTemplate`
service)

## Problem

`PUT /api/class-templates/[id]` hands parsed schema output straight to Prisma:

```ts
const updateData = parsed.data;
const updated = await prisma.classTemplate.update({ where: { id }, data: updateData });
```

There is no derived type, no column pin, no allowlist, and no forbidden set —
none of the three guards `PUT /api/classes/[id]` gained in #78 and #80. This is
the same latent shape as #79: `updateClassTemplateSchema` is `.strict()`, so an
undeclared key is a 400 today, and the only way a dangerous field reaches
`update` is by being *declared* in the schema. That is a one-line source edit
with no signal.

`ClassTemplate` carries columns a teacher must not write this way:

- `isActive` — owned by `PATCH`, which wraps the flip in a transaction and calls
  `generateInstancesForTemplate`. A bare flip to `true` would mark a template
  active with no instance window generated.
- `isArchived` — owned by `PATCH ?action=archive`, which also forces
  `isActive: false`. Writing it alone can produce an archived-but-active
  template, a state `PATCH` deliberately refuses to create.
- `teacherId` — reassign another teacher's template to yourself.
- `id`, `createdAt`, `updatedAt` — identity and Prisma-managed timestamps.

It matters slightly more here than on the class route, because this route does
not stop at the template: it calls `syncTemplateInstances`, which propagates
onto generated `Class` rows. A bad template field reaches `Class` without going
through `PUT /api/classes/[id]` at all.

**Nothing is exploitable today.** None of those columns is in the schema. This
closes what the route permits the next contributor to add without a signal.

## What is different from #79

Three things, all of which make this the better-behaved version:

1. **No blind spot.** The class pins compare against `keyof ClassUpdateData`,
   and that type re-adds `date` through an intersection
   (`Omit<z.infer<…>, 'date'> & { date?: Date }`), so a `date` dropped from the
   schema leaves both pins green. `ClassTemplateUpdateData` needs no such
   intersection — every schema field maps directly to a column of the same type
   — so it is a straight `z.infer<>`, and the reverse pin has no equivalent
   hole.
2. **`PATCH` is a real sibling route.** `status` on a class has
   `POST …/transition`; `isActive`/`isArchived` have `PATCH` *in the same file*.
   That makes "forbidden here, editable elsewhere" impossible to paper over, and
   is why the forbidden list is renamed (below) rather than copied.
3. **`PUT` has no HTTP test at all.** `tests/integration/class-templates-api.test.ts`
   covers `POST` and `PATCH` only. The class route had five `PUT` cases before
   #80 landed; this one has none.

## Design

### A. Extract the pin helper

The never-check idiom is written five times in `src/services/class-lifecycle.ts`
(three from #78/#80's original pass, two more from #80's review). Adding the
template pins would make it ten. Extract it first:

```ts
// src/lib/type-pins.ts

/**
 * Resolves to `true` when `T` is `never`, and to `T` itself otherwise — so a
 * failed pin reports the offending member by name instead of a bare boolean.
 *
 * The tuple brackets are load-bearing *here*, unlike at the call sites they
 * replace, where `X` was always a concrete alias. `T` is a naked type parameter,
 * so unbracketed `T extends never` would distribute — and distribution over the
 * empty union is `never`. The failure mode is the surprising direction:
 * `NoneOf<never>`, the case where the invariant HOLDS, would resolve to `never`
 * and reject `true`, leaving the build permanently red with no offending field
 * to name. Measured: unbracketed, only the passing case breaks; both forms still
 * reject one and two offenders correctly.
 */
export type NoneOf<T> = [T] extends [never] ? true : T;
```

Each pin then collapses from five lines to two:

```ts
const _fieldsArePermitted: NoneOf<Exclude<keyof ClassUpdateData, TeacherEditableClassField>> = true;
void _fieldsArePermitted;
```

The `void` stays: this repo's eslint `no-unused-vars` has no `varsIgnorePattern`,
and the const is what instantiates the conditional type. Deleting it removes the
pin silently.

`src/services/class-lifecycle.ts`'s five pins are refactored onto `NoneOf` in the
same change. **This is the only part of the work that touches shipped security
code**, so all five class pins are re-verified by reverted mutation afterwards,
not assumed to survive.

### B. Rename the forbidden lists to say what they mean

`NeverTeacherEditableClassField` (shipped in #80) includes `status` — which
teachers *do* change, through the transition route. The doc comment scopes the
claim; the name overstates it. On templates that gap is harder to ignore: the
name would call `isActive`/`isArchived` never-editable while the `PATCH` handler
whose entire job is editing them sits in the route file it guards.

Rename to `PlainUpdateForbiddenClassField`, and use
`PlainUpdateForbiddenTemplateField` for the new one. Type-level rename only, no
behaviour change. Each member carries the route that *does* own it:

```ts
/**
 * Columns the plain update path must never write. Each is owned by a
 * different, guarded route — the pin says "not here", not "not ever".
 */
type PlainUpdateForbiddenTemplateField =
  | 'id'                          // identity
  | 'teacherId'                   // ownership
  | 'isActive'                    // PATCH — wraps the flip in a transaction and generates instances
  | 'isArchived'                  // PATCH ?action=archive — also forces isActive: false
  | 'createdAt'                   // Prisma-managed
  | 'updatedAt';                  // Prisma-managed
```

### C. The new service module

`src/services/class-template-lifecycle.ts`, mirroring `class-lifecycle.ts`:

```ts
export type ClassTemplateUpdateData = z.infer<typeof updateClassTemplateSchema>;
```

Derived, not hand-declared — deriving is what puts a new schema field into
`keyof`, which is what every pin below depends on. A hand-declared type would
never see the offending field at all.

The allowlist is the thirteen fields the schema accepts today:

```ts
/**
 * The fields a teacher may change on their own template via
 * `PUT /api/class-templates/[id]`.
 *
 * Adding a member is how a new schema field gets authorized. Before adding one,
 * read what actually guards that column — and note that three members already
 * on this list carry consequences beyond the template row:
 *   - `dayOfWeek`      → `syncTemplateInstances` DELETES generated instances on
 *                        the old day. The most destructive field here.
 *   - `teacherRoomId`  → cross-teacher: the ownership check in
 *                        `updateClassTemplate` is the only thing stopping a
 *                        teacher attaching their template to someone else's room.
 *   - the economic fields → propagate to instances without bookings; instances
 *                        with registrations keep their settings.
 */
type TeacherEditableClassTemplateField =
  | 'classType' | 'description' | 'teacherRoomId' | 'dayOfWeek' | 'startTime'
  | 'durationMinutes' | 'roomCost' | 'minRate' | 'targetRate' | 'minStudents'
  | 'maxStudents' | 'cancelDeadline' | 'autoCancelCheck';
```

### D. Five pins

| Pin | Asserts | Catches |
|---|---|---|
| columns exist | `keyof ClassTemplateUpdateData ⊆ keyof Prisma.ClassTemplateUncheckedUpdateManyInput` | a schema field that is not a writable column |
| forward | `keyof ClassTemplateUpdateData ⊆ Allowlist` | a schema field nobody authorized |
| reverse | `Allowlist ⊆ keyof ClassTemplateUpdateData` | a stale allowlist entry |
| forbidden columns exist | `Forbidden ⊆ keyof Prisma.ClassTemplateUncheckedUpdateManyInput` | a typo in the forbidden list, which would protect nothing |
| forbidden | `Allowlist ∩ Forbidden = ∅` | the reflexive repair — pasting the offending name into the allowlist |

Forward and reverse together force the allowlist to *equal* the schema's key
set, so the allowlist carries no policy of its own. What it buys is that a grant
must be explicit. The forbidden pin is what refuses the grants that are never
right; it fails on a const named `_allowlistHasNoForbiddenFields`, because the
const name is the part of a type error people read.

`Prisma.ClassTemplateUncheckedUpdateManyInput` is the reference deliberately, as
in #78: the single-record input additionally accepts nested relation writes that
`update`'s `data` would take but a field-update path should never receive.

### E. `updateClassTemplate`

The route currently holds the ownership check, the teacher-room validation, the
write and the sync — business logic in a route handler, which CLAUDE.md places
in `src/services/`. The pins want the write behind a typed boundary anyway, so
the two goals coincide:

```ts
export type UpdateClassTemplateResult =
  | { ok: true; template: ClassTemplate; sync: TemplateSyncResult }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }      // not this teacher's template
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'invalid_room' };  // room missing, or another teacher's

export async function updateClassTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  data: ClassTemplateUpdateData,
): Promise<UpdateClassTemplateResult>;
```

Every business outcome is a variant; the function takes `teacherId` rather than
a session, keeping it framework-agnostic and independently testable.

The route becomes a thin wrapper mapping reasons to codes, preserving today's
responses exactly: `not_found` → 404 "Class template not found", `forbidden` →
403 "Access denied", `no_fields` → 400 "No valid fields to update",
`invalid_room` → 400 "Invalid teacher room", success → `{ ...template, sync }`.

**The one behavioural question this raises.** Today the write and the sync are
two sequential `await`s in the handler: if `syncTemplateInstances` throws, the
template row is already updated and the client gets a 500 — a partial success.
Moving both into the service does not change that by itself, and **this spec
does not change it either.** Wrapping the pair in a transaction is a real
improvement and a real behaviour change (sync failure would roll the template
edit back), so it belongs in its own issue with its own test, not smuggled into
a type-safety fix. The service documents the ordering and the partial-failure
window explicitly so the next reader sees it.

### F. `PATCH` gets no pin, deliberately

`PATCH` writes hardcoded object literals (`{ isArchived: !t.isArchived, isActive: false }`,
`{ isActive: !t.isActive }`), not schema output. There is no wire schema to drift,
so there is nothing for a pin to guard; excess-property checking already covers a
literal. Adding a pin there would be ceremony.

## Verified mechanics

Measured against the real types with `tsc --noEmit`, not assumed — the previous
spec in this line shipped a false claim that survived review, so each of these
was probed before being written down:

1. `Prisma.ClassTemplateUncheckedUpdateManyInput` exists under that name.
2. Every one of the thirteen schema fields is a writable column — the
   column-existence pin is green today.
3. The zod enum literals (`'HOURS_24'`, `'HOURS_2'`) assign to Prisma's
   `CancelDeadline` / `AutoCancelCheck` without a cast.
4. The whole inferred payload assigns to the Prisma input directly, confirming
   no `Omit`/intersection is needed — the finding behind "no blind spot" above.

## Testing

Unlike #79, there is real runtime behaviour to test here, because a service
function is being extracted.

**Unit** — `src/services/class-template-lifecycle.test.ts`: one case per result
variant (`not_found`, `forbidden` for another teacher's template, `no_fields`,
`invalid_room` for both a missing room and another teacher's room, and success
including the returned `sync` payload).

**Schema agreement** — a key-set test in `src/lib/schemas.test.ts` mirroring the
one #80 added, asserting `Object.keys(updateClassTemplateSchema.shape)` equals
the thirteen fields. `.shape` is public API on zod 4.4.3 and typechecks without a
cast (measured in #80). Less load-bearing here than on the class route, since
there is no intersection to hide drift — but it guards against someone adding
one later, and it fails naming the field.

**HTTP** — `tests/integration/class-templates-api.test.ts` currently has no `PUT`
coverage at all. Add: a successful field update propagating to instances, a
403 for another teacher's template, a 400 for an undeclared key (the `.strict()`
behaviour every pin's reasoning rests on), and a 400 for another teacher's room.

**Mutation verification** — each of the five new pins proven to fail in the right
direction and name the offender, then reverted: a forbidden field added to the
schema, a stale allowlist entry, `isActive` added to both schema and allowlist
(the reflexive grant), a typo in the forbidden list, and a non-column field. Plus
**all five refactored class pins re-verified**, since the `NoneOf` extraction
touches code merged the same day.

## Out of scope

- **Transactional write + sync.** Real improvement, real behaviour change, own
  issue (see E).
- **Making `isActive`/`isArchived` editable through `PUT`.** They have `PATCH`,
  deliberately.
- **The `PATCH` handler.** No wire schema, nothing to pin (see F).
- **`ClassEditForm`'s unpinned copy of the class field list** — that is #81.

## Risks

- **Refactoring shipped security code.** The `NoneOf` extraction rewrites all
  five pins in `class-lifecycle.ts` (one from #78, four from #80 and its
  review). Mitigated by re-running every #78/#80 mutation check against
  the refactored pins; if any fails to fire, the extraction is wrong and gets
  reverted rather than patched.
- **Behaviour drift in the route extraction.** The four error responses are
  reproduced exactly; the new HTTP tests pin them, and they are written before
  the extraction so they must pass against the current route first.
