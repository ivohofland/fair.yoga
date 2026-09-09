# Decline Suppression Entry Implementation Plan (#522)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a plain decline's refusal survive account erasure, so a teacher
cannot re-invite — and actually email — someone who declined them and then
asked to be forgotten.

**Architecture:** `declineInvitation` writes a `TeacherBlock` alongside its
status CAS, the same durable row `unlinkTeacher` already writes. The refusal
stops being derived from the `Invitation` row's `(teacherId, email)` key, which
erasure rewrites. Nothing else in the delivery path changes: the three existing
block gates already suppress delivery, and `resolveInvitationOnLink` already
deletes blocks on the student's own booking, so the route back needs tests
rather than code.

**Tech Stack:** Next.js 14 App Router, TypeScript strict, Prisma/PostgreSQL,
Vitest (projects: `unit`, `unit-sweeps`, `integration`, `components`).

**Spec:** `docs/superpowers/specs/2026-09-09-decline-suppression-entry-design.md`

## Global Constraints

- **The `TeacherBlock` upsert MUST be `update: {}`.** A real field in `update`
  restores Prisma's atomic, lock-taking path, and that no-lock path is the only
  reason racing `resolveInvitationOnLink` — which takes `TeacherBlock` before
  `Invitation` — does not deadlock. See `docs/lock-order.md`'s standing warning.
- **Write order is `Invitation` then `TeacherBlock`**, per `docs/lock-order.md:7`
  (`… → StudentPrivacy → TeacherStudent → Invitation → TeacherBlock`).
- **Task 4's query reads the declined `Invitation` row, never `TeacherBlock`.**
  This is a privacy requirement: after erasure the block survives and the
  invitation row's email is scrubbed, so reading the block would narrate an
  erased person's history to whoever next controls that address.
- **Task 4's copy states the situation and the action, never the history.**
  `unlinkTeacher` also writes `status: 'declined'`, with no status filter, so a
  row the student *accepted* becomes `declined` on unlink and no column records
  which act set it. "You declined this invitation" would be false for an
  ex-student who left on good terms.
- **Comment discipline (CLAUDE.md).** A comment annotates the code it sits on.
  No prose counts or rosters; no "this previously read X" — the before-and-after
  goes in the PR body.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Never edit an applied migration.** This plan adds none.
- Run `npx vitest run --project <name> <path>` for the inner loop;
  `npm run verify` before pushing (needs the app live on `:3000`).

**Task order is load-bearing.** Task 1 writes the row every later task asserts
on. Task 3 mutates Task 1's upsert. Tasks 2 and 4 are independent of each other.
Task 5 documents what actually landed and goes last.

---

### Task 1: `declineInvitation` writes the suppression entry

**Files:**
- Modify: `src/services/invitations.ts:928-950` (`declineInvitation`)
- Modify: `prisma/seed.ts:396-407` (the declined fixture)
- Create: `src/services/invitations.decline.test.ts`

**Interfaces:**
- Consumes: `inviteContact(db, input) => Promise<{ ok: true; value: InviteResult } | { ok: false; reason: InviteRefusal }>` where `InviteResult = { id: string; delivered: boolean }`; `deleteStudentAccount(db: PrismaClient, studentId: string) => Promise<void>`.
- Produces: `declineInvitation` keeps its signature — `(db, { invitationId, accountEmail }) => Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }>`. Its new post-condition, relied on by Tasks 2 and 3: a successful decline leaves a `TeacherBlock` row for `(invitation.teacherId, accountEmail)`.

- [ ] **Step 1: Write the failing regression test**

Create `src/services/invitations.decline.test.ts`. Follow the header
convention of `src/services/invitations.gate.test.ts` — real `PrismaClient`, a
per-run `suffix` for unique addresses, and the `@/lib/log` mock whose specifier
must match the one `invitations.ts` imports.

