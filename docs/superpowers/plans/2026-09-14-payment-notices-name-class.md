# Payment notices name the class (#202) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven development (`invoke_subagent`) to implement this plan task-by-task.

**Goal:** The four `payment_request` and `reminder` notification bodies name the class in full — type, day, time — via `formatDayHeader` and `timeToHHmm`, matching the standard established by #200 for cancellations.

**Architecture:** 
- Three service files updated (`class-lifecycle.ts`, `payments.ts`, `payment-reminders.ts`).
- Query selects widened in `payments.ts` and `payment-reminders.ts` to include `date` and `startTime` on `calendarEntry`.
- Date formatted with `formatDayHeader(entry.date)` from `@/lib/format`.
- Time formatted with `timeToHHmm(entry.startTime)` from `@/lib/time-of-day`.
- All four bodies tested in unit tests (`--project unit`) with separate substring assertions (`toContain`) for class type, day, time, and contextual wording.
- 8 mutations executed (2 per body: wholesale revert and dropped time field), error texts recorded in `docs/superpowers/plans/2026-09-14-payment-notices-name-class-mutations.md`.

**Tech Stack:** TypeScript strict, Prisma/PostgreSQL, Vitest (`unit` tier on `DATABASE_URL_TEST`).

## Exact Copy Specifications (Option A)

1. **Student payment request** (`src/services/class-lifecycle.ts:830`):
   ```ts
   body: `Your price for ${cls.calendarEntry.classType} class on ${formatDayHeader(cls.calendarEntry.date)} at ${timeToHHmm(cls.calendarEntry.startTime)} is €${s.price.toFixed(2)}. Pay your teacher directly.`,
   ```
2. **Teacher payment notice** (`src/services/class-lifecycle.ts:839`):
   ```ts
   body: `${cls.calendarEntry.classType} class on ${formatDayHeader(cls.calendarEntry.date)} at ${timeToHHmm(cls.calendarEntry.startTime)} completed — €${(pricing.totalCost - Number(cls.roomCost)).toFixed(2)} earnings, ${chargedRegistrations.length} payment ${chargedRegistrations.length === 1 ? 'request' : 'requests'} sent.`,
   ```
3. **Student manual reminder** (`src/services/payments.ts:302`):
   ```ts
   body: `€${Number(payment.amount).toFixed(2)} for ${registration.class.calendarEntry.classType} class on ${formatDayHeader(registration.class.calendarEntry.date)} at ${timeToHHmm(registration.class.calendarEntry.startTime)} is still open. Pay your teacher directly.`,
   ```
4. **Student automated reminder** (`src/services/payment-reminders.ts:90`):
   ```ts
   body: `€${Number(payment.amount).toFixed(2)} for ${payment.registration.class.calendarEntry.classType} class on ${formatDayHeader(payment.registration.class.calendarEntry.date)} at ${timeToHHmm(payment.registration.class.calendarEntry.startTime)} is still open. Pay your teacher directly.`,
   ```

## Global Constraints

- **`formatDayHeader`, never `formatDateShort`.** #96 standardized on `formatDayHeader` across the app.
- **`timeToHHmm`, never raw `startTime`.** `startTime` is `@db.Time` (JS Date), requiring `timeToHHmm(...)`.
- **Three separate `toContain`s** rather than whole-string equality: type, formatted day, formatted time, plus sentence context.
- **Every guard is broken and watched to fail**, exact error recorded, restored, re-verified.
- **No `any`, no `@ts-ignore`, no type assertions silencing the compiler.**
- **Stage exact paths**, never `git add -A`.

---

### Task 1: Student payment request and teacher payment notice in `class-lifecycle.ts`

**Files:**
- Modify: `src/services/class-lifecycle.ts:830,839`
- Test: `src/services/class-lifecycle.test.ts` (extend `calculates pricing and creates payments for charged registrations`)

**Steps:**
1. In `src/services/class-lifecycle.test.ts`, extend the test `calculates pricing and creates payments for charged registrations` to assert the student and teacher notification bodies:
   - For student notes: assert `body` contains `entry.classType`, `formatDayHeader(entry.date)`, `timeToHHmm(entry.startTime)`, and `is €... Pay your teacher directly.`.
   - For teacher note: assert `body` contains `entry.classType`, `formatDayHeader(entry.date)`, `timeToHHmm(entry.startTime)`, and `completed — €... earnings`.
2. Run test to verify RED:
   ```bash
   pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t 'calculates pricing and creates payments'
   ```
   Expect FAIL on `formatDayHeader(entry.date)`.
3. In `src/services/class-lifecycle.ts`:
   - Import `formatDayHeader` from `@/lib/format` (note: `timeToHHmm` is already imported at line 26).
   - Update student notification `body` at line 830.
   - Update teacher notification `body` at line 839.
4. Run test to verify GREEN:
   ```bash
   pnpm exec vitest run --project unit src/services/class-lifecycle.test.ts -t 'calculates pricing and creates payments'
   ```
