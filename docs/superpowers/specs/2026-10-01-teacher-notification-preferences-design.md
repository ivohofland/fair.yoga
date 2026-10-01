# Teacher notification preferences (#49) — design

Screen 9.4 in `docs/teacher-screens.md` asks for two things: which events notify the teacher at all, and email on/off per event type. Neither exists today. This spec adds both. It does so narrowly: only the new-booking notification can be switched off entirely, and auto-cancel stays non-optional.

## 1. What was measured, and where the issue was right or incomplete

**The premise holds.** A teacher recipient's fallback email is unconditional. In `processEmailFallback` (`src/services/email-fallback.ts`), the teacher branch selects only `email` from `Teacher`. `emailEnabled` starts `true` and is reassigned only in the student branch, through `shouldEmailStudent` (`src/services/notification-policy.ts`). No email preference exists on `Teacher` or `Account` under any name. `docs/data-model.md` (the paragraph beginning "The teacher branch consults no email preference") already records this gap, and so does the dispatch-cap spec (`2026-09-16-teacher-inbox-dispatch-cap-design.md` §10), which asked for the gap to be filed separately. #49 is that filing.

**Which notification types reach a teacher.** `enum NotificationType` has 13 members. Every row is written by `createNotification` or `createBulkNotifications` (`src/services/notifications.ts`). Apart from the seed, a grep for direct `notification.create*` and raw `INSERT INTO "Notification"` finds no other writer. Walking every caller's `recipientType`:

| Type | Call site | Trigger |
|---|---|---|
| `booking_confirmed` | `src/app/api/registrations/route.ts` (booking transaction) | a student booked |
| `class_cancelled` | `src/services/class-transitions.ts` (auto-cancel) | too few bookings at the auto-cancel check |
| `payment_request` | `src/services/class-lifecycle.ts` (`completeClass`) | completion summary: earnings, N payment requests sent |
| `teacher_invitation` | `src/services/invitations.ts` | another teacher invited this teacher-only account (capped at one per invitation, #622) |

13 − 4 = 9 types never reach a teacher. Seven are student-only (`booking_cancelled`, `booking_removed`, `waitlist_promoted`, `spot_available`, `spot_taken`, `walk_in_added`, `announcement`). `reminder` is used only for students' payment reminders, and `payment_received` is never created. `notifyCancellation` (`src/app/api/registrations/[id]/route.ts`) is the only call site that passes `recipientType` as a variable, and every caller passes `'student'`. Re-derive with:

```
grep -rn "recipientType: 'teacher'" src | grep -v "\.test\."
```

That finds the four sites above, plus readers that are not writers (inbox, layout, notifications route, GDPR export/erasure, the email-fallback comment).

**What the issue missed:**

- **"Essential" cannot be reused as it stands.** `ESSENTIAL_NOTIFICATION_TYPES` is justified entirely from the student's side. For example, `payment_request` is essential because the student owes money. For the teacher, the same type is a summary of their own class. Whether an email is essential depends on who receives it, not only on the notification type, so teachers get a classification of their own (§2).
- **`defaultReminder` is not a notification preference.** It is a class-reminder timing setting, and nothing reads it. Neither does `Student.reminderPref`, and no class-reminder sender exists. Filed as #721 (a decision). It is out of scope here.
- **The essential/optional split is a student-only idea in code.** Today all four teacher types are emailed whenever they are unread. The timing rules (`isEmailEligible`: 30 minutes unread, or the next sweep when the class starts within 120 minutes) apply to both recipient kinds, and this spec leaves them unchanged.

## 2. Policy

Agreed at the brainstorming gate:

| Event | Type | Control | Default |
|---|---|---|---|
| New booking | `booking_confirmed` | **Inbox and email** / **Inbox only** / **Off** | Inbox and email |
| Class completed | `payment_request` | email on/off (always in the inbox) | on |
| Invitation from another teacher | `teacher_invitation` | email on/off (always in the inbox) | on |
| Class auto-cancelled | `class_cancelled` | none; emailed if missed | — |

- **Auto-cancel is essential.** The system cancelled the teacher's class without the teacher acting. Missing that email means turning up to a class that isn't running.
- **Only the new-booking notification can be switched off entirely.** It is the highest-volume type, and it is the only one that adds nothing the teacher cannot see elsewhere: the booking is on the schedule's class card, in both the registration bar and the registrant list. The completion summary is one per class and is the teacher's record that payment requests went out. The inbox entry is how the teacher reaches an invitation.
- **New booking is one three-way choice, not two toggles.** Email is a fallback for an unread inbox item, so "email without inbox" cannot happen. A three-way choice makes it impossible to select. Two toggles would need a rule to block it.
- **Defaults reproduce today's behaviour exactly.**

## 3. Data model

One migration, created with `prisma migrate dev`:

```prisma
enum TeacherBookingNotifications {
  inbox_and_email
  inbox_only
  off
}

model Teacher {
  // …
  bookingNotifications  TeacherBookingNotifications @default(inbox_and_email)
  emailOnClassCompleted Boolean                     @default(true)
  emailOnInvitation     Boolean                     @default(true)
}
```

- **Where the settings live: on `Teacher`, not `Account`.** These are notifications sent to the teacher profile. Someone with both a teacher and a student profile keeps two independent sets. `Student.emailNotifications` does not cover their teacher-side mail, and these columns do not cover their student-side mail. The student preference lives on `Student` for the same reason.
- **No backfill.** The defaults in the database are today's behaviour, and nothing is in production.
- **No CHECK constraint is needed.** Every combination of the three columns is valid. The one impossible state, email without an inbox entry, cannot be expressed in the enum.

## 4. The policy in code, and the tether

In `src/services/notification-policy.ts`, next to the student policy:

```ts
export type TeacherNotificationType =
  'booking_confirmed' | 'class_cancelled' | 'payment_request' | 'teacher_invitation';

export interface TeacherNotificationPrefs {
  bookingNotifications: TeacherBookingNotifications;
  emailOnClassCompleted: boolean;
  emailOnInvitation: boolean;
}

// How each teacher-recipient type's fallback email is decided.
const TEACHER_EMAIL_POLICY = {
  class_cancelled: () => true,
  booking_confirmed: (p) => p.bookingNotifications === 'inbox_and_email',
  payment_request: (p) => p.emailOnClassCompleted,
  teacher_invitation: (p) => p.emailOnInvitation,
} satisfies Record<TeacherNotificationType, (p: TeacherNotificationPrefs) => boolean>;

export function shouldEmailTeacher(type: TeacherNotificationType, prefs: TeacherNotificationPrefs): boolean;
```

The exact shape of the table is the plan's to decide. Two properties are fixed:

1. **The table is keyed by `TeacherNotificationType` and must cover all of it.** `satisfies Record<…>` makes a missing key a compile error.
2. **`TeacherNotificationType` is connected to the code that creates notifications.** `CreateNotificationInput` becomes a discriminated union on `recipientType`:

   ```ts
   export type CreateNotificationInput =
     | (NotificationFields & { recipientType: 'teacher'; type: TeacherNotificationType })
     | (NotificationFields & { recipientType: 'student'; type: NotificationType });
   ```

   Without (2), the union is a list in a comment that the compiler can't check. With it, a fifth teacher notification does not compile until its type joins the union, and joining the union does not compile until the table classifies it. That missing forcing step is how all four types came to be emailed unconditionally.

**The fallback sweep reads the type as `NotificationType`, from the database.** It narrows to the teacher union with a runtime guard: an `isTeacherNotificationType` that reads the table's keys, not a second list. A teacher-recipient row whose type is outside the union cannot be written through the typed path except by one of the holes listed below. If one is found anyway (from one of those, the seed, or a direct SQL write), it is **emailed rather than dropped, and logged at `error`**. Failing open keeps today's behaviour for a state the typed path rules out, and the log makes it visible.

**What does and doesn't disable the tether.** Measured with `tsc --strict` against a reduced model of the union:

- **A single widening cast is refused**: `as NotificationType` on `type` is TS2345/TS2322, and `as CreateNotificationInput` on the object is TS2352. Both together, or `as unknown as CreateNotificationInput`, compile and disable the check.
- **Cast-free holes**, measured: (a) spreading a student input into a new object, then mutating its discriminant; (b) aliasing through a wider-typed reference and mutating; (c) `Object.assign({}, studentInput, { recipientType: 'teacher' as const })`, which types as `never`. `readonly` on the input's fields closes direct mutation of a parameter. It does not close (a), (b) or (c), because spread drops `readonly` and assignability ignores it. These three and the double cast are the holes. None occurs in `src` today; they are review-checklist items.
- **`Omit<CreateNotificationInput, …>`** flattens the union into one shape that fits neither variant. Passing the result to `createNotification` is a **compile error** (TS2345), not a silent widening. `notifyCancellation`'s `CancellationNoticeInput` is built this way today, so it must be rebuilt on the student variant. Every caller passes `'student'`, so nothing changes at runtime.
- **A variable `recipientType: RecipientType`** is checked soundly. TypeScript tests each possible value of the variable against the union. A teacher-valid type compiles, and a type outside `TeacherNotificationType` is TS2345.

The plan mutation-tests the tether against a realistic regression: a new teacher call site with a type outside the union, and the same site with the table entry deleted. The exact compiler error text for each is recorded.

## 5. Where each setting takes effect

**When a booking is created** (`POST /api/registrations`, in the booking transaction). Inside that transaction, the teacher's `bookingNotifications` is read with a plain unlocked read (`teacherId` comes from the class's entry). If the teacher changes the setting while a booking is in flight, the booking sees either the old value or the new one. Both outcomes are acceptable, so no `Teacher` lock is taken, and `docs/lock-order.md` gains no new edge. When the value is `off`, the teacher's entry is left out of the `createBulkNotifications` batch, and the student's `booking_confirmed` is still created. This is the only setting that applies at creation time. It is the same kind of check as `StudentPrivacy.receiveComms` for announcements.

- **Consequence:** with `off`, nothing downstream sees a row. That covers the sweep, the inbox, SSE, the unread dot, retention, the dispatch cap, and the GDPR erasure that rewrites teacher `booking_confirmed` bodies. None of them changes.
- **Not retroactive:** switching to `off` deletes nothing already created. Rows created while the setting was on stay in the inbox. The sweep still applies the *current* setting to their email (below).

