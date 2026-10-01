# Class reminders for teachers and students (#721) — design

#721 asked for a decision: two reminder settings are stored, and nothing reads
either of them. The decision is to build both reminders. A student is reminded
of each class they booked, and a teacher is reminded of each class they teach.
Each profile chooses when the reminder comes and how it arrives. The teacher can
also turn their reminder off.

Built after #722 (#49, teacher notification preferences) merges, on a branch
from the updated `main`. This design extends #722's `TeacherNotificationType`,
its policy table, and its Settings → Notifications page.

## 1. What was measured, and where the issue was wrong

**The issue misread `Teacher.defaultReminder`.** It treated the field as a
default that pre-fills each student's reminder, and its option 2 ("the teacher
default has no defined role in the product concept, since the student chooses")
rests on that reading. The field is the teacher's own reminder about their own
class (decided at the brainstorming gate). One line is the only source for the
misreading: `docs/data-model.md`'s Teacher table describes `default_reminder` as
"Pre-fills class reminder setting". Nothing else in the docs defines the field.
`docs/visual/teacher-journey.docx` mentions only payment reminders, and
`docs/teacher-screens.md` mentions only the per-row "Send reminder" for unpaid
payments. #49's spec (`2026-10-01-teacher-notification-preferences-design.md`
§1) repeats the "class-reminder timing" description without saying whose
reminder it is.

