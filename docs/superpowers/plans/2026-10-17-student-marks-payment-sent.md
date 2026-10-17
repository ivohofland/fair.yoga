# Student marks a Level 1 payment as sent — implementation plan (#898)

**Spec:** `docs/superpowers/specs/2026-10-17-student-marks-payment-sent-design.md`.
It is the binding authority: exact copy, outcome mappings, and which writers clear
the claim live there. Read it before any task.

## Global constraints

- TypeScript strict, no `any`. Services in `src/services/` take a `PrismaClient`
  and return typed outcomes (`PaymentOutcome`); no HTTP in services.
- Test-first: write the failing test, watch it fail, implement, watch it pass.
- **Prove every new guard bites**: for each WHERE term or filter added
  (`studentReportedAt: null` in the reminder read, the stamp swap, the resume
  select; the `registration.studentId` ownership term; the scoped re-read),
  remove it, run the covering test, record the exact failure text in the task
  report, restore, re-run green.
- Comment discipline (CLAUDE.md): comments annotate their own code; no counts
  or rosters in comments; no "previously" history.
- Migrations via `pnpm exec prisma migrate dev --name <name>`; never edit an
  applied migration.
- Stage exact paths, quoting `(student)` / `(teacher)`. Never `git add -A`.
- Worktree: integration tests run against this worktree's app
  (`INTEGRATION_BASE_URL` is read automatically; the app is already up).
  Inner loop: `pnpm exec vitest run --project <unit|components|integration> <path>`.
  Node 24 is required: prefix PATH with the nvm v24 bin.
- Design system: payment states are text only, never badges; `text-danger` for
  overdue; brown for pending; six type styles only; no motion.

## Task order

Tasks 1 → 2 → 3 → 4 → 5 → 6, strictly: 2 and 3 use Task 1's column and
services; 4 and 5 call Task 3's routes; 6 documents what exists.

## Task 1: Column, predicate, and the three claim services

**Files:** `prisma/schema.prisma`, a new migration, `src/lib/payment-claim.ts`
(+ unit test), `src/services/payments.ts`, `src/services/payments.test.ts`,
`src/services/student-archive.ts` (+ its test), `src/services/gdpr.ts`
(+ its test).

1. Add `studentReportedAt DateTime?` to `Payment`; create the migration
   (`--name payment_student_reported_at`).
2. `src/lib/payment-claim.ts`: `isClaimStanding({ status, studentReportedAt })`
   — true iff `isOutstanding(status)` (`src/lib/payment-status.ts`) and the
   timestamp is non-null. Unit-test all four statuses × set/unset.
3. In `payments.ts`, implement `reportPaymentSent(db, paymentId, studentId)`,
   `withdrawPaymentReport(db, paymentId, studentId)` and
   `rejectPaymentReport(db, paymentId)` exactly per the spec's Services section:
   conditional `updateMany`, re-read on a miss (scoped to the student for the
   two student services), exhaustive `switch` with a `never` default, the
   `CONCURRENT_MODIFICATION` fallback, the per-door student messages from the
   spec's table. `rejectPaymentReport` runs in one transaction: clear the claim
   and stamp `reminderSentAt`, refuse `PAYMENTS_PAUSED` after the stamp (rolled
   back, mirror `remindInTransaction`), and create one `reminder` notification
   with the spec's title/body (amount formatted the way `remindInTransaction`
   formats it; same `relatedClassId`/link fields as the manual reminder).
4. `markPaymentNotCharged` and the archive waive also set
   `studentReportedAt: null`. `markPaymentPaid` and `reopenPayment` are not
   changed — add tests that pin that they keep the timestamp.
5. `exportStudentData`: add `studentReportedAt` to the payment select; extend
   its test.
6. Tests in `payments.test.ts` for every outcome the spec lists per service,
   including: another student's payment → `NOT_FOUND` regardless of its status
   (paid, waived, outstanding); report on paid → `PAYMENT_ALREADY_PAID`; reject
   when paused → refused and nothing written (claim still set, no notification);
   reject creates exactly one `reminder` and stamps `reminderSentAt`.

## Task 2: Automatic reminders skip a standing claim; resume review carries it

**Files:** `src/services/payment-reminders.ts` (+ test),
`src/services/payout-resume.ts` (+ test).

1. `readDuePayments` (and its paged read, if separate) and the per-payment
   stamp swap in `sendPaymentReminders` add `studentReportedAt: null`. Test: a
   claimed overdue payment gets no reminder and no stamp; an unclaimed one in
   the same run does. Test the race: a payment read as due, then claimed before
   the stamp, is not reminded (drive it the way existing tests in that file
   drive mid-run state, if any; otherwise call the stamp step directly).
