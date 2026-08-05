# Student Visibility Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the codebase one implementation of "what may this teacher see about this student", apply it to all 13 sites, and stop teacher-facing responses carrying raw surnames, unshared contact details, and income tiers.

**Architecture:** A pure module `src/lib/student-visibility.ts` exports `teacherVisibleName` (name only, for the three sites that render nothing else) and `projectStudentForTeacher` (the full projection, which calls it), plus two Prisma `select` fragments so the query shape and the projection are defined together. Five existing inline implementations are replaced by it; eight ungated handlers adopt it or narrow their responses. Two compile-time pins make the two regressions that matter — a raw name field reappearing on the projection, and a new `StudentPrivacy` flag being silently ignored — build failures.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma, Vitest (three projects: `unit`, `integration`, `components`).

**Reference:** `docs/superpowers/specs/2026-08-05-student-visibility-projection-design.md`

## Global Constraints

- **Never run `npx vitest run --project integration` without a file path.** One file in that project is IP rate-limited and a whole-project run trips it. Always name files by explicit path.
- **Never start or restart the dev server on :3000.** The user runs it; integration tests need it live.
- **Never `git add -A` or `git add .`** — stage exact paths. **Quote paths containing parentheses**: `'src/app/(teacher)/...'`.
- **TypeScript `strict: true`** — no `any`, no implicit types. `npm run typecheck` must be clean at every commit.
- **`@/lib/log` is pino and server-only.** `src/lib/student-visibility.ts` must use **type-only** `@prisma/client` imports (like `src/lib/contacts.ts` and `src/lib/payment-status.ts`) so it stays safe for a `'use client'` chain.
- **Hidden fields are `null`, never omitted.** Every key of `TeacherVisibleStudent` is always present.
- **Teacher-facing responses carry `displayName`, never `firstName`/`lastName`.**
- **No `shareIncomeTier` flag is added.** `incomeTier`, `tierAtBooking` and `tierRatio` are dropped from teacher-facing responses.
- Every guard gets an explicit **break → record the exact error text → restore → re-verify** step. A guard that compiles but cannot fail certifies nothing.

---

## File Structure

**Create:**
- `src/lib/student-visibility.ts` — the projection, the name composer, two select fragments, two pins
- `src/lib/student-visibility.test.ts` — unit tests (project: `unit`)
- `src/components/students/student-directory.test.tsx` — component test (project: `components`); this component has none today

**Modify:**
- `src/services/payments.ts` — both query functions, and their lying return types
- `src/app/api/students/route.ts`, `src/app/api/students/[id]/route.ts`
- `src/app/api/payments/route.ts`, `src/app/api/payments/[id]/route.ts`, `src/app/api/classes/[id]/payments/route.ts`
- `src/app/api/classes/[id]/registrations/route.ts`, `src/app/api/registrations/[id]/route.ts`, `src/app/api/registrations/route.ts`
- `src/app/(teacher)/students/[id]/page.tsx`, `src/app/(teacher)/class/[id]/page.tsx`, `src/app/(teacher)/settings/payments/page.tsx`
- `src/components/students/student-directory.tsx`, `src/components/class/add-walk-in.tsx`
- `tests/integration/payments-api.test.ts`, `registrations-api.test.ts`, `students-api.test.ts`
- `docs/data-model.md` — the `StudentPrivacy` table is missing `share_full_name` and its creation note is wrong

---

### Task 1: Claim the payments-api fixture student

**This task must land before any privacy assertion is written against that suite.** The fixture creates an *unclaimed* student, and every gating site has an `isUnclaimed ||` bypass — so a privacy test built on this fixture takes the bypass and passes against the bug it was written to catch. This is the exact trap issue #167 warned about, and it is live in the suite Task 5 and Task 6 extend.

**Files:**
- Modify: `tests/integration/payments-api.test.ts:78-85`

**Interfaces:**
- Consumes: nothing
- Produces: a `claimedAt`-bearing fixture student in `payments-api.test.ts`, so later tasks' assertions exercise the real gate

- [ ] **Step 1: Prove the fixture is unclaimed and the bypass would fire**

Read `tests/integration/payments-api.test.ts:78-85`. Confirm the `prisma.student.create` has neither `claimedAt` nor an `account`. Confirm `src/app/api/students/[id]/route.ts:54` computes `const isUnclaimed = !student.claimedAt;` and `:59` short-circuits the surname gate on it.

- [ ] **Step 2: Give the fixture student an account and a claim stamp**

`Student_claim_link_check` (`prisma/migrations/20260721061528_student_claim_link_check/migration.sql`) enforces `("claimedAt" IS NULL) = ("accountId" IS NULL)`, so both must be set together — setting only `claimedAt` violates the constraint.

Replace lines 78-85 with:

```ts
  const studentEmail = `pay-student-${suffix}@test.local`;
  const student = await prisma.student.create({
    data: {
      firstName: 'Reminder',
      lastName: 'Student',
      email: studentEmail,
      incomeTier: 3,
      // Claimed, deliberately. Every privacy gate has an `isUnclaimed ||`
      // bypass, so an unclaimed fixture would make any assertion added here
      // pass whether or not the gate works. See #167.
      claimedAt: new Date(),
      account: { create: { email: studentEmail } },
    },
  });
  studentId = student.id;
```

- [ ] **Step 3: Extend teardown to delete the new Account**

`Account` rows are not cascaded from `Student`. Find the `afterAll` in this file and add a `prisma.account.deleteMany` for the student's account, following the pattern at `tests/integration/students-api.test.ts:607-610`. Read the existing `afterAll` first and match its ordering — accounts go last, after sessions and the rows that reference them.

- [ ] **Step 4: Run the suite; everything still passes**

Run: `npx vitest run --project integration tests/integration/payments-api.test.ts`
Expected: PASS, same test count as before. If a test now fails, the fixture change altered behaviour someone depended on — stop and report rather than adapting the assertion.

- [ ] **Step 5: Commit**

```bash
git add tests/integration/payments-api.test.ts
git commit -m "test: the payments fixture student was unclaimed, so a privacy gate could not be tested on it (#167)"
```

---

### Task 2: The projection module

**Files:**
- Create: `src/lib/student-visibility.ts`
- Create: `src/lib/student-visibility.test.ts`

**Interfaces:**
- Consumes: `formatStudentName` from `src/lib/format.ts`; `NoneOf` from `src/lib/type-pins.ts`
- Produces:
  - `type VisibilityFlags = Pick<StudentPrivacy, 'shareFullName'|'shareEmail'|'sharePhone'|'shareBirthday'|'shareAddress'>`
  - `interface StudentNameInput { firstName: string; lastName: string; claimedAt: Date | null; studentPrivacy: Pick<VisibilityFlags, 'shareFullName'>[] }`
  - `interface StudentProjectionInput extends StudentNameInput { id: string; email: string; phone: string | null; birthday: Date | null; address: string | null; studentPrivacy: VisibilityFlags[] }`
  - `interface TeacherVisibleStudent { id: string; displayName: string; email: string | null; phone: string | null; birthday: Date | null; address: string | null; claimedAt: Date | null }`
  - `function teacherVisibleName(student: StudentNameInput): string`
  - `function projectStudentForTeacher(student: StudentProjectionInput): TeacherVisibleStudent`
  - `function studentNameSelect(teacherId: string)` — Prisma `StudentSelect` for `teacherVisibleName`'s input
  - `function studentVisibilitySelect(teacherId: string)` — Prisma `StudentSelect` for `projectStudentForTeacher`'s input

