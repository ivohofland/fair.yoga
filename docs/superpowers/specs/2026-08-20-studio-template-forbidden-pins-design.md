# Forbidden-field pin machinery for `PUT /api/studio-class-templates/[id]`

**Date:** 2026-08-20
**Status:** Approved (issue #114; direction agreed with Ivo — extract
`updateStudioClassTemplate`, six pins with a stronger completeness pin than the
class twin, bound the lock wait, widen the runtime register)

## Problem

`PUT /api/studio-class-templates/[id]`
(`src/app/api/studio-class-templates/[id]/route.ts:58-61`) hands parsed schema
output straight to Prisma:

```ts
const updated = await prisma.studioClassTemplate.update({
  where: { id },
  data: parsed.data,
});
```

No derived type, no column pin, no allowlist, no forbidden set, no
caller-binding intersection — none of what #79/#82 built for `ClassTemplate` in
`src/services/class-template-lifecycle.ts`. There is no
`updateStudioClassTemplate` function at all: the ownership check, the
no-fields check and the unique-conflict mapping all live in the handler, which
CLAUDE.md places in `src/services/`.

This is the only plain-update site on the model. The other four
`studioClassTemplate` writes are compare-and-swap `updateMany`s inside the
lifecycle service (`:350`, `:701`), one recording `update` inside the same
archive transaction (`:778`), and `gdpr.ts:1146`'s bulk archive.

## What the premise check falsified

The issue is right that the machinery is absent and right about why it matters.
Four of its supporting claims do not survive measurement, and one of them
changes what the fix is for.

**1. "the same four pins" undercounts by half.** The class family has **six**
`NoneOf` pins, at `class-template-lifecycle.ts:72, 120, 133, 186, 206, 216`.
The issue names two of them; the other two items it lists
(`PlainUpdateForbiddenTemplateField`, the `data` intersection) are a type and a
mechanism, not pins. `class-lifecycle.ts` likewise has six (`:681, 743, 766,
816, 836, 845`), while both files' docblocks still say "five".

**2. "nothing is watching" is false — five of the eight columns are already
guarded, at runtime.** `src/lib/schemas.test.ts:332-506` holds a `server-owned
fields` register. It walks **every** schema exported from `src/lib/schemas.ts`,
reads its top-level `.shape` keys, and asserts exact equality in both
directions against an `EXPECTED` map. `SERVER_OWNED_FIELDS` (`:362-368`)
contains `id`, `teacherId`, `isArchived`, `archivedAt` and `withdrawnCount`.

Adding any of those five to `updateStudioClassTemplateSchema` today turns CI
red, naming the schema. That includes **both** columns the issue's "Why now"
section says #111 made worth forging.

The issue's literal words — "no *compile-time* pin to fire" — hold. Its
conclusion does not.

**3. So the real exposure is three columns, and only one of them matters.**
`isActive`, `createdAt` and `updatedAt` are the names the register does not
carry. `isActive` is the one with consequences, and the class family's own pin
comment (`class-template-lifecycle.ts:181-184`) already says why: it "is what
stops a `PUT` flipping a template active, which would bypass the
transaction-and-generate path `PATCH` owns". Measured: no exported schema
declares `isActive`, `createdAt` or `updatedAt` today, and `isActive` exists on
exactly two models — `ClassTemplate` (`schema.prisma:336`) and
`StudioClassTemplate` (`:457`).

**4. The register is weak in exactly the way #79 is about.** Its failure
message reads *"Either stop declaring it, or add it to EXPECTED with a
reason."* — so its own quickest repair **is** the reflexive grant. That is the
same repair `_templateAllowlistHasNoForbiddenFields` exists to refuse, and the
register structurally cannot refuse it. This is the sharpest argument for doing
the work, and the issue did not have it because it did not know the register
was there.

**5. The issue's comment is stale.** It says the client half is "filed as
instance 2 of #136". #136 is closed: `studio-template-form.tsx:36-43` now
carries four pins and has `studio-template-form.test.tsx` beside it. Only the
service half remains, which is what the issue body says.

**6. What did hold, and is worth stating.** #111 gave `StudioClassTemplate`
`archivedAt` (`schema.prisma:476`) and `withdrawnCount` (`:496`); the route
does pass `parsed.data` unfiltered; `updateStudioClassTemplateSchema` is
`.strict()` (`schemas.ts:461`); and the studio lifecycle service imports no
`NoneOf`.

## Design

### A. A stronger completeness pin than the class family has

