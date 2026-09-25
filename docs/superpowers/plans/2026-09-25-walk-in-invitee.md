# Walk-in for invitees and new people (#255) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher can register a pending invitee, or a brand-new person, as a walk-in from the class page. The walk-in creates or reuses the `Student` row, links it to the teacher, and emails the person.

**Architecture:** `POST /api/registrations` accepts two new request shapes, `invitationId` and `newContact`. A new framework-agnostic service, `src/services/walk-ins.ts`, handles consent in two steps: `resolveWalkInStudent` runs before any lock and `completeWalkIn` runs after `Registration`, because `docs/lock-order.md` puts the class work between them. The email goes out as a new essential, immediate-email notification type, `walk_in_added`, sent by the existing fallback sweep. The teacher-side privacy bypass for unclaimed students is deleted, and the create branch seeds a `StudentPrivacy` row instead.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, zod, Vitest (projects `unit`, `components`, `integration`), Playwright.

**Spec:** `docs/superpowers/specs/2026-09-25-walk-in-invitee-design.md` — read it before any task. Its *Premise, re-measured* section explains why this plan departs from the issue text.

## Global Constraints

- TypeScript `strict`; no `any`; no casts that widen a checked type (`as WideType`).
- Every 409 carries a code registered in `src/lib/api-error-codes.ts`; tests assert codes with `expectRefusal` (`tests/api-assertions.ts`), never a literal message string.
- Services in `src/services/` import no framework code (`next/*`, `NextResponse`).
- Lock order is `Student → Class → WaitlistEntry → Registration → StudentPrivacy → TeacherStudent → Invitation → TeacherBlock` (`docs/lock-order.md`). Take `lockLiveStudent` before `lockClassRow`.
- `TeacherStudent` rows are written only via `linkTeacherStudent` (`src/services/roster-link.ts`) — ESLint enforces it.
- `resolveInvitationOnLink` is **never** called from walk-in code.
- Comment Discipline (CLAUDE.md): no counts or member rosters in comments; comments state what is true now; a claim about another module goes in `docs/` with a link.
- Migrations via `pnpm exec prisma migrate dev --name <name>` only; never edit an applied migration. If `migrate dev` refuses because the shell is non-interactive, use `--create-only` and then `pnpm exec prisma migrate deploy` (memory: migrations from the agent shell).
- Test teardown: every `deleteMany` filtered by an id collected in `beforeAll` must first check that the id or array is non-empty. An `undefined` filter deletes the whole table.
- Stage exact paths; never `git add -A` / `git add .`; quote paths containing parentheses.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Worktree: integration/e2e run against the worktree's own app — `pnpm run worktree:up` once before `--project integration` or Playwright. Never touch a server on `:3000`.

## Review Focus

Five inputs the spec implies but doesn't spell out, most likely to break first. Each is pinned by a test in the task that owns the code:

1. **Mixed-case `newContact.email`** matching an existing lowercase `Student`. Expected: the match branch, with no second row, no P2002 answered as 500 and no `requireNormalised` throw. (Task 5, route test.)
2. **`newContact` typed for someone already on this teacher's roster** with no `Invitation` row, for example someone who self-booked. Expected: 201, registers that student, creates an `accepted` invitation row, seeds no privacy. (Task 4, service test.)
3. **Two identical `newContact` posts at once** (a double tap). Expected: one 201 and one 200 `unchanged`; never a 500, never two `Student` rows. (Task 5, route test.)
4. **A refused walk-in leaves nothing behind.** A `newContact` into a class outside the window, or into another teacher's class, writes no `Student`, `Invitation` or `StudentPrivacy` row. (Task 5, route test.)
5. **An invitee whose `Student` is already registered in this class** (they self-booked). Expected: 200 `unchanged`, with no notification and no privacy seed. (Task 5, route test.)

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/lib/erased-address.ts` (new) | builds and recognises erasure placeholder addresses | 1 |
| `src/services/gdpr.ts` | adopts `erasedAddress()` | 1 |
| `prisma/schema.prisma`, new migration | `walk_in_added` enum value | 2 |
| `src/services/notification-policy.ts` | essential + immediate sets | 2 |
| `src/lib/email-templates.ts`, `src/lib/notification-retention.ts` | intro, action link, retention | 2 |
| `src/lib/student-visibility.ts` | bypass deleted | 3 |
| `src/services/invitations.ts` (`rosterLinkState`) | `unclaimed ||` disjunct deleted | 3 |
| `src/services/walk-ins.ts` (new) | consent state machine | 4 |
| `src/lib/schemas.ts` | registration body union | 5 |
| `src/lib/api-error-codes.ts` | three new codes | 5 |
| `src/app/api/registrations/route.ts` | discriminator, wiring, refusals | 5 |
| `docs/lock-order.md` | conformance entry + Student-gate row | 5 |
| `src/app/api/invitations/route.ts` | `?status=pending` | 6 |
| `src/components/class/add-walk-in.tsx` | merged picker + new-person form | 6 |
| `CLAUDE.md`, `prisma/schema.prisma` comment, `docs/data-model.md`, `student-directory.tsx` comment | docs this change falsifies | 7 |

**Task order is load-bearing:**
- Task 3 (deleting the bypass) must land before Task 4, which starts creating unclaimed `Student` rows. Otherwise the branch has a commit where those rows are projected with every privacy flag open.
- Task 2 must precede Task 4, because `completeWalkIn` writes the new notification type.
- Task 1 must precede Task 4, because `resolveWalkInStudent` imports `isErasedAddress`.

---

### Task 1: Erasure placeholder addresses have one owner

**Files:**
- Create: `src/lib/erased-address.ts`
- Create: `src/lib/erased-address.test.ts`
- Modify: `src/services/gdpr.ts` (every `` `deleted-${…}@deleted.invalid` `` template literal)
- Modify: `src/services/email-fallback.ts:180` comment only if it quotes the literal. It may stay, because it describes the value rather than building it.

**Interfaces:**
- Produces: `erasedAddress(id: string): string`, `isErasedAddress(email: string): boolean`, `ERASED_EMAIL_DOMAIN: 'deleted.invalid'`.

- [ ] **Step 1: Write the failing test** (`src/lib/erased-address.test.ts`)

```ts
import { describe, it, expect } from 'vitest';
import { erasedAddress, isErasedAddress } from './erased-address';

