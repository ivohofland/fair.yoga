# Pinning the remaining form field lists

**Date:** 2026-08-01
**Status:** Approved (issue #136; design agreed with Ivo — reverse-pin-only for
shared schemas, ten forms in scope with two deferred, the components test glob
extended to `src/app/**`)

## Problem

A form restates the field list its Zod schema accepts, and nothing checks the two
agree. Per #81, the cost is a teacher-editable field that looks shipped with no
input rendered — silent, because forms under-send and `.strict()` prevents
over-sending.

PR #135 (#81 + #85) fixed `ClassEditForm` and `TemplateForm` and established the
shape. #136 is the rest.

### The inventory is twelve, not eight

A full census — every file under `src/app` and `src/components` containing
`body: JSON.stringify`, classified by body shape rather than sampled — returns
**28 files**. Fourteen send one or two fields with no list to drift. Two
(`class-edit-form`, `template-form`) are already pinned. **Twelve** restate a
field list against a schema.

The issue names eight. These four it does not:

| Form | Schema | Note |
|---|---|---|
| `src/components/settings/edit-teacher-room-form.tsx` | `updateTeacherRoomSchema` | three fields, exact match, unpinned |
| `src/components/students/edit-student-form.tsx` | `createStudentSchema` — see below | teacher-facing CRM edit |
| `src/components/students/create-student-form.tsx` | `createStudentSchema` | three fields, exact match, unpinned |
| `src/components/booking/booking-sign-in.tsx` | `studentSignupSchema` | four fields, exact match |

**`booking-sign-in` is deliberately out of scope** — it is a sign-in flow, not an
edit form, and #136 is about edit forms. Recorded here so it is a decision rather
than an omission.

**`tier-form.tsx` is in scope without being one of the twelve.** It sends a
single field (`incomeTier`), so it has no list to drift and is not an instance of
the defect. It is included because it *shares* `updateStudentSchema` with
`notifications-form`, and the reverse pin is what proves its one key is a key the
schema accepts — the same guarantee its neighbour gets. Counting it as an
instance would inflate the inventory; leaving it out would leave one of the three
sharers of a branched schema unpinned.

So: **twelve instances of the defect, ten forms changed** — nine instances, plus
`tier-form`, minus the three set aside below.

### Two shapes PR #135's template does not cover

**One route, two schemas, chosen by caller identity.** `PUT /api/students/[id]`
parses with `updateStudentSchema` when `session.studentId === id` (a student
editing their own profile) and with `createStudentSchema` otherwise (a teacher
editing a CRM contact). Same method, same path, different key sets.
`edit-student-form` is the teacher-facing caller, so it pins against
`createStudentSchema`.

**Many forms partially covering one schema.** `updateStudentSchema` has eight
keys. `notifications-form` sends two, `tier-form` sends one, and **five —
`firstName`, `lastName`, `phone`, `birthday`, `address` — have no student-facing
input anywhere.** A forward pin on either form would fail naming six fields it
has no business rendering.

## Design

### 1. Both pins where a form owns its schema; the reverse pin only where it shares

Seven forms own a schema (or a create/update pair) and take the full treatment,
copying `template-form.tsx`:

```ts
const _formCoversSchema: NoneOf<Exclude<keyof UpdateXWire, keyof XFormValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof XFormValues, keyof UpdateXWire>> = true;
```

Where one body serves two endpoints, all **four** pins — `template-form.tsx`
carries exactly this, and PR #135 shipped with the create-direction reverse pin
missing, which let an extra key be silently stripped rather than rejected.

Three forms share `updateStudentSchema` and get the **reverse pin only**:

```ts
// Shares `updateStudentSchema` with `tier-form.tsx`; five further keys
// (firstName, lastName, phone, birthday, address) have no student-facing input
// at all. Partial coverage is intended here, so there is no forward pin — it
// would name six fields this form has no business rendering. The reverse pin
// still holds: this form sends nothing the schema would reject.
const _formHasNoExtras: NoneOf<Exclude<keyof NotificationsBody, keyof UpdateStudentWire>> = true;
```

That is an honest statement of what a type can prove here, and it still catches
the `.strict()` 400 class of bug. The five uncovered fields are **not** pinned by
anything and that is deliberate; §5 says what would be needed to change it.

### 2. The payload is derived, never restated

One list — the state type — with the body derived from it, and the wire type
annotated: keys are held by the pins, value types only by the annotation.
Neither substitutes for the other, verified in #135.

### 3. The enum axis is different in all three places the issue describes

The issue prescribes "the option array becomes `as const` and serves as the
single source, pinned to the Prisma enum both ways". Measured, that applies
cleanly to none of the three:

**`class/new/page.tsx` — the arrays are duplicates, so pinning them is the wrong
fix.** `CANCEL_DEADLINE_OPTIONS` and `AUTO_CANCEL_OPTIONS` are **byte-identical**
to the ones in `template-form.tsx`, which already has them `as const` with four
pins. Adding `as const` and four more pins to the second copy would leave two
copies of the same eight lines, both pinned, free to drift in their *labels*.

