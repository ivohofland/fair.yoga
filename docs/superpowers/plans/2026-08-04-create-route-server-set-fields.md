# Create-route server-set fields — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> Every line reference and present-tense claim below describes the tree at this branch's
> base commit, `ea03d3a`, not at merge — this is a dated implementation record, not a live
> reference. The code blocks quoted here are the plan's intent at the time; several were
> revised during the build and the PR review that followed.

**Goal:** Stop three API routes accepting an id from the request body that names another
principal's row without checking it, and make the server-set half of that class of defect
fail the build. Client-supplied cross-tenant foreign keys (`roomId`, `classId`,
`teacherRoomId`, etc.) are a separate half this branch does not close — see the
`SERVER_OWNED_FIELDS` docblock in `schemas.test.ts`.

**Architecture:** Two remedies for two situations. `templateId` is server-set and appears
in no UI, so it is removed from both create schemas. `teacherId` on the privacy route is
legitimately chosen by the client, so it gains a `TeacherStudent` link check. A
`SERVER_OWNED_FIELDS` register in `schemas.test.ts` then holds the line across all 34
exported schemas.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma, Zod 4.4.3, Vitest.

Spec: `docs/superpowers/specs/2026-08-04-create-route-server-set-fields-design.md`

## Global Constraints

- **Never run `npx vitest run --project integration` without a file path.** One file in
  that project is IP rate-limited and a whole-project run trips it. Run single files by
  explicit path.
- **Never start or restart the dev server on :3000.** The user runs it; integration tests
  need it live.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Quote paths containing parentheses** when staging: `(teacher)`, `(public)`, `(student)`.
- TypeScript strict: no `any`, no implicit types. Typecheck with `npx tsc --noEmit`.
- `.strict()` is deliberately NOT added to any create schema. It is not a mass-assignment
  control (zod strips undeclared keys), and no create schema in the repo is strict. Do not
  add it "while you are in there".
- Every guard must be **proved to bite**: break it, record the exact error text in the
  commit or ledger, restore, re-verify. A pin that compiles but cannot fail certifies
  nothing.

**Task order is load-bearing.** Task 5 asserts exact equality over schemas that Tasks 1
and 3 change; it must run last. Task 2 edits the same handler as Task 1.

---

### Task 1: `POST /api/classes` stops accepting `templateId`

**Files:**
- Modify: `tests/integration/classes-api.test.ts` (expose `teacherRoomId`; new describe)
- Modify: `src/lib/schemas.ts:237`
- Modify: `src/app/api/classes/route.ts:78`
- Modify: `src/lib/schemas.test.ts` (new key-set pin)
- Modify: `src/app/(teacher)/class/new/page.tsx:55-77`

**Interfaces:**
- Produces: `createClassSchema` with 13 keys and no `templateId`. Task 5 depends on the
  key set being exactly the list asserted in Step 6.

- [ ] **Step 1: Expose the teacher-room id to the test module**

`beforeAll` creates a `teacherRoom` but keeps it local — `makeClass` closes over it
(`tests/integration/classes-api.test.ts:65-67`). The new tests need its id.

Add beside the other module-level declarations (near `let roomId: string;`, line 13):

```ts
let teacherRoomId: string;
```

And immediately after the `const teacherRoom = await prisma.teacherRoom.create({...})`
call at line 65-67, add:

```ts
  teacherRoomId = teacherRoom.id;
```

- [ ] **Step 2: Write the failing test**

`POST /api/classes` has **zero** integration coverage today — the file's only `describe`
blocks are `/complete`, `/transition` and `PUT /[id]`. Append this describe at the end of
`tests/integration/classes-api.test.ts`:

