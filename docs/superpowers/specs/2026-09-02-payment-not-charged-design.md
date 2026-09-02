# Payment: "not charged"

**Date:** 2026-09-02
**Status:** Approved (issue #47; design agreed with Ivo in discussion — a fourth
`PaymentStatus` member, teacher control on the payments overview only, a
second action line grouping the two deliberate actions, and reporting left as a billed
view)

## Problem

`docs/product-concept.md:142` specifies a grace policy:

> No system-level grace policy for cancellations or emergencies. If a student
> has a genuine emergency, they talk to their teacher. The teacher can manually
> mark someone as "not charged" if they choose to be lenient.

Nothing implements it. `PaymentStatus` is `pending | paid | overdue`
(`prisma/schema.prisma:73-77`), and a grep for `waive|not charged|notCharged|
grace` across `src/`, `prisma/` and `tests/` finds no waiver concept anywhere —
every hit is unrelated (a cancellation comment at
`src/app/api/registrations/[id]/route.ts:280`, and test fixtures named "Grace
Hopper"). The only way to clear an outstanding payment today is to mark it paid.

Waiving is strictly a **post-completion** act. Early cancellation already
produces no charge by producing no row at all: `Payment` is created only by
`completeClass` (`docs/data-model.md:400`, `src/services/class-lifecycle.ts:780`),
so a student who cancels before the deadline never has a payment to waive. This
feature is about a row that exists and that the teacher chooses not to collect.

### The issue's premise is half wrong, and the wrong half redirects the work

Issue #47 says marking paid "lies in the earnings/reporting numbers".
**Reporting cannot be lied to, because it never looks.**
`grep -i payment src/app/\(teacher\)/settings/reporting/page.tsx` returns
nothing. Every number on that page derives from `Class.totalRevenue`, a snapshot
written inside `completeClass` (`src/services/class-lifecycle.ts:766`) before
anyone has paid anything. The per-class earnings card is the same:
`pricing-breakdown.tsx:15-17` reads `cls.totalRevenue`.

Where marking-paid *can* move a number, by census:

> 15 `.amount` references in `src/` = **2** accumulating `reduce`s + 11
> single-row displays and notification bodies + 2 test assertions. No `_sum`
> and no `aggregate()` anywhere in `src/`.
>
> Re-derive: `grep -rn "\.amount" --include="*.ts" --include="*.tsx" src` and
> `grep -rn "_sum\|aggregate(" --include="*.ts" --include="*.tsx" src`.

Both accumulators are on one screen —
`src/app/(teacher)/settings/payments/page.tsx:36` and `:39`. So `receivedTotal`,
rendered under the label "Received … all time" (`:59-63`), is the only money
total in the application that a mis-marked payment inflates. That is the lie,
and it is one screen rather than a reporting-wide problem.

### Five sites encode a two-state assumption

The pivotal defect this change must not trip over. Each of these asks "is it
paid?" and treats the negation as meaningful, so each silently absorbs a fourth
member into a different default — and all five compile:

| Site | Expression | Where a fourth member lands |
|---|---|---|
| `settings/payments/page.tsx:34` | `p.status !== 'paid'` | Outstanding, and its € total (`:36`) and count (`:55`) |
| `class-list.tsx:73-81` | counts `overdue` + `pending`, else falls through | "✓ all paid" on a class where nothing was paid |
| `bookings/page.tsx:266,288` | `isPaid = status === 'paid'`, gate is `!isPaid` | The student is shown how to pay |
| `payment-checklist.tsx:65,101` | `disabled={isPaid \|\| isUpdating}` | An enabled "Mark paid" that 409s |
| `student-payment-list.tsx:38,52` | `{!isPaid && <button>Mark paid</button>}` | An enabled "Mark paid" that 409s |

The last two differ in kind from the first three and the distinction decides
their scope: they are not merely *revealed* by a fourth member, they are
**created** by one. Each renders a control that is visible, enabled, and
guaranteed to fail — `markPaymentPaid`'s CAS is `['pending','overdue']`
(`payments.ts:86`), so the request 409s every time. Both gates become
`isOutstanding(status)`.

The third is the worst of the first three. `bookings/page.tsx:288-314` renders the teacher's
**IBAN, account name, a remittance reference and a scannable EPC QR code
pre-filled with the exact amount** — for money the teacher has just decided the
student does not owe. The amount also keeps its brown "you owe this" styling
(`:278-280`).

**The existing compiler tethers do not reach any of them.** #58 installed
`Record<PaymentStatus, true>` (`src/lib/payment-status.ts:29-33`) and two `never`
guards (`src/lib/format.ts:53`, `:67`); all three fire on *exhaustive branching*
and will break the build as designed. A `.filter()` predicate carries no such
obligation. `tsc` will point at the rendering sites and stay silent about the
three above.

Note the counter-example in the same files: `isOutstanding` at
`payment-checklist.tsx:65` and `outstanding-payment-row.tsx:57` is written
*positively* (`=== 'pending' || === 'overdue'`), and so gates
`SendReminderButton` correctly for a fourth member with no change at all. The
bugs are exactly the sites that asked `isPaid` and negated it.

## Design

### 1. `not_charged`, a fourth `PaymentStatus` member

```prisma
enum PaymentStatus {
  pending
  paid
  overdue
  not_charged
}
```

Snake_case follows the schema's existing multiword convention
(`booking_confirmed`, `late_cancel`, `in_progress`). The user-facing word is
**"Not charged"** everywhere — product-concept §142's own phrase, chosen over
"waived" for being more universally understood.

**Rejected: a separate `notCharged` boolean or timestamp beside `status`.** It
would give two sources of truth for "is this owed?", force every read to consult
both, and — decisively — earn nothing from the `Record<PaymentStatus, true>` and
`never` tethers, which are the mechanism that makes this change discoverable at
compile time. The enum is what those guards were built for; #58's spec even
names the hypothetical (`…payment-status-end-to-end-design.md:199`: "a new
`refunded` member would render as 'Unpaid' and nothing would complain").

**`notChargedAt DateTime?` is added alongside**, mirroring `paidAt`. It gives the
Not charged row a date to display exactly as `ReceivedPaymentRow` displays
`paidAt` (`:60`), and the reversal nulls it exactly as the reversal nulls
`paidAt`. Without it the section would order by `updatedAt`, which any later
write disturbs.

### 2. Transitions, and the reversal that is already built

`not_charged` and `paid` are structurally twins: both are settled, both are
reachable only from `pending | overdue`, and both reverse only to `pending`.
They differ in exactly one respect — whether money moved.

```
                     Mark paid
      pending ──────────────────────► paid
         │ ▲                            │
  sweep  │ │  Mark unpaid (2-tap)       │  Mark unpaid (2-tap)
  ≥7d    │ ├────────────────────────────┘
         ▼ │
      overdue                    ⊘ not_charged
         │ │                            ▲ │
         │ └── Mark unpaid (2-tap) ─────┘ │
         └──────── Not charged ───────────┘
                   (also from pending)
```

New service, following the CAS shape the module's own comment justifies
(`payments.ts:83-84`: "the status guard lives in the WHERE clause so a double
submission cannot both pass a pre-check and clobber method/paidAt"):

```ts
markPaymentNotCharged(db, paymentId)
  // where: { id, status: { in: ['pending', 'overdue'] } }
  // data:  { status: 'not_charged', notChargedAt: new Date() }
```

`reminderSentAt` is deliberately **not** cleared — a reminder that was sent was
sent, and the history stays true.

**The reversal is the existing control, widened.** `unmarkPaymentPaid`'s CAS
goes from `status: 'paid'` to `status: { in: ['paid', 'not_charged'] }`, still
writing `pending` and now nulling `notChargedAt` alongside `method`/`paidAt`.
Its name stops describing it and becomes `reopenPayment`; the route
`/api/payments/[id]/unpaid` keeps its URL, which still reads true — the payment
becomes unpaid again either way. Its 409 message widens from
`Must be "paid".` to name both settled states.

Landing on `pending` rather than `overdue` is inherited reasoning, not a new
decision (`payments.ts:136-143`): the dunning sweep re-derives `overdue` from
age on its next hourly tick, so an old payment self-heals.

**Two transitions deliberately not allowed**, because a two-step path through
`pending` already exists and keeping the CAS allowlists tight is worth more than
a shortcut:

- `paid → not_charged` — if the money arrived, not charging is a *refund*, a
  different feature. Path: Mark unpaid, then Not charged.
- `not_charged → paid` directly — Mark unpaid, then Mark paid.

**The dunning machinery needs no changes at all.** `markOverduePayments` filters
`status: 'pending'` (`payment-reminders.ts:28`), `sendPaymentReminders` filters
`status: 'overdue'` (`:46`), and the manual `sendPaymentReminder` CASes on
`['pending','overdue']` (`payments.ts:218`) — all positive, so all three
correctly ignore a not-charged payment, and a teacher who tries to remind on one
gets the existing 409. This is the strongest evidence the model fits.

### 3. One predicate, tethered to the compiler

The three two-state sites are not fixed by three careful edits — that leaves the
*next* member to be absorbed just as silently. `src/lib/payment-status.ts` gains
the predicate, with an exhaustive `switch` and a `never` default, the idiom
CLAUDE.md's *Comment Discipline* prescribes and `countSkipReasons` already uses:

```ts
export function isOutstanding(status: PaymentStatus): boolean {
  switch (status) {
    case 'pending':
    case 'overdue':
      return true;
    case 'paid':
    case 'not_charged':
      return false;
    default: {
      const unhandled: never = status;
      console.error('[payment-status] unhandled status', { status: String(unhandled) });
      return false;
    }
  }
}
```

`console.error` rather than `lib/log.ts` (pino, server-only) and returning rather
than throwing, for the same reason `format.ts:41-52` gives: this module is
reachable from `'use client'` components and from a `force-dynamic` server
component on a student-facing page.

Returning `false` on the impossible branch is the safe default in every
consumer: an unknown status is excluded from Outstanding rather than dunned, and
excluded from "how to pay" rather than shown a stranger's IBAN.

All five sites in the table above call it. `payment-checklist.tsx:65` and
`outstanding-payment-row.tsx:57` drop their local derivations in favour of it,
and the two broken "Mark paid" gates become `isOutstanding(status)` — which is
also what removes the enabled-but-always-409 control from both.

### 4. Teacher UI — the payments overview only

The control ships on `/settings/payments` and nowhere else. Waiving is rare
enough that deliberately navigating to the right page is correct rather than a
cost to be optimised away.

**The row's actions split on a principle, not on crowding.** "Send reminder"
fires a notification and possibly an email at a real person; "Not charged"
forgives money. Both are deliberate decisions *about a debt*. "Mark paid" is the
routine bookkeeping tap a teacher does repeatedly after a class. So the row
keeps `Mark paid` as its one inline pill, and both deliberate actions move to a
line of their own:

```
Anna Smith                                    €12.00  [Mark paid]
Vinyasa · Tue 2 Sep · ! overdue
Send reminder · Not charged
```

Both render as **quiet text actions, not pills** — the shape `Undo` already uses
(`outstanding-payment-row.tsx:104`: `type-caption text-teal min-h-[44px] px-1`,
which keeps the 44px touch target while reading as text). That is what answers
the only real objection to keeping them always visible: a rare action should not
carry permanent visual weight, and as a third and fourth pill on every row it
would. In the caption register it reads as what it is — available, not urgent —
and it leaves `Mark paid` as the row's single visual primary.

**Deliberately not a disclosure, and not a sheet.** An earlier draft of this
spec put both actions behind `<details>`/`<summary>`, collapsed by default. That
was solving the wrong problem: the constraint is that three pills do not fit on
a 640px line, and a second line resolves it completely at no interaction cost.
Hiding them bought nothing and charged a tap for the *commoner* of the two
actions — reminding is routine, waiving is rare. The tell was defending an
interaction change on layout grounds; when the justification for making
something slower is "it does not fit", the fix is layout.

A sheet is rejected more firmly. The design system reserves its only shadow for
"sheets/modals" (CLAUDE.md), so one would not go against the grain — but
building the app's first sheet primitive inside this issue means shipping a
design-system component: focus trap, escape handling, scroll lock, `aria-modal`,
return-focus, a portal. None of that is about payments, and all of it is the
category that generates review rounds. A real sheet gets built the day something
needs to overlay.

Because both actions stay directly visible and directly reachable, **no existing
assertion changes.** `outstanding-payment-row.test.tsx:93` (distinct reminder
accessible names) and `tests/e2e/teacher-journey.spec.ts:384` (a paid row offers
no reminder, an unpaid one does) both remain valid as written.

**Interaction.** Tapping "Not charged" is a single optimistic tap with a
transient Undo, mirroring `markPaid` — `usePaymentActions` gains
`markNotCharged`, writing `'not_charged'` optimistically the way `:44` writes
`'paid'`. The durable reversal is `MarkUnpaidButton`'s two-tap confirm on the
Not charged row, per §2.

**`undo` needs no new endpoint.** It POSTs `/api/payments/[id]/unpaid`
(`use-payment-actions.ts:70`), which `reopenPayment` now accepts from both
settled states. `readUndoStatus` validates against `isPaymentStatus`, which picks
up the new member from the `Record<PaymentStatus, true>` automatically.

### 5. The payments overview: two tiles, three sections

Tiles stay **Outstanding** and **Received**, and both filters become positive so
neither can absorb a fourth member:

```ts
const outstanding  = payments.filter((p) => isOutstanding(p.status));
const received     = payments.filter((p) => p.status === 'paid');
const notCharged   = payments.filter((p) => p.status === 'not_charged');
```

"Received" keeps meaning money-in, strictly. Not-charged rows get **their own
third section** below Received rather than joining it — which also keeps them
from competing with paid rows for that list's 30-row cap (`:35`).

A new row component renders them, modelled on `ReceivedPaymentRow`: name, class
context, amount, the state text with its `notChargedAt` date, and
`MarkUnpaidButton` as the reversal.

The reconciliation this preserves is **billed = received + outstanding + not
charged**. With only two of the three shown, a teacher who waives would find the
totals no longer account for what was billed.

### 6. Student UI — passive truth, no announcement

`/bookings` is the only place a student sees payment state
(`bookings/page.tsx:281-284`). Three changes, all on that page:

- The state renders `⊘ Not charged` via the shared `paymentStateText`.
- The amount loses its brown "you owe this" styling — `:278` becomes
  `isOutstanding(payment.status) ? 'text-brown' : ''`.
- **The How-to-pay disclosure stops rendering** — `:288` becomes
  `payment && isOutstanding(payment.status)`. This is the defect fix, not a
  preference: the current gate shows a student the IBAN and QR for money that
  has been forgiven.

**No notification, and no new `NotificationType` member.** Product-concept §142
frames grace as a conversation that already happened offline ("they talk to
their teacher"); the app's job is to stop contradicting it, not to announce it.
The student learns next time they look.

### 7. Copy

Joins the existing glyph + word vocabulary (`format.ts:33-56`), text and never a
badge:

| Status | `paymentStateText` | `paymentStateInlineText` |
|---|---|---|
| `paid` | `✓ Paid`, `text-teal` | ` · ✓ paid` |
| `pending` | `○ Unpaid`, `''` | ` · ○ unpaid` |
| `overdue` | `! Overdue`, `text-danger font-medium` | ` · ! overdue` |
| `not_charged` | `⊘ Not charged`, `text-brown-light` | ` · ⊘ not charged` |

Muted `text-brown-light` deliberately: teal is the money-arrived colour
everywhere in the app and this row contributed nothing to Received, while plain
brown is the still-owed colour and nothing is owed. Muted reads as *settled,
nothing to do*.

**`PaymentRollup` (`class-list.tsx:66-82`) gains a fourth branch.** Its priority
becomes overdue > unpaid > not charged > all paid, so `✓ all paid` is claimed
only when every payment is genuinely paid, and a class where nothing was
collected reports ` · ⊘ 2 not charged` instead of a false all-clear.

### 8. Reporting stays a billed view, and says so

`/settings/reporting` is **not** rewritten to read `Payment` rows. Its numbers
are what was *billed*, derived from `Class.totalRevenue`, and they have never
reflected whether a euro was collected — unpaid money already does not move
them.

But the label overclaims once waiving exists: a teacher who has just marked €50
not charged will expect "Total earned teaching" (`:126`) to move. The copy
changes to a billed framing so the absence is honest rather than a bug. Numbers,
queries and data path are untouched.

Making that page collection-aware is a genuinely larger change — it would force
a decision about plain unpaid and overdue money too, and studio classes have no
`Payment` rows at all, so the two halves of the page would compute earnings on
different principles. Out of scope; see below.

## Testing

Per project rule, every guard is proven by mutation: break it, record the exact
error text, restore, re-verify.

- **`isOutstanding` — unit** (`src/lib/payment-status.test.ts`). One assertion
  per member. The `never` default is proven by **mutation**: add a fifth member
  to the schema enum, confirm `tsc` fails at `isOutstanding`, at
  `PAYMENT_STATUSES`, and at both `format.ts` guards; remove it. Do not create a
  migration for it. A passing `tsc` on unchanged code demonstrates nothing.
- **`paymentStateText` / `paymentStateInlineText` — unit**
  (`src/lib/format.test.ts`). One per new member, asserting label and className
  byte-exactly. The existing three must come out unchanged.
- **Transitions — service** (`src/services/payments.test.ts`).
  `markPaymentNotCharged` from `pending` and from `overdue`; its refusal from
  `paid` and from `not_charged`, asserting the 409 text. `reopenPayment` from
  both settled states, asserting `notChargedAt`, `paidAt` and `method` all end
  null. **A refusal test must be mutation-proven** — widen the CAS and confirm
  the test fails, or it certifies nothing.
- **The dunning machinery ignores it — service**
  (`src/services/payment-reminders.test.ts`). A `not_charged` payment older than
  `OVERDUE_AFTER_DAYS` is not swept to `overdue`, and is not reminded. These pass
  today by construction; they exist so a later change to those filters cannot
  quietly start dunning forgiven money.
- **The overview totals — integration** (`tests/integration/`). A teacher with
  one paid, one pending and one not-charged payment: `outstandingTotal` and its
  count exclude the not-charged one, `receivedTotal` excludes it, and it appears
  in its own section. **This is the test that fails against `:34`'s
  `!== 'paid'`** and is the single most important assertion on the branch.
- **The student page — integration.** A not-charged payment on `/bookings`
  renders `⊘ Not charged`, and the response contains **neither** the teacher's
  IBAN **nor** the QR image. Asserting the absence of the IBAN string is the
  point; asserting only the label would pass against the unfixed gate.
- **The new action line — component** (`outstanding-payment-row.test.tsx`). The
  "Not charged" action carries a per-row accessible name disambiguated by
  student and class context, and its visible text is contained in that name
  (WCAG 2.5.3) — the standard the file already holds at `:93`, `:112`, `:138`,
  `:165`, and which the new control must join rather than reintroduce #128's
  defect on a fourth surface.
- **`PaymentRollup` — component** (`class-list.test.tsx`). A completed class
  whose payments are all `not_charged` reports not-charged, **not** `✓ all paid`.
  Mutation: revert the new branch and confirm the false all-clear returns.
- **New row component — component.** State text, date from `notChargedAt`, and
  `MarkUnpaidButton` present with a disambiguated accessible name.
- **The two repaired "Mark paid" gates — component**
  (`payment-checklist.test.tsx`, `student-payment-list.test.tsx`). A
  `not_charged` row offers **no** "Mark paid" control on either surface. Each
  fails against its file as it stands today, which is what distinguishes these
  from the coverage-only additions above. One test per file: reverting either
  gate alone must leave the other's test green.
- **e2e** (`tests/e2e/teacher-journey.spec.ts`). Extend the existing payments
  block: mark not charged from the row's action line, confirm the row leaves
  Outstanding and the totals move, then reverse it with Mark unpaid.
- **a11y sweep.** `/settings/payments` is **not** currently in
  `tests/e2e/a11y.spec.ts:157-205`, verified — the eight routes swept are
  `/login`, `/{slug}`, `/{slug}/book/{classId}`, `/bookings`, `/schedule`,
  `/class/{classId}`, `/inbox`, `/settings`. This branch adds a control and a
  new row type there, so the route joins the sweep — cheap, and it covers
  precisely what is being added.

**No existing assertion is rewritten or deleted.** Every test named above is an
addition. This is a property of the §4 layout choice, not a coincidence: because
both actions stay directly visible, nothing about how an existing control is
reached has changed.

## Folded in

Both are #128/#129's missed surfaces — the same defect those two issues closed
on `MarkUnpaidButton` and the class page, standing in files this branch has to
open anyway. Neither is folded for tidiness; each is a live accessibility defect
in a file already being edited, so filing it would grow the tracker for work
that is free here.

- **`bookings/page.tsx:290`'s `<summary>` has no `aria-label`**, so a student
  with three unpaid past classes gets three identical "How to pay" disclosures.
  §6 opens that file to gate the block on `isOutstanding`, which means editing
  the exact expression that controls when this unnamed control renders.
- **`student-payment-list.tsx:52-71` has no accessible names** on either its
  "Mark paid" or its "Undo" button, so a student with several unpaid classes
  gives a screen-reader user a column of identical controls. **This was going to
  be filed** on the reasoning that the branch did not touch the file — which was
  wrong: the two-state table shows its "Mark paid" gate must change, so the file
  is opened regardless, and adding a corrected gate to an unnamed control while
  declining to name it makes no sense.

## Out of scope

- **Making `/settings/reporting` collection-aware.** §8. A real question, and a
  larger one: it forces a policy on plain unpaid and overdue money, and studio
  classes have no `Payment` rows, so the page's two halves would compute
  earnings on different principles. To be filed as its own issue.
- **A notification when a payment is not charged.** §6.
- **A sheet/modal primitive.** §4.
- **Refunds** (`paid → not_charged`). §2.
- **Level 2 processor behaviour.** `Payment.processorRef` has zero references in
  `src/`; issue #386 covers that gap.

## Risks

- **`ALTER TYPE … ADD VALUE` and Prisma's transaction.** The migration adds the
  member and the `notChargedAt` column. It must **not** also use the literal
  `'not_charged'` in a backfill: PostgreSQL forbids using a new enum value in
  the transaction that added it, and Prisma wraps migrations in one. No backfill
  is needed — existing rows keep their status.
- **The migration is immutable once applied**, comments included. Prose about it
  goes in `docs/`, per CLAUDE.md.
- **`paymentStateText` is shared by three surfaces, one student-facing.** The
  existing three labels and classNames must come out byte-identical; the unit
  tests are what hold that.
- **The `never` mutation edits `prisma/schema.prisma`.** It must be reverted and
  no migration created for it.
- **`outstanding-payment-row.tsx:78` hardcodes the amount to `text-brown`.** It
  stays correct because that component renders only in a positively-filtered
  Outstanding section — but it is briefly wrong between an optimistic
  `markNotCharged` and the refresh. Acceptable; noted so a reviewer does not
  read it as an oversight.
- **The outstanding row gains a line.** Every row grows by one caption line, so
  a teacher with thirty outstanding payments scrolls further. Judged the right
  trade against the alternatives — a third pill does not fit a 640px line, and
  hiding the actions charges a tap on the commoner one (§4) — but it is a real
  cost to a list that can get long, and the quiet-text treatment is what keeps
  it from also being noisy.
