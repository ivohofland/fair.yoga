# Gate `ALREADY_LINKED` on `shareEmail` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `POST /api/students` confirming, to a teacher who may not see a student's email, that a typed address belongs to one of their own students.

**Architecture:** `inviteContact` answers `ALREADY_LINKED` only when the pair is linked *and* the teacher could already have that address — either `StudentPrivacy.shareEmail` is true for the pair, or an accepted `Invitation` for that exact `(teacherId, email)` already exists. Otherwise it falls through and creates a real, undelivered invitation, so the response is indistinguishable from inviting a stranger. Two suppressions keep that fall-through from reaching the already-linked student: `notifyInvitee` skips a linked pair, and `listPendingInvitations` excludes one.

**Tech Stack:** TypeScript (strict), Next.js App Router, Prisma/PostgreSQL, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-03-already-linked-email-confirmation-design.md` — read it first; this plan argues from it and does not repeat its reasoning.

## Global Constraints

- **TypeScript `strict: true`.** No `any`, no implicit types.
- **Test-first.** Every task writes the failing test, runs it, sees it fail for the stated reason, then implements.
- **No migration.** This change adds no column and no constraint. Do not touch `prisma/schema.prisma` or `prisma/migrations/`.
- **`integration` and `e2e` cannot run in this worktree** — both need the dev server on `:3000` and the shared dev database. Run `npx vitest run --project unit <path>` and `--project components`. Task 4's tests are written here and verified by CI.
- **The `unit` project DOES run here**, against `ethical_yoga_test`. Service tests are runnable locally.
- **Never `git add -A` or `git add .`** — stage exact paths.
- **Comment discipline (CLAUDE.md).** Correct a claim by *replacing* it, never by annotating it ("this previously read X" is forbidden). A comment states what is true now. The before/after belongs in the PR body.
- **Never restart or kill the dev server on `:3000`.**

## Task order is load-bearing

Tasks 1 and 2 are the suppressions; Task 3 is the change that makes them necessary. Landing 3 first would leave a commit in which an already-linked student receives a false *"A teacher would like to connect"* notification and sees a bogus card on their own privacy page. Do not reorder.

---

### Task 1: `notifyInvitee` skips an already-linked pair

**Files:**
- Modify: `src/services/invitations.ts` — `notifyInvitee` (~`:380`) and its docblock (~`:315-379`)
- Test: `src/services/invitations.notify.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `notifyInvitee(db: PrismaClient, input: { teacherId: string; email: string; teacherName: string }): Promise<void>` — signature unchanged. Task 3 relies on this suppression existing.

**Why this is required, not defence in depth:** `POST /api/invitations/[id]/resend` gates only on `declined` and `not pending`, then calls `deliverInvitation` unconditionally. Without this guard a teacher could resend the invitation Task 3 creates and deliver it to a student they are already connected to.

- [ ] **Step 1: Write the failing test**

Append to the `describe` block in `src/services/invitations.notify.test.ts`. It follows the file's existing student idiom (no `accountId`/`claimedAt` — `Student_claim_link_check` permits both null):

```ts
  it('sends nothing at all to a student already on this teacher\'s roster (#412)', async () => {
    // The fall-through invitation #412's gate creates is a real, pending row,
    // so `POST /api/invitations/[id]/resend` can reach it — and that route
    // gates only on `declined`/`not pending` before calling
    // `deliverInvitation`. The guard under test is therefore the only thing
    // standing between a resend and a "would like to connect" notification
    // sent to someone already connected.
    const email = `notify-linked-${suffix}@test.local`;
    let studentId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Notify', lastName: 'Linked', email,
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;

      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher' });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      });
      expect(notifications).toHaveLength(0);
      // Not merely "no notification": the unregistered branch below it must
      // not fire either, or the student gets a stranger's sign-up email for
      // a teacher they already have.
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run --project unit src/services/invitations.notify.test.ts`

Expected: FAIL on `expect(notifications).toHaveLength(0)` receiving `1` — today a linked, registered student takes the `createNotification` branch like any other registered invitee. If it fails on `sendMock` instead, the fixture is wrong (a Student row exists, so the email branch should be unreachable).

