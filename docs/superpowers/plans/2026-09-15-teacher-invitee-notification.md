# Teacher-only invitee notification (#172) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An account with a teacher profile and no student profile, invited by another teacher, is told once, in its teacher inbox and by the unread-email fallback. Both lead to a page where it can add a student side, and then answer on the existing student page.

**Architecture:** `notifyInvitee` gains a branch between its `Student` check and the sign-in email. The dispatching routes pass a `PriorDispatch` value so a resend reaches a teacher-only address only once. Everything after that reuses existing pieces:
- `teacherNotificationHref` sends the inbox row to a new `(teacher)/inbox/invitations` page, and a teacher action-link map does the same for the email;
- the page lists the account's pending invitations and offers `POST /api/account/student-profile`;
- the invitation is then answered through the existing `/account/privacy` card.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (`unit`, `components`, `integration` projects), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-15-teacher-invitee-notification-design.md`

## Global Constraints

- **TypeScript:** `strict: true`. No `any` and no non-null assertions on values the code has not narrowed.
- **Services stay framework-agnostic:** no `next/*` import in `src/services/`.
- **`deliverInvitation` keeps returning `FireAndForget`.** No caller awaits it or attaches `.then`/`.catch`.
- **The respond route is untouched:** `POST /api/invitations/[id]/respond` stays `requireStudent` for both answers, and `tests/integration/invitations-api.test.ts`'s "refuses a teacher-only session" stays green.
- **Comment discipline (CLAUDE.md):**
  - A comment annotates the code it sits on; facts about another module go in `docs/`, with a link.
  - No counts or member rosters in comments.
  - Comments state what is true now; the before-and-after goes in the PR body.
- **Design system (`docs/design-brief.md`):**
  - the six type styles only, and no motion;
  - sand-soft surfaces with a 1px border, radius via `rounded-card`;
  - danger colour for text only;
  - no `cursor-pointer` class, because a global rule handles it.
- **Copy, verbatim from the spec:**
  - notification title: "A teacher would like to connect"
  - notification body: "{teacherName} added you as a contact. Connecting adds a student side to your account, and you choose whether to."
  - page heading: "Invitations"
  - per-teacher line: "{First} {Last} would like to connect with you as a student."
  - explanation: "Connecting adds a student side to your account, on the same sign-in. You choose whether to connect, and what each teacher can see."
  - button: "Set up student side"
  - empty state title: "No open invitations"
- **Staging:** stage exact paths only, never `git add -A` or `git add .`, and quote any path containing `(`, `)`, `[` or `]`.
- **Dev server:** never kill or restart a dev server on `:3000`. In this worktree, integration and e2e tests run against the worktree's own app (see *Before Task 1*).
- **Commits** end with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## Task order

Order is load-bearing in two places:
- **Task 1 before Task 2:** Task 2's repeat tests exercise Task 1's branch.
- **Task 5 last:** it tests the wiring every other task builds.

Tasks 3 and 4 are independent of each other.

## Before Task 1 — workspace

- [ ] Run `pnpm install --frozen-lockfile` (a fresh worktree has no `node_modules`; every `pnpm run`/`pnpm exec` fails with `ERR_PNPM_VERIFY_DEPS_BEFORE_RUN` until this runs).
- [ ] Run `pnpm run worktree:setup` once.
- [ ] Run `pnpm run worktree:up` before any `--project integration` or `playwright test` run. Both read `INTEGRATION_BASE_URL` automatically. Run `pnpm run worktree:down` when finished.

**Test commands used below:**
- `unit`: `pnpm exec vitest run --project unit <file>`. It uses the test database, and `src/**/*.test.ts` belongs to it, `src/app/api/**` route tests included.
- `components`: `pnpm exec vitest run --project components <file>`. It covers `src/components/**/*.test.tsx` and `src/app/**/*.test.tsx`, with `next/navigation` mocked by `tests/setup/components.ts`.
- `integration`: `pnpm exec vitest run --project integration <file>`.
- `e2e`: `pnpm exec playwright test <file>`.

**Mutation discipline, used by every task:**
1. Commit the task's green state first, so `git restore <file>` returns to it without discarding other work.
2. Apply one mutation.
3. For an integration or e2e check, request the touched route once so `next dev` finishes compiling before the test times it.
4. Run the named test and copy the exact failure text into the task report.
5. Run `git restore <file>`, then re-run the test and confirm it is green.

## File map

| File | Task | Responsibility |
|---|---|---|
| `src/services/invitations.ts` | 1, 2, 4 | Task 1: teacher branch in `notifyInvitee`. Task 2: `PriorDispatch`, `priorDispatchFor`, threading through `deliverInvitation`. Docblocks. |
| `src/services/invitations.notify.test.ts` | 1, 2 | Branch and repeat behaviour of `notifyInvitee` |
| `src/services/invitations.deliver.test.ts` | 2 | Existing calls gain `priorDispatch` |
| `src/services/invitations.prior-dispatch.test.ts` (new) | 2 | `priorDispatchFor` truth table |
| `src/app/api/students/route.ts` | 2 | Passes `priorDispatch: 'none'` |
| `src/app/api/students/prior-dispatch.test.ts` (new) | 2 | Pins create and revive as `'none'` |
| `src/app/api/invitations/[id]/shared.ts` | 2 | `ownedInvitation` selects the last-sent markers |
| `src/app/api/invitations/[id]/resend/route.ts` | 2 | Derives `priorDispatch` before its marker write |
| `src/app/api/invitations/[id]/resend/prior-dispatch.test.ts` (new) | 2 | Pins what resend passes on |
| `src/lib/notification-links.ts` (+ its test) | 3 | `TEACHER_INVITATION_PATH`, `TEACHER_INVITATION_LABEL`, `teacherNotificationHref` |
| `src/lib/email-templates.ts` (+ its test) | 1, 3 | Task 3: teacher action link. Task 1: `renderInvitationEmail` docblock. |
| `src/components/layout/notification-list.tsx` | 3 | Default row target becomes `teacherNotificationHref` |
| `src/components/layout/notification-list.test.tsx` (new) | 3 | Teacher rows open the right place |
| `src/components/account/set-up-student-side.tsx` (+ test, new) | 4 | The button |
| `src/app/(teacher)/inbox/invitations/page.tsx` (+ test, new) | 4 | The page |
| `tests/integration/invitations-api.test.ts` | 1, 5 | The #172 path over HTTP |
| `tests/e2e/invitations.spec.ts` | 5 | The journey in a browser |
| `docs/data-model.md` | 1, 2 | "Who an invitation reaches"; `last_notify_failed_at` row |
| `docs/information-architecture.md`, `docs/teacher-screens.md` | 4 | The new page |

---

### Task 1: `notifyInvitee` tells a teacher-only account in its teacher inbox

**Files:**
- Modify: `src/services/invitations.ts` (`notifyInvitee`, around lines 434-607; `deliverInvitation` docblock, around 649-657)
- Modify: `src/services/invitations.notify.test.ts`
- Modify: `tests/integration/invitations-api.test.ts` (new `describe` at the end of the file)
- Modify: `src/lib/email-templates.ts` (`renderInvitationEmail` docblock only), `src/lib/email-templates.test.ts` (one comment)
- Modify: `docs/data-model.md` (new paragraph; `last_notify_failed_at` row wording)

**Interfaces:**
- Consumes: `createNotification(db, { recipientType, recipientId, type, title, body })` from `src/services/notifications.ts`.
- Produces: `notifyInvitee`'s input and behaviour, which Task 2 extends. A `Notification` with `recipientType: 'teacher'` and `type: 'teacher_invitation'`, which Tasks 3 and 5 rely on.

- [ ] **Step 1: Write the failing service tests.** In `src/services/invitations.notify.test.ts`, inside the existing `describe('notifyInvitee — send-channel guards …')`, add these helpers after the `beforeEach` and then the three tests. They reuse the file's `prisma`, `suffix`, `teacherId` and `sendMock`.

```ts
  async function createTeacherOnlyInvitee(
    label: string,
  ): Promise<{ teacherId: string; accountId: string; email: string }> {
    const email = `notify-teacher-invitee-${label}-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Invitee', lastName: 'Teacher', email,
        account: { create: { email } },
        bio: '#172 teacher-only invitee fixture',
        pageSlug: `notify-teacher-invitee-${label}-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    return { teacherId: teacher.id, accountId: teacher.accountId, email };
  }

  async function removeTeacherOnlyInvitee(
    invitee: { teacherId: string; accountId: string },
  ): Promise<void> {
    await prisma.notification.deleteMany({
      where: { recipientType: 'teacher', recipientId: invitee.teacherId },
    });
    await prisma.teacher.delete({ where: { id: invitee.teacherId } });
    await prisma.account.delete({ where: { id: invitee.accountId } });
  }

  it('tells a teacher-only account in its teacher inbox, and sends no email (#172)', async () => {
    const invitee = await createTeacherOnlyInvitee('inbox');
    try {
      await notifyInvitee(prisma, { teacherId, email: invitee.email, teacherName: 'Some Teacher' });

      const notifications = await prisma.notification.findMany({
        where: { recipientType: 'teacher', recipientId: invitee.teacherId, type: 'teacher_invitation' },
        select: { title: true, body: true },
      });
      expect(notifications).toEqual([{
        title: 'A teacher would like to connect',
        body: 'Some Teacher added you as a contact. Connecting adds a student side to your account, and you choose whether to.',
      }]);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      await removeTeacherOnlyInvitee(invitee);
    }
  });

  it('gives an account holding both profiles the student notification only (#172)', async () => {
    const email = `notify-both-profiles-${suffix}@test.local`;
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'Both', lastName: 'Profiles', email,
        account: { create: { email } },
        bio: '#172 both-profiles fixture',
        pageSlug: `notify-both-profiles-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    const student = await prisma.student.create({
      data: {
        firstName: 'Both', lastName: 'Profiles', email,
        claimedAt: new Date(), accountId: teacher.accountId,
      },
      select: { id: true },
    });
    try {
      await notifyInvitee(prisma, { teacherId, email, teacherName: 'Some Teacher' });

      expect(await prisma.notification.count({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      })).toBe(1);
      expect(await prisma.notification.count({
        where: { recipientType: 'teacher', recipientId: teacher.id },
      })).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: { in: [student.id, teacher.id] } } });
      await prisma.student.delete({ where: { id: student.id } });
      await prisma.teacher.delete({ where: { id: teacher.id } });
      await prisma.account.delete({ where: { id: teacher.accountId } });
    }
  });

  it('sends nothing at all to a blocked teacher-only account (#172)', async () => {
    // Reachable without this feature writing a block: #171 keeps an erased
    // student's refusal, and the address can later hold a teacher account.
    const invitee = await createTeacherOnlyInvitee('blocked');
    const block = await prisma.teacherBlock.create({
      data: { teacherId, email: invitee.email },
      select: { id: true },
    });
    try {
      await notifyInvitee(prisma, { teacherId, email: invitee.email, teacherName: 'Some Teacher' });

      expect(await prisma.notification.count({
        where: { recipientType: 'teacher', recipientId: invitee.teacherId },
      })).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      await prisma.teacherBlock.delete({ where: { id: block.id } });
      await removeTeacherOnlyInvitee(invitee);
    }
  });
```

- [ ] **Step 2: Write the failing integration test.** At the end of `tests/integration/invitations-api.test.ts`, add this `describe`. It uses the file-level `teacherId`, `teacherToken`, `suffix`, `prisma` and imports. Task 5 adds more `it`s to it.

```ts
describe('an invitation to a teacher-only account (#172)', () => {
  const inviteeEmail = `inv-teacher-invitee-${suffix}@test.local`;
  let inviteeTeacherId: string;
  let inviteeAccountId: string;

  beforeAll(async () => {
    const invitee = await prisma.teacher.create({
      data: {
        firstName: 'Invitee', lastName: 'Teacher', email: inviteeEmail,
        account: { create: { email: inviteeEmail } },
        bio: '#172 teacher-only invitee',
        pageSlug: `inv-teacher-invitee-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    inviteeTeacherId = invitee.id;
    inviteeAccountId = invitee.accountId;
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({ where: { teacherId, email: inviteeEmail } });
    await prisma.notification.deleteMany({
      where: { recipientType: 'teacher', recipientId: inviteeTeacherId },
    });
    const student = await prisma.student.findUnique({
      where: { email: inviteeEmail },
      select: { id: true },
    });
    if (student) {
      await prisma.teacherStudent.deleteMany({ where: { studentId: student.id } });
      await prisma.notification.deleteMany({
        where: { recipientType: 'student', recipientId: student.id },
      });
      await prisma.student.delete({ where: { id: student.id } });
    }
    await prisma.session.deleteMany({ where: { accountId: inviteeAccountId } });
    await prisma.teacher.delete({ where: { id: inviteeTeacherId } });
    await prisma.account.delete({ where: { id: inviteeAccountId } });
  });

  it('reaches the invitee in their teacher inbox', async () => {
    const res = await fetch(`${BASE_URL}/api/students`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(teacherToken) },
      body: JSON.stringify({ firstName: 'Invitee', lastName: 'Teacher', email: inviteeEmail }),
    });
    expect(res.status).toBe(201);

    await waitFor(
      () => prisma.notification.findFirst({
        where: { recipientType: 'teacher', recipientId: inviteeTeacherId, type: 'teacher_invitation' },
      }),
      { description: 'teacher-inbox teacher_invitation for a teacher-only invitee (#172)' },
    );
  });
});
```

The invitee gets a session in Task 5, the first task that signs in as them.

- [ ] **Step 3: Run both and confirm they fail for the right reason.**

Run: `pnpm exec vitest run --project unit src/services/invitations.notify.test.ts`
Expected: the "teacher inbox" test FAILs, with `expected [] to deeply equal [ { title: …` and `sendMock` called once, because the sign-in email went out. "both profiles" passes (the student branch already answers first). "blocked" passes (the block check already runs first). Those two pin ordering for the mutations in Step 7.

Run: `pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts -t "teacher-only account"`
Expected: FAIL with `waitFor: condition not met within 2000ms (teacher-inbox teacher_invitation for a teacher-only invitee (#172))`.

- [ ] **Step 4: Implement the branch.** In `src/services/invitations.ts`, inside `notifyInvitee`, directly after the `if (student) { … return; }` block and before the "No Student row means no in-app surface…" comment, add:

```ts
  // Only an address with no `Student` row gets here, so an account holding
  // both profiles was answered above. Who each branch reaches, and why this
  // one needs no teacher liveness filter: `docs/data-model.md` (Invitation,
  // "Who an invitation reaches").
  const account = await db.account.findUnique({
    where: { email },
    select: { teacher: { select: { id: true } } },
  });
  if (account?.teacher) {
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

- [ ] **Step 5: Run both again and confirm they pass.** Same two commands as Step 3. Expected: PASS, and every other test in both files still passes.

- [ ] **Step 6: Commit.**

```bash
git add src/services/invitations.ts src/services/invitations.notify.test.ts tests/integration/invitations-api.test.ts
git commit -m "feat(invitations): tell a teacher-only invitee in its teacher inbox (#172)"
```

- [ ] **Step 7: Prove each guard bites** (mutation discipline, above).
  1. **Delete the `if (account?.teacher) { … }` block.** Run the notify test file and the integration `-t "teacher-only account"`. Record both failures.
  2. **Move the account lookup and the `if (account?.teacher)` block above the `Student` lookup.** Run the notify test file. Expected: "both profiles" FAILs (teacher count 1).
  3. **Move the same block above the `TeacherBlock` check.** Run the notify test file. Expected: "blocked" FAILs.

- [ ] **Step 8: Correct what this change makes false.** Read each passage whole and replace it; do not annotate.
  - **`src/services/invitations.ts`, `notifyInvitee`'s docblock summary** ("layer 1+2 … for a registered invitee, a plain email for everyone else (#166 task 8)"). It now reads: in-app for an address with a `Student` row or a teacher account, a plain email for everyone else (#166 task 8, #172).
  - **`notifyInvitee`, the comment above the `Student` lookup.** It says a miss "falls through to the plain-email branch below — which bypasses `Student.emailNotifications` entirely and tells an existing account holder to go and sign up". Now a miss falls through to the branches below: the teacher-inbox one for an account that also teaches, otherwise the plain email. Either way it bypasses `Student.emailNotifications`.
  - **`notifyInvitee`, the comment "No Student row means no in-app surface exists to notify".** It now reads: no `Student` row and no teacher account.
  - **`deliverInvitation`'s docblock, the `recordDispatchFailure` bullet.** "the registered-student path (`createNotification`, a local insert)" becomes "the in-app path (`createNotification`, a local insert, for a student or a teacher-only account)".
  - **`src/lib/email-templates.ts`, `renderInvitationEmail`'s docblock.** "the address has no `Student` row yet" becomes "the address has neither a `Student` row nor a teacher account", and "only ever runs for the 'no Student row' branch" becomes "only ever runs for an address with no in-app surface".
  - **`src/lib/email-templates.test.ts`, the comment in the "no 'welcome back'" test.** "only ever calls this for the 'no Student row' branch" becomes "only ever calls this for an address with neither a `Student` row nor a teacher account".
  - **`docs/data-model.md`, the `last_notify_failed_at` row.** "the registered-student path (`createNotification`, a local insert)" becomes "the in-app path (`createNotification`, a local insert, for a student or a teacher-only account)".
  - **`docs/data-model.md`, a new paragraph.** Insert it immediately before the `### TeacherBlock` heading:

```markdown
**Who an invitation reaches (#172).** `notifyInvitee` (`src/services/invitations.ts`) delivers an unblocked invitation through the first of these that holds for its address:

- **A `Student` row** gets a student-inbox `teacher_invitation`, or nothing if that student is already on this teacher's roster.
- **Otherwise, an `Account` with a teacher profile** gets a teacher-inbox `teacher_invitation`, which opens `/inbox/invitations`.
- **Otherwise,** the address gets the sign-in email.

An account holding both profiles therefore always takes the student branch.

The teacher branch filters on no teacher liveness, because no erased teacher can reach it:
- erasing an account's last live profile rewrites `Account.email`;
- erasing only the teacher leaves a live `Student` row on the address, which the first branch answers.

Re-derive the rewrites with `grep -n "tx.account.update" -A 3 src/services/gdpr.ts`.

A teacher-only account is offered no decline: leaving the invitation unanswered is its answer. So no `TeacherBlock` is written from one, and the student export's boundary in the TeacherBlock section below stays true.
```

- [ ] **Step 9: Re-run and commit.**

Run: `pnpm exec vitest run --project unit src/services/invitations.notify.test.ts src/lib/email-templates.test.ts`
Expected: PASS.

```bash
git add src/services/invitations.ts src/lib/email-templates.ts src/lib/email-templates.test.ts docs/data-model.md
git commit -m "docs(invitations): say who an invitation reaches now that teacher accounts have a branch (#172)"
```

---

### Task 2: A resend reaches a teacher-only address once

**Files:**
- Modify: `src/services/invitations.ts` (new `PriorDispatch`, `priorDispatchFor`; `notifyInvitee` and `deliverInvitation` inputs; docblocks)
- Create: `src/services/invitations.prior-dispatch.test.ts`
- Modify: `src/services/invitations.notify.test.ts`, `src/services/invitations.deliver.test.ts` (existing calls; three new tests)
- Modify: `src/app/api/students/route.ts`; Create: `src/app/api/students/prior-dispatch.test.ts`
- Modify: `src/app/api/invitations/[id]/shared.ts`, `src/app/api/invitations/[id]/resend/route.ts`; Create: `src/app/api/invitations/[id]/resend/prior-dispatch.test.ts`
- Modify: `docs/data-model.md`

**Interfaces:**
- Consumes: Task 1's teacher branch.
- Produces:
  - `export type PriorDispatch = 'none' | 'same_address'`
  - `export function priorDispatchFor(row: { email: string; lastNotifiedEmail: string | null; lastNotifyFailedAt: Date | null }): PriorDispatch`
  - `notifyInvitee(db, { teacherId: string; email: string; teacherName: string; priorDispatch: PriorDispatch })`
  - `deliverInvitation(db, { teacherId; email; invitationId; source; dispatchedAt; priorDispatch: PriorDispatch })`

- [ ] **Step 1: Write the failing unit test** in a new file, `src/services/invitations.prior-dispatch.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { priorDispatchFor } from './invitations';

describe('priorDispatchFor (#172)', () => {
  const email = 'invitee@test.local';

  it('is a repeat when the last dispatch went to this address and recorded no failure', () => {
    expect(priorDispatchFor({ email, lastNotifiedEmail: email, lastNotifyFailedAt: null }))
      .toBe('same_address');
  });

  it('is a first dispatch when nothing has been sent yet', () => {
    expect(priorDispatchFor({ email, lastNotifiedEmail: null, lastNotifyFailedAt: null }))
      .toBe('none');
  });

  it('is a first dispatch when the row was readdressed since the last one', () => {
    expect(priorDispatchFor({ email, lastNotifiedEmail: 'typo@test.local', lastNotifyFailedAt: null }))
      .toBe('none');
  });

  it('is a first dispatch when the last one recorded a failure', () => {
    expect(priorDispatchFor({ email, lastNotifiedEmail: email, lastNotifyFailedAt: new Date() }))
      .toBe('none');
  });
});
```

- [ ] **Step 2: Write the failing repeat tests.** Add these to `src/services/invitations.notify.test.ts`, next to Task 1's tests:

```ts
  it('does not tell a teacher-only account again on a repeat dispatch (#172)', async () => {
    const invitee = await createTeacherOnlyInvitee('repeat');
    try {
      await notifyInvitee(prisma, {
        teacherId, email: invitee.email, teacherName: 'Some Teacher', priorDispatch: 'same_address',
      });

      expect(await prisma.notification.count({
        where: { recipientType: 'teacher', recipientId: invitee.teacherId },
      })).toBe(0);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      await removeTeacherOnlyInvitee(invitee);
    }
  });

  it('still notifies a student on a repeat dispatch — the rule is the teacher branch alone (#172)', async () => {
    const email = `notify-student-repeat-${suffix}@test.local`;
    const student = await prisma.student.create({
      data: { firstName: 'Notify', lastName: 'StudentRepeat', email },
      select: { id: true },
    });
    try {
      await notifyInvitee(prisma, {
        teacherId, email, teacherName: 'Some Teacher', priorDispatch: 'same_address',
      });

      expect(await prisma.notification.count({
        where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
      })).toBe(1);
    } finally {
      await prisma.notification.deleteMany({ where: { recipientId: student.id } });
      await prisma.student.delete({ where: { id: student.id } });
    }
  });

  it('still emails an address with no account on a repeat dispatch (#172)', async () => {
    const email = `notify-stranger-repeat-${suffix}@test.local`;

    await notifyInvitee(prisma, {
      teacherId, email, teacherName: 'Some Teacher', priorDispatch: 'same_address',
    });

    expect(sendMock).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 3: Write the failing route tests.** Create `src/app/api/invitations/[id]/resend/prior-dispatch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { cookie, seedSession, uniqueSuffix } from '../../../../../../tests/helpers';

const { deliverInvitation } = vi.hoisted(() => ({ deliverInvitation: vi.fn() }));
vi.mock('@/services/invitations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/invitations')>()),
  deliverInvitation,
}));