- [ ] **Step 1: Write the failing unit tests**

Create `src/lib/student-visibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  teacherVisibleName,
  projectStudentForTeacher,
  type StudentProjectionInput,
} from './student-visibility';

const ALL_FALSE = {
  shareFullName: false,
  shareEmail: false,
  sharePhone: false,
  shareBirthday: false,
  shareAddress: false,
};

const BIRTHDAY = new Date('1990-04-17T00:00:00.000Z');

function claimedStudent(
  overrides: Partial<StudentProjectionInput> = {},
): StudentProjectionInput {
  return {
    id: 'student-1',
    firstName: 'Anna',
    lastName: 'Bakker',
    email: 'anna@example.com',
    phone: '+31612345678',
    birthday: BIRTHDAY,
    address: 'Keizersgracht 1',
    claimedAt: new Date('2026-01-01T00:00:00.000Z'),
    studentPrivacy: [ALL_FALSE],
    ...overrides,
  };
}

describe('teacherVisibleName', () => {
  it('gives a last initial when the surname is not shared', () => {
    expect(teacherVisibleName(claimedStudent())).toBe('Anna b.');
  });

  it('gives the full name when shareFullName is true', () => {
    const s = claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareFullName: true }] });
    expect(teacherVisibleName(s)).toBe('Anna Bakker');
  });

  it('treats a missing privacy row as maximum privacy', () => {
    expect(teacherVisibleName(claimedStudent({ studentPrivacy: [] }))).toBe('Anna b.');
  });

  it('ungates a legacy unclaimed student', () => {
    expect(teacherVisibleName(claimedStudent({ claimedAt: null }))).toBe('Anna Bakker');
  });
});

describe('projectStudentForTeacher', () => {
  it('withholds every unshared field as null, with the key present', () => {
    const result = projectStudentForTeacher(claimedStudent());
    expect(result).toEqual({
      id: 'student-1',
      displayName: 'Anna b.',
      email: null,
      phone: null,
      birthday: null,
      address: null,
      claimedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
  });

  it('releases exactly the fields whose flag is set, and no others', () => {
    const s = claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareEmail: true }] });
    const result = projectStudentForTeacher(s);
    expect(result.email).toBe('anna@example.com');
    expect(result.phone).toBeNull();
    expect(result.birthday).toBeNull();
    expect(result.address).toBeNull();
  });

  it('gates each field on its own flag', () => {
    expect(
      projectStudentForTeacher(
        claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, sharePhone: true }] }),
      ).phone,
    ).toBe('+31612345678');
    expect(
      projectStudentForTeacher(
        claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareBirthday: true }] }),
      ).birthday,
    ).toEqual(BIRTHDAY);
    expect(
      projectStudentForTeacher(
        claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareAddress: true }] }),
      ).address,
    ).toBe('Keizersgracht 1');
  });

  it('never emits a raw surname under any flag combination', () => {
    const shared = projectStudentForTeacher(
      claimedStudent({ studentPrivacy: [{ ...ALL_FALSE, shareFullName: true }] }),
    );
    expect(Object.keys(shared)).not.toContain('lastName');
    expect(Object.keys(shared)).not.toContain('firstName');
  });

  it('never emits an income tier, even though the query loads the row', () => {
    const result = projectStudentForTeacher(claimedStudent());
    expect(Object.keys(result)).not.toContain('incomeTier');
  });

  it('preserves a null optional field as null when it IS shared', () => {
    const s = claimedStudent({
      phone: null,
      studentPrivacy: [{ ...ALL_FALSE, sharePhone: true }],
    });
    expect(projectStudentForTeacher(s).phone).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run --project unit src/lib/student-visibility.test.ts`
Expected: FAIL — `Failed to resolve import "./student-visibility"`.

- [ ] **Step 3: Write the module**

Create `src/lib/student-visibility.ts`:

```ts
import type { Prisma, StudentPrivacy } from '@prisma/client';
import type { NoneOf } from './type-pins';
import { formatStudentName } from './format';

/**
 * One answer to "what may this teacher see about this student".
 *
 * Before #167 this rule had five implementations — `api/students/route.ts`,
 * `api/students/[id]/route.ts`, and three teacher server pages — and eight
 * further handlers that simply did not consult it. The route-only census in
 * the issue could not see the three pages, which is how a helper meant to
 * replace two copies would have become a sixth.
 *
 * Type-only `@prisma/client` import, same as `contacts.ts` and
 * `payment-status.ts`: this stays safe to import from a `'use client'` module
 * without pulling the Prisma runtime into the browser bundle.
 */

/**
 * The flags that gate *field visibility*.
 *
 * `receiveComms` is deliberately absent. It gates message delivery
 * (`api/announcements/route.ts`), not what a teacher may read — folding it in
 * here would invite a call site to hide a student's phone number because they
 * opted out of optional email.
 */
export type VisibilityFlags = Pick<
  StudentPrivacy,
  'shareFullName' | 'shareEmail' | 'sharePhone' | 'shareBirthday' | 'shareAddress'
>;

/**
 * Every `share*` column on `StudentPrivacy` must be classified — either as a
 * visibility flag above, or in the explicit exclusion list here. A new column
 * (say `shareIncomeTier`) fails this pin by name rather than being silently
 * ignored by every projection in the app.
 *
 * #167 decided against `shareIncomeTier` specifically: on `/class/[id]`,
 * `PricingBreakdown` renders "Tier 4 · €15.20" and `PaymentChecklist` renders
 * "Anna B. — €15.20" in adjacent sections, and the five `TIER_RATIOS` are
 * distinct, so the tier of any student who books is legible by name regardless.
 * If that display ever changes, this pin is where the decision gets revisited.
 */
const _visibilityFlagsAreExhaustive: NoneOf<
  Exclude<
    keyof StudentPrivacy,
    | 'id' | 'studentId' | 'teacherId' | 'createdAt' | 'updatedAt'
    | 'receiveComms'
    | keyof VisibilityFlags
  >
> = true;
void _visibilityFlagsAreExhaustive;

/** Just enough to compose a display name. */
export interface StudentNameInput {
  firstName: string;
  lastName: string;
  claimedAt: Date | null;
  studentPrivacy: Pick<VisibilityFlags, 'shareFullName'>[];
}

/** Everything the full projection reads. */
export interface StudentProjectionInput extends StudentNameInput {
  id: string;
  email: string;
  phone: string | null;
  birthday: Date | null;
  address: string | null;
  studentPrivacy: VisibilityFlags[];
}

/**
 * What a teacher may see. Every key is always present; a withheld field is
 * `null`, never absent — an absent key is indistinguishable from a route that
 * forgot to select the field, which is the failure #167 existed to close.
 *
 * No `firstName`, no `lastName`: the un-truncated surname is not in this object
 * at all, so a new call site cannot leak it by forgetting to truncate.
 */
export interface TeacherVisibleStudent {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
  birthday: Date | null;
  address: string | null;
  claimedAt: Date | null;
}

/**
 * No raw name or tier field may rejoin the projection. This is the exact
 * regression #167 closed, and it would otherwise reappear silently the first
 * time someone "just needs the surname here".
 */
const _projectionCarriesNoRawIdentity: NoneOf<
  Extract<
    keyof TeacherVisibleStudent,
    'firstName' | 'lastName' | 'incomeTier' | 'tierAtBooking' | 'tierRatio'
  >
> = true;
void _projectionCarriesNoRawIdentity;

/**
 * #166 retired the unclaimed student: nothing creates a `Student` row without
 * `claimedAt` any more, every `TeacherStudent` writer requires a
 * `session.studentId`, and `Student_claim_link_check` ties `accountId` to
 * `claimedAt`. There is no production deployment, so no legacy unclaimed rows
 * exist anywhere for this branch to expose.
 *
 * It is kept rather than deleted because removing it means removing the claim
 * path (`lib/auth/account.ts:34-50`), the `Student_claim_link_check`
 * constraint and `Student.claimedAt` together — one decision, not five edits.
 * Before #167 this comment stood in five places and each copy claimed the
 * question was "filed as a leaf"; no such issue existed. It is not filed, and
 * this is deliberate: it is dead code with a complete explanation, not a
 * defect anyone can reach.
 */
function bypassesPrivacy(student: { claimedAt: Date | null }): boolean {
  return !student.claimedAt;
}

export function teacherVisibleName(student: StudentNameInput): string {
  const shareFullName =
    bypassesPrivacy(student) || (student.studentPrivacy[0]?.shareFullName ?? false);
  return formatStudentName(student.firstName, student.lastName, shareFullName);
}

export function projectStudentForTeacher(
  student: StudentProjectionInput,
): TeacherVisibleStudent {
  const flags = student.studentPrivacy[0];
  const ungated = bypassesPrivacy(student);
  const shared = <T>(flag: boolean | undefined, value: T): T | null =>
    ungated || (flag ?? false) ? value : null;

  return {
    id: student.id,
    displayName: teacherVisibleName(student),
    email: shared(flags?.shareEmail, student.email),
    phone: shared(flags?.sharePhone, student.phone),
    birthday: shared(flags?.shareBirthday, student.birthday),
    address: shared(flags?.shareAddress, student.address),
    claimedAt: student.claimedAt,
  };
}

/** Query fragment for `teacherVisibleName`'s input. */
export function studentNameSelect(teacherId: string) {
  return {
    firstName: true,
    lastName: true,
    claimedAt: true,
    studentPrivacy: {
      where: { teacherId },
      select: { shareFullName: true },
    },
  } satisfies Prisma.StudentSelect;
}

/** Query fragment for `projectStudentForTeacher`'s input. */
export function studentVisibilitySelect(teacherId: string) {
  return {
    id: true,
    firstName: true,
    lastName: true,
    email: true,
    phone: true,
    birthday: true,
    address: true,
    claimedAt: true,
    studentPrivacy: {
      where: { teacherId },
      select: {
        shareFullName: true,
        shareEmail: true,
        sharePhone: true,
        shareBirthday: true,
        shareAddress: true,
      },
    },
  } satisfies Prisma.StudentSelect;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run --project unit src/lib/student-visibility.test.ts`
