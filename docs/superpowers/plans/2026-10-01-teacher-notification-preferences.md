# Teacher notification preferences (#49) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A teacher chooses, per optional event, whether a notification reaches their inbox and whether it is emailed. A class auto-cancel always emails.

**Architecture:**
- Three columns on `Teacher` hold the preferences.
- A policy table in `notification-policy.ts` decides each teacher type's email.
- A discriminated union on `CreateNotificationInput` means a new teacher notification type will not compile until that table classifies it.
- Two enforcement points: the booking transaction (inbox on/off for new bookings) and the fallback sweep's teacher branch (email).
- A new settings page writes the preferences through the existing `PUT /api/teachers/[id]`.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL, Zod 4, Vitest (`unit`, `unit-sweeps`, `integration`, `components` projects), Testing Library.

**Spec:** `docs/superpowers/specs/2026-10-01-teacher-notification-preferences-design.md`. Read it before any task. The policy table is in §2 and the tether is in §4.

## Global Constraints

- `strict: true`. No `any`, and no widening casts (`as NotificationType`, `as CreateNotificationInput`) at notification call sites. Spec §4 measured that a single cast is refused, and that both casts together (or `as unknown as`) silently disable the tether.
- Defaults reproduce today's behaviour: `bookingNotifications = inbox_and_email`, `emailOnClassCompleted = true`, `emailOnInvitation = true`.
- `class_cancelled` to a teacher is always emailed. No setting reaches it.
- Only `booking_confirmed` can be switched off for the inbox. The other types are always created.
- **Migrations.** `prisma migrate dev` refuses a non-interactive shell. Generate the SQL with `pnpm exec prisma migrate diff --from-schema-datasource prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script`, hand-write the migration directory, and apply it with `pnpm exec prisma migrate deploy`. Migration comments describe only their own SQL. A migration is never edited once applied, comment-only edits included.
- **Comment discipline** (CLAUDE.md). No counts or member lists in prose: name the type. A comment annotates only the code it sits on.
- Stage exact paths, and quote any containing parentheses (`'src/app/(teacher)/…'`). Never `git add -A`.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Worktree.** Prefix commands with `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`, because the default shell has Node 22 and pnpm refuses it. Before any `--project integration` run, use `pnpm run worktree:setup` (once) and `pnpm run worktree:up`. Never touch a dev server on :3000.
- **Copy** (spec §7):
  - Radio labels: "In the inbox, and emailed if I miss it" / "In the inbox only" / "Off".
  - Booking caption: "Bookings always show on your schedule — this only changes whether you're told about each one."
  - Checkboxes: "Email me when I miss a class-completed summary" and "Email me when I miss an invitation".
  - Auto-cancel row: "Always emailed — so you know the class won't run."

## Review Focus

1. **A dual-hat account.** A teacher who also has a student profile with `emailNotifications = false` must still get teacher mail by their teacher preferences. Teacher preferences must not touch their student rows. Test: Task 3.
2. **Changing a preference after unread rows exist.** A `booking_confirmed` created under `inbox_and_email`, still unread when the teacher switches to `inbox_only` or `off`, is not emailed: the sweep reads the current value. Test: Task 3.
3. **A booking under `off` still succeeds.** It answers 201 and creates the student's `booking_confirmed`. Only the teacher row is absent. Test: Task 4.
4. **A preferences-only PUT leaves the profile alone.** A body with only preference fields leaves `firstName`, `pageSlug`, `defaultTimezone` and the rest unchanged. Test: Task 5.
5. **The radio group is reachable by role and label** (`getByRole('radio', { name })`) inside a group named by its legend. Editing after a save clears the saved notice. Test: Task 6.

---

## File structure

| File | Responsibility | Task |
|---|---|---|
| `prisma/schema.prisma` | enum `TeacherBookingNotifications` + three `Teacher` columns | 1 |
| `prisma/migrations/20261001120000_teacher_notification_prefs/migration.sql` | the DDL | 1 |
| `src/services/notification-policy.ts` | `TeacherNotificationType`, `TeacherNotificationPrefs`, `TEACHER_EMAIL_POLICY`, `isTeacherNotificationType`, `shouldEmailTeacher` | 1 |
| `src/services/notification-policy.test.ts` | unit tests for the above | 1 |
| `src/services/notifications.ts` | `CreateNotificationInput` becomes a discriminated union | 2 |
| `src/app/api/registrations/[id]/route.ts` | `CancellationNoticeInput` rebuilt on the student variant | 2 |
| `src/services/email-fallback.ts` | teacher branch consults `shouldEmailTeacher` | 3 |
| `src/services/email-fallback.consent.test.ts` | a teacher-prefs `describe` block (already in `SERIAL_TESTS`) | 3 |
| `src/app/api/registrations/route.ts` | omits the teacher row when `bookingNotifications = off` | 4 |
| `tests/integration/registrations-api.test.ts` | booking × preference tests | 4 |
| `src/lib/schemas.ts` | three optional fields on `updateTeacherSchema` | 5 |
| `src/services/gdpr.ts` | teacher export carries the three preferences | 5 |
| `tests/integration/teachers-api.test.ts` | PUT round-trip, validation, ownership | 5 |
| `src/components/settings/notification-prefs-form.tsx` (new) | client form | 6 |
| `src/components/settings/notification-prefs-form.test.tsx` (new) | component tests | 6 |
| `src/app/(teacher)/settings/notifications/page.tsx` (new) | server page | 6 |
| `src/app/(teacher)/settings/page.tsx` | `Notifications` row | 6 |
| docs (spec §9) | see each task | 1, 3, 6 |