The class family's `_templateForbiddenListIsComplete`
(`class-template-lifecycle.ts:186-199`) works by duplicating the forbidden
union literally and `Exclude`-ing it against itself. It therefore never
consults Prisma, and is structurally blind to a **newly added** column.

Both models happen to be exactly partitioned by their two lists, so a stronger
form is available:

```ts
const _studioTemplateListsPartitionTheModel: NoneOf<
  Exclude<
    keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput,
    TeacherEditableStudioTemplateField | PlainUpdateForbiddenStudioTemplateField
  >
> = true;
void _studioTemplateListsPartitionTheModel;
```

**Measured against a simulated migration**, not argued. A probe added an
unclassified `publishedAt` to the Prisma input type:

| Pin style | Result |
|---|---|
| Duplicate-the-union (what the class family ships) | **green** — never reads the model |
| Partition (`Exclude<keyof M, A \| F>`) | **red**, naming `publishedAt` |

The partition pin's failure was proven by a `@ts-expect-error` that tsc
*consumed* (exit 0). Had the pin passed, the unused directive would itself have
been an error — so this distinguishes "it failed" from "I asserted it failed".

Concretely: when #111 added `archivedAt` and `withdrawnCount` to both models,
every pin then in place stayed green until a human remembered to classify them.
The partition pin would have gone red on the migration.

`_studioTemplateForbiddenColumnsExist` is kept alongside it despite partial
overlap. A typo trips both, but their messages differ usefully — the
column-existence pin says *"`isActiv` is not a column"*, the partition pin says
*"`isActive` is unclassified"*, and the first is the one that points at the fix.

**The class twins are not retrofitted here.** #82's spec calls its own pin
refactor "the only part of the work that touches shipped security code" and
required re-proving every existing mutation afterwards. The blind spot is a
latent maintenance gap, not a live defect. Filed as its own leaf issue, citing
this section's measurement.

### B. The types

```ts
export type StudioClassTemplateUpdateData =
  z.infer<typeof updateStudioClassTemplateSchema>;
```

Derived, not hand-declared — deriving is what puts a newly added schema field
into `keyof`, which is what every pin depends on.

```ts
type TeacherEditableStudioTemplateField =
  | 'classType' | 'dayOfWeek' | 'startTime'
  | 'durationMinutes' | 'location' | 'hourlyRate';

type PlainUpdateForbiddenStudioTemplateField =
  | 'id'             // identity
  | 'teacherId'      // ownership
  | 'isActive'       // PATCH ?state=active|paused — flips inside a transaction
                     //   that also claims and generates
  | 'isArchived'     // PATCH ?state=archived — also forces isActive: false
  | 'archivedAt'     // written only by the archive transaction that owns
  | 'withdrawnCount' //   isArchived (#97/#111)
  | 'createdAt'      // Prisma-managed
  | 'updatedAt';     // Prisma-managed
```

The eight forbidden names are **the same eight** as
`PlainUpdateForbiddenTemplateField`. The allowlist differs entirely, because
the two families edit different things.

Arithmetic: `StudioClassTemplate` has 14 columns; the schema declares 6;
forbidden is the other 8. `6 + 8 = 14`. Not derived from reading
`schema.prisma` — measured, see "Verified mechanics" below.

### C. Six pins

| Pin | Asserts | Catches |
|---|---|---|
| `_studioTemplateUpdateColumnsExist` | `keyof Data ⊆ keyof M` | a schema field that is not a writable column |
| `_studioTemplateFieldsArePermitted` | `keyof Data ⊆ Allowlist` | a schema field nobody authorized |
| `_studioTemplateAllowlistHasNoStaleFields` | `Allowlist ⊆ keyof Data` | a stale allowlist entry; also the only pin that fires if `Data` degrades to `{}` |
| `_studioTemplateListsPartitionTheModel` | `keyof M ⊆ Allowlist ∪ Forbidden` | a deletion from either list, **and** a new column nobody classified |
| `_studioTemplateForbiddenColumnsExist` | `Forbidden ⊆ keyof M` | a typo in the forbidden list, which would protect nothing |
| `_studioTemplateAllowlistHasNoForbiddenFields` | `Allowlist ∩ Forbidden = ∅` | the reflexive repair — pasting the offending name into the allowlist |

`M` is `Prisma.StudioClassTemplateUncheckedUpdateManyInput` throughout, chosen
for the reason #78 gives: the single-record input additionally accepts nested
relation writes that a plain field update should never receive, so pinning
against it would wave through a schema field named after a relation.