- [ ] **Step 3: Implement**

In `notifyInvitee`, widen the existing `Student` lookup and add the guard. Replace:

```ts
  const student = await db.student.findUnique({
    where: { email },
    select: { id: true },
  });

  if (student) {
```

with:

```ts
  const student = await db.student.findUnique({
    where: { email },
    select: {
      id: true,
      teacherStudents: { where: { teacherId: input.teacherId }, select: { id: true } },
    },
  });

  if (student) {
    // Already on this teacher's roster: there is no connection left to ask
    // for, and #412's gate creates real pending invitations for exactly this
    // pair rather than refuse them. "A teacher would like to connect" is
    // false here, and the decline it invites does not unlink —
    // `declineInvitation` writes only the tombstone — so a student acting on
    // it would stay linked and permanently block a re-invite they might
    // later want.
    //
    // Structural, like the `TeacherBlock` re-check above and for the same
    // reason: `POST /api/invitations/[id]/resend` gates only on `declined`
    // and `not pending` before calling `deliverInvitation`, so a guard
    // living only in `inviteContact`'s `delivered` value would not survive a
    // resend.
    if (student.teacherStudents.length > 0) return;
```

- [ ] **Step 4: Run the whole file and confirm green**

Run: `npx vitest run --project unit src/services/invitations.notify.test.ts`

Expected: PASS, 5 tests. The four pre-existing tests create no `TeacherStudent` rows, so none of them reaches the new branch.

- [ ] **Step 5: Prove the guard bites**

Delete the `if (student.teacherStudents.length > 0) return;` line, re-run, record the exact failure text in the commit message or task ledger, then restore and re-run. A guard that has never failed certifies nothing.

- [ ] **Step 6: Correct `notifyInvitee`'s docblock**

Its docblock (~`:315-379`) describes the send-channel decision and must now state the link skip. Add a paragraph stating what is true now — do not narrate the change:

```
 * A pair that is already linked gets nothing at all. #412's gate creates a
 * real pending invitation rather than refuse one for a student whose address
 * this teacher may not see, and this is what keeps that row from reaching
 * the invitee: "would like to connect" is false for someone already
 * connected, and declining it would not unlink them. The check lives here
 * rather than in the caller because `POST /api/invitations/[id]/resend`
 * calls this function for any pending row without one.
```

- [ ] **Step 7: Commit**

```bash
git add src/services/invitations.ts src/services/invitations.notify.test.ts
git commit -m "fix(invitations): send nothing to an invitee already on the roster

Groundwork for #412: the gate that lands next creates real pending
invitations for already-linked pairs, and resend would otherwise deliver
them.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: `listPendingInvitations` excludes an already-linked pair

**Files:**
- Modify: `src/services/invitations.ts` — `listPendingInvitations` (~`:518`) and its docblock (~`:489-517`)
- Test: `src/services/invitations.pending.test.ts` (including its file docblock, `:9-29`)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `listPendingInvitations(db: PrismaClient, input: { accountEmail: string })` — signature and return type unchanged.

**Note:** this file currently creates **no** `Student` or `TeacherStudent` rows at all — every fixture is an invitation to an address with nothing behind it. The new test introduces that shape, so it must clean up a Student row as well as an invitation.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('listPendingInvitations', …)`:

