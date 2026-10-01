# Class reminders (#721) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send each student a reminder before every class they booked, and each
teacher a reminder before every regular class they teach. The recipient chooses
the timing and the channel (in the app, email, or both), and can turn reminders
off.

**Architecture:** A pure function turns `(class date, start time, teacher
timezone, timing)` into a reminder instant. A new 5-minute scheduler sweep,
`class-reminders`, finds due reminders and stamps each one at most once
(`Registration.classReminderSentAt` and `Class.teacherReminderSentAt`). In the
same transaction it writes the inbox row, which carries `emailSent = true` so
the unread-fallback sweep never picks it up. After the commit it sends the
email directly. Settings live on `Teacher` and `Student` as
`classReminder`/`classReminderChannel`. They are edited on teacher Settings →
Notifications and on the student `/account/notifications` page.

**Tech Stack:** Next.js 16 App Router, TypeScript strict, Prisma/PostgreSQL,
Vitest (`unit`, `unit-sweeps`, `components`, `integration` projects), Resend.

**Spec:** `docs/superpowers/specs/2026-10-01-class-reminders-design.md`. Read
it before any task. This plan argues from it.

## Global Constraints

- Enum `ReminderTiming { evening_before, morning_of, one_hour_before, off }` and enum `ReminderChannel { inbox, email, inbox_and_email }`. These names are exact.
- `Teacher.classReminder` and `Student.classReminder` both default to `morning_of`. `classReminderChannel` defaults to `inbox_and_email` on both.
- Student value mapping: `eve → evening_before`, `morning → morning_of`, `one_hour → one_hour_before`, `off → off`.
- Moments are taken in the teacher's `defaultTimezone`:
  - evening before = 19:00 on the day before;
  - morning of = 07:00;
  - one hour before = start − 60 min;
  - every moment is capped at start − 60 min.
- A reminder is due when `moment ≤ now < start`, its stamp is null, and the registration or class predates the moment (`registeredAt < moment`, or `Class.createdAt < moment`).
- New `NotificationType` member `class_reminder`. The payment `reminder` type is untouched.
- A reminder is never emailed by `processEmailFallback`, and a failed reminder email is logged at `error` and not retried.
- `Student.emailNotifications` does not govern class reminders.
- Teacher scope is regular `Class` rows only (status `open`, entry not cancelled). Studio classes get no reminder.
- CLAUDE.md *Comment Discipline* applies to every comment written here:
  - no counts or member rosters in comments;
  - no "previously" history;
  - no claims about another module.
- Error responses keep the project rules. Tests never assert a literal `error.message` from the API (the `plan-test-code-must-pass-project-rules` memory).
- Migrations are created with `prisma migrate dev`. From an agent shell that refuses it, use the diff-and-deploy workaround in Task 1. Never edit an applied migration.
- Stage exact paths. Never use `git add -A`. Quote paths that contain parentheses.

## Review Focus

1. **A rebooked student, cancelled and then rebooked or promoted.** They must be reminded if the rebooking predates the moment, and must not be if it follows it. Pinned in Task 4, `waitlist.test.ts`.
2. **A class early in the morning (06:30) with `morning_of`.** The reminder must arrive at 05:30, before the class, never after start. Pinned in Task 2 and Task 4.
3. **A DST transition day in Europe/Amsterdam.** `evening_before` and `morning_of` must land at 19:00 and 07:00 local time on both the spring and autumn transition days. Pinned in Task 2.
4. **A reminder row left unread for 30 minutes.** The fallback sweep must not email it, or email it a second time. Pinned in Task 4, `email-fallback.test.ts`.
5. **A teacher who sets timing to Off and then back on.** The channel they had chosen must survive. Pinned in Task 5, component test.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `prisma/schema.prisma` | enums, renamed/new columns, stamps, `class_reminder` | 1 |
| `prisma/migrations/<ts>_notification_type_class_reminder/migration.sql` | `ADD VALUE` alone | 1 |
| `prisma/migrations/<ts>_class_reminders/migration.sql` | enum merge, renames, columns | 1 |
| `src/lib/schemas.ts` | teacher + student zod fields | 1 |
| `src/services/notification-policy.ts` | `TeacherNotificationType`/`Prefs` gain the reminder | 1 |
| `src/services/email-fallback.ts` | teacher `select` grows | 1 |
| `src/lib/notification-retention.ts`, `src/lib/email-templates.ts` | exhaustive maps gain `class_reminder` | 1 |
| `src/services/gdpr.ts` | both exports carry both fields | 1 |
| `prisma/seed.ts`, `tests/integration/tier-selected-at.test.ts` | renamed values | 1 |
| profile + student form/page files | mechanical rename only (UI redesign is Task 5) | 1 |
| `src/lib/reminder-moment.ts` (+ test) | pure moment function | 2 |
| `src/lib/email.ts`, `src/lib/email-templates.ts`, `src/services/notifications.ts` | `sendHtmlEmail`, email footer, `emailSent` input | 3 |
| `src/services/class-reminders.ts` (+ test) | the sweep | 4 |
| `src/services/waitlist.ts` (+ test) | reactivation resets | 4 |
| `src/lib/scheduler.ts` (+ test), `src/app/api/cron/class-reminders/route.ts`, `vitest.tiers.ts` | wiring | 4 |
| `src/components/settings/notification-prefs-form.tsx`, `src/app/(teacher)/settings/notifications/page.tsx`, `src/components/settings/profile-form.tsx`, `src/app/(teacher)/settings/profile/page.tsx`, `src/components/student/notifications-form.tsx`, `src/app/(student)/account/notifications/page.tsx` (+ tests) | UI | 5 |
| `docs/data-model.md`, `docs/visual/data-model.html`, `docs/product-concept.md`, `docs/technical-architecture.md`, `DEPLOYMENT.md`, `CLAUDE.md` | docs | the task whose change they describe |

**Task order is load-bearing.**
- Task 1 must land first, because every later task compiles against its enums and columns.
- Task 2 and Task 3 are independent of each other.
- Task 4 needs 1, 2 and 3.
- Task 5 needs 1. It runs last, so that its docs describe the finished behaviour.

---

### Task 1: Data model, migration, and the mechanical rename

The whole tree must compile and pass tests at the end of this task. The user-visible behaviour is unchanged, apart from the renamed values the existing selects send.

**Files:**
- Modify: `prisma/schema.prisma`
- Create: two migration folders (below)
- Modify: `src/lib/schemas.ts:282-295` and `:373-388`
- Modify: `src/services/notification-policy.ts`, `src/services/notification-policy.test.ts`
- Modify: `src/services/email-fallback.ts:199-216`
- Modify: `src/lib/notification-retention.ts`, `src/lib/email-templates.ts` (`STUDENT_INTROS`, `TEACHER_INTROS`, `STUDENT_ACTION_LINKS`, `TEACHER_ACTION_LINKS`)
- Modify: `src/services/gdpr.ts:128-139` and `:226-240`, `src/services/gdpr.test.ts`
- Modify: `prisma/seed.ts`, `tests/integration/tier-selected-at.test.ts:176`
- Modify: `src/components/settings/profile-form.tsx`, `src/components/settings/profile-form.test.tsx`, `src/app/(teacher)/settings/profile/page.tsx`
- Modify: `src/components/student/notifications-form.tsx`, `src/components/student/notifications-form.test.tsx`, `src/app/(student)/account/notifications/page.tsx`
- Modify: `src/components/settings/notification-prefs-form.tsx` (payload and initial only), `src/app/(teacher)/settings/notifications/page.tsx`, `src/components/settings/notification-prefs-form.test.tsx`
- Modify: `docs/data-model.md`, `docs/visual/data-model.html`

