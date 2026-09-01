# Invitation Resend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can resend a pending invitation to its current address, and can tell whether a contact was actually mailed after they corrected its email.

**Architecture:** A new `POST /api/invitations/[id]/resend` route dispatches the existing `notifyInvitee` fire-and-forget send, reusing `POST /api/students`'s rate-limit bucket and oracle-safety shape. Two new nullable `Invitation` columns (`lastNotifiedAt`, `lastNotifiedEmail`) are written unconditionally on every notify attempt — by both the create/revive path and the new resend path — regardless of whether `TeacherBlock` withholds the actual send, so the "last invited" UI can never become a second way to leak block status.

**Tech Stack:** Next.js App Router route handlers, Prisma/PostgreSQL, Vitest (`unit`, `integration`, `components` projects), React Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-01-invitation-resend-notify-design.md`

## Global Constraints

- The delivery-attempt marker (`lastNotifiedAt`/`lastNotifiedEmail`) is written **unconditionally**, before any `TeacherBlock` check, on every notify attempt. Never gate this write on whether delivery actually goes out.
- Fire-and-forget dispatch (`deliverInvitation`) is **never awaited** by any route's response path. A route's status code and latency must not vary with whether the target address is registered, blocked, or unknown.
- Every value written to `Invitation.lastNotifiedEmail` must already be lowercase (matching `Invitation.email`'s existing convention) — never lowercase a second time, only assert/copy an already-normalised value.
- No new `InvitationStatus` enum value. Delivery state stays two plain nullable columns, not a lifecycle transition.
- **A comment states what is true in the commit where it lands, never what will become true once a later task ships.** Where a task's own reasoning names something a later task creates (the resend route, in particular), that reference is added in the task that creates it — never earlier.

---

### Task 1: Migration — `lastNotifiedAt`/`lastNotifiedEmail` + CHECK constraints

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/<timestamp>_invitation_last_notified/migration.sql`
- Modify: `tests/integration/invitation-constraints.test.ts`

**Interfaces:**
- Produces: `Invitation.lastNotifiedAt: Date | null`, `Invitation.lastNotifiedEmail: string | null` on the Prisma Client, used by every later task.

- [ ] **Step 1: Add the two columns to the schema**

In `prisma/schema.prisma`, inside `model Invitation`, add after `respondedAt`:

```prisma
  respondedAt DateTime?
  lastNotifiedAt    DateTime?
  lastNotifiedEmail String?
```

- [ ] **Step 2: Generate the migration without applying it**

Run: `npx prisma migrate dev --create-only --name invitation_last_notified`

This writes `prisma/migrations/<timestamp>_invitation_last_notified/migration.sql` with the two `ALTER TABLE ... ADD COLUMN` statements, but does not apply it yet and does not regenerate the Prisma Client.

- [ ] **Step 3: Hand-append the two CHECK constraints to the generated file**

Open the generated `migration.sql` and append, after Prisma's `ADD COLUMN` statements:

```sql
-- Invariant, DB-enforced: the delivery-attempt marker is lowercase, matching
-- every other email column on this table (Invitation_email_lowercase_check).
-- Written by `deliverInvitation`'s two callers (POST /api/students,
-- POST /api/invitations/[id]/resend, #173) from an already-normalised value
-- — this asserts that precondition rather than re-normalising.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_last_notified_email_lowercase_check"
  CHECK ("lastNotifiedEmail" IS NULL OR "lastNotifiedEmail" = lower("lastNotifiedEmail"));

-- Invariant, DB-enforced: the marker is written unconditionally, in one
-- statement, both fields or neither — same paired-nullability shape as
-- Invitation_responded_at_status_check. A future writer that sets only one
-- would leave a timestamp with no address to explain it, or an address
-- with no time to date it.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_last_notified_pair_check"
  CHECK (("lastNotifiedAt" IS NULL) = ("lastNotifiedEmail" IS NULL));
```

- [ ] **Step 4: Write the constraint tests**

In `tests/integration/invitation-constraints.test.ts`, add a new `describe` block after the existing `respondedAt is null exactly when the invitation is pending` block (before the final closing `});` of the outer `describe`):

```ts
  describe('lastNotifiedAt/lastNotifiedEmail are written unconditionally, together (#173)', () => {
    it('rejects a mixed-case lastNotifiedEmail', async () => {
      await expect(
        prisma.invitation.create({
          data: {
            teacherId,
            email: `inv-constraint-marker-case-${suffix}@test.local`,
            firstName: 'Marker', lastName: 'Case',
            lastNotifiedAt: new Date(),
            lastNotifiedEmail: `Inv-Constraint-Marker-Case-${suffix}@Test.Local`,
          },
        }),
      ).rejects.toThrow(/Invitation_last_notified_email_lowercase_check/);
    });

    it('rejects lastNotifiedAt set with lastNotifiedEmail left null', async () => {
      await expect(
        prisma.invitation.create({
          data: {
            teacherId,
            email: `inv-constraint-marker-half-a-${suffix}@test.local`,
            firstName: 'Marker', lastName: 'HalfA',
            lastNotifiedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/Invitation_last_notified_pair_check/);
    });

    it('rejects lastNotifiedEmail set with lastNotifiedAt left null', async () => {
      await expect(
        prisma.invitation.create({
          data: {
            teacherId,
            email: `inv-constraint-marker-half-b-${suffix}@test.local`,
            firstName: 'Marker', lastName: 'HalfB',
            lastNotifiedEmail: `inv-constraint-marker-half-b-${suffix}@test.local`,
          },
        }),
      ).rejects.toThrow(/Invitation_last_notified_pair_check/);
    });

    it('accepts both set together, and both left null', async () => {
      const notified = await prisma.invitation.create({
        data: {
          teacherId,
          email: `inv-constraint-marker-both-${suffix}@test.local`,
          firstName: 'Marker', lastName: 'Both',
          lastNotifiedAt: new Date(),
          lastNotifiedEmail: `inv-constraint-marker-both-${suffix}@test.local`,
        },
      });
      expect(notified.lastNotifiedAt).not.toBeNull();

      const unnotified = await prisma.invitation.create({
        data: {
          teacherId,
          email: `inv-constraint-marker-neither-${suffix}@test.local`,
          firstName: 'Marker', lastName: 'Neither',
        },
      });
      expect(unnotified.lastNotifiedAt).toBeNull();
      expect(unnotified.lastNotifiedEmail).toBeNull();
    });
  });
```