**Take the `Teacher`/`Account`/`Student` fixture shape from
`invitations.gate.test.ts` rather than the sketch below.** That file's helpers
already satisfy every non-null column the schema requires; the fields shown
here are illustrative of the *structure*, not a verified column list, and
inventing one risks a create that fails on a required enum default.

```ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { inviteContact, declineInvitation } from './invitations';
import { deleteStudentAccount } from './gdpr';

vi.mock('@/lib/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

describe('a decline writes a suppression entry that survives erasure (#522)', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function makeTeacherAndInvitee() {
    const email = `decliner-${suffix}-${crypto.randomBytes(3).toString('hex')}@example.com`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Tess',
        lastName: 'Teacher',
        email: `teacher-${suffix}-${crypto.randomBytes(3).toString('hex')}@example.com`,
        pageSlug: `tess-${suffix}-${crypto.randomBytes(3).toString('hex')}`,
        bio: '',
        defaultTimezone: 'Europe/Amsterdam',
      },
    });
    const account = await prisma.account.create({ data: { email } });
    const student = await prisma.student.create({
      data: {
        firstName: 'Sam',
        lastName: 'Student',
        email,
        incomeTier: 3,
        accountId: account.id,
        claimedAt: new Date(),
      },
    });
    return { teacher, student, email };
  }

  async function invite(teacherId: string, email: string) {
    const result = await inviteContact(prisma, {
      teacherId,
      email,
      firstName: 'Sam',
      lastName: 'Student',
    });
    if (!result.ok) throw new Error(`invite refused: ${result.reason}`);
    return result.value;
  }

  it('refuses delivery when a declined invitee erases and is re-invited at their real address', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    const declined = await declineInvitation(prisma, {
      invitationId: invitation.id,
      accountEmail: email,
    });
    expect(declined).toEqual({ ok: true });

    // Erasure rewrites Invitation.email, so the (teacherId, email) key the
    // refusal used to live on no longer matches the address the teacher types.
    await deleteStudentAccount(prisma, student.id);

    const reinvited = await invite(teacher.id, email);
    expect(reinvited.delivered).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run --project unit src/services/invitations.decline.test.ts -t 'refuses delivery'`

Expected: FAIL, `expected true to be false` on `reinvited.delivered`. A failure
naming a missing table, a refused invite, or a Prisma validation error means the
fixture is wrong, not that the bug reproduced — fix the fixture and re-run until
the assertion itself is what fails.

- [ ] **Step 3: Write the suppression entry**

In `src/services/invitations.ts`, replace the body of `declineInvitation`
(keeping its existing docblock, which Task 5 updates):

```ts
export async function declineInvitation(
  db: PrismaClient,
  input: { invitationId: string; accountEmail: string },
): Promise<{ ok: true } | { ok: false; reason: 'NOT_FOUND' | 'NOT_PENDING' }> {
  // Same precondition as `acceptInvitation` above: `accountEmail` and
  // `Invitation.email` must already be lowercase for this match to work.
  const email = requireNormalised(input.accountEmail);
  const invitation = await db.invitation.findFirst({
    where: { id: input.invitationId, email },
    select: { id: true, teacherId: true },
  });
  if (!invitation) return { ok: false, reason: 'NOT_FOUND' };

  // The status write and the block are one transaction: a failure between
  // them would leave a declined row whose refusal is once again derived from
  // an `email` erasure can rewrite, and nothing downstream would say so.
  return db.$transaction(async (tx) => {
    // Same reasoning as `acceptInvitation`: the pending check is the `where`
    // on this write, not a separate read beforehand, so a concurrent accept
    // from the same account can't slip past it.
    const updated = await tx.invitation.updateMany({
      where: { id: invitation.id, status: 'pending' },
      data: { status: 'declined', respondedAt: new Date() },
    });
    // No sentinel error, unlike `acceptInvitation`'s `NotPendingError`: that
    // one exists because its roster-link write has already run by this point.
    // Here nothing has been written yet, so returning commits nothing.
    if (updated.count === 0) return { ok: false, reason: 'NOT_PENDING' } as const;

    // `Invitation` before `TeacherBlock`, per `docs/lock-order.md`.
    //
    // `update: {}` is load-bearing, not laziness. An empty update keeps Prisma
    // on the non-atomic path, which takes no row lock when the block already
    // exists; `resolveInvitationOnLink` (services/link-consent.ts) takes these
    // two tables in the opposite order, and that no-lock path is what keeps
    // the pair from deadlocking. `docs/lock-order.md` carries the same warning
    // for `unlinkTeacher`'s upsert, and `invitations-lock-order.test.ts`
    // proves both directions.
    await tx.teacherBlock.upsert({
      where: { teacherId_email: { teacherId: invitation.teacherId, email } },
      update: {},
      create: { teacherId: invitation.teacherId, email },
    });
    return { ok: true } as const;
  });
}
```

