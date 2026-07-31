# Form Field List Pins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each of the two edit forms a single field list, pinned to its schema in both directions, so a schema field with no form input fails the build naming that field (#81 + #85).

**Architecture:** Each form collapses to one enumeration of its fields — its state type — with the request payload derived from that state rather than restated. Two `NoneOf<Exclude<…>>` pins per form guard the list against the wire schema. `TemplateForm`'s two widened enums are tightened by making the existing dropdown arrays `as const` and pinning them to the Prisma enums.

**Tech Stack:** TypeScript strict (`noUncheckedIndexedAccess` on), Zod schemas, React client components, Vitest `components` project (jsdom + Testing Library).

## Global Constraints

- **TypeScript `strict: true`.** No `any`, **no type assertions to silence a type error**, no eslint suppressions.
- **Nothing server-only may be value-imported into a `'use client'` file.** `src/lib/log.ts` is pino and says so in its own docblock; `src/services/class-lifecycle.ts` value-imports `./notifications` → `@/lib/log`, so it is off-limits as a value import from a form. `import type` from it is fine (types are erased). The precedent for a client-importable module is `src/services/pricing.ts`, which has **zero** imports.
- **`import type` for `@prisma/client` in any `'use client'` file.** Every Prisma import in a client file in this repo is type-only; a value import would be the first.
- **Do not change either form's rendered markup, labels, or field order.** This is a types-and-plumbing change. The only intended runtime change is which keys appear in the request body.
- **Do not modify `prisma/schema.prisma`** except transiently in a mutation step, which must be reverted. **Never create a migration for it.**
- **Never restart the dev server on `:3000`.** It is managed manually by the repo owner.
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.

---

## File Structure

| File | Change | Task |
|---|---|---|
| `src/lib/class-fields.ts` | **New** — client-safe home for `ECONOMIC_FIELDS` / `EconomicField` | 1 |
| `src/services/class-lifecycle.ts` | Import those two from the new module instead of declaring them | 1 |
| `src/components/class/class-edit-form.tsx` | Two pins; payload derived from `ClassEditInitial` | 2 |
| `src/components/class/class-edit-form.test.tsx` | **New** | 2 |
| `src/components/settings/template-form.tsx` | Collapse three copies to one `TemplateFormValues`; two pins; derived payload | 3 |
| `src/components/settings/template-form.test.tsx` | **New** | 3 |
| `src/components/settings/template-form.tsx` | Options arrays `as const`; four enum pins; two guards | 4 |

**Task 1 exists because of a constraint the spec did not foresee.** The spec has the form derive its gated five from `ECONOMIC_FIELDS`, which lives in `class-lifecycle.ts` — a module that value-imports server-only pino. Importing it from a client form would pull pino into the browser bundle, so the constant moves to a leaf module with no imports of its own.

**`src/services/class-lifecycle.test.ts` imports both `ECONOMIC_FIELDS` (`:5`) and `type EconomicField` (`:13`) from `class-lifecycle`**, including a `@ts-expect-error` pin on the type at `:783-789`. The re-export in Step 2 is what keeps that working and is **not optional** — dropping it as an export with no consumers breaks that test file. (An earlier draft of this note claimed there were no importers outside the source file; that came from a grep that required `import` on the same line as the symbol, which multi-line import blocks defeat.)

**Tasks 3 and 4 both edit `template-form.tsx`** and must run in order. They are split because a reviewer can meaningfully accept the field-list pinning while rejecting the enum treatment, or vice versa.

---

### Task 1: Move `ECONOMIC_FIELDS` to a client-safe module

**Files:**
- Create: `src/lib/class-fields.ts`
- Modify: `src/services/class-lifecycle.ts:71-84`

**Interfaces:**
- Produces: `ECONOMIC_FIELDS` (a frozen `readonly ['roomCost','minRate','targetRate','minStudents','maxStudents']`) and `type EconomicField`, both importable from `@/lib/class-fields` by client and server code alike. Task 2 value-imports `ECONOMIC_FIELDS` from there.
- Consumes: nothing.

- [ ] **Step 1: Create the new module**

Create `src/lib/class-fields.ts`. Move the declaration verbatim — same values, same order, same `Object.freeze`, same `as const`:

```ts
/**
 * The economic fields that become immutable once settings_locked flips true
 * (i.e., after the first student registers).
 *
 * Lives in `lib/` rather than beside `updateClass` because
 * `class-edit-form.tsx` needs the *value* at runtime to strip these keys from
 * a locked payload, and it is a `'use client'` component: importing from
 * `services/class-lifecycle.ts` would pull that module's transitive
 * `@/lib/log` (pino, server-only) into the browser bundle. This module has no
 * imports at all, which is what makes it safe from either side — the same
 * property that lets `pricing-preview-table.tsx` import `services/pricing.ts`.
 */
export const ECONOMIC_FIELDS = Object.freeze([
  'roomCost',
  'minRate',
  'targetRate',
  'minStudents',
  'maxStudents',
] as const);

export type EconomicField = (typeof ECONOMIC_FIELDS)[number];
```

- [ ] **Step 2: Re-point `class-lifecycle.ts`**

Delete the `ECONOMIC_FIELDS` and `EconomicField` declarations from `src/services/class-lifecycle.ts` (currently `:71-84`, including the docblock — the comment moves with them) and add to its imports:

```ts
import { ECONOMIC_FIELDS, type EconomicField } from '@/lib/class-fields';
```

Then re-export both. This is required, not tidiness: `class-lifecycle.test.ts` imports `ECONOMIC_FIELDS` at `:5` and `type EconomicField` at `:13` from this module, and `:783-789` pins the type with a `@ts-expect-error`. Removing the export breaks that file.

```ts
export { ECONOMIC_FIELDS, type EconomicField };
```