```ts
  it('excludes a pending invitation to someone already on that teacher\'s roster (#412)', async () => {
    // The state #412's gate creates: a real pending invitation for a pair
    // that is already linked. Rendered, it puts the same teacher in "Pending
    // invitations" and "Your teachers" on one page, and offers a decline
    // that does not unlink.
    const email = `pending-list-linked-${suffix}@test.local`;
    let studentId: string | undefined;
    let invitationId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Already', lastName: 'Linked', email,
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Already', lastName: 'Linked' },
        select: { id: true },
      });
      invitationId = invitation.id;

      expect(await listPendingInvitations(prisma, { accountEmail: email })).toEqual([]);

      // The control: the exclusion must be about THIS pair's link, not about
      // the teacher having any linked student at all. `otherTeacherId` has
      // no link to this student, so its invitation to the same address still
      // shows.
      const otherInvitation = await prisma.invitation.create({
        data: { teacherId: otherTeacherId, email, firstName: 'Already', lastName: 'Linked' },
        select: { id: true },
      });
      try {
        const result = await listPendingInvitations(prisma, { accountEmail: email });
        expect(result.map((r) => r.id)).toEqual([otherInvitation.id]);
      } finally {
        await prisma.invitation.deleteMany({ where: { id: otherInvitation.id } });
      }
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

Run: `npx vitest run --project unit src/services/invitations.pending.test.ts`

Expected: FAIL on the first assertion — `expect(…).toEqual([])` receives an array of one invitation, because nothing filters on the link today.

- [ ] **Step 3: Implement**

In `listPendingInvitations`, add the exclusion inside the existing `teacher` filter — `Invitation` has no link relation of its own, so `Teacher.teacherStudents` is the edge:

```ts
    where: {
      email,
      status: 'pending',
      teacher: {
        deletedAt: null,
        teacherBlocks: { none: { email } },
        teacherStudents: { none: { student: { email } } },
      },
    },
```

No `isArchived` condition: archiving is the teacher's own filing action on their CRM view and does not end the link, the same reading `(student)/account/privacy/page.tsx` already applies when it lists teachers by existence.

- [ ] **Step 4: Run the whole file and confirm green**

Run: `npx vitest run --project unit src/services/invitations.pending.test.ts`

Expected: PASS, 8 tests. The seven pre-existing tests create no Student rows, so no address in them can be "already linked".

- [ ] **Step 5: Prove the guard bites — twice**

Two mutations, each restored after recording the exact failure text:

1. Remove the `teacherStudents: { none: … }` line → the first assertion goes red.
2. Weaken it to `teacherStudents: { none: {} }` → the **control** assertion goes red (it would hide every invitation from a teacher who has any student at all). Mutation 1 alone would pass under this, which is why the control is in the test.

- [ ] **Step 6: Correct both docblocks**

`listPendingInvitations`'s own docblock (~`:489-517`) frames the block exclusion as "the PRIMARY gate". Add the sibling, stating what is true now:

```
 * The already-linked exclusion is the other half, and it is likewise the
 * only gate: #412's `inviteContact` creates a real pending invitation for a
 * pair whose link it may not confirm, and this is what keeps that row off
 * the student's page. Rendered, it would sit above "Your teachers" naming a
 * teacher already listed there, and offer a decline that does not unlink.
```

The **file** docblock (`:9-29`) lists the mutations the tests are written to catch. It is now one short — add the `none: {}` mutation from Step 5 to that list, so the roster matches what the file actually defends.

- [ ] **Step 7: Commit**

```bash
git add src/services/invitations.ts src/services/invitations.pending.test.ts
git commit -m "fix(invitations): keep an already-linked pair off the pending list

Groundwork for #412, and it closes the pre-existing case too: PUT
/api/invitations/[id] can already point a pending row at a linked
student, and the card rendered above 'Your teachers' offers a decline
that does not unlink.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: The gate — `rosterLinkState` and `delivered`

**Files:**
- Modify: `src/services/invitations.ts` — `hasRosterLink` → `rosterLinkState` (~`:79-119`), the call site in `inviteContact` (~`:193-195`), the `delivered` computation (~`:265`), and four docblocks
- Modify: `src/services/invitations.revive.test.ts` — the comment at `:101-107` only
- Test: `src/services/invitations.gate.test.ts` (create)

**Interfaces:**
- Consumes: Tasks 1 and 2's suppressions must already be in place.
- Produces:
  ```ts
  interface RosterLinkState { linked: boolean; shareEmail: boolean }
  async function rosterLinkState(
    db: PrismaClient, teacherId: string, email: string,
  ): Promise<RosterLinkState>
  ```
  Module-private, like `hasRosterLink` was. `InviteResult` is unchanged in shape; only what sets `delivered` to `false` widens.

