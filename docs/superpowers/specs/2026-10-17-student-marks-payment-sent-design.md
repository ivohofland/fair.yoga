# Student marks a Level 1 payment as sent (#898)

## Goal

A student who paid by bank transfer, EPC QR, the teacher's open-ended payment
link (#785) or in cash can say so. The claim silences the *automatic*
reminders, and tells the teacher which payments to look for. Only the teacher's
confirmation makes a payment `paid`.

## Decisions (agreed with the maintainer, 2026-10-17)

| Open question in the issue | Decision |
|---|---|
| Does a claim keep a payment out of `overdue`? | **No.** `markOverduePayments` is untouched; a claim only silences the automatic reminders. The teacher row's `! Says paid` styling exists precisely because a claimed payment can still be overdue. |
| Does a claim expire? | **No.** It stands until the teacher acts on that payment — no timer, no staleness. |
| Notify the teacher when a student marks sent? | **No.** Claimed rows sort first on the teacher's lists; that is the signal. |
| Copy | Button **"I've sent it"**; afterwards **"You marked this as sent on 17 Oct"** with **Undo**. Teacher line **"Says paid · 12 Oct"**. |
| GDPR export | `studentReportedAt` is in the student's export beside the payment. |

"Until the teacher acts" means: **Not received** and **Not charged** (including
the archive-time waive) clear the claim. **Confirm** (mark paid) keeps the
timestamp as the student's half of the record, and **reopen** (`paid →
pending`) leaves it alone too, so a reopened confirmation is back to awaiting
confirmation. Reopen is also the row's transient Undo after Mark paid, so
clearing there would let one mis-tap erase the claim the teacher meant to check.
A reopen from `not_charged` finds the claim already cleared by the waive.

## What the issue got wrong or left out (measured 2026-10-17)

The premise holds — `PaymentStatus` is `pending | paid | overdue | not_charged`,
students have no "I've paid" action and no student payment route exists, and
there is no processor code (#896 is not built; Mollie/Stripe exist only as
dormant schema fields). Corrections:

1. **Three reminder paths, not one.** The cron (`sendPaymentReminders`,
   `src/services/payment-reminders.ts`), the teacher's manual reminder
   (`sendPaymentReminder`, `src/services/payments.ts`), and
   `resumePayments` (`src/services/payout-resume.ts`), which reminds every
   outstanding payment when a teacher resumes. The two automatic ones — cron and
   resume — skip a claimed payment; the manual one still sends, as the issue says.
2. **The class checklist shows overdue differently.** `payment-checklist.tsx`
   renders the full `paymentStateText` label on its own line, not the inline
   ` · ! overdue` text, and has no "Not charged" action. "Drop the inline
   overdue for claimed rows" applies to `outstanding-payment-row.tsx`; in the
   checklist the claim line *replaces* the status label.
3. **A third teacher surface.** `student-payment-list.tsx` (`/students/[id]`)
   also lists outstanding payments with "Mark paid". It shows the claim line;
   its actions are unchanged.
4. **"Not received" is a new write**, with its own compare-and-swap and route;
   no existing transition clears anything but status.
5. **The outstanding list is ordered by the page's own query** (`createdAt
   desc`, `settings/payments/page.tsx`), not by a service.
6. **The pay page's zero-method case** ("Pay {name} directly") has no method
   rows. Cash is a manual payment too, so the button renders there as well —
   below the methods or that line, for every outstanding, unpaused payment.
   A paused page shows no methods and no button.

## Data

`Payment.studentReportedAt DateTime?` — one migration, no backfill, no CHECK.
A CHECK tying it to status is deliberately absent: a `paid` row keeps the
timestamp (the record), so the column is legal on every status.

"Awaiting confirmation" is derived, never stored: `status ∈ {pending, overdue}
AND studentReportedAt IS NOT NULL` — one predicate, `isClaimStanding` in
`src/lib/payment-claim.ts` (built on `isOutstanding`, `src/lib/payment-status.ts`),
read by every display surface. The Prisma WHEREs (reminder read, stamp swap,
resume) each spell `studentReportedAt: null` themselves.

## Services (`src/services/payments.ts`)

All three are a conditional `updateMany` with the guard in the WHERE, then a
re-read that classifies a miss — the file's existing idiom, including its
fallback: a re-read that finds a state the swap would have accepted answers
`CONCURRENT_MODIFICATION` (`PAYMENT_CHANGED`). The two student services re-read
with `findFirst({ id, registration: { studentId } })`, never by `id` alone, so
another student's payment answers `NOT_FOUND` whatever its state.

Refusal copy is per door: a code keeps one meaning, the message is the reader's.
The student doors use their own messages:

| Code | Student message |
|---|---|
| `PAYMENT_ALREADY_PAID` | "Your teacher has already marked this payment as received." |
| `PAYMENT_WAIVED` | "Your teacher isn't charging for this class." |
| `NOT_FOUND` | "This payment no longer exists." (`PAYMENT_GONE`, shared) |
| `CONCURRENT_MODIFICATION` | "This payment just changed. Reload the page and try again." |

- **`reportPaymentSent(db, paymentId, studentId)`** — WHERE `id`,
  `registration.studentId = studentId`, `status in (pending, overdue)`,
  `studentReportedAt null` → set `now`. Miss: no row, or not this student's →
  `NOT_FOUND` (never reveal another student's payment); already reported and
  outstanding → `unchanged`; `paid` → `PAYMENT_ALREADY_PAID` (a refusal that
  makes the goal moot comes before `unchanged`, per the error-response rules —
  a paid row with no claim does not hold what the request asks for);
  `not_charged` → `PAYMENT_WAIVED`. No pause check:
  a claim moves no money and the button is not offered while paused.
- **`withdrawPaymentReport(db, paymentId, studentId)`** — WHERE owned,
  outstanding, `studentReportedAt not null` → `null`. Miss: not found/not owned
  → `NOT_FOUND`; outstanding and already null → `unchanged` (a null column is provable from the
  stored state; this is not a delete of a gone row, so it is not a 404); `paid` →
  `PAYMENT_ALREADY_PAID` (the teacher confirmed it; there is nothing to undo);
  `not_charged` → `PAYMENT_WAIVED`.
- **`rejectPaymentReport(db, paymentId)`** (teacher, "Not received") — one
  transaction: WHERE outstanding, `studentReportedAt not null` → set it `null`
  and stamp `reminderSentAt = now`, then one `reminder` notification to the
  student: title "Payment not seen yet", body "{Teacher} hasn't seen your
  payment of {amount} for {class} arrive yet. If you've sent it, it may still
  be on its way." Paused teacher → `PAYMENTS_PAUSED`, rolled back (same as the
  manual reminder: paused students are asked to hold off). Miss: already null →
  `unchanged` (this includes the student having withdrawn it themselves; the
  goal, no standing claim, holds either way); `paid` → `PAYMENT_ALREADY_PAID`; `not_charged` →
  `PAYMENT_WAIVED`; gone → `NOT_FOUND`.
  - **Why it stamps `reminderSentAt`:** the notice *is* a reminder. Without
    the stamp, an overdue payment whose last reminder is a week old gets the
    cron's "Payment outstanding" within the hour of "not seen yet" — two
    messages for one event.
  - **Why reuse `reminder`:** a new `NotificationType` touches six typed
    registries (push group, retention, email intro, essential/immediate sets,
    unsubscribe kind) for a message whose policy is identical to `reminder`'s —
    optional, `payments` push group. Accepted consequences: the fallback email
    opens "A gentle reminder." and carries the "Pay now" button to the pay page
    (where the student can mark it sent again); the push lock screen shows the
    money group's fixed line, not the body; the email-time pause check applies.
  - **Erasure:** like `sendPaymentReminder`, the action does not check
    `student.deletedAt`. An erased student's payment keeps `studentReportedAt`,
    since erasure keeps payments as the teacher's bookkeeping (`gdpr.ts`), and
    the column is a fact about the payment, not profile data.
- **`markPaymentNotCharged`** and the archive waive (`student-archive.ts`) also
  write `studentReportedAt: null`. **`markPaymentPaid` and `reopenPayment` leave
  it.**

`PaymentRefusal`'s code union is unchanged — every refusal above uses a code it
already names.

## Automatic reminders

`readDuePayments` and the per-payment stamp CAS in `sendPaymentReminders` add
`studentReportedAt: null` (the CAS too, so a claim landing between the read and
the stamp is honoured); `resumePayments`'s outstanding select adds the same, so a claimed student gets
no "You can pay now" message on resume (they said they already paid).

Notifications written *before* a claim (the completion `payment_request`, an
earlier reminder) still email on the 30-minute fallback if unread. Accepted:
retracting sent notifications is out of proportion to a claim.

## Routes

- `POST /api/payments/[id]/sent` and `DELETE /api/payments/[id]/sent` —
  `requireStudent`; ownership is inside the service's WHERE.
- `POST /api/payments/[id]/not-received` — `requireTeacher` + `loadOwnedPayment`
  + `respondPaymentOutcome`, like `/remind`.

## UI

- **Dates** are formatted in `teacher.defaultTimezone` everywhere, as the pay
  page's "Marked paid …" line already is — `Student` has no time zone.
- **Pay page** (`(student)/bookings/[classId]/pay/page.tsx`): a client
  `MarkSentControl` below the methods (or the pay-directly line) on an
  outstanding, unpaused payment. Unclaimed: a secondary button "I've sent it".
  Claimed: "You marked this as sent on 17 Oct" and an Undo text button. It
  POSTs/DELETEs and `router.refresh()`es; any refusal shows its message and
  refreshes, so a paid or waived payment re-renders as such.
- **Teacher claim line** — `PaymentClaimLine` (`src/components/class/`):
  overdue → `! Says paid · 12 Oct` in `text-danger`; pending → `Says paid · 12
  Oct` in brown. An `sr-only` prefix carries the state ("Overdue, says paid on
  12 October" / "Says paid on 12 October") so it is not colour alone (WCAG
  1.4.1); the visible text is `aria-hidden`.
- **Client state.** The claim line shows only while the row's *local* status is
  outstanding and the claim is set; "Not received" clears the local claim; the
  Undo after Mark paid returns the row to outstanding with the claim intact,
  which is what the server holds too (reopen keeps it).
- **`outstanding-payment-row.tsx`**: claim line under the class line, the
  ` · ! overdue` suffix dropped for claimed rows. Actions on a claimed row:
  "Not received · Send reminder · Not charged"; the pill keeps its "Mark paid"
  label (that is the confirmation).
- **`payment-checklist.tsx`**: the claim line replaces the status label on a
  claimed row; actions "Not received · Send reminder".
- **`student-payment-list.tsx`** (lists every payment with this teacher): the
  claim line on a claimed outstanding row; actions unchanged.
- **Resume review** (`readResumeReview` / `ReviewPayment`,
  `payout-resume.ts`, and its screen): outstanding rows carry
  `studentReportedAt` and show the claim line. A claim made while payouts may
  have pointed at a changed account is exactly what the teacher checks before
  resuming.
- **Student status label**: on `/bookings` (past classes) and in the pay
  page's header, a standing claim reads "Marked as sent" in brown in place of
  the status (`studentPaymentStateText`, `src/lib/payment-claim.ts`). Teacher
  surfaces keep the overdue mark; the student has done their part.
- **`/bookings` action**: a standing claim replaces Pay now (or the
  pay-directly line) with a "View payment →" link to the pay page, where Undo
  is. While payments are paused the row keeps its hold-off line instead: the
  pay page then shows only the hold-off copy, with no claim line to link to.
- **Ordering**: claimed outstanding payments first on the settings outstanding
  list (the page's own query/split) and in the checklist (the overview page's
  `registeredAt asc` items); the existing order holds within each group.

## Docs

`docs/data-model.md` (Payment table and notes), `docs/product-concept.md` §7
(Level 1 tracking, Payment reminders), `docs/lock-order.md`: the `Payment`
writer census (which also lacks `payout-resume.ts`'s stamp today), the
`createBulkNotifications` call-site table, and the note on sites that take no
`Class` lock — `rejectPaymentReport` has `sendPaymentReminder`'s shape (holds
the `Payment` row, `FOR KEY SHARE` on the class via `relatedClassId`) and adds
no edge; it never touches `TeacherStudent`, so it cannot cycle with reopen or
the archive.

## Tests to expect red

`PAYMENT_ROW_KEYS` (`tests/integration/payments-api.test.ts`) gains
`studentReportedAt` deliberately — the teacher should see it — not by widening.

## Not in scope

- The archive dialog's list of payments it will waive does not mark claimed
  ones.
- A teacher notification for a claim (decided against above).
- Level 2 (#896 is unaffected).