**Interfaces:**
- Produces:
  - `ReminderTiming` and `ReminderChannel` from `@prisma/client`.
  - The columns `Teacher.classReminder`, `Teacher.classReminderChannel`, `Student.classReminder`, `Student.classReminderChannel`, `Registration.classReminderSentAt`, `Class.teacherReminderSentAt`.
  - The `NotificationType` member `'class_reminder'`.
  - `TeacherNotificationType`, which now includes `'class_reminder'`.
  - `TeacherNotificationPrefs`, which now includes `classReminder: ReminderTiming; classReminderChannel: ReminderChannel`.

- [ ] **Step 1: Write the failing GDPR export tests**

In `src/services/gdpr.test.ts`, inside the `describe` that holds `'exports the teacher’s notification preferences as stored'`, add:

```ts
it('exports the teacher’s class reminder choice as stored (#721)', async () => {
  const teacherId = await makeTeacher();
  await prisma.teacher.update({
    where: { id: teacherId },
    data: { classReminder: 'one_hour_before', classReminderChannel: 'email' },
  });
  const exported = await exportTeacherData(prisma, teacherId);
  expect(exported.profile).toMatchObject({ classReminder: 'one_hour_before', classReminderChannel: 'email' });
});
```

Beside `'export contains profile, bookings, and payment state'`, add the student twin. Use that test's own fixture helper to create the student:

```ts
it('exports the student’s class reminder choice as stored (#721)', async () => {
  // create a student exactly as the neighbouring export test does, then:
  await prisma.student.update({
    where: { id: studentId },
    data: { classReminder: 'evening_before', classReminderChannel: 'inbox' },
  });
  const exported = await exportStudentData(prisma, studentId);
  expect(exported.profile).toMatchObject({ classReminder: 'evening_before', classReminderChannel: 'inbox' });
});
```

Both values are non-default on purpose: a default value cannot tell a stored value from a fallback (memory: `fixture-equals-code-default`).

- [ ] **Step 2: Edit `prisma/schema.prisma`**

- Delete `enum ReminderPref` and `enum StudentReminderPref`. Add:

```prisma
enum ReminderTiming {
  evening_before
  morning_of
  one_hour_before
  off
}

enum ReminderChannel {
  inbox
  email
  inbox_and_email
}
```

- In `enum NotificationType`, add `class_reminder` after `walk_in_added`.
- In `model Teacher`, replace `defaultReminder ReminderPref @default(morning_of)` with:

```prisma
  classReminder         ReminderTiming              @default(morning_of)
  classReminderChannel  ReminderChannel             @default(inbox_and_email)
```

- In `model Student`, replace `reminderPref StudentReminderPref @default(morning)` with:

```prisma
  classReminder        ReminderTiming  @default(morning_of)
  classReminderChannel ReminderChannel @default(inbox_and_email)
```

- In `model Registration`, after `cancelledAt`, add:

```prisma
  /// Set once when this booking's class reminder is sent; cleared when the row
  /// is reactivated as a new booking (`activateRegistration`).
  classReminderSentAt DateTime?
```

- In `model Class`, after `spotBroadcastAt`, add:

```prisma
  /// Set once when the teacher's class reminder for this class is sent.
  teacherReminderSentAt DateTime?
```

- [ ] **Step 3: Write the migrations**

This needs two migrations, because a value added with `ALTER TYPE … ADD VALUE` is better kept in its own migration. The precedent is `20260925062847_notification_type_walk_in_added`.

First, try `pnpm exec prisma migrate dev --name notification_type_class_reminder` with only the `NotificationType` edit applied. If the shell refuses because it is non-interactive (memory: `migrations-from-agent-shell`), hand-author the migrations instead. Use timestamps after `20261001120000`:

`prisma/migrations/20261001130000_notification_type_class_reminder/migration.sql`:

```sql
-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'class_reminder';
```

`prisma/migrations/20261001130100_class_reminders/migration.sql`:

```sql
-- CreateEnum
CREATE TYPE "ReminderTiming" AS ENUM ('evening_before', 'morning_of', 'one_hour_before', 'off');

-- CreateEnum
CREATE TYPE "ReminderChannel" AS ENUM ('inbox', 'email', 'inbox_and_email');

-- Teacher: rename and retype; every old value exists in the new enum.
ALTER TABLE "Teacher" RENAME COLUMN "defaultReminder" TO "classReminder";
ALTER TABLE "Teacher" ALTER COLUMN "classReminder" DROP DEFAULT;
ALTER TABLE "Teacher" ALTER COLUMN "classReminder" TYPE "ReminderTiming"
  USING ("classReminder"::text::"ReminderTiming");
ALTER TABLE "Teacher" ALTER COLUMN "classReminder" SET DEFAULT 'morning_of';
ALTER TABLE "Teacher" ADD COLUMN "classReminderChannel" "ReminderChannel" NOT NULL DEFAULT 'inbox_and_email';

-- Student: rename and retype through an explicit value map, with no ELSE, so an
-- unmapped value fails the NOT NULL column instead of becoming a default.
ALTER TABLE "Student" RENAME COLUMN "reminderPref" TO "classReminder";
ALTER TABLE "Student" ALTER COLUMN "classReminder" DROP DEFAULT;
ALTER TABLE "Student" ALTER COLUMN "classReminder" TYPE "ReminderTiming"
  USING (CASE "classReminder"::text
           WHEN 'eve' THEN 'evening_before'
           WHEN 'morning' THEN 'morning_of'
           WHEN 'one_hour' THEN 'one_hour_before'
           WHEN 'off' THEN 'off'
         END)::"ReminderTiming";
ALTER TABLE "Student" ALTER COLUMN "classReminder" SET DEFAULT 'morning_of';
ALTER TABLE "Student" ADD COLUMN "classReminderChannel" "ReminderChannel" NOT NULL DEFAULT 'inbox_and_email';

-- DropEnum
DROP TYPE "ReminderPref";
DROP TYPE "StudentReminderPref";

-- AlterTable
ALTER TABLE "Registration" ADD COLUMN "classReminderSentAt" TIMESTAMP(3);
ALTER TABLE "Class" ADD COLUMN "teacherReminderSentAt" TIMESTAMP(3);
```

Apply with `pnpm exec prisma migrate deploy`, then `pnpm exec prisma generate`.

Check for drift with `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --script`, or with `pnpm run check-migrations`. Expected: an empty diff. If the default renders differently (for example `'morning_of'::"ReminderTiming"`), fix the hand-written SQL before committing. Once the migration is applied, it is immutable.

- [ ] **Step 4: Run typecheck to list every knock-on**

Run `pnpm run typecheck`. It is expected to fail. The errors name every site below. Work through them:

1. **`src/lib/schemas.ts`.**
   - Import `ReminderTiming, ReminderChannel` from `@prisma/client` beside `TeacherBookingNotifications`.
   - In `updateTeacherSchema`, replace the `defaultReminder` line with:

     ```ts
     classReminder: z.enum(ReminderTiming).optional(),
     classReminderChannel: z.enum(ReminderChannel).optional(),
     ```

   - In `updateStudentSchema`, replace the `reminderPref` line with the same two lines.

