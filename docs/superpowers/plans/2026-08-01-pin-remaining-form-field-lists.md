# Pinning the Remaining Form Field Lists Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pin ten forms' field lists to the Zod schemas they post to, so a schema key with no rendered input fails the build instead of shipping silently (#136).

**Architecture:** Each form declares one field list (its state or prop type), derives its request body from that list rather than restating it, and carries `NoneOf<Exclude<…>>` pins in both directions against its schema. Forms that share a schema with other forms get the reverse pin only. Every form gains a component test asserting the submitted body's key set, which is the runtime half the compile-time pins cannot provide.

**Tech Stack:** TypeScript strict, Zod, React Testing Library under Vitest's `components` project (jsdom).

## Global Constraints

- **TypeScript `strict: true`, `noUncheckedIndexedAccess` on.** No `any`, **no type assertions to silence a type error**, no eslint suppressions.
- **Zero rendered output changes.** No input added, removed or relabelled; no submitted key added or dropped. This is the reviewable invariant for the whole PR. If a pin can only be satisfied by changing what renders, exclude the key and record why — do not change the render.
- **`NoneOf` resolves to `T` rather than collapsing to `never`**, so a failure names the offending field. Import it from `@/lib/type-pins`.
- **Every pin gets `void _pinName;`** after it, matching `template-form.tsx` — otherwise `noUnusedLocals` rejects it.
- **`src/components/settings/template-form.tsx` is the reference.** Copy its shape. Do not re-derive it, and do not "improve" it.
- **Never `git add -A` or `git add .`** — `docs/backlog-roadmap.md` is deliberately untracked. Stage by explicit path.
- **Never restart the dev server on `:3000`.**
- Do NOT run `npx vitest run --project integration` — one of its files is IP rate-limited.

---

## File Structure

| File | Change | Task |
|---|---|---|
| `src/lib/class-options.ts` | **Create** — the two shared enum option arrays, pinned once | 1 |
| `src/components/settings/template-form.tsx` | Import the arrays instead of declaring them | 1 |
| `vitest.config.ts` | `components` project also collects `src/app/**/*.test.tsx` | 1 |
| `src/app/(teacher)/class/new/page.tsx` | Derive body from `FormData`; pins with two exclusions | 2 |
| `src/app/(teacher)/class/new/page.test.tsx` | **Create** — key-set test | 2 |
| `src/components/settings/studio-template-form.tsx` | Four pins (create + update, both directions) | 3 |
| `src/components/settings/studio-template-form.test.tsx` | **Create** | 3 |
| `src/app/(teacher)/studio-class/new/page.tsx` | Pins with two exclusions | 3 |
| `src/app/(teacher)/studio-class/new/page.test.tsx` | **Create** | 3 |
| `src/components/settings/add-room-flow.tsx` | Two independent bodies, two schemas, four pins | 4 |
| `src/components/settings/add-room-flow.test.tsx` | **Create** | 4 |
| `src/components/settings/edit-teacher-room-form.tsx` | Two pins | 4 |
| `src/components/settings/edit-teacher-room-form.test.tsx` | **Create** | 4 |
| `src/components/students/create-student-form.tsx` | Two pins | 4 |
| `src/components/students/create-student-form.test.tsx` | **Create** | 4 |
| `src/components/student/teacher-privacy-card.tsx` | Two pins (body already spread-derived) | 4 |
| `src/components/student/teacher-privacy-card.test.tsx` | **Create** | 4 |
| `src/components/student/notifications-form.tsx` | Reverse pin only; extract the reminder options | 5 |
| `src/components/student/notifications-form.test.tsx` | **Create** | 5 |
| `src/components/student/tier-form.tsx` | Reverse pin only | 5 |
| `src/components/student/tier-form.test.tsx` | **Create** | 5 |
| `src/components/students/edit-student-form.tsx` | Two pins against `createStudentSchema` | 5 |
| `src/components/students/edit-student-form.test.tsx` | **Create** | 5 |

**Task boundaries.** Task 1 is infrastructure both later tasks depend on. Task 2 is alone because it is the widest form and the only one whose exclusions are security- and UX-adjacent. Tasks 3–5 group forms by the shape of their pin: two-schema forms, single-schema owners, and shared-schema reverse-only forms. A reviewer can reject any one without touching its neighbours.

---

## The two forms that cannot pin cleanly, and why

Measured before writing this plan; do not rediscover it at the first `tsc` run.

**`class/new/page.tsx`** — `createClassSchema` has 14 keys, `FormData` has 12. The two missing are excluded, each with its own filed issue:

- **`description`** — the schema accepts it, `POST /api/classes` writes it, `class-edit-form.tsx` renders an input for it, and this wizard renders nothing. A teacher can describe a class only after creating it. **#147.**
- **`templateId`** — server-set by `class-generator.ts`, zero occurrences in the wizard's UI, and the route passes a client value into `prisma.class.create` with no ownership check. **#146.**

**`studio-class/new/page.tsx`** — `createStudioClassSchema` has 8 keys, the form sends 6. Both extras are **dead schema surface**: `POST /api/studio-classes` accepts `studentCount` and `templateId` and never reads either (verified — neither appears in its `prisma.studioClass.create` data block). `studentCount` is set later by `student-count-editor.tsx`. No issue filed; the exclusion comment is the record.

**Every other form in scope matches its schema exactly.** Verified key-by-key.

---

### Task 1: The shared option arrays, and the test glob

**Files:**
- Create: `src/lib/class-options.ts`
- Modify: `src/components/settings/template-form.tsx:92-120`
- Modify: `vitest.config.ts:90`

**Interfaces:**
- Produces, consumed by Task 2: `CANCEL_DEADLINE_OPTIONS`, `AUTO_CANCEL_OPTIONS` (both `as const`), and the types `CancelDeadlineOption`, `AutoCancelOption`, all exported from `@/lib/class-options`.
- Produces, consumed by Tasks 2 and 3: `vitest.config.ts`'s `components` project collects `src/app/**/*.test.tsx`.
- Consumes: nothing.

`class/new/page.tsx` declares `CANCEL_DEADLINE_OPTIONS` and `AUTO_CANCEL_OPTIONS` that are **byte-identical** to `template-form.tsx`'s, minus the `as const`. Adding `as const` plus four pins to the second copy would leave two pinned copies free to drift in their labels. Extract instead.

- [ ] **Step 1: Create the shared module**

`src/lib/class-options.ts`:

```ts
import type { CancelDeadline, AutoCancelCheck } from '@prisma/client';
import type { NoneOf } from '@/lib/type-pins';

/**
 * The cancellation options a teacher is offered, shared by every form that
 * renders them — `template-form.tsx` and the class-creation wizard, which
 * carried byte-identical private copies until #136 (one pinned, one not).
 *
 * The dropdown is the list. An enum member with no option here fails the build,
 * so a teacher can never be offered a stale set of choices.
 *
 * Consequence worth knowing before deleting an entry: removing an option to
 * hide a choice from teachers now fails the build. Hiding a choice means
 * removing it from the enum, or gating it at render.
 */
export const CANCEL_DEADLINE_OPTIONS = [
  { value: 'HOURS_48', label: '48 hours' },
  { value: 'HOURS_24', label: '24 hours' },
  { value: 'HOURS_12', label: '12 hours' },
  { value: 'HOURS_6', label: '6 hours' },
] as const;

export const AUTO_CANCEL_OPTIONS = [
  { value: 'HOURS_4', label: '4 hours before' },
  { value: 'HOURS_2', label: '2 hours before' },
  { value: 'HOURS_1', label: '1 hour before' },
] as const;

export type CancelDeadlineOption = (typeof CANCEL_DEADLINE_OPTIONS)[number]['value'];
export type AutoCancelOption = (typeof AUTO_CANCEL_OPTIONS)[number]['value'];

const _offersEveryDeadline: NoneOf<Exclude<CancelDeadline, CancelDeadlineOption>> = true;
const _noStaleDeadline: NoneOf<Exclude<CancelDeadlineOption, CancelDeadline>> = true;
const _offersEveryCheck: NoneOf<Exclude<AutoCancelCheck, AutoCancelOption>> = true;
const _noStaleCheck: NoneOf<Exclude<AutoCancelOption, AutoCancelCheck>> = true;
void _offersEveryDeadline;
void _noStaleDeadline;
void _offersEveryCheck;
void _noStaleCheck;
```

The labels are copied verbatim from `template-form.tsx:92-103`. **Compare both copies character by character before deleting either** — if the labels differ, that is a rendered-output difference and you must report it rather than pick one.

- [ ] **Step 2: Point `template-form.tsx` at the module**

Delete its local `CANCEL_DEADLINE_OPTIONS`, `AUTO_CANCEL_OPTIONS`, `CancelDeadlineOption`, `AutoCancelOption`, and its four enum pins (`_offersEveryDeadline`, `_noStaleDeadline`, `_offersEveryCheck`, `_noStaleCheck` plus their `void` lines) — they now live in the module. Add:

```ts
import { CANCEL_DEADLINE_OPTIONS, AUTO_CANCEL_OPTIONS } from '@/lib/class-options';
import type { CancelDeadlineOption, AutoCancelOption } from '@/lib/class-options';
```