**The enums support the corrected reading.** `StudentReminderPref` has `off`;
`ReminderPref` (the teacher's) does not. A real default for a student setting
would carry the setting's own values. Missing `off` is a gap in a teacher's own
preference, and this design adds it.

**The issue's student enum is misquoted.** The values are
`eve | morning | one_hour | off` (`prisma/schema.prisma`), not `evening | …`.

**What held: nothing reads either field, and no class-reminder sender exists.**
Re-derive with:

```
grep -rn "defaultReminder\|reminderPref" src prisma --include='*.ts' --include='*.tsx' | grep -v "\.test\."
```

Every hit is a schema, a form, a page loader, the GDPR export, or the seed. The
only `reminder`-type notifications are payment reminders
(`src/services/payment-reminders.ts`, `src/services/payments.ts`), deduped
through `Payment.reminderSentAt`.

## 2. Decisions taken at the brainstorming gate

| Question | Decision |
|---|---|
| Direction | Build reminders for both teachers and students |
| Shape | Two settings per profile: **when** (with off) and **how** (in-app / email / both) |
| Teacher scope | Regular classes only. A studio class gets no reminder |
| Grouping | One reminder per class, never a daily digest |
| Student default | Morning of, in the app and by email (product concept: on by default, morning-of) |
| Teacher default | Morning of, in the app and by email |
| Sequencing | After #722 merges |

## 3. Data model

Two migrations, created with `prisma migrate dev`: the `ADD VALUE` alone, then
the rest. No backfill: nothing is in
production.

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

model Teacher {
  classReminder         ReminderTiming  @default(morning_of)        // was defaultReminder
  classReminderChannel  ReminderChannel @default(inbox_and_email)
}

model Student {
  classReminder         ReminderTiming  @default(morning_of)        // was reminderPref
  classReminderChannel  ReminderChannel @default(inbox_and_email)
}

model Registration { classReminderSentAt   DateTime? }
model Class        { teacherReminderSentAt DateTime? }

enum NotificationType { … class_reminder }
```

- **One timing enum for both profiles.** `ReminderTiming` replaces
  `ReminderPref` and `StudentReminderPref`. Student values map as
  `eve → evening_before`, `morning → morning_of`, `one_hour → one_hour_before`,
  `off → off`. The migration converts the column through a `USING` cast, not by
  dropping it.
- **The teacher field is renamed.** "Default" in `defaultReminder` is the word
  that misled #721. The student field is renamed to the same name, so the two
  profiles, their forms and their GDPR export keys read alike.
- **No CHECK constraint.** Every combination of timing and channel is valid. A
  channel paired with `off` is stored and ignored; the UI disables the channel
  select rather than clearing it, so turning reminders back on restores the
  previous channel.
- **`class_reminder` is a new type, not a reuse of `reminder`.** `reminder` is
  payment dunning: it is in `ESSENTIAL_NOTIFICATION_TYPES` because the student
  owes money. A class reminder is governed by its own channel setting, so it
  must not inherit that classification.
- **The two `SentAt` stamps** follow `Payment.reminderSentAt`: a conditional
  `updateMany` on `… IS NULL` makes the send at-most-once across overlapping
  sweeps.

## 4. When a reminder fires

All wall-clock times are in the teacher's `defaultTimezone`. That is the class's
own clock, and a student has no timezone of their own.

| Timing | Nominal moment |
|---|---|
| `evening_before` | 19:00 on the day before the class's date |
| `morning_of` | 07:00 on the class's date |
| `one_hour_before` | class start − 60 minutes |
| `off` | never |

**The moment is capped at start − 60 minutes.** A 06:30 class with
`morning_of` is reminded at 05:30, not after it has started. The cap leaves
`evening_before` alone in practice, and makes `one_hour_before` equal to its own
nominal moment. The calculation is a pure function in its own module, taking
`(date, startTime, timezone, timing)` and returning an instant or `null`.

**A reminder is due when** `moment ≤ now < start`, its stamp is null, and:

- *Student:* the registration's `status` is `registered`; the class's status
  is `open`; its entry's `cancelledAt` is null; and `registeredAt < moment`.
- *Teacher:* the class's status is `open`; its entry's `cancelledAt` is null;
  and `Class.createdAt < moment`.

**The `registeredAt < moment` rule** skips anyone who booked after their
reminder moment: a late booking, a walk-in, or a waitlist promotion. Each of
them just received a notification about this class, so a reminder would repeat
it. The teacher's `Class.createdAt < moment` rule does the same for a class
created after its own moment. A draft created early and published late is
still reminded, once, at the next sweep. That case is accepted rather than
adding a `publishedAt` column.

**A reactivated registration counts as a new booking.** `activateRegistration`
(`src/services/waitlist.ts`) reuses a student's earlier, cancelled row for the
same class instead of creating one. Its update branch therefore writes
`registeredAt = now` and `classReminderSentAt = null`. Without that, a rebooking
would keep its first booking's time and escape the skip rule. A stamp from the
first booking would also suppress the new booking's reminder. As a side effect,
a rebooked student moves to the end of the registrant lists, which are ordered
by `registeredAt`. That order reflects when they actually booked.

**Erased profiles are filtered explicitly.** The candidate query requires
`deletedAt: null` on the student and on the teacher, as payment reminders do,
rather than relying on erasure having cancelled their rows.

**Excluded by the status filter:** `draft`, `in_progress`, `completed`, and any
cancelled entry. Studio classes are not queried at all.

**The sweep** is a new scheduler job, `class-reminders`, every 5 minutes. A
`one_hour_before` reminder therefore lands between 55 and 60 minutes before
start. A missed tick (server down) delivers late but never after start, because
of the `now < start` bound.

## 5. Delivery

Per due reminder, in one transaction: the conditional stamp, then the inbox row
if the channel includes `inbox`. After the commit, the email is sent if the
channel includes `email`.

- **Email is direct, never through `processEmailFallback`.** A fallback email
  waits for an unread row: 30 minutes, or the next sweep within 2 hours of
  start. A `one_hour_before` reminder sent that way would arrive at or after
  start, or not at all once the row was read. So the reminder sweep sends its
  own email, and its inbox row is created with `emailSent = true` whatever the
  channel. The fallback skips rows with `emailSent = true`, so it never sends a
  reminder a second time, and never sends one for `inbox`-only. This is also
  what makes `email` without an inbox entry possible, the case #49 rules out
  for event notifications.
- **At-most-once.** A failed email is logged at `error` and not retried. The
  stamp has already committed. A missed reminder costs little; a duplicate is
  noise. Payment dunning takes the opposite trade-off for the opposite reason.
- **The student's channel choice is the whole policy.** `Student.emailNotifications`
  (the general opt-out for optional emails) does not apply to class reminders.
  The reminder has its own explicit choice. The student form's caption is
  reworded so the toggle no longer appears to cover reminders.
- **Teacher policy.** `class_reminder` joins `TeacherNotificationType`, governed
  by `classReminder` and `classReminderChannel`, never by #49's three columns.
  #722's policy table is tethered with
  `satisfies Record<TeacherNotificationType, …>`, so the compiler refuses the
  new member until the table gives it an entry. Because the reminder email is
  sent directly, that entry answers "never by fallback".
- **Content.** The title is "Class reminder". The body names the class type,
  day and start time. The teacher's version adds the registration count so far.
  `relatedClassId` is set, so the inbox row links to the class through the
  existing `studentNotificationHref` / `teacherNotificationHref`.
- **The email** is rendered by `renderNotificationEmail`
  (`src/lib/email-templates.ts`), with a plain static action link, as the linked
  fallback emails have. No magic link: fallback emails carry none either. `wrapEmail`
  takes an optional footer, because its fixed footer ("when an in-app message
  goes unread") is false for a reminder. The reminder footer says the email was
  sent because the recipient chose class reminders by email, and where to
  change that. The send goes through a new `sendHtmlEmail` in `src/lib/email.ts`,
  which honours `emailDryRun()`, rather than a third private Resend client.
- **The inbox row** is written through `createNotification`, which gains an
  optional `emailSent` input. Writing the row directly would skip the
  notification bus that pushes it to an open inbox.
- **The recipient address.** The student's is `Student.email`, which is
  required, so an unclaimed walk-in has one. The teacher's is `Teacher.email`,
  the copy the fallback also reads.
- **The new teacher fields join `TeacherNotificationPrefs`.** The profile
  form's compile pin requires every key of `updateTeacherSchema` outside
  `ProfileFormValues` to be one, and `processEmailFallback`'s teacher `select`
  must grow to match.
- **A cron route,** `/api/cron/class-reminders`, like every other job except
  waitlist reconciliation.

## 6. UI

- **Teacher.** The "Default reminder" select leaves Settings → Profile
  (`profile-form.tsx`, `updateTeacherSchema`, the `ProfileFormValues` pin).
  Settings → Notifications (#722's `notification-prefs-form.tsx`) gains a
  **Class reminder** fieldset beside *New booking*, holding two selects. *When*
  offers Evening before / Morning of class / 1 hour before / Off. *How* offers
  In the app / By email / In the app and by email. *How* is disabled while
  *When* is Off. The fields travel on #722's notification-prefs path and its
  compile-time field pin.
- **Student.** `/account/notifications` (`notifications-form.tsx`) replaces its
  lone "Class reminder" select with the same pair, with the same labels.

## 7. Documentation

- `docs/data-model.md`: the Teacher row (replaces "Pre-fills class reminder
  setting"), the Student row, the two new stamps, `class_reminder`, and the #49
  paragraph that calls `defaultReminder` "class-reminder timing".
- `docs/product-concept.md` (Class reminders): add the teacher reminder and the
  channel choice.
- `docs/visual/data-model.html`: the renamed and new fields.
- `CLAUDE.md` (Communication): one line, saying that class reminders are sent
  directly at their moment rather than as an unread fallback.
- Correct #721's issue text in a comment (what the teacher field is, and the
  enum values).

## 8. Testing

- **Unit:** the moment function: each timing; the start − 60 cap (a 06:30
  `morning_of`); `off` returns `null`; a DST transition day in
  `Europe/Amsterdam` (both directions) for `evening_before` and `morning_of`.
- **Integration (the sweep):** sends exactly once across two runs; inbox-only
  writes a row and sends no email; email-only writes no row; both writes a row
  with `emailSent = true`; skips a registration with `registeredAt` after the
  moment, a cancelled registration, a cancelled entry, a draft class, a studio
  class, and timing `off`; sends nothing at or after start; the email-fallback
  sweep does not email a `class_reminder` row; an erased student or teacher is
  not reminded.
- **Reactivation:** `activateRegistration` resets `registeredAt` and clears
  `classReminderSentAt` on a reused row, so a rebooking after the moment is
  skipped and a rebooking before it is reminded again.
- **Integration (settings and export):** both PUT routes accept and validate
  the new fields, the teacher profile PUT refuses `defaultReminder`, and the
  GDPR export carries both new fields for both profiles, pinned on non-default
  values.
- **Components:** both forms render the pair, disable *How* under Off, and send
  the fields.
- **Every guard is mutated** (the `registeredAt` rule, the cap, the status
  filter, the stamp condition, the `emailSent = true` write), with the failing
  test's error text recorded.

## 9. Out of scope

- Renaming the payment `reminder` type to `payment_reminder`.
- Reminders for studio classes and for waitlist entries.
- A student timezone of their own.
- Retrying a failed reminder email.
- #49's event notification preferences, which are unaffected apart from the new
  `class_reminder` member of `TeacherNotificationType`.
