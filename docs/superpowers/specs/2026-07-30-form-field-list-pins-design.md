# Pinning the two edit forms' field lists to their schemas

**Date:** 2026-07-30
**Status:** Approved (issues #81 + #85; design agreed with Ivo in discussion —
one field list per form with a derived payload, pinned both ways; the two
widened template enums folded in)

## Problem

`#72 → #78 → #79 → #82` hardened both mutating routes: each now carries a
derived update type, an allowlist, a forbidden list, and compile-time pins.
Adding a field to either update schema trips pins in the matching lifecycle
service — the column-existence one and the allowlist one — plus a runtime
key-set test.

No count here, deliberately: not every pin in those files fires on an
addition. Each file holds pins facing both directions, and the stale-allowlist
and forbidden-list ones answer a *removal* instead, so a figure for "how many
trip" is a figure for one direction of one kind of change. `grep -n ': NoneOf<'`
over the two services is what is current.

The two client forms that mirror those routes were never pinned. They restate
the same field lists in prose-asserted "mirrors X exactly" comments, and they
are now the only copies of those lists that nothing checks.

**Neither is a security issue.** Both forms *under*-send, and `.strict()` means
neither could over-send. The cost is a field that looks shipped and is not — a
teacher-editable field with no input rendered for it.

**The scale is larger than either issue records.** #81 names two copies in
`ClassEditForm`; that is right. #85 names one copy in `TemplateForm`; there are
**three** — `TemplateFormProps.initial` (`:21-35`), `INITIAL_VALUES` (`:61-75`),
and the payload literal (`:153-167`).

## Design

### 1. The fix both issues recommend does not work

Both propose typing the payload as the service-side update type
(`ClassUpdateData` / `ClassTemplateUpdateData`) and call it the better of their
two options. It fails twice, and both failures are compiler-verifiable:

**It is the wrong type.** `ClassUpdateData` is
`Omit<z.infer<typeof updateClassSchema>, 'date'> & { date?: Date }` — the shape
*after* the route converts the wire value. The form sends the wire shape, where
`date` is a `'YYYY-MM-DD'` string:

```
TS2322: Type 'string' is not assignable to type 'Date'.
```

**Typing the payload catches nothing regardless.** Every field in both update
schemas is `.optional()`, so a payload missing a newly-added field is
well-typed:

```ts
type Wire = z.infer<typeof updateClassSchema>;
const b: Wire = { classType: 'x' };   // compiles clean
```

Which is the whole defect: the drift is a *missing* key, and an all-optional
type cannot see a missing key. Only a pin over `keyof` can.

So the issues' second-choice option — pin the field set — is the only one that
works. Recorded here because the recommendation appears in both issues and
would otherwise be tried twice.

### 2. One list per form, derived payload, pinned both ways

Each form keeps exactly one enumeration of its fields: its state type. The
request payload derives from that state rather than restating it.

```ts
type UpdateClassWire = z.infer<typeof updateClassSchema>;

const _formCoversSchema: NoneOf<Exclude<keyof UpdateClassWire, keyof ClassEditInitial>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof ClassEditInitial, keyof UpdateClassWire>> = true;
```

`NoneOf` (`src/lib/type-pins.ts:32`) resolves to `T` rather than collapsing to
`never`, so the failure **names the field** rather than saying "not assignable
to never":

```
TS2322: Type 'true' is not assignable to type '"waitlistCap"'.
TS2322: Type 'true' is not assignable to type '"maxStudents"'.
```

Both directions verified to bite before this spec was written. The forward pin
catches a schema field with no form field — the named cost. The reverse pin
catches a form field the schema dropped, which would otherwise 400 at runtime.

`ClassEditForm`'s payload becomes:

```ts
const payload: UpdateClassWire = { ...form, description: form.description || null };
if (settingsLocked) for (const f of ECONOMIC_FIELDS) delete payload[f];
```