Expected: PASS, 10 tests (4 for `teacherVisibleName`, 6 for `projectStudentForTeacher`).

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Mutation-test guard 1 — `_visibilityFlagsAreExhaustive`**

The pin fires when a `StudentPrivacy` column is neither a visibility flag nor explicitly excluded. Reach that state by removing an exclusion rather than by adding a column: delete `| 'receiveComms'` from the `Exclude<...>` list, then run `npm run typecheck`.

Expected: FAIL in `src/lib/student-visibility.ts` naming `receiveComms` — the pin resolves to `"receiveComms"`, which is not assignable to `true`. This exercises the identical code path a new `shareIncomeTier` column would take. **Record the exact error text in the commit body.** Then restore the line and confirm typecheck is clean.

**Do not mutate `prisma/schema.prisma` to test this.** Adding a column there requires `npx prisma generate`, which rewrites the client in `node_modules` underneath the dev server the user is running on :3000 — and restarting that server to clear the stale client is forbidden by the Global Constraints. The exclusion-list mutation proves the same thing with no regeneration.

- [ ] **Step 6: Mutation-test guard 2 — `_projectionCarriesNoRawIdentity`**

Temporarily add `lastName: string;` to the `TeacherVisibleStudent` interface. Run `npm run typecheck`.

Expected: FAIL naming `lastName`. **Record the exact error text in the commit body.** Then remove the line and confirm typecheck is clean.

- [ ] **Step 7: Mutation-test guard 3 — the unit tests actually detect a broken gate**

Temporarily change `shared` to ignore its flag: `const shared = <T>(flag: boolean | undefined, value: T): T | null => value;`. Run `npx vitest run --project unit src/lib/student-visibility.test.ts`.

Expected: FAIL — at minimum "withholds every unshared field as null" and "releases exactly the fields whose flag is set". **Record which tests fail and the count.** Then restore.

- [ ] **Step 8: Commit**

```bash
git add src/lib/student-visibility.ts src/lib/student-visibility.test.ts
git commit -m "feat: one projection for what a teacher may see about a student (#167)"
```

Put the three recorded mutation results in the commit body — a guard whose failure has not been observed is not yet evidence.

---

### Task 3: The profile route adopts the projection and drops `incomeTier`

**Files:**
- Modify: `src/app/api/students/[id]/route.ts:33-72` (the teacher branch of `GET`)
- Modify: `tests/integration/students-api.test.ts:626-631`

**Interfaces:**
- Consumes: `projectStudentForTeacher`, `studentVisibilitySelect` from Task 2
- Produces: `GET /api/students/[id]` (teacher branch) responds with `TeacherVisibleStudent`

**Context the implementer needs:** nothing in the app calls `GET /api/students/[id]` — every consumer of that path is a `PUT` or `PATCH` (`booking-flow.tsx:53`, `tier-form.tsx:43`, `notifications-form.tsx:94`, `archive-student-button.tsx:22`). So this is a zero-UI-change edit, and the only thing that reads the response is the integration suite.

- [ ] **Step 1: Update the existing assertions to the new contract**

`tests/integration/students-api.test.ts:626-631` currently asserts the old shape. It uses a **claimed** roster student (`:582-590`) with default privacy, which is the right fixture — keep it. Replace the test body with:

```ts
  it('a dual account reading a roster student gets the privacy-filtered view', async () => {
    const res = await as(dualToken, `/api/students/${rosterStudentId}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { displayName: string; email: string | null; incomeTier?: number };
    };
    // Default privacy: a composed name with a last initial, and no email.
    // `email` is present and null rather than absent — an absent key cannot be
    // told apart from a route that forgot to select the field (#167).
    expect(body.data.displayName).toBe('Rostered p.');
    expect(body.data.email).toBeNull();
    // No tier: there is no shareIncomeTier flag and #167 decided against one.
    expect(body.data.incomeTier).toBeUndefined();
  });
```

Leave the sibling test at `:613-621` alone — it reads the caller's *own* row through the self path at `:25-27`, which is not a teacher boundary and does not change.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`
Expected: FAIL — `expected undefined to be 'Rostered p.'` (the route still returns `lastName: 'P'`).

- [ ] **Step 3: Rewrite the teacher branch**

In `src/app/api/students/[id]/route.ts`, add to the imports:

```ts
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';
```

The route currently loads the student at `:21` with `findUnique({ where: { id } })` and uses it for both the self path and the teacher path. Keep that load for the self path, and give the teacher branch its own narrowed re-read so the projection's input type is satisfied and unshared columns are never loaded twice. Replace lines 33-72 with:

```ts
  if (session.teacherId) {
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: session.teacherId, studentId: id } },
    });
    if (!link) return respondError('Student not in your contacts', 403);

    const visible = await prisma.student.findUnique({
      where: { id },
      select: studentVisibilitySelect(session.teacherId),
    });
    if (!visible) return respondError('Student not found', 404);

    return respondOk(projectStudentForTeacher(visible));
  }
```

Note what leaves with this edit: the separate `prisma.studentPrivacy.findUnique` at `:39-46` (the select fragment loads the row inline), the five inline `isUnclaimed ||` conditions, the five-line `#166` comment (it now lives once, in `student-visibility.ts`), and `incomeTier` at `:60`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 5: Mutation-test the route's gate**

Temporarily change the return to `return respondOk(visible);` — the raw row instead of the projection. Run the suite.

Expected: FAIL on `displayName` being undefined **and** on `email` being a string rather than null. **Record the exact assertion failures.** Then restore.

This is the check that matters: it proves the test detects the un-projected row, not merely that the route returns *something*.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/students/[id]/route.ts' tests/integration/students-api.test.ts
git commit -m "fix: the profile route returned an ungated income tier to every linked teacher (#167)"
```

---

### Task 4: The student list adopts the projection, and its two consumers follow

**Files:**
- Modify: `src/app/api/students/route.ts:62-135` (`GET`)
- Modify: `src/components/students/student-directory.tsx:11-21, 114-116`
- Modify: `src/components/class/add-walk-in.tsx:10-14, 101`
- Create: `src/components/students/student-directory.test.tsx`

**Interfaces:**
- Consumes: `projectStudentForTeacher`, `studentVisibilitySelect` from Task 2
- Produces: `GET /api/students` list items shaped `TeacherVisibleStudent & { lastClassDate: string | null; classCount: number; overduePayments: number }`. `firstName`, `lastName` and `shareFullName` leave the contract; `displayName` joins it.

- [ ] **Step 1: Write the failing component test**

`student-directory.tsx` has no test today. Create `src/components/students/student-directory.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { StudentDirectory } from './student-directory';

/**
 * The directory renders whatever name the API hands it. Before #167 it
 * re-truncated an already-truncated surname through `formatStudentName`, which
 * was correct only because that composition happens to be idempotent — nothing
 * tested it, and a future call site had no way to know. The API now sends one
 * composed `displayName`; this pins that the component stopped composing.
 */