- [ ] **Step 5: Run the tests, confirm they fail**

Run: `npx vitest run --project integration tests/integration/invitation-constraints.test.ts`

Expected: FAIL — neither the columns nor the constraints exist in the database yet (only `--create-only` has run; nothing applied).

- [ ] **Step 6: Apply the migration**

Run: `npx prisma migrate dev`

This applies the migration (columns + hand-added checks together, in one shot) and regenerates the Prisma Client with the two new fields.

- [ ] **Step 7: Run the tests again, confirm they pass**

Run: `npx vitest run --project integration tests/integration/invitation-constraints.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add prisma/schema.prisma prisma/migrations tests/integration/invitation-constraints.test.ts
git commit -m "feat(invitations): add lastNotifiedAt/lastNotifiedEmail with paired CHECK constraints"
```

---

### Task 2: Unconditional delivery marker on `POST /api/students`

**Files:**
- Modify: `src/services/invitations.ts`
- Modify: `src/app/api/students/route.ts`
- Modify: `tests/integration/invitations-api.test.ts`

**Interfaces:**
- Consumes: `Invitation.lastNotifiedAt`/`lastNotifiedEmail` (Task 1).
- Produces: `deliverInvitation(db: PrismaClient, teacherId: string, email: string): Promise<void>`, exported from `src/services/invitations.ts` — consumed by Task 4's resend route.

**Note:** the `.catch` block inside `POST` still says "There is no resend... A real resend affordance is filed separately; do not grow one out of this catch." Leave that comment untouched in this task — it remains accurate until Task 4 actually creates the route. Task 4 corrects it in the same commit that makes the correction true.

- [ ] **Step 1: Move `deliverInvitation` into the service, taking `db` explicitly**

In `src/services/invitations.ts`, add after `notifyInvitee`'s closing brace:

```ts
/**
 * Loads the inviting teacher's display name and notifies the invitee — the
 * whole "decide + deliver" tail of a successful, unblocked invite.
 *
 * Deliberately never awaited by either of its two callers, `POST
 * /api/students` and `POST /api/invitations/[id]/resend` (#173, moved here
 * from the first route so both could share it): this SELECT plus whatever
 * `notifyInvitee` does — a plain INSERT for a registered invitee, an HTTPS
 * call to Resend for anyone else — must not sit on the request's critical
 * path. Awaited, it turns a Resend outage into a 500 for an unregistered
 * address while a registered one still answers normally, and even with
 * Resend healthy it is a timing channel (blocked: nothing, registered: one
 * query, stranger: one network round trip) — both carry the exact bit these
 * routes exist to withhold. Fire-and-forget is safe here: this is a
 * long-lived Node process on a single VPS, not a serverless function that
 * could be frozen mid-request.
 */
export async function deliverInvitation(
  db: PrismaClient,
  teacherId: string,
  email: string,
): Promise<void> {
  const teacher = await db.teacher.findUniqueOrThrow({
    where: { id: teacherId },
    select: { firstName: true, lastName: true },
  });
  await notifyInvitee(db, {
    teacherId,
    email,
    teacherName: `${teacher.firstName} ${teacher.lastName}`,
  });
}
```

(This docblock names the resend route in past tense — "moved here... so both could share it" — which is fine to write now: it's a true statement about *this* function's shape, not a claim that the resend route already exists in the running app.)

- [ ] **Step 2: Remove the local copy, wire the new call, add the unconditional marker write**

In `src/app/api/students/route.ts`, replace the import line and delete the local `deliverInvitation` function:

```ts
import { inviteContact, deliverInvitation, REFUSAL_MESSAGES } from '@/services/invitations';
```

(Remove `notifyInvitee` from this import — it was only ever used inside the local `deliverInvitation`, now deleted. Delete the entire local `async function deliverInvitation(teacherId: string, email: string): Promise<void> { ... }` block and its docblock.)

Then, in `POST`, right after the existing refusal check and before the fire-and-forget dispatch:

```ts
  const result = await inviteContact(prisma, {
    teacherId: session.teacherId,
    ...parsed.data,
  });
  if (!result.ok) {
    return respondError(REFUSAL_MESSAGES[result.reason], 409, result.reason);
  }

  // Unconditional — written regardless of `result.value.delivered`, covering
  // both the create and revive paths inside `inviteContact` (#173). A
  // teacher must never be able to infer TeacherBlock status from whether
  // this timestamp advances, so this cannot be moved inside the `if` below.
  await prisma.invitation.update({
    where: { id: result.value.id },
    data: { lastNotifiedAt: new Date(), lastNotifiedEmail: parsed.data.email },
  });

  // `result.value.delivered` is false when a `TeacherBlock` exists for this
  // address (services/invitations.ts) — the invitation row is still real,
  // only delivery is withheld. Gating on it here is one of two things that
  // stop this from emailing the exact person who unlinked to get away from
  // this teacher — `notifyInvitee` re-checks the same block itself (F3,
  // #166 review), belt and braces, so this gate only saves a query on the
  // common (unblocked) path rather than being the sole guard.
  //
  // Fire-and-forget, on purpose — see `deliverInvitation`'s docblock
  // (services/invitations.ts). The explicit `.catch` is required, not
  // optional: without it, a rejection here becomes an unhandled promise
  // rejection instead of a log line.
  if (result.value.delivered) {
    void deliverInvitation(prisma, session.teacherId, parsed.data.email).catch((err) => {
      // `invitationId`, not just `teacherId` (F4, #166 review). A send that
      // fails leaves a row indistinguishable from one that went out — still
      // `pending`, still listed under Contacts — so without the id an
      // operator reading this line knows a delivery failed but not WHICH
      // one, and a busy teacher's invitations are the haystack.
      //
      // No email address on purpose: this pair finds the row, and the
      // address is the one field on it worth keeping out of the logs.
      //
      // There is no resend. The teacher's recovery is to remove the contact
      // and invite again — `DELETE /api/invitations/[id]` refuses only
      // `declined` rows, so a pending one can go — which is what
      // `REFUSAL_MESSAGES.ALREADY_INVITED` now names, since the refusal is
      // the only place they meet the dead end. A real resend affordance is
      // filed separately; do not grow one out of this catch.
      log.error(
        { err, teacherId: session.teacherId, invitationId: result.value.id },
        'failed to notify invitee',
      );
    });
  }

  return respondOk({ id: result.value.id }, 201);
```

