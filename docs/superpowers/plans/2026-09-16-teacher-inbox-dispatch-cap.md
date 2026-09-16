# Teacher-inbox dispatch cap (#622) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher-only invitee is told about an invitation once; further resends of that invitation reach them only if its address changes, it is revived, or the dispatch that told them failed.

**Architecture:** One nullable column on `Invitation`, `teacherInboxNotifiedAt`, written and read by `notifyInvitee`'s teacher branch alone. The read and the write are a single conditional `updateMany` — claiming the row *is* the check, so two concurrent dispatches cannot both notify. A dispatch that fails clears the marker on `deliverInvitation`'s existing `.catch`, so the cap re-opens where the failure is known rather than being inferred later from a marker the routes have already overwritten.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma + PostgreSQL, Vitest (projects: `unit`, `unit-sweeps`, `integration`, `components`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-16-teacher-inbox-dispatch-cap-design.md`

## Global Constraints

- Column name is exactly **`teacherInboxNotifiedAt`**, type **`DateTime?`**. Migration name is exactly **`invitation_teacher_inbox_notified_at`**.
- `notifyInvitee`'s new parameter is **`invitationId: string`, required**. `dispatchedAt` is **not** added to `notifyInvitee` — the claim's own `where` is its compare-and-swap.
- **`lastNotifyFailedAt` must never appear in the claim's `where`.** Spec §4.2: both dispatching routes clear that column before dispatching, so the clause is inert there and would strand an invitee whose only attempt failed.
- The `.catch` clear runs **above** `recordDispatchFailure()`'s `looksSystemic` early return, and carries the `lastNotifiedAt: input.dispatchedAt` CAS clause.
- **`teacherInboxNotifiedAt` must never reach a teacher-facing surface.** Do not add it to `invitationDeliveryStatus`'s parameter type (`src/lib/contacts.ts`), to `ownedInvitation`'s select (`src/app/api/invitations/[id]/shared.ts`), or to `src/app/(teacher)/students/contacts/[id]/page.tsx`. It states which account shape an address holds.
- **Comment Discipline (CLAUDE.md):** a comment annotates the code it sits on. Facts about other modules go in `docs/` with a link from the comment. No prose counts or rosters.
- **Never edit an applied migration**, comment-only edits included.
- **Never `git add -A` or `git add .`** — stage exact paths. Quote paths containing `(`/`)`.
- TypeScript `strict: true`. No `any`.

## Running tests

`invitations.notify.test.ts` and `invitations.deliver.test.ts` are in `src/`, are **not** in `vitest.tiers.ts`'s `SERIAL_TESTS`, and therefore run in the parallel **`unit`** project.

```sh
pnpm exec vitest run --project unit src/services/invitations.notify.test.ts
pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts
pnpm run verify        # everything; needs the app live
```

In a worktree, before any `pnpm run`/`pnpm exec`: `pnpm install --frozen-lockfile`, then `pnpm run worktree:setup` once, then `pnpm run worktree:up` before the `integration` project.

**Task order is load-bearing.** Task 2 needs Task 1's parameter; Task 3 needs Task 2's claim to exist before a test can prove it re-opens; Task 5 needs 2-4 complete.

---

### Task 1: The column, the migration, and the parameter

Pure plumbing. **No behaviour changes in this task** — the suite must be green at the end with identical semantics.

**Files:**
- Modify: `prisma/schema.prisma` (`model Invitation`)
- Create: `prisma/migrations/<timestamp>_invitation_teacher_inbox_notified_at/migration.sql` (generated)
- Modify: `src/services/invitations.ts` (`notifyInvitee` signature; `deliverInvitation`'s forwarding call at ~`:709`)
- Modify: `src/services/invitations.notify.test.ts` (10 call sites)

**Interfaces:**
- Produces: `notifyInvitee(db: PrismaClient, input: { teacherId: string; email: string; teacherName: string; invitationId: string }): Promise<void>`
- Produces: `Invitation.teacherInboxNotifiedAt: Date | null`

- [ ] **Step 1: Add the column**

In `prisma/schema.prisma`, `model Invitation`, directly below `lastNotifyFailedAt`:

```prisma
  teacherInboxNotifiedAt DateTime?
```

- [ ] **Step 2: Generate and apply the migration**

```bash
pnpm exec prisma migrate dev --name invitation_teacher_inbox_notified_at
```

Expected: a new folder under `prisma/migrations/` whose `migration.sql` is a single `ALTER TABLE "Invitation" ADD COLUMN "teacherInboxNotifiedAt" TIMESTAMP(3);`. No index — nothing queries by this column; it is only ever read as part of a `where` already keyed on the primary key.

- [ ] **Step 3: Widen `notifyInvitee`'s signature**

`src/services/invitations.ts`, at `export async function notifyInvitee`:

```ts
export async function notifyInvitee(
  db: PrismaClient,
  input: { teacherId: string; email: string; teacherName: string; invitationId: string },
): Promise<void> {
```

- [ ] **Step 4: Forward it from `deliverInvitation`**

In `deliverInvitation`'s async wrapper (~`:709`):

```ts
    await notifyInvitee(db, {
      teacherId: input.teacherId,
      email: input.email,
      teacherName: `${teacher.firstName} ${teacher.lastName}`,
      invitationId: input.invitationId,
    });
```

- [ ] **Step 5: Run the typecheck to see the 10 call sites fail**

```bash
pnpm exec tsc --noEmit
```

Expected: FAIL, ten errors in `src/services/invitations.notify.test.ts` of the form `Property 'invitationId' is missing in type ... but required in type ...`. Confirm the count is ten and that they are all in that one file:

```sh
grep -c 'notifyInvitee(prisma,' src/services/invitations.notify.test.ts   # 10
```

- [ ] **Step 6: Give each call site a real `Invitation` row**

Every one of the ten must create a row and delete it in its own `finally`. A non-existent id makes the claim added in Task 2 match nothing, so a test that passes a fabricated id would silently observe suppression instead of the behaviour it means to assert.

The pattern already in this file (`:255-259`), to repeat at each site:

```ts
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Notify', lastName: 'Cap' },
        select: { id: true },
      });
      invitationId = invitation.id;