### D. `updateStudioClassTemplate`

```ts
export type UpdateStudioClassTemplateResult =
  | { ok: true; template: StudioClassTemplate }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'forbidden' }
  | { ok: false; reason: 'no_fields' }
  | { ok: false; reason: 'slot_conflict' }
  | { ok: false; reason: 'busy' };

export async function updateStudioClassTemplate(
  db: PrismaClient,
  templateId: string,
  teacherId: string,
  data: StudioClassTemplateUpdateData &
    Partial<Record<PlainUpdateForbiddenStudioTemplateField, never>>,
): Promise<UpdateStudioClassTemplateResult>;
```

The intersection is what makes the forbidden list bind **callers**, not just
the wire schema. Excess-property checking fires only on a fresh object literal;
build the payload as a variable first and it never triggers. Marking each
forbidden key optional-and-`never` rejects the argument either way.

Body order, mirroring `updateClassTemplate:363-373`:

1. `findUnique` → `not_found`
2. `teacherId` mismatch → `forbidden`
3. defined-value scan → `no_fields`
4. the transaction (below)

### E. Bounding the lock wait

`setLockTimeout` takes a `TransactionClientOnly` (`db-locks.ts:75`) — the
`{ $transaction?: never }` brand makes passing a bare `PrismaClient` a compile
error rather than a `SET LOCAL` against an autocommit statement that protects
nothing. `db-locks.ts:125-146` carries the full reasoning. So
the write moves inside a transaction:

```ts
return await db.$transaction(async (tx) => {
  await setLockTimeout(tx);
  const template = await tx.studioClassTemplate.update({ where: { id: templateId }, data });
  return { ok: true, template };
}, { timeout: 10_000 });
```

The contention is real, not hypothetical: `archiveOrUnarchiveStudioTemplate`'s
CAS (`:350`, `:701`) holds this exact row inside a transaction that then runs a
`deleteMany` and, on the resume path, generation. Today a concurrent `PUT`
blocks on that row with no bound of its own — the 10s budget is not one,
because Prisma checks it at statement boundaries and "cannot roll back a
statement already blocked inside Postgres" (`db-locks.ts`).

No `SELECT … FOR UPDATE` and no read inside the transaction beyond the write
itself. The read-then-write gap is not a correctness problem here: archiving
only *leaves* `StudioClassTemplate_teacher_slot_unique`'s partial scope
(`WHERE isArchived = false`), un-archiving re-enters it and the index arbitrates,
and the archive's own writes (`isActive`, `isArchived`, `archivedAt`,
`withdrawnCount`) are disjoint from everything this write touches.

The `catch` maps three shapes:

- `isTransientDbError` → `busy`, with a `log.warn`
- `isUniqueConflictOn(err, ['teacherId','dayOfWeek','startTime'])` → `slot_conflict`, with a `log.warn`
- `isRecordNotFound` (`api-errors.ts:245`) → `not_found`. The helper, not the
  raw `err.code === 'P2025'` the class twin still uses at
  `class-template-lifecycle.ts:542` — that asymmetry is an observation, not
  something this branch changes.

**P2025 is defensive parity, not a bug fix.** Verified: nothing in production
deletes a `StudioClassTemplate`. `gdpr.ts:1146` archives; there is no `DELETE`
route and no `studioClassTemplate.delete` call anywhere in `src/`. The only
reachable path is the `Teacher` cascade, which takes the caller's own row with
it. Without the mapping a delete landing in the gap would reach
`classifyApiError`, which has no P2025 branch and falls through to a bare 500
(`api-errors.ts:231-232`) — so the mapping is worth having; claiming it closes
a live 500 would not be.

**Both `warn` lines are #231 compliance, taken at birth rather than inherited.**
#231 records that both studio twins share the unlogged read-then-write shape,
and — more sharply — that *catching* a P2002 deletes the `warn`
`classifyApiError` would otherwise have emitted, making the catch an
observability regression. Today's route catches exactly that P2002 and logs
nothing. Writing the new function silent would ship a fresh instance of an open
issue. #231's class-family half is untouched by this branch; an Update goes on
that issue instead of a new filing.

The four pre-transaction returns stay silent, with a comment saying so — a 404
or a 403 for a template the caller never owned is the case #231's own
acceptance criterion allows to go unlogged.

### F. The route becomes a thin wrapper