```ts
describe('POST /api/classes', () => {
  const baseBody = () => ({
    teacherRoomId,
    classType: 'Create Route',
    date: '2099-08-01',
    startTime: '10:00',
    durationMinutes: 60,
    roomCost: 15,
    minRate: 10,
    targetRate: 20,
    minStudents: 1,
    maxStudents: 8,
  });

  const post = (token: string, body: unknown) =>
    fetch(`${BASE_URL}/api/classes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(token) },
      body: JSON.stringify(body),
    });

  it('creates a class against the calling teacher', async () => {
    const res = await post(ownerToken, baseBody());
    expect(res.status).toBe(201);
    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.class.findUniqueOrThrow({ where: { id: data.id } });
    expect(created.teacherId).toBe(ownerId);
    expect(created.templateId).toBeNull();
  });

  // #146. templateId is server-set — class-generator.ts writes it when a
  // template materialises an instance, and no creation UI renders it. Sending
  // another teacher's template id used to squat the (templateId, date) unique
  // pair, which silently stops the victim's generator from ever filling that
  // date.
  it("ignores another teacher's templateId instead of attaching it", async () => {
    const victimRoom = await prisma.teacherRoom.create({
      data: { teacherId: otherTeacherId, roomId, capacityOverride: 8, rentalRate: 15 },
    });
    const victimTemplate = await prisma.classTemplate.create({
      data: {
        teacherId: otherTeacherId,
        teacherRoomId: victimRoom.id,
        classType: 'Victim Recurring',
        dayOfWeek: 3,
        startTime: '18:00',
        durationMinutes: 60,
        roomCost: 15,
        minRate: 10,
        targetRate: 20,
        minStudents: 1,
        maxStudents: 8,
      },
    });

    const res = await post(ownerToken, { ...baseBody(), templateId: victimTemplate.id });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.class.findUniqueOrThrow({ where: { id: data.id } });
    expect(created.templateId).toBeNull();

    // The victim's own generation window is untouched.
    expect(await prisma.class.count({ where: { templateId: victimTemplate.id } })).toBe(0);
  });
});
```

- [ ] **Step 3: Run the test and confirm the right one fails**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts`

Expected: the first test **passes** (it is new coverage of behaviour that already works —
this is not a problem). The second test **fails** on
`expect(created.templateId).toBeNull()` with a message of the form
`expected '<uuid>' to be null`, because `route.ts:78` writes the client's value.

If the second test passes before the fix, stop — the test is not exercising the defect.

- [ ] **Step 4: Remove the field from the schema and the handler**

In `src/lib/schemas.ts`, delete this line from `createClassSchema` (line 237):

```ts
  templateId: z.string().uuid().nullable().optional(),
```

In `src/app/api/classes/route.ts`, delete this line from the `create` data object (line 78):

```ts
      templateId: body.templateId ?? null,
```