```

with `let invitationId: string | undefined;` declared beside the test's other ids, and in `finally`:

```ts
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
```

Then pass it: `await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id });`

One site needs care: the already-linked test at `:255` **already** creates an invitation — reuse that row, do not create a second.

(The blocked-address test also creates a `TeacherBlock`, but that table has its own `@@unique([teacherId, email])` independent of `Invitation`'s, so the two never collide and ordering between them does not matter.)

- [ ] **Step 7: Run the tests to verify they pass unchanged**

```bash
pnpm exec tsc --noEmit
pnpm exec vitest run --project unit src/services/invitations.notify.test.ts
```

Expected: typecheck clean; every test PASSES with the same assertions it had before. This task changed no behaviour.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/invitations.ts src/services/invitations.notify.test.ts
git commit -m "feat(invitations): add teacherInboxNotifiedAt and thread invitationId into notifyInvitee (#622)"
```

---

### Task 2: The claim

**Files:**
- Modify: `src/services/invitations.ts` (teacher branch, ~`:604`; `notifyInvitee` docblock)
- Test: `src/services/invitations.notify.test.ts`

**Interfaces:**
- Consumes: `notifyInvitee`'s `invitationId`, `Invitation.teacherInboxNotifiedAt` (Task 1)

- [ ] **Step 1: Write the failing tests**

Append to the `describe` in `src/services/invitations.notify.test.ts`. This file does **not** import `tests/helpers` today, so add the teardown helper it needs:

```ts
import { teardownTeacher } from '../../tests/helpers';
```

Then a shared fixture helper, placed above the new tests:

```ts
  /** A teacher-only account plus a pending invitation to it from `teacherId`. */
  async function teacherOnlyInvitee(slug: string) {
    const email = `notify-cap-${slug}-${suffix}@test.local`;
    const invitee = await prisma.teacher.create({
      data: {
        firstName: 'Cap', lastName: 'Invitee', email,
        account: { create: { email } },
        bio: '#622 teacher-inbox dispatch cap',
        pageSlug: `notify-cap-${slug}-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Invitee' },
      select: { id: true },
    });
    return { email, inviteeTeacherId: invitee.id, accountId: invitee.accountId, invitationId: invitation.id };
  }

  async function cleanUpInvitee(f: { inviteeTeacherId: string; accountId: string; invitationId: string }) {
    await prisma.notification.deleteMany({
      where: { recipientType: 'teacher', recipientId: f.inviteeTeacherId },
    });
    await prisma.invitation.deleteMany({ where: { id: f.invitationId } });
    await teardownTeacher(prisma, f.inviteeTeacherId, f.accountId);
  }

  const countTeacherNotifications = (recipientId: string) =>
    prisma.notification.count({
      where: { recipientType: 'teacher', recipientId, type: 'teacher_invitation' },
    });
