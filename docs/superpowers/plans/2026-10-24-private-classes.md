# Private Classes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can mark a class or a class template private. A private class is left off `/[slug]`, booked by direct link, and its share button hands out the class's own booking URL.

**Architecture:** A `Boolean @default(false)` column on `Class` and on `ClassTemplate`, each added in its own migration. The column travels through the existing zod schema, then the service allowlist, then the form, and those three are tied together by compile-time pins. The public schedule filters it in its one listing query, the generator stamps it, and it is deliberately absent from `LOCKED_FIELDS`. Sharing reuses `ShareBookingLink`, which now takes the path to share.

**Tech Stack:** Next.js 16 App Router, Prisma + PostgreSQL, zod, Vitest (projects `unit`, `components`, `integration`), Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-24-private-classes-design.md`

## Global Constraints

- TypeScript `strict`, no `any`. Every compile-time pin this plan touches is satisfied by **classifying** the new field, never by widening or deleting a pin.
- Migrations via `pnpm exec prisma migrate dev --name <name>`, never `db push`. An applied migration is never edited, comments included.
- `isPrivate` is **never** a member of `LOCKED_FIELDS` / `ECONOMIC_FIELDS` / `SCHEDULE_LOCKED_FIELDS` (`src/lib/class-fields.ts`).
- A template is a stamp (#194): no code path writes `isPrivate` onto an existing `Class` from its template.
- Copy, verbatim:
  - checkbox label `Private class`;
  - checkbox hint `Not listed on your public page. Anyone with the link can book.`;
  - review row label `Visibility`, values `Listed on your public page` / `Private — link only`;
  - booking-page caption `Shared by link — not on {teacher first name}'s public schedule.`;
  - template notice `Classes already on your schedule keep their own setting.`;
  - draft caption `Publish to share the link`;
  - schedule-card word `Private`.
- Checkbox markup follows `src/components/settings/edit-room-form.tsx:162-170`: `<label className="flex items-center gap-3 min-h-[44px]">`, `<input type="checkbox" className="w-5 h-5 accent-teal">`, label text `text-base text-ink`, hint `type-caption`. Add no switch component.
- No badge for `Private`. Badges encode time (CLAUDE.md, Design Philosophy).
- Comment discipline (CLAUDE.md): no counts or rosters in comments; a comment annotates the code it sits on.
- Never kill or restart the dev server on :3000. Integration tests need it live (`.claude/skills/verify/`).

## Review Focus

1. **A full private class.** The booking page switches to its waitlist view, and `addToWaitlist` must accept a private class like any other. Pinned in Task 3.
2. **Draft → open keeps the flag.** A teacher ticks Private on a draft, then publishes. `transitionClass` must not reset `isPrivate`. Pinned in Task 1.
3. **A client that omits `isPrivate`.** An older tab POSTing a class or PUTting an edit without the key gets a public class on create, and the stored value is left alone on edit. Pinned in Task 1 (both) and Task 2 (template create).
4. **A booked private class whose student opens their `/bookings` link.** It must still render, because nothing on the booking page reads `isPrivate` as a refusal. Pinned in Task 3.
5. **Template saved with another field changed, `isPrivate` unchanged.** The "keep their own setting" notice must not appear. Pinned in Task 2.

---

### Task 1: `Class.isPrivate` — column, create, edit, both class forms

**Files:**
- Modify: `prisma/schema.prisma` (model `Class`)
- Create: `prisma/migrations/<timestamp>_class_is_private/migration.sql` (generated)
- Modify: `src/lib/schemas.ts` (`createClassSchema`, `updateClassSchema`)
- Modify: `src/app/api/classes/route.ts` (POST create data, ~line 160-180)
- Modify: `src/services/class-lifecycle.ts` (`TeacherEditableClassField`, ~line 1015)
- Modify: `src/app/(teacher)/class/new/new-class-form.tsx` (form state, step 3, step 4 review, POST payload)
- Modify: `src/components/class/class-edit-form.tsx` (`ClassEditInitial`, checkbox after the Economics block, payload)
- Modify: the server page that builds `ClassEditInitial` (find it with `grep -rn "ClassEditForm" src/app`)
- Modify: `docs/data-model.md` (Class table)
- Test: `tests/integration/classes-api.test.ts`, `src/app/(teacher)/class/new/new-class-form.test.tsx`, `src/components/class/class-edit-form.test.tsx`

