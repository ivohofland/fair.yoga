# Acceptance-Gated Teacher/Student Linking (#166) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can no longer create a link to a student unilaterally — links come only from the student accepting an invitation or from the student booking/waitlisting a class — and the account-enumeration oracle on `POST /api/students` closes as a consequence.

**Architecture:** A new `Invitation` table holds the teacher's CRM contact and its pending/accepted/declined state. `TeacherStudent` is untouched and keeps meaning "an accepted link", so none of the nine surviving sites that read a link changes. `POST /api/students` stops touching `Student` entirely and writes an `Invitation` instead, which is what makes its response identical for an address that is on the platform and one that is not. Two route branches that only ever served unclaimed students — the teacher branch of `PUT /api/students/[id]` and the whole `DELETE /api/students/[id]` — are deleted rather than ported.

**Tech Stack:** Next.js 14 App Router · TypeScript strict · Prisma/PostgreSQL · Zod · Vitest (unit/components/integration) · Playwright (e2e) · Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-08-04-student-link-acceptance-design.md`

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types. Non-negotiable.
- **Never run `npx vitest run --project integration` without a file path.** One file in that project is IP rate-limited and a whole-project run trips it. Always name files explicitly.
- **Never start or restart the dev server on :3000.** The user runs it; integration tests need it live. If it must be restarted, ask.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing parentheses: `'src/app/(teacher)/...'`.
- **Never edit an applied migration.** New schema change = `npx prisma migrate dev --name <snake_case_intent>`.
- **`@/lib/log` is pino and server-only.** Do not import it into any module a `'use client'` component value-imports.
- **API shape:** `respondOk(data, status)` → `{ data }`; `respondError(message, status, code?)` → `{ error: { message, code } }`. Both from `@/lib/api-utils`.
- **Session shape:** `requireTeacher(request)` returns `TeacherSession` (`{ sessionId, accountId, teacherId, defaultTimezone, studentId: string | null }`) **or** a `NextResponse` — always narrow with `isErrorResponse` first. `requireStudent` returns `StudentSession` (`studentId: string`).
- **Test idiom:** `import { BASE_URL, cookie, seedSession, uniqueSuffix } from '../helpers'`. Fixtures are always self-built under a `uniqueSuffix()`; never rely on seed data.
- **Design system:** teal `#1A5653` primary, cream page bg, sand-soft surfaces, radius 16, 1px borders, **no shadows** outside sheets/modals, no transitions. Type styles only: `type-display/title/subtitle/body/label/caption/number`. Words before icons.
- **A red integration run strands rows in the shared dev database.** Learned in Task 3: a suite that dies mid-file skips its `afterAll`, leaving `Student`/`Account`/`Invitation` rows behind. Sweep `@test.local` rows after any red run. It does **not** cause a next-run collision — `uniqueSuffix()` is `Date.now()` plus random bytes (`tests/helpers.ts:64-66`), so fixtures never clash across runs. Task 3's report claimed otherwise and its reviewer caught it; the debris is real, that mechanism was not.
- **Create fixtures inside the `try`, not before it.** `students-api.test.ts` states this convention in its own comments and it is the reason the rule above matters less than it could — a test that creates rows outside `try`/`finally` strands them on every failure, which hurts most in the tests you care about most.
- **A throwing `finally` masks the assertion that actually failed.** Also Task 3: a test whose teardown deletes a row the change no longer creates reports the teardown error, not the defect. When a test fails somewhere surprising, read its cleanup block before believing the message.
- **Commit per task.** Conventional-commit subject, body explaining *why*.

## Task Dependency Order

Order is load-bearing in three places, stated here so nothing is reshuffled casually:

- **Task 3 must precede Task 10.** Task 10 retires the unclaimed `Student` row; that is only true once `POST /api/students` (Task 3) has stopped creating them.
- **Task 4 must precede Task 9.** Task 9 repoints `remove-student-button.tsx` at `DELETE /api/invitations/[id]`, which Task 4 creates.
- **Task 9 must precede Task 10.** Task 10 deletes the old teacher `PUT`/`DELETE`; the UI must already point somewhere else, or the branch has a broken CRM in between.

Task 1 depends on nothing and can land first on its own.

---

## File Structure

**Created**
- `prisma/migrations/<ts>_add_invitation/migration.sql` — the table, generated.
- `src/app/api/invitations/route.ts` — `GET` teacher's contacts.
- `src/app/api/invitations/[id]/route.ts` — `PUT` edit, `DELETE` remove, `PATCH` archive.
- `src/app/api/invitations/[id]/respond/route.ts` — `POST` student accept/decline.
- `src/app/api/teacher-links/[teacherId]/route.ts` — `DELETE` student unlink.
- `src/services/invitations.ts` — all invitation business logic, framework-agnostic.
- `src/components/students/contact-form.tsx` — create/edit a contact.
- `src/components/students/contact-list.tsx` — the CRM "Contacts" section.
- `src/components/student/pending-invitation-card.tsx` — accept/decline.
- `src/app/(teacher)/students/contacts/[id]/page.tsx` — contact detail.
- `tests/integration/invitations-api.test.ts` — the whole new surface.

**Modified**
- `prisma/schema.prisma`, `prisma/seed.ts`
- `src/lib/schemas.ts`, `src/lib/schemas.test.ts`, `src/lib/email-templates.ts`, `src/lib/email.ts`
- `src/app/api/students/route.ts`, `src/app/api/students/[id]/route.ts`
- `src/app/api/registrations/route.ts`, `src/services/waitlist.ts`
- `src/app/(student)/account/privacy/page.tsx`, `src/app/(teacher)/students/page.tsx`, `src/app/(teacher)/students/[id]/page.tsx`
- `src/components/students/{create-student-form,edit-student-form,remove-student-button,student-directory}.tsx`
- `tests/integration/{students-api,tier-selected-at,waitlist-api}.test.ts`

**Deleted**
- The teacher branch of `PUT /api/students/[id]` (lines 107-164) and the whole `DELETE` export (lines 169-210).

---

### Task 1: Waitlist promotion and claim create the roster link

> **Amended after the PR review.** The project owner ruled that joining the
> waitlist is itself the consenting act — "registering for the waiting list
> already establishes the connection" — so the link is created in
> `addToWaitlist`, not here. The upserts this task adds stayed, but as an
> idempotent backstop for `waiting` rows the join never touched, not as the
> mechanism. See the design doc's "The two ways a link comes into existence".

The one part of this branch that fixes a bug live today, and it needs no schema. A student promoted off a waitlist has a `Registration` and no `TeacherStudent` row, so they are invisible in the CRM and — the sharp part — receive the teacher's announcements while being locked out of the `StudentPrivacy` row that would mute them.

**Files:**
- Modify: `src/services/waitlist.ts` (around `:344` in `promoteNext`, `:443` in `claimSpot`)
- Test: `tests/integration/waitlist-api.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing new. Both call sites gain the same `tx.teacherStudent.upsert` that `src/app/api/registrations/route.ts:201` already performs.

- [ ] **Step 1: Write the failing tests**

Add to `tests/integration/waitlist-api.test.ts`. Match the file's existing fixture names — read its `beforeAll` first and reuse its teacher/class/student ids rather than inventing new ones.

```ts
describe('waitlist promotion joins the teacher roster (#166)', () => {
  it('creates the TeacherStudent link when a waiting student is promoted', async () => {
    // Arrange: student on the waitlist, no roster link.
    await prisma.teacherStudent.deleteMany({
      where: { teacherId, studentId: waitlistStudentId },
    });

    await promoteNext(prisma, fullClassId);

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: waitlistStudentId } },
    });
    expect(link).not.toBeNull();
  });

  it('creates the link when a student claims an open spot', async () => {
    await prisma.teacherStudent.deleteMany({
      where: { teacherId, studentId: claimStudentId },
    });

    const res = await fetch(`${BASE_URL}/api/waitlist/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(claimStudentToken) },
      body: JSON.stringify({ classId: claimClassId }),
    });
    expect(res.status).toBe(201);

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: claimStudentId } },
    });
    expect(link).not.toBeNull();
  });

  it('lets a promoted student set per-teacher privacy', async () => {
    // The consequence that makes this a bug and not a tidiness issue:
    // announcements reach them, and the opt-out needs this row.
    const res = await fetch(`${BASE_URL}/api/students/${waitlistStudentId}/privacy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...cookie(waitlistStudentToken) },
      body: JSON.stringify({
        teacherId,
        shareFullName: false, shareEmail: false, sharePhone: false,
        shareBirthday: false, shareAddress: false, receiveComms: false,
      }),
    });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the tests and confirm they fail for the right reason**

Run: `npx vitest run --project integration tests/integration/waitlist-api.test.ts -t "joins the teacher roster"`

Expected: all three FAIL. The first two on `expect(link).not.toBeNull()` receiving `null`; the third with `403` and `error.code === 'TEACHER_NOT_LINKED'`. **If the third passes before the fix, stop** — it means a link already existed and the fixture is not exercising the gap.

- [ ] **Step 3: Add the upsert at both call sites**

In `src/services/waitlist.ts`, immediately after the `activateRegistration` call in `promoteNext` (~`:344`) and again in `claimSpot` (~`:443`):

```ts
    // #166: joining a waitlist is a student-initiated act aimed at one
    // teacher, exactly like booking — so it earns the roster link on the
    // same terms. Without it the student is registered but unmanageable:
    // absent from the CRM, and unable to create the StudentPrivacy row
    // that would mute this teacher's announcements, which reach them
    // through the registration regardless.
    await tx.teacherStudent.upsert({
      where: { teacherId_studentId: { teacherId: cls.teacherId, studentId: <studentId> } },
      update: {},
      create: { teacherId: cls.teacherId, studentId: <studentId> },
    });
```

Use `nextEntry.studentId` in `promoteNext` and `studentId` in `claimSpot`. Both already have `cls` in scope with `teacherId`; if `promoteNext`'s `cls` selection does not include `teacherId`, widen that `select` rather than issuing a second query.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run --project integration tests/integration/waitlist-api.test.ts`
Expected: PASS, whole file, including the pre-existing tests.

- [ ] **Step 5: Prove the guard bites**

Comment out the `promoteNext` upsert, re-run, record the exact failure text in the commit body, restore, re-run green. Repeat for `claimSpot`. A test that passes with the fix reverted is proving nothing.

- [ ] **Step 6: Commit**