```

Then the tests:

```ts
  it('tells a teacher-only invitee once, and a repeat dispatch not at all (#622)', async () => {
    const f = await teacherOnlyInvitee('repeat');
    try {
      const dispatch = () => notifyInvitee(prisma, {
        teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      await dispatch();
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
      await dispatch();
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
    } finally {
      await cleanUpInvitee(f);
    }
  });

  it('tells an address that gained a teacher profile after an earlier dispatch (#622, sequence 1)', async () => {
    // The dead end this replaces: the first dispatch took the stranger-email
    // branch and the routes wrote their markers anyway, so a suppression
    // reading those markers never told this person at all.
    const email = `notify-cap-seq1-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Seq1' },
      select: { id: true },
    });
    let inviteeTeacherId: string | undefined;
    let accountId: string | undefined;
    try {
      // No account yet: the stranger branch runs.
      await notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id,
      });
      expect(sendMock).toHaveBeenCalledTimes(1);

      const invitee = await prisma.teacher.create({
        data: {
          firstName: 'Cap', lastName: 'Seq1', email,
          account: { create: { email } },
          bio: '#622 sequence 1', pageSlug: `notify-cap-seq1-${suffix}`,
        },
        select: { id: true, accountId: true },
      });
      inviteeTeacherId = invitee.id;
      accountId = invitee.accountId;

      await notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id,
      });
      expect(await countTeacherNotifications(invitee.id)).toBe(1);
    } finally {
      if (inviteeTeacherId) {
        await prisma.notification.deleteMany({
          where: { recipientType: 'teacher', recipientId: inviteeTeacherId },
        });
        await prisma.teacher.delete({ where: { id: inviteeTeacherId } });
      }
      if (accountId) await prisma.account.delete({ where: { id: accountId } });
      await prisma.invitation.deleteMany({ where: { id: invitation.id } });
    }
  });

  it('tells a previously-linked invitee once the student side is gone (#622, sequence 2)', async () => {
    // The dispatch made while the pair was linked returned at the roster-link
    // check without notifying anyone. It must not count as having told them.
    const f = await teacherOnlyInvitee('seq2');
    let studentId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: {
          firstName: 'Cap', lastName: 'Seq2', email: f.email,
          teacherStudents: { create: { teacherId } },
        },
        select: { id: true },
      });
      studentId = student.id;

      // Linked: this dispatch notifies nobody.
      await notifyInvitee(prisma, {
        teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(0);

      // The student side is erased: address tombstoned, link removed. The
      // account keeps its address because a live teacher remains.
      await prisma.teacherStudent.deleteMany({ where: { studentId: student.id } });
      await prisma.student.update({
        where: { id: student.id },
        data: { email: `deleted-${student.id}@deleted.invalid`, deletedAt: new Date() },
      });

      await notifyInvitee(prisma, {
        teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
    } finally {
      if (studentId) {
        await prisma.teacherStudent.deleteMany({ where: { studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
      await cleanUpInvitee(f);
    }
  });

  it('caps nothing for a student invitee — every dispatch still notifies (#622)', async () => {
    const email = `notify-cap-student-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Student' },
      select: { id: true },
    });
    let studentId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: { firstName: 'Cap', lastName: 'Student', email },
        select: { id: true },
      });
      studentId = student.id;

      const dispatch = () => notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id,
      });
      await dispatch();
      await dispatch();

      expect(await prisma.notification.count({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      })).toBe(2);
    } finally {
      if (studentId) {
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
      await prisma.invitation.deleteMany({ where: { id: invitation.id } });
    }
  });

  it('caps nothing for an address with no account — every dispatch still emails (#622)', async () => {
    const email = `notify-cap-stranger-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Stranger' },
      select: { id: true },
    });
    try {
      const dispatch = () => notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', invitationId: invitation.id,
      });
      await dispatch();
      await dispatch();
      expect(sendMock).toHaveBeenCalledTimes(2);
    } finally {
      await prisma.invitation.deleteMany({ where: { id: invitation.id } });
    }
  });

  it('creates exactly one notification when two dispatches race (#622)', async () => {
    // The reason the claim is a conditional UPDATE and not a read followed by
    // a write: both of these would observe a null marker under a read-first
    // implementation, and both would notify.
    const f = await teacherOnlyInvitee('race');
    try {
      await Promise.all([
        notifyInvitee(prisma, { teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId }),
        notifyInvitee(prisma, { teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId }),
      ]);
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);
    } finally {
      await cleanUpInvitee(f);
    }
  });
```

Verified: the file's existing `beforeEach` (`src/services/invitations.notify.test.ts:92-94`) calls `sendMock.mockReset()` and re-arms the resolved value, so the two `toHaveBeenCalledTimes` assertions are per-test safe with no extra clearing. Both new tests must sit inside that same `describe` for it to apply.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run --project unit src/services/invitations.notify.test.ts
```

Expected: FAIL. The repeat test fails `expected 2 to be 1`; sequence 1 and sequence 2 PASS already (nothing suppresses yet); the race test fails `expected 2 to be 1`. The two "caps nothing" tests pass. Record which failed — sequence 1 and 2 are regression guards for Task 2's implementation, not red-first tests, and the plan expects them green here.

- [ ] **Step 3: Implement the claim**

`src/services/invitations.ts`, replacing the body of `if (account?.teacher) {`:

```ts
  if (account?.teacher) {
    // The cap (#622). A conditional UPDATE rather than a read and then a
    // write: two concurrent dispatches would both observe a null marker and
    // both notify, so claiming the row IS the check. A row deleted mid-flight
    // matches nothing and is likewise not notified.
    //
    // Do not add `lastNotifyFailedAt: null` to this `where`. It is inert here,
    // for a reason involving what the dispatching routes write before this
    // code runs: `docs/data-model.md` (Invitation, "Who an invitation
    // reaches"). A failed dispatch re-opens the cap on the failure path
    // itself — `deliverInvitation`'s `.catch`, below.
    const claimed = await db.invitation.updateMany({
      where: { id: input.invitationId, teacherInboxNotifiedAt: null },
      data: { teacherInboxNotifiedAt: new Date() },
    });
    if (claimed.count === 0) return;

    await createNotification(db, {
      recipientType: 'teacher',
      recipientId: account.teacher.id,
      type: 'teacher_invitation',
      title: 'A teacher would like to connect',
      body: `${input.teacherName} added you as a contact. Connecting adds a student side to your account, and you choose whether to.`,
    });
    return;
  }
```

- [ ] **Step 4: Update `notifyInvitee`'s docblock**

Its closing paragraph explains that `teacher_invitation` is not in `ESSENTIAL_NOTIFICATION_TYPES`, so a student keeps their `emailNotifications` opt-out. Add, immediately after it:

```
 * A teacher recipient has no such preference to honour — `processEmailFallback`
 * (services/email-fallback.ts) leaves `emailEnabled` true for the teacher arm,
 * and no teacher-side counterpart to `Student.emailNotifications` exists. The
 * teacher branch below is therefore capped instead: it tells an invitee once
 * per invitation. Which writers set and clear that marker:
 * `docs/data-model.md` (Invitation).
```

Per Comment Discipline, the census of writers stays in `docs/data-model.md` and this links to it rather than restating it — and **this task writes that paragraph too, in the same commit**. A comment shipped pointing at a doc section that does not yet say it is a pointer to nothing for three tasks, and a reviewer reading it has no way to tell a deliberate stage from a mistake. Add to `docs/data-model.md`'s *Who an invitation reaches* (~`:198-212`), under the teacher-branch bullet:

> The teacher branch delivers at most once per invitation (#622). `lastNotifyFailedAt` cannot serve as the release valve for that cap — both dispatching routes clear it before dispatching, so a reader in `notifyInvitee` always sees null — so a failed dispatch re-opens the cap on the failure path itself, in `deliverInvitation`'s `.catch`. Set by the teacher branch on delivery; cleared by that `.catch`, by a genuine readdress in `PUT /api/invitations/[id]`, and by `revivePendingInvitation`.

Task 6 extends this section and sweeps the rest; it does not create it.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm exec vitest run --project unit src/services/invitations.notify.test.ts
pnpm exec tsc --noEmit
```

Expected: all PASS, typecheck clean.

- [ ] **Step 6: Mutation checks — break each, record the exact failure text, restore, re-verify**

1. Delete `teacherInboxNotifiedAt: null` from the claim's `where` → the repeat test fails.
2. Change `if (claimed.count === 0) return;` to `!== 0` → sequence 1 and the repeat test both fail.
3. Move the claim below `createNotification` → the race test fails. Run it several times; if it is flaky rather than reliably red, say so in the task report rather than recording a pass.
4. Copy the claim into the student branch as well → the student "caps nothing" test fails.
5. **Adversarial, expected to stay GREEN:** add `lastNotifyFailedAt: null` back into the claim's `where` and run the whole file. It will pass. This records that the rejected clause is undetectable by any test, which is why the constraint lives in prose and in the comment. Restore.

- [ ] **Step 7: Commit**

```bash
git add src/services/invitations.ts src/services/invitations.notify.test.ts
git commit -m "feat(invitations): cap teacher-inbox dispatches at one per invitation (#622)"
```

---

### Task 3: A failed dispatch re-opens the cap

**Files:**
- Modify: `src/services/invitations.ts` (`deliverInvitation`'s `.catch`, ~`:714-745`; its docblock)
- Test: `src/services/invitations.deliver.test.ts`

**Interfaces:**
- Consumes: the claim (Task 2); `deliverInvitation`'s existing `input.invitationId` and `input.dispatchedAt`

- [ ] **Step 1: Write the failing tests**

Three cases, each failing for a reason the others do not. These go in `src/services/invitations.deliver.test.ts`, following its existing `waitFor` conventions (see its tests at `:143` and `:210` for the dispatch-and-observe shape).

**Task 2's `teacherOnlyInvitee` and `cleanUpInvitee` are defined in `invitations.notify.test.ts` and are NOT available here.** Define local equivalents at the top of this file's new describe block, using the shared teardown helper this file already imports:

```ts
  /** A teacher-only account plus a pending invitation to it from `teacherId`. */
  async function teacherOnlyInvitee(slug: string) {
    const email = `deliver-cap-${slug}-${suffix}@test.local`;
    const invitee = await prisma.teacher.create({
      data: {
        firstName: 'Cap', lastName: 'Invitee', email,
        account: { create: { email } },
        bio: '#622 teacher-inbox dispatch cap',
        pageSlug: `deliver-cap-${slug}-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Cap', lastName: 'Invitee' },
      select: { id: true },
    });
    return { email, inviteeTeacherId: invitee.id, accountId: invitee.accountId, invitationId: invitation.id };
  }

  async function cleanUpInvitee(f: { inviteeTeacherId: string; accountId: string; invitationId: string }) {
    await prisma.notification.deleteMany({
      where: { recipientType: 'teacher', recipientId: f.inviteeTeacherId },
    });
    await prisma.invitation.deleteMany({ where: { id: f.invitationId } });
    await teardownTeacher(prisma, f.inviteeTeacherId, f.accountId);
  }
```

`teardownTeacher` (`tests/helpers.ts:227`, signature `(db, teacherId, accountId?)`) is already imported by this file. Task 2's copy in `invitations.notify.test.ts` should use it too rather than hand-rolling the teacher and account deletes — update Task 2's `cleanUpInvitee` to match if it has not already landed that way.

```ts
  it('re-opens the cap when the teacher-branch insert fails (#622)', async () => {
    const f = await teacherOnlyInvitee('fail-ordinary');
    try {
      const dispatchedAt = new Date();
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { lastNotifiedAt: dispatchedAt, lastNotifiedEmail: f.email },
      });
      const createSpy = vi.spyOn(prisma.notification, 'create')
        .mockRejectedValueOnce(new Error('insert failed'));

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt,
      });

      await waitFor(
        () => prisma.invitation.findUniqueOrThrow({
          where: { id: f.invitationId }, select: { teacherInboxNotifiedAt: true },
        }).then((r) => (r.teacherInboxNotifiedAt === null ? true : null)),
        { description: 'a failed teacher-branch dispatch clears the cap (#622)' },
      );
      createSpy.mockRestore();
    } finally {
      await cleanUpInvitee(f);
    }
  });