`Class.templateId` is `String?`, so omitting the key leaves it null — the same value the
line wrote for every legitimate call. Do not replace it with an explicit `templateId: null`.

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts`
Expected: PASS, all tests in the file.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Add the key-set pin**

`src/lib/schemas.test.ts` already pins `updateClassSchema` (line 134) and
`updateClassTemplateSchema` (line 159) this way. Add the create-side twin next to them,
importing `createClassSchema` if it is not already imported (it is, at line 6):

```ts
  // #146. templateId was accepted here and written straight into
  // prisma.class.create with no ownership check. It is server-set —
  // class-generator.ts sets it when a template materialises an instance — so
  // the fix was to stop declaring it, not to validate it.
  //
  // A failure here is a decision, not a chore: adding a key means a client may
  // now set that column at creation time.
  it('accepts exactly the client-settable create field set', () => {
    expect(Object.keys(createClassSchema.shape).sort()).toEqual([
      'autoCancelCheck',
      'cancelDeadline',
      'classType',
      'date',
      'description',
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

`.shape` is reachable through `.refine()` in zod 4.4.3 — verified; the existing
`updateClassSchema` pin relies on the same property.

- [ ] **Step 7: Tighten the wizard pin**

`src/app/(teacher)/class/new/page.tsx` lines 55-77. Replace the docblock and the
`_formCoversCreate` pin with:

```ts
/**
 * #136. `FormData` is the list; the body is `form` itself, so the two cannot
 * drift. These pins tie that list to the schema.
 *
 * One key is excluded from the forward pin. `description` — `createClassSchema`
 * accepts it and `POST /api/classes` writes it, but this wizard renders no
 * input for it, so a teacher can only describe a class by editing it
 * afterwards. That is a real gap, filed as #147, not something to paper over by
 * adding a field inside an unrelated change.
 *
 * `templateId` used to be excluded here too. It is gone from the schema as of
 * #146 — it was server-set, reached `prisma.class.create` from the request body
 * with no ownership check, and appeared in no UI. With it removed, this pin now
 * enforces the rule the exclusion was suspending: every key this schema
 * declares must be a field this form actually renders.
 */
const _formCoversCreate: NoneOf<
  Exclude<Exclude<keyof CreateClassWire, 'description'>, keyof FormData>
> = true;
```

Leave `_formHasNoExtras` and both `void` statements exactly as they are.

- [ ] **Step 8: Run the wizard's component test and typecheck**

Run: `npx vitest run src/app/\(teacher\)/class/new/page.test.tsx`
Expected: PASS.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Prove both new guards bite**

The key-set pin. Temporarily re-add `templateId: z.string().uuid().nullable().optional(),`
to `createClassSchema`, then run
`npx vitest run src/lib/schemas.test.ts`.
Expected: FAIL, the assertion showing `templateId` present in the received array.
Record the exact message. Restore the file and re-run to confirm PASS.

The wizard pin. With `templateId` still re-added, run `npx tsc --noEmit`.
Expected: FAIL in `src/app/(teacher)/class/new/page.tsx` — a type error on
`_formCoversCreate` naming `"templateId"` (the pin resolves to the offending key rather
than `true`). Record the exact message. Restore and re-run to confirm clean.

**Both proofs use the same edit — do them in one break/restore cycle, not two.**

- [ ] **Step 10: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts src/app/api/classes/route.ts \
  'src/app/(teacher)/class/new/page.tsx' tests/integration/classes-api.test.ts
git commit -m "fix: POST /api/classes wrote a client-supplied templateId unchecked (#146)"
```

---

### Task 2: Remove the `as never` casts from the same handler

**Files:**
- Modify: `src/app/api/classes/route.ts:76-77`

**Interfaces:**
- Consumes: Task 1's edited `create` data object.
- Produces: nothing new.

This is a separate commit from Task 1 deliberately: a security fix and a type cleanup in
one diff are harder to review than two.

**Note on the issue text.** #146 says these casts violate a CLAUDE.md rule reading *"no
type assertions to silence errors"*. **No such rule exists** — CLAUDE.md line 8 says only
"no `any`, no implicit types, non-negotiable". Remove them on their own merits.

- [ ] **Step 1: Remove the casts**

In `src/app/api/classes/route.ts`, replace lines 76-77:

```ts
      cancelDeadline: body.cancelDeadline as never ?? undefined,
      autoCancelCheck: body.autoCancelCheck as never ?? undefined,
```

with:

```ts
      cancelDeadline: body.cancelDeadline,
      autoCancelCheck: body.autoCancelCheck,
```

Prisma generates `CancelDeadline` as `'HOURS_48' | 'HOURS_24' | 'HOURS_12' | 'HOURS_6'`
and `AutoCancelCheck` as `'HOURS_4' | 'HOURS_2' | 'HOURS_1'`
(`node_modules/.prisma/client/index.d.ts:151-168`) — identical to the Zod enum output.
Both columns carry a `@default` on `Class` at `prisma/schema.prisma:334-335`, so
`undefined` is accepted and the `?? undefined` was a no-op. (`:274-275` are
`ClassTemplate`'s identically-defaulted pair — the wrong model for a `prisma.class.create`.)

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: clean.

**If it does not typecheck**, do not force it through with a different assertion and do
not widen a type. Restore the casts, add a comment above them recording the exact
compiler error and why the assertion is load-bearing, and say so in your report. A
surprising failure here is information, not an obstacle.

- [ ] **Step 3: Run the route's tests**

Run: `npx vitest run --project integration tests/integration/classes-api.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/app/api/classes/route.ts
git commit -m "refactor: drop two gratuitous \`as never\` casts on the class create path (#146)"
```

---

### Task 3: `POST /api/studio-classes` stops accepting `templateId` and `studentCount`

**Files:**
- Modify: `tests/integration/studio-api.test.ts` (extend the existing describe at line 412)
- Modify: `src/lib/schemas.ts:365-374`
- Modify: `src/app/api/studio-classes/route.ts:24-32`
- Modify: `src/lib/schemas.test.ts` (new key-set pin)
- Modify: `src/app/(teacher)/studio-class/new/page.tsx:28-46`

**Interfaces:**
- Consumes: nothing from Tasks 1-2.
- Produces: `createStudioClassSchema` with exactly 6 keys. Task 5 depends on this.

- [ ] **Step 1: Write the failing tests**

The file already has `send(method, token, path, body)` (line 57), `makeTemplate(teacherId,
classType, extra)` (line 64) which creates a **`studioClassTemplate`**, plus `ownerId`,
`ownerToken`, `otherId`. Add these two tests inside the existing
`describe('/api/studio-classes', ...)` block that starts at line 412:

```ts
  // #148. Both keys reached prisma.studioClass.create through a `{ date, ...rest }`
  // spread, so neither name appeared anywhere in the handler — a grep for the
  // key names found nothing, which is how this stayed hidden.
  it("ignores another teacher's templateId instead of attaching it", async () => {
    const victimTemplate = await makeTemplate(otherId, 'Victim Studio Template');

    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Squat Attempt',
      date: '2099-07-02',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
      templateId: victimTemplate.id,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.studioClass.findUniqueOrThrow({ where: { id: data.id } });
    expect(created.templateId).toBeNull();

    expect(
      await prisma.studioClass.count({ where: { templateId: victimTemplate.id } }),
    ).toBe(0);
  });

  // Not a security gap — a teacher can set this on their own row via
  // PUT /api/studio-classes/[id]. It is dead surface at create time: the form
  // does not send it and student-count-editor.tsx sets it afterwards.
  it('ignores studentCount at create time', async () => {
    const res = await send('POST', ownerToken, '/api/studio-classes', {
      classType: 'Count At Create',
      date: '2099-07-03',
      startTime: '19:00',
      durationMinutes: 45,
      location: 'Guest Studio',
      hourlyRate: 55,
      studentCount: 12,
    });
    expect(res.status).toBe(201);

    const { data } = (await res.json()) as { data: { id: string } };
    const created = await prisma.studioClass.findUniqueOrThrow({ where: { id: data.id } });
    expect(created.studentCount).toBeNull();
  });
```

- [ ] **Step 2: Run and confirm both fail**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`

Expected: both new tests FAIL. The first on `expect(created.templateId).toBeNull()` with
`expected '<uuid>' to be null`; the second on `expect(created.studentCount).toBeNull()`
with `expected 12 to be null`.

The existing test at line 413 ('creates against the calling teacher') must still pass.

- [ ] **Step 3: Narrow the schema**

In `src/lib/schemas.ts`, delete these two lines from `createStudioClassSchema` (372-373):

```ts
  studentCount: z.number().int().nonnegative().nullable().optional(),
  templateId: z.string().uuid().nullable().optional(),
```

Leave `updateStudioClassSchema` (line 376) untouched — `studentCount` is legitimately
settable there, and `cancelledAt` is a known gap recorded in Task 5's exceptions map.

- [ ] **Step 4: Replace the spread with an explicit field list**

In `src/app/api/studio-classes/route.ts`, replace lines 24-32:

```ts
  const { date, ...rest } = parsed.data;

  const studioClass = await prisma.studioClass.create({
    data: {
      teacherId: session.teacherId,
      date: new Date(date),
      ...rest,
    },
  });
```

with:

```ts
  const body = parsed.data;

  // Fields are named rather than spread. The spread was not the vulnerability —
  // Zod strips undeclared keys, so only declared keys ever rode it — but it did
  // make `templateId` and `studentCount` invisible: neither name appeared in
  // this handler, so grepping for them found nothing (#148).
  const studioClass = await prisma.studioClass.create({
    data: {
      teacherId: session.teacherId,
      classType: body.classType,
      date: new Date(body.date),
      startTime: body.startTime,
      durationMinutes: body.durationMinutes,
      location: body.location,
      hourlyRate: body.hourlyRate,
    },
  });
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run --project integration tests/integration/studio-api.test.ts`
Expected: PASS, whole file.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Add the key-set pin**

In `src/lib/schemas.test.ts`, add `createStudioClassSchema` to the imports and add:

```ts
  // #148. templateId and studentCount reached prisma.studioClass.create through
  // a rest spread, so neither name appeared in the handler at all.
  it('accepts exactly the client-settable studio create field set', () => {
    expect(Object.keys(createStudioClassSchema.shape).sort()).toEqual([
      'classType',
      'date',
      'durationMinutes',
      'hourlyRate',
      'location',
      'startTime',
    ]);
  });
```

- [ ] **Step 7: Make the wizard pin exclusion-free**

`src/app/(teacher)/studio-class/new/page.tsx` lines 28-46. `StudioClassFormValues`
(lines 17-24) declares exactly the six keys the schema now has, so the pin needs no
exclusions at all. Replace the docblock and `_formCoversCreate` with:

```ts
/**
 * #136. `StudioClassFormValues` is the one enumeration of this form's fields;
 * these pins tie it to the schema in both directions, with no exclusions.
 *
 * Both keys that used to be excluded are gone from the schema as of #148.
 * `templateId` was server-set — a studio template materialising a class writes
 * it — and reached `prisma.studioClass.create` from the request body with no
 * ownership check. `studentCount` was dead surface: attendance is not known
 * when a studio class is created, and `student-count-editor.tsx` sets it
 * afterwards through `PUT /api/studio-classes/[id]`.
 *
 * Keep this pin exclusion-free. An exclusion here is how the last two hid.
 */
const _formCoversCreate: NoneOf<
  Exclude<keyof CreateStudioClassWire, keyof StudioClassFormValues>
> = true;
```

Leave `_formHasNoExtras` and both `void` statements as they are.

- [ ] **Step 8: Run the component test and typecheck**

Run: `npx vitest run src/app/\(teacher\)/studio-class/new/page.test.tsx`
Expected: PASS. If it references the removed exclusions in a comment (it does, at line 9),
update that comment to match.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 9: Prove the guards bite**

Re-add `templateId: z.string().uuid().nullable().optional(),` to
`createStudioClassSchema`, then:

- `npx vitest run src/lib/schemas.test.ts` → FAIL, `templateId` in the received array.
- `npx tsc --noEmit` → FAIL in `studio-class/new/page.tsx` naming `"templateId"`.

Record both exact messages, restore, and re-run both to confirm green.

- [ ] **Step 10: Commit**

```bash
git add src/lib/schemas.ts src/lib/schemas.test.ts src/app/api/studio-classes/route.ts \
  'src/app/(teacher)/studio-class/new/page.tsx' tests/integration/studio-api.test.ts
git commit -m "fix: POST /api/studio-classes spread an unchecked templateId into create (#148)"
```

---

### Task 4: The privacy route checks the teacher side

**Files:**
- Modify: `tests/integration/privacy-api.test.ts` (fixture + two new tests)
- Modify: `src/app/api/students/[id]/privacy/route.ts` (both GET and PUT)

**Interfaces:**
- Consumes: nothing from Tasks 1-3.
- Produces: nothing later tasks consume. `updatePrivacySchema` is **unchanged** — Task 5
  keeps `teacherId` as a documented exception.

**This task has a trap.** The existing fixture creates a teacher and **never links them to
the student** — `grep teacherStudent tests/integration/privacy-api.test.ts` returns
nothing. Three of the five existing tests therefore exercise the unlinked path, which is the
vulnerability (the other two short-circuit earlier, on the missing-parameter and
student-side checks, before `hasTeacherLink` is ever reached). Adding the check without
fixing the fixture breaks all three.

- [ ] **Step 1: Link the fixture teacher, and add an unlinked one**

In `tests/integration/privacy-api.test.ts`, add a module-level declaration beside
`let teacherId: string;` (line 12):

```ts
let unlinkedTeacherId: string;
```

In `beforeAll`, immediately after `teacherId = teacher.id;`, add the link the existing
tests have always implicitly assumed:

```ts
    // The four tests below all PUT/GET privacy for this teacher. Until #146's
    // branch they passed with no TeacherStudent row at all — the route never
    // checked the teacher side, so the suite was exercising the hole.
    await prisma.teacherStudent.create({
      data: { teacherId: teacher.id, studentId: student.id },
    });

    const unlinked = await prisma.teacher.create({
      data: {
        firstName: 'Unlinked',
        lastName: 'Teacher',
        email: `privacy-unlinked-${suffix}@test.local`,
        account: { create: { email: `privacy-unlinked-${suffix}@test.local` } },
        bio: 'Privacy fixture — no TeacherStudent link',
        pageSlug: `privacy-unlinked-${suffix}`,
      },
    });
    unlinkedTeacherId = unlinked.id;
```

- [ ] **Step 2: Write the failing tests**

Append inside the same `describe`:

```ts
  // A student could write privacy flags for any teacher, including one they
  // have no relationship with — the route proved the student side and never
  // touched the teacher side. Combined with #162 (a teacher can create the link
  // unilaterally knowing only an email), that pre-authorises disclosure to a
  // stranger.
  it('rejects a PUT for a teacher the student has no link to', async () => {
    const res = await fetch(`${BASE_URL}/api/students/${studentId}/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({ teacherId: unlinkedTeacherId, shareAddress: true }),
    });
    expect(res.status).toBe(403);

    const row = await prisma.studentPrivacy.findUnique({
      where: { studentId_teacherId: { studentId, teacherId: unlinkedTeacherId } },
    });
    expect(row).toBeNull();
  });

  it('rejects a GET for a teacher the student has no link to', async () => {
    const res = await fetch(
      `${BASE_URL}/api/students/${studentId}/privacy?teacherId=${unlinkedTeacherId}`,
      { headers: cookie(studentToken) },
    );
    expect(res.status).toBe(403);
  });