```bash
git add src/services/waitlist.ts tests/integration/waitlist-api.test.ts
git commit -m "fix: waitlist promotion and claim never joined the teacher roster (#166)"
```

---

### Task 2: Schema — `Invitation`, its two enums, and the notification type

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_add_invitation/migration.sql` (generated)

**Interfaces:**
- Produces: Prisma model `Invitation`, enums `InvitationStatus` (`pending | accepted | declined`) and `InvitationOrigin` (`teacher_invite | student_block`), and `NotificationType.teacher_invitation`. Every later task consumes these.

- [ ] **Step 1: Add the enums and model**

In `prisma/schema.prisma`, beside the other enums (they live at `:14-95`):

```prisma
enum InvitationStatus {
  pending
  accepted
  declined
}

// Who created the row. A link made by booking gives the teacher no access
// to the student's address — shareEmail defaults false — so a tombstone
// written when that student unlinks must never be listed back to the
// teacher, or leaving would disclose more than staying did.
enum InvitationOrigin {
  teacher_invite
  student_block
}
```

Add `teacher_invitation` to `enum NotificationType` (`:85-95`), keeping alphabetical-by-intent grouping consistent with its neighbours.

Then the model, in the PEOPLE section next to `TeacherStudent`:

```prisma
// A teacher's CRM contact and its consent state. Deliberately NOT a
// Student row: POST /api/students must behave identically whether or not
// the address is already on the platform, and it cannot, if it writes to
// a table with a unique email column.
model Invitation {
  id          String           @id @default(uuid())
  teacherId   String
  email       String
  firstName   String           @default("")
  lastName    String           @default("")
  status      InvitationStatus @default(pending)
  origin      InvitationOrigin @default(teacher_invite)
  isArchived  Boolean          @default(false)
  createdAt   DateTime         @default(now())
  respondedAt DateTime?

  teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)

  @@unique([teacherId, email])
  @@index([email])
}
```

Add the back-relation `invitations Invitation[]` to `model Teacher`.

The `@@index([email])` is load-bearing: the student-side surface looks invitations up by the signed-in account's email, which is not the unique key's leading column.

- [ ] **Step 2: Generate the migration**

Run: `npx prisma migrate dev --name add_invitation`
Expected: a new directory under `prisma/migrations/`, `CREATE TYPE`/`CREATE TABLE` statements, and the client regenerated.

- [ ] **Step 3: Verify the constraint exists in the database**

Run: `docker exec fairyoga-db-1 psql -U postgres -d fairyoga -c '\d "Invitation"'`
Expected: the unique index on `(teacherId, email)` and the index on `(email)` both listed.

- [ ] **Step 4: Confirm the build is still green**

Run: `npx tsc --noEmit`
Expected: **one class of error only** — `src/lib/email-templates.ts:46`, because `STUDENT_INTROS` is an exhaustive `Record<NotificationType, string>` and now lacks `teacher_invitation`. That error is the compile-time guard working. Add the entry:

```ts
  teacher_invitation: 'A teacher would like to connect with you.',
```

Re-run `npx tsc --noEmit`; expected clean.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/lib/email-templates.ts
git commit -m "feat: add the Invitation table, its two enums, and teacher_invitation (#166)"
```

---

### Task 3: `POST /api/students` creates an invitation, not a student

The heart of the change. This is where the oracle closes.

**Files:**
- Modify: `src/app/api/students/route.ts:105-186`, `src/lib/schemas.ts`, `src/components/students/create-student-form.tsx`, `src/components/students/create-student-form.test.tsx`
- Create: `src/services/invitations.ts`
- Test: `tests/integration/students-api.test.ts` (rewrite five tests)

**Interfaces:**
- Consumes: `Invitation`, `InvitationStatus`, `InvitationOrigin` from Task 2.
- Produces:
  - `createInvitationSchema` in `src/lib/schemas.ts` — `{ firstName: string; lastName: string; email: string }`, `.strict()`.
  - `src/services/invitations.ts`:
    ```ts
    export type InviteRefusal = 'ALREADY_INVITED' | 'ALREADY_LINKED' | 'DECLINED';
    export interface InviteResult { id: string }
    export async function inviteContact(
      db: PrismaClient,
      input: { teacherId: string; email: string; firstName: string; lastName: string },
    ): Promise<{ ok: true; value: InviteResult } | { ok: false; reason: InviteRefusal }>;
    ```
  - Tasks 4, 5, 6, 7, 8 all import from `src/services/invitations.ts`.

- [ ] **Step 1: Write the failing oracle test**

This is the assertion the whole design exists for. Add to `tests/integration/students-api.test.ts`, replacing the `describe('POST /api/students — response disclosure (#162)')` block's contents where they conflict:

```ts
describe('POST /api/students — the enumeration oracle is closed (#166)', () => {
  it('answers identically for a registered address and a free one', async () => {
    // A real, claimed student belonging to nobody in this test.
    const victimEmail = `victim-${suffix}@test.local`;
    const victim = await prisma.student.create({
      data: {
        firstName: 'Real', lastName: 'Person', email: victimEmail,
        claimedAt: new Date(), account: { create: { email: victimEmail } },
      },
      select: { id: true, accountId: true },
    });
    const freeEmail = `never-seen-${suffix}@test.local`;

    const post = (email: string) =>
      fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'Zzz', lastName: 'Qqq', email }),
      });

    const [taken, free] = await Promise.all([post(victimEmail), post(freeEmail)]);

    // Same status.
    expect(taken.status).toBe(free.status);
    expect(taken.status).toBe(201);

    // Same body shape, and no field that could carry the bit.
    const takenJson = await taken.json();
    const freeJson = await free.json();
    expect(Object.keys(takenJson.data)).toEqual(['id']);
    expect(Object.keys(freeJson.data)).toEqual(Object.keys(takenJson.data));

    // And no side effect that distinguishes them: no link, no Student row
    // for the free address, and the victim's row untouched.
    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: victim.id } },
    });
    expect(link).toBeNull();
    expect(await prisma.student.findUnique({ where: { email: freeEmail } })).toBeNull();
    const after = await prisma.student.findUniqueOrThrow({ where: { id: victim.id } });
    expect(after.firstName).toBe('Real');

    // Both produced an invitation in the same state.
    for (const email of [victimEmail, freeEmail]) {
      const inv = await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email } },
      });
      expect(inv.status).toBe('pending');
      expect(inv.origin).toBe('teacher_invite');
      expect(inv.firstName).toBe('Zzz');
    }

    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.student.delete({ where: { id: victim.id } });
    await prisma.account.delete({ where: { id: victim.accountId! } });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts -t "answers identically"`
Expected: FAIL — today the registered address returns `200` and the free one `201`, so `expect(taken.status).toBe(free.status)` fails with `200 !== 201`. Record that exact text; it is the bug.

- [ ] **Step 3: Add the schema**

In `src/lib/schemas.ts`, replace `createStudentSchema` (`:128-132`) with:

```ts
/**
 * The teacher's CRM contact form. `.strict()`, unlike the create schema it
 * replaces: an unknown key here should be a 400, not silently stripped —
 * this body is the only thing standing between a teacher and a row keyed
 * on someone else's email address.
 */
export const createInvitationSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().optional().default(''),
  email: z.string().email(),
}).strict();
```

It declares none of `SERVER_OWNED_FIELDS`, so it needs no `EXPECTED` entry in `src/lib/schemas.test.ts:352-378`. It is a plain `z.object`, so it satisfies the `.shape` walk at `:412-453`. Confirm both by running that file in Step 6.

- [ ] **Step 4: Write the service**

Create `src/services/invitations.ts`:

```ts
import type { PrismaClient } from '@prisma/client';

export type InviteRefusal = 'ALREADY_INVITED' | 'ALREADY_LINKED' | 'DECLINED';

export interface InviteResult {
  id: string;
}

export const REFUSAL_MESSAGES: Record<InviteRefusal, string> = {
  ALREADY_INVITED: 'You have already invited this person.',
  ALREADY_LINKED: 'This person is already one of your students.',
  DECLINED: 'This person declined your invitation.',
};

/**
 * Create a CRM contact and invite its owner.
 *
 * The security property lives in what this function does NOT branch on.
 * Every refusal below is about a row THIS teacher owns — their own
 * invitation, their own roster link — so answering is not a disclosure.
 * Nothing else is consulted. In particular there is no "does a Student
 * row exist for this address" branch, which is what made the old route an
 * account-enumeration oracle: 200 meant taken, 201 meant free.
 *
 * The Student lookup below is deliberately AFTER the outcome is fixed and
 * feeds only the roster-link check. Do not hoist it, and do not add a
 * branch on `student === null`.
 */
export async function inviteContact(
  db: PrismaClient,
  input: { teacherId: string; email: string; firstName: string; lastName: string },
): Promise<{ ok: true; value: InviteResult } | { ok: false; reason: InviteRefusal }> {
  const { teacherId, email, firstName, lastName } = input;

  const existing = await db.invitation.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: { status: true },
  });
  if (existing) {
    if (existing.status === 'declined') return { ok: false, reason: 'DECLINED' };
    if (existing.status === 'accepted') return { ok: false, reason: 'ALREADY_LINKED' };
    return { ok: false, reason: 'ALREADY_INVITED' };
  }

  // A link with no invitation row: this student booked a class instead of
  // being invited. Their being on this teacher's roster is the teacher's
  // own data, so refusing here discloses nothing new.
  const student = await db.student.findUnique({ where: { email }, select: { id: true } });
  if (student) {
    const link = await db.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: student.id } },
      select: { id: true },
    });
    if (link) return { ok: false, reason: 'ALREADY_LINKED' };
  }

  const created = await db.invitation.create({
    data: { teacherId, email, firstName, lastName },
    select: { id: true },
  });
  return { ok: true, value: { id: created.id } };
}
```

- [ ] **Step 5: Rewrite the route handler**

In `src/app/api/students/route.ts`, replace the whole `POST` export (`:105-186`). Keep the rate limiter exactly where it is — at the top, before `parseBody`, so refusals cost a hit too — but rewrite its comment, which currently describes an oracle that no longer exists:

```ts
export const POST = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // Keyed on the teacher, not the IP: the caller is authenticated, so an IP
  // key would be evadable by rotation and unfair to teachers behind one NAT.
  //
  // What it buys has changed. It is no longer standing in for a missing fix
  // to an enumeration oracle — #166 closed that by construction, since this
  // route no longer branches on whether the address exists. What remains is
  // that a teacher can cause an email to be sent to an arbitrary address, so
  // this is a spam brake. Issue #51 (bulk/CSV import) will exceed it by
  // design; raise the ceiling or exempt that path when it lands.
  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    log.warn({ teacherId: session.teacherId }, 'invitation refused: rate limit exceeded');
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return respondError(
      `Too many invitations. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      429,
    );
  }

  const parsed = await parseBody(request, createInvitationSchema);
  if ('error' in parsed) return parsed.error;

  const result = await inviteContact(prisma, {
    teacherId: session.teacherId,
    ...parsed.data,
  });
  if (!result.ok) {
    return respondError(REFUSAL_MESSAGES[result.reason], 409, result.reason);
  }

  return respondOk({ id: result.value.id }, 201);
});
```

Update the imports: drop `createStudentSchema`, add `createInvitationSchema`, and add `inviteContact`/`REFUSAL_MESSAGES` from `@/services/invitations`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts`
Run: `npx vitest run --project unit src/lib/schemas.test.ts`

Expected: the oracle test PASSES, and pre-existing tests FAIL. **The predicted list was off by one, corrected here after execution:**

- Actually broke: `:146`, `:168`, `:183`, `:726`, and — unpredicted — `:814` `'spends one shared budget across POST and the teacher PUT'`. The POST no longer creates a `Student`, so that test's 49 follow-up PUTs 404'd, and its `finally` block then threw on `student.delete`, **masking the real assertion error behind a cleanup failure**. Watch for that shape: a test whose teardown throws reports the teardown, not the defect.
- Did **not** break: `:763` `'refuses a 51st addition within the hour'`. Repeating one address still produced `[201, 409×49, 429]` — the 409s merely changed code. Rewrite it to 51 distinct addresses anyway; that rewrite is what actually tests the limiter, and the version that passed was passing for the wrong reason.

- [ ] **Step 7: Rewrite those five, and do not delete `:726`**

- `:146` → assert a `pending` `Invitation` row exists and **no** `Student` row and **no** `TeacherStudent` row were created. Rename to `'creates an invitation and no student row'`.
- `:168` → the 409 code is now `ALREADY_INVITED`, not `ALREADY_LINKED`. Rename accordingly.
- `:183` → this test asserted the old "existing student gets linked" path, which is the defect. Replace it with `'does not link an existing student'`: POST a claimed student's email, assert 201 and `teacherStudent.findUnique(...)` is `null`.
- `:726` → **rewrite, never delete.** It is #162's disclosure regression test. Keep the victim fixture and the "teacher knows only the email" framing; change the assertion from "gets `{ id }` of the victim" to "gets an invitation id that is not the victim's student id, and no link exists". Add `expect(json.data.id).not.toBe(victimId)`.
- `:763` → the run of 409s came from duplicate-link semantics. Post 51 **distinct** addresses instead: expect `statuses.slice(0, 50)` all `201` and `statuses[50] === 429`.

Also update the budget-accounting comment at `:135-144`, which counts PUT tests that Task 10 will delete. Leave a note there that Task 10 finishes it rather than writing a number that is about to go stale.

- [ ] **Step 8: Repoint the create form**

`src/components/students/create-student-form.tsx` already reads only `data.id` (`:81-82`) so its fetch handling is unchanged. Two edits: the type-pin import at `:6`/`:27` moves from `createStudentSchema` to `createInvitationSchema`, and the redirect at `:82` becomes `router.push('/students')` — there is no `/students/${id}` page for an invitation until Task 9. Update the docblock at `:19` to name the new schema.

In `create-student-form.test.tsx`, the mock at `:23` (`{ data: { id: 'student-1' } }`) still holds; add an assertion that the push target is `/students` using `routerPush` from `tests/setup/components`.

- [ ] **Step 9: Run everything touched**

```
npx vitest run --project integration tests/integration/students-api.test.ts
npx vitest run --project unit src/lib/schemas.test.ts
npx vitest run --project components src/components/students/create-student-form.test.tsx
npx tsc --noEmit
```
Expected: all green.

- [ ] **Step 10: Prove the guard bites**

Reintroduce the oracle deliberately: in `inviteContact`, add `if (student === null) return { ok: false, reason: 'ALREADY_INVITED' }` after the Student lookup. Re-run the oracle test, record the exact failure text, remove the line, re-run green. A test that cannot detect a reintroduced branch is not protecting the property.

- [ ] **Step 11: Commit**

```bash
git add src/app/api/students/route.ts src/services/invitations.ts src/lib/schemas.ts \
        src/components/students/create-student-form.tsx \
        src/components/students/create-student-form.test.tsx \
        tests/integration/students-api.test.ts
git commit -m "feat: POST /api/students creates an invitation, closing the enumeration oracle (#166)"
```

---

### Task 4: Teacher invitation management API

**Files:**
- Create: `src/app/api/invitations/route.ts`, `src/app/api/invitations/[id]/route.ts`
- Modify: `src/services/invitations.ts`, `src/lib/schemas.ts`
- Test: `tests/integration/invitations-api.test.ts` (new)

**Interfaces:**
- Consumes: `inviteContact`, `REFUSAL_MESSAGES` (Task 3).
- Produces:
  - `updateInvitationSchema` — `{ firstName?: string; lastName?: string; email?: string }`, `.strict()`.
  - `GET /api/invitations` → `{ data: { invitations: Array<{ id, email, firstName, lastName, status, isArchived, createdAt }>, total } }`
  - `PUT /api/invitations/[id]` → `{ data: { id } }`
  - `DELETE /api/invitations/[id]` → `{ data: { id } }`, **409 `DECLINED_IS_PERMANENT` when the row is declined**
  - `PATCH /api/invitations/[id]?state=archived|unarchived` → `{ data: { isArchived, action } }`

- [ ] **Step 1: Write the failing tests**

Create `tests/integration/invitations-api.test.ts`. Follow `students-api.test.ts:1-73` exactly for setup — module-scope `new PrismaClient()`, `uniqueSuffix()`, a `beforeAll` that creates a teacher with a nested account and `pageSlug: \`inv-teacher-${suffix}\``, `seedSession`, and an `afterAll` deleting in FK order: **`invitation` → `session` → `teacher` → `account`**.

**That last step was missing from an earlier draft and the omission shipped**, leaking two `Account` rows per run — 16 orphans after 8 runs before anyone noticed. Deleting a `Teacher` does not take its `Account` with it. The precedent is genuinely mixed: `students-api.test.ts`'s top-level teacher leaks its account too, but its *nested* ownership fixtures (`:508-517`, `:892-914`) clean theirs up. Follow the nested ones.

```ts
describe('GET /api/invitations', () => {
  it('returns this teacher\'s contacts and never another teacher\'s', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.invitations.map((i: { email: string }) => i.email))
      .toEqual([pendingEmail]);
  });

  it('never returns a student_block row', async () => {
    // The tombstone a student writes by unlinking carries an address the
    // teacher may never have had — shareEmail defaults false.
    await prisma.invitation.create({
      data: {
        teacherId, email: blockedEmail, status: 'declined', origin: 'student_block',
      },
    });
    const res = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
    const body = await res.text();
    // Assert on the raw body, not the parsed row count: a future select
    // that leaks the address through some other field still fails here.
    expect(body).not.toContain(blockedEmail);
  });
});

describe('DELETE /api/invitations/[id]', () => {
  it('removes a pending contact', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${pendingId}`, {
      method: 'DELETE', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(200);
    expect(await prisma.invitation.findUnique({ where: { id: pendingId } })).toBeNull();
  });

  it('refuses to delete a declined row, because that row is the tombstone', async () => {
    const declined = await prisma.invitation.create({
      data: { teacherId, email: declinedEmail, status: 'declined', respondedAt: new Date() },
    });
    const res = await fetch(`${BASE_URL}/api/invitations/${declined.id}`, {
      method: 'DELETE', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DECLINED_IS_PERMANENT');
    expect(await prisma.invitation.findUnique({ where: { id: declined.id } })).not.toBeNull();
  });

  it('still refuses a re-invite after the declined row is archived', async () => {
    // The whole point: archiving hides it, it does not disarm it.
    await prisma.invitation.update({
      where: { teacherId_email: { teacherId, email: declinedEmail } },
      data: { isArchived: true },
    });
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Try', lastName: 'Again', email: declinedEmail }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DECLINED');
  });

  it('refuses another teacher\'s invitation', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${otherTeacherInvitationId}`, {
      method: 'DELETE', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(404);
  });
});
```

Write the `PATCH` suite by copying the shape of `students-api.test.ts:578-654` — missing state → 400, unrecognised state → 400, other teacher's row → 404, and the idempotent archive/unarchive pair asserting `action` of `'archived' | 'unarchived' | 'unchanged'`.

**404, not 403, for another teacher's invitation.** A 403 would confirm the id exists. The students routes answer 403 because the caller supplied a student id they may legitimately know; an invitation id is never shared, so absence is the honest answer.

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts`
Expected: FAIL with 404s from Next for the unrouted paths.

- [ ] **Step 3: Add the update schema**

```ts
export const updateInvitationSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().optional(),
  email: z.string().email().optional(),
}).strict();
```

- [ ] **Step 4: Implement `GET /api/invitations`**

Create `src/app/api/invitations/route.ts`:

```ts
export const GET = withErrorHandler(async (request: NextRequest) => {
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const archived = request.nextUrl.searchParams.get('archived') === 'true';

  // `origin: 'teacher_invite'` is a security filter, not a display
  // preference. A `student_block` row is a tombstone the STUDENT wrote by
  // unlinking, and it carries their email — an address this teacher may
  // never have been given, since shareEmail defaults to false. Returning
  // it would mean that leaving disclosed more than staying did.
  const invitations = await prisma.invitation.findMany({
    where: { teacherId: session.teacherId, origin: 'teacher_invite', isArchived: archived },
    select: {
      id: true, email: true, firstName: true, lastName: true,
      status: true, isArchived: true, createdAt: true,
    },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });

  return respondOk({ invitations, total: invitations.length });
});
```

No pagination: a teacher's pending contacts are a working set, not a directory. If that stops being true, `studentListQuerySchema` (`schemas.ts:161`) is the idiom to copy.

- [ ] **Step 5: Implement `PUT`, `DELETE`, `PATCH`**

Create `src/app/api/invitations/[id]/route.ts`. All three share this ownership preamble — write it once as a local helper in the file:

```ts
async function ownedInvitation(teacherId: string, id: string) {
  return prisma.invitation.findFirst({
    where: { id, teacherId, origin: 'teacher_invite' },
    select: { id: true, status: true, isArchived: true },
  });
}
```

`findFirst` with `teacherId` in the `where`, not `findUnique` by id followed by a check — the ownership condition belongs in the query, which is the shape this project's gate model calls for.

```ts
export const DELETE = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  const invitation = await ownedInvitation(session.teacherId, id);
  if (!invitation) return respondError('Contact not found', 404);

  // The tombstone must outlive the teacher's wish to be rid of it. If this
  // row could be deleted, delete-then-re-invite would restore exactly the
  // harassment loop that declining exists to end. Archiving is the escape
  // hatch: it hides the row without disarming the uniqueness check that
  // `inviteContact` runs against it.
  if (invitation.status === 'declined') {
    return respondError(
      'This person declined. You can archive this contact, but it cannot be removed.',
      409,
      'DECLINED_IS_PERMANENT',
    );
  }

  await prisma.invitation.delete({ where: { id } });
  return respondOk({ id });
});
```

`PUT` parses `updateInvitationSchema`, refuses a `declined` row with the same 409 (editing the email would sidestep the tombstone just as deleting would), and returns `{ id }`.

`PATCH` mirrors `students/[id]/route.ts:211-251` exactly — `archiveStateQuerySchema` from `@/lib/schemas`, the already-there no-op returning `action: 'unchanged'`, the same response shape. Archiving is allowed on a declined row; that is the point.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts`
Expected: PASS.