describe('erased addresses', () => {
  it('recognises what it builds', () => {
    expect(isErasedAddress(erasedAddress('3f2a'))).toBe(true);
  });

  it('builds the lowercase form the email CHECK constraints require', () => {
    const built = erasedAddress('ABC');
    expect(built).toBe(built.toLowerCase());
  });

  it('does not recognise an ordinary address, or one merely containing the domain', () => {
    expect(isErasedAddress('anna@example.com')).toBe(false);
    expect(isErasedAddress('deleted.invalid@example.com')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `pnpm exec vitest run --project unit src/lib/erased-address.test.ts`
Expected: FAIL, "Failed to resolve import './erased-address'".

- [ ] **Step 3: Implement** (`src/lib/erased-address.ts`)

```ts
/**
 * The placeholder address erasure writes over a real one, and the test for
 * it. One module owns both halves so a reader recognising a placeholder can
 * never drift from the writer building it. Where erasure writes it, and why
 * the value is observable, is `docs/data-model.md` (TeacherBlock, Invitation
 * erasure).
 *
 * `.invalid` is reserved (RFC 2606), so no deliverable address ends in it.
 * The id is lowercased because every email column carries a lowercase CHECK.
 */
export const ERASED_EMAIL_DOMAIN = 'deleted.invalid';

export function erasedAddress(id: string): string {
  return `deleted-${id.toLowerCase()}@${ERASED_EMAIL_DOMAIN}`;
}

export function isErasedAddress(email: string): boolean {
  return email.endsWith(`@${ERASED_EMAIL_DOMAIN}`);
}
```

- [ ] **Step 4: Adopt it in `gdpr.ts`.** Replace every `` `deleted-${X}@deleted.invalid` `` with `erasedAddress(X)`. List them first with `grep -n 'deleted\.invalid' src/services/gdpr.ts`. The values passed are uuids (`crypto.randomUUID()`, `student.accountId`, `studentId`, `teacher.accountId`, `teacherId`), which are already lowercase, so the output is byte-identical. Comments that describe the shape can stay.

- [ ] **Step 5: Run the unit test and the erasure tests**

Run: `pnpm exec vitest run --project unit src/lib/erased-address.test.ts src/services/gdpr`
Expected: PASS.

- [ ] **Step 6: Mutation.** In `isErasedAddress`, change `` `@${ERASED_EMAIL_DOMAIN}` `` to `ERASED_EMAIL_DOMAIN`. Expected: the "merely containing the domain" case goes red. Record the failure line, restore, re-run, and check `git status` is clean apart from intended edits.

- [ ] **Step 7: Commit**

```bash
git add src/lib/erased-address.ts src/lib/erased-address.test.ts src/services/gdpr.ts
git commit -m "refactor(gdpr): erasure placeholder addresses built and recognised in one module (#255)"
```

---

### Task 2: `walk_in_added` notification type

**Files:**
- Modify: `prisma/schema.prisma` (`enum NotificationType`)
- Create: migration via `pnpm exec prisma migrate dev --name notification_type_walk_in_added`
- Modify: `src/services/notification-policy.ts` (`ESSENTIAL_NOTIFICATION_TYPES`, `IMMEDIATE_EMAIL_TYPES`)
- Modify: `src/lib/email-templates.ts` (`STUDENT_INTROS`, `STUDENT_ACTION_LINKS`)
- Modify: `src/lib/notification-retention.ts` (`NOTIFICATION_RETENTION_DAYS`)
- Test: `src/services/notification-policy.test.ts`, the email-templates test file (find it with `ls src/lib | grep email-templates`), and `src/services/email-fallback` tests if a per-type table exists there.

**Interfaces:**
- Produces: `NotificationType` member `'walk_in_added'`. It is essential and immediate, its student email action is `{ label: 'Sign in', path: '/login' }`, and it is kept for the standard retention period.

- [ ] **Step 1: Failing tests.** Add to `notification-policy.test.ts`:

```ts
it('treats a walk-in as essential and emails it on the first sweep', () => {
  expect(isEssential('walk_in_added')).toBe(true);
  expect(
    isEmailEligible(
      { type: 'walk_in_added', createdAt: new Date(), classStart: null },
      new Date(),
      30,
    ),
  ).toBe(true);
});
```

In the email-templates test, add:

```ts
it('gives a walk-in email a sign-in action', () => {
  const { html } = renderNotificationEmail(
    { type: 'walk_in_added', title: 't', body: 'b' },
    'https://example.test',
  );
  expect(html).toContain('href="https://example.test/login"');
  expect(html).toContain('Sign in');
});
```

- [ ] **Step 2: Run them and see them fail.** Run: `pnpm exec vitest run --project unit src/services/notification-policy.test.ts src/lib/email-templates` — expected FAIL; `tsc` also rejects `'walk_in_added'` as not assignable to `NotificationType`.

- [ ] **Step 3: Schema and migration.** Add `walk_in_added` as the last member of `enum NotificationType`, then run `pnpm exec prisma migrate dev --name notification_type_walk_in_added`. The generated SQL should be `ALTER TYPE "NotificationType" ADD VALUE 'walk_in_added';`. Check it with `cat prisma/migrations/*_notification_type_walk_in_added/migration.sql`.

- [ ] **Step 4: Policy, templates, retention.**
  - In `notification-policy.ts`, add `'walk_in_added'` to `ESSENTIAL_NOTIFICATION_TYPES` with a comment: *a booking someone else made for the student, the same reason as `booking_removed`*. Add it to `IMMEDIATE_EMAIL_TYPES` too, and extend that set's docblock sentence to cover a walk-in (*a booking made for them at the door*).
  - In `email-templates.ts`: `STUDENT_INTROS.walk_in_added = 'Your teacher added you to a class.'` and `STUDENT_ACTION_LINKS.walk_in_added = { label: 'Sign in', path: '/login' }`. Extend the `STUDENT_ACTION_LINKS` docblock with why a walk-in links to `/login`: the recipient may have no account yet, and signing in is what claims it.
  - In `notification-retention.ts`: `walk_in_added: STANDARD_RETENTION_DAYS`.

  The `Record<NotificationType, …>` maps fail to compile until each has an entry. That is the tether, so don't add `Partial`.

- [ ] **Step 5: Run the tests and typecheck.** Run: `pnpm exec vitest run --project unit src/services/notification-policy.test.ts src/lib/email-templates && pnpm exec tsc --noEmit`. Expected: PASS.

- [ ] **Step 6: Mutations,** each restored before the next:
  - (a) Remove `'walk_in_added'` from `ESSENTIAL_NOTIFICATION_TYPES`: the essential assertion goes red.
  - (b) Remove it from `IMMEDIATE_EMAIL_TYPES`: `isEmailEligible` goes red.
  - (c) Remove the action link: the template test goes red.

  Record each failure. `git status` must be clean apart from intended edits.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations src/services/notification-policy.ts src/services/notification-policy.test.ts src/lib/email-templates.ts src/lib/notification-retention.ts <the email-templates test file>
git commit -m "feat(notifications): walk_in_added — essential, emailed on the first sweep, links to sign-in (#255)"
```

---

### Task 3: Delete the unclaimed-student privacy bypass

**Must land before Task 4.**

**Files:**
- Modify: `src/lib/student-visibility.ts` (delete `privacyIsBypassed` and `bypassesPrivacy`, plus the comment block that explains them; `teacherVisibleName` and `projectStudentForTeacher` read flags only)
- Modify: `src/services/invitations.ts` (`rosterLinkState`: delete `unclaimed`, the `log.warn` tripwire and the `unclaimed ||` disjunct, together with their comments)
- Modify: `src/lib/student-visibility.test.ts`, `src/services/invitations.gate.test.ts`, and the fixture comments in `src/services/link-consent.test.ts` and `src/app/api/registrations/route.test.ts` that justify "claimed" by the bypass
- Modify: whatever else goes red in Step 5's sweep (see there)

**Interfaces:**
- Produces: `teacherVisibleName(student, teacherId)` and `projectStudentForTeacher(student, teacherId)` with unchanged signatures, gated purely by the teacher's `StudentPrivacy` row. `claimedAt` stays a key of `TeacherVisibleStudent`.

- [ ] **Step 1: Failing tests.** In `student-visibility.test.ts`, replace every case asserting that an unclaimed student is shown ungated with its opposite:

```ts
it('projects an unclaimed student through its privacy row like any other', () => {
  const projected = projectStudentForTeacher(
    {
      id: 's1', firstName: 'Anna', lastName: 'Bergsma', email: 'anna@example.com',
      phone: '0612345678', birthday: new Date('1990-01-01'), address: 'Straat 1',
      claimedAt: null,
      studentPrivacy: [{
        teacherId: 't1', shareFullName: true, shareEmail: true,
        sharePhone: false, shareBirthday: false, shareAddress: false,
      }],
    },
    't1',
  );
  expect(projected).toMatchObject({
    displayName: 'Anna Bergsma', email: 'anna@example.com',
    phone: null, birthday: null, address: null, claimedAt: null,
  });
});

it('masks an unclaimed student with no privacy row', () => {
  const projected = projectStudentForTeacher(
    {
      id: 's2', firstName: 'Anna', lastName: 'Bergsma', email: 'anna@example.com',
      phone: null, birthday: null, address: null, claimedAt: null, studentPrivacy: [],
    },
    't1',
  );
  expect(projected.displayName).toBe('Anna b.');
  expect(projected.email).toBeNull();
});
```

Match the fixture literal to the real `StudentProjectionInput` type: open it and use its exact keys, adding or removing any this sketch gets wrong. In `invitations.gate.test.ts`, find the case that pins an unclaimed, linked student answering `ALREADY_LINKED`. Rewrite it so that a linked, unclaimed student with no `StudentPrivacy` row (or `shareEmail: false`) is **not** told, and one with `shareEmail: true` is. Give each its own `it`.

- [ ] **Step 2: Run them and see them fail.** Run: `pnpm exec vitest run --project unit src/lib/student-visibility.test.ts src/services/invitations.gate.test.ts`. Expected: the new cases fail, because the bypass still ungates.

- [ ] **Step 3: Implement.**
  - `student-visibility.ts`: delete both functions. `teacherVisibleName` becomes `formatStudentName(student.firstName, student.lastName, flags?.shareFullName ?? false)`. `projectStudentForTeacher`'s `shared` helper becomes `(flag, value) => (flag ?? false ? value : null)`. Remove the `log` import if it's now unused. Delete the long comment explaining why the bypass is dead code. Leave one line stating the rule: *an unclaimed student is projected through its `StudentPrivacy` row exactly like a claimed one*.
  - `invitations.ts` `rosterLinkState`: `mayBeTold` becomes the `.find(...)?.shareEmail ?? false` expression alone. Delete `unclaimed`, the tripwire, and the `privacyIsBypassed` import. Keep the comment explaining `.find` against the scoped `teacherId`. Delete the `unclaimed ||` paragraph. Drop `claimedAt: true` from the select if nothing reads it now.

- [ ] **Step 4: Run the two files.** Expected: PASS.

- [ ] **Step 5: Sweep for everything that leaned on the bypass.** Run `pnpm exec tsc --noEmit`, then `pnpm exec vitest run --project unit --project components`, then `pnpm run worktree:up` and `pnpm exec vitest run --project integration`. Triage every red test:
  - **A fixture that creates an unclaimed `Student`** (`claimedAt` absent or null) and asserts on its name or email as a teacher sees it. Fix the fixture, not the assertion: either give it a `StudentPrivacy` row with the flags the test's story needs, or claim it (`claimedAt` plus an `account`, as `route.test.ts`'s fixtures do). Say which in the commit body.
  - **A test pinning the bypass itself.** Rewrite it to the new rule, as in Step 1.
  - **Anything else.** Stop and report. Don't weaken an assertion to get green.

  Then `grep -rn "privacyIsBypassed\|bypassesPrivacy" src tests docs`. Only `docs/superpowers/` may still hit, and those are historical records. Re-read the fixture docblocks in `link-consent.test.ts` and `route.test.ts` that say *"Claimed because `rosterLinkState` hands an unclaimed student's address…"*. The fixtures stay claimed, but their stated reason is now false, so replace it with the true one, or drop it if nothing depends on the choice any more.

- [ ] **Step 6: Mutations,** each restored before the next:
  - (a) Put `student.claimedAt === null ||` back into `shared`'s condition: the "masks an unclaimed student" case goes red.
  - (b) Put `student.claimedAt === null ||` back into `teacherVisibleName`: the `'Anna b.'` assertion goes red.
  - (c) Put the `unclaimed ||` disjunct back into `rosterLinkState` (re-select `claimedAt`): the rewritten gate case goes red.

  Record each failure, restore, and check that `git status` shows only intended edits.

- [ ] **Step 7: Commit**

```bash
git add src/lib/student-visibility.ts src/lib/student-visibility.test.ts src/services/invitations.ts src/services/invitations.gate.test.ts src/services/link-consent.test.ts src/app/api/registrations/route.test.ts <every fixture file Step 5 touched>
git commit -m "fix(privacy): an unclaimed student is projected through its privacy row — the bypass is deleted (#255)"
```

---

### Task 4: `src/services/walk-ins.ts`

**Files:**
- Create: `src/services/walk-ins.ts`
- Create: `src/services/walk-ins.test.ts` (unit project, real test DB, same shape as `link-consent.test.ts`)

**Interfaces:**
- Consumes: `isErasedAddress` (Task 1), the `'walk_in_added'` `NotificationType` (Task 2), `linkTeacherStudent` (`src/services/roster-link.ts`), `createBulkNotifications` (`src/services/notifications.ts`), `requireNormalised` (`src/lib/schemas.ts`).
- Produces (the route in Task 5 depends on these exact names):

```ts
export type WalkInSubject =
  | { kind: 'invitation'; invitationId: string }
  | { kind: 'newContact'; firstName: string; lastName: string; email: string };

export type WalkInRefusal = 'NOT_FOUND' | 'INVITATION_ERASED' | 'DECLINED' | 'WALK_IN_REFUSED';

export class WalkInRefusedError extends Error {
  constructor(readonly refusal: WalkInRefusal);
}

export interface ResolvedWalkIn {
  readonly studentId: string;
  readonly incomeTier: number;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** True when this call created the Student row. Server-side only. */
  readonly created: boolean;
}

export interface WalkInNotice {
  readonly teacherName: string;
  readonly classType: string;
  readonly dateLabel: string;
}

export async function resolveWalkInStudent(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; subject: WalkInSubject },
): Promise<ResolvedWalkIn>;

export async function completeWalkIn(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; classId: string; resolved: ResolvedWalkIn; notice: WalkInNotice },
): Promise<void>;
```

- [ ] **Step 1: Write the failing tests** (`src/services/walk-ins.test.ts`). The fixture and teardown shape is `link-consent.test.ts`'s: collect `teacherIds` / `studentIds` / `accountIds` / `classIds`, and guard each `deleteMany` behind a length check. Each case gets its own teacher (via `seedTeacher(label)`), so no two cases share a `(teacherId, email)`. Create the class with `createClassFixture` (`tests/class-fixtures.ts`); a `teacherRoom` is needed as in `route.test.ts`. The class id is only there for the notification's FK. Teardown also deletes `Notification` rows where `relatedClassId` is in `classIds`, and `StudentPrivacy` / `TeacherStudent` / `Invitation` / `TeacherBlock` rows where `teacherId` is in `teacherIds`.

Every case below that calls the service runs it inside `prisma.$transaction(async (tx) => …)`. Cases:

```ts
const notice = { teacherName: 'Tess Teacher', classType: 'Vinyasa', dateLabel: 'Monday, 5 October' };

async function walkIn(teacherId: string, classId: string, subject: WalkInSubject) {
  return prisma.$transaction(async (tx) => {
    const resolved = await resolveWalkInStudent(tx, { teacherId, subject });
    await completeWalkIn(tx, { teacherId, classId, resolved, notice });
    return resolved;
  });
}

describe('resolveWalkInStudent + completeWalkIn', () => {
  it('creates an unclaimed student for an unknown address, links it, accepts the invitation, seeds name+email sharing', async () => {
    const { teacherId, classId } = await seedTeacher('create');
    const email = `walkin-create-${suffix}@test.local`;
    const resolved = await walkIn(teacherId, classId, { kind: 'newContact', firstName: 'Anna', lastName: 'Bergsma', email });
    studentIds.push(resolved.studentId);

    const student = await prisma.student.findUniqueOrThrow({ where: { id: resolved.studentId } });
    expect(student).toMatchObject({ email, firstName: 'Anna', lastName: 'Bergsma', claimedAt: null, accountId: null, tierSelectedAt: null, incomeTier: 3 });
    expect(await prisma.teacherStudent.count({ where: { teacherId, studentId: resolved.studentId } })).toBe(1);
    expect(await prisma.invitation.findUniqueOrThrow({ where: { teacherId_email: { teacherId, email } } }))
      .toMatchObject({ status: 'accepted', firstName: 'Anna', lastName: 'Bergsma' });
    expect(await prisma.studentPrivacy.findUniqueOrThrow({ where: { studentId_teacherId: { studentId: resolved.studentId, teacherId } } }))
      .toMatchObject({ shareFullName: true, shareEmail: true, sharePhone: false, shareBirthday: false, shareAddress: false });
    const n = await prisma.notification.findFirstOrThrow({ where: { recipientId: resolved.studentId, type: 'walk_in_added' } });
    expect(n).toMatchObject({ recipientType: 'student', relatedClassId: classId });
  });

  it('uses the existing student for a known address and seeds no privacy row', async () => { /* claimed student fixture; walkIn by pending invitationId; expect resolved.created false, same studentId, no StudentPrivacy row for this teacher, invitation accepted, link exists */ });

  it('registers a roster student typed as a new contact, with no invitation row until now', async () => { /* Review Focus 2: student already linked (teacherStudents.create), no Invitation; newContact; expect created false, link count 1, invitation row now accepted, no StudentPrivacy row */ });

  it('attaches the new student to a teacher-only account holding the address', async () => { /* create Account {email} + Teacher on it, no Student; newContact to that email; expect student.accountId === account.id and claimedAt not null */ });

  it('leaves an account that already holds a live student profile alone', async () => { /* Account A with live Student at a different email (so the address has no Student but its account has one): create Account {email: X}, Student {email: Y, accountId: A, claimedAt}; walk in X; expect new student accountId null, claimedAt null */ });

  it('refuses an erased invitation before creating anything', async () => { /* Invitation with email erasedAddress(uuid), firstName 'Deleted'; walk in by id; expect rejects WalkInRefusedError with refusal 'INVITATION_ERASED'; expect no Student with that email */ });

  it('refuses a declined invitation', async () => { /* declined invitation, NO TeacherBlock (so this pins the status read, not the block read); expect refusal 'DECLINED' */ });

  it('refuses a blocked address, and leaves the block standing', async () => { /* pending invitation + TeacherBlock; expect refusal 'WALK_IN_REFUSED'; then teacherBlock.count === 1 and invitation still pending */ });

  it("refuses another teacher's invitation as not found", async () => { /* invitation owned by teacher B, walked in by teacher A; expect 'NOT_FOUND' */ });

  it('refuses a block that commits after resolve, at the last statement of complete', async () => {
    const { teacherId, classId } = await seedTeacher('race');
    const email = `walkin-race-${suffix}@test.local`;
    const inv = await prisma.invitation.create({ data: { teacherId, email, firstName: 'Race', status: 'pending', delivered: false } });
    const other = new PrismaClient();
    try {
      await expect(
        prisma.$transaction(async (tx) => {
          const resolved = await resolveWalkInStudent(tx, { teacherId, subject: { kind: 'invitation', invitationId: inv.id } });
          // An unlink of an undelivered row: block committed, status untouched (#502).
          await other.teacherBlock.create({ data: { teacherId, email } });
          await completeWalkIn(tx, { teacherId, classId, resolved, notice });
        }),
      ).rejects.toMatchObject({ refusal: 'WALK_IN_REFUSED' });
    } finally {
      await other.$disconnect();
    }
    expect(await prisma.student.count({ where: { email } })).toBe(0);
    expect((await prisma.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
  });

  it('refuses a decline that commits after resolve, at the compare-and-set', async () => { /* same shape; `other` updates invitation status to 'declined' (no block) between the two calls; expect 'DECLINED' */ });

  it('continues as the match branch when a concurrent create took the address', async () => {
    const { teacherId, classId } = await seedTeacher('conflict');
    const email = `walkin-conflict-${suffix}@test.local`;
    const theirs = await prisma.student.create({ data: { email, firstName: 'First', lastName: 'Writer' }, select: { id: true } });
    studentIds.push(theirs.id);
    // Force the create branch against a row that already exists: the one
    // interleave where the insert, not the read, meets the other writer.
    const resolved = await prisma.$transaction(async (tx) => {
      vi.spyOn(tx.student, 'findUnique').mockResolvedValueOnce(null);
      const r = await resolveWalkInStudent(tx, { teacherId, subject: { kind: 'newContact', firstName: 'Anna', lastName: 'B', email } });
      await completeWalkIn(tx, { teacherId, classId, resolved: r, notice });
      return r;
    });
    expect(resolved).toMatchObject({ studentId: theirs.id, created: false });
    expect(await prisma.student.count({ where: { email } })).toBe(1);
  });
});
```

Fill in each `/* … */` body in full. The comment names the fixture state and every assertion the case must make. If `vi.spyOn` on the interactive-transaction client's `student` delegate doesn't take (Prisma may build delegates per access), inject the lookup instead. Give `resolveWalkInStudent` no new parameter for tests; spy on `prisma.$transaction`'s client via a wrapper `tx` object, `{ ...tx, student: { ...tx.student, findUnique: … } }`. Report which one worked. Don't assert on thrown messages, only on `refusal`.

- [ ] **Step 2: Run them and see them fail.** Run: `pnpm exec vitest run --project unit src/services/walk-ins.test.ts`. Expected: FAIL, "Failed to resolve import './walk-ins'".

- [ ] **Step 3: Implement** `src/services/walk-ins.ts`:

```ts
/**
 * A walk-in: a teacher registering someone at the door who is not on their
 * roster. Presence is acceptance — the teacher's act links the person and
 * accepts their invitation — which is the one exception to "a teacher may not
 * link a student unilaterally"; the rule and its accepted residuals are
 * `docs/data-model.md` (Invitation, "Walk-ins").
 *
 * Two steps, because `docs/lock-order.md` puts the class work between them:
 * `resolveWalkInStudent` runs before the transaction's first lock and may
 * INSERT the `Student` (first in the order); `completeWalkIn` runs after
 * `Registration` and writes `StudentPrivacy → TeacherStudent → Invitation`,
 * then reads `TeacherBlock` last.
 *
 * `resolveInvitationOnLink` is never called here: it deletes the block, and a
 * teacher's act must not lift a student's refusal.
 */
import { Prisma } from '@prisma/client';
import { requireNormalised } from '@/lib/schemas';
import { isErasedAddress } from '@/lib/erased-address';
import { linkTeacherStudent } from './roster-link';
import { createBulkNotifications } from './notifications';

export type WalkInSubject =
  | { kind: 'invitation'; invitationId: string }
  | { kind: 'newContact'; firstName: string; lastName: string; email: string };

export type WalkInRefusal = 'NOT_FOUND' | 'INVITATION_ERASED' | 'DECLINED' | 'WALK_IN_REFUSED';

export class WalkInRefusedError extends Error {
  constructor(readonly refusal: WalkInRefusal) {
    super(`walk-in refused: ${refusal}`);
    this.name = 'WalkInRefusedError';
  }
}

export interface ResolvedWalkIn {
  readonly studentId: string;
  readonly incomeTier: number;
  readonly email: string;
  readonly firstName: string;
  readonly lastName: string;
  /** True when this call created the Student row. Drives the privacy seed; never leaves the server. */
  readonly created: boolean;
}

export interface WalkInNotice {
  readonly teacherName: string;
  readonly classType: string;
  readonly dateLabel: string;
}

async function subjectContact(
  tx: Prisma.TransactionClient,
  teacherId: string,
  subject: WalkInSubject,
): Promise<{ email: string; firstName: string; lastName: string; status: 'pending' | 'accepted' | 'declined' | null }> {
  if (subject.kind === 'invitation') {
    const row = await tx.invitation.findFirst({
      where: { id: subject.invitationId, teacherId },
      select: { email: true, firstName: true, lastName: true, status: true },
    });
    if (row === null) throw new WalkInRefusedError('NOT_FOUND');
    return row;
  }
  const email = requireNormalised(subject.email);
  const row = await tx.invitation.findUnique({
    where: { teacherId_email: { teacherId, email } },
    select: { status: true },
  });
  return { email, firstName: subject.firstName, lastName: subject.lastName, status: row?.status ?? null };
}

export async function resolveWalkInStudent(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; subject: WalkInSubject },
): Promise<ResolvedWalkIn> {
  const contact = await subjectContact(tx, input.teacherId, input.subject);

  // Erased first: the teacher already reads "Deleted Student" on this row.
  if (isErasedAddress(contact.email)) throw new WalkInRefusedError('INVITATION_ERASED');
  // Declined before blocked: every decline also writes a block (#522), and
  // the teacher already reads `declined` on their own Contacts row.
  if (contact.status === 'declined') throw new WalkInRefusedError('DECLINED');
  const blocked = await tx.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId: input.teacherId, email: contact.email } },
    select: { id: true },
  });
  if (blocked) throw new WalkInRefusedError('WALK_IN_REFUSED');

  const existing = await tx.student.findUnique({
    where: { email: contact.email },
    select: { id: true, incomeTier: true },
  });
  if (existing) {
    return { studentId: existing.id, incomeTier: existing.incomeTier, ...names(contact), created: false };
  }

  // A teacher-only account holding this address gets the profile now; sign-in
  // would never claim it (`resolveOrClaimAccount` returns early when an
  // Account exists). One live profile per account (#623), so an account that
  // already has one is left alone and the row stays unclaimed.
  const account = await tx.account.findUnique({
    where: { email: contact.email },
    select: { id: true, students: { where: { deletedAt: null }, select: { id: true } } },
  });
  const attach = account !== null && account.students.length === 0 ? account.id : null;

  // `ON CONFLICT DO NOTHING` rather than a caught P2002: Postgres aborts an
  // interactive transaction on any error, so a catch could not re-read.
  // An empty result means a concurrent create took the address first.
  const [created] = await tx.student.createManyAndReturn({
    data: [{
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
      // Scalar pair in one statement: `Student_claim_link_check`.
      ...(attach ? { accountId: attach, claimedAt: new Date() } : {}),
    }],
    skipDuplicates: true,
    select: { id: true, incomeTier: true },
  });
  if (created) {
    return { studentId: created.id, incomeTier: created.incomeTier, ...names(contact), created: true };
  }
  const raced = await tx.student.findUniqueOrThrow({
    where: { email: contact.email },
    select: { id: true, incomeTier: true },
  });
  return { studentId: raced.id, incomeTier: raced.incomeTier, ...names(contact), created: false };
}