```

- [ ] **Step 3: Run and confirm the shape of the failure**

Run: `npx vitest run --project integration tests/integration/privacy-api.test.ts`

Expected: the five existing tests **pass** (Step 1 gave them the link they need). The two
new tests **fail** — the PUT returns 200 and writes a row (`expected 200 to be 403`, then
the row assertion), and the GET returns 200 (`expected 200 to be 403`).

If an existing test fails here, Step 1 was applied wrongly — fix that before continuing.

- [ ] **Step 4: Add the check to both handlers**

In `src/app/api/students/[id]/privacy/route.ts`, add this helper above the `GET` export:

```ts
/**
 * A student may only read or write privacy settings for a teacher they are
 * actually connected to. Both handlers proved the *student* side
 * (`session.studentId !== id`) and never the teacher side, so `teacherId` was a
 * cross-tenant id taken from the request with no check — the same defect as
 * #146/#148 one route over, with the field kept rather than dropped because
 * here the student legitimately chooses the teacher.
 *
 * Existence, not `isArchived: false`. Archiving is the teacher's filing action;
 * a student does not lose control over their own privacy settings because a
 * teacher tidied them away. `account/privacy/page.tsx` renders cards only for
 * non-archived links, so no UI path reaches the looser case either way.
 */
async function hasTeacherLink(studentId: string, teacherId: string): Promise<boolean> {
  const link = await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId, studentId } },
    select: { id: true },
  });
  return link !== null;
}
```

In `GET`, after the `teacherId` presence check (currently lines 26-28) and before the
`studentPrivacy.findUnique`:

```ts
  if (!(await hasTeacherLink(id, teacherId))) {
    return respondError('Access denied', 403);
  }