- [ ] **Step 4: Run the regression test and confirm it passes**

Run: `npx vitest run --project unit src/services/invitations.decline.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the behaviour-preservation and CAS-miss tests**

Append to the same `describe`. These pin that the fix changes nothing a
non-erased decliner experiences, and that a losing CAS writes no block.

```ts
  it('writes a block for the declining pair', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);

    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).not.toBeNull();
  });

  it('still answers DECLINED to a re-invite before any erasure — the block never reaches that gate', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    const again = await inviteContact(prisma, {
      teacherId: teacher.id,
      email,
      firstName: 'Sam',
      lastName: 'Student',
    });
    expect(again).toEqual({ ok: false, reason: 'DECLINED' });
  });

  it('writes no block when the CAS misses, so a non-pending row cannot silently suppress', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await prisma.teacherBlock.deleteMany({ where: { teacherId: teacher.id, email } });

    // The row is already `declined`, so the CAS matches nothing.
    const second = await declineInvitation(prisma, {
      invitationId: invitation.id,
      accountEmail: email,
    });
    expect(second).toEqual({ ok: false, reason: 'NOT_PENDING' });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });
```

- [ ] **Step 6: Run them**

Run: `npx vitest run --project unit src/services/invitations.decline.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 7: Mutation-test each guard (§3 — break it, record the error, restore)**

Do all three, recording the exact failure text for the PR body. Restore the
file after each and re-run to confirm green before the next.

1. Move the `teacherBlock.upsert` above the `updateMany` → the CAS-miss test
   must fail (a block written for a decline that did not happen).
2. Drop the `if (updated.count === 0)` early return → the CAS-miss test must
   fail on the returned value.
3. Delete the `teacherBlock.upsert` entirely → the regression test and the
   "writes a block" test must both fail.

If any mutation leaves the suite green, the guard it targets is not pinned —
fix the test, not the mutation.

- [ ] **Step 8: Fix the seed's now-inconsistent fixture**

`prisma/seed.ts` creates a declined invitation and no blocks, which is a state
the new invariant forbids. After the `prisma.invitation.createMany` call at
`prisma/seed.ts:396`, add:

```ts
  // The declined fixture's suppression entry. A decline writes one (#522), so
  // seeding the row without it would produce a state the app cannot reach.
  await prisma.teacherBlock.create({
    data: { teacherId: ivo.id, email: 'declined@example.com' },
  });
```

- [ ] **Step 9: Run the seed and confirm it completes**

Run: `npx prisma db seed`
Expected: completes without a unique-constraint error, and the summary line
`Invitations: 3 (2 pending, 1 declined)` still prints.

- [ ] **Step 10: Commit**

```bash
git add src/services/invitations.ts src/services/invitations.decline.test.ts prisma/seed.ts
git commit -m "fix(invitations): write a suppression entry on decline (#522)"
```

---

### Task 2: Pin the route back

**Files:**
- Modify: `src/services/invitations.decline.test.ts`

**Interfaces:**
- Consumes: `declineInvitation`'s Task 1 post-condition (a decline leaves a `TeacherBlock`); `resolveInvitationOnLink(tx, { teacherId, studentEmail, linkOutcome })` from `src/services/link-consent.ts`, where `linkOutcome` is `'created' | 'existing'`.
- Produces: nothing. Tests only.