**Keep its four field-list pins** (`_formCoversUpdate` and friends) — those are about this form's fields, not the enums, and stay.

If `CancelDeadlineOption` / `AutoCancelOption` are referenced elsewhere in the file, they now come from the import and need no other change.

- [ ] **Step 3: Verify `template-form`'s existing tests still pass, untouched**

Run: `npx vitest run --project components src/components/settings/template-form.test.tsx`

Expected: PASS, with **no edits to the test file**. If that test needs changing, the extraction altered behaviour and that is a defect — stop and report rather than editing the test.

- [ ] **Step 4: Widen the components test glob**

`vitest.config.ts`, the `components` project's `include`:

```ts
            include: ['src/components/**/*.test.tsx', 'src/app/**/*.test.tsx'],
```

Update the comment two lines above it, which currently explains that the `.tsx` glob keeps this project disjoint from `unit`'s `src/**/*.test.ts`. That reasoning still holds — `.tsx` vs `.ts` is what separates them, not the directory — but the comment should say `src/components` and `src/app` rather than implying components only. Do not weaken the disjointness claim; it is still true.

There are no `.test.tsx` files under `src/app/` today, so this is additive.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components
npx vitest run --project unit
```

Expected: clean and green, counts unchanged (components 61, unit 450). The glob change collects nothing new yet.

- [ ] **Step 6: Commit**

```bash
git add src/lib/class-options.ts src/components/settings/template-form.tsx vitest.config.ts
git commit -m "refactor: one home for the cancellation options, and a test seam under src/app (#136)"
```

---

### Task 2: The class-creation wizard

**Files:**
- Modify: `src/app/(teacher)/class/new/page.tsx:31-47,55-66,218-234`
- Create: `src/app/(teacher)/class/new/page.test.tsx`

**Interfaces:**
- Consumes from Task 1: `CANCEL_DEADLINE_OPTIONS`, `AUTO_CANCEL_OPTIONS` from `@/lib/class-options`; the widened test glob.
- Produces: nothing.

This is the widest form — 12 fields, three restatements — and the only one whose pin exclusions are security- and UX-adjacent.

- [ ] **Step 1: Write the failing key-set test**

Create `src/app/(teacher)/class/new/page.test.tsx`. Every test in this plan shares the harness below, lifted from `src/components/settings/template-form.test.tsx` — read that file too, but this is the shape:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

describe('NewClassPage', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  function stubFetch() {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [] }) });
    vi.stubGlobal('fetch', fetchMock);
  }

  /**
   * Returns the URL and method alongside the parsed body — not just the body —
   * so a test can pin `calls.at(-1)` to the request it means. Without that, an
   * intervening `fetch` added later could make `.at(-1)` silently select the
   * wrong call while every body assertion still passed.
   */
  async function submit(): Promise<{ url: string; method: string; body: Record<string, unknown> }> {
    const button = await screen.findByRole('button', { name: /create|save/i });
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(0));
    const [url, options] = fetchMock.mock.calls.at(-1) ?? [];
    const opts = options as { method: string; body: string };
    return { url: url as string, method: opts.method, body: JSON.parse(opts.body) as Record<string, unknown> };
  }
});
```

