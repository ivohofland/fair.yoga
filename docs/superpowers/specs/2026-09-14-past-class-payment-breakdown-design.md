# Past-class payment breakdown (#576)

A completed class under **Past classes** on `/bookings` gets a disclosure
showing what the student's payment was part of: room, teacher, class total,
how many students shared it, and their own share.

## Premise, verified against the running code

### What held

**The snapshot exists and nothing rewrites it.** `completeClass`
(`services/class-lifecycle.ts`) writes `effectiveTeacherRate`, `totalStudents`
and `totalRevenue` in the same statement that sets `status: 'completed'`, then
creates one `Payment` per charged registration with `amount` set to that
student's allocated price. After that:

- **`Payment.amount` is written once.** Payment write sites outside tests:
  `grep -rnE 'payment\.(create|createMany|update|updateMany|upsert)\(' src --include='*.ts' --include='*.tsx' | grep -v '\.test\.'`
  → 8 = 1 `create` (`completeClass`) + 7 updates. Each update's `data` is an
  object literal with no spread, read site by site: 5 write status fields
  (`payment-reminders.ts` overdue sweep; `payments.ts` paid, overdue, reopen,
  not-charged) and 2 write only `reminderSentAt` (`payment-reminders.ts`,
  `payments.ts`) — 5 + 2 = 7, none touches `amount`. No raw SQL reaches the
  table (`grep -rn '"Payment"' src --include='*.ts'` has no match), and no
  migration writes `amount` or the three snapshot columns — they appear only in
  `20260403092044_init`'s `CREATE TABLE`.
- **The class snapshot is frozen.** `updateClass` refuses every field on a
  terminal class (CLAUDE.md, Class Lifecycle), and the snapshot columns'
  only non-seed writers are the two `completeClass` branches.

So the page shows the snapshot; it never recomputes a price.

**Who counts in `totalStudents`.** It is `chargedRegistrations.length`, the
registrations in `CHARGED_STATUSES` — `registered`, `attended`, `no_show`,
`late_cancel`. A walk-in is a registration with `isWalkIn: true` in one of
those statuses. All three groups the issue names — late cancels, no-shows,
walk-ins — are charged and counted, so "Students" is true for all of them.

### What the issue did not say, or said wrong

1. **Cancelled classes never reach Past classes today.** A cancelled class
   keeps the status it was cancelled in (`open`, or `in_progress` on teacher
   erasure), and the page's split treats both as upcoming whatever the date.
   The issue's "cancelled classes get no breakdown" is therefore moot on the
   current page — and the split itself is a defect, filed as **#598**. This
   design gates on `completed`, so it is correct wherever #598 moves cancelled
   rows.
