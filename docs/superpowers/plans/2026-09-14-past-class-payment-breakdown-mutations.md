# #576 mutation ledger

Nineteen mutations across four groups: the resolver's gate order and cents
arithmetic (Task 1, `src/lib/payment-breakdown.ts`), the disclosure
component's cent formatting and accessible name (Task 2,
`src/components/student/payment-breakdown.tsx`), the `/bookings` page's
wiring of the breakdown into the response and its integration assertions
(Task 3), and one further mutation from the whole-branch fix wave (F5,
confirming the "How to pay" disclosure still renders alongside the new one).
Protocol for every row: with the group's commit already in place, hand-edit
the mutation, run the named test, record the exact failure text, hand-restore
the file (never `git checkout`/`git restore`), re-run to green, and confirm
`git diff --stat` is empty before moving to the next row. Commits: Task 1
`fbc6f1aa`, Task 2 `b55135c7`, Task 3 `656c51e6`, fix wave `05e36def` (each
confirmed against its report).

## Task 1 — `resolvePaymentBreakdown` (commit `fbc6f1aa`)

| # | Edit | Test(s) that failed | Exact error text |
|---|---|---|---|
| 1.1 | Delete the `if (classStatus !== 'completed') return { kind: 'hidden' };` line | `hides the breakdown on a draft class`, `hides the breakdown on a open class`, `hides the breakdown on a in_progress class`, `does not report a missing snapshot on a class that is not completed` | `AssertionError: expected { kind: 'shown', lines: { …(5) } } to deeply equal { kind: 'hidden' }` (representative, first three tests)<br>`AssertionError: expected { kind: 'snapshot_missing' } to deeply equal { kind: 'hidden' }` (fourth test) |
| 1.2 | Snapshot-null check becomes `if (totalStudents === null)`; `toCents(totalRevenue)` → `toCents(totalRevenue!)` | `reports a completed class with no totalRevenue as a missing snapshot` (named), plus `reports a missing snapshot even on a row that would hide its breakdown` | `TypeError: Cannot read properties of null (reading 'mul')` at `toCents src/lib/payment-breakdown.ts:39:16`<br>`AssertionError: expected { kind: 'hidden' } to deeply equal { kind: 'snapshot_missing' }` |
| 1.3 | Snapshot-null check becomes `if (totalRevenue === null)`; `students: totalStudents` → `students: totalStudents!` | `reports a completed class with no totalStudents as a missing snapshot` | `AssertionError: expected { kind: 'shown', lines: { …(5) } } to deeply equal { kind: 'snapshot_missing' }` |
| 1.4 | Swap the order of the two `if` lines (payment check before snapshot-null check) | `reports a missing snapshot even on a row that would hide its breakdown` | `AssertionError: expected { kind: 'hidden' } to deeply equal { kind: 'snapshot_missing' }` |
| 1.5 | `not_charged: false` → `not_charged: true` in `SHOWS_BREAKDOWN` | `hides the breakdown for a not_charged payment` | `AssertionError: expected { kind: 'shown', lines: { …(5) } } to deeply equal { kind: 'hidden' }` |
| 1.6 | Delete the `not_charged: false,` line from `SHOWS_BREAKDOWN` | none (checked via `pnpm run typecheck`, no test run per the brief) | `error TS1360: Type '{ readonly pending: true; readonly paid: true; readonly overdue: true; }' does not satisfy the expected type 'Record<PaymentStatus, boolean>'.`<br>`error TS7053: Element implicitly has an 'any' type because expression of type 'PaymentStatus' can't be used to index type '{ readonly pending: true; readonly paid: true; readonly overdue: true; }'.` |
| 1.7 | Payment check becomes `if (!SHOWS_BREAKDOWN[payment!.status])` | `hides the breakdown when the registration has no payment` | `TypeError: Cannot read properties of null (reading 'status')` at `resolvePaymentBreakdown src/lib/payment-breakdown.ts:56:33` |
| 1.8 | `teacherCents: totalCents - roomCents` → `teacherCents: roomCents - totalCents` | `shows every line from the snapshot, in cents`, `derives the teacher line as total minus room, negative when the teacher covered part of the room` (named), plus `keeps cents exact where float subtraction drifts` | `-     "teacherCents": -400,`<br>`+     "teacherCents": 400,` (from the named negative-teacher-line test) |
| 1.9 | `teacherCents: totalCents - roomCents` → `teacherCents: (totalRevenue.toNumber() - roomCost.toNumber()) * 100` | `keeps cents exact where float subtraction drifts` | `-     "teacherCents": 1620,`<br>`+     "teacherCents": 1619.9999999999995,` |

## Task 2 — `PaymentBreakdown` component (commit `b55135c7`)