import { POST } from './route';

const suffix = uniqueSuffix();

function resend(id: string, token: string): NextRequest {
  return new NextRequest(`http://localhost:3000/api/invitations/${id}/resend`, {
    method: 'POST',
    headers: cookie(token),
  });
}

describe('POST /api/invitations/[id]/resend passes the row as it stood before its marker write (#172)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let token: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'PriorDispatch', lastName: 'Teacher',
        email: `prior-dispatch-resend-${suffix}@test.local`,
        account: { create: { email: `prior-dispatch-resend-${suffix}@test.local` } },
        bio: '#172 priorDispatch threading fixture (resend)',
        pageSlug: `prior-dispatch-resend-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    token = await seedSession(prisma, teacherAccountId);
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: teacherAccountId } });
  });

  beforeEach(() => { deliverInvitation.mockClear(); });

  async function resendRow(label: string, markers: {
    lastNotifiedAt?: Date; lastNotifiedEmail?: string; lastNotifyFailedAt?: Date;
  }): Promise<void> {
    const email = `prior-dispatch-${label}-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Prior', lastName: label, ...markers },
      select: { id: true },
    });
    const res = await POST(resend(invitation.id, token), { params: Promise.resolve({ id: invitation.id }) });
    expect(res.status).toBe(200);
  }

  it('passes same_address for a row last sent to its current address', async () => {
    const email = `prior-dispatch-same-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: { teacherId, email, firstName: 'Prior', lastName: 'Same', lastNotifiedAt: new Date(), lastNotifiedEmail: email },
      select: { id: true },
    });
    const res = await POST(resend(invitation.id, token), { params: Promise.resolve({ id: invitation.id }) });
    expect(res.status).toBe(200);
    expect(deliverInvitation).toHaveBeenCalledWith(prisma, expect.objectContaining({ priorDispatch: 'same_address' }));
  });

  it('passes none for a row never sent', async () => {
    await resendRow('never', {});
    expect(deliverInvitation).toHaveBeenCalledWith(prisma, expect.objectContaining({ priorDispatch: 'none' }));
  });

  it('passes none for a row readdressed since its last dispatch', async () => {
    await resendRow('readdressed', {
      lastNotifiedAt: new Date(), lastNotifiedEmail: `prior-dispatch-typo-${suffix}@test.local`,
    });
    expect(deliverInvitation).toHaveBeenCalledWith(prisma, expect.objectContaining({ priorDispatch: 'none' }));
  });

  it('passes none when the last dispatch recorded a failure', async () => {
    const email = `prior-dispatch-failed-${suffix}@test.local`;
    const invitation = await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Prior', lastName: 'Failed',
        lastNotifiedAt: new Date(), lastNotifiedEmail: email, lastNotifyFailedAt: new Date(),
      },
      select: { id: true },
    });
    const res = await POST(resend(invitation.id, token), { params: Promise.resolve({ id: invitation.id }) });
    expect(res.status).toBe(200);
    expect(deliverInvitation).toHaveBeenCalledWith(prisma, expect.objectContaining({ priorDispatch: 'none' }));
  });
});
```

Then create `src/app/api/students/prior-dispatch.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { cookie, seedSession, uniqueSuffix } from '../../../../tests/helpers';

const { deliverInvitation } = vi.hoisted(() => ({ deliverInvitation: vi.fn() }));
vi.mock('@/services/invitations', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/invitations')>()),
  deliverInvitation,
}));

import { POST } from './route';

const suffix = uniqueSuffix();

function add(email: string, token: string): NextRequest {
  return new NextRequest('http://localhost:3000/api/students', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    body: JSON.stringify({ firstName: 'Prior', lastName: 'Add', email }),
  });
}

describe('POST /api/students always makes a first dispatch (#172)', () => {
  let teacherId: string;
  let teacherAccountId: string;
  let token: string;

  beforeAll(async () => {
    const teacher = await prisma.teacher.create({
      data: {
        firstName: 'PriorDispatch', lastName: 'AddTeacher',
        email: `prior-dispatch-add-${suffix}@test.local`,
        account: { create: { email: `prior-dispatch-add-${suffix}@test.local` } },
        bio: '#172 priorDispatch threading fixture (create)',
        pageSlug: `prior-dispatch-add-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    teacherId = teacher.id;
    teacherAccountId = teacher.accountId;
    token = await seedSession(prisma, teacherAccountId);
  });

  afterAll(async () => {
    await prisma.invitation.deleteMany({ where: { teacherId } });
    await prisma.session.deleteMany({ where: { accountId: teacherAccountId } });
    await prisma.teacher.delete({ where: { id: teacherId } });
    await prisma.account.delete({ where: { id: teacherAccountId } });
  });

  beforeEach(() => { deliverInvitation.mockClear(); });

  it('passes none for a new contact', async () => {
    const res = await POST(add(`prior-dispatch-new-${suffix}@test.local`, token));
    expect(res.status).toBe(201);
    expect(deliverInvitation).toHaveBeenCalledWith(prisma, expect.objectContaining({ priorDispatch: 'none' }));
  });

  it('passes none for a revived invitation, even though its markers name the same address', async () => {
    const email = `prior-dispatch-revive-${suffix}@test.local`;
    await prisma.invitation.create({
      data: {
        teacherId, email, firstName: 'Prior', lastName: 'Revive',
        status: 'accepted', respondedAt: new Date(),
        lastNotifiedAt: new Date(), lastNotifiedEmail: email,
      },
    });
    const res = await POST(add(email, token));
    expect(res.status).toBe(201);
    expect(deliverInvitation).toHaveBeenCalledWith(prisma, expect.objectContaining({ priorDispatch: 'none' }));
  });
});
```

`resendRow` covers the two cases with unrelated markers. The same-address and failed cases build their rows inline, because their `lastNotifiedEmail` must equal the row's own address.

- [ ] **Step 4: Run them and confirm they fail.**

Run: `pnpm exec vitest run --project unit src/services/invitations.prior-dispatch.test.ts src/services/invitations.notify.test.ts "src/app/api/invitations/[id]/resend/prior-dispatch.test.ts" src/app/api/students/prior-dispatch.test.ts`
Expected: FAIL.
- `invitations.prior-dispatch.test.ts` fails to import `priorDispatchFor`.
- Vitest does not typecheck, so the extra `priorDispatch` field reaches `notifyInvitee` unread. "does not tell a teacher-only account again" FAILs with count 1. The two "still …" tests already pass: they pin the other side of the rule for Step 9's mutation 3.
- Both route test files FAIL, because `deliverInvitation` was called without `priorDispatch`.

- [ ] **Step 5: Implement.** In `src/services/invitations.ts`, immediately above `notifyInvitee`'s docblock, add:

```ts
/**
 * Whether a dispatch has already reached the invitation's current address.
 * `notifyInvitee`'s teacher-account branch is the only reader (#172).
 */