- [ ] **Step 7: Prove the guards bite** — three separate mutations, each recorded

1. Remove the `status === 'declined'` refusal in `DELETE`. Expected: `'refuses to delete a declined row'` fails. Restore.
2. Remove `origin: 'teacher_invite'` from the `GET` filter. Expected: `'never returns a student_block row'` fails, naming the leaked address. Restore.
3. Change `ownedInvitation`'s `findFirst` to `findUnique({ where: { id } })`. Expected: `'refuses another teacher\'s invitation'` fails. Restore.

Record all three exact messages in the commit body. Guard 2 is the one most likely to be written in a way that cannot fail — if it passes with the filter removed, the assertion is checking a row count instead of the body.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/invitations src/lib/schemas.ts src/services/invitations.ts \
        tests/integration/invitations-api.test.ts
git commit -m "feat: teacher-side invitation management, with an undeletable tombstone (#166)"
```

---

### Task 5: Student accept / decline

**Files:**
- Create: `src/app/api/invitations/[id]/respond/route.ts`
- Modify: `src/services/invitations.ts`, `src/lib/schemas.ts`
- Test: `tests/integration/invitations-api.test.ts`

**Interfaces:**
- Produces:
  - `respondToInvitationSchema` — `{ response: 'accept' | 'decline' }`, `.strict()`.
  - In `src/services/invitations.ts`:
    ```ts
    export async function acceptInvitation(
      db: PrismaClient, input: { invitationId: string; studentId: string; accountEmail: string },
    ): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }>;
    export async function declineInvitation(
      db: PrismaClient, input: { invitationId: string; accountEmail: string },
    ): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }>;
    ```

- [ ] **Step 1: Write the failing tests**

**The fixtures below are wrong as written, and were corrected during execution.** They give the accept and decline tests one shared `{teacherId, studentId}` pair, which `@@unique([teacherId, email])` makes impossible — and even if it were possible, the decline test would be asserting against the accept test's side effect. Use **two separate students**, one per test, so each proves what its name claims. Treat the snippet as intent, not as code.