**Task order is load-bearing.**
- Task 1 must land first: Tasks 2 to 6 import its type and table.
- Task 2 must precede Task 3: the sweep's narrowing guard is only sound once the creation path is typed.
- Task 5 must precede Task 6: the form's compile pin reads `updateTeacherSchema`.
- Tasks 3, 4 and 5 are independent of each other.

---

### Task 1: Schema, migration, and the teacher email policy

**Files:**
- Modify: `prisma/schema.prisma` (the `ReminderPref` enum block near the top; `model Teacher`)
- Create: `prisma/migrations/20261001120000_teacher_notification_prefs/migration.sql`
- Modify: `src/services/notification-policy.ts`
- Test: `src/services/notification-policy.test.ts`
- Modify: `docs/data-model.md` (Teacher table)

**Interfaces — Produces:**
```ts
// src/services/notification-policy.ts
import type { NotificationType, TeacherBookingNotifications } from '@prisma/client';
export type TeacherNotificationType =
  'booking_confirmed' | 'class_cancelled' | 'payment_request' | 'teacher_invitation';
export interface TeacherNotificationPrefs {
  bookingNotifications: TeacherBookingNotifications;
  emailOnClassCompleted: boolean;
  emailOnInvitation: boolean;
}
export function isTeacherNotificationType(type: NotificationType): type is TeacherNotificationType;
export function shouldEmailTeacher(type: TeacherNotificationType, prefs: TeacherNotificationPrefs): boolean;
```

- [ ] **Step 1: Schema.** Add after `enum StudentReminderPref`:

```prisma
enum TeacherBookingNotifications {
  inbox_and_email
  inbox_only
  off
}
```

and in `model Teacher`, after `defaultReminder`:

```prisma
  bookingNotifications  TeacherBookingNotifications @default(inbox_and_email)
  emailOnClassCompleted Boolean                     @default(true)
  emailOnInvitation     Boolean                     @default(true)
```

- [ ] **Step 2: Migration.** Run the `migrate diff` command from Global Constraints. Write its output to the migration file above, prefixed with one comment line: `-- Teacher-side notification preferences: an inbox/email choice for new bookings and two email toggles.` Apply it with `pnpm exec prisma migrate deploy`, then `pnpm exec prisma generate`. Confirm the migration is up to date with `pnpm exec prisma migrate status`.

- [ ] **Step 3: Write the failing unit tests.** Add to `src/services/notification-policy.test.ts`, extending its existing imports:

```ts
import {
  shouldEmailTeacher,
  isTeacherNotificationType,
  type TeacherNotificationPrefs,
} from './notification-policy';

const ALL_ON: TeacherNotificationPrefs = {
  bookingNotifications: 'inbox_and_email',
  emailOnClassCompleted: true,
  emailOnInvitation: true,
};
const ALL_OFF: TeacherNotificationPrefs = {
  bookingNotifications: 'off',
  emailOnClassCompleted: false,
  emailOnInvitation: false,
};

describe('shouldEmailTeacher', () => {
  it('always emails an auto-cancel, whatever the preferences', () => {
    expect(shouldEmailTeacher('class_cancelled', ALL_OFF)).toBe(true);
    expect(shouldEmailTeacher('class_cancelled', ALL_ON)).toBe(true);
  });

  // Each case flips ONLY the column it names, with every other column at the
  // value that would make the answer `true`. A function reading the wrong
  // column therefore answers true where false is expected.
  it.each([
    ['inbox_and_email', true],
    ['inbox_only', false],
    ['off', false],
  ] as const)('booking_confirmed with bookingNotifications=%s emails: %s', (value, expected) => {
    expect(shouldEmailTeacher('booking_confirmed', { ...ALL_ON, bookingNotifications: value })).toBe(expected);
  });

  it('payment_request follows emailOnClassCompleted only', () => {
    expect(shouldEmailTeacher('payment_request', { ...ALL_ON, emailOnClassCompleted: false })).toBe(false);
    expect(shouldEmailTeacher('payment_request', { ...ALL_OFF, emailOnClassCompleted: true })).toBe(true);
  });

  it('teacher_invitation follows emailOnInvitation only', () => {
    expect(shouldEmailTeacher('teacher_invitation', { ...ALL_ON, emailOnInvitation: false })).toBe(false);
    expect(shouldEmailTeacher('teacher_invitation', { ...ALL_OFF, emailOnInvitation: true })).toBe(true);
  });
});

describe('isTeacherNotificationType', () => {
  it('accepts every type a teacher can receive', () => {
    for (const t of ['booking_confirmed', 'class_cancelled', 'payment_request', 'teacher_invitation'] as const) {
      expect(isTeacherNotificationType(t)).toBe(true);
    }
  });

  it('rejects student-only types', () => {
    expect(isTeacherNotificationType('announcement')).toBe(false);
    expect(isTeacherNotificationType('walk_in_added')).toBe(false);
  });
});
```

- [ ] **Step 4: Run and see them fail.** Run `pnpm exec vitest run --project unit src/services/notification-policy.test.ts`. Expected: FAIL, because `shouldEmailTeacher` / `isTeacherNotificationType` are not exported.

- [ ] **Step 5: Implement.** Append to `src/services/notification-policy.ts`, adding `TeacherBookingNotifications` to its `@prisma/client` type import:

```ts
/**
 * What a teacher recipient can be sent. `CreateNotificationInput`'s teacher
 * variant (`notifications.ts`) accepts only these, so a new teacher
 * notification cannot be written until it joins this union — and joining it
 * fails `TEACHER_EMAIL_POLICY`'s `satisfies` until it is classified there.
 */
export type TeacherNotificationType =
  | 'booking_confirmed'
  | 'class_cancelled'
  | 'payment_request'
  | 'teacher_invitation';

export interface TeacherNotificationPrefs {
  bookingNotifications: TeacherBookingNotifications;
  emailOnClassCompleted: boolean;
  emailOnInvitation: boolean;
}

/**
 * The teacher's own counterpart to `ESSENTIAL_NOTIFICATION_TYPES`, kept apart
 * because essentiality depends on the recipient: `payment_request` is a debt
 * to a student but a summary to a teacher. `class_cancelled` here is the
 * auto-cancel — the system ended the teacher's class without them, so it
 * ignores every preference.
 */
const TEACHER_EMAIL_POLICY = {
  class_cancelled: () => true,
  booking_confirmed: (p) => p.bookingNotifications === 'inbox_and_email',
  payment_request: (p) => p.emailOnClassCompleted,
  teacher_invitation: (p) => p.emailOnInvitation,
} satisfies Record<TeacherNotificationType, (prefs: TeacherNotificationPrefs) => boolean>;

export function isTeacherNotificationType(type: NotificationType): type is TeacherNotificationType {
  return Object.hasOwn(TEACHER_EMAIL_POLICY, type);
}

export function shouldEmailTeacher(
  type: TeacherNotificationType,
  prefs: TeacherNotificationPrefs,
): boolean {
  return TEACHER_EMAIL_POLICY[type](prefs);
}
```

If `satisfies` leaves the arrow parameters implicitly `any` under this TS version, annotate each `(p: TeacherNotificationPrefs)` and keep the `satisfies`.

- [ ] **Step 6: Run and see them pass.** Same command. Expected: PASS.

- [ ] **Step 7: Prove the tether bites.** Make each mutation, run `pnpm run typecheck`, record the exact error text in the task report, then restore:
  1. Delete the `teacher_invitation:` entry. Expected: TS1360-style "does not satisfy … Property 'teacher_invitation' is missing".
  2. Add `| 'announcement'` to `TeacherNotificationType`. Expected: the same `satisfies` error, naming `announcement`.
  3. Change `booking_confirmed`'s predicate to `p.bookingNotifications !== 'off'`. Expected: the `inbox_only` unit case FAILS.

  After restoring, `git diff --stat` must show only the intended edits.

- [ ] **Step 8: Docs.** In `docs/data-model.md`'s Teacher table, add after the `default_reminder` row:

```
| booking_notifications | enum: inbox_and_email, inbox_only, off | New-booking notification: inbox and fallback email, inbox only, or none |
| email_on_class_completed | boolean, default true | Fallback email for the class-completed summary |
| email_on_invitation | boolean, default true | Fallback email for an invitation from another teacher |
```

- [ ] **Step 9: Commit.** Stage `prisma/schema.prisma`, the migration directory, `src/services/notification-policy.ts`, `src/services/notification-policy.test.ts` and `docs/data-model.md`. Message: `feat: teacher notification preference columns and email policy (#49)`.

---

### Task 2: Tie teacher notifications to the policy's type

**Files:**
- Modify: `src/services/notifications.ts` (`CreateNotificationInput`, about line 34)
- Modify: `src/app/api/registrations/[id]/route.ts` (`CancellationNoticeInput`, about line 454)
- Modify: any call site the compiler then flags (expected: `as const` additions only)

**Interfaces:**
- **Consumes:** `TeacherNotificationType` (Task 1).
- **Produces:**

```ts
interface NotificationFields { recipientId: string; title: string; body: string; relatedClassId?: string }
export type CreateNotificationInput =
  | (NotificationFields & { recipientType: 'teacher'; type: TeacherNotificationType })
  | (NotificationFields & { recipientType: 'student'; type: NotificationType });
```

This task changes no runtime behaviour. Its test is the compiler, and its guard is proved by mutation.

- [ ] **Step 1: Replace the interface** in `notifications.ts` with the union above. Import `TeacherNotificationType` as a type from `./notification-policy`. The `RecipientType` import may become unused; remove it if so. Then fix the comment on `recipientType`: it names the variants, so state that the teacher variant accepts only `TeacherNotificationType` and why (one line, pointing at `TEACHER_EMAIL_POLICY`).

- [ ] **Step 2: Run `pnpm run typecheck`.** Expected errors:
  - `notifyCancellation` (`registrations/[id]/route.ts`). `Omit` flattens the union into a shape that fits neither variant, so its `createNotification` call is TS2345.
  - Possibly some `.map(...)` builders whose `recipientType` literal widened to `string`.

- [ ] **Step 3: Fix `CancellationNoticeInput`.** Rebuild it on the student variant:

```ts
type StudentNotificationInput = Extract<CreateNotificationInput, { recipientType: 'student' }>;
type CancellationNoticeInput = Omit<StudentNotificationInput, 'body' | 'relatedClassId'> & {
  // …existing extra fields unchanged…
};
```

Every caller already passes `'student'`, so nothing else changes. If its docblock mentions which recipients it serves, make it say student.

- [ ] **Step 4: Fix any widened literals** by adding `as const` to the literal (`recipientType: 'student' as const`), the idiom `class-lifecycle.ts` and `gdpr.ts` already use. **Never** fix one by annotating with a wider type or by casting the object.

- [ ] **Step 5: Run `pnpm run typecheck` and `pnpm run lint`.** Expected: clean.

- [ ] **Step 6: Prove the tether bites at the creation site.** Make each mutation, run `pnpm run typecheck`, record the exact error, then restore:
  1. In `class-transitions.ts`'s teacher auto-cancel notification, change `type: 'class_cancelled'` to `type: 'announcement'`. Expected: "Type '"announcement"' is not assignable to type 'TeacherNotificationType'" (or the union-level equivalent).
  2. In `api/registrations/route.ts`'s teacher entry, cast the type: `type: 'announcement' as NotificationType`. Expected: TS2345, because the object's `recipientType: 'teacher'` literal still selects the teacher variant. Then cast the whole object alone (`{ … } as CreateNotificationInput`). Expected: TS2352. Then apply both casts together (or `as unknown as CreateNotificationInput`). Expected: **compiles**. Record all three. The last is the hole spec §4 names, and it is why Global Constraints bans the casts. A reviewer catches it; the compiler does not.

  Finish with `git status` clean apart from this task's intended edits.