5. Prove guards bite (mutations 1-4):
   - Mutation 1: Student body reverted to old text -> test fails on day substring.
   - Mutation 2: Student body drops ` at ${timeToHHmm(cls.calendarEntry.startTime)}` -> test fails on time substring.
   - Mutation 3: Teacher body reverted to old text -> test fails on day substring.
   - Mutation 4: Teacher body drops ` at ${timeToHHmm(cls.calendarEntry.startTime)}` -> test fails on time substring.
   - Restore and re-verify GREEN.
6. Commit:
   ```bash
   git add src/services/class-lifecycle.ts src/services/class-lifecycle.test.ts
   git commit -m "fix(lifecycle): payment request notices name class in full (#202)"
   ```

---

### Task 2: Student manual payment reminder in `payments.ts`

**Files:**
- Modify: `src/services/payments.ts:290,302`
- Test: `src/services/payments.test.ts` (extend `sendPaymentReminder stamps and notifies an outstanding payment`)

**Steps:**
1. In `src/services/payments.test.ts`, extend `sendPaymentReminder stamps and notifies an outstanding payment`:
   - Assert `notification.body` contains `'Hatha'`, `formatDayHeader(cls.calendarEntry.date)`, `'09:00'`, and `'is still open. Pay your teacher directly.'`.
2. Run test to verify RED:
   ```bash
   pnpm exec vitest run --project unit src/services/payments.test.ts -t 'sendPaymentReminder stamps and notifies'
   ```
   Expect FAIL on day assertion.
3. In `src/services/payments.ts`:
   - Import `formatDayHeader` from `@/lib/format` and `timeToHHmm` from `@/lib/time-of-day`.
   - In `sendPaymentReminder`: widen select on `calendarEntry` to `{ classType: true, date: true, startTime: true }`.
   - Update reminder `body` at line 302.
4. Run test to verify GREEN:
   ```bash
   pnpm exec vitest run --project unit src/services/payments.test.ts -t 'sendPaymentReminder stamps and notifies'
   ```
5. Prove guards bite (mutations 5-6):
   - Mutation 5: Manual reminder reverted to old text -> test fails on day substring.
   - Mutation 6: Manual reminder drops ` at ${timeToHHmm(...)}` -> test fails on time substring.
   - Restore and re-verify GREEN.
6. Commit:
   ```bash
   git add src/services/payments.ts src/services/payments.test.ts
   git commit -m "fix(payments): manual payment reminder names class in full (#202)"
   ```

---

### Task 3: Student automated payment reminder in `payment-reminders.ts`

**Files:**
- Modify: `src/services/payment-reminders.ts:59,90`
- Test: `src/services/payment-reminders.test.ts` (extend `sendPaymentReminders sends reminders for overdue payments`)

**Steps:**
1. In `src/services/payment-reminders.test.ts`, extend the body assertions in `sendPaymentReminders sends reminders for overdue payments`:
   - Assert `note.body` contains `'PayRem Hatha'`, `formatDayHeader(cls.calendarEntry.date)`, `'09:00'`, and `'is still open. Pay your teacher directly.'`.
2. Run test to verify RED:
   ```bash
   pnpm exec vitest run --project unit src/services/payment-reminders.test.ts -t 'sendPaymentReminders sends reminders'
   ```
   Expect FAIL on day assertion.
3. In `src/services/payment-reminders.ts`:
   - Import `formatDayHeader` from `@/lib/format` and `timeToHHmm` from `@/lib/time-of-day`.
   - In `sendPaymentReminders`: widen select on `calendarEntry` to `{ classType: true, date: true, startTime: true }`.
   - Update reminder `body` at line 90.
4. Run test to verify GREEN:
   ```bash
   pnpm exec vitest run --project unit src/services/payment-reminders.test.ts -t 'sendPaymentReminders sends reminders'
   ```
5. Prove guards bite (mutations 7-8):
   - Mutation 7: Automated reminder reverted to old text -> test fails on day substring.
   - Mutation 8: Automated reminder drops ` at ${timeToHHmm(...)}` -> test fails on time substring.
   - Restore and re-verify GREEN.
6. Commit:
   ```bash
   git add src/services/payment-reminders.ts src/services/payment-reminders.test.ts
   git commit -m "fix(reminders): automated payment reminder names class in full (#202)"
   ```

---

### Task 4: Mutation Ledger, Acceptance Grep, and Verification

**Files:**
- Create: `docs/superpowers/plans/2026-09-14-payment-notices-name-class-mutations.md`

**Steps:**
1. Run acceptance grep across all notification bodies in `src/` to ensure all 4 payment bodies and 5 cancellation bodies use `formatDayHeader`.
2. Write `docs/superpowers/plans/2026-09-14-payment-notices-name-class-mutations.md` documenting all 8 mutations and exact observed failure text.
3. Run full verification suite: `pnpm run verify`.
4. Commit:
   ```bash
   git add docs/superpowers/plans/2026-09-14-payment-notices-name-class-mutations.md
   git commit -m "docs(payments): record 8-mutation ledger for payment class naming (#202)"
   ```