```ts
describe('POST /api/invitations/[id]/respond', () => {
  it('accepting creates the link and stamps the row', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${inviteId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({ response: 'accept' }),
    });
    expect(res.status).toBe(200);

    const link = await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    });
    expect(link).not.toBeNull();
    const inv = await prisma.invitation.findUniqueOrThrow({ where: { id: inviteId } });
    expect(inv.status).toBe('accepted');
    expect(inv.respondedAt).not.toBeNull();
  });

  it('declining leaves no link and blocks a re-invite', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${declineId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({ response: 'decline' }),
    });
    expect(res.status).toBe(200);
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    })).toBeNull();

    const reinvite = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'A', lastName: 'B', email: studentEmail }),
    });
    expect(reinvite.status).toBe(409);
  });

  it('refuses an invitation addressed to someone else', async () => {
    // The id is the only thing the caller supplies; the address is what
    // authorizes them. This is gate 4 — without it, any signed-in student
    // who guesses an id accepts on a stranger's behalf.
    const res = await fetch(`${BASE_URL}/api/invitations/${otherPersonsInviteId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({ response: 'accept' }),
    });
    expect(res.status).toBe(404);
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId: otherTeacherId, studentId } },
    })).toBeNull();
  });

  it('refuses a second response to the same invitation', async () => {
    const again = await fetch(`${BASE_URL}/api/invitations/${inviteId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
      body: JSON.stringify({ response: 'decline' }),
    });
    expect(again.status).toBe(409);
  });

  it('refuses a teacher-only session', async () => {
    const res = await fetch(`${BASE_URL}/api/invitations/${inviteId}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherOnlyToken) },
      body: JSON.stringify({ response: 'accept' }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run and confirm failure** — `npx vitest run --project integration tests/integration/invitations-api.test.ts -t "respond"`. Expected: 404s from Next.

- [ ] **Step 3: Implement the service functions**

```ts
/**
 * Accept an invitation.
 *
 * Authorization is by ADDRESS, not by id. The invitation id travels in a
 * URL and is not a secret; the account email is what the person proved
 * they own at sign-in. Matching on `accountEmail` is therefore the
 * ownership gate, and `findFirst` puts it in the query rather than in a
 * check after the read.
 */
export async function acceptInvitation(
  db: PrismaClient,
  input: { invitationId: string; studentId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }> {
  // `.toLowerCase()` is load-bearing, not defensive. Invitation emails are
  // written lowercased (`inviteContact`, `PUT /api/invitations/[id]`), but
  // `Account.email` is normalized NOWHERE in this app — it is stored exactly
  // as the person typed it at signup. Compare raw and a student whose address
  // carries any uppercase never sees an invitation addressed to them: no
  // error, no hint, the row just sits pending forever.
  const invitation = await db.invitation.findFirst({
    where: { id: input.invitationId, email: input.accountEmail.toLowerCase() },
    select: { id: true, teacherId: true, status: true },
  });
  if (!invitation) return { ok: false, reason: 'NOT_FOUND' };
  if (invitation.status !== 'pending') return { ok: false, reason: 'NOT_PENDING' };

  await db.$transaction(async (tx) => {
    await tx.teacherStudent.upsert({
      where: {
        teacherId_studentId: { teacherId: invitation.teacherId, studentId: input.studentId },
      },
      update: {},
      create: { teacherId: invitation.teacherId, studentId: input.studentId },
    });
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: 'accepted', respondedAt: new Date() },
    });
  });
  return { ok: true };
}
```

`declineInvitation` is the same lookup, then a single `update` to `status: 'declined'` with `respondedAt`. It creates no link and deletes nothing.

- [ ] **Step 4: Implement the route**

```ts
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireStudent(request);
  if (isErrorResponse(session)) return session;

  const parsed = await parseBody(request, respondToInvitationSchema);
  if ('error' in parsed) return parsed.error;

  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });

  const result = parsed.data.response === 'accept'
    ? await acceptInvitation(prisma, {
        invitationId: id, studentId: session.studentId, accountEmail: account.email,
      })
    : await declineInvitation(prisma, { invitationId: id, accountEmail: account.email });

  if (!result.ok) {
    if (result.reason === 'NOT_FOUND') return respondError('Invitation not found', 404);
    return respondError('This invitation has already been answered', 409, 'ALREADY_ANSWERED');
  }
  return respondOk({ id });
});
```

`requireStudent` gives the 403 for a teacher-only session for free.

- [ ] **Step 5: Run the tests** — expected PASS.

- [ ] **Step 6: Prove the guards bite**

1. Drop `email: input.accountEmail` from `acceptInvitation`'s `findFirst`. Expected: `'refuses an invitation addressed to someone else'` fails. **This is the most important mutation in the plan** — it is the gate-4 ownership check, the family that #146/#148/#162 all belonged to.
2. Drop the `status !== 'pending'` check. Expected: `'refuses a second response'` fails.

Record both exact messages. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/invitations src/services/invitations.ts src/lib/schemas.ts \
        tests/integration/invitations-api.test.ts
git commit -m "feat: students accept or decline an invitation (#166)"
```

---

### Task 6: Student-side unlink

**Files:**
- Create: `src/app/api/teacher-links/[teacherId]/route.ts`
- Modify: `src/services/invitations.ts`
- Test: `tests/integration/invitations-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function unlinkTeacher(
    db: PrismaClient,
    input: { teacherId: string; studentId: string; accountEmail: string },
  ): Promise<{ ok: true } | { ok: false; reason: 'NOT_LINKED' }>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
describe('DELETE /api/teacher-links/[teacherId]', () => {
  it('removes the link and leaves the student account intact', async () => {
    const res = await fetch(`${BASE_URL}/api/teacher-links/${teacherId}`, {
      method: 'DELETE', headers: cookie(studentToken),
    });
    expect(res.status).toBe(200);
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId } },
    })).toBeNull();

    // The account must survive. The route this replaces
    // (students/[id]/route.ts:201-206) deleted the Student row when its
    // last link went; nothing student-facing may ever do that.
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    expect(student).not.toBeNull();
    expect(student!.deletedAt).toBeNull();
  });

  it('writes an invisible tombstone when the link came from a booking', async () => {
    const tombstone = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: studentEmail } },
    });
    expect(tombstone.status).toBe('declined');
    expect(tombstone.origin).toBe('student_block');

    const list = await fetch(`${BASE_URL}/api/invitations`, { headers: cookie(teacherToken) });
    expect(await list.text()).not.toContain(studentEmail);

    const reinvite = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'A', lastName: 'B', email: studentEmail }),
    });
    expect(reinvite.status).toBe(409);
  });

  it('keeps the teacher_invite origin when one already existed', async () => {
    // The teacher typed that address; they already have it. Downgrading
    // the row to student_block would hide a contact they are entitled to.
    //
    // NOTE — this snippet was missing its action when written: it asserted
    // on state without performing the unlink that produces it, so it would
    // have passed on whatever a neighbouring test happened to leave behind.
    // A test that asserts without acting is the exact defect this branch
    // exists to hunt, sitting in the plan that hunts it. Drive it explicitly.
    const res = await fetch(`${BASE_URL}/api/teacher-links/${invitingTeacherId}`, {
      method: 'DELETE',
      headers: cookie(studentToken),
    });
    expect(res.status).toBe(200);

    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId: invitingTeacherId, email: studentEmail } },
    });
    expect(row.origin).toBe('teacher_invite');
    expect(row.status).toBe('declined');
  });

  it('leaves registrations and payments alone', async () => {
    expect(await prisma.registration.count({ where: { studentId } })).toBeGreaterThan(0);
  });

  it('404s when no link exists', async () => {
    const res = await fetch(`${BASE_URL}/api/teacher-links/${unrelatedTeacherId}`, {
      method: 'DELETE', headers: cookie(studentToken),
    });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement**

```ts
/**
 * A student severs a teacher link.
 *
 * Two things this deliberately does not do. It does not delete the
 * Student row when the last link goes — the teacher-side DELETE used to,
 * and that behaviour must not survive into a student-facing route. And it
 * does not touch registrations or payments: those are facts, and money may
 * be owed. The teacher keeps seeing them through the registration-scoped
 * surfaces, which is #167's decision applied here.
 */
export async function unlinkTeacher(
  db: PrismaClient,
  input: { teacherId: string; studentId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_LINKED' }> {
  const link = await db.teacherStudent.findUnique({
    where: {
      teacherId_studentId: { teacherId: input.teacherId, studentId: input.studentId },
    },
    select: { id: true },
  });
  if (!link) return { ok: false, reason: 'NOT_LINKED' };

  await db.$transaction(async (tx) => {
    await tx.teacherStudent.delete({ where: { id: link.id } });

    // Update-or-create, and the origin differs by case. An existing row
    // means the teacher typed this address themselves, so it stays theirs
    // to see. A missing row means the link came from a booking and the
    // teacher may never have had the address — shareEmail defaults false —
    // so the tombstone is written as student_block and never listed back.
    // Lowercased on both branches, for the same reason `acceptInvitation`
    // lowercases: invitation emails are always stored lowercase, `Account.email`
    // never is. A raw address here would miss the existing row and create a
    // duplicate tombstone under a different casing — which then fails to block
    // the re-invite it exists to block, because `inviteContact` looks up the
    // lowercased form.
    const email = input.accountEmail.toLowerCase();
    await tx.invitation.upsert({
      where: { teacherId_email: { teacherId: input.teacherId, email } },
      update: { status: 'declined', respondedAt: new Date() },
      create: {
        teacherId: input.teacherId,
        email,
        status: 'declined',
        origin: 'student_block',
        respondedAt: new Date(),
      },
    });
  });
  return { ok: true };
}
```

The route reads the account email exactly as Task 5's does and calls this.

- [ ] **Step 4: Run the tests** — expected PASS.

- [ ] **Step 5: Prove the guards bite**

**Assertion order inside `'writes an invisible tombstone'` is load-bearing, and the snippet above gets it wrong.** Put the raw-body check on `GET /api/invitations` *first*, before the DB-level `origin` and `findUniqueOrThrow` checks. Written in the snippet's order, mutation 1 fails on a plain field mismatch rather than naming the leaked address, and mutation 2 throws a Prisma not-found error instead of producing the 201-vs-409 the guard is supposed to demonstrate. Both mutations would still go red — but red for the wrong reason teaches the next reader nothing, and a mutation test whose failure message doesn't name the defect is only half a guard.

1. Change the `create` branch's `origin` to `teacher_invite`. Expected: `'writes an invisible tombstone'` fails on the raw-body assertion, naming the leaked address.
2. Delete the whole `invitation.upsert`. Expected: the re-invite assertion fails with `201` instead of `409`.
3. Add `await tx.student.delete(...)` after the link delete. Expected: `'leaves the student account intact'` fails. Restore — this one is a deliberate check that the test would catch the old cascade being copied in.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/teacher-links src/services/invitations.ts tests/integration/invitations-api.test.ts
git commit -m "feat: a student can sever a teacher link without deleting their account (#166)"
```

---

### Task 6b: Silent-block a `student_block` tombstone

Added during the build, after a whole-repo sweep of `Invitation` consumers found that
`origin: 'student_block'` protected the *list* while the refusal code leaked the same
bit. See the spec's "The block oracle, found during the build".

**Files:**
- Modify: `src/services/invitations.ts` (`inviteContact`)
- Test: `tests/integration/invitations-api.test.ts`

**Interfaces:**
- Consumes: `unlinkTeacher` (Task 6), which creates the `student_block` rows.
- Produces: no signature change. `inviteContact` gains a branch, not a parameter.

- [ ] **Step 1: Write the failing test**

**Two things this snippet gets wrong, corrected during execution:** `post` is declared inside the first `it()` and referenced from the second, which does not work across sibling Vitest tests — hoist it to describe scope. And Task 6's existing test `'writes an invisible tombstone when the link came from a booking'` asserts the 409 this task removes; it must be updated, and updating it is the riskiest edit here (see Step 5).

```ts
// Hoisted to describe scope — the second test needs it too.
const post = (email: string) =>
  fetch(`${BASE_URL}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
    body: JSON.stringify({ firstName: 'Zzz', lastName: 'Qqq', email }),
  });

it('answers a silently-blocked address exactly as a fresh one', async () => {
  // The student unlinked, so a student_block tombstone exists for this
  // (teacher, email) pair — carrying an address this teacher never had,
  // because shareEmail defaults false. A 409 here would hand it to them.

  const [blocked, fresh] = await Promise.all([post(blockedEmail), post(freshEmail)]);

  expect(blocked.status).toBe(fresh.status);
  expect(blocked.status).toBe(201);
  const blockedJson = await blocked.json();
  const freshJson = await fresh.json();
  expect(Object.keys(blockedJson.data)).toEqual(Object.keys(freshJson.data));

  // ...and nothing was written for the blocked one. The tombstone still
  // stands, unchanged, still `declined`, still `student_block`.
  const tombstone = await prisma.invitation.findUniqueOrThrow({
    where: { teacherId_email: { teacherId, email: blockedEmail } },
  });
  expect(tombstone.status).toBe('declined');
  expect(tombstone.origin).toBe('student_block');
  expect(tombstone.respondedAt).not.toBeNull();
});

it('still refuses a declined teacher_invite honestly', async () => {
  // Contrast case, and the reason this is not a blanket change: the teacher
  // typed THIS address themselves, so 409 discloses nothing new — and a
  // teacher deserves to know their invitation is dead rather than
  // re-sending into silence.
  const res = await post(declinedInviteEmail);
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe('DECLINED');
});
```

- [ ] **Step 2: Run and confirm failure** — the first test fails `expected 409 to be 201`.

- [ ] **Step 3: Branch on origin in `inviteContact`**

The existing `if (existing.status === 'declined') return { ok: false, reason: 'DECLINED' }` splits:

```ts
  if (existing) {
    if (existing.status === 'declined') {
      // A tombstone the STUDENT wrote by unlinking. Refusing would confirm
      // that this address belongs to someone who was this teacher's student
      // and left — an address `shareEmail` withheld, on a person the roster
      // still shows as "Anna d.". So answer exactly as a fresh invitation
      // does and do nothing. The teacher is misled; that is the trade.
      //
      // Do NOT "simplify" this by returning the tombstone's own id — that
      // id is stable across probes, so two requests would betray it.
      if (existing.origin === 'student_block') return { ok: true, value: { id: randomUUID() } };

      // The teacher typed this address themselves, so 409 tells them nothing
      // they did not already have, and silence here would be cruelty rather
      // than protection.
      return { ok: false, reason: 'DECLINED' };
    }
    ...
```

Widen the `select` at the `existing` lookup to include `origin`.

- [ ] **Step 4: Run the tests** — both pass, plus the whole file.

- [ ] **Step 5: Prove the guard bites**

Change `existing.origin === 'student_block'` to `existing.origin === 'teacher_invite'`. Expected: the silent-block test fails `expected 409 to be 201` **and** the honest-refusal test fails `expected 201 to be 409`. Both must fail — one alone means the two cases are not actually distinguished. Record both.

Then re-run Task 3's oracle test (`'answers identically for a registered address and a free one'`) — it must still pass. This branch adds a third path through the same response, and it is the test that governs all of them.

**And handle Task 6's existing test carefully — this is the riskiest edit in the task.** `'writes an invisible tombstone when the link came from a booking'` asserts a 409 on re-invite, which is exactly the behaviour being removed, so it must change. It must NOT be reduced to asserting 201: 201 is now indistinguishable from success, so a test asserting only that proves nothing and the "blocks" half of Task 6's guarantee silently evaporates. Keep an assertion on an observable *consequence* of the block — that no new `Invitation` row exists for that address, and that the tombstone still stands with `status: 'declined'` and `origin: 'student_block'`. Updating a regression test to match new behaviour is how regression tests get neutered; the bar is that the rewritten test would still fail if the block stopped working.

- [ ] **Step 6: Commit**

```bash
git add src/services/invitations.ts tests/integration/invitations-api.test.ts
git commit -m "fix: a blocked address answered 409 where a fresh one answered 201 (#166)"
```

---

### Task 6c: Move the block out of `Invitation` into its own table

**Why this exists, and why it deletes more than it adds.** Task 6b's silent block closed the POST response but not the feature: `GET /api/invitations` filtered out `student_block` rows, so a fresh invite produced a listed row and a blocked one produced nothing. POST then GET, and the bit is back — one extra unmetered request.

Making a blocked address indistinguishable *everywhere* while the block lives inside the `Invitation` row would need four deceptive special cases — `DELETE` appearing to delete while secretly reverting, `PUT` refusing to let an email change move the tombstone, plus two conditional filters — and each is a place a future edit silently loses the block.

Moving the block to its own table removes the problem instead of managing it. `Invitation` rows then behave **normally everywhere, with no special cases at all**, because the block is no longer in the row being manipulated.

**Files:**
- Modify: `prisma/schema.prisma` (+ migration), `src/services/invitations.ts`, `src/app/api/invitations/route.ts`, `src/app/api/invitations/[id]/route.ts`
- Test: `tests/integration/invitations-api.test.ts`

**Interfaces:**
- Produces: `model TeacherBlock`. `InviteResult.delivered` survives unchanged — it now means "no block exists" rather than "not a tombstone".
- Consumed later: **Task 7 must delete the block** on a student-initiated link (it is the student's route back). **Task 8 must gate notification on `delivered === true`.** **Task 11's student-side pending query must exclude blocked pairs**, or the student sees an invitation from the person they walked away from.

- [ ] **Step 1: Schema**

```prisma
// A student's standing refusal of one teacher, kept out of `Invitation` on
// purpose. Held here, invitation rows behave identically for a blocked and
// an unblocked address — listed, edited, archived, deleted, re-created — so
// there is no observable difference for a teacher to read. Held *in* the
// invitation row, every one of those operations needs a special case, and
// each is a place the block can be silently lost.
model TeacherBlock {
  id        String   @id @default(uuid())
  teacherId String
  email     String
  createdAt DateTime @default(now())

  teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)

  @@unique([teacherId, email])
}
```

Add `teacherBlocks TeacherBlock[]` to `Teacher`. **Drop `Invitation.origin` and the `InvitationOrigin` enum** — nothing needs them once blocks live elsewhere. Migration: `npx prisma migrate dev --name move_block_out_of_invitation`.

- [ ] **Step 2: Simplify `inviteContact`**

Delete the whole `origin === 'student_block'` branch and the `randomUUID()` return. A declined `teacher_invite` row keeps its honest 409 — that is now the *only* declined case. Then, after the invitation is created:

```ts
  // A block makes this invitation undeliverable, not un-creatable. The row
  // is real, the teacher sees it, edits it, archives it — everything behaves
  // exactly as it does for an address that was never blocked, which is the
  // point. Only delivery is withheld. See `delivered` on InviteResult.
  const blocked = await db.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: { id: true },
  });

  return { ok: true, value: { id: created.id, delivered: blocked === null } };
```

- [ ] **Step 3: Rewrite `unlinkTeacher`'s tombstone half**

Inside the same transaction, replace the `invitation.upsert` with:

```ts
    // An invitation the teacher created keeps its honest declined state —
    // they typed that address, so telling them it is dead discloses nothing
    // and saves them re-sending into silence. `updateMany`, because most
    // links come from bookings and have no invitation at all.
    await tx.invitation.updateMany({
      where: { teacherId: input.teacherId, email },
      data: { status: 'declined', respondedAt: new Date() },
    });

    // The block is what actually holds, invitation or not.
    await tx.teacherBlock.upsert({
      where: { teacherId_email: { teacherId: input.teacherId, email } },
      update: {},
      create: { teacherId: input.teacherId, email },
    });
```

- [ ] **Step 4: Drop both `origin` filters**

`src/app/api/invitations/route.ts` and `ownedInvitation` in `src/app/api/invitations/[id]/route.ts` both filter `origin: 'teacher_invite'`. Remove both — every `Invitation` row is now a contact the teacher typed, so there is nothing to hide. Delete the security comments explaining the filters; they describe a mechanism that no longer exists, and a comment describing a departed guard is worse than none.

- [ ] **Step 5: Guard accept**

`acceptInvitation` must refuse when a block exists. The student cannot see the invitation (Task 11 filters it), so this is defence in depth — but the id travels in a URL and the whole design rests on not trusting that. Return `NOT_FOUND`, not a distinct code: a distinct code would tell a probing caller a block exists.

- [ ] **Step 6: Update the tests these changes invalidate**

Task 6's `'writes an invisible tombstone'` and Task 6b's two silent-block tests all assert behaviour that is now different. **Rewrite, do not delete** — the properties they protect still hold, they are just enforced elsewhere. Each must still prove: the teacher's list and the teacher's POST answer identically for a blocked and a fresh address, and the block survives whatever the teacher does to the invitation row.

Add the test the old design could not support: **delete the invitation for a blocked address, re-invite, and confirm the new invitation is still undelivered.** That is the case the four special cases existed to handle, and it should now pass with no special casing at all.

- [ ] **Step 7: Prove the guards bite**

1. Delete the `teacherBlock.upsert` in `unlinkTeacher` → re-invite becomes deliverable.
2. Delete the block lookup in `inviteContact` → a blocked address reports `delivered: true`.
3. Delete the accept guard → accepting a blocked invitation creates a link.

Then re-run Task 3's oracle test and the whole invitations file.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/invitations.ts \
        src/app/api/invitations tests/integration/invitations-api.test.ts
git commit -m "refactor: move the block out of Invitation so invitations behave normally (#166)"
```

---

### Task 7: Booking and waitlisting resolve invitations and clear tombstones

> **Amended after the PR review.** `resolveInvitationOnLink` now lives in
> `src/services/link-consent.ts` (a `waitlist.ts` ↔ `invitations.ts` import
> cycle), and it is called from the student's own booking and from
> `addToWaitlist` — not from `promoteNext`/`claimSpot`, which fire at a moment
> the teacher chooses. The `LinkConsent` parameter a review wave added here was
> deleted with that change; the signature below is the one that shipped.

The student's way back in. This is what stops "declined" being a trap.

**Files:**
- Modify: `src/app/api/registrations/route.ts` (the `!isTeacher` block at `:198-227`), `src/services/waitlist.ts` (both sites from Task 1), `src/services/invitations.ts`
- Test: `tests/integration/invitations-api.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function resolveInvitationOnLink(
    tx: Prisma.TransactionClient,
    input: { teacherId: string; studentEmail: string },
  ): Promise<void>;
  ```
  Called from all three link-creating sites.

- [ ] **Step 1: Write the failing tests**

```ts
it('booking a declined teacher\'s class re-establishes the link and clears the tombstone', async () => {
  // Decline first.
  await prisma.invitation.update({
    where: { teacherId_email: { teacherId, email: studentEmail } },
    data: { status: 'declined', respondedAt: new Date() },
  });
  await prisma.teacherStudent.deleteMany({ where: { teacherId, studentId } });

  const res = await fetch(`${BASE_URL}/api/registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(studentToken) },
    body: JSON.stringify({ classId: openClassId }),
  });
  expect(res.status).toBe(201);

  expect(await prisma.teacherStudent.findUnique({
    where: { teacherId_studentId: { teacherId, studentId } },
  })).not.toBeNull();

  const inv = await prisma.invitation.findUniqueOrThrow({
    where: { teacherId_email: { teacherId, email: studentEmail } },
  });
  expect(inv.status).toBe('accepted');
});

it('a teacher-initiated registration does not resolve anything', async () => {
  // Only the student's OWN act is consent. A roster add or a walk-in must
  // not launder itself into acceptance.
  //
  // THE FIXTURE'S STARTING STATUS IS THE WHOLE TEST. An earlier draft seeded
  // it `accepted`, which made this test incapable of catching the mutation it
  // exists for: a guard broken to resolve unconditionally would write
  // accepted → accepted, and nothing observable changes. Seed it `declined`,
  // which both catches the mutation and exercises the case that actually
  // matters — a teacher resurrecting a tombstone the student set deliberately.
  await prisma.invitation.update({
    where: { teacherId_email: { teacherId, email: rosterStudentEmail } },
    data: { status: 'declined', respondedAt: new Date() },
  });
  const before = await prisma.invitation.findUniqueOrThrow({
    where: { teacherId_email: { teacherId, email: rosterStudentEmail } },
  });
  await fetch(`${BASE_URL}/api/registrations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
    body: JSON.stringify({ classId: openClassId, studentId: rosterStudentId }),
  });
  const after = await prisma.invitation.findUniqueOrThrow({
    where: { teacherId_email: { teacherId, email: rosterStudentEmail } },
  });
  expect(after.status).toBe(before.status);
});
```

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement**

```ts
/**
 * A student's own booking is acceptance, so it resolves whatever
 * invitation state stood between them and this teacher — including a
 * `declined` tombstone. That asymmetry is the design: the tombstone is
 * permanent from the teacher's side and always reversible from the
 * student's, which is what keeps declining from being a trap while still
 * denying the teacher a re-invite.
 *
 * `updateMany`, not `update`: most bookings have no invitation row at all
 * and a zero-row update must not throw.
 */
export async function resolveInvitationOnLink(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; studentEmail: string },
): Promise<void> {
  // Lowercased for the third time in this file, and for the same reason each
  // time: invitation emails are always stored lowercase, `Student.email` and
  // `Account.email` never are. Miss it here and a booking silently fails to
  // clear the declined tombstone — so the student's only route back to a
  // teacher they declined stops working, which is the one escape hatch the
  // whole decline design rests on.
  const email = input.studentEmail.toLowerCase();

  // Task 6c moved the block into its own table, and the block is the thing
  // that actually stands between them — so clearing it is what makes booking
  // the student's route back. Updating the invitation alone would leave the
  // pair connected on paper and severed in practice: linked, but every future
  // invitation from this teacher still undeliverable.
  await tx.teacherBlock.deleteMany({ where: { teacherId: input.teacherId, email } });

  await tx.invitation.updateMany({
    where: { teacherId: input.teacherId, email },
    data: { status: 'accepted', respondedAt: new Date() },
  });
}
```

**Three call sites, one rule.** `acceptInvitation`, `unlinkTeacher` and this function all compare a person-supplied address against the lowercased column. If a fourth appears, it needs the same treatment — the asymmetry (invitation emails normalized, account and student emails not) is a property of the app, not of these functions, and it is filed separately as its own issue.

Call it in `registrations/route.ts` inside the existing `if (!isTeacher)` block, right after the `teacherStudent.upsert` — the guard is already there and already correct, which is why the second test above passes without new branching. Call it in both `waitlist.ts` sites beside the upserts Task 1 added.

All three call sites need the student's email. `registrations/route.ts` already loads `student` at `:84`; widen that `select` if it does not include `email`. In `waitlist.ts` both sites already do a `student.findUniqueOrThrow` for `incomeTier` — add `email: true` there rather than issuing another query.

- [ ] **Step 4: Run the tests** — expected PASS. Also re-run `tests/integration/registrations-api.test.ts` and `tests/integration/waitlist-api.test.ts`.

- [ ] **Step 5: Prove the guard bites**

Move the `resolveInvitationOnLink` call outside the `if (!isTeacher)` block in `registrations/route.ts`. Expected: `'a teacher-initiated registration does not resolve anything'` fails. Restore. This mutation matters because the same policy applied to the wrong call site is the exact defect shape #39's whole-branch review caught.

**Two more, and both had to be repaired during execution because the draft asked for the impossible:**

2. Delete the `teacherBlock.deleteMany`. A student who unlinked and then re-books must still be undeliverable. **Do not assert this through `inviteContact` on the just-rebooked pair** — it short-circuits on `ALREADY_LINKED` before it ever reaches the block check, so it answers 409 whether or not the block was cleared. Delete the freshly-created roster link first to isolate the property, and query `TeacherBlock` directly as a second check.

3. Delete the `invitation.updateMany`. A declined invitation must fail to become accepted after a booking.

Also: `registrations/route.ts`'s student lookup has **no `select` at all**, so `email` is already present — the widening this plan asked for at `:84` was unnecessary. Only the two `waitlist.ts` lookups needed `email: true` added.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/registrations/route.ts src/services/waitlist.ts \
        src/services/invitations.ts tests/integration/invitations-api.test.ts
git commit -m "feat: a student's own booking clears a declined tombstone (#166)"
```

---

### Task 8: Notify the invitee

**Files:**
- Modify: `src/services/invitations.ts`, `src/lib/email.ts`, `src/lib/email-templates.ts`, `src/app/api/students/route.ts`
- Test: `tests/integration/invitations-api.test.ts`, `src/lib/email-templates.test.ts` if one exists

**Interfaces:**
- Produces:
  - `renderInvitationEmail(teacherName: string, signInUrl: string): { subject: string; html: string }` in `email-templates.ts`
  - `sendInvitationEmail(to: string, teacherName: string, signInUrl: string): Promise<void>` in `email.ts`
  - `notifyInvitee(db, { teacherId, email, invitationId }): Promise<void>` in `invitations.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('creates an in-app notification for a registered invitee', async () => {
  await fetch(`${BASE_URL}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
    body: JSON.stringify({ firstName: 'A', lastName: 'B', email: registeredEmail }),
  });
  const notifications = await prisma.notification.findMany({
    where: { recipientType: 'student', recipientId: registeredStudentId, type: 'teacher_invitation' },
  });
  expect(notifications).toHaveLength(1);
});