- [ ] **Step 7: Run the unit tier** with `pnpm exec vitest run --project unit`. Expected: PASS. Nothing behavioural changed.

- [ ] **Step 8: Commit** `src/services/notifications.ts`, `'src/app/api/registrations/[id]/route.ts'`, and each `as const` file. Message: `refactor: teacher notifications accept only TeacherNotificationType (#49)`.

---

### Task 3: The fallback sweep honours teacher preferences

**Files:**
- Modify: `src/services/email-fallback.ts` (teacher branch, about lines 149-203)
- Test: `src/services/email-fallback.consent.test.ts` (new `describe` block; the file is already in `SERIAL_TESTS`)
- Modify: `docs/data-model.md` (the paragraph beginning "The teacher branch consults no email preference")
- Modify: `CLAUDE.md` (Communication, layer 3)

**Interfaces — Consumes:** `shouldEmailTeacher`, `isTeacherNotificationType`, `TeacherNotificationPrefs` (Task 1).

- [ ] **Step 1: Write the failing tests.** Append a second `describe` to `email-fallback.consent.test.ts`. It reuses the file's `sendMock`, `vi.mock('resend')` and `prisma`. Add `vi.mock('@/lib/log', …)` only if the file does not already mock it. If it doesn't, use the shape from `src/services/invitations.gate.test.ts`, and import `log` to assert on `log.warn`.

```ts
describe('processEmailFallback — teacher preferences (#49)', () => {
  const sfx = `${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const teacherEmail = `prefs-teacher-${sfx}@test.local`;
  let teacherId: string;
  let dualStudentId: string;
  const ids: string[] = [];

  async function note(type: 'booking_confirmed' | 'class_cancelled' | 'payment_request' | 'teacher_invitation' | 'announcement') {
    const n = await prisma.notification.create({
      data: {
        recipientType: 'teacher', recipientId: teacherId, type,
        title: 'Prefs test', body: 'Prefs test body', isRead: false, emailSent: false,
        createdAt: new Date(Date.now() - 45 * 60 * 1000),
      },
    });
    ids.push(n.id);
    return n;
  }

  async function setPrefs(data: {
    bookingNotifications?: 'inbox_and_email' | 'inbox_only' | 'off';
    emailOnClassCompleted?: boolean;
    emailOnInvitation?: boolean;
  }) {
    await prisma.teacher.update({ where: { id: teacherId }, data });
  }

  beforeAll(async () => {
    process.env.RESEND_API_KEY = 're_test_dummy';
    delete process.env.EMAIL_DRY_RUN;
    const t = await prisma.teacher.create({
      data: {
        firstName: 'Prefs', lastName: 'Teacher', email: teacherEmail,
        account: { create: { email: teacherEmail } },
        bio: 'Teacher prefs tests', pageSlug: `prefs-teacher-${sfx}`, defaultTimezone: 'UTC',
      },
    });
    teacherId = t.id;
    // Review Focus 1: the same account wears a student hat that has opted out.
    const s = await prisma.student.create({
      data: { firstName: 'Prefs', lastName: 'Dual', email: teacherEmail, emailNotifications: false, accountId: t.accountId },
    });
    dualStudentId = s.id;
  });

  afterAll(async () => {
    if (ids.length) await prisma.notification.deleteMany({ where: { id: { in: ids } } });
    if (dualStudentId) await prisma.student.delete({ where: { id: dualStudentId } });
    if (teacherId) await prisma.teacher.delete({ where: { id: teacherId } });
  });

  beforeEach(async () => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({ error: null });
    await setPrefs({ bookingNotifications: 'inbox_and_email', emailOnClassCompleted: true, emailOnInvitation: true });
  });

  it('emails every teacher type by default, despite the student hat having opted out', async () => {
    for (const t of ['booking_confirmed', 'payment_request', 'teacher_invitation'] as const) await note(t);
    await processEmailFallback(prisma);
    expect(sendsTo(teacherEmail)).toBe(3);
  });

  it.each([
    ['booking_confirmed', { bookingNotifications: 'inbox_only' }],
    ['booking_confirmed', { bookingNotifications: 'off' }],
    ['payment_request', { emailOnClassCompleted: false }],
    ['teacher_invitation', { emailOnInvitation: false }],
  ] as const)('skips %s when %o, and marks it sent', async (type, prefs) => {
    const n = await note(type); // created first: Review Focus 2, the preference changes after the row exists
    await setPrefs(prefs);
    await processEmailFallback(prisma);
    expect(sendsTo(teacherEmail)).toBe(0);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).emailSent).toBe(true);
  });

  it('always emails an auto-cancel, with every preference off', async () => {
    await setPrefs({ bookingNotifications: 'off', emailOnClassCompleted: false, emailOnInvitation: false });
    await note('class_cancelled');
    await processEmailFallback(prisma);
    expect(sendsTo(teacherEmail)).toBe(1);
  });

  it('fails open on a teacher row outside TeacherNotificationType: emailed, and warned', async () => {
    await setPrefs({ bookingNotifications: 'off', emailOnClassCompleted: false, emailOnInvitation: false });
    await note('announcement'); // only reachable by a direct write — the typed path refuses it
    await processEmailFallback(prisma);
    expect(sendsTo(teacherEmail)).toBe(1);
    expect(vi.mocked(log.warn)).toHaveBeenCalled();
  });
});
```

Adjust the `Student.create` to the schema's actual linkage field if it is not `accountId`, and check `prisma/schema.prisma` `model Student`. If the dual-hat student cannot share the address (unique constraint), give it its own address. The point is the shared account, not the shared email.

- [ ] **Step 2: Run and see them fail.** Run `pnpm exec vitest run --project unit-sweeps src/services/email-fallback.consent.test.ts`. Expected:
  - Every "skips" case FAILS with `sendsTo` = 1.
  - The fail-open test FAILS on `log.warn`.
  - The default and auto-cancel tests pass already.

- [ ] **Step 3: Implement.** In the teacher branch, keep the long comment above the read intact; it concerns `deletedAt`, not preferences. Replace the read:

```ts
      const teacher = await db.teacher.findUnique({
        where: { id: notification.recipientId },
        select: { email: true, bookingNotifications: true, emailOnClassCompleted: true, emailOnInvitation: true },
      });
      email = teacher?.email ?? null;
      if (teacher) {
        if (isTeacherNotificationType(notification.type)) {
          emailEnabled = shouldEmailTeacher(notification.type, teacher);
        } else {
          // Unreachable through `createNotification`'s teacher variant; a row
          // here came from a direct write. Emailed as before rather than
          // dropped, and logged so it is seen.
          log.warn(
            { notificationId: notification.id, type: notification.type },
            'teacher notification outside TeacherNotificationType',
          );
        }
      }