**Interfaces:**
- Produces: `Class.isPrivate: boolean` (Prisma). `createClassSchema` and `updateClassSchema` accept `isPrivate?: boolean`. `TeacherEditableClassField` includes `'isPrivate'`.

- [ ] **Step 1: Write the failing integration tests** in `tests/integration/classes-api.test.ts`. Put them inside the describe block that owns `put`, `ownerToken`, `economicsClassId` and `lockedClassId` (the one around line 1140), using its existing helpers:

```ts
it('an isPrivate edit on a locked class -> 200, the flag persists (#910)', async () => {
  const before = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
  expect(before.settingsLocked).toBe(true);
  const res = await put(ownerToken, lockedClassId, { isPrivate: !before.isPrivate });
  expect(res.status).toBe(200);
  const after = await prisma.class.findUniqueOrThrow({ where: { id: lockedClassId } });
  expect(after.isPrivate).toBe(!before.isPrivate);
  await prisma.class.update({ where: { id: lockedClassId }, data: { isPrivate: before.isPrivate } });
});

it('an edit body without isPrivate leaves the stored flag alone (#910)', async () => {
  await prisma.class.update({ where: { id: economicsClassId }, data: { isPrivate: true } });
  const res = await put(ownerToken, economicsClassId, { description: 'still private' });
  expect(res.status).toBe(200);
  const after = await prisma.class.findUniqueOrThrow({ where: { id: economicsClassId } });
  expect(after.isPrivate).toBe(true);
  await prisma.class.update({ where: { id: economicsClassId }, data: { isPrivate: false } });
});
```

In the describe block covering `POST /api/classes` (create), add two cases, reusing that block's own valid-body builder:

```ts
it('creates a private class when isPrivate is sent, a public one when omitted (#910)', async () => {
  const privRes = await createClass({ ...validBody(), isPrivate: true });   // that block's helpers
  const pubRes = await createClass(validBody());
  const priv = await prisma.class.findUniqueOrThrow({ where: { id: (await privRes.json()).data.id } });
  const pub = await prisma.class.findUniqueOrThrow({ where: { id: (await pubRes.json()).data.id } });
  expect(priv.isPrivate).toBe(true);
  expect(pub.isPrivate).toBe(false);
});

it('publishing a private draft keeps it private (#910)', async () => {
  // create with isPrivate: true, then POST the draft -> open transition through the
  // block's existing transition helper; read the row back
  expect(published.status).toBe('open');
  expect(published.isPrivate).toBe(true);
});
```

Adapt `createClass` / `validBody` / the transition call to the names that block already uses, and keep the dates in the slots that block already reserves (`slotDate` / `slotTime` in `tests/class-fixtures.ts`) so the teacher-slot exclusion doesn't fire.

- [ ] **Step 2: Run them and confirm they fail.**
Run: `pnpm exec vitest run --project integration tests/integration/classes-api.test.ts -t "910"`
Expected: FAIL. The PUT answers 400 (`.strict()` rejects the unknown key `isPrivate`), or `isPrivate` is undefined on the row.

- [ ] **Step 3: Add the column and migration.** In `model Class`, beside the other booleans:

```prisma
  isPrivate        Boolean  @default(false)
```

Run: `pnpm exec prisma migrate dev --name class_is_private`
Expected: one `ALTER TABLE "Class" ADD COLUMN "isPrivate" BOOLEAN NOT NULL DEFAULT false;`.

- [ ] **Step 4: Thread it through the schema, route and service.**
  - `createClassSchema` and `updateClassSchema` each gain `isPrivate: z.boolean().optional(),`.
  - The POST create data in `src/app/api/classes/route.ts` gains `isPrivate: body.isPrivate ?? false,`.
  - `TeacherEditableClassField` in `class-lifecycle.ts` gains `| 'isPrivate'`.

  Run `pnpm exec tsc --noEmit`. Expected: the only errors are the forms' coverage pins (`_formCoversSchema` in `class-edit-form.tsx`, and any equivalent in `new-class-form.tsx`), which Step 5 clears. `updateClass` needs no logic change: `isPrivate` is not in `EntryUpdateField`, so the destructure routes it to the `Class` half.