No production code changes. `POST /api/registrations:251` already calls
`resolveInvitationOnLink` inside `!isTeacher`, and that function already
deletes the block unconditionally. What is new is that a **decline-written**
block travels that path for the first time.

- [ ] **Step 1: Write the pre-erasure route-back test**

Append to `src/services/invitations.decline.test.ts`:

```ts
  it('a booking clears a decline-written block and returns the row to accepted', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    // What POST /api/registrations does inside `!isTeacher` on a booking that
    // created the link — the student's own act, which is the only thing that
    // lifts a block.
    await prisma.$transaction(async (tx) => {
      await resolveInvitationOnLink(tx, {
        teacherId: teacher.id,
        studentEmail: email,
        linkOutcome: 'created',
      });
    });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();

    const row = await prisma.invitation.findUnique({
      where: { id: invitation.id },
      select: { status: true },
    });
    expect(row?.status).toBe('accepted');
  });
```

Add `import { resolveInvitationOnLink } from './link-consent';` to the imports.

- [ ] **Step 2: Write the post-erasure route-back test**

This is the one that only passes *because* the block outlived the scrub — the
returning person signs up fresh on the same address.

```ts
  it('a returning erased decliner clears the surviving block by booking', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await deleteStudentAccount(prisma, student.id);

    // They come back: a new account and Student row on the same address.
    const account = await prisma.account.create({ data: { email } });
    await prisma.student.create({
      data: {
        firstName: 'Sam',
        lastName: 'Student',
        email,
        incomeTier: 3,
        accountId: account.id,
        claimedAt: new Date(),
      },
    });

    await prisma.$transaction(async (tx) => {
      await resolveInvitationOnLink(tx, {
        teacherId: teacher.id,
        studentEmail: email,
        linkOutcome: 'created',
      });
    });

    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).toBeNull();
  });
```

- [ ] **Step 3: Run both**