export type PriorDispatch = 'none' | 'same_address';

/**
 * Read from the row as it stood BEFORE the dispatching route's own
 * unconditional marker write — read after it, every dispatch is a repeat.
 */
export function priorDispatchFor(row: {
  email: string;
  lastNotifiedEmail: string | null;
  lastNotifyFailedAt: Date | null;
}): PriorDispatch {
  return row.lastNotifiedEmail === row.email && row.lastNotifyFailedAt === null
    ? 'same_address'
    : 'none';
}
```

Change `notifyInvitee`'s input type to `{ teacherId: string; email: string; teacherName: string; priorDispatch: PriorDispatch }`. In the teacher branch from Task 1, add the repeat check as the first statement inside `if (account?.teacher) {`:

```ts
  if (account?.teacher) {
    if (input.priorDispatch === 'same_address') return;
    await createNotification(db, {
```

Add `priorDispatch: PriorDispatch;` to `deliverInvitation`'s input type, with the doc comment `/** \`priorDispatchFor\` of the row before this dispatch's own marker write. */`, and pass it on:

```ts
    await notifyInvitee(db, {
      teacherId: input.teacherId,
      email: input.email,
      teacherName: `${teacher.firstName} ${teacher.lastName}`,
      priorDispatch: input.priorDispatch,
    });
```

In `src/app/api/students/route.ts`, add `priorDispatch: 'none',` to the `deliverInvitation` call, with the comment `// A create or a revive is a new invitation to this address.` above that line.

In `src/app/api/invitations/[id]/shared.ts`, change `ownedInvitation`'s select to `{ id: true, status: true, isArchived: true, email: true, lastNotifiedEmail: true, lastNotifyFailedAt: true }`. Then replace the docblock's last paragraph (the one ending "alongside the other three.") with:

```ts
 * `email` is selected for the resend route's dispatch, and PUT also reads it,
 * to compare against the incoming address and decide whether to reset
 * `delivered` (#502 Fix #3). `lastNotifiedEmail` and `lastNotifyFailedAt` are
 * for the resend route: it derives `priorDispatchFor` from them before its own
 * marker write overwrites them (#172). A route that ignores a column pays
 * nothing for selecting it.
```

In `src/app/api/invitations/[id]/resend/route.ts`:
- import `priorDispatchFor` alongside `deliverInvitation` from `@/services/invitations`;
- directly above `const dispatchedAt = new Date();`, add:

```ts
  // Before the marker write below, which overwrites what this reads.
  const priorDispatch = priorDispatchFor(invitation);
```

- then add `priorDispatch,` to the `deliverInvitation` call.

- [ ] **Step 6: Update every existing call site the compiler now rejects.**

Run: `pnpm run typecheck`
Expected: errors only in `src/services/invitations.notify.test.ts` and `src/services/invitations.deliver.test.ts`, each a `notifyInvitee`/`deliverInvitation` call missing `priorDispatch`. Add `priorDispatch: 'none'` to each: none of those tests is about repeats. That includes Task 1's three tests in the notify file. Re-run until typecheck is clean.

- [ ] **Step 7: Run and confirm they pass.**

Run: `pnpm exec vitest run --project unit src/services/invitations.prior-dispatch.test.ts src/services/invitations.notify.test.ts src/services/invitations.deliver.test.ts "src/app/api/invitations/[id]/resend/prior-dispatch.test.ts" "src/app/api/invitations/[id]/resend/dispatch-threading.test.ts" src/app/api/students/prior-dispatch.test.ts src/app/api/students/dispatch-threading.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add src/services/invitations.ts src/services/invitations.prior-dispatch.test.ts src/services/invitations.notify.test.ts src/services/invitations.deliver.test.ts src/app/api/students/route.ts src/app/api/students/prior-dispatch.test.ts "src/app/api/invitations/[id]/shared.ts" "src/app/api/invitations/[id]/resend/route.ts" "src/app/api/invitations/[id]/resend/prior-dispatch.test.ts"
git commit -m "feat(invitations): a resend reaches a teacher-only address once (#172)"
```

- [ ] **Step 9: Prove each guard bites.**
  1. **Delete `if (input.priorDispatch === 'same_address') return;`.** Expected: the notify test "does not tell a teacher-only account again" FAILs.
  2. **In `priorDispatchFor`, change `row.lastNotifiedEmail === row.email` to `!==`.** Expected: the `priorDispatchFor` tests FAIL, and so do the resend route's `same_address`, `never` and `readdressed` cases.
  3. **Move the repeat check out of the teacher branch, to the first line of `notifyInvitee`.** Expected: "still notifies a student on a repeat dispatch" and "still emails an address with no account on a repeat dispatch" FAIL.
  4. **In the resend route, replace `priorDispatchFor(invitation)` with `priorDispatchFor({ ...invitation, lastNotifiedEmail: invitation.email, lastNotifyFailedAt: null })`.** This reproduces reading the row after the marker write. Expected: the resend route's `never`, `readdressed` and `failed` cases FAIL.
  5. **In `src/app/api/students/route.ts`, change `'none'` to `'same_address'`.** Expected: both students prior-dispatch tests FAIL.

- [ ] **Step 10: Correct what this change makes false, then commit.**
  - **`docs/data-model.md`, the `last_notify_failed_at` row.** "never on either `notifyInvitee` early return (blocked, already linked)" becomes "never on a `notifyInvitee` early return (blocked, already linked, or a repeat dispatch to a teacher-only account, `priorDispatchFor`, #172)".
  - **`docs/data-model.md`, Task 1's "Who an invitation reaches" paragraph.** Append:

```markdown
The teacher branch alone also reads `priorDispatch`. A resend to the address the row was last dispatched to, with no failure recorded since (`priorDispatchFor`), tells a teacher-only account nothing. A teacher recipient's fallback email consults no preference, so without this every resend would reach them again. Removing and re-adding the contact creates a new row, whose dispatch counts as a first one.
```

  - **`src/services/invitations.ts`, `notifyInvitee`'s docblock.** After the paragraph about `teacher_invitation` not being in `ESSENTIAL_NOTIFICATION_TYPES`, add:

```ts
 * `priorDispatch` is read by the teacher-account branch alone: a teacher
 * recipient's fallback email consults no preference, so a resend that
 * repeated would reach a teacher-only account every time. Students keep their
 * opt-out and their decline (#172).
```

Run: `pnpm exec vitest run --project unit src/services/invitations.notify.test.ts`
Expected: PASS.

```bash
git add src/services/invitations.ts docs/data-model.md
git commit -m "docs(invitations): record the once-per-address rule for teacher-only invitees (#172)"
```

---

### Task 3: The inbox row and the email both point to the invitations page

**Files:**
- Modify: `src/lib/notification-links.ts`, `src/lib/notification-links.test.ts`
- Modify: `src/lib/email-templates.ts`, `src/lib/email-templates.test.ts`
- Modify: `src/components/layout/notification-list.tsx`
- Create: `src/components/layout/notification-list.test.tsx`

**Interfaces:**
- Consumes: a teacher-recipient `teacher_invitation` notification (Task 1).
- Produces:
  - `export const TEACHER_INVITATION_PATH = '/inbox/invitations'`
  - `export const TEACHER_INVITATION_LABEL = 'Review the invitation'`
  - `export function teacherNotificationHref(n: { type: NotificationType; relatedClassId: string | null }): string | null`

  Task 4's page lives at `TEACHER_INVITATION_PATH`.

- [ ] **Step 1: Write the failing tests.** In `src/lib/notification-links.test.ts`, extend the import to `import { STUDENT_INVITATION_PATH, TEACHER_INVITATION_PATH, studentNotificationHref, teacherNotificationHref } from './notification-links';` and add:

```ts
describe('teacherNotificationHref (#172)', () => {
  it('sends a teacher invitation to the invitations page', () => {
    expect(teacherNotificationHref({ type: 'teacher_invitation', relatedClassId: null }))
      .toBe(TEACHER_INVITATION_PATH);
  });

  it('sends a class notification to its class', () => {
    expect(teacherNotificationHref({ type: 'booking_confirmed', relatedClassId: 'class-1' }))
      .toBe('/class/class-1');
  });

  it('yields null for a notification with neither', () => {
    expect(teacherNotificationHref({ type: 'announcement', relatedClassId: null })).toBeNull();
  });
});
```

In `src/lib/email-templates.test.ts`, add `import { STUDENT_INVITATION_PATH, TEACHER_INVITATION_PATH } from './notification-links';` and, inside `describe('email templates')`:

```ts
  it('links a teacher-inbox invitation to the teacher invitations page (#172)', () => {
    const { html } = renderNotificationEmail(
      { type: 'teacher_invitation', title: 'A teacher would like to connect', body: 'Anna added you.', recipientType: 'teacher' },
      'https://example.test',
    );
    expect(html).toContain(`href="https://example.test${TEACHER_INVITATION_PATH}"`);
    expect(html).not.toContain(STUDENT_INVITATION_PATH);
  });

  it('still links a student invitation to the student page (#172)', () => {
    const { html } = renderNotificationEmail(
      { type: 'teacher_invitation', title: 'A teacher would like to connect', body: 'Anna added you.', recipientType: 'student' },
      'https://example.test',
    );
    expect(html).toContain(`href="https://example.test${STUDENT_INVITATION_PATH}"`);
    expect(html).not.toContain(TEACHER_INVITATION_PATH);
  });

  it('gives a teacher notification about a class no invitation link (#172)', () => {
    const { html } = renderNotificationEmail(
      { type: 'booking_confirmed', title: 'Anna booked', body: 'Tuesday Vinyasa.', recipientType: 'teacher' },
      'https://example.test',
    );
    expect(html).not.toContain(TEACHER_INVITATION_PATH);
    expect(html).not.toContain(STUDENT_INVITATION_PATH);
  });
```

Create `src/components/layout/notification-list.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Notification } from '@prisma/client';
import { routerPush } from '../../../tests/setup/components';
import { TEACHER_INVITATION_PATH } from '@/lib/notification-links';
import { NotificationList } from './notification-list';

function notification(over: Partial<Notification>): Notification {
  return {
    id: 'n-1', recipientType: 'teacher', recipientId: 't-1', type: 'announcement',
    title: 'Title', body: 'Body', relatedClassId: null, isRead: false, emailSent: false,
    createdAt: new Date('2026-09-15T10:00:00Z'), updatedAt: new Date('2026-09-15T10:00:00Z'),
    ...over,
  };
}

describe('NotificationList — where a teacher row goes (#172)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('opens the invitations page from a teacher invitation row', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<NotificationList notifications={[
      notification({ type: 'teacher_invitation', title: 'A teacher would like to connect' }),
    ]} />);

    fireEvent.click(screen.getByRole('button', { name: /^A teacher would like to connect/ }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(TEACHER_INVITATION_PATH));
  });

  it('still opens a class row on its class', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
    render(<NotificationList notifications={[
      notification({ type: 'booking_confirmed', title: 'Anna booked', relatedClassId: 'class-9' }),
    ]} />);

    fireEvent.click(screen.getByRole('button', { name: /^Anna booked/ }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith('/class/class-9'));
  });
});
```

The name regexes are anchored with `^` because each row also has a "Mark "…" read" button whose accessible name contains the title.

- [ ] **Step 2: Run them and confirm they fail.**

Run: `pnpm exec vitest run --project unit src/lib/notification-links.test.ts src/lib/email-templates.test.ts`
Expected: FAIL. `TEACHER_INVITATION_PATH` and `teacherNotificationHref` are not exported, and the teacher email has no `href` to the path.

Run: `pnpm exec vitest run --project components src/components/layout/notification-list.test.tsx`
Expected: FAIL. `routerPush` is never called for the invitation row, because the current default yields `null`.

- [ ] **Step 3: Implement.** In `src/lib/notification-links.ts`:
  - change the module docblock's first line to "Where a notification points its reader.";
  - replace "One module so the two student surfaces (`/updates` and the strip on `/bookings`) and the layer-3 fallback email cannot drift on where an invitation goes." with "One module so the inbox surfaces and the layer-3 fallback email cannot drift on where an invitation goes, for either reader.";
  - add, after `STUDENT_INVITATION_LABEL`:

```ts
/**
 * Where a teacher-inbox `teacher_invitation` sends an account with no student
 * side yet: the page that offers one (#172).
 */
export const TEACHER_INVITATION_PATH = '/inbox/invitations';

/** The label for that action, shared by the email's button. */
export const TEACHER_INVITATION_LABEL = 'Review the invitation';
```

and at the end of the file:

```ts
/**
 * The href for a teacher's inbox row, or null when the row is not
 * actionable. Type first, related class second, for the same reason
 * `studentNotificationHref` takes that order.
 */
export function teacherNotificationHref(notification: {
  type: NotificationType;
  relatedClassId: string | null;
}): string | null {
  if (notification.type === 'teacher_invitation') return TEACHER_INVITATION_PATH;
  return notification.relatedClassId ? `/class/${notification.relatedClassId}` : null;
}
```

In `src/lib/email-templates.ts`, extend the import from `./notification-links` with `TEACHER_INVITATION_LABEL, TEACHER_INVITATION_PATH`. After `STUDENT_ACTION_LINKS`, add:

```ts
/** The teacher reader's counterpart to `STUDENT_ACTION_LINKS` (#172). */
const TEACHER_ACTION_LINKS: Partial<Record<NotificationType, { label: string; path: string }>> = {
  teacher_invitation: { label: TEACHER_INVITATION_LABEL, path: TEACHER_INVITATION_PATH },
};
```

and in `renderNotificationEmail`, change `? undefined` in the `action` expression to `? TEACHER_ACTION_LINKS[notification.type]`.

In `src/components/layout/notification-list.tsx`:
- delete the local `notificationHref` function;
- import `teacherNotificationHref` from `@/lib/notification-links`;
- in `resolveHref`, return `teacherNotificationHref(notification)` in its place;
- change the `hrefById` prop's docblock to: "Per-row link overrides. Without it, rows take the teacher targets (`teacherNotificationHref`); student pages must pass their own."

- [ ] **Step 4: Run and confirm they pass.** Same commands as Step 2. Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/notification-links.ts src/lib/notification-links.test.ts src/lib/email-templates.ts src/lib/email-templates.test.ts src/components/layout/notification-list.tsx src/components/layout/notification-list.test.tsx
git commit -m "feat(notifications): send a teacher invitation's row and email to the invitations page (#172)"
```

- [ ] **Step 6: Prove each guard bites.**
  1. **Delete the `teacher_invitation` line in `teacherNotificationHref`.** Expected: the lib test and the component invitation test FAIL.
  2. **In `NotificationList`, return `notification.relatedClassId ? \`/class/${notification.relatedClassId}\` : null` in place of the `teacherNotificationHref` call.** Expected: the component invitation test FAILs, and the lib test still passes. This is why both exist.
  3. **Change `TEACHER_ACTION_LINKS[notification.type]` back to `undefined`.** Expected: "links a teacher-inbox invitation" FAILs.

---

### Task 4: The `/inbox/invitations` page

**Files:**
- Create: `src/components/account/set-up-student-side.tsx`, `src/components/account/set-up-student-side.test.tsx`
- Create: `src/app/(teacher)/inbox/invitations/page.tsx`, `src/app/(teacher)/inbox/invitations/page.test.tsx`
- Modify: `src/services/invitations.ts` (`listPendingInvitations` docblock)
- Modify: `docs/information-architecture.md` (*Tab 3: Inbox*), `docs/teacher-screens.md` (§10.1)

**Interfaces:**
- Consumes:
  - `listPendingInvitations(db, { accountEmail: string }): Promise<Array<{ id: string; teacher: { firstName: string; lastName: string } }>>`
  - `STUDENT_INVITATION_PATH`
  - `requireTeacherSession(): Promise<TeacherSession>`, whose `studentId: string | null` and `accountId: string` this page reads
- Produces: the page at `TEACHER_INVITATION_PATH` (Task 3's constant, whose value is `/inbox/invitations`).

- [ ] **Step 1: Write the failing component test** in a new file, `src/components/account/set-up-student-side.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { routerPush } from '../../../tests/setup/components';
import { STUDENT_INVITATION_PATH } from '@/lib/notification-links';
import { SetUpStudentSide } from './set-up-student-side';

describe('SetUpStudentSide (#172)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('adds the student side, then goes to the page that answers invitations', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201 });
    vi.stubGlobal('fetch', fetchMock);
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(STUDENT_INVITATION_PATH));
    expect(fetchMock).toHaveBeenCalledWith('/api/account/student-profile', { method: 'POST' });
  });

  it('treats a student side that already exists as done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({}) }));
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    await vi.waitFor(() => expect(routerPush).toHaveBeenCalledWith(STUDENT_INVITATION_PATH));
  });

  it('says so, and stays put, when the request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) }));
    render(<SetUpStudentSide />);

    fireEvent.click(screen.getByRole('button', { name: 'Set up student side' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/Could not set up your student side/);
    expect(routerPush).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Write the failing page test** in a new file, `src/app/(teacher)/inbox/invitations/page.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

const { requireTeacherSession, findUniqueOrThrow, listPendingInvitations, redirect } = vi.hoisted(() => ({
  requireTeacherSession: vi.fn(),
  findUniqueOrThrow: vi.fn(),
  listPendingInvitations: vi.fn(),
  redirect: vi.fn((to: string) => { throw new Error(`REDIRECT:${to}`); }),
}));

vi.mock('@/lib/session', () => ({ requireTeacherSession }));
vi.mock('@/lib/db', () => ({ prisma: { account: { findUniqueOrThrow } } }));
vi.mock('@/services/invitations', () => ({ listPendingInvitations }));
vi.mock('next/navigation', () => ({
  redirect,
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

import TeacherInvitationsPage from './page';

const TEACHER_ONLY = {
  sessionId: 's1', accountId: 'a1', teacherId: 't1', studentId: null, defaultTimezone: 'Europe/Amsterdam',
};

beforeEach(() => {
  vi.clearAllMocks();
  findUniqueOrThrow.mockResolvedValue({ email: 'invitee@test.local' });
});

describe('the teacher invitations page (#172)', () => {
  it('sends an account that already has a student side to the student page', async () => {
    requireTeacherSession.mockResolvedValue({ ...TEACHER_ONLY, studentId: 'st1' });

    await expect(TeacherInvitationsPage()).rejects.toThrow('REDIRECT:/account/privacy');
    expect(listPendingInvitations).not.toHaveBeenCalled();
  });

  it('names each inviting teacher and offers the student side once', async () => {
    requireTeacherSession.mockResolvedValue(TEACHER_ONLY);
    listPendingInvitations.mockResolvedValue([
      { id: 'inv-1', teacher: { firstName: 'Anna', lastName: 'Teacher' } },
      { id: 'inv-2', teacher: { firstName: 'Ben', lastName: 'Teacher' } },
    ]);

    render(await TeacherInvitationsPage());

    expect(screen.getByText('Anna Teacher would like to connect with you as a student.')).toBeInTheDocument();
    expect(screen.getByText('Ben Teacher would like to connect with you as a student.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Set up student side' })).toHaveLength(1);
    expect(listPendingInvitations).toHaveBeenCalledWith(expect.anything(), { accountEmail: 'invitee@test.local' });
  });

  it('says plainly when nothing is waiting', async () => {
    requireTeacherSession.mockResolvedValue(TEACHER_ONLY);
    listPendingInvitations.mockResolvedValue([]);

    render(await TeacherInvitationsPage());

    expect(screen.getByText('No open invitations')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up student side' })).toBeNull();
  });
});
```

- [ ] **Step 3: Run them and confirm they fail.**

Run: `pnpm exec vitest run --project components src/components/account/set-up-student-side.test.tsx "src/app/(teacher)/inbox/invitations/page.test.tsx"`
Expected: FAIL, with modules not found for `./set-up-student-side` and `./page`.

- [ ] **Step 4: Implement the component** at `src/components/account/set-up-student-side.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { readErrorMessage } from '@/lib/client-errors';
import { STUDENT_INVITATION_PATH } from '@/lib/notification-links';

// Adding the student side is the account holder's own act; the invitation is
// answered on the student page it leads to.
export function SetUpStudentSide() {
  const router = useRouter();
  const [state, setState] = useState<'idle' | 'working' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function handleSetUp() {
    setState('working');
    try {
      const res = await fetch('/api/account/student-profile', { method: 'POST' });
      // 409 ALREADY_STUDENT: another tab or a second tap got there first, and
      // the student page is where this was going anyway.
      if (!res.ok && res.status !== 409) {
        setMessage(await readErrorMessage(res, 'Could not set up your student side. Try again.'));
        setState('error');
        return;
      }
      router.push(STUDENT_INVITATION_PATH);
      // If the navigation never commits, don't leave a dead button behind.
      setTimeout(() => setState('idle'), 4000);
    } catch {
      setMessage('Network error. Try again.');
      setState('error');
    }
  }

  return (
    <div>
      <Button onClick={handleSetUp} disabled={state === 'working'} className="w-full">
        {state === 'working' ? 'One moment...' : 'Set up student side'}
      </Button>
      {state === 'error' && (
        <p role="alert" className="text-[13px] leading-[1.4] text-danger mt-3">{message}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Implement the page** at `src/app/(teacher)/inbox/invitations/page.tsx`. Each per-teacher line is one template string, not adjacent JSX text: React's server render puts a comment marker between adjacent text nodes, and Task 5's HTML assertion reads the rendered page.

```tsx
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { listPendingInvitations } from '@/services/invitations';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { SetUpStudentSide } from '@/components/account/set-up-student-side';
import { STUDENT_INVITATION_PATH } from '@/lib/notification-links';

export const dynamic = 'force-dynamic';

export default async function TeacherInvitationsPage() {
  const session = await requireTeacherSession();
  // With a student side, invitations are answered on the student page — an
  // account holding both profiles, or one that added its student side after
  // the notification that led here.
  if (session.studentId) redirect(STUDENT_INVITATION_PATH);

  // Read on every load, not taken from the notification: since it was sent
  // the contact may have been removed or the invitation answered.
  const account = await prisma.account.findUniqueOrThrow({
    where: { id: session.accountId },
    select: { email: true },
  });
  const invitations = await listPendingInvitations(prisma, { accountEmail: account.email });

  return (
    <div>
      <PageHeader title="Invitations" backHref="/inbox" />
      {invitations.length === 0 ? (
        <EmptyState
          title="No open invitations"
          body="An invitation you were sent is no longer waiting for an answer."
          action={<Link href="/inbox" className="type-label text-teal no-underline">Back to Inbox</Link>}
        />
      ) : (
        <section className="bg-sand-soft border border-border rounded-card p-5 max-w-[420px]">
          <ul className="flex flex-col gap-2 mb-4">
            {invitations.map((invitation) => (
              <li key={invitation.id} className="type-body text-ink">
                {`${invitation.teacher.firstName} ${invitation.teacher.lastName} would like to connect with you as a student.`}
              </li>
            ))}
          </ul>
          <p className="type-body mb-4">
            Connecting adds a student side to your account, on the same sign-in. You choose whether
            to connect, and what each teacher can see.
          </p>
          <SetUpStudentSide />
        </section>
      )}
    </div>
  );
}
```

- [ ] **Step 6: Run and confirm they pass.** Same command as Step 3. Expected: PASS.

- [ ] **Step 7: Check the page in the running app.** With `pnpm run worktree:up` running, sign in as a teacher-only account that has a pending invitation (the `verify` skill has recipes for signing in without email). Open `/inbox/invitations` at phone width (375px) and check:
  - there is a back link to Inbox and no tab bar;
  - each inviting teacher gets one line, followed by the explanation and one button;
  - tapping the button lands on `/account/privacy` with the invitation under "Pending invitations".

  Judge spacing at 100% zoom, not from a zoomed screenshot.

- [ ] **Step 8: Commit.**

```bash
git add src/components/account/set-up-student-side.tsx src/components/account/set-up-student-side.test.tsx "src/app/(teacher)/inbox/invitations/page.tsx" "src/app/(teacher)/inbox/invitations/page.test.tsx"
git commit -m "feat(inbox): an invitations page that offers a teacher-only account its student side (#172)"
```

- [ ] **Step 9: Prove each guard bites.**
  1. **Delete the `if (session.studentId) redirect(…)` line.** Expected: "sends an account that already has a student side" FAILs.
  2. **Move `<SetUpStudentSide />` inside the `<li>` in the map.** Expected: "names each inviting teacher and offers the student side once" FAILs with length 2.
  3. **In `SetUpStudentSide`, remove `&& res.status !== 409`.** Expected: "treats a student side that already exists as done" FAILs.

- [ ] **Step 10: Correct what this change makes false, then commit.**
  - **`src/services/invitations.ts`, `listPendingInvitations`' docblock.** Its first sentence names `(student)/account/privacy/page.tsx` as the reader. Add: "`(teacher)/inbox/invitations/page.tsx` reads it too, for an account with no student side yet (#172). The address, not a student id, is what lets it."
  - **`docs/information-architecture.md`, `## Tab 3: Inbox`.** After the paragraph beginning "A simple chronological list", add: "An invitation from another teacher, sent to an account without a student side, opens `/inbox/invitations`. It names who invited them and offers to add a student side; the invitation itself is then answered on the student's own `/account/privacy` (#172)."
  - **`docs/teacher-screens.md` §10.1.** Change the Types bullet to "Types: registration alerts, auto-cancel notices, payment received, system announcements, invitations from other teachers (tap opens the invitations page, which offers a student side)". Do not change the Screen Count Summary.

```bash
git add src/services/invitations.ts docs/information-architecture.md docs/teacher-screens.md
git commit -m "docs(inbox): record the invitations page in the IA and screen inventory (#172)"
```

---

### Task 5: The journey, over HTTP and in a browser

**Files:**
- Modify: `tests/integration/invitations-api.test.ts` (Task 1's `describe`)
- Modify: `tests/e2e/invitations.spec.ts` (new `describe` at the end)

**Interfaces:**
- Consumes: everything above. Fixture names from Task 1's `describe`: `inviteeEmail`, `inviteeTeacherId`, `inviteeAccountId`. File-level: `teacherId`, `teacherToken`, `suffix`, `prisma`, `BASE_URL`, `cookie`, `seedSession`, `waitFor`.
- Produces: nothing later tasks use.

- [ ] **Step 1: Add the integration tests.** First give the invitee a session. In Task 1's `describe('an invitation to a teacher-only account (#172)')`, declare `let inviteeToken: string;` beside `inviteeAccountId`, and add `inviteeToken = await seedSession(prisma, inviteeAccountId);` as the last line of its `beforeAll`; its `afterAll` already deletes the invitee's sessions. Then, after "reaches the invitee in their teacher inbox", add these three in this order. They share the invitation row, and the resend test needs it still pending.

```ts
  it("lists the invitation on the invitee's invitations page", async () => {
    const res = await fetch(`${BASE_URL}/inbox/invitations`, { headers: cookie(inviteeToken) });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Invitation Teacher would like to connect with you as a student.');
  });

  it('does not tell the invitee again when the invitation is resent unchanged', async () => {
    // Control: a second teacher-only account whose row was readdressed since its
    // last dispatch, so its resend is a first one. Issued after the repeat, so
    // once the control's notification lands, the repeat's would have too.
    const controlEmail = `inv-teacher-invitee-control-${suffix}@test.local`;
    const control = await prisma.teacher.create({
      data: {
        firstName: 'Control', lastName: 'Invitee', email: controlEmail,
        account: { create: { email: controlEmail } },
        bio: '#172 resend control', pageSlug: `inv-teacher-invitee-control-${suffix}`,
      },
      select: { id: true, accountId: true },
    });
    const controlInvitation = await prisma.invitation.create({
      data: {
        teacherId, email: controlEmail, firstName: 'Control', lastName: 'Invitee',
        lastNotifiedAt: new Date(), lastNotifiedEmail: `inv-typo-${suffix}@test.local`,
      },
      select: { id: true },
    });
    try {
      const invitation = await prisma.invitation.findUniqueOrThrow({
        where: { teacherId_email: { teacherId, email: inviteeEmail } },
        select: { id: true },
      });

      const repeat = await fetch(`${BASE_URL}/api/invitations/${invitation.id}/resend`, {
        method: 'POST', headers: cookie(teacherToken),
      });
      const first = await fetch(`${BASE_URL}/api/invitations/${controlInvitation.id}/resend`, {
        method: 'POST', headers: cookie(teacherToken),
      });

      // Neither status nor body tells the teacher which resend reached anyone.
      expect(repeat.status).toBe(200);
      expect(first.status).toBe(200);
      expect(await repeat.json()).toEqual({ data: { id: invitation.id } });
      expect(await first.json()).toEqual({ data: { id: controlInvitation.id } });

      await waitFor(
        () => prisma.notification.findFirst({
          where: { recipientType: 'teacher', recipientId: control.id, type: 'teacher_invitation' },
        }),
        { description: 'control: a readdressed resend reaches a teacher-only account (#172)' },
      );
      expect(await prisma.notification.count({
        where: { recipientType: 'teacher', recipientId: inviteeTeacherId, type: 'teacher_invitation' },
      })).toBe(1);
    } finally {
      await prisma.invitation.deleteMany({ where: { id: controlInvitation.id } });
      await prisma.notification.deleteMany({ where: { recipientType: 'teacher', recipientId: control.id } });
      await prisma.teacher.delete({ where: { id: control.id } });
      await prisma.account.delete({ where: { id: control.accountId } });
    }
  });

  it('lets the invitee add a student side and accept', async () => {
    const invitation = await prisma.invitation.findUniqueOrThrow({
      where: { teacherId_email: { teacherId, email: inviteeEmail } },
      select: { id: true },
    });

    const profile = await fetch(`${BASE_URL}/api/account/student-profile`, {
      method: 'POST', headers: cookie(inviteeToken),
    });
    expect(profile.status).toBe(201);

    const accept = await fetch(`${BASE_URL}/api/invitations/${invitation.id}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...cookie(inviteeToken) },
      body: JSON.stringify({ response: 'accept' }),
    });
    expect(accept.status).toBe(200);

    const student = await prisma.student.findUniqueOrThrow({
      where: { email: inviteeEmail },
      select: { id: true },
    });
    expect(await prisma.teacherStudent.findUnique({
      where: { teacherId_studentId: { teacherId, studentId: student.id } },
    })).not.toBeNull();
  });
```

The inviting teacher's name, "Invitation Teacher", is the file-level fixture's `firstName`/`lastName`.

**The inviting teacher's hourly budget.** `teacherToken`'s teacher is created fresh on each run, so every run starts a new 50-per-hour bucket (`checkStudentWriteLimit`, keyed on the teacher). Before this plan the file spends 29 of it: 8 direct `POST /api/students` calls, plus 9 calls through the two `post` helpers, plus 12 resends. This plan adds 3 (Task 1's add and Task 5's two resends), for 32 in total, leaving 18. Re-derive before adding more:
- run `grep -n -A3 'BASE_URL}/api/students`\|/resend`' tests/integration/invitations-api.test.ts` and count the `teacherToken` requests. The 50-resend loop and the `postAfter` request that follows it use their own `ResendBucket` teacher.
- run `grep -n "post(" tests/integration/invitations-api.test.ts | grep -v "const post = "` and count calls: a `Promise.all` pair is two.

- [ ] **Step 2: Run them.**

Run: `pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts -t "teacher-only account"`
Expected: PASS, all four.

- [ ] **Step 3: Add the e2e journey.** At the end of `tests/e2e/invitations.spec.ts`:

```ts
test.describe('An invitation to a teacher-only account (#172)', () => {
  test.describe.configure({ mode: 'serial' });

  const inviterEmail = `e2e-t2t-inviter-${suffix}@test.local`;
  const inviteeEmail = `e2e-t2t-invitee-${suffix}@test.local`;
  let inviterId: string;
  let inviterAccountId: string;
  let inviterToken: string;
  let inviteeId: string;
  let inviteeAccountId: string;
  let inviteeToken: string;

  test.beforeAll(async () => {
    await prisma.$connect();
    const inviter = await prisma.teacher.create({
      data: {
        firstName: 'Inviting', lastName: 'Teacher', email: inviterEmail,
        account: { create: { email: inviterEmail } },
        bio: '#172 e2e inviter', pageSlug: `e2e-t2t-inviter-${suffix}`,
      },
    });
    inviterId = inviter.id;
    inviterAccountId = await accountIdOfTeacher(prisma, inviterId);
    inviterToken = await seedSession(prisma, inviterAccountId);

    const invitee = await prisma.teacher.create({
      data: {
        firstName: 'Invited', lastName: 'Teacher', email: inviteeEmail,
        account: { create: { email: inviteeEmail } },
        bio: '#172 e2e invitee', pageSlug: `e2e-t2t-invitee-${suffix}`,
      },
    });
    inviteeId = invitee.id;
    inviteeAccountId = await accountIdOfTeacher(prisma, inviteeId);
    inviteeToken = await seedSession(prisma, inviteeAccountId);
  });

  test.afterAll(async () => {
    const student = await prisma.student.findUnique({ where: { email: inviteeEmail }, select: { id: true } });
    await prisma.session.deleteMany({ where: { accountId: { in: [inviterAccountId, inviteeAccountId] } } });
    await prisma.notification.deleteMany({ where: { recipientType: 'teacher', recipientId: inviteeId } });
    if (student) {
      await prisma.notification.deleteMany({ where: { recipientType: 'student', recipientId: student.id } });
    }
    // Cascades the invitation and the roster link.
    await prisma.teacher.delete({ where: { id: inviterId } });
    if (student) await prisma.student.delete({ where: { id: student.id } });
    await prisma.teacher.delete({ where: { id: inviteeId } });
    await prisma.account.deleteMany({ where: { id: { in: [inviterAccountId, inviteeAccountId] } } });
    await prisma.$disconnect();
  });

  test('the invitee finds it in the Inbox, adds a student side and accepts', async ({ page, context }) => {
    await signInAs(context, inviterToken);
    await page.goto('/students');
    // From inside the page: same origin and the inviter's cookie, as the app's own form sends it.
    const addStatus = await page.evaluate(async (email) => {
      const res = await fetch('/api/students', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: 'Invited', lastName: 'Teacher', email }),
      });
      return res.status;
    }, inviteeEmail);
    expect(addStatus).toBe(201);
    await expect.poll(() => prisma.notification.count({
      where: { recipientType: 'teacher', recipientId: inviteeId, type: 'teacher_invitation' },
    })).toBe(1);

    await signInAs(context, inviteeToken);
    await page.goto('/inbox');
    await page.getByRole('button', { name: /^A teacher would like to connect/ }).click();
    await page.waitForURL('**/inbox/invitations');
    await expect(page.getByText('Inviting Teacher would like to connect with you as a student.')).toBeVisible();

    await page.getByRole('button', { name: 'Set up student side' }).click();
    await page.waitForURL('**/account/privacy');
    await expect(page.getByRole('heading', { name: 'Pending invitations' })).toBeVisible();
    await page.getByRole('button', { name: 'Accept' }).click();
    await expect(page.getByText('Accepted')).toBeVisible();

    const student = await prisma.student.findUniqueOrThrow({ where: { email: inviteeEmail }, select: { id: true } });
    await expect.poll(() => prisma.teacherStudent.count({
      where: { teacherId: inviterId, studentId: student.id },
    })).toBe(1);
  });

  test('the invitations page, opened after joining, goes to the student page', async ({ page, context }) => {
    await signInAs(context, inviteeToken);
    await page.goto('/inbox/invitations');
    await page.waitForURL('**/account/privacy');
  });
});
```

- [ ] **Step 4: Run it.**

Run: `pnpm exec playwright test tests/e2e/invitations.spec.ts`
Expected: PASS, including the existing #166 and #173 describes.

- [ ] **Step 5: Commit.**

```bash
git add tests/integration/invitations-api.test.ts tests/e2e/invitations.spec.ts
git commit -m "test(invitations): the teacher-only invitee journey over HTTP and in a browser (#172)"
```

- [ ] **Step 6: Prove the cross-task wiring bites.** These catch what the per-task tests cannot, because each breaks the connection between two tasks. Warm the touched route after each edit.
  1. **In `src/app/api/invitations/[id]/resend/route.ts`, pass `priorDispatch: 'none'` instead of the derived value.** Run the integration `-t "teacher-only account"`. Expected: "does not tell the invitee again" FAILs (count 2).
  2. **In `src/lib/notification-links.ts`, change `TEACHER_INVITATION_PATH` to `'/inbox/invitation'`.** Run the e2e spec. Expected: the journey test times out at `waitForURL('**/inbox/invitations')`. Every unit test still passes, because they compare against the constant.
  3. **Delete the page's `redirect` line.** Run the e2e spec. Expected: "the invitations page, opened after joining" FAILs.

## After the last task

- [ ] **Run `pnpm run verify` with the worktree app up.** Record its per-project totals for the PR body: it runs `unit`, `components`, `unit-sweeps` and `integration`, so a green run covers the whole integration tier.
- [ ] **Run `pnpm run build`.** CI runs it, and `verify` does not.
- [ ] **Run `pnpm exec playwright test tests/e2e/invitations.spec.ts tests/e2e/account-hybrid.spec.ts`.**
- [ ] **Sweep for what this branch invalidated.** Run `grep -rn "no Student row\|registered-student path\|registered invitee" src docs --include="*.ts" --include="*.tsx" --include="*.md" | grep -v "docs/superpowers/"` and give every hit a verdict.
- [ ] **Then continue with the `solve-issue` skill's whole-branch review and PR steps.** The PR body names #615 as unaffected, never with a closing keyword.