it('creates no notification for an address with no student row, and still answers 201', async () => {
  const res = await fetch(`${BASE_URL}/api/students`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
    body: JSON.stringify({ firstName: 'A', lastName: 'B', email: strangerEmail }),
  });
  expect(res.status).toBe(201);
  expect(await prisma.notification.count({ where: { type: 'teacher_invitation' } }))
    .toBe(1); // still just the one from the previous test
});
```

Integration tests run with `EMAIL_DRY_RUN` behaviour (`src/lib/email.ts:23`) — confirm the dev server's env before asserting on sends, and assert on the notification rows rather than on Resend.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Implement**

```ts
/**
 * Layer 1+2 for a registered invitee; a plain email for everyone else.
 *
 * This function reads `Student` by email, and that is fine — the read
 * happens AFTER the response has been decided and feeds only the delivery
 * choice. Nothing it learns reaches the caller. Do not restructure this so
 * that the route's status or body depends on it; that dependency is the
 * enumeration oracle this feature exists to close.
 *
 * `teacher_invitation` is deliberately NOT in ESSENTIAL_NOTIFICATION_TYPES
 * (`services/notification-policy.ts:16-21`), so `shouldEmailStudent`
 * resolves to the student's own `emailNotifications` preference. An
 * invitation from someone they have never met is not a service message
 * about their own booking.
 */