function names(c: { email: string; firstName: string; lastName: string }) {
  return { email: c.email, firstName: c.firstName, lastName: c.lastName };
}

export async function completeWalkIn(
  tx: Prisma.TransactionClient,
  input: { teacherId: string; classId: string; resolved: ResolvedWalkIn; notice: WalkInNotice },
): Promise<void> {
  const { teacherId, resolved } = input;

  // The teacher typed the name and the address; they have no claim on the
  // rest. The match branch seeds nothing — that person's own settings govern.
  if (resolved.created) {
    await tx.studentPrivacy.create({
      data: { teacherId, studentId: resolved.studentId, shareFullName: true, shareEmail: true },
    });
  }

  await linkTeacherStudent(tx, { teacherId, studentId: resolved.studentId });

  await tx.invitation.createMany({
    data: [{ teacherId, email: resolved.email, firstName: resolved.firstName, lastName: resolved.lastName }],
    skipDuplicates: true,
  });
  const updated = await tx.invitation.updateMany({
    where: { teacherId, email: resolved.email, status: 'pending' },
    data: { status: 'accepted', respondedAt: new Date() },
  });
  if (updated.count === 0) {
    const current = await tx.invitation.findUnique({
      where: { teacherId_email: { teacherId, email: resolved.email } },
      select: { status: true },
    });
    if (current === null) throw new WalkInRefusedError('NOT_FOUND');
    if (current.status === 'declined') throw new WalkInRefusedError('DECLINED');
  }

  await createBulkNotifications(tx, [{
    recipientType: 'student',
    recipientId: resolved.studentId,
    type: 'walk_in_added',
    title: `You're in ${input.notice.classType}`,
    body: `${input.notice.teacherName} added you to ${input.notice.classType} on ${input.notice.dateLabel}. Your price is calculated after class.`,
    relatedClassId: input.classId,
  }]);

  // LAST statement, the #537 pattern `acceptInvitation` uses: a block
  // committed after `resolveWalkInStudent`'s read — an unlink of an
  // undelivered row leaves the invitation `pending` — is caught here.
  const blockedNow = await tx.teacherBlock.findUnique({
    where: { teacherId_email: { teacherId, email: resolved.email } },
    select: { id: true },
  });
  if (blockedNow) throw new WalkInRefusedError('WALK_IN_REFUSED');
}
```

Verify before relying on them: the compound unique names Prisma generates (`teacherId_email`, `studentId_teacherId`) with `grep -n "@@unique\|@@id" prisma/schema.prisma`; and `createManyAndReturn`'s `skipDuplicates` as `src/app/api/classes/route.ts` uses it. `ON CONFLICT DO NOTHING` with no target also swallows a `Student_account_live_unique` conflict (a teacher-only account gaining a live profile under another address between the `account` read and the insert). The re-read by email then finds nothing, and `findUniqueOrThrow` throws, so that request answers 500. Accept that and don't add handling for it: it needs a second profile created for the same account inside the same few milliseconds.

- [ ] **Step 4: Run the tests.** `pnpm exec vitest run --project unit src/services/walk-ins.test.ts`. Expected: PASS.

- [ ] **Step 5: Mutations.** One at a time; restore after each and re-run to green:
  - (a) Delete the `isErasedAddress` refusal: "refuses an erased invitation" goes red.
  - (b) Delete the `declined` refusal in `resolveWalkInStudent`: "refuses a declined invitation" goes red. Its fixture has no block, so the block read can't mask it.
  - (c) Delete the block read in `resolveWalkInStudent`: "refuses a blocked address" goes red. **Predicted inert:** the final re-check in `completeWalkIn` catches the same block. If so, record it as inert-by-design, and add a case that calls `resolveWalkInStudent` alone and expects it to reject, so the early read has a test of its own.
  - (d) Delete the final `blockedNow` read: the race case goes red.
  - (e) Delete the CAS-miss `declined` branch: the decline-race case goes red.
  - (f) Replace the own CAS with `resolveInvitationOnLink(tx, { teacherId, studentEmail: resolved.email, linkOutcome: 'created' })`: "leaves the block standing" or the race case goes red. Record which.
  - (g) Seed privacy unconditionally (drop `if (resolved.created)`): the match-branch "seeds no privacy row" case goes red.
  - (h) Drop `attach`: the teacher-only-account case goes red.
  - (i) Replace the empty-result re-read with `throw new Error('conflict')`: the concurrent-create case goes red.

  Record each failure line. Finish with `git status` clean apart from intended edits.

- [ ] **Step 6: Commit**

```bash
git add src/services/walk-ins.ts src/services/walk-ins.test.ts
git commit -m "feat(walk-ins): resolve and complete a walk-in for an invitee or a new person (#255)"
```

---

### Task 5: Wire walk-ins into `POST /api/registrations`

**Files:**
- Modify: `src/lib/schemas.ts` (`createRegistrationSchema`)
- Modify: `src/lib/api-error-codes.ts` (add `INVITATION_ERASED: 409`, `WALK_IN_REFUSED: 409`, `WALK_IN_WINDOW_CLOSED: 409`, alphabetically)
- Modify: `src/app/api/registrations/route.ts`
- Modify: `src/app/api/registrations/route.test.ts` (new `describe` block for walk-ins; in-process `POST`, no server)
- Modify: `docs/lock-order.md` (Known conformance entry for `POST /api/registrations`, around `:2609`; Student-gate table row, around `:1176`)

**Interfaces:**
- Consumes: everything Task 4 produces.
- Produces: request bodies `{ classId, invitationId }` and `{ classId, newContact: { firstName, lastName?, email } }`; refusal codes `WALK_IN_WINDOW_CLOSED`, `WALK_IN_REFUSED`, `INVITATION_ERASED`, `DECLINED`, and `NOT_FOUND` (404) for a foreign invitation. The response body is unchanged (`{ id, status }`).

- [ ] **Step 1: Failing tests.** In `route.test.ts`, add `describe('POST /api/registrations — walk-ins (#255)')`. It gets its own teacher (with account and session token, as the existing fixture does) and two classes: `inWindow` (create with `status: 'open'`, then `prisma.class.update({ status: 'in_progress' })`) and `farOff` (2099, `open`). The helper:

```ts
async function post(token: string, body: unknown): Promise<Response> {
  return POST(new NextRequest('http://localhost/api/registrations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...cookie(token) },
    body: JSON.stringify(body),
  }));
}
```

Check the existing file's own request helper first and reuse it if one exists. Cases (each asserts status, and code where it refuses):

1. A pending invitee walked in → 201. A `Registration` with `isWalkIn: true` exists, and `tierAtBooking` is the student's tier.
2. A new person walked in → 201. Registration exists, `Student.tierSelectedAt` stays `null` (the self-booking stamp must not fire).
3. **The two branches look the same:** the JSON bodies of case 1 and case 2 have identical key sets (`Object.keys(data).sort()`).
4. `invitationId` into `farOff` → `expectRefusal(res, 'WALK_IN_WINDOW_CLOSED')`. The same for `newContact` → `WALK_IN_WINDOW_CLOSED`, **and** no `Student`, `Invitation` or `StudentPrivacy` row exists for that email afterwards (Review Focus 4).
5. `newContact` into another teacher's class → 403, with no rows left behind (Review Focus 4).
6. A blocked pending invitation → `WALK_IN_REFUSED`. An erased invitation → `INVITATION_ERASED`. A declined address typed as `newContact` → `DECLINED`. Another teacher's `invitationId` → `expectRefusal(res, 'NOT_FOUND')`.
7. A body with `invitationId` from a session that has a **student profile too** (a dual-role teacher) books the invitee, not the teacher's own student profile: the registration's `studentId` is the invitee's.
8. A student-only session posting `invitationId` → 403.
9. `{ classId, studentId, invitationId }` → 400 (strict union).
10. Mixed-case `newContact.email` (`'Anna.Case@Test.Local'` variant of an existing claimed student's address) → 201 against that student. There's no second `Student`, and the response isn't a 500 (Review Focus 1). Check what `emailField` does; it should lowercase. If it doesn't, the test shows it and the route must normalise.
11. Two concurrent identical `newContact` posts (`Promise.all`) → statuses sorted `[200, 201]`, and exactly one `Student` with that email (Review Focus 3). If the second answers 500 or 409 `UNIQUE_CONFLICT`, fix the route (Step 3's P2002 branch) rather than the test.
12. An invitee who already self-booked this class → 200 via `expectUnchanged`, with no `walk_in_added` notification (Review Focus 5).
13. The `newContact` rate limit: mock `checkStudentWriteLimit` to return `{ allowed: false, … }` with `vi.spyOn` on the `@/lib/rate-limit` module namespace (check how other route tests stub it with `grep -rn "checkStudentWriteLimit" src tests`) → 429. An `invitationId` post under the same mock → 201.

- [ ] **Step 2: Run them and see them fail.** `pnpm exec vitest run --project unit src/app/api/registrations/route.test.ts`. Expected: new cases FAIL (400 from the current schema).

- [ ] **Step 3: Schema.**

```ts
const registrationClassId = { classId: z.string().uuid() };