**Extract both to a shared module and pin once** — `src/lib/class-options.ts`,
beside `src/lib/class-fields.ts` which #135 created for the same reason. Both
files then import them. This is smaller than the issue's prescription and closes
the duplication rather than certifying it.

**`studio-template-form.tsx` — no enum involved.** `DAY_OPTIONS` is numeric
(`0`–`6`), and `dayOfWeek` is a number in the schema. There is no Prisma enum to
pin against and no enum pin to write. (Its `Monday = 0` convention is worth a
glance against what the generator expects, but that is not this issue's business.)

**`notifications-form.tsx` — there is no array to make `as const`.** It renders
four inline `<option value="eve">` literals. Pinning requires extracting one
first. It is worth doing: the values match `StudentReminderPref` exactly today,
and the codebase carries a second, similarly-named `ReminderPref`
(`morning_of | evening_before | one_hour_before`) governing the *teacher's*
`defaultReminder`. Nothing connects the form's literals to either enum, and the
two are one careless import apart.

### 4. Ten key-set tests, and a one-line glob change to allow two of them

`vitest.config.ts`'s components project includes only
`src/components/**/*.test.tsx`. Both page-level forms in scope
(`class/new/page.tsx`, `studio-class/new/page.tsx`) are `'use client'` and
RTL-testable, but no test file under `src/app/` is collected. Add
`src/app/**/*.test.tsx`.

This is **#143's own option 1**, described there as "cheapest, and immediately
unlocks `class/new/page.tsx`" — so it advances that issue rather than colliding
with it. Async server components remain uncovered; that is the rest of #143.

**No component test exists for any of the ten forms today.** #135's precedent is
pin *and* key-set test — it added `class-edit-form.test.tsx` and
`template-form.test.tsx` — so this adds ten files, each asserting the real
submitted body:

```ts
expect(Object.keys(body).sort()).toEqual([...]);
```

That runtime assertion is what makes the compile-time pins mean something:
create and update schemas usually agree on keys while differing in optionality
and `.strict()`, differences a key-set pin cannot see.

### 5. What a pin cannot do, stated so nobody over-trusts it

These pins make schema↔field-list drift impossible. They do **not** pin
field-list↔rendered-input — no type can see JSX. A field can still reach
production with no `<Input>`; it just has to get past a compile error naming it.
The key-set tests are what catch that last step, which is why every form gets
one.

For the three reverse-pin-only forms, even that is partial: nothing proves the
five uncovered `updateStudentSchema` fields *should* have inputs. Deciding that
means deciding whether a student may self-edit their own name and address, which
is a product question and not in scope here.

## Testing

- **Ten new component tests**, one per form, each asserting the submitted body's
  key set. For forms serving two endpoints, assert both modes — #135's
  `template-form.test.tsx` is the model.
- **The pins are compile-time**: `npx tsc --noEmit` failing *is* the test. Each
  task verifies its pin bites by temporarily removing a field from the form's
  list and confirming the error names that field, then restoring.
- **No behaviour changes.** Every rendered input, every submitted key, every
  label stays as it is. That is the reviewable invariant.

## Out of scope

- **`edit-room-form.tsx`** — `isPublic` is in `updateRoomSchema` and appears zero
  times in the form. #73 describes `PUT /api/rooms/[id] { isPublic: true }` as an
  irreversible one-way door, and the field having no UI is plausibly why that has
  never bitten anyone. Whether to render an input or drop the field from the
  schema is a product call about an irreversible action.
- **`profile-form.tsx`** — a forward pin fails the build today naming
  `photoUrl`, which is #46, specified and unbuilt. That is the pin working, but
  the fix waits on the feature.
- **`booking-sign-in.tsx`** — a sign-in flow, not an edit form.
- **#114**, the service-side half (`studio-class-template-lifecycle.ts` has no
  allowlist or forbidden-field pins at all). Natural to pair with instance 2, but
  it is a service change and this is a client-side PR.

## Risks

- **Ten forms is a wide diff for a "no behaviour change" claim.** The mitigation
  is that every change is mechanical and the key-set tests assert the submitted
  body exactly — if a key moves, a test fails by name.
- **The duplicated option arrays are the one place with real thinking.** Moving
  them to a shared module touches `template-form.tsx`, which is already pinned
  and already tested. Its tests must stay green untouched; if they need editing,
  the extraction changed behaviour and that is a defect.
- **A reverse-pin-only form looks under-pinned to a reviewer** who knows the
  #135 shape. The comment above each one carries the reason, and this section
  exists so the pattern is defensible rather than looking like an oversight.
- **The glob change widens what the `components` project collects.** Any existing
  `.test.tsx` under `src/app/` would start running; there are none today
  (verified), so the change is additive, but it will collect future ones
  automatically and that is the intent.