(The `.catch` block's comment is copied verbatim from the current file — unchanged, per the note above.)

- [ ] **Step 3: Extend the existing block-oracle test to prove the marker is unconditional**

In `tests/integration/invitations-api.test.ts`, find `describe('POST /api/students — the block oracle (#166 task 6b, mechanism moved in 6c)', ...)`, inside `it('answers a blocked address exactly as a fresh one, including on a repeat POST', ...)`. Right after the existing assertion `expect(Object.keys(blockedJson.data)).toEqual(Object.keys(freshJson.data));`, add:

```ts
      // #173: the delivery-attempt marker must be written for BOTH — a
      // teacher must never be able to tell a blocked address from a fresh
      // one by whether "last invited" advances, the same property the rest
      // of this test proves for the response body.
      const blockedInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: blockedJson.data.id },
      });
      const freshInvitation = await prisma.invitation.findUniqueOrThrow({
        where: { id: freshJson.data.id },
      });
      expect(blockedInvitation.lastNotifiedAt).not.toBeNull();
      expect(freshInvitation.lastNotifiedAt).not.toBeNull();
      expect(blockedInvitation.lastNotifiedEmail).toBe(blockedEmail);
      expect(freshInvitation.lastNotifiedEmail).toBe(freshEmail);
```

This assertion runs synchronously after `fetch` resolves — no `waitFor` needed, because the marker write is awaited on the response path (unlike the fire-and-forget `Notification`/email dispatch elsewhere in this file).

- [ ] **Step 4: Run the test, confirm it fails**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts -t "answers a blocked address exactly as a fresh one"`

Expected: FAIL — `lastNotifiedAt` is still `null` on both rows (the route doesn't write it yet).

- [ ] **Step 5: Confirm it passes**

Run the same command. Expected: PASS.

- [ ] **Step 6: Run the full students/invitations integration suites to confirm nothing else broke**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts tests/integration/invitations-api.test.ts`

Expected: all PASS (the `deliverInvitation` relocation is behavior-preserving for every other test in these files).

- [ ] **Step 7: Commit**

```bash
git add src/services/invitations.ts src/app/api/students/route.ts tests/integration/invitations-api.test.ts
git commit -m "feat(invitations): write the delivery-attempt marker unconditionally on POST /api/students"
```

---

### Task 3: `respondRateLimited` helper

**Files:**
- Modify: `src/lib/rate-limit.ts`
- Modify: `src/app/api/students/route.ts`

**Interfaces:**
- Produces: `respondRateLimited(limit: RateLimitResult): NextResponse`, exported from `src/lib/rate-limit.ts` — consumed by Task 4's resend route.

**Note:** `checkStudentWriteLimit`'s docblock still says "this is a single-caller budget again" — leave it untouched in this task, it's still accurate. Task 4 corrects it once the resend route becomes the second caller.

- [ ] **Step 1: Add the helper**

In `src/lib/rate-limit.ts`, add the imports at the top:

```ts
import type { NextResponse } from 'next/server';
import { respondError } from './api-utils';
```

(`import { log } from '@/lib/log';` already exists at the top of this file — leave it as-is.) Then add, right after `checkStudentWriteLimit`'s closing brace:

```ts
/**
 * The 429 body for a `checkStudentWriteLimit` refusal, shared by
 * `POST /api/students` and `POST /api/invitations/[id]/resend` (#173) — both
 * spend the same bucket and build the identical message from it. Each
 * caller keeps its own `log.warn` immediately before calling this: the
 * `teacherId` field is the same shape either way, but the message text
 * names which action was refused, which matters for grepping operator
 * logs and isn't worth genericizing away.
 */
export function respondRateLimited(limit: RateLimitResult): NextResponse {
  const minutes = Math.ceil(limit.retryAfterSeconds / 60);
  return respondError(
    `Too many invitations. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    429,
  );
}
```

- [ ] **Step 2: Use it in `POST /api/students`**

In `src/app/api/students/route.ts`, replace:

```ts
  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    log.warn({ teacherId: session.teacherId }, 'invitation refused: rate limit exceeded');
    const minutes = Math.ceil(limit.retryAfterSeconds / 60);
    return respondError(
      `Too many invitations. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
      429,
    );
  }
```

with:

```ts
  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    log.warn({ teacherId: session.teacherId }, 'invitation refused: rate limit exceeded');
    return respondRateLimited(limit);
  }
```

And update the import: `import { checkStudentWriteLimit, respondRateLimited } from '@/lib/rate-limit';`

- [ ] **Step 3: Run the existing rate-limit tests to confirm the refactor is behavior-preserving**

Run: `npx vitest run --project integration tests/integration/students-api.test.ts -t "refuses a 51st invitation"`

Then also run: `npx vitest run --project integration tests/integration/students-api.test.ts -t "spends its budget"` and `-t "spends budget on invalid bodies"`.

Expected: all PASS — the message text and status code are unchanged, only where the string gets built moved.

- [ ] **Step 4: Commit**

```bash
git add src/lib/rate-limit.ts src/app/api/students/route.ts
git commit -m "refactor(rate-limit): extract respondRateLimited, shared by POST /api/students"
```

---

### Task 4: `POST /api/invitations/[id]/resend`, its shared helpers, and every reference to its absence

**Files:**
- Create: `src/app/api/invitations/[id]/shared.ts`
- Modify: `src/app/api/invitations/[id]/route.ts`
- Create: `src/app/api/invitations/[id]/resend/route.ts`
- Modify: `src/lib/rate-limit.ts` (docblock only)
- Modify: `src/services/invitations.ts` (`REFUSAL_MESSAGES` + `notifyInvitee` docblock)
- Modify: `src/app/api/students/route.ts` (the `.catch` comment left alone by Task 2)
- Modify: `tests/integration/students-api.test.ts` (two stale message assertions)
- Modify: `tests/integration/invitations-api.test.ts` (new tests)

**Interfaces:**
- Consumes: `deliverInvitation` (Task 2), `checkStudentWriteLimit`/`respondRateLimited` (Task 3).
- Produces: `ownedInvitation`/`NOT_FOUND`/`DECLINED`, exported from `src/app/api/invitations/[id]/shared.ts`. `POST /api/invitations/[id]/resend` — consumed by Task 5's `ResendInvitationButton`.

**Why `shared.ts` and the route land in one task:** the only reason to pull `ownedInvitation`/`NOT_FOUND`/`DECLINED` out of `route.ts` is so the new resend route can reuse them — there is no independent motivation to extract them on their own. Splitting the extraction into its own task would leave a commit where `shared.ts`'s docblock names a 4th consumer, or a select includes `email` for a dispatch, that doesn't exist anywhere in the codebase yet. Landing both together keeps every comment true at the commit where it lands.

- [ ] **Step 1: Extract the shared ownership helpers**

Create `src/app/api/invitations/[id]/shared.ts`:

```ts
import { prisma } from '@/lib/db';
import { respondError } from '@/lib/api-utils';

/**
 * The ownership preamble shared by PUT/DELETE/PATCH
 * (`src/app/api/invitations/[id]/route.ts`) and
 * `POST /api/invitations/[id]/resend` (#173) — four routes reading the same
 * row before deciding what they're allowed to do to it. Pulled into its own
 * file rather than exported from `route.ts` directly: Next's Route Handler
 * convention restricts what a `route.ts` file may export to HTTP verbs plus
 * a small fixed config allow-list.
 *
 * `findFirst` with `teacherId` in the `where`, not `findUnique` by id
 * followed by a separate ownership check — the ownership condition belongs
 * in the query itself, which is the shape this project's gate model calls
 * for (#162 was a PUT that skipped exactly this).
 *
 * `email` is selected for the resend route's dispatch — PUT/DELETE/PATCH
 * ignore it, which costs nothing extra to select alongside the other three.
 */
export async function ownedInvitation(teacherId: string, id: string) {
  return prisma.invitation.findFirst({
    where: { id, teacherId },
    select: { id: true, status: true, isArchived: true, email: true },
  });
}

/**
 * 404, not 403, when the row isn't this teacher's. The students routes
 * answer 403 for the equivalent case because a caller may legitimately know
 * a student id (they share a class roster, a booking link, etc). An
 * invitation id is never shared with anyone but the teacher who created it,
 * so its absence is the honest answer — a 403 would confirm the id exists
 * and belongs to someone else, which is a disclosure this route has no
 * reason to make.
 */
export const NOT_FOUND = () => respondError('Contact not found', 404);

/**
 * The refusal a declined row earns, in one place — PUT's pre-check, DELETE's
 * pre-check, both of their post-CAS answers (via `casMatchedNothing`,
 * `route.ts`), and resend's pre-check all say exactly this, and four copies
 * of one sentence is four chances for them to stop agreeing.
 */
export const DECLINED = () =>
  respondError(
    'This person declined. You can archive this contact, but it cannot be removed.',
    409,
    'DECLINED_IS_PERMANENT',
  );
```

- [ ] **Step 2: Update `[id]/route.ts` to import from it**

In `src/app/api/invitations/[id]/route.ts`, delete the local `ownedInvitation` function, `NOT_FOUND` const, and `DECLINED` const (and their docblocks — they now live in `shared.ts`). Add the import:

```ts
import { ownedInvitation, NOT_FOUND, DECLINED } from './shared';
```

`casMatchedNothing` and the `PUT`/`DELETE`/`PATCH` handlers are otherwise unchanged — they already call `ownedInvitation(...)`, `NOT_FOUND()`, `DECLINED()` by name, which now resolve to the imported symbols instead of local ones.

- [ ] **Step 3: Run the invitations suite to confirm the extraction alone is behavior-preserving**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts`

Expected: all PASS — this is a pure extraction so far, no route's observable behavior has changed yet.

- [ ] **Step 4: Create the resend route**

Create `src/app/api/invitations/[id]/resend/route.ts`:

```ts
import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import {
  respondOk,
  respondError,
  requireTeacher,
  isErrorResponse,
  withErrorHandler,
} from '@/lib/api-utils';
import { checkStudentWriteLimit, respondRateLimited } from '@/lib/rate-limit';
import { deliverInvitation } from '@/services/invitations';
import { log } from '@/lib/log';
import { ownedInvitation, NOT_FOUND, DECLINED } from '../shared';

/**
 * Resend a pending invitation to its current address (#173) — the recovery
 * from a send that never went out, or from a teacher who just corrected a
 * typo and wants the corrected address mailed. `PUT /api/invitations/[id]`
 * still does not notify (see `notifyInvitee`'s docblock, services/
 * invitations.ts); this route is the actual send.
 *
 * The marker write below (`lastNotifiedAt`/`lastNotifiedEmail`) is
 * unconditional — written before `deliverInvitation` is even called, and
 * regardless of whether a `TeacherBlock` ends up withholding the actual
 * send. If it were written only on a successful, unblocked dispatch, a
 * blocked contact's "last invited" display would never advance while every
 * otherwise-identical unblocked one does — a second, silent way for a
 * teacher to learn a specific student blocked them, exactly what
 * `TeacherBlock` exists to prevent from surfacing (see `inviteContact`'s own
 * docblock, services/invitations.ts, for the same property on the create
 * path).
 *
 * No CAS on the `status === 'pending'` check below: a decline landing in
 * the gap between the read and the write could let a stale send through,
 * but `notifyInvitee` has never checked `Invitation.status`, only
 * `TeacherBlock` — so this exact race already exists on `POST /api/students`
 * today (a decline landing between `inviteContact`'s write and its own
 * already-scheduled fire-and-forget dispatch sends the same way). Not a new
 * gap this route opens.
 */
export const POST = withErrorHandler(async (
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) => {
  const { id } = await params;
  const session = await requireTeacher(request);
  if (isErrorResponse(session)) return session;

  // Same bucket `POST /api/students` spends (src/lib/rate-limit.ts) — both
  // cause an email to go to an arbitrary address, so they share one ceiling
  // rather than each getting their own.
  const limit = checkStudentWriteLimit(session.teacherId);
  if (!limit.allowed) {
    log.warn({ teacherId: session.teacherId }, 'invitation resend refused: rate limit exceeded');
    return respondRateLimited(limit);
  }

  const invitation = await ownedInvitation(session.teacherId, id);
  if (!invitation) return NOT_FOUND();

  if (invitation.status === 'declined') return DECLINED();
  if (invitation.status !== 'pending') {
    // Unreachable from the UI today — the contact detail page redirects
    // away from an accepted invitation before a Resend button could ever
    // render — but the id travels in a URL, not a secret, so a direct call
    // still needs an honest answer rather than a 404 that pretends the row
    // doesn't exist.
    return respondError('This invitation is no longer pending.', 409, 'NOT_PENDING');
  }

  // Unconditional — see this route's own docblock above for why this must
  // never depend on whether `TeacherBlock` withholds the send below.
  await prisma.invitation.update({
    where: { id },
    data: { lastNotifiedAt: new Date(), lastNotifiedEmail: invitation.email },
  });

  // Fire-and-forget, same shape as `POST /api/students` — this route's
  // response must not vary in status or latency with whether the address is
  // registered, blocked, or unknown.
  void deliverInvitation(prisma, session.teacherId, invitation.email).catch((err) => {
    log.error(
      { err, teacherId: session.teacherId, invitationId: id },
      'failed to resend invitation',
    );
  });

  return respondOk({ id });
});
```

- [ ] **Step 5: Correct `checkStudentWriteLimit`'s docblock**

In `src/lib/rate-limit.ts`, replace the docblock above `checkStudentWriteLimit`:

```ts
/**
 * Hourly budget for `POST /api/students` and `POST
 * /api/invitations/[id]/resend`, keyed on the inviting teacher. #166 closed
 * the enumeration oracle this used to guard against by construction — the
 * create route no longer branches on whether the address already exists —
 * so what remains is a spam brake: a teacher can still cause an email to be
 * sent to an arbitrary address, once per request.
 *
 * There used to be a second caller, the teacher branch of
 * `PUT /api/students/[id]`, which wrote a client-supplied `email` to the
 * same `@unique` column with no pre-check and so needed the same budget.
 * Task 10 of #166 deleted that branch outright. #173's resend route is the
 * new second caller, sharing this same bucket by design — both routes cause
 * an email to go to an arbitrary address, so one ceiling covers both rather
 * than each needing its own.
 *
 * 50/hour fits a workshop roster plus corrections in one sitting.
 */
```

- [ ] **Step 6: Correct `REFUSAL_MESSAGES`'s docblock and `ALREADY_INVITED`'s copy**

In `src/services/invitations.ts`, replace the first paragraph of the docblock above `REFUSAL_MESSAGES` (the one starting "`ALREADY_INVITED` names the way out..."):

```ts
/**
 * `ALREADY_INVITED` names the way out, the other two do not, and that
 * asymmetry is the point (F4, #166 review). A teacher whose invitation email
 * silently failed to send meets this refusal when they try again, and on
 * its own it reads as a closed door — while the door is in fact open:
 * `POST /api/invitations/[id]/resend` (#173) resends to the address already
 * on the row, and `PUT` on the same route can correct that address first if
 * it was the problem.
 *
 * One sentence, and it stays one: ...
```

(Leave the remaining three paragraphs of that docblock unchanged.) Then update the message itself:

```ts
export const REFUSAL_MESSAGES: Record<InviteRefusal, string> = {
  ALREADY_INVITED:
    'You have already invited this person — open their contact to resend or update their details.',
  ALREADY_LINKED: 'This person is already one of your students.',
  DECLINED: 'This person declined your invitation.',
  CONTACT_CHANGED: 'This contact changed while you were sending — reload and try again.',
};
```

- [ ] **Step 7: Add resend as `notifyInvitee`'s second caller in its docblock**

In `src/services/invitations.ts`, find the paragraph in `notifyInvitee`'s docblock starting "`PUT /api/invitations/[id]` edits `email`..." and append one sentence:

```ts
 * `PUT /api/invitations/[id]` edits `email` on a pending row without
 * recomputing `delivered`, which looks like a second door and is not: PUT
 * does not notify, so a value gone stale there reaches nobody. Named only so
 * the next reader does not go checking it, find it harmless, and conclude
 * the re-check below is redundant. `POST /api/invitations/[id]/resend`
 * (#173) is the actual second caller of this function — it reads `email`
 * fresh from the row in the same request it dispatches, so there is no
 * equivalent staleness window for it to worry about.
```

- [ ] **Step 8: Correct the `.catch` comment in `POST /api/students` (left alone by Task 2)**

In `src/app/api/students/route.ts`, replace the paragraph inside the `.catch` block:

```ts
      // There is no resend. The teacher's recovery is to remove the contact
      // and invite again — `DELETE /api/invitations/[id]` refuses only
      // `declined` rows, so a pending one can go — which is what
      // `REFUSAL_MESSAGES.ALREADY_INVITED` now names, since the refusal is
      // the only place they meet the dead end. A real resend affordance is
      // filed separately; do not grow one out of this catch.
```

with:

```ts
      // This log line is the operator's only signal that a specific send
      // failed — the teacher's own recovery is now
      // `POST /api/invitations/[id]/resend` (#173), not delete-and-recreate.
```

- [ ] **Step 9: Update the two stale message assertions in `students-api.test.ts`**

In `tests/integration/students-api.test.ts`, inside `it('returns 409 when the person is already invited', ...)`, replace:

```ts
    // F4, #166 review: the message must name the way out, not just the wall.
    // The invitation email is sent fire-and-forget, so a teacher whose send
    // failed meets this refusal when they retry — and removing the contact is
    // the recovery `DELETE /api/invitations/[id]` actually allows for a
    // pending row. Substring, not the whole sentence: what is pinned is that
    // the refusal points somewhere, not this month's wording.
    expect(json.error.message).toContain('remove the contact');
```

with:

```ts
    // F4, #166 review: the message must name the way out, not just the wall.
    // The invitation email is sent fire-and-forget, so a teacher whose send
    // failed meets this refusal when they retry — and the recovery it now
    // names is `POST /api/invitations/[id]/resend` (#173), not
    // delete-and-recreate. Substring, not the whole sentence: what is pinned
    // is that the refusal points somewhere, not this month's wording.
    expect(json.error.message).toContain('resend');
```

And inside `describe('POST /api/students answers a raced invite with ALREADY_INVITED (#161)', ...)`, replace:

```ts
    expect(body.error.message).toBe(
      'You have already invited this person — remove the contact to invite them again.',
    );
```

with:

```ts
    expect(body.error.message).toBe(
      'You have already invited this person — open their contact to resend or update their details.',
    );
```

- [ ] **Step 10: Add the new resend route tests**

In `tests/integration/invitations-api.test.ts`, add a new `describe` block after the `PATCH /api/invitations/[id]` block closes (before `describe('POST /api/invitations/[id]/respond', ...)`):

```ts
describe('POST /api/invitations/[id]/resend (#173)', () => {
  it('refuses another teacher\'s invitation', async () => {
    let other: { id: string } | undefined;
    try {
      other = await createOtherTeacherInvitation('resend-target');
      const res = await fetch(`${BASE_URL}/api/invitations/${other.id}/resend`, {
        method: 'POST', headers: cookie(teacherToken),
      });
      expect(res.status).toBe(404);
    } finally {
      if (other) await prisma.invitation.deleteMany({ where: { id: other.id } });
    }
  });

  it('refuses a declined row', async () => {
    const declined = await prisma.invitation.create({
      data: {
        teacherId, email: `resend-declined-${suffix}@test.local`,
        status: 'declined', respondedAt: new Date(),
      },
      select: { id: true },
    });
    const res = await fetch(`${BASE_URL}/api/invitations/${declined.id}/resend`, {
      method: 'POST', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('DECLINED_IS_PERMANENT');
  });

  it('refuses a non-pending row that is not declined', async () => {
    const accepted = await prisma.invitation.create({
      data: {
        teacherId, email: `resend-accepted-${suffix}@test.local`,
        status: 'accepted', respondedAt: new Date(),
      },
      select: { id: true },
    });
    const res = await fetch(`${BASE_URL}/api/invitations/${accepted.id}/resend`, {
      method: 'POST', headers: cookie(teacherToken),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NOT_PENDING');
  });

  it('resends to the current address, writing the marker and notifying a registered invitee', async () => {
    const email = `resend-registered-${suffix}@test.local`;
    let studentId: string | undefined;
    let invitationId: string | undefined;
    try {
      const student = await prisma.student.create({
        data: { firstName: 'Resend', lastName: 'Registered', email },
        select: { id: true },
      });
      studentId = student.id;
      const invitation = await prisma.invitation.create({
        data: { teacherId, email, firstName: 'Resend', lastName: 'Target' },
        select: { id: true },
      });
      invitationId = invitation.id;

      const res = await fetch(`${BASE_URL}/api/invitations/${invitation.id}/resend`, {
        method: 'POST', headers: cookie(teacherToken),
      });
      expect(res.status).toBe(200);

      const after = await prisma.invitation.findUniqueOrThrow({ where: { id: invitation.id } });
      expect(after.lastNotifiedAt).not.toBeNull();
      expect(after.lastNotifiedEmail).toBe(email);

      await waitFor(
        () =>
          prisma.notification.findFirst({
            where: { recipientType: 'student', recipientId: student.id, type: 'teacher_invitation' },
          }),
        { description: 'resend teacher_invitation notification (#173)' },
      );
    } finally {
      if (invitationId) await prisma.invitation.deleteMany({ where: { id: invitationId } });
      if (studentId) {
        await prisma.notification.deleteMany({ where: { recipientId: studentId } });
        await prisma.student.delete({ where: { id: studentId } });
      }
    }
  });

  it('still writes the marker for a blocked address, and sends nothing', async () => {
    const blockedEmail = `resend-blocked-${suffix}@test.local`;
    const controlEmail = `resend-blocked-control-${suffix}@test.local`;
    let blockedStudentId: string | undefined;
    let controlStudentId: string | undefined;
    let blockedInvitationId: string | undefined;
    let controlInvitationId: string | undefined;
    let blockId: string | undefined;
    try {
      const blockedStudent = await prisma.student.create({
        data: { firstName: 'Resend', lastName: 'Blocked', email: blockedEmail },
        select: { id: true },
      });
      blockedStudentId = blockedStudent.id;
      const block = await prisma.teacherBlock.create({
        data: { teacherId, email: blockedEmail },
        select: { id: true },
      });
      blockId = block.id;
      const blockedInvitation = await prisma.invitation.create({
        data: { teacherId, email: blockedEmail, firstName: 'Resend', lastName: 'Blocked' },
        select: { id: true },
      });
      blockedInvitationId = blockedInvitation.id;

      const blockedRes = await fetch(`${BASE_URL}/api/invitations/${blockedInvitation.id}/resend`, {
        method: 'POST', headers: cookie(teacherToken),
      });
      expect(blockedRes.status).toBe(200);

      const after = await prisma.invitation.findUniqueOrThrow({ where: { id: blockedInvitation.id } });
      expect(after.lastNotifiedAt).not.toBeNull();
      expect(after.lastNotifiedEmail).toBe(blockedEmail);

      // Bracketing control, same technique as "creates no notification for
      // an address with no Student row" above: a second, unblocked resend
      // issued strictly after the blocked one, whose own notification is
      // awaited before the final count — proving the blocked send, if it
      // existed, would have landed too.
      const controlStudent = await prisma.student.create({
        data: { firstName: 'Resend', lastName: 'BlockedControl', email: controlEmail },
        select: { id: true },
      });
      controlStudentId = controlStudent.id;
      const controlInvitation = await prisma.invitation.create({
        data: { teacherId, email: controlEmail, firstName: 'Resend', lastName: 'Control' },
        select: { id: true },
      });
      controlInvitationId = controlInvitation.id;
      const controlRes = await fetch(`${BASE_URL}/api/invitations/${controlInvitation.id}/resend`, {
        method: 'POST', headers: cookie(teacherToken),
      });
      expect(controlRes.status).toBe(200);
      await waitFor(
        () =>
          prisma.notification.findFirst({
            where: { recipientType: 'student', recipientId: controlStudent.id, type: 'teacher_invitation' },
          }),
        { description: 'control teacher_invitation notification (#173)' },
      );

      const blockedNotifications = await prisma.notification.findMany({
        where: { recipientType: 'student', recipientId: blockedStudent.id, type: 'teacher_invitation' },
      });
      expect(blockedNotifications).toHaveLength(0);
    } finally {
      if (blockedInvitationId) await prisma.invitation.deleteMany({ where: { id: blockedInvitationId } });
      if (controlInvitationId) await prisma.invitation.deleteMany({ where: { id: controlInvitationId } });
      if (blockId) await prisma.teacherBlock.deleteMany({ where: { id: blockId } });
      if (blockedStudentId) {
        await prisma.notification.deleteMany({ where: { recipientId: blockedStudentId } });
        await prisma.student.delete({ where: { id: blockedStudentId } });
      }
      if (controlStudentId) {
        await prisma.notification.deleteMany({ where: { recipientId: controlStudentId } });
        await prisma.student.delete({ where: { id: controlStudentId } });
      }
    }
  });

  it('shares its rate-limit bucket with POST /api/students', async () => {
    const shared = await prisma.teacher.create({
      data: {
        firstName: 'ResendBucket', lastName: 'Teacher',
        email: `resend-bucket-${suffix}@test.local`,
        account: { create: { email: `resend-bucket-${suffix}@test.local` } },
        bio: 'Fresh limiter bucket for the resend route',
        pageSlug: `resend-bucket-${suffix}`,
      },
    });
    try {
      const headers = {
        'Content-Type': 'application/json',
        ...cookie(await seedSession(prisma, shared.accountId)),
      };
      const invitation = await prisma.invitation.create({
        data: { teacherId: shared.id, email: `resend-bucket-target-${suffix}@test.local`, firstName: 'A', lastName: 'B' },
        select: { id: true },
      });

      // 50 resends of the same row spend the same bucket a create-burst
      // spends on 50 distinct addresses — resend doesn't need a fresh
      // target each time, since it never collides on ALREADY_INVITED.
      for (let i = 0; i < 50; i++) {
        const res = await fetch(`${BASE_URL}/api/invitations/${invitation.id}/resend`, {
          method: 'POST', headers,
        });
        expect(res.status).toBe(200);
      }

      const fiftyFirstResend = await fetch(`${BASE_URL}/api/invitations/${invitation.id}/resend`, {
        method: 'POST', headers,
      });
      expect(fiftyFirstResend.status).toBe(429);

      // The bucket is shared, not merely identically-sized: a fresh POST
      // /api/students call for the SAME teacher is also refused.
      const postAfter = await fetch(`${BASE_URL}/api/students`, {
        method: 'POST', headers,
        body: JSON.stringify({
          firstName: 'A', lastName: 'B', email: `resend-bucket-fresh-${suffix}@test.local`,
        }),
      });
      expect(postAfter.status).toBe(429);
    } finally {
      await prisma.invitation.deleteMany({ where: { teacherId: shared.id } });
      await prisma.session.deleteMany({ where: { accountId: shared.accountId } });
      await prisma.teacher.delete({ where: { id: shared.id } });
      await prisma.account.deleteMany({ where: { id: shared.accountId } });
    }
  }, 30_000);
});
```

- [ ] **Step 11: Run the new tests, confirm they fail**

Run: `npx vitest run --project integration tests/integration/invitations-api.test.ts -t "POST /api/invitations/\[id\]/resend"`

Expected: FAIL — the route doesn't exist yet (404/network error on every request).

- [ ] **Step 12: Confirm they pass**

Run the same command. Expected: all PASS.

- [ ] **Step 13: Run the full integration suite**

Run: `npx vitest run --project integration`

Expected: all PASS, including the two corrected assertions from Step 9.

- [ ] **Step 14: Commit**

```bash
git add src/app/api/invitations/\[id\]/shared.ts src/app/api/invitations/\[id\]/route.ts src/app/api/invitations/\[id\]/resend/route.ts src/lib/rate-limit.ts src/services/invitations.ts src/app/api/students/route.ts tests/integration/students-api.test.ts tests/integration/invitations-api.test.ts
git commit -m "feat(invitations): add POST /api/invitations/[id]/resend and its shared helpers"
```

---

### Task 5: UI — "Last invited" line and Resend button

**Files:**
- Modify: `src/lib/contacts.ts`
- Modify: `src/lib/contacts.test.ts`
- Modify: `src/app/(teacher)/students/contacts/[id]/page.tsx`
- Modify: `src/components/students/contact-form.tsx`
- Modify: `src/components/students/contact-form.test.tsx`

**Interfaces:**
- Consumes: `Invitation.lastNotifiedAt`/`lastNotifiedEmail` (Task 1), `POST /api/invitations/[id]/resend` (Task 4).
- Produces: `invitationDeliveryStatus(...)` from `src/lib/contacts.ts`; `ResendInvitationButton` exported from `src/components/students/contact-form.tsx`.

- [ ] **Step 1: Write the failing unit test for the pure decision function**

In `src/lib/contacts.test.ts`, replace the existing `import { canRemoveContact } from './contacts';` with:

```ts
import { canRemoveContact, invitationDeliveryStatus } from './contacts';
```

Add, at the end of the file:

```ts
describe('invitationDeliveryStatus', () => {
  it('is sent when the last notified address matches the current one', () => {
    const at = new Date('2026-08-01T00:00:00.000Z');
    const result = invitationDeliveryStatus({
      email: 'lena@example.com', lastNotifiedAt: at, lastNotifiedEmail: 'lena@example.com',
    });
    expect(result).toEqual({ sent: true, at });
  });

  it('is not sent when the address was corrected after the last attempt', () => {
    const result = invitationDeliveryStatus({
      email: 'lena@example.com',
      lastNotifiedAt: new Date('2026-08-01T00:00:00.000Z'),
      lastNotifiedEmail: 'lena-old-typo@example.com',
    });
    expect(result).toEqual({ sent: false });
  });

  it('is not sent when no attempt has ever been made', () => {
    const result = invitationDeliveryStatus({
      email: 'lena@example.com', lastNotifiedAt: null, lastNotifiedEmail: null,
    });
    expect(result).toEqual({ sent: false });
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `npx vitest run --project unit src/lib/contacts.test.ts`

Expected: FAIL — `invitationDeliveryStatus` is not exported yet.

- [ ] **Step 3: Implement it**

In `src/lib/contacts.ts`, add after `canRemoveContact`:

```ts
/**
 * Whether a pending invitation's most recent notify attempt reached the
 * address the row currently holds (#173). Pulled out of
 * `/students/contacts/[id]/page.tsx` for the same reason `canRemoveContact`
 * above was: that page is a server component, so no component test can
 * reach the comparison directly.
 *
 * `lastNotifiedEmail` is written unconditionally on every attempt — see
 * `deliverInvitation`'s docblock (services/invitations.ts) — so `sent:
 * false` here means only "not sent to the CURRENT address", never
 * "blocked". A teacher must not be able to tell those two apart from this
 * result.
 */
export function invitationDeliveryStatus(
  invitation: { email: string; lastNotifiedAt: Date | null; lastNotifiedEmail: string | null },
): { sent: true; at: Date } | { sent: false } {
  if (invitation.lastNotifiedAt && invitation.lastNotifiedEmail === invitation.email) {
    return { sent: true, at: invitation.lastNotifiedAt };
  }
  return { sent: false };
}
```

- [ ] **Step 4: Run the test again, confirm it passes**

Run: `npx vitest run --project unit src/lib/contacts.test.ts`

Expected: PASS.

- [ ] **Step 5: Render the status line on the contact detail page**

In `src/app/(teacher)/students/contacts/[id]/page.tsx`, update the imports:

```tsx
import { formatStudentName, timeAgo } from '@/lib/format';
import { canRemoveContact, invitationDeliveryStatus } from '@/lib/contacts';
import { ContactForm, ArchiveContactButton, ResendInvitationButton } from '@/components/students/contact-form';
```

Add `lastNotifiedAt: true, lastNotifiedEmail: true,` to the `select` in the `prisma.invitation.findFirst` call. Then, right before the `return (`:

```tsx
  const displayName = formatStudentName(invitation.firstName, invitation.lastName, true);
  const delivery = invitation.status === 'pending' ? invitationDeliveryStatus(invitation) : null;
```

And replace the single status-label paragraph:

```tsx
      <p className="type-caption mb-6">{STATUS_LABEL[invitation.status]}</p>
```

with:

```tsx
      <div className="mb-6">
        <p className="type-caption">{STATUS_LABEL[invitation.status]}</p>
        {delivery && (
          <p className="type-caption">
            {delivery.sent ? `Last invited ${timeAgo(delivery.at)}` : 'Not yet sent to this address'}
          </p>
        )}
      </div>
```

And in the actions section, add the button next to `ArchiveContactButton`:

```tsx
      <section className="pt-6 border-t border-border flex flex-col items-start gap-4">
        <ArchiveContactButton invitationId={invitation.id} isArchived={invitation.isArchived} />
        {invitation.status === 'pending' && (
          <ResendInvitationButton invitationId={invitation.id} />
        )}
        {/* ... existing comment and canRemoveContact block, unchanged ... */}
```

- [ ] **Step 6: Write the failing component tests for `ResendInvitationButton`**

In `src/components/students/contact-form.test.tsx`, update the import:

```tsx
import { ContactForm, ArchiveContactButton, ResendInvitationButton } from './contact-form';
```

Add, after the `ArchiveContactButton` describe block:

```tsx
describe('ResendInvitationButton', () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  it('POSTs to the resend route and refreshes on success', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    render(<ResendInvitationButton invitationId="inv-1" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith('/api/invitations/inv-1/resend', { method: 'POST' }),
    );
    await waitFor(() => expect(routerRefresh).toHaveBeenCalledTimes(1));
    expect(routerPush).not.toHaveBeenCalled();
  });

  it('shows the server message when the resend fails', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: { message: 'This invitation is no longer pending.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ResendInvitationButton invitationId="inv-1" />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('This invitation is no longer pending.')).toBeInTheDocument();
  });

  it('falls back to generic copy when the server sends no message', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) });
    vi.stubGlobal('fetch', fetchMock);
    render(<ResendInvitationButton invitationId="inv-1" />);

    fireEvent.click(screen.getByRole('button'));

    expect(
      await screen.findByText('Could not resend this invitation. Try again.'),
    ).toBeInTheDocument();
  });

  it('reports a thrown fetch instead of swallowing it', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    vi.stubGlobal('fetch', fetchMock);
    render(<ResendInvitationButton invitationId="inv-1" />);

    fireEvent.click(screen.getByRole('button'));

    expect(await screen.findByText('Network error. Try again.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button')).not.toBeDisabled());
  });
});
```

- [ ] **Step 7: Run the tests, confirm they fail**

Run: `npx vitest run --project components src/components/students/contact-form.test.tsx -t "ResendInvitationButton"`

Expected: FAIL — `ResendInvitationButton` is not exported yet.

- [ ] **Step 8: Implement `ResendInvitationButton`**

In `src/components/students/contact-form.tsx`, add after `ArchiveContactButton`'s closing brace:

```tsx
interface ResendInvitationButtonProps {
  invitationId: string;
}