```

Import `shouldEmailTeacher` and `isTeacherNotificationType` alongside `shouldEmailStudent`.

- [ ] **Step 4: Run and see them pass.** Same command, then the whole file. Expected: PASS, the existing student cases included.

- [ ] **Step 5: Prove the guards bite.** For each mutation: apply it, run the file, record the failing test name and message, restore.
  1. `emailEnabled = shouldEmailTeacher(…)` becomes `emailEnabled = true`. Expected: every "skips" case fails.
  2. `select` loses `emailOnInvitation`. Expected: a typecheck error, recorded as the guard.
  3. The `else` branch's `log.warn` is deleted. Expected: the fail-open test fails.

  End with `git status` showing only the intended edits.

- [ ] **Step 6: Docs.**
  - **`docs/data-model.md`:** replace the whole paragraph beginning "**The teacher branch consults no email preference, because a teacher recipient has none.**", including its re-derivation block, with what is true now. The teacher branch reads `Teacher.bookingNotifications`, `emailOnClassCompleted` and `emailOnInvitation`, and decides through `shouldEmailTeacher` (`src/services/notification-policy.ts`). That policy table is keyed by `TeacherNotificationType`, which the creation path's teacher variant enforces. `class_cancelled` (auto-cancel) ignores every preference. A teacher row outside that type is emailed and logged. Then read the sentences that follow that paragraph, which mention keeping `teacher_invitation` out of the essential set "buys a teacher invitee nothing". Correct anything in that section that this change made false. Replace; do not annotate with "previously".
  - **`CLAUDE.md`, Communication item 3:** after "students can opt out of optional messages, essential booking messages always email", add "; teachers choose per event in Settings → Notifications, and an auto-cancel always emails".

- [ ] **Step 7: Commit** `src/services/email-fallback.ts`, `src/services/email-fallback.consent.test.ts`, `docs/data-model.md` and `CLAUDE.md`. Message: `feat: the email fallback honours teacher notification preferences (#49)`.

---

### Task 4: A new booking respects `bookingNotifications = off`

**Files:**
- Modify: `src/app/api/registrations/route.ts` (the `createBulkNotifications` call in the booking transaction, about line 411)
- Test: `tests/integration/registrations-api.test.ts`

**Interfaces — Consumes:** the `Teacher.bookingNotifications` column (Task 1).

- [ ] **Step 1: Write the failing tests.** Add a `describe` to `registrations-api.test.ts`. It uses the file's existing `makeClass`, `post`, `studentTokens`, `studentIds`, `ownerId` and `prisma`. `post(token, body)` returns the fetch `Response`. Check its signature near the top of the file.

```ts
describe('POST /api/registrations — teacher bookingNotifications (#49)', () => {
  afterEach(async () => {
    await prisma.teacher.update({ where: { id: ownerId }, data: { bookingNotifications: 'inbox_and_email' } });
  });

  async function bookUnder(pref: 'inbox_and_email' | 'inbox_only' | 'off') {
    await prisma.teacher.update({ where: { id: ownerId }, data: { bookingNotifications: pref } });
    const classId = await makeClass(5);
    const res = await post(studentTokens[0]!, { classId });
    expect(res.status).toBe(201); // Review Focus 3: the booking itself is never refused
    const rows = await prisma.notification.findMany({
      where: { relatedClassId: classId, type: 'booking_confirmed' },
      select: { recipientType: true },
    });
    return rows.map((r) => r.recipientType).sort();
  }

  it('off: the student is confirmed, the teacher gets no row', async () => {
    expect(await bookUnder('off')).toEqual(['student']);
  });

  it('inbox_only: both rows exist (email is the sweep’s decision, not this one)', async () => {
    expect(await bookUnder('inbox_only')).toEqual(['student', 'teacher']);
  });

  it('inbox_and_email: both rows exist', async () => {
    expect(await bookUnder('inbox_and_email')).toEqual(['student', 'teacher']);
  });
});
```

If `201` is not what a fresh booking answers in this file's other tests, use the status they assert. Check the first `POST /api/registrations` test. If the file's suite shares `ownerId` with parallel describes that count teacher notifications, run this describe last or give it its own teacher. Check whether the file runs serially (`describe.sequential` or file-level).

- [ ] **Step 2: Run and see them fail.** Run `pnpm exec vitest run --project integration tests/integration/registrations-api.test.ts -t "bookingNotifications"`. This needs `worktree:up`. Expected: the `off` case FAILS with `['student', 'teacher']`.

- [ ] **Step 3: Implement.** Immediately before the `createBulkNotifications` call, inside the transaction:

```ts
        // Unlocked: a preference changed mid-booking lands either side of
        // this read, and either answer is acceptable (spec §5).
        const { bookingNotifications } = await tx.teacher.findUniqueOrThrow({
          where: { id: cls.calendarEntry.teacherId },
          select: { bookingNotifications: true },
        });
```

and build the batch with the teacher entry only when `bookingNotifications !== 'off'`. Keep the student entry first, and keep both objects' content unchanged:

```ts
        await createBulkNotifications(tx, [
          { /* student entry, unchanged */ },
          ...(bookingNotifications === 'off'
            ? []
            : [{ /* teacher entry, unchanged */ }]),
        ]);
```

Update the "Layer 1+2" comment above it to say the teacher's heads-up is skipped when they turned new-booking notifications off.

- [ ] **Step 4: Run and see them pass.** Same command, then the whole file. Expected: PASS. The existing "tells only the student" test, which expects `['booking_confirmed']` for the teacher, still passes because the default is `inbox_and_email`.

- [ ] **Step 5: Prove the guard bites.**
  1. Change `=== 'off'` to `=== 'inbox_only'`. Expected: both the `off` and `inbox_only` cases fail.
  2. Remove the conditional so the teacher entry is always included. Expected: the `off` case fails.

  Warm the route (`curl` a GET on the worktree app's base URL) after each mutation before judging the result. `next dev` recompiles lazily. Restore, and confirm `git status` is clean apart from the intended edits.

- [ ] **Step 6: Commit** `src/app/api/registrations/route.ts` and `tests/integration/registrations-api.test.ts`. Message: `feat: a teacher can turn off new-booking notifications (#49)`.

---

### Task 5: The write path, and the GDPR export

**Files:**
- Modify: `src/lib/schemas.ts` (`updateTeacherSchema`, about line 282)
- Modify: `src/services/gdpr.ts` (`exportTeacherData`'s `profile`, about line 226)
- Test: `tests/integration/teachers-api.test.ts`
- Test: `src/services/gdpr.test.ts` (the `exportTeacherData` cases, about line 3244)

**Interfaces — Produces:** `z.infer<typeof updateTeacherSchema>` gains `bookingNotifications?: TeacherBookingNotifications`, `emailOnClassCompleted?: boolean` and `emailOnInvitation?: boolean`. Task 6's form pins against this.

- [ ] **Step 1: Write the failing integration tests.** Add these inside `describe('PUT /api/teachers/[id]')` in `teachers-api.test.ts`, using its `putTeacher`, `teacherId`, `teacherToken` and `otherTeacherId`:

```ts
  it('round-trips the notification preferences without touching the profile (#49)', async () => {
    const before = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    const res = await putTeacher(teacherId, {
      bookingNotifications: 'inbox_only',
      emailOnClassCompleted: false,
      emailOnInvitation: false,
    }, teacherToken);
    expect(res.status).toBe(200);
    const after = await prisma.teacher.findUniqueOrThrow({ where: { id: teacherId } });
    expect(after.bookingNotifications).toBe('inbox_only');
    expect(after.emailOnClassCompleted).toBe(false);
    expect(after.emailOnInvitation).toBe(false);
    // Review Focus 4
    expect({ ...after, bookingNotifications: before.bookingNotifications, emailOnClassCompleted: before.emailOnClassCompleted, emailOnInvitation: before.emailOnInvitation, updatedAt: before.updatedAt })
      .toEqual(before);
  });

  it('refuses an unknown bookingNotifications value (#49)', async () => {
    const res = await putTeacher(teacherId, { bookingNotifications: 'sometimes' }, teacherToken);
    expect(res.status).toBe(400);
  });

  it('refuses a non-boolean email toggle (#49)', async () => {
    const res = await putTeacher(teacherId, { emailOnInvitation: 'no' }, teacherToken);
    expect(res.status).toBe(400);
  });

  it('refuses another teacher writing these preferences (#49)', async () => {
    const res = await putTeacher(otherTeacherId, { bookingNotifications: 'off' }, teacherToken);
    expect(res.status).toBe(403);
    const other = await prisma.teacher.findUniqueOrThrow({ where: { id: otherTeacherId } });
    expect(other.bookingNotifications).toBe('inbox_and_email');
  });
```

If `Teacher` has no `updatedAt`, drop that key from the spread. Restore the test teacher's preferences in `afterAll` only if a later test in the file depends on the defaults.

- [ ] **Step 2: Write the failing export assertion.** In `gdpr.test.ts`, extend an existing `exportTeacherData` case:

```ts
    expect(exported.profile).toMatchObject({
      bookingNotifications: 'inbox_and_email',
      emailOnClassCompleted: true,
      emailOnInvitation: true,
    });
```

- [ ] **Step 3: Run and see them fail.** Run `pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts` and `pnpm exec vitest run --project unit src/services/gdpr.test.ts -t exportTeacherData`. Expected:
  - The round-trip test FAILS with a 400: `.strict()` refuses the keys it doesn't know yet.
  - The gdpr assertion FAILS.
  - The three refusal tests (unknown value, non-boolean, other teacher) **already pass**, for the wrong reason: an unknown key, or the ownership check that runs first. Passing before the change proves nothing about them. Step 6's mutations are what prove them.

- [ ] **Step 4: Implement.** In `updateTeacherSchema`, after `defaultReminder`:

```ts
  bookingNotifications: z.enum(TeacherBookingNotifications).optional(),
  emailOnClassCompleted: z.boolean().optional(),
  emailOnInvitation: z.boolean().optional(),
```

with `import { TeacherBookingNotifications } from '@prisma/client'` as a **value** import. That is the `z.enum(OnboardingStep)` pattern already in this file, so no second list of values exists. In `exportTeacherData`'s `profile`, after `defaultTimezone`, add the three fields from `teacher`. The route needs no change.

- [ ] **Step 5: Run and see them pass.** Same commands. Expected: PASS.

- [ ] **Step 6: Prove the guards bite.**
  1. Change `z.enum(TeacherBookingNotifications)` to `z.string()`. Expected: the unknown-value test fails, with a 500 or 200 instead of a 400.
  2. Remove the export line for `emailOnInvitation`. Expected: the gdpr assertion fails.

  Restore, then run `git status`.

- [ ] **Step 7: Commit** `src/lib/schemas.ts`, `src/services/gdpr.ts`, `src/services/gdpr.test.ts` and `tests/integration/teachers-api.test.ts`. Message: `feat: write and export teacher notification preferences (#49)`.

---

### Task 6: Settings → Notifications

**Files:**
- Create: `src/components/settings/notification-prefs-form.tsx`
- Create: `src/components/settings/notification-prefs-form.test.tsx`
- Create: `src/app/(teacher)/settings/notifications/page.tsx`
- Modify: `src/app/(teacher)/settings/page.tsx` (`SETTINGS_ITEMS`)
- Modify: `docs/teacher-screens.md` (9.4), `docs/information-architecture.md` (Settings → Notifications line)

**Interfaces:**
- **Consumes:** `updateTeacherSchema` (Task 5), `TeacherNotificationPrefs` (Task 1).
- **Produces:** `NotificationPrefsForm({ teacherId: string; initial: TeacherNotificationPrefs })`.

- [ ] **Step 1: Write the failing component tests.** Mirror `src/components/student/notifications-form.test.tsx`'s fetch-stub harness:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { NotificationPrefsForm } from './notification-prefs-form';
import type { TeacherNotificationPrefs } from '@/services/notification-policy';

const DEFAULTS: TeacherNotificationPrefs = {
  bookingNotifications: 'inbox_and_email',
  emailOnClassCompleted: true,
  emailOnInvitation: true,
};

describe('NotificationPrefsForm', () => {
  const fetchMock = vi.fn();
  afterEach(() => { fetchMock.mockReset(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  function stubFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> } = { ok: true, json: async () => ({}) }) {
    fetchMock.mockResolvedValue(response);
    vi.stubGlobal('fetch', fetchMock);
  }

  async function save() {
    fireEvent.click(screen.getByRole('button', { name: /save notifications/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, opts] = fetchMock.mock.calls[0] as [string, { method: string; body: string }];
    return { url, method: opts.method, body: JSON.parse(opts.body) as Record<string, unknown> };
  }

  it('renders the stored values', () => {
    render(<NotificationPrefsForm teacherId="t1" initial={{ bookingNotifications: 'inbox_only', emailOnClassCompleted: false, emailOnInvitation: true }} />);
    const group = screen.getByRole('group', { name: /new booking/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'In the inbox only' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /class-completed summary/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /invitation/i })).toBeChecked();
    expect(screen.getByText(/always emailed/i)).toBeInTheDocument();
  });

  it('sends exactly the three preference keys to the teacher route', async () => {
    stubFetch();
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /invitation/i }));
    const { url, method, body } = await save();
    expect(url).toBe('/api/teachers/t1');
    expect(method).toBe('PUT');
    expect(body).toEqual({ bookingNotifications: 'off', emailOnClassCompleted: true, emailOnInvitation: false });
  });

  it('clears the saved notice when edited after a save', async () => {
    stubFetch();
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} />);
    await save();
    await screen.findByText(/saved/i);
    fireEvent.click(screen.getByRole('radio', { name: 'In the inbox only' }));
    expect(screen.queryByText(/saved/i)).not.toBeInTheDocument();
  });

  it('shows the server’s error message', async () => {
    stubFetch({ ok: false, status: 400, json: async () => ({ error: 'Nope from server' }) });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<NotificationPrefsForm teacherId="t1" initial={DEFAULTS} />);
    await save();
    expect(await screen.findByText('Nope from server')).toBeInTheDocument();
  });
});
```

Match the saved-notice text and the error-body shape to what `readErrorMessage` (`src/lib/client-errors.ts`) and the student form's notice actually use. Read both before running.

- [ ] **Step 2: Run and see them fail.** Run `pnpm exec vitest run --project components src/components/settings/notification-prefs-form.test.tsx`. Expected: FAIL, because the module is not found.

- [ ] **Step 3: Implement the form.** Follow `src/components/student/notifications-form.tsx` in structure: the reverse compile pin, save state, error handling, `logRequestFailure`, and the save notice. It renders a `Button` labelled "Save notifications". Key parts:

```tsx
'use client';