export const createRegistrationSchema = z.union([
  z.object({ ...registrationClassId, studentId: z.string().uuid() }).strict(),
  z.object({ ...registrationClassId, invitationId: z.string().uuid() }).strict(),
  z.object({ ...registrationClassId, newContact: createInvitationSchema }).strict(),
  z.object(registrationClassId).strict(),
]);
export type CreateRegistrationBody = z.infer<typeof createRegistrationSchema>;
```

`createRegistrationSchema` must be declared after `createInvitationSchema`. Confirm `booking-flow.tsx` posts only `{ classId }`, which `grep -n "JSON.stringify" src/components/booking/booking-flow.tsx` shows.

- [ ] **Step 4: Route.** The changes to `route.ts`:
  - **Discriminator, decided once:**
    ```ts
    type Subject =
      | { kind: 'self' }
      | { kind: 'roster'; studentId: string }
      | { kind: 'walkIn'; walkIn: WalkInSubject };

    function subjectOf(body: CreateRegistrationBody): Subject {
      if ('studentId' in body) return { kind: 'roster', studentId: body.studentId };
      if ('invitationId' in body) return { kind: 'walkIn', walkIn: { kind: 'invitation', invitationId: body.invitationId } };
      if ('newContact' in body) return { kind: 'walkIn', walkIn: { kind: 'newContact', ...body.newContact } };
      return { kind: 'self' };
    }
    ```
    `isTeacher = subject.kind !== 'self'`, and `actingTeacherId = isTeacher ? session.teacherId : null`. With `isTeacher` and no `teacherId` → 403 `'Teacher access required'`. For `self`, `studentId = session.studentId`, else 403 as today.
  - **Rate limit:** for `walkIn` with `walkIn.kind === 'newContact'`, call `checkStudentWriteLimit(teacherId)` before the transaction. If refused, `return respondRateLimited(limit, 'Too many new contacts.')` and log `warn` as `api/students/route.ts` does.
  - **The pre-transaction student read and roster check** (`:97-106`) run for `self`/`roster` only. The walk-in path has no `studentId` until inside the transaction.
  - **Inside the transaction,** before `lockLiveStudent`:
    ```ts
    const resolved = subject.kind === 'walkIn'
      ? await resolveWalkInStudent(tx, { teacherId: actingTeacherId, subject: subject.walkIn })
      : null;
    const studentId = resolved?.studentId ?? knownStudentId;
    const tierAtBooking = resolved?.incomeTier ?? knownStudent.incomeTier;
    ```
    Restructure the variables so each path's `studentId`/`tier` is definitely assigned without a non-null assertion. A small `{ studentId, tier }` value built per branch is fine. `studentId` must be in scope for the `catch`'s P2002 re-read, so hoist a `let bookedStudentId: string | null` that the transaction assigns. On a P2002 twin re-read with `bookedStudentId === null`, rethrow.
  - Extend the class read's `teacher` select with `firstName: true, lastName: true`.
  - **Window refusal:** after the `allowedStatuses` check and after computing `isWalkIn`, `if (resolved && !isWalkIn) throw new WalkInWindowClosedError()`, a new local error class. It comes after the `unchanged` check (a retry is never refused), matching the existing ordering comment.
  - **After** the `settingsLocked` update:
    ```ts
    if (resolved) {
      await completeWalkIn(tx, {
        teacherId: cls.calendarEntry.teacherId,
        classId: cls.id,
        resolved,
        notice: {
          teacherName: `${cls.calendarEntry.teacher.firstName} ${cls.calendarEntry.teacher.lastName}`.trim(),
          classType: cls.calendarEntry.classType,
          dateLabel: formatDayHeader(cls.calendarEntry.date),
        },
      });
    }
    ```
  - **`tierSelectedAt` stamp:** the guard becomes `if (subject.kind === 'self')`.
  - **`catch`:** map `WalkInRefusedError` through a `Record<WalkInRefusal, CodedRefusal>` built with `codedRefusal` and answered with `respondRefusal` (the #649 pattern; see `api-error-codes.ts` and `api-utils.ts`):
    ```ts
    const WALK_IN_REFUSALS: Record<WalkInRefusal, CodedRefusal> = {
      NOT_FOUND: codedRefusal('NOT_FOUND', 'Contact not found.'),
      INVITATION_ERASED: codedRefusal('INVITATION_ERASED', "This contact's account has been deleted."),
      DECLINED: codedRefusal('DECLINED', 'This person declined your invitation.'),
      WALK_IN_REFUSED: codedRefusal('WALK_IN_REFUSED', "This person can't be added to your classes."),
    };
    ```
    and `WalkInWindowClosedError` → `respondError('Walk-ins can be added once the class is about to start.', 409, 'WALK_IN_WINDOW_CLOSED')`.
  - **Rewrite the `!isTeacher` block's #166 comment,** which says "a roster add or a walk-in never launders itself into acceptance". Now it should say that a *walk-in* resolves its own invitation in `completeWalkIn` without lifting a block, and the roster add resolves none. Point to `docs/data-model.md` rather than restating the rule.

- [ ] **Step 5: Run.** `pnpm exec vitest run --project unit src/app/api/registrations/route.test.ts && pnpm exec tsc --noEmit`. Expected: PASS. Then `pnpm run worktree:up` and `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts`. Expected: PASS, since existing behaviour is unchanged.

- [ ] **Step 6: Mutations.** One at a time; restore after each:
  - (a) Delete the `if (resolved && !isWalkIn)` refusal: case 4 goes red.
  - (b) Revert the `tierSelectedAt` guard to `if (!('studentId' in body))`: case 2 goes red.
  - (c) Change `subjectOf` so `invitationId` falls through to `self`: case 7 or case 1 goes red.
  - (d) Skip the rate-limit call: case 13 goes red.
  - (e) Map `WALK_IN_REFUSED` to the `DECLINED` code: case 6 goes red.

  Record each. Finish with `git status` clean apart from intended edits.

- [ ] **Step 7: `docs/lock-order.md`.**
  - In the Known conformance entry for `POST /api/registrations`, add the walk-in order: `Student` (an INSERT by `resolveWalkInStudent` on the create branch, then `lockLiveStudent`) → `Class` → `Registration`, `WaitlistEntry` → `StudentPrivacy` (create branch) → `TeacherStudent` → `Invitation` → `TeacherBlock` (a plain read, last). State that this conforms to the canonical line, unlike the self-booking path's `TeacherBlock`-before-`Invitation` via `resolveInvitationOnLink`.
  - In the Student-gate table row, add that on the walk-in path the student is resolved (and possibly created) inside the transaction, so there is no pre-transaction 404.

  Both follow the existing entries' wording style, with no counts.

- [ ] **Step 8: Commit**

```bash
git add src/lib/schemas.ts src/lib/api-error-codes.ts src/app/api/registrations/route.ts src/app/api/registrations/route.test.ts docs/lock-order.md
git commit -m "feat(registrations): walk in a pending invitee or a new person (#255)"
```

---

### Task 6: The walk-in panel lists invitees and adds a new person

**Files:**
- Modify: `src/app/api/invitations/route.ts` (`?status=pending`)
- Test: `tests/integration/invitations-api.test.ts` (new case)
- Modify: `src/components/class/add-walk-in.tsx`
- Modify: `src/components/class/add-walk-in.test.tsx`
- Modify: `src/components/students/contact-list.tsx` docblock (`:47-49`), which anticipates the flag: state that it now exists and who uses it, in one line.
- Test: `tests/e2e/teacher-journey.spec.ts` (extend the walk-in step)

**Interfaces:**
- Consumes: the Task 5 request bodies, and `isErasedAddress` / `ERASED_EMAIL_DOMAIN` (Task 1).
- Produces: `GET /api/invitations?status=pending`, which returns non-archived, `pending`, non-erased rows with the same select as today.

- [ ] **Step 1: Failing API test.** In `invitations-api.test.ts`, seed one pending, one declined, one archived pending, and one pending erased row (email `erasedAddress(randomUUID())`) for one teacher. `GET /api/invitations?status=pending` returns exactly the plain pending row. Without the flag, the response is unchanged: all non-archived rows.

- [ ] **Step 2: Implement the flag:**

```ts
const pendingOnly = request.nextUrl.searchParams.get('status') === 'pending';
const where: Prisma.InvitationWhereInput = pendingOnly
  ? { teacherId: session.teacherId, isArchived: false, status: 'pending', NOT: { email: { endsWith: `@${ERASED_EMAIL_DOMAIN}` } } }
  : { teacherId: session.teacherId, isArchived: archived };