**Two things to get right per form.** If the component fetches on mount (this wizard loads the teacher's rooms; `add-room-flow` searches rooms), `stubFetch` must return data shaped like that first response, and `submit`'s `waitFor` must use `toBeGreaterThan(1)` — the mount fetch is call zero. If it does not fetch on mount, `toBeGreaterThan(0)` is right. Getting this wrong makes the test hang rather than fail informatively.

Stub `next/navigation` where a form calls `useRouter` — `template-form.test.tsx` does not need it, but forms that `router.push` after submitting do.

The assertion that matters:

```ts
  /**
   * The twelve keys this wizard sends. The compile-time pins in the page prove
   * this list agrees with `createClassSchema` (minus two deliberate
   * exclusions); this proves the code actually sends it — a pin cannot see
   * what `JSON.stringify` receives at runtime.
   */
  it('sends exactly these twelve fields', async () => {
    const { url, method, body } = await fillAndSubmit();
    expect(url).toBe('/api/classes');
    expect(method).toBe('POST');
    expect(Object.keys(body).sort()).toEqual([
      'autoCancelCheck',
      'cancelDeadline',
      'classType',
      'date',
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
```

The wizard is multi-step: the test must advance through the steps before submitting. `handleNext` gates on `validateStep`, so required fields must be filled at each step. Read the component to learn which, and put that in the `fillAndSubmit` helper.

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run --project components "src/app/(teacher)/class/new/page.test.tsx"`

Expected: FAIL — the file is collected (Task 1's glob change) but the test does not pass yet, most likely on step navigation. Iterate on the helper until it submits. **If the file is not collected at all, Task 1's glob change did not land — stop and report.**

- [ ] **Step 3: Import the shared options and delete the local copies**

Delete `CANCEL_DEADLINE_OPTIONS` and `AUTO_CANCEL_OPTIONS` (`:55-66`) and import them:

```ts
import { CANCEL_DEADLINE_OPTIONS, AUTO_CANCEL_OPTIONS } from '@/lib/class-options';
```

The rendered `<option>` elements keep reading `.value` and `.label` exactly as before.

- [ ] **Step 4: Derive the body instead of restating it**

Replace the twelve-line literal (`:222-233`) with the state object itself:

```ts
        body: JSON.stringify(form),
```

`form` is already exactly `FormData` and its twelve keys are exactly the twelve currently listed — verified. This removes the second restatement; `INITIAL_FORM` remains, which is fine: it is typed `FormData`, so it cannot drift from the list.

If any current line applies a transform (a `.trim()`, a `Number()`), it must be preserved — build the object explicitly with the transform rather than spreading, and say so in your report. Read all twelve lines before replacing them.

- [ ] **Step 5: Add the pins**

Above the component, after the `FormData` interface:

```ts
type CreateClassWire = z.infer<typeof createClassSchema>;

/**
 * #136. `FormData` is the list; the body is `form` itself, so the two cannot
 * drift. These pins tie that list to the schema.
 *
 * Two keys are excluded from the forward pin, each for its own reason:
 *
 * - `description` — `createClassSchema` accepts it and `POST /api/classes`
 *   writes it, but this wizard renders no input for it, so a teacher can only
 *   describe a class by editing it afterwards. That is a real gap, filed as
 *   #147, not something to paper over by adding a field inside a pinning
 *   change.
 * - `templateId` — server-set by `class-generator.ts` when a template
 *   materialises a class; it appears nowhere in this UI. The route passes a
 *   client-supplied value straight through with no ownership check, filed as
 *   #146. Excluded so this pin does not certify it as a field this form ought
 *   to be sending.
 *
 * Both exclusions are deliberate and both are tracked. Narrow them when the
 * issues close.
 */
const _formCoversCreate: NoneOf<
  Exclude<Exclude<keyof CreateClassWire, 'description' | 'templateId'>, keyof FormData>
> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof FormData, keyof CreateClassWire>> = true;
void _formCoversCreate;
void _formHasNoExtras;
```

Add the imports:

```ts
import type { z } from 'zod';
import type { createClassSchema } from '@/lib/schemas';
import type { NoneOf } from '@/lib/type-pins';
```

- [ ] **Step 6: Prove the forward pin bites**

Temporarily delete `minStudents` from the `FormData` interface. Run `npx tsc --noEmit`.

Expected: an error naming `minStudents` — `Type 'true' is not assignable to type '"minStudents"'`. Restore the field and confirm `tsc` is clean again.

**Record the exact error text in your report.** A pin that compiles but does not bite is worthless, and the only way to know is to break it on purpose.

- [ ] **Step 7: Prove the reverse pin bites**

Temporarily add `bogusField: string;` to `FormData`. Run `npx tsc --noEmit`.

Expected: an error naming `bogusField`. Remove it and confirm clean.

- [ ] **Step 8: Verify**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components
npx vitest run --project unit
```

Expected: clean; components 62 (+1).

- [ ] **Step 9: Commit**

```bash
git add "src/app/(teacher)/class/new/page.tsx" "src/app/(teacher)/class/new/page.test.tsx"
git commit -m "fix: pin the class wizard's field list, excluding two tracked gaps (#136)"
```

---

### Task 3: The two studio forms

**Files:**
- Modify: `src/components/settings/studio-template-form.tsx:12-19,32-39,73-80`
- Create: `src/components/settings/studio-template-form.test.tsx`
- Modify: `src/app/(teacher)/studio-class/new/page.tsx:39-46`
- Create: `src/app/(teacher)/studio-class/new/page.test.tsx`

**Interfaces:**
- Consumes from Task 1: the widened test glob (for the page test).
- Produces: nothing.

- [ ] **Step 1: `studio-template-form.tsx` — four pins**

This form sends one body to two endpoints, so it takes the same four pins as `template-form.tsx`. Its six keys are `classType`, `dayOfWeek`, `startTime`, `durationMinutes`, `location`, `hourlyRate` — and both `createStudioClassTemplateSchema` and `updateStudioClassTemplateSchema` have exactly those six. Verified.

Its field list is currently an **anonymous inline type** on the optional `initial` prop (`:12-19`) — there is no named type to pin against. Extract it, exported so the test and the caller can use it:

```ts
export interface StudioTemplateFormValues {
  classType: string;
  dayOfWeek: number;
  startTime: string;
  durationMinutes: number;
  location: string;
  hourlyRate: number;
}
```

Then `initial?: StudioTemplateFormValues`, `INITIAL_VALUES: StudioTemplateFormValues`, and the body derived from `form` rather than restated. Its caller at `src/app/(teacher)/settings/studio-classes/[id]/page.tsx:34-41` restates the same six fields as a fourth copy — it can now be typed `StudioTemplateFormValues` instead, which is the point of exporting it.

Then add:

```ts
type CreateStudioTemplateWire = z.infer<typeof createStudioClassTemplateSchema>;
type UpdateStudioTemplateWire = z.infer<typeof updateStudioClassTemplateSchema>;

/**
 * #136. Four pins, because one body serves both endpoints — the shape
 * `template-form.tsx` established. The two schemas agree on keys today; the
 * day they diverge, a pin against only one would not notice.
 */
const _formCoversCreate: NoneOf<Exclude<keyof CreateStudioTemplateWire, keyof StudioTemplateFormValues>> = true;
const _formCoversUpdate: NoneOf<Exclude<keyof UpdateStudioTemplateWire, keyof StudioTemplateFormValues>> = true;
const _formHasNoExtrasOnCreate: NoneOf<Exclude<keyof StudioTemplateFormValues, keyof CreateStudioTemplateWire>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof StudioTemplateFormValues, keyof UpdateStudioTemplateWire>> = true;
void _formCoversCreate;
void _formCoversUpdate;
void _formHasNoExtrasOnCreate;
void _formHasNoExtras;
```

**No enum pin here.** `DAY_OPTIONS` is numeric (`0`–`6`) and `dayOfWeek` is a number in the schema — there is no Prisma enum behind it. Leave `DAY_OPTIONS` exactly as it is.

- [ ] **Step 2: `studio-class/new/page.tsx` — two pins, two exclusions**

The form sends six keys (`classType`, `location`, `date`, `startTime`, `durationMinutes`, `hourlyRate`); `createStudioClassSchema` has eight. Both extras are dead schema surface — `POST /api/studio-classes` accepts and never reads them.

```ts
type CreateStudioClassWire = z.infer<typeof createStudioClassSchema>;

/**
 * #136. Two keys are excluded from the forward pin, and unlike the class
 * wizard's exclusions neither is a tracked gap — both are schema surface the
 * route never reads:
 *
 * - `studentCount` — set after the fact by `student-count-editor.tsx`, because
 *   a studio class's attendance is not known when it is created.
 * - `templateId` — server-set when a studio template materialises a class.
 *
 * `POST /api/studio-classes` accepts both and writes neither; its
 * `prisma.studioClass.create` data block references neither key. Excluded here
 * rather than added to the form, since sending a value the route discards
 * would be worse than not sending it.
 */
const _formCoversCreate: NoneOf<
  Exclude<Exclude<keyof CreateStudioClassWire, 'studentCount' | 'templateId'>, keyof StudioClassFormValues>
> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof StudioClassFormValues, keyof CreateStudioClassWire>> = true;
void _formCoversCreate;
void _formHasNoExtras;
```

This page currently holds its fields as separate `useState` calls, not one object. Introduce a `StudioClassFormValues` interface naming the six keys and derive the body from an object of that type. Keep every `.trim()` and `Number()` transform the current body applies.

- [ ] **Step 3: Prove each pin bites**

For **both** files: remove one field from the form's list, run `npx tsc --noEmit`, confirm the error names that field, restore. Then add a bogus field, confirm the reverse pin names it, remove.

Record all four error messages in your report.

- [ ] **Step 4: Write the two key-set tests**

Follow `template-form.test.tsx`'s conventions. Each asserts `Object.keys(body).sort()`:

- `studio-template-form.test.tsx` — the six keys, asserted in **both** create and update modes if the component takes a `mode` prop (read it to find out); `template-form.test.tsx` has a worked example of testing both.
- `studio-class/new/page.test.tsx` — `['classType', 'date', 'durationMinutes', 'hourlyRate', 'location', 'startTime']`.

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components
```

Expected: clean; components 64 (+2).

- [ ] **Step 6: Commit**

```bash
git add src/components/settings/studio-template-form.tsx src/components/settings/studio-template-form.test.tsx \
        "src/app/(teacher)/studio-class/new/page.tsx" "src/app/(teacher)/studio-class/new/page.test.tsx"
git commit -m "fix: pin both studio forms' field lists (#136)"
```

---

### Task 4: The four remaining schema owners

**Files:**
- Modify: `src/components/settings/add-room-flow.tsx:126-137,186-191`
- Create: `src/components/settings/add-room-flow.test.tsx`
- Modify: `src/components/settings/edit-teacher-room-form.tsx:8-14,51-55`
- Create: `src/components/settings/edit-teacher-room-form.test.tsx`
- Modify: `src/components/students/create-student-form.tsx:46`
- Create: `src/components/students/create-student-form.test.tsx`
- Modify: `src/components/student/teacher-privacy-card.tsx:6-14,54`
- Create: `src/components/student/teacher-privacy-card.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing.

All four match their schemas exactly — verified key-by-key — so all four take both pins with no exclusions.

- [ ] **Step 1: `add-room-flow.tsx` — two independent bodies, four pins**

This form posts **twice, to two endpoints, with two different bodies** — unlike `template-form.tsx`, which sends one body to two endpoints. Each body gets its own pair of pins.

`/api/rooms` sends ten keys matching `createRoomSchema` exactly: `venueName`, `address`, `city`, `postcode`, `floor`, `roomName`, `maxCapacity`, `equipment`, `notes`, `isPublic`.

`/api/teacher-rooms` sends four matching `createTeacherRoomSchema` exactly: `roomId`, `capacityOverride`, `rentalRate`, `equipmentNotes`.

Introduce a named type per body (`NewRoomValues`, `NewTeacherRoomValues`), derive each body from its type, and pin each pair:

```ts
type CreateRoomWire = z.infer<typeof createRoomSchema>;
type CreateTeacherRoomWire = z.infer<typeof createTeacherRoomSchema>;

/**
 * #136. Two bodies, two endpoints, four pins — this form creates a room and
 * then attaches the teacher to it, and the two payloads have nothing in
 * common. Each is pinned to its own schema in both directions.
 */
const _roomCoversCreate: NoneOf<Exclude<keyof CreateRoomWire, keyof NewRoomValues>> = true;
const _roomHasNoExtras: NoneOf<Exclude<keyof NewRoomValues, keyof CreateRoomWire>> = true;
const _linkCoversCreate: NoneOf<Exclude<keyof CreateTeacherRoomWire, keyof NewTeacherRoomValues>> = true;
const _linkHasNoExtras: NoneOf<Exclude<keyof NewTeacherRoomValues, keyof CreateTeacherRoomWire>> = true;
void _roomCoversCreate;
void _roomHasNoExtras;
void _linkCoversCreate;
void _linkHasNoExtras;
```

Note `isPublic` is genuinely sent here — this form *does* render it. That is the field `edit-room-form.tsx` is missing, which is why that form is deferred to #73 and this one is not.

- [ ] **Step 2: `edit-teacher-room-form.tsx` — two pins**

Sends `capacityOverride`, `rentalRate`, `equipmentNotes`; `updateTeacherRoomSchema` has exactly those three. Its existing `initial` prop object (`:10`) is the natural field list — reuse it rather than adding a second type.

```ts
type UpdateTeacherRoomWire = z.infer<typeof updateTeacherRoomSchema>;
type EditTeacherRoomValues = EditTeacherRoomFormProps['initial'];

const _formCoversUpdate: NoneOf<Exclude<keyof UpdateTeacherRoomWire, keyof EditTeacherRoomValues>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof EditTeacherRoomValues, keyof UpdateTeacherRoomWire>> = true;
void _formCoversUpdate;
void _formHasNoExtras;
```

- [ ] **Step 3: `create-student-form.tsx` — two pins**

Sends `firstName`, `lastName`, `email`; `createStudentSchema` has exactly those three. Its body is currently a one-line literal with `.trim()` on each value — keep the trims, name the type, derive the shape.

- [ ] **Step 4: `teacher-privacy-card.tsx` — two pins, body already correct**

This one is nearly free: its body is already `{ teacherId, ...values }`, spread-derived from the exported `TeacherPrivacyValues` interface (`:6`). Only the pins are missing. `updatePrivacySchema` has seven keys — `teacherId` plus the six in `TeacherPrivacyValues`.

The form's list is `TeacherPrivacyValues & { teacherId: string }`, so pin against that:

```ts
type UpdatePrivacyWire = z.infer<typeof updatePrivacySchema>;
type PrivacyBody = TeacherPrivacyValues & { teacherId: string };

const _formCoversUpdate: NoneOf<Exclude<keyof UpdatePrivacyWire, keyof PrivacyBody>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof PrivacyBody, keyof UpdatePrivacyWire>> = true;
void _formCoversUpdate;
void _formHasNoExtras;
```

- [ ] **Step 5: Prove every pin bites**

Eight pins across four files. For each file: remove a field, confirm `tsc` names it, restore; add a bogus field, confirm, remove. **Report the error text for each file** — four forward, four reverse.

- [ ] **Step 6: Write four key-set tests**

One per form, following `template-form.test.tsx`. `add-room-flow.test.tsx` asserts **both** bodies — it is the only form here that posts twice, and asserting only the first would leave the teacher-room payload unpinned at runtime.

- [ ] **Step 7: Verify**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components
```

Expected: clean; components 68 (+4).

- [ ] **Step 8: Commit**

```bash
git add src/components/settings/add-room-flow.tsx src/components/settings/add-room-flow.test.tsx \
        src/components/settings/edit-teacher-room-form.tsx src/components/settings/edit-teacher-room-form.test.tsx \
        src/components/students/create-student-form.tsx src/components/students/create-student-form.test.tsx \
        src/components/student/teacher-privacy-card.tsx src/components/student/teacher-privacy-card.test.tsx
git commit -m "fix: pin the four remaining single-schema forms (#136)"
```

---

### Task 5: The three forms that share a schema

**Files:**
- Modify: `src/components/student/notifications-form.tsx:8-12,32-36,67-75`
- Create: `src/components/student/notifications-form.test.tsx`
- Modify: `src/components/student/tier-form.tsx:28`
- Create: `src/components/student/tier-form.test.tsx`
- Modify: `src/components/students/edit-student-form.tsx:8-12,41-46`
- Create: `src/components/students/edit-student-form.test.tsx`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: nothing.

`updateStudentSchema` has eight keys. `notifications-form` sends two, `tier-form` sends one, and five — `firstName`, `lastName`, `phone`, `birthday`, `address` — have no student-facing input anywhere. A forward pin on either would fail naming six fields the form has no business rendering. **These two get the reverse pin only**, per the spec's §1.

`edit-student-form` is different and takes both pins — see Step 3.

- [ ] **Step 1: `notifications-form.tsx` — reverse pin, and extract the reminder options**

Every task in this plan needs `import type { z } from 'zod';`, the schema type imports from `@/lib/schemas`, and `import type { NoneOf } from '@/lib/type-pins';`. They are shown once here rather than repeated in every block.

```ts
type UpdateStudentWire = z.infer<typeof updateStudentSchema>;

interface NotificationsBody {
  emailNotifications: boolean;
  reminderPref: StudentReminderPref;
}

/**
 * #136. Reverse pin only, deliberately. This form shares
 * `updateStudentSchema` with `tier-form.tsx`, and between them they cover
 * three of its eight keys — `firstName`, `lastName`, `phone`, `birthday` and
 * `address` have no student-facing input anywhere. A forward pin would name
 * six fields this form has no business rendering.
 *
 * What the reverse pin still buys: `updateStudentSchema` is `.strict()`, so a
 * key it dropped would 400 at runtime. This catches that at compile time.
 *
 * Whether those five fields *should* have inputs is a product question about
 * student self-service, not a pinning one, and is out of #136's scope.
 */
const _formHasNoExtras: NoneOf<Exclude<keyof NotificationsBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;
```

The four `<option>` elements (`:71-74`) are inline literals with no array behind them. Extract one so the choices can be pinned to the enum:

```ts
/**
 * `StudentReminderPref`, not `ReminderPref` — the codebase carries both, and
 * the other one (`morning_of | evening_before | one_hour_before`) governs the
 * *teacher's* `defaultReminder`. Nothing but this pin connects these four
 * option values to the right enum, and the two are one careless import apart.
 */
const REMINDER_OPTIONS = [
  { value: 'eve', label: 'Evening before' },
  { value: 'morning', label: 'Morning of class' },
  { value: 'one_hour', label: 'One hour before' },
  { value: 'off', label: 'No reminders' },
] as const;

type ReminderOption = (typeof REMINDER_OPTIONS)[number]['value'];

const _offersEveryReminder: NoneOf<Exclude<StudentReminderPref, ReminderOption>> = true;
const _noStaleReminder: NoneOf<Exclude<ReminderOption, StudentReminderPref>> = true;
void _offersEveryReminder;
void _noStaleReminder;
```

Render from the array with `.map`. **The four labels must be copied verbatim** from the current JSX — they are user-facing copy and this PR changes no rendered output.

- [ ] **Step 2: `tier-form.tsx` — reverse pin only**

Sends one key, `incomeTier`. It is in scope not as an instance of the field-list defect but because it shares `updateStudentSchema`, and the reverse pin proves its one key is one the schema accepts.

```ts
type UpdateStudentWire = z.infer<typeof updateStudentSchema>;

interface TierBody {
  incomeTier: number;
}

/**
 * #136. Reverse pin only — one key, and this form shares
 * `updateStudentSchema` with `notifications-form.tsx`. See that file for why
 * there is no forward pin.
 */
const _formHasNoExtras: NoneOf<Exclude<keyof TierBody, keyof UpdateStudentWire>> = true;
void _formHasNoExtras;
```

- [ ] **Step 3: `edit-student-form.tsx` — both pins, against `createStudentSchema`**

This is the teacher-facing CRM edit form, and it is the subtle one. `PUT /api/students/[id]` chooses its schema by **caller identity**: `updateStudentSchema` when `session.studentId === id` (a student editing their own profile), `createStudentSchema` otherwise. This form is the teacher path, so it pins against `createStudentSchema` — whose three keys (`firstName`, `lastName`, `email`) it matches exactly.

```ts
type CreateStudentWire = z.infer<typeof createStudentSchema>;
type EditStudentBody = { firstName: string; lastName: string; email: string };

/**
 * #136. Pinned against `createStudentSchema`, not `updateStudentSchema`,
 * which is not the obvious choice: `PUT /api/students/[id]` picks its schema
 * by *caller identity*, not by method. `session.studentId === id` (a student
 * editing themselves) parses with `updateStudentSchema`; every other caller —
 * including this teacher-facing CRM form — parses with `createStudentSchema`.
 * See `src/app/api/students/[id]/route.ts`, the two `parseBody` calls in `PUT`.
 *
 * Both directions apply here because this form owns its branch's schema
 * outright: three keys, three inputs.
 */
const _formCoversSchema: NoneOf<Exclude<keyof CreateStudentWire, keyof EditStudentBody>> = true;
const _formHasNoExtras: NoneOf<Exclude<keyof EditStudentBody, keyof CreateStudentWire>> = true;
void _formCoversSchema;
void _formHasNoExtras;
```

- [ ] **Step 4: Prove the pins bite**

Five pins across three files. Reverse pins are proved by **adding** a bogus key (a forward-pin break would not fire on a reverse-only form — confirm that too, and say so in your report: adding a missing schema field must *not* break `notifications-form`, which is the whole point of omitting the forward pin).

- [ ] **Step 5: Write three key-set tests**

```ts
    expect(Object.keys(body).sort()).toEqual(['emailNotifications', 'reminderPref']);  // notifications-form
    expect(Object.keys(body).sort()).toEqual(['incomeTier']);                          // tier-form
    expect(Object.keys(body).sort()).toEqual(['email', 'firstName', 'lastName']);      // edit-student-form
```

`notifications-form.test.tsx` should also assert that all four reminder options render, since Step 1 changed how they are produced:

```ts
    expect(screen.getAllByRole('option').map((o) => (o as HTMLOptionElement).value))
      .toEqual(['eve', 'morning', 'one_hour', 'off']);
```

- [ ] **Step 6: Verify**

```bash
npx tsc --noEmit && npm run lint
npx vitest run --project components
npx vitest run --project unit
npx playwright test
```

Expected: clean; components 71 (+3); unit 450 unchanged; e2e 118.

- [ ] **Step 7: Commit**

```bash
git add src/components/student/notifications-form.tsx src/components/student/notifications-form.test.tsx \
        src/components/student/tier-form.tsx src/components/student/tier-form.test.tsx \
        src/components/students/edit-student-form.tsx src/components/students/edit-student-form.test.tsx
git commit -m "fix: reverse-pin the forms that share updateStudentSchema (#136)"
```

---

## Pre-PR checklist

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run lint` — clean
- [ ] `npx vitest run --project unit` — 450, unchanged
- [ ] `npx vitest run --project components` — **71** (61 + 10 new files)
- [ ] `npx playwright test` — 118
- [ ] `grep -rn "CANCEL_DEADLINE_OPTIONS" src/` — declared **once**, in `src/lib/class-options.ts`
- [ ] Every pin has a `void _pinName;` line
- [ ] No `as`-cast was added anywhere
- [ ] Ten new `.test.tsx` files, each asserting `Object.keys(body).sort()`
- [ ] `template-form.test.tsx` passes **unedited** — if it needed changes, Task 1's extraction altered behaviour
- [ ] The four exclusions are commented, and the two in `class/new` name #146 and #147
- [ ] `edit-room-form.tsx` and `profile-form.tsx` are **untouched** — deferred to #73 and #46
- [ ] `git status --short` — only `docs/backlog-roadmap.md` untracked