```

In `PUT`, after `const { teacherId, ...privacyFields } = parsed.data;` (line 69) and
before the `upsert`:

```ts
  if (!(await hasTeacherLink(id, teacherId))) {
    return respondError('Access denied', 403);
  }
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `npx vitest run --project integration tests/integration/privacy-api.test.ts`
Expected: PASS, all seven tests.

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Prove the guard bites**

Comment out the `hasTeacherLink` check in `PUT` only, and re-run the file.
Expected: `rejects a PUT for a teacher the student has no link to` FAILS with
`expected 200 to be 403`. Record the message, restore, re-run to confirm PASS.

Repeat for `GET`. **Do these separately** — a single edit removing both would not show
that each handler's check is independently load-bearing, and fixing one handler while
leaving its twin is the failure this branch exists to avoid.

- [ ] **Step 7: Commit**

```bash
git add 'src/app/api/students/[id]/privacy/route.ts' tests/integration/privacy-api.test.ts
git commit -m "fix: the privacy route never checked the teacher side of teacherId"
```

---

### Task 5: `SERVER_OWNED_FIELDS` — the register that holds the line

**Files:**
- Modify: `src/lib/schemas.test.ts`

**Interfaces:**
- Consumes: the narrowed `createClassSchema` (Task 1) and `createStudioClassSchema`
  (Task 3). **This task must run after both** — it asserts exact equality, so running it
  earlier would require entries that Tasks 1 and 3 then delete.