- [ ] **Step 5: Forms.**
  - **Create wizard.** Form state gains `isPrivate: boolean` (initially `false`). Step 3 gets the checkbox (constraint markup) as the last child after the Auto-cancel `Select`. Step 4 gets a review row after the existing rows, in the same `py-2 border-b border-border` shape:

    ```tsx
    <div className="py-2 border-b border-border">
      <span className="type-label">Visibility</span>
      <p className="text-base text-ink">{form.isPrivate ? 'Private — link only' : 'Listed on your public page'}</p>
    </div>
    ```

    The POST payload builder gains `isPrivate: form.isPrivate`.
  - **Edit form.** `ClassEditInitial` gains `isPrivate: boolean`. The checkbox goes after the Economics block, before Save. It is never disabled by `settingsLocked`, and the locked-key stripping near `class-edit-form.tsx:254` must not strip it (it can't, because it isn't in `LOCKED_FIELDS`). The page that builds `initial` passes `isPrivate: cls.isPrivate`.

- [ ] **Step 6: Component tests.**
  - `new-class-form.test.tsx`: tick Private on step 3, advance to step 4, and assert the review reads `Private — link only` and the POST body carries `isPrivate: true`. Untouched, the body carries `isPrivate: false` and the review reads `Listed on your public page`.
  - `class-edit-form.test.tsx`: with `settingsLocked: true`, the Private checkbox is enabled while an economic input is disabled. Toggling it and saving sends `isPrivate`.

  Follow each file's existing render/fetch-mock helpers.

- [ ] **Step 7: Run everything touched.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run --project integration tests/integration/classes-api.test.ts && pnpm exec vitest run --project components "src/app/(teacher)/class/new" src/components/class/class-edit-form.test.tsx`
Expected: PASS.

- [ ] **Step 8: Prove the not-locked guard bites.** Make `isPrivate` locked the way a future contributor would: add it to `LOCKED_FIELDS` in `src/lib/class-fields.ts`, adjusting that file's types only as far as needed to compile. Run the first test from Step 1 and record the exact failure (expected: 409 `SETTINGS_LOCKED` where 200 was asserted). Restore, re-run, PASS.

- [ ] **Step 9: Docs.** In `docs/data-model.md`'s `Class` table, add `isPrivate | boolean, default false | Left off the teacher's public page (/[slug]); bookable by direct link. Never locked: not one of LOCKED_FIELDS (#910)`.

