# Payment reminders: the promised button, finally wired

**Date:** 2026-07-23
**Status:** Approved (issue #43; placement A and design approved by Ivo;
autonomous run — remaining decisions recorded here)

## Problem

`POST /api/payments/[id]/remind` is fully built — `sendPaymentReminder`
transactionally creates the student's `reminder` notification (which
rides the three-layer comms model) and stamps `reminderSentAt`, which
also spaces the automatic dunning cron. The docs promise the button in
two places (teacher-screens 7.2, IA Flow 4). No front-end ever called
it.

## Decisions

- **One standalone component**, `SendReminderButton({ paymentId,
  reminderSentAt })` in `src/components/class/send-reminder-button.tsx`,
  sibling to `MarkPaidButton`/`MarkUnpaidButton`. It does not extend
  `usePaymentActions`: reminding never changes paid-state, so it owns
  its busy/error/remindedAt state locally.
- **Two mounts** (placement A): the class detail payment checklist
  (each unpaid row) and the `/settings/payments` Outstanding rows,
  beside "Mark paid". Paid rows never show it — nothing to remind.
- **No enforced cooldown; visible history instead.** The button stays
  enabled ("Send reminder", words only, no icon; "Sending..." while
  busy). When `reminderSentAt` is set, a `type-caption` line reads
  `Reminded {timeAgo}` using the existing `timeAgo` helper. Manual
  sends already delay the next automatic cron reminder via the same
  stamp, so over-reminding is partly self-limiting server-side.
- **Local state only, no `router.refresh`.** The row doesn't move
  sections on remind; the caption updates from the POST response's
  `reminderSentAt`. (Also sidesteps the #40 dropped-refresh class.)
- **Failure**: inline `text-danger` message, button re-enabled — the
  `mark-unpaid-button` pattern. No optimistic stamp.
- **Data plumbing**: `PaymentItem` (payment checklist) gains
  `reminderSentAt: Date | null`, mapped on the class page; the settings
  page already loads full payment rows.

## Testing

- Integration (first HTTP tests for the remind route — the #53 payments
  slice): 401 signed out; 404 unknown payment; 403 another teacher's
  payment; 200 → `Notification` row created (recipient = the student,
  type `reminder`) and `reminderSentAt` stamped, returned non-null in
  the response.
- E2e (`teacher-journey.spec.ts`, serial chain after class completion):
  the class checklist's unpaid row sends a reminder → "Reminded just
  now" caption appears without reload; the notification row is asserted
  in the DB (the recipient is the unclaimed walk-in student, who has no
  session — `/updates` rendering of notifications is already covered by
  the existing updates e2e). The payments-overview test additionally
  asserts the Outstanding row shows the button and the caption from the
  earlier send.
