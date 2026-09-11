# Invitation Delivery Failure Signal (#392) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a teacher a way to tell "we tried and it failed" apart from "not yet sent" and "sent" for a pending invitation, without reopening the account-enumeration oracle #166 closed.

**Architecture:** Add one nullable timestamp column, `Invitation.lastNotifyFailedAt`. It is written in exactly one place — `deliverInvitation`'s existing `.catch`, which already only fires on a genuine dispatch error (never on the two `notifyInvitee` early returns for a blocked or already-linked address) — and cleared in the two places that already reset delivery-adjacent state for a fresh attempt: the unconditional pre-dispatch write in `POST /api/students` and `POST /api/invitations/[id]/resend`, and the `readdressed` branch of `PUT /api/invitations/[id]`. `invitationDeliveryStatus` (`src/lib/contacts.ts`) reads the three resulting states; the contact detail page renders them.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Vitest (unit + integration projects).

**Spec:** `docs/superpowers/specs/2026-09-11-invitation-delivery-failure-signal-design.md`

## Global Constraints

- `deliverInvitation` must keep returning `FireAndForget` (`= void`) — no caller may gain anything to `.then()`/`.catch()` on it. The pinned type `_deliverInvitationReturnsVoid` (`src/services/invitations.ts:676-682`) already enforces this at compile time; nothing in this plan touches that pin.
- Every write this plan adds to `deliverInvitation`'s `.catch` must use `updateMany` scoped by `id`, never `update` — the row can be deleted between dispatch start and the callback running, and a P2025 there must not become an unhandled rejection.
- The failure signal must never distinguish "blocked" or "already linked" from "genuine send failure" — both `notifyInvitee` early returns (`src/services/invitations.ts:548`, `:579`) resolve without throwing, so the `.catch` this plan writes to must never fire for either. No new branch may change that.
- The invitee's email address is never logged (existing rule, `deliverInvitation`'s docblock) — this plan's new log line, if any, follows the same rule.
- `lastNotifyFailedAt` carries no address — do not add a paired `lastNotifyFailedEmail` column (see spec, "Rejected alternatives").

---

### Task 1: Add and wire the invitation delivery-failure signal

**Files:**
- Modify: `prisma/schema.prisma` (`Invitation` model)
- Modify: `docs/data-model.md:136-158` (Invitation table)
- Modify: `src/services/invitations.ts:653-682` (`deliverInvitation`)
- Test: `src/services/invitations.deliver.test.ts`
- Modify: `src/app/api/students/route.ts:121-124`
- Modify: `src/app/api/invitations/[id]/resend/route.ts` (the unconditional marker write)
- Test: `tests/integration/invitations-api.test.ts` (extend two existing tests)
- Modify: `src/app/api/invitations/[id]/route.ts:240-244` (`PUT`)
- Test: `tests/integration/invitations-api.test.ts` (new `PUT` readdress test)
- Modify: `src/lib/contacts.ts` (`invitationDeliveryStatus`)
- Test: `src/lib/contacts.test.ts`
- Modify: `src/app/(teacher)/students/contacts/[id]/page.tsx:26-53`

**Interfaces:**
- Consumes: nothing from another task — this is the only task in this plan (see spec's Scope: splitting the set/clear halves would ship a column that goes stale the moment it's added).
- Produces: `invitationDeliveryStatus(invitation: { email, lastNotifiedAt, lastNotifiedEmail, lastNotifyFailedAt }): { state: 'sent'; at: Date } | { state: 'failed'; at: Date } | { state: 'not-sent' }` — the new public shape, replacing the old `{ sent: true; at } | { sent: false }`. Its only caller in this codebase is `src/app/(teacher)/students/contacts/[id]/page.tsx`, updated in Step 7 below.

---