`delete` typechecks because every wire field is optional, and `ECONOMIC_FIELDS`
(`src/lib/class-fields.ts:13`) is the canonical naming of the gated five — the
form stops restating them, which is what #81 asks for. Task 1 moved the
constant there from `class-lifecycle.ts`, which now only re-exports it: the
new module has zero imports, which is what makes it safe to value-import from
a `'use client'` component — importing it from `class-lifecycle.ts` directly
would pull that module's `./notifications` → `@/lib/log` (pino, server-only)
into the browser bundle.

Note what the spread does *not* buy. `class-lifecycle.ts:242` already records
that spreading defeats excess-property checking, so `{ ...form }` cannot flag an
extra field. The reverse pin is what covers that, which is why both directions
are present rather than just the forward one.

(This file's `class-lifecycle.ts` line citations were checked against the file
as it stood when this spec was written, before Task 1 ran. Task 1 removed 11
net lines from that file — moving `ECONOMIC_FIELDS` out, as above — shifting
every citation below this point; each has been re-verified against the current
file rather than adjusted by arithmetic.)

### 3. Both template schemas get pinned, though they agree today

#85 warns that a pin "has to target the right schema per branch" because
`createClassTemplateSchema` and `updateClassTemplateSchema` differ. They do
differ — create has required fields and no `.strict()`; update is all-optional
and strict — but their **key sets are identical**, 13 each, so for a key-set pin
they are interchangeable as things stand.

Both are pinned anyway, in both directions — four pins. The form sends one body
to both endpoints, so the day the two schemas' keys diverge, that single body
stops satisfying one of them; a pin against only one would not notice.

The reverse direction needs the create schema more than the update one, which
is the opposite of what the `.strict()` difference suggests at a glance. A key
the form sends and `updateClassTemplateSchema` no longer declares gets a 400 —
loud, findable. The same key against `createClassTemplateSchema`, which has no
`.strict()`, is *stripped in silence*: the teacher saves, the field vanishes,
nothing reports it. Pinning only the strict schema would have left the quiet
failure unguarded.

### 4. The two widened enums, and why the dropdown becomes the source

`TemplateFormProps.initial` types `cancelDeadline` and `autoCancelCheck` as
`string`, against Prisma enums of four and three members
(`schema.prisma:37-48`). `update('cancelDeadline', 'HOURS_99')` compiles today.
Same family as #58 and #132, in a file this change already rewrites.

Rather than a separate guard module, the arrays that already render the
dropdowns become `as const` and serve as the single list:

```ts
type OptionValue = (typeof CANCEL_DEADLINE_OPTIONS)[number]['value'];
const _offersAll: NoneOf<Exclude<CancelDeadline, OptionValue>> = true;
const _noStale:   NoneOf<Exclude<OptionValue, CancelDeadline>> = true;

export function isCancelDeadline(v: string): v is CancelDeadline {
  return CANCEL_DEADLINE_OPTIONS.some((o) => o.value === v);
}
```

Verified to compile with no assertion. This is the same mechanism as §2 applied
one level down: an enum member with no dropdown entry fails the build, so a
teacher can never be offered a stale set of choices. The guard supplies the
narrowing where `<select>`'s `e.target.value` arrives as `string`.

`import type` for the Prisma enums, per the convention #58 established: every
`@prisma/client` import in a `'use client'` file in this repo is type-only, and
a value import would be the first.

### 5. What is deliberately not done

**The form state types are not derived from the schemas.** `Required<Wire>`
would give `description: string | null`, while both forms hold `description` as
a `string` and render it into a `value=` that cannot take `null`. Deriving would
push nullability into the JSX for no gain — the pins already catch the drift
that matters, and the value types differ for a reason.

**`pick()` in `api-utils.ts:84-95` stays unused.** #81 notes it is documented for
exactly this purpose and has zero callers. It is a *runtime* allowlist for
server-side payloads; this change is client-side and compile-time. Wiring it in
here would add a runtime filter that duplicates what `.strict()` already
enforces at the route.

## Testing

