# Payout resume: reminders lock classes in ascending order (#883)

## Problem

`resumePayments` (`src/services/payout-resume.ts`) writes one reminder per owed
payment in one `createMany`, each carrying its class as `relatedClassId`. The
foreign key's RI check takes `FOR KEY SHARE` on each parent `Class` row, in
the order of the `data` array — which is the order `tx.payment.findMany`
returned the owed payments, and that query has no `orderBy`.

`deleteStudentAccount` (`src/services/gdpr.ts`) takes `FOR UPDATE` on every
class its subject holds a `WaitlistEntry` of any status on, in one ascending
statement (`lockClassRowsOrdered`). A `claimed`/`promoted` entry on a
completed class is in that set. A student owing one teacher on two such
classes, erased while that teacher resumes, can close a cycle: erasure holds
the lower `FOR UPDATE` and waits on the higher; resume holds the higher
`FOR KEY SHARE` and waits on the lower. Postgres aborts one side (`40P01`).

## Premise, as measured

- **Holds:** the owed-payment read has no `orderBy` (`payout-resume.ts`, the
  `owed` `findMany`); `createBulkNotifications` passes its inputs to
  `notification.createMany` in array order, without re-sorting
  (`services/notifications.ts`).
- **Holds:** the erasure's pre-lock covers every waitlist status, ascending by
  `c.id` (`gdpr.ts`, `lockClassRowsOrdered` call with `CLASS_TO_WAITLIST_JOIN`).
- **Checked, and no second edge:** the resume's other writes in that
  transaction — `teacher.update`, `payoutPauseToken.deleteMany`,
  `payment.updateMany` of `reminderSentAt` — change no foreign-key column,
  so they take no `FOR KEY SHARE` on `Class`. The erasure writes no `Payment`
  row after its pre-lock. What it writes there (`deleteStudentAccount`,
  `gdpr.ts`): `Registration` status and `cancelledAt` for upcoming classes,
  `StudentPrivacy` and `TeacherStudent` deletes, `WaitlistEntry` deletes and
  position renumbering of other students' rows, `Invitation` scrubs, the
  student's `Notification` deletes and the teachers' `booking_confirmed`
  body scrub, the student's `Account` sign-out, passkey, token and email
  writes, `MagicLinkToken` and `HandoffAttemptBudget` deletes, the
  `Announcement.audienceStudentIds` scrub, and the `Student` update. None of
  them changes a foreign-key column into `Class` or `Payment`, so none
  contends with the resume's `FOR KEY SHARE` on `Class` or its `Payment`
  row locks. `Class` is the only shared node.
- **Not reproduced before this change:** the issue says so; this branch's test
  is the first reproduction.

## Design

Order the owed-payment read by the class it belongs to, ascending:
`orderBy: { registration: { classId: 'asc' } }`. The reminders are built from
that array in order, so the `FOR KEY SHARE` locks arrive in ascending class id
— the direction of every ordered `FOR UPDATE` locker. Two transactions taking
row locks on a shared set in one direction cannot wait on each other in a
cycle through that set. The resume orders by `Registration.classId` and the
lockers by `Class.id`: both are Postgres `ORDER BY` on the same id values, so
they share a collation.

Alternatives rejected:
- **Sort in JS after the read** — `String.prototype` comparison is code-unit
  order, Postgres's is the column's collation; the two can disagree, and the
  guarantee is "same direction as `ORDER BY c.id`".
- **Pre-lock the classes `FOR KEY SHARE` in an ordered raw statement** — the
  same guarantee with an extra round trip and a second statement to keep in
  step with the read.

## The residual this does not change

In the staged shape, after the fix the resume waits for the erasure to commit
and then inserts its reminder for the erased profile. That is not new: any
resume whose owed-payment read precedes an erasure's commit and whose insert
follows it does the same today, and `Notification.recipientId` has no foreign
key to `Student`. It is the residual `docs/lock-order.md` already accepts for
an announcement send ("A send that read before the erasure and commits after
the scrub writes the id back"), retained until the one-year inbox sweep. The
doc paragraph names it rather than leaving it implied.

## Test

A case in `src/services/payout-resume-lock-order.test.ts` (serial tier
already), using the real `deleteStudentAccount` and `resumePayments`:

1. Teacher (paused, no passkey), student, two completed classes with a
   registration, a pending `Payment` and a `claimed` `WaitlistEntry` each;
   `lo`/`hi` named by comparing the two class ids in Postgres order.
2. Connection C holds `hi` `FOR NO KEY UPDATE` — conflicts with the erasure's
   `FOR UPDATE`, not with a `FOR KEY SHARE`.
3. Start the erasure; wait until it is blocked by C. It now holds `lo`.
4. Start the resume; wait until it is blocked by the erasure.
5. Release C. Assert the erasure answers erased and the resume `resumed`.

Before the fix, the resume (reading `hi` first) holds `hi` `FOR KEY SHARE`
when C releases, the erasure waits on it, and one side fails `40P01`. The
pre-fix order is the planner's, so the guard is proven against a
deterministic mutation — `classId: 'desc'` — and against the removal of the
`orderBy`, both recorded.

## Docs

`docs/lock-order.md`: the notification-site table row for `resumePayments`
states its order; the "takes `FOR KEY SHARE` on many classes in no order"
paragraph becomes the rule the ordering keeps, pinned by the test; the
"fourth path" passage's "and with no order" is corrected.