2. **`src/services/notification-policy.ts`.**
   - Import `ReminderTiming, ReminderChannel`.
   - Add `| 'class_reminder'` to `TeacherNotificationType`.
   - Add `classReminder: ReminderTiming; classReminderChannel: ReminderChannel;` to `TeacherNotificationPrefs`.
   - Add the entry `class_reminder: () => false,` to `TEACHER_EMAIL_POLICY`, with the one-line comment `// Sent directly by the class-reminder sweep at its moment, never as an unread fallback.`

3. **`src/services/notification-policy.test.ts`.**
   - Add `'class_reminder'` to the `isTeacherNotificationType` hand list.
   - Add `classReminder` and `classReminderChannel` to the `ALL_ON` and `ALL_OFF` fixtures. `ALL_ON` gets `'morning_of', 'inbox_and_email'`; `ALL_OFF` gets `'off', 'inbox'`.
   - Add a test:

     ```ts
     it('never emails a class reminder through the fallback, whatever the preferences (#721)', () => {
       expect(shouldEmailTeacher('class_reminder', ALL_ON)).toBe(false);
       expect(shouldEmailTeacher('class_reminder', ALL_OFF)).toBe(false);
     });
     ```

4. **`src/services/email-fallback.ts`.** Add `classReminder: true, classReminderChannel: true` to the teacher `select`.

5. **`src/lib/notification-retention.ts`.** Add `class_reminder: STANDARD_RETENTION_DAYS`.

6. **`src/lib/email-templates.ts`.**
   - Add `class_reminder: 'Your class is coming up.'` to `STUDENT_INTROS`.
   - Add `class_reminder: 'You have a class coming up.'` to `TEACHER_INTROS`.
   - Add `class_reminder: { label: STUDENT_BOOKINGS_LABEL, path: STUDENT_BOOKINGS_PATH }` to `STUDENT_ACTION_LINKS`.
   - Add `class_reminder: { label: 'Open your schedule', path: '/schedule' }` to `TEACHER_ACTION_LINKS`. If `src/lib/notification-links.ts` already exports a constant for `/schedule`, use it instead.

7. **`src/services/gdpr.ts`.**
   - In the student export, replace `reminderPref: student.reminderPref` with `classReminder: student.classReminder, classReminderChannel: student.classReminderChannel`.
   - In the teacher export, after `emailOnInvitation`, add `classReminder: teacher.classReminder, classReminderChannel: teacher.classReminderChannel`.
   - If the teacher query uses a `select`, add both columns to it.

8. **`prisma/seed.ts`.**
   - Rename every `defaultReminder:` to `classReminder:`.
   - Rename every `reminderPref:` to `classReminder:`, mapping the values: `'eve' → 'evening_before'`, `'morning' → 'morning_of'`, `'one_hour' → 'one_hour_before'`, `'off' → 'off'`.

9. **`tests/integration/tier-selected-at.test.ts:176`.** Change the body to `{ classReminder: 'morning_of' }`.

10. **Teacher profile.** Task 5 removes the select. Here, only keep it compiling:
    - in `profile-form.tsx`, rename `defaultReminder` to `classReminder` in `ProfileFormValues`, the payload and the `<Select>`;
    - in `profile/page.tsx`, read `teacher.classReminder`;
    - in `profile-form.test.tsx`, rename the fixture key.

    The `_formCoversSchema` pin now refuses `classReminder` in `ProfileFormValues`, because it is a key of `TeacherNotificationPrefs` and the forward pin excludes those. So delete the reminder from `ProfileFormValues`, the payload, the `REMINDER_OPTIONS` constant, the `<Select id="reminder">`, the page's `initial` line and the test fixture key **in this task**. This is the profile half of Task 5's move, done here because the compiler forces it.

11. **Teacher notifications form and page.** The `payload: TeacherNotificationPrefs` literal now needs both keys.
    - In `notification-prefs-form.tsx`, add `const [reminder] = useState(initial.classReminder); const [reminderChannel] = useState(initial.classReminderChannel);` and include both in `payload`. Task 5 adds the controls.
    - In `settings/notifications/page.tsx`, add both columns to the `select` and to `initial`.
    - In `notification-prefs-form.test.tsx`, the "sends exactly the … keys" test now expects the two extra keys at their `initial` values. Give the fixture non-default `initial` values (`'evening_before'`, `'inbox'`) and assert them.

12. **Student notifications form and page.**
    - In `notifications-form.tsx`, import `ReminderTiming` and remove `StudentReminderPref`.
    - Change `REMINDER_OPTIONS` values to `evening_before` / `morning_of` / `one_hour_before` / `off`. Labels are unchanged here; Task 5 rewrites them.
    - Retype `NotificationsBody` to `{ emailNotifications: boolean; classReminder: ReminderTiming }`.
    - Rename the prop `reminderPref` to `classReminder`.
    - Update the pins to `ReminderTiming`.
    - Delete the docblock comparing `StudentReminderPref` with `ReminderPref`; both enums are gone.
    - In `account/notifications/page.tsx`, select and pass `classReminder`.
    - In `notifications-form.test.tsx`, rename the keys and values throughout (`'morning' → 'morning_of'`, `'off'` unchanged).

13. **`docs/data-model.md`.**
    - Replace the Teacher `default_reminder` row with two rows:
      - `| class_reminder | enum: evening_before, morning_of, one_hour_before, off | When the teacher is reminded of each class they teach |`
      - `| class_reminder_channel | enum: inbox, email, inbox_and_email | How that reminder arrives |`
    - Replace the Student `reminder_pref` row with the same two rows, saying "each class they booked".
    - Add `class_reminder_sent_at | datetime, nullable | Set when this booking's reminder is sent; cleared on reactivation` to Registration.
    - Add `teacher_reminder_sent_at | datetime, nullable | Set when the teacher's reminder for this class is sent` to Class.
    - Add `class_reminder` to the Notification type list.
    - In the #49 paragraph, replace "`Teacher.defaultReminder` is class-reminder timing" with "`Teacher.classReminder` is the teacher's own class-reminder timing, sent directly rather than as a fallback".

14. **`docs/visual/data-model.html`.** Replace the `default_reminder` and `reminder_pref` field lines with the two new fields each.

- [ ] **Step 5: Run the checks**

Run:
- `pnpm run typecheck && pnpm run lint`
- `pnpm exec vitest run --project unit src/services/notification-policy.test.ts src/services/gdpr.test.ts src/lib/notification-retention.test.ts src/lib/email-templates.test.ts`
- `pnpm exec vitest run --project components src/components/settings src/components/student`

Expected: all PASS, and the two new GDPR tests PASS.

- [ ] **Step 6: Prove the export pins bite**

1. Temporarily delete `classReminderChannel: teacher.classReminderChannel` from the teacher export.
2. Run the gdpr test. Expected FAIL: `toMatchObject` reports the missing `classReminderChannel`. Record the exact text.
3. Restore the line, and re-run to PASS.
4. Repeat for the student export.
5. Confirm with `git status` that only the intended files are modified.