```

Add a one-line comment: *the walk-in picker's list (`add-walk-in.tsx`); erased rows are left out because walking one in is refused*. Run with `pnpm run worktree:up` then `pnpm exec vitest run --project integration tests/integration/invitations-api.test.ts` — PASS.

- [ ] **Step 3: Failing component tests** (`add-walk-in.test.tsx`; follow its existing fetch-mock pattern):
  1. With roster `[{ id: 's1', displayName: 'Bram V.' }]` and invitations `[{ id: 'i1', firstName: 'Anna', lastName: 'Bergsma', … }]`, the select's options read `Anna Bergsma · invited` then `Bram V.` (alphabetical, merged).
  2. Choosing the invitee and pressing **Add walk-in** posts `{ classId, invitationId: 'i1' }`. Choosing the roster student posts `{ classId, studentId: 's1' }`.
  3. Filling the new-person form (First name, Last name, Email) and pressing its **Add new person** button posts `{ classId, newContact: { firstName, lastName, email } }`.
  4. A 409 response shows the server's message in the `role="alert"` region, whatever its code.
  5. The caption "Not in your students yet? Add them under Students first." is gone.
  6. If the invitations fetch fails while the roster succeeds, the roster is still offered and the load-failure message names invitees ("Could not load your invited contacts."). Decide this state explicitly rather than hiding the whole picker.

- [ ] **Step 4: Implement.**
  - Fetch both lists in the existing effect, each with its own failure state. Build `options: Array<{ value: string; label: string }>` with values `student:<id>` / `invitation:<id>`, sorted by `label.localeCompare(other, undefined, { sensitivity: 'base' })`. The invitee label is `` `${firstName} ${lastName}`.trim() + ' · invited' ``. The filter keeps matching on the name part.
  - Under the picker's buttons, add a divider (`<hr className="border-border" />` or the house divider, whichever `docs/design-brief.md` names) and a heading-less group with three `Input`s: `label="First name"`, `label="Last name"`, `label="Email"` (`type="email"`). Add one `Button variant="secondary"`, **Add new person**, disabled until first name and email are non-empty or while submitting.
  - Both submit paths share one `submit(body)` function, which keeps the current success (`setOpen(false)`, `router.refresh()`) and error handling.
  - Replace the top-of-file comment: *the picker merges this teacher's roster with their pending invitations; a new person is added from the form below, which creates the contact and the registration at once*. Remove the caption.

  Follow the design brief: six type styles only, no motion, no new colors.

- [ ] **Step 5: Run.** `pnpm exec vitest run --project components src/components/class/add-walk-in.test.tsx`. Expected: PASS.

- [ ] **Step 6: e2e.** In `teacher-journey.spec.ts`, find the existing walk-in step (`grep -n "walk-in" tests/e2e/teacher-journey.spec.ts`). Extend it, or add a sibling test on the same in-progress class fixture: add a brand-new person through the form, and assert their name appears in the class's registration list. Run with `pnpm exec playwright test tests/e2e/teacher-journey.spec.ts` after `pnpm run worktree:up`. If `visual.spec.ts` covers the class page with the panel **closed**, it is unaffected; if it opens the panel, update the baseline per `docs/` visual-attestation rules and say so in the commit.

- [ ] **Step 7: Mutation.** Change the invitee option's value to `student:<id>`: component case 2 goes red. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/invitations/route.ts tests/integration/invitations-api.test.ts src/components/class/add-walk-in.tsx src/components/class/add-walk-in.test.tsx src/components/students/contact-list.tsx tests/e2e/teacher-journey.spec.ts
git commit -m "feat(class): the walk-in panel lists invitees and adds a new person in one step (#255)"
```