2. `markOverduePayments` is NOT changed — test that a claimed pending payment
   past 7 days still becomes `overdue`.
3. `resumePayments`: its outstanding select adds `studentReportedAt: null`;
   test that a claimed student gets no resume reminder. `readResumeReview`'s
   select and the `ReviewPayment` type carry `studentReportedAt`; test it is
   returned.

## Task 3: Routes

**Files:** `src/app/api/payments/[id]/sent/route.ts` (POST, DELETE),
`src/app/api/payments/[id]/not-received/route.ts` (POST), integration tests in
`tests/integration/payments-api.test.ts` (or a new
`tests/integration/payment-claim-api.test.ts`).

1. `/sent`: `withErrorHandler`, `requireStudent`, call the service with the
   session's `studentId`, answer through `respondPaymentOutcome`
   (`src/app/api/payments/[id]/shared.ts`) or a sibling that maps the same
   way. No body.
2. `/not-received`: mirror `/remind` exactly (`requireTeacher`,
   `loadOwnedPayment`, `respondPaymentOutcome`).
3. Integration tests: student marks sent (200 applied), again (200 unchanged),
   undo (200), undo again (unchanged); another student → 404; teacher session
   on `/sent` → 403; paid → 409 `PAYMENT_ALREADY_PAID`; waived → 409
   `PAYMENT_WAIVED`; teacher not-received → 200 and claim cleared; other
   teacher → 404. Assert codes, not messages (CLAUDE.md).
4. `PAYMENT_ROW_KEYS` gains `studentReportedAt` deliberately (spec, "Tests to
   expect red"). Check `write-handler-wrap-census.test.ts` and
   `cross-origin.test.ts` for route censuses the new handlers must join.

## Task 4: Student pay page

**Files:** `src/components/student/mark-sent-control.tsx` (+ components test),
`src/app/(student)/bookings/[classId]/pay/page.tsx`,
`tests/integration/pay-page.test.ts`, a date-line helper beside
`markedPaidLine` in `src/lib/pay-page.server.ts` (+ its test).

1. `MarkSentControl` (client): props `paymentId`, `claimedLine: string | null`.
   Unclaimed → secondary button "I've sent it" (POST). Claimed → the line and
   an "Undo" text button (DELETE). On success or refusal, `router.refresh()`;
   a refusal's message shows in a polite live region until the refresh.
2. Pay page renders it on an outstanding, unpaused payment, below the method
   rows or the pay-directly line. Date in `teacher.defaultTimezone` ("You
   marked this as sent on 17 Oct").
3. Tests: component states and requests; pay page shows the button when
   outstanding, the line when claimed, nothing when paid/not_charged/paused.

## Task 5: Teacher surfaces

**Files:** `src/components/class/payment-claim-line.tsx` (+ test),
`src/components/class/outstanding-payment-row.tsx`,
`src/components/class/payment-checklist.tsx`,
`src/components/students/student-payment-list.tsx`, the resume review screen
component, `src/lib/use-payment-actions.ts`,
`src/app/(teacher)/settings/payments/page.tsx`,
`src/app/(teacher)/class/[id]/(overview)/page.tsx`, and their tests.

1. `PaymentClaimLine` per spec: overdue → `! Says paid · 12 Oct`,
   `text-danger`; pending → `Says paid · 12 Oct`, brown; visible text
   `aria-hidden`, `sr-only` "Overdue, says paid on 12 October" / "Says paid on
   12 October". Date in the teacher's zone.
2. `use-payment-actions`: add `notReceived` (POST `/not-received`) and the
   local claim state per the spec's Client state bullet.
3. Outstanding row: claim line, suffix dropped when claimed, action order
   "Not received · Send reminder · Not charged". Checklist: claim line replaces
   the status label; "Not received · Send reminder". Student list: claim line
   only. Resume screen: claim line on claimed outstanding rows.
4. Claimed-first ordering on the settings outstanding list and the checklist,
   stable within groups.
5. Tests for each surface (components project) and the ordering (integration
   page test or a pure sort helper with a unit test).

## Task 6: Docs

**Files:** `docs/data-model.md` (Payment table + notes),
`docs/product-concept.md` §7 (Level 1 tracking, Payment reminders),
`docs/lock-order.md` (Payment writer census incl. the missing
`payout-resume.ts` stamp — re-derive with the doc's own command and show the
arithmetic; `createBulkNotifications` table; the no-`Class`-lock note).
State only what the code now does.