**CONSTRAINT — do not collapse the lookup into a `teacherStudent` query.** `rosterLinkState` **must** keep `db.student.findUnique({ where: { email } })` as its first and only statement. `invitations.revive.test.ts:97` makes a race deterministic by hooking `student.findUnique` through a Prisma client extension; rewriting this as, say, `teacherStudent.findFirst({ where: { teacherId, student: { email } } })` means the hook never fires and two tests break with misleading failures (`CONTACT_CHANGED` becomes `ALREADY_LINKED`). The nested-select shape below was executed against the real test database before this plan was written.

- [ ] **Step 1: Write the failing tests**

Create `src/services/invitations.gate.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { inviteContact } from './invitations';

const prisma = new PrismaClient();
const suffix = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

/**
 * #412. `ALREADY_LINKED` is a distinct, teacher-visible outcome, so answering
 * it on the strength of the link alone confirmed that a typed address belongs
 * to one of this teacher's students — a fact `projectStudentForTeacher`
 * (lib/student-visibility.ts) returns as `null` everywhere else once the
 * student has withheld it.
 *
 * A hit costs nothing and leaves nothing: `inviteContact` returns before any
 * write, and the route answers 409 before both the `lastNotifiedAt` write and
 * `deliverInvitation`. That is why the targeted case — testing one guessed
 * address against one suspected student — is the one worth closing, and it is
 * what these tests are written against.
 */
describe('inviteContact — the shareEmail gate on ALREADY_LINKED (#412)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  const studentIds: string[] = [];

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Gate', lastName: 'Teacher',
        email: `gate-teacher-${suffix}@test.local`,
        account: { create: { email: `gate-teacher-${suffix}@test.local` } },
        bio: '#412 shareEmail gate fixture',
        pageSlug: `gate-teacher-${suffix}`,
      },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
  });

  afterAll(async () => {
    if (studentIds.length) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.studentPrivacy.deleteMany({ where: { studentId: { in: studentIds } } });
      await prisma.student.deleteMany({ where: { id: { in: studentIds } } });
    }
    if (teacherId) {
      await prisma.invitation.deleteMany({ where: { teacherId } });
      await prisma.teacherBlock.deleteMany({ where: { teacherId } });
      await prisma.teacher.delete({ where: { id: teacherId } });
      await prisma.account.delete({ where: { id: teacherAccountId } });
    }
    await prisma.$disconnect();
  });

  /** A student on this teacher's roster, with the privacy row this test wants. */
  async function seedLinked(
    label: string,
    privacy: { shareEmail: boolean } | null,
    opts: { linked?: boolean } = {},
  ): Promise<string> {
    const email = `gate-${label}-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: {
        firstName: 'Gate', lastName: label, email,
        ...(opts.linked === false ? {} : { teacherStudents: { create: { teacherId } } }),
        ...(privacy ? { studentPrivacy: { create: { teacherId, ...privacy } } } : {}),
      },
      select: { id: true },
    });
    studentIds.push(student.id);
    return email;
  }

  it('does not answer ALREADY_LINKED when the student has not shared their email', async () => {
    const email = await seedLinked('unshared', null);

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    // The whole point: an ordinary, indistinguishable success. The row must
    // genuinely be created — "did a new contact appear in my list?" is itself
    // a yes/no channel carrying the bit being withheld.
    if (!result.ok) throw new Error(`expected a fall-through invite, got ${result.reason}`);
    expect(result.value.delivered).toBe(false);
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: { status: true },
    });
    expect(row.status).toBe('pending');
  });

  it('treats an explicit shareEmail: false exactly as a missing privacy row', async () => {
    const email = await seedLinked('explicit-false', { shareEmail: false });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result.ok).toBe(true);
  });

  it('answers ALREADY_LINKED when the student HAS shared their email with this teacher', async () => {
    const email = await seedLinked('shared', { shareEmail: true });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Already', lastName: 'Mine',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    // A refusal, not a refusal-shaped success.
    expect(
      await prisma.invitation.findUnique({ where: { teacherId_email: { teacherId, email } } }),
    ).toBeNull();
  });

  it('does not answer ALREADY_LINKED for a shared address that is NOT on the roster', async () => {
    // Pins the `linked &&` conjunct. Without it, `shareEmail: true` alone
    // would refuse an invitation to someone this teacher has never had.
    const email = await seedLinked('shared-unlinked', { shareEmail: true }, { linked: false });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Not', lastName: 'Mine',
    });

    expect(result.ok).toBe(true);
  });

  it('answers ALREADY_LINKED on an accepted invitation, and leaves that row untouched', async () => {
    // The second disjunct. It exists to keep the gated path out of
    // `revivePendingInvitation`, which would flip this row to `pending`
    // (rendering it as an outstanding "Invited" contact for someone already
    // in the directory), clear `isArchived`, and overwrite the names.
    const email = await seedLinked('accepted', null);
    const acceptedAt = new Date('2026-01-02T03:04:05.000Z');
    await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Original', lastName: 'Name',
        status: 'accepted', respondedAt: acceptedAt, isArchived: true,
      },
    });

    const result = await inviteContact(prisma, {
      teacherId, email, firstName: 'Rewritten', lastName: 'Name',
    });

    expect(result).toEqual({ ok: false, reason: 'ALREADY_LINKED' });
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email } },
      select: {
        status: true, respondedAt: true, isArchived: true,
        firstName: true, lastName: true,
      },
    });
    expect(row).toEqual({
      status: 'accepted',
      respondedAt: acceptedAt,
      isArchived: true,
      firstName: 'Original',
      lastName: 'Name',
    });
  });
});
```

- [ ] **Step 2: Run and confirm the right failures**

Run: `npx vitest run --project unit src/services/invitations.gate.test.ts`

Expected: **exactly 2 of the 5 fail.**

| test | today | why |
|---|---|---|
| `…when the student has not shared their email` | **FAIL** — `expected a fall-through invite, got ALREADY_LINKED` | refuses on the link alone |
| `…explicit shareEmail: false exactly as a missing privacy row` | **FAIL** — `expect(result.ok).toBe(true)` receives `false` | same |
| `…when the student HAS shared their email` | PASS | today refuses, and it still must |
| `…for a shared address that is NOT on the roster` | PASS | unlinked, so never refused today either |
| `…on an accepted invitation, and leaves that row untouched` | PASS | today refuses before the revive |

The asymmetry is intended: two tests pin the new behaviour, three pin behaviour that must survive the change. If any of the three PASS rows is red before you start, the fixture is wrong — stop and fix it, because a test that was already failing proves nothing about your implementation.

- [ ] **Step 3: Implement `rosterLinkState`**

Replace `hasRosterLink` (`:103-119`) entirely:

```ts
interface RosterLinkState {
  /** A `TeacherStudent` row joins this teacher to the Student owning `email`. */
  linked: boolean;
  /** This teacher's `StudentPrivacy.shareEmail` for that student. */
  shareEmail: boolean;
}