Run: `npx vitest run --project unit src/services/invitations.decline.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 4: Mutation-test the route back**

These two tests share the `teacherBlock.deleteMany` in
`link-consent.ts:99` with existing unlink-written-block coverage, so a
permissive change could make them pass for the wrong reason. Scope the
`deleteMany` to a `where` that cannot match a decline-written row — add
`createdAt: { lt: new Date(0) }` — and confirm **both** new tests fail. Restore
and re-run.

- [ ] **Step 5: Commit**

```bash
git add src/services/invitations.decline.test.ts
git commit -m "test(invitations): pin that booking clears a decline-written block (#522)"
```

---

### Task 3: Pin the lock order

**Files:**
- Modify: `src/services/invitations-lock-order.test.ts`

**Interfaces:**
- Consumes: `declineInvitation`'s Task 1 upsert.
- Produces: nothing. Tests only.

`src/services/invitations-lock-order.test.ts` already uses exactly this
pattern for `unlinkTeacher`'s upsert — a pair of tests, one proving the real
shape survives the opposite order, one proving a non-empty `update` deadlocks.
Read `it('with the real empty-update upsert, the opposite order does not
currently deadlock…')` at line 211 and its sibling at 257 and follow their
structure: two transactions started concurrently with `Promise.allSettled`,
each taking the two tables in opposing orders.

- [ ] **Step 1: Write the pair**

Add a new `describe` block. The first test races the real `declineInvitation`
against a `resolveInvitationOnLink`-shaped transaction and expects both to
settle without `40P01`. The second replaces the block upsert's `update: {}`
with a real field (`update: { createdAt: new Date() }`) inline in the test's
own transaction, reproducing the mutation, and expects one side to be rejected
with a deadlock error.

Name them for what they prove, matching the file's existing voice:

```
it('a real decline racing a booking-shaped resolve does not deadlock — the empty-update path holds', …)
it('the same race deadlocks once the block upsert carries a real field — why update: {} is load-bearing', …)
```

- [ ] **Step 2: Run them**

Run: `npx vitest run --project unit-sweeps src/services/invitations-lock-order.test.ts`
(this file is in `SERIAL_TESTS` (`vitest.tiers.ts`), which the `unit` project
excludes — `--project unit` exits 1 with "No test files found")
Expected: PASS. If the deadlock test passes without a `40P01`, the race is not
being reproduced — check that both transactions are genuinely concurrent and
that the block row already exists before the race starts (the no-lock path only
applies to an existing row).

- [ ] **Step 3: Commit**

```bash
git add src/services/invitations-lock-order.test.ts
git commit -m "test(invitations): pin the decline path's lock order and update:{} (#522)"
```

---

### Task 4: Make the route back discoverable

**Files:**
- Modify: `src/services/invitations.ts` (add `listDeclinedTeachers` beside `listPendingInvitations` at `:717`)
- Modify: `src/app/(student)/account/privacy/page.tsx`
- Modify: `src/components/student/pending-invitation-card.tsx:107-121`
- Modify: `src/components/student/pending-invitation-card.test.tsx`
- Create: `src/services/invitations.declined-teachers.test.ts`

**Interfaces:**
- Produces: `listDeclinedTeachers(db: PrismaClient, input: { accountEmail: string }) => Promise<Array<{ id: string; teacher: { firstName: string; lastName: string; pageSlug: string } }>>`

- [ ] **Step 1: Write the failing service test**

Create `src/services/invitations.declined-teachers.test.ts` with the same
header convention as Task 1's file. Three cases, the second of which is the
privacy requirement:

```ts
  it('lists a teacher whose invitation this account declined', async () => {
    const { teacher, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });

    const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
    expect(rows.map((r) => r.teacher.pageSlug)).toContain(teacher.pageSlug);
  });

  it('lists nothing once the account is erased, even though the block survives', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await deleteStudentAccount(prisma, student.id);

    // The block is still there — it is what keeps the suppression working.
    const block = await prisma.teacherBlock.findUnique({
      where: { teacherId_email: { teacherId: teacher.id, email } },
      select: { id: true },
    });
    expect(block).not.toBeNull();

    // The narrative is not. A new account on this address learns nothing
    // about the erased person's refusal.
    const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
    expect(rows).toEqual([]);
  });

  it('lists nothing for a pair that is currently linked', async () => {
    const { teacher, student, email } = await makeTeacherAndInvitee();
    const invitation = await invite(teacher.id, email);
    await declineInvitation(prisma, { invitationId: invitation.id, accountEmail: email });
    await prisma.teacherStudent.create({ data: { teacherId: teacher.id, studentId: student.id } });

    const rows = await listDeclinedTeachers(prisma, { accountEmail: email });
    expect(rows).toEqual([]);
  });
```

- [ ] **Step 2: Run and confirm it fails**

Run: `npx vitest run --project unit src/services/invitations.declined-teachers.test.ts`
Expected: FAIL — `listDeclinedTeachers` is not exported.

- [ ] **Step 3: Implement the query**

Add to `src/services/invitations.ts`, directly after `listPendingInvitations`:

```ts
/**
 * The teachers this account has a standing refusal against, for the student's
 * own settings page.
 *
 * Reads the `declined` `Invitation` row, never `TeacherBlock`. The block is
 * what makes the refusal work and it deliberately outlives erasure (#522);
 * the invitation row is the only part that may be narrated back to anyone,
 * because erasure scrubs its `email` and a later account on the same address
 * therefore matches nothing here.
 *
 * The `deletedAt` and already-linked exclusions mirror
 * `listPendingInvitations` above, and for the same reasons — a teacher who
 * added this student to their roster is not someone to describe as not
 * connected.
 */
export async function listDeclinedTeachers(
  db: PrismaClient,
  input: { accountEmail: string },
): Promise<Array<{ id: string; teacher: { firstName: string; lastName: string; pageSlug: string } }>> {
  const email = requireNormalised(input.accountEmail);
  return db.invitation.findMany({
    where: {
      email,
      status: 'declined',
      teacher: {
        deletedAt: null,
        teacherStudents: { none: { student: { email } } },
      },
    },
    select: {
      id: true,
      teacher: { select: { firstName: true, lastName: true, pageSlug: true } },
    },
    orderBy: { teacher: { firstName: 'asc' } },
  });
}
```

- [ ] **Step 4: Run and confirm it passes**

Run: `npx vitest run --project unit src/services/invitations.declined-teachers.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Mutation-test the privacy requirement**

Change the `where` to read the block instead — `teacher: { teacherBlocks: { some: { email } } }` in place of the `status: 'declined'` filter — and confirm the "lists nothing once the account is erased" test fails. This is the mutation that matters: it proves the test would catch someone "simplifying" the query to the block. Restore and re-run.

- [ ] **Step 6: Render the section**

In `src/app/(student)/account/privacy/page.tsx`, add `listDeclinedTeachers` to
the existing `Promise.all` (it already destructures
`[links, privacyRows, pendingInvitations]`), then render a section between
"Pending invitations" and "Your teachers":

```tsx
      {declinedTeachers.length > 0 && (
        <div className="mb-6">
          <h2 className="type-subtitle mb-3">Not connected</h2>
          <div className="flex flex-col gap-4">
            {declinedTeachers.map((row) => (
              <div key={row.id} className="bg-sand-soft border border-line rounded-2xl p-4">
                <h3 className="type-label text-ink font-semibold mb-2">
                  {row.teacher.firstName} {row.teacher.lastName}
                </h3>
                <p className="type-body mb-3">
                  This teacher can&apos;t invite you again. Booking one of their
                  classes will connect you.
                </p>
                <Link href={`/${row.teacher.pageSlug}`} className="type-label text-teal">
                  View their classes
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}
```

Match the surrounding card classes to whatever `PendingInvitationCard` and
`TeacherPrivacyCard` actually use — read them rather than trusting the sketch
above, and keep the `h3`-under-`h2` heading structure the file's own comment at
the "Your teachers" heading explains.

- [ ] **Step 7: Add the decline-time sentence**

In `src/components/student/pending-invitation-card.tsx`, add a sibling
paragraph inside the `confirmingDecline` branch, after the existing
`<p className="type-body">` at line 109 and before the button row:

```tsx
          <p className="type-caption mb-3">
            You can connect later by booking one of their classes.
          </p>
```

Neutral about history by construction — it describes the route back, and says
nothing this card could get wrong. Do not add it to the non-confirming branch:
a student who has not chosen to decline should not be read a consolation.

- [ ] **Step 8: Update the card test**

`src/components/student/pending-invitation-card.test.tsx` asserts on the
confirm copy. Add both directions, so the sentence cannot drift into the
always-visible state:

```tsx
  it('offers the route back only once declining is being confirmed', async () => {
    render(<PendingInvitationCard invitationId="i1" teacherName="Tess Teacher" />);

    expect(screen.queryByText(/booking one of their classes/i)).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: /decline/i }));

    expect(screen.getByText(/booking one of their classes/i)).toBeInTheDocument();
  });
```

Match the file's existing render/query idiom — it may already have a helper and
its own `userEvent` setup.

- [ ] **Step 9: Run the component tests**

Run: `npx vitest run --project components src/components/student/pending-invitation-card.test.tsx`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/services/invitations.ts src/services/invitations.declined-teachers.test.ts "src/app/(student)/account/privacy/page.tsx" src/components/student/pending-invitation-card.tsx src/components/student/pending-invitation-card.test.tsx
git commit -m "feat(invitations): surface the route back from a decline (#522)"
```

---

### Task 5: Correct every artifact that states the old rule

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/data-model.md`
- Modify: `src/services/gdpr.ts` (docblock ~325, `TeacherBlock` comment ~623)
- Modify: `src/services/invitations.ts` (`declineInvitation`'s docblock)
- Modify: `docs/lock-order.md`

**Interfaces:** none. Documentation only.

Per `solve-issue` §4, a claim is corrected everywhere it appears, and by
**replacement** — not by annotating what it used to say.

- [ ] **Step 1: Sweep for the claim**

```bash
grep -rn "plain decline" CLAUDE.md docs/ src/
grep -rn "only an unlink writes one" CLAUDE.md docs/ src/
grep -rn "tombstone" CLAUDE.md docs/ src/ | grep -v node_modules
```

Give every hit a verdict. Expect legitimate survivors — the `Invitation` row
is still a tombstone for the `DECLINED` gate; what changed is that it is no
longer the *only* thing holding the refusal.

- [ ] **Step 2: Correct the four prose sites**

- `CLAUDE.md`, Data Model section: "a plain decline does not; the declined
  `Invitation` row is itself the tombstone that blocks a re-invite" — now both
  paths write a `TeacherBlock`; the declined row still drives the `DECLINED`
  answer.
- `docs/data-model.md`, `TeacherBlock` section: "Written only when a student
  unlinks…" and the parked-retention paragraph, which becomes **one** question
  covering both paths rather than two divergent behaviours.
- `docs/data-model.md` design note (the "Invitation and TeacherBlock" bullet):
  "a bare decline blocks re-invites without a `TeacherBlock` row, only an
  unlink writes one".
- `src/services/invitations.ts`: `declineInvitation`'s docblock, which says the
  declined row *is* the tombstone.

- [ ] **Step 3: Correct the two `gdpr.ts` comments**

- The docblock at ~325: "`Invitation` rows naming this address anonymized in
  place, keeping the teacher's filing state without the identity behind it —
  but NOT their refusal, which this frees (#522)". The refusal is no longer
  freed; the retained `TeacherBlock` holds it.
- The `TeacherBlock` comment at ~623: its conclusion (do not touch blocks here)
  is unchanged, but its framing is — retention now covers both refusal paths,
  and the open question is one question. Keep it annotating this code only; the
  full reasoning lives in `docs/data-model.md`, which it already links.

- [ ] **Step 4: Add the rule**

In `docs/data-model.md`, beside the `TeacherBlock` section, state the rule this
issue produced: a refusal is a row, never a derived key — with the columns
`deleteStudentAccount` rewrites as the check. Three doors (`PUT`, `DELETE`,
erasure) were found one at a time; the rule is what catches the fourth.

- [ ] **Step 5: Update `docs/lock-order.md`**

Add `declineInvitation` to the known-conformance list, and extend the standing
`update: {}` warning so it names both upserts rather than only
`unlinkTeacher`'s.

- [ ] **Step 6: Verify the sweep found everything**

Re-run Step 1's greps and confirm every remaining hit is a deliberate survivor.
Then derive a second sweep from the branch's own diff, not from a keyword:

```bash
git diff main --stat
```

List what changed, list what was supposed to change, reconcile the two.

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/data-model.md docs/lock-order.md src/services/gdpr.ts src/services/invitations.ts
git commit -m "docs(invitations): a refusal is a row, not a derived key (#522)"
```

---

## Before pushing

- [ ] `npm run verify` — typecheck, lint, and every vitest project. Needs the
      dev server live on `:3000`; **never kill or restart it** — if one is
      running it is the user's.
- [ ] If `verify` goes red anywhere, run `npx vitest run --project integration`
      directly before reporting anything about that tier: `npm test` chains
      with `&&`, so an earlier failure means integration reports *nothing*,
      not zero failures.
- [ ] PR body records what was measured, the mutation-test error texts from
      Task 1 Step 7, Task 2 Step 4, Task 3 and Task 4 Step 5, and what the
      corrected comments used to say. Name `#522`. Both spin-outs (hashing
      `TeacherBlock.email`, the invitee landing surface) were considered and
      deliberately not filed — the spec records why.