import { useState } from 'react';
import type { z } from 'zod';
import type { TeacherBookingNotifications } from '@prisma/client';
import type { updateTeacherSchema } from '@/lib/schemas';
import type { TeacherNotificationPrefs } from '@/services/notification-policy';
import type { NoneOf } from '@/lib/type-pins';
import { Button } from '@/components/ui/button';
import { logRequestFailure, readErrorMessage } from '@/lib/client-errors';

type UpdateTeacherWire = z.infer<typeof updateTeacherSchema>;

/** Reverse pin: `updateTeacherSchema` is `.strict()`, so a key sent here that
 *  the schema dropped would 400 at runtime; this fails at compile time instead. */
const _formHasNoExtras: NoneOf<Exclude<keyof TeacherNotificationPrefs, keyof UpdateTeacherWire>> = true;
void _formHasNoExtras;

const BOOKING_OPTIONS = [
  { value: 'inbox_and_email', label: 'In the inbox, and emailed if I miss it' },
  { value: 'inbox_only', label: 'In the inbox only' },
  { value: 'off', label: 'Off' },
] as const satisfies ReadonlyArray<{ value: TeacherBookingNotifications; label: string }>;

type BookingOption = (typeof BOOKING_OPTIONS)[number]['value'];
const _offersEveryChoice: NoneOf<Exclude<TeacherBookingNotifications, BookingOption>> = true;
void _offersEveryChoice;
```

Mark-up, in this order (spec §7):
- A `<fieldset>` with `<legend className="type-subtitle">New booking</legend>`. Inside it, the three `<label className="flex items-center gap-3 min-h-12">` rows, each with an `<input type="radio" name="bookingNotifications" className="w-5 h-5 accent-teal">`. Then the caption `<p className="type-caption">`.
- The two checkbox rows, styled like the student form's checkbox.
- A plain `<section>`: `<h2 className="type-subtitle">Class auto-cancelled</h2>` and the "Always emailed" caption.

Every control's `onChange` sets its value and calls `setSaved(false)`. Only `onChange` for the radios is needed; native radios give keyboard arrow navigation within the group. Server-side props arrive as plain strings for the enum. If `initial.bookingNotifications` is typed `string` at the page boundary, narrow it with an `isBookingOption` guard reading `BOOKING_OPTIONS`, as the student form's `isReminderOption` does, rather than casting.

- [ ] **Step 4: Run and see them pass.** Same command. Expected: PASS.

- [ ] **Step 5: Page and index.** Create `src/app/(teacher)/settings/notifications/page.tsx`:

```tsx
import { prisma } from '@/lib/db';
import { requireTeacherSession } from '@/lib/session';
import { PageHeader } from '@/components/layout/page-header';
import { NotificationPrefsForm } from '@/components/settings/notification-prefs-form';