async function rosterLinkState(
  db: PrismaClient,
  teacherId: string,
  email: string,
): Promise<RosterLinkState> {
  const student = await db.student.findUnique({
    where: { email },
    select: {
      teacherStudents: { where: { teacherId }, select: { id: true } },
      studentPrivacy: { where: { teacherId }, select: { shareEmail: true } },
    },
  });
  if (!student) return { linked: false, shareEmail: false };

  return {
    linked: student.teacherStudents.length > 0,
    // A missing row reads as `false`, matching
    // `projectStudentForTeacher`'s own `flags?.shareEmail ?? false` and the
    // promise on /account/privacy that new teachers start with nothing shared.
    shareEmail: student.studentPrivacy[0]?.shareEmail ?? false,
  };
}
```

- [ ] **Step 4: Implement the gate and `delivered`**

Replace the call site (`:193-195`):

```ts
  const link = await rosterLinkState(db, teacherId, email);
  if (link.linked && (link.shareEmail || existing !== null)) {
    return { ok: false, reason: 'ALREADY_LINKED' };
  }
```

and the `delivered` computation at the end of `inviteContact` (`:265`):

```ts
  return { ok: true, value: { id: invitationId, delivered: blocked === null && !link.linked } };
```

- [ ] **Step 5: Run the file, then the whole unit project**

Run: `npx vitest run --project unit src/services/invitations.gate.test.ts`
Expected: PASS, 5 tests.

Run: `npx vitest run --project unit`
Expected: all green. `invitations.revive.test.ts` in particular must stay green — if it does not, the CONSTRAINT above was violated and `student.findUnique` is no longer the first query.

- [ ] **Step 6: Prove each conjunct bites**

Three mutations, each restored after recording the exact failure text:

1. Drop `link.shareEmail` from the predicate (refuse whenever linked) → `does not answer ALREADY_LINKED when the student has not shared their email` goes red.
2. Drop `|| existing !== null` → `answers ALREADY_LINKED on an accepted invitation…` goes red on the **row contents**, not only the reason, because the revive rewrites `status`, `isArchived` and the names.
3. Drop `link.linked &&` → `does not answer ALREADY_LINKED for a shared address that is NOT on the roster` goes red.

- [ ] **Step 7: Correct the four docblocks in `invitations.ts`**

State what is true now; do not narrate the change.

1. **`rosterLinkState`'s docblock** (replacing `hasRosterLink`'s at `:79-102`) — issue acceptance criterion 2. It must keep the #166 property and add the #167 one:

```
/**
 * Is this address on this teacher's roster, and may this teacher be told?
 *
 * Two facts rather than one verdict: the caller composes the policy, and
 * `inviteContact` needs `linked` again below to decide whether delivery is
 * withheld.
 *
 * Both fields read `false` for "no Student row" and for "Student row, no
 * link" alike, and that is a property rather than an implementation detail:
 * the caller must not be able to tell those two apart, or it becomes the
 * account-enumeration oracle the old `POST /api/students` was (#166).
 *
 * `shareEmail` is the second property (#412), and it is about a different
 * thing: #167 made `Student.email` per-teacher redacted, so a teacher who
 * may not see an address must not be handed a confirmation of one they
 * typed. Answering `ALREADY_LINKED` on the strength of the link alone told
 * them a guessed address belongs to one of their own students — which
 * `projectStudentForTeacher` (lib/student-visibility.ts) returns as `null`
 * on every other surface. A missing `StudentPrivacy` row reads as `false`.
 *
 * ONE query, and `student.findUnique` must stay the first statement in it:
 * `invitations.revive.test.ts` hooks that call through a Prisma extension to
 * close a race window deterministically, and a rewrite that reached
 * `TeacherStudent` first would silently stop that test testing anything.
 *
 * A plain, case-SENSITIVE `findUnique`, safe because both sides are
 * guaranteed lowercase (#170): this `email` already passed through
 * `requireNormalised` at the caller, and `Student.email` can only hold
 * lowercase — `Student_email_lowercase_check` rejects anything else at rest.
 */