/**
 * #173. Same shape as `ArchiveContactButton` above — plain button, loading
 * state, inline error via `readErrorMessage` — but no navigation on
 * success: the page's own "Last invited" line (`invitationDeliveryStatus`,
 * lib/contacts.ts) is the confirmation once `router.refresh()` re-fetches
 * the server component's data, so a separate toast would say the same
 * thing twice.
 */
export function ResendInvitationButton({ invitationId }: ResendInvitationButtonProps) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleResend() {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/invitations/${invitationId}/resend`, { method: 'POST' });
      if (res.ok) {
        router.refresh();
      } else {
        setError(await readErrorMessage(res, 'Could not resend this invitation. Try again.'));
      }
    } catch {
      setError('Network error. Try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={handleResend} disabled={loading} className="type-caption">
        {loading ? 'Sending...' : 'Resend invitation'}
      </button>
      {error && <p className="text-sm text-danger mt-2">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 9: Run the component tests again, confirm they pass**

Run: `npx vitest run --project components src/components/students/contact-form.test.tsx`

Expected: all PASS (the full file, including the pre-existing `ContactForm`/`ArchiveContactButton` blocks).

- [ ] **Step 10: Typecheck and lint**

Run: `npm run typecheck && npm run lint`

Expected: clean.

- [ ] **Step 11: Manually verify in the running app**

With the dev server already up on `:3000` (do not start or restart it — see the hazard list), sign in as a teacher, open a pending contact's detail page (`/students/contacts/[id]`), confirm:
- The status line reads "Not yet sent to this address" for a contact that has never been notified, or "Last invited …" for one that has.
- Clicking "Resend invitation" shows "Sending...", then the page refreshes and the line updates to "Last invited just now".
- Editing the contact's email and saving, then reloading the page, still shows "Not yet sent to this address" (proving `PUT` alone doesn't advance the marker).

- [ ] **Step 12: Commit**

```bash
git add src/lib/contacts.ts src/lib/contacts.test.ts "src/app/(teacher)/students/contacts/[id]/page.tsx" src/components/students/contact-form.tsx src/components/students/contact-form.test.tsx
git commit -m "feat(invitations): show delivery status and a resend button on the contact page"
```

---

## Final verification

- [ ] Run `npm run verify` in full (typecheck, lint, unit + components + unit-sweeps + integration — see the spec's acceptance criterion 6 for the arithmetic this proves).
- [ ] Push and let CI run `prisma validate`, the migration-drift check, `npm run build`, and Playwright — none of those tiers run locally.
- [ ] Open a PR citing the spec, this plan, and the exact `npm run verify` output plus the CI run for the build/Playwright tiers.