| # | Edit | Test(s) that failed | Exact error text |
|---|---|---|---|
| 2.1 | `` cents < 0 ? '−' : '' `` → `` cents < 0 ? '-' : '' `` | `renders a negative teacher line with a minus sign before the euro sign` | `AssertionError: expected '-€4.00' to be '−€4.00' // Object.is equality` |
| 2.2 | Sign moved after the euro sign: `` `€${cents < 0 ? '−' : ''}${euros}.${rest}` `` | same test as 2.1 | `AssertionError: expected '€−4.00' to be '−€4.00' // Object.is equality` |
| 2.3 | Drop `.padStart(2, '0')` from `rest` | `renders each line beside its label`, `pads single-digit cents` | `AssertionError: expected '€40.0' to be '€40.00' // Object.is equality`<br>`AssertionError: expected '€0.5' to be '€0.05' // Object.is equality` |
| 2.4 | `aria-label` drops `, ${formatDayHeader(date)}` | `names the class and day in the summary, so several past classes stay distinguishable` | `TestingLibraryElementError: Unable to find a label with the text of: Where your payment goes — Vinyasa, Monday, 1 Jun` |
| 2.5 | Swap the `formatCents(...)` arguments between the Room and Teacher rows | `renders each line beside its label` | `AssertionError: expected '€16.25' to be '€40.00' // Object.is equality` |

## Task 3 — page wiring (commit `656c51e6`)

| # | Edit | Test(s) that failed | Exact error text |
|---|---|---|---|
| 3.1 | Delete the `{breakdown.kind === 'shown' && (<PaymentBreakdown … />)}` expression | `shows a pending payment the room, teacher and class total behind it`; `shows a paid payment its breakdown, with a negative teacher line when the teacher covered part of the room` | `AssertionError: expected '<!DOCTYPE html>…' to contain 'Where your payment goes — Breakdown Pending …, Tuesday, 2 Jun'`<br>`AssertionError: expected '<!DOCTYPE html>…' to contain 'Where your payment goes — Breakdown Paid …, Wednesday, 3 Jun'` |
| 3.2 | `src/lib/payment-breakdown.ts`: `not_charged: false` → `not_charged: true` in `SHOWS_BREAKDOWN` | `shows a not_charged payment no breakdown` | `AssertionError: expected '<!DOCTYPE html>…' not to contain 'Where your payment goes — Breakdown Waived …, Thursday, 4 Jun'` |
| 3.3 | Pass `totalRevenue: cls.totalRevenue ?? cls.roomCost` and `totalStudents: cls.totalStudents ?? 0` | `renders a completed class with no snapshot without a breakdown, and the page still loads` | `AssertionError: expected '<!DOCTYPE html>…' not to contain 'Where your payment goes — Breakdown Unsnapshotted …, Friday, 5 Jun'` |
| 3.4 | Pass `totalRevenue: cls.roomCost` | `shows a pending payment the room, teacher and class total behind it` (named); also `shows a paid payment its breakdown, with a negative teacher line when the teacher covered part of the room` | `AssertionError: expected '<!DOCTYPE html>…' to contain '€16.25'`<br>`AssertionError: expected '<!DOCTYPE html>…' to contain '−€4.00'`. Side effect noted in the report: forcing `totalRevenue = roomCost` for every row collapses `teacherCents = totalCents − roomCents` to 0 for every class, not just the named one, so the paid fixture's negative teacher line breaks too — "the mutation biting harder than its named test, not a 'did not bite' case." |

## Fix wave (commit `05e36def`)

`F5`'s mutation/restore ran against `src/app/(student)/bookings/page.tsx` after commit `05e36def`, per the report's stated ordering; that file was never itself staged into `05e36def`.

| # | Edit | Test(s) that failed | Exact error text |
|---|---|---|---|
| F5 | Delete the `{payment && outstanding && (<details>...How to pay...</details>)}` expression | `GET /bookings (page) — payment status gate > still shows an unpaid student how to pay` (collateral — that suite also asserts "How to pay" is present); `GET /bookings (page) — past-class payment breakdown > shows a pending payment the room, teacher and class total behind it` (the F5 target test) | Target test: `AssertionError: expected '<!DOCTYPE html><html lang="en" class=…' to contain 'How to pay — Breakdown Pending 178941…'`, decisive diff line `- How to pay — Breakdown Pending 1789418822702-ad75e2, Tuesday, 2 Jun`. Collateral test's exact error text: not recorded. |

## What no test guards

- The `snapshot_missing` branch's `log.warn` is checked only by grepping
  `worktree-dev.log`, not by an assertion. Task 3's report recorded the count
  at one point as `8` (non-zero, "across the RED and GREEN runs plus mutation
  runs accumulated in the log by the time this was checked"). The fix wave's
  F6 recorded a separate before/after at a later point in the branch's
  history: before running the integration file, `80`; after, `85`; delta `5`
  — matching, per that report, "1 warm fetch in `beforeAll` + 4 `it` blocks"
  in the unsnapshotted-class describe block.
- The order of the two disclosures — the payment breakdown rendering after
  "How to pay" — is not asserted. F5 added a `toContain` check for the
  "How to pay — …" text immediately after the existing breakdown-label
  assertion, which pins that both render; neither that assertion nor any
  other in the reports pins which one appears first in the markup.

## Total

9 (Task 1) + 5 (Task 2) + 4 (Task 3) + 1 (fix wave) = 19 mutations.