```

2. **`InviteResult.delivered`** (`:28-41`) — its opening sentence, "False when a `TeacherBlock` exists for this (teacher, email) pair, true otherwise", is now untrue. Replace that sentence (keep the rest of the docblock, which is still accurate about the caller's gate and about staleness):

```
 * False when delivery must be withheld — either a `TeacherBlock` exists for
 * this (teacher, email) pair, or the pair is already linked and #412's gate
 * declined to say so. True otherwise.
```

3. **`inviteContact`'s docblock** (`:121-150`) — its "one residual channel … issues one extra query" paragraph describes a two-query shape that no longer exists. The residual is now smaller: state that the lookup is a single query, so the "Student exists but is not on this teacher's roster" path no longer costs an extra round trip, and that closing the remainder would still mean dummy queries. Keep "Do not add a branch on whether a Student row was found" verbatim — it is still the load-bearing instruction.

4. **The `accepted`-row comment inside `inviteContact`** (`:179-192`) — the F8 reasoning still holds and must stay. Add that an accepted row is now also the second disjunct of the refusal, and why: it keeps a gated pair out of the revive, which would otherwise resurrect an archived contact under rewritten names.

- [ ] **Step 8: Correct the stale comment in `invitations.revive.test.ts`**

`:101-107` names `hasRosterLink`'s "first query" and explains the hook is placed there "rather than on `teacherStudent.findUnique` because that second query only runs when a Student row exists". After this task there is no second query. Rewrite it to name `rosterLinkState`, and state the reason that is now true: it is the only query, and the window must close whether or not a Student row exists. Do not change any test code in this file.

- [ ] **Step 9: Typecheck, lint, and commit**

```bash
npx tsc --noEmit
npm run lint
git add src/services/invitations.ts src/services/invitations.gate.test.ts src/services/invitations.revive.test.ts
git commit -m "fix(security): gate ALREADY_LINKED on the student's shareEmail (#412)