describe('StudentDirectory', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: {
            students: [
              {
                id: 'student-1',
                displayName: 'Anna b.',
                email: null,
                phone: null,
                birthday: null,
                address: null,
                claimedAt: '2026-01-01T00:00:00.000Z',
                lastClassDate: null,
                classCount: 3,
                overduePayments: 0,
              },
            ],
            total: 1,
            page: 1,
            pageSize: 20,
          },
        }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the name the API composed, without recomposing it', async () => {
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna b.')).toBeInTheDocument());
  });

  it('renders no email row when the student withheld it', async () => {
    render(<StudentDirectory />);
    await waitFor(() => expect(screen.getByText('Anna b.')).toBeInTheDocument());
    expect(screen.queryByText(/@/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run --project components src/components/students/student-directory.test.tsx`
Expected: FAIL — the component reads `student.firstName`/`student.lastName`, which the mock does not provide, so no `Anna b.` appears.

- [ ] **Step 3: Rewrite the list route's projection**

In `src/app/api/students/route.ts`, add to the imports:

```ts
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';
```

Replace the `select` block at `:68-91` — keep the three aggregate sub-selects exactly as they are and swap the student columns for the fragment:

```ts
      select: {
        ...studentVisibilitySelect(session.teacherId),
        registrations: {
          where: { class: { teacherId: session.teacherId } },
          orderBy: { registeredAt: 'desc' },
          take: 1,
          select: { class: { select: { date: true } } },
        },
        _count: {
          select: {
            registrations: {
              where: { class: { teacherId: session.teacherId } },
            },
          },
        },
      },
```

Then replace the `students.map` at `:112-133` with:

```ts
  const result = students.map((s) => ({
    ...projectStudentForTeacher(s),
    lastClassDate: s.registrations[0]?.class.date ?? null,
    classCount: s._count.registrations,
    overduePayments: overdueByStudent.get(s.id) ?? 0,
  }));
```

The inline `isUnclaimed`/`shareFullName`/`shareEmail` computation and its `#166` comment go; so does `shareFullName` on the response, which existed only so the client could re-truncate.

- [ ] **Step 4: Update `student-directory.tsx`**

Replace the `StudentRow` interface (`:11-21`) with:

```ts
interface StudentRow {
  id: string;
  displayName: string;
  email: string | null;
  claimedAt: string | null;
  lastClassDate: string | null;
  classCount: number;
  overduePayments: number;
}
```

Replace the name cell at `:114` with `{student.displayName}` and delete the now-unused `formatStudentName` import at `:8`. Leave `:116` (`{student.email && …}`) alone — it already handles a falsy email.

- [ ] **Step 5: Update `add-walk-in.tsx`**

Replace the `RosterStudent` interface (`:10-14`) with:

```ts
interface RosterStudent {
  id: string;
  displayName: string;
}
```

Replace the option label at `:101` — currently `{s.firstName} {s.lastName}` — with `{s.displayName}`.

- [ ] **Step 6: Run everything to verify it passes**

Run: `npx vitest run --project components src/components/students/student-directory.test.tsx`
Expected: PASS, 2 tests.

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`
Expected: PASS. If a list test asserted `firstName`/`lastName`/`shareFullName`, update it to `displayName` — do not delete it.

Run: `npm run typecheck && npm run lint`
Expected: clean. A leftover `formatStudentName` import will fail lint.

- [ ] **Step 7: Mutation-test the list gate**

Temporarily change the map to spread the raw row: `const result = students.map((s) => ({ ...s, lastClassDate: …, classCount: …, overduePayments: … }));`. Run the integration file.

Expected: FAIL — the response now carries `lastName` and a real `email`. **Record the exact failure.** If nothing fails, the integration suite has no assertion on the list's gating and you must add one before restoring:

```ts
  it('the list withholds a surname and an email the student did not share', async () => {
    const res = await as(dualToken, '/api/students?page=1&pageSize=20');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { students: { displayName: string; email: string | null }[] };
    };
    const row = body.data.students.find((s) => s.displayName.startsWith('Rostered'));
    expect(row).toBeDefined();
    expect(row!.displayName).toBe('Rostered p.');
    expect(row!.email).toBeNull();
  });
```

Add it inside the `describe` that owns `dualToken` and `rosterStudentId`, then restore the route and confirm it passes.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/students/route.ts src/components/students/student-directory.tsx src/components/students/student-directory.test.tsx src/components/class/add-walk-in.tsx tests/integration/students-api.test.ts
git commit -m "refactor: the list route composes the name once, instead of the client re-truncating it (#167)"
```

---

### Task 5: The three payment routes

**Files:**
- Modify: `src/services/payments.ts:186-216` (`getOutstandingPayments`), `:222-246` (`getPaymentsForClass`)
- Modify: `src/app/api/payments/route.ts:15`
- Modify: `src/app/api/classes/[id]/payments/route.ts:25`
- Modify: `src/app/api/payments/[id]/route.ts:21-30`
- Modify: `tests/integration/payments-api.test.ts`

**Interfaces:**
- Consumes: `projectStudentForTeacher`, `studentVisibilitySelect`, `TeacherVisibleStudent` from Task 2; the claimed fixture from Task 1
- Produces:
  - `type TeacherPaymentRow = Payment & { registration: { id: string; status: RegistrationStatus; student: TeacherVisibleStudent; class: { classType: string; date: Date } } }`
  - `getOutstandingPayments(db: PrismaClient, teacherId: string): Promise<TeacherPaymentRow[]>`
  - `getPaymentsForClass(db: PrismaClient, classId: string, teacherId: string): Promise<TeacherPaymentRow[]>` — **note the new third parameter**

**Context the implementer needs:** `src/app/api/payments/[id]/route.ts` is **not** a consumer of `services/payments.ts` — it imports only `@/lib/db` and `@/lib/api-utils` and runs its own inline query. Fixing the service fixes two of the three routes; this one needs its own edit. Issue #167 states otherwise and is wrong.

Both service functions currently declare `Promise<Payment[]>` while returning a structural superset carrying student names and email. The declared type is why a reader cannot see the leak. Fixing it is part of this task, not a bonus.

- [ ] **Step 1: Write the failing integration tests**

Add to `tests/integration/payments-api.test.ts`, inside the describe that owns `teacherToken`, `classId` and `paymentId`. The fixture student is claimed (Task 1), is named `Reminder Student`, and has no `StudentPrivacy` row — so every flag defaults false and `formatStudentName` yields `Reminder s.`.

This file has no `as()` helper; requests are plain `fetch` with `BASE_URL` and `cookie(token)`, both already imported at `:3`.

```ts
  it('GET /api/payments withholds the email and surname of a student who shared neither', async () => {
    const res = await fetch(`${BASE_URL}/api/payments`, { headers: cookie(teacherToken) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        registration: {
          student: { displayName: string; email: string | null };
          tierAtBooking?: number;
        };
      }[];
    };
    const row = body.data.find((p) => p.registration.student.displayName.startsWith('Reminder'));
    expect(row).toBeDefined();
    expect(row!.registration.student.displayName).toBe('Reminder s.');
    expect(row!.registration.student.email).toBeNull();
    expect(row!.registration.tierAtBooking).toBeUndefined();
  });

  it('GET /api/payments/[id] applies the same gate as the list', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/${paymentId}`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        registration: {
          student: { displayName: string; email: string | null };
          tierAtBooking?: number;
        };
      };
    };
    expect(body.data.registration.student.displayName).toBe('Reminder s.');
    expect(body.data.registration.student.email).toBeNull();
    expect(body.data.registration.tierAtBooking).toBeUndefined();
  });

  it('GET /api/classes/[id]/payments withholds the surname too', async () => {
    const res = await fetch(`${BASE_URL}/api/classes/${classId}/payments`, {
      headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { registration: { student: { displayName: string }; tierAtBooking?: number } }[];
    };
    expect(body.data[0]!.registration.student.displayName).toBe('Reminder s.');
    expect(body.data[0]!.registration.tierAtBooking).toBeUndefined();
  });
```

- [ ] **Step 2: Run to verify all three fail**

Run: `npx vitest run --project integration tests/integration/payments-api.test.ts`
Expected: FAIL ×3 — `displayName` undefined, `email` a real address, `tierAtBooking` present.

- [ ] **Step 3: Rewrite both service functions**

In `src/services/payments.ts`, add to the imports:

```ts
import type { RegistrationStatus } from '@prisma/client';
import {
  projectStudentForTeacher,
  studentVisibilitySelect,
  type TeacherVisibleStudent,
} from '@/lib/student-visibility';
```

Add the honest return type next to `PaymentResult`:

```ts
/**
 * What a teacher-facing payment read returns.
 *
 * Both query functions below used to declare `Promise<Payment[]>` while
 * returning a structural superset carrying the student's name and email — it
 * type-checked, and the signature is exactly why nobody reading it could see
 * the disclosure. The `registration` shape is explicit for the same reason:
 * an un-`select`ed `include` shipped `tierAtBooking` and `tierRatio`, which are
 * stored copies of the student's income tier.
 */
export type TeacherPaymentRow = Payment & {
  registration: {
    id: string;
    status: RegistrationStatus;
    student: TeacherVisibleStudent;
    class: { classType: string; date: Date };
  };
};
```

Replace `getOutstandingPayments`'s body:

```ts
export async function getOutstandingPayments(
  db: PrismaClient,
  teacherId: string,
): Promise<TeacherPaymentRow[]> {
  const rows = await db.payment.findMany({
    where: {
      status: { in: ['pending', 'overdue'] },
      registration: { class: { teacherId } },
    },
    include: {
      registration: {
        select: {
          id: true,
          status: true,
          student: { select: studentVisibilitySelect(teacherId) },
          class: { select: { classType: true, date: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    ...row,
    registration: {
      ...row.registration,
      student: projectStudentForTeacher(row.registration.student),
    },
  }));
}
```

Replace `getPaymentsForClass`, which gains `teacherId` — it has no other way to know whose privacy row to read:

```ts
export async function getPaymentsForClass(
  db: PrismaClient,
  classId: string,
  teacherId: string,
): Promise<TeacherPaymentRow[]> {
  const rows = await db.payment.findMany({
    where: { registration: { classId } },
    include: {
      registration: {
        select: {
          id: true,
          status: true,
          student: { select: studentVisibilitySelect(teacherId) },
          class: { select: { classType: true, date: true } },
        },
      },
    },
  });

  return rows.map((row) => ({
    ...row,
    registration: {
      ...row.registration,
      student: projectStudentForTeacher(row.registration.student),
    },
  }));
}
```

Update both docblocks: they say "Includes registration with student name/email" and "with student name", which is no longer what happens.

- [ ] **Step 4: Update the two service consumers**

`src/app/api/classes/[id]/payments/route.ts:25` — pass the teacher through:

```ts
  const payments = await getPaymentsForClass(prisma, id, session.teacherId);
```

`src/app/api/payments/route.ts` needs no change; `getOutstandingPayments` already takes `session.teacherId`.

- [ ] **Step 5: Rewrite the third payment route's own query**

In `src/app/api/payments/[id]/route.ts`, add:

```ts
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';
```

Replace the query at `:21-30` and the response. The ownership check at `:35` reads `payment.registration.class.teacherId`, so `teacherId` must stay selected:

```ts
  const payment = await prisma.payment.findUnique({
    where: { id },
    include: {
      registration: {
        select: {
          id: true,
          status: true,
          student: { select: studentVisibilitySelect(session.teacherId) },
          class: { select: { teacherId: true, classType: true, date: true } },
        },
      },
    },
  });

  if (!payment) return respondError('Payment not found', 404);

  if (payment.registration.class.teacherId !== session.teacherId) {
```

Then, at the existing `respondOk`, project the student:

```ts
  return respondOk({
    ...payment,
    registration: {
      ...payment.registration,
      student: projectStudentForTeacher(payment.registration.student),
    },
  });
```

Read the rest of the handler before editing — if the response currently returns something other than the bare `payment`, preserve that shape and only swap the student.

- [ ] **Step 6: Run to verify they pass**

Run: `npx vitest run --project integration tests/integration/payments-api.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean. If `(teacher)/settings/payments/page.tsx` calls `getPaymentsForClass`, the new parameter will fail here — it does not today (it queries Prisma directly), but check the error rather than assuming.

- [ ] **Step 7: Mutation-test each of the three gates separately**

The three routes are three independent code paths; one mutation cannot prove all three.

1. In `getOutstandingPayments`, return `rows` un-projected. Run the file. Expected: the `GET /api/payments` test fails; the other two still pass. Restore.
2. In `getPaymentsForClass`, return `rows` un-projected. Expected: only the `classes/[id]/payments` test fails. Restore.
3. In `payments/[id]/route.ts`, return the bare `payment`. Expected: only the `payments/[id]` test fails. Restore.

**Record all three results.** If mutation 1 or 2 fails the wrong test, the two functions are not as independent as assumed — stop and report.

- [ ] **Step 8: Commit**

```bash
git add src/services/payments.ts src/app/api/payments/route.ts 'src/app/api/payments/[id]/route.ts' 'src/app/api/classes/[id]/payments/route.ts' tests/integration/payments-api.test.ts
git commit -m "fix: three payment routes returned raw names, emails and stored income tiers (#167)"
```

---

### Task 6: The two registration read routes

**Files:**
- Modify: `src/app/api/classes/[id]/registrations/route.ts:24-34`
- Modify: `src/app/api/registrations/[id]/route.ts:25-41` (`GET`)
- Modify: `tests/integration/registrations-api.test.ts`

**Interfaces:**
- Consumes: `projectStudentForTeacher`, `studentVisibilitySelect` from Task 2
- Produces: both routes return registrations whose `student` is a `TeacherVisibleStudent`, with `tierAtBooking`, `tierRatio` and `price` absent from the teacher-facing shape

**Context the implementer needs — this is the one place the branch is load-bearing.** `GET /api/registrations/[id]` uses `requireSession` (`:20`), not `requireTeacher`, and authorizes at `:36-39` as *either* the student themselves *or* the class teacher. A student reading their own registration must keep getting their own data untouched: they are not a teacher, and their own tier and price are theirs to see. Gate the teacher path only. Issue #167 describes this route as a teacher surface; it is shared.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` to `tests/integration/registrations-api.test.ts`. The file already provides everything needed: `BASE_URL`, `cookie`, `ownerToken`, `studentTokens[]`, `studentIds[]`, the `post(token, body)` helper and `makeClass(n)`.

**Use `studentIds[0]`, never `unlinkedStudentId`.** The fixture at `:151-158` is deliberately *unclaimed* — no `claimedAt`, no account — so a privacy assertion built on it takes the `isUnclaimed ||` bypass and passes against the bug. This is the same trap Task 1 fixed in the payments suite; here the trap is a second fixture sitting beside the right one. `studentIds[0]` is `RegStudent0 Test`, claimed at `:136-149`, with no `StudentPrivacy` row — so `formatStudentName` yields `RegStudent0 t.`.

```ts
describe('teacher-facing registration reads honour StudentPrivacy', () => {
  it('the class roster withholds a surname the student did not share', async () => {
    const classId = await makeClass(5);
    await post(studentTokens[0]!, { classId });

    const res = await fetch(`${BASE_URL}/api/classes/${classId}/registrations`, {
      headers: cookie(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { student: { displayName: string }; tierAtBooking?: number; tierRatio?: string }[];
    };
    expect(body.data[0]!.student.displayName).toBe('RegStudent0 t.');
    expect(body.data[0]!.tierAtBooking).toBeUndefined();
    expect(body.data[0]!.tierRatio).toBeUndefined();
  });

  it('a teacher reading one registration gets the gated student', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      headers: cookie(ownerToken),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { student: { displayName: string }; tierAtBooking?: number };
    };
    expect(body.data.student.displayName).toBe('RegStudent0 t.');
    expect(body.data.tierAtBooking).toBeUndefined();
  });

  it('a student reading their OWN registration is not gated', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      headers: cookie(studentTokens[0]!),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { tierAtBooking: number } };
    // Their own tier is theirs to see — the gate is a teacher boundary, not a
    // blanket filter. This test is what stops the fix over-reaching.
    expect(body.data.tierAtBooking).toBeDefined();
  });
});
```

Every class created by `makeClass` must be cleaned up; check whether it already pushes to the module-level `classIds` array the `afterAll` drains, and if not, push each new `classId` yourself.

- [ ] **Step 2: Run to verify the first two fail and the third passes**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: the two teacher tests FAIL; the student self-read test PASSES already. A third test that fails now means the fixture or token wiring is wrong — fix that before continuing.

- [ ] **Step 3: Gate the class roster route**

`src/app/api/classes/[id]/registrations/route.ts` is `requireTeacher` (`:15`), so no branch is needed. Add the import and replace `:24-34`:

```ts
import { projectStudentForTeacher, studentVisibilitySelect } from '@/lib/student-visibility';
```

```ts
  const registrations = await prisma.registration.findMany({
    where: { classId: id },
    select: {
      id: true,
      classId: true,
      studentId: true,
      status: true,
      isWalkIn: true,
      registeredAt: true,
      cancelledAt: true,
      updatedAt: true,
      student: { select: studentVisibilitySelect(session.teacherId) },
    },
    orderBy: { registeredAt: 'asc' },
  });

  return respondOk(
    registrations.map((r) => ({ ...r, student: projectStudentForTeacher(r.student) })),
  );
```

`Registration` has exactly eleven columns (`prisma/schema.prisma:484-495`): `id`, `classId`, `studentId`, `status`, `isWalkIn`, `tierAtBooking`, `price`, `tierRatio`, `registeredAt`, `cancelledAt`, `updatedAt`. The select above names the eight that stay; the three omitted — `tierAtBooking`, `price`, `tierRatio` — are the ones this task exists to drop. Do not re-add them.

- [ ] **Step 4: Branch the shared route**

In `src/app/api/registrations/[id]/route.ts`, add the same import. The current handler loads once and responds once; it now needs the authorization decision *before* deciding what to return. Replace `:25-41`:

```ts
  const registration = await prisma.registration.findUnique({
    where: { id },
    include: {
      class: { select: { teacherId: true, classType: true, date: true } },
    },
  });

  if (!registration) return respondError('Registration not found', 404);

  const isStudent = registration.studentId === session.studentId;
  const isTeacher = registration.class.teacherId === session.teacherId;

  if (!isStudent && !isTeacher) return respondError('Access denied', 403);

  // The student's own read is not a disclosure boundary — their tier and price
  // are theirs. Only the teacher's view is projected (#167).
  if (isStudent) return respondOk(registration);

  const student = await prisma.student.findUniqueOrThrow({
    where: { id: registration.studentId },
    select: studentVisibilitySelect(session.teacherId!),
  });

  return respondOk({
    id: registration.id,
    classId: registration.classId,
    studentId: registration.studentId,
    status: registration.status,
    registeredAt: registration.registeredAt,
    cancelledAt: registration.cancelledAt,
    isWalkIn: registration.isWalkIn,
    class: registration.class,
    student: projectStudentForTeacher(student),
  });
```

`session.teacherId!` is safe only because `isTeacher` is true on this line — if that ordering changes, the assertion is wrong. Prefer restructuring to keep `teacherId` narrowed if TypeScript allows it without the `!`; a non-null assertion that depends on a distant branch is exactly the thing that rots.

Note the student `include` is gone from the initial load: the student path no longer needs it (it never rendered a name), and the teacher path loads through the fragment.

- [ ] **Step 5: Run to verify all three pass**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: PASS.

Run: `npm run typecheck`
Expected: clean.

- [ ] **Step 6: Mutation-test both gates and the branch**

1. In the roster route, return `registrations` un-projected. Expected: the roster test fails. Restore.
2. In the shared route, delete `if (isStudent) return respondOk(registration);` so students fall through to the projected shape. Expected: the **student self-read** test fails on `tierAtBooking` being undefined. **This is the important one** — it proves the test detects over-reach, not just under-reach. Restore.
3. In the shared route, return the projected shape's `student` as the raw `student` object. Expected: the teacher test fails. Restore.

**Record all three.**

- [ ] **Step 7: Commit**

```bash
git add 'src/app/api/classes/[id]/registrations/route.ts' 'src/app/api/registrations/[id]/route.ts' tests/integration/registrations-api.test.ts
git commit -m "fix: two registration reads exposed rosters ungated, and one of them is shared with students (#167)"
```

---

### Task 7: Narrow the three registration write responses

**Files:**
- Modify: `src/app/api/registrations/[id]/route.ts` (the `PUT` response and both `DELETE` responses)
- Modify: `src/app/api/registrations/route.ts` (the `POST` response)
- Modify: `tests/integration/registrations-api.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `PUT`, `DELETE` and `POST` all respond `{ id, status }`

**Context the implementer needs:** every *client* consumer of these three handlers reads only `res.ok` — `attendance-list.tsx:38`, `cancel-booking-button.tsx:31`, `booking-flow.tsx:83`, `add-walk-in.tsx:69`. Each reads the body only on the error path via `readErrorMessage`. So this is a zero-UI-change edit.

**But `status` must stay on all three responses.** `tests/integration/registrations-api.test.ts:319-321` reads the POST body and asserts `rebookJson.data.status === 'registered'` — it is the evidence that re-booking a cancelled class reactivates the same row rather than creating a second one, which is a real invariant worth keeping. Narrowing POST to `{ id }` would break it, and "the test was in the way" is not a reason to weaken a test. `status` is not sensitive; `tierAtBooking`, `price` and `tierRatio` are what leave.

`DELETE` has **two** `respondOk(updated)` sites: the late-cancel branch (`:139`) and the full-cancel branch (`:151`). Both must be narrowed; fixing one and leaving the other is the shape of defect this project keeps finding.

- [ ] **Step 1: Write the failing tests**

```ts
describe('registration writes return no stored income tier', () => {
  it('POST returns the id and status, and nothing else', async () => {
    const classId = await makeClass(5);
    const res = await post(studentTokens[0]!, { classId });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['id', 'status']);
  });

  it('PUT returns the id and status, and nothing else', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(ownerToken) },
      body: JSON.stringify({ status: 'attended' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['id', 'status']);
  });

  it('DELETE before the deadline returns the id and status, and nothing else', async () => {
    const classId = await makeClass(5);
    const created = await post(studentTokens[0]!, { classId });
    const { data } = (await created.json()) as { data: { id: string } };

    const res = await fetch(`${BASE_URL}/api/registrations/${data.id}`, {
      method: 'DELETE',
      headers: cookie(studentTokens[0]!),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown> };
    expect(Object.keys(body.data).sort()).toEqual(['id', 'status']);
    expect(body.data.status).toBe('cancelled');
  });
});
```

`makeClass` builds classes in 2099 (see the comment at `:276`), so the three tests above all take the **before-deadline** branch. The late-cancel branch at `:133-141` needs a class starting within `DEADLINE_HOURS`. Add a fourth test for it: build a class the same way `makeClass` does but with a `date`/`startTime` a few hours out, register a student, `DELETE`, and assert the same two keys plus `status === 'late_cancel'`. Read `makeClass` and copy its shape — a class needs a `teacherRoomId`, `minRate`, `targetRate`, `minStudents` and `maxStudents`, and its id must land in `classIds` for teardown.

**Both `DELETE` branches must be covered.** Fixing one `respondOk` and leaving the other is precisely the defect shape this project keeps finding — `dbe1bb9` and `fad7231` in #166 were both "the third button still failed silently".

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: FAIL — the key arrays contain the full `Registration` column set.

- [ ] **Step 3: Narrow the four response sites**

`PUT` — replace `return respondOk(updated);` with:

```ts
  return respondOk({ id: updated.id, status: updated.status });
```

`DELETE`, **both** branches — the same, at each `respondOk(updated)`.

`POST` in `src/app/api/registrations/route.ts` — find the `respondOk` that returns the activated registration and replace the payload with `{ id: reg.id, status: reg.status }`, matching the local variable's actual name. Leave the 201 status code as it is. **Keep `status`** — `tests/integration/registrations-api.test.ts:319-321` asserts on it.

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run --project integration tests/integration/registrations-api.test.ts`
Expected: PASS.

Run: `npx vitest run --project integration tests/integration/waitlist-api.test.ts tests/integration/full-flow.test.ts`
Expected: PASS. These exercise booking and promotion end to end and are the most likely place an assertion read a field that just left a response body.

- [ ] **Step 5: Mutation-test each narrowing**

Restore each of the four `respondOk` sites to the full object one at a time, run the file, confirm exactly the corresponding test fails, restore. **Record all four.** Both `DELETE` branches must be shown independently — that is the point of testing them separately.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/api/registrations/[id]/route.ts' src/app/api/registrations/route.ts tests/integration/registrations-api.test.ts
git commit -m "fix: three registration writes echoed the student's stored income tier back to the teacher (#167)"
```

---

### Task 8: The three teacher pages adopt the shared name

**Files:**
- Modify: `src/app/(teacher)/students/[id]/page.tsx:18-55`
- Modify: `src/app/(teacher)/class/[id]/page.tsx:38-69`
- Modify: `src/app/(teacher)/settings/payments/page.tsx:19-59`

**Interfaces:**
- Consumes: `teacherVisibleName`, `projectStudentForTeacher`, `studentNameSelect`, `studentVisibilitySelect` from Task 2
- Produces: no API contract change — these are server components

**Context the implementer needs:** these three pages have **no test coverage at any level** (this is what open issue #143 tracks). Two of them also over-fetch: `students/[id]/page.tsx:18-37` and `class/[id]/page.tsx:38-51` use `include` on `student`, which loads every `Student` column including `incomeTier`, `phone`, `birthday` and `address`. That is over-fetch, not a browser-visible leak — `ClassInfo`, `PricingPreview` and `PricingBreakdown` are all server components, and the client components receive only narrow projected item types. Narrowing to `select` is still correct and is part of this task.

Because there is no automated coverage, this task is verified by running the app. Do **not** start or restart the dev server — the user runs it on :3000. Use the `verify` skill's recipe to drive the running app.

- [ ] **Step 1: `class/[id]/page.tsx` — replace the local name function**

Replace the nested student `include` at `:40-47` with `student: { select: studentNameSelect(session.teacherId) }`, and delete the local `getStudentDisplayName` at `:61-69` along with its `#166` comment. Point its two call sites (`:84` and `:92`, plus the roster link at `:157`) at `teacherVisibleName(r.student)`.

`PricingPreview` and `PricingBreakdown` take `cls`, and `PricingPreview`'s prop type is `Registration & { student: Student }` (`pricing-preview.tsx:6`). Narrowing the query breaks that type. Change `RegistrationWithStudent` in `pricing-preview.tsx` to require only what the component reads — it uses `r.tierAtBooking`, `r.status` and `r.price`, not any student field — so `type RegistrationWithStudent = Registration` may be enough. Read the component before changing its props and make the type match what it actually consumes.

- [ ] **Step 2: `settings/payments/page.tsx` — replace the local name function**

Replace the student `select` at `:23-32` with `student: { select: studentNameSelect(session.teacherId) }` and replace the body of `studentName` at `:47-59` with `return teacherVisibleName(p.registration.student);`, deleting the `#166` comment. Keep `studentId: true` on the registration select — the payment rows link to the student page.

- [ ] **Step 3: `students/[id]/page.tsx` — adopt the full projection**

This page renders all five gated fields, so it takes `projectStudentForTeacher`. Replace the `include` at `:20-36` with a `select` that spreads `studentVisibilitySelect(session.teacherId)` and keeps the two relation sub-selects (`teacherStudents`, `registrations`) exactly as they are. Then replace `:46-55` with:

```ts
  const isArchived = student.teacherStudents[0]?.isArchived ?? false;
  const visible = projectStudentForTeacher(student);
```

Point `displayName` at `visible.displayName`, and change each of the four conditionals at `:81`, `:87`, `:93`, `:107` from `showX && student.x &&` to `visible.x &&` — the projection already nulls a withheld field, so the separate boolean is redundant.

`isUnlinked` at `:46` is still used by the "hasn't created an account yet" notice at `:61-65`. Keep it, but source it from `visible.claimedAt` and delete the `#166` comment above it — that comment explains the privacy bypass, which now lives in `student-visibility.ts`, and leaving a copy here recreates the duplication this task removes.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run lint`
Expected: clean.

Run: `npm run build`
Expected: success. Server components are only fully typechecked at build; a broken prop type on `PricingPreview` surfaces here.

- [ ] **Step 5: Verify in the running app**

Using the `verify` skill's recipe against the already-running server on :3000, sign in as a seeded teacher and check three pages:

1. `/students/<id>` for a claimed student with default privacy — name shows as "First l.", and no email, phone, birthday or address rows render.
2. `/class/<id>` for a class with registrations — roster and attendance names show as "First l.".
3. `/settings/payments` — payment rows show "First l.".

Then set `shareFullName: true` for that student/teacher pair (via the student's own `/account/privacy` page, or a direct DB update) and confirm all three pages switch to the full name. **A check that only ever sees the redacted state proves nothing** — both directions must be observed.

- [ ] **Step 6: Commit**

```bash
git add 'src/app/(teacher)/students/[id]/page.tsx' 'src/app/(teacher)/class/[id]/page.tsx' 'src/app/(teacher)/settings/payments/page.tsx' src/components/class/pricing-preview.tsx
git commit -m "refactor: the three teacher pages share the projection instead of each carrying a copy (#167)"
```

Record in the commit body which pages were checked in the running app and that both share states were observed.

---

### Task 9: Prove the rule has one implementation, and correct the data model doc

**Files:**
- Modify: `docs/data-model.md:66-82`
- Possibly modify: any file the greps below reveal

**Interfaces:**
- Consumes: everything from Tasks 2-8
- Produces: evidence for the PR body

- [ ] **Step 1: Prove the duplication is gone**

Run each and record the output verbatim for the PR body:

```bash
grep -rn "shareFullName\|shareEmail\|sharePhone\|shareBirthday\|shareAddress" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\." | grep -v "student-visibility.ts"
grep -rn "claimedAt" src/ --include="*.ts" --include="*.tsx" | grep -v "\.test\." | grep -v "student-visibility.ts"
grep -rn "Do NOT treat this branch as a live privacy rule\|Filed as a leaf" src/ | grep -v "\.test\."
grep -rln "retired the unclaimed student" src/ | grep -v "\.test\."
```

Expected: the first returns only `api/students/[id]/privacy/route.ts` (the CRUD for the flags), `api/announcements/route.ts` (`receiveComms`), `services/gdpr.ts`, `services/invitations.ts` and the student-facing privacy UI. **No teacher-facing read site should appear.** The third returns **nothing** — both of those sentences are gone, the second because it was false. The fourth returns exactly **one** file, `src/lib/student-visibility.ts`: the bypass explanation still exists, once, and now claims only things that are true.

If a teacher-facing read site still appears, it is a site this plan missed. Fix it the same way and say so; do not adjust the expectation.

- [ ] **Step 2: Correct `docs/data-model.md`**

The `StudentPrivacy` table at `:66-80` lists five flags and **omits `share_full_name`**, which exists in `prisma/schema.prisma:192`. Add it as the first flag row:

```
| share_full_name | boolean, default false | Surname; when false a teacher sees a last initial |
```

Then replace the note at `:82`. It currently says "Created on first booking with a teacher" — that is not what happens. Only two sites write the row: `api/students/[id]/privacy/route.ts:112` (the student's own `PUT`) and `services/invitations.ts:673`, inside `unlinkTeacher` — a student *severing* a teacher link, not accepting one; that write force-sets every flag (including `receive_comms`) to `false` rather than being an opt-in. Absence of a row means maximum privacy, which every read site relies on:

```
Not created on booking. Two sites write it: the student's own
`PUT /api/students/[id]/privacy` — where the student opts in to each field —
and `DELETE /api/teacher-links/[teacherId]` (`unlinkTeacher`), which force-sets
every flag, including `receive_comms`, to `false` when a student severs a
teacher link. The second write is not an opt-in; it is the system silencing
every share on the student's behalf because deleting the link alone does not
stop the teacher reaching them. Until one of those two sites has run there is
no row, and every read treats absence as maximum privacy
(`privacy?.shareX ?? false`). One projection reads these flags for every
teacher-facing surface: `src/lib/student-visibility.ts`.
```

- [ ] **Step 3: Run the full affected suite set**

Run each by explicit path — never the whole integration project:

```bash
npx vitest run --project unit
npx vitest run --project components
npx vitest run --project integration tests/integration/payments-api.test.ts
npx vitest run --project integration tests/integration/registrations-api.test.ts
npx vitest run --project integration tests/integration/students-api.test.ts
npx vitest run --project integration tests/integration/privacy-api.test.ts
npx vitest run --project integration tests/integration/waitlist-api.test.ts
npx vitest run --project integration tests/integration/full-flow.test.ts
npm run typecheck && npm run lint && npm run build
```

Record the pass counts per suite. These are the numbers that go in the PR body, and they must be the observed ones, not the expected ones.

- [ ] **Step 4: Commit**

```bash
git add docs/data-model.md
git commit -m "docs: the StudentPrivacy table was missing shareFullName and described a write that does not happen (#167)"
```

---

## Notes for the PR body

Record, with the arithmetic:

- **56** route files; **8** exposed a student field to a teacher across **10** handlers; **8** handlers were ungated (56 − 8 files = 48 carrying none).
- The gating rule had **5** implementations before this branch and has **1** after. The `isUnclaimed` bypass had **5** call sites and **1** after.
- Which of the issue's claims **held** (the two `payments.ts` select shapes, the registration route shapes, the absence of a `shareIncomeTier` column, the fixture-trap warning) and which were **wrong** (`payments/[id]` is not a service consumer; the rule had 5 implementations not 2; the "Adjacent" teacher `PUT` branch no longer exists; `POST /api/registrations` was missing from the list; two registration handlers are shared not teacher-only; the tier ships as a raw value rather than being derivable).
- **What this does not do:** it does not hide the tier of a student who takes classes. `/class/[id]` renders "Tier 4 · €15.20" and "Anna B. — €15.20" in adjacent sections, and no flag could change that.
- The **exact mutation results** recorded in Tasks 2, 3, 4, 5, 6 and 7 — every guard was broken and observed failing before being restored.
- Which suites ran, **by path**. The `integration` project is never run whole.