```

The outage case differs only in driving `recordDispatchFailure` past its burst threshold first, so that `looksSystemic` is true when the `.catch` runs — the cap must still re-open:

```ts
  it('re-opens the cap even when the failure looks systemic (#622)', async () => {
    const f = await teacherOnlyInvitee('fail-outage');
    try {
      const dispatchedAt = new Date();
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { lastNotifiedAt: dispatchedAt, lastNotifiedEmail: f.email },
      });
      // Drive the health window past its threshold, so `looksSystemic` is
      // true by the time this dispatch's own failure is handled.
      recordDispatchFailure();
      recordDispatchFailure();
      recordDispatchFailure();

      const createSpy = vi.spyOn(prisma.notification, 'create')
        .mockRejectedValueOnce(new Error('insert failed'));

      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'resend', dispatchedAt,
      });

      await waitFor(
        () => prisma.invitation.findUniqueOrThrow({
          where: { id: f.invitationId },
          select: { teacherInboxNotifiedAt: true, lastNotifyFailedAt: true },
        }).then((r) => (r.teacherInboxNotifiedAt === null ? r : null)),
        { description: 'the cap re-opens under a failure burst (#622)' },
      );
      // The teacher-visible half stays suppressed — that is #392's rule and
      // this change does not touch it.
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId }, select: { lastNotifyFailedAt: true },
      });
      expect(row.lastNotifyFailedAt).toBeNull();
      createSpy.mockRestore();
    } finally {
      await cleanUpInvitee(f);
    }
  });