- [ ] **Step 7: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/20261001130000_notification_type_class_reminder prisma/migrations/20261001130100_class_reminders src/lib/schemas.ts src/services/notification-policy.ts src/services/notification-policy.test.ts src/services/email-fallback.ts src/lib/notification-retention.ts src/lib/email-templates.ts src/services/gdpr.ts src/services/gdpr.test.ts prisma/seed.ts tests/integration/tier-selected-at.test.ts src/components/settings/profile-form.tsx src/components/settings/profile-form.test.tsx "src/app/(teacher)/settings/profile/page.tsx" src/components/settings/notification-prefs-form.tsx src/components/settings/notification-prefs-form.test.tsx "src/app/(teacher)/settings/notifications/page.tsx" src/components/student/notifications-form.tsx src/components/student/notifications-form.test.tsx "src/app/(student)/account/notifications/page.tsx" docs/data-model.md docs/visual/data-model.html
git commit -m "feat: class reminder timing and channel on both profiles, one enum (#721)"
```

---

### Task 2: The reminder moment

**Files:**
- Create: `src/lib/reminder-moment.ts`
- Test: `src/lib/reminder-moment.test.ts` (`unit` project)

**Interfaces:**
- Consumes: `ReminderTiming` (Task 1), `classStartInstant` (`src/lib/timezone.ts`), `hhmmToTime` (`src/lib/time-of-day.ts`).
- Produces:
  - `export function reminderMoment(entry: { date: Date; startTime: Date }, timeZone: string, timing: ReminderTiming): Date | null`
  - `export const REMINDER_LATEST_LEAD_MINUTES = 60`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, it, expect } from 'vitest';
import { reminderMoment } from './reminder-moment';
import { hhmmToTime } from './time-of-day';

const AMS = 'Europe/Amsterdam';
const entry = (date: string, hhmm: string) => ({ date: new Date(`${date}T00:00:00Z`), startTime: hhmmToTime(hhmm) });

describe('reminderMoment', () => {
  it('evening before is 19:00 local on the previous day', () => {
    // 2026-06-10 is CEST (UTC+2): 19:00 local on the 9th = 17:00Z.
    expect(reminderMoment(entry('2026-06-10', '18:00'), AMS, 'evening_before')?.toISOString()).toBe('2026-06-09T17:00:00.000Z');
  });
  it('morning of is 07:00 local on the class day', () => {
    expect(reminderMoment(entry('2026-06-10', '18:00'), AMS, 'morning_of')?.toISOString()).toBe('2026-06-10T05:00:00.000Z');
  });
  it('one hour before is start − 60 minutes', () => {
    expect(reminderMoment(entry('2026-06-10', '18:00'), AMS, 'one_hour_before')?.toISOString()).toBe('2026-06-10T15:00:00.000Z');
  });
  it('caps an early class’s morning reminder at start − 60 minutes', () => {
    // 06:30 local start → 05:30 local = 03:30Z, not 07:00 local.
    expect(reminderMoment(entry('2026-06-10', '06:30'), AMS, 'morning_of')?.toISOString()).toBe('2026-06-10T03:30:00.000Z');
  });
  it('returns null when reminders are off', () => {
    expect(reminderMoment(entry('2026-06-10', '18:00'), AMS, 'off')).toBeNull();
  });
  it('keeps 19:00 and 07:00 local on the spring-forward day (2026-03-29)', () => {
    // The 28th is CET (UTC+1); the 29th from 03:00 is CEST (UTC+2).
    expect(reminderMoment(entry('2026-03-29', '18:00'), AMS, 'evening_before')?.toISOString()).toBe('2026-03-28T18:00:00.000Z');
    expect(reminderMoment(entry('2026-03-29', '18:00'), AMS, 'morning_of')?.toISOString()).toBe('2026-03-29T05:00:00.000Z');
  });
  it('keeps 19:00 and 07:00 local on the fall-back day (2026-10-25)', () => {
    // The 24th is CEST (UTC+2); the 25th from 03:00 is CET (UTC+1).
    expect(reminderMoment(entry('2026-10-25', '18:00'), AMS, 'evening_before')?.toISOString()).toBe('2026-10-24T17:00:00.000Z');
    expect(reminderMoment(entry('2026-10-25', '18:00'), AMS, 'morning_of')?.toISOString()).toBe('2026-10-25T06:00:00.000Z');
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run `pnpm exec vitest run --project unit src/lib/reminder-moment.test.ts`. Expected FAIL: cannot resolve `./reminder-moment`.

- [ ] **Step 3: Implement**

```ts
import type { ReminderTiming } from '@prisma/client';
import { classStartInstant } from './timezone';
import { hhmmToTime } from './time-of-day';

/** No reminder lands later than this many minutes before the class starts. */
export const REMINDER_LATEST_LEAD_MINUTES = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a class reminder is due, in the teacher's timezone: 19:00 the day
 * before, 07:00 on the day, or an hour before start — never later than
 * `REMINDER_LATEST_LEAD_MINUTES` before start. `null` when reminders are off.
 */
export function reminderMoment(
  entry: { date: Date; startTime: Date },
  timeZone: string,
  timing: ReminderTiming,
): Date | null {
  const start = classStartInstant(entry, timeZone);
  const latest = new Date(start.getTime() - REMINDER_LATEST_LEAD_MINUTES * 60_000);
  let nominal: Date;
  switch (timing) {
    case 'off':
      return null;
    case 'evening_before':
      nominal = classStartInstant(
        { date: new Date(entry.date.getTime() - DAY_MS), startTime: hhmmToTime('19:00') },
        timeZone,
      );
      break;
    case 'morning_of':
      nominal = classStartInstant({ date: entry.date, startTime: hhmmToTime('07:00') }, timeZone);
      break;
    case 'one_hour_before':
      nominal = latest;
      break;
    default: {
      const unreachable: never = timing;
      return unreachable;
    }
  }
  return nominal.getTime() < latest.getTime() ? nominal : latest;
}
```

- [ ] **Step 4: Run them and see them pass**

Same command. Expected: PASS.

- [ ] **Step 5: Prove the cap bites**

1. Change the return to `return nominal;`.
2. Run the tests. Expected FAIL on "caps an early class’s morning reminder": received `2026-06-10T05:00:00.000Z`. Record the text.
3. Restore, and re-run to PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reminder-moment.ts src/lib/reminder-moment.test.ts
git commit -m "feat: reminderMoment — when a class reminder is due (#721)"
```

---

### Task 3: Email and notification plumbing

**Files:**
- Modify: `src/lib/email-templates.ts` (`wrapEmail`, `renderNotificationEmail`), `src/lib/email-templates.test.ts`
- Modify: `src/lib/email.ts`
- Modify: `src/services/notifications.ts` (`NotificationFields`, `createNotification`, `createBulkNotifications`), `src/services/notifications.test.ts`

**Interfaces:**
- Produces:
  - `wrapEmail(heading: string, bodyHtml: string, footer?: string): string`. When `footer` is absent, it keeps today's footer line.
  - `renderNotificationEmail(notification, baseUrl?, footer?: string)`, which passes `footer` through to `wrapEmail`.
  - `export const CLASS_REMINDER_EMAIL_FOOTER: string`, in `email-templates.ts`.
  - `export async function sendHtmlEmail(input: { to: string; subject: string; html: string }): Promise<{ ok: true } | { ok: false; reason: string }>`, in `src/lib/email.ts`. In dry-run it logs and returns `{ ok: true }`.
  - `NotificationFields` gains `readonly emailSent?: boolean`. Both create functions write `emailSent: input.emailSent ?? false`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/email-templates.test.ts`:

```ts
it('uses the reminder footer, not the unread-fallback one, when given (#721)', () => {
  const { html } = renderNotificationEmail(
    { type: 'class_reminder', title: 'Class reminder', body: 'Flow on Wed 10 Jun at 18:00.', recipientType: 'student' },
    'https://fair.yoga',
    CLASS_REMINDER_EMAIL_FOOTER,
  );
  expect(html).toContain(CLASS_REMINDER_EMAIL_FOOTER);
  expect(html).not.toContain('when an in-app message goes unread');
});
it('keeps the unread-fallback footer by default', () => {
  const { html } = renderNotificationEmail({ type: 'announcement', title: 't', body: 'b' }, 'https://fair.yoga');
  expect(html).toContain('when an in-app message goes unread');
});
```

In `src/services/notifications.test.ts`, following that file's fixture style:

```ts
it('writes emailSent as given, and false by default (#721)', async () => {
  const sent = await createNotification(prisma, { recipientType: 'student', recipientId: studentId, type: 'class_reminder', title: 't', body: 'b', emailSent: true });
  const unsent = await createNotification(prisma, { recipientType: 'student', recipientId: studentId, type: 'announcement', title: 't', body: 'b' });
  expect(sent.emailSent).toBe(true);
  expect(unsent.emailSent).toBe(false);
});
```

- [ ] **Step 2: Run them and see them fail**

Run:
- `pnpm exec vitest run --project unit src/lib/email-templates.test.ts`
- `pnpm exec vitest run --project unit-sweeps src/services/notifications.test.ts`

Expected FAIL: `CLASS_REMINDER_EMAIL_FOOTER` is not exported, and a type error on `emailSent`.

- [ ] **Step 3: Implement**

`email-templates.ts`:

```ts
const UNREAD_FALLBACK_FOOTER =
  'You get emails like this when an in-app message goes unread; turn them off in your settings.';