**When the sweep sends emails** (`processEmailFallback`, teacher branch). It selects `email` and the three columns, then sets `emailEnabled = shouldEmailTeacher(type, prefs)`. When that is false, the row takes the existing skip path: it is logged as `opted-out` and marked sent, so it is never retried. The setting is read when the email is sent, not when the notification was created, which matches the student branch. A booking created at 10:00 is not emailed at 10:30 if the teacher turned booking email off at 10:05.

- `inbox_only` and `off` both make `booking_confirmed` email false. That is what lets `off` also be correct for rows created before the switch.
- The unread threshold and urgent window are unchanged for both kinds of recipient.

## 6. Write path

- **`updateTeacherSchema`** (`src/lib/schemas.ts`) gains three optional fields: `bookingNotifications: z.enum(TeacherBookingNotifications)` (built from the Prisma enum, so no second list exists to drift) and two `z.boolean()`s. It stays `.strict()`.
- **`PUT /api/teachers/[id]`** writes them unchanged. Ownership is `session.teacherId === id`, so another teacher gets a 403. A body with only these fields skips the slug check and goes straight to the plain `prisma.teacher.update`. The route takes no lock of its own, and these columns add none.
- **No `respondUnchanged`.** This route has none, and re-saving the same settings answers 200 with the row, as a re-saved profile does today.

## 7. UI

**Settings index** (`src/app/(teacher)/settings/page.tsx`): a `Notifications` entry in `SETTINGS_ITEMS`, placed before `Profile`.

**`/settings/notifications`** is a server page that loads the three columns and renders a client form, in the same structure as `/account/notifications` and `NotificationsForm`. It has one save button, a settled notice on success, and `readErrorMessage` / `logRequestFailure` on failure, matching the student form.

- **New booking:** a `<fieldset>` with a `<legend>` and three native radio inputs (`accent-teal`, minimum height 48px per row). Labels: "In the inbox, and emailed if I miss it" / "In the inbox only" / "Off". A caption under the group: "Bookings always show on your schedule — this only changes whether you're told about each one." The repo has no radio component yet. This page uses native inputs styled like the student checkbox, and does not add a component used in one place only.
- **Class completed:** checkbox, "Email me when I miss a class-completed summary".
- **Invitation from another teacher:** checkbox, "Email me when I miss an invitation".
- **Class auto-cancelled:** text, no control. "Always emailed if you miss it — so you know the class won't run."
- **Copy and layout:** Georgia headings and system-sans body, following `docs/design-brief.md`. No hover motion, and danger colour is used for errors only.

**Information architecture:** `docs/information-architecture.md`'s Settings tree already lists "Notifications → Per-event email on/off toggles". That line is updated to describe the shipped controls. The tree's other missing entries (Reporting, Recurring, Studio) are not this issue's to fix.

## 8. Tests

Test-first throughout. Each guard named here gets a mutation step in the plan: break it, record the failure, restore it, re-run.

- **Unit (`notification-policy`):** `shouldEmailTeacher` for every `TeacherNotificationType` × each value of its own setting. Every other setting is held at a value that would flip the result if the function read the wrong column. Also, `class_cancelled` returns true when every setting is off.
- **Integration: booking.** With `bookingNotifications: 'off'`, a booking creates the student's `booking_confirmed` and no teacher row. With `inbox_only`, the teacher row exists. Each value is asserted through the stored rows, not the response.
- **Integration: sweep.** For each optional type with its setting off, the row is marked sent and no email is sent (asserted through the email transport the existing fallback tests use). `class_cancelled` with every setting off is still emailed. A student row is unaffected by teacher settings.
- **Integration: PUT.** Each field round-trips. An invalid enum value gets a 400. Another teacher gets a 403. An unknown key is refused by `.strict()`.
- **Component:** the form renders the stored values, submits exactly the three fields, clears the saved notice on edit, and shows the server's error message.
- **Type tether:** proved by mutation (§4), not by a runtime test.

## 9. Docs updated in the same branch

- `docs/data-model.md`: the Teacher table gains the three columns. The paragraph beginning "The teacher branch consults no email preference" becomes false and is **replaced** with what is true now, including where the policy lives.
- `CLAUDE.md` (Communication, layer 3): states that teachers choose email per optional event, and that an auto-cancel is emailed if missed, whatever the settings.
- `docs/teacher-screens.md` 9.4: describes the shipped screen.
- `docs/information-architecture.md`: the Settings → Notifications line.
- **Not edited:** `2026-07-21-notification-delivery-policy-design.md` ("no teacher-facing knobs") and the dispatch-cap spec §10. These are records of past decisions, not live documentation.

## 10. Out of scope

- Class-reminder timing (`defaultReminder`, `reminderPref`): #721.
- Turning off the inbox entry for any type except new booking.
- Per-class or per-student notification settings.
- `payment_received`, which is never created. If a writer for it is ever added with a teacher recipient, the tether in §4 forces a policy decision for it at that point.