POST /api/students confirmed a caller-typed address against a
per-teacher redacted Student.email. It now refuses only when the
teacher could already have that address — shareEmail, or an accepted
invitation they sent themselves — and otherwise creates a real,
undelivered invitation so the answer is indistinguishable.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: The HTTP tier — repair the one broken test, add the acceptance test

**Files:**
- Modify: `tests/integration/students-api.test.ts` — the test at `:322` and its comment at `:316-321`; add one new test
- Modify: `tests/integration/invitations-api.test.ts` — the comment at `:2446-2451` only

**Interfaces:**
- Consumes: Task 3's gate.
- Produces: nothing later tasks depend on.

**These tests cannot run in this worktree** (`integration` needs the dev server on `:3000` and the shared dev database). Write them, verify by inspection against the fixtures named below, and let CI be the signal. The PR body cites the CI run for this tier.

**Census result, so the implementer does not re-derive it:** exactly one existing test breaks. Every other test across `students-api`, `invitations-api`, `invitation-constraints`, `privacy-page`, `notifications-stream`, the e2e specs and the component tests survives, because their fixtures create no `TeacherStudent` row for the address under test. `invitations-api.test.ts:1691` survives on the new second disjunct — it seeds an `accepted` invitation *and* a link.

- [ ] **Step 1: Repair the breaking test**

`students-api.test.ts:322` reuses `studentIds[0]`, one of the 25 students the file's `beforeAll` links to `teacherId` with **no `StudentPrivacy` row** — so after Task 3 it falls through and answers `201`. Three assertions fail: `:338` (`409` receives `201`), `:340` (`json.error` is `undefined`, throwing a TypeError) and `:344-348` (the invitation is no longer `null`).

Restore its original intent by giving the pair a shared email. The privacy row **must** be removed in a `finally`: this file's `GET /api/students` tests project the same student, and a leaked `shareEmail: true` would change what they see.

```ts
  it('returns 409 ALREADY_LINKED for a student already on the roster', async () => {
    // One of the 25 seeded in the file's beforeAll: linked to this teacher
    // and carrying no invitation row, which is the "booked a class instead
    // of being invited" case. The privacy row is what entitles this teacher
    // to the refusal at all (#412) — without it the address is one they may
    // not see, and the invite falls through instead.
    const linked = await prisma.student.findUniqueOrThrow({
      where: { id: studentIds[0]! },
      select: { email: true },
    });
    // Removed in the finally: the GET tests in this file project this same
    // student, and a leaked share would change what they assert on.
    await prisma.studentPrivacy.create({
      data: { studentId: studentIds[0]!, teacherId, shareEmail: true },
    });

    try {
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'Already', lastName: 'Mine', email: linked.email }),
      });

      expect(res.status).toBe(409);
      const json = await res.json();
      expect(json.error.code).toBe('ALREADY_LINKED');

      // A refusal, not a refusal-shaped success: no invitation was written
      // beside it.
      expect(
        await prisma.invitation.findUnique({
          where: { teacherId_email: { teacherId, email: linked.email } },
        }),
      ).toBeNull();
    } finally {
      await prisma.studentPrivacy.deleteMany({
        where: { studentId: studentIds[0]!, teacherId },
      });
    }
  });
```