---

### Task 7: Documentation this change falsifies

**Files:**
- Modify: `CLAUDE.md` (Data Model, the `Account` bullet)
- Modify: `prisma/schema.prisma` (the `Student.accountId` comment: "nothing produces an unclaimed row any more")
- Modify: `docs/data-model.md` (Student; StudentPrivacy "Two sites write it"; Invitation roster-link census; a new "Walk-ins" paragraph with the accepted residuals)
- Modify: `src/components/students/student-directory.tsx` (the "unlinked" caption comment)

**No new tests.** Each edit is verified by the grep in Step 2.

- [ ] **Step 1: Edit.**
  - **`CLAUDE.md`:** in the `Account` bullet, after "A teacher may not link a student unilaterally…", add one sentence: *the exception is a walk-in, where the teacher registers someone standing at the door: presence is acceptance, so it links them and accepts their invitation, creating an unclaimed `Student` when the address has none; it never lifts a `TeacherBlock` (`docs/data-model.md`, Invitation → Walk-ins)*. Replace "nothing creates an unclaimed `Student` row any more, though pre-existing unclaimed rows…" with the true statement: *unclaimed `Student` rows are created only by a walk-in and claim their account on first sign-in*.
  - **`schema.prisma`:** rewrite the `accountId` comment to what's true now: nullable for an unclaimed row, which a walk-in creates (`services/walk-ins.ts`); what reads for one is `docs/data-model.md` (StudentPrivacy). This is a comment-only edit to `schema.prisma`, not to a migration, so it's safe.
  - **`docs/data-model.md`:**
    - Update the StudentPrivacy writer list to name `completeWalkIn`'s create-branch seed, and why it sets `shareFullName` and `shareEmail` only.
    - Update the unclaimed-student paragraphs: the bypass is deleted, and an unclaimed student is projected through its flags.
    - Re-run the roster-link census grep (`data-model.md` `:184`) and update its count **with the command's output**, classifying `completeWalkIn` as *resolves by its own hand, with its own compare-and-set, like `acceptInvitation`*.
    - Add a **Walk-ins (#255)** paragraph under Invitation: presence is acceptance, the window bound, the refusal order and why, and the three accepted residuals copied from the spec's *Accepted residuals*.
  - **`student-directory.tsx`:** replace the "unreachable… dead code" comment with: *an unclaimed student is someone a teacher walked in who has not signed in yet*.

- [ ] **Step 2: Sweep for what this invalidated.** Run each and give every hit a verdict (fixed, or legitimately still true):

```bash
grep -rn "unclaimed" CLAUDE.md prisma/schema.prisma docs/data-model.md docs/technical-architecture.md src
grep -rn "nothing creates an unclaimed\|nothing produces an unclaimed\|sole site that creates\|sole remaining create site" src docs CLAUDE.md prisma
grep -rn "may not link a student unilaterally\|never launders" src docs CLAUDE.md
grep -rn "Students → New\|Add them under Students first" src
```

Hits in `docs/superpowers/` are historical records; leave them.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md prisma/schema.prisma docs/data-model.md src/components/students/student-directory.tsx
git commit -m "docs: walk-ins are the named exception to unilateral linking; unclaimed rows have a creator again (#255)"
```

---

## After the tasks

- A whole-branch review, one fix wave and one scoped re-review (this plan has 7 tasks).
- `pnpm run verify` with the worktree app up, then push and open a PR. The PR body carries the spec's premise table, the mutation record from every task, and the arithmetic for the green run.
