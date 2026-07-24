# `updateClass` service — fixing the misleading 409

**Date:** 2026-07-24
**Status:** Approved (issue #72; scope agreed with Ivo — extract a service
rather than patch the route in place)

## Problem

`PUT /api/classes/[id]` ends with a conditional update whose failure handler
serves two different situations:

```ts
const result = await prisma.class.updateMany({
  where: sentEconomicFields.length > 0 ? { id, settingsLocked: false } : { id },
  data: body,
});
if (result.count === 0) {
  return respondError(
    `Cannot update economic fields when settings are locked: ${sentEconomicFields.join(', ')}`,
    409,
  );
}
```

For an **economic** edit this is right: it is the compare-and-swap that catches
a first registration landing between the route's read and its write.

For a **non-economic** edit the `where` is just `{ id }`, so `count === 0` can
only mean the class was **deleted** between the read and the write. The caller
gets:

```
409 Cannot update economic fields when settings are locked:
```

An empty field list, a trailing colon, and a lock blamed for a request that
touched no economic field — where **404** is the correct answer. Low
likelihood, but the message would send someone debugging the lock when the
real event was a deletion.

### Two things found while investigating

**The route duplicates a service constant.** `src/services/class-lifecycle.ts`
exports a frozen `ECONOMIC_FIELDS` with unit tests asserting its exact contents
and its frozen-ness. The route declares an identical private copy and never
imports it. Add a sixth economic field to the service — with its test — and the
route's lock silently stops covering it. That is a worse latent bug than the
one filed.

**The route is the odd one out architecturally.** `CLAUDE.md` states that
business logic lives in `src/services/` and API routes are thin wrappers. The
sibling operations `transitionClass` and `completeClass` follow that; this PUT
holds its business rule inline. That is also *why* the bug is untestable: the
services take an injectable `db: PrismaClient`, and the route does not.

## Design

### The result type makes the defect unrepresentable

```ts
export type UpdateClassResult =
  | { ok: true; cls: Class }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'locked'; fields: readonly [EconomicField, ...EconomicField[]] }
  | { ok: false; reason: 'no_fields' };
```

The defect is two outcomes sharing one response. Distinct `reason` tags stop
them being conflated by construction rather than by a correctly-written `if`.

`fields` is a **non-empty tuple**, deliberately. The shipped bug was a `locked`
result carrying an empty field list; this type makes the compiler reject one.
It costs a little ergonomics where the value is built — the code must narrow
before constructing:

```ts
const [first, ...others] = sentEconomicFields;
if (first !== undefined) {
  return { ok: false, reason: 'locked', fields: [first, ...others] };
}
```

That awkwardness is the point: it is exactly the check whose absence caused the
bug, and the type now refuses to let it be skipped.

### Signature

Mirrors `transitionClass(db, classId, targetStatus)`:

```ts
export type ClassUpdateData = {
  classType?: string;
  description?: string | null;
  date?: Date;
  startTime?: string;
  durationMinutes?: number;
  roomCost?: number;
  minRate?: number;
  targetRate?: number;
  minStudents?: number;
  maxStudents?: number;
};

export async function updateClass(
  db: PrismaClient,
  classId: string,
  data: ClassUpdateData,
): Promise<UpdateClassResult>;
```

`ClassUpdateData` is declared explicitly in the service rather than derived from
`updateClassSchema`, so the service stays framework- and wire-format-agnostic.
Its fields mirror what that schema accepts today.

### Behaviour, in order

1. Read the class. Missing → `not_found`.
2. `sentEconomicFields = ECONOMIC_FIELDS.filter((f) => data[f] !== undefined)`.
3. `cls.settingsLocked && sentEconomicFields.length > 0` → `locked`.
4. No keys in `data` → `no_fields`.
5. `updateMany({ where: sentEconomicFields.length > 0 ? { id, settingsLocked: false } : { id }, data })`.
6. `count === 0` → **`locked`** if economic fields were sent (the genuine race),
   otherwise **`not_found`** (the row disappeared). *This is the fix.*
7. Re-read and return `{ ok: true, cls }`.

**Step 3 must precede step 4.** Today a locked class sent only economic fields
returns 409, not the empty-body 400. Reordering would silently change that, and
`classes-api.test.ts` pins the 409.

### The split

| Concern | Where |
|---|---|
| `requireTeacher`, params | Route |
| Read + `404 Class not found` + `403 Not your class` | Route |
| `parseBody`, `YYYY-MM-DD` → `Date` | Route |
| Lock rule, `ECONOMIC_FIELDS`, the CAS, `count === 0` classification | **Service** |
| `reason` → status code and message text | Route |

Message strings stay in the route: user-facing copy is an HTTP concern, and
keeping them there preserves the exact text `classes-api.test.ts` asserts.

The route reads the class for its ownership check and the service reads it
again. That double read is what `transitionClass` and its route already do — an
established pattern here, not a new wart.

The route's ownership check stays in the route because `session.teacherId` is an
HTTP-session concern, matching the transition route exactly.

## Testing

**Reachable paths** — unit tests in `src/services/class-lifecycle.test.ts`
against a real `PrismaClient`, the way `transitionClass` is already tested:
`not_found`, `locked` (step 3), `no_fields`, success, and a non-economic edit on
a locked class succeeding.

**The two `count === 0` branches** cannot be reached with a real database
deterministically — that is precisely why the bug shipped. They get a stub `db`
whose `class.findUnique` returns a class and whose `class.updateMany` returns
`{ count: 0 }`, cast once (`as unknown as PrismaClient`) and confined to the
test file. Two cases:

- economic fields sent → `locked` — the CAS backstop, previously untested
- none sent → **`not_found`** — the bug

**Behaviour preservation.** `tests/integration/classes-api.test.ts` must stay
green **without modification**. It pins the 409 message, the scoped lock, the
ownership guard, and atomic rejection of mixed bodies — so an unchanged pass is
the evidence the extraction preserved behaviour. No new integration tests: the
fixed branch still isn't reachable over HTTP.

## Also in scope

`src/lib/schemas.ts:251` comments the economic fields as "only accepted when
settings not locked (checked in route)". After this change the check lives in
`class-lifecycle.ts`; the comment gets updated so it does not send the next
reader to the wrong file.

## Out of scope

**The re-read after a successful update.** Step 7 uses `findUniqueOrThrow`,
which can itself race a delete and throw — surfacing as a 500 via
`withErrorHandler`. True today, unchanged by this work, and a different (much
narrower) window than the one being fixed. Recorded so its survival is a
decision rather than an oversight.

**`GET`/`DELETE` on the same route file.** Untouched.

## Verification

`tsc` + `eslint` clean. The `class-lifecycle` unit tests and the full
integration project green, with `classes-api.test.ts` unmodified.