export async function notifyInvitee(
  db: PrismaClient,
  input: { teacherId: string; email: string; teacherName: string },
): Promise<void> {
  const student = await db.student.findUnique({
    where: { email: input.email },
    select: { id: true },
  });

  if (student) {
    // The three-layer model handles email from here: the fallback cron
    // picks this up unread after the threshold, honouring the student's
    // preference. No direct send.
    await createNotification(db, {
      recipientType: 'student',
      recipientId: student.id,
      type: 'teacher_invitation',
      title: 'A teacher would like to connect',
      body: `${input.teacherName} added you as a contact. You choose whether to connect.`,
    });
    return;
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000';
  await sendInvitationEmail(input.email, input.teacherName, `${baseUrl}/login`);
}
```

The email body must not reveal whether the address was already registered — same copy either way, and no "welcome back". Wire it into the route after `inviteContact` succeeds, loading the teacher's name in the same handler.

- [ ] **Step 4: Run the tests, then the oracle test again**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts tests/integration/students-api.test.ts`
Expected: PASS, **including Task 3's `'answers identically'`**. If notification work has made the two branches diverge in status or body, that test is what catches it.

- [ ] **Step 5: Commit**

```bash
git add src/services/invitations.ts src/lib/email.ts src/lib/email-templates.ts \
        src/app/api/students/route.ts tests/integration/invitations-api.test.ts
git commit -m "feat: tell the invitee, without telling the teacher whether they exist (#166)"
```

---

### Task 9: Teacher CRM — the Contacts section

**Files:**
- Create: `src/components/students/contact-list.tsx`, `src/components/students/contact-form.tsx`, `src/app/(teacher)/students/contacts/[id]/page.tsx`
- Modify: `src/app/(teacher)/students/page.tsx`, `src/components/students/create-student-form.tsx`, `src/components/students/remove-student-button.tsx`
- Test: `src/components/students/contact-list.test.tsx`, `src/components/students/contact-form.test.tsx`

- [ ] **Step 1: Write the failing component tests**

Follow `create-student-form.test.tsx` exactly: `const fetchMock = vi.fn()`, `vi.stubGlobal('fetch', fetchMock)`, `afterEach` resetting both, and `routerPush`/`routerRefresh` imported from `tests/setup/components` rather than mocked per file.

Assert: `contact-list` fetches `/api/invitations`, renders one row per contact with the status as **text, not a badge** (design rule: payment/relationship states are text), and shows the empty state when there are none. `contact-form` PUTs to `/api/invitations/${id}` and surfaces the 409 `DECLINED_IS_PERMANENT` message rather than a generic retry prompt — the `teacher-privacy-card.tsx:75-84` handling of its own 403 is the precedent for why status-specific copy matters there.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Build the components**

`contact-list.tsx` mirrors `student-directory.tsx`'s fetch shape (including the `401 → window.location.href = '/login'` branch at `:57-60`) but without pagination — `GET /api/invitations` returns the whole working set. Rows are ≥56px chevron rows linking to `/students/contacts/[id]`, per the directory pattern.

Status renders as plain text: `Invited`, `Declined`. Not badges — badges in this system encode time on class cards, and a relationship state is not that.

`/students/contacts/[id]/page.tsx` is a full page with a back link to `/students`, the edit form, an archive button copying `archive-student-button.tsx:18-24`'s query-param idiom, and a remove button that is **absent** for a declined contact rather than present-and-failing.

- [ ] **Step 4: Add the section to `/students`**

Two sections under the existing header: the current `StudentDirectory`, then `Contacts`. Give the Contacts section a one-line explanation of why a contact is not yet a student — this is the first place a teacher meets the new model and the copy is doing real work:

> "Contacts you've invited. They join your students once they accept, or book one of your classes."

- [ ] **Step 5: Repoint `remove-student-button.tsx`**

Change its fetch from `/api/students/${studentId}` to `/api/invitations/${invitationId}` and its prop from `studentId` to `invitationId`. Its `readErrorMessage` call already surfaces the server message, so the `DECLINED_IS_PERMANENT` copy arrives for free. **It has no test file — write one now**, because Task 10 deletes the route it used to call and nothing else would notice.

- [ ] **Step 6: Run** — `npx vitest run --project components src/components/students/` and `npx tsc --noEmit`. Expected: green.

- [ ] **Step 7: Verify in the running app**

Use the `verify` skill. Do **not** start or restart the dev server. Confirm: adding a contact lands back on `/students` with the contact listed as Invited; the contact page edits; a declined contact shows no remove button.

- [ ] **Step 8: Commit**

```bash
git add 'src/app/(teacher)/students' src/components/students
git commit -m "feat: the CRM shows contacts alongside students (#166)"
```

---

### Task 10: Retire the unclaimed student

Only now, once nothing creates one and the UI points elsewhere.

**Files:**
- Modify: `src/app/api/students/[id]/route.ts` (delete `:107-164` and `:169-210`), `src/lib/schemas.ts`, `prisma/seed.ts`, `src/components/students/edit-student-form.tsx`, `src/app/(teacher)/students/[id]/page.tsx`
- Test: `tests/integration/students-api.test.ts`, `tests/integration/tier-selected-at.test.ts`

- [ ] **Step 1: Delete the two branches**

Remove the teacher branch of `PUT` (`:107-164`), leaving the self-edit branch and the trailing `respondError('Access denied', 403)` at `:166`. Remove the entire `DELETE` export (`:169-210`), **including the orphan cascade at `:201-206`** — that cascade is the only precedent in the codebase for deleting a `Student` row as a side effect of removing a link, and Task 6's route must not be written by copying it.

**Delete `createStudentSchema` from `src/lib/schemas.ts`, not merely its import here.** Task 3 kept it alive solely for this route's PUT branch, with a docblock saying so. Once the branch is gone it has no caller.

**The trap Task 3 flagged, verbatim:** `createStudentSchema` and `createInvitationSchema` differ *only* by `.strict()`. "Deduplicating" them — pointing the old PUT at the new schema instead of deleting — is a behaviour change dressed as a refactor: it would start 400ing bodies that previously had their extra keys silently stripped. Delete; do not merge.

- [ ] **Step 2: Fix the four tests the classification named**

- `students-api.test.ts:950` — delete. It pins a response shape that no longer exists.
- `students-api.test.ts:984` — delete. The link check it guarded is gone.
- `students-api.test.ts:814` — **already rewritten in Task 3**, which is where it actually broke. Task 3 reseeded its `Student` via Prisma so the PUTs still had a target; now that the PUT branch is gone, rewrite it again against `POST /api/students` alone. Update `checkStudentWriteLimit`'s docblock (`src/lib/rate-limit.ts:65-72`), which describes a POST/PUT pair that no longer exists.
- `students-api.test.ts:355` (`'a teacher cannot edit a claimed student'`) — **delete, do not leave green.** It asserts only `403`, which it still gets from the catch-all rather than from the `claimedAt` guard it was written for. A passing test whose name is a lie is worse than no test.
- `tier-selected-at.test.ts:194` — delete. The branch whose behaviour it pinned is gone.

Also clear the stale prose at `students-api.test.ts:135-144` and `:979-983`.

- [ ] **Step 3: Rewrite the seed**

In `prisma/seed.ts`: delete the `crmOnlyStudents` block (`:243-258`), change the link loop (`:293-302`) to iterate `students` alone, and fix the comment at `:292` which says "All 10 claimed students + 2 CRM-only students". Sarah's three links (`:304-312`) are untouched.

Add invitation fixtures so every state has one:

```ts
  await prisma.invitation.createMany({
    data: [
      { teacherId: ivo.id, email: 'lena@example.com', firstName: 'Lena', lastName: 'Visser' },
      { teacherId: ivo.id, email: 'max@example.com', firstName: 'Max', lastName: 'Dekker' },
      {
        teacherId: ivo.id, email: 'declined@example.com',
        firstName: 'Nadia', lastName: 'Bakker',
        status: 'declined', respondedAt: daysAgo(3),
      },
    ],
  });
```

Add `prisma.invitation.deleteMany()` to the wipe block beside `:61`.

- [ ] **Step 4: Reset and reseed**

Run: `npm run db:reset`
Expected: drops, re-migrates, re-seeds without error. This is destructive and authorised — there is no production data.

- [ ] **Step 5: Comment the dead code, do not remove it**

Five privacy bypasses and one UI affordance can no longer fire. Removing them means also removing the claim path, the `Student_claim_link_check` constraint and `Student.claimedAt` — a second feature. Leave one comment at each so a future reader does not mistake dead for live:

```ts
    // #166: unreachable for rows created after acceptance-gated linking —
    // nothing creates an unclaimed Student any more. Kept because removing
    // it means removing the claim path (lib/auth/account.ts:34-50), the
    // Student_claim_link_check constraint and Student.claimedAt together.
    // Filed as a leaf. Do NOT treat this branch as a live privacy rule.
```

Sites: `api/students/route.ts:86`, `api/students/[id]/route.ts:51`, `(teacher)/students/[id]/page.tsx:42`, `(teacher)/class/[id]/page.tsx:62`, `(teacher)/settings/payments/page.tsx:52`, `components/students/student-directory.tsx:129`.

Do **not** comment `students/[id]/privacy/route.ts:75-86`. That block synthesizes maximally-private defaults when no `StudentPrivacy` row exists; it has nothing to do with `claimedAt` and stays live.

- [ ] **Step 6: Remove the edit form from the student page**

`(teacher)/students/[id]/page.tsx` renders `EditStudentForm` for unclaimed students. That path is unreachable; remove the render and the import. Delete `edit-student-form.tsx` and its test if `contact-form.tsx` from Task 9 fully replaces it — check for other consumers first with `grep -rn EditStudentForm src/`.

- [ ] **Step 7: Run the full suite**

```
npx vitest run --project unit
npx vitest run --project components
npx vitest run --project integration tests/integration/students-api.test.ts \
    tests/integration/tier-selected-at.test.ts tests/integration/invitations-api.test.ts \
    tests/integration/waitlist-api.test.ts tests/integration/registrations-api.test.ts \
    tests/integration/privacy-api.test.ts tests/integration/account-api.test.ts \
    tests/integration/signup-api.test.ts
npx tsc --noEmit
```

Name integration files explicitly — never `--project integration` bare.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/students src/lib/schemas.ts src/lib/rate-limit.ts prisma/seed.ts \
        'src/app/(teacher)/students' src/components/students tests/integration
git commit -m "refactor: retire the unclaimed student, and the two branches that served it (#166)"
```

---

### Task 11: Student-side pending invitations

**Files:**
- Create: `src/components/student/pending-invitation-card.tsx`, `src/components/student/pending-invitation-card.test.tsx`
- Modify: `src/app/(student)/account/privacy/page.tsx`, `src/components/student/teacher-privacy-card.tsx`

- [ ] **Step 1: Write the failing component test**

Assert the card POSTs `{ response: 'accept' }` to `/api/invitations/${id}/respond`, that decline sends `{ response: 'decline' }`, and that both call `routerRefresh` on success. Copy the fetch-mock idiom from `create-student-form.test.tsx`.

- [ ] **Step 2: Run and confirm failure.**

- [ ] **Step 3: Load invitations on the privacy page**

In `(student)/account/privacy/page.tsx`, add a third query to the existing `Promise.all` at `:27`:

```ts
    prisma.invitation.findMany({
      where: { email: accountEmail, status: 'pending' },
      select: { id: true, teacher: { select: { firstName: true, lastName: true } } },
      orderBy: { createdAt: 'desc' },
    }),
```

`accountEmail` comes from the session's `accountId` — the authenticated identity, not `Student.email`. The page already redirects a session without `studentId` at `:25`.

- [ ] **Step 4: Render the section above the teacher list**

A "Pending invitations" heading, then one card per invitation with the teacher's name and Accept / Decline. Explain the consequence in the card, because this is the moment consent is given:

> "Accepting lets [Name] add you to their classes. You choose what they can see next — nothing is shared until you say so."

Add a decline confirmation, using the two-step `confirming` state from `remove-student-button.tsx:36-46` rather than a browser dialog. Declining is not reversible by the student through this surface, and the copy must say what the way back is: booking one of that teacher's classes.

Update the empty state at `:58-59` so it accounts for a student who has invitations but no teachers yet.

- [ ] **Step 5: Run** — `npx vitest run --project components src/components/student/` and `npx tsc --noEmit`.

- [ ] **Step 6: Add the unlink control to `teacher-privacy-card.tsx`**

A "Remove this teacher" action calling `DELETE /api/teacher-links/${teacherId}`, two-step confirm, with copy stating what survives: "Your past bookings and any payments stay. They won't be able to add you again — but you can always reconnect by booking one of their classes."

- [ ] **Step 7: Verify in the running app** via the `verify` skill. Sign in as a seeded student, accept an invitation, confirm the teacher appears with privacy toggles; decline another; unlink a teacher.

- [ ] **Step 8: Commit**

```bash
git add 'src/app/(student)/account/privacy/page.tsx' src/components/student
git commit -m "feat: students accept, decline, and unlink from their privacy settings (#166)"
```

---

### Task 12: End-to-end, and the branch sweep

**Files:**
- Create: `tests/e2e/invitations.spec.ts`
- Modify: `docs/technical-architecture.md`, `docs/data-model.md`, `docs/information-architecture.md` if they describe the old model

- [ ] **Step 1: Write the e2e flow**

One spec, two paths, built on `tests/e2e/account-helpers.ts`:
1. Teacher adds a contact → student signs in → sees it on `/account/privacy` → accepts → teacher's CRM lists them under Students, not Contacts.
2. Teacher adds a second contact → student declines → teacher's CRM shows Declined and offers no remove.

- [ ] **Step 2: Run** — `npx playwright test tests/e2e/invitations.spec.ts`.

- [ ] **Step 3: Sweep the live reference docs**

`docs/technical-architecture.md` went stale on #39 for exactly this reason. Grep each of these across `docs/*.md` and fix every hit, not just the first:

```bash
grep -rn "unclaimed\|CRM-created\|claimedAt\|TeacherStudent" docs/*.md
grep -rn "12 entities\|CRM import\|optional invitation" docs/*.md
```

`docs/data-model.md` says 12 entities; it is now 13. `docs/product-concept.md:193` and `docs/information-architecture.md:145,158` describe the CRM invitation as optional — it is now mandatory and is the only way to add a contact. `CLAUDE.md`'s data-model section names the same 12 entities.

- [ ] **Step 4: Whole-branch self-check before the PR**

- `grep -rn "ALREADY_LINKED\|createStudentSchema" src/ tests/` — no stale references.
- `npx tsc --noEmit` clean.
- Every `it(` added in this branch: does it fail if its guard is reverted? Re-check the three from Tasks 4-7 that were mutation-tested, and spot-check two that were not.
- Count the integration test files that ran, by path, for the PR body.

- [ ] **Step 5: Commit and open the PR**

```bash
git add tests/e2e/invitations.spec.ts docs
git commit -m "test: end-to-end invitation flow, and the docs that named 12 entities (#166)"
git push -u origin feat/166-student-link-acceptance
```

PR body must record: what was measured and where the numbers came from; that the seed change was predicted to break tests and broke none; which integration files ran, by path; and what this does **not** do (`incomeTier` still unconditional — #167; the dead bypasses kept and filed).

---

## Self-Review

**Spec coverage.** Every section of the spec maps to a task: entity → 2; why-separate-table → 2 (no read sites touched, verified in 10's suite run); two ways a link forms → 5 and 7; email identity and the three arrival states → 5, 11; route table → 3, 4, 5, 6, 10; tombstone hole → 4; oracle → 3, 8; notification/email → 8; seed and database → 10; waitlist → 1; testing → distributed, with the mutation step named per task.

**Gap found and closed during review:** the spec's route table lists `PUT /api/invitations/[id]` but says nothing about editing a *declined* row. Changing its email would sidestep the tombstone exactly as deleting would, so Task 4 Step 5 refuses `PUT` on a declined row with the same 409. Worth carrying back into the spec.

**Type consistency.** `inviteContact`, `acceptInvitation`, `declineInvitation`, `unlinkTeacher`, `resolveInvitationOnLink`, `notifyInvitee` are each defined once and referenced with the same names and shapes throughout. `InviteRefusal` values (`ALREADY_INVITED | ALREADY_LINKED | DECLINED`) match `REFUSAL_MESSAGES`' keys and the codes asserted in Task 3 and 4 tests. `DECLINED_IS_PERMANENT` and `ALREADY_ANSWERED` are route-level codes, deliberately not in `InviteRefusal`.

**Known soft spots, stated rather than hidden.** Task 1's test snippet uses fixture names (`waitlistStudentId`, `fullClassId`, `claimStudentToken`) that must be reconciled with what `waitlist-api.test.ts` actually defines — read its `beforeAll` first. **Resolved during execution, and worse than "rename a few variables":** the file's shared fixtures are deliberately exhausted and mutated by the pre-existing describe block, so reusing them would have order-coupled the new tests to it. The new block owns two students and two classes of its own. The snippet also asserted `200` on the claim route, which returns `201` — corrected above. Task 9 and 11's UI steps are specified by behaviour and copy rather than by markup; that is deliberate, since the design system is the constraint and the component tests pin the wiring.