2. **The teacher's part can be negative.** `minRate` may go down to
   `-roomCost` (`lib/schemas.ts`, "minRate cannot subsidize more than the room
   cost"), so the teacher line can read `−€5.00`. The class total cannot go
   below zero.
3. **"What the teacher earned" is not what the snapshot holds.** It holds what
   was *billed*. A `not_charged` payment does not reduce `totalRevenue` (#47),
   and other students may not have paid. The label says **Teacher**, what the
   money is for, not what the teacher received.
4. **The teacher line is `totalRevenue − roomCost`, not
   `effectiveTeacherRate`.** Those two columns are rounded to cents
   independently, each from its own float, so nothing guarantees
   `roomCost + effectiveTeacherRate = totalRevenue`. The subtraction adds up
   by construction, and it is what the teacher already sees
   (`components/class/pricing-breakdown.tsx`, and the completion
   notification's earnings figure). No mismatch between the two was measured;
   the choice does not depend on one existing.
5. **Tier labels are half-shipped.** The issue lists them as an open question;
   the booking flow already shows a student "You're in Tier 3 · Comfortable"
   (`components/booking/booking-flow.tsx`, `TIER_INFO` in `lib/tiers.ts`).
   Moot here — see the tier decision below.

## Decisions (brainstorm, 2026-09-14)

| Question (from the issue) | Decision |
|---|---|
| Placement | A disclosure, beside the existing "How to pay". The ledger stays one quiet line per class. |
| Lines | Room · Teacher · Class total · Students · Your share. |
| Tier adjustment copy | **None.** Class total and your share are enough on this screen. `docs/product-concept.md` keeps its "tier adjustment framed in plain language" promise as future direction; CLAUDE.md's Open Questions already carries "Tier adjustment framing — deferred to UX copy phase". |
| Who counts in "N students" | Everyone charged — see *Who counts* above. Label **Students**, no qualifier. |
| `not_charged` (#47) | **Hide the breakdown.** A waiver is usually applied well after the class; the row shows only the waiver. |
| Cancelled classes | No breakdown (gated on `completed`). Their placement is #598. |
| Privacy | Accepted, restated below. |

## Design

### When the disclosure renders

All of:

- the class is `completed`;
- the registration has a `Payment`;
- that payment's status is one that shows a breakdown — `pending`, `paid`,
  `overdue`, not `not_charged`;
- the snapshot is present (`totalRevenue` and `totalStudents` non-null).

The status rule is an exhaustive `Record<PaymentStatus, boolean>`, not a
`!== 'not_charged'` test, so a new `PaymentStatus` member fails the build until
someone decides whether it shows a breakdown (CLAUDE.md, *Comment Discipline*:
tether membership to the compiler).

A completed class with a null snapshot is unreachable through `completeClass`,
which writes both in the statement that completes the class. If one is found
anyway, the page renders no disclosure and logs a warning naming the class — it
does not throw (a student-facing server page, same reasoning as
`paymentStateText`'s runtime branch) and does not render zeros.

### Where each number comes from

| Line | Source |
|---|---|
| Room | `Class.roomCost` |
| Teacher | `Class.totalRevenue − Class.roomCost` |
| Class total | `Class.totalRevenue` |
| Students | `Class.totalStudents` |
| Your share | `Payment.amount` |

Money arithmetic in integer cents, never floats: `Decimal(10,2)` values become
whole cents before the subtraction, and formatting divides back. A negative
teacher line renders as `−€5.00` (U+2212 minus before the euro sign), never
`€-5.00`.

### Units

- **`src/lib/payment-breakdown.ts`** — `resolvePaymentBreakdown`, pure: takes
  the class status, the snapshot fields, and the registration's payment (or
  null); returns a discriminated result — a breakdown (all five lines in cents),
  hidden, or snapshot missing. Owns the gate and the cents arithmetic. Same
  shape as #433's `resolvePriceLine` / `ClassPriceLine` split.
- **`src/components/student/payment-breakdown.tsx`** — `PaymentBreakdown`,
  presentational, no `'use client'` (a `<details>` needs no JS). Takes the
  resolved breakdown plus the class context for the accessible name.
- **`src/app/(student)/bookings/page.tsx`** — the past-class row calls the
  resolver, renders the component on a breakdown, logs on a missing snapshot.
  The query already loads `payment` and the class's scalar columns; no query
  change is expected.

### Presentation

- `<details>` after "How to pay". Both render on a `pending` or `overdue` row
  ("How to pay" is gated on `isOutstanding`); the breakdown renders alone on a
  `paid` row.
- Summary: **Where your payment goes**, `type-label text-teal`, matching "How to
  pay"; `aria-label` "Where your payment goes — {classType}, {day header}", the
  same shape "How to pay" uses, so a student with several past classes can tell
  the disclosures apart.
- Body: the `bg-sand-soft border border-border rounded-field p-4` panel "How to
  pay" uses; label/value rows, labels `type-body`, values `tabular-nums`, **Your
  share** as `type-number`. No badges, no icons (design brief).

### Privacy

Room cost + teacher amount + class size + the student's own share lets a
student compute the class's average tier ratio. At completion that is a
whole-class average, not a per-booking change, and it was judged acceptable on
#433 and again on #576. The breakdown reads only the class's own snapshot and
the student's own payment — never another student's registration.

## Testing

- **Unit** (`src/lib/payment-breakdown.test.ts`): each gate condition hides on
  its own (not completed; no payment; `not_charged`; null `totalRevenue`; null
  `totalStudents`, the last two as *snapshot missing*, not *hidden*); each of
  `pending`, `paid`, `overdue` shows; the teacher line is the subtraction,
  including a negative one; cents survive values that drift in float
  subtraction.
- **Component** (`src/components/student/payment-breakdown.test.tsx`): the five
  labels and their values render; a negative teacher line renders with U+2212
  before the euro sign; the summary's accessible name names the class and day.
- **Integration** (`tests/integration/bookings-page.test.ts`): one student with
  completed classes whose snapshots carry distinct values — a pending payment
  (breakdown present, its values in the HTML), a paid one (present), a
  `not_charged` one (absent). The load-bearing assertion is each class's own
  distinct value, so presence and absence are attributable to the right row.

**Every guard is broken once**, with the failing test and its error text
recorded: the `completed` gate, the payment-present gate, the `not_charged`
entry in the status record, each snapshot null check, the subtraction (swapped
for `effectiveTeacherRate`), and the minus-sign formatting.

## Out of scope

- **Tier adjustment sentence** — deferred; see Decisions.
- **Where cancelled classes sit** — #598 is unaffected.
- **The teacher's completed-class breakdown** — unchanged.
- **Upcoming classes** — no breakdown; #433's price line already covers them.