The wizard pins from Tasks 1 and 3 are per-form and opt-in: a new create route with a new
form carries no protection unless a contributor remembers to write one. The update path
has had a forbidden list since #79 (`PlainUpdateForbiddenClassField`,
`src/services/class-lifecycle.ts:390`); the create path has had nothing. This is that half.

- [ ] **Step 1: Write the register and its test**

Add to `src/lib/schemas.test.ts`. Import `* as schemas from './schemas'` at the top if not
already present.

```ts
/**
 * Field names the server owns. A schema declaring one of these is saying a
 * client may set that column — which is occasionally right and usually a
 * defect, so every instance has to be named in EXPECTED below with a reason.
 *
 * This exists because the per-form pins in the two create wizards are opt-in: a
 * new route with a new form carries no protection until someone remembers to
 * write one. #146 and #148 were both server-set `templateId` reaching a Prisma
 * create from a request body — found 45 minutes apart by the same sweep, on two
 * routes that had no reason to be compared. This is the create-side counterpart
 * to PlainUpdateForbiddenClassField
 * (src/services/class-lifecycle.ts:390).
 */
const SERVER_OWNED_FIELDS = [
  'accountId', 'archivedAt', 'cancelledAt', 'claimedAt', 'createdById',
  'isArchived', 'isPublic', 'paidAt', 'photoUrl', 'settingsLocked', 'status',
  'studentId', 'teacherId', 'templateId', 'tierAtBooking', 'tierSelectedAt',
  'totalRevenue', 'withdrawnCount',
] as const;

/**
 * Every schema that legitimately declares one, and why. Three of these are
 * known gaps rather than endorsements — they are recorded here, beside the
 * guard, so the next person to touch that schema reads the gap instead of
 * rediscovering it.
 */
const EXPECTED: Record<string, readonly string[]> = {
  // A teacher registers a student from their own roster; ownership is checked
  // in src/app/api/registrations/route.ts:87-92 (the TeacherStudent link is
  // looked up and a missing link 403s before the registration is created).
  createRegistrationSchema: ['studentId'],
  // Whether a newly created room is shared is legitimately the creator's call.
  createRoomSchema: ['isPublic'],
  // This schema *is* the state machine's input. 'completed' is deliberately
  // absent so completion must go through the route that runs pricing.
  transitionClassSchema: ['status'],
  // The student chooses which teacher's settings to change. The TeacherStudent
  // link is checked in the route as of this branch.
  updatePrivacySchema: ['teacherId'],
  // Attendance status on the teacher's own class.
  updateRegistrationSchema: ['status'],
  // KNOWN GAP: no form sends it, and flipping it true is a one-way door — the
  // room can then no longer be edited or deleted, and any teacher may attach.
  // Blocked on #73's isPublic product decision.
  updateRoomSchema: ['isPublic'],
  // KNOWN GAP: a client can backdate, forward-date or null a cancellation
  // timestamp. Ownership is checked, so the blast radius is the teacher's own
  // bookkeeping.
  updateStudioClassSchema: ['cancelledAt'],
  // KNOWN GAP: no form sends it and nothing renders it. Latent until someone
  // adds the <img>. Blocked on #46.
  updateTeacherSchema: ['photoUrl'],
};

describe('server-owned fields', () => {
  it('are declared only where EXPECTED says so, and everywhere it says so', () => {
    const actual: Record<string, string[]> = {};

    for (const [name, schema] of Object.entries(schemas)) {
      const shape = (schema as { shape?: Record<string, unknown> })?.shape;
      if (!shape) continue;
      const hits = Object.keys(shape)
        .filter((k) => (SERVER_OWNED_FIELDS as readonly string[]).includes(k))
        .sort();
      if (hits.length > 0) actual[name] = hits;
    }

    const expected = Object.fromEntries(
      Object.entries(EXPECTED).map(([k, v]) => [k, [...v].sort()]),
    );

    // Exact equality in both directions. A new declaration fails naming the
    // schema; deleting a legitimate one fails too, so the reasons above cannot
    // rot into a list of names nobody re-reads.
    expect(actual).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run src/lib/schemas.test.ts`