export default async function NotificationSettingsPage() {
  const session = await requireTeacherSession();
  const teacher = await prisma.teacher.findUniqueOrThrow({
    where: { id: session.teacherId },
    select: { id: true, bookingNotifications: true, emailOnClassCompleted: true, emailOnInvitation: true },
  });
  return (
    <>
      <PageHeader title="Notifications" backHref="/settings" backLabel="Settings" />
      <NotificationPrefsForm
        teacherId={teacher.id}
        initial={{
          bookingNotifications: teacher.bookingNotifications,
          emailOnClassCompleted: teacher.emailOnClassCompleted,
          emailOnInvitation: teacher.emailOnInvitation,
        }}
      />
    </>
  );
}
```

In `settings/page.tsx`, insert `{ href: '/settings/notifications', label: 'Notifications' }` before the `Profile` entry.

- [ ] **Step 6: Prove the pins bite.** For each mutation: apply it, run `pnpm run typecheck`, record the error, restore.
  1. Remove the `off` entry from `BOOKING_OPTIONS`. Expected: the `_offersEveryChoice` error.
  2. Rename `emailOnInvitation` in `updateTeacherSchema` to `emailOnInvite`. Expected: the `_formHasNoExtras` error.
  3. Make the form send `emailOnInvitation: !invitation` (a behavioural mutation). Expected: the "exactly the three keys" component test fails.

  Run `git status` afterwards.

- [ ] **Step 7: See it in the running app.** Using the `verify` skill's recipe against the worktree app:
  1. Sign in as a seeded teacher, open Settings → Notifications, choose "Off" and save.
  2. Reload: "Off" is still selected.
  3. Book that teacher's class as a seeded student: no "New booking" appears in the teacher inbox.
  4. Switch back to the default.

  Screenshot the page at 100% (390px wide), and judge spacing at actual size, not zoomed.

- [ ] **Step 8: Docs.**
  - **`docs/teacher-screens.md` 9.4:** replace the two bullets with what shipped. New booking: inbox and email / inbox only / off. Class completed and invitations: email on/off. Auto-cancel: always emailed.
  - **`docs/information-architecture.md`:** change the Settings tree's "Notifications → Per-event email on/off toggles" line to the same summary. Leave the tree's other entries alone; they are out of scope.

- [ ] **Step 9: Run the full check.** `pnpm run typecheck && pnpm run lint && pnpm exec vitest run --project components`. Expected: clean.

- [ ] **Step 10: Commit** the two component files, `'src/app/(teacher)/settings/notifications/page.tsx'`, `'src/app/(teacher)/settings/page.tsx'`, `docs/teacher-screens.md` and `docs/information-architecture.md`. Message: `feat: Settings → Notifications for teachers (#49)`.

---

## After the tasks

- **Whole-branch review** on the most capable model. There are six tasks, so this review runs. Cross-task risks for the reviewer:
  - Does `TeacherNotificationType` actually reach every teacher call site, or did Task 2 widen any?
  - Do the docs from Tasks 1, 3 and 6 agree with each other and with the code?
  - Is `inbox_only` treated identically in Task 3 (no email) and Task 4 (row created)?
- **Then:** `pnpm run verify` (with the worktree app up), `pnpm run build`, push, PR, and `/pr-review-toolkit:review-pr`.
- **The PR body:**
  - The premise census and its arithmetic (spec §1).
  - That #721 holds the reminder question and is unaffected.
  - The integration files touched, by path: `tests/integration/registrations-api.test.ts` and `tests/integration/teachers-api.test.ts`.
  - The mutation results recorded in each task.