/** Footer for a class reminder, sent at its moment because the reader chose email for reminders. */
export const CLASS_REMINDER_EMAIL_FOOTER =
  'You get this email because you chose class reminders by email; change that in your notification settings.';
```

- `wrapEmail(heading, bodyHtml, footer = UNREAD_FALLBACK_FOOTER)` interpolates `${escapeHtml(footer)}` where the fixed sentence was.
- `renderNotificationEmail(notification, baseUrl = …, footer?: string)` passes `footer` to `wrapEmail`.

`email.ts` (it reuses the module's own `resend()` and `emailDryRun()`, and imports `log` from `@/lib/log`):

```ts
/** Sends one HTML email. Resend reports failure as `{ error }`, not a throw; so does this. */
export async function sendHtmlEmail(input: {
  to: string;
  subject: string;
  html: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (emailDryRun()) {
    log.info({ to: input.to, subject: input.subject }, 'email dry-run');
    return { ok: true };
  }
  const { error } = await resend().emails.send({
    from: process.env.EMAIL_FROM || 'noreply@fair.yoga',
    ...input,
  });
  return error ? { ok: false, reason: error.message } : { ok: true };
}
```

`notifications.ts`:
- Add `readonly emailSent?: boolean;` to `NotificationFields`.
- In both create functions, replace `emailSent: false` with `emailSent: input.emailSent ?? false`.

- [ ] **Step 4: Run them and see them pass**

Run the same commands, then `pnpm run typecheck`. Expected: PASS.

- [ ] **Step 5: Prove the guards bite**

1. Change `input.emailSent ?? false` to `false` in `createNotification`. Run the test. Expected FAIL: `expected false to be true`. Restore.
2. Change the `wrapEmail` default so the passed footer is ignored (interpolate `UNREAD_FALLBACK_FOOTER` unconditionally). Expected FAIL on the reminder-footer test. Restore.
3. Run `git status` to confirm a clean diff apart from the intended edits.

- [ ] **Step 6: Commit**

```bash
git add src/lib/email-templates.ts src/lib/email-templates.test.ts src/lib/email.ts src/services/notifications.ts src/services/notifications.test.ts
git commit -m "feat: reminder email footer, sendHtmlEmail, emailSent at creation (#721)"
```

---

### Task 4: The reminder sweep, reactivation, and scheduler wiring

**Files:**
- Create: `src/services/class-reminders.ts`
- Test: `src/services/class-reminders.test.ts` (add to `SWEEP_TESTS` in `vitest.tiers.ts`)
- Modify: `src/services/waitlist.ts:132-141` (`activateRegistration` update branch), `src/services/waitlist.test.ts`
- Modify: `src/services/email-fallback.test.ts` (one test)
- Modify: `src/lib/scheduler.ts`, `src/lib/scheduler.test.ts`
- Create: `src/app/api/cron/class-reminders/route.ts`
- Modify: `docs/technical-architecture.md` (cron table `:897-904`, `readInPages` census `:317-326`), `DEPLOYMENT.md:101`

**Interfaces:**
- Consumes:
  - `reminderMoment` (Task 2).
  - `sendHtmlEmail`, `renderNotificationEmail`, `CLASS_REMINDER_EMAIL_FOOTER` (Task 3).
  - `createNotification` with `emailSent` (Task 3).
  - Task 1's columns.
- Produces:
  - `export interface ClassReminderResult { studentReminders: number; teacherReminders: number; emailFailures: number }`
  - `export async function processClassReminders(db: PrismaClient, now: Date = new Date()): Promise<ClassReminderResult>`
  - `export function reminderCandidateDates(now: Date): { from: Date; to: Date }`

- [ ] **Step 1: Write the failing reactivation test**

In `src/services/waitlist.test.ts`, inside `describe('promoteNext (DB)')`, beside the lock-mismatch test (it uses that block's `seedPromotable`):

```ts
it('reactivating a cancelled registration is a new booking for reminders (#721)', async () => {
  const seeded = await seedPromotable('2099-07-15', 'Reactivate');
  const old = new Date('2000-01-01T00:00:00Z');
  await prisma.registration.create({
    data: {
      classId: seeded.classId, studentId: seeded.waiterId, status: 'cancelled', cancelledAt: old,
      tierAtBooking: 3, registeredAt: old, classReminderSentAt: old,
    },
  });
  const before = Date.now();
  await prisma.$transaction(async (tx) => {
    const lock = await lockClassRow(tx, seeded.classId);
    return activateRegistration(tx, lock, { classId: seeded.classId, studentId: seeded.waiterId, tierAtBooking: 3 });
  });
  const row = await prisma.registration.findUniqueOrThrow({
    where: { classId_studentId: { classId: seeded.classId, studentId: seeded.waiterId } },
  });
  expect(row.registeredAt.getTime()).toBeGreaterThanOrEqual(before);
  expect(row.classReminderSentAt).toBeNull();
});
```

Run `pnpm exec vitest run --project unit src/services/waitlist.test.ts -t "new booking for reminders"`. If `waitlist.test.ts` is in `SWEEP_TESTS`, use `--project unit-sweeps` instead. Expected FAIL: `registeredAt` is still 2000-01-01.

- [ ] **Step 2: Implement the reactivation reset**

In the `existing ? tx.registration.update({ … data: { … } })` branch, add:

```ts
          // A reused row is a new booking: its reminder is judged from now.
          registeredAt: new Date(),
          classReminderSentAt: null,
```

Re-run. Expected: PASS.

- [ ] **Step 3: Write the failing sweep tests**

Create `src/services/class-reminders.test.ts`. Follow `src/services/payment-reminders.test.ts` for the fixtures (`new PrismaClient()`, inline teacher/room/teacherRoom, `createClassFixture` from `'../../tests/class-fixtures'`, `afterAll` teardown by collected ids, guarded against an id left undefined).

Use `scopeSweep` (`tests/scoped-sweep.ts`) to scope `Class` to the fixture class ids. Stub Resend and the logger exactly as `email-fallback.consent.test.ts` does (`sendMock`, `vi.mock('resend', …)`, `vi.mock('@/lib/log', …)`, plus `RESEND_API_KEY='re_test_dummy'` and `EMAIL_DRY_RUN` deleted in `beforeAll`, restored in `afterAll`).

Fixtures:
- Teacher `defaultTimezone: 'UTC'`, so wall-clock time equals the instant (memory: `real-time-fixtures-need-utc-teacher`).
- Class date `2099-06-10`, start `18:00`, status `open`, `createdAt` default (now, long before 2099).
- A fixed `now` per test, injected.

Shared shape:

```ts
const START = new Date('2099-06-10T18:00:00Z');
const MORNING = new Date('2099-06-10T07:00:00Z');

async function book(studentOverrides: Partial<{ classReminder: ReminderTiming; classReminderChannel: ReminderChannel }>, regOverrides: Partial<{ registeredAt: Date; status: RegistrationStatus }> = {}) {
  const student = await prisma.student.create({ data: { firstName: 'Rem', lastName: 'Inder', email: `rem-${uniqueSuffix}-${n++}@test.local`, incomeTier: 3, ...studentOverrides } });
  studentIds.push(student.id);
  return prisma.registration.create({ data: { classId, studentId: student.id, status: 'registered', tierAtBooking: 3, registeredAt: new Date('2099-06-01T00:00:00Z'), ...regOverrides } });
}
```

Each case below is its own `it`. In every case, assert presence before asserting a zero: count the fixture rows first (the project convention in `payment-reminders.test.ts`).

| # | Setup | `now` | Expect |
|---|---|---|---|
| 1 | student `morning_of`/`inbox_and_email` | `MORNING` | one `class_reminder` row for the student, with `emailSent: true` and `relatedClassId`; `sendsTo(student.email) === 1`; `classReminderSentAt` set |
| 2 | same as 1, sweep run twice | `MORNING`, then `MORNING + 5 min` | still one row, one send; the second result is `studentReminders: 0` |
| 3 | student `inbox` | `MORNING` | one row; zero sends |
| 4 | student `email` | `MORNING` | zero rows for that student; one send; the stamp is set |
| 5 | student `off` | `MORNING` | zero rows; zero sends; the stamp is null |
| 6 | student `morning_of`, `registeredAt` = `MORNING + 1 min` | `MORNING + 10 min` | nothing sent; the stamp is null |
| 7 | registration `status: 'cancelled'` | `MORNING` | nothing |
| 8 | moment not yet reached | `MORNING − 1 min` | nothing |
| 9 | at start | `START` | nothing (the `now < start` bound) |
| 10 | the class entry is cancelled (`cancelledAt` set through the fixture) | `MORNING` | nothing |
| 11 | class `status: 'draft'` | `MORNING` | nothing |
| 12 | the student is erased (`deletedAt` set) | `MORNING` | nothing |
| 13 | teacher `morning_of`/`inbox_and_email`, two `registered` students | `MORNING` | one teacher row (`recipientType: 'teacher'`), whose body contains `2 registered`; one send to `teacher.email`; `teacherReminderSentAt` set; a second run sends nothing |
| 14 | teacher `off` | `MORNING` | no teacher row; stamp null |
| 15 | teacher erased (`deletedAt` set) | `MORNING` | no teacher row |
| 16 | a `StudioClass` for the same teacher on the same date | `MORNING` | no row references it (the sweep reads `Class` only; assert that the teacher's notification count equals the reminder count from the regular class alone) |
| 17 | `sendMock` resolves `{ error: { message: 'boom' } }` for a student `email` | `MORNING` | the result has `emailFailures: 1`; the stamp is set (at most once); a second run sends nothing |

Run it after adding the file to `SWEEP_TESTS`:
`pnpm exec vitest run --project unit-sweeps src/services/class-reminders.test.ts`. Expected FAIL: cannot resolve `./class-reminders`.

In `src/services/email-fallback.test.ts`, add one test. Create a `class_reminder` row with `emailSent: true`, unread, `createdAt` one hour ago, and a related class starting within the urgent window. Run `processEmailFallback`. Expect `sendsTo(email) === 0`.

- [ ] **Step 4: Implement the sweep**

```ts
import type { PrismaClient, ReminderChannel, ReminderTiming } from '@prisma/client';
import { readInPages } from '@/lib/read-in-pages';
import { classStartInstant } from '@/lib/timezone';
import { reminderMoment } from '@/lib/reminder-moment';
import { formatDayHeader } from '@/lib/format';
import { timeToHHmm } from '@/lib/time-of-day';
import { renderNotificationEmail, CLASS_REMINDER_EMAIL_FOOTER } from '@/lib/email-templates';
import { sendHtmlEmail } from '@/lib/email';
import { log } from '@/lib/log';
import { createNotification } from './notifications';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ClassReminderResult {
  studentReminders: number;
  teacherReminders: number;
  emailFailures: number;
}

function utcMidnight(ms: number): Date {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Entry dates that can hold a due reminder at `now`: wide enough for an
 * evening-before reminder under any zone offset; the moment check narrows it.
 */
export function reminderCandidateDates(now: Date): { from: Date; to: Date } {
  return { from: utcMidnight(now.getTime() - 2 * DAY_MS), to: utcMidnight(now.getTime() + 3 * DAY_MS) };
}

function readCandidatePage(db: PrismaClient, from: Date, to: Date, afterId: string | undefined, take: number) {
  return db.class.findMany({
    where: {
      status: 'open',
      calendarEntry: { cancelledAt: null, date: { gte: from, lte: to }, teacher: { deletedAt: null } },
      ...(afterId !== undefined ? { id: { gt: afterId } } : {}),
    },
    orderBy: { id: 'asc' },
    take,
    select: {
      id: true,
      createdAt: true,
      teacherReminderSentAt: true,
      calendarEntry: {
        select: {
          classType: true,
          date: true,
          startTime: true,
          teacherId: true,
          teacher: {
            select: { firstName: true, email: true, defaultTimezone: true, classReminder: true, classReminderChannel: true },
          },
        },
      },
    },
  });
}
type Candidate = Awaited<ReturnType<typeof readCandidatePage>>[number];

const wantsInbox = (c: ReminderChannel) => c !== 'email';
const wantsEmail = (c: ReminderChannel) => c !== 'inbox';

/** True when a reminder at `timing` is due at `now` for something created at `createdAt`. */
function isDue(entry: Candidate['calendarEntry'], timing: ReminderTiming, createdAt: Date, start: Date, now: Date): boolean {
  const moment = reminderMoment(entry, entry.teacher.defaultTimezone, timing);
  return moment !== null && moment <= now && now < start && createdAt < moment;
}

async function emailReminder(to: string, recipientType: 'student' | 'teacher', title: string, body: string): Promise<boolean> {
  const { subject, html } = renderNotificationEmail(
    { type: 'class_reminder', title, body, recipientType },
    undefined,
    CLASS_REMINDER_EMAIL_FOOTER,
  );
  const result = await sendHtmlEmail({ to, subject, html });
  if (!result.ok) log.error({ to, reason: result.reason }, 'class reminder email failed; not retried');
  return result.ok;
}

export async function processClassReminders(db: PrismaClient, now: Date = new Date()): Promise<ClassReminderResult> {
  const result: ClassReminderResult = { studentReminders: 0, teacherReminders: 0, emailFailures: 0 };
  const { from, to } = reminderCandidateDates(now);
  const classes = await readInPages<Candidate>((after, take) => readCandidatePage(db, from, to, after?.id, take));

  for (const cls of classes) {
    const entry = cls.calendarEntry;
    const start = classStartInstant(entry, entry.teacher.defaultTimezone);
    if (now >= start) continue;
    const when = `${entry.classType} on ${formatDayHeader(entry.date)} at ${timeToHHmm(entry.startTime)}`;

    const registrations = await db.registration.findMany({
      where: { classId: cls.id, status: 'registered', classReminderSentAt: null, student: { deletedAt: null } },
      select: { id: true, registeredAt: true, student: { select: { id: true, email: true, classReminder: true, classReminderChannel: true } } },
    });
    for (const reg of registrations) {
      const { student } = reg;
      if (!isDue(entry, student.classReminder, reg.registeredAt, start, now)) continue;
      const title = 'Class reminder';
      const body = `Your ${when} with ${entry.teacher.firstName}.`;
      const claimed = await db.$transaction(async (tx) => {
        const { count } = await tx.registration.updateMany({
          where: { id: reg.id, status: 'registered', classReminderSentAt: null },
          data: { classReminderSentAt: now },
        });
        if (count === 0) return false;
        if (wantsInbox(student.classReminderChannel)) {
          await createNotification(tx, {
            recipientType: 'student', recipientId: student.id, type: 'class_reminder',
            title, body, relatedClassId: cls.id, emailSent: true,
          });
        }
        return true;
      });
      if (!claimed) continue;
      result.studentReminders++;
      if (wantsEmail(student.classReminderChannel) && !(await emailReminder(student.email, 'student', title, body))) {
        result.emailFailures++;
      }
    }

    const { teacher } = entry;
    if (cls.teacherReminderSentAt === null && isDue(entry, teacher.classReminder, cls.createdAt, start, now)) {
      const title = 'Class reminder';
      const registered = await db.registration.count({ where: { classId: cls.id, status: 'registered' } });
      const body = `${when} — ${registered} registered so far.`;
      const claimed = await db.$transaction(async (tx) => {
        const { count } = await tx.class.updateMany({
          where: { id: cls.id, teacherReminderSentAt: null },
          data: { teacherReminderSentAt: now },
        });
        if (count === 0) return false;
        if (wantsInbox(teacher.classReminderChannel)) {
          await createNotification(tx, {
            recipientType: 'teacher', recipientId: entry.teacherId, type: 'class_reminder',
            title, body, relatedClassId: cls.id, emailSent: true,
          });
        }
        return true;
      });
      if (claimed) {
        result.teacherReminders++;
        if (wantsEmail(teacher.classReminderChannel) && !(await emailReminder(teacher.email, 'teacher', title, body))) {
          result.emailFailures++;
        }
      }
    }
  }
  return result;
}
```


Run the sweep tests. Expected: PASS, all 17 plus the email-fallback test.

- [ ] **Step 5: Wire the scheduler and cron route**

`src/lib/scheduler.ts`:
- add `processClassReminders: (db: PrismaClient) => Promise<unknown>;` to `SchedulerSweeps`;
- in `startScheduler`, add `const { processClassReminders } = await import('@/services/class-reminders');` and pass it to `buildJobs`;
- destructure it in `buildJobs`;
- add the job immediately after `payment-reminders`:

```ts
    {
      // 5 minutes bounds how late a reminder lands after its moment; the
      // sweep never sends at or after the class's start.
      name: 'class-reminders',
      intervalMs: 5 * MINUTE,
      run: (db) => processClassReminders(db),
    },
```

`src/lib/scheduler.test.ts`:
- add `'processClassReminders'` to `SWEEP_NAMES`;
- add `['class-reminders', 5 * MINUTE]` after `['payment-reminders', 60 * MINUTE]` in the interval list;
- add `'class-reminders': ['processClassReminders']` to the routing map.

`src/app/api/cron/class-reminders/route.ts` is a copy of `src/app/api/cron/payment-reminders/route.ts` that imports and calls `processClassReminders(prisma)`.

Docs:
- in `docs/technical-architecture.md`, add a cron table row for `class-reminders` (every 5 minutes, `/api/cron/class-reminders`) and a `readInPages` census row for `processClassReminders`;
- in `DEPLOYMENT.md:101`, append `/api/cron/class-reminders`.

Run `pnpm exec vitest run --project unit src/lib/scheduler.test.ts` and `pnpm run typecheck`. Expected: PASS.

- [ ] **Step 6: Prove each guard bites**

Mutate one guard at a time, run `class-reminders.test.ts` (and `waitlist.test.ts` for the last one), record the failing test and its message, then restore. Warm nothing: these are in-process tests.

| Mutation | Expected red |
|---|---|
| `isDue`: drop `&& createdAt < moment` | case 6 |
| `isDue`: drop `&& now < start` (also remove the `if (now >= start) continue`) | case 9 |
| student `updateMany` where: drop `classReminderSentAt: null` | case 2 |
| `readCandidatePage`: drop `cancelledAt: null` | case 10 |
| `readCandidatePage`: `status: 'open'` → `status: { in: ['open', 'draft'] }` | case 11 |
| `emailSent: true` → omitted (student branch) | the email-fallback test **may stay green** because the reminder sweep never leaves the row unread-eligible; if it stays green, add an assertion to case 1 that the row's `emailSent` is `true`, then re-run the mutation to red |
| registrations query: drop `student: { deletedAt: null }` | case 12 |
| `activateRegistration`: drop `classReminderSentAt: null` | the waitlist reactivation test |

Finish with `git status` showing only the intended files (memory: `mutation-sweeps-must-end-clean`).

- [ ] **Step 7: Commit**

```bash
git add src/services/class-reminders.ts src/services/class-reminders.test.ts vitest.tiers.ts src/services/waitlist.ts src/services/waitlist.test.ts src/services/email-fallback.test.ts src/lib/scheduler.ts src/lib/scheduler.test.ts src/app/api/cron/class-reminders/route.ts docs/technical-architecture.md DEPLOYMENT.md
git commit -m "feat: class-reminders sweep — teacher and student reminders at their moment (#721)"
```

---

### Task 5: Settings UI and the remaining docs

**Files:**
- Modify: `src/components/settings/notification-prefs-form.tsx`, `src/components/settings/notification-prefs-form.test.tsx`
- Modify: `src/components/student/notifications-form.tsx`, `src/components/student/notifications-form.test.tsx`
- Modify: `tests/integration/teachers-api.test.ts`
- Modify: `docs/product-concept.md:207`, `CLAUDE.md` (Communication section)

**Interfaces:**
- Consumes:
  - `ReminderTiming` and `ReminderChannel`.
  - `TeacherNotificationPrefs` (with the two new keys).
  - `updateStudentSchema`'s `classReminder` and `classReminderChannel`.

**Shared option lists.** Both forms show the same labels. Put them in one place, `src/lib/reminder-options.ts`:

```ts
import type { ReminderChannel, ReminderTiming } from '@prisma/client';
import type { NoneOf } from './type-pins';

export const REMINDER_TIMING_OPTIONS = [
  { value: 'evening_before', label: 'Evening before' },
  { value: 'morning_of', label: 'Morning of class' },
  { value: 'one_hour_before', label: '1 hour before' },
  { value: 'off', label: 'Off' },
] as const satisfies ReadonlyArray<{ value: ReminderTiming; label: string }>;

export const REMINDER_CHANNEL_OPTIONS = [
  { value: 'inbox', label: 'In the app' },
  { value: 'email', label: 'By email' },
  { value: 'inbox_and_email', label: 'In the app and by email' },
] as const satisfies ReadonlyArray<{ value: ReminderChannel; label: string }>;

const _everyTiming: NoneOf<Exclude<ReminderTiming, (typeof REMINDER_TIMING_OPTIONS)[number]['value']>> = true;
const _everyChannel: NoneOf<Exclude<ReminderChannel, (typeof REMINDER_CHANNEL_OPTIONS)[number]['value']>> = true;
void _everyTiming;
void _everyChannel;

export function isReminderTiming(v: string): v is ReminderTiming {
  return REMINDER_TIMING_OPTIONS.some((o) => o.value === v);
}
export function isReminderChannel(v: string): v is ReminderChannel {
  return REMINDER_CHANNEL_OPTIONS.some((o) => o.value === v);
}
```

Add `src/lib/reminder-options.ts` to this task's commit.

- [ ] **Step 1: Write the failing component tests**

`notification-prefs-form.test.tsx`:

```ts
it('offers a Class reminder timing and channel, and sends both (#721)', async () => {
  render(<NotificationPrefsForm teacherId="t1" initial={{ ...INITIAL, classReminder: 'morning_of', classReminderChannel: 'inbox_and_email' }} />);
  fireEvent.change(screen.getByLabelText('When'), { target: { value: 'one_hour_before' } });
  fireEvent.change(screen.getByLabelText('How'), { target: { value: 'email' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save notifications' }));
  const body = await lastPutBody(); // the file's existing helper for the captured fetch body
  expect(body).toMatchObject({ classReminder: 'one_hour_before', classReminderChannel: 'email' });
});
it('disables How while When is Off, and keeps the chosen channel (#721)', () => {
  render(<NotificationPrefsForm teacherId="t1" initial={{ ...INITIAL, classReminder: 'morning_of', classReminderChannel: 'email' }} />);
  fireEvent.change(screen.getByLabelText('When'), { target: { value: 'off' } });
  expect(screen.getByLabelText('How')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('When'), { target: { value: 'evening_before' } });
  expect(screen.getByLabelText('How')).toHaveValue('email');
});
```

Use the file's existing fetch-capture and `INITIAL` fixture names. If it names them differently, use its names.

`notifications-form.test.tsx`: the same two tests against `NotificationsForm`, with props `classReminder` and `classReminderChannel`. Also:
- update "sends exactly …" to expect exactly the keys `['classReminder', 'classReminderChannel', 'emailNotifications']`;
- update "renders all four reminder options" to read the labels from `REMINDER_TIMING_OPTIONS`.

`tests/integration/teachers-api.test.ts`:
- add `classReminder: 'evening_before', classReminderChannel: 'inbox'` to the round-trip test's body and to its override list;
- add `'refuses an unknown classReminder value (#721)'`, which PUTs `{ classReminder: 'eve' }` and expects status 400 (the status only, no message);
- add `'refuses the retired defaultReminder key (#721)'`, which PUTs `{ defaultReminder: 'morning_of' }` and expects 400.

- [ ] **Step 2: Run them and see them fail**

Run `pnpm exec vitest run --project components src/components/settings/notification-prefs-form.test.tsx src/components/student/notifications-form.test.tsx`. Expected FAIL: no element labelled `When`.

The integration test is run in Step 4, after `worktree:up`.

- [ ] **Step 3: Implement the controls**

In both forms, add a fieldset after the existing preference controls. On the teacher form, place it after *New booking*. On the student form, it replaces the lone `Class reminder` select:

```tsx
<fieldset className="mt-6">
  <legend className="type-subtitle">Class reminder</legend>
  <div className="mt-3 flex max-w-[280px] flex-col gap-3">
    <Select id="reminder-when" label="When" value={reminder}
      onChange={(e) => { if (isReminderTiming(e.target.value)) { setReminder(e.target.value); setSaved(false); } }}>
      {REMINDER_TIMING_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
    <Select id="reminder-how" label="How" value={reminderChannel} disabled={reminder === 'off'}
      onChange={(e) => { if (isReminderChannel(e.target.value)) { setReminderChannel(e.target.value); setSaved(false); } }}>
      {REMINDER_CHANNEL_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </Select>
  </div>
</fieldset>
```

- Make the state set by Task 1 settable: `const [reminderChannel, setReminderChannel] = useState(...)`.
- Use whichever "saved" flag the form already has. If the teacher form names it differently, use its name.
- Check that `Select` forwards `disabled` to the `<select>`. If it does not, add the pass-through in `src/components/ui/select.tsx`.
- Student form:
  - delete its local `REMINDER_OPTIONS`, `ReminderOption`, `isReminderOption` and their pins, which `reminder-options.ts` now owns;
  - add the `classReminderChannel` prop and state;
  - add `classReminderChannel` to `NotificationsBody` and the payload;
  - in `account/notifications/page.tsx`, select and pass `classReminderChannel`;
  - reword the caption under the email toggle to: "Essential messages about your bookings — cancellations, waitlist spots, payment requests — are still emailed even when this is off. Class reminders follow their own setting below."

Docs:
- `docs/product-concept.md:207` becomes: "**Class reminders:** On by default, set to morning-of, in the app and by email. Each student chooses when (evening before, morning of, 1 hour before, or off) and how (in the app, by email, or both); the setting applies to all their bookings. Teachers get the same reminder for each class they teach, with the same two choices, in Settings → Notifications."
- In `CLAUDE.md`, under *Communication*, after item 3, add: "Class reminders are not a fallback: the `class-reminders` sweep sends them at the recipient's chosen moment, in the app, by email or both, and each is sent at most once."

- [ ] **Step 4: Run them and see them pass**

Run:
- `pnpm exec vitest run --project components src/components`
- In a worktree: `pnpm install --frozen-lockfile`, `pnpm run worktree:setup` (once), `pnpm run worktree:up`, then `pnpm exec vitest run --project integration tests/integration/teachers-api.test.ts tests/integration/tier-selected-at.test.ts`

Expected: PASS.

- [ ] **Step 5: Prove the guards bite**

1. Remove `disabled={reminder === 'off'}`. Expected FAIL on the "disables How" test. Restore.
2. Drop `classReminderChannel` from the student payload. Expected FAIL on "sends exactly …", which names the missing key. Restore.
3. Run `git status` to confirm it is clean apart from the intended edits.

- [ ] **Step 6: Drive it in the app**

Follow the `verify` skill:
- sign in as a seeded teacher and open `/settings/notifications`;
- set *When* to 1 hour before and *How* to By email, save, reload, and confirm the values persist;
- set *When* to Off and confirm *How* is disabled;
- check that `/settings/profile` no longer shows a reminder select;
- repeat on `/account/notifications` as a seeded student.

Screenshot both pages at 100% (memory: `verify-visuals-at-actual-size`).

- [ ] **Step 7: Full verification, then commit**

Run `pnpm run verify` (with the worktree app up). Expected: green. Record the per-project counts for the PR body.

```bash
git add src/lib/reminder-options.ts src/components/settings/notification-prefs-form.tsx src/components/settings/notification-prefs-form.test.tsx src/components/student/notifications-form.tsx src/components/student/notifications-form.test.tsx "src/app/(student)/account/notifications/page.tsx" tests/integration/teachers-api.test.ts docs/product-concept.md CLAUDE.md
git commit -m "feat: class reminder When/How controls for teachers and students (#721)"
```

If `src/components/ui/select.tsx` changed, add it to this commit.

---

## After the tasks

- Whole-branch review on the most capable model (the plan has 5 tasks), one fix wave, and one scoped re-review.
- Before opening the PR:
  - post a comment on #721 correcting its premise: what `defaultReminder` is, the student enum values, and the decision taken (from a `--body-file`);
  - grep `defaultReminder\|reminderPref\|StudentReminderPref\|ReminderPref\b` across `src prisma tests docs CLAUDE.md`, and give every hit a verdict. Expected survivors: applied migrations, and historical specs and plans.