Expected: PASS. If it fails naming `createClassSchema` or `createStudioClassSchema`,
Tasks 1 or 3 were not applied — do not add them to `EXPECTED` to make it green.

- [ ] **Step 3: Prove it bites in the direction that matters**

Re-add `templateId: z.string().uuid().nullable().optional(),` to `createClassSchema` and
run `npx vitest run src/lib/schemas.test.ts`.
Expected: FAIL, the diff showing `createClassSchema: ['templateId']` present in actual and
absent from expected. Record the message. Restore and confirm PASS.

- [ ] **Step 4: Prove it bites in the other direction**

Delete the `updateRoomSchema: ['isPublic'],` line from `EXPECTED` and re-run.
Expected: FAIL, showing `updateRoomSchema` present in actual and absent from expected.
This is what stops the register decaying into stale prose. Record the message, restore,
confirm PASS.

- [ ] **Step 5: Prove a typo cannot hide in the list**

Change `'templateId'` in `SERVER_OWNED_FIELDS` to `'templatId'` and re-run.
Expected: **PASS** — which is the point, and is not a mistake in this step.

The reason is worth understanding before you write the pin. The test compares `actual`
against `EXPECTED`, so it *does* catch a typo in any name some schema currently declares —
misspelling `'isPublic'` drops `createRoomSchema` and `updateRoomSchema` out of `actual`
and fails. What it cannot catch is a typo in a name **nothing declares today**:
`templateId` (post-Task-1), `paidAt`, `settingsLocked`, `tierAtBooking`, and others. Those
are the forward-looking names in the register — the ones guarding against a future
addition — so the blind spot covers precisely the entries whose whole job is to fire later.