- [ ] **Step 1: Add the schema column, migrate, and document it**

  This step has no red/green cycle of its own — a schema-only change isn't
  independently testable, and Step 2's test is what first exercises the new
  column. Its correctness gate is that `pnpm exec prisma migrate dev` succeeds
  and the generated Prisma Client now has `lastNotifyFailedAt` on
  `Invitation`.

  In `prisma/schema.prisma`, inside `model Invitation`, add the new field
  directly below the existing pair it mirrors:

  ```prisma
  model Invitation {
    id          String           @id @default(uuid())
    teacherId   String
    email       String
    firstName   String           @default("")
    lastName    String           @default("")
    status      InvitationStatus @default(pending)
    isArchived  Boolean          @default(false)
    createdAt   DateTime         @default(now())
    respondedAt DateTime?
    lastNotifiedAt      DateTime?
    lastNotifiedEmail   String?
    lastNotifyFailedAt  DateTime?
    delivered           Boolean          @default(true)

    teacher Teacher @relation(fields: [teacherId], references: [id], onDelete: Cascade)

    @@unique([teacherId, email])
    @@index([email])
  }
  ```

  Run:

  ```bash
  pnpm exec prisma migrate dev --name invitation_notify_failed_at
  ```

  Confirm the migration applied cleanly and `pnpm exec prisma validate`
  passes.

  In `docs/data-model.md`, in the Invitation table (currently
  `docs/data-model.md:136-158`), add a new row directly after the existing
  `last_notified_email` row:

  ```markdown
  | last_notify_failed_at | datetime, nullable | Set only when the fire-and-forget dispatch (`deliverInvitation`) genuinely throws — never on either `notifyInvitee` early return (blocked, already linked), so it carries no more information than "blocked" already withholds (#392). Cleared to null by the same two events that already reset delivery-adjacent state: a fresh dispatch's own unconditional pre-write (`POST /api/students`, `POST /api/invitations/[id]/resend`), and `PUT /api/invitations/[id]`'s `readdressed` branch. No paired `last_notify_failed_email` column — clearing at those two sites keeps this always describing the most recent attempt against the row's current address without one |
  ```

  Commit:

  ```bash
  git add prisma/schema.prisma prisma/migrations docs/data-model.md
  git commit -m "feat(db): add Invitation.lastNotifyFailedAt (#392)"
  ```