- [ ] **Step 3: Verify nothing else broke**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit src/services/class-lifecycle.test.ts
```

Expected: clean, and the existing `class-lifecycle` unit tests unchanged. This step is a pure move — if any test output differs, stop and report rather than adjusting the test.

- [ ] **Step 4: Commit**

```bash
git add src/lib/class-fields.ts src/services/class-lifecycle.ts
git commit -m "refactor: move ECONOMIC_FIELDS to a client-safe module (#81)"
```

---

### Task 2: Pin `ClassEditForm` and derive its payload

**Files:**
- Modify: `src/components/class/class-edit-form.tsx`
- Create: `src/components/class/class-edit-form.test.tsx`

**Interfaces:**
- Consumes from Task 1: `import { ECONOMIC_FIELDS } from '@/lib/class-fields'`.
- Produces: nothing later tasks depend on. Task 3 follows the same shape but on a different file.

- [ ] **Step 1: Write the failing tests**

Create `src/components/class/class-edit-form.test.tsx`. The `components` project picks up `src/components/**/*.test.tsx`; `next/navigation` is already stubbed by `tests/setup/components.ts`.

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ClassEditForm, type ClassEditInitial } from './class-edit-form';

/**
 * #81. This form used to enumerate its field list twice — once as
 * `ClassEditInitial`, once as the payload builder — under a comment claiming it
 * "Mirrors updateClassSchema exactly", which nothing checked. The list is now
 * single and compiler-pinned; what a pin cannot see is which keys actually
 * reach the API, and that is what these tests hold.
 *
 * The `settingsLocked` fork is the reason this file exists. It decides whether
 * five economic fields are sent, and getting it wrong means either a teacher
 * silently cannot edit their pricing, or a locked class accepts an edit the
 * route will reject with a 400.
 */
describe('ClassEditForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const initial: ClassEditInitial = {
    classType: 'Vinyasa',
    description: 'Bring a mat.',
    date: '2026-06-12',
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 4,
    maxStudents: 12,
  };

  async function saveWith(settingsLocked: boolean): Promise<Record<string, unknown>> {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ClassEditForm classId="cls-1" settingsLocked={settingsLocked} initial={initial} />);
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    return JSON.parse((options as { body: string }).body) as Record<string, unknown>;
  }

  it('sends every editable field when settings are unlocked', async () => {
    const body = await saveWith(false);
    expect(Object.keys(body).sort()).toEqual([
      'classType', 'date', 'description', 'durationMinutes', 'maxStudents',
      'minRate', 'minStudents', 'roomCost', 'startTime', 'targetRate',
    ]);
  });

  /**
   * Pins that the five economic keys do not reach the API when settings are
   * locked, by whatever mechanism the component uses to leave them out.
   *
   * This does not distinguish `delete payload[f]` from a hypothetical
   * `payload[f] = undefined`: `JSON.stringify` produces byte-identical output
   * for both, and this test only ever observes `JSON.parse(body)`. The route
   * itself would accept either — it filters on `data[f] !== undefined`
   * (class-lifecycle.ts:457) — so the two are equivalent over the wire, and no
   * test here tells them apart. Not that none could: a spy on
   * `JSON.stringify` sees the object before it is serialized, where the two
   * differ. It would be testing the mechanism rather than what is sent, which
   * is why this file does not.
   */
  it('omits the economic fields when settings are locked', async () => {
    const body = await saveWith(true);
    expect(Object.keys(body).sort()).toEqual([
      'classType', 'date', 'description', 'durationMinutes', 'startTime',
    ]);
    for (const f of ['roomCost', 'minRate', 'targetRate', 'minStudents', 'maxStudents']) {
      expect(body).not.toHaveProperty(f);
    }
  });

  it('sends an empty description as null', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: {} }) });
    vi.stubGlobal('fetch', fetchMock);
    render(
      <ClassEditForm
        classId="cls-1"
        settingsLocked={false}
        initial={{ ...initial, description: '' }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const body = JSON.parse((options as { body: string }).body) as Record<string, unknown>;
    expect(body.description).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail or pass**

Run: `npx vitest run --project components src/components/class/class-edit-form.test.tsx`

Expected: **all three PASS** against the current implementation. That is correct and worth not dressing up: these are characterization tests pinning the behaviour the current payload builder already has, so that Step 3's rewrite cannot change it silently. The red-green cycle for this task belongs to the pins, which Step 5 exercises by mutation.

If any of the three fails, the current form does not behave as this plan assumes — stop and report rather than adjusting the test to match.

- [ ] **Step 3: Add the pins**

In `src/components/class/class-edit-form.tsx`, add these imports:

```tsx
import type { z } from 'zod';
import type { updateClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
import { ECONOMIC_FIELDS } from '@/lib/class-fields';
```

and, immediately below the `ClassEditInitial` declaration:

```tsx
type UpdateClassWire = z.infer<typeof updateClassSchema>;

/**
 * #81. `ClassEditInitial` is the only enumeration of this form's fields, and
 * these two pins are what make it safe to have only one. Before them the list
 * was stated twice and checked nowhere, under a comment asserting it "mirrors
 * updateClassSchema exactly".
 *
 * Forward: a field added to the schema with no form field fails the build,
 * naming it — the defect #81 reports, where a teacher-editable field looks
 * shipped with no input rendered.
 *
 * Reverse: a field the schema dropped but the form still sends. `.strict()`
 * would 400 it at runtime; this catches it at compile time instead.
 *
 * `NoneOf` resolves to `T` rather than collapsing to `never`, so a failure
 * reads `Type 'true' is not assignable to type '"waitlistCap"'` instead of
 * naming no field at all.
 */
const _formCoversSchema: NoneOf<Exclude<keyof UpdateClassWire, keyof ClassEditInitial>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof ClassEditInitial, keyof UpdateClassWire>> = true;
void _formCoversSchema;
void _formHasNoExtras;
```

- [ ] **Step 4: Derive the payload**

Replace the payload builder (currently `:49-62`, the `const payload: Record<string, unknown> = {…}` block and the `if (!settingsLocked) {…}` block that follows it) with:

```tsx
      // Derived from `form`, not restated. The old builder listed all ten
      // fields a second time; keeping one list is the point of #81, and the
      // pins above are what keep that list honest.
      //
      // Spreading cannot flag an extra field — TypeScript's excess-property
      // check does not survive a spread, which `class-lifecycle.ts:242` records
      // for the route's own payload. The reverse pin covers that instead, but
      // only against `ClassEditInitial`'s statically declared keys — it can't
      // see an own-enumerable property `form` happens to carry at runtime that
      // isn't declared on the type.
      const payload: UpdateClassWire = { ...form, description: form.description || null };
      if (settingsLocked) {
        for (const f of ECONOMIC_FIELDS) delete payload[f];
      }
```

Also delete the now-false line from the component's header comment: `// Mirrors updateClassSchema exactly:` — it is the prose assertion the pins replace. Keep the rest of that comment (details always editable, economic fields only while unlocked, policies not part of the update schema), which is still true.

(Both `class-lifecycle.ts` line citations above — `:457` and `:242` — reflect this branch's Task 1, which removed 11 net lines from that file before Task 2 was written; the plan originally cited `:467` and `:252`.)

- [ ] **Step 5: Typecheck, lint, re-run**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components src/components/class/class-edit-form.test.tsx
```

Expected: clean, three tests still passing with no edits to them. If a test needed changing, the rewrite changed behaviour — stop and report.

- [ ] **Step 6: Mutation-verify both pins bite**

One at a time, confirming with `git diff` that each edit landed before running, and reverting before the next. **A mutation you did not confirm landed proves nothing.**

1. Add `waitlistCap: z.number().optional(),` to `updateClassSchema` in `src/lib/schemas.ts` → `npx tsc --noEmit` must fail with `Type 'true' is not assignable to type '"waitlistCap"'`. Revert.
2. Delete `maxStudents` from `ClassEditInitial` → must fail naming `"maxStudents"`, from the *forward* pin. Revert.
3. Delete `maxStudents: z.number()…` from `updateClassSchema` → must fail naming `"maxStudents"`, from the *reverse* pin. Revert.

Note that (2) and (3) name the same field from opposite pins; check the error line number to confirm which pin fired, and report both.

- [ ] **Step 7: Commit**

```bash
git add src/components/class/class-edit-form.tsx src/components/class/class-edit-form.test.tsx
git commit -m "fix: pin ClassEditForm's field list and derive its payload (#81)"
```

---

### Task 3: Collapse `TemplateForm`'s three lists to one and pin it

**Files:**
- Modify: `src/components/settings/template-form.tsx`
- Create: `src/components/settings/template-form.test.tsx`

**Interfaces:**
- Consumes: nothing from Tasks 1-2. This task mirrors Task 2's shape on a different file.
- Produces: `export interface TemplateFormValues` — the single field list, consumed by Task 4, which tightens two of its members from `string` to Prisma enum unions.

- [ ] **Step 1: Write the failing tests**

Create `src/components/settings/template-form.test.tsx`.

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TemplateForm } from './template-form';

/**
 * #85. This form enumerated its thirteen fields three times — the `initial`
 * prop, `INITIAL_VALUES`, and the PUT body — and nothing checked that the three
 * agreed with each other or with `updateClassTemplateSchema`. One list now,
 * compiler-pinned; these tests hold what a pin cannot see, which is what
 * actually reaches the API.
 *
 * The form fetches its room list on mount, so `fetch` is stubbed for every
 * test rather than only the saving ones. The first call is that room fetch;
 * the submit is the last call, which is why the assertions read
 * `mock.calls.at(-1)` rather than `calls[0]`.
 */
describe('TemplateForm', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const initial = {
    teacherRoomId: '11111111-1111-4111-8111-111111111111',
    classType: '  Vinyasa  ',
    description: '  Bring a mat.  ',
    dayOfWeek: 2,
    startTime: '09:30',
    durationMinutes: 60,
    roomCost: 20,
    minRate: 15,
    targetRate: 25,
    minStudents: 4,
    maxStudents: 12,
    cancelDeadline: 'HOURS_24',
    autoCancelCheck: 'HOURS_2',
  } as const;

  function stubFetch() {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [{
          id: '11111111-1111-4111-8111-111111111111',
          capacityOverride: 30,
          rentalRate: 20,
          room: { roomName: 'Studio A', venueName: 'Main Venue' },
        }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);
  }

  /**
   * Returns the URL and method alongside the parsed body — not just the body
   * — so a test can pin `calls.at(-1)` to the request it means. Without that,
   * an intervening `fetch` added later could make `.at(-1)` silently select
   * the wrong call while every body assertion still passed.
   */
  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    const button = await screen.findByRole('button', { name: /save|create/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(1));
    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    return {
      url: url as string,
      method: opts.method,
      body: JSON.parse(opts.body) as Record<string, unknown>,
    };
  }

  it('sends all thirteen fields when editing', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const { url, method, body } = await submit();
    expect(url).toBe('/api/class-templates/tpl-1');
    expect(method).toBe('PUT');
    expect(Object.keys(body).sort()).toEqual([
      'autoCancelCheck', 'cancelDeadline', 'classType', 'dayOfWeek', 'description',
      'durationMinutes', 'maxStudents', 'minRate', 'minStudents', 'roomCost',
      'startTime', 'targetRate', 'teacherRoomId',
    ]);
  });

  it('trims classType and description before sending', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const { body } = await submit();
    expect(body.classType).toBe('Vinyasa');
    expect(body.description).toBe('Bring a mat.');
  });

  it('sends a whitespace-only description as null', async () => {
    stubFetch();
    render(
      <TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial, description: '   ' }} />,
    );
    const { body } = await submit();
    expect(body.description).toBeNull();
  });

  /**
   * Create sends the same body to a different endpoint, and
   * `createClassTemplateSchema` requires fields the update one leaves optional
   * — so a body good enough for PUT can still be rejected by POST. Asserting
   * the key set on both modes is what makes the one create-side pin in the
   * source file (`_formCoversCreate`, checked against `CreateTemplateWire`)
   * mean something at runtime: the pin only guards the *key set*, and the
   * create and update schemas agree on keys while differing in optionality
   * and `.strict()` — differences a key-set pin can't see, which is exactly
   * what this runtime assertion adds.
   */
  it('sends the same thirteen fields when creating', async () => {
    stubFetch();
    render(<TemplateForm mode="create" />);
    const roomSelect = await screen.findByLabelText('Room');
    fireEvent.change(roomSelect, {
      target: { value: '11111111-1111-4111-8111-111111111111' },
    });
    fireEvent.change(screen.getByLabelText('Class type'), {
      target: { value: 'Vinyasa' },
    });
    const { url, method, body } = await submit();
    expect(url).toBe('/api/class-templates');
    expect(method).toBe('POST');
    expect(Object.keys(body).sort()).toEqual([
      'autoCancelCheck', 'cancelDeadline', 'classType', 'dayOfWeek', 'description',
      'durationMinutes', 'maxStudents', 'minRate', 'minStudents', 'roomCost',
      'startTime', 'targetRate', 'teacherRoomId',
    ]);
  });
});
```

The submit button is `type="submit"` inside a `<form>` (`:365`), so `fireEvent.click` works through form submission rather than an onClick handler. If that turns out not to fire in jsdom, submit the form directly (`fireEvent.submit`) and note the change — do not weaken the assertion.

- [ ] **Step 2: Run the tests**

Run: `npx vitest run --project components src/components/settings/template-form.test.tsx`

Expected: **all four PASS** against the current implementation — characterization tests, same as Task 2 Step 2.

The block above is the harness as it shipped, which is not how it was first written. Three details are load-bearing and each was a red test before it was fixed; a re-executing agent that "simplifies" any of them back will get a harness that cannot run, under a step that says it should be green:

1. **`stubFetch` returns a real room, not `{ data: [] }`.** With an empty list the component renders "No rooms configured." and there is no submit button at all — `submit()` fails on the query, not on an assertion.
2. **`submit()` uses `await screen.findByRole`, not `screen.getByRole`.** The form gates on `loading` while the room fetch resolves, so the synchronous query runs against "Loading rooms..." and finds no button.
3. **The create test selects a room and types a class type before submitting.** `handleSubmit` returns early at the `!form.teacherRoomId` guard and never calls `fetch`, so `waitFor` waits out its full timeout for a second call that will never come. Edit mode does not need this — its `initial` supplies both.

If something else in the stubbing does not hold, fix the stub to match what the component actually needs and **say what you changed in your report**. Do not weaken an assertion to make a render problem go away.

- [ ] **Step 3: Introduce the single list**

In `src/components/settings/template-form.tsx`, replace the inline `initial?: { … }` object type (currently `:21-35`) with a named export, and use it for both the prop and `INITIAL_VALUES`:

```tsx
/**
 * #85. The one enumeration of this form's fields. It replaced three that
 * nothing reconciled: this prop's inline type, `INITIAL_VALUES`, and the
 * request body. The pins below hold it against the wire schema.
 */
export interface TemplateFormValues {
  teacherRoomId: string;
  classType: string;
  description: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  roomCost: number;
  minRate: number;
  targetRate: number;
  minStudents: number;
  maxStudents: number;
  cancelDeadline: string;
  autoCancelCheck: string;
}

interface TemplateFormProps {
  mode: 'create' | 'edit';
  templateId?: string;
  initial?: TemplateFormValues;
}
```

and type the defaults against it, so a field added to the interface without a default fails here:

```tsx
const INITIAL_VALUES: TemplateFormValues = {
```

(keep the existing values unchanged).

`cancelDeadline` and `autoCancelCheck` stay `string` in this task. Task 4 tightens them; doing it here would mix two reviewable changes.

- [ ] **Step 4: Add the pins**

Add these imports:

```tsx
import type { z } from 'zod';
import type { createClassTemplateSchema, updateClassTemplateSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
```

and below `TemplateFormValues`:

```tsx
type UpdateTemplateWire = z.infer<typeof updateClassTemplateSchema>;
type CreateTemplateWire = z.infer<typeof createClassTemplateSchema>;

/**
 * #85. Both schemas, both directions — four pins, because this form sends one
 * body to both endpoints.
 *
 * The issue warned that a pin "has to target the right schema per branch"
 * because create and update differ — they do differ, in optionality and
 * `.strict()`, but not in *keys*: thirteen each, the same thirteen. For a
 * key-set pin they are interchangeable as things stand. The day their keys
 * diverge, that single body stops satisfying one of them, and a pin against
 * only the other would not notice.
 *
 * Forward (`_formCovers…`): a key the schema has and the form does not — a
 * field that looks shipped with no input rendered for it.
 *
 * Reverse (`_formHasNoExtras…`): a key the form sends and the schema dropped.
 * The two endpoints punish that differently, which is why both are pinned
 * rather than just the update one: `updateClassTemplateSchema` is `.strict()`
 * and would 400 the extra key, while `createClassTemplateSchema` is not, so it
 * would *silently strip* it — the field-vanishes-without-a-word mode this
 * change exists to eliminate. Compile time catches both.
 */
const _formCoversUpdate: NoneOf<Exclude<keyof UpdateTemplateWire, keyof TemplateFormValues>> = true;
const _formCoversCreate: NoneOf<Exclude<keyof CreateTemplateWire, keyof TemplateFormValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof TemplateFormValues, keyof UpdateTemplateWire>> = true;
const _formHasNoExtrasOnCreate: NoneOf<Exclude<keyof TemplateFormValues, keyof CreateTemplateWire>> = true;
void _formCoversUpdate;
void _formCoversCreate;
void _formHasNoExtras;
void _formHasNoExtrasOnCreate;
```

**All four, not three.** The first version of this task pinned the reverse direction against `UpdateTemplateWire` only, under a docblock arguing that a pin against one schema would not notice the other diverging — which described its own state. It was measured: dropping `dayOfWeek` from `createClassTemplateSchema` alone produced no error in the file.

- [ ] **Step 5: Derive the payload**

Replace the `body: JSON.stringify({ … })` literal (currently `:153-167`) with a derivation:

```tsx
      // The intersection, not either half: one body goes to both endpoints, so
      // it has to satisfy both schemas. The pins above hold the *key sets*
      // against both; this annotation is what holds the *value types* — without
      // it the literal is inferred, and retyping a schema field (say
      // `durationMinutes` to a string) would change what the route expects
      // while this file kept compiling.
      const payload: CreateTemplateWire & UpdateTemplateWire = {
        ...form,
        classType: form.classType.trim(),
        description: form.description.trim() || null,
      };

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
```

The two overrides stay explicit because they transform rather than pass through — trimming, and empty-to-`null`. Everything else comes from `form` and is no longer restated.

**Annotate it; do not pass the literal straight into `JSON.stringify`.** That was the first version, and it left the value types unheld: retyping `updateClassTemplateSchema.durationMinutes` to `z.string()` produced zero errors in this file, where the same change against `updateClassSchema` already failed at `class-edit-form.tsx:86`. The intersection compiles clean with no assertion — verified — and it is the honest type for a body sent to two endpoints.

- [ ] **Step 6: Typecheck, lint, re-run**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components src/components/settings/template-form.test.tsx
```

Expected: clean, four tests still passing with no edits. Also confirm `src/app/(teacher)/settings/recurring/[id]/page.tsx:37-51` still compiles — it passes an `initial` literal of all thirteen fields, and with `TemplateFormValues` now named and required, a missing one fails there. That is intended; it should not need editing today.

- [ ] **Step 7: Mutation-verify the pins**

One at a time, `git diff`-confirmed before each run, reverted after:

1. Add `waitlistCap: z.number().optional(),` to `updateClassTemplateSchema` → must fail naming `"waitlistCap"`.
2. Add `waitlistCap: z.number(),` to `createClassTemplateSchema` only → must fail naming `"waitlistCap"`, proving the forward create pin is not redundant with the update one.
3. Delete `dayOfWeek` from `TemplateFormValues` → must fail naming `"dayOfWeek"`.
4. Delete `dayOfWeek` from `createClassTemplateSchema` only → must fail naming `"dayOfWeek"` **from `_formHasNoExtrasOnCreate`**, proving the same for the reverse direction. Check the error's line number, not just the field name: (3) and this one name the same field from different pins.
5. Retype one value in `updateClassTemplateSchema` (e.g. `durationMinutes` to `z.string().optional()`) → must fail at the `const payload:` line with `Type 'number' is not assignable to type 'string'`. This is the annotation, not a pin; no pin can see a value type.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx
git commit -m "fix: collapse TemplateForm's three field lists to one, pinned (#85)"
```

---

### Task 4: Tighten `TemplateForm`'s two widened enums

**Files:**
- Modify: `src/components/settings/template-form.tsx`
- Modify: `src/components/settings/template-form.test.tsx`

**Interfaces:**
- Consumes from Task 3: `TemplateFormValues`, whose `cancelDeadline` and `autoCancelCheck` are currently `string`.
- Produces: nothing.

**Must run after Task 3.**

- [ ] **Step 1: Write the failing test**

Append to `src/components/settings/template-form.test.tsx`:

```tsx
  /**
   * #85's second half. These two fields were typed `string` against Prisma
   * enums of four and three members, so `update('cancelDeadline', 'HOURS_99')`
   * compiled. The dropdown arrays are now the single source of both the union
   * and the `<option>`s, so the two cannot disagree.
   *
   * This asserts the rendered options rather than the type, because the type is
   * held by the pins in the source file and a runtime test cannot see it. What
   * a runtime test *can* see is that every enum member is actually offered —
   * the failure a teacher would meet is a missing choice, not a type error.
   *
   * Narrower than the spec asked for, deliberately. The spec wanted a test of
   * "the enum guard rejecting a value outside the dropdown". The guards are
   * module-private, and exporting them only so a test can reach them is the
   * pattern PR #131's review rejected. Driving an invalid value through the
   * component is not possible either — the `<option>`s are the same array the
   * guard reads, so there is no way to select one it would refuse. What is
   * left is this: assert that the offered set equals the enum, which is the
   * property the guard exists to preserve.
   */
  it('offers every cancellation deadline the schema accepts', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const select = await screen.findByLabelText(/cancellation deadline/i);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values.sort()).toEqual(['HOURS_12', 'HOURS_24', 'HOURS_48', 'HOURS_6']);
  });

  it('offers every auto-cancel check the schema accepts', async () => {
    stubFetch();
    render(<TemplateForm mode="edit" templateId="tpl-1" initial={{ ...initial }} />);
    const select = await screen.findByLabelText(/auto-cancel check/i);
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(values.sort()).toEqual(['HOURS_1', 'HOURS_2', 'HOURS_4']);
  });
```

- [ ] **Step 2: Run and watch them pass**

Run: `npx vitest run --project components src/components/settings/template-form.test.tsx`
Expected: six tests, all passing. Characterization again — the dropdowns already offer these values; the tests exist so Step 3's rewrite cannot quietly drop one.

- [ ] **Step 3: Make the options arrays the source of truth**

Add the type import:

```tsx
import type { CancelDeadline, AutoCancelCheck } from '@prisma/client';
```

Make both arrays `as const` and derive their unions:

```tsx
const CANCEL_DEADLINE_OPTIONS = [
  { value: 'HOURS_48', label: '48 hours' },
  { value: 'HOURS_24', label: '24 hours' },
  { value: 'HOURS_12', label: '12 hours' },
  { value: 'HOURS_6', label: '6 hours' },
] as const;

const AUTO_CANCEL_OPTIONS = [
  { value: 'HOURS_4', label: '4 hours before' },
  { value: 'HOURS_2', label: '2 hours before' },
  { value: 'HOURS_1', label: '1 hour before' },
] as const;
```

Then pin each array to its Prisma enum in both directions:

```tsx
type CancelDeadlineOption = (typeof CANCEL_DEADLINE_OPTIONS)[number]['value'];
type AutoCancelOption = (typeof AUTO_CANCEL_OPTIONS)[number]['value'];

/**
 * The dropdown is the list. An enum member with no option here fails the build,
 * so a teacher can never be offered a stale set of choices — the same defect as
 * the field-list pins above, one level down.
 *
 * Consequence worth knowing before deleting an entry: removing an option to
 * hide a choice from teachers now fails the build. Hiding a choice means
 * removing it from the enum, or gating it at render.
 */
const _offersEveryDeadline: NoneOf<Exclude<CancelDeadline, CancelDeadlineOption>> = true;
const _noStaleDeadline: NoneOf<Exclude<CancelDeadlineOption, CancelDeadline>> = true;
const _offersEveryCheck: NoneOf<Exclude<AutoCancelCheck, AutoCancelOption>> = true;
const _noStaleCheck: NoneOf<Exclude<AutoCancelOption, AutoCancelCheck>> = true;
void _offersEveryDeadline;
void _noStaleDeadline;
void _offersEveryCheck;
void _noStaleCheck;
```

- [ ] **Step 4: Tighten the two fields and narrow at the `<select>`**

In `TemplateFormValues`:

```tsx
  cancelDeadline: CancelDeadline;
  autoCancelCheck: AutoCancelCheck;
```

Add the two guards beside the arrays:

```tsx
/**
 * `<select>` hands back `e.target.value` as `string`; these narrow it without
 * an assertion. They read the options array rather than a second list, so
 * there is nothing here that can drift from what is rendered.
 */
function isCancelDeadline(v: string): v is CancelDeadline {
  return CANCEL_DEADLINE_OPTIONS.some((o) => o.value === v);
}

function isAutoCancelCheck(v: string): v is AutoCancelCheck {
  return AUTO_CANCEL_OPTIONS.some((o) => o.value === v);
}
```

and use them at the two `onChange` handlers — `:366` (`cancelDeadline`) and `:377` (`autoCancelCheck`).

Those are the line numbers **after Task 3**, which this task must follow. Task 3 adds roughly twenty lines above them (the exported interface, the four pins, their docblock), so the handlers move down: at `:344` you will find the `maxStudents` `setForm` callback and at `:355` a `<PricingPreviewTable>` prop, not these. Match on the handler text rather than the line number.

```tsx
        onChange={(e) => {
          if (isCancelDeadline(e.target.value)) update('cancelDeadline', e.target.value);
        }}
```

```tsx
        onChange={(e) => {
          if (isAutoCancelCheck(e.target.value)) update('autoCancelCheck', e.target.value);
        }}
```

A value outside the list is dropped rather than stored. It cannot occur through the UI — the options are the same array the guard reads — so this is a boundary guard, not a user-facing path, and deliberately has no error state.

- [ ] **Step 5: Typecheck, lint, run**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components src/components/settings/template-form.test.tsx
```

Expected: clean, six tests passing. `settings/recurring/[id]/page.tsx:49-50` passes `template.cancelDeadline` / `template.autoCancelCheck` straight from Prisma, which are already the enum types, so it should need no edit — confirm rather than assume.

- [ ] **Step 6: Mutation-verify the enum pins**

`git diff`-confirmed, reverted after each:

1. Delete the `HOURS_6` entry from `CANCEL_DEADLINE_OPTIONS` → `tsc` must fail naming `"HOURS_6"`, and the "offers every cancellation deadline" test must fail too. Both, not either.
2. Add `{ value: 'HOURS_3', label: '3 hours' },` to `CANCEL_DEADLINE_OPTIONS` → must fail naming `"HOURS_3"` from the reverse pin.

- [ ] **Step 7: Run the full suites**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project unit
npx vitest run --project components
npx playwright test
```

Expected: unit unchanged, components up by 9 (3 + 4 + 2), e2e 118 passing. The e2e matters here: `recurring.spec.ts` (`'creates a template through settings'`) and `class-edit.spec.ts` drive these forms through the browser, and they are the only coverage of the create path end to end.

Do NOT run `npx vitest run --project integration` — its `signup-api` tests are rate-limited per IP (3/hour and 5/hour) and are routinely exhausted. If you run it by accident and see `expected 429 to be 201`, that is the limiter, not this change; report it and do not re-run to confirm.

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx
git commit -m "fix: tighten TemplateForm's two schema enums, dropdown as source (#85)"
```

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — unchanged from `main`
- [ ] `npx vitest run --project components` — 48 + 9 = 57 passing
- [ ] `npx playwright test` — 118 passing
- [ ] `git status --short` — only `docs/backlog-roadmap.md` untracked; **`prisma/` unchanged**
- [ ] Review the diff's `as` assertions — none exists to silence a type error. `as const` is fine, and so are the narrowing casts on untyped `fetch` mock args in the test files (`options as { body: string }` and similar); that is pre-existing repo convention, not new here.
- [ ] Every mutation step was **observed**, with its `git diff` confirmed first: Task 2 Step 6, Task 3 Step 7, Task 4 Step 6. (Step 2 in each task is a characterization run, not a mutation — it isn't part of this check.)
- [ ] Neither form's markup, labels, or field order changed
- [ ] `src/app/(teacher)/settings/recurring/[id]/page.tsx` needed no edit
- [ ] The `// Mirrors updateClassSchema exactly` comment is gone from `class-edit-form.tsx`