- [ ] **Step 2: Rewrite that test's comment**

The comment at `:316-321` frames this as "the roster-link refusal" whose coverage exists because "that block in `inviteContact` is exactly where a future edit would reintroduce a Student-existence branch". That is still true, but it is no longer the whole story — the refusal now also depends on `shareEmail`. Replace it with a comment that states both, and keep the "delete the block and this goes red" falsifiability note.

- [ ] **Step 3: Add the acceptance test (issue criterion 3)**

Place it immediately after the repaired test. It uses a different student from the 25 so the two do not interact:

```ts
  it('invites, rather than confirming, when the linked student has not shared their email (#412)', async () => {
    // The disclosure this closes: `ALREADY_LINKED` told a teacher that an
    // address they typed belongs to one of their own students, even one who
    // withheld it — a fact projectStudentForTeacher returns as null on every
    // other surface. A hit was free and silent, which is what made the
    // targeted guess worth closing.
    const linked = await prisma.student.findUniqueOrThrow({
      where: { id: studentIds[1]! },
      select: { email: true },
    });

    try {
      const res = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ firstName: 'Already', lastName: 'Mine', email: linked.email }),
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(Object.keys(json.data)).toEqual(['id']);

      // The row must genuinely exist: "did a new contact appear in my list?"
      // is itself a channel carrying the bit the refusal withheld, so the
      // gated path has to leave the artifact a real invitation leaves.
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: linked.email } },
        select: { status: true },
      });
      expect(row.status).toBe('pending');
    } finally {
      await prisma.invitation.deleteMany({
        where: { teacherId, email: linked.email },
      });
    }
  });
```

- [ ] **Step 4: Correct the stale comment in `invitations-api.test.ts`**

`:2446-2451` claims *"`inviteContact` refuses ALREADY_LINKED before it ever reaches the block check — so calling it on the still-linked pair would prove nothing about the block."* After Task 3 that is false: a still-linked pair with no privacy row and no invitation row is **not** refused.

The `teacherStudent.deleteMany` on `:2452` is still load-bearing, but for a different reason, and that is what the comment must now say — the delete stays. Replace the comment with:

```ts
    // The booking above also recreated the TeacherStudent link, and a linked
    // pair is undeliverable on its own account since #412 — `delivered` is
    // `blocked === null && !linked`. Left in place, the link would make the
    // assertion below fail for a reason that has nothing to do with the
    // TeacherBlock this test is about.
```

Do not change any assertion — the census confirms every `inviteContact` call in this test runs on an unlinked pair, so the test's outcome is unchanged.

- [ ] **Step 5: Typecheck and commit**

Run `npx tsc --noEmit`. Do **not** attempt `--project integration` here; it will hang on `ECONNREFUSED`.

```bash
git add tests/integration/students-api.test.ts tests/integration/invitations-api.test.ts
git commit -m "test(#412): cover the shareEmail gate at the HTTP tier

Repairs the one test the gate breaks (it asserted the refusal for a
pair with no privacy row) and adds the acceptance test: an unshared
linked address is invited, not confirmed.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## After the tasks

- [ ] Run `npx vitest run --project unit` and `npx vitest run --project components` — both must be green. Record the arithmetic (`N = unit + components`) for the PR body.
- [ ] Run `npx tsc --noEmit` and `npm run lint`.
- [ ] Whole-branch review (this plan has 4 tasks, so it is required), one fix wave, one scoped re-review.
- [ ] Push and open the PR. The body must: name the five premise corrections from the spec, state that `integration` and `e2e` were verified by CI rather than locally and cite the run, name by path the integration files touched, and record that `notifications-stream.test.ts` would break if anyone ever added a `TeacherStudent` row to its fixture — its two SSE tests wait on the very notification `notifyInvitee` now suppresses for a linked pair.
- [ ] `/pr-review-toolkit:review-pr <N>`. Skip the type-design reviewer: `RosterLinkState` is a two-field internal result shape, not the PR's subject.