`PUT` shrinks to parse → call → map reasons, preserving today's responses:
`not_found` → 404 "Studio class template not found", `forbidden` → 403 "Access
denied", `no_fields` → 400 "No valid fields to update", `slot_conflict` → 409
`DUPLICATE_STUDIO_TEMPLATE_SLOT` with today's wording, `busy` → 503
`STUDIO_TEMPLATE_BUSY` — the code the `PATCH` in the same file already returns,
with a message about editing.

A closing `const unhandled: never = result` guard, which this handler does not
have today, so a future reason is a compile error rather than a wrong status.
The success half gets no `switch`: unlike `PATCH`'s result, the success arm is a
single variant with no `action` discriminant, and inventing one to satisfy the
shape #124 describes would be ceremony. Noted here so a reader does not read
the asymmetry as an oversight.

### G. Widening the runtime register

Add `isActive`, `createdAt` and `updatedAt` to `SERVER_OWNED_FIELDS`
(`schemas.test.ts:362`) and to the roster assertion at `:439`.

With the extraction, studio's `isActive` is already a compile error, so this
buys the generalisation rather than the studio fix: every schema in the repo,
now and future, plus the class family's `isActive` redundantly. Measured green
today — no exported schema declares any of the three — so no `EXPECTED` entry is
needed, and `_serverOwnedNamesExist` (`:397`) stays satisfied because `isActive`
lives on `ClassTemplate` and `StudioClassTemplate`, both already in
`AnyModelKey`, and `createdAt`/`updatedAt` on most of the fourteen.

### H. The stale docblock

`class-template-lifecycle.ts:6` says the file is the sibling of
`class-lifecycle.ts`'s update section "with the same five pins". Both files
have six, so the sentence is wrong twice over — about its own file and about
the one it compares itself to.

**Corrected during planning:** this section originally said "the two stale
docblocks", planning for a fix in `class-lifecycle.ts` too. Measured — it
makes no pin-count claim anywhere (`grep -n "pin" src/services/class-lifecycle.ts`
returns only per-pin prose). There is one stale claim, in one file, and it is
the file this branch reads as its template. `class-lifecycle.ts` is untouched
by this branch.

### I. What gets no pin, deliberately

`PATCH` writes hardcoded object literals through the lifecycle service's CAS
statements, not schema output. There is no wire schema to drift, and
excess-property checking already covers a literal. `POST` is #228's territory.

## Behaviour changes

Three, all user-visible in principle, none covered by an existing test that
would go red silently.

1. **A malformed body against another teacher's template becomes 400, not
   403.** Parsing must precede the service call because the service takes typed
   data. This is #82's accepted drift, and the same argument holds: it is not an
   existence oracle, because the cheap probe is `{}`, which parses fine and
   still yields 403. `studio-api.test.ts:305-325` sends a *valid* body
   (`{ hourlyRate: 1 }`), so it keeps asserting 403 unchanged.

2. **`no_fields` becomes a defined-value scan.** `Object.keys(data).length === 0`
   becomes `Object.values(data).some((v) => v !== undefined)`, matching
   `updateClassTemplate:372`. Unreachable over the wire — JSON cannot carry
   `undefined`, so a key can never arrive with that value — but reachable at the
   new function boundary, which is the point of having one.
   `studio-api.test.ts:337` sends `{}` and keeps asserting 400.

3. **A blocked write answers 503 at ~2s instead of waiting.** New outcome, new
   test.

## Verified mechanics

Measured with `npx tsc --noEmit` against the real generated types, in a probe
file deleted afterwards. Each was probed before being written here.

1. `Prisma.StudioClassTemplateUncheckedUpdateManyInput` exists under that name.
2. All six schema fields name writable columns — the column-existence pin is
   green today.
3. The whole inferred payload assigns to the Prisma input directly, with no
   `Omit`/intersection. Same "no blind spot" property #82 recorded for
   `ClassTemplateUpdateData`, and for the same reason: `hourlyRate: number`
   assigns to the `Decimal` column's input union, and there is no `date`-shaped
   field needing re-typing.
4. All eight forbidden names are real columns.
5. Allowlist equals the schema key set; allowlist ∩ forbidden = ∅.
6. `keyof Prisma.StudioClassTemplateUncheckedUpdateManyInput` is **exactly**
   allowlist ∪ forbidden — the partition is exact. The same holds for
   `ClassTemplate` (13 + 8 = 21).
7. The partition pin fails on an unclassified column while the duplicate-union
   form passes — proven by a consumed `@ts-expect-error`, above.

## Testing