- [ ] **Step 10: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations/*_class_is_private src/lib/schemas.ts src/app/api/classes/route.ts src/services/class-lifecycle.ts "src/app/(teacher)/class/new/new-class-form.tsx" "src/app/(teacher)/class/new/new-class-form.test.tsx" src/components/class/class-edit-form.tsx src/components/class/class-edit-form.test.tsx tests/integration/classes-api.test.ts docs/data-model.md <the edit page path>
git commit -m "feat(#910): Class.isPrivate, set on create and edit, never locked"
```

---

### Task 2: `ClassTemplate.isPrivate` — column, stamp, template form

**Files:**
- Modify: `prisma/schema.prisma` (model `ClassTemplate`)
- Create: `prisma/migrations/<timestamp>_class_template_is_private/migration.sql` (generated)
- Modify: `src/lib/schemas.ts` (`createClassTemplateSchema`, `updateClassTemplateSchema`)
- Modify: `src/services/class-template-lifecycle.ts` (`TeacherEditableClassTemplateField` ~line 140, template create data ~line 1060-1075)
- Modify: `src/services/class-generator.ts` (`CLASS_GENERATOR.createChildren`, the `createMany` object ~line 68-105)
- Modify: `src/components/settings/template-form.tsx` (`TemplateFormValues`, checkbox after Auto-cancel check, notice)
- Modify: `docs/data-model.md` (ClassTemplate table)
- Test: `src/services/class-generator.test.ts`, `tests/integration/class-templates-api.test.ts`, `src/components/settings/template-form.test.tsx`

**Interfaces:**
- Consumes: `Class.isPrivate` (Task 1).
- Produces: `ClassTemplate.isPrivate: boolean`. Template schemas accept `isPrivate?: boolean`.

- [ ] **Step 1: Write the failing generator test** in `src/services/class-generator.test.ts`, inside `describe('generateClassInstances (DB)')`, following the template setup that the `'generates 4 class instances from a template'` case uses (around line 97-160):

```ts
it('stamps the template\'s isPrivate onto every class it generates (#910)', async () => {
  await prisma.classTemplate.update({ where: { id: templateId }, data: { isPrivate: true } });
  // run generation exactly as the 'generates 4 class instances' case does
  const generated = await prisma.class.findMany({ where: { templateId } });
  expect(generated.length).toBeGreaterThan(0);
  expect(generated.every((c) => c.isPrivate)).toBe(true);
});

it('a template isPrivate flip leaves already-generated classes as they are (#910, #194)', async () => {
  // generate with isPrivate false; then flip the template through updateClassTemplate
  // (the real service, as the description-edit case near line 269 does)
  const after = await prisma.class.findMany({ where: { templateId } });
  expect(after.every((c) => c.isPrivate === false)).toBe(true);
});
```

Match the existing cases' fixture names and cleanup.

- [ ] **Step 2: Run and confirm failure.**
Run: `pnpm exec vitest run --project integration src/services/class-generator.test.ts -t "910"` (use the project the file already runs under; check `vitest.config.*`).
Expected: FAIL. A type error or unknown field `isPrivate` on `classTemplate.update`.

- [ ] **Step 3: Column and migration.** In `model ClassTemplate`: `isPrivate Boolean @default(false)`. Run `pnpm exec prisma migrate dev --name class_template_is_private`.

- [ ] **Step 4: Classify the field and thread it through.**
  - `pnpm exec tsc --noEmit`. Expected: `_templateListsPartitionTheModel` fails, naming `isPrivate`. Record the error text for the PR body. This is the partition pin doing its job.
  - Add `| 'isPrivate'` to `TeacherEditableClassTemplateField`.
  - Add `isPrivate: z.boolean().optional(),` to `createClassTemplateSchema` and `updateClassTemplateSchema`.
  - Template create data gains `isPrivate: input.isPrivate ?? false,`.
  - `CLASS_GENERATOR.createChildren`'s `createMany` object gains `isPrivate: template.isPrivate,`, next to `autoCancelCheck: template.autoCancelCheck`.
  - Re-run `tsc`. The remaining errors are `template-form.tsx`'s `_formCovers*` pins, cleared in Step 5.

- [ ] **Step 5: Template form.**
  - `TemplateFormValues` gains `isPrivate: boolean`. The checkbox goes after the Auto-cancel check `Select`.
  - Create and update payloads send it.
  - On a successful edit where the loaded value and the saved value differ, render `Classes already on your schedule keep their own setting.` as a `type-caption` line beside the existing late-first-class notice. Compare against the value the form was initialised with, not the server's answer, so no route change is needed.
  - Initialise from the template being edited (find where `TemplateFormValues` is built for edit: `grep -rn "TemplateForm" src/app`).

- [ ] **Step 6: Integration and component tests.**
  - `tests/integration/class-templates-api.test.ts`: a create with `isPrivate: true` persists `true`, and one without it persists `false`. A PUT `{ isPrivate: true }` on a template that has generated classes → 200, and those classes' `isPrivate` are unchanged.
  - `template-form.test.tsx`:
    - toggling Private and saving sends `isPrivate: true` and shows the notice;
    - saving with only `classType` changed shows no notice (Review Focus 5);
    - create mode shows no notice at all.

- [ ] **Step 7: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run src/services/class-generator.test.ts tests/integration/class-templates-api.test.ts src/components/settings/template-form.test.tsx`
Expected: PASS.

- [ ] **Step 8: Prove the stamp guard bites.** Delete the `isPrivate: template.isPrivate` line from `createChildren`. Run the stamp test and record the failure (expected: `every(c => c.isPrivate)` false). Restore, PASS.

- [ ] **Step 9: Prove the no-cascade guard bites.** Inside the template update's transaction in `class-template-lifecycle.ts`, temporarily add `await tx.class.updateMany({ where: { templateId: id }, data: { isPrivate: true } })` (using that function's own transaction client and id names). Run the flip test and record the failure. Remove it, PASS.

- [ ] **Step 10: Docs.** In `docs/data-model.md`'s `ClassTemplate` table, add `isPrivate | boolean, default false | Stamped onto each generated Class; changing it touches no existing class (#194, #910)`.

- [ ] **Step 11: Commit.**

```bash
git add prisma/schema.prisma prisma/migrations/*_class_template_is_private src/lib/schemas.ts src/services/class-template-lifecycle.ts src/services/class-generator.ts src/services/class-generator.test.ts src/components/settings/template-form.tsx src/components/settings/template-form.test.tsx tests/integration/class-templates-api.test.ts docs/data-model.md <edit page path if touched>
git commit -m "feat(#910): ClassTemplate.isPrivate, stamped onto generated classes"
```

---

### Task 3: Public side — hide from `/[slug]`, booking page noindex and caption

**Files:**
- Modify: `src/app/(public)/[slug]/page.tsx` (listing query, ~line 57)
- Modify: `src/app/(public)/[slug]/book/[classId]/page.tsx` (add `generateMetadata`; caption)
- Modify: `CLAUDE.md` (Data Model: one bullet)
- Create: `tests/integration/private-classes.test.ts`

**Interfaces:**
- Consumes: `Class.isPrivate` (Task 1).

- [ ] **Step 1: Write the failing integration tests** in a new `tests/integration/private-classes.test.ts`. Seed a teacher with a `pageSlug`, a room, and two open future classes via `createClassFixture` (`tests/class-fixtures.ts`), one with `isPrivate: true`. Copy the teacher/room seeding and teardown from `tests/integration/bookings-page.test.ts`, and use `BASE_URL` / `freshIp()` from `tests/helpers.ts`.

```ts
it('/[slug] lists the public class and leaves out the private one', async () => {
  const html = await (await fetch(`${BASE_URL}/${slug}`, { headers: freshIp() })).text();
  expect(html).toContain(`/${slug}/book/${publicClassId}`);
  expect(html).not.toContain(`/${slug}/book/${privateClassId}`);
});

it('the booking page renders a private class, noindex, with the shared-by-link caption', async () => {
  const res = await fetch(`${BASE_URL}/${slug}/book/${privateClassId}`, { headers: freshIp() });
  expect(res.status).toBe(200);
  const html = await res.text();
  expect(html).toMatch(/<meta name="robots" content="noindex/);
  expect(html).toContain(`not on ${firstName}&#x27;s public schedule`); // React escapes the apostrophe; match what it emits
});

it('the booking page for a public class has no noindex and no caption', async () => {
  const html = await (await fetch(`${BASE_URL}/${slug}/book/${publicClassId}`, { headers: freshIp() })).text();
  expect(html).not.toMatch(/<meta name="robots" content="noindex/);
  expect(html).not.toContain('Shared by link');
});

it('a student books a private class through POST /api/registrations', async () => {
  // seed a student session with seedSession; POST { classId: privateClassId } as bookings tests do
  expect(res.status).toBe(201); // or whatever the route answers for a fresh booking; read it from registrations tests
});

it('a full private class still takes a waitlist join (Review Focus 1)', async () => {
  // fill seats with fillSeats (tests/waitlist-fixtures.ts) on a private class with maxStudents 1,
  // then join the waitlist through its route as a second student
  expect(joinRes.status).toBe(201);
});

it('a booked private class still renders for its student (Review Focus 4)', async () => {
  // GET the booking page with the booked student's cookie
  expect(res.status).toBe(200);
});
```

Before the assertion, check how the escaped apostrophe actually comes out by fetching once. Assert the exact form React emits.

- [ ] **Step 2: Run and confirm the first two fail.**
Run: `pnpm exec vitest run --project integration tests/integration/private-classes.test.ts`
Expected: the `/[slug]` case fails (the private class's href is present), and the noindex/caption case fails. The booking, waitlist and render cases already pass. That's expected: the feature adds no refusal, so these are regression pins, not RED tests.

- [ ] **Step 3: Filter the listing.** In `[slug]/page.tsx`'s `findMany` `where`, add `isPrivate: false` beside `status: 'open'`. Extend the existing comment's sentence rather than adding a new paragraph, e.g. "...the one place a cancelled class must never appear, nor a private one (#910), which is booked by its own link."

- [ ] **Step 4: Booking page metadata and caption.**
  - Add `generateMetadata({ params })`. It reads only `{ isPrivate: true }` for the class (`prisma.class.findUnique({ where: { id: classId }, select: { isPrivate: true } })`) and returns `{ robots: { index: false } }` when true, `{}` otherwise. It must not repeat the page's 404 logic: the page body still decides existence.
  - In the body, under the date/time line, when `cls.isPrivate`:

    ```tsx
    <p className="type-caption mt-1">Shared by link — not on {entry.teacher.firstName}&apos;s public schedule.</p>
    ```

- [ ] **Step 5: Run.** Same command as Step 2. Expected: all PASS.

- [ ] **Step 6: Prove the filter guard bites.** Remove `isPrivate: false` from the listing query, warm the route (`curl -s $BASE_URL/<slug> >/dev/null`), and run the `/[slug]` case. Record the failure. Restore, warm, PASS.

- [ ] **Step 7: Prove the noindex guard bites.** Make `generateMetadata` return `{}` unconditionally, warm, and run the noindex case. Record the failure. Restore, PASS.

- [ ] **Step 8: CLAUDE.md.** Under *Data Model*, add one bullet: "`isPrivate` on `Class` and `ClassTemplate` (#910) keeps a class off `/[slug]` — the one listing query — while its booking link works for anyone holding it. Not a `LOCKED_FIELDS` member; the template stamps it like any other field. `docs/superpowers/specs/2026-10-24-private-classes-design.md`"

- [ ] **Step 9: Commit.**

```bash
git add "src/app/(public)/[slug]/page.tsx" "src/app/(public)/[slug]/book/[classId]/page.tsx" tests/integration/private-classes.test.ts CLAUDE.md
git commit -m "feat(#910): private classes are left off the public page, booked by link"
```

---

### Task 4: Teacher side — share the class's own link, schedule-card label

**Files:**
- Create: `src/lib/class-share.ts`, `src/lib/class-share.test.ts`
- Modify: `src/components/class/share-booking-link.tsx` (prop `pageSlug` → `path` + `title`)
- Create: `src/components/class/share-booking-link.test.tsx`
- Modify: `src/app/(teacher)/class/[id]/(overview)/page.tsx` (~line 264-269)
- Modify: `src/components/schedule/getting-started.tsx` (call site)
- Modify: `src/components/schedule/class-card.tsx` (caption, ~line 107-111) and whatever passes its props
- Test: `src/components/schedule/class-card.test.tsx` (create one if absent)

**Interfaces:**
- Consumes: `Class.isPrivate` (Task 1).
- Produces:

```ts
// src/lib/class-share.ts
export function bookingPath(pageSlug: string, classId: string): string; // `/${pageSlug}/book/${classId}`
export type ClassShareState = 'share' | 'publish_first' | 'none';
export function classShareState(
  cls: { status: ClassStatus; cancelled: boolean; start: Date },
  now: Date,
): ClassShareState;
// 'share' when status 'open' && !cancelled && now < start; 'publish_first' when status 'draft' && !cancelled; else 'none'
```

```tsx
// ShareBookingLink
interface ShareBookingLinkProps { path: string; title: string }
```

- [ ] **Step 1: Failing unit tests** in `src/lib/class-share.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { bookingPath, classShareState } from './class-share';

const start = new Date('2026-11-03T17:30:00Z');
describe('bookingPath', () => {
  it('is the class booking page', () => {
    expect(bookingPath('anna', 'c1')).toBe('/anna/book/c1');
  });
});
describe('classShareState', () => {
  it('shares an open class before its start', () => {
    expect(classShareState({ status: 'open', cancelled: false, start }, new Date(start.getTime() - 1))).toBe('share');
  });
  it('stops at the start instant even while the status still reads open', () => {
    expect(classShareState({ status: 'open', cancelled: false, start }, start)).toBe('none');
  });
  it('asks a draft to publish first', () => {
    expect(classShareState({ status: 'draft', cancelled: false, start }, new Date(0))).toBe('publish_first');
  });
  it('offers nothing on a cancelled class', () => {
    expect(classShareState({ status: 'open', cancelled: true, start }, new Date(0))).toBe('none');
    expect(classShareState({ status: 'draft', cancelled: true, start }, new Date(0))).toBe('none');
  });
  it('offers nothing in progress or completed', () => {
    expect(classShareState({ status: 'in_progress', cancelled: false, start }, new Date(0))).toBe('none');
    expect(classShareState({ status: 'completed', cancelled: false, start }, new Date(0))).toBe('none');
  });
});
```

Run `pnpm exec vitest run src/lib/class-share.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 2: Implement `src/lib/class-share.ts`** exactly to the interface above, using `ClassStatus` from `@/lib/prisma-client` (or wherever the codebase imports enums from; match `class-lifecycle.ts`). Run: PASS.

- [ ] **Step 3: `ShareBookingLink` takes a path.**
  - Change props to `{ path, title }`, build `url = window.location.origin + path`, and pass `title` to `navigator.share`. Leave its fallbacks as they are.
  - Update `getting-started.tsx` to pass `path={`/${pageSlug}`}` and `title="Book a class"`, so its behaviour is unchanged.
  - Write `share-booking-link.test.tsx` covering:
    - with `navigator.share` defined, it is called with `{ title, url: origin + path }`;
    - without it, `navigator.clipboard.writeText` receives the URL and the button reads `Link copied`;
    - when the clipboard rejects, the `Copy it yourself:` line shows the URL.

- [ ] **Step 4: Class detail uses it.** In `(overview)/page.tsx`, compute:

  ```ts
  const share = classShareState(
    { status: cls.status, cancelled, start: classStartInstant(cls.calendarEntry, <teacher tz>) },
    new Date(),
  );
  ```

  Use the timezone source the page already uses (grep it for `defaultTimezone` / `classStartInstant`, and add `defaultTimezone` to the select if it's absent). Replace the `cls.status === 'open' &&` block:

  ```tsx
  {share === 'share' && (
    <ShareBookingLink path={bookingPath(cls.calendarEntry.teacher.pageSlug, cls.id)} title={`Book ${cls.calendarEntry.classType}`} />
  )}
  {share === 'publish_first' && <p className="type-caption">Publish to share the link</p>}
  ```

  Update the block's leading comment ("share while bookable") only if it no longer describes the code.

- [ ] **Step 5: Schedule-card label.**
  - `ClassCard` receives `isPrivate` (thread it from the schedule query; find it with `grep -rn "<ClassCard" src`). When it is true, append ` · Private` inside the existing caption `<p className="type-caption ...">`, after the room text. Plain text, no badge, no icon.
  - In `class-card.test.tsx`: renders `Private` when `isPrivate`, and not otherwise.

- [ ] **Step 6: Run.**
Run: `pnpm exec tsc --noEmit && pnpm exec vitest run src/lib/class-share.test.ts src/components/class/share-booking-link.test.tsx src/components/schedule`
Expected: PASS.

- [ ] **Step 7: Prove the share-path guard bites.** Make `bookingPath` return `` `/${pageSlug}` ``. Run `class-share.test.ts` and record the failure. Restore, PASS. Then make `classShareState` test `status === 'open'` without the clock, and record the failure of the "stops at the start instant" case. Restore, PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/lib/class-share.ts src/lib/class-share.test.ts src/components/class/share-booking-link.tsx src/components/class/share-booking-link.test.tsx "src/app/(teacher)/class/[id]/(overview)/page.tsx" src/components/schedule/getting-started.tsx src/components/schedule/class-card.tsx src/components/schedule/class-card.test.tsx <schedule query file>
git commit -m "feat(#910): class detail shares the class's own booking link; Private on the card"
```

---

### Task 5: Verify the whole branch

- [ ] **Step 1:** `pnpm run verify` (typecheck, lint, every vitest project; needs :3000 live). Record the per-project test-file counts for the PR body as `total = unit + components + integration + ...`, read from the run's output.
- [ ] **Step 2:** `pnpm run build`. It catches what `verify` doesn't (server-only leaks, metadata export errors).
- [ ] **Step 3:** `pnpm exec prisma validate` and `pnpm exec prisma migrate status`: two new migrations, both applied, no drift.
- [ ] **Step 4:** Drive it once with the `verify` skill:
  - as a teacher, create a private class through the wizard (step 3 checkbox, step 4 review row) and publish it;
  - see `Private` on its schedule card;
  - tap Share link;
  - open `/{slug}` and confirm it's absent;
  - open the shared URL and book as a student.

  Screenshot the step-3 form, the card and the booking-page caption for the PR.