- [ ] **Step 2: Persist a genuine dispatch failure**

  **Write the failing test.** Add to `src/services/invitations.deliver.test.ts`
  a `beforeAll`/`afterAll` teacher fixture (the file currently has none — every
  existing test uses a fictional `teacherId` because none needs a real
  `Invitation` row) and a new test:

  ```ts
  import { PrismaClient } from '@prisma/client';
  import { deliverInvitation } from './invitations';
  import { log } from '@/lib/log';

  const prisma = new PrismaClient();

  describe('deliverInvitation — fire-and-forget by construction (#391)', () => {
    let teacherId: string;
    let invitationId: string;

    beforeAll(async () => {
      const teacher = await prisma.teacher.create({
        data: {
          firstName: 'Deliver', lastName: 'Teacher',
          email: `deliver-392-teacher-${Date.now()}@test.local`,
          account: { create: { email: `deliver-392-teacher-${Date.now()}@test.local` } },
          bio: '#392 failure-signal tests',
          pageSlug: `deliver-392-teacher-${Date.now()}`,
        },
      });
      teacherId = teacher.id;

      const invitation = await prisma.invitation.create({
        data: {
          teacherId, email: `deliver-392-invitee-${Date.now()}@test.local`,
          firstName: 'Deliver', lastName: 'Target',
        },
        select: { id: true },
      });
      invitationId = invitation.id;
    });

    afterAll(async () => {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      if (teacherId) {
        const accountId = (await prisma.teacher.findUnique({
          where: { id: teacherId }, select: { accountId: true },
        }))?.accountId;
        await prisma.teacher.delete({ where: { id: teacherId } });
        if (accountId) await prisma.account.deleteMany({ where: { id: accountId } });
      }
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    // ... existing three tests stay unchanged above this point ...

    it('records a delivery failure on the invitation row (#392)', async () => {
      const error = vi.spyOn(log, 'error').mockImplementation(() => undefined);

      // A bogus teacherId (not this fixture's real one) makes
      // `db.teacher.findUniqueOrThrow` throw before `notifyInvitee` is ever
      // called — the same trick the existing tests above use. The write
      // this test proves is scoped only by `invitationId`, so it lands
      // regardless of which teacherId the throw came from.
      const result = deliverInvitation(prisma, {
        teacherId: 'no-such-teacher-392d',
        email: 'nobody-392d@test.local',
        invitationId,
        source: 'create',
      });
      expect(result).toBeUndefined();

      await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

      const after = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { lastNotifyFailedAt: true },
      });
      expect(after.lastNotifyFailedAt).not.toBeNull();
    });
  });
  ```

  (Add `beforeAll, afterAll` to the existing `import { describe, it, expect,
  vi, afterEach } from 'vitest';` line.)

  **Run it, confirm it fails**:

  ```bash
  pnpm exec vitest run src/services/invitations.deliver.test.ts -t "records a delivery failure"
  ```

  Expected: FAIL — `after.lastNotifyFailedAt` is `null` (nothing writes it
  yet).

  **Implement.** In `src/services/invitations.ts`, change `deliverInvitation`'s
  `.catch` from a plain logger to one that also persists the failure, without
  creating a new unhandled rejection of its own:

  ```ts
  export function deliverInvitation(
    db: PrismaClient,
    input: { teacherId: string; email: string; invitationId: string; source: DeliverySource },
  ): FireAndForget {
    void (async () => {
      const teacher = await db.teacher.findUniqueOrThrow({
        where: { id: input.teacherId },
        select: { firstName: true, lastName: true },
      });
      await notifyInvitee(db, {
        teacherId: input.teacherId,
        email: input.email,
        teacherName: `${teacher.firstName} ${teacher.lastName}`,
      });
    })().catch((err: unknown) => {
      log.error(
        { err, teacherId: input.teacherId, invitationId: input.invitationId },
        DELIVERY_FAILURE_MESSAGE[input.source],
      );
      // Scoped by id alone, matching every other background write in this
      // file — the row may already be gone (a concurrent DELETE), and a
      // zero-count match here is not an error. Best-effort: a failure to
      // record the failure is logged, not thrown, since there is still no
      // promise for anything to await this on.
      db.invitation
        .updateMany({
          where: { id: input.invitationId },
          data: { lastNotifyFailedAt: new Date() },
        })
        .catch((writeErr: unknown) => {
          log.error(
            { err: writeErr, invitationId: input.invitationId },
            'failed to record notify failure',
          );
        });
    });
  }
  ```

  Add one sentence to `deliverInvitation`'s existing docblock (just above the
  function), after the paragraph on the invitee's address deliberately not
  being logged: `lastNotifyFailedAt` is persisted here on the same `.catch`
  path (#392) — scoped by `invitationId` only, so it carries nothing the
  `TeacherBlock`/roster re-checks inside `notifyInvitee` don't already gate.

  **Run it, confirm it passes**:

  ```bash
  pnpm exec vitest run src/services/invitations.deliver.test.ts
  ```

  Expected: PASS, all tests in the file (including the three pre-existing
  ones, unedited).

  **Extend two existing regression tests** — no new mutation-proof needed for
  either: both prove a property that already holds structurally (the
  `.catch` above only ever fires on a thrown error, and neither
  `notifyInvitee` early return throws), so there is no new guard branch to
  break and restore.

  In `tests/integration/invitations-api.test.ts`, the `'still writes the
  marker for a blocked address, and sends nothing'` test (around line 751),
  immediately after the existing
  `expect(after.lastNotifiedEmail).toBe(blockedEmail);` line, add:

  ```ts
      expect(after.lastNotifyFailedAt).toBeNull();
  ```

  In the same file, the `'a real #417/#418 decoy resends successfully but
  stays undelivered, and unlink still leaves it pending'` test (around line
  893), change the `afterResend` select to also fetch the new column and
  assert it:

  ```ts
      const afterResend = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { delivered: true, lastNotifyFailedAt: true },
      });
      expect(afterResend.delivered).toBe(false);
      expect(afterResend.lastNotifyFailedAt).toBeNull();
  ```

  **Run both, confirm they pass**:

  ```bash
  pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts -t "still writes the marker for a blocked address"
  pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts -t "417/#418 decoy resends"
  ```

  Expected: both PASS.

  **Commit:**

  ```bash
  git add src/services/invitations.ts src/services/invitations.deliver.test.ts tests/integration/invitations-api.test.ts
  git commit -m "feat(invitations): persist a genuine dispatch failure (#392)"
  ```

- [ ] **Step 3: Clear the failure marker on every fresh attempt**

  This is genuinely new guarding code (unlike Step 2's extensions), so it
  gets its own mutation-proof pass below.

  **Write the failing tests.** In `tests/integration/invitations-api.test.ts`,
  add two new tests — one per route — each seeding a stale
  `lastNotifyFailedAt` before the call and asserting it is cleared by the
  response, before the async dispatch has had any chance to resolve:

  ```ts
  describe('a fresh attempt clears a stale failure marker (#392)', () => {
    it('POST /api/students clears lastNotifyFailedAt on a revived invitation', async () => {
      const email = `clear-create-392-${suffix}@test.local`;
      let invitationId: string | undefined;
      try {
        const stale = await prisma.invitation.create({
          data: {
            teacherId, email, firstName: 'Stale', lastName: 'Failure',
            status: 'accepted', respondedAt: new Date(),
            lastNotifyFailedAt: new Date('2020-01-01T00:00:00.000Z'),
          },
          select: { id: true },
        });
        invitationId = stale.id;

        const res = await fetch(`${BASE_URL}/api/students`, {
          method: 'POST',
          headers: { ...cookie(teacherToken), 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, firstName: 'Stale', lastName: 'Failure' }),
        });
        expect(res.status).toBe(201);

        const after = await prisma.invitation.findUniqueOrThrow({
          where: { id: invitationId },
          select: { lastNotifyFailedAt: true },
        });
        expect(after.lastNotifyFailedAt).toBeNull();
      } finally {
        if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      }
    });

    it('POST /api/invitations/[id]/resend clears lastNotifyFailedAt', async () => {
      const email = `clear-resend-392-${suffix}@test.local`;
      let invitationId: string | undefined;
      try {
        const stale = await prisma.invitation.create({
          data: {
            teacherId, email, firstName: 'Stale', lastName: 'Resend',
            lastNotifyFailedAt: new Date('2020-01-01T00:00:00.000Z'),
          },
          select: { id: true },
        });
        invitationId = stale.id;

        const res = await fetch(`${BASE_URL}/api/invitations/${invitationId}/resend`, {
          method: 'POST', headers: cookie(teacherToken),
        });
        expect(res.status).toBe(200);

        const after = await prisma.invitation.findUniqueOrThrow({
          where: { id: invitationId },
          select: { lastNotifyFailedAt: true },
        });
        expect(after.lastNotifyFailedAt).toBeNull();
      } finally {
        if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      }
    });
  });
  ```

  (This describe block goes near the other `resend`/`students` describe
  blocks in the same file; `teacherId`, `teacherToken`, `suffix`, `cookie`,
  `BASE_URL` are the file's existing shared fixtures — no new setup needed.)

  **Run, confirm both fail**:

  ```bash
  pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts -t "clears a stale failure marker"
  ```

  Expected: both FAIL — `after.lastNotifyFailedAt` still holds the seeded
  2020 date.

  **Implement.** In `src/app/api/students/route.ts`, extend the existing
  unconditional pre-dispatch write (currently lines 121-124):

  ```ts
    await prisma.invitation.updateMany({
      where: { id: result.value.id },
      data: { lastNotifiedAt: new Date(), lastNotifiedEmail: parsed.data.email, lastNotifyFailedAt: null },
    });
  ```

  In `src/app/api/invitations/[id]/resend/route.ts`, extend its equivalent
  write the same way:

  ```ts
    const updated = await prisma.invitation.updateMany({
      where: { id },
      data: { lastNotifiedAt: new Date(), lastNotifiedEmail: invitation.email, lastNotifyFailedAt: null },
    });
  ```

  **Run, confirm both pass**:

  ```bash
  pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts -t "clears a stale failure marker"
  ```

  Expected: both PASS.

  **Mutation-proof** (skill §3 — prove the guard actually bites): revert the
  `lastNotifyFailedAt: null` addition in `route.ts` (`POST
  /api/students`) only, rerun the "POST /api/students clears" test, confirm
  it fails with the seeded 2020 date still present, restore the addition,
  rerun to confirm green again. Repeat the same revert/confirm/restore cycle
  for `resend/route.ts` against its own test.

  **Commit:**

  ```bash
  git add src/app/api/students/route.ts src/app/api/invitations/\[id\]/resend/route.ts tests/integration/invitations-api.test.ts
  git commit -m "fix(invitations): clear stale failure marker on a fresh attempt (#392)"
  ```

- [ ] **Step 4: Clear the failure marker on readdress**

  **Write the failing test.** In `tests/integration/invitations-api.test.ts`,
  in or near the existing `PUT /api/invitations/[id]` describe block:

  ```ts
  it('clears a stale failure marker when the address changes (#392)', async () => {
    const oldEmail = `readdress-old-392-${suffix}@test.local`;
    const newEmail = `readdress-new-392-${suffix}@test.local`;
    let invitationId: string | undefined;
    try {
      const stale = await prisma.invitation.create({
        data: {
          teacherId, email: oldEmail, firstName: 'Readdress', lastName: 'Stale',
          lastNotifyFailedAt: new Date('2020-01-01T00:00:00.000Z'),
        },
        select: { id: true },
      });
      invitationId = stale.id;

      const res = await fetch(`${BASE_URL}/api/invitations/${invitationId}`, {
        method: 'PUT',
        headers: { ...cookie(teacherToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: newEmail, firstName: 'Readdress', lastName: 'Stale' }),
      });
      expect(res.status).toBe(200);

      const after = await prisma.invitation.findUniqueOrThrow({
        where: { id: invitationId },
        select: { lastNotifyFailedAt: true, delivered: true },
      });
      expect(after.lastNotifyFailedAt).toBeNull();
      expect(after.delivered).toBe(false);
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
    }
  });
  ```

  **Run, confirm it fails**:

  ```bash
  pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts -t "clears a stale failure marker when the address changes"
  ```

  Expected: FAIL — `lastNotifyFailedAt` still the seeded 2020 date.

  **Implement.** In `src/app/api/invitations/[id]/route.ts`, extend the
  existing `readdressed` conditional (currently lines 240-244):

  ```ts
      data: {
        ...rest,
        ...(email !== undefined ? { email } : {}),
        ...(readdressed ? { delivered: false, lastNotifyFailedAt: null } : {}),
      },
  ```

  **Run, confirm it passes.** Same command as above; expect PASS.

  **Mutation-proof**: revert the `lastNotifyFailedAt: null` half of the added
  object (leave `delivered: false` alone), rerun the test, confirm it fails,
  restore, rerun to confirm green.

  **Commit:**

  ```bash
  git add src/app/api/invitations/\[id\]/route.ts tests/integration/invitations-api.test.ts
  git commit -m "fix(invitations): clear stale failure marker on readdress (#392)"
  ```

- [ ] **Step 5: Three-state `invitationDeliveryStatus`**

  **Write the failing tests.** Replace `src/lib/contacts.test.ts`'s
  `invitationDeliveryStatus` describe block:

  ```ts
  describe('invitationDeliveryStatus', () => {
    it('is sent when the last notified address matches the current one and no failure is recorded', () => {
      const at = new Date('2026-08-01T00:00:00.000Z');
      const result = invitationDeliveryStatus({
        email: 'lena@example.com', lastNotifiedAt: at, lastNotifiedEmail: 'lena@example.com',
        lastNotifyFailedAt: null,
      });
      expect(result).toEqual({ state: 'sent', at });
    });

    it('is failed when the last attempt against the current address is recorded as failed', () => {
      const notifiedAt = new Date('2026-08-01T00:00:00.000Z');
      const failedAt = new Date('2026-08-01T00:05:00.000Z');
      const result = invitationDeliveryStatus({
        email: 'lena@example.com', lastNotifiedAt: notifiedAt, lastNotifiedEmail: 'lena@example.com',
        lastNotifyFailedAt: failedAt,
      });
      expect(result).toEqual({ state: 'failed', at: failedAt });
    });

    it('is not-sent when the address was corrected after the last attempt, even with a stale failure recorded', () => {
      const result = invitationDeliveryStatus({
        email: 'lena@example.com',
        lastNotifiedAt: new Date('2026-08-01T00:00:00.000Z'),
        lastNotifiedEmail: 'lena-old-typo@example.com',
        lastNotifyFailedAt: new Date('2026-08-01T00:05:00.000Z'),
      });
      expect(result).toEqual({ state: 'not-sent' });
    });

    it('is not-sent when no attempt has ever been made', () => {
      const result = invitationDeliveryStatus({
        email: 'lena@example.com', lastNotifiedAt: null, lastNotifiedEmail: null,
        lastNotifyFailedAt: null,
      });
      expect(result).toEqual({ state: 'not-sent' });
    });
  });
  ```

  **Run, confirm it fails to even compile/pass**:

  ```bash
  pnpm exec vitest run src/lib/contacts.test.ts
  ```

  Expected: FAIL — the current function returns `{ sent: boolean }`, not
  `{ state: ... }`.

  **Implement.** In `src/lib/contacts.ts`, replace `invitationDeliveryStatus`:

  ```ts
  /**
   * Whether a pending invitation's most recent notify attempt reached the
   * address the row currently holds, and whether that attempt is known to
   * have failed (#392). Pulled out of `/students/contacts/[id]/page.tsx` for
   * the same reason `canRemoveContact` above was: that page is a server
   * component, so no component test can reach the comparison directly.
   *
   * `lastNotifiedEmail` is written unconditionally on every attempt by both
   * writers — `POST /api/students` (route.ts) and `POST
   * /api/invitations/[id]/resend` (route.ts, #173) — so `state: 'not-sent'`
   * here means only "not sent to the CURRENT address," never "blocked."
   * `lastNotifyFailedAt` is set only inside `deliverInvitation`'s own
   * `.catch` (services/invitations.ts), which never fires for a blocked or
   * already-linked address either (both `notifyInvitee` early returns
   * resolve without throwing) — so `state: 'failed'` carries the same
   * non-disclosure property `state: 'sent'` always has. Checked only once
   * `lastNotifiedEmail === email` already holds: both `POST` routes clear
   * `lastNotifyFailedAt` on every fresh attempt and `PUT` clears it on every
   * readdress, so a stale failure from a superseded attempt or an old
   * address should never reach this branch — the email-match gate is kept
   * as a second, independent check anyway, not load-bearing on the clearing
   * writes alone.
   */
  export function invitationDeliveryStatus(
    invitation: {
      email: string;
      lastNotifiedAt: Date | null;
      lastNotifiedEmail: string | null;
      lastNotifyFailedAt: Date | null;
    },
  ): { state: 'sent'; at: Date } | { state: 'failed'; at: Date } | { state: 'not-sent' } {
    if (invitation.lastNotifiedAt && invitation.lastNotifiedEmail === invitation.email) {
      return invitation.lastNotifyFailedAt
        ? { state: 'failed', at: invitation.lastNotifyFailedAt }
        : { state: 'sent', at: invitation.lastNotifiedAt };
    }
    return { state: 'not-sent' };
  }
  ```

  **Run, confirm it passes**:

  ```bash
  pnpm exec vitest run src/lib/contacts.test.ts
  ```

  Expected: PASS, all tests in the file (`canRemoveContact`'s three tests
  unedited and green).

  **Commit:**

  ```bash
  git add src/lib/contacts.ts src/lib/contacts.test.ts
  git commit -m "feat(contacts): three-state invitationDeliveryStatus (#392)"
  ```

- [ ] **Step 6: Wire the new state into the contact detail page**

  This is a server component — no unit test can reach its render output
  (the same reason `invitationDeliveryStatus` and `canRemoveContact` were
  extracted in the first place). Verify this step by running the app, per
  CLAUDE.md's rule for UI changes: "start the dev server and use the feature
  in a browser before reporting the task as complete." The `verify` skill
  covers driving the running app without email (magic-link bypass) if a
  fresh teacher session is needed.

  In `src/app/(teacher)/students/contacts/[id]/page.tsx`, add the new column
  to the existing `select` (currently lines 28-32):

  ```ts
    const invitation = await prisma.invitation.findFirst({
      where: { id, teacherId: session.teacherId },
      select: {
        id: true, firstName: true, lastName: true, email: true,
        status: true, isArchived: true,
        lastNotifiedAt: true, lastNotifiedEmail: true, lastNotifyFailedAt: true,
      },
    });
  ```

  Replace the delivery line (currently lines 49-53):

  ```tsx
        {delivery && (
          <p className="type-caption">
            {delivery.state === 'sent' && `Last invited ${timeAgo(delivery.at)}`}
            {delivery.state === 'failed' && `Last attempt failed ${timeAgo(delivery.at)}`}
            {delivery.state === 'not-sent' && 'Not yet sent to this address'}
          </p>
        )}
  ```

  **Manual verification** (the dev server on :3000 is the user's — check
  first per CLAUDE.md's hazard list, never kill or restart it; start one
  yourself only if genuinely absent):

  1. As a teacher, create a contact whose invitation will fail to send —
     easiest is to temporarily seed a row directly
     (`prisma.invitation.update({ where: { id }, data: { lastNotifyFailedAt:
     new Date() } })` via a one-off script or `psql`) rather than trying to
     force a real Resend outage, then load `/students/contacts/[id]` and
     confirm "Last attempt failed …" renders.
  2. Click Resend on that same contact against a real, deliverable address;
     confirm the line reverts to "Last invited …" on reload.
  3. Create a brand-new contact and confirm it still reads "Not yet sent to
     this address" before any send.

  **Commit:**

  ```bash
  git add src/app/\(teacher\)/students/contacts/\[id\]/page.tsx
  git commit -m "feat(ui): show a failed-delivery state on the contact detail page (#392)"
  ```

- [ ] **Step 7: Full verification**

  Run the whole suite and confirm every project is green:

  ```bash
  pnpm run verify
  ```

  Expected: PASS — typecheck, lint, and every vitest project (unit,
  components, integration). Record the pass/fail counts in the PR body per
  the `solve-issue` skill's "The PR body" section (the arithmetic that
  proves `pnpm run verify` ran the whole integration suite, not just the
  unit tier).

  No commit for this step unless `pnpm run verify` surfaces something to
  fix — if it does, fix it as part of whichever step's file it belongs to
  and re-run this step.

---

## Self-review notes

- **Spec coverage**: every Mechanism item (1-8) in the spec maps to a step
  above — schema+docs (Step 1), the `.catch` write (Step 2), the two
  unconditional-write clears (Step 3), the `PUT` clear (Step 4),
  `invitationDeliveryStatus` (Step 5), the page (Step 6). The spec's Tests
  items 1-7 all appear as concrete test code above; item 6 (mutation-proof
  the clearing) is folded into Steps 3 and 4 rather than a separate step, matching how CLAUDE.md's "Prove every guard bites" expects it — immediately after the guard it proves.
- **Placeholder scan**: no TBD/TODO; every step shows real code or a real,
  runnable command.
- **Type consistency**: `invitationDeliveryStatus`'s new return shape
  (`{ state: 'sent' | 'failed'; at: Date } | { state: 'not-sent' }`) is
  defined once in Step 5 and consumed identically in Step 6 — no drift.