The pins are the check, and a passing `tsc` on unchanged code demonstrates
nothing about them. Each is verified by mutation: add a field to the schema,
confirm the build fails **naming that field**, revert. Per the #66 lesson,
confirm the mutation landed before trusting the result.

The derived payloads are a different matter — they change what is actually sent,
so they need runtime coverage. Neither form had a component test when this was
written; Task 2 has since added `ClassEditForm`'s, below. `TemplateForm`'s
still doesn't exist as of this writing — that's Tasks 3-4.

- **`ClassEditForm`** — the `settingsLocked` branch decides whether five
  economic fields reach the API, which is a real behavioural fork and the one
  thing in this change that can break a teacher's edit. Tests: unlocked sends
  all ten; locked sends the five details and none of `ECONOMIC_FIELDS`;
  `description: ''` sends `null`.
- **`TemplateForm`** — one test per mode, asserting the body carries all
  thirteen fields and that `classType`/`description` are trimmed. Plus, per
  dropdown, that the offered option set equals the Prisma enum.

  That last one is not what this spec originally asked for, and the difference
  is recorded rather than quietly closed. The ask was "the enum guard rejecting
  a value outside the dropdown"; Task 4 found no way to write it and documented
  why at `template-form.test.tsx:146-155`. The guards are module-private, and
  exporting one only so a test can reach it is the pattern PR #131's review
  rejected. Driving an invalid value in from outside does not work either: the
  `<option>`s are the same array the guard reads, so jsdom's `<select>` refuses
  to take a value the guard would refuse. There is no reachable input for which
  the guard returns false. Asserting the offered set equals the enum tests the
  property the guard exists to preserve — a stale dropdown is the failure a
  teacher would actually meet — and that is what shipped.

Assert on the `fetch` body via `vi.stubGlobal('fetch', …)`, which is this repo's
established component-test pattern — every component test that touches the
network uses it — and the shape `outstanding-payment-row.test.tsx` uses.

## Out of scope

- **The route-side pins and allowlists** — done, in #80 and #84.
- **`z.enum([…])` in `schemas.ts` restating the Prisma enum members** — a third
  copy of those lists, on the server side. Real, but it belongs with the route
  pins rather than a form change.
- **`attendance-list.tsx`'s `RegistrationStatus` widening** — #132, filed.
- **Deriving form state types from schemas** — per §5.
- **`isEconomicFieldLocked` (`class-lifecycle.ts:79`) has no production
  callers** — only its own test imports it. Noticed while confirming where the
  lock is actually enforced (`:462`). Dead code, not a defect, and deleting it
  is unrelated to pinning form field lists; recorded here rather than filed.

## Risks

- **`delete` on the payload is the only new runtime mechanic.** It replaces
  conditional assignment, so a mistake means economic fields reach the API while
  locked. The route rejects them — `class-lifecycle.ts:462-464` returns
  `{ ok: false, reason: 'locked', fields }` naming the offenders — so the
  failure mode is a visible 400, not a bad write. That is a backstop, not a
  reason to be careless: the locked-branch test is what keeps this honest and is
  the test to write first.

  Worth knowing while in there: that check filters on `data[f] !== undefined`,
  so a key present with an `undefined` value is not an edit. `delete` and
  `JSON.stringify`'s own dropping of `undefined` are therefore equivalent to the
  route — the design does not depend on which one removes the key.
- **Every pin in the repo resolves through `NoneOf`, and this change adds
  more.** `type-pins.ts:35` already records that a hollowed-out `NoneOf`
  defangs all of them at once and carries its own pin for that reason; this
  change increases what rides on that one guard without changing it — and
  widens it past the services, since two of the new dependants are
  `'use client'` components. Stated without figures on purpose: the ones that
  were here were wrong before the branch that wrote them finished.
- **The dropdown arrays become load-bearing types.** They were presentation
  data; after this they define a union. Reordering or relabelling stays safe,
  but deleting an entry to hide an option from teachers would now fail the
  build — which is intended, and worth knowing before someone tries it.