Therefore add this compile-time pin directly below `SERVER_OWNED_FIELDS`, mirroring
`_forbiddenColumnsExist` (`src/services/class-lifecycle.ts:405`):

```ts
// Every name above must be a real column on some Prisma model. Without this a
// typo would sit in the list protecting nothing while looking like protection.
// Fails naming the offender.
type AnyModelKey =
  | keyof Prisma.ClassUncheckedUpdateManyInput
  | keyof Prisma.StudioClassUncheckedUpdateManyInput
  | keyof Prisma.StudentUncheckedUpdateManyInput
  | keyof Prisma.TeacherUncheckedUpdateManyInput
  | keyof Prisma.RoomUncheckedUpdateManyInput
  | keyof Prisma.RegistrationUncheckedUpdateManyInput
  | keyof Prisma.PaymentUncheckedUpdateManyInput
  | keyof Prisma.ClassTemplateUncheckedUpdateManyInput;

const _serverOwnedNamesExist: NoneOf<
  Exclude<(typeof SERVER_OWNED_FIELDS)[number], AnyModelKey>
> = true;
void _serverOwnedNamesExist;
```

Add `import type { Prisma } from '@prisma/client';` and
`import type { NoneOf } from './type-pins';` to the file's imports.

With the typo still in place, run `npx tsc --noEmit`.
Expected: FAIL naming `"templatId"`. Record it. Restore the correct spelling and confirm
both `tsc` and the test are green.

**If a legitimate name in the list is not a key of any model above**, that is real
information: either the union needs another model or the name is wrong. Report it rather
than deleting the name to get to green.

- [ ] **Step 6: Full verification**

Run: `npx tsc --noEmit` → clean
Run: `npx vitest run src/lib/schemas.test.ts` → PASS
Run: `npx vitest run --project unit` → PASS

- [ ] **Step 7: Commit**

```bash
git add src/lib/schemas.test.ts
git commit -m "test: register every schema that declares a server-owned field (#146, #148)"
```

---

## Final verification (after all five tasks)

- [ ] `npx tsc --noEmit` — clean
- [ ] `npx vitest run --project unit` — PASS
- [ ] `npx vitest run --project components` — PASS
- [ ] `npx vitest run --project integration tests/integration/classes-api.test.ts` — PASS
- [ ] `npx vitest run --project integration tests/integration/studio-api.test.ts` — PASS
- [ ] `npx vitest run --project integration tests/integration/privacy-api.test.ts` — PASS
- [ ] `npx vitest run --project integration tests/integration/class-templates-api.test.ts` — PASS
      (it counts classes by `templateId`; nothing here should move it, and confirming that
      is cheaper than assuming)
- [ ] `npx eslint .` — clean
- [ ] Confirm **no** `.strict()` was added to any create schema:
      `grep -n "strict()" src/lib/schemas.ts` should still return exactly 9 lines
- [ ] Re-read `docs/superpowers/specs/2026-08-04-create-route-server-set-fields-design.md`
      and correct any claim the build disproved — the spec, the plan, the code comments,
      the PR body and the two GitHub issues must agree. Correcting one and not the others
      is this project's most repeated failure.

Never run the integration project without a file path.