```

`@/lib/notify-health` exports both `recordDispatchFailure` and `__resetDispatchFailureTrackingForTests` (`src/lib/notify-health.ts:44,57`). This file already imports the reset and **already calls it in a `beforeEach`** (`src/services/invitations.deliver.test.ts:57-58`), so no new cleanup is needed. Add `recordDispatchFailure` to that same import line.

**That makes placement load-bearing:** these three tests must go *inside* the existing `describe` block, not in a new sibling one. A new `describe` gets no `beforeEach`, and the systemic verdict the outage test deliberately creates would then leak into every later test that asserts `lastNotifyFailedAt` was written — including the ones in this file that already do.

The superseded case proves the CAS clause:

```ts
  it('does not re-open a cap a newer dispatch closed (#622)', async () => {
    const f = await teacherOnlyInvitee('fail-superseded');
    try {
      const staleDispatchedAt = new Date(Date.now() - 60_000);
      const currentDispatchedAt = new Date();
      // The row has moved on to a newer attempt, which succeeded and holds
      // the cap closed.
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: {
          lastNotifiedAt: currentDispatchedAt, lastNotifiedEmail: f.email,
          teacherInboxNotifiedAt: new Date(),
        },
      });
      const createSpy = vi.spyOn(prisma.notification, 'create')
        .mockRejectedValueOnce(new Error('insert failed'));

      // A stale attempt's late failure.
      deliverInvitation(prisma, {
        teacherId, email: f.email, invitationId: f.invitationId,
        source: 'create', dispatchedAt: staleDispatchedAt,
      });

      await waitFor(
        () => prisma.notification.count({
          where: { recipientType: 'teacher', recipientId: f.inviteeTeacherId },
        }).then((c) => (c >= 0 ? c : null)),
        { description: 'the stale dispatch has been handled (#622)' },
      );
      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId }, select: { teacherInboxNotifiedAt: true },
      });
      expect(row.teacherInboxNotifiedAt).not.toBeNull();
      createSpy.mockRestore();
    } finally {
      await cleanUpInvitee(f);
    }
  });
```

The superseded test's `waitFor` is a synchronisation point, not the assertion — it needs a condition that actually proves the stale dispatch finished. If a count that is always `>= 0` cannot do that, replace it with a spy on `prisma.invitation.updateMany` whose call resolution is awaited, the technique `invitations.notify.test.ts:277` uses for exactly this problem. State in the task report which was used and why.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run --project unit src/services/invitations.deliver.test.ts
```

Expected: the ordinary and outage cases FAIL by timing out in `waitFor` (the marker is never cleared). The superseded case PASSES already, since nothing clears the marker yet — it is the guard that Step 3's CAS clause must not break.

- [ ] **Step 3: Implement the clear**

In `deliverInvitation`'s `.catch`, **above** the `recordDispatchFailure()` call:

```ts
    // #622: re-open the cap wherever a dispatch failed. Above the systemic
    // early return below on purpose — `teacherInboxNotifiedAt` reaches no
    // teacher-facing surface, so the burst suppression that protects
    // `lastNotifyFailedAt` from becoming an account-existence proxy buys
    // nothing here, and gating on it would strand every invitee whose
    // notification failed during an outage.
    //
    // Same `lastNotifiedAt` CAS as the failure write below, for the same
    // reason: a superseded attempt's late failure must not re-open a cap a
    // newer, successful attempt closed.
    db.invitation
      .updateMany({
        where: { id: input.invitationId, lastNotifiedAt: input.dispatchedAt },
        data: { teacherInboxNotifiedAt: null },
      })
      .catch((writeErr: unknown) => {
        log.error(
          { err: writeErr, invitationId: input.invitationId },
          'failed to re-open teacher inbox dispatch cap',
        );
      });
```