**Unit** — `src/services/studio-class-template-lifecycle.test.ts`: one case per
result variant. `not_found`; `forbidden` for another teacher's template, with
the row asserted untouched; `no_fields` for `{}` **and** for
`{ classType: undefined }`, which is the case the key-count check let through;
success returning the updated row; `slot_conflict` against a live sibling;
`busy` under a held row lock, following the interleaving
`studio-class-template-lifecycle.test.ts`'s existing race tests already
construct. The `busy` and `slot_conflict` cases assert on the log spy, per
#231's acceptance criterion — silence is what a passing test looks like by
default.

**Schema agreement** — a key-set test for `updateStudioClassTemplateSchema` in
`schemas.test.ts`, mirroring `updateClassTemplateSchema`'s at `:257`. The
studio family has none today.

**HTTP** — `tests/integration/studio-api.test.ts`: a successful field update; a
400 for an undeclared key, mirroring `class-templates-api.test.ts:1123` and
carrying its comment, because that is the runtime behaviour every compile-time
pin's reasoning rests on; and a 503 with `STUDIO_TEMPLATE_BUSY` under
contention. The existing 403, 404, empty-PUT and slot-collision cases stay
green unedited — if any needs editing, the extraction drifted.

**Mutation verification** — each of the six pins proven to fail in the right
direction and name the offender, then reverted. Per the skill's rule, each
mutation uses a value the code under test cannot otherwise produce:

| # | Mutation | Expected to fire |
|---|---|---|
| 1 | add `isActive: z.boolean().optional()` to the schema | forward pin |
| 2 | also paste `isActive` into the allowlist (the reflexive repair) | `…HasNoForbiddenFields` |
| 3 | add `notAColumn: z.string().optional()` to the schema and the allowlist | `…UpdateColumnsExist` |
| 4 | delete `location` from the allowlist | forward pin **and** the partition pin — the one mutation that trips two, because the allowlist is in both |
| 5 | add `'location'` to the allowlist while removing it from the schema | reverse pin |
| 6 | typo `isActive` → `isActiv` in the forbidden list | `…ForbiddenColumnsExist` **and** the partition pin |
| 7 | delete `updatedAt` from the forbidden list | partition pin |
| 8 | simulate a new column via `& { publishedAt?: Date \| null }` | partition pin only — the duplicate-union form stays green |
| 9 | pass `{ hourlyRate: 1, isActive: true }` as a pre-built variable | the `data` intersection |
| 10 | delete `await setLockTimeout(tx)` | the `busy` test hangs to timeout rather than aborting |

Mutations 6 and 7 are the pair that matters: the class family's completeness
pin catches 7 and cannot catch 8. Mutation 10 is the one #227's records show
ends in a hung test rather than a budget expiry, which is the evidence that the
budget is not a bound.

**Whole-suite** — `npm run verify` before pushing, with the dev server up on
:3000. Baseline measured at branch start and re-measured after, not predicted.

## Out of scope

- **Studio instance sync on edit.** Editing `dayOfWeek`/`startTime` leaves
  generated `StudioClass` rows on the old schedule. That is **#194**, which is
  unaffected by this branch and carries two open product decisions. The
  extraction gives it the seam it will need.
- **`POST /api/studio-class-templates`.** #228 owns moving both template
  creates into services; **#228 is unaffected**.
- **#231's class-family half.** The new function is written compliant; the four
  existing sites are not changed. **#231 stays open**, with an Update.
- **Retrofitting the class family's completeness pins.** Filed as a leaf,
  citing section A.
- **Making `isActive`/`isArchived` editable through `PUT`.** They have `PATCH`.
- **#117's correction** to the "a missed CAS holds no lock" claim. Adjacent
  prose, different owner; **#117 is unaffected**.

## Risks

- **Behaviour drift in the route extraction.** Five responses must be preserved
  exactly. Mitigated by the four existing integration cases staying green
  unedited — an edit to any of them is the signal that something drifted, not a
  chore.
- **The new transaction.** The `PUT` has never opened one. It holds two
  statements and a `SET LOCAL`, on a single row, with no lock-ordering surface
  (no `Class`, no `StudioClass`, one table). The nearest hazard is a
  long-running archive transaction now producing a 503 where it previously
  produced a slow 200 — which is the intended change, and gets its own test.
- **Log noise.** Two new `warn` lines on paths a teacher can trigger by
  ordinary misuse (moving a template onto an occupied slot). Matched to what
  `archiveOrUnarchiveTemplate` already emits for the same event, so the volume
  is a known quantity rather than a new one.