- [ ] **Step 4: Update `deliverInvitation`'s docblock**

It enumerates what the `.catch` persists and behind which guards. Add a third bullet beside the two it already has for `lastNotifyFailedAt`, stating that `teacherInboxNotifiedAt` is cleared there, that it takes the CAS but **not** the `recordDispatchFailure` gate, and why (visibility). Keep it to what this function does; the writer census belongs in `docs/data-model.md`.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm exec vitest run --project unit src/services/invitations.deliver.test.ts
pnpm exec tsc --noEmit
```

Expected: all three PASS.

- [ ] **Step 6: Mutation checks**

1. Delete the clear entirely → the ordinary case fails.
2. Move the clear below `if (looksSystemic) return;` → the outage case fails, the ordinary case still passes. If the ordinary case also fails, the two tests are not independent — fix the tests before continuing.
3. Drop `lastNotifiedAt: input.dispatchedAt` from the clear's `where` → the superseded case fails.

- [ ] **Step 7: Commit**

```bash
git add src/services/invitations.ts src/services/invitations.deliver.test.ts
git commit -m "fix(invitations): re-open the dispatch cap when a dispatch fails (#622)"
```

---

### Task 4: The two resets

**Files:**
- Modify: `src/app/api/invitations/[id]/route.ts:246` (the `readdressed` reset)
- Modify: `src/services/invitations.ts` (`revivePendingInvitation`, ~`:421`)
- Test: `src/services/invitations.notify.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
  it('tells the invitee again after the invitation is readdressed (#622)', async () => {
    const f = await teacherOnlyInvitee('readdress');
    const newEmail = `notify-cap-readdress-new-${suffix}@test.local`;
    let secondTeacherId: string | undefined;
    let secondAccountId: string | undefined;
    try {
      await notifyInvitee(prisma, {
        teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);

      const second = await prisma.teacher.create({
        data: {
          firstName: 'Cap', lastName: 'Readdressed', email: newEmail,
          account: { create: { email: newEmail } },
          bio: '#622 readdress', pageSlug: `notify-cap-readdress-new-${suffix}`,
        },
        select: { id: true, accountId: true },
      });
      secondTeacherId = second.id;
      secondAccountId = second.accountId;

      // What `PUT /api/invitations/[id]` does on a genuine address change.
      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { email: newEmail, delivered: false, lastNotifyFailedAt: null, teacherInboxNotifiedAt: null },
      });

      await notifyInvitee(prisma, {
        teacherId, email: newEmail, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      expect(await countTeacherNotifications(second.id)).toBe(1);
    } finally {
      if (secondTeacherId) {
        await prisma.notification.deleteMany({
          where: { recipientType: 'teacher', recipientId: secondTeacherId },
        });
        await prisma.teacher.delete({ where: { id: secondTeacherId } });
      }
      if (secondAccountId) await prisma.account.delete({ where: { id: secondAccountId } });
      await cleanUpInvitee(f);
    }
  });
```

That test pins `notifyInvitee`'s half but writes the reset by hand, so it would pass even if the route never wrote it. The route's own half needs a test that calls `revivePendingInvitation`'s and the PUT's real code. `revivePendingInvitation` is module-private, so cover it through its exported caller:

```ts
  it('tells the invitee again after a revived invitation (#622)', async () => {
    const f = await teacherOnlyInvitee('revive');
    try {
      await notifyInvitee(prisma, {
        teacherId, email: f.email, teacherName: 'Some Teacher', invitationId: f.invitationId,
      });
      expect(await countTeacherNotifications(f.inviteeTeacherId)).toBe(1);

      await prisma.invitation.update({
        where: { id: f.invitationId },
        data: { status: 'accepted', respondedAt: new Date() },
      });

      // `inviteContact` revives the accepted row rather than creating a new
      // one, so the marker travels with it unless the revive clears it.
      const revived = await inviteContact(prisma, {
        teacherId, email: f.email, firstName: 'Cap', lastName: 'Invitee',
      });
      expect(revived.ok).toBe(true);

      const row = await prisma.invitation.findUniqueOrThrow({
        where: { id: f.invitationId },
        select: { status: true, teacherInboxNotifiedAt: true },
      });
      expect(row.status).toBe('pending');
      expect(row.teacherInboxNotifiedAt).toBeNull();
    } finally {
      await cleanUpInvitee(f);
    }
  });
```

Verified signature (`src/services/invitations.ts:245-248`), to import alongside `notifyInvitee`:

```ts
inviteContact(
  db: PrismaClient,
  input: { teacherId: string; email: string; firstName: string; lastName: string },
): Promise<{ ok: true; value: InviteResult } | { ok: false; reason: InviteRefusal }>
```

It returns a result union rather than throwing, so `expect(revived.ok).toBe(true)` is what catches a refusal — without it a refused revive leaves the row `accepted` and the null assertion below passes for the wrong reason. `inviteContact` does not itself dispatch (its callers do), so no notification cleanup is needed beyond `cleanUpInvitee`.

The `PUT` route's own reset is covered at the integration level in Task 5, because it is route code.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run --project unit src/services/invitations.notify.test.ts
```

Expected: the readdress test PASSES (it writes the reset itself); the revive test FAILS with `expected <Date> to be null`.

- [ ] **Step 3: Implement both resets**

`src/services/invitations.ts`, in `revivePendingInvitation`:

```ts
  const revived = await db.invitation.updateMany({
    where: { id, status: 'accepted' },
    data: {
      status: 'pending', respondedAt: null, isArchived: false,
      // #622: a revive reuses this row, so the cap would otherwise travel
      // across a link that ended. A re-invitation is a new invitation.
      teacherInboxNotifiedAt: null,
      ...fields,
    },
  });
```

`src/app/api/invitations/[id]/route.ts`, at the `readdressed` spread:

```ts
        ...(readdressed
          ? { delivered: false, lastNotifyFailedAt: null, teacherInboxNotifiedAt: null }
          : {}),
```

Extend the comment above that spread — which already explains `delivered: false` and `lastNotifyFailedAt: null` — with one sentence for the third column: the new address is a different person, who has been told nothing.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
pnpm exec vitest run --project unit src/services/invitations.notify.test.ts
pnpm exec tsc --noEmit
```

- [ ] **Step 5: Mutation checks**

1. Remove `teacherInboxNotifiedAt: null` from `revivePendingInvitation` → the revive test fails.
2. Remove it from the `readdressed` spread → **no unit test fails.** That is expected: the readdress test writes the reset by hand. Task 5's integration test is what covers this line; note here that the check is deferred to it, and re-run this mutation at the end of Task 5.

- [ ] **Step 6: Commit**

```bash
git add src/services/invitations.ts 'src/app/api/invitations/[id]/route.ts' src/services/invitations.notify.test.ts
git commit -m "fix(invitations): clear the dispatch cap on readdress and revive (#622)"
```

---

### Task 5: Over HTTP — invert the guard, prove the reset and the absent oracle

**Files:**
- Modify: `tests/integration/invitations-api.test.ts` (the `#172` describe, ~`:4204-4306`)

- [ ] **Step 1: Replace the current-behaviour guard**

`tests/integration/invitations-api.test.ts:4285` is `tells the invitee again when the invitation is resent`, with a comment block above it (~`:4275-4284`) explaining that the cap was withdrawn. Both the test and that comment are now false. Replace them:

```ts
  it('tells the invitee once, and a resend not again (#622)', async () => {
    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: inviteeEmail } },
      select: { id: true },
    });
    const before = await prisma.notification.count({
      where: { recipientType: 'teacher', recipientId: inviteeTeacherId, type: 'teacher_invitation' },
    });

    const resend = await fetch(`${BASE_URL}/api/invitations/${invitation.id}/resend`, {
      method: 'POST', headers: cookie(teacherToken),
    });
    expect(resend.status).toBe(200);
    expect(await resend.json()).toEqual({ data: { id: invitation.id } });

    // The dispatch is fire-and-forget, so "no notification" cannot be proven
    // by reading immediately. Wait for the marker the route writes
    // synchronously, then for the dispatch to have run, and only then count.
    await waitFor(
      () => prisma.invitation.findUniqueOrThrow({
        where: { id: invitation.id }, select: { lastNotifiedAt: true },
      }).then((r) => r.lastNotifiedAt),
      { description: 'the resend wrote its dispatch marker (#622)' },
    );
    await new Promise((r) => setTimeout(r, 1_000));

    expect(await prisma.notification.count({
      where: { recipientType: 'teacher', recipientId: inviteeTeacherId, type: 'teacher_invitation' },
    })).toBe(before);
  });
```

**On the fixed wait, and why it is acceptable here specifically.** Proving a negative with a sleep is weak, and the two better techniques both fail in this tier:

- A *control dispatch* — resend an uncapped invitation alongside and wait for **its** notification — assumes the capped dispatch cannot outlive the control. `src/services/invitations.notify.test.ts:262-277` records that exact reasoning being wrong: both dispatches are fire-and-forget and compete for one connection pool with no ordering guarantee.
- *Spying on the query* is how that file solved it, and it is unavailable here — this tier drives the app over HTTP in another process.

So keep the bounded wait, and keep it honest about what it buys. **The proof that the cap works is Task 2's unit tests**, which are synchronous and exact. This test's job is narrower: that the *route* reaches the capped branch at all, and that its response carries no signal. Say precisely that in a comment above the wait, so a later reader does not mistake a sleep for the guarantee.

- [ ] **Step 2: Add the oracle-equivalence assertion**

Acceptance criterion 5. In the same test, or beside it, assert that the suppressed resend's response is indistinguishable from a notifying one — status `200`, body `{ data: { id } }`, and `lastNotifiedAt` advanced — which the assertions above already cover. Add explicitly that no failure was recorded:

```ts
    const row = await prisma.invitation.findUniqueOrThrow({
      where: { id: invitation.id },
      select: { lastNotifyFailedAt: true, lastNotifiedEmail: true },
    });
    expect(row.lastNotifyFailedAt).toBeNull();
    expect(row.lastNotifiedEmail).toBe(inviteeEmail);
```

- [ ] **Step 3: Add the readdress reset test, exercising the real PUT**

```ts
  it('tells the readdressed invitee, because PUT clears the cap (#622)', async () => {
    const readdressed = `inv-teacher-readdressed-${suffix}@test.local`;
    const second = await prisma.teacher.create({
      data: {
        firstName: 'Readdressed', lastName: 'Teacher', email: readdressed,
        account: { create: { email: readdressed } },
        bio: '#622 readdress', pageSlug: `inv-teacher-readdressed-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: inviteeEmail } },
      select: { id: true },
    });
    try {
      const put = await fetch(`${BASE_URL}/api/invitations/${invitation.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
        body: JSON.stringify({ email: readdressed, firstName: 'Readdressed', lastName: 'Teacher' }),
      });
      expect(put.status).toBe(200);

      // `PUT /api/invitations/[id]` does NOT dispatch — verified: the route
      // file contains no `deliverInvitation` call. It only clears the cap.
      // The resend is what delivers.
      const resend = await fetch(`${BASE_URL}/api/invitations/${invitation.id}/resend`, {
        method: 'POST', headers: cookie(teacherToken),
      });
      expect(resend.status).toBe(200);

      await waitFor(
        () => prisma.notification.count({
          where: { recipientType: 'teacher', recipientId: second.id, type: 'teacher_invitation' },
        }).then((c) => (c > 0 ? c : null)),
        { description: 'a readdressed invitation reaches the new teacher (#622)' },
      );
    } finally {
      await prisma.notification.deleteMany({
        where: { recipientType: 'teacher', recipientId: second.id },
      });
      await prisma.invitation.updateMany({
        where: { id: invitation.id }, data: { email: inviteeEmail },
      });
      await prisma.teacher.delete({ where: { id: second.id } });
      await prisma.account.delete({ where: { id: second.accountId } });
    }
  });
```

**This test runs after the capped test above and mutates the shared `inviteeEmail` row, so its placement is load-bearing.** Restore the address in `finally`, and state the ordering constraint in a comment.

- [ ] **Step 4: Run the integration tests**

```bash
pnpm run worktree:up   # in a worktree only
pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts
```

Expected: PASS. Warm the routes first — `next dev` compiles lazily and a first-request compile can blow a `waitFor` timeout in a way that reads exactly like an assertion failure.

- [ ] **Step 5: Re-run Task 4's deferred mutation**

Remove `teacherInboxNotifiedAt: null` from the `readdressed` spread in `src/app/api/invitations/[id]/route.ts` and re-run this file. Expected: the readdress test fails. Restore and re-verify.

- [ ] **Step 6: Commit**

```bash
git add tests/integration/invitations-api.test.ts
git commit -m "test(invitations): the dispatch cap over HTTP, and the readdress reset (#622)"
```

---

### Task 6: Docs and the comment sweep

**Files:**
- Modify: `docs/data-model.md` (`Invitation` field table; *Who an invitation reaches*, ~`:198-212`)
- Modify: whichever docblocks the sweep finds stale

- [ ] **Step 1: Add the column to the `Invitation` field table**

A row for `teacher_inbox_notified_at`, `datetime?`, whose note states: set by `notifyInvitee`'s teacher branch when it delivers a notification, cleared by `deliverInvitation`'s failure path, by a genuine readdress in `PUT /api/invitations/[id]`, and by `revivePendingInvitation`. Note that it is never read by any teacher-facing surface, and why that matters — it states which account shape an address holds.

- [ ] **Step 2: Re-read *Who an invitation reaches*, which Task 2 already amended**

Task 2 wrote the paragraph its own comment points at. Re-read it against the code as it now stands after Tasks 3-5 — the failure-path clear, both resets — and correct anything those tasks made imprecise. Do not duplicate it.

- [ ] **Step 3: Sweep for what this branch invalidated**

Read whole docblocks in the touched functions rather than grepping for names — what changed is what these describe, not what they are called:

```sh
grep -rn "teacherInboxNotifiedAt" src/ docs/ prisma/
```

Give every hit a verdict. Then read, in full:
- `src/app/api/invitations/[id]/resend/route.ts:18-37` — describes what a resend does and does not do.
- `src/lib/contacts.ts:24-42` — `invitationDeliveryStatus`'s docblock, which defers its writer census to `docs/data-model.md`. Decide whether it now under-describes the row; it probably does not, but the verdict must be recorded rather than assumed.
- `src/app/api/invitations/[id]/shared.ts` — `ownedInvitation`'s docblock, which explains which columns it selects and why. It must **not** gain the new column.

- [ ] **Step 4: Confirm the oracle constraint holds in code**

```sh
grep -rn "teacherInboxNotifiedAt" src/app src/lib src/components
```

Expected: hits in `src/app/api/invitations/[id]/route.ts` only (the reset). Any hit in `src/lib/contacts.ts`, `src/app/(teacher)/`, or a component is a violation of the Global Constraints.

- [ ] **Step 5: Full verification**

```bash
pnpm exec tsc --noEmit
pnpm run verify
pnpm run build
pnpm exec prisma validate
```

Record the arithmetic from `verify` (files/tests per tier) for the PR body. `pnpm run build` and `prisma validate` are CI-only gates that `verify` does not run.

- [ ] **Step 6: Commit**

```bash
git add docs/data-model.md src/services/invitations.ts 'src/app/api/invitations/[id]/resend/route.ts'
git commit -m "docs(invitations): record the dispatch cap and its writers (#622)"
```
